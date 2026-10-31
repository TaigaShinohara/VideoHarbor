import test from 'node:test';
import assert from 'node:assert/strict';
import {collect,locateSourceElement} from '../extension/collector.js';

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

test('collector excludes image resources attributed to video without matching images in video queries or directories',t => {
  const extensions=['jpg','jpeg','png','gif','webp','avif','svg','bmp','ico','tif','tiff','heic','heif','jfif'];
  const videos=['https://cdn.test/playback?poster=cover.jpg','https://cdn.test/poster.jpg/movie.mp4?thumbnail=cover.png'];
  const resources=[
    ...extensions.map(extension=>({name:`https://cdn.test/cover.${extension.toUpperCase()}?size=160#preview`,initiatorType:'video'})),
    {name:'https://cdn.test/cover%2E%6A%70%67?size=160',initiatorType:'video'},
    ...videos.map(name=>({name,initiatorType:'video'})),
  ];
  const result=scan(t,documentFor([],resources));
  assert.deepEqual(result.items.map(item=>item.url),videos);
  assert.ok(result.items.every(item=>item.mediaHint));
});

test('collector rejects explicit image MIME even for extensionless or video-shaped URLs and preserves video blobs',t => {
  const result=scan(t,documentFor([
    node('video',{src:'/image-endpoint',type:'image/png'}),
    node('a',{href:'/image.mp4',type:'IMAGE/JPEG; charset=binary'}),
    node('video',{}, {},[node('source',{src:'/source-endpoint',type:'image/webp'})]),
    node('video',{src:'/movie.mp4'},{currentSrc:'blob:https://page.test/actual-video'}),
  ]));
  assert.deepEqual(result.items.map(item=>item.url),['blob:https://page.test/actual-video','https://page.test/movie.mp4']);
});

test('collector respects image MIME from JSON media fields, structured metadata and Open Graph',t => {
  const result=scan(t,documentFor([
    node('script',{type:'application/ld+json'},{textContent:JSON.stringify({
      '@graph':[
        {'@type':'VideoObject',contentUrl:'/structured-poster',encodingFormat:'image/jpeg'},
        {file:'/config-image.mp4',type:'image/png'},
        {video_url:'/field-poster',mimeType:'image/webp'},
        {mp4:'/typed-poster',type:'image/avif'},
        {file:'/actual.mp4',type:'video/mp4'},
      ],
    })}),
    node('meta',{property:'og:video',content:'/og-image.mp4'}),
    node('meta',{property:'og:video:type',content:'image/png'}),
  ]));
  assert.deepEqual(result.items.map(item=>item.url),['https://page.test/actual.mp4']);
});

test('video poster resources do not fill the candidate budget before a real loaded video',t => {
  const resources=Array.from({length:501},(_,index)=>({name:`https://cdn.test/poster${index}.jpg`,initiatorType:'video'}));
  resources.push({name:'https://cdn.test/playback',initiatorType:'video'});
  const result=scan(t,documentFor([],resources));
  assert.deepEqual(result.items.map(item=>item.url),['https://cdn.test/playback']);
  assert.ok(!result.notices.some(notice=>notice.includes('500')));
});

