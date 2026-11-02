import test from 'node:test';
import assert from 'node:assert/strict';
import {controlPageVideo} from '../extension/page-video-recording.js';

const token = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const key = Symbol.for('VideoHarbor.videoRecording');
const reference = {elementToken:'video-1',frameToken:'frame-1',documentURL:'https://source.test/',title:'選んだ動画'};
class Track extends EventTarget {
  constructor(kind) { super(); this.kind=kind; this.readyState='live'; this.muted=false; }
  stop() { this.readyState='ended'; }
  clone() { const value=new Track(this.kind);value.muted=this.muted;return value; }
}
class Stream extends EventTarget {
  constructor(audio) { super(); this.tracks=Array.isArray(audio)?[...audio]:[new Track('video'),...(audio?[new Track('audio')]:[])]; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter(value=>value.kind==='video'); }
  getAudioTracks() { return this.tracks.filter(value=>value.kind==='audio'); }
  removeTrack(track) { this.tracks=this.tracks.filter(value=>value!==track); }
}
class Recorder extends EventTarget {
  static instances=[];
  static isTypeSupported() { return true; }
  constructor(stream,options) { super();this.stream=stream;this.mimeType=options.mimeType;this.state='inactive';Recorder.instances.push(this); }
  start() { this.state='recording'; }
  pause() { this.state='paused'; }
  resume() { this.state='recording'; }
  data(blob) { const event=new Event('dataavailable');event.data=blob;this.dispatchEvent(event); }
  stop() {
    this.state='inactive';
    queueMicrotask(()=>{ if(this.finalBlob)this.data(this.finalBlob);this.dispatchEvent(new Event('stop')); });
  }
}
function harness(t,{audio=true}={}) {
  const descriptors=new Map(['document','MediaRecorder','MediaStream','addEventListener','removeEventListener'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const stream=new Stream(audio),video=new EventTarget();
  Object.assign(video,{tagName:'VIDEO',isConnected:true,readyState:4,videoWidth:320,videoHeight:180,paused:false,ended:false,currentTime:0,duration:12,playCalls:0,pauseCalls:0,play:async()=>{video.playCalls++;video.paused=false;video.dispatchEvent(new Event('play'));},pause:()=>{video.pauseCalls++;video.paused=true;},muted:false,volume:1,currentSrc:'https://source.test/movie.webm',srcObject:null,mediaKeys:null,getAttribute:()=>null,captureStream:()=>!video.srcObject&&stream.getTracks().every(track=>track.readyState==='ended')?new Stream(audio):stream});
  const discovery={token:reference.frameToken,elements:new Map([[reference.elementToken,video]]),videoSources:new Map([[reference.elementToken,{currentSrc:video.currentSrc,srcObject:null}]])};
  const page=new EventTarget();
  const replacements={document:{URL:reference.documentURL,__videoHarborDiscovery:discovery},MediaRecorder:Recorder,MediaStream:Stream,addEventListener:page.addEventListener.bind(page),removeEventListener:page.removeEventListener.bind(page)};
  for(const [name,value] of Object.entries(replacements))Object.defineProperty(globalThis,name,{configurable:true,value});
  Recorder.instances=[];
  const command=(command,extra={})=>controlPageVideo({command,token,reference,mimeType:'video/webm',audio:true,ack:0,...extra});
  t.after(async()=>{
    await command('close');
    for(const [name,descriptor]of descriptors)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];
    delete globalThis[key];
  });
  return {video,stream,discovery,page,command,get session(){return globalThis[key];},get recorder(){return Recorder.instances.at(-1);}};
}

test('element recording validates the document, scan source and playback without starting or changing the page',async t=>{
  const h=harness(t);
  assert.match((await h.command('prepare',{token:'bad'})).error,/指定が不正/);
  assert.match((await h.command('prepare',{reference:{...reference,frameToken:'changed'}})).error,/見つかりません/);
  h.video.currentSrc+='?changed';assert.match((await h.command('prepare')).error,/再生元が変わりました/);
  h.video.currentSrc=h.discovery.videoSources.get(reference.elementToken).currentSrc;
  h.video.mediaKeys={};assert.match((await h.command('prepare')).error,/保護された/);
  assert.equal(Recorder.instances.length,0);assert.equal(h.video.paused,false);assert.equal(h.video.muted,false);
});

test('element recording prepares without starting, serializes bounded slices and acknowledges each byte once',async t=>{
  const h=harness(t),prepared=await h.command('prepare');
  assert.equal(prepared.audio,true);assert.equal(prepared.state,'inactive');
  assert.equal((await h.command('start')).state,'recording');
  const bytes=new Uint8Array(192*1024+17);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
  h.recorder.data(new Blob([bytes]));
  const first=await h.command('poll');
  assert.equal(first.chunk.size,192*1024);assert.equal(first.chunk.base64.length,262144);
  assert.deepEqual((await h.command('poll')).chunk,first.chunk,'unacknowledged block is repeated exactly');
  const second=await h.command('poll',{ack:1});
  assert.equal(second.chunk.sequence,2);assert.equal(second.chunk.size,17);
  assert.equal(h.session.queuedBytes,bytes.length,'partially ACKed Blob retains its complete budget');
  const output=Buffer.concat([Buffer.from(first.chunk.base64,'base64'),Buffer.from(second.chunk.base64,'base64')]);
  assert.deepEqual(output,Buffer.from(bytes));
  assert.match((await h.command('poll',{ack:3})).error,/受領確認/);
  assert.equal((await h.command('poll',{ack:2})).chunk,undefined);assert.equal(h.session.queuedBytes,0);
  assert.match((await h.command('poll',{token:other})).error,/接続が終了/);
});

test('element stop exposes its final chunk before done and closes every capture track',async t=>{
  const h=harness(t);await h.command('prepare');await h.command('start');
  h.recorder.data(new Blob(['first']));h.recorder.finalBlob=new Blob(['tail']);
  await h.command('stop');
  const first=await h.command('poll');assert.equal(first.done,false);assert.equal(Buffer.from(first.chunk.base64,'base64').toString(),'first');
  const tail=await h.command('poll',{ack:1});assert.equal(tail.done,false);assert.equal(Buffer.from(tail.chunk.base64,'base64').toString(),'tail');
  assert.equal((await h.command('poll',{ack:2})).done,true);
  assert.ok(h.stream.getTracks().every(track=>track.readyState==='ended'));
});

test('muted or zero-volume video requests an explicit audio decision without modifying the original player',async t=>{
  const h=harness(t);h.video.muted=true;
  let prepared=await h.command('prepare');assert.equal(prepared.audio,false);assert.match(prepared.audioReason,/ミュートまたは音量0/);
  assert.equal(h.recorder.stream.getAudioTracks().length,0);assert.equal(h.video.muted,true);assert.equal(h.video.volume,1);
  await h.command('close');
  h.video.muted=false;h.video.volume=0;h.stream.tracks=[new Track('video'),new Track('audio')];
  prepared=await h.command('prepare');assert.equal(prepared.audio,false);assert.match(prepared.audioReason,/音量0/);assert.equal(h.video.volume,0);
});

test('missing audio is an unstarted decision state and prepare track loss terminates it',async t=>{
  const h=harness(t,{audio:false});assert.equal((await h.command('prepare')).audio,false);
  const track=h.stream.getVideoTracks()[0];track.readyState='ended';track.dispatchEvent(new Event('ended'));
  const response=await h.command('poll');assert.equal(response.available,false);assert.equal(response.done,true);assert.match(response.failure,/取得が終了/);
  assert.match((await h.command('start')).error,/もう一度/);
});

test('source changes, ended and track changes stop instead of following another video',async t=>{
  const h=harness(t);await h.command('prepare');await h.command('start');
  h.video.currentSrc+='?next';
  const response=await h.command('poll');assert.match(response.reason,/再生元が変わった/);assert.equal(h.recorder.state,'inactive');
  await h.command('close');
  h.video.currentSrc=h.discovery.videoSources.get(reference.elementToken).currentSrc;
  h.stream.tracks=[new Track('video'),new Track('audio')];await h.command('prepare');await h.command('start');
  h.video.ended=true;h.video.dispatchEvent(new Event('ended'));assert.match((await h.command('poll')).reason,/再生が終了/);
});

test('source transfer budget accounts for retained blobs and rejects oversized chunks',async t=>{
  const h=harness(t);await h.command('prepare');await h.command('start');
  const chunk=new Blob([new Uint8Array(4*1024*1024)]);h.recorder.data(chunk);h.recorder.data(chunk);
  await h.command('poll');await h.command('poll',{ack:1});assert.equal(h.session.queuedBytes,8*1024*1024);
  h.recorder.data(new Blob(['excess']));assert.equal(h.session.queuedBytes,8*1024*1024);assert.match(h.session.failure,/転送が追いつかない/);
  await h.command('close');h.stream.tracks=[new Track('video')];await h.command('prepare');await h.command('start');
  h.recorder.data(new Blob([new Uint8Array(4*1024*1024+1)]));assert.equal(h.session.queuedBytes,0);assert.match(h.session.failure,/転送が追いつかない/);
});

test('a lost workspace lease disposes the source and release cannot affect another token',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const h=harness(t);await h.command('prepare');
  assert.match((await h.command('close',{token:other})).error,/接続が終了/);assert.ok(h.session);
  h.session.leaseAt=Date.now()-16000;t.mock.timers.tick(1000);
  assert.equal(h.session,undefined);assert.ok(h.stream.getTracks().every(track=>track.readyState==='ended'));
});


