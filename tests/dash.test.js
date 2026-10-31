import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareDASH} from '../extension/dash.js';
const manifestURL='https://media.test/root/manifest.mpd';
const video=(inside,attrs='')=>`<AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v1" bandwidth="1000" ${attrs}>${inside}</Representation></AdaptationSet>`;
const wrap=(inside,attrs='')=>`<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT6S" ${attrs}><Period>${inside}</Period></MPD>`;
const fixed='<SegmentTemplate timescale="1000" duration="2000" initialization="init-$RepresentationID$.mp4" media="seg-$Number%03d$.m4s"/>';
function plan(xml,options={}) {
  const calls=[];
  const fetch=async(url,config)=>{calls.push({url,config});return options.response || new Response(xml,{headers:{'content-type':'application/dash+xml'}});};
  return {calls,result:prepareDASH(options.url || manifestURL,options.fetch || fetch,{signal:options.signal})};
}

test('static DASH expands Number formatting, initialization, BaseURL hierarchy and highest video quality',async()=>{
  const xml=`<MPD type="static" mediaPresentationDuration="PT6S"><BaseURL>https://cdn.test/assets/</BaseURL><Period><BaseURL>period/</BaseURL><AdaptationSet contentType="video" mimeType="video/mp4"><BaseURL>video/</BaseURL>${fixed}<Representation id="low" bandwidth="500"/><Representation id="high" bandwidth="2000"><BaseURL>high/</BaseURL></Representation></AdaptationSet></Period></MPD>`;
  const h=plan(xml),result=await h.result;
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,manifestURL);
  assert.equal(result.duration,6);assert.equal(result.mime,'video/mp4');assert.equal(result.extension,'mp4');assert.equal(result.fromMaster,true);
  assert.deepEqual(result.tracks[0].segments,[
    {url:'https://cdn.test/assets/period/video/high/init-high.mp4',init:true},
    {url:'https://cdn.test/assets/period/video/high/seg-001.m4s'},
    {url:'https://cdn.test/assets/period/video/high/seg-002.m4s'},
    {url:'https://cdn.test/assets/period/video/high/seg-003.m4s'},
  ]);
});

test('DASH inherits template attributes and overrides timeline from closer levels',async()=>{
  const xml=`<MPD mediaPresentationDuration="PT6S"><Period><SegmentTemplate timescale="100" initialization="i-$RepresentationID$.mp4" media="$Bandwidth$/t-$Time%04d$.m4s" startNumber="4"><SegmentTimeline><S d="100" r="5"/></SegmentTimeline></SegmentTemplate><AdaptationSet contentType="video" mimeType="video/mp4"><Representation id="v" bandwidth="1800"><SegmentTemplate><SegmentTimeline><S t="0" d="200" r="2"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>`;
  const result=await plan(xml).result;
  assert.deepEqual(result.tracks[0].segments.map(segment=>new URL(segment.url).pathname),['/root/i-v.mp4','/root/1800/t-0000.m4s','/root/1800/t-0200.m4s','/root/1800/t-0400.m4s']);
});

test('negative Timeline repeats stop at next explicit time or finite Period duration',async()=>{
  const xml=wrap(video('<SegmentTemplate timescale="10" initialization="init.mp4" media="t-$Time$.m4s"><SegmentTimeline><S t="0" d="10" r="-1"/><S t="20" d="20" r="-1"/></SegmentTimeline></SegmentTemplate>'));
  const result=await plan(xml).result;
  assert.deepEqual(result.tracks[0].segments.slice(1).map(segment=>new URL(segment.url).pathname),['/root/t-0.m4s','/root/t-10.m4s','/root/t-20.m4s','/root/t-40.m4s']);
});

test('DASH chooses main audio adaptation and highest bandwidth in that language',async()=>{
  const audio=(language,role,reps)=>`<AdaptationSet contentType="audio" mimeType="audio/mp4" lang="${language}">${role?'<Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/>':''}${fixed}${reps.map(([id,bandwidth])=>`<Representation id="${id}" bandwidth="${bandwidth}"/>`).join('')}</AdaptationSet>`;
  const xml=wrap(video(fixed)+audio('en',false,[['en',128]])+audio('ja',true,[['ja-low',64],['ja-high',192]]));
  const result=await plan(xml).result;
  assert.equal(result.tracks.length,2);assert.equal(result.tracks[1].type,'audio');assert.equal(result.tracks[1].language,'ja');
  assert.equal(result.tracks[1].bandwidth,192);assert.match(result.tracks[1].segments[0].url,/ja-high/);
});

