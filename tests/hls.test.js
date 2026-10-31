import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareHLS, downloadHLS } from '../extension/hls.js';

const base = 'https://media.test/path/list.m3u8';
const vod = (...lines) => ['#EXTM3U', '#EXT-X-TARGETDURATION:10', ...lines, '#EXT-X-ENDLIST'].join('\n');
const one = vod('#EXTINF:2.5,', 'first.ts');
const packet = (fill = 0) => { const bytes = new Uint8Array(188).fill(fill); bytes[0] = 0x47; return bytes; };
function box(name, payload = new Uint8Array()) {
  const bytes = new Uint8Array(8 + payload.length);
  new DataView(bytes.buffer).setUint32(0, bytes.length);
  bytes.set([...name].map(char => char.charCodeAt(0)), 4); bytes.set(payload, 8); return bytes;
}
const concat = (...parts) => new Uint8Array(parts.flatMap(part => [...part]));
const init = concat(box('ftyp'), box('moov'));
const fragment = concat(box('styp'), box('moof'), box('mdat', new Uint8Array([1, 2, 3])));
function resources(entries) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, ...options });
    assert.ok(Object.hasOwn(entries, url), `Unexpected request ${url}`);
    const entry = entries[url];
    if (entry instanceof Error) throw entry;
    if (typeof entry === 'function') return entry(options);
    if (entry instanceof Response) return entry;
    return new Response(entry);
  };
  return { fetch, calls };
}

test('HLS: finite TS playlists resolve relative URLs and assemble bytes in playlist order', async () => {
  const h = resources({ [base]: vod('#EXTINF:2.5,first', 'first.ts', '#EXTINF:1,last', '../last.ts'),
    'https://media.test/path/first.ts': packet(1), 'https://media.test/last.ts': packet(2) });
  const plan = await prepareHLS(base, h.fetch);
  assert.equal(plan.extension, 'ts'); assert.equal(plan.mime, 'video/mp2t'); assert.equal(plan.duration, 3.5);
  assert.equal(plan.playlistURL, base);
  const progress = [];
  const blob = await downloadHLS(plan, h.fetch, { onProgress: value => progress.push(value) });
  assert.equal(blob.type, 'video/mp2t'); assert.equal(blob.size, 376);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), concat(packet(1), packet(2)));
  assert.deepEqual(progress.at(-1), { bytesReceived: 376, completed: 2, total: 2 });
});

test('HLS: selects highest bandwidth self-contained variant, preserving commas in CODECS', async () => {
  const h = resources({ [base]: ['#EXTM3U', '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="audio.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=4000,AUDIO="audio"', 'external.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.4d401f,mp4a.40.2"', 'low.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000,RESOLUTION=1280x720', 'high.m3u8'].join('\n'),
  'https://media.test/path/high.m3u8': one });
  const plan = await prepareHLS(base, h.fetch);
  assert.equal(plan.bandwidth, 2000); assert.equal(plan.resolution, '1280x720');
  assert.equal(plan.playlistURL, 'https://media.test/path/high.m3u8');
  assert.equal(h.calls.length, 2);
});

test('HLS: a declared in-band audio group does not require a separate audio file', async () => {
  const h = resources({ [base]: '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="main"\n#EXT-X-STREAM-INF:BANDWIDTH=1,AUDIO="a"\nchild.m3u8',
    'https://media.test/path/child.m3u8': one });
  assert.equal((await prepareHLS(base, h.fetch)).extension, 'ts');
});

test('HLS: external audio, video or subtitles are rejected rather than dropped', async () => {
  for (const type of ['AUDIO', 'VIDEO', 'SUBTITLES']) {
    const h = resources({ [base]: `#EXTM3U\n#EXT-X-MEDIA:TYPE=${type},GROUP-ID="external",URI="track.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1,${type}="external"\nchild.m3u8` });
    await assert.rejects(prepareHLS(base, h.fetch), /別配信/);
    assert.equal(h.calls.length, 1);
  }
});

test('HLS: fMP4 writes one init section followed by validated fragments', async () => {
  const h = resources({ [base]: vod('#EXT-X-MAP:URI="init.mp4"', '#EXTINF:1,', 'one.m4s', '#EXTINF:1,', 'two.m4s'),
    'https://media.test/path/init.mp4': init, 'https://media.test/path/one.m4s': fragment, 'https://media.test/path/two.m4s': fragment });
  const plan = await prepareHLS(base, h.fetch);
  assert.equal(plan.extension, 'mp4'); assert.equal(plan.segments[0].init, true);
  assert.deepEqual(new Uint8Array(await (await downloadHLS(plan, h.fetch)).arrayBuffer()), concat(init, fragment, fragment));
});

