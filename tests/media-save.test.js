import test from 'node:test';
import assert from 'node:assert/strict';
import {MediaSaver,originPattern} from '../extension/media-save.js';
import {validateMediaSegment} from '../extension/media-validation.js';
import {muxFragmentedMP4} from '../extension/mp4-mux.js';
import {remuxTSToMP4} from '../extension/ts-to-mp4.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve,reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };
async function eventually(predicate) { for (let n=0;n<30;n++) {if (predicate()) return;await tick();} assert.ok(predicate(),'condition reached'); }
const blobItem = {url:'blob:https://page.test/00000000-0000-4000-8000-000000000001',type:'blob'};
function harness(t,options={}) {
  const originals = new Map(['chrome','fetch'].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const urlOriginals = new Map(['createObjectURL','revokeObjectURL'].map(key => [key,Object.getOwnPropertyDescriptor(URL,key)]));
  const calls=[], listeners=new Set(), granted=new Set(options.granted || []), downloads=new Map(), released=[];
  const h = {calls,listeners,granted,downloads,released,processors:[],requestResult:true,state:options.state || 'complete',fetch:options.fetch};
  const chrome = {
    permissions:{
      async contains({origins}) {calls.push(['contains',...origins]);return origins.every(origin => granted.has(origin));},
      request({origins}) {calls.push(['request',...origins]);return Promise.resolve(h.requestResult).then(result => {if (result) origins.forEach(origin => granted.add(origin));return result;});},
    },
    ...(options.withoutDownloads ? {} : {
      downloads:{
        async download(config) {calls.push(['download',config]);downloads.set(42,{id:42,state:h.state});if(h.acceptDownload)await h.acceptDownload.promise;return 42;},
        async search({id}) {calls.push(['search',id]);return downloads.has(id) ? [{...downloads.get(id)}] : [];},
        async cancel(id) {calls.push(['cancel',id]);const item=downloads.get(id);if(item?.state==='complete')throw new Error('already complete');if(item)item.state='interrupted';h.emit(id,'interrupted');},
        onChanged:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},
      },
    }),
  };
  h.emit = (id,state) => { if(downloads.has(id))downloads.get(id).state=state;for(const fn of [...listeners])fn({id,state:{current:state}}); };
  Object.defineProperty(globalThis,'chrome',{configurable:true,value:chrome});
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:(...args) => {calls.push(['fetch',...args]);return h.fetch ? h.fetch(...args) : Promise.reject(new Error('Unexpected fetch'));}});
  Object.defineProperty(URL,'createObjectURL',{configurable:true,value:blob=>{calls.push(['objectURL',blob]);return 'blob:extension-synthetic';}});
  Object.defineProperty(URL,'revokeObjectURL',{configurable:true,value:url=>calls.push(['revoke',url])});
  const defaultReader = async (url,offset,token) => {
    calls.push(['readBlob',url,offset,token]);
    if(offset===-2){released.push(token);return {released:true};}
    return {size:3,mime:'video/webm',bytes:offset<0 ? [] : [1,2,3]};
  };
  h.readBlob=options.readBlob || defaultReader;
  // Node has no extension Worker. Inject the pure functions explicitly in this
  // harness; production must never use this as a fallback for a failed worker.
  const processorFactory=({signal})=>{
    const processor=options.processorFactory ? options.processorFactory({signal},h) : {
      async validate(...args){signal.throwIfAborted();return validateMediaSegment(...args);},
      async mux(...args){signal.throwIfAborted();return muxFragmentedMP4(...args);},
      async remux(...args){signal.throwIfAborted();return remuxTSToMP4(...args);},
      close(){this.closed=true;},
    };
    // MediaProcessor.close is idempotent: cancel and finally may both invoke it.
    const close=processor.close.bind(processor);let closed=false;
    processor.close=()=>{if(!closed){closed=true;close();}};
    h.processors.push(processor);return processor;
  };
  h.saver=new MediaSaver({processorFactory,readBlob:(...args)=>h.readBlob(...args),onUpdate:()=>{if(options.onUpdate)options.onUpdate(h);}});
  t.after(async()=>{
    h.saver.cancel();h.emit(42,'interrupted');
    if(h.acceptDownload)h.acceptDownload.resolve();
    await tick();
    for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
    for(const [key,descriptor] of urlOriginals)Object.defineProperty(URL,key,descriptor);
  });
  return h;
}

test('cancel settles a stalled blob request and cleanup without waiting for its reply',async t=>{
  let entered=false;
  const h=harness(t,{readBlob:()=>{entered=true;return new Promise(()=>{});}});
  const saving=h.saver.start(blobItem,'Title');await eventually(()=>entered);
  h.saver.cancel();await eventually(()=>!h.saver.busy);await saving;
  assert.equal(h.saver.status(blobItem.url).status,'interrupted');
  assert.equal(h.calls.some(c=>c[0]==='download'),false);
});

