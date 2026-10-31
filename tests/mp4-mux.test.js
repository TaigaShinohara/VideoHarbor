import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { muxFragmentedMP4 } from '../extension/mp4-mux.js';

const data = bytes => new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
const numbers = (...values) => { const bytes=new Uint8Array(values.length*4);values.forEach((value,i)=>data(bytes).setUint32(i*4,value));return bytes; };
const ascii = text => new Uint8Array([...text].map(char=>char.charCodeAt(0)));
function concat(...parts) {const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;}
function box(type,...parts) {const payload=concat(...parts);return concat(numbers(payload.length+8),ascii(type),payload);}
function full(type,payload=new Uint8Array(),flags=0,version=0) {return box(type,numbers(version*16777216+flags),payload);}
function boxes(bytes,start=0,end=bytes.length) {
  const out=[];
  for(let at=start;at<end;){const n=data(bytes).getUint32(at),size=n===1 ? Number(data(bytes).getBigUint64(at+8)) : n;const header=n===1 ? 16 : 8;assert.ok(size>=header && at+size<=end);out.push({type:String.fromCharCode(...bytes.subarray(at+4,at+8)),start:at,data:at+header,end:at+size,size});at+=size;}
  return out;
}
function child(bytes,parent,type) {return boxes(bytes,parent.data,parent.end).find(box=>box.type===type);}
function path(bytes,...names) {let parent={data:0,end:bytes.length};for(const name of names){parent=child(bytes,parent,name);assert.ok(parent,`missing ${name}`);}return parent;}
function changed(bytes,edit) {const copy=bytes.slice();edit(copy);return copy;}
const descriptor=(tag,...parts)=>{const payload=concat(...parts);assert.ok(payload.length<128);return concat(new Uint8Array([tag,payload.length]),payload);};
function init(type,{id=7,timescale=type==='video' ? 1000 : 48000,movieTimescale=1000,edit,codec}={}) {
  const mvhd=new Uint8Array(100);data(mvhd).setUint32(12,movieTimescale);data(mvhd).setUint32(96,8);
  const tkhd=new Uint8Array(84);data(tkhd).setUint32(0,3);data(tkhd).setUint32(12,id);if(edit)data(tkhd).setUint32(20,movieTimescale);
  const mdhd=new Uint8Array(24);data(mdhd).setUint32(12,timescale);
  const hdlr=new Uint8Array(24);hdlr.set(ascii(type==='video' ? 'vide' : 'soun'),8);
  let sample;
  if(type==='video') {
    const header=new Uint8Array(78);data(header).setUint16(6,1);
    sample=box(codec||'avc1',header,box('avcC',new Uint8Array([1,66,0,30,255,224,0])));
  } else {
    const header=new Uint8Array(28);data(header).setUint16(6,1);data(header).setUint16(16,2);
    const esds=full('esds',descriptor(3,new Uint8Array([0,1,0]),descriptor(4,new Uint8Array([0x40,0x15,0,0,0,0,0,0,0,0,0,0,0]),descriptor(5,new Uint8Array([0x12,0x10]))),descriptor(6,new Uint8Array([2]))));
    sample=box(codec||'mp4a',header,esds);
  }
  const stbl=box('stbl',full('stsd',concat(numbers(1),sample)),full('stts',numbers(0)),full('stsc',numbers(0)),full('stsz',numbers(0,0)),full('stco',numbers(0)));
  const dinf=box('dinf',full('dref',concat(numbers(1),full('url ',new Uint8Array(),1))));
  const minf=box('minf',full(type==='video' ? 'vmhd' : 'smhd',new Uint8Array(type==='video' ? 8 : 4),type==='video' ? 1 : 0),dinf,stbl);
  const edts=edit ? box('edts',full('elst',concat(numbers(1,movieTimescale,edit),new Uint8Array([0,1,0,0])))) : new Uint8Array();
  const trak=box('trak',box('tkhd',tkhd),edts,box('mdia',box('mdhd',mdhd),box('hdlr',hdlr),minf));
  return concat(box('ftyp',ascii('iso6'),numbers(0),ascii('iso6'),ascii('mp41')),box('moov',box('mvhd',mvhd),trak,box('mvex',full('trex',numbers(id,1,0,0,0)))));
}
function segment({id=7,time=0n,duration=100,size=4,payload,sequence=91}={}) {
  const tfhd=full('tfhd',numbers(id,duration,size,0),0x020038),timeBytes=new Uint8Array(8);data(timeBytes).setBigUint64(0,time);
  let moof=box('moof',full('mfhd',numbers(sequence)),box('traf',tfhd,full('tfdt',timeBytes,0,1),full('trun',numbers(1,0),1)));
  const trun=path(moof,'moof','traf','trun');data(moof).setInt32(trun.data+8,moof.length+8);
  return concat(moof,box('mdat',payload||new Uint8Array(size).fill(0x61)));
}
function track(type,options={}) {
  return {type,init:init(type,options),segments:[segment({id:options.id,time:options.time,duration:type==='video' ? 100 : 4800,...options.fragment})]};
}
const output=async tracks=>new Uint8Array(await muxFragmentedMP4(tracks).arrayBuffer());

