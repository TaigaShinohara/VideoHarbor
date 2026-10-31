// Development-only, loopback-only manual QA fixture. No extension APIs are mocked.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

let scratch, server, closing;
const nonce=randomBytes(18).toString('base64');
async function cleanup() {
  if (closing) return closing;
  closing=(async()=>{
    if (server?.listening) {
      const closed=new Promise(resolve=>server.close(resolve));
      server.closeAllConnections();
      await closed;
    }
    if (scratch) await rm(scratch,{recursive:true,force:true});
  })();
  return closing;
}
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{
  cleanup().then(()=>process.exit(0),()=>process.exit(1));
});

function generateClip(name, color, frequency) {
  const filter=[
    'drawbox=x=108:y=134:w=100:h=7:color=0xcbd2dc:t=fill',
    `drawbox=x=199:y=72:w=30:h=42:color=${color}:t=7`,
    `drawbox=x=112:y=58:w=90:h=76:color=${color}:t=fill`,
    'drawbox=x=117:y=62:w=80:h=5:color=white@0.7:t=fill',
    "drawbox=x=132:y=29:w=5:h=19:color=0xa6b1c0:t=fill:enable='lt(mod(t,1),0.5)'",
    "drawbox=x=168:y=22:w=5:h=23:color=0xa6b1c0:t=fill:enable='gte(mod(t,1),0.5)'",
    'drawbox=x=20:y=157:w=280:h=6:color=0xd9e0e9:t=fill',
    ...[0,1,2,3,4].map(i=>`drawbox=x=${20+i*56}:y=157:w=54:h=6:color=${color}:t=fill:enable='gte(t,${i*0.6})'`),
  ].join(',');
  const result=spawnSync('ffmpeg',[
    '-hide_banner','-loglevel','error','-nostdin','-y',
    '-f','lavfi','-i','color=c=0xf4f7fb:s=320x180:r=15:d=3',
    '-f','lavfi','-i',`sine=frequency=${frequency}:sample_rate=48000`,
    '-t','3','-vf',filter,'-map','0:v:0','-map','1:a:0',
    '-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','6','-b:v','90k','-pix_fmt','yuv420p','-threads','1','-filter_threads','1',
    '-c:a','libopus','-b:a','32k',join(scratch,`${name}.webm`),
  ],{encoding:'utf8',maxBuffer:1024*1024,timeout:20000});
  if (result.error?.code === 'ENOENT') throw new Error('既存のffmpegが見つかりません。ffmpegを利用できる環境で実行してください。');
  if (result.status !== 0) throw new Error(`合成動画の生成に失敗しました。${(result.stderr || result.error?.message || '').slice(0,400)}`);
}
function video(name,title,alternatives=false) {
  return `<video controls loop preload="metadata" title="${title}" aria-label="${title}" width="320" height="180"><source src="/clip.webm?item=${name}" type="video/webm">${alternatives ? `<source src="/alternative.webm?item=${name}" type="video/webm">` : ''}</video>`;
}
function page(port,embedded=false) {
  const style='body{font:17px/1.65 system-ui,sans-serif;max-width:1000px;margin:24px auto;padding:0 18px;color:#1d2b3f;background:#fafcff}h1{font-size:1.7rem}h2{font-size:1.15rem}main{display:flex;flex-wrap:wrap;gap:28px}figure{margin:0}video{max-width:100%;height:auto;background:#e9eef5}iframe{display:block;width:min(100%,440px);height:330px;border:2px solid #8a9ab1;border-radius:10px}button{font:inherit;padding:10px 16px;cursor:pointer}p{max-width:75ch}.note{padding:12px;background:#e9f0fc}';
  const body=embedded ? `<h1>別ホストの埋め込み</h1><p>緑のカップ・880 Hz。localhost側の動画です。</p>${video('green','緑のカップ（別ホストの埋め込み）')}` : `
    <h1>VideoHarbor 本人確認用ページ</h1>
    <p class="note">合成動画だけを使うローカル確認です。音は小さめから再生してください。各動画は約3秒で繰り返します。自動再生はしません。</p>
    <p>青と赤は同じ配信元・同じファイル名 <code>clip.webm</code> で、queryだけが異なります。青には同じ動画を指す代替sourceがあります。</p>
    <main>
      <figure><h2>青のカップ · 440 Hz</h2>${video('blue','青のカップ',true)}<figcaption>青いカップと点滅する湯気。保存結果の見分けに使います。</figcaption></figure>
      <figure id="second"><h2 id="second-title">赤のカップ · 660 Hz</h2>${video('red','赤のカップ')}<figcaption id="second-caption">赤を再生後、下のボタンで別の動画へ差し替えられます。</figcaption></figure>
    </main>
    <p><button id="replace" type="button">赤を新しい動画へ差し替える</button></p><p id="replacement-status" role="status">現在は青と赤です。</p>
    <h2>別ホストの埋め込み</h2><p>本体は127.0.0.1、埋め込みはlocalhostです。両方ともこのMacの同じサーバーを使います。追加サイト許可の拒否と再試行に使います。</p>
    <iframe title="緑のカップを含むlocalhostの埋め込み" src="http://localhost:${port}/embedded"></iframe>
    <script nonce="${nonce}">
      let replaced=false;
      document.querySelector('#replace').addEventListener('click',()=>{
        const old=document.querySelector('#second video');old.pause();
        replaced=!replaced;
        const current=document.createElement('video');
        current.controls=true;current.loop=true;current.preload='metadata';current.width=320;current.height=180;
        current.title=replaced ? '新しい緑のカップ（差し替え後）' : '赤のカップ';current.setAttribute('aria-label',current.title);
        const source=document.createElement('source');source.src='/clip.webm?item='+(replaced ? 'green' : 'red');source.type='video/webm';current.append(source);old.replaceWith(current);
        document.querySelector('#second-title').textContent=replaced ? '新しい緑のカップ · 880 Hz' : '赤のカップ · 660 Hz';
        document.querySelector('#replace').textContent=replaced ? '赤の動画へ戻す' : '赤を新しい動画へ差し替える';
        document.querySelector('#replacement-status').textContent=replaced ? '赤のvideo要素を削除し、新しい緑のvideo要素に替えました。拡張で再スキャンしてください。' : '青と赤に戻しました。拡張で再スキャンしてください。';
      });
    </script>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${embedded ? '緑のカップの埋め込み' : 'VideoHarbor 本人確認用 fixture'}</title><style nonce="${nonce}">${style}</style></head><body>${body}</body></html>`;
}

