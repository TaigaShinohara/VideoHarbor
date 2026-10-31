import test from 'node:test';
import assert from 'node:assert/strict';
import {RecordingResultView} from '../extension/workspace-result.js';

function deferred() {
  let resolve;
  let reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}

class Element extends EventTarget {
  constructor() {
    super();this.hidden=false;this.disabled=false;this.textContent='';this.currentTime=0;
    this.attributes=new Map();this.playCalls=0;this.playResults=[];
  }
  getAttribute(name) {return this.attributes.get(name) ?? null;}
  removeAttribute(name) {this.attributes.delete(name);}
  set src(value) {this.attributes.set('src',value);}
  get src() {return this.getAttribute('src') || '';}
  pause() {}
  load() {}
  play() {this.playCalls++;return this.playResults.shift()?.promise || Promise.resolve();}
}

function harness(t) {
  const names=['document','window','URL'];
  const originals=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const ids=['record-result','preview-stage','result-playback','play-result','show-record-file',
    'result-file-name','result-location','result-preview-message'];
  const elements=new Map(ids.map(id=>[id,new Element()]));
  const created=[],revoked=[];
  Object.defineProperty(globalThis,'document',{configurable:true,value:{getElementById:id=>elements.get(id)}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:new EventTarget()});
  Object.defineProperty(globalThis,'URL',{configurable:true,value:{
    createObjectURL:file=>{const url=`blob:recording-${created.length+1}`;created.push({file,url});return url;},
    revokeObjectURL:url=>revoked.push(url),
  }});
  const reads=[];
  let snapshot={phase:'ready',resultReady:true,resultSaved:false,resultPlaybackAvailable:true,
    fileName:'recording-A.webm',downloadId:null};
  const controller={busy:false,snapshot:()=>snapshot,getResultFile:()=>reads.shift().promise};
  const view=new RecordingResultView({controller,showDownload:async()=>{}});
  view.update(snapshot);
  t.after(()=>{
    view.clear();
    for(const [name,descriptor] of originals) {
      if(descriptor)Object.defineProperty(globalThis,name,descriptor);
      else delete globalThis[name];
    }
  });
  return {
    view,controller,reads,created,revoked,
    player:elements.get('result-playback'),play:elements.get('play-result'),message:elements.get('result-preview-message'),
    nextResult({viaRecording=true}={}) {
      if(viaRecording) {
        controller.busy=true;
        snapshot={...snapshot,phase:'recording',resultReady:false};
        view.update(snapshot);
      } else view.clear();
      controller.busy=false;
      snapshot={...snapshot,phase:'ready',resultReady:true,fileName:'recording-B.webm'};
      view.update(snapshot);
    },
  };
}

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const loadingState=h=>({message:h.message.textContent,hidden:h.message.hidden,
  loading:h.view.loading,disabled:h.play.disabled,src:h.player.src});

for(const outcome of ['resolve','reject']) {
  test(`leaving the recorder invalidates an outstanding file ${outcome} without discarding the result`,async t=>{
    const h=harness(t),read=deferred();h.reads.push(read);
    const pending=h.view.playResult();await tick();
    h.view.pausePlayback();
    if(outcome==='resolve')read.resolve(new Blob(['saved recording']));
    else read.reject(new DOMException('read failed after navigation','NotFoundError'));
    await pending;
    assert.equal(h.player.playCalls,0,'an old read never starts hidden playback');
    assert.equal(h.view.loading,false);assert.equal(h.play.disabled,false);
    assert.equal(h.message.hidden,true);assert.deepEqual(h.revoked,[]);
    if(outcome==='resolve') {
      await h.view.playResult();
      assert.equal(h.player.playCalls,1,'an explicit new play action can reuse the retained result');
      assert.equal(h.created.length,1);
    }
  });
}

// The read belongs to A's File System Access handle, but B is now the current recording.
// A's error handling and finally must not dismiss B's pending read or display A's failure.
test('a replaced result file read cannot overwrite the next result loading state when it rejects',async t=>{
  const h=harness(t),oldRead=deferred(),nextRead=deferred();
  h.reads.push(oldRead,nextRead);
  const first=h.view.playResult();
  await tick();
  h.nextResult();
  const second=h.view.playResult();
  await tick();
  const nextLoading=loadingState(h);
  assert.equal(nextLoading.loading,true);
  assert.equal(nextLoading.disabled,true);
  assert.equal(nextLoading.hidden,true);
  oldRead.reject(new DOMException('previous file moved','NotFoundError'));
  await first;
  assert.deepEqual(loadingState(h),nextLoading);
  assert.deepEqual(h.created,[]);
  assert.deepEqual(h.revoked,[]);
  const nextFile=new Blob(['recording B']);
  nextRead.resolve(nextFile);
  await second;
  assert.equal(h.player.src,'blob:recording-1');
  assert.equal(h.player.playCalls,1);
  assert.equal(h.view.loading,false);
  assert.equal(h.play.disabled,false);
  assert.equal(h.message.hidden,true);
  assert.equal(h.created[0].file,nextFile);
  h.view.clear();
  assert.deepEqual(h.revoked,['blob:recording-1']);
});

for(const outcome of ['NotAllowedError','NotSupportedError','complete']) {
  test(`a cleared result player ${outcome==='complete' ? 'completion' : outcome+' rejection'} cannot finish the next result loading operation`,async t=>{
    const h=harness(t),oldRead=deferred(),nextRead=deferred(),oldPlay=deferred();
    h.reads.push(oldRead,nextRead);
    h.player.playResults.push(oldPlay);
    const first=h.view.playResult();
    oldRead.resolve(new Blob(['recording A']));
    await tick();
    assert.equal(h.player.playCalls,1);
    assert.equal(h.player.src,'blob:recording-1');
    h.nextResult({viaRecording:false});
    assert.deepEqual(h.revoked,['blob:recording-1']);
    const second=h.view.playResult();
    await tick();
    const nextLoading=loadingState(h);
    assert.equal(nextLoading.loading,true);
    assert.equal(nextLoading.disabled,true);
    assert.equal(nextLoading.src,'');
    if(outcome==='complete')oldPlay.resolve();
    else oldPlay.reject(new DOMException('old playback stopped',outcome));
    await first;
    assert.deepEqual(loadingState(h),nextLoading);
    assert.equal(h.created.length,1);
    assert.deepEqual(h.revoked,['blob:recording-1']);
    nextRead.resolve(new Blob(['recording B']));
    await second;
    assert.equal(h.player.src,'blob:recording-2');
    assert.equal(h.player.playCalls,2);
    assert.equal(h.view.loading,false);
    assert.equal(h.play.disabled,false);
    assert.equal(h.message.hidden,true);
    h.view.clear();
    assert.deepEqual(h.revoked,['blob:recording-1','blob:recording-2']);
  });
}
