// Real Chrome downloads survive a closed workspace and service-worker restart.
// Only the first download API reply is delayed; its network request and files are real.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,mkdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {launchTestExtension} from './chrome-runtime.mjs';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo=fileURLToPath(new URL('../',import.meta.url));
const scratch=await mkdtemp(join(tmpdir(),'videoharbor-session-privacy-'));
const extension=join(scratch,'extension'),downloadsDirectory=join(scratch,'downloads');
let context,server,clip=Buffer.alloc(0);
const pendingResponses=new Map(),completedRequests=new Set();
const errors=[];
const paths=['/SESSION_PATH_FIRST.webm','/SESSION_PATH_SECOND.webm','/SESSION_PATH_THIRD.webm'];
const queryValues=['SESSION_QUERY_FIRST','SESSION_QUERY_SECOND','SESSION_QUERY_THIRD'];

async function eventually(predicate,message,timeout=20000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {if(await predicate())return;await delay(40);}
  assert.fail(message);
}
function finishResponse(path) {
  const response=pendingResponses.get(path);
  assert.ok(response,'the expected synthetic download request reached the local server');
  pendingResponses.delete(path);response.end(clip.subarray(16));completedRequests.add(path);
}
const sessionState=(observer,id)=>observer.evaluate(async id=>(await chrome.storage.session.get('workspace:'+id))['workspace:'+id],id);
function assertMinimalState(state,{queued,accepted,acceptedId}) {
  assert.ok(state,'a pending batch retains its session');
  assert.deepEqual(Object.keys(state).sort(),['closed','id','jobs'],'only the closed batch projection remains');
  assert.equal(state.closed,true);
  assert.equal(state.jobs.filter(job=>job.status==='queued').length,queued,'only unaccepted operations retain retrieval information');
  assert.equal(state.jobs.filter(job=>job.status==='in_progress').length,accepted,'accepted operations retain download identity');
  for(const job of state.jobs) {
    if(job.status==='queued') {
      assert.deepEqual(Object.keys(job).sort(),['filename','outputFormat','status','url']);
      assert.equal(queryValues.some(value=>job.url.includes(value)),true,'queued jobs keep the exact synthetic signed source');
      assert.equal(job.filename.includes('SESSION_'),false,'queued output names contain no source title or source URL');
    } else {
      assert.deepEqual(Object.keys(job).sort(),['downloadId','outputFormat','status']);
      assert.equal(Number.isSafeInteger(job.downloadId),true);
    }
  }
  if(acceptedId!==undefined)assert.equal(state.jobs.some(job=>job.downloadId===acceptedId),true,'the app retained the actual Chrome download ID');
  const serialized=JSON.stringify(state);
  for(const marker of ['SESSION_TITLE_FIXTURE','SESSION_DOCUMENT_QUERY','SESSION_FRAME_QUERY','previewDataURL','actualFilename','workspaceTabId','documentURL']) {
    assert.equal(serialized.includes(marker),false,'closed storage contains no page identity, preview, frame reference or absolute output path');
  }
}

