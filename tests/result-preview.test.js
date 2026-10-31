import test from 'node:test';
import assert from 'node:assert/strict';
import {ResultPreview} from '../extension/result-preview.js';
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};

test('playback reuses one local URL and clearing it never revokes unrelated download URLs',async()=>{
  const file=new Blob(['recording']),created=[],revoked=[];
  const preview=new ResultPreview({getFile:async()=>file,createURL:value=>{created.push(value);return 'blob:playback';},revokeURL:value=>revoked.push(value)});
  assert.deepEqual(await Promise.all([preview.load(),preview.load()]),['blob:playback','blob:playback']);
  assert.equal(created.length,1);assert.equal(await preview.load(),'blob:playback');
  preview.clear();preview.clear();assert.deepEqual(revoked,['blob:playback']);
});

test('a late file read cannot recreate a discarded or replaced recording preview',async()=>{
  const late=deferred(),created=[];
  const preview=new ResultPreview({getFile:()=>late.promise,createURL:file=>{created.push(file);return 'blob:late';}});
  const loading=preview.load();preview.clear();late.resolve(new Blob(['old recording']));
  assert.equal(await loading,null);assert.equal(preview.url,null);assert.deepEqual(created,[]);
});

test('an old pending read cannot clear the new recording read or leak its playback URL',async()=>{
  const old=deferred(),next=deferred(),revoked=[];let reads=0;
  const preview=new ResultPreview({getFile:()=>++reads===1 ? old.promise : next.promise,createURL:()=> 'blob:new',revokeURL:url=>revoked.push(url)});
  const first=preview.load();await Promise.resolve();preview.clear();
  const second=preview.load();await Promise.resolve();old.resolve(new Blob(['old']));
  assert.equal(await first,null);assert.equal(preview.load(),second);
  next.resolve(new Blob(['new']));assert.equal(await second,'blob:new');
  preview.clear();assert.deepEqual(revoked,['blob:new']);
});
