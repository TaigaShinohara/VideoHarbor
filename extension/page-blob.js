// Runs in this extension's isolated world, in the frame that supplied the candidate.
export async function readPageBlob(url, offset = -1, token = '', expiresAt = Date.now() + 60000) {
  if (!url.startsWith('blob:') || !Number.isSafeInteger(offset) || offset < -2 || !/^[a-f0-9-]{36}$/.test(token)) throw new Error('動画データの指定が不正です。');
  const key=Symbol.for('VideoHarbor.blobSnapshot');
  const revisionKey=Symbol.for('VideoHarbor.blobRevision');
  let snapshot=globalThis[key];
  const cancelledKey=Symbol.for('VideoHarbor.blobCancelled');
  const cancelled=globalThis[cancelledKey] ||= new Map();
  for(const [id,until] of cancelled)if(until<Date.now())cancelled.delete(id);
  if(!Number.isFinite(expiresAt) || expiresAt<Date.now())return {error:'ページ内動画の取得が期限切れです。もう一度保存してください。'};
  if(offset===-2) {
    cancelled.set(token,Date.now()+60000);
    while(cancelled.size>64)cancelled.delete(cancelled.keys().next().value);
    if(snapshot?.token===token){clearTimeout(snapshot.timer);snapshot.controller?.abort();delete globalThis[key];}
    return {released:true};
  }
  if(offset===-1) {
    if(cancelled.has(token))return {error:'ページ内動画の取得を停止しました。'};
    if(snapshot){clearTimeout(snapshot.timer);snapshot.controller?.abort();}
    const operation={url,token,controller:new AbortController()};
    globalThis[revisionKey]=token;
    globalThis[key]=operation;
    const valid=()=>globalThis[key]===operation && !operation.controller.signal.aborted && Date.now()<=expiresAt;
    const wait=promise=>new Promise((resolve,reject)=>{
      const stop=()=>{operation.controller.signal.removeEventListener('abort',stop);reject(new Error('Stopped'));};
      operation.controller.signal.addEventListener('abort',stop,{once:true});
      Promise.resolve(promise).then(value=>{operation.controller.signal.removeEventListener('abort',stop);valid() ? resolve(value) : reject(new Error('Stopped'));},error=>{operation.controller.signal.removeEventListener('abort',stop);reject(error);});
      if(!valid())stop();
    });
    const timer=setTimeout(()=>operation.controller.abort(),Math.max(0,expiresAt-Date.now()));
    timer.unref?.();
    let blob;
    try {
      const response=await wait(fetch(url,{signal:operation.controller.signal}));
      const maximum=268435456;
      if(Number(response.headers.get('content-length'))>maximum) {
        void response.body?.cancel().catch(()=>{});return {error:'ページ内動画の直接保存は256 MiBまでです。'};
      }
      if(!response.body) return {error:'ページ内動画のデータを取得できません。'};
      const reader=response.body.getReader(),parts=[];let bytes=0;
      const abortReader=()=>{void Promise.resolve(reader.cancel()).catch(()=>{});};
      operation.controller.signal.addEventListener('abort',abortReader,{once:true});
      try {
        while(true) {
          const {value,done}=await wait(reader.read());if(done)break;
          bytes+=value.byteLength;
          if(bytes>maximum){void Promise.resolve(reader.cancel()).catch(()=>{});return {error:'ページ内動画の直接保存は256 MiBまでです。'};}
          parts.push(value);
        }
      } finally {operation.controller.signal.removeEventListener('abort',abortReader);try {reader.releaseLock();}catch{}}
      blob=new Blob(parts,{type:response.headers.get('content-type') || ''});
    }
    catch { return {error:'このblobは元ファイルとして取得できません。分割配信の候補を再スキャンするか、録画を試してください。'}; }
    finally {clearTimeout(timer);if(globalThis[key]===operation)delete globalThis[key];}
    if(!validAfterRead())return {error:'ページ内動画の取得を停止しました。'};
    function validAfterRead(){return globalThis[revisionKey]===token && !operation.controller.signal.aborted && !cancelled.has(token) && Date.now()<=expiresAt && !globalThis[key];}
    if (blob.size > 268435456) return {error:'ページ内動画の直接保存は256 MiBまでです。'};
    if (!blob.size || !/^video\/(mp4|webm|ogg|quicktime|x-m4v)(?:;|$)/i.test(blob.type)) return {error:'ページ内データを対応する動画ファイルとして確認できません。録画を試してください。'};
    const signature=new Uint8Array(await blob.slice(0,16).arrayBuffer());
    const ascii=(from,to)=>String.fromCharCode(...signature.slice(from,to));
    const signatureValid=/webm/i.test(blob.type) ? signature[0]===0x1a && signature[1]===0x45 && signature[2]===0xdf && signature[3]===0xa3 : /ogg/i.test(blob.type) ? ascii(0,4)==='OggS' : ['ftyp','moov','mdat','wide'].includes(ascii(4,8));
    if(!signatureValid || !validAfterRead())return {error:'ページ内データを動画ファイルとして確認できません。録画を試してください。'};
    snapshot={url,token,blob};globalThis[key]=snapshot;
  }
  if(!snapshot || snapshot.token!==token || snapshot.url!==url)return {error:'ページ内動画の取得が期限切れです。もう一度保存してください。'};
  clearTimeout(snapshot.timer);
  snapshot.timer=setTimeout(()=>{if(globalThis[key]===snapshot)delete globalThis[key];},60000);
  snapshot.timer.unref?.();
  const blob=snapshot.blob;
  const length=262144;
  return {size:blob.size,mime:blob.type,bytes:offset < 0 ? [] : Array.from(new Uint8Array(await blob.slice(offset,offset+length).arrayBuffer()))};
}
