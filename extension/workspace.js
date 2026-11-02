import { fileLabel, extensionOf, matchesImage, summarizeJobs, formatBytes, publicError } from './utils.js';
import { RecorderController } from './recorder.js';
import { MediaSaver, originPattern } from './media-save.js';
import { outputOptions, validateOutputFormat } from './output-format.js';
import { renderVideoGroups } from './workspace-videos.js';
import { RecordingResultView } from './workspace-result.js';
import { prepareVideoCapture, inspectVideoCapture, activateVideoCapture } from './video-capture.js';
import { groupVideos } from './video-view.js';
import {resources,candidateLabel,videoReferences,referenceKey,videoReferenceId,displayText,videoGroupLabels} from './presentation.js';
const KIND = 'videos';
const $ = id => document.getElementById(id);
const sessionId = new URL(location.href).searchParams.get('id');
const instance = crypto.randomUUID();
let state, selected = new Set(), visible = [], loading = false, requestPending = false, pollRunning = false;
let recorder = null;
let recordingResultView = null;
let initialRecorderMessage = '', previousRecordingPhase = '';
const handledCompletions = new Set();
const formatSelections=new Map();
let recordingChoices=[];
const videoKey = videoReferenceId;
const elementURL = node => resources.key(node.dataset.candidateId);
const selectedVideo = () => recordingChoices.find(group => videoKey(group.source) === $('record-video').value)?.source;
function updateVideoChoices() {
  // An active recording owns its exact reference; a redraw must not replace it.
  if(recorder?.busy)return;
  const select=$('record-video'), current=select.value;
  videoReferences.retain((state.videoElements || []).map(referenceKey));
  recordingChoices=videoGroupLabels(groupVideos(state.items,state.videoElements || [])).filter(group=>group.recordable);
  const refs=recordingChoices.map(group=>group.source), options=[['','動画を選んでください'],...recordingChoices.map(group=>[videoKey(group.source),`${group.label}${group.source.playing ? ' · 再生中' : ''}`])];
  if(JSON.stringify([...select.options].map(option=>[option.value,option.textContent]))!==JSON.stringify(options)) {
    select.replaceChildren(...options.map(([value,text])=>{const option=element('option','',text);option.value=value;return option;}));
    select.value=refs.some(ref=>videoKey(ref)===current) ? current : '';
  }
  if(recorder)updateRecording(recorder.snapshot());
}
function selectVideoForRecording(reference) {
  if(recorder?.busy || isBusy())return;
  updateVideoChoices();
  if(reference) {
    const key=videoKey(reference);
    if(!recordingChoices.some(group=>videoKey(group.source)===key)) {error(new Error('動画が見つかりません。元ページを確認して再スキャンしてください。'));return;}
    $('record-video').value=key;
    document.querySelector('[name="record-mode"][value="video"]').checked=true;
  }
  showView('record');
  updateRecording(recorder.snapshot());
}
const mediaSaver=new MediaSaver({onUpdate:updateMediaUI,readBlob:(url,offset,token)=>send('blob-read',{url,offset,token})});
window.addEventListener('pagehide',()=>mediaSaver.dispose());
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
  const format=/\.([a-z0-9]{2,5})$/i.exec(job.filename || '')?.[1].toUpperCase(),suffix=format ? ` · ${format}` : '';
  if (job.status === 'complete') return `保存完了${suffix}`;
  if (job.status === 'interrupted') return `中断${suffix} · ${job.error || '再試行できます'}`;
  if (job.status === 'queued') return `順番待ち${suffix}`;
  return `保存中${suffix} · ${formatBytes(job.bytesReceived)}${job.totalBytes > 0 ? ' / '+formatBytes(job.totalBytes) : ''}`;
}
function statusElement(item) { const span = element('span','item-status',jobLabel(jobFor(item.url))); span.dataset.candidateId=resources.id(item.url);span.dataset.state=jobFor(item.url)?.status || '';  return span; }
function applyState(next) {
  state = next;
  for(const job of state.jobs) {
    const key=`${job.downloadId}:${job.url}`;
    if(job.status === 'complete' && !handledCompletions.has(key)) { selected.delete(job.url); handledCompletions.add(key); }
  }
  updateSummary();
  for(const el of document.querySelectorAll('.item-status')) { const job=jobFor(elementURL(el));el.textContent=jobLabel(job);el.dataset.state=job?.status || ''; }
  for(const checkbox of document.querySelectorAll('.image-select')) checkbox.checked=selected.has(elementURL(checkbox));
  updateOutputResults();
}
function updateSummary() {
  if(!state) return;
  const batch=summarizeJobs(state.jobs), busy=isBusy() || Boolean(recorder?.busy);
  $('scan').disabled=busy || Boolean(recorder?.busy);
  document.body.classList.toggle('scanning',loading);
  $('empty-scan').disabled=busy || Boolean(recorder?.busy);
  $('download-footer').hidden=!batch.active && !batch.interrupted;
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
  } else for(const el of document.querySelectorAll('.direct-save,.media-save,.frame-permission,.output-format,.record-video-button')) el.disabled=busy;
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
    const job=jobFor(elementURL(el));el.textContent=jobLabel(job);el.dataset.state=job?.status || '';
  }
  for(const el of document.querySelectorAll('.media-save')) {
    const url=elementURL(el),job=mediaSaver.status(url);
    const text=job?.status==='permission' ? '配信元を許可して保存' : job?.blob ? 'ファイル保存を再試行' : '保存';
    const iconName=job?.status==='permission' ? 'external' : job?.blob ? 'refresh' : 'download';
    el.replaceChildren(icon(iconName),document.createTextNode(text));
    el.setAttribute('aria-label',`${el.dataset.displayName || candidateLabel(url)} · ${candidateLabel(url)}${job?.status==='permission' ? 'の配信元を許可して保存' : 'を保存'}`);
  }
  for(const el of document.querySelectorAll('.permission-sites')) {
    const origins=mediaSaver.status(elementURL(el))?.origins;
    el.hidden=!origins?.length;el.textContent=origins?.length ? `アクセスを求めるサイト: ${origins.join('、')}` : '';
  }
  updateOutputResults();
}
function outputFolderButton(id) {
  const button=element('button','secondary show-file');button.dataset.downloadId=String(id);
  button.append(icon('folder'),document.createTextNode('保存場所を表示'));
  let pending=false;
  button.addEventListener('click',async()=>{
    if(pending)return;pending=true;button.setAttribute('aria-busy','true');
    try{await send('show-download',{downloadId:id});}catch(e){error(e);}
    finally{pending=false;button.removeAttribute('aria-busy');}
  });
  return button;
}
function outputName(job) {
  const value=job.actualFilename || (job.extension ? job.filename : '');
  return value ? String(value).split(/[\\/]/).at(-1) : '';
}
function updateOutputResults() {
  if(!state)return;
  for(const container of document.querySelectorAll('.candidate-result')) {
    const job=jobFor(elementURL(container)),key=job?.status==='complete' ? `${job.downloadId}:${outputName(job)}:${job.exists}` : '';
    if(container.dataset.resultKey===key)continue;
    container.dataset.resultKey=key;container.replaceChildren();
    if(key) {
      if(Number.isSafeInteger(job.downloadId))container.append(outputFolderButton(job.downloadId));
      if(job.exists===false || job.resultUnavailable)container.append(element('span','hint','保存先で見つからない可能性があります。'));
    }
  }
  for(const button of document.querySelectorAll('.direct-save,.media-save')) {
    const url=elementURL(button),saved=jobFor(url)?.status==='complete';
    button.classList.toggle('primary',!saved);button.classList.toggle('secondary',saved);
    if(saved){
      button.replaceChildren(icon('refresh'),document.createTextNode('もう一度保存'));
      button.setAttribute('aria-label',`${button.dataset.displayName || candidateLabel(url)}をもう一度保存`);
    }
  }
  const completed=[...(state.history || []),...state.jobs,...mediaSaver.results.values()].filter(job=>job.status==='complete' && Number.isSafeInteger(job.downloadId));
  const records=[...new Map(completed.map(job=>[job.downloadId,job])).values()].slice(-50).reverse();
  $('saved-files').hidden=!records.length;
  const key=records.map(job=>`${job.downloadId}:${outputName(job)}:${job.exists}`).join('|');
  if($('saved-file-list').dataset.resultKey===key)return;
  const focused=document.activeElement?.closest('#saved-file-list .show-file')?.dataset.downloadId;
  $('saved-file-list').dataset.resultKey=key;$('saved-file-list').replaceChildren();
  for(const job of records) {
    const row=element('li','saved-output');row.append(element('span','',outputName(job) || '保存完了のファイル'),outputFolderButton(job.downloadId));$('saved-file-list').append(row);
  }
  if(focused)for(const button of $('saved-file-list').querySelectorAll('.show-file'))if(button.dataset.downloadId===focused)button.focus({preventScroll:true});
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
    const input=element('input','image-select'); input.type='checkbox';input.dataset.candidateId=resources.id(item.url); input.checked=selected.has(item.url);
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
  if(!record)recordingResultView?.pausePlayback();
  $('download-view').hidden=record;$('record-view').hidden=!record;
  $('download-tab').setAttribute('aria-selected',String(!record));$('record-tab').setAttribute('aria-selected',String(record));
  $('download-tab').tabIndex=record ? -1 : 0;$('record-tab').tabIndex=record ? 0 : -1;
  if(focus) $(record ? 'record-heading' : 'download-heading').focus();
}
function renderVideos() {
  const retained=new Set([...state.items,...(state.previousItems || []),...(state.jobs || []),...(state.history || [])].map(item=>item.url));
  resources.retain([...retained,...mediaSaver.results.keys()]);
  for(const url of formatSelections.keys())if(!retained.has(url))formatSelections.delete(url);
  renderVideoGroups({state,element,icon,statusElement,formatOptions:outputOptions,
    formatValue:(item,options)=>{
      const knownBlobMP4=/^video\/(?:mp4|x-m4v)(?:;|$)/i.test(item.mime || '');
      const preferred=options.some(option=>option.value==='mp4' && !option.disabled) && (item.type!=='blob' || knownBlobMP4) ? 'mp4' : 'auto';
      const previous=formatSelections.get(item.url);
      const value=options.some(option=>option.value===previous && !option.disabled) ? previous : preferred;
      formatSelections.set(item.url,value);return value;
    },
    onFormatChange:(item,select)=>{
      if(isBusy() || recorder?.busy){select.value=formatSelections.get(item.url);return;}
      formatSelections.set(item.url,select.value);
      for(const other of document.querySelectorAll('.output-format'))if(elementURL(other)===item.url)other.value=select.value;
    },
    onSave:item=>{
      if(isBusy() || recorder?.busy)return;
      try {
        const outputFormat=validateOutputFormat(item,formatSelections.get(item.url) || 'auto');
        if(item.type==='direct')return saveURLs([item.url],outputFormat);
        void mediaSaver.start(item,state.title,outputFormat).catch(error);
      } catch(e){error(e);}
    },
    onRecord:selectVideoForRecording,
    onLocate:(item,occurrence)=>{
      if((state.videoElements || []).some(ref=>videoKey(ref)===videoKey(occurrence)))return send('locate-video',{reference:occurrence}).catch(error);
      if(item)return send('locate-source',{url:item.url,occurrenceId:occurrence.id}).catch(error);
    },
    onLocateFrame:frame=>send('locate-frame',{elementToken:frame.elementToken,frameToken:frame.frameToken}).catch(error),
    onFramePermission:(origin,button)=>{
      let permission,restorePermissionFocus=false;
      try {permission=chrome.permissions.request({origins:[origin]});}catch(e){error(e);return;}
      requestPending=true;updateSummary();
      Promise.resolve(permission).then(async granted=>{
        if(!granted)throw new Error('埋め込みサイトへのアクセスは許可されませんでした。もう一度試せます。');
        requestPending=false;
        const scanned=await scan();
        if(scanned)$('download-heading').focus();
        else if(button.isConnected)button.focus();
      }).catch(e=>{error(e);restorePermissionFocus=true;}).finally(()=>{
        requestPending=false;updateSummary();
        if(restorePermissionFocus && button.isConnected)button.focus();
      });
    },
  });
  updateMediaUI();
}
async function scan() {
  if(isBusy() || recorder?.busy) return;
  const fromEmpty=document.activeElement===$('empty-scan');
  loading=true;clearError();updateSummary();$('message').textContent='ページから候補を探しています…';
  try { applyState(await send('scan'));render();$('message').textContent='';return true; }
  catch(e){error(e);$('message').textContent='取得できませんでした。元ページからやり直せます。';return false;}
  finally {
    loading=false;updateSummary();
    if(fromEmpty && (document.activeElement===document.body || document.activeElement===$('empty-scan'))) $($('empty').hidden ? 'download-heading' : 'empty-scan').focus({preventScroll:true});
  }
}
function render() {
  $('notices').textContent=displayText(state.notices.join(' '));$('notices').hidden=!state.notices.length;
  KIND === 'images' ? renderImages() : renderVideos();
  if(KIND==='videos')updateVideoChoices();
}
async function saveURLs(urls,outputFormat='auto') {
  if(isBusy()) return;
  requestPending=true;clearError();updateSummary();
  try{applyState(await send('save',{urls,outputFormat}));}catch(e){error(e);}finally{requestPending=false;updateSummary();}
}
async function jobAction(type) {
  if(requestPending || mediaSaver.busy || recorder?.busy) return;requestPending=true;clearError();updateSummary();
  try{applyState(await send(type));}catch(e){error(e);}finally{requestPending=false;updateSummary();}
}
function setupRecording() {
  recorder = new RecorderController({source:state,onUpdate:updateRecording,acquire:async mode=>{try{return await send('capture',{mode});}catch(e){e.name='CaptureControlError';throw e;}},release:()=>send('release'),activateVideo:options=>activateVideoCapture({tabId:state.tabId,...options}),inspectVideo:async options=>{try{return await inspectVideoCapture({send,...options});}catch(e){e.name='CaptureControlError';throw e;}},prepareVideo:async options=>{try{return await prepareVideoCapture({send,...options});}catch(e){e.name='CaptureControlError';throw e;}}});
  recordingResultView=new RecordingResultView({controller:recorder,showDownload:downloadId=>send('show-download',{downloadId})});
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
  $('record-video').addEventListener('change',()=>updateRecording(recorder.snapshot()));
  $('locate-record-video').addEventListener('click',()=>{const reference=selectedVideo();if(reference)send('locate-video',{reference}).catch(error);});
  window.addEventListener('pagehide',()=>{void recorder.stop().catch(()=>{});});
  $('choose-file').addEventListener('click',()=>recorder.chooseFile().catch(error));
  $('start-record').addEventListener('click',()=> {
    if(mediaSaver.busy)return;
    clearError();
    // start() must reach getDisplayMedia before yielding user activation.
    recorder.start(document.querySelector('[name="record-mode"]:checked').value,$('record-audio').checked,$('record-output').value,selectedVideo()).catch(error);
  });
  $('pause-record').addEventListener('click',()=>{Promise.resolve(recorder.snapshot().phase==='paused' ? recorder.resume() : recorder.pause()).catch(error);});
  $('stop-record').addEventListener('click',()=>recorder.stop().catch(error));
  $('continue-from-position').addEventListener('click',()=>recorder.continueFromPosition());
  $('continue-without-audio').addEventListener('click',()=>recorder.continueWithoutAudio());
  for(const id of ['reselect-capture','cancel-record-start','cancel-position-start']) $(id).addEventListener('click',async()=>{
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
  const phases={idle:'待機中',starting:'録画を準備中','awaiting-position-decision':'再生位置を確認してください · 録画未開始','awaiting-audio-decision':'音声を確認してください · 録画未開始',recording:'録画中',paused:'一時停止中',finalizing:'保存を確定中',ready:'録画できました · 保存してください',saving:'ファイルを保存中',saved:'ファイル保存完了',error:'録画・保存に問題が起きました'};
  const awaiting=s.phase==='awaiting-audio-decision',positionDecision=s.phase==='awaiting-position-decision';
  const busy=['starting','awaiting-position-decision','awaiting-audio-decision','recording','paused','finalizing','saving'].includes(s.phase);
  const focused=document.activeElement, phaseChanged=previousRecordingPhase!==s.phase;
  const mode=document.querySelector('[name="record-mode"]:checked').value, disk=$('record-output').value==='file';
  const reference=selectedVideo();
  let targetHint=mode==='video' ? (reference ? '録画開始に合わせて元動画を再生します。選んだ動画の映像と音声だけを録画します。' : '元ページの動画を再スキャンし、録画する動画を選んでください。') : mode==='tab' ? '元のタブ全体を録画します。タブ内の他の音も含まれます。' : '開始後に共有する対象を選びます。別のタブも選べます。';
  if(s.recorderAvailable===false && s.phase==='idle') {
    targetHint='この環境ではブラウザ内録画が制限されています。iOS/Androidの標準画面収録をご利用いただくか、「動画を保存」をお試しください。';
  }
  $('video-choice').hidden=mode!=='video';
  $('locate-record-video').disabled=busy || !reference;
  const thumbnail=$('record-video-image');
  const preview=reference?.previewDataURL || '';
  thumbnail.hidden=!/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(preview) || preview.length>32768;
  if(!thumbnail.hidden)thumbnail.src=preview;else thumbnail.removeAttribute('src');
  document.body.classList.toggle('recording-active',busy || (s.resultReady && !s.resultSaved));
  document.body.classList.toggle('recording-result',s.resultReady && !s.resultSaved);
  document.body.classList.toggle('has-recording-result',s.resultReady);
  const layout=$('record-layout'),recordStage=$('record-stage'),settings=$('record-settings');
  let layoutMoved=false;
  if(s.resultReady && layout.firstElementChild!==recordStage){layout.insertBefore(recordStage,settings);layoutMoved=true;}
  else if(!s.resultReady && layout.firstElementChild!==settings){layout.insertBefore(settings,recordStage);layoutMoved=true;}
  $('record-settings').hidden=busy || (s.resultReady && !s.resultSaved);
  document.body.classList.toggle('recording-error',s.phase==='error');
  $('record-panel').hidden=s.phase==='idle' && s.message===initialRecorderMessage;
  $('record-panel').dataset.state=s.phase;
  $('preview-stage').dataset.phase=s.phase;
  $('record-state').textContent=phases[s.phase] || s.phase;$('record-state').dataset.state=s.phase;
  $('download-tab').disabled=busy;
  $('record-options').disabled=busy;$('start-record').disabled=busy || (s.resultReady && !s.resultSaved) || (disk && !s.diskChosen) || (mode==='video' && !reference);
  $('choose-file').disabled=busy;
  const diskOption=$('record-output').querySelector('option[value="file"]');diskOption.disabled=!s.diskAvailable;
  $('file-choice').hidden=!disk;
  $('output-summary').textContent=disk ? 'ファイルへ順次保存' : '停止後に保存';
  $('record-limit').textContent=disk ? '最大30分 · ファイルへ順次保存' : '最大30分 · 約256 MiBで自動停止';
  $('target-hint').textContent=targetHint;
  $('chosen-file').textContent=s.diskChosen ? `選択済み: ${s.chosenFileName || s.fileName}` : '未選択';
  $('pause-record').disabled=Boolean(s.controlPending);
  $('pause-record').hidden=!['recording','paused'].includes(s.phase);$('pause-record').textContent=s.phase==='paused' ? '再開' : '一時停止';
  $('stop-record').hidden=!['recording','paused'].includes(s.phase);
  $('audio-decision').hidden=!awaiting;
  $('position-decision').hidden=!positionDecision;
  const sourceCentiseconds=Math.floor(Math.max(0,s.sourcePosition || 0)*100),minutes=Math.floor(sourceCentiseconds/6000);
  $('source-position').textContent=`元動画の再生位置: ${minutes}:${((sourceCentiseconds%6000)/100).toFixed(2).padStart(5,'0')}`;
  $('continue-from-position').textContent=s.sourceEnded ? '先頭から録画' : 'この位置から録画';
  $('save-record').hidden=!s.resultReady || s.resultSaved || busy;
  $('discard-record').hidden=!s.resultReady || busy;
  const seconds=Math.floor((s.elapsed||0)/1000);$('record-time').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;$('record-size').textContent=formatBytes(s.bytes);
  const showCaptureDetails=Boolean(s.method) && !['starting','awaiting-position-decision','awaiting-audio-decision'].includes(s.phase);
  $('record-metrics').hidden=!showCaptureDetails;
  $('record-description').hidden=!showCaptureDetails;
  $('record-description').textContent=s.method ? `${s.method==='video' ? '選んだ動画のみ' : s.method==='tab' ? '元のタブ全体' : 'Chromeで選んだ共有対象'} · ${displayText(s.target || state.title)} · WebM · ${s.audio ? '音声あり' : '音声なし'}${busy ? ' · この作業タブを閉じないでください' : ''}` : '';
  if($('record-message').textContent!==s.message) $('record-message').textContent=s.message || '';
  $('record-message').hidden=!s.message || s.message===initialRecorderMessage;
  if(recorder && $('preview').srcObject!==recorder.stream) $('preview').srcObject=recorder.stream || null;
  const live=['recording','paused','awaiting-audio-decision'].includes(s.phase) && Boolean(recorder?.stream);
  $('preview').hidden=!live;$('preview-placeholder').hidden=live;$('live-badge').hidden=!(live || (s.method==='video' && ['recording','paused'].includes(s.phase)));
  $('live-label').textContent=awaiting ? '共有中 · 録画未開始' : s.phase==='paused' ? '一時停止中' : '録画中';
  const videoStage=s.method==='video' && ['starting','awaiting-position-decision','awaiting-audio-decision','recording','paused'].includes(s.phase) ? ['play',s.phase==='starting' ? '選んだ動画を確認中' : (awaiting || positionDecision) ? '録画はまだ始まっていません' : s.phase==='paused' ? '動画の録画を一時停止中' : '選んだ動画を録画中',`${s.target || reference?.title || '選んだ動画'} · 結果は停止後に確認できます。`] : null;
  const stage=videoStage || {idle:['screen','録画の準備',targetHint],starting:['refresh','共有する対象を確認','Chromeの案内に従ってください。'],finalizing:['refresh','保存を確定中','この作業タブを閉じないでください。'],saving:['refresh','ファイルを保存中','保存先を確認してください。'],ready:['download','録画できました','ファイルへ保存して完了です。'],saved:['check','保存しました','直前の録画 · WebM'],error:['info','録画・保存を確認','下のメッセージを確認してください。']}[s.phase];
  if(stage) {
    $('stage-icon').querySelector('use').setAttribute('href',`icons.svg#${stage[0]}`);
    $('stage-title').textContent=displayText(stage[1]);$('stage-hint').textContent=displayText(stage[2]);
  }
  recordingResultView?.update(s);
  if(layoutMoved && focused?.isConnected && !focused.closest('[hidden]') && !focused.disabled)focused.focus({preventScroll:true});
  if(phaseChanged && focused && (focused.closest('[hidden]') || focused.disabled)) $('record-state').focus({preventScroll:true});
  if(phaseChanged && (awaiting || positionDecision)) $('record-state').focus({preventScroll:true});
  // A cancelled/failed start returns to a usable setting without stealing timer focus.
  if(previousRecordingPhase==='starting' && !busy && document.activeElement===$('record-state') && !$('start-record').disabled) $('start-record').focus({preventScroll:true});
  previousRecordingPhase=s.phase;
  updateSummary();
}
$('scan').addEventListener('click',scan);
$('retry').addEventListener('click',()=>jobAction('retry'));$('cancel').addEventListener('click',()=>jobAction('cancel'));
$('media-cancel').addEventListener('click',()=>mediaSaver.cancel());
if(KIND === 'images') {
  for(const id of ['query','width','height','type']) $(id).addEventListener('input',()=>{if(state)renderImages();});
  $('select-visible').addEventListener('click',()=>{for(const i of visible)selected.add(i.url);renderImages();});
  $('clear').addEventListener('click',()=>{selected.clear();renderImages();});
  $('save').addEventListener('click',()=>saveURLs([...selected]));
}
try {
  state=await send('hello');$('source-title').textContent=displayText(state.title);
  try{$('source-domain').textContent=new URL(state.url).hostname;}catch{}
  if(KIND==='videos')setupRecording();
  render();
  if(!state.scanned)await scan();else{$('message').textContent='前回の取得結果を表示しています。再スキャンで現在のページを確認できます。';applyState(await send('get'));}
  setInterval(async()=> {
    if(pollRunning || loading || requestPending || !state) return;
    pollRunning=true;
    try{if(summarizeJobs(state.jobs).active)applyState(await send('get'));}catch(e){error(e);}finally{pollRunning=false;}
  },1000);
} catch(e){error(e);$('message').textContent='元ページで拡張アイコンを押し直してください。';$('scan').disabled=true;}