test('origin permission patterns are scoped hosts and reject unsafe protocols or credentials',()=>{
  assert.equal(originPattern('https://cdn.test:8443/media.m3u8'),'https://cdn.test/*');
  assert.equal(originPattern('http://[::1]:8080/media'),'http://[::1]/*');
  for(const url of ['file:///movie','javascript:alert(1)','https://name:password@cdn.test/file','https://*/movie.m3u8','https://*.cdn.test/movie.m3u8'])assert.throws(()=>originPattern(url));
});

test('unsaved ready data blocks another candidate and format change without losing its buffer',async t=>{
  const h=harness(t,{state:'interrupted'});await h.saver.start(blobItem,'Title');
  const first=h.saver.status(blobItem.url),calls=h.calls.length;
  assert.throws(()=>h.saver.start({...blobItem,url:blobItem.url+'-other'},'Other'),/破棄/);
  assert.throws(()=>h.saver.start(blobItem,'Other','mp4'),/破棄/);
  assert.equal(h.calls.length,calls);assert.equal(h.saver.status(blobItem.url),first);assert.ok(first.blob);
  assert.equal(h.saver.discard(blobItem.url),true);assert.equal(h.saver.status(blobItem.url),undefined);
});

test('permission request stays synchronous with the retry click and denial retains retry guidance',async t=>{
  const h=harness(t);
  const item={url:'https://cdn.test/master.m3u8',type:'hls'};
  await h.saver.start(item,'Title');
  assert.equal(h.saver.status(item.url).status,'permission');
  assert.deepEqual(h.saver.status(item.url).origins,['https://cdn.test/*']);
  assert.equal(h.calls.some(call=>call[0]==='fetch'),false);
  h.requestResult=false;
  const retry=h.saver.start(item,'Title');
  assert.equal(h.calls.at(-1)[0],'request','permission API called before start yields');
  await retry;
  assert.equal(h.saver.status(item.url).status,'interrupted');
  assert.match(h.saver.status(item.url).message,/許可されませんでした/);
  assert.equal(h.saver.busy,false);
});

test('blob save waits for Chrome completion, releases its page snapshot and revokes only after terminal state',async t=>{
  const h=harness(t,{state:'in_progress'});
  const saving=h.saver.start(blobItem,'Title');
  await eventually(()=>h.listeners.size===1);
  assert.equal(h.saver.status(blobItem.url).status,'saving');
  assert.equal(h.calls.some(call=>call[0]==='revoke'),false);
  const token=h.calls.find(call=>call[0]==='readBlob')[3];
  assert.match(token,/^[a-f0-9-]{36}$/);
  h.emit(42,'complete');await saving;
  assert.equal(h.saver.status(blobItem.url).status,'complete');
  assert.equal(h.saver.status(blobItem.url).blob,undefined);
  assert.equal(h.saver.status(blobItem.url).downloadId,42,'the completed output can be found without inspecting unrelated downloads');
  assert.deepEqual(h.released,[token]);
  assert.equal(h.calls.filter(call=>call[0]==='revoke').length,1);
  assert.equal(h.listeners.size,0);
});
test('HLS permission retry grants only encountered origins and completes a finite local assembly',async t=>{
  const packet=new Uint8Array(188);packet[0]=0x47;
  const h=harness(t,{fetch:async url=>url.endsWith('.m3u8')
    ? new Response('#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttps://segments.test/part.ts\n#EXT-X-ENDLIST\n',{headers:{'content-type':'application/vnd.apple.mpegurl'}})
    : new Response(packet,{headers:{'content-type':'video/mp2t'}})});
  const item={url:'https://cdn.test/master.m3u8',type:'hls'};
  await h.saver.start(item,'Title');assert.deepEqual(h.saver.status(item.url).origins,['https://cdn.test/*']);
  const playlistRetry=h.saver.start(item,'Title');assert.equal(h.calls.at(-1)[0],'request');await playlistRetry;
  assert.equal(h.saver.status(item.url).status,'permission');assert.deepEqual(h.saver.status(item.url).origins,['https://segments.test/*']);
  assert.equal(h.calls.filter(call=>call[0]==='fetch' && call[1].includes('segments.test')).length,0);
  const segmentsRetry=h.saver.start(item,'Title');assert.equal(h.calls.at(-1)[0],'request');await segmentsRetry;
  assert.equal(h.saver.status(item.url).status,'complete');
  assert.deepEqual([...h.granted].sort(),['https://cdn.test/*','https://segments.test/*']);
  assert.match(h.calls.find(call=>call[0]==='download')[1].filename,/\.ts$/);
  assert.equal(h.saver.status(item.url).bytesReceived,188);
  assert.match(h.saver.status(item.url).message,/音声の有無は未確認/);
  h.state='interrupted';await h.saver.start(item,'Title');
  const fetchesBeforeRetry=h.calls.filter(call=>call[0]==='fetch').length;
  h.state='complete';await h.saver.start(item,'Title');
  assert.equal(h.calls.filter(call=>call[0]==='fetch').length,fetchesBeforeRetry);
  assert.match(h.saver.status(item.url).message,/音声の有無は未確認/,'retry keeps the audio-context limitation');
});

