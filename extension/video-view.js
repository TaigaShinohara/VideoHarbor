// Presentation identity describes a page occurrence; saving still uses the full resource URL.
export function groupVideos(items,videoElements=[]) {
  const groups=new Map();
  const keyFor=source=>`${source.documentId || source.frameToken || source.frameId || 'page'}:${source.videoRef || source.configRef}`;
  const create=(key,source)=>{
    const group={id:key,title:source.title || '',source,items:[],playing:false,visible:false,linked:Boolean(source.videoRef || source.configRef),recordable:false,history:true};
    groups.set(key,group);return group;
  };
  const describe=(group,source)=>{
    group.playing ||= Boolean(source.playing);
    group.visible ||= Boolean(source.visible);
    if(!group.title && source.title)group.title=source.title;
    if(!group.duration && Number.isFinite(source.duration) && source.duration>0)group.duration=source.duration;
    if(!group.previewDataURL && /^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(source.previewDataURL || '') && source.previewDataURL.length<=32768)group.previewDataURL=source.previewDataURL;
  };
  // A recording target must be a real VIDEO in this scan. A media URL, player
  // setting or loading-history record alone cannot establish that identity.
  for(const source of videoElements) {
    if(source.elementTag!=='VIDEO' || !source.elementToken || source.videoRef!==source.elementToken || !source.frameToken || !source.documentURL)continue;
    const key=keyFor(source),group=groups.get(key) || create(key,source);
    group.source=source;group.recordable=true;group.history=false;
    describe(group,source);
  }
  for(const item of items) {
    const occurrences=item.occurrences?.length ? item.occurrences : [item];
    const linked=occurrences.filter(source=>source.videoRef || source.configRef);
    for(const source of linked.length ? linked : [occurrences[0]]) {
      const ref=source.videoRef || source.configRef;
      const key=ref ? keyFor(source) : `resource:${item.url}`;
      const group=groups.get(key) || create(key,source);
      if(!group.items.some(candidate=>candidate.url===item.url)) group.items.push(item);
      group.history &&= item.discovery==='loaded-history';
      describe(group,source);
    }
  }
  return [...groups.values()].sort((a,b)=>Number(b.playing)-Number(a.playing) || Number(b.visible)-Number(a.visible) || Number(a.history)-Number(b.history));
}

export function formatDuration(seconds) {
  if(!Number.isFinite(seconds) || seconds<=0)return '';
  if(seconds<1)return '1秒未満';
  const value=Math.floor(seconds), h=Math.floor(value/3600), m=Math.floor(value%3600/60), s=String(value%60).padStart(2,'0');
  return h ? `${h}:${String(m).padStart(2,'0')}:${s}` : `${m}:${s}`;
}
