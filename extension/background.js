import { collect, locateSourceElement, inspectSourceDocument } from './collector.js';
import { discoverySnapshot, migrateDiscovery, DISCOVERY_VERSION } from './discovery.js';
import { readPageBlob } from './page-blob.js';
import { controlPageVideo } from './page-video-recording.js';
import { originalExtension, validateOutputFormat } from './output-format.js';
import { allowedURL, downloadName, summarizeJobs, publicError } from './utils.js';
const KIND = 'videos';
const PREFIX = 'workspace:';
const sessionStore = (typeof chrome !== 'undefined' && chrome.storage?.session)
  ? chrome.storage.session
  : ((typeof chrome !== 'undefined' && chrome.storage?.local) || {
      _data: new Map(),
      async get(key) {
        if (!key) return Object.fromEntries(this._data);
        if (typeof key === 'string') return {[key]: this._data.get(key)};
        const res = {};
        const keys = Array.isArray(key) ? key : Object.keys(key);
        for (const k of keys) if (this._data.has(k)) res[k] = this._data.get(k);
        return res;
      },
      async set(items) { for (const [k, v] of Object.entries(items)) this._data.set(k, v); },
      async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) this._data.delete(k); }
    });
let operations = Promise.resolve();
// One mutation queue protects storage read/modify/write across concurrent events.
const serial = task => { const next = operations.then(task); operations = next.catch(() => {}); return next; };
// Closing must not wait behind a pending Chrome download acceptance. Keep the
// current object so the close projection and the accepting pump share job IDs.
const knownStates = new Map();
const closedSessions = new Set();
const closedTabs = new Set();
const writes = new Map();
// After the workspace closes, only the remaining download queue has an owner.
// Preserve job identity while dropping fields: pump may still hold a job across
// an await when an accepted download is reconciled immediately after saving.
function minimizeClosed(state) {
  const jobs=(state.jobs || []).filter(job=>['queued','in_progress'].includes(job.status));
  for(const job of jobs) {
    const keep=job.status==='queued' ? ['status','url','filename','outputFormat'] : ['status','downloadId','outputFormat'];
    for(const key of Object.keys(job)) if(!keep.includes(key)) delete job[key];
  }
  const id=state.id;
  for(const key of Object.keys(state)) delete state[key];
  return Object.assign(state,{id,closed:true,jobs});
}
function remember(state) {
  // A storage read can have captured its clone before the close event. Once
  // closed, the live object (including terminal tombstones) is authoritative.
  const current=knownStates.get(state.id);
  if(current?.closed) return minimizeClosed(current);
  if(state.closed || closedSessions.has(state.id) || closedTabs.has(state.workspaceTabId)) {
    closedSessions.add(state.id);minimizeClosed(state);
  }
  knownStates.set(state.id,state);
  return state;
}
const save = state => {
  // Only storage writes are serialized here. Evaluate the projection when the
  // write runs, so an older full snapshot cannot restore a closed workspace.
  const id=state.id;
  const next=(writes.get(id) || Promise.resolve()).catch(()=>{}).then(async()=>{
    state=remember(state);
    if(state.closed) {
      if(active(state)) return sessionStore.set({[PREFIX + id]:state});
      // Keep the minimized empty object until worker suspension: a stale read
      // must not revive an already finished queue from its previous snapshot.
      return sessionStore.remove(PREFIX + id);
    }
    const latest=new Map((state.history || []).map(job=>[job.url,job]));
    for(const job of state.jobs) latest.set(job.url,{...job});
    state.history=[...latest.values()].slice(-500);
    return sessionStore.set({[PREFIX + id]:state});
  });
  writes.set(id,next);
  const clear=()=>{if(writes.get(id)===next)writes.delete(id);};
  next.then(clear,clear);
  return next;
};
const load = async id => { const state=(await sessionStore.get(PREFIX + id))[PREFIX + id]; return state ? remember(state.closed ? state : migrateDiscovery(state)) : state; };
const all = async () => Object.entries(await sessionStore.get(null)).filter(([k]) => k.startsWith(PREFIX)).map(([,v])=>remember(v));
const active = state => summarizeJobs(state.jobs).active > 0;
async function scrubClosedTab(tabId) {
  closedTabs.add(tabId);
  const closing=new Map(),pending=[];
  const close=state=>{
    closing.set(state.id,state);closedSessions.add(state.id);minimizeClosed(state);
    pending.push(save(state));
  };
  for(const state of knownStates.values()) if(state.workspaceTabId===tabId) close(state);
  // After worker restart there may be no in-memory state for this tab yet.
  const stored=await sessionStore.get(null);
  for(const [key,state] of Object.entries(stored)) if(key.startsWith(PREFIX) && state.workspaceTabId===tabId && !closing.has(state.id)) {
    close(knownStates.get(state.id) || state);
  }
  await Promise.all(pending);
  return [...closing.values()];
}
async function closeWorkspace(state) {
  state=remember(state);
  state.closed=true;
  // Persist minimization before querying Chrome or starting the next file.
  await save(state);
  if(active(state)) await pump(state);
}
async function liveTab(id) { try { return await chrome.tabs.get(id); } catch { return null; } }
async function workspaceURL(id) {
  const tab=await liveTab(id);if(!tab)return null;
  // Chrome 116 may omit even this extension's tab URL without the tabs grant.
  // Its own extension contexts provide the identity without broader permission.
  if(typeof chrome.runtime.getContexts==='function') {
    const contexts=await chrome.runtime.getContexts({contextTypes:['TAB'],tabIds:[id]});
    const documentURL=contexts.find(context=>context.frameId===0)?.documentUrl;
    if(!documentURL && tab.status==='loading')throw new Error('作業画面を読み込み中です。少し待ってから再試行してください。');
    return documentURL || null;
  }
  return tab.url || null;
}

