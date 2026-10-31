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
  const started = h.controller.start('display', false, 'memory');
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fileDestination(name) {
  const calls = [];
  let contents = [];
  let closed = false;
  const handle = {
    name,
    async createWritable() {
      calls.push('createWritable');
      contents = [];
      closed = false;
      return {
        async write(blob) { calls.push('write'); contents.push(blob); },
        async close() { calls.push('close'); closed = true; },
        async abort() { calls.push('abort'); },
      };
    },
    async getFile() {
      assert.equal(closed, true, 'read the output only after close succeeded');
      calls.push('getFile');
      return new Blob(contents, { type: 'video/webm' });
    },
  };
  return { handle, calls };
}

test('a file destination is consumed once and a second recording preserves the first output', async (t) => {
  const first = fileDestination('first.webm');
  const second = fileDestination('second.webm');
  const h = harness(t, { picker: async () => first.handle });
  await h.controller.chooseFile();
  assert.equal(await h.controller.start('display', false, 'file'), true);
  assert.equal(h.controller.snapshot().diskChosen, false);
  h.latest().chunk('first recording');
  await h.controller.stop();
  const firstFile = await h.controller.getResultFile();
  assert.equal(await firstFile.text(), 'first recordingfinal');
  assert.equal(h.controller.snapshot().fileName, 'first.webm');
  assert.equal(h.controller.snapshot().resultPlaybackAvailable, true);
  assert.equal(await h.controller.start('display', false, 'file'), false);
  assert.equal(first.calls.filter((call) => call === 'createWritable').length, 1);
  globalThis.showSaveFilePicker = async () => second.handle;
  await h.controller.chooseFile();
  assert.equal(h.controller.snapshot().fileName, 'first.webm');
  assert.equal(h.controller.snapshot().chosenFileName, 'second.webm');
  assert.equal(await (await h.controller.getResultFile()).text(), 'first recordingfinal');
  h.mediaDevices.getDisplayMedia = async () => stream();
  await h.controller.start('display', false, 'file');
  h.latest().chunk('second recording');
  await h.controller.stop();
  assert.equal(await (await h.controller.getResultFile()).text(), 'second recordingfinal');
  assert.equal(await firstFile.text(), 'first recordingfinal');
  assert.equal(first.calls.filter((call) => call === 'createWritable').length, 1);
  assert.equal(second.calls.filter((call) => call === 'createWritable').length, 1);
  assert.equal(h.controller.snapshot().fileName, 'second.webm');
});

test('capture cancellation keeps the unused destination and completed playback result', async (t) => {
  const first = fileDestination('completed.webm');
  const next = fileDestination('next.webm');
  const h = harness(t, { picker: async () => first.handle });
  await h.controller.chooseFile();
  await h.controller.start('display', false, 'file');
  await h.controller.stop();
  globalThis.showSaveFilePicker = async () => next.handle;
  await h.controller.chooseFile();
  h.mediaDevices.getDisplayMedia = async () => { throw new DOMException('cancel', 'NotAllowedError'); };
  assert.equal(await h.controller.start('display', false, 'file'), false);
  assert.equal(h.controller.snapshot().diskChosen, true);
  assert.equal(h.controller.snapshot().chosenFileName, 'next.webm');
  assert.equal(h.controller.snapshot().fileName, 'completed.webm');
  assert.equal(await (await h.controller.getResultFile()).text(), 'final');
  assert.deepEqual(next.calls, []);
});

test('requested audio with no live audio waits before creating either writer or recorder', async (t) => {
  const output = fileDestination('with-decision.webm');
  const media = stream(true);
  media.getAudioTracks()[0].stop();
  const h = harness(t, { media, picker: async () => output.handle });
  await h.controller.chooseFile();
  const started = h.controller.start('display', true, 'file');
  assert.deepEqual(h.calls, ['display']);
  await tick();
  assert.equal(h.controller.snapshot().phase, 'awaiting-audio-decision');
  assert.equal(h.controller.snapshot().audioRequested, true);
  assert.equal(h.controller.snapshot().audio, false);
  assert.equal(h.controller.busy, true);
  assert.equal(h.controller.stream, media);
  assert.equal(media.getVideoTracks()[0].readyState, 'live');
  assert.deepEqual(output.calls, []);
  assert.equal(Recorder.instances.length, 0);
  assert.equal(await h.controller.start('display', false, 'file'), false);
  assert.equal(h.calls.filter((call) => call === 'display').length, 1);
  assert.equal(h.controller.continueWithoutAudio(), true);
  assert.equal(await started, true);
  assert.equal(h.controller.snapshot().phase, 'recording');
  assert.equal(h.controller.snapshot().audioRequested, true);
  assert.equal(h.controller.snapshot().audio, false);
  await h.controller.stop();
  assert.equal(h.controller.snapshot().audioRequested, true);
  assert.equal(h.controller.snapshot().resultSaved, true);
});

