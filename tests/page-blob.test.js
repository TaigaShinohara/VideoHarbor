import test from 'node:test';
import assert from 'node:assert/strict';
import {readPageBlob} from '../extension/page-blob.js';
const token='00000000-0000-4000-8000-000000000001';
const otherToken='00000000-0000-4000-8000-000000000002';
const url='blob:https://page.test/synthetic';
const key=Symbol.for('VideoHarbor.blobSnapshot');
const webm = tail => new Blob([new Uint8Array([0x1a,0x45,0xdf,0xa3]),tail || 'video'],{type:'video/webm'});
function harness(t,blob) {
  const fetchDescriptor=Object.getOwnPropertyDescriptor(globalThis,'fetch');
  const snapshotDescriptor=Object.getOwnPropertyDescriptor(globalThis,key);
  const h={fetches:0,blob};
  delete globalThis[key];
  Object.defineProperty(globalThis,'fetch',{configurable:true,value:async()=>{h.fetches++;if(h.error)throw h.error;return h.response ? h.response() : new Response(h.blob);}});
  t.after(()=>{
    if(globalThis[key])clearTimeout(globalThis[key].timer);
    if(snapshotDescriptor)Object.defineProperty(globalThis,key,snapshotDescriptor);else delete globalThis[key];
    if(fetchDescriptor)Object.defineProperty(globalThis,'fetch',fetchDescriptor);else delete globalThis.fetch;
  });
  return h;
}

test('page blob snapshots fetch once, preserve original bytes across slices and release by token',async t=>{
  const data=new Uint8Array(262147);data.set([0x1a,0x45,0xdf,0xa3]);data[262144]=9;data[262146]=11;
  const h=harness(t,new Blob([data],{type:'video/webm'}));
  assert.deepEqual(await readPageBlob(url,-1,token),{size:data.length,mime:'video/webm',bytes:[]});
  h.blob=new Blob(['changed'],{type:'video/mp4'});
  const first=await readPageBlob(url,0,token),second=await readPageBlob(url,262144,token);
  assert.equal(first.bytes.length,262144);assert.equal(first.bytes[0],0x1a);
  assert.deepEqual(second.bytes,[9,0,11]);assert.equal(second.mime,'video/webm');assert.equal(h.fetches,1);
  await readPageBlob(url,-2,otherToken);assert.ok(globalThis[key],'another token cannot release snapshot');
  await readPageBlob(url,-2,token);assert.equal(globalThis[key],undefined);
  assert.match((await readPageBlob(url,0,token)).error,/期限切れ/);
});

test('page blob snapshot is restricted to one operation and its exact URL',async t=>{
  const h=harness(t,webm());
  await readPageBlob(url,-1,token);
  assert.match((await readPageBlob('blob:https://page.test/other',0,token)).error,/期限切れ/);
  await readPageBlob(url,-1,otherToken);assert.equal(h.fetches,2);
  assert.match((await readPageBlob(url,0,token)).error,/期限切れ/);
  assert.deepEqual((await readPageBlob(url,0,otherToken)).bytes,[0x1a,0x45,0xdf,0xa3,118,105,100,101,111]);
});

test('page blob snapshot expires after inactivity and each chunk renews its TTL',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  harness(t,webm());
  await readPageBlob(url,-1,token);
  t.mock.timers.tick(59000);assert.ok(globalThis[key]);
  await readPageBlob(url,0,token);
  t.mock.timers.tick(2000);assert.ok(globalThis[key],'chunk renewed timeout');
  t.mock.timers.tick(58001);assert.equal(globalThis[key],undefined);
  assert.match((await readPageBlob(url,0,token)).error,/期限切れ/);
});

test('page blob rejects invalid operation parameters without fetching',async t=>{
  const h=harness(t,new Blob(['video'],{type:'video/mp4'}));
  for(const args of [['https://page.test/video',-1,token],[url,-3,token],[url,0.5,token],[url,-1,'bad-token']])await assert.rejects(()=>readPageBlob(...args),/指定が不正/);
  assert.equal(h.fetches,0);
});

test('page blob refuses empty, non-video and oversized data without keeping a snapshot',async t=>{
  const h=harness(t,new Blob([],{type:'video/mp4'}));
  assert.match((await readPageBlob(url,-1,token)).error,/動画ファイル/);
  h.blob=new Blob(['html'],{type:'text/html'});assert.match((await readPageBlob(url,-1,token)).error,/動画ファイル/);
  h.response=()=>new Response('placeholder',{headers:{'content-type':'video/mp4','content-length':'268435457'}});
  assert.match((await readPageBlob(url,-1,token)).error,/256 MiB/);
  assert.equal(globalThis[key],undefined);
});
test('page blob bounds streamed bytes when content length is absent and rejects false video signatures',async t=>{
  const h=harness(t,new Blob(['html pretending to be video'],{type:'video/mp4'}));
  assert.match((await readPageBlob(url,-1,token)).error,/動画ファイル/);
  let canceled=0,released=0;
  h.response=()=>({headers:new Headers({'content-type':'video/webm'}),body:{getReader:()=>({
    read:async()=>({done:false,value:{byteLength:268435457}}),cancel:async()=>{canceled++;},releaseLock:()=>{released++;},
  })}});
  assert.match((await readPageBlob(url,-1,token)).error,/256 MiB/);
  assert.equal(canceled,1);assert.equal(released,1);assert.equal(globalThis[key],undefined);
});

test('MediaSource or revoked blob fetch failure offers fallback without retaining data',async t=>{
  const h=harness(t,new Blob(['video'],{type:'video/mp4'}));h.error=new TypeError('Failed to fetch blob:synthetic');
  assert.match((await readPageBlob(url,-1,token)).error,/分割配信.*録画/);
  assert.equal(globalThis[key],undefined);
});
