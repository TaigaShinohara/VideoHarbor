// Download output policy. Recording has its own format and is outside this selector.
const MP4_MIMES = new Set(['video/mp4','video/x-m4v']);
const EXTENSIONS = new Set(['mp4','m4v','webm','mov','ogv','ogg','mpeg','mpg','ts','m2ts','avi','mkv','3gp']);
const MIME_EXTENSIONS = new Map([
  ['video/mp4','mp4'],['video/x-m4v','m4v'],['video/webm','webm'],
  ['video/quicktime','mov'],['video/ogg','ogv'],['application/ogg','ogg'],
  ['video/mpeg','mpeg'],['video/mp2t','ts'],['video/x-msvideo','avi'],
  ['video/x-matroska','mkv'],['video/3gpp','3gp'],
]);
const mimeOf = item => typeof item?.mime === 'string' ? item.mime.split(';',1)[0].trim().toLowerCase() : '';
function extensionOf(item) {
  try {
    const url=new URL(item?.url);
    if(!/^https?:$/.test(url.protocol))return '';
    const extension=/\.([a-z0-9]+)$/i.exec(url.pathname)?.[1]?.toLowerCase();
    return EXTENSIONS.has(extension) ? extension : '';
  } catch {return '';}
}
export function originalExtension(item) {
  const fileExtension=extensionOf(item),mimeExtension=MIME_EXTENSIONS.get(mimeOf(item));
  const family=extension=>({m4v:'mp4',ogv:'ogg',mpg:'mpeg',m2ts:'ts'})[extension] || extension;
  // Keep equivalent source suffixes (.ogg/.ogv, .m4v/.mp4); an incompatible
  // known MIME overrides a misleading URL suffix just as the MP4 policy does.
  const extension=mimeExtension && family(mimeExtension)!==family(fileExtension) ? mimeExtension : fileExtension || mimeExtension;
  return extension || '';
}
function autoLabel(item) {
  if(item?.type==='hls')return '配信の標準（HLS）';
  if(item?.type==='dash')return '配信の標準（MP4）';
  const extension=originalExtension(item);
  return extension ? `元の形式（.${extension}）` : '元の形式（形式未確認）';
}
function mp4Reason(item) {
  if(item?.type==='hls' || item?.type==='dash')return '';
  const mime=mimeOf(item),extension=extensionOf(item);
  const knownOtherMIME=Boolean(mime && !MP4_MIMES.has(mime) && (mime.startsWith('video/') || MIME_EXTENSIONS.has(mime)));
  if(item?.type==='blob') {
    if(knownOtherMIME)return 'このページ内動画はMP4形式ではありません。元の形式で保存してください。';
    // A blob without metadata can be inspected only after reading its snapshot.
    // The saver must validate its actual MIME/container before writing MP4.
    if(!mime || mime==='application/octet-stream' || MP4_MIMES.has(mime))return '';
    return 'このページ内データをMP4動画として確認できません。元の形式で保存してください。';
  }
  if(item?.type==='direct') {
    if(knownOtherMIME)return 'この動画の形式からMP4への変換には対応していません。元の形式で保存してください。';
    if(MP4_MIMES.has(mime) || ['mp4','m4v'].includes(extension))return '';
    return extension
      ? 'この動画の形式からMP4への変換には対応していません。元の形式で保存してください。'
      : '元の動画がMP4か確認できないため、元の形式で保存してください。';
  }
  return 'この動画の配信方式ではMP4保存を選べません。';
}
export function outputOptions(item) {
  const reason=mp4Reason(item);
  return [
    {value:'auto',label:autoLabel(item)},
    {value:'mp4',label:'MP4（.mp4）',...(reason ? {disabled:true,reason} : {})},
  ];
}
export function validateOutputFormat(item,value) {
  if(value!=='auto' && value!=='mp4')throw new Error('保存形式は「元の形式」または「MP4」から選んでください。');
  if(value==='mp4') {
    const reason=mp4Reason(item);if(reason)throw new Error(reason);
  }
  return value;
}
