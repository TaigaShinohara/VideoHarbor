// Presentation identity describes a page occurrence; saving still uses the full resource URL.
export function groupVideos(items) {
  const groups=new Map();
  for(const item of items) {
    const occurrences=item.occurrences?.length ? item.occurrences : [item];
    const linked=occurrences.filter(source=>source.videoRef || source.configRef);
    for(const source of linked.length ? linked : [occurrences[0]]) {
      const ref=source.videoRef || source.configRef;
      const key=ref ? `${source.documentId || source.frameToken || source.frameId || 'page'}:${ref}` : `resource:${item.url}`;
      let group=groups.get(key);
      if(!group) {
        group={id:key,title:source.title || '',source,items:[],playing:false,visible:false,linked:Boolean(ref),history:true};
        groups.set(key,group);
      }
      if(!group.items.some(candidate=>candidate.url===item.url)) group.items.push(item);
      group.playing ||= Boolean(source.playing);
      group.visible ||= Boolean(source.visible);
      group.history &&= item.discovery==='loaded-history';
      if(!group.title && source.title)group.title=source.title;
      if(!group.duration && Number.isFinite(source.duration) && source.duration>0)group.duration=source.duration;
      if(!group.previewDataURL && /^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(source.previewDataURL || '') && source.previewDataURL.length<=32768)group.previewDataURL=source.previewDataURL;
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
