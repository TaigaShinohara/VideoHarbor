import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareVideoCapture} from '../extension/video-capture.js';

const reference={elementToken:'one',frameToken:'frame',documentURL:'https://synthetic.test/'};
const base={available:true,audio:true,state:'inactive',target:'動画',mimeType:'video/webm',done:false};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function eventually(predicate) {
  for(let index=0;index<150;index++){if(predicate())return;await sleep(10);}
  assert.ok(predicate(),'condition was eventually reached');
}
async function harness(t,handler) {
  const calls=[];
  const capture=await prepareVideoCapture({reference,audio:true,mimeType:'video/webm',send:async(type,request)=>{
    calls.push({type,...request});if(handler)return handler(request);
    return request.command==='close'?{closed:true}:base;
  }});
  t.after(()=>capture.close());
  return {capture,calls};
}

test('prepared source failure notifies listeners before recording has started',async t=>{
  let lost=false;
  const {capture}=await harness(t,async request=>{
    if(request.command==='close')return {closed:true};
    if(request.command==='poll'&&lost)throw new Error('source disappeared');
    return {...base,audio:false,audioReason:'元動画がミュートです。'};
  });
  assert.equal(capture.audio,false);assert.match(capture.audioReason,/ミュート/);
  const events=[];capture.addEventListener('error',()=>events.push('error'));capture.addEventListener('stop',()=>events.push('stop'));
  lost=true;await capture.poll();assert.deepEqual(events,['error','stop']);assert.equal(capture.available,false);
});

test('prepared source ending normally notifies stop without pretending to start a recording',async t=>{
  let ended=false;const {capture}=await harness(t,async request=>request.command==='close'?{closed:true}:{...base,available:!ended,done:ended});
  const events=[];capture.addEventListener('stop',()=>events.push('stop'));ended=true;
  await capture.poll();assert.deepEqual(events,['stop']);assert.equal(capture.state,'inactive');
  await assert.rejects(()=>capture.start(),/録画を開始する前/);
});

test('delayed stop and scheduled polls deliver multiple blocks once before the terminal event',async t=>{
  let stopped=false,index=0,encoded=false;const acks=[],events=[],parts=[];
  const blocks=['first','second','tail'];
  const {capture}=await harness(t,async request=>{
    if(request.command==='close')return {closed:true};
    if(request.command==='prepare')return base;
    if(request.command==='start')return {...base,state:'recording'};
    if(request.command==='stop'){await sleep(350);stopped=true;return {...base,state:'inactive',available:false};}
    if(request.command==='poll'){
      acks.push(request.ack);await sleep(100);
      if(stopped&&encoded&&request.ack===index+1){index++;encoded=false;}
      if(stopped&&index<blocks.length){encoded=true;const text=blocks[index];return {...base,state:'inactive',available:false,chunk:{sequence:index+1,size:text.length,base64:btoa(text)}};}
      return {...base,state:stopped?'inactive':'recording',available:!stopped,done:stopped&&index===blocks.length};
    }
  });
  capture.addEventListener('dataavailable',event=>{parts.push(event.data);events.push('data');});
  capture.addEventListener('error',event=>events.push(`error:${event.error.message}`));
  capture.addEventListener('stop',()=>events.push('stop'));
  await capture.start();await sleep(130);await capture.stop();await eventually(()=>capture.stopped);
  assert.deepEqual(events,['data','data','data','stop']);assert.equal(await new Blob(parts).text(),'firstsecondtail');
  assert.equal(capture.failure,'');assert.ok(acks.every((value,index)=>index===0||value>=acks[index-1]));
});

test('corrupt sequence or oversized messages terminate with a recoverable failure',async t=>{
  const {capture}=await harness(t,async request=>{
    if(request.command==='close')return {closed:true};
    if(request.command==='start')return {...base,state:'recording'};
    if(request.command==='poll')return {...base,state:'recording',chunk:{sequence:2,size:1,base64:'YQ=='}};
    return base;
  });
  const events=[];capture.addEventListener('error',()=>events.push('error'));capture.addEventListener('stop',()=>events.push('stop'));
  await capture.start();await capture.poll();assert.deepEqual(events,['error','stop']);assert.match(capture.failure,/順序または容量/);
});

test('adapter preserves delivered data and reports an unexpected source disconnect',async t=>{
  let lost=false;const parts=[];
  const {capture}=await harness(t,async request=>{
    if(request.command==='close')return {closed:true};
    if(request.command==='start')return {...base,state:'recording'};
    if(request.command==='poll'){if(lost)throw new Error('https://private.invalid/token');lost=true;return {...base,state:'recording',chunk:{sequence:1,size:4,base64:'c2FmZQ=='}};}
    return base;
  });
  capture.addEventListener('dataavailable',event=>parts.push(event.data));await capture.start();await capture.poll();await capture.poll();
  assert.equal(await new Blob(parts).text(),'safe');assert.ok(capture.stopped);assert.doesNotMatch(capture.failure,/private|https/);
});

test('missing final stop event has a bounded drain deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {capture}=await harness(t,async request=>{
    if(request.command==='close')return {closed:true};
    if(request.command==='start')return {...base,state:'recording'};
    return base;
  });
  const events=[];capture.addEventListener('error',()=>events.push('error'));capture.addEventListener('stop',()=>events.push('stop'));
  await capture.start();await capture.stop();t.mock.timers.tick(120001);await tick();
  assert.ok(capture.stopped);assert.deepEqual(events,['error','stop']);assert.match(capture.failure,/終了データを確認できません/);
});