test('namespaced MPDs and safe XML escapes preserve signed resource identity',async()=>{
  const xml=`<?xml version="1.0"?><d:MPD xmlns:d="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT2S"><d:Period><d:AdaptationSet contentType="video" mimeType="video/mp4"><d:Representation id="v" bandwidth="100"><d:SegmentTemplate duration="2" initialization="i.mp4?x=1&amp;y=2" media="seg-$Number$.m4s?token=synthetic&amp;n=&#50;"/></d:Representation></d:AdaptationSet></d:Period></d:MPD>`;
  const result=await plan(xml).result;
  assert.match(result.tracks[0].segments[0].url,/x=1&y=2$/);
  assert.match(result.tracks[0].segments[1].url,/token=synthetic&n=2$/);
});

test('SegmentList honors Initialization/SegmentURL ranges and inherited initialization',async()=>{
  const xml=wrap(`<AdaptationSet contentType="video" mimeType="video/mp4"><BaseURL>all.mp4</BaseURL><SegmentList timescale="1" duration="2"><Initialization range="0-99"/></SegmentList><Representation id="v" bandwidth="100"><SegmentList><SegmentURL mediaRange="100-199"/><SegmentURL mediaRange="200-299"/><SegmentURL mediaRange="300-399"/></SegmentList></Representation></AdaptationSet>`);
  const result=await plan(xml).result;
  assert.deepEqual(result.tracks[0].segments,[
    {url:'https://media.test/root/all.mp4',range:{start:0,end:99},init:true},
    {url:'https://media.test/root/all.mp4',range:{start:100,end:199}},
    {url:'https://media.test/root/all.mp4',range:{start:200,end:299}},
    {url:'https://media.test/root/all.mp4',range:{start:300,end:399}},
  ]);
});

test('a single Period duration can supply duration without MPD duration',async()=>{
  const result=await plan(`<MPD type="static"><Period start="PT0S" duration="PT6S">${video(fixed)}</Period></MPD>`).result;
  assert.equal(result.duration,6);assert.equal(result.tracks[0].segments.length,4);
});

test('unsupported live, DRM, multi-period, timing corrections and WebM fail explicitly',async()=>{
  for(const [xml,reason] of [
    [wrap(video(fixed)).replace('type="static"','type="dynamic"'),/ライブ/],
    [wrap(video('<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"/>'+fixed)),/暗号化|DRM/],
    [wrap(video(fixed)).replace('</MPD>','<Period/></MPD>'),/複数Period/],
    [wrap(video(fixed.replace('timescale="1000"','timescale="1000" presentationTimeOffset="1000"'))),/開始時刻/],
    [wrap(video(fixed)).replace('<Period>','<Period start="PT2S">'),/開始時刻/],
    [wrap(video(fixed)).replace('video/mp4','video/webm'),/MP4映像/],
  ])await assert.rejects(plan(xml).result,reason);
});

test('timeline gaps, overlaps, invalid repeats and excessive segment counts are rejected',async()=>{
  for(const content of [
    '<S t="1" d="2" r="2"/>','<S d="2"/><S t="1" d="2" r="1"/>',
    '<S d="2" r="-2"/>','<S d="2" r="-1"/><S t="3" d="3"/>','<S d="1" r="5000"/>',
  ])await assert.rejects(plan(wrap(video(`<SegmentTemplate initialization="i.mp4" media="$Time$.m4s"><SegmentTimeline>${content}</SegmentTimeline></SegmentTemplate>`))).result);
  await assert.rejects(plan(wrap(video(fixed.replace('duration="2000"','duration="1"')))).result,/5000/);
});