test('muting a recording stops promptly instead of claiming that audio is still being captured',async t=>{
  const h=harness(t);await h.command('prepare');await h.command('start');
  h.video.muted=true;h.video.dispatchEvent(new Event('volumechange'));
  assert.equal(h.recorder.state,'inactive');assert.match((await h.command('poll')).failure,/ミュートまたは音量0になった/);
});

test('capture restrictions reject a missing or muted video track and release the captured stream',async t=>{
  const h=harness(t);h.stream.getVideoTracks()[0].muted=true;
  assert.match((await h.command('prepare')).error,/配信元の制限や保護/);
  assert.ok(h.stream.getTracks().every(track=>track.readyState==='ended'));assert.equal(h.session,undefined);
});


test('an unavailable captured audio track is removed before an explicit no-audio decision',async t=>{
  const h=harness(t),audio=h.stream.getAudioTracks()[0];audio.muted=true;
  assert.equal((await h.command('prepare')).audio,false);assert.equal(h.recorder.stream.getAudioTracks().length,0);assert.equal(audio.readyState,'live');
  audio.muted=false;audio.dispatchEvent(new Event('unmute'));
  assert.equal((await h.command('start')).audio,false);assert.equal(h.recorder.stream.getAudioTracks().length,0);
});


test('queued initial track notifications do not stop preparation but actual track additions do',async t=>{
  const h=harness(t);await h.command('prepare');
  h.stream.dispatchEvent(new Event('addtrack'));h.stream.dispatchEvent(new Event('removetrack'));
  assert.equal((await h.command('start')).state,'recording');
  h.stream.tracks.push(new Track('audio'));h.stream.dispatchEvent(new Event('addtrack'));
  assert.equal(h.recorder.state,'inactive');assert.match((await h.command('poll')).reason,/構成が変わった/);
});

