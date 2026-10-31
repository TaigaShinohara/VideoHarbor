import {ResultPreview} from './result-preview.js';

export class RecordingResultView {
  constructor({controller,showDownload}) {
    this.controller=controller;this.showDownload=showDownload;this.previousPhase='idle';this.loading=false;this.operation=0;
    const $=id=>document.getElementById(id);
    this.root=$('record-result');this.live=$('preview-stage');this.player=$('result-playback');
    this.play=$('play-result');this.folder=$('show-record-file');this.name=$('result-file-name');
    this.location=$('result-location');this.message=$('result-preview-message');
    this.preview=new ResultPreview({getFile:()=>controller.getResultFile()});
    this.play.addEventListener('click',()=>this.playResult());
    this.folder.addEventListener('click',()=>{
      const id=controller.snapshot().downloadId;
      if(id===null || controller.busy)return;
      const generation=this.preview.generation;
      this.folder.disabled=true;
      Promise.resolve(showDownload(id)).catch(()=>{if(generation===this.preview.generation)this.explain('保存先を表示できません。Chromeのダウンロード履歴と、ファイルの移動・削除を確認してください。');})
        .finally(()=>{if(generation===this.preview.generation)this.folder.disabled=controller.busy;});
    });
    this.player.addEventListener('error',()=>{
      if(!this.root.hidden && this.player.error && this.player.getAttribute('src')===this.preview.url)this.explain('このChromeでは録画を再生できません。ファイルに保存して、対応するプレーヤーで確認してください。');
    });
    window.addEventListener('pagehide',()=>this.clear());
    window.addEventListener('resize',()=>{if(!this.player.hidden)this.fitPlayer(false);});
  }
  explain(text) {this.message.textContent=text;this.message.hidden=false;}
  clear() {
    this.operation++;
    this.player.pause();this.player.removeAttribute('src');this.player.load();this.player.hidden=true;
    this.preview.clear();this.loading=false;this.message.hidden=true;
  }
  update(snapshot) {
    if(snapshot.phase==='recording' && !['recording','paused'].includes(this.previousPhase))this.clear();
    if(!snapshot.resultReady && !this.controller.busy)this.clear();
    if(this.controller.busy)this.player.pause();
    const visible=snapshot.resultReady && !this.controller.busy;
    this.root.hidden=!visible;this.live.hidden=visible;
    this.name.textContent=snapshot.fileName || '録画ファイル';
    this.location.textContent=snapshot.resultSaved
      ? snapshot.downloadId!==null ? 'ファイルへ保存済みです。保存場所から実ファイルを確認できます。' : '開始前に選んだファイルへ保存済みです。ここで内容を再生できます。'
      : 'この作業タブ内にある録画です。まだファイルへ保存していません。';
    this.play.disabled=!snapshot.resultPlaybackAvailable || this.loading;
    this.folder.hidden=!snapshot.resultSaved || snapshot.downloadId===null;
    this.folder.disabled=this.controller.busy;
    this.previousPhase=snapshot.phase;
  }
  fitPlayer(scroll=true) {
    const panel=document.getElementById('record-panel');
    const fixed=panel && globalThis.getComputedStyle?.(panel).position==='fixed';
    const reserved=fixed ? panel.getBoundingClientRect().height : 0;
    if(this.player.style)this.player.style.maxHeight=`${Math.min(480,Math.max(80,(window.innerHeight || 800)-reserved-40))}px`;
    if(scroll)this.player.scrollIntoView?.({block:fixed ? 'start' : 'center',behavior:'instant'});
  }
  async playResult() {
    if(this.loading || this.controller.busy)return;
    const operation=++this.operation;
    this.loading=true;this.play.disabled=true;this.message.hidden=true;
    try {
      const url=await this.preview.load();
      if(operation!==this.operation || !url || this.controller.busy || !this.controller.snapshot().resultReady)return;
      this.player.hidden=false;
      if(this.player.getAttribute('src')!==url)this.player.src=url;
      else this.player.currentTime=0;
      this.fitPlayer();
      try {await this.player.play();}
      catch(error) {
        if(operation!==this.operation)return;
        if(error.name==='NotAllowedError')this.explain('下の動画の再生ボタンを押して、映像と音声を確認してください。');
        else this.explain('このChromeでは録画を再生できません。保存したファイルを対応するプレーヤーで確認してください。');
      }
    } catch {if(operation===this.operation)this.explain('録画ファイルを読み込めません。保存先の移動・削除や、ファイルへのアクセス許可を確認してください。');}
    finally {if(operation===this.operation){this.loading=false;this.play.disabled=this.controller.busy || !this.controller.snapshot().resultPlaybackAvailable;}}
  }
}
