import test from 'node:test';
import assert from 'node:assert/strict';
import {groupVideos,formatDuration} from '../extension/video-view.js';

test('a proven video groups its sources while distinct same-name videos stay separate',()=>{
  const occurrence={videoRef:'video-1',frameToken:'document-a',title:'青いカップ',playing:true,duration:61};
  const items=[
    {url:'https://cdn.test/clip.mp4?a=1',occurrences:[occurrence]},
    {url:'https://cdn.test/clip.webm',occurrences:[occurrence]},
    {url:'https://cdn.test/clip.mp4?a=2',occurrences:[{...occurrence,videoRef:'video-2',playing:false}]},
  ];
  const groups=groupVideos(items);
  assert.equal(groups.length,2);
  assert.equal(groups[0].title,'青いカップ');
  assert.equal(groups[0].items.length,2);
  assert.equal(groups[1].title,'青いカップ');
  assert.equal(groups[1].items[0].url,'https://cdn.test/clip.mp4?a=2');
});

test('a shared resource has one card across distinct players, frames and config occurrences',()=>{
  const item={url:'https://cdn.test/clip.mp4?token=synthetic',occurrences:[
    {videoRef:'v1',frameToken:'doc-a'}, {videoRef:'v2',frameToken:'doc-a'},
    {videoRef:'v1',frameToken:'doc-b'}, {configRef:'config-1',frameToken:'doc-a'},
  ]};
  const before=structuredClone(item);
  const groups=groupVideos([item]);
  assert.equal(groups.length,1);
  assert.equal(groups[0].items.length,1);
  assert.equal(groups[0].items[0],item,'single resource records should keep their identity and source occurrences');
  assert.deepEqual(item,before,'grouping must preserve every source occurrence on its input');
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

test('an untitled visible representative does not inherit hidden source titles, duration or preview',()=>{
  const groups=groupVideos([{url:'https://cdn.test/shared.mp4',title:'広告',occurrences:[
    {videoRef:'main',frameToken:'doc',visible:true},
    {videoRef:'ad',frameToken:'doc',title:'広告',duration:15,previewDataURL:'data:image/jpeg;base64,AA=='},
  ]}]);
  assert.equal(groups.length,1);
  assert.equal(groups[0].title,'');
  assert.equal(groups[0].source.videoRef,'main');
  assert.equal(groups[0].duration,undefined);
  assert.equal(groups[0].previewDataURL,undefined);
});

test('playing representatives keep their own title, duration and preview regardless of source order',()=>{
  const hidden={videoRef:'hidden',frameToken:'doc-a',title:'Hidden copy',duration:9,previewDataURL:'data:image/jpeg;base64,AA=='};
  const visible={videoRef:'visible',frameToken:'doc-b',visible:true,title:'Visible copy',duration:30,previewDataURL:'data:image/jpeg;base64,AQ=='};
  const playing={videoRef:'playing',frameToken:'doc-b',playing:true,title:'Playing copy',duration:61,previewDataURL:'data:image/jpeg;base64,Ag=='};
  for(const occurrences of [[hidden,visible,playing],[playing,hidden,visible],[visible,playing,hidden]]) {
    const item={url:'https://cdn.test/shared.mp4',occurrences};
    const before=structuredClone(item);
    const groups=groupVideos([item]);
    assert.equal(groups.length,1);
    assert.equal(groups[0].source.videoRef,'playing');
    assert.equal(groups[0].title,playing.title);
    assert.equal(groups[0].duration,playing.duration);
    assert.equal(groups[0].previewDataURL,playing.previewDataURL);
    assert.equal(groups[0].playing,true);
    assert.deepEqual(item,before);
  }
});

test('a visible DOM player represents the shared URL instead of a hidden player or config record',()=>{
  const visible={videoRef:'visible',frameToken:'doc',visible:true,title:'Visible video',duration:90,previewDataURL:'data:image/jpeg;base64,AQ=='};
  const groups=groupVideos([{url:'https://cdn.test/shared.mp4',occurrences:[
    {configRef:'config',frameToken:'doc',title:'Config title',duration:180},
    {videoRef:'hidden',frameToken:'doc',title:'Hidden title',duration:45},
    visible,
  ]}]);
  assert.equal(groups.length,1);
  assert.equal(groups[0].source.videoRef,'visible');
  assert.equal(groups[0].title,visible.title);
  assert.equal(groups[0].duration,visible.duration);
  assert.equal(groups[0].previewDataURL,visible.previewDataURL);
});

test('overlapping proven source groups retain every alternative once without absorbing unrelated same-name videos',()=>{
  const first={videoRef:'one',frameToken:'doc',title:'Same name'};
  const second={configRef:'two',frameToken:'doc',title:'Same name',playing:true};
  const unrelated={videoRef:'three',frameToken:'doc',title:'Same name'};
  const items=[
    {url:'https://cdn.test/first.mp4',occurrences:[first]},
    {url:'https://cdn.test/shared.webm',occurrences:[first,second]},
    {url:'https://cdn.test/third.mp4',occurrences:[second]},
    {url:'https://cdn.test/unrelated.mp4',occurrences:[unrelated]},
  ];
  const before=structuredClone(items);
  for(const input of [items,[...items].reverse(),[items[2],items[1],items[0],items[3],items[1],items[0]]]) {
    const groups=groupVideos(input);
    assert.equal(groups.length,2);
    const combined=groups.find(group=>group.items.some(item=>item.url==='https://cdn.test/shared.webm'));
    assert.deepEqual(new Set(combined.items.map(item=>item.url)),new Set(items.slice(0,3).map(item=>item.url)));
    assert.equal(combined.items.length,3);
    const displayed=groups.flatMap(group=>group.items.map(item=>item.url));
    assert.equal(displayed.length,4);
    assert.equal(new Set(displayed).size,4);
    assert.equal(groups.find(group=>group!==combined).items[0].url,'https://cdn.test/unrelated.mp4');
  }
  assert.deepEqual(items,before);
});

test('overlap groups pair legacy source location with its own URL while current video location keeps source order',()=>{
  const identity={frameToken:'frame',documentId:'doc',documentURL:'https://page.test'};
  const first={...identity,videoRef:'a',id:'aA'};
  const sharedA={...identity,videoRef:'a',id:'aShared',elementTag:'VIDEO',elementToken:'a'};
  const sharedB={...identity,videoRef:'b',id:'bShared'};
  const last={...identity,videoRef:'b',id:'bB',visible:true};
  const items=[
    {url:'https://cdn.test/a.mp4',occurrences:[first]},
    {url:'https://cdn.test/shared.webm',occurrences:[sharedA,sharedB]},
    {url:'https://cdn.test/b.mp4',occurrences:[last]},
  ];
  const before=structuredClone(items);
  for(const input of [items,[items[1],items[0],items[2]],[...items].reverse()]) {
    const groups=groupVideos(input,[]);
    assert.equal(groups.length,1);
    assert.equal(groups[0].source,last);
    assert.equal(groups[0].recordable,false);
    assert.ok(groups[0].items[0].occurrences.some(source=>source.id===groups[0].source.id),
      'legacy locate-source must receive the URL containing the selected occurrence ID');
    assert.equal(groups[0].items[0].url,'https://cdn.test/b.mp4');
    assert.equal(new Set(groups[0].items.map(item=>item.url)).size,3);
  }
  const current=groupVideos(items,[sharedA]);
  assert.equal(current[0].source,sharedA);
  assert.equal(current[0].recordable,true);
  assert.deepEqual(current[0].items.map(item=>item.url),items.map(item=>item.url),
    'current locate-video uses the element reference and does not need to move its resource first');
  assert.deepEqual(items,before);
});

test('repeated input records for one complete URL cannot duplicate its card or hide a better representative',()=>{
  const config={url:'https://cdn.test/shared.mp4?token=one',occurrences:[{configRef:'config',frameToken:'doc',title:'Config'}]};
  const player={url:config.url,occurrences:[{videoRef:'player',frameToken:'doc',visible:true,title:'Actual video',duration:12}]};
  for(const input of [[config,player,config],[player,config,player]]) {
    const before=structuredClone(input);
    const groups=groupVideos(input);
    assert.equal(groups.length,1);
    assert.equal(groups[0].items.length,1);
    assert.equal(groups[0].items[0].url,config.url);
    assert.deepEqual(new Set(groups[0].items[0].occurrences.map(source=>source.videoRef || source.configRef)),new Set(['config','player']));
    assert.equal(groups[0].items[0].occurrences.length,2);
    assert.equal(groups[0].source.videoRef,'player');
    assert.equal(groups[0].title,'Actual video');
    assert.equal(groups[0].duration,12);
    assert.deepEqual(input,before);
  }
});

test('real URL-less videos are recordable and proven URL groups reuse the same element reference',()=>{
  const reference={elementTag:'VIDEO',videoRef:'stream',elementToken:'stream',frameToken:'frame',documentURL:'https://page.test',documentId:'doc',title:'Live video',playing:true};
  const sources=[{url:'blob:https://page.test/source',occurrences:[{...reference,title:'Older label'}]}];
  const groups=groupVideos(sources,[reference,{...reference,videoRef:'empty',elementToken:'empty',title:'No URL',playing:false}]);
  assert.equal(groups.length,2);
  assert.equal(groups[0].items.length,1);
  assert.equal(groups[0].title,'Live video');
  assert.equal(groups[0].source,reference);
  assert.equal(groups[0].recordable,true);
  assert.equal(groups[1].items.length,0);
  assert.equal(groups[1].recordable,true);
  assert.equal(groups[1].history,false);
});

test('a saved URL or player setting never enables video-only recording without a real current element',()=>{
  const groups=groupVideos([
    {url:'https://cdn.test/clip.mp4',occurrences:[{videoRef:'old',frameToken:'old-frame'}]},
    {url:'https://cdn.test/config.mp4',occurrences:[{configRef:'player',frameToken:'frame'}]},
  ],[{elementTag:'SCRIPT',videoRef:'script',elementToken:'script',frameToken:'frame',documentURL:'https://page.test'}]);
  assert.equal(groups.length,2);
  assert.ok(groups.every(group=>group.recordable===false));
});

test('duplicate current video elements share one save card and keep the current playing or visible recording target',()=>{
  const identity={elementTag:'VIDEO',frameToken:'frame',documentId:'doc',documentURL:'https://page.test'};
  const hidden={...identity,elementToken:'hidden',videoRef:'hidden',title:'Hidden copy',duration:9};
  const visible={...identity,elementToken:'visible',videoRef:'visible',visible:true,title:'Current visible',duration:90,previewDataURL:'data:image/jpeg;base64,AQ=='};
  const playing={...identity,elementToken:'playing',videoRef:'playing',playing:true,title:'Current playing',duration:91,previewDataURL:'data:image/jpeg;base64,Ag=='};
  const item={url:'https://cdn.test/shared.mp4',discovery:'loaded-history',occurrences:[
    {...hidden,playing:true,title:'Old playing label'},
    {...visible,title:'Old visible label'},
    {...playing,title:'Old title'},
    {configRef:'config',frameToken:'frame',documentId:'doc',playing:true,visible:true,title:'Config title'},
  ]};
  for(const {current,expected} of [
    {current:[hidden,visible,playing,visible],expected:playing},
    {current:[{...playing,playing:false},hidden,visible],expected:visible},
  ]) {
    const before=structuredClone({item,current});
    const groups=groupVideos([item],current);
    assert.equal(groups.length,1);
    assert.equal(groups[0].items.length,1);
    assert.equal(groups[0].items[0],item);
    assert.equal(groups[0].source,expected);
    assert.equal(groups[0].title,expected.title);
    assert.equal(groups[0].duration,expected.duration);
    assert.equal(groups[0].previewDataURL,expected.previewDataURL);
    assert.equal(groups[0].playing,Boolean(expected.playing));
    assert.equal(groups[0].recordable,true);
    assert.equal(groups[0].history,false);
    assert.deepEqual({item,current},before);
  }
});

test('old video occurrences and config metadata cannot overwrite an untitled current recording reference',()=>{
  const current={elementTag:'VIDEO',elementToken:'current',videoRef:'current',frameToken:'frame',documentId:'doc',documentURL:'https://page.test',visible:true};
  const item={url:'https://cdn.test/shared.mp4',occurrences:[
    {...current,playing:true,title:'Stale title',duration:180,previewDataURL:'data:image/jpeg;base64,AA=='},
    {configRef:'config',frameToken:'frame',documentId:'doc',playing:true,visible:true,title:'Config title',duration:240},
  ]};
  const before=structuredClone({item,current});
  const groups=groupVideos([item],[current]);
  assert.equal(groups.length,1);
  assert.equal(groups[0].source,current);
  assert.equal(groups[0].title,'');
  assert.equal(groups[0].duration,undefined);
  assert.equal(groups[0].previewDataURL,undefined);
  assert.equal(groups[0].playing,false);
  assert.equal(groups[0].recordable,true);
  assert.deepEqual({item,current},before);
});

test('distinct current URL-less videos remain separate recording targets even when their titles match',()=>{
  const identity={elementTag:'VIDEO',frameToken:'frame',documentId:'doc',documentURL:'https://page.test',title:'Live video'};
  const videos=[
    {...identity,elementToken:'first',videoRef:'first',visible:true},
    {...identity,elementToken:'second',videoRef:'second',playing:true},
    {...identity,elementToken:'third',videoRef:'third'},
  ];
  const before=structuredClone(videos);
  const groups=groupVideos([],videos);
  assert.equal(groups.length,3);
  assert.equal(new Set(groups.map(group=>group.id)).size,3);
  assert.deepEqual(new Set(groups.map(group=>group.source)),new Set(videos));
  assert.ok(groups.every(group=>group.recordable && group.items.length===0 && !group.history));
  assert.equal(groups[0].source,videos[1]);
  assert.deepEqual(videos,before);
});