test('queued intentional audio removal notifications preserve silence; a real video removal stops',async t=>{
  const h=harness(t);await h.command('prepare',{audio:false});
  assert.equal(h.recorder.stream.getAudioTracks().length,0);h.stream.dispatchEvent(new Event('removetrack'));
  assert.equal((await h.command('start')).state,'recording');assert.equal(h.recorder.stream.getAudioTracks().length,0);
  h.stream.removeTrack(h.stream.getVideoTracks()[0]);h.stream.dispatchEvent(new Event('removetrack'));
  assert.equal(h.recorder.state,'inactive');assert.match((await h.command('poll')).reason,/構成が変わった/);
});


test('srcObject recording owns clones and never stops the original player input tracks',async t=>{
  const h=harness(t),original=[...h.stream.getTracks()];h.video.srcObject=h.stream;
  h.discovery.videoSources.get(reference.elementToken).srcObject=h.stream;
  await h.command('prepare');assert.notEqual(h.recorder.stream,h.stream);
  for(const track of h.recorder.stream.getTracks())assert.ok(!original.includes(track));
  await h.command('start');await h.command('stop');
  assert.ok(original.every(track=>track.readyState==='live'),'original srcObject playback stays live after stopping the recording');
  assert.ok(h.recorder.stream.getTracks().every(track=>track.readyState==='ended'),'recording clones are released');
  await h.command('close');assert.ok(original.every(track=>track.readyState==='live'));
});

