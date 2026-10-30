import { fileLabel, extensionOf, matchesImage, summarizeJobs, formatBytes, publicError } from './utils.js';
import { RecorderController } from './recorder.js';
const KIND = 'videos';
const $ = id => document.getElementById(id);
const sessionId = new URL(location.href).searchParams.get('id');
const instance = crypto.randomUUID();
let state, selected = new Set(), visible = [], loading = false, requestPending = false, pollRunning = false;
let recorder = null;
const handledCompletions = new Set();
async function send(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({type, sessionId, instance, ...extra});
  if (!response?.ok) throw new Error(response?.error || '拡張の接続が切れました。作業タブを開き直してください。');
  return response.data;
}
function error(error) { $('error').textContent=publicError(error); $('error').hidden=false; }
function clearError() { $('error').hidden=true; }
function element(tag, cls, text) { const e = document.createElement(tag); if(cls)e.className=cls; if(text !== undefined)e.textContent=text; return e; }
function isBusy() { return loading || requestPending || (state && summarizeJobs(state.jobs).active > 0); }
function jobFor(url) { return state.jobs.find(job=>job.url===url) || state.history?.find(job=>job.url===url); }
function jobLabel(job) {
  if (!job) return '';
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
  const batch=summarizeJobs(state.jobs), busy=isBusy();
  $('scan').disabled=busy || Boolean(recorder?.busy);
  $('batch').textContent=batch.total ? `今回 ${batch.total}件中 ${batch.complete}件保存完了 · ${batch.interrupted}件中断${batch.active ? ` · ${batch.active}件処理中` : ''}` : '';
  $('cancel').hidden=!batch.active;
  $('retry').hidden=!batch.interrupted || batch.active > 0;
  $('retry').disabled=requestPending;
  if(KIND === 'images') {
    const visibleURLs=new Set(visible.map(i=>i.url));
    const hidden=[...selected].filter(url=>!visibleURLs.has(url)).length;
    $('selection').textContent=`選択${selected.size}件${hidden ? ` · 非表示${hidden}件を含む` : ''}`;
    $('save').textContent=`選択${selected.size}件を保存`;
    $('save').disabled=!selected.size || busy;
    $('select-visible').disabled=busy || !visible.length;
    $('clear').disabled=busy || !selected.size;
    for(const el of document.querySelectorAll('.image-select')) el.disabled=busy;
  } else for(const el of document.querySelectorAll('.direct-save')) el.disabled=busy;
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
  if(view !== 'record' && recorder?.busy) { error(new Error('録画・保存中はこの画面で停止と状態を確認してください。')); return; }
  const record=view === 'record';
  $('download-view').hidden=record;$('record-view').hidden=!record;
  $('download-tab').setAttribute('aria-selected',String(!record));$('record-tab').setAttribute('aria-selected',String(record));
  $('download-tab').tabIndex=record ? -1 : 0;$('record-tab').tabIndex=record ? 0 : -1;
  if(focus) $(record ? 'record-heading' : 'download-heading').focus();
}
function renderVideos() {
  const direct=state.items.filter(i=>i.type === 'direct'), other=state.items.filter(i=>i.type !== 'direct');
  $('count').textContent=`直接保存 ${direct.length}件 · その他 ${other.length}件`;
  $('direct-list').replaceChildren();$('unsupported-list').replaceChildren();
  for(const item of [...direct,...other]) {
    const card=element('article','video-card'), info=element('div','video-info');
    info.append(element('span','tag',item.type==='direct' ? '元のファイル' : '直接保存に未対応'),element('h3','file-name',fileLabel(item.url)));
    let host='ページ内データ';try{host=new URL(item.url).hostname || host;}catch{}
    info.append(element('p','meta',`${host} · ${item.width && item.height ? `${item.width} × ${item.height} · ` : ''}${item.type==='direct' ? extensionOf(item.url,'videos').toUpperCase() : item.type.toUpperCase()}`), statusElement(item));
    const details=element('details','url-detail'), summary=element('summary','','取得元の詳細');
    details.append(summary,element('p','meta',item.url.length>500 ? item.url.slice(0,500)+'…' : item.url));info.append(details);
    const button=element('button',item.type==='direct' ? 'primary direct-save' : 'secondary',item.type==='direct' ? 'ファイルを保存' : '録画の設定へ');
    button.addEventListener('click',()=>item.type==='direct' ? saveURLs([item.url]) : showView('record'));
    card.append(info,button);$(item.type==='direct' ? 'direct-list' : 'unsupported-list').append(card);
  }
  $('empty').hidden=direct.length>0;$('unsupported').hidden=!other.length;$('unsupported-count').textContent=`(${other.length}件)`;updateSummary();
}
async function scan() {
  if(isBusy() || recorder?.busy) return;
  loading=true;clearError();updateSummary();$('message').textContent='ページから候補を探しています…';
  try { applyState(await send('scan'));render();$('message').textContent=`${state.items.length}件の候補を取得しました。保存前に対象を確認してください。`; }
  catch(e){error(e);$('message').textContent='取得できませんでした。元ページからやり直せます。';}
  finally {loading=false;updateSummary();}
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
  if(requestPending) return;requestPending=true;clearError();updateSummary();
  try{applyState(await send(type));}catch(e){error(e);}finally{requestPending=false;updateSummary();}
}
function setupRecording() {
  recorder = new RecorderController({source:state,onUpdate:updateRecording,acquire:async mode=>{try{return await send('capture',{mode});}catch(e){e.name='CaptureControlError';throw e;}},release:()=>send('release')});
  $('download-tab').addEventListener('click',()=>showView('download'));$('record-tab').addEventListener('click',()=>showView('record'));
  for(const id of ['download-tab','record-tab']) $(id).addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();showView(id==='download-tab'?'record':'download');}});
  $('try-record').addEventListener('click',()=>showView('record'));
  $('record-output').addEventListener('change',()=>{$('file-choice').hidden=$('record-output').value !== 'file';});
  $('choose-file').addEventListener('click',()=>recorder.chooseFile().catch(error));
  $('start-record').addEventListener('click',()=> {
    clearError();
    // start() must reach getDisplayMedia before yielding user activation.
    recorder.start($('record-mode').value,$('record-audio').checked,$('record-output').value).catch(error);
  });
  $('pause-record').addEventListener('click',()=>{try{recorder.snapshot().phase==='paused' ? recorder.resume() : recorder.pause();}catch(e){error(e);}});
  $('stop-record').addEventListener('click',()=>recorder.stop().catch(error));
  $('save-record').addEventListener('click',()=>recorder.save().catch(error));
  $('discard-record').addEventListener('click',()=>{if(confirm('この作業タブ内の録画データを破棄しますか？保存済みのファイルは残ります。')) recorder.discard();});
  chrome.tabs.onRemoved.addListener(tabId=>{if(tabId===state.tabId && recorder.snapshot().method==='tab' && recorder.busy) recorder.stop().catch(error);});
  window.addEventListener('beforeunload',e=>{const s=recorder.snapshot();if(recorder.busy || (s.resultReady && !s.resultSaved)){e.preventDefault();e.returnValue='';}});
  updateRecording(recorder.snapshot());
}
function updateRecording(s) {
  const phases={idle:'待機中',starting:'録画を準備中',recording:'録画中',paused:'一時停止中',finalizing:'保存を確定中',ready:'録画できました · 保存してください',saving:'ファイルを保存中',saved:'ファイル保存完了',error:'録画・保存に問題が起きました'};
  const busy=['starting','recording','paused','finalizing','saving'].includes(s.phase);
  document.body.classList.toggle('recording-active',['starting','recording','paused','finalizing'].includes(s.phase));
  $('record-state').textContent=phases[s.phase] || s.phase;$('record-state').dataset.state=s.phase;
  $('download-tab').disabled=busy;
  $('record-options').disabled=busy;$('start-record').disabled=busy || (s.resultReady && !s.resultSaved);
  $('choose-file').disabled=busy;
  const diskOption=$('record-output').querySelector('option[value="file"]');diskOption.disabled=!s.diskAvailable;
  $('chosen-file').textContent=s.diskChosen ? `選択済み: ${s.chosenFileName || s.fileName}` : '未選択';
  $('pause-record').hidden=!['recording','paused'].includes(s.phase);$('pause-record').textContent=s.phase==='paused' ? '再開' : '一時停止';
  $('stop-record').hidden=!['recording','paused'].includes(s.phase);
  $('save-record').hidden=!s.resultReady || s.resultSaved || busy;
  $('discard-record').hidden=!s.resultReady || busy;
  const seconds=Math.floor((s.elapsed||0)/1000);$('record-metrics').textContent=`${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')} · ${formatBytes(s.bytes)}`;
  $('record-description').textContent=s.method ? `${s.method==='tab' ? '元のタブ' : 'Chromeで選んだ共有対象'} · ${s.target || state.title} · WebM · ${s.audio ? '音声あり' : '音声なし'}${busy ? ' · この作業タブを開いたままにしてください' : ''}` : '録画の設定を確認して開始してください。';
  if($('record-message').textContent!==s.message) $('record-message').textContent=s.message || '';
  if(recorder && $('preview').srcObject!==recorder.stream) $('preview').srcObject=recorder.stream || null;
  updateSummary();
}
$('source').addEventListener('click',()=>send('source').catch(error));$('scan').addEventListener('click',scan);
$('retry').addEventListener('click',()=>jobAction('retry'));$('cancel').addEventListener('click',()=>jobAction('cancel'));
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
