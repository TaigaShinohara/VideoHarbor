import test from 'node:test';
import assert from 'node:assert/strict';
import { RecorderController } from '../extension/recorder.js';
import { prepareVideoCapture } from '../extension/video-capture.js';

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
    this.emitChunk(new Blob([value]));
  }
  sizedChunk(size, label = 'synthetic') {
    // Exercise byte accounting without allocating hundreds of MiB. The Blob
    // keeps a tiny genuine payload; only its reported event size is synthetic.
    const blob = new Blob([label]);
    Object.defineProperty(blob, 'size', { value: size });
    this.emitChunk(blob);
  }
  emitChunk(blob) {
    const event = new Event('dataavailable');
    Object.defineProperty(event, 'data', { value: blob });
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
  const names = ['navigator', 'MediaRecorder', 'showSaveFilePicker', 'chrome', 'AudioContext', 'performance', 'setInterval', 'clearInterval'];
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
  const intervals = new Map();
  if (options.manualIntervals) {
    let nextInterval = 0;
    Object.defineProperty(globalThis, 'setInterval', { configurable: true, writable: true, value: (callback, delay) => {
      const id = ++nextInterval; intervals.set(id, { callback, delay }); return id;
    } });
    Object.defineProperty(globalThis, 'clearInterval', { configurable: true, writable: true, value: (id) => intervals.delete(id) });
  }
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
    prepareVideo: options.prepareVideo,
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
    now: (value) => { now = value; }, latest: () => Recorder.instances.at(-1), listeners, intervals,
    heartbeat: () => { for (const { callback, delay } of [...intervals.values()]) if (delay === 1000) callback(); } };
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
  h.controller.source.title='SyntheticPerson private-title';
  const submitted=[];
  h.downloads.download=async config=>{submitted.push(config);return 42;};
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
  assert.match(submitted[0].filename,/^VideoHarbor\/\d{4}-\d{2}-\d{2}\/recording-\d{9}-\d{3,}\.webm$/);
  assert.doesNotMatch(submitted[0].filename,/Synthetic|private/);
  assert.equal(submitted[1].filename,submitted[0].filename,'retry keeps the recording name');
  assert.ok(submitted.every(call=>call.saveAs===true && call.conflictAction==='uniquify'));
});