test('unsafe XML features, malformed tags and attributes never resolve external content',async()=>{
  for(const xml of [
    '<!DOCTYPE MPD [<!ENTITY x SYSTEM "file:///etc/passwd">]>'+wrap(video(fixed)),
    wrap(video(fixed)).replace('<Period>','<Period xlink:href="https://outside.test/period">'),
    wrap(video(fixed)).replace('<Period>','<Period xml:base="https://outside.test/">'),
    wrap(video(fixed)).replace('bandwidth="1000"','bandwidth="1000" bandwidth="1001"'),
    wrap(video(fixed)).replace('</Representation>','</AdaptationSet>'),
    wrap(video(fixed)).replace('init-$RepresentationID$.mp4','&unknown;'),
    '<MPD/><MPD/>',
  ]) {const h=plan(xml);await assert.rejects(h.result);assert.equal(h.calls.length,1);}
});

test('unsafe URLs, malformed ranges and unsupported template substitutions are rejected',async()=>{
  for(const url of ['javascript:alert(1)','file:///movie','https://name:password@media.test/a'])await assert.rejects(plan('',{url}).result);
  for(const replacement of ['file:///tmp/i.mp4','https://name:password@cdn.test/i.mp4','$Unsupported$.mp4','$Number%021d$.mp4'])await assert.rejects(plan(wrap(video(fixed.replace('init-$RepresentationID$.mp4',replacement)))).result);
  for(const value of ['8-2','-1-10','0-9007199254740992'])await assert.rejects(plan(wrap(video(`<SegmentList><Initialization sourceURL="i.mp4" range="${value}"/><SegmentURL media="m.m4s"/></SegmentList>`))).result,/範囲|数値/);
});

test('HTTP and non-media errors, bounded manifest bytes and permission failures remain distinct',async()=>{
  await assert.rejects(plan('',{response:new Response('no',{status:403})}).result,/HTTP 403/);
  await assert.rejects(plan(wrap(video(fixed)),{response:new Response(wrap(video(fixed)),{status:206})}).result,/一部だけ/);
  await assert.rejects(plan('',{response:new Response('<html/>',{headers:{'content-type':'text/html'}})}).result,/動画ではない/);
  await assert.rejects(plan('',{response:new Response('x',{headers:{'content-length':'1048577'}})}).result,/1 MiB/);
  await assert.rejects(plan(' '.repeat(1048577)).result,/1 MiB/);
  const permission=Object.assign(new Error('permission needed'),{origins:['https://media.test/*']});
  await assert.rejects(plan('',{fetch:async()=>{throw permission;}}).result,error=>error===permission);
});