test('audio-off srcObject preparation does not remove or stop original audio; raw file tracks are released',async t=>{
  const h=harness(t),original=[...h.stream.getTracks()];h.video.srcObject=h.stream;h.discovery.videoSources.get(reference.elementToken).srcObject=h.stream;
  await h.command('prepare',{audio:false});assert.equal(h.stream.getAudioTracks().length,1);assert.equal(h.recorder.stream.getAudioTracks().length,0);
  await h.command('close');assert.ok(original.every(track=>track.readyState==='live'));
  h.video.srcObject=null;h.discovery.videoSources.get(reference.elementToken).srcObject=null;
  await h.command('prepare');await h.command('close');assert.ok(original.every(track=>track.readyState==='ended'),'raw capture tracks owned by file capture are also released');
});

test('source replacement preserves old and new srcObject inputs while releasing recording clones',async t=>{
  const h=harness(t),old=[...h.stream.getTracks()],next=new Stream(true);h.video.srcObject=h.stream;
  h.discovery.videoSources.get(reference.elementToken).srcObject=h.stream;
  await h.command('prepare');await h.command('start');h.video.srcObject=next;
  h.stream.tracks.push(...next.getTracks());h.stream.dispatchEvent(new Event('addtrack'));
  assert.match((await h.command('poll')).reason,/再生元が変わった/);await h.command('close');
  assert.ok([...old,...next.getTracks()].every(track=>track.readyState==='live'));
  assert.ok(h.recorder.stream.getTracks().every(track=>track.readyState==='ended'));
});

test('lease and preparation errors release only recording-owned resources',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  const h=harness(t),original=[...h.stream.getTracks()];h.video.srcObject=h.stream;
  h.discovery.videoSources.get(reference.elementToken).srcObject=h.stream;
  await h.command('prepare');const clones=[...h.recorder.stream.getTracks()];h.session.leaseAt=Date.now()-16000;t.mock.timers.tick(1000);
  assert.ok(original.every(track=>track.readyState==='live'));assert.ok(clones.every(track=>track.readyState==='ended'));
  h.stream.getAudioTracks()[0].clone=()=>{throw new Error('synthetic clone failure');};
  assert.match((await h.command('prepare')).error,/取得できません/);assert.ok(original.every(track=>track.readyState==='live'));
});

test('removed dedicated raw file-capture tracks remain owned until cleanup',async t=>{
  const h=harness(t),raw=[...h.stream.getTracks()];await h.command('prepare');await h.command('start');
  h.stream.removeTrack(raw[1]);h.stream.dispatchEvent(new Event('removetrack'));await h.command('close');
  assert.ok(raw.every(track=>track.readyState==='ended'));
});


