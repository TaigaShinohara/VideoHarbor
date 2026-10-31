import { originalExtension } from './output-format.js';
export function sanitizePart(value, fallback = 'untitled') {
  const clean = String(value ?? '').normalize('NFKC')
    .replace(/[\x00-\x1f\x7f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/\s+/g, ' ').replace(/^\.+|[. ]+$/g, '').trim().slice(0, 90);
  const safe = clean || fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe) ? `_${safe}` : safe;
}
export function mediaType(url, mime = '') {
  const kind = mediaKind(url,mime);
  return kind === 'hls' || kind === 'dash' ? 'stream' : kind;
}
export function mediaKind(url, mime = '') {
  let path = ''; try { path = new URL(url).pathname.toLowerCase(); } catch { return 'unknown'; }
  if (/^blob:/i.test(url)) return 'blob';
  if (/\.m3u8$/.test(path) || /mpegurl/i.test(mime)) return 'hls';
  if (/\.mpd$/.test(path) || /dash\+xml/i.test(mime)) return 'dash';
  if (/\.(mp4|webm|mov|m4v|ogv|ogg)$/.test(path) || /^video\//i.test(mime)) return 'direct';
  return 'unknown';
}
export function isImageResource(url, mime = '') {
  if (/^image\//i.test(mime.trim())) return true;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    let path = parsed.pathname;
    try { path = decodeURIComponent(path); } catch { /* Match the literal path if encoding is malformed. */ }
    return /\.(avif|bmp|gif|heic|heif|ico|jpe?g|jfif|png|svg|tiff?|webp)$/i.test(path);
  } catch { return false; }
}
export function allowedURL(value, kind) {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.hostname.includes('*')) return false;
    if (u.protocol === 'http:' || u.protocol === 'https:') return true;
    return kind === 'images' && /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml|bmp|x-icon);/i.test(value)
      && value.length <= 131072;
  } catch { return false; }
}
export function extensionOf(url, kind) {
  const d = /^data:image\/([\w+.-]+)/i.exec(url);
  if (d) return ({'svg+xml':'svg', jpeg:'jpg', 'x-icon':'ico'})[d[1]] || d[1];
  try {
    const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
    const good = kind === 'images' ? ['jpg','jpeg','png','gif','webp','avif','svg','bmp','ico'] : ['mp4','webm','mov','m4v','ogv','ogg'];
    if (m && good.includes(m[1].toLowerCase())) return m[1].toLowerCase();
  } catch { /* use a neutral suffix for URLs without format information */ }
  return kind === 'images' ? 'img' : 'video';
}
export function fileLabel(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'data:') return '埋め込み画像';
    if (u.protocol === 'blob:') return 'ページ内の動画データ';
    return decodeURIComponent(u.pathname.split('/').pop() || u.hostname).slice(0, 120);
  } catch { return 'メディア'; }
}
export function downloadName(item, title, index, kind, outputFormat='auto') {
  const ext = outputFormat==='mp4' && kind==='videos' ? 'mp4' : kind==='videos' ? originalExtension(item) || extensionOf(item.url,kind) : extensionOf(item.url,kind);
  const raw = fileLabel(item.url).replace(/\.[a-z0-9]{2,5}$/i, '');
  return `${kind === 'images' ? 'ImageCrate' : 'VideoHarbor'}/${sanitizePart(title)}/${String(index + 1).padStart(3,'0')}_${sanitizePart(raw, 'media')}.${ext}`;
}
export function matchesImage(item, filters) {
  const q = (filters.query || '').toLocaleLowerCase();
  return (!q || `${fileLabel(item.url)} ${item.alt || ''} ${item.url}`.toLocaleLowerCase().includes(q))
    && (!filters.width || item.width >= filters.width)
    && (!filters.height || item.height >= filters.height)
    && (!filters.type || extensionOf(item.url, 'images') === filters.type);
}
export function mergeItems(previous, incoming) {
  const map = new Map(previous.map(i => [i.url, i]));
  const confidence = {video:5,'player-config':4,metadata:3,embed:3,'loaded-resource':2,link:1};
  for (const item of incoming) {
    const old = map.get(item.url);
    const merged = {...old,...item};
    if (old) {
      for (const key of ['width','height']) if (key in old || key in item) merged[key] = Math.max(old[key] || 0,item[key] || 0);
      if (old.mediaHint) merged.mediaHint = true;
      if (old.mime && (!item.mime || (confidence[old.source] || 0) > (confidence[item.source] || 0))) merged.mime = old.mime;
      if ((confidence[old.source] || 0) > (confidence[item.source] || 0)) merged.source = old.source;
    }
    map.set(item.url,merged);
  }
  return [...map.values()];
}
export function summarizeJobs(jobs = []) {
  const count = {total:jobs.length, complete:0, interrupted:0, active:0};
  for (const job of jobs) {
    if (job.status === 'complete') count.complete++;
    else if (job.status === 'interrupted') count.interrupted++;
    else count.active++;
  }
  return count;
}
export function formatBytes(n = 0) {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${Math.round(n / 1024)} KiB`;
}
export function publicError(error) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'AbortError') return '操作がキャンセルされたか、許可されませんでした。';
  if (name === 'NotFoundError') return '対象が見つかりません。元のページを開き直してください。';
  // Browser errors may contain signed media URLs. Keep those out of UI reports.
  return String(error?.message || error || '処理に失敗しました。').replace(/(?:https?|blob|data):\S+/g,'[URL]').slice(0,180);
}
