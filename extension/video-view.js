// A full resource URL appears once; proven page occurrences connect alternative sources.
export function groupVideos(items,videoElements=[]) {
  const groups=new Map();
  const keyFor=source=>`${source.documentId || source.frameToken || source.frameId || 'page'}:${source.videoRef || source.configRef}`;
  const create=key=>{
    const group={order:groups.size,items:new Map(),sources:[],current:[]};
    group.parent=group;groups.set(key,group);return group;
  };
  const root=group=>{
    while(group.parent!==group) {group.parent=group.parent.parent;group=group.parent;}
    return group;
  };
  const resources=new Map();
  for(const item of items) {
    let resource=resources.get(item.url);
    if(!resource) {resource={item,records:new Set(),occurrences:new Set()};resources.set(item.url,resource);}
    resource.records.add(item);
    for(const source of item.occurrences?.length ? item.occurrences : [item]) resource.occurrences.add(source);
  }
  // A recording target must be a real VIDEO in this scan. A media URL, player
  // setting or loading-history record alone cannot establish that identity.
  for(const source of videoElements) {
    if(source.elementTag!=='VIDEO' || !source.elementToken || source.videoRef!==source.elementToken || !source.frameToken || !source.documentURL)continue;
    const key=keyFor(source),group=groups.get(key) || create(key);
    group.current.push(source);
  }
  const owners=new Map();
  for(const {item,records,occurrences:allOccurrences} of resources.values()) {
    const occurrences=[...allOccurrences];
    const candidate=records.size===1 ? item : {...item,occurrences};
    const linked=occurrences.filter(source=>source.videoRef || source.configRef);
    for(const source of linked.length ? linked : [occurrences[0]]) {
      const ref=source.videoRef || source.configRef;
      const key=ref ? keyFor(source) : `resource:${item.url}`;
      const group=groups.get(key) || create(key);
      group.items.set(item.url,candidate);group.sources.push(source);
      // Join overlapping source groups by their exact URL, including its query.
      const owner=owners.get(item.url);
      if(owner) {
        const first=root(owner),second=root(group);
        if(first!==second) {
          if(first.order<second.order)second.parent=first;
          else first.parent=second;
        }
      } else owners.set(item.url,group);
    }
  }
  const combined=new Map();
  for(const group of groups.values()) {
    const key=root(group);
    let target=combined.get(key);
    if(!target) {target={items:new Map(),sources:[],current:[]};combined.set(key,target);}
    for(const [url,item] of group.items)target.items.set(url,item);
    target.sources.push(...group.sources);target.current.push(...group.current);
  }
  const priority=source=>(source.playing ? 16 : 0)+(source.visible ? 8 : 0)+(source.videoRef ? 4 : 0)+(source.configRef ? 2 : 0)+(source.locatable ? 1 : 0);
  const result=[];
  for(const group of combined.values()) {
    // Keep recording and descriptive metadata on the same current element. A
    // hidden/config occurrence must not donate its title or preview to another.
    const sources=group.current.length ? group.current : group.sources;
    const source=sources.reduce((best,next)=>priority(next)>priority(best) ? next : best);
    const candidates=[...group.items.values()];
    // Legacy sessions locate a saved occurrence through the first resource URL.
    const primary=group.current.length ? -1 : candidates.findIndex(item=>item===source || item.occurrences?.includes(source));
    if(primary>0)candidates.unshift(candidates.splice(primary,1)[0]);
    const output={id:source.videoRef || source.configRef ? keyFor(source) : `resource:${candidates[0].url}`,
      title:source.title || '',source,items:candidates,
      playing:sources.some(entry=>entry.playing),visible:sources.some(entry=>entry.visible),
      linked:Boolean(source.videoRef || source.configRef),recordable:group.current.length>0,
      history:!group.current.length && candidates.every(item=>item.discovery==='loaded-history')};
    if(Number.isFinite(source.duration) && source.duration>0)output.duration=source.duration;
    if(/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(source.previewDataURL || '') && source.previewDataURL.length<=32768)output.previewDataURL=source.previewDataURL;
    result.push(output);
  }
  return result.sort((a,b)=>Number(b.playing)-Number(a.playing) || Number(b.visible)-Number(a.visible) || Number(a.history)-Number(b.history));
}

export function formatDuration(seconds) {
  if(!Number.isFinite(seconds) || seconds<=0)return '';
  if(seconds<1)return '1秒未満';
  const value=Math.floor(seconds), h=Math.floor(value/3600), m=Math.floor(value%3600/60), s=String(value%60).padStart(2,'0');
  return h ? `${h}:${String(m).padStart(2,'0')}:${s}` : `${m}:${s}`;
}