try {
  scratch=await mkdtemp(join(tmpdir(),'videoharbor-ux-fixture-'));
  generateClip('blue','0x236bd4',440);generateClip('red','0xd54444',660);generateClip('green','0x23935a',880);
  const clips=new Map(await Promise.all(['blue','red','green'].map(async name=>[name,await readFile(join(scratch,`${name}.webm`))])));
  let port;
  server=createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    if (!['GET','HEAD'].includes(req.method)) {res.writeHead(405,{Allow:'GET, HEAD'});return res.end();}
    if (![ `127.0.0.1:${port}`,`localhost:${port}` ].includes(req.headers.host)) {res.writeHead(403);return res.end();}
    let url;try {url=new URL(req.url,'http://127.0.0.1');} catch {res.writeHead(400);return res.end();}
    if (url.pathname==='/' || url.pathname==='/embedded') {
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; media-src 'self'; frame-src http://localhost:${port}; connect-src 'none'; base-uri 'none'; form-action 'none'`);
      return res.end(req.method==='HEAD' ? undefined : page(port,url.pathname==='/embedded'));
    }
    if (url.pathname==='/clip.webm' || url.pathname==='/alternative.webm') {
      const clip=clips.get(url.searchParams.get('item'));
      if (!clip) {res.writeHead(404);return res.end();}
      let start=0,end=clip.length-1;
      if (req.headers.range) {
        const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
        if (!range || !Number.isSafeInteger(Number(range[1])) || (range[2] && !Number.isSafeInteger(Number(range[2])))) {res.writeHead(416,{'Content-Range':`bytes */${clip.length}`});return res.end();}
        start=Number(range[1]);end=range[2] ? Math.min(Number(range[2]),end) : end;
        if (start>end || start>=clip.length) {res.writeHead(416,{'Content-Range':`bytes */${clip.length}`});return res.end();}
        res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${clip.length}`);
      }
      res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Type','video/webm');res.setHeader('Content-Length',end-start+1);
      return res.end(req.method==='HEAD' ? undefined : clip.subarray(start,end+1));
    }
    res.writeHead(404);res.end();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  port=server.address().port;
  console.log(`VideoHarbor 本人確認: http://127.0.0.1:${port}/`);
  console.log('終了は Ctrl+C。一時生成した合成動画だけを削除します。保存した確認ファイルは残ります。');
} catch (error) {
  console.error(error.message);await cleanup();process.exitCode=1;
}
