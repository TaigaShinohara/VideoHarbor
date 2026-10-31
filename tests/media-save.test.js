import test from 'node:test';
import assert from 'node:assert/strict';
import {MediaSaver,originPattern} from '../extension/media-save.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve,reject; const promise = new Promise((yes,no) => {resolve=yes;reject=no;}); return {promise,resolve,reject}; };
async function eventually(predicate) { for (let n=0;n<30;n++) {if (predicate()) return;await tick();} assert.ok(predicate(),'condition reached'); }
const blobItem = {url:'blob:https://page.test/00000000-0000-4000-8000-000000000001',type:'blob'};
function harness(t,options={}) {
  const originals = new Map(['chrome','fetch'].map(key => [key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const urlOriginals = new Map(['createObjectURL','revokeObjectURL'].map(key => [key,Object.getOwnPropertyDescriptor(URL,key)]));
  const calls=[], listeners=new Set(), granted=new Set(options.granted || []), downloads=new Map(), released=[];
  const h = {calls,listeners,granted,downloads,released,requestResult:true,state:options.state || 'complete',fetch:options.fetch};
  const chrome = {
    permissions:{
      async contains({origins}) {calls.push(['contains',...origins]);return origins.every(origin => granted.has(origin));},
      request({origins}) {calls.push(['request',...origins]);return Promise.resolve(h.requestResult).then(result => {if (result) origins.forEach(origin => granted.add(origin));return result;});},
    },
    downloads:{
      async download(config) {calls.push(['download',config]);downloads.set(42,{id:42,state:h.state});if(h.acceptDownload)await h.acceptDownload.promise;return 42;},
      async search({id}) {calls.push(['search',id]);return downloads.has(id) ? [{...downloads.get(id)}] : [];},
      async cancel(id) {calls.push(['cancel',id]);const item=downloads.get(id);if(item?.state==='complete')throw new Error('already complete');if(item)item.state='interrupted';h.emit(id,'interrupted');},
      onChanged:{addListener:fn=>listeners.add(fn),removeListener:fn=>listeners.delete(fn)},
    },
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
  h.saver=new MediaSaver({readBlob:(...args)=>h.readBlob(...args),onUpdate:()=>{if(options.onUpdate)options.onUpdate(h);}});
  t.after(async()=>{
    h.saver.cancel();h.emit(42,'interrupted');
    if(h.acceptDownload)h.acceptDownload.resolve();
    await tick();
    for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
    for(const [key,descriptor] of urlOriginals)Object.defineProperty(URL,key,descriptor);
  });
  return h;
}

test('origin permission patterns are scoped hosts and reject unsafe protocols or credentials',()=>{
  assert.equal(originPattern('https://cdn.test:8443/media.m3u8'),'https://cdn.test/*');
  assert.equal(originPattern('http://[::1]:8080/media'),'http://[::1]/*');
  for(const url of ['file:///movie','javascript:alert(1)','https://name:password@cdn.test/file','https://*/movie.m3u8','https://*.cdn.test/movie.m3u8'])assert.throws(()=>originPattern(url));
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

test('starting another candidate releases the previous retry buffer and duplicate starts do no work',async t=>{
  const wait=deferred();
  const h=harness(t,{state:'interrupted'});
  await h.saver.start(blobItem,'Title');
  assert.ok(h.saver.status(blobItem.url).blob);
  const next={...blobItem,url:'blob:https://page.test/00000000-0000-4000-8000-000000000002'};
  h.readBlob=async(url,offset)=>{if(offset===-2)return {released:true};if(offset===-1)await wait.promise;return {size:3,mime:'video/webm',bytes:offset<0?[]:[1,2,3]};};
  const second=h.saver.start(next,'Title');
  assert.equal(h.saver.status(blobItem.url).blob,undefined);
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
