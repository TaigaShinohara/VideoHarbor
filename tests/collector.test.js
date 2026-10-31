import test from 'node:test';
import assert from 'node:assert/strict';
import {collect} from '../extension/collector.js';

function node(tag,attrs = {},props = {},children = []) {
  const descendants = () => children.flatMap(child => [child,...child.querySelectorAll('*')]);
  return {tagName:tag.toUpperCase(),baseURI:'https://page.test/path/',...props,
    getAttribute(name) { return attrs[name] ?? null; },
    querySelectorAll(selector) { const all = descendants(); return selector === '*' ? all : all.filter(el => el.tagName === selector.toUpperCase()); },
  };
}
function documentFor(children,resources = [],baseURI = 'https://page.test/path/') {
  return {...node('document',{}, {},children),baseURI,defaultView:{performance:{getEntriesByType:() => resources}}};
}
function scan(t,doc) {
  const previous = Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:doc});
  t.after(() => { if (previous) Object.defineProperty(globalThis,'document',previous); else delete globalThis.document; });
  // This is also the shape serialized by chrome.scripting.executeScript: no module helpers.
  return (0,eval)(`(${collect.toString()})()`);
}
const bySuffix = (result,suffix) => result.items.find(item => item.url.endsWith(suffix));

test('collector preserves blob currentSrc and independent original/lazy/source URLs',t => {
  const video = node('video',{'src':'original.mp4','data-src':'lazy.webm','data-hls':'stream.m3u8'},
    {currentSrc:'blob:https://page.test/live',videoWidth:1920,videoHeight:1080},[
      node('source',{'src':'fallback','type':'video/mp4'}),
      node('source',{'data-src':'manifest','type':'application/vnd.apple.mpegurl'}),
    ]);
  const result = scan(t,documentFor([video]));
  assert.equal(result.items.length,6);
  assert.ok(result.items.some(item => item.url === 'blob:https://page.test/live'));
  assert.equal(bySuffix(result,'original.mp4').width,1920);
  assert.equal(bySuffix(result,'manifest').mime,'application/vnd.apple.mpegurl');
  assert.equal(bySuffix(result,'fallback').mediaHint,true);
});

test('collector reads video metadata, JSON-LD and explicit JSON sources without evaluating scripts',t => {
  const json = { '@graph':[
    {'@type':'VideoObject',contentUrl:'/video-endpoint',encodingFormat:'video/mp4',embedUrl:'https://embed.test/watch'},
    {'@type':'ImageObject',contentUrl:'/cover.jpg'},
  ],player:{sources:[{src:'/hls-endpoint',type:'application/x-mpegURL'},{file:'/movie.webm'}]},
    auth:{url:'/login',src:'/session',file:'/secret.json'}, thumbnail:'/thumb.jpg'};
  const result = scan(t,documentFor([
    node('meta',{property:'og:video',content:'/og-video'}),
    node('meta',{property:'og:video:type',content:'video/mp4'}),
    node('meta',{name:'twitter:player:stream',content:'/twitter-endpoint'}),
    node('meta',{name:'twitter:player',content:'https://embed.test/watch'}),
    node('script',{type:'application/ld+json'},{textContent:JSON.stringify(json)}),
    node('script',{}, {textContent:'globalThis.__collectorMustNotExecute = true;'}),
    node('script',{type:'application/json'}, {textContent:'{broken'}),
  ]));
  assert.deepEqual(result.items.map(item => new URL(item.url).pathname).sort(),['/hls-endpoint','/movie.webm','/og-video','/twitter-endpoint','/video-endpoint']);
  assert.equal(bySuffix(result,'hls-endpoint').mime,'application/x-mpegURL');
  assert.equal(globalThis.__collectorMustNotExecute,undefined);
});

test('collector discovers typed links, object/embed, player data and loaded video only',t => {
  const result = scan(t,documentFor([
    node('a',{href:'/download',type:'video/mp4'}),
    node('a',{href:'/watch'}),
    node('object',{data:'/embedded',type:'video/webm'}),
    node('embed',{src:'/other.mp4'}),
    node('div',{'data-video-src':'/container-video'}),
    node('div',{'data-src':'/image.jpg'}),
    node('video',{'data-setup':JSON.stringify({sources:[{src:'/setup.mp4'}]})}),
  ],[
    {name:'https://cdn.test/no-extension',initiatorType:'video'},
    {name:'https://cdn.test/api/session',initiatorType:'fetch'},
    {name:'https://cdn.test/master.m3u8?auth=synthetic',initiatorType:'fetch'},
  ]));
  assert.equal(result.items.length,7);
  assert.ok(bySuffix(result,'no-extension').mediaHint);
  assert.ok(result.items.some(item => item.url.includes('master.m3u8?auth=synthetic')));
  assert.ok(!result.items.some(item => /session|watch|image.jpg/.test(item.url)));
});

