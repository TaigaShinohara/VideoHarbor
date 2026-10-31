// Real local module Workers in an isolated extension/profile. Success and
// malformed-input checks run unmodified parsers. Deterministic busy cancellation
// adds a synchronous barrier ONLY to the temporary worker copy before parsing;
// it proves Worker termination/UI responsiveness, not a parser timing bound.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,mkdir,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo=fileURLToPath(new URL('../',import.meta.url));
const scratch=await mkdtemp(join(tmpdir(),'videoharbor-worker-qa-'));
const extension=join(scratch,'extension');
let context;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function command(binary,args) {
  const result=spawnSync(binary,args,{encoding:'utf8',timeout:25000,maxBuffer:2*1024*1024});
  assert.equal(result.status,0,`${binary} failed: ${result.error?.message || result.stderr}`);
  return result.stdout;
}
async function makeFixtures() {
  const tracks=[];
  for(const type of ['video','audio']) {
    const directory=join(scratch,type);await mkdir(directory);
    const input=type==='video' ? 'testsrc2=size=64x64:rate=8' : 'sine=frequency=440:sample_rate=48000';
    const codec=type==='video' ? ['-an','-c:v','libx264','-bf','0','-pix_fmt','yuv420p','-g','4','-sc_threshold','0'] : ['-vn','-c:a','aac','-ac','2'];
    command('ffmpeg',['-v','error','-nostdin','-y','-f','lavfi','-i',input,...codec,'-t','1.5','-threads','1','-f','hls','-hls_segment_type','fmp4','-hls_time','0.5','-hls_playlist_type','vod','-hls_fmp4_init_filename','init.mp4','-hls_segment_filename',join(directory,'seg-%02d.m4s'),join(directory,'index.m3u8')]);
    const names=(await readdir(directory)).filter(name=>name.endsWith('.m4s')).sort();
    assert.ok(names.length>=2,'fixture includes multiple real fragments');
    tracks.push({type,init:[...await readFile(join(directory,'init.mp4'))],segments:await Promise.all(names.map(async name=>[...await readFile(join(directory,name))]))});
  }
  const directory=join(scratch,'ts');await mkdir(directory);
  command('ffmpeg',['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=96x64:rate=12','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-g','12','-bf','2','-sc_threshold','0','-c:a','aac','-b:a','64k','-ac','2','-f','hls','-hls_time','1','-hls_playlist_type','vod','-hls_segment_filename',join(directory,'seg-%02d.ts'),join(directory,'index.m3u8')]);
  const names=(await readdir(directory)).filter(name=>name.endsWith('.ts')).sort();
  return {tracks,ts:[...Buffer.concat(await Promise.all(names.map(name=>readFile(join(directory,name)))))]};
}
function decode(path,minDuration) {
  const probe=JSON.parse(command('ffprobe',['-v','error','-show_entries','format=format_name,duration:stream=codec_type,codec_name','-of','json',path]));
  assert.ok(probe.format.format_name.includes('mp4'),'worker returns an actual MP4 container');
  assert.deepEqual(probe.streams.map(stream=>stream.codec_type).sort(),['audio','video']);
  assert.deepEqual(probe.streams.map(stream=>stream.codec_name).sort(),['aac','h264']);
  assert.ok(Number(probe.format.duration)>=minDuration,'complete synthetic duration is preserved');
  assert.equal(command('ffmpeg',['-v','error','-nostdin','-xerror','-err_detect','explode','-threads','1','-i',path,'-map','0:v','-map','0:a','-threads','1','-f','null','-']),'');
}
const entry=String.raw`
import {MediaProcessor} from './media-processing.js';
import {fixtures} from './qa-worker-fixtures.js';
const tracks=()=>fixtures.tracks.map(track=>({...track,init:new Uint8Array(track.init),segments:track.segments.map(bytes=>new Uint8Array(bytes))}));
const ts=()=>new Uint8Array(fixtures.ts);
const packet=()=>{const bytes=new Uint8Array(188);bytes[0]=0x47;return bytes;};
let beats=0,active=null,sequence=0;
setInterval(()=>{document.querySelector('#heartbeat').textContent=String(++beats);},10);
document.querySelector('#abort').addEventListener('click',()=>{
  if(!active)return;
  active.clicked=performance.now();active.controller.abort();
  document.querySelector('#state').textContent='stopping';
});
globalThis.workerQA={
  get active(){return active;},
  async success(){
    const processor=new MediaProcessor(),budget={boxes:0},input=tracks();let result;
    try {
      for(const track of input){
        track.init=await processor.validate(track.init,'mp4',true,budget);
        for(let i=0;i<track.segments.length;i++)track.segments[i]=await processor.validate(track.segments[i],'mp4',false,budget);
      }
      const transport=await processor.validate(ts(),'ts',false,budget);
      const mux=await processor.mux(input),muxOwnership=input.every(track=>!track.init.byteLength&&track.segments.every(bytes=>!bytes.byteLength));
      const remux=await processor.remux(transport),remuxOwnership=transport.byteLength===0;
      result={boxes:budget.boxes,muxOwnership,remuxOwnership,mux:[...new Uint8Array(await mux.arrayBuffer())],remux:[...new Uint8Array(await remux.arrayBuffer())]};
    } finally {processor.close();}
    return {...result,closed:processor.closed};
  },
  async fail(kind){
    const processor=new MediaProcessor();let rejected=false,message='';
    try {
      if(kind==='validate')await processor.validate(new Uint8Array([1]),'ts',false,{boxes:0});
      else if(kind==='mux')await processor.mux([]);
      else await processor.remux(new Uint8Array(188));
    } catch(error){rejected=true;message=error.message;}
    finally {processor.close();}
    return {rejected,message,closed:processor.closed};
  },
  startBusy(kind,{timeoutMs=10000}={}){
    const record={id:++sequence,kind,started:false,state:'running',beatsAtStart:beats,controller:new AbortController(),success:false,barrier:true};
    const processor=new MediaProcessor({signal:record.controller.signal,timeoutMs,workerFactory:()=>{
      const worker=new Worker(new URL('./media-worker.js?qaBusy=1',import.meta.url),{type:'module'});
      worker.addEventListener('message',event=>{if(event.data?.__qaBusy){record.started=true;record.beatsAtMarker=beats;}});
      return worker;
    }});
    record.processor=processor;active=record;document.querySelector('#state').textContent='running';
    const pending=kind==='validate' ? processor.validate(packet(),'ts',false,{boxes:0}) : kind==='mux' ? processor.mux(tracks()) : processor.remux(ts());
    record.pending=pending.then(()=>{record.success=true;record.state='complete';},error=>{record.state=error.name==='AbortError' ? 'aborted' : 'failed';record.error=error.name;record.message=error.message;record.settled=performance.now();}).finally(()=>{
      processor.close();if(active===record)document.querySelector('#state').textContent=record.state;
    });
    return record.id;
  },
  snapshot(){const record=active;return record&&{id:record.id,kind:record.kind,started:record.started,state:record.state,success:record.success,error:record.error,message:record.message,beats,beatsAtMarker:record.beatsAtMarker,elapsed:record.settled-record.clicked,closed:record.processor.closed};},
  async repeat(){const processor=new MediaProcessor();try{const bytes=await processor.validate(packet(),'ts',false,{boxes:0});return bytes.length;}finally{processor.close();}},
};
globalThis.workerQAReady=true;
`;