export async function openWorkspace(tab) {
  return serial(async () => {
    const existing = await all();
    for (const state of existing) {
      const managerURL=await workspaceURL(state.workspaceTabId);
      if (managerURL !== chrome.runtime.getURL(`workspace.html?id=${state.id}`)) { await closeWorkspace(state); continue; }
      if (state.tabId === tab.id && state.url === tab.url) {
        await chrome.tabs.update(state.workspaceTabId, {active:true}); return state.id;
      }
    }
    if ((await all()).length >= 4) throw new Error('作業タブは4つまでです。使い終わった作業タブを閉じてください。');
    const id = crypto.randomUUID();
    const state = {id, tabId:tab.id, url:tab.url || '', title:(tab.title || 'ページ').slice(0,160), items:[], previousItems:[], scan:{version:DISCOVERY_VERSION,sequence:0,at:null,currentCount:0,previousCount:0,omitted:0}, jobs:[], notices:[], scanned:false};
    await save(state);
    const manager = await chrome.tabs.create({url:chrome.runtime.getURL(`workspace.html?id=${id}`), active:true});
    state.workspaceTabId = manager.id;
    await save(state);
    return id;
  });
}
chrome.action.onClicked.addListener(tab => {
  openWorkspace(tab).then(() => chrome.action.setBadgeText?.({text:''})).catch(async error => {
    console.error('VideoHarbor openWorkspace error:', error);
    await chrome.action.setBadgeText?.({text:'!'}).catch(()=>{});
    await chrome.action.setTitle?.({title:publicError(error)}).catch(()=>{});
  });
});