test('download interruption retains one reusable buffer and retry does not reread page data',async t=>{
  const h=harness(t,{state:'interrupted'});
  await h.saver.start(blobItem,'Title');
  const failed=h.saver.status(blobItem.url);
  assert.equal(failed.status,'interrupted');assert.equal(failed.blob.size,3);
  const readCount=h.calls.filter(call=>call[0]==='readBlob').length;
  h.state='complete';await h.saver.start(blobItem,'Title');
  assert.equal(h.saver.status(blobItem.url).status,'complete');
  assert.equal(h.calls.filter(call=>call[0]==='readBlob').length,readCount);
  assert.equal(h.calls.filter(call=>call[0]==='revoke').length,2);
});

test('assembled saves use neutral distinct names and same-format retries keep their confirmed name',async t=>{
  const h=harness(t,{state:'interrupted'});
  const item={...blobItem,url:'blob:https://page.test/SyntheticPerson?Signature=SyntheticPrivate'};
  await h.saver.start(item,'SyntheticPerson private-title');
  const filename=h.calls.find(call=>call[0]==='download')[1].filename;
  assert.match(filename,/^VideoHarbor\/\d{4}-\d{2}-\d{2}\/video-\d{9}-\d{3,}\.webm$/);
  assert.doesNotMatch(filename,/Synthetic|private|Signature/);
  h.state='complete';await h.saver.start(item,'Changed private-title');
  const downloads=()=>h.calls.filter(call=>call[0]==='download').map(call=>call[1]);
  assert.equal(downloads()[1].filename,filename,'retry does not replace the established name');
  assert.ok(downloads().every(call=>call.conflictAction==='uniquify'));
  await h.saver.start(item,'SyntheticPerson private-title');
  assert.notEqual(downloads()[2].filename,filename,'a new completed-save request receives its own name');
});

test('a refetched source with a changed format cannot reuse an incompatible old filename',async t=>{
  let mime='video/mp4';
  const h=harness(t,{state:'interrupted',readBlob:async(url,offset)=>offset===-2 ? {released:true}
    : {size:3,mime,bytes:offset<0 ? [] : [1,2,3]}});
  await h.saver.start(blobItem,'Private title');
  const first=h.calls.find(call=>call[0]==='download')[1].filename;
  assert.ok(first.endsWith('.mp4'));
  h.state='complete';mime='video/webm';
  h.saver.discard(blobItem.url);
  await h.saver.start({...blobItem,url:`${blobItem.url}-other`},'Other');
  assert.equal(h.saver.status(blobItem.url),undefined,'explicit discard releases the original retry data');
  await h.saver.start(blobItem,'Private title');
  const latest=h.calls.filter(call=>call[0]==='download').at(-1)[1].filename;
  assert.ok(latest.endsWith('.webm'));assert.notEqual(latest,first);
});

test('another candidate requires explicit discard and duplicate starts do no work',async t=>{
  const wait=deferred();
  const h=harness(t,{state:'interrupted'});
  await h.saver.start(blobItem,'Title');
  assert.ok(h.saver.status(blobItem.url).blob);
  const next={...blobItem,url:'blob:https://page.test/00000000-0000-4000-8000-000000000002'};
  h.readBlob=async(url,offset)=>{if(offset===-2)return {released:true};if(offset===-1)await wait.promise;return {size:3,mime:'video/webm',bytes:offset<0?[]:[1,2,3]};};
  assert.throws(()=>h.saver.start(next,'Title'),/破棄/);
  assert.ok(h.saver.status(blobItem.url).blob);h.saver.discard(blobItem.url);
  const second=h.saver.start(next,'Title');
  assert.equal(h.saver.status(blobItem.url),undefined);
  assert.equal(h.saver.current,next.url);
  const callsBefore=h.calls.length;await h.saver.start(blobItem,'Title');assert.equal(h.calls.length,callsBefore);
  h.saver.cancel();wait.resolve();await second;
  assert.equal(h.saver.status(next.url).status,'interrupted');
});

test('cancellation during blob preparation releases snapshot and never starts download',async t=>{
  const wait=deferred(),releases=[];
  const h=harness(t,{readBlob:async(url,offset,token)=>{
    if(offset===-2){releases.push(token);return {released:true};}
    await wait.promise;return {size:3,mime:'video/webm',bytes:[]};
  }});
  const preparing=h.saver.start(blobItem,'Title');await tick();
  h.saver.cancel();wait.resolve();await preparing;
  assert.equal(h.saver.status(blobItem.url).status,'interrupted');
  assert.match(h.saver.status(blobItem.url).message,/停止/);
  assert.equal(releases.length,1);
  assert.equal(h.calls.some(call=>call[0]==='download'),false);
});

