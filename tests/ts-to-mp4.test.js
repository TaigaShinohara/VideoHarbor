import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { join as pathJoin } from 'node:path';
import { tmpdir } from 'node:os';
import { remuxTSToMP4 } from '../extension/ts-to-mp4.js';

const data=bytes=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
function concatList(parts){const result=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const part of parts){result.set(part,at);at+=part.length;}return result;}
function concat(...parts){return concatList(parts);}
function crcSection(values){let crc=0xffffffff;for(const value of values){crc^=value<<24;for(let bit=0;bit<8;bit++)crc=crc&0x80000000 ? (crc<<1)^0x04c11db7 : crc<<1;}const result=new Uint8Array(values.length+4);result.set(values);data(result).setUint32(values.length,crc>>>0);return result;}
function section(id,body){const length=body.length+4;return crcSection([id,0xb0|(length>>8),length&255,...body]);}
function pat(programs=[[1,4096]]){return section(0,[0,1,0xc1,0,0,...programs.flatMap(([id,pid])=>[id>>8,id&255,0xe0|(pid>>8),pid&255])]);}
function pmt({audio=true,videoType=0x1b,audioType=15,ca=false}={}){
  const info=ca ? [9,4,0,1,0xe1,0] : [];
  return section(2,[0,1,0xc1,0,0,0xe1,0,0xf0,info.length,...info,videoType,0xe1,0,0xf0,0,...(audio ? [audioType,0xe1,1,0xf0,0] : [])]);
}
function bits(){const values=[];const put=(n,width)=>{for(let i=width-1;i>=0;i--)values.push(Math.floor(n/2**i)&1);};const ue=n=>{const v=n+1,width=Math.floor(Math.log2(v));put(0,width);put(v,width+1);};const finish=()=>{values.push(1);while(values.length%8)values.push(0);const bytes=[];for(let i=0;i<values.length;i+=8)bytes.push(values.slice(i,i+8).reduce((n,v)=>n*2+v,0));const escaped=[];let zeros=0;for(const value of bytes){if(zeros>=2&&value<=3){escaped.push(3);zeros=0;}escaped.push(value);zeros=value===0 ? zeros+1 : 0;}return new Uint8Array(escaped);};return{put,ue,finish};}
function sps(){const b=bits();b.put(66,8);b.put(0,8);b.put(30,8);b.ue(0);b.ue(0);b.ue(0);b.ue(0);b.ue(1);b.put(0,1);b.ue(3);b.ue(3);b.put(1,1);b.put(1,1);b.put(0,1);b.put(1,1);b.put(0,1);b.put(0,1);b.put(0,1);b.put(0,1);b.put(1,1);b.put(1,32);b.put(60,32);b.put(1,1);return concat(new Uint8Array([0x67]),b.finish());}
function pps(){const b=bits();b.ue(0);b.ue(0);b.put(0,1);b.put(0,1);b.ue(0);return concat(new Uint8Array([0x68]),b.finish());}
function slice(key=true){const b=bits();b.ue(0);b.ue(key ? 2 : 0);b.ue(0);b.put(0,8);return concat(new Uint8Array([key ? 0x65 : 0x41]),b.finish());}
const annex=(...nals)=>concat(...nals.flatMap(nal=>[new Uint8Array([0,0,0,1]),nal]));
function time(value,prefix){value=((value%8589934592)+8589934592)%8589934592;return new Uint8Array([(prefix<<4)|((Math.floor(value/1073741824)&7)<<1)|1,Math.floor(value/4194304)&255,((Math.floor(value/32768)&127)<<1)|1,Math.floor(value/128)&255,((value&127)<<1)|1]);}
function pes(es,{audio=false,pts=9000,dts=pts}={}){const clock=audio||pts===dts ? time(pts,2) : concat(time(pts,3),time(dts,1)),length=audio ? 3+clock.length+es.length : 0;return concat(new Uint8Array([0,0,1,audio ? 0xc0 : 0xe0,length>>8,length&255,0x80,clock.length===10 ? 0xc0 : 0x80,clock.length]),clock,es);}
function adts({rate=3,channels=2,profile=1,payload=new Uint8Array([0x11,0x22,0x33])}={}){const length=7+payload.length;return concat(new Uint8Array([255,241,(profile<<6)|(rate<<2)|(channels>>2),((channels&3)<<6)|(length>>11),(length>>3)&255,((length&7)<<5)|31,252]),payload);}
function transport(){const packets=[],cc=new Map();return{packets,add(pid,bytes,psi=false){if(psi)bytes=concat(new Uint8Array([0]),bytes);for(let at=0;at<bytes.length;at+=184){const payload=bytes.subarray(at,Math.min(at+184,bytes.length)),packet=new Uint8Array(188).fill(255),counter=cc.get(pid)||0;packet.set([71,(at===0 ? 64 : 0)|(pid>>8),pid&255,(payload.length===184 ? 16 : 48)|counter]);cc.set(pid,(counter+1)&15);let offset=4;if(payload.length<184){const length=183-payload.length;packet[4]=length;if(length)packet[5]=0;offset=5+length;}packet.set(payload,offset);packets.push(packet);}},result(){return concatList(packets);}};}
function fixture({audio=true,count=3,allKey=false,videoType=0x1b,audioType=15,missingAudio=false,videoES,frames,clock=0,ca=false}={}){const t=transport();t.add(0,pat(),true);t.add(4096,pmt({audio,videoType,audioType,ca}),true);if(audio&&!missingAudio)t.add(257,pes(concat(...(frames||Array.from({length:10},()=>adts()))),{audio:true,pts:clock}));for(let i=0;i<count;i++)t.add(256,pes(videoES||annex(...(i===0 ? [sps(),pps()] : []),new Uint8Array([9,240]),slice(i===0||allKey)),{pts:clock+3000+i*3000,dts:clock+i*3000}));return t.result();}
function boxes(bytes,start=0,end=bytes.length){const found=[];for(let at=start;at<end;){const size=data(bytes).getUint32(at);assert.ok(size>=8&&at+size<=end);found.push({type:String.fromCharCode(...bytes.subarray(at+4,at+8)),start:at,data:at+8,end:at+size});at+=size;}return found;}
function child(bytes,parent,type){return boxes(bytes,parent.data,parent.end).find(box=>box.type===type);}
function path(bytes,...names){let parent={data:0,end:bytes.length};for(const name of names){parent=child(bytes,parent,name);assert.ok(parent,`missing ${name}`);}return parent;}

