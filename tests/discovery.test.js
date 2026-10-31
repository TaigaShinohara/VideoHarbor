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

test('snapshot excludes image candidates even with video hints while preserving unknown video endpoints and blobs',()=>{
  const videos=[
    resource('https://cdn.test/playback?poster=cover.jpg','loaded-resource'),
    resource('https://cdn.test/poster.jpg/movie.mp4?thumbnail=cover.png'),
    resource('blob:https://frame.test/actual-video','video',{mime:'video/mp4'}),
  ];
  const output=discoverySnapshot(state(),[injection(0,'top',[
    resource('https://cdn.test/poster.JPG?size=160#preview','loaded-resource'),
    resource('https://cdn.test/poster%2E%6A%70%67','video'),
    resource('https://cdn.test/image-endpoint','video',{mime:'IMAGE/WEBP; charset=binary'}),
    resource('https://cdn.test/incorrect.mp4','video',{mime:'image/png'}),
    resource('blob:https://frame.test/poster','video',{mime:'image/jpeg'}),
    ...videos,
  ])]);
  assert.deepEqual(new Set(output.items.map(item=>item.url)),new Set(videos.map(item=>item.url)));
  assert.equal(output.items.find(item=>item.url===videos[0].url).type,'direct');
  assert.equal(output.items.find(item=>item.url===videos[2].url).type,'blob');
  assert.equal(output.scan.currentCount,3);
  assert.equal(output.scan.omitted,0);
});

test('rescan removes old image candidates instead of retaining them in previous results',()=>{
  const oldVideo=resource('https://cdn.test/old.mp4');
  const poster=resource('https://cdn.test/poster.jpg','loaded-resource');
  const oldImage=resource('https://cdn.test/old-image','video',{mime:'image/png'});
  const before={...state(),items:[oldVideo,poster],previousItems:[oldImage]};
  const copy=structuredClone(before);
  const output=discoverySnapshot(before,[injection(0,'top',[
    poster,resource('https://cdn.test/current.mp4'),
  ])]);
  assert.deepEqual(output.items.map(item=>item.url),['https://cdn.test/current.mp4']);
  assert.deepEqual(output.previousItems.map(item=>item.url),[oldVideo.url]);
  assert.equal(output.scan.previousCount,1);
  assert.deepEqual(before,copy,'discarding old image candidates must not mutate the previous snapshot');
});

test('session migration removes stored image candidates while preserving video records and download history',()=>{
  const poster=resource('https://cdn.test/poster.jpg','loaded-resource');
  const oldImage=resource('https://cdn.test/image-endpoint','video',{mime:'image/png'});
  const video=resource('https://cdn.test/current.mp4'), oldVideo=resource('https://cdn.test/old.mp4');
  const jobs=[{url:poster.url,status:'complete',downloadId:7}];
  const current={...state(),items:[poster,video],previousItems:[oldImage,oldVideo],jobs,history:jobs,
    scan:{version:2,sequence:4,currentCount:2,previousCount:2}};
  const copy=structuredClone(current);
  const cleaned=migrateDiscovery(current);
  assert.deepEqual(cleaned.items.map(item=>item.url),[video.url]);
  assert.deepEqual(cleaned.previousItems.map(item=>item.url),[oldVideo.url]);
  assert.equal(cleaned.scan.currentCount,1);
  assert.equal(cleaned.scan.previousCount,1);
  assert.equal(cleaned.scan.sequence,4);
  assert.equal(cleaned.jobs,jobs);
  assert.equal(cleaned.history,jobs);
  assert.deepEqual(current,copy,'migration must preserve the original state until it is committed');
  assert.equal(migrateDiscovery(cleaned),cleaned,'image-free sessions should retain their original identity');

  const legacy=migrateDiscovery({items:[poster,video],jobs,history:jobs});
  assert.deepEqual(legacy.items,[]);
  assert.deepEqual(legacy.previousItems.map(item=>item.url),[video.url]);
  assert.equal(legacy.scan.previousCount,1);
  assert.equal(legacy.jobs,jobs);
  assert.equal(legacy.history,jobs);
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

test('recording targets retain their own Chrome document identity without a resource URL',()=>{
  const before={...state(),videoElements:[{elementToken:'stale'}]};
  const frame=injection(13,'child',[]);
  frame.result.videoElements=[{elementTag:'VIDEO',elementToken:'real-video',videoRef:'real-video',frameId:0,documentId:'wrong',frameToken:'wrong',documentURL:'https://wrong.test',paused:false,playing:true}];
  const output=discoverySnapshot(before,[frame]);
  assert.equal(output.items.length,0);
  assert.equal(output.videoElements.length,1);
  assert.equal(output.videoElements[0].frameId,13);
  assert.equal(output.videoElements[0].documentId,'child');
  assert.equal(output.videoElements[0].frameToken,'frame-child');
  assert.equal(output.videoElements[0].documentURL,'https://frame.test/child');
  assert.equal(output.videoElements[0].url,undefined);
  assert.equal(before.videoElements[0].elementToken,'stale','replacement stays atomic until commit');
  assert.deepEqual(discoverySnapshot(before,[injection(0,'new',[])]).videoElements,[],'old recording refs are not retained as current targets');
});

test('global recording target limit prioritizes playing elements and excludes non-video references',()=>{
  const top=injection(0,'top',[]),child=injection(7,'child',[]);
  top.result.videoElements=Array.from({length:100},(_,i)=>({elementTag:'VIDEO',elementToken:`v${i}`,videoRef:`v${i}`,paused:true}));
  child.result.videoElements=[
    {elementTag:'SCRIPT',elementToken:'script',videoRef:'script'},
    {elementTag:'VIDEO',elementToken:'different',videoRef:'wrong'},
    {elementTag:'VIDEO',elementToken:'current',videoRef:'current',playing:true},
  ];
  const output=discoverySnapshot(state(),[top,child]);
  assert.equal(output.videoElements.length,100);
  assert.equal(output.videoElements[0].elementToken,'current');
  assert.ok(output.notices.some(notice=>notice.includes('100')));
  assert.ok(!output.videoElements.some(video=>video.elementTag!=='VIDEO' || video.elementToken!==video.videoRef));
});

test('legacy migration clears recording references and current sessions initialize an empty selector',()=>{
  const legacy=migrateDiscovery({items:[],videoElements:[{elementToken:'inherited-frame'}]});
  assert.deepEqual(legacy.videoElements,[]);
  assert.deepEqual(migrateDiscovery(state()).videoElements,[]);
});
