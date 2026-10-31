// Bounded HLS VOD planning and fetching. Separate fMP4 tracks are handed to
// stream-assembly.js. No decryption, transcoding or playback capture. RFC 8216.
import {createMediaBudget,validateMediaSegment} from './media-validation.js';
const MANIFEST_LIMIT = 1024 * 1024;
const SEGMENT_LIMIT = 5000;
const DEPTH_LIMIT = 5;
const DOWNLOAD_LIMIT = 256 * 1024 * 1024;
// Relative paths can repeat a long base thousands of times. Bound expanded
// URL storage while constructing each track/master; two tracks total <= 8 MiB.
const PLAN_URL_LIMIT = 4 * 1024 * 1024;
const error = message => new Error(message);
function urlBudget() {
  let size = 0;
  return url => { size += url.length; if (size > PLAN_URL_LIMIT) throw error('HLSの配信URLの合計が大きすぎます（各リスト最大4 MiB）。'); return url; };
}
// Fallback is allowed only for an explicitly unsupported parsed structure.
// Transport, permission, authentication and malformed-data errors keep their identity.
class UnsupportedHLS extends Error {}
const unsupported = message => new UnsupportedHLS(message);
function abort(signal) { if (signal?.aborted) throw new DOMException('保存を停止しました。', 'AbortError'); }
function resourceURL(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw error('配信URLを読み取れません。元ページから再取得してください。'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hostname.includes('*') || url.href.length > 131072 || /\{\$/.test(value)) {
    throw error('この配信URLの形式には対応していません。録画を試してください。');
  }
  url.hash = '';
  return url.href;
}
function attributes(value) {
  const result = Object.create(null);
  let index = 0;
  while (index < value.length) {
    const match = /^([A-Z0-9-]+)=/.exec(value.slice(index));
    if (!match || Object.hasOwn(result, match[1])) throw error('HLSの属性を読み取れません。');
    index += match[0].length;
    let text;
    if (value[index] === '"') {
      const end = value.indexOf('"', index + 1);
      if (end < 0) throw error('HLSの属性が途中で終わっています。');
      text = value.slice(index + 1, end); index = end + 1;
    } else {
      const end = value.indexOf(',', index);
      text = value.slice(index, end < 0 ? value.length : end); index += text.length;
      if (!text) throw error('HLSの属性が空です。');
    }
    result[match[1]] = text;
    if (index === value.length) break;
    if (value[index++] !== ',' || index === value.length) throw error('HLSの属性の区切りが不正です。');
  }
  return result;
}
function integer(value, positive = false) {
  if (!/^\d+$/.test(value || '')) throw error('HLSの数値が不正です。');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < (positive ? 1 : 0)) throw error('HLSの数値が範囲外です。');
  return n;
}
function byteRange(value, url, previous) {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value);
  if (!match) throw error('HLSの部分取得範囲を読み取れません。');
  const length = integer(match[1], true);
  if (match[2] === undefined && (!previous?.range || previous.url !== url)) {
    throw error('HLSの連続する部分取得範囲が不正です。');
  }
  const start = match[2] === undefined ? previous.range.end + 1 : integer(match[2]);
  const end = start + length - 1;
  if (!Number.isSafeInteger(end)) throw error('HLSの部分取得範囲が大きすぎます。');
  return { start, end };
}
function checkResponse(response, range) {
  try {
    if (!response?.ok) throw error(`配信元から取得できません（HTTP ${Number(response?.status) || 'エラー'}）。元ページで再生して再取得してください。`);
    if (/^(text\/html|application\/(?:json|xml|xhtml\+xml))/i.test(response.headers.get('content-type') || '')) {
      throw error('動画ではない応答が返されました。サイトの認証やアクセス制限を確認してください。');
    }
    if (range) {
      const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(response.headers.get('content-range') || '');
      if (response.status !== 206 || !match || Number(match[1]) !== range.start || Number(match[2]) !== range.end ||
          (match[3] !== '*' && (!Number.isSafeInteger(Number(match[3])) || Number(match[3]) <= range.end))) {
        throw error('配信元が必要な部分取得に応答しませんでした。録画を試してください。');
      }
    } else if (response.status === 206) throw error('動画の一部だけが返されました。保存を中断しました。');
  } catch (cause) {
    // Rejecting headers must also stop the unread response, especially when a
    // server ignores Range and starts sending an entire large resource.
    void response?.body?.cancel().catch(() => {});
    throw cause;
  }
}
async function readBytes(response, maxBytes, signal, onChunk) {
  abort(signal);
  const reader = response.body?.getReader();
  if (!reader) throw error('配信データを読み取れません。');
  const parts = [];
  let bytes = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const declared = response.headers.get('content-length');
    if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw error('保存データが容量上限を超えます。録画または元ファイル保存を試してください。');
    while (true) {
      abort(signal);
      const { value, done } = await reader.read();
      abort(signal);
      if (done) break;
      if (!(value instanceof Uint8Array)) throw error('配信データの形式が不正です。');
      bytes += value.byteLength;
      if (bytes > maxBytes) throw error('保存データが容量上限を超えます。録画または元ファイル保存を試してください。');
      parts.push(value);
      onChunk?.(value.byteLength);
    }
    const result = new Uint8Array(bytes);
    let position = 0;
    for (const part of parts) { result.set(part, position); position += part.byteLength; }
    return result;
  } catch (cause) {
    await reader.cancel().catch(() => {});
    throw cause;
  } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
}
async function manifest(url, fetchResource, signal) {
  abort(signal);
  const response = await fetchResource(url, { signal });
  checkResponse(response);
  const bytes = await readBytes(response, MANIFEST_LIMIT, signal);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw error('HLSの文字コードを読み取れません。'); }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw error('HLS配信リストではありません。元ページで再生して再取得してください。');
  return { lines, url: response.url ? resourceURL(response.url) : url };
}
const COMMON_TAGS = new Set(['EXTM3U', 'EXT-X-VERSION', 'EXT-X-INDEPENDENT-SEGMENTS', 'EXT-X-START']);
const MEDIA_TAGS = new Set(['EXTINF', 'EXT-X-TARGETDURATION', 'EXT-X-MEDIA-SEQUENCE', 'EXT-X-PLAYLIST-TYPE', 'EXT-X-ENDLIST', 'EXT-X-BYTERANGE', 'EXT-X-MAP', 'EXT-X-KEY', 'EXT-X-PROGRAM-DATE-TIME', 'EXT-X-DATERANGE', 'EXT-X-ALLOW-CACHE']);
const MASTER_TAGS = new Set(['EXT-X-STREAM-INF', 'EXT-X-MEDIA', 'EXT-X-I-FRAME-STREAM-INF', 'EXT-X-SESSION-DATA']);
function tagOf(line) { return line.slice(1).split(':', 1)[0]; }
function checkTags(lines) {
  for (const line of lines) {
    if (!line.startsWith('#EXT')) continue;
    const tag = tagOf(line);
    if (tag === 'EXT-X-SESSION-KEY') throw unsupported('暗号化されたHLS配信は保存できません。');
    if (tag === 'EXT-X-DISCONTINUITY' || tag === 'EXT-X-DISCONTINUITY-SEQUENCE') throw unsupported('途中で映像形式や時間軸が変わるHLS配信には未対応です。録画を試してください。');
    if (!COMMON_TAGS.has(tag) && !MEDIA_TAGS.has(tag) && !MASTER_TAGS.has(tag)) throw unsupported('このHLS配信方式には未対応です。録画を試してください。');
  }
}
function parseMaster(lines, base) {
  const groups = lines.filter(line => line.startsWith('#EXT-X-MEDIA:')).map(line => attributes(line.slice(13)));
  const variants = [];
  let pending;
  const keepURL = urlBudget();
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      if (pending) throw error('HLSの画質リストが不正です。');
      pending = attributes(line.slice(18));
      integer(pending.BANDWIDTH, true);
    } else if (!line.startsWith('#')) {
      if (!pending) throw error('HLSの画質リストが不正です。');
      const external = ['VIDEO', 'SUBTITLES'].some(type => pending[type] &&
        (!groups.some(group => group.TYPE === type && group['GROUP-ID'] === pending[type]) ||
         groups.some(group => group.TYPE === type && group['GROUP-ID'] === pending[type] && group.URI)));
      const audio=pending.AUDIO ? groups.filter(group=>group.TYPE==='AUDIO' && group['GROUP-ID']===pending.AUDIO) : [];
      const selectedAudio=audio.find(group=>group.DEFAULT==='YES') || audio.find(group=>group.AUTOSELECT==='YES') || audio[0];
      const muxCodecs=/^(?:avc[13]|hvc1|hev1|av01|vp09|mp4a\.40\.(?:2|5|29)|opus|ac-3|ec-3)(?:\.|$)/i;
      const unsupportedAudioCodec=Boolean(selectedAudio?.URI && pending.CODECS && !pending.CODECS.split(',').every(codec=>muxCodecs.test(codec.trim())));
      if (variants.length >= 500) throw error('HLSの画質候補が多すぎます（最大500件）。');
      variants.push({ url: keepURL(resourceURL(line, base)), attributes: pending, external:external || unsupportedAudioCodec || Boolean(pending.AUDIO && !audio.length),
        audioURL:selectedAudio?.URI ? keepURL(resourceURL(selectedAudio.URI,base)) : undefined,
        audioLanguage:selectedAudio?.LANGUAGE || selectedAudio?.NAME });
      pending = undefined;
    }
  }
  if (pending || !variants.length || variants.length > 500) throw error('HLSの画質リストを読み取れません。');
  const eligible = variants.filter(variant => !variant.external);
  if (!eligible.length) throw unsupported('この映像・字幕の別配信構成には未対応です。録画を試してください。');
  eligible.sort((a, b) => Number(b.attributes.BANDWIDTH) - Number(a.attributes.BANDWIDTH));
  return eligible;
}
function parseMedia(lines, base) {
  if (!lines.includes('#EXT-X-ENDLIST')) throw unsupported('ライブ配信や未完了のHLSは保存できません。録画を試してください。');
  const segments = [];
  const keepURL = urlBudget();
  const append = segment => { keepURL(segment.url); segments.push(segment); };
  let pendingDuration, pendingRange, previous, map, duration = 0;
  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-KEY:')) {
      const key = attributes(line.slice(11));
      if (key.METHOD !== 'NONE' || Object.keys(key).length !== 1) throw unsupported('暗号化されたHLS配信は保存できません。');
    } else if (line.startsWith('#EXTINF:')) {
      if (pendingDuration !== undefined) throw error('HLSの動画区間が不正です。');
      const text = line.slice(8).split(',')[0];
      if (!/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text)) || Number(text) <= 0) throw error('HLSの区間長が不正です。');
      pendingDuration = Number(text);
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      if (pendingRange !== undefined) throw error('HLSの部分取得範囲が重複しています。');
      pendingRange = line.slice(17);
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attr = attributes(line.slice(11));
      if (!attr.URI) throw error('HLSの初期化データが不明です。');
      const url = resourceURL(attr.URI, base);
      // An initialization range needs an explicit offset; no prior media
      // segment can define its implicit offset at the head of this file.
      if (attr.BYTERANGE && !/@\d+$/.test(attr.BYTERANGE)) throw error('HLS初期化データの取得開始位置が不明です。');
      const next = { url, ...(attr.BYTERANGE ? { range: byteRange(attr.BYTERANGE, url) } : {}), init: true };
      if (map && JSON.stringify(map) !== JSON.stringify(next)) throw unsupported('初期化データが途中で変わるHLS配信には未対応です。録画を試してください。');
      if (!map && segments.length) throw unsupported('初期化データが途中から始まるHLS配信には未対応です。');
      if (!map) append(next);
      map = next;
    } else if (!line.startsWith('#')) {
      if (pendingDuration === undefined) throw error('HLSの動画区間の情報がありません。');
      const url = resourceURL(line, base);
      const segment = { url, ...(pendingRange === undefined ? {} : { range: byteRange(pendingRange, url, previous) }) };
      append(segment); previous = segment;
      duration += pendingDuration; pendingDuration = undefined; pendingRange = undefined;
      if (segments.length > SEGMENT_LIMIT + Number(Boolean(map))) throw unsupported('HLSの動画区間が多すぎます（最大5000区間）。');
    }
  }
  if (pendingDuration !== undefined || pendingRange !== undefined || !segments.some(segment => !segment.init)) throw error('HLSの動画区間が空か途中で終わっています。');
  return { segments, extension: map ? 'mp4' : 'ts', mime: map ? 'video/mp4' : 'video/mp2t', duration, playlistURL: base };
}
export async function prepareHLS(url, fetchResource, { signal, _audio = false } = {}) {
  let fetched = 0;
  const resolve = async (current, depth, ancestors, isAudio) => {
    abort(signal);
    if (ancestors.has(current)) throw unsupported('HLS配信リストが循環しています。');
    if (depth >= DEPTH_LIMIT) throw unsupported('HLS配信リストの階層が深すぎます。');
    // A branching master cannot turn a bounded depth into unbounded network work.
    if (++fetched > 64) throw error('HLS配信リストの確認数が多すぎます（最大64件）。');
    const result = await manifest(current, fetchResource, signal);
    if (ancestors.has(result.url)) throw unsupported('HLS配信リストが循環しています。');
    const path = new Set(ancestors); path.add(current); path.add(result.url);
    checkTags(result.lines);
    const master = result.lines.some(line => line.startsWith('#EXT-X-STREAM-INF:'));
    const media = result.lines.some(line => MEDIA_TAGS.has(tagOf(line)));
    if (master && media) throw error('HLSの画質リストと動画区間が混在しています。');
    if (!master) {
      if (result.lines.some(line => MASTER_TAGS.has(tagOf(line)))) throw unsupported('通常の動画を含まないHLS配信リストです。');
      return {...parseMedia(result.lines, result.url), fromMaster:false};
    }
    const variants = parseMaster(result.lines, result.url);
    let firstUnsupported;
    for (const variant of variants) {
      abort(signal);
      try {
        const plan = await resolve(variant.url, depth + 1, path, isAudio);
        plan.fromMaster = true;
        // A nested master may give more specific metadata for the selected leaf.
        plan.bandwidth ??= Number(variant.attributes.BANDWIDTH);
        if (variant.attributes.RESOLUTION) plan.resolution ??= variant.attributes.RESOLUTION;
        if (!variant.audioURL) return plan;
        if (isAudio) throw unsupported('複数階層の別音声HLSには未対応です。');
        if (plan.tracks) {
          if (plan.audioSourceURL === variant.audioURL) return {...plan,audioLanguage:variant.audioLanguage || plan.audioLanguage};
          throw unsupported('複数階層の別音声HLSには未対応です。');
        }
        // TS plus separately packed AAC is a known unsupported combination; do
        // not request its audio when a lower self-contained variant can work.
        if (plan.extension !== 'mp4') throw unsupported('別音声HLSの合成はMP4配信に対応しています。TSやAACの別配信は録画を試してください。');
        const audio = await resolve(variant.audioURL, depth + 1, path, true);
        if (audio.extension !== 'mp4' || audio.tracks) throw unsupported('別音声HLSの合成はMP4配信に対応しています。TSやAACの別配信は録画を試してください。');
        if (Math.abs(plan.duration - audio.duration) > 1) throw unsupported('映像と別音声の長さが一致しません。保存を中断しました。');
        const segments = [...plan.segments, ...audio.segments];
        if (segments.filter(segment => !segment.init).length > SEGMENT_LIMIT) throw unsupported('映像と音声を合わせたHLSの動画区間が多すぎます（最大5000区間）。');
        return {...plan, segments, tracks:[{...plan,type:'video'},{...audio,type:'audio'}], audioLanguage:variant.audioLanguage, audioSourceURL:variant.audioURL};
      } catch (cause) {
        if (!(cause instanceof UnsupportedHLS)) throw cause;
        firstUnsupported ||= cause;
      }
    }
    throw firstUnsupported || unsupported('対応するHLSの画質候補がありません。');
  };
  return resolve(resourceURL(url), 0, new Set(), _audio);
}

