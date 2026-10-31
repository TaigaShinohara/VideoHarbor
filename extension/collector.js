// Injected as a self-contained function into each authorized source document.
export function collect(previousURLs = []) {
  const items = new Map(), frames = new Map(), notices = new Set();
  // Each injection owns exactly one real Chrome frame. Never attribute a child
  // document to its parent InjectionResult (notably for blob reads).
  const key = '__videoHarborDiscovery';
  let local = document[key];
  if (!local || local.document !== document) {
    local = {document,token:globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,refs:new WeakMap(),next:0,elements:new Map()};
    document[key] = local;
  }
  local.elements = new Map();
  const previous = new Set(Array.isArray(previousURLs) ? previousURLs : []);
  let context = {}, configSequence = 0, previewCount = 0;
  const documentURL = document.URL || document.defaultView?.location?.href || document.baseURI;
  const tokenFor = el => {
    if (!local.refs.has(el)) local.refs.set(el,`${local.token}:${++local.next}`);
    const token = local.refs.get(el); local.elements.set(token,el); return token;
  };
  const observed = el => {
    const info = {elementToken:tokenFor(el),elementTag:el.tagName,frameToken:local.token,documentURL,origin:'dom'};
    if (typeof document.title === 'string' && document.title.trim()) info.documentTitle=document.title.trim().slice(0,160);
    const title = el.getAttribute('aria-label') || el.getAttribute('title');
    if (title) info.title = title.trim().slice(0,160);
    try {
      const rect = el.getBoundingClientRect?.();
      if (rect && ['x','y','width','height'].every(k => Number.isFinite(rect[k]))) {
        info.position = {x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)};
        const view = document.defaultView, style = view?.getComputedStyle?.(el);
        info.visibilityScope='frame-viewport';
        info.locatable = rect.width > 0 && rect.height > 0 && !['SCRIPT','META','LINK','SOURCE'].includes(el.tagName)
          && style?.display !== 'none' && style?.visibility !== 'hidden' && style?.visibility !== 'collapse' && style?.opacity !== '0';
        info.visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
          && (view?.innerHeight == null || rect.top < view.innerHeight) && (view?.innerWidth == null || rect.left < view.innerWidth)
          && style?.display !== 'none' && style?.visibility !== 'hidden' && style?.visibility !== 'collapse' && style?.opacity !== '0';
      }
    } catch { /* Detached or unusual DOM nodes may not expose layout. */ }
    return info;
  };
  const rank = item => (item.playing ? 100000 : 0)+(item.visible ? 10000 : 0)
    +(item.discovery === 'loaded-history' ? 0 : 1000)+(!previous.has(item.url) ? 100 : 0)+(confidence[item.source] || 0);
  const fingerprint = value => { let n=2166136261; for (let i=0;i<value.length;i++) n=Math.imul(n^value.charCodeAt(i),16777619); return (n>>>0).toString(36); };
  const LIMIT = 500, NODE_LIMIT = 12000, FRAME_LIMIT = 32, JSON_LIMIT = 524288;
  const mediaSuffix = /\.(mp4|webm|mov|m4v|ogv|ogg|m3u8|mpd)(?:[?#]|$)/i;
  const videoMIME = /^(?:video\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;
  const confidence = {video:5,'player-config':4,metadata:3,embed:3,'loaded-resource':2,link:1};
  let visited = 0, jsonBytes = 0, jsonNodes = 0, scriptConfigs = 0;
  const decodeHTML = value => value.replace(/&(?:amp|quot|apos|lt|gt|#(?:x[0-9a-f]+|\d+));/gi,entity => {
    const named = {'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':'<','&gt;':'>'};
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const code = /^&#x/i.test(entity) ? parseInt(entity.slice(3,-1),16) : Number(entity.slice(2,-1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : entity;
  });
  const add = (raw, metadata = {}, base = document.baseURI) => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    try {
      const u = new URL(decodeHTML(raw), base); u.hash = '';
      const url = u.href;
      if (u.username || u.password || u.hostname.includes('*') || url.length > 131072 || !/^https?:$|^blob:$/.test(u.protocol)) return;
      const old = items.get(url), info = {...context,...metadata};
      const source = old && (confidence[old.source] || 0) > (confidence[metadata.source] || 0) ? old.source : metadata.source;
      const keepMIME = old?.mime && (confidence[old.source] || 0) > (confidence[metadata.source] || 0);
      const occurrence = {...info,id:`${info.elementToken || local.token}:${metadata.source || 'unknown'}:${fingerprint(url)}`};
      const occurrences = [...(old?.occurrences || [])];
      const index = occurrences.findIndex(entry => entry.id === occurrence.id);
      if (index >= 0) occurrences[index] = {...occurrences[index],...occurrence};
      else if (occurrences.length < 32) occurrences.push(occurrence);
      else notices.add('同じURLの出典は32件まで表示します。');
      const item = {...old,...info,url,source,occurrences,
        mime:keepMIME ? old.mime : metadata.mime || old?.mime || '',
        mediaHint:Boolean(old?.mediaHint || metadata.mediaHint),
        playing:Boolean(old?.playing || info.playing),visible:Boolean(old?.visible || info.visible),
        discovery:occurrences.some(entry => entry.origin === 'dom') ? 'current-dom' : 'loaded-history',
        width:Math.max(old?.width || 0,metadata.width || 0),height:Math.max(old?.height || 0,metadata.height || 0)};
      if (!old && items.size >= LIMIT) {
        notices.add('候補は500件までです。再生中・表示中・現在のページ・新しい候補を優先しました。');
        let worst;
        for (const candidate of items.values()) if (!worst || rank(candidate) < rank(worst)) worst = candidate;
        if (rank(item) <= rank(worst)) return;
        items.delete(worst.url);
      }
      items.set(url,item);
      if (info.previewDataURL) delete context.previewDataURL;
    } catch { /* Ignore malformed/unusable page values. */ }
  };
  const addFrame = (raw, base) => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    try {
      const u = new URL(decodeHTML(raw),base); u.hash = '';
      if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.hostname.includes('*') || u.href.length > 16384) return;
      const id = `${context.elementToken || local.token}:${u.href}`;
      if (frames.size < FRAME_LIMIT || frames.has(id)) {
        const locatable=['IFRAME','FRAME','OBJECT','EMBED'].includes(context.elementTag);
        const frame={...context,url:u.href,locatable,hintSource:locatable ? 'element' : 'metadata'};
        if (!locatable) for (const key of ['elementToken','title','position','visible','visibilityScope']) delete frame[key];
        frames.set(id,frame);
      }
      else if (!frames.has(id)) notices.add('埋め込みページの候補は32件までです。');
    } catch { /* Ignore unusable iframe URLs. */ }
  };
  // Parse only explicit JSON media configuration, never page JavaScript or arbitrary URL strings.
  const walkJSON = (value,base,depth = 0,source = 'player-config',mediaList = false,group = null) => {
    if (!value || typeof value !== 'object' || depth > 10) return;
    if (++jsonNodes > 4000) { notices.add('動画設定の取得量を制限しました。'); return; }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (mediaList && typeof item === 'string' && mediaSuffix.test(item)) add(item,{source,mediaHint:true,...(group || {})},base);
        else walkJSON(item,base,depth+1,source,mediaList,group);
      }
      return;
    }
    const configRef = group?.configRef || `${context.elementToken || local.token}:config:${++configSequence}`;
    const configMeta = {...(group || {}),configRef};
    const label = typeof value.name === 'string' ? value.name : typeof value.title === 'string' ? value.title : '';
    if (label) configMeta.title = label.trim().slice(0,160);
    if (Number.isFinite(value.duration) && value.duration >= 0) configMeta.duration = value.duration;
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    const isVideoObject = types.some(type => typeof type === 'string' && /(?:^|[\/#])VideoObject$/.test(type));
    if (isVideoObject && typeof value.contentUrl === 'string') add(value.contentUrl,{...configMeta,source:'metadata',mediaHint:true,mime:typeof value.encodingFormat === 'string' && videoMIME.test(value.encodingFormat) ? value.encodingFormat : ''},base);
    if (isVideoObject && typeof value.embedUrl === 'string') addFrame(value.embedUrl,base);
    const rawMIME = typeof value.type === 'string' ? value.type : typeof value.mimeType === 'string' ? value.mimeType : '';
    const mime = ({hls:'application/vnd.apple.mpegurl',dash:'application/dash+xml',mp4:'video/mp4',webm:'video/webm'})[rawMIME.toLowerCase()] || rawMIME;
    for (const key of ['file','src','url']) {
      const url = value[key];
      if (typeof url === 'string' && (mediaSuffix.test(url) || videoMIME.test(mime))) add(url,{...configMeta,source,mime:videoMIME.test(mime) ? mime : '',mediaHint:true},base);
    }
    const videoFields = {
      video_url:'',videoUrl:'',video_src:'',videoSrc:'',playbackUrl:'',
      mp4:'video/mp4',hls:'application/vnd.apple.mpegurl',hlsUrl:'application/vnd.apple.mpegurl',hls_url:'application/vnd.apple.mpegurl',hlsManifestUrl:'application/vnd.apple.mpegurl',
      dash:'application/dash+xml',dashUrl:'application/dash+xml',dash_url:'application/dash+xml',dashManifestUrl:'application/dash+xml',
    };
    for (const [key,type] of Object.entries(videoFields)) if (typeof value[key] === 'string') {
      add(value[key],{...configMeta,source,mime:type || (videoMIME.test(mime) ? mime : ''),mediaHint:true},base);
    }
    // Traverse bounded objects to find nested sources and VideoObjects, but do not treat
    // unrelated endpoint/thumbnail/embedUrl values as media files.
    for (const [key,child] of Object.entries(value)) if (child && typeof child === 'object') walkJSON(child,base,depth+1,source,['sources','playlist','videos'].includes(key),key === 'sources' ? configMeta : null);
  };
  const takeJSONBudget = text => {
    if (text.length > JSON_LIMIT || (jsonBytes += text.length) > JSON_LIMIT) { notices.add('動画設定の取得量を制限しました。'); return false; }
    return true;
  };
  const parseJSON = (text,base,budgeted = false) => {
    if (!text || typeof text !== 'string') return;
    if (!budgeted && !takeJSONBudget(text)) return;
    try { walkJSON(JSON.parse(text),base); }
    catch {
      try { walkJSON(JSON.parse(decodeHTML(text)),base); } catch { /* Malformed JSON is not executable input. */ }
    }
  };
  // Read a JavaScript string as data only. No expressions, templates, or code run.
  const quoted = (text,start) => {
    const quote = text[start]; let value = '';
    for (let i = start+1;i < text.length;i++) {
      const ch = text[i];
      if (ch === quote) return {value,end:i+1};
      if (ch === '\n' || ch === '\r') return null;
      if (ch !== '\\') { value += ch; continue; }
      const escape = text[++i], simple = {b:'\b',f:'\f',n:'\n',r:'\r',t:'\t',v:'\v','0':'\0'};
      if (escape === undefined) return null;
      if (escape === '\n') continue;
      if (escape === '\r') { if (text[i+1] === '\n') i++; continue; }
      if ('\\\'"/'.includes(escape)) { value += escape; continue; }
      if (Object.hasOwn(simple,escape)) { value += simple[escape]; continue; }
      if (escape === 'u' || escape === 'x') {
        const size = escape === 'u' ? 4 : 2, code = text.slice(i+1,i+1+size);
        if (code.length !== size || !/^[0-9a-f]+$/i.test(code)) return null;
        value += String.fromCharCode(parseInt(code,16)); i += size; continue;
      }
      return null;
    }
    return null;
  };
  const literalJSON = (text,start) => {
    const stack = [];
    for (let i = start;i < text.length;i++) {
      const ch = text[i];
      if (ch === '"' || ch === "'") { const string = quoted(text,i); if (!string) return null; i = string.end-1; continue; }
      if (ch === '{' || ch === '[') { if (stack.length >= 32) return null; stack.push(ch); }
      else if (ch === '}' || ch === ']') {
        if (stack.pop() !== (ch === '}' ? '{' : '[')) return null;
        if (!stack.length) return {text:text.slice(start,i+1),end:i+1};
      }
    }
    return null;
  };
  const parsePlayerScript = (text,base) => {
    if (!text || typeof text !== 'string' || !/(?:__(?:PLAYER|VIDEO|MEDIA|INITIAL|PRELOADED|NEXT|NUXT)|playerConfig|playerData|videoConfig|videoData|flashvars|jwplayer|videojs|ytInitialPlayerResponse|ytplayer|Playerjs|Clappr)/.test(text) || !takeJSONBudget(text)) return;
    // Match known player/hydration variables and setup calls, not arbitrary URL
    // text or executable object literals. Only subsequent strict JSON is parsed.
    const variable = '(?:(?:window|globalThis|self)\\s*\\.\\s*)?(?:__(?:PLAYER|VIDEO|MEDIA|INITIAL|PRELOADED|NEXT|NUXT)[A-Z0-9_]*|playerConfig|playerData|videoConfig|videoData|flashvars|jwplayerConfig|ytInitialPlayerResponse|ytplayer\\s*\\.\\s*config)\\s*=';
    const player = '(?:jwplayer\\s*\\(\\s*(?:"[^"\\n]{0,160}"|\'[^\'\\n]{0,160}\'|[0-9]+)?\\s*\\)\\s*\\.\\s*(?:setup|load)\\s*\\(|videojs\\s*\\(\\s*(?:"[^"\\n]{0,160}"|\'[^\'\\n]{0,160}\')\\s*,|(?:new\\s+)?(?:Playerjs|Clappr\\s*\\.\\s*Player)\\s*\\()';
    const marker = new RegExp(`(?:${variable}|${player})\\s*`,'y');
    for (let i = 0;i < text.length;) {
      const ch = text[i];
      if (ch === '"' || ch === "'" || ch === '`') { const string = quoted(text,i); if (!string) break; i = string.end; continue; }
      if (text.startsWith('//',i)) { const end = text.indexOf('\n',i+2); i = end < 0 ? text.length : end+1; continue; }
      if (text.startsWith('/*',i)) { const end = text.indexOf('*/',i+2); if (end < 0) break; i = end+2; continue; }
      let before = i-1;
      if (ch === '/') while (before >= 0 && /\s/.test(text[before])) before--;
      if (ch === '/' && (before < 0 || /[=(:,!&|?{[;]/.test(text[before]))) {
        // A regexp literal is data too. Skip it instead of recognizing a fake
        // player assignment written inside its pattern.
        let inClass = false; i++;
        for (;i < text.length;i++) {
          if (text[i] === '\\') { i++; continue; }
          if (text[i] === '[') inClass = true;
          if (text[i] === ']') inClass = false;
          if (text[i] === '/' && !inClass) { i++; break; }
          if (text[i] === '\n' || text[i] === '\r') break;
        }
        continue;
      }
      if (i && /[\w$.]/.test(text[i-1])) { i++; continue; }
      marker.lastIndex = i;
      if (!marker.exec(text)) { i++; continue; }
      const start = marker.lastIndex;
      if (++scriptConfigs > 64) { notices.add('動画設定の取得量を制限しました。'); return; }
      if (text[start] === '{' || text[start] === '[') {
        const literal = literalJSON(text,start);
        if (literal) { parseJSON(literal.text,base,true); i = literal.end; continue; }
      } else if (text[start] === '"' || text[start] === "'") {
        const string = quoted(text,start);
        if (string) { parseJSON(string.value,base,true); i = string.end; continue; }
      } else if (text.startsWith('JSON.parse',start)) {
        const call = /^JSON\.parse\s*\(\s*/.exec(text.slice(start));
        const from = call && start+call[0].length;
        if (from && (text[from] === '"' || text[from] === "'")) {
          const string = quoted(text,from);
          if (string && /^\s*\)/.test(text.slice(string.end))) { parseJSON(string.value,base,true); i = string.end; continue; }
        }
      }
      i = start+1;
    }
  };
  const walkDocument = doc => {
    const view = doc.defaultView;
    // Structured og:video:type applies to its own preceding video group, not all URLs.
    const ogTypes = new Map();
    let ogGroup = [], metaCount = 0;
    for (const meta of doc.querySelectorAll('meta')) {
      if (++metaCount > NODE_LIMIT) break;
      const key = String(meta.getAttribute('property') || meta.getAttribute('name') || '').toLowerCase();
      if (key === 'og:video') ogGroup = [meta];
      else if (/^og:video:(url|secure_url)$/.test(key)) ogGroup.push(meta);
      else if (key === 'og:video:type') {
        const type = meta.getAttribute('content') || '';
        if (videoMIME.test(type)) for (const member of ogGroup) ogTypes.set(member,type);
      }
    }
    const walk = root => {
      for (const el of root.querySelectorAll('*')) {
        if (++visited > NODE_LIMIT) { notices.add('要素数が多いため取得を12000要素に制限しました。'); return; }
        const base = el.baseURI || doc.baseURI, tag = el.tagName;
        context = observed(el);
        if (tag === 'VIDEO') {
          context.videoRef = context.elementToken;
          if (Number.isFinite(el.duration) && el.duration >= 0) context.duration = el.duration;
          if (typeof el.paused === 'boolean') context.playing = !el.paused && !el.ended;
          if (context.visible && el.readyState >= 2 && el.videoWidth > 0 && el.videoHeight > 0 && previewCount < 8) {
            previewCount++;
            try {
              const canvas = doc.createElement('canvas');
              const scale=Math.min(160/el.videoWidth,90/el.videoHeight,1);
              canvas.width=Math.max(1,Math.round(el.videoWidth*scale));canvas.height=Math.max(1,Math.round(el.videoHeight*scale));
              canvas.getContext('2d').drawImage(el,0,0,canvas.width,canvas.height);
              const preview = canvas.toDataURL('image/jpeg',0.55);
              if (/^data:image\/jpeg;base64,/.test(preview) && preview.length <= 32768) {context.previewDataURL=preview;}
            } catch { /* Cross-origin/tainted videos remain usable without a preview. */ }
          }
          const meta = {width:el.videoWidth || 0,height:el.videoHeight || 0,source:'video',mediaHint:true,mime:el.getAttribute('type') || ''};
          add(el.currentSrc,meta,base);
          for (const key of ['src','data-src','data-video-src','data-source','data-hls','data-dash']) add(el.getAttribute(key),{...meta,mime:key === 'data-hls' ? 'application/vnd.apple.mpegurl' : key === 'data-dash' ? 'application/dash+xml' : meta.mime},base);
          for (const src of el.querySelectorAll('source')) {
            const childMeta = {...meta,mime:src.getAttribute('type') || ''};
            for (const key of ['src','data-src','data-video-src','data-source']) add(src.getAttribute(key),childMeta,base);
          }
          parseJSON(el.getAttribute('data-setup'),base);
        }
        if (tag === 'A' || tag === 'LINK') {
          const raw = el.getAttribute('href'), mime = el.getAttribute('type') || '';
          if (raw && (mediaSuffix.test(raw) || videoMIME.test(mime))) add(raw,{source:'link',mime,mediaHint:true},base);
        }
        if (tag === 'OBJECT' || tag === 'EMBED') {
          const raw = el.getAttribute(tag === 'OBJECT' ? 'data' : 'src'), mime = el.getAttribute('type') || '';
          if (raw && (mediaSuffix.test(raw) || videoMIME.test(mime))) add(raw,{source:'embed',mime,mediaHint:true},base);
        }
        if (tag === 'META') {
          const key = String(el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase(), raw = el.getAttribute('content');
          const ogMIME = ogTypes.get(el) || '';
          if (/^og:video(?::url|:secure_url)?$/.test(key) && raw && (mediaSuffix.test(raw) || ogMIME)) add(raw,{source:'metadata',mime:ogMIME,mediaHint:true},base);
          if (key === 'twitter:player:stream' && raw) add(raw,{source:'metadata',mediaHint:true},base);
        }
        if (tag === 'SCRIPT') {
          const type = el.getAttribute('type') || '';
          if (/^application\/(?:ld\+)?json(?:\s*;|$)/i.test(type)) parseJSON(el.textContent,base);
          else if (!type || /^(?:application|text)\/(?:java|ecma)script(?:\s*;|$)/i.test(type) || type === 'module') parsePlayerScript(el.textContent,base);
        }
        // Video-specific lazy attributes can also live on a player container.
        if (tag !== 'VIDEO') for (const key of ['data-video-src','data-hls','data-dash']) {
          const raw = el.getAttribute(key); if (raw) add(raw,{source:'player-config',mediaHint:true,mime:key === 'data-hls' ? 'application/vnd.apple.mpegurl' : key === 'data-dash' ? 'application/dash+xml' : ''},base);
        }
        if (el.shadowRoot) walk(el.shadowRoot);
        if (tag === 'IFRAME' || tag === 'FRAME') {
          for (const key of ['src','data-src']) {
            const raw = el.getAttribute(key);
            if (raw && mediaSuffix.test(raw)) add(raw,{source:'embed',mediaHint:true},base);
            else addFrame(raw,base);
          }
          // Child documents are collected only by their own allFrames injection.
        }
      }
    };
    walk(doc);
    context = {frameToken:local.token,documentURL,origin:'performance'};
    try {
      for (const entry of (view?.performance?.getEntriesByType('resource') || []).slice(-1000)) {
        if (mediaSuffix.test(entry.name) || entry.initiatorType === 'video') add(entry.name,{source:'loaded-resource',mediaHint:entry.initiatorType === 'video'},doc.baseURI);
      }
    } catch { /* A detached frame may lose its performance context. */ }
  };
  walkDocument(document);
  return {frameToken:local.token,documentURL,items:[...items.values()],frames:[...frames.values()],notices:[...notices]};
}


// Injected into the exact document selected by Chrome. Tokens never select a
// different page or cause playback/network requests.
export function locateSourceElement(frameToken, elementToken, expectedURL) {
  const local = document.__videoHarborDiscovery;
  const url = document.URL || document.defaultView?.location?.href || document.baseURI;
  if (!local || local.token !== frameToken || url !== expectedURL) return {found:false};
  const el = local.elements.get(elementToken);
  if (!el || el.isConnected === false) return {found:false};
  try { el.scrollIntoView?.({block:'center',inline:'nearest',behavior:'instant'}); } catch { el.scrollIntoView?.(); }
  // Keep the original inline style across repeated clicks. Compare the actual
  // CSSOM value after assignment, since Chrome normalizes colors to rgb().
  if (el.style) {
    local.highlights ||= new WeakMap();
    const style=el.style, previous=local.highlights.get(el);
    const priority=name=>style.getPropertyPriority?.(name) || '';
    const write=(name,value,importance)=> {
      if (style.setProperty) style.setProperty(name,value,importance);
      else style[name === 'outline-offset' ? 'outlineOffset' : 'outline']=value;
    };
    if (previous) clearTimeout(previous.timer);
    const unchanged=(value,name,applied)=>value === applied && priority(name) === '';
    const record={
      outline:previous && unchanged(style.outline,'outline',previous.appliedOutline) ? previous.outline : style.outline,
      outlinePriority:previous && unchanged(style.outline,'outline',previous.appliedOutline) ? previous.outlinePriority : priority('outline'),
      offset:previous && unchanged(style.outlineOffset,'outline-offset',previous.appliedOffset) ? previous.offset : style.outlineOffset,
      offsetPriority:previous && unchanged(style.outlineOffset,'outline-offset',previous.appliedOffset) ? previous.offsetPriority : priority('outline-offset'),
    };
    write('outline','3px solid #1267d6','');write('outline-offset','4px','');
    record.appliedOutline=style.outline;record.appliedOffset=style.outlineOffset;
    local.highlights.set(el,record);
    record.timer=setTimeout(()=>{
      if(local.highlights.get(el)!==record)return;
      if(unchanged(style.outline,'outline',record.appliedOutline))write('outline',record.outline,record.outlinePriority);
      if(unchanged(style.outlineOffset,'outline-offset',record.appliedOffset))write('outline-offset',record.offset,record.offsetPriority);
      local.highlights.delete(el);
    },1800);
  }
  return {found:true};
}


// Lightweight generation check for the current top document at commit time.
export function inspectSourceDocument() {
  return {frameToken:document.__videoHarborDiscovery?.token,documentURL:document.URL || document.defaultView?.location?.href || document.baseURI};
}