test('changes to borrowed input after an explicit stop do not turn drained data into a failure',async t=>{
  const h=harness(t);h.video.srcObject=h.stream;h.discovery.videoSources.get(reference.elementToken).srcObject=h.stream;
  await h.command('prepare');await h.command('start');h.recorder.finalBlob=new Blob(['complete']);await h.command('stop');
  h.video.muted=true;h.video.dispatchEvent(new Event('volumechange'));h.stream.getVideoTracks()[0].muted=true;h.stream.getVideoTracks()[0].dispatchEvent(new Event('mute'));
  h.video.currentSrc+='?next';h.video.dispatchEvent(new Event('emptied'));
  const response=await h.command('poll');assert.equal(response.failure,'');assert.equal(Buffer.from(response.chunk.base64,'base64').toString(),'complete');
});


test('natural video end takes priority over simultaneous captured-track mute and removal',async t=>{
  const h=harness(t);await h.command('prepare');await h.command('start');
  h.video.ended=true;h.stream.getVideoTracks()[0].muted=true;h.stream.getVideoTracks()[0].dispatchEvent(new Event('mute'));
  const response=await h.command('poll');assert.equal(response.failure,'');assert.match(response.reason,/再生が終了/);
});


test('inspection reads the live position without capture, playback, or session allocation', async t=>{
  const h=harness(t);h.video.paused=true;h.video.currentTime=3.25;
  const state=await h.command('inspect');
  assert.deepEqual(state,{currentTime:3.25,duration:12,paused:true,ended:false});
  assert.equal(h.session,undefined);assert.equal(Recorder.instances.length,0);assert.equal(h.video.playCalls,0);
  assert.ok(h.stream.getTracks().every(track=>track.readyState==='live'));
  assert.match((await h.command('inspect',{reference:{...reference,frameToken:'wrong'}})).error,/見つかりません/);
});

test('paused video remains paused during preparation and the recorder arms inside its native play event', async t=>{
  const h=harness(t);h.video.paused=true;h.video.currentTime=3;
  h.video.play=async()=>{assert.equal(h.recorder.state,'inactive');h.video.playCalls++;h.video.paused=false;h.video.dispatchEvent(new Event('play'));};
  await h.command('prepare');assert.equal(h.video.playCalls,0);assert.equal(h.video.paused,true);
  assert.equal((await h.command('start')).state,'recording');
  assert.equal(Recorder.instances.length,2,'a fresh stream wins over old native capture listeners');
  assert.equal(h.video.playCalls,1);assert.equal(h.video.currentTime,3,'automatic playback preserves the confirmed position');
});

test('rejected automatic playback stops capture and leaves source settings intact', async t=>{
  const h=harness(t);h.video.paused=true;h.video.play=()=>Promise.reject(new DOMException('synthetic private URL','NotAllowedError'));
  await h.command('prepare');const result=await h.command('start');
  assert.match(result.error,/自動再生できません/);assert.doesNotMatch(result.error,/synthetic/);
  assert.equal(h.video.paused,true);assert.equal(h.video.muted,false);assert.equal(h.video.volume,1);
  await new Promise(resolve=>queueMicrotask(resolve));
  assert.ok(h.stream.getTracks().every(track=>track.readyState==='ended'));
});

test('ended sources require explicit restart consent before rewinding', async t=>{
  const h=harness(t);h.video.ended=true;h.video.paused=true;h.video.currentTime=12;
  assert.equal((await h.command('inspect')).ended,true);
  assert.match((await h.command('prepare')).error,/再生が終了/);assert.equal(h.video.currentTime,12);
  Object.defineProperty(h.video,'currentTime',{configurable:true,get(){return this.position;},set(value){this.position=value;this.ended=false;}});
  const prepared=await h.command('prepare',{restart:true});assert.equal(prepared.available,true);assert.equal(h.video.currentTime,0);
  await h.command('start');assert.equal(h.video.paused,false);
});

