// Local, bounded remuxing of clear single-track fragmented MP4 streams.
// Sample bytes and each track's media clock are preserved. No decoder or
// transcoder is used. Offsets must be relative to their own moof (ISO BMFF/MSE).
const LIMIT = 268435456;
const fail = message => { throw new Error(`MP4を結合できません。${message}`); };
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const typeAt = (bytes, at) => String.fromCharCode(...bytes.subarray(at, at + 4));
const ENCRYPTED = new Set(['encv','enca','sinf','schi','schm','tenc','pssh','senc','saiz','saio','uuid']);
const PADDING = new Set(['free','skip']);

function boxes(bytes, start = 0, end = bytes.length, budget) {
  const result = [], data = view(bytes);
  for (let at = start; at < end;) {
    if (++budget.boxes > 250000 || end - at < 8) fail('ボックス数が多すぎるか、データが途中で終わっています。');
    let size = data.getUint32(at), header = 8;
    const type = typeAt(bytes, at + 4);
    if (ENCRYPTED.has(type)) fail('暗号化・保護されたMP4には対応していません。');
    if (size === 0) fail('終端が省略されたボックスには対応していません。');
    if (size === 1) {
      if (end - at < 16) fail('拡張ボックスのサイズが不正です。');
      const large = data.getBigUint64(at + 8);
      if (large > BigInt(end - at)) fail('ボックスのサイズが範囲外です。');
      size = Number(large); header = 16;
    }
    if (size < header || size > end - at) fail('ボックスのサイズが範囲外です。');
    result.push({type, start:at, end:at+size, data:at+header, header, size}); at += size;
  }
  return result;
}
function children(bytes, box, budget, extra = 0) { return boxes(bytes, box.data + extra, box.end, budget); }
function one(list, type) { const found = list.filter(box => box.type === type); if (found.length !== 1) fail(`${type}ボックスは1つ必要です。`); return found[0]; }
function allowed(list, names) { for (const box of list) if (!names.includes(box.type)) fail(`未対応の構成（${box.type}）です。`); }
function full(bytes, box, versions = [0], flags = 0) {
  if (box.end - box.data < 4 || !versions.includes(bytes[box.data])) fail(`${box.type}のバージョンが未対応です。`);
  const value = view(bytes).getUint32(box.data) & 0xffffff;
  if (flags !== null && value !== flags) fail(`${box.type}のフラグが未対応です。`);
  return {version:bytes[box.data],flags:value};
}
function exact(box, payload) { if (box.end - box.data !== payload) fail(`${box.type}のデータ長が不正です。`); }
function copy(bytes, box) { return bytes.slice(box.start, box.end); }
function box(type, parts) {
  const size = 8 + parts.reduce((n, part) => n + part.byteLength, 0), result = new Uint8Array(size);
  view(result).setUint32(0, size); result.set([...type].map(char => char.charCodeAt(0)), 4);
  let at = 8; for (const part of parts) { result.set(part, at); at += part.length; } return result;
}
function movieHeader(bytes, mvhd) {
  const {version} = full(bytes, mvhd, [0,1]); exact(mvhd, version ? 112 : 100);
  const timescale = view(bytes).getUint32(mvhd.data + (version ? 20 : 12));
  if (!timescale) fail('movieの時刻単位が0です。');
  return {version, timescale, durationOffset:mvhd.data + (version ? 24 : 16)};
}
function mediaHeader(bytes, mdhd) {
  const {version} = full(bytes, mdhd, [0,1]); exact(mdhd, version ? 36 : 24);
  const timescale = view(bytes).getUint32(mdhd.data + (version ? 20 : 12));
  if (!timescale) fail('トラックの時刻単位が0です。');
  return timescale;
}
function uintDuration(bytes, at, version) { return version ? view(bytes).getBigUint64(at) : BigInt(view(bytes).getUint32(at)); }
function setDuration(bytes, at, version, value) {
  if (value < 0n || value > (version ? 0xffffffffffffffffn : 0xffffffffn)) fail('時間が対応範囲を超えています。');
  if (version) view(bytes).setBigUint64(at,value); else view(bytes).setUint32(at,Number(value));
}
function scale(value, from, to) { return (value * BigInt(to) + BigInt(from) / 2n) / BigInt(from); }
function rescaleEdits(bytes, edts, from, to, budget) {
  const list = children(bytes,edts,budget); allowed(list,['elst']);
  const elst = one(list,'elst'), {version} = full(bytes,elst,[0,1]);
  if (elst.end - elst.data < 8) fail('編集情報が途中で終わっています。');
  const count = view(bytes).getUint32(elst.data+4), width = version ? 20 : 12;
  if (count > 16 || elst.end - elst.data !== 8 + count * width) fail('編集情報の構成が未対応です。');
  const result = copy(bytes,edts), edits = [];
  for (let i=0;i<count;i++) {
    const at=elst.data+8+i*width, mediaAt=at+(version ? 8 : 4);
    const mediaTime=version ? view(bytes).getBigInt64(mediaAt) : BigInt(view(bytes).getInt32(mediaAt));
    const duration=uintDuration(bytes,at,version);
    if (mediaTime < -1n || view(bytes).getInt16(mediaAt+(version ? 8 : 4)) !== 1 || view(bytes).getInt16(mediaAt+(version ? 10 : 6)) !== 0) fail('等速再生以外の編集情報には対応していません。');
    const converted=scale(duration,from,to);
    setDuration(result,at-edts.start,version,converted);
    edits.push({duration:converted,mediaTime});
  }
  return {bytes:result,edits};
}
function descriptor(bytes, at, end) {
  if (at >= end) fail('AACの設定が途中で終わっています。');
  const tag=bytes[at++];let size=0,done=false;
  for(let i=0;i<4;i++) { if(at>=end)fail('AACの設定長が不正です。');const b=bytes[at++];size=size*128+(b&127);if(!(b&128)){done=true;break;} }
  if(!done || size>end-at)fail('AACの設定長が範囲外です。');
  return {tag,start:at,end:at+size,next:at+size};
}
function aacConfig(bytes, esds) {
  full(bytes,esds);const es=descriptor(bytes,esds.data+4,esds.end);
  if(es.tag!==3 || es.next!==esds.end || es.end-es.start<3)fail('AACの初期化情報が未対応です。');
  let at=es.start+3;const flags=bytes[es.start+2];
  if(flags&128)at+=2;
  if(flags&64){if(at>=es.end)fail('AACの設定が不正です。');at+=1+bytes[at];}
  if(flags&32)at+=2;
  const decoder=descriptor(bytes,at,es.end);
  if(decoder.tag!==4 || decoder.end-decoder.start<13 || bytes[decoder.start]!==0x40 || bytes[decoder.start+1]>>2!==5)fail('AAC以外のmp4aには対応していません。');
  const config=descriptor(bytes,decoder.start+13,decoder.end);
  if(config.tag!==5 || config.end-config.start<2 || ![2,5,29].includes(bytes[config.start]>>3))fail('このAACプロファイルには対応していません。');
}
function sampleDescription(bytes, stsd, type, budget) {
  full(bytes,stsd);
  if(stsd.end-stsd.data<8 || view(bytes).getUint32(stsd.data+4)!==1)fail('サンプル形式は1種類だけ対応しています。');
  const entries=children(bytes,stsd,budget,8);
  if(entries.length!==1)fail('サンプル形式の構成が不正です。');
  const sample=entries[0], video={avc1:'avcC',avc3:'avcC',hvc1:'hvcC',hev1:'hvcC',av01:'av1C',vp09:'vpcC'}, audio={mp4a:'esds',Opus:'dOps','ac-3':'dac3','ec-3':'dec3'};
  const config=(type==='video' ? video : audio)[sample.type];
  if(!config)fail(`未対応のコーデック（${sample.type}）です。`);
  const header=type==='video' ? 78 : 28;
  if(sample.end-sample.data<header || view(bytes).getUint16(sample.data+6)!==1)fail('サンプルの参照先が不正です。');
  if(type==='audio' && view(bytes).getUint16(sample.data+8)!==0)fail('QuickTime固有の音声構成には対応していません。');
  const configs=children(bytes,sample,budget,header);
  allowed(configs,[config,'btrt','pasp','colr','clap','fiel','mdcv','clli','chan']);
  const configuration=one(configs,config);
  if(configuration.end-configuration.data<1)fail('コーデック設定が空です。');
  if(config==='esds')aacConfig(bytes,configuration);
  if(config==='avcC' && (configuration.end-configuration.data<7 || bytes[configuration.data]!==1))fail('AVCの設定が不正です。');
  if(config==='hvcC' && (configuration.end-configuration.data<23 || bytes[configuration.data]!==1))fail('HEVCの設定が不正です。');
  if(config==='av1C' && (configuration.end-configuration.data<4 || bytes[configuration.data]!==0x81))fail('AV1の設定が不正です。');
  if(config==='vpcC' && configuration.end-configuration.data<12)fail('VP9の設定が不正です。');
  if(config==='dOps' && (configuration.end-configuration.data<11 || bytes[configuration.data]!==0))fail('Opusの設定が未対応です。');
  if(config==='dac3' && configuration.end-configuration.data!==3)fail('AC-3の設定が不正です。');
  if(config==='dec3' && configuration.end-configuration.data<5)fail('E-AC-3の設定が不正です。');
}
function sampleTable(bytes, stbl, type, budget) {
  const list=children(bytes,stbl,budget);
  allowed(list,['stsd','stts','stsc','stsz','stco','co64','stss','ctts']);
  sampleDescription(bytes,one(list,'stsd'),type,budget);
  for(const entry of list.filter(box=>box.type!=='stsd')) {
    full(bytes,entry,entry.type==='ctts' ? [0,1] : [0]);
    exact(entry,entry.type==='stsz' ? 12 : 8);
    if(view(bytes).getUint32(entry.data+(entry.type==='stsz' ? 8 : 4))!==0)fail('初期化データに通常MP4のサンプルが含まれています。');
  }
  for(const type of ['stts','stsc','stsz'])one(list,type);
  if(list.filter(box=>box.type==='stco'||box.type==='co64').length!==1)fail('サンプル位置の構成が不正です。');
}
function references(bytes, dinf, budget) {
  const list=children(bytes,dinf,budget);allowed(list,['dref']);
  const dref=one(list,'dref');full(bytes,dref);
  if(dref.end-dref.data<8 || view(bytes).getUint32(dref.data+4)!==1)fail('外部データ参照には対応していません。');
  const entries=children(bytes,dref,budget,8),url=one(entries,'url ');
  if(entries.length!==1)fail('外部データ参照には対応していません。');
  full(bytes,url,[0],1);exact(url,4);
}
function trackInit(track,id,budget) {
  const bytes=track.init,top=boxes(bytes,0,bytes.length,budget);
  allowed(top,['ftyp','moov','free','skip','sidx']);
  const ftyp=one(top,'ftyp'),moov=one(top,'moov');
  if(ftyp.end-ftyp.data<8 || (ftyp.end-ftyp.data)%4)fail('ファイル形式情報が不正です。');
  const list=children(bytes,moov,budget);allowed(list,['mvhd','trak','mvex','udta','meta','free','skip']);
  const mvhd=one(list,'mvhd'),movie=movieHeader(bytes,mvhd),trak=one(list,'trak'),trakChildren=children(bytes,trak,budget);
  allowed(trakChildren,['tkhd','mdia','edts','udta','meta','free','skip']);
  const tkhd=one(trakChildren,'tkhd'),tk=full(bytes,tkhd,[0,1],null);exact(tkhd,tk.version ? 96 : 84);
  if(tk.flags&~15)fail('トラックヘッダーのフラグが未対応です。');
  const idOffset=tkhd.data+(tk.version ? 20 : 12),oldID=view(bytes).getUint32(idOffset);
  if(!oldID)fail('トラックIDは0にできません。');
  const mdia=one(trakChildren,'mdia'),media=children(bytes,mdia,budget);allowed(media,['mdhd','hdlr','minf','elng']);
  const timescale=mediaHeader(bytes,one(media,'mdhd')),hdlr=one(media,'hdlr');full(bytes,hdlr);
  if(hdlr.end-hdlr.data<24 || typeAt(bytes,hdlr.data+8)!==(track.type==='video' ? 'vide' : 'soun'))fail('指定された映像・音声の種類とトラックが一致しません。');
  const minf=children(bytes,one(media,'minf'),budget);allowed(minf,['vmhd','smhd','dinf','stbl','free','skip']);
  one(minf,track.type==='video' ? 'vmhd' : 'smhd');references(bytes,one(minf,'dinf'),budget);sampleTable(bytes,one(minf,'stbl'),track.type,budget);
  const mvex=children(bytes,one(list,'mvex'),budget);allowed(mvex,['trex','mehd']);
  const trex=one(mvex,'trex');full(bytes,trex);exact(trex,24);
  if(view(bytes).getUint32(trex.data+4)!==oldID || view(bytes).getUint32(trex.data+8)!==1)fail('トラックと既定サンプルのIDが一致しません。');
  const trexBytes=copy(bytes,trex);view(trexBytes).setUint32(trex.data-trex.start+4,id);
  return {track,bytes,ftyp,mvhd,movie,trak,trakChildren,tkhd,tk,idOffset,oldID,id,timescale,trexBytes,
    defaultDuration:view(bytes).getUint32(trex.data+12),defaultSize:view(bytes).getUint32(trex.data+16),end:0n,presentationEnd:0n,fragments:[]};
}
function tfhdInfo(bytes,tfhd,track) {
  const {flags}=full(bytes,tfhd,[0],null);
  if((flags&~0x02003a)!==0 || !(flags&0x020000))fail('絶対位置や暗黙の位置を使うfragmentには対応していません。');
  if(tfhd.end-tfhd.data<8 || view(bytes).getUint32(tfhd.data+4)!==track.oldID)fail('fragmentのトラックIDが初期化情報と一致しません。');
  let at=tfhd.data+8,duration=track.defaultDuration,size=track.defaultSize;
  const read=()=>{if(tfhd.end-at<4)fail('fragmentの既定値が途中で終わっています。');const n=view(bytes).getUint32(at);at+=4;return n;};
  if(flags&2 && read()!==1)fail('fragment内のサンプル形式の切り替えには対応していません。');
  if(flags&8)duration=read();if(flags&16)size=read();if(flags&32)read();
  if(at!==tfhd.end)fail('fragmentヘッダーの長さが不正です。');
  return {duration,size,idAt:tfhd.data+4};
}
function fragment(bytes,moof,mdats,track,budget) {
  const list=children(bytes,moof,budget);allowed(list,['mfhd','traf']);
  const mfhd=one(list,'mfhd');full(bytes,mfhd);exact(mfhd,8);
  const traf=children(bytes,one(list,'traf'),budget);allowed(traf,['tfhd','tfdt','trun','sdtp']);
  const tfhd=one(traf,'tfhd'),defaults=tfhdInfo(bytes,tfhd,track),tfdt=one(traf,'tfdt'),dt=full(bytes,tfdt,[0,1]);exact(tfdt,dt.version ? 12 : 8);
  const time=dt.version ? view(bytes).getBigUint64(tfdt.data+4) : BigInt(view(bytes).getUint32(tfdt.data+4));
  if(time<track.end)fail('トラック内のfragmentが時間的に重複・逆行しています。');
  const runs=traf.filter(box=>box.type==='trun');if(!runs.length)fail('fragmentにサンプルがありません。');
  const ranges=[];let nextOffset,duration=0n,totalSamples=0;
  for(const run of runs) {
    const {flags,version}=full(bytes,run,[0,1],null);if(flags&~0xf05)fail('サンプル区間のフラグが未対応です。');
    if((flags&4)&&(flags&0x400))fail('サンプルフラグの構成が不正です。');
    if(run.end-run.data<8)fail('サンプル区間が途中で終わっています。');
    const count=view(bytes).getUint32(run.data+4);totalSamples+=count;budget.samples+=count;
    if(!count || count>1000000 || budget.samples>4000000)fail('サンプル数が空か上限を超えています。');
    let at=run.data+8,offset=nextOffset;
    if(flags&1){if(run.end-at<4)fail('サンプル位置が不正です。');offset=moof.start+view(bytes).getInt32(at);at+=4;}
    if(offset===undefined)fail('最初のサンプル区間にはmoof相対位置が必要です。');
    if(flags&4)at+=4;
    const width=4*Number(Boolean(flags&0x100))+4*Number(Boolean(flags&0x200))+4*Number(Boolean(flags&0x400))+4*Number(Boolean(flags&0x800));
    if(run.end-at!==count*width)fail('サンプル区間のデータ長が不正です。');
    let length=0;
    for(let i=0;i<count;i++) {
      let sampleDuration=defaults.duration,sampleSize=defaults.size;
      if(flags&0x100){sampleDuration=view(bytes).getUint32(at);at+=4;}
      if(flags&0x200){sampleSize=view(bytes).getUint32(at);at+=4;}
      if(flags&0x400)at+=4;
      let compositionOffset=0n;
      if(flags&0x800){compositionOffset=BigInt(version ? view(bytes).getInt32(at) : view(bytes).getUint32(at));at+=4;}
      if(!sampleDuration || !sampleSize)fail('サンプルの長さ・時間が不明です。');
      const presentationEnd=time+duration+compositionOffset+BigInt(sampleDuration);
      if(presentationEnd>track.presentationEnd)track.presentationEnd=presentationEnd;
      duration+=BigInt(sampleDuration);length+=sampleSize;
    }
    const end=offset+length;
    if(!Number.isSafeInteger(end) || !mdats.some(mdat=>offset>=mdat.data && end<=mdat.end) || ranges.some(range=>offset<range.end&&end>range.start))fail('サンプル位置がmdatの範囲外か重複しています。');
    ranges.push({start:offset,end});nextOffset=end;
  }
  for(const sdtp of traf.filter(box=>box.type==='sdtp')){full(bytes,sdtp);exact(sdtp,4+totalSamples);}
  track.end=time+duration;
  const rewritten=copy(bytes,moof);view(rewritten).setUint32(defaults.idAt-moof.start,track.id);
  return {time,timescale:track.timescale,trackID:track.id,moof:rewritten,sequenceAt:mfhd.data+4-moof.start,
    tail:bytes.subarray(moof.end,mdats.at(-1).end)};
}
function trackFragments(track,budget) {
  for(const bytes of track.track.segments) {
    const top=boxes(bytes,0,bytes.length,budget);allowed(top,['styp','sidx','moof','mdat','free','skip','emsg','prft','mfra']);
    for(let i=0;i<top.length;i++) {
      const current=top[i];
      if(current.type==='mdat')fail('moofに属さないmdatがあります。');
      if(current.type!=='moof')continue;
      const mdats=[];let j=i+1;
      while(j<top.length && (top[j].type==='mdat'||PADDING.has(top[j].type))) {if(top[j].type==='mdat')mdats.push(top[j]);j++;}
      if(!mdats.length)fail('fragmentに対応するmdatがありません。');
      track.fragments.push(fragment(bytes,current,mdats,track,budget));i=j-1;
    }
  }
  if(!track.fragments.length)fail('動画区間がありません。');
}
function mergedTrack(track,movieTimescale,budget) {
  const bytes=track.bytes,parts=[];track.edits=[];
  for(const child of track.trakChildren) {
    if(child.type==='tkhd') {
      const patched=copy(bytes,child);view(patched).setUint32(track.idOffset-child.start,track.id);
      const at=child.data+(track.tk.version ? 28 : 20),duration=uintDuration(bytes,at,track.tk.version);
      setDuration(patched,at-child.start,track.tk.version,scale(duration,track.movie.timescale,movieTimescale));parts.push(patched);
    } else if(child.type==='edts') {
      const edits=rescaleEdits(bytes,child,track.movie.timescale,movieTimescale,budget);track.edits=edits.edits;parts.push(edits.bytes);
    } else parts.push(bytes.subarray(child.start,child.end));
  }
  return box('trak',parts);
}
function presentationDuration(track,movieTimescale) {
  if(!track.edits.length)return scale(track.presentationEnd,track.timescale,movieTimescale);
  let duration=0n;
  for(const edit of track.edits)duration+=edit.duration || (edit.mediaTime>=0n && track.presentationEnd>edit.mediaTime ? scale(track.presentationEnd-edit.mediaTime,track.timescale,movieTimescale) : 0n);
  return duration;
}
export function muxFragmentedMP4(tracks,{maxBytes=LIMIT}={}) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>LIMIT)fail('容量上限が不正です。');
  if(!Array.isArray(tracks)||tracks.length<1||tracks.length>2||new Set(tracks.map(track=>track?.type)).size!==tracks.length)fail('映像・音声をそれぞれ最大1本指定してください。');
  let inputSize=0,count=0;
  for(const track of tracks) {
    if(!['video','audio'].includes(track.type)||!(track.init instanceof Uint8Array)||!track.init.length||track.init.length>4194304||!Array.isArray(track.segments)||!track.segments.length)fail('トラックの指定が不正です。');
    inputSize+=track.init.length;
    for(const bytes of track.segments){if(!(bytes instanceof Uint8Array)||!bytes.length)fail('動画区間の指定が不正です。');inputSize+=bytes.length;count++;if(inputSize>maxBytes||count>10000)fail('保存容量・区間数の上限を超えています。');}
  }
  const budget={boxes:0,samples:0},parsed=tracks.map((track,i)=>trackInit(track,i+1,budget));
  for(const track of parsed)trackFragments(track,budget);
  const first=parsed[0],movieTimescale=first.movie.timescale,traks=parsed.map(track=>mergedTrack(track,movieTimescale,budget));
  const mvhd=copy(first.bytes,first.mvhd);let duration=0n;
  for(const track of parsed){const end=presentationDuration(track,movieTimescale);if(end>duration)duration=end;}
  setDuration(mvhd,first.movie.durationOffset-first.mvhd.start,first.movie.version,duration);view(mvhd).setUint32(mvhd.length-4,parsed.length+1);
  const moov=box('moov',[mvhd,...traks,box('mvex',parsed.map(track=>track.trexBytes))]);
  const parts=[copy(first.bytes,first.ftyp),moov],fragments=parsed.flatMap(track=>track.fragments);
  fragments.sort((a,b)=>{const difference=a.time*BigInt(b.timescale)-b.time*BigInt(a.timescale);return difference<0n ? -1 : difference>0n ? 1 : a.trackID-b.trackID;});
  for(let i=0;i<fragments.length;i++){const fragment=fragments[i];view(fragment.moof).setUint32(fragment.sequenceAt,i+1);parts.push(fragment.moof,fragment.tail);}
  if(parts.reduce((n,part)=>n+part.byteLength,0)>maxBytes)fail('保存容量の上限を超えています。');
  return new Blob(parts,{type:'video/mp4'});
}
