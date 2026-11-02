import test from 'node:test';
import assert from 'node:assert/strict';
import {PresentationIds,resources,candidateLabel,sourceHost,displayText,videoReferenceId,videoReferences,referenceKey,videoGroupLabels} from '../extension/presentation.js';
import {renderVideoGroups} from '../extension/workspace-videos.js';
import {outputOptions} from '../extension/output-format.js';
import {groupVideos} from '../extension/video-view.js';

test('presentation IDs preserve complete query-sensitive identity only in memory',()=>{
  const ids=new PresentationIds('source');
  const first='https://media.test/opaque-fixture.mp4?CustomAuth=fixture-a';
  const other='https://media.test/opaque-fixture.mp4?CustomAuth=fixture-b';
  const a=ids.id(first),b=ids.id(other);
  assert.match(a,/^source-\d+$/);assert.notEqual(a,b);assert.equal(ids.id(first),a);
  assert.equal(ids.key(a),first);assert.equal(ids.key(b),other);
  ids.retain([other]);assert.equal(ids.key(a),undefined);assert.equal(ids.knownId(first),undefined);
  assert.equal(ids.id(other),b);assert.notEqual(ids.id(first),a,'discarded IDs never identify another resource');
});

test('recording option IDs distinguish exact documents without embedding their URLs',()=>{
  const ref={documentId:'doc',frameId:2,frameToken:'frame',elementToken:'video',documentURL:'https://page.test/opaque-fixture?unknown=fixture-a'};
  const next={...ref,documentURL:'https://page.test/opaque-fixture?unknown=fixture-b'};
  const a=videoReferenceId(ref),b=videoReferenceId(next);
  assert.match(a,/^video-\d+$/);assert.notEqual(a,b);
  assert.equal(videoReferenceId({...ref,title:'Updated title',playing:true}),a,'descriptive updates preserve the current selection');
  videoReferences.retain([referenceKey(next)]);assert.equal(videoReferences.key(a),undefined);assert.equal(videoReferenceId(next),b);
});

test('source descriptions reveal the permitted host but never URL paths, query or blob identifiers',()=>{
  assert.equal(sourceHost('https://media.test:8443/opaque-fixture?unknown=fixture#fragment'),'media.test');
  assert.equal(sourceHost('blob:https://media.test/opaque-fixture'),'ページ内データ');
  assert.equal(sourceHost('data:video/mp4;base64,AA'),'ページ内データ');
  assert.equal(sourceHost('not a URL'),'配信元未確認');
  assert.equal(displayText('動画 HTTPS://media.test/opaque?unknown=fixture 続き'),'動画 [URL] 続き');
});

class Node {
  constructor(tag,cls='',text='') {this.tag=tag;this.className=cls;this.text=text;this.children=[];this.dataset={};this.attributes={};this.listeners={};}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children=children;}
  setAttribute(name,value) {this.attributes[name]=value;}
  addEventListener(type,listener) {this.listeners[type]=listener;}
}
const descendants=node=>[node,...node.children.filter(child=>child instanceof Node).flatMap(descendants)];
test('rendered candidates keep sensitive URLs out of text and DOM while actions retain exact source values',t=>{
  const markers=['OPAQUE_PATH_FIXTURE','QUERY_FIXTURE','HASH_FIXTURE','BLOB_FIXTURE'];
  const doc='https://page.test/OPAQUE_PATH_FIXTURE?custom=QUERY_FIXTURE#HASH_FIXTURE';
  const ref={elementTag:'VIDEO',videoRef:'v',elementToken:'v',frameToken:'f',documentId:'doc',documentURL:doc,title:'選んだ動画',locatable:true};
  const urls=[
    'https://media.test/OPAQUE_PATH_FIXTURE.mp4?UnKnOwN=QUERY_FIXTURE#HASH_FIXTURE',
    'https://media.test/OPAQUE_PATH_FIXTURE.mp4?UnKnOwN=QUERY_FIXTURE-2',
    'blob:https://page.test/BLOB_FIXTURE',
  ];
  const items=urls.map((url,index)=>({url,type:index===2 ? 'blob' : 'direct',mime:index===2 ? '' : 'video/mp4',occurrences:[ref]}));
  const state={items,videoElements:[ref],frames:[{title:'埋め込み',url:doc}],previousItems:[{url:urls[0]}]};
  const roots=new Map();const get=id=>{if(!roots.has(id))roots.set(id,new Node('root'));return roots.get(id);};
  const previous=globalThis.document;
  globalThis.document={getElementById:get,createTextNode:text=>new Node('text','',text)};
  t.after(()=>{globalThis.document=previous;});
  const saved=[],located=[],selected=[];
  renderVideoGroups({state,element:(...args)=>new Node(...args),icon:()=>new Node('svg'),statusElement:()=>new Node('span'),
    formatOptions:outputOptions,formatValue:()=> 'auto',onFormatChange:()=>{},onSave:item=>saved.push(item.url),
    onRecord:source=>selected.push(source),onLocate:(item,source)=>located.push(source),onLocateFrame:()=>{},onFramePermission:()=>{}});
  const nodes=[...roots.values()].flatMap(descendants);
  const output=JSON.stringify(nodes.map(({text,dataset,attributes,value,src,title})=>({text,dataset,attributes,value,src,title})));
  assert.equal(markers.some(marker=>output.includes(marker)),false,'source secrets never enter serialized DOM text or attributes');
  assert.equal(urls.some(url=>output.includes(url)),false,'full source URLs stay out of rendered DOM');
  assert.ok(output.includes('media.test'),'the user can still identify the permitted host');
  assert.ok(output.includes('選んだ動画'),'the real video title remains usable');
  for(const node of nodes.filter(node=>node.className.includes('direct-save') || node.className.includes('media-save')))node.listeners.click();
  assert.deepEqual(saved,urls,'save actions retain both complete query variants and blob identity');
  for(const node of nodes.filter(node=>node.className.includes('locate-source')))node.listeners.click();
  assert.deepEqual(located,[ref],'source navigation retains its exact document reference');
  for(const node of nodes.filter(node=>node.className.includes('record-video-button')))node.listeners.click();
  assert.deepEqual(selected,[ref]);
  assert.notEqual(resources.id(urls[0]),resources.id(urls[1]));
  assert.match(candidateLabel(urls[0]),/^保存元 \d+$/);
});


