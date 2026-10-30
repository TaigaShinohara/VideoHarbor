import test from 'node:test';
import assert from 'node:assert/strict';
import { RecorderController } from '../extension/recorder.js';

class Track extends EventTarget {
  constructor(kind = 'video') { super(); this.kind = kind; this.readyState = 'live'; this.stops = 0; }
  stop() { this.stops++; this.readyState = 'ended'; }
  getSettings() { return { displaySurface: 'window' }; }
  end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')); }
}

function stream(audio = false) {
  const tracks = [new Track(), ...(audio ? [new Track('audio')] : [])];
  return { getTracks: () => tracks, getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio') };
}

class Recorder extends EventTarget {
  static instances = [];
  static failStart = false;
  static isTypeSupported(type) { return type.startsWith('video/webm'); }
  constructor(media, { mimeType }) {
    super(); this.media = media; this.mimeType = mimeType; this.state = 'inactive'; this.stopCount = 0;
    Recorder.instances.push(this);
  }
  start() {
    if (Recorder.failStart) { Recorder.failStart = false; throw new DOMException('no', 'NotSupportedError'); }
    this.state = 'recording';
  }
  chunk(value) {
    const event = new Event('dataavailable');
    Object.defineProperty(event, 'data', { value: new Blob([value]) });
    this.dispatchEvent(event);
  }
  pause() { this.state = 'paused'; }
  resume() { this.state = 'recording'; }
  stop() {
    assert.notEqual(this.state, 'inactive');
    this.stopCount++;
    this.state = 'inactive';
    queueMicrotask(() => { this.chunk('final'); this.dispatchEvent(new Event('stop')); });
  }
}

function harness(t, options = {}) {
  const names = ['navigator', 'MediaRecorder', 'showSaveFilePicker', 'chrome', 'AudioContext', 'performance'];
  const original = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const listeners = new Set();
  const captured = [];
  const calls = [];
  const resultStream = options.media || stream(options.audio);
  const mediaDevices = {
    getDisplayMedia: (constraints) => { calls.push('display'); captured.push(constraints); return Promise.resolve(resultStream); },
    getUserMedia: (constraints) => { calls.push('user'); captured.push(constraints); return Promise.resolve(resultStream); },
  };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices } });
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: Recorder });
  Object.defineProperty(globalThis, 'showSaveFilePicker', { configurable: true, writable: true, value: options.picker });
  let now = 0;
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
  let audioContexts = 0;
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class {
    constructor() { audioContexts++; this.state = 'running'; this.destination = {}; }
    createMediaStreamSource() { return { connect() {} }; }
    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  } });
  const downloads = {
    download: async () => 42,
    search: async () => [{ id: 42, state: 'complete' }],
    onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { downloads } });
  let releases = 0;
  const controller = new RecorderController({ source: { tabId: 1, title: 'A:/test', url: 'https://example.test' },
    acquire: async (mode) => { calls.push(`acquire:${mode}`); return options.acquire ? options.acquire(mode) : { streamId: 'one-use' }; },
    release: async () => { calls.push('release'); releases++; },
  });
  t.after(async () => {
    if (controller.busy) await controller.stop();
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
    Recorder.instances = [];
    Recorder.failStart = false;
  });
  return { controller, mediaDevices, media: resultStream, captured, calls, downloads,
    releases: () => releases, audioContexts: () => audioContexts,
    now: (value) => { now = value; }, latest: () => Recorder.instances.at(-1), listeners };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('display picker runs synchronously before lock and final data survives stop', async (t) => {
  const h = harness(t);
  const started = h.controller.start('display', true, 'memory');
  assert.deepEqual(h.calls, ['display']);
  assert.equal(await started, true);
  assert.deepEqual(h.calls, ['display', 'acquire:display']);
  assert.equal(h.controller.snapshot().audio, false);
  assert.equal(h.controller.snapshot().target, '共有ダイアログで選んだウィンドウ');
  assert.equal(h.audioContexts(), 0);
  await h.controller.stop();
  assert.equal(h.controller.snapshot().phase, 'ready');
  assert.equal(h.controller.snapshot().bytes, 5);
  assert.equal(h.controller.snapshot().resultSaved, false);
  assert.equal(h.controller.stream, null);
  assert.ok(h.media.getTracks().every((track) => track.readyState === 'ended'));
  assert.equal(h.releases(), 1);
});

test('acquisition denial stops a display stream without releasing another owner lock', async (t) => {
  const h = harness(t, { acquire: () => { throw new Error('busy'); } });
  assert.equal(await h.controller.start('display', false, 'memory'), false);
  assert.equal(h.controller.snapshot().phase, 'error');
  assert.ok(h.media.getTracks().every((track) => track.readyState === 'ended'));
  assert.equal(h.releases(), 0);
});