test('HLS: explicit and implicit ranges request exactly the specified bytes', async () => {
  const part = url => ({ range }) => new Response(packet(range.start ? 2 : 1), { status: 206,
    headers: { 'Content-Range': `bytes ${range.start}-${range.end}/376` } });
  const h = resources({ [base]: vod('#EXTINF:1,', '#EXT-X-BYTERANGE:188@0', 'parts.ts', '#EXTINF:1,', '#EXT-X-BYTERANGE:188', 'parts.ts'),
    'https://media.test/path/parts.ts': part() });
  const plan = await prepareHLS(base, h.fetch);
  assert.deepEqual(plan.segments.map(part => part.range), [{ start: 0, end: 187 }, { start: 188, end: 375 }]);
  assert.equal((await downloadHLS(plan, h.fetch)).size, 376);
  assert.deepEqual(h.calls.slice(1).map(call => call.range), [{ start: 0, end: 187 }, { start: 188, end: 375 }]);
});

test('HLS: init ranges are distinct from implicit media range offset history', async () => {
  const h = resources({ [base]: vod('#EXT-X-MAP:URI="parts.mp4",BYTERANGE="16@0"', '#EXTINF:1,', '#EXT-X-BYTERANGE:27@16', 'parts.mp4'),
    'https://media.test/path/parts.mp4': ({ range }) => new Response(range.start ? fragment : init, { status: 206,
      headers: { 'Content-Range': `bytes ${range.start}-${range.end}/43` } }) });
  const plan = await prepareHLS(base, h.fetch);
  assert.equal((await downloadHLS(plan, h.fetch)).size, 43);
  const bad = resources({ [base]: vod('#EXT-X-MAP:URI="parts.mp4",BYTERANGE="16@0"', '#EXTINF:1,', '#EXT-X-BYTERANGE:27', 'parts.mp4') });
  await assert.rejects(prepareHLS(base, bad.fetch), /部分取得範囲が不正/);
});

test('HLS: implicit ranges require an immediately preceding ranged segment of the same resource', async () => {
  for (const lines of [ ['#EXTINF:1,', '#EXT-X-BYTERANGE:188', 'parts.ts'],
    ['#EXTINF:1,', '#EXT-X-BYTERANGE:188@0', 'one.ts', '#EXTINF:1,', '#EXT-X-BYTERANGE:188', 'two.ts'],
    ['#EXTINF:1,', 'parts.ts', '#EXTINF:1,', '#EXT-X-BYTERANGE:188', 'parts.ts'] ]) {
    await assert.rejects(prepareHLS(base, resources({ [base]: vod(...lines) }).fetch), /部分取得範囲が不正/);
  }
});

test('HLS: encryption, live, discontinuities and unsupported partial streams fail explicitly', async () => {
  const cases = [ ['#EXTM3U\n#EXTINF:1,\na.ts', /ライブ/],
    [vod('#EXT-X-KEY:METHOD=AES-128,URI="key"', '#EXTINF:1,', 'a.ts'), /暗号化/],
    [vod('#EXT-X-KEY:METHOD=SAMPLE-AES', '#EXTINF:1,', 'a.ts'), /暗号化/],
    [vod('#EXT-X-DISCONTINUITY', '#EXTINF:1,', 'a.ts'), /時間軸/],
    [vod('#EXT-X-PART:DURATION=1,URI="a.ts"', '#EXTINF:1,', 'a.ts'), /未対応/],
    [vod('#EXT-X-GAP', '#EXTINF:1,', 'a.ts'), /未対応/],
    ['#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=AES-128,URI="key"\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8', /暗号化/] ];
  for (const [text, expected] of cases) await assert.rejects(prepareHLS(base, resources({ [base]: text }).fetch), expected);
});

test('HLS: no-encryption declaration remains accepted', async () => {
  const plan = await prepareHLS(base, resources({ [base]: vod('#EXT-X-KEY:METHOD=NONE', '#EXTINF:1,', 'a.ts') }).fetch);
  assert.equal(plan.segments.length, 1);
});

test('HLS: malformed, mixed and unsafe playlists are never downloaded', async () => {
  const cases = [ 'not HLS', vod('#EXTINF:1,', 'file:///etc/passwd'), vod('#EXTINF:1,', 'https://u:p@media.test/a.ts'),
    vod('#EXTINF:1,', 'https://*/a.ts'), vod('#EXTINF:1,', 'https://*.cdn.test/a.ts'),
    vod('#EXTINF:1,', '{$server}/a.ts'), vod('#EXTINF:1,'), vod('#EXTINF:NaN,', 'a.ts'),
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST',
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,BANDWIDTH=2\na.m3u8',
    vod('#EXT-X-MAP:URI="init.mp4"', '#EXTINF:1,', 'a.m4s', '#EXT-X-MAP:URI="other.mp4"', '#EXTINF:1,', 'b.m4s') ];
  for (const text of cases) await assert.rejects(prepareHLS(base, resources({ [base]: text }).fetch));
});