test('file picker suggests a neutral basename and preserves the user-chosen output name',async t=>{
  const suggestions=[];
  const h=harness(t,{picker:async options=>{suggestions.push(options.suggestedName);return {
    name:'My chosen recording.webm',createWritable:async()=>({async write(){},async close(){}}),
  };}});
  h.controller.source.title='SyntheticPerson private-title';
  assert.equal(await h.controller.chooseFile(),true);
  assert.match(suggestions[0],/^recording-\d{9}-\d{3,}\.webm$/);
  assert.doesNotMatch(suggestions[0],/Synthetic|private|\//);
  assert.equal(await h.controller.start('display',false,'file'),true);
  await h.controller.stop();
  assert.equal(h.controller.snapshot().fileName,'My chosen recording.webm');
  assert.equal(h.controller.snapshot().resultSaved,true);
  await h.controller.chooseFile();
  assert.notEqual(suggestions[1],suggestions[0]);
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

test('memory recording stays active below 256 MiB and auto-stops at the exact threshold while retaining the final chunk', async (t) => {
  const h = harness(t, { manualIntervals: true });
  await h.controller.start('display', false, 'memory');
  const recorder = h.latest(), limit = 256 * 1024 * 1024;
  recorder.sizedChunk(limit - 1, 'below');
  await tick();
  assert.equal(h.controller.snapshot().phase, 'recording');
  assert.equal(h.controller.snapshot().bytes, limit - 1);
  assert.equal(recorder.stopCount, 0);assert.equal(h.releases(), 0);
  assert.ok(h.media.getTracks().every(track => track.readyState === 'live'));
  recorder.sizedChunk(1, 'threshold');
  await tick();
  const result = h.controller.snapshot();
  assert.equal(result.phase, 'ready');assert.equal(recorder.stopCount, 1);
  assert.equal(result.bytes, limit + 5, 'MediaRecorder final data is retained after reaching the stop threshold');
  assert.equal(result.resultReady, true);assert.equal(result.resultSaved, false);
  assert.match(result.message, /256MiB.*自動停止.*最終データ分は超過/);
  assert.equal(await (await h.controller.getResultFile()).text(), 'belowthresholdfinal');
  assert.ok(h.media.getTracks().every(track => track.readyState === 'ended'));
  assert.equal(h.controller.stream, null);assert.equal(h.releases(), 1);assert.equal(h.intervals.size, 0);
});

test('a memory chunk crossing 256 MiB stops automatically without truncating either that chunk or the final data', async (t) => {
  const h = harness(t, { manualIntervals: true });
  await h.controller.start('display', false, 'memory');
  const recorder = h.latest(), limit = 256 * 1024 * 1024;
  recorder.sizedChunk(limit - 4, 'before');
  await tick();assert.equal(recorder.stopCount, 0);
  recorder.sizedChunk(17, 'crossing');
  await tick();
  assert.equal(h.controller.snapshot().phase, 'ready');
  assert.equal(h.controller.snapshot().bytes, limit + 18);
  assert.equal(await (await h.controller.getResultFile()).text(), 'beforecrossingfinal');
  assert.equal(h.controller.snapshot().resultSaved, false);
  assert.equal(recorder.stopCount, 1);assert.equal(h.releases(), 1);
  assert.ok(h.media.getTracks().every(track => track.readyState === 'ended'));
  assert.equal(h.intervals.size, 0);
});

test('pending file writes below 32 MiB keep recording; exactly 32 MiB stops sharing and waits for a confirmed close', async (t) => {
  const blocked = deferred(), actions = [];
  const writable = {
    async write(blob) { const text = await blob.text();actions.push(text);if (text === 'blocked') await blocked.promise; },
    async close() { actions.push('close'); },async abort() { actions.push('abort'); },
  };
  const h = harness(t, { manualIntervals: true, picker: async () => ({ name: 'bounded.webm', createWritable: async () => writable }) });
  await h.controller.chooseFile();await h.controller.start('display', false, 'file');
  const recorder = h.latest(), limit = 32 * 1024 * 1024;
  try {
    recorder.sizedChunk(limit - 1, 'blocked');await tick();
    assert.deepEqual(actions, ['blocked']);assert.equal(h.controller.snapshot().phase, 'recording');
    assert.equal(recorder.stopCount, 0);assert.equal(h.releases(), 0);
    recorder.sizedChunk(1, 'threshold');await tick();
    assert.equal(recorder.stopCount, 1);assert.equal(h.controller.snapshot().phase, 'finalizing');
    assert.equal(h.controller.snapshot().resultSaved, false);assert.equal(h.controller.snapshot().resultReady, false);
    assert.equal(await h.controller.getResultFile(), null);
    assert.ok(h.media.getTracks().every(track => track.readyState === 'ended'), 'sharing stops before the slow writer flushes');
    assert.equal(h.releases(), 0);assert.deepEqual(actions, ['blocked']);
  } finally {blocked.resolve();await h.controller.stop();}
  assert.deepEqual(actions, ['blocked', 'threshold', 'final', 'close']);
  assert.equal(h.controller.snapshot().phase, 'saved');assert.equal(h.controller.snapshot().resultSaved, true);
  assert.equal(h.controller.snapshot().bytes, limit + 5);
  assert.match(h.controller.snapshot().message, /書き込みが追いつかないため自動停止.*ファイル保存完了/);
  assert.equal(h.controller.stream, null);assert.equal(h.releases(), 1);assert.equal(h.intervals.size, 0);
});

test('completed writes return the queue budget so total file size can exceed 32 MiB without triggering the pending-write stop', async (t) => {
  const destination = fileDestination('draining.webm');
  const h = harness(t, { manualIntervals: true, picker: async () => destination.handle });
  await h.controller.chooseFile();await h.controller.start('display', false, 'file');
  const recorder = h.latest(), size = 32 * 1024 * 1024 - 1;
  recorder.sizedChunk(size, 'first');await tick();
  recorder.sizedChunk(size, 'second');await tick();
  assert.equal(h.controller.snapshot().phase, 'recording');assert.equal(recorder.stopCount, 0);
  assert.equal(h.controller.snapshot().bytes, 2 * size);
  assert.ok(h.media.getTracks().every(track => track.readyState === 'live'));
  await h.controller.stop();
  assert.equal(h.controller.snapshot().phase, 'saved');assert.equal(h.controller.snapshot().resultSaved, true);
  assert.equal(await (await h.controller.getResultFile()).text(), 'firstsecondfinal');
  assert.equal(destination.calls.filter(action => action === 'close').length, 1);
  assert.equal(destination.calls.includes('abort'), false);assert.equal(h.releases(), 1);
});

test('a write failure after the 32 MiB queue stop aborts the file, drains cleanup and never advertises a saved output', async (t) => {
  const blocked = deferred(), actions = [];
  const writable = {
    async write(blob) { actions.push(await blob.text());await blocked.promise; },
    async close() { actions.push('close'); },async abort() { actions.push('abort'); },
  };
  const h = harness(t, { manualIntervals: true, picker: async () => ({ name: 'failed-limit.webm', createWritable: async () => writable }) });
  await h.controller.chooseFile();await h.controller.start('display', false, 'file');
  const recorder = h.latest();
  try {
    recorder.sizedChunk(32 * 1024 * 1024, 'blocked');await tick();
    assert.equal(h.controller.snapshot().phase, 'finalizing');assert.equal(recorder.stopCount, 1);
    assert.equal(h.controller.snapshot().resultSaved, false);assert.equal(h.releases(), 0);
    assert.ok(h.media.getTracks().every(track => track.readyState === 'ended'));
    blocked.reject(new Error('synthetic disk full'));await tick();
  } finally {blocked.resolve();await h.controller.stop();}
  assert.deepEqual(actions, ['blocked', 'abort'], 'failed writes skip later queued chunks and never close as a successful file');
  assert.equal(h.controller.snapshot().phase, 'error');assert.equal(h.controller.snapshot().resultSaved, false);
  assert.equal(h.controller.snapshot().resultReady, false);assert.equal(h.controller.snapshot().resultPlaybackAvailable, false);
  assert.equal(h.controller.snapshot().diskChosen, false);assert.equal(await h.controller.getResultFile(), null);
  assert.match(h.controller.snapshot().message, /書き込みに失敗.*不完全なファイル/);
  assert.equal(h.controller.stream, null);assert.equal(h.releases(), 1);assert.equal(h.intervals.size, 0);
});

for (const output of ['memory', 'file']) test(`${output} recording excludes a long pause and auto-stops at exactly 30 active minutes`, async (t) => {
  const destination = fileDestination('time-limit.webm');
  const h = harness(t, { manualIntervals: true, picker: async () => destination.handle });
  if (output === 'file') await h.controller.chooseFile();
  await h.controller.start('display', false, output);
  const recorder = h.latest(), limit = 30 * 60 * 1000, pauseDuration = 60 * 60 * 1000;
  h.now(limit - 1);h.heartbeat();await tick();
  assert.equal(h.controller.snapshot().phase, 'recording');assert.equal(recorder.stopCount, 0);
  assert.equal(h.controller.snapshot().elapsed, limit - 1);assert.equal(h.releases(), 0);
  assert.equal(h.controller.pause(), true);
  h.now(limit - 1 + pauseDuration);h.heartbeat();await tick();
  assert.equal(h.controller.snapshot().phase, 'paused');assert.equal(h.controller.snapshot().elapsed, limit - 1);
  assert.equal(recorder.stopCount, 0);assert.ok(h.media.getTracks().every(track => track.readyState === 'live'));
  assert.equal(h.controller.resume(), true);
  h.now(limit + pauseDuration);h.heartbeat();await tick();
  const result = h.controller.snapshot();
  assert.equal(result.elapsed, limit);assert.equal(recorder.stopCount, 1);
  assert.equal(result.phase, output === 'file' ? 'saved' : 'ready');
  assert.equal(result.resultSaved, output === 'file');assert.equal(result.resultReady, true);
  assert.match(result.message, /30分に達したため自動停止/);
  assert.equal(await (await h.controller.getResultFile()).text(), 'final');
  if (output === 'file') assert.deepEqual(destination.calls, ['createWritable', 'write', 'close', 'getFile']);
  assert.ok(h.media.getTracks().every(track => track.readyState === 'ended'));
  assert.equal(h.controller.stream, null);assert.equal(h.releases(), 1);assert.equal(h.intervals.size, 0);
});


const videoReference = {elementToken:'video-1',frameToken:'document-1',documentURL:'https://example.test/',title:'選んだ動画'};
class RemoteRecorder extends Recorder {
  constructor(audio = true) {
    super(null,{mimeType:'video/webm'}); this.audio=audio;this.target='選んだ動画';this.available=true;this.closed=0;
  }
  async start() { super.start(); }
  async pause() { super.pause(); }
  async resume() { super.resume(); }
  async stop() { if(this.state!=='inactive')super.stop(); }
  async close() { this.closed++;this.available=false; }
}

test('video capture uses the selected element without any tab or display capture, and preserves final data', async t=>{
  const remote=new RemoteRecorder();let prepared;
  const h=harness(t,{prepareVideo:async options=>{prepared=options;return remote;}});
  const reference={...videoReference,title:'SyntheticPerson private-video'};
  assert.equal(await h.controller.start('video',true,'memory',reference),true);
  assert.match(h.controller.snapshot().fileName,/^VideoHarbor\/\d{4}-\d{2}-\d{2}\/recording-\d{9}-\d{3,}\.webm$/);
  assert.doesNotMatch(h.controller.snapshot().fileName,/Synthetic|private/);
  assert.deepEqual(h.calls,['acquire:video']);
  assert.equal(prepared.reference,reference);assert.equal(prepared.audio,true);
  assert.equal(h.controller.stream,null);assert.equal(h.audioContexts(),0);
  remote.chunk('selected');
  assert.equal(await h.controller.pause(),true);assert.equal(h.controller.snapshot().phase,'paused');
  assert.equal(await h.controller.resume(),true);assert.equal(h.controller.snapshot().phase,'recording');
  await h.controller.stop();
  assert.equal(await (await h.controller.getResultFile()).text(),'selectedfinal');
  assert.equal(h.controller.snapshot().method,'video');assert.equal(remote.closed,1);assert.equal(h.releases(),1);
});

test('capture control failures hide signed URLs regardless of scheme casing',async t=>{
  const error=new Error('Source unavailable HTTPS://media.test/SyntheticPerson?Signature=SyntheticPrivate');
  error.name='CaptureControlError';
  const h=harness(t,{prepareVideo:async()=>{throw error;}});
  assert.equal(await h.controller.start('video',false,'memory',videoReference),false);
  assert.match(h.controller.snapshot().message,/^Source unavailable \[URL\]/);
  assert.doesNotMatch(h.controller.snapshot().message,/Synthetic|Signature/);
});

test('video with missing audio waits for a decision before recording and never switches to the tab', async t=>{
  const remote=new RemoteRecorder(false),h=harness(t,{prepareVideo:async()=>remote});
  const starting=h.controller.start('video',true,'memory',videoReference);await tick();
  assert.equal(h.controller.snapshot().phase,'awaiting-audio-decision');assert.equal(remote.state,'inactive');
  assert.equal(h.controller.continueWithoutAudio(),true);assert.equal(await starting,true);
  assert.equal(h.controller.snapshot().audio,false);assert.deepEqual(h.calls,['acquire:video']);
  await h.controller.stop();
});

test('cancelling delayed video preparation closes its late source without replacing the previous saved result', async t=>{
  let resolve;const preparation=new Promise(r=>{resolve=r;});
  const h=harness(t,{prepareVideo:()=>preparation});
  await h.controller.start('display',false,'memory');await h.controller.stop();await h.controller.save();
  const previous=await h.controller.getResultFile();
  const starting=h.controller.start('video',false,'memory',videoReference);await tick();
  await h.controller.cancelStart();assert.equal(await starting,false);
  const remote=new RemoteRecorder(false);resolve(remote);await tick();
  assert.equal(remote.closed,1);assert.equal(remote.state,'inactive');
  assert.equal(await h.controller.getResultFile(),previous);assert.equal(h.controller.snapshot().phase,'saved');
});

test('video source failure retains received data as unverified recovery and releases the owner', async t=>{
  const remote=new RemoteRecorder(),h=harness(t,{prepareVideo:async()=>remote});
  await h.controller.start('video',true,'memory',videoReference);remote.chunk('received');
  remote.dispatchEvent(new Event('error'));await h.controller.stop();
  assert.equal(h.controller.snapshot().phase,'error');assert.equal(h.controller.snapshot().resultReady,true);
  assert.match(h.controller.snapshot().message,/再生できるかは未確認/);assert.equal(remote.closed,1);assert.equal(h.releases(),1);
});

test('video reference and preparation failure never fall back to whole-tab capture', async t=>{
  const h=harness(t,{prepareVideo:async()=>{throw new DOMException('blocked','SecurityError');}});
  assert.equal(await h.controller.start('video',true,'memory'),false);assert.deepEqual(h.calls,[]);
  assert.equal(await h.controller.start('video',true,'memory',videoReference),false);
  assert.deepEqual(h.calls,['acquire:video','release']);assert.equal(h.controller.snapshot().phase,'error');
});


test('source disappearance settles a pending video audio decision and retains the unused file destination', async t=>{
  const remote=new RemoteRecorder(false),h=harness(t,{prepareVideo:async()=>remote,picker:async()=>({name:'unused.webm',createWritable:()=>{throw new Error('must not write');}})});
  await h.controller.chooseFile();
  const starting=h.controller.start('video',true,'file',videoReference);await tick();
  assert.equal(h.controller.snapshot().phase,'awaiting-audio-decision');
  remote.available=false;remote.dispatchEvent(new Event('error'));
  assert.equal(await starting,false);assert.equal(h.controller.snapshot().diskChosen,true);
  assert.match(h.controller.snapshot().message,/動画の取得が終了/);assert.equal(remote.closed,1);assert.equal(h.releases(),1);
});

test('real video adapter propagates a preparation-time connection loss through the audio decision and releases the lock', {timeout:3000}, async t=>{
  let disconnect;
  const lost=new Promise((_,reject)=>{disconnect=()=>reject(new Error('接続が終了しました。'));});
  let polled;
  const polling=new Promise(resolve=>{polled=resolve;});
  const h=harness(t,{prepareVideo:options=>prepareVideoCapture({...options,send:async(_type,{command})=>{
    if(command==='prepare')return {available:true,audio:false,state:'inactive',target:'選んだ動画',mimeType:'video/webm'};
    if(command==='poll'){polled();return lost;}
    if(command==='close')return {closed:true};
    throw new Error('Recording must not start before the audio decision');
  }})});
  const starting=h.controller.start('video',true,'memory',videoReference);
  await polling;
  assert.equal(h.controller.snapshot().phase,'awaiting-audio-decision');
  disconnect();
  assert.equal(await starting,false);
  assert.equal(h.controller.snapshot().phase,'idle');assert.equal(h.releases(),1);
  assert.match(h.controller.snapshot().message,/動画の取得が終了/);
});

test('video file output waits for the final remote data and closes only after ordered writes', async t=>{
  const remote=new RemoteRecorder();const writes=[];let unblock;
  const blocked=new Promise(resolve=>{unblock=resolve;});let closed=false;
  const h=harness(t,{prepareVideo:async()=>remote,picker:async()=>({name:'selected.webm',createWritable:async()=>({
    async write(blob){const text=await blob.text();writes.push(text);if(text==='first')await blocked;},
    async close(){closed=true;},async abort(){throw new Error('Successful output must not abort');},
  })})});
  await h.controller.chooseFile();await h.controller.start('video',true,'file',videoReference);remote.chunk('first');
  const stopping=h.controller.stop();await tick();
  assert.equal(h.controller.snapshot().phase,'finalizing');assert.equal(closed,false);assert.deepEqual(writes,['first']);
  unblock();await stopping;
  assert.deepEqual(writes,['first','final']);assert.equal(closed,true);assert.equal(h.controller.snapshot().phase,'saved');
  assert.equal(h.controller.snapshot().resultSaved,true);assert.equal(remote.closed,1);assert.equal(h.releases(),1);
});
