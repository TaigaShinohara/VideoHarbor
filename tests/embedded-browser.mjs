// Isolated, local-only integration coverage. Native permission confirmation is
// deliberately not automated: only that API boundary is simulated below.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,mkdir,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {spawnSync} from 'node:child_process';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo=fileURLToPath(new URL('../',import.meta.url));
const scratch=await mkdtemp(join(tmpdir(),'videoharbor-embedded-qa-'));
const extension=join(scratch,'extension');
let context,server;
let slowSegments=false;
const requests=new Map();
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
  context=await chromium.launchPersistentContext(join(scratch,profile),{
    channel:process.env.CHROME_CHANNEL || 'chrome',headless:true,acceptDownloads:true,
    viewport:{width:1280,height:900},ignoreDefaultArgs:['--disable-extensions'],
    args:['--enable-unsafe-extension-debugging','--autoplay-policy=no-user-gesture-required','--no-first-run'],
  });
  const browserSession=await context.browser().newBrowserCDPSession();
  const {id}=await browserSession.send('Extensions.loadUnpacked',{path:extension});
  let worker=context.serviceWorkers().find(w=>w.url().includes(id));
  if(!worker)worker=await context.waitForEvent('serviceworker',{predicate:w=>w.url().includes(id)});
  const page=await context.newPage();await page.goto(origin);
  await page.waitForFunction(()=>document.querySelector('#cross-frame')?.contentWindow && document.readyState==='complete');
  const tab=await worker.evaluate(async origin=>(await chrome.tabs.query({})).find(t=>t.url===origin+'/'),origin);
  assert.ok(tab,'source fixture tab exists');
  const [manager]=await Promise.all([context.waitForEvent('page'),worker.evaluate(tab=>globalThis.__openWorkspace(tab),tab)]);
  manager.on('pageerror',e=>errors.push(e.message));
  await manager.waitForFunction(()=>document.querySelector('#message').textContent.includes('候補を取得'));
  const downloadFolder=join(scratch,profile+'-downloads');await mkdir(downloadFolder);
  const session=await context.newCDPSession(manager);
  await session.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadFolder,eventsEnabled:true});
  return {page,manager,worker};
}
const mediaButton=(manager,url)=>manager.locator(`button.media-save[data-url=${JSON.stringify(url)}]`);
const mediaStatus=(manager,url)=>manager.locator(`.item-status[data-url=${JSON.stringify(url)}]`);
async function waitStatus(manager,url,status) {
  await manager.waitForFunction(({url,status})=>[...document.querySelectorAll('.item-status')].some(el=>el.dataset.url===url && el.dataset.state===status),{url,status},{timeout:15000});
}
async function saveAndDecode(manager,url,name,format,{standaloneHLS=false}={}) {
  const previous=await manager.evaluate(async()=> (await chrome.downloads.search({})).map(item=>item.id));
  await mediaButton(manager,url).click();
  await waitStatus(manager,url,'complete');
  if(standaloneHLS)assert.match(await mediaStatus(manager,url).textContent(),/音声の有無は未確認/,'standalone HLS file completion does not claim verified audio');
  else if(url.endsWith('.mpd') || url.includes('/split/'))assert.doesNotMatch(await mediaStatus(manager,url).textContent(),/音声の有無は未確認/,'an explicitly selected audio/video manifest is distinct from a standalone HLS child list');
  const saved=await manager.evaluate(async previous=>(await chrome.downloads.search({})).find(item=>!previous.includes(item.id)),previous);
  assert.ok(saved,'the save started a real Chrome download');
  assert.equal(saved.state,'complete','Chrome completed the actual download');
  assert.equal(saved.exists,true,'Chrome reports the downloaded file exists');
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
      requests.set(pathname,(requests.get(pathname)||0)+1);
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
        <iframe src="/iframe-video.mp4"></iframe>
        <a href="/ts/index.m3u8">TS HLS</a><a href="/mp4/index.m3u8">fMP4 HLS</a>
        <a href="/dash/manifest.mpd">DASH separate audio/video</a><a href="/split/master.m3u8">HLS separate audio/video</a></body></html>`);
    }catch(error){res.statusCode=500;res.end('Synthetic fixture error');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;other=`http://localhost:${server.address().port}`;
  const first=await openFixture('limited',manifest,origin);
  const {page,manager}=first;
  for(const filename of ['lazy.mp4','metadata.mp4','structured.mp4','same.mp4','inline-player.mp4','iframe-video.mp4'])assert.equal(await manager.locator('#direct-list .video-card').filter({hasText:filename}).count(),1,`${filename} is discovered`);
  assert.equal(await manager.locator('#direct-list .video-card').filter({hasText:'cross.mp4'}).count(),0,'ungranted cross-origin iframe is not inspected');
  assert.equal(await manager.locator('.frame-permission').count(),1,'the missing iframe origin has a scoped permission action');
  const realGrants=await manager.evaluate(()=>chrome.permissions.getAll());
  assert.ok(!realGrants.origins.some(x=>x.includes('localhost')),'localhost host access has not been granted');
  assert.ok(!realGrants.origins.some(x=>x==='http://*/*' || x==='https://*/*'),'no wildcard host grant');

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
  await manager.locator('.frame-permission').click();
  await manager.waitForFunction(()=>document.querySelector('#error').textContent.includes('許可されませんでした'));
  assert.equal(await manager.locator('#direct-list .video-card').filter({hasText:'cross.mp4'}).count(),0,'decline never inspects cross-origin content');
  let permissionRequests=await manager.evaluate(()=>window.__permissionRequests);
  assert.deepEqual(permissionRequests[0].origins,['http://localhost/*']);
  assert.equal(permissionRequests[0].active,true,'iframe permission request is reached within the click gesture');

  const tsURL=origin+'/ts/index.m3u8';
  const beforeRequests=requests.get('/ts/index.m3u8')||0;
  await manager.evaluate(()=>{window.__forceMissing=true;});
  await mediaButton(manager,tsURL).click();await waitStatus(manager,tsURL,'permission');
  assert.equal(requests.get('/ts/index.m3u8')||0,beforeRequests,'HLS host is checked before fetching the manifest');
  await mediaButton(manager,tsURL).click();await waitStatus(manager,tsURL,'interrupted');
  assert.match(await mediaStatus(manager,tsURL).textContent(),/許可されませんでした/);
  await mediaButton(manager,tsURL).click();await waitStatus(manager,tsURL,'permission');
  await manager.evaluate(()=>{window.__permissionAccept=true;});
  await saveAndDecode(manager,tsURL,'saved-hls.ts','mpegts',{standaloneHLS:true});
  permissionRequests=await manager.evaluate(()=>window.__permissionRequests);
  for(const request of permissionRequests.slice(1)) {
    assert.deepEqual(request.origins,['http://127.0.0.1/*'],'HLS request names only its concrete local host');
    assert.equal(request.active,true,'HLS permission request is reached within the click gesture');
  }
  await saveAndDecode(manager,origin+'/mp4/index.m3u8','saved-hls.mp4','mp4',{standaloneHLS:true});
  await saveAndDecode(manager,origin+'/dash/manifest.mpd','saved-dash.mp4','mp4');
  await saveAndDecode(manager,origin+'/split/master.m3u8','saved-split-hls.mp4','mp4');
  // Stop stays reachable even while a long candidate list is scrolled elsewhere.
  slowSegments=true;
  const downloadsBeforeStop=await manager.evaluate(async()=> (await chrome.downloads.search({})).length);
  await manager.setViewportSize({width:360,height:800});
  await mediaButton(manager,tsURL).click();await waitStatus(manager,tsURL,'fetching');
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
  await manager.locator('#scan').click();await mediaButton(manager,blobURL).waitFor();
  await saveAndDecode(manager,blobURL,'saved-page-blob.mp4','mp4');
  const mseURL=await page.evaluate(()=>{
    window.__mse=new MediaSource();const url=URL.createObjectURL(window.__mse);
    const video=document.createElement('video');video.src=url;document.body.append(video);return url;
  });
  await manager.locator('#scan').click();await mediaButton(manager,mseURL).waitFor();
  const downloadCount=await manager.evaluate(async()=> (await chrome.downloads.search({})).length);
  await mediaButton(manager,mseURL).click();await waitStatus(manager,mseURL,'interrupted');
  assert.match(await mediaStatus(manager,mseURL).textContent(),/blob|ページ内|分割配信|取得できません/);
  assert.equal(await manager.evaluate(async()=> (await chrome.downloads.search({})).length),downloadCount,'MediaSource blob is not falsely downloaded as a video file');
  await context.close();context=null;

  // Real injection after a local host grant is checked in a fresh isolated
  // profile. This is test-copy manifest permission, not a native prompt test.
  manifest.host_permissions=['http://127.0.0.1/*','http://localhost/*'];
  const granted=await openFixture('local-frame-granted',manifest,origin);
  assert.equal(await granted.manager.locator('#direct-list .video-card').filter({hasText:'cross.mp4'}).count(),1,'granted cross-origin iframe is collected through actual allFrames injection');
  assert.equal(await granted.manager.locator('.frame-permission').count(),0,'already permitted local frames do not request access again');
  await granted.manager.setViewportSize({width:360,height:800});
  assert.ok(await granted.manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'embedded candidate controls fit a narrow viewport');
  assert.deepEqual(errors,[],'no uncaught extension page errors');
  console.log('VideoHarbor embedded browser PASS: lazy/metadata/JSON-LD/player JSON/media iframe, same/cross-origin frame grants, scoped permission decline/retry, actual TS/fMP4/DASH/split-HLS/blob downloads with complete audio/video duration and full decode, MSE blob rejection. Native permission confirmation and real-site compatibility remain manual.');
  if(process.env.QA_KEEP)console.log(`QA files retained locally: ${scratch}`);
} finally {
  await context?.close();
  if(server)await new Promise(resolve=>server.close(resolve));
  if(!process.env.QA_KEEP)await rm(scratch,{recursive:true,force:true});
}