test('HLS: cycles, deep manifests, oversized manifests and too many segments are bounded', async () => {
  const recursive = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlist.m3u8';
  await assert.rejects(prepareHLS(base, resources({ [base]: recursive }).fetch), /循環/);
  let count = 0;
  await assert.rejects(prepareHLS(base, async () => { count++; return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlist${count}.m3u8`); }), /深すぎ/);
  assert.equal(count, 5);
  await assert.rejects(prepareHLS(base, resources({ [base]: '#EXTM3U\n#' + 'x'.repeat(1024 * 1024) }).fetch), /容量上限/);
  const many = vod(...Array.from({ length: 5001 }, (_, i) => `#EXTINF:1,\n${i}.ts`));
  await assert.rejects(prepareHLS(base, resources({ [base]: many }).fetch), /5000区間/);
});

test('HLS: redirected playlist URLs are used as the relative base', async () => {
  const response = new Response(one);
  Object.defineProperty(response, 'url', { value: 'https://cdn.test/final/playlist.m3u8' });
  const plan = await prepareHLS(base, resources({ [base]: response }).fetch);
  assert.equal(plan.segments[0].url, 'https://cdn.test/final/first.ts');
});

test('HLS: caller permission errors propagate unchanged', async () => {
  const permissionError = Object.assign(new Error('permission'), { origins: ['https://media.test/*'] });
  await assert.rejects(prepareHLS(base, async () => { throw permissionError; }), cause => cause === permissionError);
});

test('HLS: HTTP and HTML failures never become media files', async () => {
  await assert.rejects(prepareHLS(base, async () => new Response('denied', { status: 403 })), /HTTP 403/);
  const plan = await prepareHLS(base, resources({ [base]: one }).fetch);
  for (const response of [new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }), new Response('<html>login</html>'), new Response()]) {
    await assert.rejects(downloadHLS(plan, async () => response));
  }
});

test('HLS: byte-range responses must match status, offsets and exact payload length', async () => {
  const plan = await prepareHLS(base, resources({ [base]: vod('#EXTINF:1,', '#EXT-X-BYTERANGE:188@0', 'part.ts') }).fetch);
  const responses = [new Response(packet()), new Response(packet(), { status: 206, headers: { 'Content-Range': 'bytes 188-375/376' } }),
    new Response(packet(), { status: 206, headers: { 'Content-Range': 'bytes 0-187/100' } }),
    new Response(packet().subarray(0, 187), { status: 206, headers: { 'Content-Range': 'bytes 0-187/188' } })];
  for (const response of responses) await assert.rejects(downloadHLS(plan, async () => response), /部分取得/);
});

test('HLS: rejected response headers cancel unread HTTP, HTML and ignored-Range bodies', async () => {
  const ts = await prepareHLS(base, resources({ [base]: one }).fetch);
  const ranged = await prepareHLS(base, resources({ [base]: vod('#EXTINF:1,', '#EXT-X-BYTERANGE:188@0', 'part.ts') }).fetch);
  for (const [plan, options] of [[ts, { status: 403 }], [ts, { headers: { 'Content-Type': 'text/html' } }], [ranged, {}]]) {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    await assert.rejects(downloadHLS(plan, async () => new Response(body, options)));
    assert.equal(cancelled, true, 'an unread rejected body must not continue streaming');
  }
});

test('HLS: TS and MP4 content cannot be mislabeled or mixed', async () => {
  const ts = await prepareHLS(base, resources({ [base]: one }).fetch);
  await assert.rejects(downloadHLS(ts, async () => new Response(fragment)), /TS/);
  const mp4 = await prepareHLS(base, resources({ [base]: vod('#EXT-X-MAP:URI="init.mp4"', '#EXTINF:1,', 'a.m4s') }).fetch);
  let count = 0;
  await assert.rejects(downloadHLS(mp4, async () => new Response(count++ ? packet() : init)), /MP4/);
  count = 0;
  await assert.rejects(downloadHLS(mp4, async () => new Response(count++ ? fragment.subarray(0, fragment.length - 1) : init)), /MP4/);
});

test('HLS: byte limits stop streaming and cancel the reader without returning a partial file', async () => {
  const plan = await prepareHLS(base, resources({ [base]: one }).fetch);
  let cancelled = false;
  const response = new Response(new ReadableStream({ pull(controller) { controller.enqueue(packet()); }, cancel() { cancelled = true; } }));
  await assert.rejects(downloadHLS(plan, async () => response, { maxBytes: 200 }), /容量上限/);
  assert.equal(cancelled, true);
  await assert.rejects(downloadHLS(plan, async () => new Response(packet(), { headers: { 'Content-Length': '1000' } }), { maxBytes: 200 }), /容量上限/);
});

test('HLS: AbortSignal cancels a stalled reader and prevents following requests', async () => {
  const plan = await prepareHLS(base, resources({ [base]: vod('#EXTINF:1,', 'one.ts', '#EXTINF:1,', 'two.ts') }).fetch);
  const controller = new AbortController();
  let calls = 0, cancelled = false, started;
  const reading = new Promise(resolve => { started = resolve; });
  const pending = downloadHLS(plan, async () => {
    calls++; return new Response(new ReadableStream({ start() { started(); }, cancel() { cancelled = true; } }));
  }, { signal: controller.signal });
  await reading; controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true); assert.equal(calls, 1);
  await assert.rejects(prepareHLS(base, async () => { throw new Error('must not fetch'); }, { signal: controller.signal }), { name: 'AbortError' });
});
