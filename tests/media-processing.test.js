import test from 'node:test';
import assert from 'node:assert/strict';
import {MediaProcessor} from '../extension/media-processing.js';
import {MEDIA_BOX_LIMIT} from '../extension/media-validation.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const packet=()=>{const bytes=new Uint8Array(188);bytes[0]=0x47;return bytes;};
class FakeWorker {
  constructor(){this.listeners=new Map();this.requests=[];this.transfers=[];this.terminated=0;}
  addEventListener(type,listener){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(listener);}
  removeEventListener(type,listener){this.listeners.get(type)?.delete(listener);}
  postMessage(message,transfer){
    if(this.postError)throw new Error('synthetic postMessage failure');
    this.transfers.push(transfer.map(buffer=>buffer.byteLength));
    this.requests.push(structuredClone(message,{transfer}));
  }
  emit(type,event){for(const listener of [...(this.listeners.get(type)||[])])listener(event);}
  reply(request,result,extra={}){this.emit('message',{data:{id:request.id,kind:request.kind,ok:true,result,...extra}});}
  terminate(){this.terminated++;}
  get listenerCount(){return [...this.listeners.values()].reduce((count,listeners)=>count+listeners.size,0);}
}
function harness(t,options={}) {
  const worker=new FakeWorker();let created=0;
  const processor=new MediaProcessor({...options,workerFactory:()=>{created++;return worker;}});
  t.after(()=>processor.close());
  return {processor,worker,get created(){return created;}};
}
const validReply=request=>({bytes:request.payload.bytes,boxes:request.payload.boxes});

test('media processor creates its local worker lazily and an unused close releases its abort listener',()=>{
  const controller=new AbortController();let created=0,removed=0;
  const remove=controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.removeEventListener=(...args)=>{removed++;remove(...args);};
  const processor=new MediaProcessor({signal:controller.signal,workerFactory:()=>{created++;return new FakeWorker();}});
  assert.equal(created,0);processor.close();processor.close();
  assert.equal(created,0);assert.equal(removed,1);
});

test('media processor transfers validation bytes and returns the checked bytes with the shared structure count',async t=>{
  const h=harness(t),bytes=packet(),budget={boxes:7};
  const pending=h.processor.validate(bytes,'ts',false,budget);
  assert.equal(h.created,1);assert.equal(h.worker.requests.length,1);
  const request=h.worker.requests[0];
  assert.equal(request.kind,'validate');assert.equal(request.payload.extension,'ts');
  assert.equal(request.payload.init,false);assert.equal(request.payload.boxes,7);
  assert.deepEqual(h.worker.transfers,[[188]]);assert.equal(bytes.byteLength,0,'ownership moves to the worker');
  h.worker.reply(request,{bytes:request.payload.bytes,boxes:9});
  const checked=await pending;
  assert.equal(checked.byteLength,188);assert.equal(checked[0],0x47);assert.equal(budget.boxes,9);
  const next=h.processor.validate(packet(),'ts',false,budget),second=h.worker.requests[1];
  assert.notEqual(second.id,request.id);assert.equal(second.payload.boxes,9);
  h.worker.reply(second,validReply(second));await next;
  assert.equal(h.created,1,'one operation reuses one worker');
});

test('media processor mux and remux use fixed operations and only return bounded MP4 blobs',async t=>{
  const h=harness(t),shared=new Uint8Array([1,2,3,4]);
  const muxing=h.processor.mux([{type:'video',init:shared.subarray(0,2),segments:[shared.subarray(2)]}],{maxBytes:20});
  const request=h.worker.requests[0];
  assert.equal(request.kind,'mux');assert.equal(request.payload.maxBytes,20);
  assert.equal(h.worker.transfers[0].length,1,'aliased views transfer their buffer only once');
  const muxed=new Blob(['muxed'],{type:'video/mp4'});h.worker.reply(request,muxed);
  assert.equal(await muxing,muxed);
  const remuxing=h.processor.remux(packet(),{maxBytes:30}),second=h.worker.requests[1];
  assert.equal(second.kind,'remux');assert.equal(second.payload.maxBytes,30);
  const remuxed=new Blob(['remuxed'],{type:'video/mp4'});h.worker.reply(second,remuxed);
  assert.equal(await remuxing,remuxed);
});

test('media processor does not accept a reply for an earlier request as a new validation result',async t=>{
  const h=harness(t),budget={boxes:0};
  const first=h.processor.validate(packet(),'ts',false,budget),old=h.worker.requests[0];
  h.worker.reply(old,validReply(old));await first;
  let settled=false;
  const second=h.processor.validate(packet(),'ts',false,budget).finally(()=>{settled=true;}),current=h.worker.requests[1];
  h.worker.reply(old,{bytes:new Uint8Array(188),boxes:MEDIA_BOX_LIMIT});await tick();
  assert.equal(settled,false);assert.equal(budget.boxes,0);
  h.worker.reply(current,validReply(current));await second;
  assert.equal(budget.boxes,0);
});

