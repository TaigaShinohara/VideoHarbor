import {fileLabel,extensionOf} from './utils.js';
import {originPattern} from './media-save.js';
import {groupVideos,formatDuration} from './video-view.js';
import {originalExtension} from './output-format.js';

export function renderVideoGroups({state,element,icon,statusElement,onSave,onRecord,onLocate,onFramePermission,onLocateFrame,formatOptions,formatValue,onFormatChange}) {
  const $=id=>document.getElementById(id), supported=item=>['direct','hls','dash','blob'].includes(item.type);
  const groups=groupVideos(state.items), known=groups.filter(group=>group.linked).length;
  const direct=state.items.filter(supported), other=state.items.filter(item=>!supported(item));
  $('count').textContent=`${known ? `${known}本の動画 · ` : ''}${direct.length}件の保存候補`;
  $('direct-list').replaceChildren();$('unsupported-list').replaceChildren();
  let videoNumber=0,formatIndex=0;
  for(const group of groups) {
    const section=element('section','video-group');
    const heading=element('div','video-group-heading'), description=element('div','video-identity');
    const name=group.title || (group.linked ? `ページ上の動画 ${++videoNumber}` : '内容を確認できていない候補');
    description.append(element('h3','video-title',name));
    const facts=[];
    if(group.playing)facts.push('再生中');
    if(group.duration)facts.push(formatDuration(group.duration));
    if(group.items.length>1)facts.push(`${group.items.length}種類の保存元`);
    if(!group.linked)facts.push(group.history ? '読み込み記録 · 現在の動画との対応は未確認' : 'ページ上の動画との対応は未確認');
    if(facts.length)description.append(element('p','meta',facts.join(' · ')));
    if(group.previewDataURL) {
      const image=element('img','video-snapshot');image.src=group.previewDataURL;image.alt='元ページ上の動画の一場面';
      heading.append(image);
    }
    heading.append(description);
    const sourceTag=group.source.elementTag;
    const locatable=group.source.locatable===true && sourceTag && !['SCRIPT','META','LINK','SOURCE'].includes(sourceTag);
    if(locatable && group.source.elementToken && group.source.frameToken) {
      const locate=element('button','secondary locate-source',group.source.videoRef ? '元ページで確認' : sourceTag==='A' ? '元リンクを確認' : '出典の場所を確認');
      locate.setAttribute('aria-label',`${name}の元ページの出典を確認`);
      locate.addEventListener('click',()=>onLocate(group.items[0],group.source));heading.append(locate);
    }
    section.append(heading);
    let alternatives;
    for(const [itemIndex,item] of group.items.entries()) {
      const card=element('article','video-card'),info=element('div','video-info');
      const format=item.type==='direct' ? (originalExtension(item) || extensionOf(item.url,'videos')).toUpperCase() : item.type==='blob' ? 'ページ内動画' : item.type.toUpperCase();
      const fileIcon=element('div','file-icon');fileIcon.setAttribute('aria-hidden','true');fileIcon.append(icon('file'),element('span','',format));
      info.append(element('h4','file-name',fileLabel(item.url)));
      let host='ページ内データ';try{host=new URL(item.url).hostname || host;}catch{}
      info.append(element('p','meta',`${format} · ${host}${item.width && item.height ? ` · ${item.width} × ${item.height}` : ''}`),statusElement(item));
      const details=element('details','url-detail');details.append(element('summary','','詳細'),element('p','meta',item.url.length>500 ? item.url.slice(0,500)+'…' : item.url));
      const notes={hls:'HLSをファイルにまとめます。単独リストでは別配信の音声を判別できません。',dash:'DASHの映像・音声を対応するMP4にまとめます。',blob:'元ファイル型のページ内動画を取得します。分割再生用blobは未対応です。'};
      if(notes[item.type])details.append(element('p','hint',`${notes[item.type]} 最大256 MiB。`));
      info.append(details);
      const sites=element('p','hint permission-sites');sites.dataset.url=item.url;sites.hidden=true;info.append(sites);
      if(supported(item) && formatOptions) {
        const select=element('select','output-format');select.dataset.url=item.url;select.id=`format-${formatIndex++}`;
        const options=formatOptions(item);
        for(const option of options) {const node=element('option','',option.label);node.value=option.value;node.disabled=Boolean(option.disabled);select.append(node);}
        select.value=formatValue(item,options);
        select.setAttribute('aria-label',`${name} · ${fileLabel(item.url)}の保存形式`);
        select.addEventListener('change',()=>onFormatChange(item,select));
        const choice=element('div','format-choice'),label=element('label','','保存形式');label.htmlFor=select.id;choice.append(label,select);info.append(choice);
        const reason=options.find(option=>option.value==='mp4')?.reason;
        if(reason) {const hint=element('p','hint format-hint',reason);hint.id=`${select.id}-hint`;select.setAttribute('aria-describedby',hint.id);details.append(hint);}
      }
      const actions=element('div','candidate-actions');
      const button=element('button',supported(item) ? `primary ${item.type==='direct' ? 'direct-save' : 'media-save'}` : 'secondary');button.dataset.url=item.url;
      button.append(icon(supported(item) ? 'download' : 'record'),document.createTextNode(supported(item) ? '保存' : '録画へ'));
      button.setAttribute('aria-label',`${name} · ${fileLabel(item.url)}${supported(item) ? 'を保存' : 'の録画設定へ'}`);
      button.addEventListener('click',()=>supported(item) ? onSave(item) : onRecord());actions.append(button);
      const result=element('div','candidate-result');result.dataset.url=item.url;actions.append(result);
      card.append(fileIcon,info,actions);
      if(itemIndex===0)section.append(card);
      else {
        if(!alternatives) {alternatives=element('details','source-alternatives');alternatives.append(element('summary','',`ほかの保存元（${group.items.length-1}件）`));section.append(alternatives);}
        alternatives.append(card);
      }
    }
    $(group.items.some(supported) ? 'direct-list' : 'unsupported-list').append(section);
  }
  $('empty').hidden=direct.length>0;$('record-fallback').hidden=!direct.length;
  $('unsupported').hidden=!other.length;$('unsupported-count').textContent=`(${other.length}件)`;
  $('frame-sites').replaceChildren();$('frame-access').hidden=!(state.frames || []).length;
  for(const [index,frame] of (state.frames || []).entries()) {
    let origin;try{origin=originPattern(frame.url);}catch{continue;}
    const card=element('article','embed-card'),title=frame.title || `ページ内の埋め込み ${index+1}`;
    card.append(element('h3','video-title',title),element('p','hint',`${new URL(origin).hostname} の埋め込みを調べます。許可の範囲はこのサイトです。`));
    const actions=element('div','actions');
    if(frame.locatable && frame.elementToken && frame.frameToken) {const locate=element('button','secondary','元ページで確認');locate.addEventListener('click',()=>onLocateFrame(frame));actions.append(locate);}
    if(!frame.locatable)card.append(element('p','hint','埋め込み先の情報です。ページ上の表示位置は未確認です。'));
    const allow=element('button','secondary frame-permission','このサイトを許可して探す');
    allow.setAttribute('aria-label',`${title} · ${new URL(origin).hostname} を許可して探す`);allow.addEventListener('click',()=>onFramePermission(origin,allow));actions.append(allow);card.append(actions);$('frame-sites').append(card);
  }
  $('previous-candidates').hidden=!(state.previousItems || []).length;
  $('previous-list').replaceChildren();
  for(const item of state.previousItems || []) $('previous-list').append(element('li','',item.title || fileLabel(item.url)));
}