test('MP4 mux: colliding track IDs are rewritten in tkhd, trex and every fragment without altering input',async()=>{
  const video=track('video'),audio=track('audio'),before=structuredClone([video,audio]);
  const bytes=await output([video,audio]),top=boxes(bytes),moov=top.find(box=>box.type==='moov');
  const traks=boxes(bytes,moov.data,moov.end).filter(box=>box.type==='trak');
  assert.equal(traks.length,2);
  assert.deepEqual(traks.map(trak=>data(bytes).getUint32(child(bytes,trak,'tkhd').data+12)),[1,2]);
  const mvex=child(bytes,moov,'mvex');assert.deepEqual(boxes(bytes,mvex.data,mvex.end).map(trex=>data(bytes).getUint32(trex.data+4)),[1,2]);
  const mvhd=child(bytes,moov,'mvhd');assert.equal(data(bytes).getUint32(mvhd.end-4),3);
  const fragments=top.filter(box=>box.type==='moof');
  assert.deepEqual(fragments.map(moof=>data(bytes).getUint32(child(bytes,child(bytes,moof,'traf'),'tfhd').data+4)),[1,2]);
  assert.deepEqual(fragments.map(moof=>data(bytes).getUint32(child(bytes,moof,'mfhd').data+4)),[1,2]);
  assert.deepEqual([video,audio],before);
  for(let i=0;i<2;i++) {
    const source=[video,audio][i].init;
    const original=path(source,'moov','trak','mdia','mdhd'),preserved=child(bytes,child(bytes,traks[i],'mdia'),'mdhd');
    assert.deepEqual(bytes.slice(preserved.start,preserved.end),source.slice(original.start,original.end));
  }
});

test('MP4 mux: interleaves decode times using each independent media timescale',async()=>{
  const video=track('video');video.segments.push(segment({time:100n,payload:new Uint8Array([0x76,0x32,0,0])}));
  const audio=track('audio');audio.segments=[segment({time:0n,duration:2400}),segment({time:2400n,duration:2400})];
  const bytes=await output([video,audio]),fragments=boxes(bytes).filter(box=>box.type==='moof');
  assert.deepEqual(fragments.map(moof=>{
    const traf=child(bytes,moof,'traf');return [data(bytes).getUint32(child(bytes,traf,'tfhd').data+4),data(bytes).getBigUint64(child(bytes,traf,'tfdt').data+4)];
  }),[[1,0n],[2,0n],[2,2400n],[1,100n]]);
});

test('MP4 mux: preserves sample bytes and drops stale sidx/mfra indexes',async()=>{
  const video=track('video',{fragment:{size:8,payload:ascii('psshdata')}});
  video.segments=[concat(box('styp',ascii('msdh'),numbers(0)),box('sidx',new Uint8Array(24)),video.segments[0],box('mfra',new Uint8Array()))];
  const bytes=await output([video]);
  assert.deepEqual(boxes(bytes).map(box=>box.type),['ftyp','moov','moof','mdat']);
  const mdat=boxes(bytes).find(box=>box.type==='mdat');assert.deepEqual(bytes.slice(mdat.data,mdat.end),ascii('psshdata'));
});

test('MP4 mux: edit durations are converted to the shared movie clock while media offsets remain intact',async()=>{
  const video=track('video'),audio=track('audio',{movieTimescale:48000,edit:96});
  const bytes=await output([video,audio]),moov=path(bytes,'moov'),trak=boxes(bytes,moov.data,moov.end).filter(box=>box.type==='trak')[1];
  const edits=child(bytes,child(bytes,trak,'edts'),'elst'),tkhd=child(bytes,trak,'tkhd');
  assert.equal(data(bytes).getUint32(edits.data+8),1000);assert.equal(data(bytes).getInt32(edits.data+12),96);
  assert.equal(data(bytes).getUint32(tkhd.data+20),1000);
});