test('media processor rejects a matching-id reply with the wrong operation or malformed success marker',async t=>{
  for(const extra of [{kind:'mux'},{ok:'yes'}]) {
    const h=harness(t),budget={boxes:0},pending=h.processor.validate(packet(),'ts',false,budget);
    const rejected=assert.rejects(pending);
    h.worker.reply(h.worker.requests[0],validReply(h.worker.requests[0]),extra);
    await rejected;
    assert.equal(h.worker.terminated,1);assert.equal(h.worker.listenerCount,0);assert.equal(budget.boxes,0);
  }
});

test('media processor rejects validation results with changed size, invalid bytes or invalid shared budget',async t=>{
  for(const result of [
    {bytes:new Uint8Array(187),boxes:4},
    {bytes:[0x47],boxes:4},
    {bytes:new Uint8Array(188),boxes:3},
    {bytes:new Uint8Array(188),boxes:4.5},
    {bytes:new Uint8Array(188),boxes:MEDIA_BOX_LIMIT+1},
  ]) {
    const h=harness(t),budget={boxes:4},pending=h.processor.validate(packet(),'ts',false,budget);
    const rejected=assert.rejects(pending);h.worker.reply(h.worker.requests[0],result);await rejected;
    assert.equal(budget.boxes,4);assert.equal(h.worker.terminated,1);assert.equal(h.worker.listenerCount,0);
  }
});

test('media processor rejects non-MP4, empty, oversized or non-Blob outputs before they can be saved',async t=>{
  for(const kind of ['mux','remux'])for(const result of [new Blob(['bad'],{type:'video/webm'}),new Blob([],{type:'video/mp4'}),new Blob(['too large'],{type:'video/mp4'}),new Uint8Array([1])]) {
    const h=harness(t),pending=kind==='mux' ? h.processor.mux([],{maxBytes:4}) : h.processor.remux(packet(),{maxBytes:4});
    const rejected=assert.rejects(pending);h.worker.reply(h.worker.requests[0],result);await rejected;
    assert.equal(h.worker.terminated,1);assert.equal(h.worker.listenerCount,0);
  }
});

test('media processor abort terminates pending work, removes listeners and ignores a captured late reply',async t=>{
  const controller=new AbortController(),h=harness(t,{signal:controller.signal}),budget={boxes:0};
  const pending=h.processor.validate(packet(),'ts',false,budget),request=h.worker.requests[0];
  const late=[...h.worker.listeners.get('message')][0];
  const rejected=assert.rejects(pending,{name:'AbortError'});controller.abort();await rejected;
  assert.equal(h.worker.terminated,1);assert.equal(h.worker.listenerCount,0);
  late({data:{...request,ok:true,result:{bytes:new Uint8Array(188),boxes:99}}});await tick();
  assert.equal(budget.boxes,0);
  await assert.rejects(h.processor.remux(packet()),{name:'AbortError'});
  h.processor.close();assert.equal(h.worker.terminated,1,'cleanup is idempotent');
});

test('media processor with an already-aborted operation never starts a worker',async t=>{
  const controller=new AbortController();controller.abort();
  const h=harness(t,{signal:controller.signal});
  await assert.rejects(h.processor.validate(packet(),'ts',false,{boxes:0}),{name:'AbortError'});
  assert.equal(h.created,0);
});

test('media processor times out a stalled worker and makes the operation retryable with a new processor',async t=>{
  const h=harness(t,{timeoutMs:15});
  await assert.rejects(h.processor.validate(packet(),'ts',false,{boxes:0}),/時間/);
  assert.equal(h.worker.terminated,1);assert.equal(h.worker.listenerCount,0);
  const retry=harness(t),pending=retry.processor.validate(packet(),'ts',false,{boxes:0});
  retry.worker.reply(retry.worker.requests[0],validReply(retry.worker.requests[0]));
  assert.equal((await pending).byteLength,188);
});

test('media processor handles worker failures, message deserialization failures and failed posts without a synchronous fallback',async t=>{
  for(const mode of ['error','messageerror','post']) {
    const h=harness(t);if(mode==='post')h.worker.postError=true;
    const pending=h.processor.validate(packet(),'ts',false,{boxes:0}),rejected=assert.rejects(pending);
    if(mode!=='post')h.worker.emit(mode,{preventDefault(){}});
    await rejected;assert.equal(h.created,1);assert.equal(h.worker.terminated,1);assert.equal(h.worker.listenerCount,0);
  }
  const processor=new MediaProcessor({workerFactory:()=>{throw new Error('Workers unavailable');}});
  t.after(()=>processor.close());
  await assert.rejects(processor.validate(packet(),'ts',false,{boxes:0}));
  assert.equal(processor.closed,true,'worker setup failure cannot run a synchronous parser instead');
});

test('media processor bounds remote errors and rejects concurrent or unknown work without replacing pending ownership',async t=>{
  const h=harness(t),budget={boxes:0},pending=h.processor.validate(packet(),'ts',false,budget);
  await assert.rejects(h.processor.remux(packet()));
  await assert.rejects(h.processor.run('fetch',{url:'https://synthetic.invalid/'}));
  assert.equal(h.worker.requests.length,1);
  const rejected=assert.rejects(pending,error=>error.message.length<=180);
  const request=h.worker.requests[0];h.worker.reply(request,undefined,{ok:false,error:'x'.repeat(1000)});
  await rejected;assert.equal(h.worker.terminated,1);assert.equal(budget.boxes,0);
});
