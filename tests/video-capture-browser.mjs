// Local, isolated profiles only. This exercises real element capture, messaging,
// MediaRecorder, result playback and download; native prompts and human listening
// remain separate manual QA.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {launchTestExtension} from './chrome-runtime.mjs';
import {candidateLocator,candidateCount,assertPrivateDOM} from './privacy-browser-helpers.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo=fileURLToPath(new URL('../',import.meta.url));
const scratch=await mkdtemp(join(tmpdir(),'videoharbor-video-only-qa-'));
const extension=join(scratch,'extension');
let context,server,crossServer;
const pageErrors=[],results=[];
const watchdog=setTimeout(()=>{console.error('Video capture QA deadline exceeded');void context?.close();},180000);
const command=(tool,args)=>{
  const run=spawnSync(tool,args,{maxBuffer:32*1024*1024});
  assert.equal(run.status,0,`${tool}: ${run.error?.message || run.stderr?.toString()}`);
  return run.stdout;
};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function makeVideo(name,color,frequency) {
  command('ffmpeg',['-v','error','-nostdin','-y','-f','lavfi','-i',`color=${color}:size=320x180:rate=12`,
    ...(frequency ? ['-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=48000`] : []),
    '-t','12','-c:v','libvpx','-deadline','realtime','-cpu-used','8','-g','12','-pix_fmt','yuv420p','-threads','1',
    ...(frequency ? ['-c:a','libopus'] : ['-an']),join(scratch,name+'.webm')]);
  return readFile(join(scratch,name+'.webm'));
}
async function analyze(path,{audio=true,color='red',frequency=440}={}) {
  const probe=JSON.parse(command('ffprobe',['-v','error','-show_streams','-show_packets','-show_entries','stream=index,codec_type,width,height:packet=stream_index,pts_time,duration_time','-of','json',path]));
  const video=probe.streams.find(stream=>stream.codec_type==='video');
  assert.equal(video?.width,320);assert.equal(video?.height,180,'recording uses source pixels, not the page layout');
  assert.equal(probe.streams.some(stream=>stream.codec_type==='audio'),audio,'actual saved audio presence');
  command('ffmpeg',['-v','error','-nostdin','-xerror','-err_detect','explode','-i',path,'-f','null','-']);
  const frame=command('ffmpeg',['-v','error','-nostdin','-i',path,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','-']);
  const average=[0,0,0];for(let index=0;index<frame.length;index++)average[index%3]+=frame[index]/(frame.length/3);
  if(color==='red'||color==='blue') {
    let expected=0;for(let index=0;index<frame.length;index+=3)if(color==='red' ? frame[index]>200&&frame[index+1]<70&&frame[index+2]<70 : frame[index+2]>200&&frame[index]<70&&frame[index+1]<70)expected++;
    assert.ok(expected/(frame.length/3)>0.999,`more than 99.9% of pixels belong to the target color: ${average}`);
  }
  let audioRatio;
  if(audio&&frequency) {
    const pcm=command('ffmpeg',['-v','error','-nostdin','-i',path,'-map','0:a','-ac','1','-ar','48000','-f','f32le','-']);
    const samples=new Float32Array(pcm.buffer,pcm.byteOffset,Math.floor(pcm.byteLength/4));
    const power=f=>{let s=0,c=0;for(let index=0;index<samples.length;index++){const angle=2*Math.PI*f*index/48000;s+=samples[index]*Math.sin(angle);c+=samples[index]*Math.cos(angle);}return s*s+c*c;};
    audioRatio=power(frequency)/Math.max(power(frequency===440?1200:440),1e-10);
    assert.ok(audioRatio>100,`target sound dominates the unrelated video by >20dB: ${audioRatio}`);
  }
  const times=probe.packets.filter(packet=>packet.stream_index===video.index).map(packet=>Number(packet.pts_time));
  assert.ok(Math.max(...times)-Math.min(...times)>0.25,'the output has multiple real video frames');
  return {bytes:(await readFile(path)).length,average,audioRatio,videoSeconds:Math.max(...times)-Math.min(...times)};
}
async function screenshot(manager,name) {
  if(!process.env.QA_SCREENSHOT_DIR)return;
  await mkdir(process.env.QA_SCREENSHOT_DIR,{recursive:true});
  for(const width of [1280,360,320]) {
    await manager.setViewportSize({width,height:width===1280?900:800});
    await manager.evaluate(()=>scrollTo(0,0));
    assert.ok(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`no horizontal overflow at ${width}px`);
    await manager.screenshot({path:join(process.env.QA_SCREENSHOT_DIR,`${name}-${width}.png`),fullPage:name==='prepare',animations:'disabled'});
  }
  await manager.setViewportSize({width:1280,height:900});
}
async function getSavedRecording(manager,name) {
  assert.equal(await manager.locator('#save-record').isVisible(),true,JSON.stringify(await manager.evaluate(()=>({name:document.querySelector('#record-state').textContent,phase:document.querySelector('#record-state').dataset.state,message:document.querySelector('#record-message').textContent,requests:globalThis.__qaVideoRequests?.slice(-20)}))));
  const before=await manager.evaluate(async()=>(await chrome.downloads.search({})).map(item=>item.id));
  await manager.locator('#save-record').click();
  await manager.waitForFunction(()=>document.querySelector('#record-state').dataset.state==='saved',{},{timeout:15000});
  const download=await manager.evaluate(async before=>(await chrome.downloads.search({})).find(item=>!before.includes(item.id)),before);
  assert.equal(download?.state,'complete');assert.equal(download.exists,true);
  assert.ok(download.filename.startsWith(scratch+'/'),'actual download stays inside isolated temporary output');
  const path=join(scratch,name+'.webm');await cp(download.filename,path);return path;
}
async function discard(manager) {
  if(await manager.locator('#discard-record').isVisible())await manager.locator('#discard-record').click();
}
async function scan(manager) {
  await manager.locator('#download-tab').click();await manager.locator('#scan').click();
  await manager.waitForFunction(()=>!document.querySelector('#scan').disabled);
}
async function select(manager,title,fromSelector=false) {
  if(fromSelector) {
    await manager.locator('#record-tab').click();
    await manager.locator('[name="record-mode"][value="video"]').check();
    const matches=await manager.locator('#record-video option').evaluateAll((options,title)=>options
      .filter(option=>option.textContent===title || option.textContent===title+' · 再生中')
      .map(option=>option.value),title);
    assert.equal(matches.length,1,`one current video option for ${title}`);
    await manager.locator('#record-video').selectOption(matches[0]);
  } else {
    await manager.locator('#download-tab').click();
    const group=manager.locator('.video-group').filter({has:manager.getByRole('heading',{name:title,exact:true})});
    assert.equal(await group.count(),1,`one actual video group for ${title}: ${JSON.stringify(await manager.locator('.video-title').allTextContents())}`);
    await group.locator('.record-video-button').click();
  }
  assert.equal(await manager.locator('[name="record-mode"]:checked').inputValue(),'video');
  assert.ok([title,title+' · 再生中'].includes(await manager.locator('#record-video option:checked').textContent()),`the selected option is exactly ${title}`);
}
async function start(manager,{position='continue'}={}) {
  await manager.locator('#start-record').click();
  await manager.waitForFunction(()=>['recording','awaiting-position-decision','awaiting-audio-decision','error'].includes(document.querySelector('#record-state').dataset.state),{},{timeout:15000}).catch(async error=>{
    console.error('video-only start timeout',await manager.evaluate(()=>({phase:document.querySelector('#record-state').dataset.state,message:document.querySelector('#record-message').textContent,startError:globalThis.__qaStartError,requests:globalThis.__qaVideoRequests})),pageErrors);throw error;
  });
  if(position==='continue' && await manager.locator('#record-state').getAttribute('data-state')==='awaiting-position-decision') {
    await manager.locator('#continue-from-position').click();
    await manager.waitForFunction(()=>['recording','awaiting-audio-decision','error'].includes(document.querySelector('#record-state').dataset.state),{},{timeout:15000});
  }
}
async function setTargetPosition(page,time) {
  await page.locator('#target').evaluate(async(video,time)=>{
    video.pause();video.currentTime=time;
    const deadline=Date.now()+10000;
    while(video.seeking || Math.abs(video.currentTime-time)>0.05) {
      if(Date.now()>=deadline)throw new Error('Fixture seek timed out: '+JSON.stringify({expected:time,time:video.currentTime,seeking:video.seeking,readyState:video.readyState,error:video.error?.code}));
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  },time);
}
async function stopped(manager) {
  await manager.waitForFunction(()=>['ready','saved','error'].includes(document.querySelector('#record-state').dataset.state),{},{timeout:15000});
}
async function normalRecording(manager,title,name,{audio=true,color='red',frequency=440,duration=1000,fromSelector=false}={}) {
  console.log('video-only QA: '+name);
  await select(manager,title,fromSelector);await manager.locator('#record-audio').setChecked(audio);await start(manager);
  assert.equal(await manager.locator('#record-state').getAttribute('data-state'),'recording',(await manager.locator('#record-message').textContent())+' '+JSON.stringify(await manager.evaluate(()=>({error:globalThis.__qaStartError,requests:globalThis.__qaVideoRequests}))));
  await sleep(duration);await manager.locator('#stop-record').click();await stopped(manager);
  assert.equal(await manager.locator('#record-state').getAttribute('data-state'),'ready',await manager.locator('#record-message').textContent());
  const path=await getSavedRecording(manager,name),data=await analyze(path,{audio,color,frequency});
  results.push({test:name,...data});await discard(manager);return path;
}
try {
  const target=await makeVideo('target','red',440),other=await makeVideo('other','blue',1200),silent=await makeVideo('silent','green',0),mse=await makeVideo('mse','red',0);
  const media=(req,res)=>{
    const bytes=req.url.includes('other')?other:req.url.includes('silent')?silent:req.url.includes('mse')?mse:target;
    res.setHeader('content-type','video/webm');res.setHeader('accept-ranges','bytes');
    const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if(range) {
      const start=Number(range[1]),end=range[2] ? Math.min(Number(range[2]),bytes.length-1) : bytes.length-1;
      if(start>=bytes.length || start>end) {res.writeHead(416,{'content-range':`bytes */${bytes.length}`});return res.end();}
      res.writeHead(206,{'content-range':`bytes ${start}-${end}/${bytes.length}`,'content-length':end-start+1});return res.end(bytes.subarray(start,end+1));
    }
    res.setHeader('content-length',bytes.length);res.end(bytes);
  };
  let origin,crossOrigin;
  crossServer=createServer((req,res)=>{
    if(req.url==='/autoplay-only'){res.setHeader('content-type','text/html; charset=utf-8');return res.end('<!doctype html><title>Fresh autoplay origin</title><h1>NO SOURCE PAGE GESTURE</h1><video title="初回未再生動画" preload="none" src="/target.webm"></video>');}
    if(req.url==='/frame'){res.setHeader('content-type','text/html; charset=utf-8');return res.end('<!doctype html><video title="別origin埋め込み" loop src="/target.webm"></video>');}
    if(req.url.startsWith('/allow.webm'))res.setHeader('access-control-allow-origin','*');
    media(req,res);
  });
  await new Promise(resolve=>crossServer.listen(0,'127.0.0.1',resolve));crossOrigin=`http://127.0.0.1:${crossServer.address().port}`;
  server=createServer((req,res)=>{
    if(new URL(req.url,'http://fixture.test').pathname.endsWith('.webm'))return media(req,res);
    if(req.url==='/frame'){res.setHeader('content-type','text/html; charset=utf-8');return res.end('<!doctype html><video title="同origin埋め込み" loop src="/target.webm"></video>');}
    res.setHeader('content-type','text/html; charset=utf-8');res.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>Video-only synthetic fixture</title><body style="background:lime"><h1>PAGE TEXT MUST NEVER APPEAR</h1><div style="position:absolute;top:60px;left:5px;background:yellow;z-index:10">OVERLAY MUST NEVER APPEAR</div><video id="target" title="赤い対象動画" preload="none" loop controls width="150" height="80" src="/target.webm"></video><video id="other" title="青い別動画" loop controls src="/other.webm"></video><video id="silent" title="音声なし動画" loop src="/silent.webm"></video><video id="allowed" title="CORS許可動画" loop crossorigin="anonymous" src="${crossOrigin}/allow.webm"></video><video id="denied" title="CORS不許可動画" loop src="${crossOrigin}/deny.webm"></video><video id="object" title="srcObject動画"></video><video id="mse" title="MSE動画"></video><iframe id="same-frame" title="同origin埋め込み" src="/frame"></iframe><iframe id="cross-frame" title="別origin埋め込み" src="${crossOrigin}/frame"></iframe></body></html>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  await cp(join(repo,'extension'),extension,{recursive:true});
  const background=join(extension,'background.js');await writeFile(background,(await readFile(background,'utf8'))+'\nglobalThis.__openWorkspace=openWorkspace;\n');
  // Diagnostics in the temporary copy only; no capture, ordering or writer behavior is replaced.
  const recorderPath=join(extension,'recorder.js');await writeFile(recorderPath,(await readFile(recorderPath,'utf8')).replace('} catch (error) {\n      if (op.pendingSession)', '} catch (error) {\n      globalThis.__qaStartError={name:error.name,message:error.message,stack:error.stack};\n      if (op.pendingSession)'));
  const adapterPath=join(extension,'video-capture.js');await writeFile(adapterPath,(await readFile(adapterPath,'utf8')).replace('if (!response || response.error)', '(globalThis.__qaVideoRequests ||= []).push({command,currentTime:response?.currentTime,ended:response?.ended,state:response?.state,reason:response?.reason,failure:response?.failure,error:response?.error});\n      if (!response || response.error)'));
  const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['http://127.0.0.1/*'];await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
  const downloadFolder=join(scratch,'downloads');await mkdir(downloadFolder);
  const defaultProfile=join(scratch,'profile','Default');await mkdir(defaultProfile,{recursive:true});
  await writeFile(join(defaultProfile,'Preferences'),JSON.stringify({download:{default_directory:downloadFolder,prompt_for_download:false,directory_upgrade:true}}));
  console.log('video-only QA: generated local fixtures; starting isolated Chrome');
  const runtime=await launchTestExtension(chromium,join(scratch,'profile'),extension,{acceptDownloads:false,viewport:{width:1280,height:900},ignoreDefaultArgs:['--disable-extensions'],args:['--no-first-run']});
  context=runtime.context;const {worker}=runtime;
  // Fresh origin, no source-page click, and Chrome's default autoplay policy.
  // Only the real extension Start button is clicked before source play().
  console.log('video-only QA: default-policy playback from a fresh, unactivated origin');
  const firstSource=await context.newPage();firstSource.on('pageerror',error=>pageErrors.push(error.message));await firstSource.goto(crossOrigin+'/autoplay-only');
  // Playwright evaluate() marks calls as user gestures, even read-only queries.
  // CDP explicitly disables that flag to keep this source origin unactivated.
  const firstSourceCDP=await context.newCDPSession(firstSource);
  const firstActivation=async()=>(await firstSourceCDP.send('Runtime.evaluate',{expression:'navigator.userActivation.hasBeenActive',returnByValue:true,userGesture:false})).result.value;
  assert.equal(await firstActivation(),false,'the source origin has no prior user gesture');
  const firstTab=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url),crossOrigin+'/autoplay-only');
  const [firstManager]=await Promise.all([context.waitForEvent('page'),worker.evaluate(tab=>globalThis.__openWorkspace(tab),firstTab)]);
  firstManager.on('dialog',dialog=>dialog.accept());firstManager.on('pageerror',error=>pageErrors.push(error.message));await firstManager.waitForFunction(()=>document.querySelector('#count').textContent&&!document.querySelector('#scan').disabled);
  const firstCDP=await context.newCDPSession(firstManager);await firstCDP.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadFolder,eventsEnabled:true});
  assert.equal(await firstActivation(),false,'discovery did not activate the source page');
  await normalRecording(firstManager,'初回未再生動画','fresh-origin-default-policy',{fromSelector:true});
  assert.equal(await firstActivation(),true,'the real extension Start gesture reaches the selected source frame');
  assert.equal(await firstSource.locator('video').evaluate(video=>video.paused),false,'default-policy auto playback succeeds without prior source interaction');
  await firstManager.close();await firstSource.close();

  const page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));await page.goto(origin);console.log('video-only QA: preparing source playback');
  await page.evaluate(()=>{const button=document.createElement('button');button.id='qa-prepare-other-media';button.textContent='Prepare unrelated fixture media';document.body.prepend(button);});
  await page.locator('#qa-prepare-other-media').click();
  await page.evaluate(async()=>{
    for(const video of document.querySelectorAll('video:not(#target):not(#object):not(#mse)'))await Promise.race([video.play(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Playback timeout: '+video.id)),10000))]);
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const drawing=canvas.getContext('2d');drawing.fillStyle='red';drawing.fillRect(0,0,320,180);
    const stream=canvas.captureStream(12),audio=new AudioContext(),oscillator=audio.createOscillator(),destination=audio.createMediaStreamDestination();
    oscillator.frequency.value=440;oscillator.connect(destination);oscillator.start();await audio.resume();stream.addTrack(destination.stream.getAudioTracks()[0]);
    window.originalSyntheticStream=stream;window.originalSyntheticAudio=audio;window.syntheticTimer=setInterval(()=>{drawing.fillStyle='red';drawing.fillRect(0,0,320,180);},60);
    document.querySelector('#object').srcObject=stream;await document.querySelector('#object').play();
    const source=new MediaSource();window.syntheticMSE=source;document.querySelector('#mse').preload='auto';document.querySelector('#mse').src=URL.createObjectURL(source);document.querySelector('#mse').load();
    await new Promise((resolve,reject)=>{setTimeout(()=>reject(new Error('MSE preparation timeout '+JSON.stringify({source:source.readyState,media:document.querySelector('#mse').readyState,error:document.querySelector('#mse').error?.message}))),10000);source.addEventListener('sourceopen',async()=>{try{const buffer=source.addSourceBuffer('video/webm;codecs="vp8"');buffer.addEventListener('updateend',()=>{source.endOfStream();resolve();},{once:true});buffer.appendBuffer(await(await fetch('/mse.webm')).arrayBuffer());}catch(error){reject(error);}},{once:true});});
    document.querySelector('#mse').loop=true;await document.querySelector('#mse').play();
  });
  console.log('video-only QA: source playback ready');
  for(const frame of page.frames().filter(frame=>frame!==page.mainFrame())) {
    await frame.evaluate(()=>{const button=document.createElement('button');button.id='qa-prepare-frame';button.textContent='Prepare embedded fixture';document.body.prepend(button);});
    await frame.locator('#qa-prepare-frame').click();
    // Keep the same-URL clone paused, so the top-page target remains the one
    // representative without manually playing it before the autoplay test.
    if(frame.url()!==origin+'/frame')await frame.evaluate(async()=>{await document.querySelector('video').play();});
  }
  const tab=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url+'/'),origin);
  const [manager]=await Promise.all([context.waitForEvent('page'),worker.evaluate(tab=>globalThis.__openWorkspace(tab),tab)]);
  manager.on('dialog',dialog=>dialog.accept());manager.on('pageerror',error=>pageErrors.push(error.message));await manager.waitForFunction(()=>document.querySelector('#count').textContent&&!document.querySelector('#scan').disabled);
  const cdp=await context.newCDPSession(manager);await cdp.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadFolder,eventsEnabled:true});
  console.log('video-only QA: workspace and discovery ready');
  assert.equal(await manager.locator('.record-video-button').count(),8,'the shared top-page and same-origin frame URL has one video group');
  await assertPrivateDOM(manager,['/target.webm']);
  assert.equal(await manager.locator('#record-video option').evaluateAll(options=>options.filter(option=>option.value).length),8,'recording choices use the same eight representatives as the video cards');
  assert.equal(await manager.locator('#record-video option').evaluateAll(options=>options.filter(option=>option.textContent==='同origin埋め込み' || option.textContent==='同origin埋め込み · 再生中').length),0,'the same-URL frame does not add a duplicate recording choice');
  assert.equal(await candidateCount(manager,origin+'/target.webm','.direct-save'),1,'the shared top-page and same-origin frame URL has one save card');

  console.log('video-only QA: start a never-played source automatically');
  assert.deepEqual(await page.locator('#target').evaluate(video=>({paused:video.paused,time:video.currentTime})),{paused:true,time:0},'the user did not play the target first');
  await normalRecording(manager,'赤い対象動画','unplayed-autostart',{fromSelector:true});
  assert.equal(await page.locator('#target').evaluate(video=>video.paused),false,'starting video-only recording also plays the source');
  await scan(manager);

  console.log('video-only QA: warn before playing a paused source from its current position');
  await setTargetPosition(page,3);
  assert.ok(Math.abs(await page.locator('#target').evaluate(video=>video.currentTime)-3)<0.05,'the fixture actually seeks to the intended nonzero position');
  await select(manager,'赤い対象動画',true);await start(manager,{position:'wait'});
  assert.equal(await manager.locator('#record-state').getAttribute('data-state'),'awaiting-position-decision',JSON.stringify({source:await page.locator('#target').evaluate(video=>({time:video.currentTime,paused:video.paused})),requests:await manager.evaluate(()=>globalThis.__qaVideoRequests)}));
  assert.equal(await page.locator('#target').evaluate(video=>video.paused),true,'the source stays paused while the warning awaits a choice');
  assert.ok(Math.abs(await page.locator('#target').evaluate(video=>video.currentTime)-3)<0.05,'inspection does not rewind the source');
  assert.equal(await manager.locator('#save-record').isVisible(),false,'no recording result before confirmation');
  await screenshot(manager,'position-warning');
  await manager.locator('#cancel-position-start').click();
  await manager.waitForFunction(()=>!['starting','awaiting-position-decision'].includes(document.querySelector('#record-state').dataset.state));
  assert.equal(await page.locator('#target').evaluate(video=>video.paused),true,'cancel leaves the source paused');
  assert.ok(Math.abs(await page.locator('#target').evaluate(video=>video.currentTime)-3)<0.05,'cancel preserves the original playback position');
  assert.equal(await manager.evaluate(async()=>Boolean((await chrome.storage.session.get('captureLock')).captureLock)),false,'position cancellation releases recording ownership');
  await normalRecording(manager,'赤い対象動画','confirmed-current-position',{fromSelector:true});
  assert.ok(await page.locator('#target').evaluate(video=>video.currentTime)>3.25,'confirmation plays from the accepted current position');

  console.log('video-only QA: a rejected play request fails without capturing the page');
  await setTargetPosition(page,0);
  // Replace only this local fixture's isolated-world play boundary. Actual capture,
  // source messaging, controller cleanup and lock release remain production code.
  await worker.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>{
    const video=document.querySelector('#target');video.__qaOriginalPlay=video.play;
    video.play=()=>Promise.reject(new DOMException('Synthetic policy rejection','NotAllowedError'));
  }}),tab.id);
  await select(manager,'赤い対象動画',true);await start(manager);
  assert.equal(await manager.locator('#record-state').getAttribute('data-state'),'error');
  assert.match(await manager.locator('#record-message').textContent(),/再生|開始/);
  assert.equal(await manager.locator('[name="record-mode"]:checked').inputValue(),'video','play rejection never falls back to page capture');
  assert.equal(await manager.locator('#save-record').isVisible(),false,'a rejected start produces no completed recording');
  assert.equal(await page.locator('#target').evaluate(video=>video.paused),true);
  assert.equal(await manager.evaluate(async()=>Boolean((await chrome.storage.session.get('captureLock')).captureLock)),false,'play rejection releases recording ownership');
  await worker.evaluate(async tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>{
    const video=document.querySelector('#target');video.play=video.__qaOriginalPlay;delete video.__qaOriginalPlay;
  }}),tab.id);

  console.log('video-only QA: an ended source warns before restarting from the beginning');
  await page.locator('#target').evaluate(async video=>{
    video.loop=false;video.currentTime=video.duration-0.15;
    const deadline=Date.now()+10000;
    await Promise.race([video.play(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Fixture ended playback start timed out')),10000))]);
    while(!video.ended) {
      if(Date.now()>=deadline)throw new Error('Fixture ending timed out: '+JSON.stringify({time:video.currentTime,duration:video.duration,paused:video.paused,seeking:video.seeking,readyState:video.readyState,error:video.error?.code}));
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  });
  await select(manager,'赤い対象動画',true);await start(manager,{position:'wait'});
  assert.equal(await manager.locator('#record-state').getAttribute('data-state'),'awaiting-position-decision');
  assert.equal(await page.locator('#target').evaluate(video=>video.ended),true,'inspection does not restart an ended source');
  assert.equal(await manager.locator('#continue-from-position').textContent(),'先頭から録画');
  await manager.locator('#continue-from-position').click();
  await manager.waitForFunction(()=>document.querySelector('#record-state').dataset.state==='recording',{},{timeout:15000});
  assert.equal(await page.locator('#target').evaluate(video=>video.paused),false);
  assert.ok(await page.locator('#target').evaluate(video=>video.currentTime)<3,'an ended source restarts at the beginning after confirmation');
  await sleep(900);
  assert.ok(await page.locator('#target').evaluate(video=>video.currentTime)>0.5,'the restarted source actually advances from the beginning');
  await manager.locator('#stop-record').click();await stopped(manager);
  const endedOutput=await getSavedRecording(manager,'ended-confirmed-restart');results.push({test:'ended-confirmed-restart',...await analyze(endedOutput)});await discard(manager);
  await page.locator('#target').evaluate(video=>{video.loop=true;});

  console.log('video-only QA: record target with background/pause/seek');
  await select(manager,'赤い対象動画');await screenshot(manager,'prepare');await start(manager);
  assert.equal(await manager.locator('#record-state').getAttribute('data-state'),'recording',(await manager.locator('#record-message').textContent())+' '+JSON.stringify(await manager.evaluate(()=>({error:globalThis.__qaStartError,requests:globalThis.__qaVideoRequests}))));
  await manager.bringToFront();await sleep(1100);await screenshot(manager,'recording');
  await manager.locator('#pause-record').click();await manager.waitForFunction(()=>document.querySelector('#record-state').dataset.state==='paused');
  await sleep(200);await manager.locator('#pause-record').click();await manager.waitForFunction(()=>document.querySelector('#record-state').dataset.state==='recording');
  await page.evaluate(async()=>{const target=document.querySelector('#target');target.pause();await new Promise(resolve=>setTimeout(resolve,200));target.currentTime=3;await target.play();target.style.width='75px';scrollTo(0,document.body.scrollHeight);});
  await sleep(1100);assert.equal(await manager.locator('#record-state').getAttribute('data-state'),'recording','source pause, seek, scroll and resizing do not turn into a capture failure');
  await manager.locator('#stop-record').click();await stopped(manager);await screenshot(manager,'result');
  assert.equal(await manager.locator('#record-state').getAttribute('data-state'),'ready',await manager.locator('#record-message').textContent());
  await manager.locator('#play-result').click();await manager.waitForFunction(()=>{const video=document.querySelector('#result-playback');return !video.hidden&&video.readyState>=2;});
  const output=await getSavedRecording(manager,'selected-only');results.push({test:'selected-only-background-pause-seek-scroll',...await analyze(output)});await discard(manager);

  await page.evaluate(()=>{document.querySelector('#target').muted=true;});await select(manager,'赤い対象動画');await start(manager);
  assert.equal(await manager.locator('#record-state').getAttribute('data-state'),'awaiting-audio-decision','source mute is explicitly handled before recording');
  await manager.locator('#cancel-record-start').click();await manager.waitForFunction(()=>!['starting','awaiting-audio-decision'].includes(document.querySelector('#record-state').dataset.state));
  await start(manager);await manager.locator('#continue-without-audio').click();await manager.waitForFunction(()=>document.querySelector('#record-state').dataset.state==='recording');
  await sleep(900);await manager.locator('#stop-record').click();await stopped(manager);const silentResult=await getSavedRecording(manager,'muted-explicitly-silent');results.push({test:'muted-explicitly-silent',...await analyze(silentResult,{audio:false})});await discard(manager);await page.evaluate(()=>{document.querySelector('#target').muted=false;});

  await select(manager,'CORS不許可動画');await start(manager);assert.equal(await manager.locator('#record-state').getAttribute('data-state'),'error');
  assert.match(await manager.locator('#record-message').textContent(),/取得|制限|保護/);assert.equal(await manager.locator('[name="record-mode"]:checked').inputValue(),'video','CORS failure never changes to whole-tab recording');
  await normalRecording(manager,'CORS許可動画','cors-allowed');
  await normalRecording(manager,'MSE動画','mse-playback',{audio:false});
  const sameFrame=page.frames().find(frame=>frame.url()===origin+'/frame');
  assert.ok(sameFrame,'the same-origin recording fixture is still present');
  await sameFrame.evaluate(async()=>{const video=document.querySelector('video');video.src='/target.webm?frame=1';await video.play();});
  await scan(manager);
  assert.equal(await manager.locator('#record-video option').evaluateAll(options=>options.filter(option=>option.value).length),9,'a frame with a distinct complete URL becomes its own recording choice');
  assert.equal(await manager.locator('#record-video option').evaluateAll(options=>options.filter(option=>option.textContent==='同origin埋め込み' || option.textContent==='同origin埋め込み · 再生中').length),1,'the query-distinct frame has one exact recording choice');
  assert.equal(await candidateCount(manager,origin+'/target.webm?frame=1','.direct-save'),1,'the query-distinct frame retains its own save card');
  await assertPrivateDOM(manager,['/target.webm','/target.webm?frame=1']);
  await normalRecording(manager,'同origin埋め込み','same-origin-frame',{fromSelector:true});
  await normalRecording(manager,'別origin埋め込み','cross-origin-frame');
  await normalRecording(manager,'srcObject動画','src-object');
  assert.equal(await page.evaluate(()=>originalSyntheticStream.getTracks().every(track=>track.readyState==='live')),true,'capture cleanup preserves the original srcObject tracks');


  // Only the picker boundary is replaced; the origin-private handle, writable,
  // ordered writes, close and getFile are real browser implementations.
  await manager.evaluate(async()=>{
    const directory=await navigator.storage.getDirectory();
    window.__qaOutput=await directory.getFileHandle('video-only-streamed.webm',{create:true});
    window.showSaveFilePicker=async()=>window.__qaOutput;
  });
  console.log('video-only QA: real OPFS sequential writer');
  await select(manager,'赤い対象動画');await manager.locator('.output-settings > summary').click();await manager.locator('#record-output').selectOption('file');await manager.locator('#choose-file').click();
  await start(manager);assert.equal(await manager.locator('#record-state').getAttribute('data-state'),'recording');await sleep(900);
  await manager.locator('#stop-record').click();await stopped(manager);assert.equal(await manager.locator('#record-state').getAttribute('data-state'),'saved');
  const streamedPath=join(scratch,'real-opfs-streamed.webm');await writeFile(streamedPath,Buffer.from(await manager.evaluate(async()=>[...new Uint8Array(await(await window.__qaOutput.getFile()).arrayBuffer())])));
  results.push({test:'real-opfs-sequential-writer',...await analyze(streamedPath)});await discard(manager);await manager.locator('#record-output').selectOption('memory');

  // Automatic source ending finalizes, and a source replacement never follows the new video.
  await select(manager,'赤い対象動画');await start(manager);await sleep(700);
  await page.evaluate(()=>{const target=document.querySelector('#target');target.loop=false;target.currentTime=target.duration-0.6;});await stopped(manager);
  assert.equal(await manager.locator('#record-state').getAttribute('data-state'),'ready',await manager.locator('#record-message').textContent());
  assert.match(await manager.locator('#record-message').textContent(),/終了/);await discard(manager);
  await page.evaluate(async()=>{const target=document.querySelector('#target');target.loop=true;target.currentTime=0;await target.play();});
  await select(manager,'赤い対象動画');await start(manager);await sleep(700);await page.evaluate(async()=>{const target=document.querySelector('#target');target.src='/other.webm';await target.play();});await stopped(manager);
  assert.equal(await manager.locator('[name="record-mode"]:checked').inputValue(),'video');assert.match(await manager.locator('#record-message').textContent(),/変わ|構成|終了|取得/);await discard(manager);
  await scan(manager);await select(manager,'赤い対象動画');await start(manager);await sleep(900);await page.close();await stopped(manager);
  assert.equal(await manager.locator('#record-state').getAttribute('data-state'),'error','source disappearance is a recoverable error, not successful completion');
  assert.match(await manager.locator('#record-message').textContent(),/取得済|接続|終了/);assert.equal(await manager.locator('#save-record').isVisible(),true,'received bytes can be rescued after source loss');
  assert.equal(await manager.evaluate(async()=>Boolean((await chrome.storage.session.get('captureLock')).captureLock)),false,'recording ownership is released');
  assert.deepEqual(pageErrors,[],'no uncaught source or extension page errors');
  console.log(JSON.stringify({result:'PASS',chrome:await worker.evaluate(()=>navigator.userAgent),results,autoplayPolicy:'Chrome default; fresh source origin inactive before the real extension Start click',syntheticRejection:'isolated-world play boundary only',screenshots:process.env.QA_SCREENSHOT_DIR||null,nativePromptsAndHumanListening:'not tested'}));
  if(process.env.QA_KEEP)console.log(`QA files retained locally: ${scratch}`);
} finally {
  clearTimeout(watchdog);await context?.close();if(server)await new Promise(resolve=>server.close(resolve));if(crossServer)await new Promise(resolve=>crossServer.close(resolve));
  if(!process.env.QA_KEEP)await rm(scratch,{recursive:true,force:true});
}