test('unloaded source uses a temporary preload hint while preserving paused time and source identity', async t=>{
  const h=harness(t);h.video.readyState=0;h.video.paused=true;h.video.currentSrc='';
  h.discovery.videoSources.get(reference.elementToken).currentSrc='';
  h.discovery.videoSources.get(reference.elementToken).attributes=['/movie.webm'];
  const attrs=new Map([['src','/movie.webm'],['preload','none']]);
  h.video.getAttribute=name=>attrs.get(name)??null;h.video.setAttribute=(name,value)=>attrs.set(name,value);h.video.removeAttribute=name=>attrs.delete(name);
  Object.defineProperty(h.video,'preload',{get:()=>attrs.get('preload')||'',set:value=>{
    attrs.set('preload',value);
    queueMicrotask(()=>{h.video.currentSrc='https://source.test/movie.webm';h.video.readyState=4;});
  }});
  const prepared=await h.command('prepare');assert.equal(prepared.available,true);
  assert.equal(h.video.preload,'none');assert.equal(h.video.paused,true);assert.equal(h.video.currentTime,0);assert.equal(h.video.playCalls,0);
  await h.command('start');assert.equal(h.video.playCalls,1);
});

test('preload preparation rejects changed source attributes and restores its hint on failure', async t=>{
  const h=harness(t);h.video.readyState=0;h.video.paused=true;
  const attrs=new Map([['src','/movie.webm'],['preload','none']]);
  h.video.getAttribute=name=>attrs.get(name)??null;h.video.setAttribute=(name,value)=>attrs.set(name,value);h.video.removeAttribute=name=>attrs.delete(name);
  Object.defineProperty(h.video,'preload',{get:()=>attrs.get('preload')||'',set:value=>{attrs.set('preload',value);attrs.set('src','/changed.webm');}});
  assert.match((await h.command('prepare')).error,/読み込みを準備できません/);
  assert.equal(h.video.preload,'none');assert.equal(h.session,undefined);assert.equal(h.video.playCalls,0);
});


test('timed-out playback stops our capture and cannot restart playback when its promise resolves late',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const h=harness(t);h.video.paused=true;let resolvePlay;
  h.video.play=()=>new Promise(resolve=>{resolvePlay=()=>{h.video.paused=false;resolve();};});
  await h.command('prepare');const start=h.command('start');
  t.mock.timers.tick(3001);assert.match((await start).error,/自動再生できません/);
  assert.equal(h.video.paused,true);resolvePlay();await new Promise(resolve=>queueMicrotask(resolve));
  assert.equal(h.video.paused,true);assert.equal(h.recorder.state,'inactive');
});

test('failed playback cleanup never pauses a replacement source on the same video element',async t=>{
  const h=harness(t);h.video.paused=true;
  h.video.play=()=>{h.video.currentSrc+='?new';h.video.paused=false;return Promise.reject(new Error('replaced'));};
  await h.command('prepare');assert.match((await h.command('start')).error,/自動再生できません/);
  assert.equal(h.video.paused,false);assert.equal(h.video.pauseCalls,0);
});

test('a preloaded source cannot replace an unresolved scanned source before inspection',async t=>{
  const h=harness(t),source=h.discovery.videoSources.get(reference.elementToken);
  source.currentSrc='';source.attributes=['/scanned.webm'];h.video.getAttribute=name=>name==='src'?'/replacement.webm':null;
  assert.match((await h.command('inspect')).error,/再生元が変わりました/);assert.equal(h.video.playCalls,0);
});


test('legacy unresolved scan metadata requires rescan rather than following an unknown source',async t=>{
  const h=harness(t),source=h.discovery.videoSources.get(reference.elementToken);source.currentSrc='';
  assert.match((await h.command('inspect')).error,/確認情報が古い/);assert.equal(h.session,undefined);
});


test('a site play handler cannot silently move the confirmed position before recording starts',async t=>{
  const h=harness(t);h.video.paused=true;h.video.currentTime=0;
  h.video.addEventListener('play',()=>{h.video.currentTime=3;});
  await h.command('prepare');assert.match((await h.command('start')).error,/再生位置が変わりました/);
  assert.equal(h.video.paused,true);assert.equal(h.session,undefined);assert.equal(h.recorder.state,'inactive');
});