test('shared video labels number only untitled linked groups, redact URLs and preserve source identities',()=>{
  const groups=[
    {title:'Named https://media.test/OPAQUE_LABEL?token=PRIVATE_LABEL',linked:true,source:{videoRef:'named'},items:[]},
    {title:'',linked:false,source:{},items:[]},
    {title:'',linked:true,recordable:false,source:{configRef:'config'},items:[]},
    {title:'',linked:true,recordable:true,source:{videoRef:'first'},items:[]},
    {title:'タイトル付き',linked:true,source:{videoRef:'other'},items:[]},
    {title:'',linked:true,recordable:true,source:{videoRef:'second'},items:[]},
  ];
  const before=structuredClone(groups);
  const labelled=videoGroupLabels(groups);
  assert.deepEqual(labelled.map(group=>group.label),['Named [URL]','内容を確認できていない候補','ページ上の動画 1','ページ上の動画 2','タイトル付き','ページ上の動画 3']);
  assert.deepEqual(labelled.filter(group=>group.recordable).map(group=>group.label),['ページ上の動画 2','ページ上の動画 3'],
    'recording choices use numbering from the same complete group list as the cards');
  for(let index=0;index<groups.length;index++) {
    assert.notEqual(labelled[index],groups[index]);
    assert.equal(labelled[index].source,groups[index].source);
    assert.equal(labelled[index].items,groups[index].items);
  }
  assert.deepEqual(groups,before);
});

test('rendered recording actions use the same untitled numbers and redacted labels as the recording choices',t=>{
  const identity={elementTag:'VIDEO',frameToken:'frame',documentId:'doc',documentURL:'https://page.test/OPAQUE_LABEL?token=PRIVATE_LABEL'};
  const refs=[
    {...identity,elementToken:'first',videoRef:'first'},
    {...identity,elementToken:'named',videoRef:'named',title:'動画 https://media.test/OPAQUE_LABEL?token=PRIVATE_LABEL'},
    {...identity,elementToken:'second',videoRef:'second'},
  ];
  const state={items:[{url:'https://media.test/OPAQUE_LABEL.mp4?token=PRIVATE_LABEL',type:'direct',occurrences:[{configRef:'config',frameToken:'frame'}]}],videoElements:refs,frames:[],previousItems:[]};
  const roots=new Map();const get=id=>{if(!roots.has(id))roots.set(id,new Node('root'));return roots.get(id);};
  const previous=globalThis.document;
  globalThis.document={getElementById:get,createTextNode:text=>new Node('text','',text)};
  t.after(()=>{globalThis.document=previous;});
  const selected=[];
  renderVideoGroups({state,element:(...args)=>new Node(...args),icon:()=>new Node('svg'),statusElement:()=>new Node('span'),
    onSave:()=>{},onRecord:source=>selected.push(source),onLocate:()=>{},onLocateFrame:()=>{},onFramePermission:()=>{}});
  const labelled=videoGroupLabels(groupVideos(state.items,state.videoElements));
  const nodes=[...roots.values()].flatMap(descendants);
  assert.deepEqual(nodes.filter(node=>node.className==='video-title').map(node=>node.text),labelled.map(group=>group.label));
  const buttons=nodes.filter(node=>node.className.includes('record-video-button'));
  assert.deepEqual(buttons.map(node=>node.attributes['aria-label']),labelled.filter(group=>group.recordable).map(group=>`${group.label}だけを録画`));
  for(const button of buttons)button.listeners.click();
  assert.deepEqual(selected,labelled.filter(group=>group.recordable).map(group=>group.source));
  const output=JSON.stringify(nodes.map(({text,dataset,attributes})=>({text,dataset,attributes})));
  assert.equal(/OPAQUE_LABEL|PRIVATE_LABEL/.test(output),false);
});
