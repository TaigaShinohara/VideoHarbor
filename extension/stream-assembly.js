import { downloadHLS, downloadHLSParts } from './hls.js';
import { muxFragmentedMP4 } from './mp4-mux.js';

// Preserve compressed packets and timing without codecs or runtime libraries.
export async function assembleStream(plan,fetchResource,{signal,onProgress,maxBytes=268435456}={}) {
  if(!plan.tracks)return downloadHLS(plan,fetchResource,{signal,onProgress,maxBytes});
  if(!Array.isArray(plan.tracks) || !plan.tracks.length || plan.tracks.length>2)throw new Error('配信トラックの構成に未対応です。');
  const total=plan.tracks.reduce((n,track)=>n+track.segments.length,0);
  if(total>5002)throw new Error('映像と音声の区間が多すぎます。');
  let bytesReceived=0,completed=0;
  const tracks=[];
  for(const track of plan.tracks) {
    signal?.throwIfAborted();
    const startBytes=bytesReceived,startCompleted=completed;
    const parts=await downloadHLSParts({...track,extension:'mp4'},fetchResource,{signal,maxBytes:maxBytes-bytesReceived,onProgress:progress=>{
      bytesReceived=startBytes+progress.bytesReceived;completed=startCompleted+progress.completed;
      onProgress?.({bytesReceived,completed,total});
    }});
    tracks.push({type:track.type,init:parts[0],segments:parts.slice(1)});
  }
  signal?.throwIfAborted();
  return muxFragmentedMP4(tracks,{maxBytes});
}