test('cancellation during blob chunks stops before save and rejects changed or oversized chunks',async t=>{
  const wait=deferred();let chunks=0,releases=0;
  const h=harness(t,{readBlob:async(url,offset)=>{
    if(offset===-2){releases++;return {released:true};}
    if(offset<0)return {size:6,mime:'video/webm',bytes:[]};
    chunks++;await wait.promise;return {size:6,mime:'video/webm',bytes:[1,2,3]};
  }});
  const saving=h.saver.start(blobItem,'Title');await eventually(()=>chunks===1);
  h.saver.cancel();wait.resolve();await saving;
  assert.equal(h.saver.status(blobItem.url).status,'interrupted');assert.equal(chunks,1);assert.equal(releases,1);
  assert.equal(h.calls.some(call=>call[0]==='download'),false);
  h.readBlob=async(url,offset)=>offset===-2 ? {released:true} : {size:3,mime:'video/webm',bytes:offset<0?[]:[1,2,3,4]};
  await h.saver.start(blobItem,'Title');assert.match(h.saver.status(blobItem.url).message,/変化/);
  h.readBlob=async(url,offset)=>offset===-2 ? {released:true} : {size:300000,mime:'video/webm',bytes:offset<0?[]:Array(262145).fill(1)};
  await h.saver.start(blobItem,'Title');assert.match(h.saver.status(blobItem.url).message,/変化/);
});

test('cancel while Chrome accepts a save reconciles actual completion instead of reporting false interruption',async t=>{
  const h=harness(t,{state:'complete'});h.acceptDownload=deferred();
  const saving=h.saver.start(blobItem,'Title');await eventually(()=>h.downloads.has(42));
  h.saver.cancel();h.acceptDownload.resolve();await saving;
  assert.ok(h.calls.some(call=>call[0]==='cancel'));
  assert.equal(h.saver.status(blobItem.url).status,'complete');
  assert.equal(h.saver.busy,false);
});

test('cancel an accepted in-progress save waits for terminal interruption and retains retry buffer',async t=>{
  const h=harness(t,{state:'in_progress'});
  const saving=h.saver.start(blobItem,'Title');await eventually(()=>h.listeners.size===1);
  h.saver.cancel();await saving;
  assert.equal(h.saver.status(blobItem.url).status,'interrupted');
  assert.equal(h.saver.status(blobItem.url).blob.size,3);
  assert.equal(h.listeners.size,0);
  assert.equal(h.calls.filter(call=>call[0]==='revoke').length,1);
});

test('fetches use only granted origins, reject redirects and pass explicit range and abort signal',async t=>{
  const h=harness(t,{granted:['https://cdn.test/*'],fetch:async()=>new Response('ok')});
  const controller=new AbortController();
  await h.saver.fetchResource('https://cdn.test/segment',{signal:controller.signal,range:{start:12,end:20}});
  const [,url,config]=h.calls.find(call=>call[0]==='fetch');
  assert.equal(url,'https://cdn.test/segment');assert.equal(config.redirect,'error');assert.equal(config.credentials,'include');
  assert.equal(config.referrerPolicy,'no-referrer');assert.equal(config.headers.Range,'bytes=12-20');assert.equal(config.signal,controller.signal);
  await assert.rejects(()=>h.saver.fetchResource('https://other.test/segment'),error=>error.origins[0]==='https://other.test/*');
  assert.equal(h.calls.filter(call=>call[0]==='fetch').length,1);
});

const dashItem={url:'https://manifest.test/player.mpd',type:'dash'};
const splitDASH=`<MPD type="static" mediaPresentationDuration="PT2S"><Period>
  <AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate duration="2" initialization="https://video.test/init-$RepresentationID$.mp4" media="https://video.test/$Number$.m4s"/><Representation id="v" bandwidth="1000"/></AdaptationSet>
  <AdaptationSet contentType="audio" mimeType="audio/mp4"><SegmentTemplate duration="2" initialization="https://audio.test/init-$RepresentationID$.mp4" media="https://audio.test/$Number$.m4s"/><Representation id="a" bandwidth="128"/></AdaptationSet>
</Period></MPD>`;
const dashResponse=()=>new Response(splitDASH,{headers:{'content-type':'application/dash+xml'}});

test('DASH permission retries request the MPD and both selected track hosts before any segment fetch',async t=>{
  const h=harness(t,{fetch:async url=>url===dashItem.url ? dashResponse() : new Response('not available',{status:403})});
  await h.saver.start(dashItem,'Title');
  assert.equal(h.saver.status(dashItem.url).status,'permission');
  assert.deepEqual(h.saver.status(dashItem.url).origins,['https://manifest.test/*']);
  assert.equal(h.calls.some(call=>call[0]==='fetch'),false);
  const firstRetry=h.saver.start(dashItem,'Title');
  assert.equal(h.calls.at(-1)[0],'request','MPD permission is requested before yielding');await firstRetry;
  assert.equal(h.saver.status(dashItem.url).status,'permission');
  assert.deepEqual(h.saver.status(dashItem.url).origins,['https://video.test/*','https://audio.test/*']);
  assert.deepEqual(h.calls.filter(call=>call[0]==='fetch').map(call=>call[1]),[dashItem.url]);
  const secondRetry=h.saver.start(dashItem,'Title');
  assert.equal(h.calls.at(-1)[0],'request','track permissions are requested before yielding');await secondRetry;
  assert.deepEqual([...h.granted].sort(),['https://audio.test/*','https://manifest.test/*','https://video.test/*']);
  assert.equal(h.saver.status(dashItem.url).status,'interrupted');
  assert.match(h.saver.status(dashItem.url).message,/403/,'the actual init failure is retained');
  assert.ok(h.calls.some(call=>call[0]==='fetch' && call[1]==='https://video.test/init-v.mp4'));
  assert.equal(h.calls.some(call=>call[0]==='download'),false,'a failed init cannot create a purported completed MP4');
});

