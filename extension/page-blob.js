// Runs in this extension's isolated world, in the frame that supplied the candidate.
export async function readPageBlob(url, offset = -1, token = '') {
  if (!url.startsWith('blob:') || !Number.isSafeInteger(offset) || offset < -2 || !/^[a-f0-9-]{36}$/.test(token)) throw new Error('動画データの指定が不正です。');
  const key=Symbol.for('VideoHarbor.blobSnapshot');
  let snapshot=globalThis[key];
  if(offset===-2) {
    if(snapshot?.token===token){clearTimeout(snapshot.timer);delete globalThis[key];}
    return {released:true};
  }
  if(offset===-1) {
    let blob;
    try {
      const response=await fetch(url);
      const maximum=268435456;
      if(Number(response.headers.get('content-length'))>maximum) {
        await response.body?.cancel();return {error:'ページ内動画の直接保存は256 MiBまでです。'};
      }
      if(!response.body) return {error:'ページ内動画のデータを取得できません。'};
      const reader=response.body.getReader(),parts=[];let bytes=0;
      try {
        while(true) {
          const {value,done}=await reader.read();if(done)break;
          bytes+=value.byteLength;
          if(bytes>maximum){await reader.cancel();return {error:'ページ内動画の直接保存は256 MiBまでです。'};}
          parts.push(value);
        }
      } finally {reader.releaseLock();}
      blob=new Blob(parts,{type:response.headers.get('content-type') || ''});
    }
    catch { return {error:'このblobは元ファイルとして取得できません。分割配信の候補を再スキャンするか、録画を試してください。'}; }
    if (blob.size > 268435456) return {error:'ページ内動画の直接保存は256 MiBまでです。'};
    if (!blob.size || !/^video\/(mp4|webm|ogg|quicktime|x-m4v)(?:;|$)/i.test(blob.type)) return {error:'ページ内データを対応する動画ファイルとして確認できません。録画を試してください。'};
    const signature=new Uint8Array(await blob.slice(0,16).arrayBuffer());
    const ascii=(from,to)=>String.fromCharCode(...signature.slice(from,to));
    const valid=/webm/i.test(blob.type) ? signature[0]===0x1a && signature[1]===0x45 && signature[2]===0xdf && signature[3]===0xa3 : /ogg/i.test(blob.type) ? ascii(0,4)==='OggS' : ['ftyp','moov','mdat','wide'].includes(ascii(4,8));
    if(!valid)return {error:'ページ内データを動画ファイルとして確認できません。録画を試してください。'};
    if(snapshot)clearTimeout(snapshot.timer);
    snapshot={url,token,blob};globalThis[key]=snapshot;
  }
  if(!snapshot || snapshot.token!==token || snapshot.url!==url)return {error:'ページ内動画の取得が期限切れです。もう一度保存してください。'};
  clearTimeout(snapshot.timer);
  snapshot.timer=setTimeout(()=>{if(globalThis[key]===snapshot)delete globalThis[key];},60000);
  const blob=snapshot.blob;
  const length=262144;
  return {size:blob.size,mime:blob.type,bytes:offset < 0 ? [] : Array.from(new Uint8Array(await blob.slice(offset,offset+length).arrayBuffer()))};
}