test('TS->MP4: writes genuine fast-start MP4 sample tables and keeps declared audio',async()=>{
  const input=fixture(),snapshot=input.slice(),blob=remuxTSToMP4(input),bytes=new Uint8Array(await blob.arrayBuffer());
  assert.equal(blob.type,'video/mp4');assert.deepEqual(boxes(bytes).map(box=>box.type),['ftyp','moov','mdat']);assert.deepEqual(input,snapshot);
  const moov=path(bytes,'moov'),traks=boxes(bytes,moov.data,moov.end).filter(box=>box.type==='trak');assert.equal(traks.length,2);
  for(const [i,trak]of traks.entries()){const mdia=child(bytes,trak,'mdia'),hdlr=child(bytes,mdia,'hdlr'),stbl=child(bytes,child(bytes,mdia,'minf'),'stbl');assert.equal(String.fromCharCode(...bytes.slice(hdlr.data+8,hdlr.data+12)),i ? 'soun' : 'vide');assert.equal(data(bytes).getUint32(child(bytes,stbl,'stsz').data+8),i ? 10 : 3);const offset=data(bytes).getUint32(child(bytes,stbl,'stco').data+8);assert.ok(offset>=path(bytes,'mdat').data&&offset<bytes.length);}
});

test('TS->MP4: a video-only PMT is supported, while missing declared audio is refused',async()=>{
  const bytes=new Uint8Array(await remuxTSToMP4(fixture({audio:false})).arrayBuffer()),moov=path(bytes,'moov');
  assert.equal(boxes(bytes,moov.data,moov.end).filter(box=>box.type==='trak').length,1);
  assert.throws(()=>remuxTSToMP4(fixture({missingAudio:true})),/音声がありません/);
});

