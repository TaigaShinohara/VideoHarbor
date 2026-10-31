import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DISCOVERY_VERSION } from '../extension/discovery.js';

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
  const requested = [], scripts = [], shown = [];
  let scriptResults = [], scriptError, permissionError, lastCollection=[], documentResult;
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
      async show(id) { shown.push(id); },
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
    permissions: { async contains() { if (permissionError) throw permissionError; return false; } },
    scripting: { async executeScript(options) {
      scripts.push(options); if (scriptError) throw scriptError;
      if (options.func.name === 'inspectSourceDocument') return clone(documentResult || lastCollection.filter(entry=>entry.frameId===0).map(entry=>({frameId:0,documentId:entry.documentId,result:{frameToken:entry.result.frameToken,documentURL:entry.result.documentURL}})));
      const result=typeof scriptResults === 'function' ? scriptResults(options) : scriptResults;
      if (options.func.name === 'collect') lastCollection=result;
      return clone(result);
    } },
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
    items: [], previousItems: [], scan:{version:DISCOVERY_VERSION,sequence:0,at:null}, notices: [], scanned: true, jobs: [],
  };
  const persist = () => store.set('workspace:work', clone(state));
  persist();
  return {
    state, store, tabs, downloads, requested, persist, scripts, shown,
    setScriptResults(results) { scriptResults = results; },
    setDocumentResult(result) { documentResult = result; },
    failScript(error) { scriptError=error; },
    failPermission(error) { permissionError=error; },
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


const injection=(frameId,documentId,items,frames=[])=>({frameId,documentId,result:{frameToken:`token-${documentId}`,documentURL:frameId ? 'https://embed.test/player' : 'https://source.test/',items:items.map(item=>({source:'video',mediaHint:true,...item})),frames,notices:[]}});

test('BG-04: successful rescan replaces 500 old candidates and retains independent job/history results',async t=>{
  const h=await browser(t);
  h.state.items=Array.from({length:500},(_,i)=>({url:`https://source.test/old${i}.mp4`,type:'direct'}));
  h.state.jobs=[{url:'https://source.test/old0.mp4',status:'complete',downloadId:7,filename:'saved.mp4'}];
  h.downloads.set(7,{id:7,state:'complete',exists:true,filename:'/downloads/actual.mp4'});
  h.persist();
  h.setScriptResults([injection(0,'top',[{url:'https://source.test/new.mp4'}])]);
  const response=await h.send({type:'scan'});
  assert.equal(response.ok,true,response.error);
  assert.deepEqual(response.data.items.map(item=>item.url),['https://source.test/new.mp4']);
  assert.equal(response.data.previousItems.length,100);
  assert.equal(response.data.jobs[0].downloadId,7);
  assert.equal(response.data.history[0].downloadId,7);
  assert.equal(response.data.scan.version,2);
  assert.equal(response.data.scan.sequence,1);
});

test('BG-05: permission failure and source navigation never commit a partial rescan snapshot',async t=>{
  const h=await browser(t);
  h.state.items=[{url:'https://source.test/retained.mp4',type:'direct'}];h.persist();
  const before=structuredClone(h.store.get('workspace:work'));
  h.setScriptResults([injection(0,'top',[{url:'https://source.test/new.mp4'}],[{url:'https://other.test/embed'}])]);
  h.failPermission(new Error('Permission unavailable'));
  let response=await h.send({type:'scan'});
  assert.equal(response.ok,false);
  assert.deepEqual(h.store.get('workspace:work'),before);
  h.failPermission(undefined);
  h.setScriptResults(()=>{h.tabs.set(1,{id:1,url:'https://source.test/changed'});return [injection(0,'top',[{url:'https://source.test/new.mp4'}])];});
  response=await h.send({type:'scan'});
  assert.equal(response.ok,false);
  assert.deepEqual(h.store.get('workspace:work'),before);
});

test('BG-06: blob reads use their real child document and never inherit parent frame identity',async t=>{
  const h=await browser(t);
  h.setScriptResults([
    injection(0,'top',[]),
    injection(17,'child-document',[{url:'blob:https://embed.test/one',occurrences:[{id:'video-child',source:'video',videoRef:'video1',elementToken:'video1',origin:'dom'}]}]),
  ]);
  const scan=await h.send({type:'scan'});
  assert.equal(scan.ok,true,scan.error);
  assert.equal(scan.data.items[0].frameId,17);
  assert.equal(scan.data.items[0].documentId,'child-document');
  h.setScriptResults([{result:{size:10,bytes:[]}}]);
  const response=await h.send({type:'blob-read',url:'blob:https://embed.test/one',offset:-1,token:'00000000-0000-0000-0000-000000000000'});
  assert.equal(response.ok,true,response.error);
  assert.deepEqual(h.scripts.at(-1).target,{tabId:1,documentIds:['child-document']});
});

test('BG-07: locate validates saved occurrence/document identity and rejects stale or unknown references',async t=>{
  const h=await browser(t);
  h.setScriptResults([injection(0,'top',[]),injection(17,'child-document',[{url:'https://source.test/clip.mp4',occurrences:[{id:'occ1',source:'video',videoRef:'video1',elementToken:'video1',origin:'dom'}]}])]);
  await h.send({type:'scan'});
  h.setScriptResults([{result:{found:true}}]);
  let response=await h.send({type:'locate-source',url:'https://source.test/clip.mp4',occurrenceId:'occ1'});
  assert.equal(response.ok,true,response.error);
  assert.deepEqual(h.scripts.at(-1).target,{tabId:1,documentIds:['child-document']});
  assert.deepEqual(h.scripts.at(-1).args,['token-child-document','video1','https://embed.test/player']);
  const count=h.scripts.length;
  response=await h.send({type:'locate-source',url:'https://source.test/clip.mp4',occurrenceId:'unknown'});
  assert.equal(response.ok,false);
  assert.equal(h.scripts.length,count);
  h.setScriptResults([{result:{found:false}}]);
  response=await h.send({type:'locate-source',url:'https://source.test/clip.mp4',occurrenceId:'occ1'});
  assert.equal(response.ok,false);
  assert.match(response.error,/再スキャン/);
});

test('BG-08: download inspection/show is restricted to known jobs or proven extension downloads',async t=>{
  const h=await browser(t);
  h.state.jobs=[{url:'https://source.test/clip.mp4',status:'complete',downloadId:7}];h.persist();
  h.downloads.set(7,{id:7,state:'complete',filename:'/downloads/unique.mp4',exists:true});
  h.downloads.set(8,{id:8,state:'complete',filename:'/downloads/other.mp4',exists:true,byExtensionId:'other-extension'});
  h.downloads.set(9,{id:9,state:'complete',filename:'/downloads/assembled.mp4',exists:true,byExtensionId:'test'});
  h.downloads.set(10,{id:10,state:'complete',filename:'/downloads/missing.mp4',exists:false,byExtensionId:'test'});
  let response=await h.send({type:'inspect-download',downloadId:7});
  assert.equal(response.ok,true,response.error);
  assert.equal(response.data.filename,'/downloads/unique.mp4');
  assert.equal(response.data.exists,true);
  response=await h.send({type:'show-download',downloadId:8});assert.equal(response.ok,false);
  response=await h.send({type:'show-download',downloadId:9});assert.equal(response.ok,true,response.error);
  response=await h.send({type:'show-download',downloadId:10});assert.equal(response.ok,false);
  assert.deepEqual(h.shown,[9]);
});


test('BG-09: actual download paths never replace the relative retry filename',async t=>{
  const h=await browser(t);
  h.state.jobs=[{url:'https://source.test/retry.mp4',status:'in_progress',downloadId:7,filename:'VideoHarbor/Source/001_retry.mp4'}];
  h.downloads.set(7,{id:7,state:'interrupted',error:'NETWORK_FAILED',filename:'/Users/example/Downloads/VideoHarbor/Source/001_retry (1).mp4',exists:false});
  h.persist();
  let response=await h.send({type:'get'});
  assert.equal(response.ok,true,response.error);
  assert.equal(response.data.jobs[0].filename,'VideoHarbor/Source/001_retry.mp4');
  assert.equal(response.data.jobs[0].actualFilename,'/Users/example/Downloads/VideoHarbor/Source/001_retry (1).mp4');
  response=await h.send({type:'retry'});
  assert.equal(response.ok,true,response.error);
  assert.equal(h.requested[0].filename,'VideoHarbor/Source/001_retry.mp4');
  assert.equal(response.data.jobs[0].actualFilename,undefined);
  assert.equal(response.data.jobs[0].exists,undefined);
});


test('BG-10: same-URL reload, stale frame tokens, or missing top result cannot commit an old snapshot',async t=>{
  const h=await browser(t);
  h.state.items=[{url:'https://source.test/retained.mp4',type:'direct'}];h.persist();
  const before=structuredClone(h.store.get('workspace:work'));
  h.setScriptResults([injection(0,'old-document',[{url:'https://source.test/new.mp4'}])]);
  // The tab URL is unchanged, but its current document has been replaced while
  // the scan was waiting on a permission check.
  h.setDocumentResult([{frameId:0,documentId:'new-document',result:{frameToken:'token-new-document',documentURL:'https://source.test/'}}]);
  let response=await h.send({type:'scan'});
  assert.equal(response.ok,false);
  assert.deepEqual(h.store.get('workspace:work'),before);
  h.setDocumentResult([{frameId:0,documentId:'old-document',result:{frameToken:'stale-token',documentURL:'https://source.test/'}}]);
  response=await h.send({type:'scan'});
  assert.equal(response.ok,false);
  assert.deepEqual(h.store.get('workspace:work'),before);
  h.setDocumentResult(undefined);
  h.setScriptResults([injection(17,'child-only',[{url:'https://source.test/new.mp4'}])]);
  response=await h.send({type:'scan'});
  assert.equal(response.ok,false);
  assert.deepEqual(h.store.get('workspace:work'),before);
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