async function scan(state) {
  if (active(state)) throw new Error('保存処理が終わってから再スキャンしてください。');
  const tab = await liveTab(state.tabId);
  if (!tab || tab.url !== state.url) throw new Error('元ページが閉じられたか移動しました。そのページで拡張アイコンを押し直してください。');
  if (!/^https?:\/\//.test(tab.url)) throw new Error('通常のHTTP/HTTPSページで拡張アイコンを押してください。Chromeの設定・ストア等は取得できません。');
  // Chrome injects only into frames for which activeTab or a site grant permits access.
  let results;
  try { results = await chrome.scripting.executeScript({target:{tabId:state.tabId,allFrames:true},func:collect,args:[state.items.map(item=>item.url)]}); }
  catch { results = await chrome.scripting.executeScript({target:{tabId:state.tabId},func:collect,args:[state.items.map(item=>item.url)]}); }
  const collected = results.filter(r=>r.result?.items);
  if (!collected.length) throw new Error('ページの動画を取得できませんでした。元ページからやり直してください。');
  const snapshot = discoverySnapshot(state,collected);
  // Resolve all grants before replacing the snapshot. No partial result survives
  // a permission failure, navigation, or detached source tab.
  snapshot.frames = (await Promise.all(snapshot.frames.map(async frame=> {
    const url=new URL(frame.url);
    const pattern=`${url.protocol}//${url.hostname}/*`;
    return url.origin===new URL(state.url).origin || await chrome.permissions.contains({origins:[pattern]}) ? null : frame;
  }))).filter(Boolean);
  const after = await liveTab(state.tabId);
  if (!after || after.url !== state.url) throw new Error('元ページが閉じられたか移動しました。そのページで拡張アイコンを押し直してください。');
  const top = collected.find(entry=>entry.frameId===0);
  if (!top?.result?.frameToken || !top.result.documentURL) throw new Error('元ページの取得情報を確認できません。再スキャンしてください。');
  let current;
  try { [current]=await chrome.scripting.executeScript({target:{tabId:state.tabId,frameIds:[0]},func:inspectSourceDocument}); }
  catch { throw new Error('元ページが更新されました。再スキャンしてください。'); }
  if (!current?.result || current.result.frameToken !== top.result.frameToken || current.result.documentURL !== top.result.documentURL
    || (top.documentId && current.documentId !== top.documentId)) throw new Error('元ページが更新されました。再スキャンしてください。');
  Object.assign(state,snapshot);
  await save(state); return state;
}
async function refreshJob(job, closed=false) {
  if (!job.downloadId || !['in_progress','complete'].includes(job.status)) return;
  const [item] = await chrome.downloads.search({id:job.downloadId});
  if (!item) {
    if (job.status === 'complete') {job.exists=false;job.resultUnavailable=true;return;}
    job.status='interrupted'; job.error='ダウンロード履歴から見つかりません。再試行できます。'; return;
  }
  if(!closed) {
    job.bytesReceived = item.bytesReceived; job.totalBytes = item.totalBytes;
    if (typeof item.filename === 'string') job.actualFilename = item.filename;
    if (typeof item.exists === 'boolean') job.exists = item.exists;
  }
  job.status = item.state;
  if (item.error) job.error = item.error;
  if (item.state === 'complete' && /^(text\/html|application\/(json|xml))/i.test(item.mime || '')) {
    job.status='interrupted'; job.error='メディアではない応答が保存されました。サイトの認証・制限を確認してください。';
  }
  const mime=typeof item.mime==='string' ? item.mime.split(';',1)[0].trim().toLowerCase() : '';
  // Apply the selector's known-media policy to actual responses too, including
  // application/ogg. A missing or generic MIME remains unconfirmed as before.
  if(item.state==='complete' && job.outputFormat==='mp4' && (mime.startsWith('video/') || originalExtension({mime}))) {
    try {validateOutputFormat({type:'direct',mime},'mp4');}
    catch {job.status='interrupted';job.error='選択したMP4と異なる形式の応答が保存されました。保存先のファイルと配信元を確認してください。';}
  }
}
async function ownedDownload(state, id) {
  if (!Number.isSafeInteger(id) || id < 0) throw new Error('保存結果の指定が不正です。');
  const known=[...(state.jobs || []),...(state.history || [])].some(job=>job.downloadId===id);
  const [item]=await chrome.downloads.search({id});
  if (!item || (!known && item.byExtensionId !== chrome.runtime.id)) throw new Error('この拡張の保存結果を確認できません。Chromeのダウンロード履歴を確認してください。');
  return item;
}
async function locate(state, ref) {
  const tab=await liveTab(state.tabId);
  if (!tab || tab.url!==state.url || !ref?.frameToken || !ref.elementToken || !ref.documentURL) throw new Error('元ページの出典が変わりました。再スキャンしてください。');
  const target={tabId:state.tabId,...(ref.documentId ? {documentIds:[ref.documentId]} : {frameIds:[ref.frameId || 0]})};
  let results;
  try {results=await chrome.scripting.executeScript({target,func:locateSourceElement,args:[ref.frameToken,ref.elementToken,ref.documentURL]});}
  catch {throw new Error('元ページの出典が変わりました。再スキャンしてください。');}
  if (!results.some(result=>result.result?.found)) throw new Error('元ページにこの出典が見つかりません。再スキャンしてください。');
  await chrome.tabs.update(state.tabId,{active:true});
  return {found:true};
}
function videoReference(state, reference) {
  if (!reference || typeof reference.elementToken !== 'string' || typeof reference.frameToken !== 'string'
    || typeof reference.documentURL !== 'string') throw new Error('録画する動画を一覧から選んでください。');
  const match = (state.videoElements || []).find(value => value.elementToken === reference.elementToken
    && value.frameToken === reference.frameToken && value.documentURL === reference.documentURL
    && (value.documentId ? value.documentId === reference.documentId : value.frameId === reference.frameId));
  if (!match || match.elementTag !== 'VIDEO') throw new Error('選んだ動画が現在の一覧に見つかりません。再スキャンしてください。');
  return match;
}
async function videoControl(state, message) {
  if (!/^[a-f0-9-]{36}$/.test(message.token || '')
    || !['inspect','prepare','poll','start','pause','resume','stop','close'].includes(message.command)) throw new Error('動画録画の指定が不正です。');
  const ref = videoReference(state, message.reference);
  const lock = (await sessionStore.get('captureLock')).captureLock;
  if (lock?.sessionId !== state.id || lock.tabId !== state.workspaceTabId || lock.instance !== message.instance || lock.mode !== 'video') {
    throw new Error('この画面は動画の録画を所有していません。元ページから開き直してください。');
  }
  if (message.command === 'prepare') {
    if (lock.videoToken && lock.videoToken !== message.token) throw new Error('動画の録画はすでに準備されています。');
    lock.videoToken = message.token; lock.videoElementToken = ref.elementToken; lock.videoFrameToken = ref.frameToken;
    await sessionStore.set({captureLock:lock});
  } else if (message.command !== 'inspect' && (lock.videoToken !== message.token || lock.videoElementToken !== ref.elementToken || lock.videoFrameToken !== ref.frameToken)) {
    throw new Error('動画録画の接続が変わりました。元ページからやり直してください。');
  }
  const tab = await liveTab(state.tabId);
  if (!tab || tab.url !== state.url) throw new Error('元ページが閉じられたか移動しました。取得済みの動画を確認してください。');
  const target = {tabId:state.tabId,...(ref.documentId ? {documentIds:[ref.documentId]} : {frameIds:[ref.frameId || 0]})};
  const request = {command:message.command,token:message.token,reference:ref,
    audio:Boolean(message.audio),restart:Boolean(message.restart),mimeType:message.mimeType,ack:message.ack};
  let timer;
  try {
    const results = await Promise.race([
      chrome.scripting.executeScript({target,func:controlPageVideo,args:[request]}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('動画の取得が応答しません。取得済みのデータを確認してください。')),5000);}),
    ]);
    const result = results?.find(value => value.frameId === (ref.frameId || 0) && (!ref.documentId || value.documentId === ref.documentId))?.result;
    if (!result) throw new Error('動画の取得が終了しました。取得済みのデータを確認してください。');
    return result;
  } catch (error) {
    // executeScript failures can include private source URLs. Only fixed local messages leave this boundary.
    throw new Error(error?.message?.startsWith('動画の取得') ? error.message : '元ページとの接続が終了しました。取得済みのデータを確認してください。');
  } finally { clearTimeout(timer); }
}

