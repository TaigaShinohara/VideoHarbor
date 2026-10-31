import { fileLabel, extensionOf, matchesImage, summarizeJobs, formatBytes, publicError } from './utils.js';
import { RecorderController } from './recorder.js';
import { MediaSaver, originPattern } from './media-save.js';
const KIND = 'videos';
const $ = id => document.getElementById(id);
const sessionId = new URL(location.href).searchParams.get('id');
const instance = crypto.randomUUID();
let state, selected = new Set(), visible = [], loading = false, requestPending = false, pollRunning = false;
let recorder = null;
let initialRecorderMessage = '', previousRecordingPhase = '';
const handledCompletions = new Set();
const mediaSaver=new MediaSaver({onUpdate:updateMediaUI,readBlob:(url,offset,token)=>send('blob-read',{url,offset,token})});
async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({type, sessionId, instance, ...extra});
  if (!response?.ok) throw new Error(response?.error || '拡張の接続が切れました。作業タブを開き直してください。');
  return response.data;
}
function error(error) { $('error').textContent=publicError(error); $('error').hidden=false; }
function clearError() { $('error').hidden=true; }
function element(tag, cls, text) { const e = document.createElement(tag); if(cls)e.className=cls; if(text !== undefined)e.textContent=text; return e; }
function icon(name) {
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.classList.add('icon');svg.setAttribute('aria-hidden','true');
  const use=document.createElementNS('http://www.w3.org/2000/svg','use');
  use.setAttribute('href',`icons.svg#${name}`);svg.append(use);return svg;
}
function isBusy() { return loading || requestPending || mediaSaver.busy || (state && summarizeJobs(state.jobs).active > 0); }
function jobFor(url) { return mediaSaver.status(url) || state.jobs.find(job=>job.url===url) || state.history?.find(job=>job.url===url); }
function jobLabel(job) {
  if (!job) return '';
  if(job.message)return job.message+(job.status==='fetching' ? ` · ${formatBytes(job.bytesReceived)}` : '');
  if (job.status === 'complete') return '保存完了';
  if (job.status === 'interrupted') return `中断 · ${job.error || '再試行できます'}`;
  if (job.status === 'queued') return '順番待ち';
  return `保存中 · ${formatBytes(job.bytesReceived)}${job.totalBytes > 0 ? ' / '+formatBytes(job.totalBytes) : ''}`;
}
function statusElement(item) { const span = element('span','item-status',jobLabel(jobFor(item.url))); span.dataset.url=item.url;span.dataset.state=jobFor(item.url)?.status || '';  return span; }
function applyState(next) {
  state = next;
  for(const job of state.jobs) {
    const key=`${job.downloadId}:${job.url}`;
    if(job.status === 'complete' && !handledCompletions.has(key)) { selected.delete(job.url); handledCompletions.add(key); }
  }
  updateSummary();
  for(const el of document.querySelectorAll('.item-status')) { const job=jobFor(el.dataset.url);el.textContent=jobLabel(job);el.dataset.state=job?.status || ''; }
  for(const checkbox of document.querySelectorAll('.image-select')) checkbox.checked=selected.has(checkbox.dataset.url);
}
function updateSummary() {
  if(!state) return;
  const batch=summarizeJobs(state.jobs), busy=isBusy() || Boolean(recorder?.busy);
  $('scan').disabled=busy || Boolean(recorder?.busy);
  document.body.classList.toggle('scanning',loading);
  $('empty-scan').disabled=busy || Boolean(recorder?.busy);
  $('download-footer').hidden=!batch.total;
  const batchText=batch.total ? `今回 ${batch.total}件中 ${batch.complete}件保存完了 · ${batch.interrupted}件中断${batch.active ? ` · ${batch.active}件処理中` : ''}` : '';
  if($('batch').textContent!==batchText)$('batch').textContent=batchText;
  $('cancel').hidden=!batch.active;
  $('retry').hidden=!batch.interrupted || batch.active > 0;
  $('retry').disabled=busy;
  if(KIND === 'images') {
    const visibleURLs=new Set(visible.map(i=>i.url));
    const hidden=[...selected].filter(url=>!visibleURLs.has(url)).length;
    $('selection').textContent=`選択${selected.size}件${hidden ? ` · 非表示${hidden}件を含む` : ''}`;
    $('save').textContent=`選択${selected.size}件を保存`;
    $('save').disabled=!selected.size || busy;
    $('select-visible').disabled=busy || !visible.length;
    $('clear').disabled=busy || !selected.size;
    for(const el of document.querySelectorAll('.image-select')) el.disabled=busy;
  } else for(const el of document.querySelectorAll('.direct-save,.media-save,.frame-permission')) el.disabled=busy;
  $('record-tab').disabled=mediaSaver.busy;
}
function updateMediaUI() {
  if(!state)return;
  updateSummary();
  const current=mediaSaver.current && mediaSaver.status(mediaSaver.current);
  document.body.classList.toggle('media-saving',mediaSaver.busy);
  $('media-panel').hidden=!mediaSaver.busy;
  if(current) {
    $('media-status').textContent=current.message;
    $('media-progress').textContent=formatBytes(current.bytesReceived)+(current.total ? ` · ${current.completed || 0}/${current.total}区間` : '');
  }
  for(const el of document.querySelectorAll('.item-status')) {
    const job=jobFor(el.dataset.url);el.textContent=jobLabel(job);el.dataset.state=job?.status || '';
  }
  for(const el of document.querySelectorAll('.media-save')) {
    const job=mediaSaver.status(el.dataset.url);
    el.textContent=job?.status==='permission' ? '配信元を許可して保存' : job?.blob ? 'ファイル保存を再試行' : '保存';
    el.setAttribute('aria-label',`${fileLabel(el.dataset.url)}${job?.status==='permission' ? 'の配信元を許可して保存' : 'を保存'}`);
  }
  for(const el of document.querySelectorAll('.permission-sites')) {
    const origins=mediaSaver.status(el.dataset.url)?.origins;
    el.hidden=!origins?.length;el.textContent=origins?.length ? `アクセスを求めるサイト: ${origins.join('、')}` : '';
  }
}
function renderImages() {
  const filters={query:$('query').value,width:Math.max(0,Number($('width').value)||0),height:Math.max(0,Number($('height').value)||0),type:$('type').value};
  visible=state.items.filter(item=>matchesImage(item,filters));
  $('count').textContent=`表示${visible.length} / 全${state.items.length}件`;
  $('grid').replaceChildren();
  for(const item of visible) {
    const card=element('label','card');
    const thumb=element('div','thumb');
    const image=new Image(); image.loading='lazy'; image.alt=''; image.referrerPolicy='no-referrer';
    image.addEventListener('error',()=>{ thumb.replaceChildren(element('span','meta','プレビューを表示できません')); }); image.src=item.url; thumb.append(image);
    const body=element('div','card-body');
    const input=element('input','image-select'); input.type='checkbox';input.dataset.url=item.url; input.checked=selected.has(item.url);
    input.setAttribute('aria-label',`${fileLabel(item.url)}を選択`);
    input.addEventListener('change',()=>{input.checked ? selected.add(item.url) : selected.delete(item.url);updateSummary();});
    const name=element('strong','file-name',fileLabel(item.url)); name.title=fileLabel(item.url);
    body.append(input,name,element('span','meta',`${item.width && item.height ? `${item.width} × ${item.height}` : '寸法不明'} · ${extensionOf(item.url,'images').toUpperCase()}`),statusElement(item));
    card.append(thumb,body); $('grid').append(card);
  }
  $('empty').hidden=visible.length > 0;
  $('empty').replaceChildren(element('h3','',state.items.length ? 'フィルターに一致しません' : '取得できる画像がありません'),element('p','',state.items.length ? '検索・最小寸法・種類を変更してください。' : '元ページで画像を表示し、スクロールしてから再スキャンしてください。'));
  if(state.items.length && !visible.length) {
    const reset=element('button','secondary','フィルターを解除');reset.addEventListener('click',()=>{$('query').value='';$('width').value=0;$('height').value=0;$('type').value='';renderImages();});$('empty').append(reset);
  }
  updateSummary();
}
function showView(view, focus=true) {
  if(view==='record' && mediaSaver.busy){error(new Error('動画の保存が終わってから録画を開始してください。'));return;}
  if(view !== 'record' && recorder?.busy) { error(new Error('録画・保存中はこの画面で停止と状態を確認してください。')); return; }
  const record=view === 'record';
  $('download-view').hidden=record;$('record-view').hidden=!record;
  $('download-tab').setAttribute('aria-selected',String(!record));$('record-tab').setAttribute('aria-selected',String(record));
  $('download-tab').tabIndex=record ? -1 : 0;$('record-tab').tabIndex=record ? 0 : -1;
  if(focus) $(record ? 'record-heading' : 'download-heading').focus();
}
function renderVideos() {
  const supported=item=>['direct','hls','dash','blob'].includes(item.type);
  const direct=state.items.filter(supported), other=state.items.filter(i=>!supported(i));
  $('count').textContent=`${direct.length}件の動画`;
  $('direct-list').replaceChildren();$('unsupported-list').replaceChildren();
  for(const item of [...direct,...other]) {
    const card=element('article','video-card'), info=element('div','video-info');
    const format=item.type==='direct' ? extensionOf(item.url,'videos').toUpperCase() : item.type==='blob' ? 'ページ内動画' : item.type.toUpperCase();
    const fileIcon=element('div','file-icon');fileIcon.setAttribute('aria-hidden','true');fileIcon.append(icon('file'),element('span','',format));
    info.append(element('h3','file-name',fileLabel(item.url)));
    let host='ページ内データ';try{host=new URL(item.url).hostname || host;}catch{}
    info.append(element('p','meta',`${format} · ${host}${item.width && item.height ? ` · ${item.width} × ${item.height}` : ''}`), statusElement(item));
    const details=element('details','url-detail'), summary=element('summary','','詳細');
    details.append(summary,element('p','meta',item.url.length>500 ? item.url.slice(0,500)+'…' : item.url));info.append(details);
    const sites=element('p','hint permission-sites');sites.dataset.url=item.url;sites.hidden=true;info.append(sites);
    if(item.type==='hls')info.append(element('p','hint','HLSをファイルにまとめて保存 · 最大256 MiB · 単独リストでは別音声を判別できません'));
    if(item.type==='dash')info.append(element('p','hint','DASHの映像・音声をMP4にまとめて保存 · 最大256 MiB'));
    if(item.type==='blob')info.append(element('p','hint','元ファイル型のページ内動画を取得 · 分割再生用blobは未対応'));
    const button=element('button',supported(item) ? `primary ${item.type==='direct' ? 'direct-save' : 'media-save'}` : 'secondary');
    button.dataset.url=item.url;
    button.append(icon(supported(item) ? 'download' : 'record'),document.createTextNode(supported(item) ? '保存' : '録画へ'));
    button.setAttribute('aria-label',`${fileLabel(item.url)}${supported(item) ? 'を保存' : 'の録画設定へ'}`);
    button.addEventListener('click',()=>{
      if(item.type==='direct')return saveURLs([item.url]);
      if(!supported(item))return showView('record');
      if(isBusy() || recorder?.busy)return;
      void mediaSaver.start(item,state.title).catch(error);
    });
    card.append(fileIcon,info,button);$(supported(item) ? 'direct-list' : 'unsupported-list').append(card);
  }
  $('empty').hidden=direct.length>0;$('record-fallback').hidden=!direct.length;
  $('unsupported').hidden=!other.length;$('unsupported-count').textContent=`(${other.length}件)`;
  $('frame-sites').replaceChildren();
  const frameOrigins=[...new Set((state.frames || []).map(f=>originPattern(f.url)))];
  $('frame-access').hidden=!frameOrigins.length;
  for(const origin of frameOrigins) {
    const button=element('button','secondary frame-permission',`${new URL(origin).hostname} を許可して探す`);
    button.addEventListener('click',()=>{
      // Request in the click before awaiting or messaging the worker.
      const permission=chrome.permissions.request({origins:[origin]});
      requestPending=true;updateSummary();
      permission.then(async granted=>{
        if(!granted)throw new Error('埋め込みサイトへのアクセスは許可されませんでした。');
        requestPending=false;await scan();
      }).catch(error).finally(()=>{requestPending=false;updateSummary();});
    });
    $('frame-sites').append(button);
  }
  updateMediaUI();
}
async function scan() {
  if(isBusy() || recorder?.busy) return;
  const fromEmpty=document.activeElement===$('empty-scan');
  loading=true;clearError();updateSummary();$('message').textContent='ページから候補を探しています…';
  try { applyState(await send('scan'));render();$('message').textContent=`${state.items.length}件の候補を取得しました。`; }
  catch(e){error(e);$('message').textContent='取得できませんでした。元ページからやり直せます。';}
  finally {
    loading=false;updateSummary();
    if(fromEmpty && (document.activeElement===document.body || document.activeElement===$('empty-scan'))) $($('empty').hidden ? 'download-heading' : 'empty-scan').focus({preventScroll:true});
  }
}
function render() {
  $('notices').textContent=state.notices.join(' ');$('notices').hidden=!state.notices.length;
  KIND === 'images' ? renderImages() : renderVideos();
}
async function saveURLs(urls) {
  if(isBusy()) return;
  requestPending=true;clearError();updateSummary();
  try{applyState(await send('save',{urls}));}catch(e){error(e);}finally{requestPending=false;updateSummary();}
}
async function jobAction(type) {
  if(requestPending || mediaSaver.busy || recorder?.busy) return;requestPending=true;clearError();updateSummary();
  try{applyState(await send(type));}catch(e){error(e);}finally{requestPending=false;updateSummary();}
}
function setupRecording() {
  recorder = new RecorderController({source:state,onUpdate:updateRecording,acquire:async mode=>{try{return await send('capture',{mode});}catch(e){e.name='CaptureControlError';throw e;}},release:()=>send('release')});
  initialRecorderMessage=recorder.snapshot().message;
  $('download-tab').addEventListener('click',()=>showView('download'));$('record-tab').addEventListener('click',()=>showView('record'));
  for(const id of ['download-tab','record-tab']) $(id).addEventListener('keydown',e=>{
    if(!['ArrowRight','ArrowLeft','Home','End'].includes(e.key))return;
    e.preventDefault();
    const next=e.key==='Home' ? 'download' : e.key==='End' ? 'record' : id==='download-tab' ? 'record' : 'download';
    if($(next+'-tab').disabled)return;
    showView(next,false);$(next+'-tab').focus();
  });
  $('try-record').addEventListener('click',()=>showView('record'));
  $('empty-record').addEventListener('click',()=>showView('record'));
  $('empty-scan').addEventListener('click',scan);
  $('record-output').addEventListener('change',()=>updateRecording(recorder.snapshot()));
  for(const input of document.querySelectorAll('[name="record-mode"]'))input.addEventListener('change',()=>updateRecording(recorder.snapshot()));
  $('choose-file').addEventListener('click',()=>recorder.chooseFile().catch(error));
  $('start-record').addEventListener('click',()=> {
    if(mediaSaver.busy)return;
    clearError();
    // start() must reach getDisplayMedia before yielding user activation.
    recorder.start(document.querySelector('[name="record-mode"]:checked').value,$('record-audio').checked,$('record-output').value).catch(error);
  });
  $('pause-record').addEventListener('click',()=>{try{recorder.snapshot().phase==='paused' ? recorder.resume() : recorder.pause();}catch(e){error(e);}});
  $('stop-record').addEventListener('click',()=>recorder.stop().catch(error));
  $('continue-without-audio').addEventListener('click',()=>recorder.continueWithoutAudio());
  for(const id of ['reselect-capture','cancel-record-start']) $(id).addEventListener('click',async()=>{
    try {
      await recorder.cancelStart();
      if(!$('start-record').disabled) $('start-record').focus();
      else $('record-state').focus();
    } catch(e) { error(e); }
  });
  $('save-record').addEventListener('click',()=>recorder.save().catch(error));
  $('discard-record').addEventListener('click',()=>{if(confirm('この作業タブ内の録画データを破棄しますか？保存済みのファイルは残ります。')) recorder.discard();});
  chrome.tabs.onRemoved.addListener(tabId=>{if(tabId===state.tabId && recorder.snapshot().method==='tab' && recorder.busy) recorder.stop().catch(error);});
  window.addEventListener('beforeunload',e=>{const s=recorder.snapshot();if(mediaSaver.busy || [...mediaSaver.results.values()].some(r=>r.blob) || recorder.busy || (s.resultReady && !s.resultSaved)){e.preventDefault();e.returnValue='';}});
  updateRecording(recorder.snapshot());
}
function updateRecording(s) {
  const phases={idle:'待機中',starting:'録画を準備中','awaiting-audio-decision':'音声を確認してください · 録画未開始',recording:'録画中',paused:'一時停止中',finalizing:'保存を確定中',ready:'録画できました · 保存してください',saving:'ファイルを保存中',saved:'ファイル保存完了',error:'録画・保存に問題が起きました'};
  const awaiting=s.phase==='awaiting-audio-decision';
  const busy=['starting','awaiting-audio-decision','recording','paused','finalizing','saving'].includes(s.phase);
  const focused=document.activeElement, phaseChanged=previousRecordingPhase!==s.phase;
  const mode=document.querySelector('[name="record-mode"]:checked').value, disk=$('record-output').value==='file';
  const targetHint=mode==='tab' ? '元のタブを録画します。' : '開始後に共有する対象を選びます。別のタブも選べます。';
  document.body.classList.toggle('recording-active',['starting','awaiting-audio-decision','recording','paused','finalizing'].includes(s.phase));
  $('record-settings').hidden=busy || (s.resultReady && !s.resultSaved);
  document.body.classList.toggle('recording-error',s.phase==='error');
  $('record-panel').hidden=s.phase==='idle' && s.message===initialRecorderMessage;
  $('record-panel').dataset.state=s.phase;
  $('preview-stage').dataset.phase=s.phase;
  $('record-state').textContent=phases[s.phase] || s.phase;$('record-state').dataset.state=s.phase;
  $('download-tab').disabled=busy;
  $('record-options').disabled=busy;$('start-record').disabled=busy || (s.resultReady && !s.resultSaved) || (disk && !s.diskChosen);
  $('choose-file').disabled=busy;
  const diskOption=$('record-output').querySelector('option[value="file"]');diskOption.disabled=!s.diskAvailable;
  $('file-choice').hidden=!disk;
  $('output-summary').textContent=disk ? 'ファイルへ順次保存' : '停止後に保存';
  $('record-limit').textContent=disk ? '最大30分 · ファイルへ順次保存' : '最大30分 · 約256 MiBで自動停止';
  $('target-hint').textContent=targetHint;
  $('chosen-file').textContent=s.diskChosen ? `選択済み: ${s.chosenFileName || s.fileName}` : '未選択';
  $('pause-record').hidden=!['recording','paused'].includes(s.phase);$('pause-record').textContent=s.phase==='paused' ? '再開' : '一時停止';
  $('stop-record').hidden=!['recording','paused'].includes(s.phase);
  $('audio-decision').hidden=!awaiting;
  $('save-record').hidden=!s.resultReady || s.resultSaved || busy;
  $('discard-record').hidden=!s.resultReady || busy;
  const seconds=Math.floor((s.elapsed||0)/1000);$('record-time').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;$('record-size').textContent=formatBytes(s.bytes);
  const showCaptureDetails=Boolean(s.method) && !['starting','awaiting-audio-decision'].includes(s.phase);
  $('record-metrics').hidden=!showCaptureDetails;
  $('record-description').hidden=!showCaptureDetails;
  $('record-description').textContent=s.method ? `${s.method==='tab' ? '元のタブ' : 'Chromeで選んだ共有対象'} · ${s.target || state.title} · WebM · ${s.audio ? '音声あり' : '音声なし'}${busy ? ' · この作業タブを閉じないでください' : ''}` : '';
  if($('record-message').textContent!==s.message) $('record-message').textContent=s.message || '';
  $('record-message').hidden=!s.message || s.message===initialRecorderMessage;
  if(recorder && $('preview').srcObject!==recorder.stream) $('preview').srcObject=recorder.stream || null;
  const live=['recording','paused','awaiting-audio-decision'].includes(s.phase) && Boolean(recorder?.stream);
  $('preview').hidden=!live;$('preview-placeholder').hidden=live;$('live-badge').hidden=!live;
  $('live-label').textContent=awaiting ? '共有中 · 録画未開始' : s.phase==='paused' ? '一時停止中' : '録画中';
  const stage={idle:['screen','録画の準備',targetHint],starting:['refresh','共有する対象を確認','Chromeの案内に従ってください。'],finalizing:['refresh','保存を確定中','この作業タブを閉じないでください。'],saving:['refresh','ファイルを保存中','保存先を確認してください。'],ready:['download','録画できました','ファイルへ保存して完了です。'],saved:['check','保存しました','直前の録画 · WebM'],error:['info','録画・保存を確認','下のメッセージを確認してください。']}[s.phase];
  if(stage) {
    $('stage-icon').querySelector('use').setAttribute('href',`icons.svg#${stage[0]}`);
    $('stage-title').textContent=stage[1];$('stage-hint').textContent=stage[2];
  }
  if(phaseChanged && focused && (focused.closest('[hidden]') || focused.disabled)) $('record-state').focus({preventScroll:true});
  if(phaseChanged && awaiting) $('record-state').focus({preventScroll:true});
  // A cancelled/failed start returns to a usable setting without stealing timer focus.
  if(previousRecordingPhase==='starting' && !busy && document.activeElement===$('record-state') && !$('start-record').disabled) $('start-record').focus({preventScroll:true});
  previousRecordingPhase=s.phase;
  updateSummary();
}
$('source').addEventListener('click',()=>send('source').catch(error));$('scan').addEventListener('click',scan);
$('retry').addEventListener('click',()=>jobAction('retry'));$('cancel').addEventListener('click',()=>jobAction('cancel'));
$('media-cancel').addEventListener('click',()=>mediaSaver.cancel());
if(KIND === 'images') {
  for(const id of ['query','width','height','type']) $(id).addEventListener('input',()=>{if(state)renderImages();});
  $('select-visible').addEventListener('click',()=>{for(const i of visible)selected.add(i.url);renderImages();});
  $('clear').addEventListener('click',()=>{selected.clear();renderImages();});
  $('save').addEventListener('click',()=>saveURLs([...selected]));
}
try {
  state=await send('hello');$('source-title').textContent=state.title;
  try{$('source-domain').textContent=new URL(state.url).hostname;}catch{}
  if(KIND==='videos')setupRecording();
  render();
  if(!state.scanned)await scan();else{$('message').textContent='前回の取得結果を表示しています。再スキャンで追加できます。';applyState(await send('get'));}
  setInterval(async()=> {
    if(pollRunning || loading || requestPending || !state) return;
    pollRunning=true;
    try{if(summarizeJobs(state.jobs).active)applyState(await send('get'));}catch(e){error(e);}finally{pollRunning=false;}
  },1000);
} catch(e){error(e);$('message').textContent='元ページで拡張アイコンを押し直してください。';$('scan').disabled=true;}
