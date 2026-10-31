import test from 'node:test';
import assert from 'node:assert/strict';
import {outputOptions,validateOutputFormat} from '../extension/output-format.js';
const direct=(url,mime='')=>({type:'direct',url,mime});
const mp4Option=item=>outputOptions(item).find(option=>option.value==='mp4');

test('native MP4/M4V files can keep their source format or use the MP4 filename extension',()=>{
  for(const item of [direct('https://cdn.test/movie.mp4?auth=synthetic'),direct('https://cdn.test/movie.M4V'),direct('https://cdn.test/play','video/mp4; codecs="avc1.4d401e"'),direct('https://cdn.test/play','video/x-m4v')]) {
    assert.equal(mp4Option(item).disabled,undefined);
    assert.equal(validateOutputFormat(item,'mp4'),'mp4');assert.equal(validateOutputFormat(item,'auto'),'auto');
  }
  assert.equal(outputOptions(direct('https://cdn.test/movie.m4v'))[0].label,'元の形式（.m4v）');
});

test('direct WebM, Ogg and MOV are offered in their source format with MP4 disabled',()=>{
  for(const [suffix,mime] of [['webm','video/webm'],['ogg','video/ogg'],['mov','video/quicktime']]) {
    const item=direct(`https://cdn.test/movie.${suffix}`,mime);
    const options=outputOptions(item);assert.match(options[0].label,new RegExp(`\\.${suffix}`));
    assert.equal(options[1].disabled,true);assert.match(options[1].reason,/変換.*対応していません/);
    assert.throws(()=>validateOutputFormat(item,'mp4'),/元の形式/);
    assert.equal(validateOutputFormat(item,'auto'),'auto');
  }
});

test('known incompatible video MIME prevents treating a misleading MP4 suffix as MP4',()=>{
  const item=direct('https://cdn.test/not-really.mp4','video/quicktime');
  assert.equal(mp4Option(item).disabled,true);assert.throws(()=>validateOutputFormat(item,'mp4'),/変換/);
  assert.equal(outputOptions(item)[0].label,'元の形式（.mov）');
  assert.equal(outputOptions(direct('https://cdn.test/not-really.mp4','video/webm'))[0].label,'元の形式（.webm）');
});

test('unknown extensionless direct URLs cannot silently receive an MP4 extension',()=>{
  for(const item of [direct('https://cdn.test/play?file=movie.mp4'),direct('https://cdn.test/play','application/octet-stream'),direct('javascript:movie.mp4')]) {
    assert.equal(mp4Option(item).disabled,true);assert.throws(()=>validateOutputFormat(item,'mp4'),/確認できない/);
    assert.match(outputOptions(item)[0].label,/形式未確認/);
  }
});

test('typed direct MP4 endpoints are enabled even when the pathname has no known suffix',()=>{
  const item=direct('https://cdn.test/resource','VIDEO/MP4 ; codecs=avc1');
  assert.equal(mp4Option(item).disabled,undefined);assert.match(outputOptions(item)[0].label,/\.mp4/);
});

test('HLS and DASH allow an MP4 attempt while auto describes their standard output',()=>{
  for(const type of ['hls','dash']) {
    const item={type,url:`https://cdn.test/manifest.${type==='hls'?'m3u8':'mpd'}`};
    const options=outputOptions(item);assert.match(options[0].label,/配信の標準/);assert.equal(options[1].disabled,undefined);
    assert.equal(validateOutputFormat(item,'mp4'),'mp4');
  }
  assert.match(outputOptions({type:'hls'})[0].label,/HLS/);
  assert.match(outputOptions({type:'dash'})[0].label,/MP4/);
});

test('blob MP4 is enabled and missing metadata defers validation to the actual snapshot',()=>{
  for(const mime of ['',undefined,'application/octet-stream','video/mp4','video/x-m4v']) {
    const item={type:'blob',url:'blob:https://page.test/uuid',mime};
    assert.equal(mp4Option(item).disabled,undefined);assert.equal(validateOutputFormat(item,'mp4'),'mp4');
  }
});

test('known non-MP4 blob types cannot be relabeled as MP4',()=>{
  for(const mime of ['video/webm','video/quicktime','video/ogg','application/ogg','text/html']) {
    const item={type:'blob',url:'blob:https://page.test/misleading.mp4',mime};
    assert.equal(mp4Option(item).disabled,true);assert.throws(()=>validateOutputFormat(item,'mp4'),/元の形式/);
  }
  assert.match(outputOptions({type:'blob',mime:'video/webm'})[0].label,/\.webm/);
});

test('invalid output values and unsupported source kinds fail without reproducing source URLs',()=>{
  const item=direct('https://cdn.test/movie.mp4?secret=synthetic');
  for(const value of ['',undefined,null,'webm','MP4','mp4?secret=synthetic',{}])assert.throws(()=>validateOutputFormat(item,value),error=>!error.message.includes('secret'));
  for(const source of [{type:'unknown'},null,undefined]) {
    assert.equal(mp4Option(source).disabled,true);assert.throws(()=>validateOutputFormat(source,'mp4'),/配信方式/);
  }
});

test('output policy is pure and every disabled option has an actionable explanation',()=>{
  const item=Object.freeze(direct('https://cdn.test/movie.webm','video/webm'));
  const first=outputOptions(item),second=outputOptions(item);assert.deepEqual(first,second);assert.notEqual(first,second);
  assert.equal(first[0].value,'auto');assert.equal(first[0].disabled,undefined);
  for(const option of first)if(option.disabled)assert.ok(option.reason.length>0);
});
