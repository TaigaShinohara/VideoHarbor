import { operationWait } from './operation-wait.js';

// Used only when the browser has no downloads API. Chrome keeps its native path.
export async function readDirectFile(url,fetchResource,{signal,onProgress=()=>{},maxBytes=268435456}={}) {
  const response=await operationWait(fetchResource(url,{signal}),{signal,timeout:30000});
  if(response.status!==200 || !response.body)throw new Error('動画ファイル全体を取得できません。認証・配信元を確認してください。');
  const mime=(response.headers.get('content-type') || '').split(';',1)[0].trim().toLowerCase();
  if(mime && !['application/octet-stream','binary/octet-stream','video/mp4','video/x-m4v','video/quicktime','video/webm','video/ogg','application/ogg'].includes(mime)) {
    void response.body.cancel().catch(()=>{});throw new Error('対応する動画ファイルではない応答が返されました。');
  }
  const declared=response.headers.get('content-length');
  const length=declared===null ? null : Number(declared);
  if(length!==null && (!Number.isSafeInteger(length) || length<1 || length>maxBytes)) {
    void response.body.cancel().catch(()=>{});throw new Error('直接取得できる動画は256 MiBまでです。');
  }
  const reader=response.body.getReader(),parts=[];let size=0,complete=false;
  const cancel=()=>{void Promise.resolve(reader.cancel()).catch(()=>{});};
  signal?.addEventListener('abort',cancel,{once:true});
  try {
    while(true) {
      const {value,done}=await operationWait(reader.read(),{signal,timeout:30000});
      signal?.throwIfAborted();if(done)break;
      if(!(value instanceof Uint8Array) || !value.byteLength)throw new Error('動画データを読み取れません。');
      size+=value.byteLength;if(size>maxBytes)throw new Error('直接取得できる動画は256 MiBまでです。');
      parts.push(value);onProgress(size);
    }
    if(!size || (length!==null && !response.headers.get('content-encoding') && size!==length))throw new Error('動画ファイルが空か、途中で終了しています。');
    complete=true;
  } finally {
    signal?.removeEventListener('abort',cancel);if(!complete)cancel();
    try {reader.releaseLock();}catch{ /* A cancellation may still be settling. */ }
  }
  const bytes=new Uint8Array(size);let at=0;
  for(const part of parts){bytes.set(part,at);at+=part.length;}
  const ascii=(a,b)=>String.fromCharCode(...bytes.subarray(a,b));
  const iso=['ftyp','moov','mdat','wide','free','skip'].includes(ascii(4,8));
  const webm=bytes[0]===0x1a && bytes[1]===0x45 && bytes[2]===0xdf && bytes[3]===0xa3;
  const ogg=ascii(0,4)==='OggS';
  const actual=iso ? (mime==='video/quicktime' || ascii(8,12)==='qt  ' ? 'mov' : 'mp4') : webm ? 'webm' : ogg ? 'ogv' : '';
  const expected={'video/mp4':'mp4','video/x-m4v':'mp4','video/quicktime':'mov','video/webm':'webm','video/ogg':'ogv','application/ogg':'ogv'}[mime];
  if(!actual || (expected && expected!==actual))throw new Error('動画の形式と実データを照合できません。');
  return {bytes,extension:actual,mime:{mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',ogv:'video/ogg'}[actual]};
}
