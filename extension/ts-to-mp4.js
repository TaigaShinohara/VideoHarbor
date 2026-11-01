// Local packet-preserving MPEG-TS -> fast-start MP4 remuxing. Supported input:
// one current PAT/PMT program, AVC Annex B (one picture per PES), AAC ADTS.
// No codecs, decryption, third-party libraries or playback recording are used.
const LIMIT = 268435456, PES_LIMIT = 16777216, SAMPLE_LIMIT = 1000000;
const CLOCK_WRAP = 8589934592;
const rates = [96000,88200,64000,48000,44100,32000,24000,22050,16000,12000,11025,8000,7350];
const fail = message => { throw new Error(`TSからMP4へ保存できません。${message}`); };
const dv = bytes => new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
const ascii = text => new Uint8Array([...text].map(char=>char.charCodeAt(0)));
function join(parts) {const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let at=0;for(const part of parts){out.set(part,at);at+=part.length;}return out;}
function u32(...values) {const out=new Uint8Array(values.length*4);values.forEach((v,i)=>dv(out).setUint32(i*4,v));return out;}
function words(values) {const out=new Uint8Array(values.length*4);values.forEach((value,i)=>dv(out).setUint32(i*4,value));return out;}
function u16(...values) {const out=new Uint8Array(values.length*2);values.forEach((v,i)=>dv(out).setUint16(i*2,v));return out;}
function box(type,...parts) {const size=8+parts.reduce((n,p)=>n+p.length,0);return join([u32(size),ascii(type),...parts]);}
const full = (type,payload,flags=0,version=0) => box(type,u32(version*16777216+flags),payload);
const same = (a,b) => a.length===b.length&&a.every((value,i)=>value===b[i]);
function uint(value) {if(!Number.isSafeInteger(value)||value<0||value>4294967295)fail('サイズまたは時間が対応範囲を超えています。');return value;}
function signed(value) {if(!Number.isSafeInteger(value)||value< -2147483648||value>2147483647)fail('時刻の補正量が対応範囲を超えています。');return value;}
const matrix = u32(65536,0,0,0,65536,0,0,0,1073741824);
const crcTable = Uint32Array.from({length:256},(_,i)=>{let crc=i<<24;for(let bit=0;bit<8;bit++)crc=crc&0x80000000 ? (crc<<1)^0x04c11db7 : crc<<1;return crc>>>0;});
function crcOK(bytes) {let crc=0xffffffff;for(const value of bytes)crc=((crc<<8)^crcTable[((crc>>>24)^value)&255])>>>0;return crc===0;}
function descriptors(bytes,start,end) {for(let at=start;at<end;){if(end-at<2||at+2+bytes[at+1]>end)fail('PMTの設定が途中で終わっています。');if(bytes[at]===9)fail('暗号化・保護されたTSには対応していません。');at+=2+bytes[at+1];}}
function rbsp(bytes,limit=bytes.length) {
  const result=[];
  // Limit parsing/allocation without hiding the original byte after an escape.
  // A prefix boundary is not the end of the NAL; a real truncated escape is.
  for(let i=0;i<Math.min(bytes.length,limit);i++){if(i>=2&&bytes[i]===3&&bytes[i-1]===0&&bytes[i-2]===0){if(i+1>=bytes.length||bytes[i+1]>3)fail('AVCのエスケープが不正です。');continue;}result.push(bytes[i]);}
  return new Uint8Array(result);
}
class Bits {
  constructor(bytes){this.bytes=bytes;this.at=0;}
  read(count){if(count>32||this.at+count>this.bytes.length*8)fail('AVCの設定が途中で終わっています。');let value=0;for(let i=0;i<count;i++){value=value*2+((this.bytes[this.at>>3]>>(7-(this.at&7)))&1);this.at++;}return value;}
  ue(){let zeros=0;while(!this.read(1)){if(++zeros>30)fail('AVCの数値が大きすぎます。');}return 2**zeros-1+this.read(zeros);}
  se(){const value=this.ue();return value&1 ? (value+1)/2 : -value/2;}
}
function spsInfo(nal) {
  const bits=new Bits(rbsp(nal.subarray(1))),profile=bits.read(8),compatibility=bits.read(8),level=bits.read(8),id=bits.ue();
  let chroma=1;
  if([100,110,122,244,44,83,86,118,128,138,139,134,135,144].includes(profile)) {
    chroma=bits.ue();if(chroma!==1||bits.ue()!==0||bits.ue()!==0)fail('8bit・4:2:0以外のAVCには対応していません。');
    bits.read(1);
    if(bits.read(1))for(let list=0;list<8;list++)if(bits.read(1)){let last=8,next=8;for(let j=0;j<(list<6 ? 16 : 64);j++){if(next)next=(last+bits.se()+256)%256;last=next||last;}}
  } else if(![66,77,88].includes(profile))fail('このAVCプロファイルには対応していません。');
  if(id>31||bits.ue()>12)fail('AVCの設定が範囲外です。');
  const order=bits.ue();
  if(order===0){if(bits.ue()>12)fail('AVCの時刻設定が範囲外です。');}
  else if(order===1){bits.read(1);bits.se();bits.se();const count=bits.ue();if(count>255)fail('AVCの時刻設定が大きすぎます。');for(let i=0;i<count;i++)bits.se();}
  else if(order!==2)fail('AVCの時刻設定に未対応です。');
  bits.ue();bits.read(1);const widthUnits=bits.ue()+1,heightUnits=bits.ue()+1;
  if(!bits.read(1))fail('インターレースAVCのTS変換には未対応です。');
  bits.read(1);let left=0,right=0,top=0,bottom=0;
  if(bits.read(1)){left=bits.ue();right=bits.ue();top=bits.ue();bottom=bits.ue();}
  const width=widthUnits*16-(left+right)*2,height=heightUnits*16-(top+bottom)*2;
  if(width<1||height<1||width>16384||height>16384)fail('AVCの画面サイズが範囲外です。');
  let frameTicks;
  if(bits.read(1)) {
    if(bits.read(1)){const ratio=bits.read(8);if(ratio===255){bits.read(16);bits.read(16);}}
    if(bits.read(1))bits.read(1);
    if(bits.read(1)){bits.read(3);bits.read(1);if(bits.read(1)){bits.read(8);bits.read(8);bits.read(8);}}
    if(bits.read(1)){bits.ue();bits.ue();}
    if(bits.read(1)){const tick=bits.read(32),scale=bits.read(32);bits.read(1);if(tick&&scale)frameTicks=180000*tick/scale;}
  }
  return {id,profile,compatibility,level,chroma,width,height,frameTicks};
}
function ppsInfo(nal) {const bits=new Bits(rbsp(nal.subarray(1))),id=bits.ue(),sps=bits.ue();bits.read(1);bits.read(1);if(id>255||sps>31||bits.ue()!==0)fail('複数スライスグループ等のAVC設定には未対応です。');return {id,sps};}
function annexB(bytes) {
  const starts=[];
  for(let i=2;i<bytes.length;i++)if(bytes[i]===1&&bytes[i-1]===0&&bytes[i-2]===0){if(starts.length>=16384)fail('1つのPES内のNALが多すぎます。');starts.push({prefix:i>=3&&bytes[i-3]===0 ? i-3 : i-2,data:i+1});i++;}
  if(!starts.length||bytes.subarray(0,starts[0].prefix).some(value=>value!==0))fail('AVCのAnnex Bデータを確認できません。');
  const result=[];
  for(let i=0;i<starts.length;i++){let end=i+1<starts.length ? starts[i+1].prefix : bytes.length;while(end>starts[i].data&&bytes[end-1]===0)end--;if(end<=starts[i].data)fail('空のAVC NALがあります。');result.push(bytes.subarray(starts[i].data,end));}
  return result;
}
function timestamp(bytes,at,prefix) {
  if(at+5>bytes.length||bytes[at]>>4!==prefix||!(bytes[at]&1)||!(bytes[at+2]&1)||!(bytes[at+4]&1))fail('PESのタイムスタンプが不正です。');
  return (bytes[at]&14)*536870912+bytes[at+1]*4194304+(bytes[at+2]&254)*16384+bytes[at+3]*128+(bytes[at+4]>>1);
}
function nearestClock(value,reference) {if(reference===undefined)return value;return value+Math.round((reference-value)/CLOCK_WRAP)*CLOCK_WRAP;}
function demux(bytes,maxBytes) {
  let pmtPID,program,configuration,anchor,videoBytes=0,pesCount=0;
  const psi=new Map(),pending=new Map(),continuity=new Map(),lastClock=new Map();
  const video={type:'video',timescale:90000,samples:[]},audio={type:'audio',samples:[]};
  const section=raw=>{
    if(raw.length<12||!crcOK(raw)||!(raw[1]&128)||raw[6]!==0||raw[7]!==0)fail('PAT/PMTのCRCまたは構造が不正です。');
    if(!(raw[5]&1))return;
    const end=raw.length-4;
    if(raw[0]===0) {
      if((end-8)%4)fail('PATの長さが不正です。');const entries=[];
      for(let at=8;at<end;at+=4){const id=raw[at]*256+raw[at+1];if(id)entries.push({id,pid:((raw[at+2]&31)<<8)|raw[at+3]});}
      if(entries.length!==1||entries[0].pid<32||entries[0].pid===8191)fail('単一番組以外のTSには対応していません。');
      if(program!==undefined&&(program!==entries[0].id||pmtPID!==entries[0].pid))fail('途中で番組が変わるTSには対応していません。');
      program=entries[0].id;pmtPID=entries[0].pid;
    } else if(raw[0]===2) {
      if(raw[3]*256+raw[4]!==program||raw.length<16)fail('PMTの番組情報が一致しません。');
      const info=((raw[10]&15)<<8)|raw[11];if(12+info>end)fail('PMTの設定長が不正です。');descriptors(raw,12,12+info);
      const streams=[];
      for(let at=12+info;at<end;){if(end-at<5)fail('PMTが途中で終わっています。');const type=raw[at],pid=((raw[at+1]&31)<<8)|raw[at+2],length=((raw[at+3]&15)<<8)|raw[at+4];if(at+5+length>end||pid<32||pid===8191)fail('PMTのトラック指定が不正です。');descriptors(raw,at+5,at+5+length);if(![0x1b,0x0f].includes(type))fail('H.264とAAC ADTS以外のTSには対応していません。');streams.push({type,pid});at+=5+length;}
      if(streams.filter(stream=>stream.type===0x1b).length!==1||streams.filter(stream=>stream.type===0x0f).length>1||new Set(streams.map(stream=>stream.pid)).size!==streams.length)fail('映像・音声を各1本含むTSだけに対応しています。');
      const next=JSON.stringify(streams.sort((a,b)=>a.type-b.type));if(configuration&&configuration!==next)fail('途中でトラックが変わるTSには対応していません。');configuration=next;
      video.pid=streams.find(stream=>stream.type===0x1b).pid;audio.pid=streams.find(stream=>stream.type===0x0f)?.pid;
    } else fail('未対応の番組テーブルです。');
  };
  const feedPSI=(pid,payload,start)=>{
    let previous=psi.get(pid)||new Uint8Array();
    const append=data=>{
      previous=join([previous,data]);
      while(previous.length&&previous[0]!==255){if(previous.length<3)break;const length=3+((previous[1]&15)<<8)+previous[2];if(length<12||length>1024)fail('PAT/PMTのサイズが不正です。');if(previous.length<length)break;section(previous.subarray(0,length));previous=previous.subarray(length);}
      if(previous[0]===255){if(previous.some(value=>value!==255))fail('番組テーブルの詰め物が不正です。');previous=new Uint8Array();}
      if(previous.length>1024)fail('番組テーブルが大きすぎます。');
    };
    if(start){if(!payload.length||payload[0]+1>payload.length)fail('番組テーブルの開始位置が不正です。');const pointer=payload[0];if(previous.length)append(payload.subarray(1,1+pointer));if(previous.length)fail('番組テーブルが途中で切れています。');append(payload.subarray(1+pointer));}
    else {if(!previous.length)fail('番組テーブルの先頭がありません。');append(payload);}
    psi.set(pid,previous);
  };
  const videoPES=(es,pts,dts)=>{
    if(pts===undefined||dts===undefined)fail('映像のタイムスタンプがありません。');
    const nals=annexB(es),parts=[];let slices=0,starts=0,aud=0,key=false;
    for(const nal of nals) {
      if(nal[0]&128)fail('AVC NALヘッダーが不正です。');const type=nal[0]&31;
      if(type===7||type===8){if(nal.length>65535)fail('AVCの初期化データが大きすぎます。');const name=type===7 ? 'sps' : 'pps';if(video[name]&&!same(video[name],nal))fail('途中でAVC設定が変わるTSには未対応です。');video[name]=nal.slice();if(type===7)video.info=spsInfo(nal);else video.ppsInfo=ppsInfo(nal);continue;}
      if(type===9){aud++;continue;}if(type===10||type===11)continue;
      if(type===1||type===5){const bits=new Bits(rbsp(nal.subarray(1),63));const first=bits.ue(),slice=bits.ue(),pps=bits.ue();if(slice>9||!video.ppsInfo||pps!==video.ppsInfo.id)fail('AVCスライスの設定が不明です。');if(first===0)starts++;if((slices>0&&key!==(type===5)))fail('複数のAVC画像が1つのPESに入っています。');key=type===5;slices++;}
      else if(type!==6&&type!==12)fail('未対応のAVC NAL構成です。');
      parts.push(u32(nal.length),nal);
    }
    if(!slices)return;
    if(aud>1||starts!==1||!video.sps||!video.pps||video.ppsInfo.sps!==video.info.id)fail('1つのPESに1画像を含むAVCだけに対応しています。');
    if(!video.samples.length&&!key)fail('先頭がIDR画像ではないため、安全にMP4へ変換できません。');
    if(video.samples.length&&dts<=video.samples.at(-1).dts)fail('映像の時刻が重複・逆行しています。');
    const sample=join(parts);videoBytes+=sample.length;if(videoBytes>maxBytes||video.samples.length>=SAMPLE_LIMIT)fail('映像データの上限を超えています。');
    video.samples.push({data:sample,pts,dts,key});
  };
  const audioPES=(es,pts,dts)=>{
    if(pts!==undefined&&dts!==undefined&&pts!==dts)fail('AACの時刻構成が未対応です。');
    if(!audio.samples.length){if(pts===undefined)fail('音声の開始時刻がありません。');audio.start=pts;}
    else if(pts!==undefined&&Math.abs(pts-(audio.start+audio.samples.length*1024*90000/audio.timescale))>2)fail('音声の時刻に欠損・重複があります。');
    for(let at=0;at<es.length;) {
      if(es.length-at<7||es[at]!==255||(es[at+1]&246)!==240)fail('AAC ADTSのヘッダーが不正です。');
      const profile=(es[at+2]>>6)+1,index=(es[at+2]>>2)&15,channels=((es[at+2]&1)<<2)|(es[at+3]>>6),rate=rates[index];
      const length=((es[at+3]&3)<<11)|(es[at+4]<<3)|(es[at+5]>>5),header=es[at+1]&1 ? 7 : 9;
      if(profile!==2||!rate||rate>65535||!channels||(es[at+6]&3)!==0)fail('このAACプロファイル・複数ブロック・チャンネル構成には未対応です。');
      if(length<=header||at+length>es.length)fail('AACフレームがPESの途中で切れています。');
      if(audio.timescale&&(audio.timescale!==rate||audio.channels!==channels))fail('途中でAAC設定が変わるTSには未対応です。');
      audio.timescale=rate;audio.channels=channels;audio.index=index;
      if(audio.samples.length>=SAMPLE_LIMIT)fail('音声サンプル数の上限を超えています。');
      audio.samples.push({data:es.subarray(at+header,at+length),duration:1024});at+=length;
    }
  };
  const flush=pid=>{
    const state=pending.get(pid);if(!state)return;pending.delete(pid);if(++pesCount>250000)fail('PESの件数が多すぎます。');
    const pes=join(state.parts);if(pes.length<9||pes[0]!==0||pes[1]!==0||pes[2]!==1||(pes[6]&192)!==128)fail('PESヘッダーが不正です。');
    const isVideo=pid===video.pid;if(isVideo ? (pes[3]&240)!==224 : (pes[3]&224)!==192)fail('PESの映像・音声種別が一致しません。');
    if(pes[6]&48)fail('暗号化されたPESは変換できません。');
    const declared=pes[4]*256+pes[5],end=declared ? declared+6 : pes.length,start=9+pes[8],flags=pes[7]>>6;
    if(!declared&&!isVideo||end>pes.length||start>end||pes.subarray(end).some(value=>value!==255)||flags===1)fail('PESの長さや時刻構造が不正です。');
    let pts,dts;
    if(flags>=2){if(pes[8]<(flags===3 ? 10 : 5))fail('PESの時刻ヘッダーが短すぎます。');const rawPTS=timestamp(pes,9,flags===3 ? 3 : 2),rawDTS=flags===3 ? timestamp(pes,14,1) : rawPTS;dts=nearestClock(rawDTS,lastClock.get(pid)??anchor);pts=nearestClock(rawPTS,dts);anchor??=dts;lastClock.set(pid,dts);}
    (isVideo ? videoPES : audioPES)(pes.subarray(start,end),pts,dts);
  };
  for(let at=0;at<bytes.length;at+=188) {
    const packet=bytes.subarray(at,at+188);
    if(packet[0]!==71||(packet[1]&128))fail('TSパケットが破損しています。');
    if(packet[3]&192)fail('スクランブル・暗号化されたTSは変換できません。');
    const pid=((packet[1]&31)<<8)|packet[2],start=Boolean(packet[1]&64),control=(packet[3]>>4)&3,cc=packet[3]&15;
    if(!control)fail('TSパケットの制御値が不正です。');let offset=4,discontinuity=false;
    if(control&2){const length=packet[4];if(length>183||5+length>188)fail('TSの補助データが範囲外です。');if(length)discontinuity=Boolean(packet[5]&128);offset=5+length;}
    if(!(control&1)||offset===188)continue;
    if(pid===8191)continue;
    const old=continuity.get(pid);
    if(old&&discontinuity)fail('途中で不連続になるTSは変換できません。');
    if(old&&cc===old.cc){if(same(packet,old.packet))continue;fail('TSパケット番号が重複しています。');}
    if(old&&cc!==((old.cc+1)&15))fail('TSパケットが欠落しています。');continuity.set(pid,{cc,packet});
    const payload=packet.subarray(offset);
    if(pid===0||pid===pmtPID)feedPSI(pid,payload,start);
    else if(configuration&&(pid===video.pid||pid===audio.pid)) {
      if(start){flush(pid);pending.set(pid,{parts:[],size:0});}
      const state=pending.get(pid);if(!state)fail('PESの先頭パケットがありません。');state.size+=payload.length;if(state.size>PES_LIMIT)fail('1つのPESが大きすぎます（最大16 MiB）。');state.parts.push(payload);
    }
  }
  for(const pid of pending.keys())flush(pid);
  if(!configuration||[...psi.values()].some(value=>value.length)||!video.samples.length)fail('番組情報または映像が揃っていません。');
  if(audio.pid!==undefined&&!audio.samples.length)fail('PMTで宣言された音声がありません。音声を欠落させずに変換できません。');
  return audio.pid===undefined ? [video] : [video,audio];
}
function runTable(values,signedValues=false) {
  const runs=[];for(const value of values){if(signedValues)signed(value);else uint(value);const last=runs.at(-1);if(last&&last[1]===value)last[0]++;else runs.push([1,value]);}
  return words([runs.length,...runs.flat()]);
}
function descriptor(tag,bytes) {const sizes=[bytes.length&127];for(let size=bytes.length>>7;size;size>>=7)sizes.unshift((size&127)|128);return join([new Uint8Array([tag,...sizes]),bytes]);}
function sampleEntry(track,id) {
  if(track.type==='video') {
    const info=track.info,header=new Uint8Array(78);dv(header).setUint16(6,1);dv(header).setUint16(24,info.width);dv(header).setUint16(26,info.height);dv(header).setUint32(28,4718592);dv(header).setUint32(32,4718592);dv(header).setUint16(40,1);dv(header).setUint16(74,24);dv(header).setUint16(76,65535);
    const config=[new Uint8Array([1,info.profile,info.compatibility,info.level,255,225]),u16(track.sps.length),track.sps,new Uint8Array([1]),u16(track.pps.length),track.pps];
    if([100,110,122,144].includes(info.profile))config.push(new Uint8Array([252|info.chroma,248,248,0]));
    return box('avc1',header,box('avcC',...config));
  }
  const header=new Uint8Array(28);dv(header).setUint16(6,1);dv(header).setUint16(16,track.channels===7 ? 8 : track.channels);dv(header).setUint16(18,16);dv(header).setUint32(24,track.timescale*65536);
  const config=u16((2<<11)|(track.index<<7)|(track.channels<<3));
  const decoder=descriptor(4,join([new Uint8Array([64,21,0,0,0]),u32(0,0),descriptor(5,config)]));
  return box('mp4a',header,full('esds',descriptor(3,join([u16(id),new Uint8Array([0]),decoder,descriptor(6,new Uint8Array([2]))]))));
}
function trackBox(track,id,origin,chunkOffset) {
  const video=track.type==='video',samples=track.samples;
  const decodeStart=video ? samples[0].dts : track.start;
  const mediaDuration=samples.reduce((sum,sample)=>sum+sample.duration,0),end=track.presentationEnd;
  // Anchor the active edit at the first actual presentation sample. An empty
  // edit retains the inter-track delay, including AAC encoder priming.
  const delay=uint(track.presentationStart-origin),mediaTime=video ? track.presentationStart-decodeStart : 0;
  if(mediaTime<0)fail('先頭画像がデコード時刻より前のTSには未対応です。');
  const duration=uint(Math.round(end-origin)),active=uint(duration-delay),edits=[];
  if(delay)edits.push(u32(uint(delay),-1),u16(1,0));edits.push(u32(active,signed(mediaTime)),u16(1,0));
  const tkhd=full('tkhd',join([u32(0,0,id,0,duration),new Uint8Array(8),u16(0,0,video ? 0 : 256,0),matrix,u32(video ? track.info.width*65536 : 0,video ? track.info.height*65536 : 0)]),7);
  const mdhd=full('mdhd',join([u32(0,0,track.timescale,uint(mediaDuration)),u16(21956,0)]));
  const hdlr=full('hdlr',join([u32(0),ascii(video ? 'vide' : 'soun'),new Uint8Array(12),ascii(video ? 'Video\0' : 'Audio\0')]));
  const sampleSizes=new Uint8Array(samples.length*4);samples.forEach((sample,i)=>dv(sampleSizes).setUint32(i*4,sample.data.length));
  const tables=[full('stsd',join([u32(1),sampleEntry(track,id)])),full('stts',runTable(samples.map(sample=>sample.duration))),full('stsc',u32(1,1,samples.length,1)),full('stsz',join([u32(0,samples.length),sampleSizes])),full('stco',u32(1,uint(chunkOffset)))];
  if(video){const offsets=samples.map(sample=>sample.pts-sample.dts);if(offsets.some(Boolean))tables.push(full('ctts',runTable(offsets,true),0,1));const sync=samples.flatMap((sample,i)=>sample.key ? [i+1] : []);tables.push(full('stss',words([sync.length,...sync])));}
  const dinf=box('dinf',full('dref',join([u32(1),full('url ',new Uint8Array(),1)])));
  const minf=box('minf',video ? full('vmhd',new Uint8Array(8),1) : full('smhd',new Uint8Array(4)),dinf,box('stbl',...tables));
  return box('trak',tkhd,box('edts',full('elst',join([u32(edits.length/2),...edits]))),box('mdia',mdhd,hdlr,minf));
}
export function remuxTSToMP4(bytes,{maxBytes=LIMIT}={}) {
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length%188||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>LIMIT||bytes.length>maxBytes)fail('入力サイズが不正か容量上限を超えています。');
  const tracks=demux(bytes,maxBytes),video=tracks[0],samples=video.samples;
  for(let i=0;i<samples.length;i++){const duration=i+1<samples.length ? samples[i+1].dts-samples[i].dts : Math.round(video.info.frameTicks || (i ? samples[i].dts-samples[i-1].dts : 0));if(!duration)fail('映像のフレーム時間を確定できません。');samples[i].duration=uint(duration);}
  video.presentationStart=samples.reduce((start,sample)=>Math.min(start,sample.pts),Infinity);
  let origin=video.presentationStart;
  video.presentationEnd=samples.reduce((end,sample)=>Math.max(end,sample.pts+sample.duration),-Infinity);
  if(tracks[1]){const audio=tracks[1];audio.presentationStart=audio.start;origin=Math.min(origin,audio.start);audio.presentationEnd=audio.start+audio.samples.length*1024*90000/audio.timescale;}
  const duration=uint(Math.round(Math.max(...tracks.map(track=>track.presentationEnd))-origin));
  const mvhd=full('mvhd',join([u32(0,0,90000,duration,65536),u16(256,0),new Uint8Array(8),matrix,new Uint8Array(24),u32(tracks.length+1)]));
  const ftyp=box('ftyp',ascii('isom'),u32(512),ascii('isomiso2avc1mp41'));
  let moov=box('moov',mvhd,...tracks.map((track,i)=>trackBox(track,i+1,origin,0))),at=ftyp.length+moov.length+8;
  const chunks=[];moov=box('moov',mvhd,...tracks.map((track,i)=>{const start=at;for(const sample of track.samples){chunks.push(sample.data);at+=sample.data.length;}return trackBox(track,i+1,origin,start);}));
  if(at>maxBytes)fail('出力MP4が容量上限を超えます。');
  return new Blob([ftyp,moov,u32(at-ftyp.length-moov.length),ascii('mdat'),...chunks],{type:'video/mp4'});
}
