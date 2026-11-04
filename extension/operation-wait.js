// Bound a wait without claiming that the underlying browser API was cancelled.
export function operationWait(promise,{signal,timeout=10000}={}) {
  return new Promise((resolve,reject)=>{
    let timer;
    const abort=()=>finish(new DOMException('処理を停止しました。','AbortError'));
    const finish=(error,value)=>{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);
      error ? reject(error) : resolve(value);
    };
    Promise.resolve(promise).then(value=>finish(null,value),error=>finish(error));
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>finish(new Error('応答に時間がかかりすぎたため停止しました。もう一度お試しください。')),timeout);
    if(signal?.aborted)abort();
  });
}