test('TS->MP4: rejects malformed input, excessive size and damaged/scrambled transport',()=>{
  for(const bytes of [new Uint8Array(),new Uint8Array(187),new Uint8Array(188)])assert.throws(()=>remuxTSToMP4(bytes),/TSからMP4/);
  const bytes=fixture();assert.throws(()=>remuxTSToMP4(bytes,{maxBytes:bytes.length-1}),/上限/);
  for(const edit of [copy=>copy[3]|=128,copy=>copy[1]|=128,copy=>copy[4]=255]){const copy=bytes.slice();edit(copy);assert.throws(()=>remuxTSToMP4(copy),/TSからMP4/);}
  const videoPackets=[];for(let at=0;at<bytes.length;at+=188)if(((bytes[at+1]&31)<<8|bytes[at+2])===256)videoPackets.push(at);
  const missing=concat(bytes.subarray(0,videoPackets[1]),bytes.subarray(videoPackets[1]+188));assert.throws(()=>remuxTSToMP4(missing),/欠落/);
});

test('TS->MP4: PAT/PMT CRC, single program, supported codecs and clear descriptors are required',()=>{
  const broken=fixture();broken[187]^=1;assert.throws(()=>remuxTSToMP4(broken),/CRC/);
  for(const options of [{videoType:0x24},{audioType:0x11},{ca:true}])assert.throws(()=>remuxTSToMP4(fixture(options)),/対応|暗号化/);
  const t=transport();t.add(0,pat([[1,4096],[2,4097]]),true);assert.throws(()=>remuxTSToMP4(t.result()),/単一番組/);
});

test('TS->MP4: unsupported AAC, split frames and configuration changes fail without silent audio loss',()=>{
  for(const frame of [adts({profile:0}),adts({channels:0}),adts({rate:15}),adts().subarray(0,8)])assert.throws(()=>remuxTSToMP4(fixture({frames:[frame]})),/AAC/);
  assert.throws(()=>remuxTSToMP4(fixture({frames:[adts(),adts({rate:4})]})),/AAC設定/);
});

test('TS->MP4: ambiguous AVC access units, non-IDR starts and invalid timestamps fail explicitly',()=>{
  const settings=[sps(),pps(),new Uint8Array([9,240])];
  for(const es of [annex(...settings,slice(false)),annex(...settings,slice(),new Uint8Array([9,240]),slice()),annex(...settings,new Uint8Array([0x74,0x80]))])assert.throws(()=>remuxTSToMP4(fixture({videoES:es})),/AVC|IDR|画像/);
  const t=transport();t.add(0,pat(),true);t.add(4096,pmt({audio:false}),true);const packet=pes(annex(sps(),pps(),slice()));packet[9]&=254;t.add(256,packet);assert.throws(()=>remuxTSToMP4(t.result()),/タイムスタンプ/);
});

test('TS->MP4: valid AVC escapes crossing the slice-header prefix keep the complete NAL bytes',async()=>{
  for(const offset of [60,61,62])for(const following of [0,1,2,3]) {
    const nal=new Uint8Array(70).fill(0x55);nal.set(slice());nal.set([0,0,3,following],offset);
    const bytes=new Uint8Array(await remuxTSToMP4(fixture({audio:false,count:1,videoES:annex(sps(),pps(),nal)})).arrayBuffer());
    const mdat=path(bytes,'mdat');
    assert.equal(data(bytes).getUint32(mdat.data),nal.length);
    assert.deepEqual(bytes.subarray(mdat.data+4,mdat.end),nal,`escape at ${offset} with lookahead ${following} preserves compressed bytes`);
  }
});

test('TS->MP4: an invalid or actually truncated AVC escape at the prefix boundary remains rejected',()=>{
  for(const following of [4,255,undefined]) {
    const nal=new Uint8Array(following===undefined ? 64 : 70).fill(0x55);nal.set(slice());
    nal.set(following===undefined ? [0,0,3] : [0,0,3,following],61);
    assert.throws(()=>remuxTSToMP4(fixture({audio:false,count:1,videoES:annex(sps(),pps(),nal)})),/AVCのエスケープが不正/);
  }
});

test('TS->MP4: 33-bit timestamp rollover stays continuous',async()=>{
  const bytes=new Uint8Array(await remuxTSToMP4(fixture({clock:8589934592-6000,audio:false})).arrayBuffer());
  const stts=path(bytes,'moov','trak','mdia','minf','stbl','stts');assert.equal(data(bytes).getUint32(stts.data+4),1);assert.equal(data(bytes).getUint32(stts.data+8),3);assert.equal(data(bytes).getUint32(stts.data+12),3000);
});