test('DASH cancellation during MPD fetch aborts that request and does not fetch tracks or save',async t=>{
  let entered=false,requestSignal;
  const h=harness(t,{granted:['https://manifest.test/*'],fetch:async(url,{signal})=>{
    entered=true;requestSignal=signal;
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')),{once:true}));
  }});
  const preparing=h.saver.start(dashItem,'Title');await eventually(()=>entered);
  h.saver.cancel();await preparing;
  assert.equal(requestSignal.aborted,true);
  assert.equal(h.saver.status(dashItem.url).status,'interrupted');
  assert.match(h.saver.status(dashItem.url).message,/停止/);
  assert.equal(h.calls.filter(call=>call[0]==='fetch').length,1);
  assert.equal(h.calls.some(call=>call[0]==='download'),false);
});

test('DASH cancellation during a stalled init cancels its reader and prevents audio/fragment fetches',async t=>{
  let entered=false,cancelled=false;
  const h=harness(t,{granted:['https://manifest.test/*','https://video.test/*','https://audio.test/*'],fetch:async url=>url===dashItem.url ? dashResponse() : new Response(new ReadableStream({start(){entered=true;},cancel(){cancelled=true;}}))});
  const fetching=h.saver.start(dashItem,'Title');await eventually(()=>entered);
  assert.equal(h.saver.status(dashItem.url).status,'fetching');
  assert.equal(h.saver.status(dashItem.url).audioUnverified,false,'DASH does not inherit standalone HLS uncertainty');
  h.saver.cancel();await fetching;
  assert.equal(cancelled,true);assert.equal(h.saver.status(dashItem.url).status,'interrupted');
  assert.deepEqual(h.calls.filter(call=>call[0]==='fetch').map(call=>call[1]),[dashItem.url,'https://video.test/init-v.mp4']);
  assert.equal(h.calls.some(call=>call[0]==='download'),false);
});

test('media host preflight rejects more than 32 distinct origins before permission queries',async t=>{
  const h=harness(t);
  await assert.rejects(h.saver.missing(Array.from({length:33},(_,i)=>`https://cdn${i}.test/segment.m4s`)),/32/);
  assert.equal(h.calls.length,0);
  const missing=await h.saver.missing(Array.from({length:64},(_,i)=>`https://same.test/segment-${i}.m4s`));
  assert.deepEqual(missing,['https://same.test/*'],'segment count does not multiply host requests');
  assert.equal(h.calls.filter(call=>call[0]==='contains').length,1);
});

test('output format validation happens synchronously before any permission prompt or retry-buffer mutation',async t=>{
  const h=harness(t),item={...blobItem,mime:'video/webm'};
  const previous={status:'permission',origins:['https://cdn.test/*'],blob:new Blob(['old']),outputFormat:'auto'};
  h.saver.results.set(item.url,previous);
  assert.throws(()=>h.saver.start(item,'Title','mp4'),/MP4形式ではありません/);
  assert.throws(()=>h.saver.start(item,'Title','bogus'),/保存形式/);
  assert.equal(h.calls.length,0);assert.equal(h.saver.busy,false);
  assert.equal(h.saver.status(item.url),previous);assert.equal(previous.blob.size,3);
});

test('selected MP4 inspects the actual unknown blob MIME before reading chunks or creating a download',async t=>{
  const calls=[];
  const h=harness(t,{readBlob:async(url,offset,token)=>{
    calls.push({offset,token});return offset===-2 ? {released:true} : {size:3,mime:'video/webm',bytes:[]};
  }});
  await h.saver.start(blobItem,'Title','mp4');
  const result=h.saver.status(blobItem.url);
  assert.equal(result.outputFormat,'mp4');assert.equal(result.status,'interrupted');assert.match(result.message,/MP4ではありません/);
  assert.deepEqual(calls.map(call=>call.offset),[-1,-2]);assert.equal(calls[0].token,calls[1].token);
  assert.equal(h.calls.some(call=>call[0]==='download' || call[0]==='objectURL'),false);
});

