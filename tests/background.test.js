import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url)));
const supportsRecording = manifest.permissions.includes('tabCapture');
let moduleNumber = 0;
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

async function eventually(predicate, description) {
  for (let attempts = 0; attempts < 50; attempts++) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.ok(predicate(), description);
}

function event() {
  const listeners = new Set();
  return { addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (...args) => [...listeners].map((listener) => listener(...args)) };
}

async function browser(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const store = new Map();
  const tabs = new Map([
    [1, { id: 1, url: 'https://source.test/', title: 'Source' }],
    [100, { id: 100, url: 'chrome-extension://test/workspace.html?id=work' }],
  ]);
  const downloads = new Map();
  const requested = [];
  let nextDownloadId = 8;
  const changed = event();
  const removed = event();
  const messages = event();
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  const chrome = {
    runtime: { id: 'test', getURL: (path) => `chrome-extension://test/${path}`, onMessage: messages },
    action: { onClicked: event(), setBadgeText: async () => {}, setTitle: async () => {} },
    storage: { session: {
      async get(key) {
        if (key === null) return Object.fromEntries([...store].map(([name, value]) => [name, clone(value)]));
        return { [key]: clone(store.get(key)) };
      },
      async set(values) { for (const [key, value] of Object.entries(values)) store.set(key, clone(value)); },
      async remove(key) { store.delete(key); },
    } },
    tabs: { onRemoved: removed,
      async get(id) { if (!tabs.has(id)) throw new Error('No such tab'); return clone(tabs.get(id)); },
      async update(id, values) { Object.assign(tabs.get(id), values); return clone(tabs.get(id)); },
    },
    downloads: { onChanged: changed,
      async download(options) {
        const id = nextDownloadId++;
        requested.push({ ...options, id });
        downloads.set(id, { id, state: 'in_progress', bytesReceived: 0, totalBytes: -1, mime: 'video/mp4' });
        return id;
      },
      async search({ id }) { return downloads.has(id) ? [clone(downloads.get(id))] : []; },
      async cancel(id) {
        const item = downloads.get(id);
        if (item?.state === 'complete') throw new Error('Download is already complete');
        if (!item) throw new Error('No such download');
        item.state = 'interrupted'; item.error = 'USER_CANCELED';
        changed.emit({ id, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
      },
    },
    tabCapture: { getCapturedTabs: async () => [], getMediaStreamId: async () => 'one-use-stream' },
  };
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: chrome });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous); else delete globalThis.chrome;
  });
  // Each test gets a new worker module and independent event registrations/storage.
  await import(`${new URL('../extension/background.js', import.meta.url).href}?test=${moduleNumber++}`);
  const state = {
    id: 'work', tabId: 1, workspaceTabId: 100, url: 'https://source.test/', title: 'Source',
    items: [], notices: [], scanned: true, jobs: [],
  };
  const persist = () => store.set('workspace:work', clone(state));
  persist();
  return {
    state, store, tabs, downloads, requested, persist,
    closeWorkspace() { tabs.delete(100); removed.emit(100); },
    complete(id) {
      Object.assign(downloads.get(id), { state: 'complete', bytesReceived: 10, totalBytes: 10 });
      changed.emit({ id, state: { current: 'complete' } });
    },
    send(message) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Background did not respond')), 1000);
        messages.emit({ sessionId: 'work', instance: 'current-page', ...message },
          { id: 'test', url: 'chrome-extension://test/workspace.html?id=work', tab: { id: 100 } },
          (response) => { clearTimeout(timeout); resolve(response); });
      });
    },
  };
}