test('TS->MP4: sample counts above the JavaScript argument limit still produce bounded tables',async()=>{
  const count=125001,input=fixture({audio:false,count,allKey:true}),bytes=new Uint8Array(await remuxTSToMP4(input).arrayBuffer());
  const stsz=path(bytes,'moov','trak','mdia','minf','stbl','stsz'),stss=path(bytes,'moov','trak','mdia','minf','stbl','stss');assert.equal(data(bytes).getUint32(stsz.data+8),count);assert.equal(data(bytes).getUint32(stss.data+4),count);
});

const ffmpeg=spawnSync('ffmpeg',['-version'],{encoding:'utf8'}).status===0 ? 'ffmpeg' : null;
const ffprobe=spawnSync('ffprobe',['-version'],{encoding:'utf8'}).status===0 ? 'ffprobe' : null;
function run(command,args){const result=spawnSync(command,args,{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});assert.equal(result.status,0,result.stderr||String(result.error));return result.stdout;}
test('TS->MP4: actual HLS AVC/AAC B-frames and video-only streams retain packet clocks and fully decode',{skip:!ffmpeg||!ffprobe},async()=>{
  const folder=await mkdtemp(pathJoin(tmpdir(),'videoharbor-ts-to-mp4-'));
  try {
    for(const audio of [true,false]) {
      const prefix=audio ? 'av' : 'video',playlist=pathJoin(folder,prefix+'.m3u8');
      run(ffmpeg,['-v','error','-nostdin','-y','-f','lavfi','-i','testsrc2=size=96x64:rate=12',...(audio ? ['-f','lavfi','-i','sine=frequency=440:sample_rate=44100'] : []),'-t','2','-c:v','libx264','-pix_fmt','yuv420p','-threads','1','-g','12','-bf','2','-sc_threshold','0',...(audio ? ['-c:a','aac','-b:a','64k','-ac','2'] : ['-an']),'-f','hls','-hls_time','1','-hls_playlist_type','vod',playlist]);
      const files=(await readdir(folder)).filter(file=>file.startsWith(prefix)&&file.endsWith('.ts')).sort();assert.ok(files.length>=2);
      const input=concat(...await Promise.all(files.map(async file=>new Uint8Array(await readFile(pathJoin(folder,file))))));
      const source=pathJoin(folder,prefix+'-source.ts'),file=pathJoin(folder,prefix+'-out.mp4');await writeFile(source,input);await writeFile(file,new Uint8Array(await remuxTSToMP4(input).arrayBuffer()));
      const probe=JSON.parse(run(ffprobe,['-v','error','-show_entries','format=format_name,duration:stream=codec_type,codec_name,duration,nb_frames,width,height','-of','json',file]));
      assert.match(probe.format.format_name,/mp4/);assert.equal(probe.streams.length,audio ? 2 : 1);assert.equal(probe.streams[0].codec_name,'h264');assert.equal(probe.streams[0].nb_frames,'24');assert.equal(probe.streams[0].width,96);assert.equal(probe.streams[0].height,64);assert.ok(Number(probe.format.duration)>=1.9&&Number(probe.format.duration)<2.2);if(audio)assert.equal(probe.streams[1].codec_name,'aac');
      const packets=path=>JSON.parse(run(ffprobe,['-v','error','-show_packets','-show_entries','packet=stream_index,pts_time,dts_time','-of','json',path])).packets;
      const before=packets(source),after=packets(file),origin=Math.min(...before.map(packet=>Number(packet.pts_time)));
      for(let stream=0;stream<(audio ? 2 : 1);stream++){
        const a=before.filter(packet=>packet.stream_index===stream),b=after.filter(packet=>packet.stream_index===stream);assert.equal(a.length,b.length);
        for(let i=0;i<a.length;i++)for(const key of ['pts_time','dts_time'])assert.ok(Math.abs((Number(a[i][key])-origin)-Number(b[i][key]))<0.00004,`stream${stream} sample${i} ${key} preserves original clock`);
      }
      assert.equal(run(ffmpeg,['-v','error','-xerror','-err_detect','explode','-threads','1','-i',file,'-map','0','-threads','1','-f','null','-']),'');
    }
  } finally {await rm(folder,{recursive:true,force:true});}
});
