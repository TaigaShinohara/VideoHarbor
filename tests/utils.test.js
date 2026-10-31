import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizePart,mediaType,mediaKind,allowedURL,extensionOf,fileLabel,downloadName,matchesImage,mergeItems,summarizeJobs,publicError} from '../extension/utils.js';
test('filenames stay inside chosen download folder',()=>{
  assert.equal(sanitizePart('../../bad\\name:*'),'_.._bad_name__');
  assert.equal(sanitizePart('..'),'untitled');
  assert.equal(sanitizePart('CON'),'_CON');
  const name=downloadName({url:'https://example.test/a%2Fb.png?token=private'},'../../outside',0,'images');
  assert.equal(name.split('/').length,3);assert.ok(!name.includes('token'));
  assert.ok(name.endsWith('.png'));assert.ok(!name.split('/').some(p=>p==='..'));
});
test('reject executable and credential-bearing URLs',()=>{
  for(const url of ['javascript:alert(1)','file:///tmp/a.png','https://u:p@example.test/image.png','data:text/html,test','https://*/image.png','https://*.cdn.test/image.png'])assert.equal(allowedURL(url,'images'),false);
  assert.equal(allowedURL('https://example.test/image?id=1','images'),true);
  assert.equal(allowedURL('data:image/png;base64,AA==','images'),true);
  assert.equal(allowedURL('data:image/png;base64,AA==','videos'),false);
  assert.equal(allowedURL('data:image/png;base64,'+'a'.repeat(131072),'images'),false);
});
test('streaming manifests never masquerade as direct files',()=>{
  assert.equal(mediaType('https://a.test/a.m3u8?x=1'),'stream');
  assert.equal(mediaType('https://a.test/a.mpd'),'stream');
  assert.equal(mediaType('https://a.test/no-suffix','application/vnd.apple.mpegurl'),'stream');
  assert.equal(mediaType('blob:https://a.test/123'),'blob');
  assert.equal(mediaType('https://a.test/a.webm?auth=yes'),'direct');
  assert.equal(mediaType('https://a.test/resource','video/mp4'),'direct');
  assert.equal(mediaType('https://a.test/resource'),'unknown');
});
test('query strings remain part of identity and do not affect suffixes',()=>{
  assert.equal(extensionOf('https://a.test/a.PNG?size=2','images'),'png');
  assert.equal(extensionOf('data:image/svg+xml;base64,AAA=','images'),'svg');
  assert.equal(fileLabel('https://a.test/photo%20one.jpg?secret=value'),'photo one.jpg');
  assert.equal(extensionOf('https://a.test/endpoint?file=movie.mp4','videos'),'video');
});
test('specific media kinds distinguish HLS, DASH and actual blob URLs',()=>{
  assert.equal(mediaKind('https://a.test/master.m3u8?auth=synthetic'),'hls');
  assert.equal(mediaKind('https://a.test/manifest','application/vnd.apple.mpegurl'),'hls');
  assert.equal(mediaKind('https://a.test/manifest.mpd'),'dash');
  assert.equal(mediaKind('https://a.test/manifest','application/dash+xml'),'dash');
  assert.equal(mediaKind('blob:https://a.test/uuid','video/mp4'),'blob');
  assert.equal(mediaKind('https://a.test/video','video/mp4'),'direct');
  assert.equal(mediaKind('https://a.test/watch'),'unknown');
});
test('unknown dimensions are excluded only when requested',()=>{
  const item={url:'https://a.test/photo.png',alt:'海',width:0,height:0};
  assert.ok(matchesImage(item,{}));assert.ok(!matchesImage(item,{width:100}));
  assert.ok(matchesImage({...item,width:300,height:200},{query:'海',width:200,height:100,type:'png'}));
  assert.ok(!matchesImage(item,{query:'mountain'}));
});
test('rescan merges URLs, retains records, and adds variants',()=>{
  const before=[{url:'https://a.test/i?size=1',width:100,alt:'first'}];
  const merged=mergeItems(before,[{url:'https://a.test/i?size=1',width:200},{url:'https://a.test/i?size=2',width:400}]);
  assert.equal(merged.length,2);assert.equal(merged[0].width,200);assert.equal(merged[0].alt,'first');assert.equal(before[0].width,100);
});
test('accepted and queued downloads are not completed',()=>{
  assert.deepEqual(summarizeJobs([{status:'queued'},{status:'in_progress'},{status:'complete'},{status:'interrupted'}]),{total:4,complete:1,interrupted:1,active:2});
});
test('rescans retain stronger video metadata when only a weak resource hint remains',()=>{
  const merged = mergeItems([{url:'https://a.test/clip',source:'video',mime:'video/mp4',width:1920,height:1080,mediaHint:true}],
    [{url:'https://a.test/clip',source:'loaded-resource',mime:'',width:0,height:0,mediaHint:false}]);
  assert.equal(merged[0].mime,'video/mp4');assert.equal(merged[0].source,'video');
  assert.equal(merged[0].width,1920);assert.equal(merged[0].height,1080);assert.equal(merged[0].mediaHint,true);
});
test('public errors do not reproduce signed media URLs',()=>{
  const s=publicError(new Error('Failed https://example.test/media?secret=token'));
  assert.ok(!s.includes('secret'));assert.ok(s.includes('[URL]'));
  assert.match(publicError({name:'AbortError'}),/キャンセル/);
});
test('selected MP4 filenames apply only to video output and preserve source URLs and safe folder boundaries',()=>{
  const item=Object.freeze({url:'https://media.test/movie.m4v?secret=synthetic'});
  assert.match(downloadName(item,'Page',0,'videos'),/movie\.m4v$/);
  assert.match(downloadName(item,'Page',0,'videos','auto'),/movie\.m4v$/);
  const name=downloadName(item,'../../Page',0,'videos','mp4');
  assert.match(name,/movie\.mp4$/);assert.equal(name.split('/').length,3);assert.ok(!name.includes('secret'));
  assert.equal(item.url,'https://media.test/movie.m4v?secret=synthetic');
  assert.match(downloadName({url:'https://media.test/image.png'},'Page',0,'images','mp4'),/\.png$/,'video selection does not alter image formats');
  assert.match(downloadName({url:'https://media.test/endpoint'},'Page',0,'videos','mp4'),/\.mp4$/,'validated typed MP4 endpoints get a concrete extension');
  assert.match(downloadName({url:'https://media.test/endpoint',mime:'video/mp4'},'Page',0,'videos','auto'),/\.mp4$/,'source naming uses known MIME for extensionless URLs');
  assert.match(downloadName({url:'https://media.test/misleading.mp4',mime:'video/webm'},'Page',0,'videos','auto'),/\.webm$/,'auto naming agrees with the actual known source type');
});
