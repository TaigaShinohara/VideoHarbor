import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverySnapshot, migrateDiscovery } from '../extension/discovery.js';

const resource = (url,source='video',extra={}) => ({url,source,mediaHint:true,...extra});
const injection = (frameId,documentId,items) => ({frameId,documentId,result:{frameToken:`frame-${documentId}`,documentURL:`https://frame.test/${documentId}`,items}});
const state = () => ({items:[],previousItems:[],scan:{version:2,sequence:0}});

test('snapshot separates performance loading history from current DOM and preserves exact query identity',()=>{
  const result=discoverySnapshot(state(),[injection(0,'top',[
    resource('https://cdn.test/file.mp4?token=one','loaded-resource'),
    resource('https://cdn.test/file.mp4?token=two','video'),
  ])],123);
  assert.equal(result.items.length,2);
  assert.equal(result.items.find(item=>item.url.endsWith('one')).discovery,'loaded-history');
  assert.equal(result.items.find(item=>item.url.endsWith('two')).discovery,'current-dom');
  assert.equal(result.scan.at,123);
});

test('one resource may have distinct document/video occurrences without cross-frame ref attribution',()=>{
  const url='https://cdn.test/shared.mp4';
  const output=discoverySnapshot(state(),[
    injection(0,'top',[resource(url,'video',{occurrences:[{id:'a',source:'video',origin:'dom',videoRef:'video-a',elementToken:'a',title:'First'}]})]),
    injection(13,'child',[resource(url,'video',{occurrences:[{id:'b',source:'video',origin:'dom',videoRef:'video-b',elementToken:'b',playing:true,title:'Second'}]})]),
  ]);
  const item=output.items[0];
  assert.equal(item.occurrences.length,2);
  assert.deepEqual(item.occurrences.map(occurrence=>occurrence.frameId),[0,13]);
  assert.deepEqual(item.occurrences.map(occurrence=>occurrence.documentId),['top','child']);
  assert.equal(item.frameId,13);
  assert.equal(item.title,'Second');
});

test('new and DOM candidates displace older loading history within the global 500 limit',()=>{
  const before=state();
  before.items=Array.from({length:500},(_,i)=>resource(`https://cdn.test/old${i}.mp4`,'loaded-resource'));
  const output=discoverySnapshot(before,[
    injection(0,'top',before.items),
    injection(1,'child',[resource('https://cdn.test/new.mp4','video')]),
  ]);
  assert.equal(output.items.length,500);
  assert.equal(output.items[0].url,'https://cdn.test/new.mp4');
  assert.equal(output.scan.omitted,1);
  assert.ok(output.notices.some(notice=>notice.includes('省略')));
  assert.equal(output.previousItems.length,1);
});

test('previous snapshots stay bounded and do not replace current resource metadata with historical values',()=>{
  const before=state();
  before.items=Array.from({length:500},(_,i)=>resource(`https://cdn.test/old${i}.mp4`));
  const copy=structuredClone(before);
  const output=discoverySnapshot(before,[injection(0,'top',[resource('https://cdn.test/current.mp4','loaded-resource')])]);
  assert.equal(output.previousItems.length,100);
  assert.equal(output.items.length,1);
  assert.equal(output.items[0].source,'loaded-resource');
  assert.equal(output.items[0].discovery,'loaded-history');
  assert.deepEqual(before,copy,'snapshot computation must not mutate state before the commit boundary');
});

test('legacy cumulative sessions migrate to previous results without trusting inherited parent frame IDs',()=>{
  const jobs=[{url:'https://cdn.test/old.mp4',status:'complete',downloadId:7}];
  const old={items:[resource('blob:https://frame.test/one','video',{frameId:0,documentId:'wrong',videoRef:'unknown'})],jobs,history:jobs,scanned:true};
  const migrated=migrateDiscovery(old);
  assert.equal(migrated.scan.version,2);
  assert.deepEqual(migrated.items,[]);
  assert.equal(migrated.previousItems.length,1);
  assert.equal(migrated.previousItems[0].frameId,undefined);
  assert.equal(migrated.previousItems[0].documentId,undefined);
  assert.equal(migrated.previousItems[0].videoRef,undefined);
  assert.deepEqual(migrated.jobs,jobs);
  assert.deepEqual(migrated.history,jobs);
  assert.equal(old.items[0].frameId,0,'migration must not alter the stored original on failure');
  assert.equal(migrateDiscovery(migrated),migrated);
});
