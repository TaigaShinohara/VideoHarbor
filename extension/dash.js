// Static, unencrypted ISO-BMFF DASH planning without runtime dependencies.
// URL/timeline semantics: https://dashif.org/Guidelines-TimingModel/
const MANIFEST_LIMIT = 1048576, SEGMENT_LIMIT = 5000;
const fail = message => new Error(message);
// Count expanded URLs before appending: a short template must not multiply a
// long RepresentationID/BaseURL into hundreds of MiB. Two tracks <= 8 MiB.
const PLAN_URL_LIMIT = 4 * 1024 * 1024;
const urlLimit = () => Object.assign(fail('DASHの配信URLの合計が大きすぎます（各リスト最大4 MiB）。'),{code:'PLAN_URL_LIMIT'});
function urlBudget() {let size=0;return url=>{size+=url.length;if(size>PLAN_URL_LIMIT)throw urlLimit();return url;};}
const abort = signal => { if (signal?.aborted) throw new DOMException('保存を停止しました。','AbortError'); };
function safeURL(value,base) {
  let url;
  try {url=new URL(value,base);} catch {throw fail('DASHの配信URLを読み取れません。');}
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hostname.includes('*') || url.href.length>131072) throw fail('このDASH配信URLには対応していません。');
  url.hash='';return url.href;
}
function unescapeXML(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(value)) throw fail('DASHのXMLエンティティには対応していません。');
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,(_,name)=>{
    const known={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(known[name])return known[name];
    const n=name[1]==='x' ? parseInt(name.slice(2),16) : Number(name.slice(1));
    if(!Number.isSafeInteger(n) || n<1 || n>0x10ffff || (n>=0xd800 && n<=0xdfff) || (n<32 && ![9,10,13].includes(n)))throw fail('DASHのXML文字が不正です。');
    return String.fromCodePoint(n);
  });
}
// The MPD subset needs elements, attributes and text only. DTDs, custom entities,
// processing instructions and XLink are rejected rather than resolved externally.
function parseXML(text) {
  const stack=[],roots=[];let index=0,nodes=0,declaration=false;
  text=text.replace(/^\uFEFF/,'');
  if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw fail('DASHのXML文字が不正です。');
  const appendText=(value,cdata=false)=>{
    if(!stack.length){if(value.trim())throw fail('DASHのXML構造が不正です。');return;}
    stack.at(-1).text+=cdata ? value : unescapeXML(value);
  };
  while(index<text.length) {
    if(text[index]!=='<') {const end=text.indexOf('<',index);appendText(text.slice(index,end<0?text.length:end));index=end<0?text.length:end;continue;}
    if(text.startsWith('<!--',index)) {const end=text.indexOf('-->',index+4);if(end<0 || text.slice(index+4,end).includes('--'))throw fail('DASHのXMLコメントが不正です。');index=end+3;continue;}
    if(text.startsWith('<![CDATA[',index)) {const end=text.indexOf(']]>',index+9);if(end<0)throw fail('DASHのXMLが途中で終わっています。');appendText(text.slice(index+9,end),true);index=end+3;continue;}
    if(text.startsWith('<?',index)) {
      const end=text.indexOf('?>',index+2);
      if(end<0 || declaration || roots.length || stack.length || !/^<\?xml\s/.test(text.slice(index,end+2)))throw fail('DASHのXML処理命令には対応していません。');
      declaration=true;index=end+2;continue;
    }
    if(text.startsWith('<!',index))throw fail('DTDや外部エンティティを含むDASHには対応していません。');
    let end=index+1,quote='';
    for(;end<text.length;end++) {const ch=text[end];if(quote){if(ch===quote)quote='';}else if(ch==='"' || ch==="'")quote=ch;else if(ch==='>')break;}
    if(end===text.length || quote)throw fail('DASHのXMLが途中で終わっています。');
    const inside=text.slice(index+1,end);index=end+1;
    if(inside.startsWith('/')) {
      const match=/^\/([A-Za-z_][\w:.-]*)\s*$/.exec(inside);
      if(!match || stack.at(-1)?.qualified!==match[1])throw fail('DASHのXML終了タグが一致しません。');
      stack.pop();continue;
    }
    const self=/\/\s*$/.test(inside),body=self ? inside.replace(/\/\s*$/,'') : inside;
    const match=/^([A-Za-z_][\w:.-]*)/.exec(body);if(!match)throw fail('DASHのXMLタグが不正です。');
    const qualified=match[1],attrs=Object.create(null);let position=qualified.length;
    if(!/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(qualified))throw fail('DASHのXML名前空間が不正です。');
    while(position<body.length) {
      const whitespace=/^\s+/.exec(body.slice(position));if(!whitespace)throw fail('DASHのXML属性の区切りが不正です。');position+=whitespace[0].length;
      if(position===body.length)break;
      const attr=/^([A-Za-z_][\w:.-]*)\s*=\s*(["'])/.exec(body.slice(position));if(!attr)throw fail('DASHのXML属性が不正です。');
      position+=attr[0].length;const close=body.indexOf(attr[2],position);if(close<0 || body.slice(position,close).includes('<'))throw fail('DASHのXML属性が不正です。');
      if(Object.hasOwn(attrs,attr[1]))throw fail('DASHのXML属性が重複しています。');
      if(!/^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/.test(attr[1]))throw fail('DASHのXML名前空間が不正です。');
      if(attr[1]==='xml:base' || /:href$/.test(attr[1]))throw fail('外部参照を使うDASHには対応していません。');
      attrs[attr[1]]=unescapeXML(body.slice(position,close));position=close+1;
    }
    if(++nodes>12000 || stack.length>=24)throw fail('DASH配信リストの構造が大きすぎます。');
    const node={name:qualified.split(':').at(-1),qualified,attrs,children:[],text:''};
    if(stack.length)stack.at(-1).children.push(node);else roots.push(node);
    if(!self)stack.push(node);
  }
  if(stack.length || roots.length!==1 || roots[0].name!=='MPD')throw fail('DASH配信リストのXML構造が不正です。');
  return roots[0];
}
const children=(node,name)=>node.children.filter(child=>child.name===name);
function single(node,name) {const found=children(node,name);if(found.length>1)throw fail(`DASHの${name}指定が重複しています。`);return found[0];}
function integer(value,{fallback,positive=false,signed=false}={}) {
  if(value===undefined && fallback!==undefined)return fallback;
  if(!(signed ? /^-?\d+$/ : /^\d+$/).test(value || ''))throw fail('DASHの数値が不正です。');
  const result=Number(value);if(!Number.isSafeInteger(result) || (!signed && result<(positive?1:0)))throw fail('DASHの数値が範囲外です。');return result;
}
function duration(value,optional=false) {
  if(value===undefined && optional)return undefined;
  const match=/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value || '');
  if(!match || !match.slice(1).some(Boolean))throw fail('DASHの再生時間を読み取れません。');
  const seconds=Number(match[1] || 0)*86400+Number(match[2] || 0)*3600+Number(match[3] || 0)*60+Number(match[4] || 0);
  if(!Number.isFinite(seconds) || seconds<0 || seconds>Number.MAX_SAFE_INTEGER)throw fail('DASHの再生時間が範囲外です。');return seconds;
}
function baseAt(node,base) {
  const options=children(node,'BaseURL');
  if(!options.length)return base;
  const first=options[0];if(first.children.length || !first.text.trim())throw fail('DASHのBaseURLが不正です。');
  return safeURL(first.text.trim(),base);
}
function supportedCodecs(type,value) {
  if(!value)return true; // The MP4 initializer supplies the authoritative sample entry.
  return value.split(',').every(item=>{
    const parts=item.trim().toLowerCase().split('.'),prefix=parts[0];
    if(type==='video')return ['avc1','avc3','hvc1','hev1','av01','vp09'].includes(prefix);
    if(['opus','ac-3','ec-3'].includes(prefix))return true;
    return prefix==='mp4a' && (parts.length===1 || (parts[1]==='40' && (parts.length===2 || (parts.length===3 && [2,5,29].includes(Number(parts[2]))))));
  });
}
function addressing(levels) {
  let result;
  for(const level of levels) {
    const entries=level.children.filter(node=>['SegmentTemplate','SegmentList','SegmentBase'].includes(node.name));
    if(entries.length>1)throw fail('DASHの区間指定が混在しています。');
    if(!entries.length)continue;
    const next=entries[0];
    if(!result || result.name!==next.name)result={name:next.name,attrs:{},timeline:undefined,init:undefined,urls:undefined};
    result.attrs={...result.attrs,...next.attrs};
    const timeline=single(next,'SegmentTimeline'),init=single(next,'Initialization'),urls=children(next,'SegmentURL');
    if(timeline)result.timeline=timeline;
    if(init)result.init=init;
    if(urls.length)result.urls=urls;
  }
  if(!result || result.name==='SegmentBase')throw fail('このDASHの区間指定には未対応です。録画を試してください。');
  if(integer(result.attrs.presentationTimeOffset,{fallback:0})!==0 || integer(result.attrs.eptDelta,{fallback:0,signed:true})!==0)throw fail('開始時刻の補正が必要なDASHには未対応です。録画を試してください。');
  return result;
}
function range(value) {
  if(value===undefined)return undefined;
  const match=/^(\d+)-(\d+)$/.exec(value);if(!match)throw fail('DASHの部分取得範囲が不正です。');
  const start=integer(match[1]),end=integer(match[2]);if(end<start)throw fail('DASHの部分取得範囲が不正です。');return {start,end};
}
function segmentTimeline(timeline,scale,periodDuration,startNumber) {
  const entries=children(timeline,'S');if(!entries.length || entries.length>SEGMENT_LIMIT || timeline.children.some(node=>node.name!=='S'))throw fail('DASHの区間時刻が空か大きすぎます。');
  const result=[];let time=0,number=startNumber;
  const endpoint=periodDuration*scale;
  if(!Number.isFinite(endpoint) || endpoint>Number.MAX_SAFE_INTEGER)throw fail('DASHの区間時刻が範囲外です。');
  for(let i=0;i<entries.length;i++) {
    const attr=entries[i].attrs,t=integer(attr.t,{fallback:time}),d=integer(attr.d,{positive:true}),repeat=integer(attr.r,{fallback:0,signed:true});
    if(t!==time)throw fail('区間時刻に隙間や重なりがあるDASHには未対応です。');
    if(repeat<-1)throw fail('DASHの繰り返し回数が不正です。');
    let count=repeat+1;
    if(repeat===-1) {
      const next=entries[i+1],limit=next ? integer(next.attrs.t) : endpoint;
      if(limit<=t || (next && (limit-t)%d!==0))throw fail('DASHの繰り返し区間が整列していません。');
      count=Math.ceil((limit-t)/d);
    }
    if(result.length+count>SEGMENT_LIMIT)throw fail('DASHの動画区間が多すぎます（最大5000区間）。');
    for(let n=0;n<count;n++) {
      if(!Number.isSafeInteger(time+d) || !Number.isSafeInteger(number))throw fail('DASHの区間時刻が範囲外です。');
      result.push({time,number,duration:d});time+=d;number++;
    }
  }
  if(time<endpoint-1 || (result.length>1 && result.at(-1).time>=endpoint))throw fail('DASHの動画区間が再生時間と一致しません。');
  return result;
}
function template(value,representation,segment) {
  if(typeof value!=='string' || !value)throw fail('DASHのURLテンプレートがありません。');
  let length=value.length;
  if(length>131072)throw urlLimit();
  const replacements={RepresentationID:representation.id,Bandwidth:representation.bandwidth,Number:segment?.number,Time:segment?.time};
  const rendered=value.replace(/\$\$|\$(RepresentationID|Bandwidth|Number|Time)(?:%0(\d+)d)?\$/g,(match,key,width)=>{
    if(match==='$$')return '\u0000';
    if(replacements[key]===undefined || (width && key==='RepresentationID'))throw fail('DASHのURLテンプレートを展開できません。');
    const padding=width ? integer(width,{positive:true}) : 0;if(padding>20)throw fail('DASHのURL数値書式が大きすぎます。');
    const replacement=String(replacements[key]).padStart(padding,'0');
    length+=replacement.length-match.length;if(length>131072)throw urlLimit();
    return replacement;
  });
  if(rendered.includes('$'))throw fail('このDASHのURLテンプレートには対応していません。');
  return rendered.replaceAll('\u0000','$');
}
function buildTrack(candidate,periodDuration) {
  const {type,representation,levels,base}=candidate,description=addressing(levels),attr=description.attrs;
  const timescale=integer(attr.timescale,{fallback:1,positive:true}),startNumber=integer(attr.startNumber,{fallback:1,positive:true});
  let timing;
  if(description.timeline)timing=segmentTimeline(description.timeline,timescale,periodDuration,startNumber);
  else if(attr.duration!==undefined) {
    const d=integer(attr.duration,{positive:true}),count=Math.ceil(periodDuration*timescale/d);
    if(!Number.isSafeInteger(count) || count<1 || count>SEGMENT_LIMIT)throw fail('DASHの動画区間が多すぎます（最大5000区間）。');
    timing=Array.from({length:count},(_,i)=>({time:i*d,number:startNumber+i,duration:d}));
    if(timing.some(entry=>!Number.isSafeInteger(entry.time) || !Number.isSafeInteger(entry.number)))throw fail('DASHの区間時刻が範囲外です。');
  }
  const variables={id:representation.attrs.id,bandwidth:representation.attrs.bandwidth};
  const segments=[];
  const keepURL=urlBudget();
  const append=segment=>{keepURL(segment.url);segments.push(segment);};
  if(description.name==='SegmentTemplate') {
    if(!timing)throw fail('DASHの動画区間の長さを読み取れません。');
    if(attr.endNumber!==undefined && integer(attr.endNumber)<timing.at(-1).number)throw fail('DASHの最終区間が再生時間より前で終わっています。');
    if(attr.initialization)append({url:safeURL(template(attr.initialization,variables),base),init:true});
    else if(description.init)append({url:safeURL(description.init.attrs.sourceURL || '',base),...(description.init.attrs.range!==undefined ? {range:range(description.init.attrs.range)} : {}),init:true});
    else throw fail('DASHのMP4初期化データがありません。');
    for(const entry of timing)append({url:safeURL(template(attr.media,variables,entry),base)});
    if(new Set(segments.slice(1).map(segment=>segment.url)).size!==timing.length)throw fail('DASHの区間URLが重複しています。');
  } else {
    if(!description.init)throw fail('DASHのMP4初期化データがありません。');
    const urls=description.urls || [];if(!urls.length || urls.length>SEGMENT_LIMIT || (timing && timing.length!==urls.length))throw fail('DASHの動画区間の件数が不正です。');
    append({url:safeURL(description.init.attrs.sourceURL || '',base),...(description.init.attrs.range!==undefined ? {range:range(description.init.attrs.range)} : {}),init:true});
    for(const node of urls) {
      if(node.attrs.index || node.attrs.indexRange)throw fail('索引が別取得のDASH区間には未対応です。');
      if(node.attrs.media===undefined && !node.attrs.mediaRange)throw fail('DASHの動画区間URLがありません。');
      append({url:safeURL(node.attrs.media || '',base),...(node.attrs.mediaRange!==undefined ? {range:range(node.attrs.mediaRange)} : {})});
    }
  }
  return {type,segments,bandwidth:Number(representation.attrs.bandwidth || 0),...(candidate.language ? {language:candidate.language} : {})};
}
async function readManifest(url,fetchResource,signal) {
  abort(signal);const response=await fetchResource(url,{signal});abort(signal);
  if(!response?.ok)throw fail(`DASH配信元から取得できません（HTTP ${Number(response?.status) || 'エラー'}）。`);
  if(response.status===206)throw fail('DASH配信リストの一部だけが返されました。保存を中断しました。');
  if(/^(text\/html|application\/(?:json|xhtml\+xml))/i.test(response.headers.get('content-type') || ''))throw fail('動画ではない応答が返されました。サイトの認証やアクセス制限を確認してください。');
  if(Number(response.headers.get('content-length'))>MANIFEST_LIMIT){await response.body?.cancel();throw fail('DASH配信リストが大きすぎます（最大1 MiB）。');}
  const reader=response.body?.getReader();if(!reader)throw fail('DASH配信リストを読み取れません。');
  const parts=[];let size=0;
  const cancel=()=>{reader.cancel().catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
  try {
    while(true){abort(signal);const {value,done}=await reader.read();abort(signal);if(done)break;
      if(!(value instanceof Uint8Array))throw fail('DASH配信データの形式が不正です。');size+=value.byteLength;if(size>MANIFEST_LIMIT)throw fail('DASH配信リストが大きすぎます（最大1 MiB）。');parts.push(value);}
  } catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally {signal?.removeEventListener('abort',cancel);reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw fail('DASH配信リストの文字コードを読み取れません。');}
  return {mpd:parseXML(text),url:response.url ? safeURL(response.url) : url};
}
export async function prepareDASH(url,fetchResource,{signal}={}) {
  const {mpd,url:manifestURL}=await readManifest(safeURL(url),fetchResource,signal);
  if(mpd.attrs.type && mpd.attrs.type!=='static')throw fail('ライブDASH配信には未対応です。録画を試してください。');
  const inspect=node=>{if(node.name==='ContentProtection')throw fail('暗号化・DRM保護されたDASHは保存できません。');for(const child of node.children)inspect(child);};inspect(mpd);
  const periods=children(mpd,'Period');if(periods.length!==1)throw fail('複数Periodを含むDASHには未対応です。録画を試してください。');
  const period=periods[0];if(duration(period.attrs.start,true) || 0)throw fail('開始時刻の補正が必要なDASHには未対応です。');
  const seconds=duration(period.attrs.duration || mpd.attrs.mediaPresentationDuration);
  if(seconds<=0)throw fail('DASHの再生時間が空です。');
  const mpdBase=baseAt(mpd,manifestURL),periodBase=baseAt(period,mpdBase),candidates=[],keepCandidateURL=urlBudget();
  const adaptations=children(period,'AdaptationSet');if(adaptations.length>500)throw fail('DASHの映像・音声候補が多すぎます。');
  for(let index=0;index<adaptations.length;index++) {
    const adaptation=adaptations[index],adaptationBase=baseAt(adaptation,periodBase);
    const components=children(adaptation,'ContentComponent'),componentTypes=[...new Set(components.map(component=>component.attrs.contentType).filter(Boolean))];
    const roles=children(adaptation,'Role').map(role=>role.attrs.value),language=adaptation.attrs.lang || adaptation.attrs['xml:lang'] || components[0]?.attrs.lang || '';
    for(const representation of children(adaptation,'Representation')) {
      if(candidates.length>=1000)throw fail('DASHの画質候補が多すぎます。');
      const attrs={...(componentTypes.length===1 ? {contentType:componentTypes[0]} : {}),...adaptation.attrs,...representation.attrs},mime=attrs.mimeType || '',codecs=attrs.codecs || '';
      const type=attrs.contentType || (/^video\//i.test(mime) || /^(?:avc[13]|hev1|hvc1|av01|vp09)/i.test(codecs) ? 'video' : /^audio\//i.test(mime) || /^(?:mp4a|ac-3|ec-3|opus)/i.test(codecs) ? 'audio' : '');
      if(!['video','audio'].includes(type))continue;
      if(attrs.bandwidth!==undefined)integer(attrs.bandwidth,{positive:true});
      const dependency=attrs.dependencyId || componentTypes.length>1 || children(adaptation,'EssentialProperty').length || children(representation,'EssentialProperty').length;
      candidates.push({type,supported:!dependency && /^(?:(?:video|audio|application)\/mp4)?$/i.test(mime) && supportedCodecs(type,codecs),representation:{...representation,attrs},levels:[period,adaptation,representation],base:keepCandidateURL(baseAt(representation,adaptationBase)),language:attrs.lang || attrs['xml:lang'] || language,index,main:roles.includes('main')});
    }
  }
  const videos=candidates.filter(candidate=>candidate.type==='video' && candidate.supported).sort((a,b)=>Number(b.representation.attrs.bandwidth || 0)-Number(a.representation.attrs.bandwidth || 0));
  if(!videos.length)throw fail('対応するMP4映像がDASH配信内にありません。');
  const firstSupported=list=>{
    let firstError;
    for(const candidate of list)try{return buildTrack(candidate,seconds);}catch(error){if(error.code==='PLAN_URL_LIMIT')throw error;firstError ||= error;}
    throw firstError || fail('対応するDASHの区間指定がありません。');
  };
  const videoTrack=firstSupported(videos);
  const preferredLanguage=mpd.attrs.lang || mpd.attrs['xml:lang'] || period.attrs.lang || period.attrs['xml:lang'] || '';
  const audios=candidates.filter(candidate=>candidate.type==='audio').sort((a,b)=>Number(b.main)-Number(a.main) || Number(b.language===preferredLanguage)-Number(a.language===preferredLanguage) || a.index-b.index || Number(b.representation.attrs.bandwidth || 0)-Number(a.representation.attrs.bandwidth || 0));
  const tracks=[videoTrack];
  if(audios.length) {
    const defaultGroup=audios[0].index,defaultLanguage=audios[0].language,eligible=audios.filter(candidate=>candidate.index===defaultGroup && candidate.language===defaultLanguage && candidate.supported);
    if(!eligible.length)throw fail('音声を欠落させないため、このDASH音声形式の保存を中断しました。');
    tracks.push(firstSupported(eligible));
  } else if(adaptations.some(adaptation=>adaptation.attrs.contentType==='audio' || /^audio\//.test(adaptation.attrs.mimeType || '') || children(adaptation,'ContentComponent').some(component=>component.attrs.contentType==='audio')))throw fail('音声を欠落させないため、このDASH音声形式の保存を中断しました。');
  if(tracks.reduce((sum,track)=>sum+track.segments.length-1,0)>SEGMENT_LIMIT)throw fail('映像と音声の区間が多すぎます（合計最大5000区間）。');
  abort(signal);return {tracks,extension:'mp4',mime:'video/mp4',duration:seconds,fromMaster:true};
}
