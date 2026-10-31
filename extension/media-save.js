import { prepareHLS } from './hls.js';
import { prepareDASH } from './dash.js';
import { assembleStream } from './stream-assembly.js';
import { remuxTSToMP4 } from './ts-to-mp4.js';
import { validateOutputFormat } from './output-format.js';
import { sanitizePart, fileLabel, publicError } from './utils.js';

export function originPattern(url) {
  const value=new URL(url);
  if(!/^https?:$/.test(value.protocol) || value.username || value.password || value.hostname.includes('*')) throw new Error('具体的なHTTP/HTTPSの配信元だけ取得できます。');
  // Use site host scope consistently with the wording of the permission controls.
  return `${value.protocol}//${value.hostname.includes(':') ? `[${value.hostname.replace(/^\[|\]$/g,'')}]` : value.hostname}/*`;
}
class SitePermissionError extends Error {
  constructor(origins) {super('配信元へのアクセス許可が必要です。');this.origins=origins;}
}

// All assembled data lives in this workspace, not the suspendable service worker.
export class MediaSaver {
  constructor({onUpdate=()=>{},readBlob}) {
    this.onUpdate=onUpdate;this.readBlob=readBlob;this.results=new Map();this.busy=false;
    this.current=null;this.controller=null;this.downloadId=null;
  }
  emit() {this.onUpdate();}
  status(url) {return this.results.get(url);}
  async missing(urls) {
    const origins=[...new Set(urls.map(originPattern))];
    if(origins.length>32)throw new Error('配信元のサイトが多すぎます。最大32サイトまでです。');
    return (await Promise.all(origins.map(async origin=>await chrome.permissions.contains({origins:[origin]}) ? null : origin))).filter(Boolean);
  }
  async fetchResource(url,{signal,range}={}) {
    const missing=await this.missing([url]);if(missing.length)throw new SitePermissionError(missing);
    try {
      return await fetch(url,{signal,credentials:'include',redirect:'error',referrerPolicy:'no-referrer',
        headers:range ? {Range:`bytes=${range.start}-${range.end}`} : {}});
    } catch(error) {
      if(signal?.aborted)throw error;
      throw new Error('配信元から取得できません。ログイン・アクセス制限・URLの期限やリダイレクトを確認してください。');
    }
  }
  // Invoke directly from a click. permissions.request must happen before the first await.
  start(item,title,outputFormat='auto') {
    if(this.busy)return Promise.resolve();
    validateOutputFormat(item,outputFormat);
    const previous=this.results.get(item.url);
    const permission=previous?.origins?.length ? chrome.permissions.request({origins:previous.origins}) : Promise.resolve(true);
    if(previous && previous.outputFormat!==outputFormat)delete previous.blob;
    // Keep at most one retry buffer. Original source files remain available for re-fetch.
    for(const [url,result] of this.results)if(url!==item.url)delete result.blob;
    for(const [url,result] of this.results) {
      if(this.results.size<100)break;
      if(url!==item.url && !result.blob)this.results.delete(url);
    }
    this.busy=true;this.current=item.url;this.controller=new AbortController();
    return this.run(item,title,permission,previous,outputFormat);
  }
  async run(item,title,permission,previous,outputFormat) {
    let objectURL,blobToken;
    const sameFormat=previous?.outputFormat===outputFormat;
    const result={status:'preparing',message:'動画の配信情報を確認しています。',bytesReceived:0,outputFormat,audioUnverified:sameFormat && Boolean(previous?.audioUnverified)};
    this.results.set(item.url,result);this.emit();
    try {
      if(!await permission)throw new Error('配信元へのアクセスは許可されませんでした。もう一度「保存」から試せます。');
      const signal=this.controller.signal;
      signal.throwIfAborted();
      let blob=sameFormat ? previous?.blob : null, extension=sameFormat ? previous?.extension : undefined;
      if(!blob && ['hls','dash'].includes(item.type)) {
        const plan=await (item.type==='hls' ? prepareHLS : prepareDASH)(item.url,this.fetchResource.bind(this),{signal});
        const missing=await this.missing((plan.tracks ? plan.tracks.flatMap(t=>t.segments) : plan.segments).map(s=>s.url));
        if(missing.length)throw new SitePermissionError(missing);
        result.audioUnverified=!plan.fromMaster;
        result.status='fetching';result.message=result.audioUnverified ? '単独のHLSリストを取得中。別配信の音声を判別できないため、音声を含まない場合があります。' : plan.tracks?.length===2 ? '映像と音声を取得して、MP4へまとめています。' : '分割された動画を取得しています。';this.emit();
        blob=await assembleStream(plan,this.fetchResource.bind(this),{signal,onProgress:progress=>{
          Object.assign(result,progress);this.emit();
        }});
        extension=plan.extension;
      } else if(!blob && item.type==='blob') {
        blobToken=crypto.randomUUID();
        const metadata=await this.readBlob(item.url,-1,blobToken);signal.throwIfAborted();
        if(outputFormat==='mp4' && !/^video\/(?:mp4|x-m4v)(?:;|$)/i.test(metadata.mime))throw new Error('このページ内動画はMP4ではありません。「元の形式」で保存してください。');
        extension=/mp4|m4v/.test(metadata.mime) ? 'mp4' : /quicktime/.test(metadata.mime) ? 'mov' : /ogg/.test(metadata.mime) ? 'ogv' : 'webm';
        result.status='fetching';result.message='ページ内の動画ファイルを取得しています。';this.emit();
        const parts=[];let offset=0;
        while(offset<metadata.size) {
          signal.throwIfAborted();
          const part=await this.readBlob(item.url,offset,blobToken);signal.throwIfAborted();
          if(part.size!==metadata.size || part.mime!==metadata.mime || !part.bytes.length || part.bytes.length>262144 || offset+part.bytes.length>metadata.size)throw new Error('ページ内動画が変化しました。再スキャンしてください。');
          parts.push(new Uint8Array(part.bytes));offset+=part.bytes.length;result.bytesReceived=offset;this.emit();
        }
        blob=new Blob(parts,{type:metadata.mime});
      }
      signal.throwIfAborted();
      if(!blob)throw new Error('この配信方式にはまだ対応していません。');
      if(outputFormat==='mp4' && extension==='ts') {
        result.status='converting';result.message='映像と音声を保ってMP4へまとめ直しています。';this.emit();
        const bytes=new Uint8Array(await blob.arrayBuffer());signal.throwIfAborted();
        blob=remuxTSToMP4(bytes);signal.throwIfAborted();extension='mp4';
      }
      if(outputFormat==='mp4' && extension!=='mp4')throw new Error('この形式のMP4変換には未対応です。「元の形式」を選んでください。');
      Object.assign(result,{blob,extension,status:'saving',message:'ファイルへ保存しています。',bytesReceived:blob.size});this.emit();
      objectURL=URL.createObjectURL(blob);
      const stem=sanitizePart(fileLabel(item.url).replace(/\.[a-z0-9]{2,5}$/i,''),'video');
      this.downloadId=await chrome.downloads.download({url:objectURL,filename:`VideoHarbor/${sanitizePart(title)}/${stem}.${extension}`,conflictAction:'uniquify',saveAs:false});
      result.downloadId=this.downloadId;
      // The user may cancel while Chrome is accepting the download.
      if(signal.aborted)await chrome.downloads.cancel(this.downloadId).catch(()=>{});
      await this.waitForDownload(this.downloadId);
      try {
        const [saved]=await chrome.downloads.search({id:this.downloadId});
        if(saved?.filename)result.filename=saved.filename;
        if(typeof saved?.exists==='boolean')result.exists=saved.exists;
      } catch { /* The confirmed completion remains valid if its optional location is unavailable. */ }
      result.status='complete';result.message=`保存完了 · ${extension.toUpperCase()}${result.audioUnverified ? ' · 音声の有無は未確認' : ''}`;delete result.blob;
    } catch(error) {
      result.status=error.origins ? 'permission' : 'interrupted';
      result.origins=error.origins;
      result.message=this.controller.signal.aborted ? '保存を停止しました。' : publicError(error);
    } finally {
      this.controller.abort();
      if(blobToken)await this.readBlob(item.url,-2,blobToken).catch(()=>{});
      if(objectURL)URL.revokeObjectURL(objectURL);
      this.busy=false;this.current=null;this.downloadId=null;this.controller=null;this.emit();
    }
  }
  waitForDownload(id) {
    return new Promise((resolve,reject)=> {
      let done=false,checking=false;
      const finish=(error)=>{if(done)return;done=true;clearInterval(timer);chrome.downloads.onChanged.removeListener(changed);error ? reject(error) : resolve();};
      const changed=delta=>{if(delta.id!==id)return;if(delta.state?.current==='complete')finish();else if(delta.state?.current==='interrupted')finish(new Error('ダウンロードが中断されました。保存先を確認して再試行してください。'));};
      const check=async()=> {
        if(done || checking)return;checking=true;
        try {
          const [item]=await chrome.downloads.search({id});
          if(!item)finish(new Error('ダウンロード履歴を確認できません。保存先を確認してください。'));
          else if(['complete','interrupted'].includes(item.state))changed({id,state:{current:item.state}});
        } catch { /* An API error is not a terminal download; retain its object URL and reconcile. */ }
        finally {checking=false;}
      };
      const timer=setInterval(check,500);chrome.downloads.onChanged.addListener(changed);void check();
    });
  }
  cancel() {this.controller?.abort();if(this.downloadId!==null)void chrome.downloads.cancel(this.downloadId).catch(()=>{});}
}