try {
  // The session contract does not depend on canvas MediaRecorder startup, whose
  // first-frame timing differs in Chrome 116. Generate and decode a real local
  // WebM fixture before Chrome starts; the browser still performs every download.
  const clipPath=join(scratch,'synthetic.webm');
  const generated=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y',
    '-f','lavfi','-i','testsrc2=size=160x90:rate=12','-t','1','-an',
    '-c:v','libvpx','-b:v','200k','-threads','1','-f','webm',clipPath],{encoding:'utf8',timeout:20000});
  assert.equal(generated.status,0,'local ffmpeg generates the synthetic WebM fixture');
  clip=await readFile(clipPath);
  assert.ok(clip.length>32,'the fixture contains real local WebM bytes');
  const probed=spawnSync('ffprobe',['-v','error','-count_frames','-show_entries','format=format_name,duration:stream=codec_type,codec_name,nb_read_frames','-of','json',clipPath],{encoding:'utf8',timeout:20000});
  assert.equal(probed.status,0,'the synthetic WebM has a readable container');
  const media=JSON.parse(probed.stdout);
  assert.equal(media.format.format_name.includes('webm'),true,'the fixture is a real WebM container');
  assert.equal(Number(media.format.duration)>=0.9,true,'the fixture contains the complete synthetic second');
  assert.equal(media.streams.some(stream=>stream.codec_type==='video' && stream.codec_name==='vp8' && Number(stream.nb_read_frames)>=12),true,'the fixture contains at least twelve real VP8 frames');
  const decoded=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-xerror','-err_detect','explode','-i',clipPath,'-map','0:v','-f','null','-'],{encoding:'utf8',timeout:20000});
  assert.equal(decoded.status,0,'the synthetic input decodes completely');
  await cp(join(repo,'extension'),extension,{recursive:true});await mkdir(downloadsDirectory);
  const workerPath=join(extension,'background.js');
  await writeFile(workerPath,(await readFile(workerPath,'utf8'))+`
globalThis.__openWorkspace=openWorkspace;
globalThis.__workerBoot=crypto.randomUUID();
`);
  // An extension-origin observer reads storage without creating another workspace.
  await writeFile(join(extension,'observer.html'),'<!doctype html><meta charset="utf-8"><title>Local privacy QA observer</title>');
  const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
  manifest.host_permissions=['http://127.0.0.1/*'];
  await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
  server=createServer((request,response)=>{
    const url=new URL(request.url,'http://fixture.test'),index=paths.indexOf(url.pathname);
    if(index>=0) {
      if(url.searchParams.get('UnKnOwN')!==queryValues[index]) {response.statusCode=403;response.end('Synthetic signature mismatch');return;}
      response.writeHead(200,{'Content-Type':'video/webm','Content-Length':clip.length,'Cache-Control':'no-store'});
      response.write(clip.subarray(0,16));pendingResponses.set(url.pathname,response);return;
    }
    if(url.pathname==='/frame') {response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Synthetic embed</title>');return;}
    if(url.pathname==='/preview.webm') {response.writeHead(200,{'Content-Type':'video/webm','Content-Length':clip.length});response.end(clip);return;}
    response.setHeader('Content-Type','text/html');
    response.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>SESSION_TITLE_FIXTURE</title><body>
      <video id="preview" title="Synthetic video preview" src="/preview.webm" muted autoplay loop width="160" height="90"></video>
      ${paths.map((path,index)=>`<a href="${path}?UnKnOwN=${queryValues[index]}">Synthetic video ${index+1}</a>`).join('')}
      <iframe src="http://localhost:${server.address().port}/frame?ref=SESSION_FRAME_QUERY" title="Synthetic embed"></iframe>
      </body></html>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const profileDefault=join(scratch,'profile','Default');await mkdir(profileDefault,{recursive:true});
  await writeFile(join(profileDefault,'Preferences'),JSON.stringify({download:{default_directory:downloadsDirectory,prompt_for_download:false,directory_upgrade:true}}));
  const runtime=await launchTestExtension(chromium,join(scratch,'profile'),extension,{
    acceptDownloads:false,viewport:{width:1280,height:900},ignoreDefaultArgs:['--disable-extensions'],
    args:['--autoplay-policy=no-user-gesture-required','--no-first-run'],
  });
  context=runtime.context;const {worker,id}=runtime;
  const page=await context.newPage();await page.goto(origin+'/?source=SESSION_DOCUMENT_QUERY');
  await page.locator('#preview').evaluate(video=>video.play());
  await page.waitForFunction(()=>document.querySelector('#preview').readyState>=2 && document.querySelector('#preview').videoWidth>0);
  const tab=await worker.evaluate(async origin=>(await chrome.tabs.query({})).find(tab=>tab.url===origin+'/?source=SESSION_DOCUMENT_QUERY'),origin);
  assert.ok(tab,'the synthetic source tab is available');
  const [manager]=await Promise.all([context.waitForEvent('page'),worker.evaluate(tab=>globalThis.__openWorkspace(tab),tab)]);
  manager.on('pageerror',()=>errors.push('workspace page error'));
  await manager.waitForFunction(()=>document.querySelector('#count').textContent && !document.querySelector('#scan').disabled);
  const sessionId=new URL(manager.url()).searchParams.get('id');
  const observer=await context.newPage();await observer.goto(`chrome-extension://${id}/observer.html`);
  const browserSession=await context.newCDPSession(observer);
  // CDP's "allow" mode overrides Chrome's suggested extension filename with
  // the source name. Keep native filename handling and set only this profile's
  // download directory, as in the embedded media integration test.
  const {targetInfo}=await browserSession.send('Target.getTargetInfo');
  await browserSession.send('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:true,...(targetInfo.browserContextId&&!runtime.legacy ? {browserContextId:targetInfo.browserContextId} : {})});
  const initial=await sessionState(observer,sessionId);
  assert.equal(initial.title==='SESSION_TITLE_FIXTURE',true,'the initial session contains the expected synthetic page title');
  assert.equal((initial.videoElements || []).some(ref=>Boolean(ref.previewDataURL)),true,'this test exercises a real collected frame preview');
  assert.equal((initial.frames || []).length>0,true,'this test exercises a collected embedded-frame reference');
  const urls=paths.map((path,index)=>origin+path+'?UnKnOwN='+queryValues[index]);
  // Install the reply barrier only in this worker instance. After an actual restart
  // the production download API runs unwrapped, including all queued requests.
  await worker.evaluate(()=>{
    const original=chrome.downloads.download.bind(chrome.downloads);let first=true;
    globalThis.__nativeDownloadIds=[];
    chrome.downloads.download=async options=>{
      const id=await original(options);globalThis.__nativeDownloadIds.push(id);
      if(first){first=false;globalThis.__acceptancePending=true;await new Promise(resolve=>{globalThis.__releaseAcceptance=resolve;});}
      return id;
    };
  });
  // Send a genuine own-workspace batch request; no production session is fabricated.
  await manager.evaluate(({sessionId,urls})=>{
    globalThis.__batchRequest=chrome.runtime.sendMessage({type:'save',sessionId,urls,outputFormat:'auto'});
    globalThis.__batchRequest.catch(()=>{});
  },{sessionId,urls});
  await eventually(()=>worker.evaluate(()=>Boolean(globalThis.__acceptancePending)),'the native download was accepted before its app reply was delayed');
  await eventually(()=>pendingResponses.has(paths[0]),'the first real native download requested its signed media');
  const firstId=await worker.evaluate(()=>globalThis.__nativeDownloadIds[0]);
  assert.equal(Number.isSafeInteger(firstId),true);
  await manager.close();
  await eventually(async()=>Boolean((await sessionState(observer,sessionId))?.closed),'closing the workspace minimizes storage while the API reply is still pending');
  assertMinimalState(await sessionState(observer,sessionId),{queued:3,accepted:0});
  assert.equal(await observer.evaluate(async id=>(await chrome.downloads.search({id}))[0]?.state,firstId),'in_progress','the Chrome download itself continues after the workspace closes');
  await worker.evaluate(()=>globalThis.__releaseAcceptance());
  await eventually(async()=>Boolean((await sessionState(observer,sessionId))?.jobs?.some(job=>job.downloadId===firstId)),'the delayed accepted ID is committed into the closed projection');
  const afterAcceptance=await sessionState(observer,sessionId);
  assertMinimalState(afterAcceptance,{queued:2,accepted:1,acceptedId:firstId});
  assert.equal(JSON.stringify(afterAcceptance).includes(queryValues[0]),false,'the accepted URL is removed even when closure preceded its API reply');
  assert.equal(pendingResponses.has(paths[1]),false,'the next queued request waits for the first native download');

  const previousBoot=await worker.evaluate(()=>globalThis.__workerBoot);
  // Register before terminating: native download progress can restart the worker
  // before closeTarget resolves or before the observer finishes reading storage.
  const observedWorkers=[];
  const observeWorker=value=>{if(value.url().includes(id))observedWorkers.push(value);};
  context.on('serviceworker',observeWorker);
  // Scope termination to this disposable extension's actual background target,
  // then prove a different module boot handles the subsequent download events.
  const {targetInfos}=await browserSession.send('Target.getTargets');
  const ownTargets=targetInfos.filter(target=>target.type==='service_worker' && target.url===`chrome-extension://${id}/background.js`);
  assert.equal(ownTargets.length,1,'only the test extension background target is selected for termination');
  const terminated=await browserSession.send('Target.closeTarget',{targetId:ownTargets[0].targetId});
  assert.equal(terminated.success,true,'Chrome accepted termination of the exact test worker target');
  assertMinimalState(await sessionState(observer,sessionId),{queued:2,accepted:1,acceptedId:firstId});
  // No extension page messages wake the worker. Native progress or completion may
  // start it; either must preserve the stopped worker's already minimized queue.
  finishResponse(paths[0]);
  // Chrome 143+ may restart the execution context while Playwright retains the
  // same Worker object/target. A changed module boot is the evidence of restart;
  // waiting only for a new Worker or its close event would miss that real restart.
  const bootProbes=new Map();let nextWorker,nextBoot;
  await eventually(()=>{
    for(const value of new Set([worker,...observedWorkers,...context.serviceWorkers()])) {
      if(!value.url().includes(id))continue;
      const probe=bootProbes.get(value);
      if(!probe) {
        const pending={settled:false,boot:null};bootProbes.set(value,pending);
        value.evaluate(()=>globalThis.__workerBoot).then(boot=>{pending.boot=boot;pending.settled=true;},()=>{pending.settled=true;});
      } else if(probe.settled) {
        if(probe.boot && probe.boot!==previousBoot){nextWorker=value;nextBoot=probe.boot;return true;}
        bootProbes.delete(value);
      }
    }
    return false;
  },'the background module restarts without a workspace wake message');
  assert.notEqual(nextBoot,previousBoot,'Chrome actually restarted the service worker execution context');
  context.off('serviceworker',observeWorker);
  await eventually(()=>pendingResponses.has(paths[1]),'the restarted worker handles native completion and starts the next queued download');
  await eventually(async()=>{const state=await sessionState(observer,sessionId);return state?.jobs?.filter(job=>job.status==='in_progress').length===1 && state.jobs.filter(job=>job.status==='queued').length===1;},'the second real download is accepted after restart');
  const secondState=await sessionState(observer,sessionId);
  assertMinimalState(secondState,{queued:1,accepted:1});
  assert.equal(JSON.stringify(secondState).includes(queryValues[1]),false,'the second accepted source URL is removed after restart');
  finishResponse(paths[1]);
  await eventually(()=>pendingResponses.has(paths[2]),'the third real download starts after the second completes');
  await eventually(async()=>{const state=await sessionState(observer,sessionId);return state?.jobs?.length===1 && state.jobs[0].status==='in_progress';},'only the final accepted download remains');
  const lastState=await sessionState(observer,sessionId);
  assertMinimalState(lastState,{queued:0,accepted:1});
  assert.equal(queryValues.some(value=>JSON.stringify(lastState).includes(value)),false,'no signed URL remains once every request has been accepted');
  finishResponse(paths[2]);
  await eventually(async()=>!await sessionState(observer,sessionId),'all terminal downloads remove the closed session');
  const saved=await observer.evaluate(async()=>(await chrome.downloads.search({})).filter(item=>item.byExtensionId===chrome.runtime.id).map(({id,state,exists,filename})=>({id,state,exists,filename})));
  assert.equal(saved.length,3,'exactly three real extension downloads were created');
  const expectedHash=createHash('sha256').update(clip).digest('hex');
  for(const item of saved) {
    assert.equal(item.state,'complete');assert.equal(item.exists,true);
    assert.equal(item.filename.startsWith(downloadsDirectory+'/'),true,'real files stay inside the disposable test directory');
    assert.equal(item.filename.includes('SESSION_'),false,'real output names reveal none of the synthetic page or source markers');
    assert.equal((await stat(item.filename)).size,clip.length);
    assert.equal(createHash('sha256').update(await readFile(item.filename)).digest('hex')===expectedHash,true,'the downloaded WebM bytes exactly match the local source');
  }
  assert.equal(completedRequests.size,3);assert.deepEqual(errors,[]);
  console.log('VideoHarbor session privacy browser PASS: native acceptance delay, immediate closed projection, two queued downloads, proven worker restart with native download continuation, exact local files, accepted URL/path removal and final session deletion. Personal profiles and native pickers are not used; automatic wake after a natural idle stop is not claimed.');
} finally {
  for(const response of pendingResponses.values())response.destroy();pendingResponses.clear();
  await context?.close();
  await new Promise(resolve=>server ? server.close(resolve) : resolve());
  await rm(scratch,{recursive:true,force:true});
}
