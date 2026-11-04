// Genuine 30-minute wall-clock recording in a disposable Chrome profile.
// The native capture input and capture lock are synthetic; MediaRecorder, clocks,
// RecorderController thresholds, background tabs and output bytes are real.
// This does not exercise an OS picker, screen/audio permissions or real system audio.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {spawn,spawnSync} from 'node:child_process';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ACTIVE_LIMIT=30*60*1000,DEADLINE=33*60*1000;
const scratch=await mkdtemp(join(tmpdir(),'videoharbor-recording-endurance-'));
const extension=join(scratch,'extension'),downloads=join(scratch,'downloads');
let context,browser,ownedChrome,interrupted=false;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const stop=()=>{interrupted=true;void browser?.close().catch(()=>{});ownedChrome?.kill('SIGTERM');};
process.once('SIGINT',stop);process.once('SIGTERM',stop);
const watchdog=setTimeout(stop,DEADLINE);watchdog.unref();

const fixture=`import {RecorderController} from './recorder.js';
globalThis.endurance={locked:false,acquisitions:0,releases:0,paints:0,sources:[],updates:0,last:null};
const state=globalThis.endurance;
async function capture() {
  const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
  const drawing=canvas.getContext('2d');let count=0;
  const paint=()=>{drawing.fillStyle=\`hsl(\${count++%360} 65% 45%)\`;drawing.fillRect(0,0,160,90);drawing.fillStyle='#fff';drawing.fillRect(count%140,30,20,20);state.paints++;};
  paint();const video=canvas.captureStream(1),audioContext=new AudioContext({sampleRate:48000});
  const oscillator=audioContext.createOscillator(),gain=audioContext.createGain(),destination=audioContext.createMediaStreamDestination();
  oscillator.frequency.value=440;gain.gain.value=0.025;oscillator.connect(gain).connect(destination);oscillator.start();await audioContext.resume();
  const stream=new MediaStream([...video.getTracks(),...destination.stream.getTracks()]);
  const source={stream,audioContext,oscillator,timer:setInterval(paint,1000),closed:false};state.sources.push(source);
  return stream;
}
Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:capture});
globalThis.recorder=new RecorderController({source:{title:'Synthetic endurance recording'},
  acquire:async()=>{if(state.locked)throw new Error('Synthetic lock already held');state.locked=true;state.acquisitions++;return {};},
  release:async()=>{
    state.releases++;state.locked=false;
    for(const source of state.sources)if(!source.closed){
      source.tracksStoppedBeforeFixtureCleanup=source.stream.getTracks().every(track=>track.readyState==='ended');
      clearInterval(source.timer);source.oscillator.stop();await source.audioContext.close();source.closed=true;
    }
  },
  onUpdate:snapshot=>{state.updates++;state.last=snapshot;},
});
globalThis.enduranceSnapshot=()=>({snapshot:recorder.snapshot(),locked:state.locked,acquisitions:state.acquisitions,releases:state.releases,paints:state.paints,
  visibility:document.visibilityState,updates:state.updates,sources:state.sources.map(source=>({tracks:source.stream.getTracks().map(track=>({kind:track.kind,state:track.readyState})),
    tracksStoppedBeforeFixtureCleanup:source.tracksStoppedBeforeFixtureCleanup,audioContext:source.audioContext.state,closed:source.closed}))});
globalThis.enduranceReady=true;
`;

function command(binary,args,{maxBuffer=8*1024*1024,timeout=120000}={}) {
  const result=spawnSync(binary,args,{encoding:'utf8',maxBuffer,timeout});
  assert.equal(result.status,0,`${binary} completed synthetic media analysis (${result.error?.code || 'exit '+result.status})`);
  return result.stdout;
}