test('unsaved memory recording blocks replacement; cancelled picker preserves the saved result', async (t) => {
  const h = harness(t);
  await h.controller.start('display', false, 'memory');
  await h.controller.stop();
  assert.equal(await h.controller.start('display', false, 'memory'), false);
  assert.equal(h.calls.filter((call) => call === 'display').length, 1);
  await h.controller.save();
  const prior = h.controller.snapshot();
  h.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('cancel', 'NotAllowedError'));
  assert.equal(await h.controller.start('display', false, 'memory'), false);
  assert.equal(h.controller.snapshot().phase, 'saved');
  assert.equal(h.controller.snapshot().fileName, prior.fileName);
  assert.equal(h.controller.snapshot().bytes, prior.bytes);
  assert.equal(h.controller.snapshot().resultSaved, true);
});

test('file finalization waits for ordered writes, ends sharing before flush, and releases once', async (t) => {
  const writes = [];
  let unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const writable = {
    async write(blob) { const text = await blob.text(); writes.push(text); if (text === 'first') await blocked; },
    async close() { writes.push('close'); }, async abort() { writes.push('abort'); },
  };
  const h = harness(t, { picker: async () => ({ name: 'movie.webm', createWritable: async () => writable }) });
  await h.controller.chooseFile();
  await h.controller.start('display', false, 'file');
  h.latest().chunk('first');
  const stopped = h.controller.stop();
  await tick();
  assert.equal(h.controller.snapshot().phase, 'finalizing');
  assert.equal(h.controller.snapshot().resultSaved, false);
  assert.ok(h.media.getTracks().every((track) => track.readyState === 'ended'));
  assert.deepEqual(writes, ['first']);
  assert.equal(h.releases(), 0);
  unblock();
  await stopped;
  assert.deepEqual(writes, ['first', 'final', 'close']);
  assert.equal(h.controller.snapshot().phase, 'saved');
  assert.equal(h.controller.snapshot().resultSaved, true);
  assert.equal(h.releases(), 1);
});

test('write failure aborts the file and never reports a saved result', async (t) => {
  const actions = [];
  const writable = { async write() { throw new Error('disk full'); },
    async close() { actions.push('close'); }, async abort() { actions.push('abort'); } };
  const h = harness(t, { picker: async () => ({ name: 'movie.webm', createWritable: async () => writable }) });
  await h.controller.chooseFile();
  await h.controller.start('display', false, 'file');
  h.latest().chunk('content');
  await h.controller.stop();
  assert.deepEqual(actions, ['abort']);
  assert.equal(h.controller.snapshot().phase, 'error');
  assert.equal(h.controller.snapshot().resultSaved, false);
  assert.match(h.controller.snapshot().message, /不完全なファイル/);
  assert.equal(h.releases(), 1);
});

test('tab audio uses tab constraints only and pause excludes paused duration', async (t) => {
  const h = harness(t, { audio: true });
  await h.controller.start('tab', true, 'memory');
  assert.equal(h.captured[0].audio.mandatory.chromeMediaSource, 'tab');
  assert.equal(h.captured[0].video.mandatory.chromeMediaSourceId, 'one-use');
  assert.equal(h.audioContexts(), 1);
  h.now(1200);
  assert.equal(h.controller.pause(), true);
  h.now(9000);
  assert.equal(h.controller.snapshot().elapsed, 1200);
  assert.equal(h.controller.resume(), true);
  h.now(9500);
  await h.controller.stop();
  assert.equal(h.controller.snapshot().elapsed, 1700);
});

test('browser stop and concurrent stop share one finalization and preserve final chunk', async (t) => {
  const h = harness(t);
  await h.controller.start('display', false, 'memory');
  const recorder = h.latest();
  h.media.getVideoTracks()[0].end();
  await Promise.all([h.controller.stop(), h.controller.stop()]);
  assert.equal(recorder.stopCount, 1);
  assert.equal(h.releases(), 1);
  assert.equal(h.controller.snapshot().bytes, 5);
});

test('download acceptance is not success; interrupted save retains retryable recording', async (t) => {
  const h = harness(t);
  await h.controller.start('display', false, 'memory');
  await h.controller.stop();
  h.downloads.search = async () => [{ id: 42, state: 'in_progress' }];
  const saving = h.controller.save();
  await tick();
  assert.equal(h.controller.snapshot().phase, 'saving');
  assert.equal(h.controller.snapshot().resultSaved, false);
  for (const listener of h.listeners) listener({ id: 42, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
  assert.equal(await saving, false);
  assert.equal(h.controller.snapshot().resultReady, true);
  assert.equal(h.controller.snapshot().resultSaved, false);
  h.downloads.search = async () => [{ id: 42, state: 'complete' }];
  assert.equal(await h.controller.save(), true);
  assert.equal(h.controller.snapshot().resultSaved, true);
  assert.equal(h.listeners.size, 0);
});

test('file-choice cancellation retains previous handle', async (t) => {
  const h = harness(t, { picker: async () => ({ name: 'chosen.webm' }) });
  assert.equal(await h.controller.chooseFile(), true);
  globalThis.showSaveFilePicker = () => Promise.reject(new DOMException('cancel', 'AbortError'));
  assert.equal(await h.controller.chooseFile(), false);
  assert.equal(h.controller.snapshot().diskChosen, true);
  assert.equal(h.controller.snapshot().fileName, 'chosen.webm');
});
