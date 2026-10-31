// Injected as a self-contained function into each authorized source document.
export function collect() {
  const items = new Map(), frames = new Map(), notices = new Set(), seenDocs = new Set();
  const LIMIT = 500, NODE_LIMIT = 12000, FRAME_LIMIT = 32, JSON_LIMIT = 524288;
  const mediaSuffix = /\.(mp4|webm|mov|m4v|ogv|ogg|m3u8|mpd)(?:[?#]|$)/i;
  const videoMIME = /^(?:video\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;
  const confidence = {video:5,'player-config':4,metadata:3,embed:3,'loaded-resource':2,link:1};
  let visited = 0, jsonBytes = 0, jsonNodes = 0;
  const add = (raw, metadata = {}, base = document.baseURI) => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    try {
      const u = new URL(raw, base); u.hash = '';
      const url = u.href;
      if (u.username || u.password || u.hostname.includes('*') || url.length > 131072 || !/^https?:$|^blob:$/.test(u.protocol)) return;
      const old = items.get(url);
      if (!old && items.size >= LIMIT) { notices.add('候補は500件までです。表示範囲を絞って再取得してください。'); return; }
      const source = old && (confidence[old.source] || 0) > (confidence[metadata.source] || 0) ? old.source : metadata.source;
      const keepMIME = old?.mime && (confidence[old.source] || 0) > (confidence[metadata.source] || 0);
      items.set(url, {...old,...metadata,url,source,
        mime:keepMIME ? old.mime : metadata.mime || old?.mime || '',
        mediaHint:Boolean(old?.mediaHint || metadata.mediaHint),
        width:Math.max(old?.width || 0,metadata.width || 0),height:Math.max(old?.height || 0,metadata.height || 0)});
    } catch { /* Ignore malformed/unusable page values. */ }
  };
  const addFrame = (raw, base) => {
    if (typeof raw !== 'string' || !raw.trim()) return;
    try {
      const u = new URL(raw,base); u.hash = '';
      if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.hostname.includes('*') || u.href.length > 16384) return;
      if (frames.size < FRAME_LIMIT) frames.set(u.href,{url:u.href});
      else if (!frames.has(u.href)) notices.add('埋め込みページの候補は32件までです。');
    } catch { /* Ignore unusable iframe URLs. */ }
  };
  // Parse only explicit JSON media configuration, never page JavaScript or arbitrary URL strings.
  const walkJSON = (value,base,depth = 0,source = 'player-config') => {
    if (!value || typeof value !== 'object' || depth > 10) return;
    if (++jsonNodes > 4000) { notices.add('動画設定の取得量を制限しました。'); return; }
    if (Array.isArray(value)) { for (const item of value) walkJSON(item,base,depth+1,source); return; }
    const types = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    const isVideoObject = types.some(type => typeof type === 'string' && /(?:^|[\/#])VideoObject$/.test(type));
    if (isVideoObject && typeof value.contentUrl === 'string') add(value.contentUrl,{source:'metadata',mediaHint:true,mime:typeof value.encodingFormat === 'string' && videoMIME.test(value.encodingFormat) ? value.encodingFormat : ''},base);
    const rawMIME = typeof value.type === 'string' ? value.type : typeof value.mimeType === 'string' ? value.mimeType : '';
    const mime = ({hls:'application/vnd.apple.mpegurl',dash:'application/dash+xml',mp4:'video/mp4',webm:'video/webm'})[rawMIME.toLowerCase()] || rawMIME;
    for (const key of ['file','src','url']) {
      const url = value[key];
      if (typeof url === 'string' && (mediaSuffix.test(url) || videoMIME.test(mime))) add(url,{source,mime:videoMIME.test(mime) ? mime : '',mediaHint:true},base);
    }
    // Traverse bounded objects to find nested sources and VideoObjects, but do not treat
    // unrelated endpoint/thumbnail/embedUrl values as media files.
    for (const child of Object.values(value)) if (child && typeof child === 'object') walkJSON(child,base,depth+1,source);
  };
  const parseJSON = (text,base) => {
    if (!text || typeof text !== 'string') return;
    if (text.length > JSON_LIMIT || (jsonBytes += text.length) > JSON_LIMIT) { notices.add('動画設定の取得量を制限しました。'); return; }
    try { walkJSON(JSON.parse(text),base); } catch { /* Malformed JSON is not executable input. */ }
  };
  const walkDocument = doc => {
    if (seenDocs.has(doc)) return;
    seenDocs.add(doc);
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
        if (tag === 'VIDEO') {
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
        if (tag === 'SCRIPT' && /^application\/(?:ld\+)?json(?:\s*;|$)/i.test(el.getAttribute('type') || '')) parseJSON(el.textContent,base);
        // Video-specific lazy attributes can also live on a player container.
        if (tag !== 'VIDEO') for (const key of ['data-video-src','data-hls','data-dash']) {
          const raw = el.getAttribute(key); if (raw) add(raw,{source:'player-config',mediaHint:true,mime:key === 'data-hls' ? 'application/vnd.apple.mpegurl' : key === 'data-dash' ? 'application/dash+xml' : ''},base);
        }
        if (el.shadowRoot) walk(el.shadowRoot);
        if (tag === 'IFRAME' || tag === 'FRAME') {
          for (const key of ['src','data-src']) addFrame(el.getAttribute(key),base);
          try { const child = el.contentDocument; if (child) walkDocument(child); }
          catch { /* Other origins are returned separately for explicit permission. */ }
        }
      }
    };
    walk(doc);
    try {
      for (const entry of (view?.performance?.getEntriesByType('resource') || []).slice(-1000)) {
        if (mediaSuffix.test(entry.name) || entry.initiatorType === 'video') add(entry.name,{source:'loaded-resource',mediaHint:entry.initiatorType === 'video'},doc.baseURI);
      }
    } catch { /* A detached frame may lose its performance context. */ }
  };
  walkDocument(document);
  return {items:[...items.values()],frames:[...frames.values()],notices:[...notices]};
}
