const MAX_BLOCK_BYTES = 192 * 1024;
const CONNECTION_ERROR = '元ページとの接続が終了しました。取得済みデータを保存できますが、再生できるか確認してください。';

function safeMessage(error, fallback = CONNECTION_ERROR) {
  const text = typeof error === 'string' ? error : error?.message;
  // Errors from the injected source have fixed text. Never reflect a URL supplied by Chrome.
  return typeof text === 'string' && !/(?:https?|blob|data):/i.test(text) ? text.slice(0, 240) : fallback;
}

class VideoCapture extends EventTarget {
  constructor({send, reference, audio, mimeType}) {
    super();
    this.send = send; this.reference = reference; this.requestedAudio = audio; this.mimeType = mimeType;
    this.token = crypto.randomUUID(); this.state = 'inactive'; this.available = false; this.audio = false;
    this.target = '選んだ動画'; this.reason = ''; this.audioReason = ''; this.ack = 0;
    this.closed = false; this.started = false; this.stopped = false; this.failure = '';
    this.chain = Promise.resolve(); this.timer = null; this.polling = false; this.nextDelay = null;
    this.prepared = false; this.drainTimer = null;
  }
  request(command, extra = {}) {
    const task = this.chain.then(async () => {
      if (this.closed && command !== 'close') throw new Error(CONNECTION_ERROR);
      let timer;
      // executeScript can stall on a discarded/frozen frame; do not strand Stop or cancel.
      const response = await Promise.race([
        this.send('video-control', {command, reference: this.reference, token: this.token, ...extra}),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(CONNECTION_ERROR)), 6000); }),
      ]).finally(() => clearTimeout(timer));
      if (!response || response.error) throw new Error(safeMessage(response?.error));
      return response;
    });
    this.chain = task.catch(() => {});
    return task;
  }
  update(response) {
    this.available = Boolean(response.available);
    this.audio = Boolean(response.audio);
    this.target = response.target || this.target;
    this.mimeType = response.mimeType || this.mimeType;
    this.reason = response.reason || this.reason;
    this.audioReason = response.audioReason || this.audioReason;
    // Browser state becomes inactive before its final dataavailable/stop events.
    // Keep the adapter recording until every encoded byte has been acknowledged.
    if (response.state !== 'inactive' || !this.started || this.stopped) this.state = response.state;
    if (response.failure) this.fail(safeMessage(response.failure), false);
  }
  fail(message, terminal) {
    this.failure ||= message;
    this.available = false;
    if ((this.prepared || this.started) && !this.errorEmitted) {
      this.errorEmitted = true;
      const event = new Event('error'); event.error = new Error(this.failure); this.dispatchEvent(event);
    }
    if (terminal) this.finish();
  }
  finish() {
    if (this.stopped) return;
    this.stopped = true; this.state = 'inactive'; this.available = false;
    clearTimeout(this.timer); this.timer = null; clearTimeout(this.drainTimer); this.drainTimer = null;
    if (this.prepared || this.started) this.dispatchEvent(new Event('stop'));
  }
  schedule(delay = 150) {
    if (this.closed || this.stopped) return;
    if (this.polling) { this.nextDelay = Math.min(this.nextDelay ?? Infinity, delay); return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.poll(); }, delay);
  }
  async poll() {
    if (this.closed || this.stopped || this.polling) return;
    clearTimeout(this.timer); this.timer = null; this.polling = true; this.nextDelay = null;
    try {
      const response = await this.request('poll', {ack: this.ack});
      if (this.closed || this.stopped) return;
      // Deliver bytes before dispatching failures that can cause controller finalization.
      if (response.chunk) {
        const {sequence, size, base64} = response.chunk;
        if (!Number.isSafeInteger(sequence) || sequence !== this.ack + 1 || !Number.isSafeInteger(size)
          || size < 1 || size > MAX_BLOCK_BYTES || typeof base64 !== 'string'
          || base64.length !== 4 * Math.ceil(size / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
          throw new Error('動画データの順序または容量を確認できませんでした。');
        }
        const raw = atob(base64);
        if (raw.length !== size) throw new Error('動画データの長さを確認できませんでした。');
        const bytes = new Uint8Array(size);
        for (let index = 0; index < size; index++) bytes[index] = raw.charCodeAt(index);
        const event = new Event('dataavailable'); event.data = new Blob([bytes], {type: this.mimeType});
        this.dispatchEvent(event); this.ack = sequence;
      }
      this.update(response);
      if (response.state === 'inactive' && this.started) this.beginDrain();
      if (response.done) {
        if (!this.started) this.failure ||= response.failure || '録画を開始する前に動画の取得が終了しました。';
        this.finish(); return;
      }
      this.schedule(response.chunk ? 0 : 150);
    } catch (error) {
      if (!this.closed) this.fail(safeMessage(error), true);
    } finally {
      this.polling = false;
      if (!this.closed && !this.stopped) this.schedule(this.nextDelay ?? 150);
      this.nextDelay = null;
    }
  }
  beginDrain() {
    if (this.drainTimer || this.stopped || this.closed) return;
    // The source holds at most 8 MiB (43 blocks). Even a missing browser stop
    // event must settle finalization and preserve the already delivered bytes.
    this.drainTimer = setTimeout(() => {
      if (!this.closed && !this.stopped) this.fail('動画の終了データを確認できませんでした。取得済みデータの再生を確認してください。', true);
    }, 120000);
  }
  async start() {
    if (this.closed || this.started || !this.available || this.stopped || this.failure) throw new Error(this.failure || '選んだ動画を録画できません。');
    // Polling continues while preparing, but queued commands and JavaScript dispatch are ordered.
    const response = await this.request('start');
    if (this.closed || response.state !== 'recording' || response.failure || response.done) {
      throw new Error(safeMessage(response.failure, '動画の録画を開始できませんでした。'));
    }
    this.started = true; this.state = 'recording'; this.update(response); this.schedule(0);
  }
  async pause() {
    if (this.state !== 'recording' || this.stopped) throw new Error('動画の録画を一時停止できませんでした。');
    this.update(await this.request('pause'));
    if (this.state !== 'paused') throw new Error('動画の録画を一時停止できませんでした。');
  }
  async resume() {
    if (this.state !== 'paused' || this.stopped) throw new Error('動画の録画を再開できませんでした。');
    this.update(await this.request('resume'));
    if (this.state !== 'recording') throw new Error('動画の録画を再開できませんでした。');
  }
  async stop() {
    if (this.closed || this.stopped) return;
    this.beginDrain();
    try { this.update(await this.request('stop')); this.schedule(0); }
    catch (error) { if (!this.closed) this.fail(safeMessage(error), true); }
  }
  async close() {
    if (this.closed) return;
    this.closed = true; this.available = false; clearTimeout(this.timer); this.timer = null;
    clearTimeout(this.drainTimer); this.drainTimer = null;
    try { await this.request('close'); } catch { /* Source lease also stops a disconnected recording. */ }
    this.finish();
  }
}

export async function prepareVideoCapture(options) {
  const capture = new VideoCapture(options);
  try {
    const response = await capture.request('prepare', {audio: Boolean(options.audio), mimeType: options.mimeType});
    capture.update(response);
    if (!capture.available) throw new Error(capture.failure || '選んだ動画を取得できませんでした。');
    capture.prepared = true; capture.schedule();
    return capture;
  } catch (error) {
    await capture.close();
    throw Object.assign(new Error(safeMessage(error)), {name: 'CaptureControlError'});
  }
}