test('fresh play-event capture refuses changed audio rather than silently recording without it',async t=>{
  const h=harness(t);h.video.paused=true;let captures=0;
  h.video.captureStream=()=>new Stream(captures++===0);
  assert.equal((await h.command('prepare')).audio,true);
  assert.match((await h.command('start')).error,/映像・音声構成が変わりました/);
  assert.equal(h.video.paused,true);assert.equal(h.session,undefined);
});

test('fresh play-event capture preserves an explicit no-audio choice if source is unmuted meanwhile',async t=>{
  const h=harness(t);h.video.paused=true;h.video.muted=true;
  assert.equal((await h.command('prepare')).audio,false);h.video.muted=false;
  assert.equal((await h.command('start')).audio,false);assert.equal(h.recorder.stream.getAudioTracks().length,0);
});


test('play-event preparation cannot silently advance while waiting for source readiness',async t=>{
  const h=harness(t);h.video.paused=true;h.video.currentTime=0;h.video.preload='auto';
  h.video.addEventListener('play',()=>{
    h.video.readyState=0;
    queueMicrotask(()=>{h.video.currentTime=0.5;h.video.readyState=4;});
  });
  await h.command('prepare');assert.match((await h.command('start')).error,/再生位置が変わりました/);
  assert.equal(h.video.paused,true);assert.equal(h.session,undefined);assert.equal(h.recorder.state,'inactive');
});

test('synchronously rejected source playback returns only the fixed public error',async t=>{
  const h=harness(t);h.video.paused=true;
  h.video.play=()=>{throw new Error('動画の https://private.test/?synthetic=secret');};
  await h.command('prepare');const response=await h.command('start');
  assert.match(response.error,/自動再生できません/);assert.doesNotMatch(response.error,/private|secret|https/);
  assert.equal(h.session,undefined);assert.equal(h.video.paused,true);
});

test('paused srcObject playback rebuilds recording clones without stopping borrowed input tracks',async t=>{
  const h=harness(t),original=[...h.stream.getTracks()];h.video.srcObject=h.stream;h.video.paused=true;
  h.discovery.videoSources.get(reference.elementToken).srcObject=h.stream;
  await h.command('prepare');const initialClones=[...h.recorder.stream.getTracks()];
  assert.equal((await h.command('start')).state,'recording');
  assert.ok(original.every(track=>track.readyState==='live'));assert.ok(initialClones.every(track=>track.readyState==='ended'));
  await h.command('stop');await new Promise(resolve=>queueMicrotask(resolve));
  assert.ok(original.every(track=>track.readyState==='live'));assert.ok(h.recorder.stream.getTracks().every(track=>track.readyState==='ended'));
});

test('stopping an active or paused recording pauses the exact source without rewinding and retains final data',async t=>{
  for(const paused of [false,true]) await t.test(paused ? 'paused recorder' : 'active recorder',async sub=>{
    const h=harness(sub);h.video.currentTime=3.25;
    await h.command('prepare');await h.command('start');if(paused)await h.command('pause');
    h.recorder.finalBlob=new Blob(['final']);
    await h.command('stop');
    assert.equal(h.video.paused,true);assert.equal(h.video.currentTime,3.25);assert.equal(h.video.pauseCalls,1);
    const tail=await h.command('poll');assert.equal(Buffer.from(tail.chunk.base64,'base64').toString(),'final');
    assert.equal((await h.command('poll',{ack:1})).done,true);await h.command('close');assert.equal(h.video.pauseCalls,1);
  });
});

test('closing preparation does not pause a playing source but closing a started session does',async t=>{
  const h=harness(t);await h.command('prepare');await h.command('stop');await h.command('close');
  assert.equal(h.video.paused,false);assert.equal(h.video.pauseCalls,0);
  await h.command('prepare');await h.command('start');await h.command('close');
  assert.equal(h.video.paused,true);assert.equal(h.video.pauseCalls,1);
});

