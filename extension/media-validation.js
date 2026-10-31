// The top-level transport validation budget is shared by init/segments and
// both tracks. The mux separately bounds all nested boxes in its own pass;
// the same input is not double-charged across these two validation phases.
export const MEDIA_BOX_LIMIT = 250000;
export const createMediaBudget = () => ({boxes:0});
const fail = message => {throw new Error(message);};

export function validateMediaSegment(bytes,extension,init,budget=createMediaBudget()) {
  if(!(bytes instanceof Uint8Array) || !bytes.length)fail('空の動画区間が返されました。');
  if(bytes.length>268435456)fail('保存データが容量上限を超えます。');
  if(!budget || !Number.isSafeInteger(budget.boxes) || budget.boxes<0 || budget.boxes>MEDIA_BOX_LIMIT)fail('動画の構造上限が不正です。');
  if(extension==='ts') {
    if(bytes.length%188 || bytes[0]!==0x47)fail('このHLSの動画形式には未対応です。TSとして保存できないため中断しました。');
    for(let at=188;at<bytes.length;at+=188)if(bytes[at]!==0x47)fail('TSの動画区間が壊れています。');
    return bytes;
  }
  if(extension!=='mp4')fail('動画の形式に対応していません。');
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let at=0,seen=0;
  while(at<bytes.length) {
    if(budget.boxes>=MEDIA_BOX_LIMIT)fail('MP4のボックス数が多すぎます（合計最大250000件）。');
    budget.boxes++;
    if(bytes.length-at<8)fail('MP4の動画区間が途中で終わっています。');
    let size=view.getUint32(at),header=8;
    const type=view.getUint32(at+4);
    if(size===1) {
      if(bytes.length-at<16)fail('MP4の動画区間が途中で終わっています。');
      const large=view.getBigUint64(at+8);
      if(large>BigInt(bytes.length-at))fail('MP4の動画区間が壊れています。');
      size=Number(large);header=16;
    } else if(size===0)size=bytes.length-at;
    if(size<header || size>bytes.length-at)fail('MP4の動画区間が壊れています。');
    // Retain only required presence bits, including when unknown boxes occur.
    if(type===0x66747970)seen|=1; // ftyp
    else if(type===0x6d6f6f76)seen|=2; // moov
    else if(type===0x6d6f6f66)seen|=4; // moof
    else if(type===0x6d646174)seen|=8; // mdat
    at+=size;
  }
  if(init ? (seen&3)!==3 || Boolean(seen&4) : (seen&12)!==12 || Boolean(seen&2))fail('このHLSのMP4構成には未対応です。形式を変えて保存できないため中断しました。');
  return bytes;
}