test('audio decision cancellation preserves the unused destination and prior saved result', async (t) => {
  const destination = fileDestination('pending.webm');
  const h = harness(t, { picker: async () => destination.handle });
  await h.controller.start('display', false, 'memory');
  await h.controller.stop();
  await h.controller.save();
  const prior = await h.controller.getResultFile();
  await h.controller.chooseFile();
  const media = stream();
  h.mediaDevices.getDisplayMedia = async () => media;
  const started = h.controller.start('display', true, 'file');
  await tick();
  assert.equal(h.controller.snapshot().phase, 'awaiting-audio-decision');
  assert.equal(await h.controller.getResultFile(), prior);
  assert.equal(await h.controller.cancelStart(), true);
  assert.equal(await started, false);
  assert.equal(h.controller.snapshot().phase, 'saved');
  assert.equal(h.controller.snapshot().diskChosen, true);
  assert.equal(h.controller.snapshot().downloadId, 42);
  assert.equal(await h.controller.getResultFile(), prior);
  assert.equal(h.releases(), 2);
  assert.ok(media.getTracks().every((track) => track.readyState === 'ended'));
  assert.deepEqual(destination.calls, []);
  assert.equal(Recorder.instances.length, 1);
  assert.equal(h.controller.continueWithoutAudio(), false);
});

test('browser sharing end and concurrent stop settle an outstanding audio decision once', async (t) => {
  const h = harness(t);
  const started = h.controller.start('display', true, 'memory');
  await tick();
  assert.equal(h.controller.snapshot().phase, 'awaiting-audio-decision');
  h.media.getVideoTracks()[0].end();
  await Promise.all([h.controller.stop(), h.controller.stop()]);
  assert.equal(await started, false);
  assert.equal(h.releases(), 1);
  assert.equal(Recorder.instances.length, 0);
  assert.equal(h.controller.stream, null);
  assert.equal(h.controller.busy, false);
  assert.match(h.controller.snapshot().message, /共有が終了/);
});

test('cancelled native capture settles immediately and stops a late successful stream', async (t) => {
  const h = harness(t);
  const capture = deferred();
  h.mediaDevices.getDisplayMedia = () => capture.promise;
  const started = h.controller.start('display', false, 'memory');
  assert.equal(await h.controller.cancelStart(), true);
  assert.equal(await started, false);
  assert.equal(h.controller.busy, false);
  assert.equal(h.releases(), 0);
  const late = stream(true);
  capture.resolve(late);
  await tick();
  assert.ok(late.getTracks().every((track) => track.readyState === 'ended'));
  assert.equal(Recorder.instances.length, 0);
  assert.equal(h.controller.snapshot().phase, 'idle');
});

test('tab capture ID is consumed immediately and late capture is stopped after cancellation', async (t) => {
  const h = harness(t);
  const capture = deferred();
  h.mediaDevices.getUserMedia = () => { h.calls.push('consume'); return capture.promise; };
  const started = h.controller.start('tab', true, 'memory');
  await tick();
  assert.deepEqual(h.calls, ['acquire:tab', 'consume']);
  assert.equal(await h.controller.stop(), true);
  assert.equal(await started, false);
  assert.equal(h.releases(), 1);
  const late = stream(true);
  capture.resolve(late);
  await tick();
  assert.ok(late.getTracks().every((track) => track.readyState === 'ended'));
  assert.equal(Recorder.instances.length, 0);
});

test('cancellation during lock acquisition releases only a subsequently granted owned lock', async (t) => {
  const grant = deferred();
  const h = harness(t, { acquire: () => grant.promise });
  const started = h.controller.start('display', true, 'memory');
  await tick();
  const stopped = h.controller.cancelStart();
  assert.ok(h.media.getTracks().every((track) => track.readyState === 'ended'));
  grant.resolve({});
  assert.equal(await stopped, true);
  assert.equal(await started, false);
  assert.equal(h.releases(), 1);
  assert.equal(Recorder.instances.length, 0);
  assert.equal(h.controller.busy, false);
});

test('lock denial while audio is missing never enters audio decision or consumes a file', async (t) => {
  const destination = fileDestination('pending.webm');
  const h = harness(t, { picker: async () => destination.handle, acquire: () => { throw new Error('busy'); } });
  await h.controller.chooseFile();
  assert.equal(await h.controller.start('display', true, 'file'), false);
  assert.equal(h.controller.snapshot().phase, 'error');
  assert.equal(h.controller.snapshot().diskChosen, true);
  assert.deepEqual(destination.calls, []);
  assert.equal(h.releases(), 0);
  assert.ok(h.media.getTracks().every((track) => track.readyState === 'ended'));
});