test('BG-01: closing the workspace preserves and completes the already accepted download batch', async (t) => {
  const h = await browser(t);
  h.state.jobs = [
    { url: 'https://source.test/first.mp4', filename: 'first.mp4', downloadId: 7, status: 'in_progress' },
    { url: 'https://source.test/second.mp4', filename: 'second.mp4', status: 'queued' },
  ];
  h.downloads.set(7, { id: 7, state: 'in_progress', mime: 'video/mp4', bytesReceived: 1, totalBytes: 10 });
  h.persist();
  h.closeWorkspace();
  await nextTurn();
  await nextTurn();
  assert.ok(h.store.has('workspace:work'), 'pending batch must survive the workspace closing');
  assert.equal(h.requested.length, 0, 'downloads remain sequential while the first file is active');
  h.complete(7);
  await eventually(() => h.requested.length === 1, 'second file starts after first completes, without a live workspace');
  assert.equal(h.requested[0].url, 'https://source.test/second.mp4');
  h.complete(h.requested[0].id);
  await eventually(() => {
    const saved = h.store.get('workspace:work');
    return !saved || saved.jobs.every((job) => ['complete', 'interrupted'].includes(job.status));
  }, 'closed workspace must not leave a queued or in-progress batch after all downloads finish');
  assert.equal(h.requested.length, 1, 'neither completed file is downloaded a second time');
});

test('BG-02: a capture owner that navigated away cannot keep another workspace locked',
  { skip: !supportsRecording }, async (t) => {
    const h = await browser(t);
    h.tabs.set(999, { id: 999, url: 'https://another-page.test/' });
    h.store.set('captureLock', { tabId: 999, instance: 'departed-page', mode: 'display' });
    const response = await h.send({ type: 'capture', mode: 'display' });
    assert.equal(response.ok, true, response.error);
    const lock = h.store.get('captureLock');
    assert.equal(lock.tabId, 100, 'the new workspace owns the granted capture');
    assert.equal(lock.instance, 'current-page');
    const release = await h.send({ type: 'release' });
    assert.equal(release.ok, true);
    assert.equal(h.store.has('captureLock'), false);
  });

test('BG-03: a download completing just before cancel remains complete and is never retried', async (t) => {
  const h = await browser(t);
  h.state.jobs = [{ url: 'https://source.test/already-saved.mp4', filename: 'saved.mp4', downloadId: 7, status: 'in_progress' }];
  // Chrome has completed the file, but its event has not reached the worker's cached state yet.
  h.downloads.set(7, { id: 7, state: 'complete', mime: 'video/mp4', bytesReceived: 10, totalBytes: 10 });
  h.persist();
  const response = await h.send({ type: 'cancel' });
  assert.equal(response.ok, true, response.error);
  assert.equal(response.data.jobs[0].status, 'complete', 'cancel rejection must reconcile the actual Chrome state');
  const retried = await h.send({ type: 'retry' });
  assert.equal(retried.ok, true, retried.error);
  assert.equal(retried.data.jobs[0].status, 'complete');
  assert.deepEqual(h.requested, [], 'retry must never duplicate a completed file');
});

test('BG-format: direct MP4 choice preserves source URL and freezes output format across cancel/retry',async t=>{
  const h=await browser(t),url='https://source.test/original.m4v?auth=synthetic';
  h.state.items=[{url,type:'direct',mime:'video/x-m4v'}];h.persist();
  const command={type:'save',urls:[url],outputFormat:'mp4'};
  const saved=await h.send(command);assert.equal(saved.ok,true,saved.error);
  assert.equal(saved.data.jobs[0].outputFormat,'mp4');assert.match(saved.data.jobs[0].filename,/\.mp4$/);
  assert.equal(h.requested[0].url,url);assert.match(h.requested[0].filename,/\.mp4$/);
  command.outputFormat='auto';
  const canceled=await h.send({type:'cancel'});assert.equal(canceled.ok,true,canceled.error);
  assert.equal(canceled.data.jobs[0].status,'interrupted');
  const retried=await h.send({type:'retry',outputFormat:'auto'});assert.equal(retried.ok,true,retried.error);
  assert.equal(retried.data.jobs[0].outputFormat,'mp4','retry uses the accepted job format');
  assert.equal(h.requested.length,2);assert.match(h.requested[1].filename,/\.mp4$/);assert.equal(h.requested[1].url,url);
});

