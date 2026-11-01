import test from 'node:test';
import assert from 'node:assert/strict';
import { outputName } from '../extension/filenames.js';

test('a burst of outputs uses neutral local dates and distinct sequence names even within one millisecond',()=>{
  const now=new Date(2026,10,1,19,0,3,7);
  const names=Array.from({length:1001},()=>outputName('mp4',{now}));
  assert.equal(new Set(names).size,names.length);
  assert.ok(names.every(name=>/^VideoHarbor\/2026-11-01\/video-190003007-\d{3,}\.mp4$/.test(name)));
});

test('picker suggestions share the naming policy without a folder and retain actual format suffixes',()=>{
  const now=new Date(2026,0,2,3,4,5,6);
  assert.match(outputName('webm',{recording:true,directory:false,now}),/^recording-030405006-\d{3,}\.webm$/);
  for(const extension of ['ts','mp4','m4v','mov','webm','ogv','ogg','video']) {
    assert.ok(outputName(extension,{now}).endsWith(`.${extension}`));
  }
  for(const extension of ['../mp4','.mp4','mp4/escape','mp4?secret'])assert.throws(()=>outputName(extension,{now}),TypeError);
});