test('a pending save keeps the clicked MP4 format when another format start is attempted',async t=>{
  const metadata=deferred();let entered=false;
  const h=harness(t,{readBlob:async(url,offset)=>{
    if(offset===-2)return {released:true};
    if(offset===-1){entered=true;await metadata.promise;}
    return {size:3,mime:'video/mp4',bytes:offset<0 ? [] : [1,2,3]};
  }});
  const saving=h.saver.start(blobItem,'Title','mp4');await eventually(()=>entered);
  assert.equal(h.saver.status(blobItem.url).outputFormat,'mp4');
  await h.saver.start(blobItem,'Title','auto');
  assert.equal(h.saver.status(blobItem.url).outputFormat,'mp4');
  metadata.resolve();await saving;
  assert.equal(h.saver.status(blobItem.url).status,'complete');assert.equal(h.saver.status(blobItem.url).outputFormat,'mp4');
  assert.match(h.calls.find(call=>call[0]==='download')[1].filename,/\.mp4$/);
});

test('same-format MP4 retry reuses its buffer and keeps output format after download interruption',async t=>{
  let reads=0;
  const h=harness(t,{state:'interrupted',readBlob:async(url,offset)=>{
    if(offset===-2)return {released:true};reads++;
    return {size:3,mime:'video/mp4',bytes:offset<0 ? [] : [1,2,3]};
  }});
  await h.saver.start(blobItem,'Title','mp4');const first=h.saver.status(blobItem.url),readCount=reads;
  assert.equal(first.status,'interrupted');assert.equal(first.outputFormat,'mp4');assert.equal(first.blob.type,'video/mp4');
  h.state='complete';await h.saver.start(blobItem,'Title','mp4');
  assert.equal(reads,readCount);assert.equal(h.saver.status(blobItem.url).status,'complete');
  const blobs=h.calls.filter(call=>call[0]==='objectURL').map(call=>call[1]);assert.equal(blobs[0],blobs[1]);
});

test('changing output format requires discard before re-reading the source snapshot',async t=>{
  let snapshots=0;
  const h=harness(t,{state:'interrupted',readBlob:async(url,offset)=>{
    if(offset===-2)return {released:true};if(offset===-1)snapshots++;
    const size=snapshots===1 ? 3 : 5;return {size,mime:'video/mp4',bytes:offset<0 ? [] : Array(size).fill(snapshots)};
  }});
  await h.saver.start(blobItem,'Title','auto');const previous=h.saver.status(blobItem.url);
  assert.equal(previous.blob.size,3);assert.equal(previous.outputFormat,'auto');
  h.state='complete';assert.throws(()=>h.saver.start(blobItem,'Title','mp4'),/破棄/);
  assert.ok(previous.blob);h.saver.discard(blobItem.url);await h.saver.start(blobItem,'Title','mp4');
  assert.equal(snapshots,2);
  assert.equal(h.saver.status(blobItem.url).outputFormat,'mp4');assert.equal(h.saver.status(blobItem.url).bytesReceived,5);
  const blobs=h.calls.filter(call=>call[0]==='objectURL').map(call=>call[1]);assert.notEqual(blobs[0],blobs[1]);
  assert.deepEqual([...new Uint8Array(await blobs[1].arrayBuffer())],[2,2,2,2,2]);
});

test('changed-format retry cannot save a stale MP4 buffer when the new source is now WebM',async t=>{
  let snapshots=0;
  const h=harness(t,{state:'interrupted',readBlob:async(url,offset)=>{
    if(offset===-2)return {released:true};if(offset===-1)snapshots++;
    return {size:3,mime:snapshots===1 ? 'video/mp4' : 'video/webm',bytes:offset<0 ? [] : [1,2,3]};
  }});
  await h.saver.start(blobItem,'Title','auto');const previous=h.saver.status(blobItem.url);assert.ok(previous.blob);
  h.state='complete';assert.throws(()=>h.saver.start(blobItem,'Title','mp4'),/破棄/);
  assert.ok(previous.blob);h.saver.discard(blobItem.url);await h.saver.start(blobItem,'Title','mp4');
  assert.equal(h.saver.status(blobItem.url).status,'interrupted');
  assert.match(h.saver.status(blobItem.url).message,/MP4ではありません/);
  assert.equal(h.calls.filter(call=>call[0]==='download').length,1);
});

const processingItem={url:'https://media.test/video.m3u8',type:'hls'};
function transportFixture(url) {
  if(url.endsWith('.m3u8'))return new Response('#EXTM3U\n#EXTINF:1,\none.ts\n#EXTINF:1,\ntwo.ts\n#EXT-X-ENDLIST\n');
  const packet=new Uint8Array(188);packet[0]=0x47;return new Response(packet);
}

test('cancelling pending media processing closes its processor and never fetches or saves following segments',async t=>{
  let entered=false,closed=0;
  const h=harness(t,{granted:['https://media.test/*'],fetch:transportFixture,processorFactory:({signal})=>({
    validate(){entered=true;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('stopped','AbortError')),{once:true}));},
    close(){closed++;},
  })});
  const saving=h.saver.start(processingItem,'Title');await eventually(()=>entered);
  h.saver.cancel();await saving;
  const result=h.saver.status(processingItem.url);
  assert.equal(result.status,'interrupted');assert.match(result.message,/停止/);
  assert.equal(result.blob,undefined,'unfinished worker output cannot become a retry buffer');
  assert.equal(closed,1);assert.equal(h.saver.busy,false);
  assert.deepEqual(h.calls.filter(call=>call[0]==='fetch').map(call=>call[1]),[processingItem.url,'https://media.test/one.ts']);
  assert.equal(h.calls.some(call=>call[0]==='objectURL'||call[0]==='download'),false);
});

