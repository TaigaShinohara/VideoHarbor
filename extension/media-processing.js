import { MEDIA_BOX_LIMIT } from './media-validation.js';

const LIMIT = 268435456;
const stopped = () => new DOMException('保存を停止しました。', 'AbortError');
const failure = () => new Error('動画の解析を完了できませんでした。再試行してください。');
const buffers = value => {
  const found = new Set();
  const visit = item => {
    if (item instanceof Uint8Array) found.add(item.buffer);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') Object.values(item).forEach(visit);
  };
  visit(value); return [...found];
};

// One processor belongs to one save operation. It has no network/download API.
export class MediaProcessor {
  constructor({signal,workerFactory=()=>new Worker(new URL('./media-worker.js',import.meta.url),{type:'module'}),timeoutMs=120000}={}) {
    this.signal=signal;this.workerFactory=workerFactory;this.timeoutMs=timeoutMs;
    this.worker=null;this.pending=null;this.closed=false;this.sequence=0;
    this.token=crypto.randomUUID();
    this.abort=()=>this.close(stopped());
    signal?.addEventListener('abort',this.abort,{once:true});
    if(signal?.aborted)this.close(stopped());
  }
  run(kind,payload) {
    if(this.closed || this.signal?.aborted)return Promise.reject(stopped());
    if(!['validate','mux','remux'].includes(kind) || this.pending)return Promise.reject(failure());
    return new Promise((resolve,reject)=>{
      const id=`${this.token}:${++this.sequence}`;
      const finish=(error,result)=>{
        if(this.pending?.id!==id)return;
        clearTimeout(this.pending.timer);this.pending=null;
        error ? reject(error) : resolve(result);
      };
      this.pending={id,kind,finish,timer:setTimeout(()=>this.close(new Error('動画の解析に時間がかかりすぎたため停止しました。')),this.timeoutMs)};
      try {
        if(!this.worker) {
          this.worker=this.workerFactory();
          this.message=event=>{
            const reply=event.data, pending=this.pending;
            if(!pending || reply?.id!==pending.id)return;
            if(reply.kind!==pending.kind || typeof reply.ok!=='boolean')return this.close(failure());
            if(!reply.ok)return this.close(new Error(typeof reply.error==='string' ? reply.error.slice(0,180) : failure().message));
            pending.finish(null,reply.result);
          };
          this.error=event=>{event.preventDefault?.();this.close(failure());};
          this.worker.addEventListener('message',this.message);
          this.worker.addEventListener('error',this.error);
          this.worker.addEventListener('messageerror',this.error);
        }
        this.worker.postMessage({id,kind,payload},buffers(payload));
      } catch {this.close(failure());}
    });
  }
  async validate(bytes,extension,init,budget) {
    const length=bytes.byteLength,previous=budget.boxes;
    const result=await this.run('validate',{bytes,extension,init:init==='file' ? 'file' : Boolean(init),boxes:previous});
    if(!(result?.bytes instanceof Uint8Array) || result.bytes.byteLength!==length || !Number.isSafeInteger(result.boxes) || result.boxes<previous || result.boxes>MEDIA_BOX_LIMIT) {
      this.close(failure());throw failure();
    }
    budget.boxes=result.boxes;return result.bytes;
  }
  async mux(tracks,{maxBytes=LIMIT}={}) {
    return this.output(await this.run('mux',{tracks,maxBytes}),maxBytes);
  }
  async remux(bytes,{maxBytes=LIMIT}={}) {
    return this.output(await this.run('remux',{bytes,maxBytes}),maxBytes);
  }
  output(result,maxBytes) {
    if(!(result instanceof Blob) || result.type!=='video/mp4' || !result.size || result.size>maxBytes) {
      this.close(failure());throw failure();
    }
    return result;
  }
  close(error=stopped()) {
    if(this.closed)return;
    this.closed=true;this.signal?.removeEventListener('abort',this.abort);
    if(this.worker) {
      this.worker.removeEventListener('message',this.message);
      this.worker.removeEventListener('error',this.error);
      this.worker.removeEventListener('messageerror',this.error);
      this.worker.terminate();this.worker=null;
    }
    this.pending?.finish(error);
  }
}