test('BG-format: auto preserves WebM and omitted output defaults to auto',async t=>{
  const h=await browser(t),url='https://source.test/original.webm';
  h.state.items=[{url,type:'direct',mime:'video/webm'}];h.persist();
  const response=await h.send({type:'save',urls:[url]});assert.equal(response.ok,true,response.error);
  assert.equal(response.data.jobs[0].outputFormat,'auto');assert.match(h.requested[0].filename,/\.webm$/);
});

test('BG-format: incompatible MP4 or invalid format rejects the entire batch without replacing previous jobs',async t=>{
  const h=await browser(t);
  const previous=[{url:'https://source.test/finished.mp4',status:'complete',filename:'previous.mp4',outputFormat:'mp4'}];
  h.state.jobs=previous;
  h.state.items=[{url:'https://source.test/good.mp4',type:'direct',mime:'video/mp4'},{url:'https://source.test/other.webm',type:'direct',mime:'video/webm'}];h.persist();
  for(const outputFormat of ['mp4','bogus']) {
    const response=await h.send({type:'save',urls:h.state.items.map(item=>item.url),outputFormat});
    assert.equal(response.ok,false);assert.match(response.error,/形式|MP4/);
    assert.deepEqual(h.store.get('workspace:work').jobs,previous,'failed validation is atomic');
    assert.equal(h.requested.length,0);
  }
});

test('BG-format: typed extensionless MP4 may use MP4, while unknown endpoints cannot be relabeled',async t=>{
  const h=await browser(t),url='https://source.test/typed-endpoint';
  const unknownURL='https://source.test/untyped-endpoint';
  h.state.items=[{url,type:'direct',mime:'video/mp4'},{url:unknownURL,type:'direct'}];h.persist();
  const response=await h.send({type:'save',urls:[url],outputFormat:'mp4'});assert.equal(response.ok,true,response.error);
  assert.match(h.requested[0].filename,/\.mp4$/);
  const canceled=await h.send({type:'cancel'});assert.equal(canceled.ok,true);
  const denied=await h.send({type:'save',urls:[unknownURL],outputFormat:'mp4'});assert.equal(denied.ok,false);assert.match(denied.error,/確認できない/);
  assert.equal(h.requested.length,1);
});

test('BG-format: completed Chrome WebM/QuickTime responses cannot report successful selected MP4 output',async t=>{
  const h=await browser(t);
  for(const mime of ['video/webm','video/quicktime']) {
    h.state.jobs=[{url:'https://source.test/declared.mp4',filename:'declared.mp4',downloadId:7,status:'in_progress',outputFormat:'mp4'}];h.persist();
    h.downloads.set(7,{id:7,state:'complete',mime,bytesReceived:10,totalBytes:10});
    const response=await h.send({type:'get'});assert.equal(response.ok,true,response.error);
    const job=response.data.jobs[0];assert.equal(job.status,'interrupted');assert.equal(job.outputFormat,'mp4');
    assert.match(job.error,/MP4と異なる形式/);assert.match(job.error,/応答が保存されました/,'the already saved file is honestly acknowledged');
    assert.equal(job.bytesReceived,10);assert.equal(h.requested.length,0,'status reconciliation does not retry or relabel the file');
  }
});

test('BG-format: actual native MP4/M4V complete normally and auto accepts other actual video formats',async t=>{
  const h=await browser(t);
  for(const [mime,outputFormat] of [['video/mp4','mp4'],['video/mp4; codecs=avc1','mp4'],['video/x-m4v','mp4'],['video/webm','auto'],['video/quicktime','auto']]) {
    h.state.jobs=[{url:'https://source.test/clip',filename:outputFormat==='mp4' ? 'clip.mp4' : 'clip.video',downloadId:7,status:'in_progress',outputFormat}];h.persist();
    h.downloads.set(7,{id:7,state:'complete',mime,bytesReceived:10,totalBytes:10});
    const response=await h.send({type:'get'});assert.equal(response.ok,true,response.error);
    assert.equal(response.data.jobs[0].status,'complete',`${mime} is accepted for ${outputFormat}`);
    assert.equal(response.data.jobs[0].error,undefined);assert.equal(h.requested.length,0);
  }
});
