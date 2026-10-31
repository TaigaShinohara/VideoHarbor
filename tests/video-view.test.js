import test from 'node:test';
import assert from 'node:assert/strict';
import {groupVideos,formatDuration} from '../extension/video-view.js';

test('a proven video groups its sources while distinct same-name videos stay separate',()=>{
  const occurrence={videoRef:'video-1',frameToken:'document-a',title:'青いカップ',playing:true,duration:61};
  const items=[
    {url:'https://cdn.test/clip.mp4?a=1',occurrences:[occurrence]},
    {url:'https://cdn.test/clip.webm',occurrences:[occurrence]},
    {url:'https://cdn.test/clip.mp4?a=2',occurrences:[{...occurrence,videoRef:'video-2',title:'赤いカップ',playing:false}]},
  ];
  const groups=groupVideos(items);
  assert.equal(groups.length,2);
  assert.equal(groups[0].title,'青いカップ');
  assert.equal(groups[0].items.length,2);
  assert.equal(groups[1].title,'赤いカップ');
});

test('shared resources can belong to two player occurrences without losing their URL identity',()=>{
  const item={url:'https://cdn.test/clip.mp4?token=synthetic',occurrences:[
    {videoRef:'v1',frameToken:'doc-a'}, {videoRef:'v2',frameToken:'doc-a'}, {videoRef:'v1',frameToken:'doc-b'},
  ]};
  const groups=groupVideos([item]);
  assert.equal(groups.length,3);
  assert.ok(groups.every(group=>group.items[0]===item));
});

test('unrelated frame resources and old loading records are not silently recognized as one video',()=>{
  const groups=groupVideos([
    {url:'https://cdn.test/master.m3u8?a=1',discovery:'loaded-history',occurrences:[{frameToken:'same',source:'loaded-resource'}]},
    {url:'https://cdn.test/master.m3u8?a=2',occurrences:[{frameToken:'same',source:'metadata'}]},
  ]);
  assert.equal(groups.length,2);
  assert.equal(groups[0].history,false);
  assert.equal(groups[1].history,true);
  assert.ok(groups.every(group=>!group.linked));
});

test('only bounded local video snapshots can become a preview',()=>{
  for(const previewDataURL of ['https://external.test/poster.jpg','data:image/svg+xml,<svg/>','data:image/jpeg;base64,'+'A'.repeat(32768)]) {
    assert.equal(groupVideos([{url:'https://cdn.test/movie',occurrences:[{videoRef:'v',previewDataURL}]}])[0].previewDataURL,undefined);
  }
  assert.equal(formatDuration(61),'1:01');
  assert.equal(formatDuration(3661),'1:01:01');
  assert.equal(formatDuration(Infinity),'');
});

test('a representative title never labels another untitled occurrence of the same resource',()=>{
  const groups=groupVideos([{url:'https://cdn.test/shared.mp4',title:'広告',occurrences:[
    {videoRef:'main',frameToken:'doc'}, {videoRef:'ad',frameToken:'doc',title:'広告'},
  ]}]);
  assert.equal(groups[0].title,'');
  assert.equal(groups[1].title,'広告');
});
