// Isolated, local-only integration coverage. Native permission confirmation is
// deliberately not automated: only that API boundary is simulated below.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,mkdir,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
import {launchTestExtension} from './chrome-runtime.mjs';
import {candidateLocator,candidateCount,assertPrivateDOM} from './privacy-browser-helpers.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo=fileURLToPath(new URL('../',import.meta.url));
const scratch=await mkdtemp(join(tmpdir(),'videoharbor-embedded-qa-'));
const extension=join(scratch,'extension');
let context,server;
let slowSegments=false;
const requests=new Map();
const requestedResources=new Set();
const errors=[];

function command(binary,args) {
  const result=spawnSync(binary,args,{encoding:'utf8',maxBuffer:2*1024*1024});
  assert.equal(result.status,0,`${binary} failed: ${result.error?.message || result.stderr}`);
  return result.stdout;
}
async function makeHLS(kind) {
  const directory=join(scratch,kind);await mkdir(directory);
  const ext=kind==='ts' ? 'ts' : 'm4s';
  command('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y',
    '-f','lavfi','-i','testsrc2=size=160x90:rate=12',
    '-f','lavfi','-i','sine=frequency=700:sample_rate=48000',
    '-t','4','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',
    '-g','12','-threads','1','-c:a','aac','-b:a','64k',
    '-f','hls','-hls_time','1','-hls_list_size','0','-hls_playlist_type','vod',
    '-hls_segment_type',kind==='ts' ? 'mpegts' : 'fmp4',
    ...(kind==='mp4' ? ['-hls_fmp4_init_filename','init.mp4'] : []),
    '-hls_segment_filename',join(directory,`seg-%02d.${ext}`),join(directory,'index.m3u8')]);
}
async function makeDASH() {
  const directory=join(scratch,'dash');await mkdir(directory);
  command('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y',
    '-f','lavfi','-i','testsrc2=size=160x90:rate=12',
    '-f','lavfi','-i','sine=frequency=900:sample_rate=48000',
    '-t','4','-map','0:v:0','-map','1:a:0','-c:v','libx264','-preset','ultrafast',
    '-pix_fmt','yuv420p','-g','12','-threads','1','-c:a','aac','-b:a','64k',
    '-f','dash','-seg_duration','1','-use_template','1','-use_timeline','1',
    '-adaptation_sets','id=0,streams=v id=1,streams=a',
    '-init_seg_name','init-$RepresentationID$.mp4',
    '-media_seg_name','chunk-$RepresentationID$-$Number%05d$.m4s',join(directory,'manifest.mpd')]);
}
async function makeSplitHLS() {
  for(const kind of ['video','audio']) {
    const directory=join(scratch,'split',kind);await mkdir(directory,{recursive:true});
    const input=kind==='video' ? ['-f','lavfi','-i','testsrc2=size=160x90:rate=12'] : ['-f','lavfi','-i','sine=frequency=1100:sample_rate=48000'];
    const codec=kind==='video' ? ['-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','12','-threads','1'] : ['-vn','-c:a','aac','-b:a','64k'];
    command('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y',...input,'-t','4',...codec,
      '-f','hls','-hls_time','1','-hls_list_size','0','-hls_playlist_type','vod',
      '-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4',
      '-hls_segment_filename',join(directory,'seg-%02d.m4s'),join(directory,'index.m3u8')]);
  }
  await writeFile(join(scratch,'split','master.m3u8'),[
    '#EXTM3U','#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="synthetic-audio",NAME="Synthetic audio",DEFAULT=YES,AUTOSELECT=YES,URI="audio/index.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=300000,CODECS="avc1.42c00a,mp4a.40.2",RESOLUTION=160x90,AUDIO="synthetic-audio"',
    'video/index.m3u8','',
  ].join('\n'));
}
async function decode(path,expectedFormat) {
  const data=JSON.parse(command('ffprobe',['-v','error','-show_packets','-show_entries','format=format_name,duration:stream=index,codec_type,codec_name,duration,start_time:packet=stream_index,pts_time,duration_time','-of','json',path]));
  assert.ok(data.format.format_name.includes(expectedFormat),`${expectedFormat} container`);
  assert.ok(data.streams.some(s=>s.codec_type==='video'),'saved file contains video');
  assert.ok(data.streams.some(s=>s.codec_type==='audio'),'saved file contains audio');
  assert.ok(Number(data.format.duration)>=3.8,'the complete four-second clip was saved');
  assert.ok(Math.abs(Number(data.streams.find(s=>s.codec_type==='video').start_time)-Number(data.streams.find(s=>s.codec_type==='audio').start_time))<0.1,'synthetic audio/video start timestamps stay within 100 ms');
  for(const kind of ['video','audio']) {
    const stream=data.streams.find(s=>s.codec_type===kind);
    const packets=data.packets.filter(packet=>packet.stream_index===stream.index && Number.isFinite(Number(packet.pts_time)));
    const start=Math.min(...packets.map(packet=>Number(packet.pts_time)));
    const end=Math.max(...packets.map(packet=>Number(packet.pts_time)+Number(packet.duration_time || 0)));
    assert.ok(end-start>=3.8 && end-start<4.5,`${kind} packet timestamps preserve the four-second duration: ${end-start}`);
  }
  command('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-xerror','-err_detect','explode','-i',path,'-map','0:v','-map','0:a','-f','null','-']);
}
async function openFixture(profile,manifest,origin) {
  await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
  const downloadFolder=join(scratch,profile+'-downloads');await mkdir(downloadFolder);
  const profileDefault=join(scratch,profile,'Default');await mkdir(profileDefault,{recursive:true});
  await writeFile(join(profileDefault,'Preferences'),JSON.stringify({download:{default_directory:downloadFolder,prompt_for_download:false,directory_upgrade:true}}));
  const runtime=await launchTestExtension(chromium,join(scratch,profile),extension,{
    acceptDownloads:false,
    viewport:{width:1280,height:900},ignoreDefaultArgs:['--disable-extensions'],
    args:['--autoplay-policy=no-user-gesture-required','--no-first-run'],
  });
  context=runtime.context;const {worker}=runtime;
  const page=await context.newPage();await page.goto(origin+'/?document=DOCUMENT_QUERY_FIXTURE');
  await page.waitForFunction(()=>document.querySelector('#cross-frame')?.contentWindow && document.readyState==='complete');
  const tab=await worker.evaluate(async origin=>(await chrome.tabs.query({})).find(t=>t.url===origin+'/?document=DOCUMENT_QUERY_FIXTURE'),origin);
  assert.ok(tab,'source fixture tab exists');
  const [manager]=await Promise.all([context.waitForEvent('page'),worker.evaluate(tab=>globalThis.__openWorkspace(tab),tab)]);
  manager.on('pageerror',e=>errors.push(e.message));
  await manager.waitForFunction(()=>document.querySelector('#count').textContent && !document.querySelector('#scan').disabled);
  const session=await context.newCDPSession(manager);
  const {targetInfo}=await session.send('Target.getTargetInfo');
  // Chrome 116 exposes an ID for the default persistent context that this CDP
  // command cannot resolve. Omitting it selects that same real default context.
  await session.send('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:true,...(targetInfo.browserContextId&&!runtime.legacy ? {browserContextId:targetInfo.browserContextId} : {})});
  return {page,manager,worker};
}
const mediaButton=(manager,url)=>candidateLocator(manager,url,'button.media-save');
const saveButton=(manager,url)=>candidateLocator(manager,url,'button.media-save,button.direct-save');
const mediaStatus=(manager,url)=>candidateLocator(manager,url,'.item-status');
const outputFormat=(manager,url)=>candidateLocator(manager,url,'select.output-format');
async function waitStatus(manager,url,status) {
  await (await candidateLocator(manager,url,`.item-status[data-state="${status}"]`)).waitFor({state:'attached',timeout:15000});
}
async function saveAndDecode(manager,url,name,format,{standaloneHLS=false,selectedFormat}={}) {
  if(selectedFormat)await (await outputFormat(manager,url)).selectOption(selectedFormat);
  const previous=await manager.evaluate(async()=> (await chrome.downloads.search({})).map(item=>item.id));
  await (await saveButton(manager,url)).click();
  await waitStatus(manager,url,'complete');
  if(standaloneHLS)assert.match(await (await mediaStatus(manager,url)).textContent(),/音声の有無は未確認/,'standalone HLS file completion does not claim verified audio');
  else if(url.endsWith('.mpd') || url.includes('/split/'))assert.doesNotMatch(await (await mediaStatus(manager,url)).textContent(),/音声の有無は未確認/,'an explicitly selected audio/video manifest is distinct from a standalone HLS child list');
  const saved=await manager.evaluate(async previous=>(await chrome.downloads.search({})).find(item=>!previous.includes(item.id)),previous);
  assert.ok(saved,'the save started a real Chrome download');
  assert.equal(saved.state,'complete','Chrome completed the actual download');
  assert.equal(saved.exists,true,'Chrome reports the downloaded file exists');
  assert.ok(saved.filename.startsWith(scratch+'/'),'downloads stay inside this test\'s temporary profile output');
  assert.ok(saved.filename.toLowerCase().endsWith('.'+name.split('.').at(-1)),`the actual downloaded filename has the selected container extension: ${saved.filename}`);
  const destination=join(scratch,name);await cp(saved.filename,destination);
  await decode(destination,format);
}

try {
  // Tiny generated assets; no bundled or downloaded copyrighted media.
  await makeHLS('ts');await makeHLS('mp4');await makeDASH();await makeSplitHLS();
  const mp4Files=(await readdir(join(scratch,'mp4'))).filter(name=>name.endsWith('.m4s')).sort();
  const clip=Buffer.concat(await Promise.all(['init.mp4',...mp4Files].map(name=>readFile(join(scratch,'mp4',name)))));
  await cp(join(repo,'extension'),extension,{recursive:true});
  const workerPath=join(extension,'background.js');
  await writeFile(workerPath,(await readFile(workerPath,'utf8'))+'\nglobalThis.__openWorkspace=openWorkspace;\n');
  const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
  // Only localhost test origins are ever granted; optional wildcard declarations
  // are never requested or granted by this test.
  manifest.host_permissions=['http://127.0.0.1/*'];
  let origin,other;
  server=createServer(async(req,res)=>{
    try {
      const pathname=new URL(req.url,'http://fixture.test').pathname;
      requestedResources.add(req.url);
      requests.set(pathname,(requests.get(pathname)||0)+1);
      if(pathname==='/OPAQUE_PATH_FIXTURE.mp4' && !['QUERY_FIXTURE_1','QUERY_FIXTURE_2'].includes(new URL(req.url,'http://fixture.test').searchParams.get('UnKnOwN'))) {
        res.statusCode=403;return res.end('Synthetic signature mismatch');
      }
      if(pathname==='/same-frame' || pathname==='/cross-frame') {
        const name=pathname==='/same-frame' ? 'same' : 'cross';
        res.setHeader('Content-Type','text/html');return res.end(`<video data-src="/${name}.mp4"></video>`);
      }
      if(pathname.startsWith('/ts/') || pathname.startsWith('/mp4/')) {
        if(!/^\/(?:ts|mp4)\/(?:index\.m3u8|init\.mp4|seg-\d+\.(?:ts|m4s))$/.test(pathname)){res.statusCode=404;return res.end();}
        if(slowSegments && pathname==='/ts/seg-00.ts')await new Promise(resolve=>setTimeout(resolve,1000));
        const data=await readFile(join(scratch,pathname.slice(1)));
        res.setHeader('Content-Type',pathname.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : pathname.endsWith('.ts') ? 'video/mp2t' : 'video/mp4');
        res.setHeader('Content-Length',data.length);return res.end(data);
      }
      if(pathname.startsWith('/dash/') || pathname.startsWith('/split/')) {
        const allowed=/^\/dash\/(?:manifest\.mpd|init-\d+\.mp4|chunk-\d+-\d+\.m4s)$/.test(pathname) ||
          /^\/split\/(?:master\.m3u8|(?:audio|video)\/(?:index\.m3u8|init\.mp4|seg-\d+\.m4s))$/.test(pathname);
        if(!allowed){res.statusCode=404;return res.end();}
        const data=await readFile(join(scratch,pathname.slice(1)));
        res.setHeader('Content-Type',pathname.endsWith('.mpd') ? 'application/dash+xml' : pathname.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : pathname.includes('/audio/') ? 'audio/mp4' : 'video/mp4');
        res.setHeader('Content-Length',data.length);return res.end(data);
      }
      if(pathname.endsWith('.mp4')) {res.setHeader('Content-Type','video/mp4');res.setHeader('Content-Length',clip.length);return res.end(clip);}
      res.setHeader('Content-Type','text/html');
      return res.end(`<!doctype html><html lang="ja"><head><title>Embedded video integration fixture</title>
        <meta property="og:video" content="/metadata.mp4"><meta property="og:video:type" content="video/mp4">
        <script type="application/ld+json">{"@type":"VideoObject","contentUrl":"/structured.mp4"}</script>
        <script>window.__PLAYER_CONFIG__ = {"sources":[{"file":"/inline-player.mp4"}]};</script>
        </head><body><video data-src="/lazy.mp4"></video>
        <iframe src="/same-frame"></iframe><iframe id="cross-frame" src="${other}/cross-frame"></iframe>
        <iframe srcdoc="<video data-src='${origin}/srcdoc.mp4'></video>"></iframe>
        <iframe src="/iframe-video.mp4"></iframe>
        <a href="/unsupported.webm" type="video/webm">Known non-MP4 format</a>
        <a href="/OPAQUE_PATH_FIXTURE.mp4?UnKnOwN=QUERY_FIXTURE_1#HASH_FIXTURE">Signed source one</a>
        <a href="/OPAQUE_PATH_FIXTURE.mp4?UnKnOwN=QUERY_FIXTURE_2">Signed source two</a>
        <a href="/ts/index.m3u8">TS HLS</a><a href="/mp4/index.m3u8">fMP4 HLS</a>
        <a href="/mp4/index.m3u8?CustomAuthorization=QUERY_FIXTURE_HLS">Signed HLS</a>
        <a href="/dash/manifest.mpd?CustomAuthorization=QUERY_FIXTURE_DASH">Signed DASH</a>
        <a href="/dash/manifest.mpd">DASH separate audio/video</a><a href="/split/master.m3u8">HLS separate audio/video</a></body></html>`);
    }catch(error){res.statusCode=500;res.end('Synthetic fixture error');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;other=`http://localhost:${server.address().port}`;
  const first=await openFixture('limited',manifest,origin);
  const {page,manager}=first;
  for(const filename of ['lazy.mp4','metadata.mp4','structured.mp4','same.mp4','srcdoc.mp4','inline-player.mp4','iframe-video.mp4'])assert.equal(await candidateCount(manager,origin+'/'+filename),1,`${filename} is discovered`);
  assert.equal(await candidateCount(manager,other+'/cross.mp4'),0,'ungranted cross-origin iframe is not inspected');
  assert.equal(await manager.locator('.frame-permission').count(),1,'the missing iframe origin has a scoped permission action');
  const realGrants=await manager.evaluate(()=>chrome.permissions.getAll());
  assert.ok(!realGrants.origins.some(x=>x.includes('localhost')),'localhost host access has not been granted');
  assert.ok(!realGrants.origins.some(x=>x==='http://*/*' || x==='https://*/*'),'no wildcard host grant');

  const directMP4=origin+'/lazy.mp4',unsupportedWebM=origin+'/unsupported.webm';
  const signedOne=origin+'/OPAQUE_PATH_FIXTURE.mp4?UnKnOwN=QUERY_FIXTURE_1',signedTwo=origin+'/OPAQUE_PATH_FIXTURE.mp4?UnKnOwN=QUERY_FIXTURE_2';
  const privacyMarkers=['OPAQUE_PATH_FIXTURE','QUERY_FIXTURE','HASH_FIXTURE','DOCUMENT_QUERY_FIXTURE'];
  await assertPrivateDOM(manager,privacyMarkers);
  assert.equal(await candidateCount(manager,signedOne),1,'the first signed resource is identified without rendering its source');
  assert.equal(await candidateCount(manager,signedTwo),1,'different query identities retain independent save cards');
  const signedId=await (await outputFormat(manager,signedOne)).getAttribute('data-candidate-id');
  await (await outputFormat(manager,signedOne)).selectOption('auto');
  await manager.locator('#scan').click();await manager.waitForFunction(()=>!document.querySelector('#scan').disabled);
  assert.equal(await (await outputFormat(manager,signedOne)).getAttribute('data-candidate-id'),signedId,'an unchanged resource keeps its opaque ID across scans');
  assert.equal(await (await outputFormat(manager,signedOne)).inputValue(),'auto','query-specific output preference survives a scan');
  assert.equal(await (await outputFormat(manager,signedTwo)).inputValue(),'mp4','the other query variant keeps its own output preference');
  await assertPrivateDOM(manager,privacyMarkers);
  assert.equal(await (await outputFormat(manager,directMP4)).inputValue(),'mp4','known MP4 candidates initially prefer MP4');
  assert.equal(await (await outputFormat(manager,unsupportedWebM)).inputValue(),'auto','known WebM keeps its original container');
  assert.equal(await (await outputFormat(manager,unsupportedWebM)).locator('option[value="mp4"]').isDisabled(),true,'unsupported WebM-to-MP4 conversion cannot be selected');
  assert.match(await (await candidateLocator(manager,unsupportedWebM)).locator('.format-hint').textContent(),/変換には対応していません/);
  await saveAndDecode(manager,directMP4,'saved-direct.mp4','mp4',{selectedFormat:'mp4'});
  await saveAndDecode(manager,signedOne,'saved-signed-one.mp4','mp4',{selectedFormat:'auto'});
  await saveAndDecode(manager,signedTwo,'saved-signed-two.mp4','mp4',{selectedFormat:'mp4'});
  for(const url of [signedOne,signedTwo])assert.equal(requestedResources.has(new URL(url).pathname+new URL(url).search),true,'direct download uses the unchanged complete signed URL');
  await assertPrivateDOM(manager,privacyMarkers);

  // Simulate declining only the browser confirmation boundary. The actual scan,
  // injection, HLS fetching, assembly, and download implementations remain intact.
  await manager.evaluate(()=>{
    window.__permissionRequests=[];
    window.__realPermissionContains=chrome.permissions.contains.bind(chrome.permissions);
    window.__permissionAccept=false;window.__forceMissing=false;
    chrome.permissions.contains=async options=>window.__forceMissing && options.origins?.some(x=>x.includes('127.0.0.1')) ? false : window.__realPermissionContains(options);
    chrome.permissions.request=options=>{
      window.__permissionRequests.push({origins:options.origins,active:navigator.userActivation.isActive});
      if(window.__permissionAccept)window.__forceMissing=false;
      return Promise.resolve(window.__permissionAccept);
    };
  });
  const previousPermission=await manager.locator('.frame-permission').elementHandle();
  await manager.locator('.frame-permission').click();
  await manager.waitForFunction(()=>document.querySelector('#error').textContent.includes('許可されませんでした'));
  await manager.waitForFunction(()=>document.activeElement?.classList.contains('frame-permission'));
  assert.equal(await candidateCount(manager,other+'/cross.mp4'),0,'decline never inspects cross-origin content');
  await manager.evaluate(()=>{
    window.__permissionAccept=true;
    const contains=chrome.permissions.contains.bind(chrome.permissions);
    chrome.permissions.contains=options=>options.origins?.some(origin=>origin.includes('localhost')) ? Promise.resolve(true) : contains(options);
  });
  await manager.locator('.frame-permission').click();
  await manager.waitForFunction(()=>document.activeElement?.id==='download-heading' && !document.querySelector('#scan').disabled);
  assert.equal(await previousPermission.evaluate(el=>el.isConnected),false,'the permission scan replaced the old action while focus moved to the new results');
  let permissionRequests=await manager.evaluate(()=>window.__permissionRequests);
  assert.deepEqual(permissionRequests[0].origins,['http://localhost/*']);
  assert.equal(permissionRequests[0].active,true,'iframe permission request is reached within the click gesture');
  assert.deepEqual(permissionRequests[1].origins,['http://localhost/*']);
  assert.equal(permissionRequests[1].active,true);
  await manager.evaluate(()=>{window.__permissionAccept=false;});

  const tsURL=origin+'/ts/index.m3u8';
  assert.equal(await (await outputFormat(manager,tsURL)).inputValue(),'mp4','HLS initially prefers actual MP4 output');
  await (await outputFormat(manager,tsURL)).selectOption('auto');
  const beforeRequests=requests.get('/ts/index.m3u8')||0;
  await manager.evaluate(()=>{window.__forceMissing=true;});
  await (await mediaButton(manager,tsURL)).click();await waitStatus(manager,tsURL,'permission');
  assert.equal(requests.get('/ts/index.m3u8')||0,beforeRequests,'HLS host is checked before fetching the manifest');
  await (await mediaButton(manager,tsURL)).click();await waitStatus(manager,tsURL,'interrupted');
  assert.match(await (await mediaStatus(manager,tsURL)).textContent(),/許可されませんでした/);
  await (await mediaButton(manager,tsURL)).click();await waitStatus(manager,tsURL,'permission');
  await manager.evaluate(()=>{window.__permissionAccept=true;});
  await saveAndDecode(manager,tsURL,'saved-hls.ts','mpegts',{standaloneHLS:true,selectedFormat:'auto'});
  permissionRequests=await manager.evaluate(()=>window.__permissionRequests);
  for(const request of permissionRequests.slice(2)) {
    assert.deepEqual(request.origins,['http://127.0.0.1/*'],'HLS request names only its concrete local host');
    assert.equal(request.active,true,'HLS permission request is reached within the click gesture');
  }
  await saveAndDecode(manager,origin+'/mp4/index.m3u8','saved-hls.mp4','mp4',{standaloneHLS:true});
  await saveAndDecode(manager,origin+'/dash/manifest.mpd','saved-dash.mp4','mp4');
  await saveAndDecode(manager,origin+'/split/master.m3u8','saved-split-hls.mp4','mp4');
  const signedHLS=origin+'/mp4/index.m3u8?CustomAuthorization=QUERY_FIXTURE_HLS',signedDASH=origin+'/dash/manifest.mpd?CustomAuthorization=QUERY_FIXTURE_DASH';
  await saveAndDecode(manager,signedHLS,'saved-signed-hls.mp4','mp4',{standaloneHLS:true});
  await saveAndDecode(manager,signedDASH,'saved-signed-dash.mp4','mp4');
  for(const url of [signedHLS,signedDASH])assert.equal(requestedResources.has(new URL(url).pathname+new URL(url).search),true,'manifest fetch uses the unchanged complete signed URL');
  await assertPrivateDOM(manager,privacyMarkers);
  await saveAndDecode(manager,tsURL,'saved-ts-remux.mp4','mp4',{standaloneHLS:true,selectedFormat:'mp4'});
  // Stop stays reachable even while a long candidate list is scrolled elsewhere.
  slowSegments=true;
  const downloadsBeforeStop=await manager.evaluate(async()=> (await chrome.downloads.search({})).length);
  await manager.setViewportSize({width:360,height:800});
  await (await mediaButton(manager,tsURL)).click();await waitStatus(manager,tsURL,'fetching');
  assert.ok(await manager.locator('.output-format').evaluateAll(controls=>controls.every(control=>control.disabled)),'all candidate format choices freeze during a save');
  await (await outputFormat(manager,tsURL)).evaluate(control=>{control.value='auto';control.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal(await (await outputFormat(manager,tsURL)).inputValue(),'mp4','a scripted change cannot alter the in-flight format snapshot');
  await manager.evaluate(()=>scrollTo(0,0));
  assert.ok(await manager.locator('#media-cancel').evaluate(el=>{const r=el.getBoundingClientRect();return r.top>=0 && r.bottom<=innerHeight;}),'HLS Stop remains inside the viewport after scrolling');
  await manager.locator('#media-cancel').click();await waitStatus(manager,tsURL,'interrupted');
  assert.equal(await manager.evaluate(async()=> (await chrome.downloads.search({})).length),downloadsBeforeStop,'stopped HLS does not save a partial file');
  slowSegments=false;await manager.setViewportSize({width:1280,height:900});

  // A real page-origin Blob survives the isolated-world transfer and Chrome save.
  const blobURL=await page.evaluate(async()=>{
    const data=await(await fetch('/clip.mp4')).arrayBuffer();
    const url=URL.createObjectURL(new Blob([data],{type:'video/mp4'}));
    const video=document.createElement('video');video.src=url;document.body.append(video);return url;
  });
  await manager.locator('#scan').click();await (await mediaButton(manager,blobURL)).waitFor();
  assert.equal(await (await outputFormat(manager,blobURL)).inputValue(),'auto','a blob without DOM MIME starts with the original format');
  await saveAndDecode(manager,blobURL,'saved-page-blob.mp4','mp4',{selectedFormat:'mp4'});
  await assertPrivateDOM(manager,[...privacyMarkers,blobURL]);
  // The source DOM does not identify the blob container. An actual WebM Blob
  // must still fail the runtime MIME check when MP4 is requested.
  const webmBlobURL=await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=160;canvas.height=90;
    const drawing=canvas.getContext('2d');drawing.fillStyle='#348c83';drawing.fillRect(0,0,160,90);
    const stream=canvas.captureStream(12),chunks=[],recorder=new MediaRecorder(stream,{mimeType:'video/webm'});
    const done=new Promise(resolve=>{recorder.ondataavailable=event=>chunks.push(event.data);recorder.onstop=resolve;});
    recorder.start(100);await new Promise(resolve=>setTimeout(resolve,300));recorder.stop();await done;stream.getTracks().forEach(track=>track.stop());
    const url=URL.createObjectURL(new Blob(chunks,{type:'video/webm'}));
    const video=document.createElement('video');video.src=url;document.body.append(video);return url;
  });
  await manager.locator('#scan').click();await (await mediaButton(manager,webmBlobURL)).waitFor();
  assert.equal(await (await outputFormat(manager,webmBlobURL)).inputValue(),'auto');
  assert.equal(await (await outputFormat(manager,webmBlobURL)).locator('option[value="mp4"]').isDisabled(),false,'unknown blob MIME can be inspected at runtime');
  await (await outputFormat(manager,webmBlobURL)).selectOption('mp4');
  const beforeRejectedFormat=await manager.evaluate(async()=> (await chrome.downloads.search({})).length);
  await (await mediaButton(manager,webmBlobURL)).click();await waitStatus(manager,webmBlobURL,'interrupted');
  assert.match(await (await mediaStatus(manager,webmBlobURL)).textContent(),/MP4ではありません/);
  assert.equal(await manager.evaluate(async()=> (await chrome.downloads.search({})).length),beforeRejectedFormat,'WebM bytes are not mislabeled or downloaded as MP4');
  const mseURL=await page.evaluate(()=>{
    window.__mse=new MediaSource();const url=URL.createObjectURL(window.__mse);
    const video=document.createElement('video');video.src=url;document.body.append(video);return url;
  });
  await manager.locator('#scan').click();await (await mediaButton(manager,mseURL)).waitFor();
  const downloadCount=await manager.evaluate(async()=> (await chrome.downloads.search({})).length);
  await (await mediaButton(manager,mseURL)).click();await waitStatus(manager,mseURL,'interrupted');
  assert.match(await (await mediaStatus(manager,mseURL)).textContent(),/blob|ページ内|分割配信|取得できません/);
  assert.equal(await manager.evaluate(async()=> (await chrome.downloads.search({})).length),downloadCount,'MediaSource blob is not falsely downloaded as a video file');
  await context.close();context=null;

  // Real injection after a local host grant is checked in a fresh isolated
  // profile. This is test-copy manifest permission, not a native prompt test.
  manifest.host_permissions=['http://127.0.0.1/*','http://localhost/*'];
  const granted=await openFixture('local-frame-granted',manifest,origin);
  assert.equal(await candidateCount(granted.manager,other+'/cross.mp4'),1,'granted cross-origin iframe is collected through actual allFrames injection');
  assert.equal(await granted.manager.locator('.frame-permission').count(),0,'already permitted local frames do not request access again');
  await granted.manager.setViewportSize({width:360,height:800});
  assert.ok(await granted.manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'embedded candidate controls fit a narrow viewport');
  assert.deepEqual(errors,[],'no uncaught extension page errors');
  console.log('VideoHarbor embedded browser PASS: discovery and scoped frame grants, format selection/defaults/freeze, actual native TS and remuxed TS-to-MP4, direct MP4/fMP4/DASH/split-HLS/blob downloads with complete audio/video duration and full decode, runtime WebM-as-MP4/MSE rejection. Native permission confirmation and real-site compatibility remain manual.');
  if(process.env.QA_KEEP)console.log(`QA files retained locally: ${scratch}`);
} finally {
  await context?.close();
  if(server)await new Promise(resolve=>server.close(resolve));
  if(!process.env.QA_KEEP)await rm(scratch,{recursive:true,force:true});
}
