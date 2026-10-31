// Playback URLs have their own lifetime, independent of a download's object URL.
export class ResultPreview {
  constructor({getFile,createURL=file=>URL.createObjectURL(file),revokeURL=url=>URL.revokeObjectURL(url)}) {
    this.getFile=getFile;this.createURL=createURL;this.revokeURL=revokeURL;
    this.url=null;this.pending=null;this.generation=0;
  }
  load() {
    if(this.url)return Promise.resolve(this.url);
    if(this.pending)return this.pending;
    const generation=this.generation;
    const pending=Promise.resolve().then(()=>this.getFile()).then(file=>{
      if(generation!==this.generation)return null;
      if(!file)throw new Error('録画ファイルを読み込めません。保存先とアクセス許可を確認してください。');
      this.url=this.createURL(file);return this.url;
    });
    const tracked=pending.finally(()=>{if(this.pending===tracked)this.pending=null;});
    this.pending=tracked;return tracked;
  }
  clear() {
    this.generation++;this.pending=null;
    if(this.url)this.revokeURL(this.url);
    this.url=null;
  }
}