test('a cancelled operation stays exclusive while a late processing result unwinds, then a new retry owns its result',async t=>{
  const pending=deferred();let entered=false,factories=0,closed=0;
  const h=harness(t,{granted:['https://media.test/*'],fetch:transportFixture,processorFactory:()=>{
    const first=++factories===1;
    return {
      async validate(bytes,extension,init,budget){
        if(first){entered=true;await pending.promise;}
        return validateMediaSegment(bytes,extension,init,budget);
      },
      close(){closed++;},
    };
  }});
  const saving=h.saver.start(processingItem,'Title');await eventually(()=>entered);
  const cancelled=h.saver.status(processingItem.url);
  h.saver.cancel();
  const calls=h.calls.length;await h.saver.start(processingItem,'Other title');
  assert.equal(h.calls.length,calls,'a second start cannot replace a running operation');
  assert.equal(h.saver.busy,true);assert.equal(factories,1);
  pending.resolve();await saving;
  assert.equal(cancelled.status,'interrupted');assert.equal(cancelled.blob,undefined);
  assert.equal(h.calls.some(call=>call[0]==='download'),false,'late worker completion after abort cannot save');
  assert.equal(closed,1);assert.equal(h.saver.busy,false);
  await h.saver.start(processingItem,'Retry title');
  const retried=h.saver.status(processingItem.url);
  assert.notEqual(retried,cancelled);assert.equal(retried.status,'complete');
  assert.equal(cancelled.status,'interrupted');assert.equal(closed,2);assert.equal(factories,2);
  assert.equal(h.calls.filter(call=>call[0]==='download').length,1);
});

test('a processing failure is retryable without saving or reusing unvalidated media',async t=>{
  let factories=0,closed=0;
  const h=harness(t,{granted:['https://media.test/*'],fetch:transportFixture,processorFactory:()=>{
    const first=++factories===1;
    return {
      async validate(...args){if(first)throw new Error('synthetic worker failure');return validateMediaSegment(...args);},
      close(){closed++;},
    };
  }});
  await h.saver.start(processingItem,'Title');
  const failed=h.saver.status(processingItem.url);
  assert.equal(failed.status,'interrupted');assert.equal(failed.blob,undefined);
  assert.equal(closed,1);assert.equal(h.calls.some(call=>call[0]==='download'),false);
  await h.saver.start(processingItem,'Title');
  assert.equal(h.saver.status(processingItem.url).status,'complete');
  assert.equal(closed,2);assert.equal(factories,2);
  assert.equal(h.calls.filter(call=>call[0]==='fetch'&&call[1]==='https://media.test/one.ts').length,2,'retry fetches and validates the rejected input again');
});

test('cancelling TS remux cannot download a delayed MP4 result and retry fetches a fresh source',async t=>{
  const pending=deferred();let entered=false,factories=0,closed=0;
  const h=harness(t,{granted:['https://media.test/*'],fetch:transportFixture,processorFactory:()=>{
    const first=++factories===1;
    return {
      async validate(...args){return validateMediaSegment(...args);},
      async remux(){if(first){entered=true;await pending.promise;}return new Blob(['synthetic MP4 result'],{type:'video/mp4'});},
      close(){closed++;},
    };
  }});
  const saving=h.saver.start(processingItem,'Title','mp4');await eventually(()=>entered);
  assert.equal(h.saver.status(processingItem.url).status,'converting');
  h.saver.cancel();pending.resolve();await saving;
  assert.equal(h.saver.status(processingItem.url).status,'interrupted');
  assert.equal(h.saver.status(processingItem.url).blob,undefined);
  assert.equal(h.calls.some(call=>call[0]==='download'),false);assert.equal(closed,1);
  await h.saver.start(processingItem,'Title','mp4');
  assert.equal(h.saver.status(processingItem.url).status,'complete');
  assert.equal(h.saver.status(processingItem.url).extension,'mp4');assert.equal(closed,2);
  assert.equal(h.calls.filter(call=>call[0]==='fetch'&&call[1]===processingItem.url).length,2);
});