test('collector leaves each iframe document to its own injection and walks open shadow content',t => {
  const child = documentFor([node('video',{src:'https://frame.test/frame.mp4'})]);
  const inaccessible = node('iframe',{src:'https://other.test/player?video=123'},{get contentDocument() { return null; }});
  const shadow = node('div',{}, {shadowRoot:node('shadow',{}, {},[node('video',{src:'/shadow.webm'})])});
  const result = scan(t,documentFor([
    node('iframe',{src:'/frame'},{contentDocument:child}), inaccessible,shadow,
    node('iframe',{src:'javascript:alert(1)'}),
  ]));
  assert.deepEqual(result.frames.map(item => item.url),['https://page.test/frame','https://other.test/player?video=123']);
  assert.equal(bySuffix(result,'frame.mp4'),undefined,'parent output must not inherit child media');
  assert.ok(bySuffix(scan(t,child),'frame.mp4'),'the child injection discovers its own media');
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

test('collector parses strict JSON in known player assignments and setup calls without running JavaScript',t => {
  const result = scan(t,documentFor([
    node('script',{}, {textContent:`
      window.__PLAYER_CONFIG__ = {"sources":[{"file":"/assigned.mp4"}]};
      window.__INITIAL_STATE__ = {"player":{"hlsManifestUrl":"/hls-endpoint"}};
      jwplayer("example-player").setup({"playlist":[{"sources":[{"file":"/setup.webm"}]}]});
      jwplayer('example-player').load([{"file":"/loaded.mp4"}]);
      new Playerjs({"file":"/playerjs.mp4"});
      new Clappr.Player({"sources":["/clappr.mp4"]});
      videojs("example-player", {"sources":[{"src":"/videojs.mp4"}]});
      globalThis.__collectorMustNotExecute = true;
    `}),
    node('script',{}, {textContent:'videojs("another-player", {"sources":[{"src":"/standalone-videojs.mp4"}]});'}),
  ]));
  assert.deepEqual(result.items.map(item => new URL(item.url).pathname).sort(),['/assigned.mp4','/clappr.mp4','/hls-endpoint','/loaded.mp4','/playerjs.mp4','/setup.webm','/standalone-videojs.mp4','/videojs.mp4']);
  assert.equal(bySuffix(result,'hls-endpoint').mime,'application/vnd.apple.mpegurl');
  assert.equal(globalThis.__collectorMustNotExecute,undefined);
});

test('collector reads known JSON strings and HTML-escaped URLs as data',t => {
  const parsed = JSON.stringify({sources:[{file:'/parsed.mp4?one=1&two=2'}]});
  const result = scan(t,documentFor([
    node('script',{}, {textContent:`window.playerConfig = JSON.parse('${parsed}');`}),
    node('script',{}, {textContent:`window.videoConfig = JSON.parse(${JSON.stringify(JSON.stringify({sources:[{src:'/quoted.webm'}]}))});`}),
    node('script',{}, {textContent:`window.__VIDEO_DATA__ = ${JSON.stringify(JSON.stringify({videoUrl:'/json-string.mp4'}))};`}),
    node('script',{}, {textContent:'window.playerData = {&quot;sources&quot;:[{&quot;src&quot;:&quot;/encoded.mp4?one=1&amp;two=2&quot;}]};'}),
    node('video',{'data-video-src':'/html.mp4?one=1&amp;two=2'}),
    node('script',{type:'application/json'}, {textContent:JSON.stringify({hls:'/master?one=1&amp;two=2',dashManifestUrl:'/dash-endpoint'})}),
  ]));
  assert.equal(result.items.length,7);
  for (const filename of ['parsed.mp4','encoded.mp4','html.mp4']) {
    const item = result.items.find(item => new URL(item.url).pathname === '/'+filename);
    assert.equal(new URL(item.url).search,'?one=1&two=2');
  }
  assert.ok(bySuffix(result,'quoted.webm'));
  assert.ok(bySuffix(result,'json-string.mp4'));
  assert.equal(result.items.find(item => new URL(item.url).pathname === '/master').mime,'application/vnd.apple.mpegurl');
  assert.equal(bySuffix(result,'dash-endpoint').mime,'application/dash+xml');
});

test('collector ignores executable objects, fake player setup in strings/comments/regexp and unrelated state',t => {
  const result = scan(t,documentFor([
    node('script',{}, {textContent:`
      const example = 'window.playerConfig = {"file":"/string.mp4"};';
      const pattern = /window.playerConfig = {"file":"regexp.mp4"};/;
      // window.videoData = {"file":"/line-comment.mp4"};
      /* jwplayer("example-player").setup({"file":"/block-comment.mp4"}); */
      const template = \`window.__PLAYER_CONFIG__ = {"file":"/template.mp4"};\`;
      unrelatedState = {"url":"/unrelated.mp4"};
      window.playerConfig = {file:"/not-json.mp4"};
      window.videoConfig = {"file":function(){ globalThis.__collectorMustNotExecute = true; return "/function.mp4"; }};
      window.__PLAYER_CONFIG__ = {"sources":[{"file":"/real.mp4?brace={a}"}]};
    `}),
  ]));
  assert.equal(result.items.length,1);
  assert.equal(new URL(result.items[0].url).pathname,'/real.mp4');
  assert.equal(globalThis.__collectorMustNotExecute,undefined);
});

test('collector keeps VideoObject embed pages as frames and discovers media iframe src',t => {
  const aboutDocument = documentFor([node('video',{'src':'/about-blank.mp4'})]);
  const srcdocDocument = documentFor([node('video',{'src':'/srcdoc.mp4'})]);
  const result = scan(t,documentFor([
    node('script',{type:'application/ld+json'},{textContent:JSON.stringify({'@type':'VideoObject',embedUrl:'https://player.test/embed',contentUrl:'/original.mp4'})}),
    node('iframe',{src:'https://media.test/embedded.mp4?one=1&amp;two=2'}),
    node('iframe',{'data-src':'https://media.test/stream.m3u8'}),
    node('iframe',{src:'about:blank'},{contentDocument:aboutDocument}),
    node('iframe',{srcdoc:'<video src="/srcdoc.mp4"></video>'},{contentDocument:srcdocDocument}),
  ]));
  assert.equal(result.items.length,3);
  assert.deepEqual(result.frames.map(frame => frame.url),['https://player.test/embed']);
  assert.equal(result.items.find(item => item.url.startsWith('https://media.test/embedded.mp4')).url,'https://media.test/embedded.mp4?one=1&two=2');
  assert.equal(bySuffix(result,'about-blank.mp4'),undefined);
  assert.equal(bySuffix(result,'srcdoc.mp4'),undefined);
  assert.ok(bySuffix(scan(t,aboutDocument),'about-blank.mp4'));
  assert.ok(bySuffix(scan(t,srcdocDocument),'srcdoc.mp4'));
});

test('collector bounds inline player parsing and does not spend JSON budget on unrelated JavaScript',t => {
  const result = scan(t,documentFor([
    node('script',{}, {textContent:'const unrelated = "'+'a'.repeat(524289)+'";'}),
    node('script',{}, {textContent:Array.from({length:66},(_,i) => `window.playerConfig = {"file":"/config${i}.mp4"};`).join('\n')}),
  ]));
  assert.equal(result.items.length,64);
  assert.ok(result.notices.some(notice => notice.includes('動画設定')));
  const oversized = scan(t,documentFor([
    node('script',{}, {textContent:'window.playerConfig = '+JSON.stringify({padding:'a'.repeat(524289),file:'/large.mp4'})}),
  ]));
  assert.equal(oversized.items.length,0);
  assert.ok(oversized.notices.some(notice => notice.includes('動画設定')));
});


test('collector distinguishes occurrences of a shared resource and preserves independent query variants',t => {
  const result=scan(t,documentFor([
    node('video',{src:'/clip.mp4?token=one',title:'First'},{duration:12,paused:false,ended:false}),
    node('video',{src:'/clip.mp4?token=one',title:'Second'},{duration:25,paused:true}),
    node('video',{src:'/clip.mp4?token=two',title:'Variant'}),
  ],[{name:'https://page.test/clip.mp4?token=one',initiatorType:'video'}]));
  assert.equal(result.items.length,2);
  const first=result.items.find(item=>item.url.endsWith('token=one'));
  const videos=first.occurrences.filter(entry=>entry.source==='video');
  assert.equal(videos.length,2);
  assert.notEqual(videos[0].videoRef,videos[1].videoRef);
  assert.deepEqual(videos.map(entry=>entry.duration),[12,25]);
  assert.deepEqual(videos.map(entry=>entry.playing),[true,false]);
  assert.equal(first.occurrences.at(-1).origin,'performance');
  assert.equal(first.occurrences.at(-1).videoRef,undefined);
  assert.equal(first.discovery,'current-dom');
});

test('collector distinguishes two same-host embeds and keeps titles and observed positions',t => {
  const rect={x:10,y:20,width:640,height:360,top:20,left:10,bottom:380,right:650};
  const result=scan(t,documentFor([
    node('iframe',{src:'https://player.test/embed',title:'Chapter one'},{getBoundingClientRect:()=>rect}),
    node('iframe',{src:'https://player.test/embed',title:'Chapter two'},{getBoundingClientRect:()=>({...rect,y:500,top:500,bottom:860})}),
  ]));
  assert.equal(result.frames.length,2);
  assert.deepEqual(result.frames.map(frame=>frame.title),['Chapter one','Chapter two']);
  assert.notEqual(result.frames[0].elementToken,result.frames[1].elementToken);
  assert.equal(result.frames[1].position.y,500);
});

test('collector prioritizes current playing video beyond 500 old links and bounds inline previews',t => {
  let canvases=0;
  const rect={x:0,y:0,width:160,height:90,top:0,left:0,bottom:90,right:160};
  const links=Array.from({length:500},(_,i)=>node('a',{href:`/old${i}.mp4`}));
  const videos=Array.from({length:10},(_,i)=>node('video',{src:`/new${i}.mp4`},{videoWidth:640,videoHeight:360,readyState:2,paused:false,getBoundingClientRect:()=>rect}));
  const doc=documentFor([...links,...videos]);
  doc.createElement=()=>{canvases++;return {getContext:()=>({drawImage(){}}),toDataURL:()=> 'data:image/jpeg;base64,AA=='};};
  const result=scan(t,doc);
  assert.equal(result.items.length,500);
  assert.ok(bySuffix(result,'new9.mp4'));
  assert.equal(canvases,8);
  assert.equal(result.items.flatMap(item=>item.occurrences).filter(entry=>entry.previewDataURL).length,8);
  assert.ok(result.notices.some(notice=>notice.includes('500')));
});

test('collector treats tainted preview as optional and keeps video collection usable',t => {
  const rect={x:0,y:0,width:160,height:90,top:0,left:0,bottom:90,right:160};
  const doc=documentFor([node('video',{src:'/clip.mp4'},{videoWidth:640,videoHeight:360,readyState:2,getBoundingClientRect:()=>rect})]);
  doc.createElement=()=>({getContext:()=>({drawImage(){}}),toDataURL(){throw new Error('tainted');}});
  const result=scan(t,doc);
  assert.equal(result.items.length,1);
  assert.equal(result.items[0].occurrences[0].previewDataURL,undefined);
});


test('collector groups only sources of a confirmed config object and keeps unrelated hydrated videos independent',t => {
  const result=scan(t,documentFor([node('script',{type:'application/json'},{textContent:JSON.stringify({
    first:{name:'Known first',duration:42,sources:[{src:'/one.mp4'},{src:'/one.webm'}]},
    second:{sources:[{src:'/two.mp4'}]},
  })})]));
  const first=bySuffix(result,'one.mp4').occurrences[0];
  assert.equal(first.configRef,bySuffix(result,'one.webm').occurrences[0].configRef);
  assert.notEqual(first.configRef,bySuffix(result,'two.mp4').occurrences[0].configRef);
  assert.equal(first.title,'Known first');
  assert.equal(first.duration,42);
});


test('source location requires current document tokens and does not find removed elements after rescan',t=>{
  let scrolled=0;
  const children=[node('video',{src:'/clip.mp4'},{isConnected:true,scrollIntoView(){scrolled++;}})];
  const doc=documentFor(children);
  const result=scan(t,doc), ref=result.items[0].occurrences[0];
  assert.deepEqual(locateSourceElement('foreign',ref.elementToken,result.documentURL),{found:false});
  assert.deepEqual(locateSourceElement(ref.frameToken,ref.elementToken,'https://changed.test/'),{found:false});
  assert.deepEqual(locateSourceElement(ref.frameToken,ref.elementToken,result.documentURL),{found:true});
  assert.equal(scrolled,1);
  children.length=0;
  scan(t,doc);
  assert.deepEqual(locateSourceElement(ref.frameToken,ref.elementToken,result.documentURL),{found:false});
  assert.equal(scrolled,1);
});


test('metadata embed hints never claim a script is a locatable visual player',t=>{
  const rect={x:10,y:20,width:640,height:360,top:20,left:10,bottom:380,right:650};
  const result=scan(t,documentFor([
    node('script',{type:'application/ld+json',title:'Metadata title'},{getBoundingClientRect:()=>rect,textContent:JSON.stringify({'@type':'VideoObject',name:'Video name',embedUrl:'https://player.test/embed'})}),
    node('iframe',{src:'https://player.test/embed',title:'Actual visible player'},{getBoundingClientRect:()=>rect}),
  ]));
  assert.equal(result.frames.length,2);
  const metadata=result.frames.find(frame=>frame.hintSource==='metadata');
  assert.equal(metadata.locatable,false);
  assert.equal(metadata.elementToken,undefined);
  assert.equal(metadata.position,undefined);
  assert.equal(metadata.title,undefined);
  const element=result.frames.find(frame=>frame.hintSource==='element');
  assert.equal(element.locatable,true);
  assert.ok(element.elementToken);
  assert.equal(element.title,'Actual visible player');
  assert.equal(element.position.y,20);
});