async function pump(state) {
  state=remember(state);
  for (const job of state.jobs) await refreshJob(job,state.closed);
  if (!state.jobs.some(j=>j.status === 'in_progress')) {
    for (const job of state.jobs.filter(j=>j.status === 'queued')) {
      try {
        if(typeof chrome!=='undefined' && chrome.downloads?.download) {
          job.downloadId = await chrome.downloads.download({url:job.url,filename:job.filename,conflictAction:'uniquify',saveAs:false});
          job.status='in_progress'; await save(state); await refreshJob(job,state.closed);
          if (job.status === 'in_progress') break;
        } else {
          job.status='interrupted'; job.error='この環境では直接ダウンロードが制限されています。';
        }
      } catch (error) { job.status='interrupted'; job.error=publicError(error); }
    }
  }
  await save(state); return state;
}
async function claim(state, instance, mode, wantStream = true) {
  if (KIND !== 'videos') throw new Error('未対応の操作です。');
  const current = (await sessionStore.get('captureLock')).captureLock;
  const ownerURL=current && await workspaceURL(current.tabId);
  const ownerState=current && (current.sessionId ? await load(current.sessionId) : (await all()).find(state=>state.workspaceTabId===current.tabId));
  const ownerLive=ownerState && !ownerState.closed && ownerState.workspaceTabId===current.tabId && ownerURL===chrome.runtime.getURL(`workspace.html?id=${ownerState.id}`);
  if(current && !ownerLive) await sessionStore.remove('captureLock');
  if (current && ownerLive && (current.tabId !== state.workspaceTabId || current.instance !== instance)) {
    throw new Error('別の作業タブで録画中です。停止してから開始してください。');
  }
  // Same owner may not start another capture while one is active.
  if (ownerLive && current?.instance === instance) throw new Error('録画はすでに開始されています。');
  await sessionStore.set({captureLock:{tabId:state.workspaceTabId,sessionId:state.id,instance,mode}});
  try {
    if (mode !== 'tab' || !wantStream) return {};
    const tab = await liveTab(state.tabId);
    if (!tab || tab.url !== state.url) throw new Error('元ページが閉じられたか移動しました。拡張を押し直してください。');
    const captured = await chrome.tabCapture.getCapturedTabs();
    if (captured.some(t=>t.tabId === state.tabId && t.status !== 'stopped' && t.status !== 'error')) throw new Error('このタブはすでに録画されています。');
    return {streamId:await chrome.tabCapture.getMediaStreamId({targetTabId:state.tabId,consumerTabId:state.workspaceTabId})};
  } catch(error) { await sessionStore.remove('captureLock'); throw error; }
}
chrome.runtime.onMessage.addListener((message,sender,respond) => {
  if (!sender.url?.startsWith(chrome.runtime.getURL('workspace.html')) || sender.id !== chrome.runtime.id) return;
  serial(async () => {
    const state = await load(message.sessionId);
    if (!state || state.closed || sender.tab?.id !== state.workspaceTabId) throw new Error('作業情報が見つかりません。元ページから拡張を押し直してください。');
    switch(message.type) {
      case 'get': return pump(state);
      case 'scan': return scan(state);
      case 'video-control': return videoControl(state,message);
      case 'locate-video': return locate(state,videoReference(state,message.reference));
      case 'blob-read': {
        const item=state.items.find(i=>i.url===message.url && i.type==='blob');
        const tab=await liveTab(state.tabId);
        if(!item || !tab || tab.url!==state.url) throw new Error('元ページの動画情報が変わりました。元ページから開き直してください。');
        if(!Number.isSafeInteger(message.offset) || message.offset < -2 || !/^[a-f0-9-]{36}$/.test(message.token)) throw new Error('動画データの指定が不正です。');
        const target={tabId:state.tabId,...(item.documentId ? {documentIds:[item.documentId]} : {frameIds:[item.frameId || 0]})};
        const [result]=await chrome.scripting.executeScript({target,func:readPageBlob,args:[item.url,message.offset,message.token]});
        if(!result?.result || result.result.error) throw new Error(result?.result?.error || 'ページ内動画を取得できませんでした。');
        return result.result;
      }
      case 'inspect-download': {
        const item=await ownedDownload(state,message.downloadId);
        return {downloadId:item.id,filename:item.filename || '',exists:item.exists,state:item.state};
      }
      case 'show-download': {
        const item=await ownedDownload(state,message.downloadId);
        if (item.state !== 'complete' || item.exists === false) throw new Error('保存ファイルが見つかりません。Chromeのダウンロード履歴を確認してください。');
        await chrome.downloads.show(item.id); return {};
      }
      case 'locate-source': {
        const item=state.items.find(item=>item.url===message.url);
        const occurrence=item?.occurrences?.find(entry=>message.occurrenceId ? entry.id===message.occurrenceId : entry.elementToken);
        return locate(state,occurrence);
      }
      case 'locate-frame': {
        const frame=state.frames?.find(frame=>frame.locatable===true && frame.elementToken===message.elementToken && frame.frameToken===message.frameToken);
        return locate(state,frame && {...frame,frameId:frame.parentFrameId,documentId:frame.parentDocumentId});
      }
      case 'source': { const tab = await liveTab(state.tabId); if(!tab) throw new Error('元ページは閉じられています。'); await chrome.tabs.update(state.tabId,{active:true}); return {}; }
      case 'save': {
        if (active(state)) throw new Error('保存処理中です。');
        const chosen = new Set(message.urls);
        const items = state.items.filter(item=>chosen.has(item.url) && allowedURL(item.url,KIND) && (KIND !== 'videos' || item.type === 'direct'));
        if (!items.length) throw new Error('保存する対象を選んでください。');
        state.jobs = items.map((item,i)=>{
          const outputFormat=validateOutputFormat(item,message.outputFormat===undefined ? 'auto' : message.outputFormat);
          return {url:item.url,status:'queued',outputFormat,filename:downloadName(item,state.title,i,KIND,outputFormat)};
        });
        return pump(state);
      }
      case 'cancel': {
        for(const job of state.jobs) {
          if(job.status==='queued') { job.status='interrupted'; job.error='停止しました。'; }
          if(job.status==='in_progress') { try { await chrome.downloads.cancel(job.downloadId); } catch {} await refreshJob(job); if(job.status==='interrupted') job.error='停止しました。'; }
        }
        await save(state); return state;
      }
      case 'retry': {
        if(active(state)) throw new Error('保存処理中です。');
        for(const job of state.jobs.filter(j=>j.status==='interrupted')) { job.status='queued'; delete job.downloadId; delete job.error; delete job.actualFilename; delete job.exists; delete job.resultUnavailable; }
        return pump(state);
      }
      case 'capture': return claim(state,message.instance,message.mode);
      case 'hello': {
        // Reload gets a new instance token; the old page no longer owns a live recorder.
        const lock = (await sessionStore.get('captureLock')).captureLock;
        if(lock?.tabId === state.workspaceTabId && lock.instance !== message.instance) await sessionStore.remove('captureLock');
        return state;
      }
      case 'release': {
        const lock = (await sessionStore.get('captureLock')).captureLock;
        if(lock?.tabId === state.workspaceTabId && lock.instance === message.instance) await sessionStore.remove('captureLock');
        return {};
      }
      default: throw new Error('未対応の操作です。');
    }
  }).then(data=>respond({ok:true,data}),error=>respond({ok:false,error:publicError(error)}));
  return true;
});
// Register listeners at worker startup; storage keeps download IDs across suspension.
chrome.downloads?.onChanged?.addListener(delta => {
  if (!delta.state && !delta.error) return;
  serial(async()=> {for(const state of await all()) if(state.jobs.some(j=>j.downloadId === delta.id)) await pump(state);}).catch(()=>{});
});
chrome.tabs.onRemoved.addListener(tabId => {
  const closed=scrubClosedTab(tabId);
  // Handle rejection immediately while the mutation queue may still be busy.
  closed.catch(()=>{});
  serial(async()=> {
    const lock = (await sessionStore.get('captureLock')).captureLock;
    if(lock?.tabId === tabId) await sessionStore.remove('captureLock');
    for(const state of await closed) if(active(state)) await pump(state);
  }).catch(()=>{});
});