test('MP4 mux: movie duration includes composition offsets without changing fragment timing',async()=>{
  for(const [version,offset,expected] of [[0,200,300],[1,-50,50]]) {
    const source=track('video'),tfhd=full('tfhd',numbers(7,100,4,0),0x020038),timeBytes=new Uint8Array(8);
    const moof=box('moof',full('mfhd',numbers(1)),box('traf',tfhd,full('tfdt',timeBytes,0,1),full('trun',numbers(1,0,offset),0x801,version)));
    const trun=path(moof,'moof','traf','trun');data(moof).setInt32(trun.data+8,moof.length+8);
    source.segments=[concat(moof,box('mdat',new Uint8Array(4)))];
    const bytes=await output([source]),mvhd=path(bytes,'moov','mvhd');
    assert.equal(data(bytes).getUint32(mvhd.data+16),expected);
    const preserved=path(bytes,'moof','traf','trun');assert.equal(data(bytes).getInt32(preserved.data+12),offset);
  }
});

test('MP4 mux: malformed and oversized boxes fail before output',()=>{
  const originals=track('video');
  for(const bad of [new Uint8Array(7),concat(numbers(9999),ascii('ftyp')),concat(numbers(0),ascii('ftyp')),concat(numbers(1),ascii('ftyp'),new Uint8Array(8).fill(255))]) {
    assert.throws(()=>muxFragmentedMP4([{...originals,init:bad}]),/MP4/);
  }
  assert.throws(()=>muxFragmentedMP4([originals],{maxBytes:10}),/上限/);
  assert.throws(()=>muxFragmentedMP4([originals],{maxBytes:268435457}),/上限/);
  assert.throws(()=>muxFragmentedMP4([]),/最大1本/);
  assert.throws(()=>muxFragmentedMP4([originals,originals]),/最大1本/);
});

test('MP4 mux: unknown codecs, protected sample entries and encryption boxes are rejected',()=>{
  assert.throws(()=>muxFragmentedMP4([track('video',{codec:'encv'})]),/暗号化/);
  assert.throws(()=>muxFragmentedMP4([track('audio',{codec:'enca'})]),/暗号化/);
  assert.throws(()=>muxFragmentedMP4([track('video',{codec:'jpeg'})]),/コーデック/);
  for(const encrypted of ['pssh','sinf','senc','saiz','saio','uuid']) {
    const source=track('video');source.segments=[concat(box(encrypted,new Uint8Array()),source.segments[0])];
    assert.throws(()=>muxFragmentedMP4([source]),/暗号化/);
  }
});

test('MP4 mux: fragment track IDs must match their input init, even when output IDs are reassigned',()=>{
  const source=track('video');source.segments=[segment({id:8})];
  assert.throws(()=>muxFragmentedMP4([source]),/トラックID/);
  const bad={...track('video'),type:'audio'};assert.throws(()=>muxFragmentedMP4([bad]),/一致しません/);
});

test('MP4 mux: rejects absolute or ambiguous offsets, missing clocks and out-of-range samples',()=>{
  for(const change of [
    bytes=>data(bytes).setUint32(path(bytes,'moof','traf','tfhd').data,0x020039),
    bytes=>data(bytes).setUint32(path(bytes,'moof','traf','tfhd').data,0x38),
    bytes=>data(bytes).setUint32(path(bytes,'moof','traf','trun').data+8,1),
    bytes=>data(bytes).setUint32(path(bytes,'moof','traf','trun').data+8,0x7fffffff),
    bytes=>bytes.set(ascii('free'),path(bytes,'moof','traf','tfdt').start+4),
    bytes=>data(bytes).setUint32(path(bytes,'moof','traf','trun').data+4,1000001),
  ]) {
    const source=track('video');source.segments=[changed(source.segments[0],change)];
    assert.throws(()=>muxFragmentedMP4([source]),/MP4/);
  }
});

test('MP4 mux: overlapping decode ranges are rejected, intentional gaps stay unchanged',async()=>{
  const source=track('video');source.segments.push(segment({time:99n}));assert.throws(()=>muxFragmentedMP4([source]),/重複/);
  source.segments[1]=segment({time:200n});const bytes=await output([source]);
  const fragments=boxes(bytes).filter(box=>box.type==='moof');assert.equal(data(bytes).getBigUint64(child(bytes,child(bytes,fragments[1],'traf'),'tfdt').data+4),200n);
});

