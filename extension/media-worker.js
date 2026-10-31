import { validateMediaSegment, MEDIA_BOX_LIMIT } from './media-validation.js';
import { muxFragmentedMP4 } from './mp4-mux.js';
import { remuxTSToMP4 } from './ts-to-mp4.js';
import { publicError } from './utils.js';

// Fixed binary-only operations. URLs, grants, files and downloads stay in the parent.
export function processMedia(kind,payload) {
  if(!payload || typeof payload!=='object')throw new Error('動画データの指定が不正です。');
  if(kind==='validate') {
    const {bytes,extension,init,boxes}=payload;
    if(!(bytes instanceof Uint8Array) || bytes.byteLength>268435456 || !['mp4','ts'].includes(extension) || typeof init!=='boolean' || !Number.isSafeInteger(boxes) || boxes<0 || boxes>MEDIA_BOX_LIMIT)throw new Error('動画データの指定が不正です。');
    const budget={boxes};validateMediaSegment(bytes,extension,init,budget);
    return {bytes,boxes:budget.boxes};
  }
  if(kind==='mux')return muxFragmentedMP4(payload.tracks,{maxBytes:payload.maxBytes});
  if(kind==='remux')return remuxTSToMP4(payload.bytes,{maxBytes:payload.maxBytes});
  throw new Error('未対応の動画処理です。');
}

if(typeof self!=='undefined')self.addEventListener('message',event=>{
  const {id,kind,payload}=event.data || {};
  if(typeof id!=='string' || id.length>100 || !['validate','mux','remux'].includes(kind))return;
  try {
    const result=processMedia(kind,payload);
    self.postMessage({id,kind,ok:true,result},kind==='validate' ? [result.bytes.buffer] : []);
  } catch(error) {self.postMessage({id,kind,ok:false,error:publicError(error)});}
});
