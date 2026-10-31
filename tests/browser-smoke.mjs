// Runs an isolated Chrome profile. Test copy grants ONLY the local fixture origin.
// Real activeTab toolbar invocation and native macOS pickers remain manual QA.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {launchTestExtension} from './chrome-runtime.mjs';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const repo=fileURLToPath(new URL('../',import.meta.url));
const scratch=await mkdtemp(join(tmpdir(),'media-extension-qa-'));
const extension=join(scratch,'extension');await cp(join(repo,'extension'),extension,{recursive:true});
const workerPath=join(extension,'background.js');await writeFile(workerPath,(await readFile(workerPath,'utf8'))+'\nglobalThis.__openWorkspace=openWorkspace;globalThis.__workerBoot=crypto.randomUUID();\n');
const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
manifest.host_permissions=['http://127.0.0.1/*'];await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
let clip=Buffer.alloc(0), failedOnce=true;
const fixture=`<!doctype html><html lang="ja"><meta charset="utf-8"><title>Synthetic media fixture</title><body><h1>Local fixture</h1><img src="/red.svg" alt="赤" width="320" height="200"><img src="/blue.svg" alt="青" width="400" height="300"><img src="/red.svg"><div style="background-image:url('/green.svg');width:100px;height:100px"></div><picture><source srcset="/red.svg 1x, /blue.svg 2x"><img src="/red.svg"></picture><div id="shadow"></div><iframe src="/frame" title="関連画像"></iframe><video id="blue" title="青いカップ" controls src="/clip.webm" width="320" height="180"><source src="/variant.webm" type="video/webm"></video><video id="red" title="赤いカップ" controls src="/clip.webm?alternate=1" width="320" height="180"></video><a href="/stream.m3u8">stream</a><script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<img src="/shadow.svg">';</script></body></html>`;
const server=createServer((req,res)=>{
  if(req.url==='/empty') {res.setHeader('Content-Type','text/html');return res.end('<!doctype html><html lang="ja"><title>Empty synthetic fixture</title><body><h1>No media</h1></body></html>');}
  if(req.url==='/frame') {res.setHeader('Content-Type','text/html');return res.end('<img src="/frame.svg">');}
  if(req.url.startsWith('/clip.webm') || req.url==='/variant.webm') {res.setHeader('Content-Type','video/webm');return res.end(clip);}
  if(req.url.startsWith('/stream.m3u8')) {res.setHeader('Content-Type','application/vnd.apple.mpegurl');return res.end('#EXTM3U\n');}
  if(req.url.startsWith('/fail.svg') && failedOnce) {res.statusCode=403;return res.end('blocked');}
  if(req.url.endsWith('.svg')) {res.setHeader('Content-Type','image/svg+xml');return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${req.url.includes('blue')?'#566ac4':req.url.includes('green')?'#58a884':'#e8987e'}"/></svg>`);}
  res.setHeader('Content-Type','text/html');res.end(fixture);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
let context;
try {
  const runtime=await launchTestExtension(chromium,join(scratch,'profile'),extension,{acceptDownloads:true,viewport:{width:1280,height:900},ignoreDefaultArgs:['--disable-extensions'],args:['--autoplay-policy=no-user-gesture-required','--no-first-run']});
  context=runtime.context;const {worker,id}=runtime;
  const page=await context.newPage();await page.goto(origin);
  // Generate a small synthetic video locally; no remote media or personal pages.
  clip=Buffer.from(await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
    const ctx=canvas.getContext('2d'),stream=canvas.captureStream(12),chunks=[];
    const rec=new MediaRecorder(stream,{mimeType:'video/webm'});
    const ready=new Promise(resolve=>{rec.ondataavailable=e=>chunks.push(e.data);rec.onstop=async()=>resolve([...new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer())]);});
    rec.start(100);let n=0;const timer=setInterval(()=>{ctx.fillStyle=`hsl(${n++*15} 70% 50%)`;ctx.fillRect(0,0,320,180);},40);
    await new Promise(r=>setTimeout(r,400));rec.stop();clearInterval(timer);stream.getTracks().forEach(t=>t.stop());return ready;
  }));
  await page.reload();
  const tab=await worker.evaluate(async origin=>(await chrome.tabs.query({})).find(t=>t.url?.startsWith(origin)),origin);
  const [manager]=await Promise.all([context.waitForEvent('page'),worker.evaluate(tab=>globalThis.__openWorkspace(tab),tab)]);
  await manager.waitForLoadState();
  const errors=[];manager.on('pageerror',e=>errors.push(e.message));
  await manager.waitForFunction(()=>document.querySelector('#count').textContent && !document.querySelector('#scan').disabled);
  const downloadFolder=join(scratch,'downloads');await mkdir(downloadFolder);
  const session=await context.newCDPSession(manager);await session.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloadFolder,eventsEnabled:true});
  if(manifest.name==='ImageCrate') {
    assert.ok(await manager.locator('.card').count()>=5,'DOM, background, shadow and frame collection');
    assert.equal(await manager.locator('.image-select:checked').count(),0,'initial selection is empty');
    const boxes=manager.locator('.image-select');await boxes.nth(0).check();await boxes.nth(1).check();
    await manager.locator('#query').fill('red.svg');assert.match(await manager.locator('#selection').textContent(),/非表示1件/);
    await manager.locator('#save').click();
    await manager.waitForFunction(()=>document.querySelector('#batch').textContent.includes('2件保存完了'));
    assert.equal(await manager.locator('#selection').textContent(),'選択0件');
    await manager.locator('#query').fill('');
    await page.evaluate(origin=>{const image=new Image();image.src=origin+'/added.svg';document.body.append(image);},origin);
    await manager.locator('#scan').click();await manager.waitForFunction(()=>document.querySelector('#count').textContent.includes('全6件'));
    assert.equal(await manager.locator('.image-select:checked').count(),0,'rescan never reselects completed/new images');
    assert.match(await manager.locator('.card').filter({hasText:'red.svg'}).first().locator('.item-status').textContent(),/保存完了/);
    // Failed download keeps selection; retry only that item, with a fresh ID.
    await page.evaluate(origin=>{const image=new Image();image.dataset.src=origin+'/fail.svg';document.body.append(image);},origin);
    await manager.locator('#scan').click();await manager.waitForFunction(()=>document.querySelector('#count').textContent.includes('全7件'));
    await manager.locator('.card').filter({hasText:'fail.svg'}).locator('input').check();await manager.locator('#save').click();
    await manager.waitForFunction(()=>document.querySelector('#batch').textContent.includes('1件中断'));
    assert.match(await manager.locator('#selection').textContent(),/選択1件/);
    failedOnce=false;
    await manager.locator('#retry').click();await manager.waitForFunction(()=>document.querySelector('#batch').textContent.includes('1件保存完了'));
  } else {
    const assertFocused=async id=>assert.equal(await manager.evaluate(id=>document.activeElement?.id===id,id),true,`${id} has keyboard focus`);
    const screenshots=async label=>{
      if(!process.env.QA_SCREENSHOT)return;
      const base=process.env.QA_SCREENSHOT.replace(/\.png$/i,''), previous=manager.viewportSize();
      const scroll=await manager.evaluate(()=>({x:scrollX,y:scrollY}));
      for(const [size,width,height] of [['desktop',1280,900],['360',360,800]]) {
        await manager.setViewportSize({width,height});await manager.evaluate(()=>scrollTo(0,0));
        await manager.screenshot({path:`${base}-${label}-${size}.png`,fullPage:!['recording','ready'].includes(label),animations:'disabled'});
      }
      await manager.setViewportSize(previous);await manager.evaluate(({x,y})=>scrollTo(x,y),scroll);
    };
    assert.ok(await manager.locator('.direct-save').count()>=1);assert.ok(await manager.locator('#unsupported-count').textContent());
    const sameName=manager.locator('#direct-list .video-card').filter({hasText:'clip.webm'});
    assert.equal(await sameName.count(),2,'distinct URLs can have the same file name');
    for(const card of await sameName.all()) {
      const details=card.locator('.url-detail'),metadata=details.locator('.meta').first();
      assert.equal(await details.getAttribute('open'),null);
      assert.equal(await metadata.isVisible(),false,'candidate metadata is initially collapsed in details');
      await details.locator('summary').click();
      assert.equal(await metadata.isVisible(),true,'opening details reveals candidate metadata');
      assert.match(await metadata.textContent(),/WEBM.*127\.0\.0\.1/);
      await details.locator('summary').click();
    }
    await screenshots('download');
    const blueGroup=manager.locator('.video-group').filter({has:manager.getByRole('heading',{name:'青いカップ',exact:true})});
    assert.equal(await blueGroup.count(),1,'a real video occurrence has one identifiable card');
    assert.equal(await blueGroup.locator('.video-card').count(),2,'only confirmed sources of one video are grouped');
    assert.equal(await manager.getByRole('heading',{name:'赤いカップ',exact:true}).count(),1,'same-name CDN files remain different page videos');
    await page.locator('#blue').evaluate(el=>{el.style.outline='2px dotted rgb(77, 88, 99)';});
    await blueGroup.locator('.locate-source').click();
    await page.waitForFunction(()=>document.querySelector('#blue').style.outline.includes('18, 103, 214'));
    await manager.bringToFront();await blueGroup.locator('.locate-source').click();
    await page.waitForFunction(()=>document.querySelector('#blue').style.outline==='rgb(77, 88, 99) dotted 2px' || document.querySelector('#blue').style.outline==='2px dotted rgb(77, 88, 99)');
    await manager.bringToFront();
    await worker.evaluate(()=>{globalThis.__shownDownloads=[];chrome.downloads.show=id=>globalThis.__shownDownloads.push(id);});
    await blueGroup.locator('.source-alternatives > summary').click();
    assert.equal(await blueGroup.locator('.source-alternatives .direct-save').isVisible(),true);
    await blueGroup.locator('.source-alternatives .direct-save').click();await manager.waitForFunction(()=>document.querySelector('.source-alternatives .item-status[data-state="complete"]'));
    await blueGroup.locator('.source-alternatives .show-file').click();
    assert.equal(await worker.evaluate(()=>globalThis.__shownDownloads.length),1,'confirmed output has a folder action using its own download ID');
    await blueGroup.locator('.source-alternatives > summary').click();
    const hlsFormat=manager.locator('.video-card').filter({hasText:'stream.m3u8'}).locator('.output-format');
    await hlsFormat.selectOption('auto');
    await page.locator('#red').evaluate(el=>el.remove());
    await manager.locator('#scan').click();await manager.waitForFunction(()=>!document.querySelector('#scan').disabled);
    assert.equal(await manager.getByRole('heading',{name:'赤いカップ',exact:true}).count(),0,'a removed page video is no longer described as current');
    assert.equal(await hlsFormat.inputValue(),'auto','rescan preserves the selected output format');
    // Arrow navigation keeps focus inside the tablist for consecutive key presses.
    await manager.locator('#download-tab').focus();
    for(const [key,focused] of [['ArrowRight','record-tab'],['ArrowRight','download-tab'],['ArrowLeft','record-tab'],['Home','download-tab'],['End','record-tab']]) {
      await manager.keyboard.press(key);await assertFocused(focused);
      assert.equal(await manager.locator(`#${focused}`).getAttribute('aria-selected'),'true');
    }
    await manager.locator('#record-tab').click();
    await assertFocused('record-heading');
    await manager.locator('[name="record-mode"][value="display"]').check();
    assert.match(await manager.locator('#target-hint').textContent(),/別のタブ/);
    await screenshots('record-preparation');
    // The file choice stays visible when its settings disclosure is closed.
    await manager.evaluate(()=>{
      window.__diskWriteFailure=false;window.__diskCloseStarted=false;
      Object.defineProperty(window,'showSaveFilePicker',{configurable:true,writable:true,value:async()=>{let chunks=[];return ({
        name:'synthetic-recording.webm',
        getFile:async()=>new File(chunks,'synthetic-recording.webm',{type:'video/webm'}),
        createWritable:async()=>({
          async write(chunk) {if(window.__diskWriteFailure)throw new Error('synthetic disk failure');chunks.push(chunk);},
          async close() {window.__diskCloseStarted=true;await new Promise(resolve=>{window.__releaseDiskClose=resolve;});},
          async abort() {},
        }),
      });}});
      window.__fixtureFilePicker=window.showSaveFilePicker;
    });
    await manager.locator('.output-settings > summary').click();
    await manager.locator('#record-output').selectOption('file');
    await manager.locator('.output-settings > summary').click();
    assert.equal(await manager.locator('#file-choice').isVisible(),true);
    assert.equal(await manager.locator('#choose-file').isVisible(),true);
    assert.equal(await manager.locator('#start-record').isDisabled(),true,'file mode requires a selected destination');
    await manager.locator('#choose-file').click();
    assert.match(await manager.locator('#chosen-file').textContent(),/synthetic-recording\.webm/);
    assert.equal(await manager.locator('#start-record').isDisabled(),false);
    await manager.evaluate(()=>{window.showSaveFilePicker=async()=>{throw new DOMException('cancel','AbortError');};});
    await manager.locator('#choose-file').click();
    assert.match(await manager.locator('#chosen-file').textContent(),/synthetic-recording\.webm/,'cancel keeps the previous output choice');
    assert.equal(await manager.locator('#start-record').isDisabled(),false);
    await manager.evaluate(()=>{window.showSaveFilePicker=window.__fixtureFilePicker;});
    await manager.locator('.output-settings > summary').click();
    await manager.locator('#record-output').selectOption('memory');
    await manager.locator('.output-settings > summary').click();
    await manager.setViewportSize({width:360,height:800});
    // Inject synthetic capture at the native API boundary; exercise actual MediaRecorder lifecycle.
    await manager.evaluate(()=>{
      window.__captureTracks=[];
      window.__fixtureGetDisplayMedia=async()=>{
        const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;
        const ctx=canvas.getContext('2d');ctx.fillStyle='#258d79';ctx.fillRect(0,0,320,180);
        const stream=canvas.captureStream(12);window.__captureTracks.push(...stream.getTracks());
        const timer=setInterval(()=>{ctx.fillStyle=`hsl(${Date.now()%360} 60% 50%)`;ctx.fillRect(0,0,320,180);},80);
        const track=stream.getVideoTracks()[0],stop=track.stop.bind(track);
        track.stop=()=>{clearInterval(timer);stop();};
        track.addEventListener('ended',()=>clearInterval(timer));return stream;
      };
      Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,writable:true,value:window.__fixtureGetDisplayMedia});
    });
    await manager.locator('#start-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-panel').dataset.state==='awaiting-audio-decision');
    assert.equal(await manager.locator('#audio-decision').isVisible(),true);
    assert.equal(await manager.locator('#record-metrics').isVisible(),false,'no recorded metrics before the audio decision');
    assert.match(await manager.locator('#live-label').textContent(),/録画未開始/);
    await screenshots('audio-decision');
    await manager.locator('#continue-without-audio').click();
    await manager.waitForFunction(()=>document.querySelector('#record-state').textContent==='録画中');
    assert.equal(await manager.locator('#download-tab').isDisabled(),true);
    assert.equal(await manager.locator('#record-settings').isVisible(),false);
    await assertFocused('record-state');
    await manager.locator('#pause-record').focus();
    await manager.waitForTimeout(1100);await assertFocused('pause-record');
    await manager.evaluate(()=>scrollTo(0,0));
    const stopBox=await manager.locator('#stop-record').boundingBox();assert.ok(stopBox.y>=0 && stopBox.y+stopBox.height<=800,'recording stop remains in viewport at 360px');
    await screenshots('recording');
    await manager.locator('#pause-record').click();assert.equal(await manager.locator('#record-state').textContent(),'一時停止中');
    await manager.locator('#pause-record').click();
    await manager.waitForTimeout(350);await manager.locator('#stop-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-state').textContent.includes('保存してください'));
    await assertFocused('record-state');
    assert.ok(await manager.evaluate(()=>window.__captureTracks.every(t=>t.readyState==='ended')),'all capture tracks stopped');
    assert.equal(await manager.locator('#start-record').isDisabled(),true,'unsaved capture blocks replacement');
    assert.match(await manager.locator('#record-description').textContent(),/音声なし/);
    assert.equal(await manager.locator('#save-record').isVisible(),true);
    assert.equal(await manager.locator('#record-settings').isVisible(),false,'unsaved result takes priority over blocked settings');
    assert.equal(await manager.locator('#record-result').isVisible(),true);
    assert.match(await manager.locator('#result-location').textContent(),/まだファイルへ保存していません/);
    await manager.locator('#play-result').click();
    await manager.waitForFunction(()=>document.querySelector('#result-playback').readyState>=2 && document.querySelector('#result-playback').videoWidth===320);
    const playerBox=await manager.locator('#result-playback').boundingBox(),panelBox=await manager.locator('#record-panel').boundingBox();
    assert.ok(playerBox.y>=0 && playerBox.y+playerBox.height<=panelBox.y,'unsaved playback controls stay above the fixed save panel');
    const playbackURL=await manager.locator('#result-playback').getAttribute('src');
    await manager.evaluate(()=>scrollTo(0,0));
    const saveBox=await manager.locator('#save-record').boundingBox();
    assert.ok(saveBox.y>=0 && saveBox.y+saveBox.height<=800,'unsaved recording save action remains in viewport at 360px');
    await screenshots('ready');
    // Simulate native save-picker cancellation, then allow a real download to the test folder.
    await manager.evaluate(()=>{
      const original=chrome.downloads.download.bind(chrome.downloads);window.__cancelNextSave=true;
      chrome.downloads.download=options=>{
        if(window.__cancelNextSave){window.__cancelNextSave=false;return Promise.reject(new Error('USER_CANCELED'));}
        return original({...options,saveAs:false});
      };
    });
    await manager.locator('#save-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-message').textContent.includes('保存をキャンセル'));
    assert.equal(await manager.locator('#record-panel').getAttribute('data-state'),'ready');
    assert.equal(await manager.locator('#save-record').isVisible(),true,'cancel keeps a retryable recording');
    assert.equal(await manager.locator('#start-record').isDisabled(),true);
    assert.equal(await manager.locator('#result-playback').getAttribute('src'),playbackURL,'save cancellation preserves the playable recording');
    await assertFocused('record-state');
    await manager.locator('#save-record').click();await manager.waitForFunction(()=>document.querySelector('#record-state').textContent==='ファイル保存完了');
    assert.equal(await manager.locator('#download-tab').isDisabled(),false);
    await assertFocused('record-state');
    await screenshots('saved');
    assert.equal(await manager.locator('#record-layout').evaluate(el=>el.firstElementChild.id),'record-stage','saved result precedes next-recording settings in keyboard and DOM order');
    assert.match(await manager.locator('#result-file-name').textContent(),/\.webm$/);
    await manager.locator('#show-record-file').click();
    assert.equal(await worker.evaluate(()=>globalThis.__shownDownloads.length),2,'memory recording folder action uses a proven extension download');
    await manager.locator('#record-audio').uncheck();
    const [savedCapture]=await manager.evaluate(()=>chrome.downloads.search({urlRegex:'^blob:'}));
    const captureBytes=await readFile(savedCapture.filename);assert.ok(captureBytes.length>100);
    clip=captureBytes;
    await page.evaluate(async origin=>{const v=document.querySelector('video');v.src=origin+'/clip.webm?recorded=1';await v.play();},origin);
    await page.waitForFunction(()=>document.querySelector('video').videoWidth===320 && document.querySelector('video').currentTime>0);
    // Cancel does not replace the previously completed recording.
    await manager.evaluate(()=>{Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,writable:true,value:()=>new Promise((resolve,reject)=>{window.__cancelPendingCapture=()=>reject(new DOMException('cancel','NotAllowedError'));})});});
    await manager.locator('#start-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-panel').dataset.state==='starting');
    assert.equal(await manager.locator('#record-metrics').isVisible(),false,'previous result metrics are hidden while choosing a new capture');
    assert.equal(await manager.locator('#record-description').isVisible(),false,'previous target and audio do not describe a pending capture');
    await manager.evaluate(()=>window.__cancelPendingCapture());
    await manager.waitForFunction(()=>!document.querySelector('#start-record').disabled);
    assert.ok(!await manager.locator('#stop-record').isVisible());
    assert.equal(await manager.locator('#record-panel').getAttribute('data-state'),'saved');
    assert.match(await manager.locator('#stage-hint').textContent(),/直前の録画/);
    assert.match(await manager.locator('#record-message').textContent(),/キャンセル.*保持/);
    assert.equal(await manager.locator('#result-playback').getAttribute('src'),playbackURL,'new capture cancellation preserves the previous playback URL');
    // Native file APIs are synthetic, but MediaRecorder and UI finalization remain real.
    await manager.evaluate(()=>{navigator.mediaDevices.getDisplayMedia=window.__fixtureGetDisplayMedia;});
    await manager.locator('.output-settings > summary').click();
    await manager.locator('#record-output').selectOption('file');
    await manager.locator('.output-settings > summary').click();
    await manager.locator('#start-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-panel').dataset.state==='recording');
    await manager.waitForTimeout(350);await manager.locator('#stop-record').click();
    await manager.waitForFunction(()=>window.__diskCloseStarted);
    assert.equal(await manager.locator('#record-panel').getAttribute('data-state'),'finalizing','file close must finish before success');
    assert.equal(await manager.locator('#record-settings').isVisible(),false);
    assert.equal(await manager.locator('#save-record').isVisible(),false);
    await assertFocused('record-state');
    await manager.evaluate(()=>window.__releaseDiskClose());
    await manager.waitForFunction(()=>document.querySelector('#record-panel').dataset.state==='saved');
    assert.equal(await manager.locator('#show-record-file').isVisible(),false,'sequential file output does not invent a Chrome download location');
    await manager.locator('#play-result').click();
    await manager.waitForFunction(()=>document.querySelector('#result-playback').readyState>=2 && document.querySelector('#result-playback').videoWidth===320);
    assert.match(await manager.locator('#result-file-name').textContent(),/synthetic-recording\.webm/);
    assert.equal(await manager.locator('#start-record').isDisabled(),true,'the selected output file belongs to one recording only');
    assert.match(await manager.locator('#chosen-file').textContent(),/未選択/);
    await manager.locator('#choose-file').click();
    await manager.evaluate(()=>{window.__diskWriteFailure=true;});
    await manager.locator('#start-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-panel').dataset.state==='recording');
    await manager.waitForTimeout(350);await manager.locator('#stop-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-panel').dataset.state==='error');
    assert.match(await manager.locator('#record-message').textContent(),/不完全なファイル/);
    assert.equal(await manager.locator('#save-record').isVisible(),false,'failed disk recording does not claim a recoverable memory result');
    assert.equal(await manager.locator('#start-record').isDisabled(),true,'a failed file write also consumes its output choice');
    assert.equal(await manager.locator('#stage-title').textContent(),'録画・保存を確認');
    // A MediaRecorder error can still leave a Blob: error and its save action coexist.
    await manager.locator('.output-settings > summary').click();
    await manager.locator('#record-output').selectOption('memory');
    await manager.locator('.output-settings > summary').click();
    await manager.evaluate(()=>{
      window.__NativeMediaRecorder=window.MediaRecorder;
      window.MediaRecorder=class extends window.__NativeMediaRecorder {constructor(...args){super(...args);window.__actualRecorder=this;}};
    });
    await manager.locator('#start-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-panel').dataset.state==='recording');
    await manager.waitForTimeout(350);await manager.evaluate(()=>window.__actualRecorder.dispatchEvent(new Event('error')));
    await manager.waitForFunction(()=>document.querySelector('#record-panel').dataset.state==='error');
    assert.equal(await manager.locator('#save-record').isVisible(),true,'a recording error can retain data to save');
    assert.equal(await manager.locator('#start-record').isDisabled(),true);
    assert.match(await manager.locator('#record-message').textContent(),/取得済みデータを保存できます/);
    manager.once('dialog',dialog=>dialog.accept());await manager.locator('#discard-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-panel').dataset.state==='idle');
    await manager.evaluate(()=>{window.MediaRecorder=window.__NativeMediaRecorder;});
    // Exercise the real File System Access writer against this disposable profile's
    // origin-private files. Only the native save-picker boundary is substituted.
    await manager.evaluate(async()=>{
      const root=await navigator.storage.getDirectory();
      window.__qaFsaA=await root.getFileHandle('qa-first.webm',{create:true});
      window.__qaFsaB=await root.getFileHandle('qa-second.webm',{create:true});
      const handles=[window.__qaFsaA,window.__qaFsaB];
      window.showSaveFilePicker=async()=>handles.shift();
      navigator.mediaDevices.getDisplayMedia=window.__fixtureGetDisplayMedia;
    });
    await manager.locator('.output-settings > summary').click();
    await manager.locator('#record-output').selectOption('file');
    await manager.locator('.output-settings > summary').click();
    await manager.locator('#choose-file').click();await manager.locator('#start-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-panel').dataset.state==='recording');
    await manager.waitForTimeout(350);await manager.locator('#stop-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-panel').dataset.state==='saved');
    const firstFile=await manager.evaluate(async()=>{
      const file=await window.__qaFsaA.getFile();
      return {size:file.size,digest:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))]};
    });
    assert.ok(firstFile.size>100,'the first sequential recording really exists in the disposable filesystem');
    assert.equal(await manager.locator('#start-record').isDisabled(),true);
    await manager.locator('#play-result').click();
    await manager.waitForFunction(()=>document.querySelector('#result-playback').readyState>=2);
    const filePlaybackURL=await manager.locator('#result-playback').getAttribute('src');
    await manager.locator('#download-tab').click();
    assert.equal(await manager.locator('#result-playback').evaluate(el=>el.paused),true,'leaving the recorder pauses hidden result playback');
    await manager.locator('#record-tab').click();
    assert.equal(await manager.locator('#result-playback').getAttribute('src'),filePlaybackURL,'view changes retain the saved result for replay');
    await manager.locator('#choose-file').click();
    await manager.evaluate(()=>{navigator.mediaDevices.getDisplayMedia=()=>Promise.reject(new DOMException('cancel','NotAllowedError'));});
    await manager.locator('#start-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-panel').dataset.state==='saved' && !document.querySelector('#start-record').disabled);
    await manager.evaluate(()=>{navigator.mediaDevices.getDisplayMedia=window.__fixtureGetDisplayMedia;});
    await manager.locator('#start-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-panel').dataset.state==='recording');
    await manager.waitForTimeout(350);await manager.locator('#stop-record').click();
    await manager.waitForFunction(()=>document.querySelector('#record-panel').dataset.state==='saved');
    const files=await manager.evaluate(async()=>{
      const first=await window.__qaFsaA.getFile(),second=await window.__qaFsaB.getFile();
      return {firstSize:first.size,firstDigest:[...new Uint8Array(await crypto.subtle.digest('SHA-256',await first.arrayBuffer()))],secondSize:second.size};
    });
    assert.equal(files.firstSize,firstFile.size);assert.deepEqual(files.firstDigest,firstFile.digest,'second recording and capture cancellation preserve every byte of the first real file');
    assert.ok(files.secondSize>100,'the second recording writes a different real file');
    await screenshots('file-saved');
    await manager.setViewportSize({width:1280,height:900});
    // Chrome 116 omits this extension tab's URL from tabs.query without tabs
    // permission. The workspace can identify its own real tab directly.
    const workspaceTab=await manager.evaluate(()=>chrome.tabs.getCurrent());
    assert.ok(Number.isInteger(workspaceTab?.id),'the real workspace tab is available for zoom');
    await worker.evaluate(async id=>chrome.tabs.setZoom(id,2),workspaceTab.id);
    assert.ok(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Chrome 200% zoom keeps the saved result within the layout');
    assert.equal(await manager.locator('#record-layout').evaluate(el=>el.firstElementChild.id),'record-stage');
    await worker.evaluate(async id=>chrome.tabs.setZoom(id,1),workspaceTab.id);
    await manager.setViewportSize({width:360,height:800});
    // Empty results expose working recovery actions without invoking capture automatically.
    const emptyPage=await context.newPage();await emptyPage.goto(origin+'/empty');
    const emptyTab=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(t=>t.url===url),origin+'/empty');
    const [emptyManager]=await Promise.all([context.waitForEvent('page'),worker.evaluate(tab=>globalThis.__openWorkspace(tab),emptyTab)]);
    await emptyManager.waitForLoadState();emptyManager.on('pageerror',e=>errors.push(e.message));
    await emptyManager.waitForFunction(()=>!document.querySelector('#empty').hidden && !document.querySelector('#scan').disabled);
    assert.equal(await emptyManager.locator('#empty').isVisible(),true);
    assert.equal(await emptyManager.locator('.direct-save').count(),0);
    await emptyManager.locator('#empty-scan').click();
    await emptyManager.waitForFunction(()=>!document.querySelector('#empty-scan').disabled);
    await emptyManager.locator('#empty-record').click();
    assert.equal(await emptyManager.evaluate(()=>document.activeElement?.id),'record-heading');
    assert.equal(await emptyManager.locator('#record-panel').getAttribute('data-state'),'idle');
    await emptyManager.close();await emptyPage.close();
    await manager.setViewportSize({width:1280,height:900});
  }
  // A real extension service worker stop/restart must retain session-scoped result state.
  const bootBefore=await worker.evaluate(()=>globalThis.__workerBoot);
  await session.send('ServiceWorker.enable');await session.send('ServiceWorker.stopAllWorkers');
  await manager.reload();
  await manager.waitForFunction(()=>document.querySelector('#message').textContent.includes('前回の取得結果'));
  await manager.waitForFunction(()=>document.querySelector('.item-status[data-state="complete"]'));
  const restartedWorker=context.serviceWorkers().find(w=>w.url().includes(id));
  assert.ok(restartedWorker,'worker is available after page reconnects');
  assert.notEqual(await restartedWorker.evaluate(()=>globalThis.__workerBoot),bootBefore,'service worker actually restarted');
  if(manifest.name==='VideoHarbor')await manager.locator('#record-tab').click();
  if(process.env.QA_SCREENSHOT)await manager.screenshot({path:process.env.QA_SCREENSHOT.replace('.png','-desktop.png'),fullPage:true,animations:'disabled'});
  await manager.setViewportSize({width:360,height:900});
  assert.ok(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'360px layout does not overflow');
  if(process.env.QA_SCREENSHOT)await manager.screenshot({path:process.env.QA_SCREENSHOT,fullPage:true,animations:'disabled'});
  if(manifest.name==='VideoHarbor') {
    await manager.setViewportSize({width:320,height:800});
    assert.ok(await manager.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'320px layout does not overflow');
    await manager.emulateMedia({reducedMotion:'reduce',forcedColors:'active'});
    assert.ok(await manager.evaluate(()=>[...document.querySelectorAll('*')].every(el=>{
      const style=getComputedStyle(el);return style.animationName==='none' && style.transitionDuration.split(',').every(value=>parseFloat(value)===0);
    })),'reduced motion suppresses animated UI');
  }
  assert.deepEqual(errors,[],'no uncaught page errors');
  console.log(`${manifest.name} browser smoke PASS (isolated Chrome, local fixture). Native activeTab invocation, tabCapture consent and macOS display/audio remain manual.`);
  if(process.env.QA_KEEP)console.log(`QA files retained locally: ${scratch}`);
} finally {await context?.close();await new Promise(resolve=>server.close(resolve));if(!process.env.QA_KEEP)await rm(scratch,{recursive:true,force:true});}