try {
  await mkdir(downloads);await cp(fileURLToPath(new URL('../extension',import.meta.url)),extension,{recursive:true});
  const recorderSource=await readFile(join(extension,'recorder.js'),'utf8');
  assert.match(recorderSource,/const MAX_ACTIVE_MS = 30 \* 60 \* 1000;/,'test runs the production 30-minute threshold unchanged');
  await writeFile(join(extension,'endurance.html'),'<!doctype html><meta charset="utf-8"><title>Synthetic recording endurance</title><script type="module" src="endurance.js"></script>');
  await writeFile(join(extension,'endurance.js'),fixture);
  await mkdir(join(scratch,'profile','Default'),{recursive:true});
  await writeFile(join(scratch,'profile','Default','Preferences'),JSON.stringify({download:{default_directory:downloads,prompt_for_download:false,directory_upgrade:true}}));
  // connectOverCDP(noDefaults) avoids Playwright's per-session forced-visible
  // focus override, while this owned process still uses only our scratch profile.
  const executable=process.env.CHROME_EXECUTABLE || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  ownedChrome=spawn(executable,['--headless=new',`--user-data-dir=${join(scratch,'profile')}`,'--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',
    '--enable-unsafe-extension-debugging','--autoplay-policy=no-user-gesture-required','--no-first-run','--no-default-browser-check',
    '--disable-background-networking','--disable-component-update','--disable-default-apps','--disable-sync',
    '--use-mock-keychain','--password-store=basic','about:blank'],{stdio:'ignore'});
  let startupError;ownedChrome.once('error',error=>{startupError=error;});
  let port;
  for(let count=0;count<100;count++) {
    if(startupError)throw new Error('The isolated Chrome process could not start');
    try {port=Number((await readFile(join(scratch,'profile','DevToolsActivePort'),'utf8')).split('\n')[0]);if(port)break;}catch {}
    await sleep(100);
  }
  assert.ok(port,'the owned Chrome process opens its local debugging port');
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`,{noDefaults:true,isLocal:true});
  context=browser.contexts()[0];assert.ok(context);
  context.setDefaultTimeout(15000);
  const browserSession=await context.browser().newBrowserCDPSession();
  const {id}=await browserSession.send('Extensions.loadUnpacked',{path:extension});
  const manager=await context.newPage();await manager.goto(`chrome-extension://${id}/endurance.html`);await manager.waitForFunction(()=>globalThis.enduranceReady);
  const session=await context.newCDPSession(manager);await session.send('Performance.enable');
  const {targetInfo}=await session.send('Target.getTargetInfo');
  await session.send('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:true,...(targetInfo.browserContextId ? {browserContextId:targetInfo.browserContextId} : {})});
  const errors=[];manager.on('pageerror',()=>errors.push('extension-page error'));
  const started=performance.now(),startedAt=new Date().toISOString();
  assert.equal(await manager.evaluate(()=>recorder.start('display',true,'memory')),true);
  await sleep(1500);
  const pauseBefore=await manager.evaluate(()=>{recorder.pause();return recorder.snapshot().elapsed;});
  const pauseStart=performance.now();await sleep(2200);
  const pauseAfter=await manager.evaluate(()=>recorder.snapshot().elapsed);
  assert.equal(pauseAfter,pauseBefore,'real paused time does not advance the production active clock');
  assert.equal(await manager.evaluate(()=>recorder.resume()),true);
  const pauseWall=performance.now()-pauseStart;
  const foreground=await context.newPage();await foreground.goto('about:blank');await foreground.bringToFront();
  // Playwright enables focus emulation, which forces visibility even for a
  // real background tab. Disable that test-driver override, not page clocks.
  await session.send('Emulation.setFocusEmulationEnabled',{enabled:false});
  await sleep(300);
  const selection=await manager.evaluate(async()=>{const current=await chrome.tabs.getCurrent();const active=await chrome.tabs.query({active:true,windowId:current.windowId});return {currentActive:current.active,activeCount:active.length,currentId:current.id,activeId:active[0]?.id};});
  const initial=await manager.evaluate(()=>enduranceSnapshot());
  assert.equal(selection.currentActive,false,'the recording tab is not the selected tab');
  assert.equal(selection.activeCount,1);assert.notEqual(selection.currentId,selection.activeId);
  assert.equal(initial.visibility,'hidden','the recording tab starts genuinely hidden');
  assert.equal(initial.snapshot.audio,true,'the real recorder receives synthetic audio and video tracks');
  console.log(JSON.stringify({suite:'VideoHarbor recording endurance',stage:'started',browser:context.browser().version(),startedAt,
    activeLimitMs:ACTIVE_LIMIT,pauseWallMs:Math.round(pauseWall),background:true,visibility:initial.visibility,
    nonSelectedTab:true,syntheticCapture:true,nativeCapture:false,clocksModified:false}));
  let previousMinute=-1,completed;
  while(performance.now()-started<DEADLINE-30000) {
    if(interrupted)throw new Error('Endurance test interrupted or exceeded its deadline');
    const state=await manager.evaluate(()=>enduranceSnapshot());
    if(['recording','paused','finalizing'].includes(state.snapshot.phase))assert.equal(state.visibility,'hidden','the recording tab stays hidden during capture');
    const minute=Math.floor(state.snapshot.elapsed/60000);
    if(minute!==previousMinute) {
      previousMinute=minute;
      const metrics=await session.send('Performance.getMetrics');
      console.log(JSON.stringify({stage:'recording',activeMinute:minute,wallSeconds:Math.round((performance.now()-started)/1000),
        phase:state.snapshot.phase,bytes:state.snapshot.bytes,paints:state.paints,visibility:state.visibility,
        jsHeapUsedBytes:metrics.metrics.find(metric=>metric.name==='JSHeapUsedSize')?.value ?? null}));
    }
    if(!['recording','paused','finalizing'].includes(state.snapshot.phase)) {completed=state;break;}
    await sleep(1000);
  }
  assert.ok(completed,'production recorder automatically reaches a terminal state before the deadline');
  const wallElapsed=performance.now()-started;
  assert.equal(completed.snapshot.phase,'ready');assert.equal(completed.snapshot.resultReady,true);assert.equal(completed.snapshot.resultSaved,false);
  assert.match(completed.snapshot.message,/30分/,'the real production time threshold caused auto-stop');
  assert.ok(completed.snapshot.elapsed>=ACTIVE_LIMIT && completed.snapshot.elapsed<ACTIVE_LIMIT+90000,'auto-stop is within background timer scheduling tolerance');
  assert.ok(wallElapsed>=ACTIVE_LIMIT+pauseWall-500,'actual wall-clock time includes the real pause');
  assert.equal(completed.locked,false);assert.equal(completed.acquisitions,1);assert.equal(completed.releases,1);
  assert.equal(completed.sources.every(source=>source.tracksStoppedBeforeFixtureCleanup && source.tracks.every(track=>track.state==='ended')),true);
  assert.equal(completed.sources.every(source=>source.audioContext==='closed'),true,'synthetic generator contexts are cleaned after product track termination');
  assert.ok(completed.snapshot.bytes>0 && completed.snapshot.bytes<256*1024*1024);
  assert.deepEqual(errors,[]);
  // Export the actual result without invoking a native save picker.
  const downloadId=await manager.evaluate(async()=>{
    const file=await recorder.getResultFile();globalThis.enduranceURL=URL.createObjectURL(file);
    return chrome.downloads.download({url:globalThis.enduranceURL,filename:'VideoHarbor-endurance/synthetic-30-minute.webm',saveAs:false,conflictAction:'uniquify'});
  });
  let saved;
  for(let count=0;count<200;count++) {
    const [item]=await manager.evaluate(id=>chrome.downloads.search({id}),downloadId);
    if(item?.state==='complete'){saved=item;break;}
    assert.notEqual(item?.state,'interrupted','real synthetic result download is not interrupted');await sleep(50);
  }
  assert.ok(saved?.exists && saved.filename.startsWith(downloads+'/'));
  await manager.evaluate(()=>URL.revokeObjectURL(globalThis.enduranceURL));
  const probe=JSON.parse(command('ffprobe',['-v','error','-show_entries','format=format_name:stream=codec_type,codec_name','-of','json',saved.filename]));
  assert.match(probe.format.format_name,/webm/);assert.ok(probe.streams.some(stream=>stream.codec_type==='video'));assert.ok(probe.streams.some(stream=>stream.codec_type==='audio'));
  const videoPackets=command('ffprobe',['-v','error','-select_streams','v:0','-show_packets','-show_entries','packet=pts_time,duration_time','-of','csv=p=0',saved.filename]);
  const videoEnd=Math.max(...videoPackets.trim().split('\n').filter(Boolean).map(line=>{const [pts,duration]=line.split(',').map(Number);return pts+(Number.isFinite(duration)?duration:0);}));
  assert.ok(videoEnd>=ACTIVE_LIMIT/1000-90,'real encoded video spans the endurance interval');
  command('ffmpeg',['-hide_banner','-loglevel','error','-xerror','-err_detect','explode','-i',saved.filename,'-map','0:v','-map','0:a','-f','null','-']);
  await manager.evaluate(()=>recorder.discard());
  await session.send('HeapProfiler.collectGarbage');
  const final=await manager.evaluate(()=>enduranceSnapshot());
  assert.equal(final.snapshot.resultReady,false);assert.equal(final.snapshot.phase,'idle');assert.equal(final.locked,false);
  const result={suite:'VideoHarbor recording endurance',pass:true,browser:context.browser().version(),startedAt,finishedAt:new Date().toISOString(),
    activeElapsedMs:completed.snapshot.elapsed,wallElapsedMs:Math.round(wallElapsed),pausedWallMs:Math.round(pauseWall),background:true,
    visibilityState:initial.visibility,nonSelectedTab:true,backgroundVisibilityConfirmed:initial.visibility==='hidden',
    bytes:completed.snapshot.bytes,videoEndSeconds:videoEnd,realMediaRecorder:true,fullDecode:true,tracksEndedBeforeFixtureCleanup:true,
    syntheticAudioGeneratorClosed:true,recorderOwnedAudioContextApplicable:false,lockReleased:true,resultDiscarded:true,
    nativeCapture:false,nativeAudio:false,nativeSavePicker:false,clocksModified:false,thresholdsModified:false};
  if(process.env.QA_ENDURANCE_REPORT)await writeFile(process.env.QA_ENDURANCE_REPORT,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
} finally {
  clearTimeout(watchdog);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  await browser?.close();
  if(ownedChrome && ownedChrome.exitCode===null && ownedChrome.signalCode===null)await new Promise(resolve=>{
    const timer=setTimeout(()=>{ownedChrome.kill('SIGKILL');},5000);timer.unref();
    ownedChrome.once('exit',()=>{clearTimeout(timer);resolve();});ownedChrome.kill('SIGTERM');
  });
  await rm(scratch,{recursive:true,force:true});
}
