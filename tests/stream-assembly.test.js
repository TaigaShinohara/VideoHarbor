import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleStream } from '../extension/stream-assembly.js';
const box=(type,payload=[])=>{const bytes=new Uint8Array(8+payload.length);new DataView(bytes.buffer).setUint32(0,bytes.length);bytes.set([...type].map(c=>c.charCodeAt(0)),4);bytes.set(payload,8);return bytes;};
const join=(...parts)=>new Uint8Array(parts.flatMap(p=>[...p]));
const init=join(box('ftyp'),box('moov')),fragment=join(box('moof'),box('mdat',[1,2,3]));
const track=type=>({type,segments:[{url:`https://fixture.test/${type}/init.mp4`,init:true},{url:`https://fixture.test/${type}/1.m4s`}]});

test('split stream capacity is shared across video and audio; oversized audio is never partially saved',async()=>{
  const calls=[],progress=[];
  await assert.rejects(assembleStream({tracks:[track('video'),track('audio')]},async url=>{calls.push(url);return new Response(url.endsWith('init.mp4') ? init : fragment);},{maxBytes:40,onProgress:p=>progress.push(p)}),/容量上限/);
  assert.equal(calls.length,3);assert.match(calls.at(-1),/audio\/init/);
  assert.equal(progress.at(-1).bytesReceived,35);assert.equal(progress.at(-1).total,4);
});

test('split stream cancellation between tracks prevents fetching the next audio init',async()=>{
  const calls=[],controller=new AbortController();
  await assert.rejects(assembleStream({tracks:[track('video'),track('audio')]},async url=>{calls.push(url);return new Response(url.endsWith('init.mp4') ? init : fragment);},{signal:controller.signal,onProgress:p=>{if(p.completed===2)controller.abort();}}),{name:'AbortError'});
  assert.equal(calls.length,2);
});

test('single TS stream remains byte-preserving through the unified assembler',async()=>{
  const packet=new Uint8Array(188);packet[0]=0x47;
  const output=await assembleStream({extension:'ts',segments:[{url:'https://fixture.test/1.ts'}]},async()=>new Response(packet));
  assert.equal(output.type,'video/mp2t');assert.deepEqual(new Uint8Array(await output.arrayBuffer()),packet);
});
