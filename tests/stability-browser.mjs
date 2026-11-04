// Local synthetic source and disposable profile. Sharing is simulated only at
// the OS boundary; real acquisition, worker validation, UI and recording run.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {launchTestExtension} from './chrome-runtime.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const scratch=await mkdtemp(join(tmpdir(),'videoharbor-stability-'));
const extension=join(scratch,'extension');let context,server,requests=0;
const run=(bin,args)=>{const r=spawnSync(bin,args,{encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);};
try {
  const clipPath=join(scratch,'clip.mp4');
  run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=12','-f','lavfi','-i','sine=frequency=600:sample_rate=48000','-t','4','-c:v','libx264','-preset','ultrafast','-threads','1','-c:a','aac','-movflags','+faststart',clipPath]);
  const clip=await readFile(clipPath),hash=createHash('sha256').update(clip).digest('hex');
  const playbackPath=join(scratch,'playback.webm');
  run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=12','-f','lavfi','-i','sine=frequency=600:sample_rate=48000','-t','4','-c:v','libvpx','-deadline','realtime','-threads','1','-c:a','libopus',playbackPath]);
  const playback=await readFile(playbackPath);
  server=createServer((req,res)=>{
    if(req.url==='/playback.webm'){res.writeHead(200,{'Content-Type':'video/webm','Content-Length':playback.length});res.end(playback);return;}
    if(req.url==='/clip.mp4'){
      requests++;const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const start=range ? Number(range[1]) : 0,end=range&&range[2] ? Math.min(Number(range[2]),clip.length-1) : clip.length-1;
      res.writeHead(range ? 206 : 200,{'Content-Type':'video/mp4','Content-Length':end-start+1,'Accept-Ranges':'bytes',...(range ? {'Content-Range':`bytes ${start}-${end}/${clip.length}`} : {})});
      res.end(clip.subarray(start,end+1));return;
    }
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end('<!doctype html><title>Stability fixture</title><video id="v" controls loop preload="auto" src="/playback.webm"></video><video id="blob" controls></video><a href="/clip.mp4">MP4 fixture</a><script>fetch("/clip.mp4").then(r=>r.blob()).then(b=>{document.querySelector("#blob").src=URL.createObjectURL(b);window.ready=true;});</script>');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
  await cp(fileURLToPath(new URL('../extension',import.meta.url)),extension,{recursive:true});
  const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['http://127.0.0.1/*'];
  await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
  await writeFile(join(extension,'background.js'),(await readFile(join(extension,'background.js'),'utf8'))+'\nglobalThis.__openWorkspace=openWorkspace;');
  await writeFile(join(extension,'workspace.js'),(await readFile(join(extension,'workspace.js'),'utf8'))+'\nglobalThis.__saver=mediaSaver;');
  const blobSource=await readFile(join(extension,'page-blob.js'),'utf8');
  await writeFile(join(extension,'page-blob.js'),blobSource.replace("  const key=Symbol.for('VideoHarbor.blobSnapshot');","  if(offset===-1)await new Promise(()=>{}); // test-only frozen API response\n  const key=Symbol.for('VideoHarbor.blobSnapshot');"));
  const runtime=await launchTestExtension(chromium,join(scratch,'profile'),extension,{ignoreDefaultArgs:['--disable-extensions'],args:['--autoplay-policy=no-user-gesture-required','--no-first-run'],viewport:{width:1200,height:900}});
  ({context}=runtime);context.setDefaultTimeout(15000);const errors=[];
  const sourceA=await context.newPage(),sourceB=await context.newPage();
  for(const [i,page] of [sourceA,sourceB].entries()){
    await page.goto(origin+`/source-${i}`);await page.waitForFunction(()=>window.ready);
    await page.evaluate(async()=>{const v=document.querySelector('#v');await v.play();v.pause();v.currentTime=0;});
    await page.waitForFunction(()=>document.querySelector('#v').readyState>=2&&!document.querySelector('#v').seeking);
  }
  async function open(page){const tab=await runtime.worker.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url),page.url());
    const [manager]=await Promise.all([context.waitForEvent('page'),runtime.worker.evaluate(tab=>__openWorkspace(tab),tab)]);
    manager.on('pageerror',error=>errors.push(error.name));await manager.waitForFunction(()=>globalThis.__saver&&document.querySelector('#count').textContent);return manager;}
  const a=await open(sourceA),b=await open(sourceB);
  // A real remote video recording continues past the source's 15-second lease
  // while an unrelated workspace's blob API never returns.
  assert.equal(await b.evaluate(async()=>{
    const {RecorderController}=await import('./recorder.js');
    const {prepareVideoCapture}=await import('./video-capture.js');
    const sessionId=new URL(location.href).searchParams.get('id'),instance='stability-browser';
    const send=async(type,extra={})=>{const r=await chrome.runtime.sendMessage({type,sessionId,instance,...extra});if(!r.ok)throw new Error(r.error);return r.data;};
    const state=await send('get'),ref=state.videoElements.find(ref=>ref.frameId===0&&ref.currentSrc?.endsWith('/playback.webm')) || state.videoElements.find(ref=>ref.frameId===0);
    window.probeRecorder=new RecorderController({source:state,acquire:mode=>send('capture',{mode}),release:()=>send('release'),prepareVideo:options=>prepareVideoCapture({send,...options})});
    return probeRecorder.start('video',true,'memory',ref);
  }),true);
  await a.evaluate(async()=>{
    const {MediaSaver}=await import('./media-save.js');const sessionId=new URL(location.href).searchParams.get('id');
    const send=async(type,extra={})=>{const r=await chrome.runtime.sendMessage({type,sessionId,instance:'stability-blob',...extra});if(!r.ok)throw new Error(r.error);return r.data;};
    const state=await send('get'),item=state.items.find(item=>item.type==='blob');if(!item)throw new Error('missing synthetic blob');
    window.stalledSaver=new MediaSaver({readBlob:(url,offset,token)=>send('blob-read',{url,offset,token})});
    window.stalledSave=stalledSaver.start(item,'Synthetic');
  });
  await a.waitForTimeout(18000);
  assert.equal(await b.evaluate(()=>probeRecorder.snapshot().phase),'recording');
  const stopAt=Date.now();await a.evaluate(()=>stalledSaver.cancel());
  await a.waitForFunction(()=>!stalledSaver.busy,{},{timeout:1000});assert.ok(Date.now()-stopAt<1500);
  await b.evaluate(()=>probeRecorder.stop());
  const bytes=await b.evaluate(async()=>Array.from(new Uint8Array(await(await probeRecorder.getResultFile()).arrayBuffer())));
  const recorded=join(scratch,'recorded.webm');await writeFile(recorded,new Uint8Array(bytes));
  run('ffmpeg',['-v','error','-i',recorded,'-f','null','-']);
  assert.equal(await b.evaluate(()=>probeRecorder.snapshot().phase),'ready');

  // Exercise the actual workspace direct-save handler with downloads absent.
  await a.evaluate(()=>{
    globalThis.chrome={...chrome,downloads:undefined};window.shares=[];window.shareFailure=true;
    Object.defineProperty(navigator,'canShare',{configurable:true,value:()=>true});
    Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{
      if(shareFailure)throw new DOMException('synthetic activation failure','NotAllowedError');
      const bytes=await data.files[0].arrayBuffer();
      shares.push({active:navigator.userActivation.isActive,name:data.files[0].name,hash:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('')});
    }});
  });
  const directId=await a.evaluate(()=>{const match=Array.from(document.querySelectorAll('.video-card')).find(card=>card.querySelector('.file-icon')?.textContent.includes('MP4'));return match?.dataset.candidateId;});
  assert.ok(directId);await a.locator(`.direct-save[data-candidate-id="${directId}"]`).click();await a.waitForFunction(()=>!__saver.busy&&__saver.retained());
  assert.equal(await a.evaluate(()=>__saver.retained()[1].status),'ready');
  assert.equal(await a.locator('#retained-media').isVisible(),true);
  const count=requests;await a.evaluate(()=>{shareFailure=false;});
  await a.locator('#save-retained-media').click();await a.waitForFunction(()=>shares.length===1);
  const shared=await a.evaluate(()=>shares[0]);assert.equal(shared.hash,hash);assert.equal(shared.active,true);assert.equal(shared.name.includes('/'),false);
  assert.equal(requests,count,'retry shares the retained payload without a network request');
  assert.equal(await a.evaluate(()=>__saver.retained()[1].status),'shared');
  assert.equal((await a.locator('#retained-media-message').textContent()).includes('保存完了'),false);
  await a.locator('#scan').click();await a.waitForFunction(()=>!document.querySelector('#scan').disabled);
  assert.equal(await a.locator('#retained-media').isVisible(),true);
  a.on('dialog',dialog=>dialog.accept());await a.locator('#discard-retained-media').click();
  assert.equal(await a.evaluate(()=>__saver.retained()),undefined);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:'PASS',browser:await runtime.worker.evaluate(()=>navigator.userAgent),leaseSurvivedSeconds:18,cancelResponsive:true,fullWebMDecode:true,directMp4WorkerValidation:true,directMp4Hash:hash,sharedOnlyOnExplicitRetry:true,realUserActivation:true,retainedAcrossRescan:true,shareBoundary:'synthetic; not native Safari persistence'}));
} finally {await context?.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await rm(scratch,{recursive:true,force:true});}
