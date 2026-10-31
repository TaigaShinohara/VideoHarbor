import { isImageResource, mediaKind, mergeItems } from './utils.js';

export const DISCOVERY_VERSION = 2;
const LIMIT = 500, VIDEO_LIMIT = 100, PREVIOUS_LIMIT = 100;
const isVideoCandidate = item => !isImageResource(item.url,item.mime);
const priority = (item, previousURLs) => (item.playing ? 100000 : 0)+(item.visible ? 10000 : 0)
  +(item.discovery === 'loaded-history' ? 0 : 1000)+(!previousURLs.has(item.url) ? 100 : 0)
  +({video:5,'player-config':4,metadata:3,embed:3,'loaded-resource':2,link:1}[item.source] || 0);
const kindFor = item => {
  const kind = mediaKind(item.url,item.mime);
  return kind === 'unknown' && (item.source === 'video' || item.mediaHint) && /^https?:/.test(item.url) ? 'direct' : kind;
};

// Old sessions contain a cumulative URL list with potentially inherited parent
// frame IDs. Retain those records as previous results, never trust their frame.
export function migrateDiscovery(state) {
  if (state.scan?.version === DISCOVERY_VERSION) {
    const items = (state.items || []).filter(isVideoCandidate), previousItems = (state.previousItems || []).filter(isVideoCandidate);
    if (items.length === (state.items || []).length && previousItems.length === (state.previousItems || []).length && Array.isArray(state.videoElements)) return state;
    return {...state,items,previousItems,videoElements:Array.isArray(state.videoElements) ? state.videoElements : [],scan:{...state.scan,currentCount:items.length,previousCount:previousItems.length}};
  }
  const previousItems = (state.items || []).filter(isVideoCandidate).slice(-PREVIOUS_LIMIT).map(item => {
    const {frameId,documentId,occurrences,videoRef,configRef,frameToken,...safe} = item;
    return {...safe,discovery:'previous',legacy:true};
  });
  return {...state,items:[],previousItems,videoElements:[],frames:[],scan:{version:DISCOVERY_VERSION,sequence:0,at:null,currentCount:0,previousCount:previousItems.length,omitted:0},
  notices:[...new Set([...(state.notices || []),...(state.items?.length ? ['以前の候補を前回の結果へ移しました。再スキャンで現在のページを確認してください。'] : [])])]};
}

// Pure snapshot creation: callers finish permission checks and validate the source
// tab again before committing all fields together. A failed scan keeps old state.
export function discoverySnapshot(state, results, now = Date.now()) {
  const previousURLs = new Set((state.items || []).map(item => item.url));
  const incoming = [], frames = [], videoElements = new Map(), notices = new Set();
  let previewBudget = 262144;
  const boundPreview = source => {
    if (typeof source.previewDataURL !== 'string') return;
    if (/^data:image\/jpeg;base64,[a-z0-9+/=]+$/i.test(source.previewDataURL) && source.previewDataURL.length <= 32768 && source.previewDataURL.length <= previewBudget) previewBudget-=source.previewDataURL.length;
    else delete source.previewDataURL;
  };
  const videoPriority = video => (video.playing ? 100 : 0)+(video.visible ? 10 : 0);
  for (const {result,frameId = 0,documentId} of results) {
    if (!Array.isArray(result?.items)) continue;
    for (const entry of result.videoElements || []) {
      if (entry.elementTag !== 'VIDEO' || !entry.elementToken || entry.videoRef !== entry.elementToken || !result.frameToken || !result.documentURL) continue;
      const video={...entry,source:'video',origin:'dom',frameToken:result.frameToken,documentURL:result.documentURL,frameId,...(documentId ? {documentId} : {})};
      boundPreview(video);
      const key=`${documentId || frameId}:${video.elementToken}`;
      if (!videoElements.has(key) && videoElements.size>=VIDEO_LIMIT) {
        notices.add('録画する動画は100件までです。再生中・表示中の動画を優先しました。');
        let worst;
        for (const candidate of videoElements) if (!worst || videoPriority(candidate[1])<videoPriority(worst[1])) worst=candidate;
        if (videoPriority(video)<=videoPriority(worst[1])) continue;
        videoElements.delete(worst[0]);
      }
      videoElements.set(key,video);
    }
    for (const item of result.items) {
      if (!isVideoCandidate(item)) continue;
      const occurrences = (item.occurrences?.length ? item.occurrences : [{source:item.source,origin:item.source === 'loaded-resource' ? 'performance' : 'dom'}]).map((entry,index) => {
        const occurrence = {...entry,frameToken:result.frameToken,documentURL:result.documentURL || entry.documentURL,frameId,...(documentId ? {documentId} : {}),id:entry.id || `${documentId || frameId}:${index}:${item.url}`};
        boundPreview(occurrence);
        return occurrence;
      });
      // Only a document's own output may receive its InjectionResult identity.
      incoming.push({...item,occurrences,frameId,...(documentId ? {documentId} : {}),frameToken:result.frameToken,type:kindFor(item)});
    }
    for (const frame of result.frames || []) frames.push({...frame,parentFrameId:frameId,...(documentId ? {parentDocumentId:documentId} : {}),frameToken:result.frameToken,documentURL:result.documentURL || frame.documentURL});
    for (const notice of result.notices || []) notices.add(notice);
  }
  const grouped = new Map();
  for (const item of incoming) {
    const old = grouped.get(item.url);
    const merged = mergeItems(old ? [old] : [],[item])[0];
    merged.occurrences = [...new Map([...(old?.occurrences || []),...item.occurrences].map(entry => [entry.id,entry])).values()].slice(0,32);
    merged.discovery = merged.occurrences.some(entry => entry.origin === 'dom') ? 'current-dom' : 'loaded-history';
    merged.playing = merged.occurrences.some(entry => entry.playing);
    merged.visible = merged.occurrences.some(entry => entry.visible);
    const representative = [...merged.occurrences].sort((a,b) => (b.playing ? 100 : 0)+(b.visible ? 10 : 0)+(b.source === 'video' ? 1 : 0)-((a.playing ? 100 : 0)+(a.visible ? 10 : 0)+(a.source === 'video' ? 1 : 0)))[0];
    for (const key of ['frameId','documentId','frameToken','elementToken','documentURL','videoRef','configRef','title','duration']) {
      delete merged[key];
      if (representative[key] !== undefined) merged[key]=representative[key];
    }
    delete merged.previewDataURL;
    merged.type = kindFor(merged);
    grouped.set(item.url,merged);
  }
  const ordered = [...grouped.values()].sort((a,b) => priority(b,previousURLs)-priority(a,previousURLs));
  const items = ordered.slice(0,LIMIT), omitted = Math.max(0,ordered.length-LIMIT);
  if (omitted) notices.add(`${omitted}件を省略しました。再生中・表示中・現在のページ・新しい候補を優先して500件まで表示します。`);
  const currentURLs = new Set(items.map(item => item.url));
  const previousItems = [...new Map([...(state.previousItems || []),...(state.items || [])].map(item => [item.url,item])).values()]
    .filter(item => isVideoCandidate(item) && !currentURLs.has(item.url)).slice(-PREVIOUS_LIMIT).map(item => ({...item,discovery:'previous'}));
  return {items,previousItems,videoElements:[...videoElements.values()].sort((a,b)=>videoPriority(b)-videoPriority(a)),frames:frames.slice(0,100),notices:[...notices],scanned:true,
    scan:{version:DISCOVERY_VERSION,sequence:(state.scan?.sequence || 0)+1,at:now,currentCount:items.length,previousCount:previousItems.length,omitted}};
}