export async function downloadHLSParts(plan, fetchResource, { signal, onProgress, maxBytes = DOWNLOAD_LIMIT,
  structureBudget=createMediaBudget(),validateSegment=validateMediaSegment } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DOWNLOAD_LIMIT) throw error('HLS保存の容量上限が不正です。');
  if (!['ts', 'mp4'].includes(plan?.extension) || !Array.isArray(plan.segments) || !plan.segments.length || plan.segments.length > SEGMENT_LIMIT + 1) throw error('HLSの保存計画が不正です。');
  if (plan.extension === 'mp4' && (!plan.segments[0].init || plan.segments.slice(1).some(segment => segment.init))) throw error('MP4の初期化データが不正です。');
  const parts = [];
  let bytesReceived = 0, completed = 0;
  onProgress?.({ bytesReceived, completed, total: plan.segments.length });
  for (const segment of plan.segments) {
    abort(signal);
    const url = resourceURL(segment.url);
    if (segment.range && (!Number.isSafeInteger(segment.range.start) || !Number.isSafeInteger(segment.range.end) || segment.range.start < 0 || segment.range.end < segment.range.start)) throw error('HLSの部分取得範囲が不正です。');
    const response = await fetchResource(url, { signal, ...(segment.range ? { range: segment.range } : {}) });
    checkResponse(response, segment.range);
    const bytes = await readBytes(response, maxBytes - bytesReceived, signal, count => {
      bytesReceived += count;
      onProgress?.({ bytesReceived, completed, total: plan.segments.length });
    });
    if (segment.range && bytes.length !== segment.range.end - segment.range.start + 1) throw error('部分取得した動画データの長さが一致しません。');
    const checked=await validateSegment(bytes,plan.extension,segment.init,structureBudget);
    abort(signal);
    parts.push(checked); completed++;
    onProgress?.({ bytesReceived, completed, total: plan.segments.length });
  }
  abort(signal);
  return parts;
}
export async function downloadHLS(plan,fetchResource,options={}) {
  const parts=await downloadHLSParts(plan,fetchResource,options);
  return new Blob(parts,{type:plan.extension==='mp4' ? 'video/mp4' : 'video/mp2t'});
}