test('cancelled blob cleanup cannot hold a following operation hostage',async t=>{
  const cleanup=deferred();let releasing=false,snapshots=0;
  const h=harness(t,{readBlob:async(url,offset)=>{
    if(offset===-2){releasing=true;await cleanup.promise;return {released:true};}
    if(offset===-1){snapshots++;return {size:3,mime:'video/webm',bytes:[]};}
    return {size:3,mime:'video/webm',bytes:[1,2,3]};
  },onUpdate:h=>{if(h.saver?.status(blobItem.url)?.status==='fetching')h.saver.cancel();}});
  const saving=h.saver.start(blobItem,'Title');await eventually(()=>releasing);
  await h.saver.start(blobItem,'Another title');
  assert.equal(snapshots,2);assert.equal(h.saver.busy,false);
  cleanup.resolve();await saving;
  assert.equal(h.saver.busy,false);assert.equal(h.saver.status(blobItem.url).status,'interrupted');
  assert.equal(h.calls.some(call=>call[0]==='download'),false);
});

test('cancellation just before Chrome submission prevents a download and preserves the completed same-format retry buffer',async t=>{
  let cancelled=false;
  const h=harness(t,{onUpdate:h=>{
    if(!cancelled&&h.saver?.status(blobItem.url)?.status==='saving'){cancelled=true;h.saver.cancel();}
  }});
  await h.saver.start(blobItem,'Title');
  const first=h.saver.status(blobItem.url),reads=h.calls.filter(call=>call[0]==='readBlob').length;
  assert.equal(first.status,'interrupted');assert.equal(first.blob.size,3);
  assert.equal(h.calls.some(call=>call[0]==='objectURL'||call[0]==='download'),false);
  await h.saver.start(blobItem,'Title');
  assert.equal(h.saver.status(blobItem.url).status,'complete');
  assert.equal(h.calls.filter(call=>call[0]==='readBlob').length,reads,'retry can use the fully validated buffer');
  assert.equal(h.calls.filter(call=>call[0]==='download').length,1);
});

test('workspace disposal terminates pending processing and prevents later starts from acquiring new work',async t=>{
  let entered=false,closed=0;
  const h=harness(t,{granted:['https://media.test/*'],fetch:transportFixture,processorFactory:({signal})=>({
    validate(){entered=true;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new DOMException('disposed','AbortError')),{once:true}));},
    close(){closed++;},
  })});
  const saving=h.saver.start(processingItem,'Title');await eventually(()=>entered);
  h.saver.dispose();await saving;
  assert.equal(closed,1);assert.equal(h.saver.busy,false);
  assert.equal(h.saver.status(processingItem.url).status,'interrupted');
  const calls=h.calls.length;await h.saver.start(blobItem,'Another title');
  assert.equal(h.calls.length,calls);assert.equal(h.processors.length,1);
  assert.equal(h.calls.some(call=>call[0]==='objectURL'||call[0]==='download'),false);
});

test('mobile context without chrome.downloads uses navigator.share when available',async t=>{
  const shared=[];
  const originalShare=navigator.share, originalCanShare=navigator.canShare;
  Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{shared.push(data);return true;}});
  Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});
  t.after(()=>{
    if(originalShare)Object.defineProperty(navigator,'share',{configurable:true,value:originalShare});
    else delete navigator.share;
    if(originalCanShare)Object.defineProperty(navigator,'canShare',{configurable:true,value:originalCanShare});
    else delete navigator.canShare;
  });
  const h=harness(t,{withoutDownloads:true});
  await h.saver.start(blobItem,'Mobile Title');
  const result=h.saver.status(blobItem.url);
  assert.equal(result.status,'shared');
  assert.ok(result.blob);
  assert.equal(shared.length,1);
  assert.ok(shared[0].files?.[0] instanceof File);
  assert.match(result.message,/共有先へ渡しました/);
});

test('mobile context transitions to ready when user gesture expires and shares on next tap',async t=>{
  const shared=[];
  let attempts=0;
  const originalShare=navigator.share, originalCanShare=navigator.canShare;
  Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{
    attempts++;
    if(attempts===1) {
      const err=new Error('User activation expired');
      err.name='NotAllowedError';
      throw err;
    }
    shared.push(data);
    return true;
  }});
  Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});
  t.after(()=>{
    if(originalShare)Object.defineProperty(navigator,'share',{configurable:true,value:originalShare});
    else delete navigator.share;
    if(originalCanShare)Object.defineProperty(navigator,'canShare',{configurable:true,value:originalCanShare});
    else delete navigator.canShare;
  });
  const h=harness(t,{withoutDownloads:true});
  await h.saver.start(blobItem,'Mobile Title');
  const readyResult=h.saver.status(blobItem.url);
  assert.equal(readyResult.status,'ready');
  assert.ok(readyResult.blob);
  assert.match(readyResult.message,/保持/);
  assert.equal(shared.length,0);

  // User taps "端末に保存" with fresh user gesture
  h.readBlob=()=>{throw new Error('source has expired');};
  const sharing=h.saver.start(blobItem,'Mobile Title');
  assert.equal(shared.length,1,'share is called synchronously without re-fetching the expired source');
  await sharing;
  const completeResult=h.saver.status(blobItem.url);
  assert.equal(completeResult.status,'shared');
  assert.equal(shared.length,1);
  assert.equal(completeResult.blob,readyResult.blob);
  assert.match(completeResult.message,/共有先へ渡しました/);
});
