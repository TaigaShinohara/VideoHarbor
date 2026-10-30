// Injected as a self-contained function into the authorized source document.
export function collect() {

  const items = new Map();
  const notices = new Set();
  const seenDocs = new Set();
  let visited = 0, dataBytes = 0;
  const LIMIT = 500, NODE_LIMIT = 12000;
  const add = (raw, metadata = {}, base = document.baseURI) => {
    if (!raw || items.size >= LIMIT) { if (items.size >= LIMIT) notices.add('候補は500件までです。表示範囲を絞って再取得してください。'); return; }
    try {
      const u = new URL(raw, base); u.hash = '';
      const url = u.href;
      if (u.username || u.password || url.length > 131072) return;
      const supported = /^https?:$/.test(u.protocol) || ("videos" === 'images' && /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml|bmp|x-icon);/i.test(url));
      if ("videos" === 'images' && !supported) { if(u.protocol === 'blob:') notices.add('ページ内blob画像は今回の直接保存に未対応です。'); return; }
      if ("videos" === 'videos' && !supported && u.protocol !== 'blob:') return;
      if (u.protocol === 'data:' && !items.has(url)) { dataBytes += url.length; if (dataBytes > 524288) { notices.add('埋め込み画像の取得量を制限しました。'); return; } }
      const old = items.get(url);
      items.set(url, {...old, url, ...metadata, width: Math.max(old?.width || 0, metadata.width || 0), height: Math.max(old?.height || 0, metadata.height || 0)});
    } catch { /* ignore malformed/unusable page values */ }
  };
  const walkDocument = doc => {
    if (seenDocs.has(doc)) return;
    seenDocs.add(doc);
    const view = doc.defaultView;
    const walk = root => {
      for (const el of root.querySelectorAll('*')) {
        if (++visited > NODE_LIMIT) { notices.add('要素数が多いため取得を12000要素に制限しました。'); return; }
        const base = el.baseURI || doc.baseURI;

        if (el.tagName === 'VIDEO') {
          const meta = {width:el.videoWidth || 0, height:el.videoHeight || 0, source:'video', mime:el.getAttribute('type') || ''};
          add(el.currentSrc || el.getAttribute('src'), meta, base);
          for (const src of el.querySelectorAll('source')) add(src.getAttribute('src'), {...meta,mime:src.type || ''}, base);
        }
        if (el.tagName === 'A' && /\.(mp4|webm|mov|m4v|ogv|ogg|m3u8|mpd)(?:[?#]|$)/i.test(el.href)) add(el.href, {source:'link'}, base);

        if (el.shadowRoot) walk(el.shadowRoot);
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          try { const child = el.contentDocument; if(child) walkDocument(child); else notices.add('別ドメインの埋め込み内は取得できません。'); }
          catch { notices.add('別ドメインの埋め込み内は取得できません。'); }
        }
      }
    };
    walk(doc);

    for (const entry of view.performance.getEntriesByType('resource').slice(-1000)) {
      if (/\.(mp4|webm|mov|m4v|ogv|ogg|m3u8|mpd)(?:[?#]|$)/i.test(entry.name)) add(entry.name, {source:'loaded-resource'}, doc.baseURI);
    }

  };
  walkDocument(document);
  return {items:[...items.values()], notices:[...notices]};

}