test('source replacement or document navigation never pauses another playback during cleanup',async t=>{
  for(const changed of ['currentSrc','srcObject','attribute','document']) await t.test(changed,async sub=>{
    const h=harness(sub);await h.command('prepare');await h.command('start');
    if(changed==='currentSrc')h.video.currentSrc+='?replacement';
    if(changed==='srcObject')h.video.srcObject=new Stream(true);
    if(changed==='attribute')h.video.getAttribute=name=>name==='src'?'/replacement.webm':null;
    if(changed==='document')document.URL+='next';
    await h.command('stop');await h.command('close');assert.equal(h.video.pauseCalls,0,changed);
  });
});

test('source pause failure does not prevent final bytes, capture cleanup or close',async t=>{
  const h=harness(t);await h.command('prepare');await h.command('start');h.recorder.finalBlob=new Blob(['tail']);
  let attempts=0;h.video.pause=()=>{attempts++;throw new Error('Synthetic pause rejection');};
  await h.command('stop');const response=await h.command('poll');
  assert.match(response.reason,/元動画を一時停止できませんでした/);
  assert.equal(Buffer.from(response.chunk.base64,'base64').toString(),'tail');
  await h.command('close');assert.ok(h.stream.getTracks().every(track=>track.readyState==='ended'));assert.equal(attempts,1);
});

test('queued play events allow normal resumed clock progress at the source playback rate',async t=>{
  for(const rate of [1,2])await t.test(`rate ${rate}`,async sub=>{
    const h=harness(sub);h.video.paused=true;h.video.currentTime=0.89;h.video.playbackRate=rate;
    h.video.play=()=>new Promise(resolve=>setTimeout(()=>{
      h.video.currentTime+=0.08*rate;h.video.paused=false;h.video.dispatchEvent(new Event('play'));resolve();
    },80));
    await h.command('prepare');assert.equal((await h.command('start')).state,'recording');
    await h.command('stop');assert.equal(h.video.paused,true);
  });
});

test('an explicit seek during queued playback is rejected even if the seeking flag is already clear',async t=>{
  const h=harness(t);h.video.paused=true;
  h.video.play=async()=>{
    h.video.currentTime=0.02;h.video.dispatchEvent(new Event('seeking'));h.video.dispatchEvent(new Event('seeked'));
    h.video.seeking=false;h.video.paused=false;h.video.dispatchEvent(new Event('play'));
  };
  await h.command('prepare');assert.match((await h.command('start')).error,/再生位置が変わりました/);
  assert.equal(h.session,undefined);assert.equal(h.video.paused,true);
});

test('native resumed clock rebasing is bounded while opening and explicit seeks stay strict',async t=>{
  for(const [position,advance,allowed] of [[0.89,0.063,true],[0.89,0.2,false],[0,0.063,false]])await t.test(`${position}+${advance}`,async sub=>{
    const h=harness(sub);h.video.paused=true;h.video.currentTime=position;
    h.video.addEventListener('play',()=>{h.video.currentTime+=advance;});
    await h.command('prepare');const result=await h.command('start');
    if(allowed) {assert.equal(result.state,'recording');await h.command('stop');}
    else {assert.match(result.error,/再生位置が変わりました/);assert.equal(h.session,undefined);}
    assert.equal(h.video.paused,true);
  });
});

test('final cleanup respects user playback resumed after an already-paused or ended source was stopped',async t=>{
  for(const ended of [false,true])await t.test(ended ? 'ended source' : 'already paused source',async sub=>{
    const h=harness(sub);await h.command('prepare');await h.command('start');
    h.video.paused=true;h.video.ended=ended;h.recorder.finalBlob=new Blob(['tail']);
    await h.command('stop');const tail=await h.command('poll');
    assert.equal(Buffer.from(tail.chunk.base64,'base64').toString(),'tail');await h.command('poll',{ack:1});
    h.video.ended=false;await h.video.play();
    const pauseCalls=h.video.pauseCalls;await h.command('close');
    assert.equal(h.video.paused,false);assert.equal(h.video.pauseCalls,pauseCalls);
  });
});
