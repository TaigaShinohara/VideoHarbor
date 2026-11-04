import test from 'node:test';
import assert from 'node:assert/strict';
import {readDirectFile} from '../extension/direct-file.js';
import {processMedia} from '../extension/media-worker.js';

const mp4=new Uint8Array([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0,0,0,0,8,109,111,111,118,0,0,0,9,109,100,97,116,1]);
const read=(response,options)=>readDirectFile('https://synthetic.test/video',async()=>response,options);

test('mobile direct file keeps original bytes at the exact budget and passes worker container validation',async()=>{
  const file=await read(new Response(mp4,{headers:{'content-type':'video/mp4','content-length':String(mp4.length)}}),{maxBytes:mp4.length});
  assert.deepEqual(file.bytes,mp4);assert.equal(file.extension,'mp4');
  assert.deepEqual(processMedia('validate',{bytes:file.bytes,extension:'mp4',init:'file',boxes:0}).bytes,mp4);
  assert.throws(()=>processMedia('validate',{bytes:mp4.slice(0,-1),extension:'mp4',init:'file',boxes:0}),/途中|壊れ/);
});

test('direct files reject HTML, partial HTTP responses, empty payloads, mismatched MIME and incomplete lengths',async()=>{
  for(const response of [new Response('<html>',{headers:{'content-type':'text/html'}}),new Response(mp4,{status:206}),new Response(''),
    new Response(mp4,{headers:{'content-type':'video/webm'}}),new Response(mp4,{headers:{'content-length':'100'}}),new Response('not an mp4',{headers:{'content-type':'video/mp4'}})])await assert.rejects(()=>read(response));
});

test('direct files enforce declared and streamed budgets including absent Content-Length',async()=>{
  await assert.rejects(()=>read(new Response(mp4,{headers:{'content-length':String(mp4.length)}}),{maxBytes:mp4.length-1}),/256 MiB/);
  let cancelled=false;
  const response=new Response(new ReadableStream({start(c){c.enqueue(mp4);},cancel(){cancelled=true;}}));
  await assert.rejects(()=>read(response,{maxBytes:mp4.length-1}),/256 MiB/);assert.equal(cancelled,true);
});

test('cancelling a stalled direct body releases its reader without waiting for a network reply',async()=>{
  let cancelled=false;
  const response=new Response(new ReadableStream({cancel(){cancelled=true;}}));
  const controller=new AbortController();const pending=read(response,{signal:controller.signal});
  await new Promise(r=>setImmediate(r));controller.abort();
  await assert.rejects(pending,{name:'AbortError'});assert.equal(cancelled,true);
});