test('opening failure consumes the destination and MediaRecorder start failure keeps the prior result', async (t) => {
  const destination = fileDestination('failed.webm');
  const h = harness(t, { picker: async () => destination.handle });
  await h.controller.start('display', false, 'memory');
  await h.controller.stop();
  await h.controller.save();
  const prior = await h.controller.getResultFile();
  await h.controller.chooseFile();
  h.mediaDevices.getDisplayMedia = async () => stream();
  Recorder.failStart = true;
  assert.equal(await h.controller.start('display', false, 'file'), false);
  assert.deepEqual(destination.calls, ['createWritable', 'abort']);
  assert.equal(h.controller.snapshot().diskChosen, false);
  assert.equal(h.controller.snapshot().phase, 'saved');
  assert.equal(await h.controller.getResultFile(), prior);
  globalThis.showSaveFilePicker = async () => ({
    name: 'denied.webm', createWritable() { throw new DOMException('denied', 'NotAllowedError'); },
  });
  await h.controller.chooseFile();
  assert.equal(await h.controller.start('display', false, 'file'), false);
  assert.equal(h.controller.snapshot().diskChosen, false);
  assert.equal(await h.controller.getResultFile(), prior);
});

test('cancellation while opening a writer consumes its selection and aborts a late writer', async (t) => {
  const opening = deferred();
  const actions = [];
  const h = harness(t, { picker: async () => ({ name: 'pending.webm', createWritable: () => opening.promise }) });
  await h.controller.chooseFile();
  const started = h.controller.start('display', false, 'file');
  await tick();
  assert.equal(h.controller.snapshot().diskChosen, false);
  assert.equal(await h.controller.stop(), true);
  assert.equal(await started, false);
  assert.equal(h.releases(), 1);
  assert.equal(Recorder.instances.length, 0);
  opening.resolve({ async abort() { actions.push('abort'); } });
  await tick();
  assert.deepEqual(actions, ['abort']);
});

test('file read is unavailable during final close and failed files are never offered for playback', async (t) => {
  const close = deferred();
  let reads = 0;
  const h = harness(t, { picker: async () => ({
    name: 'pending.webm', getFile: async () => { reads++; return new Blob(['file']); },
    createWritable: async () => ({ write: async () => {}, close: () => close.promise, abort: async () => {} }),
  }) });
  await h.controller.chooseFile();
  await h.controller.start('display', false, 'file');
  const stopped = h.controller.stop();
  await tick();
  assert.equal(h.controller.snapshot().phase, 'finalizing');
  assert.equal(await h.controller.getResultFile(), null);
  assert.equal(reads, 0);
  close.reject(new Error('disk failed'));
  await stopped;
  assert.equal(h.controller.snapshot().phase, 'error');
  assert.equal(h.controller.snapshot().resultPlaybackAvailable, false);
  assert.equal(await h.controller.getResultFile(), null);
  assert.equal(reads, 0);
  assert.equal(h.controller.snapshot().diskChosen, false);
});

test('memory playback remains available through interrupted save and keeps a completed download ID', async (t) => {
  const h = harness(t);
  assert.equal(await h.controller.getResultFile(), null);
  await h.controller.start('display', false, 'memory');
  h.latest().chunk('content');
  await h.controller.stop();
  const file = await h.controller.getResultFile();
  assert.equal(await file.text(), 'contentfinal');
  assert.equal(h.controller.snapshot().downloadId, null);
  h.downloads.search = async () => [{ id: 42, state: 'interrupted', error: 'USER_CANCELED' }];
  assert.equal(await h.controller.save(), false);
  assert.equal(await h.controller.getResultFile(), file);
  assert.equal(h.controller.snapshot().downloadId, null);
  h.downloads.search = async () => [{ id: 42, state: 'complete' }];
  assert.equal(await h.controller.save(), true);
  assert.equal(h.controller.snapshot().downloadId, 42);
  assert.equal(await h.controller.getResultFile(), file);
  assert.equal(h.controller.discard(), true);
  assert.equal(await h.controller.getResultFile(), null);
  assert.equal(h.controller.snapshot().downloadId, null);
});


test('completed memory save exposes the actual renamed basename and a filename lookup failure keeps success', async (t) => {
  const h = harness(t);
  await h.controller.start('display', false, 'memory');
  await h.controller.stop();
  h.downloads.search = async () => [{ id: 42, state: 'complete', filename: '/Downloads/renamed.webm' }];
  assert.equal(await h.controller.save(), true);
  assert.equal(h.controller.snapshot().fileName, 'renamed.webm');
  assert.equal(h.controller.snapshot().downloadId, 42);
  let queries = 0;
  h.downloads.search = async () => {
    if (queries++ === 0) return [{ id: 42, state: 'in_progress' }];
    throw new Error('temporary search failure');
  };
  const saved = h.controller.save();
  await tick();
  for (const listener of h.listeners) listener({ id: 42, state: { current: 'complete' } });
  assert.equal(await saved, true);
  assert.equal(h.controller.snapshot().resultSaved, true);
  assert.equal(h.controller.snapshot().fileName, 'renamed.webm');
});