test('collector reports embedded page URLs separately and walks same-origin/open shadow content',t => {
  const child = documentFor([node('video',{src:'https://frame.test/frame.mp4'})]);
  const inaccessible = node('iframe',{src:'https://other.test/player?video=123'},{get contentDocument() { return null; }});
  const shadow = node('div',{}, {shadowRoot:node('shadow',{}, {},[node('video',{src:'/shadow.webm'})])});
  const result = scan(t,documentFor([
    node('iframe',{src:'/frame'},{contentDocument:child}), inaccessible,shadow,
    node('iframe',{src:'javascript:alert(1)'}),
  ]));
  assert.deepEqual(result.frames.map(item => item.url),['https://page.test/frame','https://other.test/player?video=123']);
  assert.ok(bySuffix(result,'frame.mp4'));
  assert.ok(bySuffix(result,'shadow.webm'));
  assert.ok(!result.items.some(item => item.url.includes('player?')));
});

test('collector rejects unsafe media URLs and preserves stronger duplicate metadata',t => {
  const result = scan(t,documentFor([
    node('video',{src:'/movie.mp4',type:'video/mp4'},{videoWidth:1280,videoHeight:720}),
    node('a',{href:'/movie.mp4'}),
    node('video',{src:'javascript:alert(1)'}),
    node('video',{src:'file:///private/movie.mp4'}),
    node('video',{src:'https://name:password@page.test/private.mp4'}),
    node('video',{src:'data:video/mp4;base64,AAAA'}),
    node('video',{src:'https://*/movie.mp4'}),
    node('iframe',{src:'https://*.example.test/player'}),
  ],[{name:'https://page.test/movie.mp4',initiatorType:'video'}]));
  assert.equal(result.items.length,1);
  assert.equal(result.frames.length,0);
  assert.equal(result.items[0].source,'video');
  assert.equal(result.items[0].mime,'video/mp4');
  assert.equal(result.items[0].width,1280);
});

test('collector bounds candidates, iframe hints and JSON processing with visible notices',t => {
  const result = scan(t,documentFor([
    ...Array.from({length:502},(_,i) => node('a',{href:`/video${i}.mp4`})),
    ...Array.from({length:34},(_,i) => node('iframe',{src:`https://frame${i}.test/player`})),
    node('script',{type:'application/json'},{textContent:' '.repeat(524289)}),
  ]));
  assert.equal(result.items.length,500);
  assert.equal(result.frames.length,32);
  assert.ok(result.notices.some(notice => notice.includes('500')));
  assert.ok(result.notices.some(notice => notice.includes('32')));
  assert.ok(result.notices.some(notice => notice.includes('動画設定')));
});
test('collector keeps stream hints on extensionless data attributes and grouped Open Graph types',t => {
  const result = scan(t,documentFor([
    node('div',{'data-hls':'/hls-endpoint'}),node('video',{'data-dash':'/dash-endpoint'}),
    node('meta',{property:'og:video',content:'/video-endpoint'}),
    node('meta',{property:'og:video:type',content:'video/mp4'}),
    node('meta',{property:'og:video',content:'https://embed.test/player'}),
    node('meta',{property:'og:video:type',content:'text/html'}),
    node('script',{type:'application/json'},{textContent:JSON.stringify({sources:[{src:'/typed-hls',type:'hls'}]})}),
  ]));
  assert.equal(bySuffix(result,'hls-endpoint').mime,'application/vnd.apple.mpegurl');
  assert.equal(bySuffix(result,'dash-endpoint').mime,'application/dash+xml');
  assert.equal(bySuffix(result,'typed-hls').mime,'application/vnd.apple.mpegurl');
  assert.equal(bySuffix(result,'video-endpoint').mime,'video/mp4');
  assert.ok(!result.items.some(item => item.url.startsWith('https://embed.test/')));
});