test('abort before fetch and during streamed manifest reads releases stream',async()=>{
  const early=new AbortController();early.abort();const h=plan('',{signal:early.signal});await assert.rejects(h.result,{name:'AbortError'});assert.equal(h.calls.length,0);
  const controller=new AbortController();let canceled=0;
  const response=new Response(new ReadableStream({start(stream){stream.enqueue(new TextEncoder().encode('<MPD'));},cancel(){canceled++;}}));
  const pending=plan('',{response,signal:controller.signal}).result;
  await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(canceled,1);
});
test('highest supported video falls back from unavailable codecs and unsupported addressing',async()=>{
  const xml=wrap(`<AdaptationSet contentType="video" mimeType="video/mp4">${fixed}
    <Representation id="highest" bandwidth="9000" codecs="vvc1.1"/>
    <Representation id="dependent" bandwidth="20000" codecs="avc1.4d401e" dependencyId="other"/>
    <Representation id="trick" bandwidth="15000" codecs="avc1.4d401e"><EssentialProperty schemeIdUri="http://dashif.org/guidelines/trickmode" value="0"/></Representation>
    <Representation id="high-base" bandwidth="8000" codecs="avc1.64001f"><SegmentBase/></Representation>
    <Representation id="supported" bandwidth="1000" codecs="avc1.4d401e"/>
    <Representation id="low" bandwidth="500" codecs="avc1.4d401e"/>
  </AdaptationSet>`);
  const result=await plan(xml).result;
  assert.equal(result.tracks[0].bandwidth,1000);assert.match(result.tracks[0].segments[0].url,/init-supported/);
});
test('unsupported default audio does not silently disappear or switch languages',async()=>{
  const unsupported=`<AdaptationSet lang="ja"><Role value="main"/><Representation id="unsupported" bandwidth="128" mimeType="audio/webm" codecs="vorbis">${fixed}</Representation></AdaptationSet>`;
  const other=`<AdaptationSet contentType="audio" mimeType="audio/mp4" lang="en"><Representation id="en" bandwidth="128" codecs="mp4a.40.2">${fixed}</Representation></AdaptationSet>`;
  await assert.rejects(plan(wrap(video(fixed)+unsupported+other)).result,/音声.*保存を中断/);
  const unsupportedAAC=other.replace('mp4a.40.2','mp4a.40.42');
  await assert.rejects(plan(wrap(video(fixed)+unsupportedAAC)).result,/音声.*保存を中断/);
});
test('DASH segment bound applies across the selected video and audio tracks',async()=>{
  const many='<SegmentTemplate timescale="1000" duration="2" initialization="i-$RepresentationID$.mp4" media="$RepresentationID$-$Number$.m4s"/>';
  const audio=`<AdaptationSet contentType="audio" mimeType="audio/mp4"><Representation id="a" bandwidth="128">${many}</Representation></AdaptationSet>`;
  await assert.rejects(plan(wrap(video(many)+audio)).result,/合計最大5000/);
});
test('DASH refuses wildcard origins and invalid XML namespace/control characters',async()=>{
  for(const url of ['https://*/manifest.mpd','https://*.cdn.test/manifest.mpd'])await assert.rejects(plan('',{url}).result,/配信URL/);
  for(const url of ['https://*/init.mp4','https://*.cdn.test/init.mp4'])await assert.rejects(plan(wrap(video(fixed.replace('init-$RepresentationID$.mp4',url)))).result,/配信URL/);
  await assert.rejects(plan(wrap(video(fixed)).replace('<Period>','<Period>\u0000')).result,/XML文字/);
  await assert.rejects(plan(wrap(video(fixed)).replace('<MPD ','<a:b:MPD ').replace('</MPD>','</a:b:MPD>')).result,/名前空間/);
});
test('ContentComponent preserves legacy declared audio and representation languages',async()=>{
  const audio=`<AdaptationSet mimeType="application/mp4"><ContentComponent contentType="audio" lang="ja"/>${fixed}
    <Representation id="ja" bandwidth="100" lang="ja" codecs="mp4a.40.2"/>
    <Representation id="en" bandwidth="200" lang="en" codecs="mp4a.40.2"/>
  </AdaptationSet>`;
  const result=await plan(wrap(video(fixed)+audio,'lang="ja"')).result;
  assert.equal(result.tracks[1].language,'ja');assert.match(result.tracks[1].segments[0].url,/init-ja/);
  await assert.rejects(plan(wrap(video(fixed)+'<AdaptationSet><ContentComponent contentType="audio"/></AdaptationSet>')).result,/音声.*中断/);
});

test('DASH: expanded template and BaseURL plans stop at their incremental URL budget without fallback',async()=>{
  const id='x'.repeat(60000);
  const xml=`<MPD mediaPresentationDuration="PT100S"><Period><AdaptationSet contentType="video" mimeType="video/mp4"><SegmentTemplate duration="1" initialization="init-$RepresentationID$.mp4" media="$RepresentationID$-$Number$.m4s"/><Representation id="${id}" bandwidth="2000"/><Representation id="small-fallback" bandwidth="1000"/></AdaptationSet></Period></MPD>`;
  const h=plan(xml);await assert.rejects(h.result,error=>error.code==='PLAN_URL_LIMIT'&&/4 MiB/.test(error.message));assert.equal(h.calls.length,1);
  const inherited=`<MPD mediaPresentationDuration="PT100S"><BaseURL>https://cdn.test/${id}/</BaseURL><Period>${video('<SegmentTemplate duration="1" initialization="init.mp4" media="$Number$.m4s"/>')}</Period></MPD>`;
  await assert.rejects(plan(inherited).result,error=>error.code==='PLAN_URL_LIMIT');
  const repeated=xml.replace('media="$RepresentationID$-$Number$.m4s"','media="$RepresentationID$$RepresentationID$$RepresentationID$-$Number$.m4s"');
  await assert.rejects(plan(repeated).result,error=>error.code==='PLAN_URL_LIMIT','one template cannot create an oversized URL before validation');
});