try {
  const fixtures=await makeFixtures();
  await cp(join(repo,'extension'),extension,{recursive:true});
  const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
  assert.ok(!manifest.host_permissions,'worker test must not add host access');
  await writeFile(join(extension,'qa-worker-fixtures.js'),`export const fixtures=${JSON.stringify(fixtures)};\n`);
  await writeFile(join(extension,'qa-worker-test.html'),'<!doctype html><html lang="en"><meta charset="utf-8"><title>Isolated worker QA</title><body><button id="abort">Stop processing</button><p id="state">idle</p><output id="heartbeat">0</output><script type="module" src="qa-worker-test.js"></script></body></html>');
  await writeFile(join(extension,'qa-worker-test.js'),entry);
  const workerPath=join(extension,'media-worker.js'),worker=await readFile(workerPath,'utf8');
  const anchor='const result=processMedia(kind,payload);';
  assert.equal(worker.split(anchor).length,2,'worker test hook matches exactly one handler boundary');
  await writeFile(workerPath,worker.replace(anchor,`if(new URL(self.location.href).searchParams.has('qaBusy')) {
      self.postMessage({__qaBusy:true});
      const until=performance.now()+1000;while(performance.now()<until) {}
    }
    ${anchor}`));
  const executable=process.env.CHROME_EXECUTABLE;
  const executableMajor=executable ? Number(command(executable,['--version']).match(/\b(\d+)\./)?.[1]) : null;
  if(executable)assert.ok(Number.isSafeInteger(executableMajor),'the selected Chrome executable reports a version');
  // Chrome 116 predates Extensions.loadUnpacked. An explicit current executable
  // still uses CDP so an environment-wide path override needs no manual unset.
  const legacyLoad=Boolean(executable&&executableMajor<=116);
  const args=['--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update'];
  if(legacyLoad)args.push('--headless=new',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`);
  else args.push('--enable-unsafe-extension-debugging');
  context=await chromium.launchPersistentContext(join(scratch,'profile'),{
    ...(executable ? {executablePath:executable,headless:!legacyLoad} : {channel:process.env.CHROME_CHANNEL || 'chrome',headless:true}),
    acceptDownloads:false,ignoreDefaultArgs:['--disable-extensions'],args,viewport:{width:800,height:600},
  });
  const session=await context.browser().newBrowserCDPSession();
  await session.send('Target.setDiscoverTargets',{discover:true});
  let id;
  if(legacyLoad) {
    let background=context.serviceWorkers().find(worker=>worker.url().endsWith('/background.js'));
    if(!background)background=await context.waitForEvent('serviceworker',{predicate:worker=>worker.url().endsWith('/background.js'),timeout:15000});
    id=new URL(background.url()).hostname;
  } else ({id}=await session.send('Extensions.loadUnpacked',{path:extension}));
  const origin=`chrome-extension://${id}`,page=await context.newPage(),errors=[],httpRequests=[];
  let workerStarts=0;
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{if(/^https?:/.test(request.url()))httpRequests.push(request.url());});
  page.on('worker',()=>workerStarts++);
  await page.goto(`${origin}/qa-worker-test.html`);await page.waitForFunction(()=>globalThis.workerQAReady);
  const workerTargets=async()=>{
    const {targetInfos}=await session.send('Target.getTargets');
    return targetInfos.filter(info=>info.type==='worker'&&info.url.startsWith(origin));
  };
  const noWorkers=async()=>{
    for(let tries=0;tries<100;tries++) {
      if(!(await workerTargets()).length&&!page.workers().length)return;
      await sleep(25);
    }
    assert.fail('a dedicated worker remains alive after operation cleanup');
  };
  await noWorkers();
  const success=await page.evaluate(()=>workerQA.success());
  assert.ok(success.boxes>0);assert.equal(success.muxOwnership,true);assert.equal(success.remuxOwnership,true);assert.equal(success.closed,true);
  const muxPath=join(scratch,'worker-mux.mp4'),remuxPath=join(scratch,'worker-remux.mp4');
  await writeFile(muxPath,Buffer.from(success.mux));await writeFile(remuxPath,Buffer.from(success.remux));
  decode(muxPath,1.4);decode(remuxPath,1.9);await noWorkers();
  for(const kind of ['validate','mux','remux']) {
    const failed=await page.evaluate(kind=>workerQA.fail(kind),kind);
    assert.equal(failed.rejected,true,`${kind} malformed input rejects`);assert.ok(failed.message);assert.equal(failed.closed,true);await noWorkers();
  }
  const cancellations=[];
  for(const kind of ['validate','mux','remux']) {
    await page.evaluate(kind=>workerQA.startBusy(kind),kind);
    await page.waitForFunction(()=>workerQA.snapshot()?.started);
    assert.ok(page.workers().length>0,'the real module worker is alive at the busy barrier');
    const targets=(await workerTargets()).length;
    await page.waitForFunction(()=>{const snapshot=workerQA.snapshot();return snapshot.beats>=snapshot.beatsAtMarker+3;});
    await page.locator('#abort').click();
    await page.waitForFunction(()=>workerQA.snapshot()?.state==='aborted');
    const stopped=await page.evaluate(()=>workerQA.snapshot());
    assert.equal(stopped.error,'AbortError');assert.equal(stopped.success,false);assert.equal(stopped.closed,true);
    assert.ok(stopped.elapsed<1000,`UI abort settles promptly: ${stopped.elapsed}ms`);
    await noWorkers();
    await page.waitForTimeout(1050);
    assert.equal((await page.evaluate(()=>workerQA.snapshot())).state,'aborted','a terminated busy worker cannot later overwrite the stopped state');
    cancellations.push({kind,abortMs:Math.round(stopped.elapsed),heartbeatWhileBusy:true,cdpWorkerTargetsAtBarrier:targets,testCopyBusyBarrier:true});
  }
  await page.evaluate(()=>workerQA.startBusy('validate',{timeoutMs:150}));
  await page.waitForFunction(()=>workerQA.snapshot()?.state==='failed');
  const timeout=await page.evaluate(()=>workerQA.snapshot());
  assert.match(timeout.message,/時間/);assert.equal(timeout.closed,true);await noWorkers();
  for(let iteration=0;iteration<10;iteration++) {
    assert.equal(await page.evaluate(()=>workerQA.repeat()),188);await noWorkers();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(httpRequests,[],'the harness makes no HTTP/HTTPS requests');
  assert.equal(await page.evaluate(async()=>(await chrome.downloads.search({})).length),0,'worker processing never starts a Chrome download');
  const version=await session.send('Browser.getVersion');
  console.log(JSON.stringify({result:'PASS',browser:version.product,launch:legacyLoad ? 'CHROME_EXECUTABLE with headless=new and load-extension' : 'current Chrome with Extensions.loadUnpacked',realParserSuccess:['validate','mux','remux'],fullDecode:['mux H264/AAC','TS-remux H264/AAC'],transferOwnership:true,malformedInputFailures:3,cancellations,timeoutCleanup:true,repeatCleanup:10,workersStarted:workerStarts,remainingPageWorkers:page.workers().length,cdpDedicatedWorkersObservable:cancellations.some(item=>item.cdpWorkerTargetsAtBarrier>0),remainingWorkerTargets:(await workerTargets()).length,pageHttpRequests:0,downloads:0,testHook:'Only cancellation/timeout uses the temporary-copy pre-parse busy barrier; parser success and malformed-input checks use the unmodified endpoint path.'}));
  if(process.env.QA_KEEP)console.log(`QA files retained locally: ${scratch}`);
} finally {
  await context?.close();
  if(!process.env.QA_KEEP)await rm(scratch,{recursive:true,force:true});
}