test('MP4 mux: external references and populated normal-MP4 sample tables cannot pass as fMP4 init',()=>{
  for(const change of [
    bytes=>data(bytes).setUint32(path(bytes,'moov','trak','mdia','minf','stbl','stsz').data+8,1),
    bytes=>data(bytes).setUint32(path(bytes,'moov','trak','mdia','mdhd').data+12,0),
    bytes=>{const dref=path(bytes,'moov','trak','mdia','minf','dinf','dref');data(bytes).setUint32(dref.data+8+8,0);},
    bytes=>{const stsd=path(bytes,'moov','trak','mdia','minf','stbl','stsd');data(bytes).setUint32(stsd.data+4,2);},
  ]) {
    const source=track('video');source.init=changed(source.init,change);assert.throws(()=>muxFragmentedMP4([source]),/MP4/);
  }
});

const ffmpeg=spawnSync('ffmpeg',['-version'],{encoding:'utf8'}).status===0 ? 'ffmpeg' : null;
const ffprobe=spawnSync('ffprobe',['-version'],{encoding:'utf8'}).status===0 ? 'ffprobe' : null;
function run(command,args) {const result=spawnSync(command,args,{encoding:'utf8',timeout:20000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr||String(result.error));return result;}
test('MP4 mux: real separate HLS and DASH H264/AAC fragments decode both tracks after remux', {skip:!ffmpeg||!ffprobe},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'videoharbor-mp4-mux-test-'));
  try {
    for(const format of ['hls','dash']) {
      const tracks=[];
      for(const type of ['video','audio']) {
        const folder=join(dir,`${format}-${type}`);await mkdir(folder);
        const input=type==='video' ? 'testsrc2=size=64x64:rate=8' : 'sine=frequency=440:sample_rate=48000';
        const codec=type==='video' ? ['-an','-c:v','libx264','-bf','0','-pix_fmt','yuv420p','-g','4','-sc_threshold','0'] : ['-vn','-c:a','aac','-ac','2'];
        const output=join(folder,format==='hls' ? 'playlist.m3u8' : 'manifest.mpd');
        const muxer=format==='hls' ? ['-f','hls','-hls_segment_type','fmp4','-hls_time','0.5','-hls_playlist_type','vod'] : ['-f','dash','-seg_duration','0.5','-use_template','1','-use_timeline','1'];
        run(ffmpeg,['-v','error','-nostdin','-y','-f','lavfi','-i',input,...codec,'-t','1.5','-threads','1',...muxer,output]);
        const files=(await readdir(folder)).sort(),initFile=files.find(name=>/^init.*\.(?:mp4|m4s)$/.test(name));
        assert.ok(initFile,'ffmpeg writes an initialization section');
        const segmentFiles=files.filter(name=>name!==initFile&&name.endsWith('.m4s'));
        assert.ok(segmentFiles.length>=2,'fixture exercises multiple fragments per track');
        tracks.push({type,init:new Uint8Array(await readFile(join(folder,initFile))),segments:await Promise.all(segmentFiles.map(async name=>new Uint8Array(await readFile(join(folder,name))))) });
      }
      const merged=muxFragmentedMP4(tracks),file=join(dir,`${format}-merged.mp4`);await writeFile(file,new Uint8Array(await merged.arrayBuffer()));
      const probe=JSON.parse(run(ffprobe,['-v','error','-show_entries','stream=codec_type,codec_name,duration,start_time','-of','json',file]).stdout);
      assert.deepEqual(probe.streams.map(stream=>stream.codec_type).sort(),['audio','video']);
      assert.deepEqual(probe.streams.map(stream=>stream.codec_name).sort(),['aac','h264']);
      for(const stream of probe.streams)assert.ok(Number(stream.duration)>=1.4&&Number(stream.duration)<=1.6,JSON.stringify(stream));
      assert.ok(Math.abs(Number(probe.streams[0].start_time)-Number(probe.streams[1].start_time))<0.1,'input presentation start times remain aligned');
      const decode=run(ffmpeg,['-v','error','-xerror','-err_detect','explode','-threads','1','-i',file,'-map','0:v:0','-map','0:a:0','-threads','1','-f','null','-']);
      assert.equal(decode.stderr,'','both actual sample streams decode without an error');
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
