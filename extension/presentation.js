// Full source identities stay in this module's memory; DOM IDs reveal no URL parts.
export class PresentationIds {
  constructor(prefix) { this.prefix=prefix;this.sequence=0;this.byKey=new Map();this.byId=new Map(); }
  id(key) {
    if(!this.byKey.has(key)) {
      const id=`${this.prefix}-${++this.sequence}`;
      this.byKey.set(key,id);this.byId.set(id,key);
    }
    return this.byKey.get(key);
  }
  key(id) { return this.byId.get(id); }
  knownId(key) { return this.byKey.get(key); }
  retain(keys) {
    const live=new Set(keys);
    for(const [key,id] of this.byKey)if(!live.has(key)){this.byKey.delete(key);this.byId.delete(id);}
  }
}

export const resources=new PresentationIds('source');
export const videoReferences=new PresentationIds('video');
export const referenceKey=ref=>JSON.stringify([ref.documentId || ref.frameId || 0,ref.frameToken,ref.elementToken,ref.documentURL]);
export const videoReferenceId=ref=>videoReferences.id(referenceKey(ref));
export const candidateLabel=url=>`保存元 ${resources.id(url).slice('source-'.length)}`;
export const displayText=value=>String(value ?? '').replace(/(?:https?|blob|data):\S+/gi,'[URL]');
export function videoGroupLabels(groups) {
  let unnamed=0;
  return groups.map(group=>({...group,label:displayText(group.title) || (group.linked ? `ページ上の動画 ${++unnamed}` : '内容を確認できていない候補')}));
}
export function sourceHost(url) {
  try { const parsed=new URL(url);return /^https?:$/.test(parsed.protocol) ? parsed.hostname : 'ページ内データ'; }
  catch { return '配信元未確認'; }
}
