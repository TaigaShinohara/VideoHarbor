// Local-only network security integration test. All credentials/media are synthetic.
// Only an extension copy and disposable Chrome profile receive fixture permissions.
// TLS certificate exceptions apply to that profile; the host trust store is untouched.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer as httpServer} from 'node:http';
import {createServer as httpsServer} from 'node:https';
import {spawnSync} from 'node:child_process';
import {launchTestExtension} from './chrome-runtime.mjs';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const scratch=await mkdtemp(join(tmpdir(),'videoharbor-network-qa-'));
const extension=join(scratch,'extension'),downloadFolder=join(scratch,'downloads');
const hosts=['a.vh.test','b.vh.test','c.other.test'];
const permitted=new Set([...hosts,'denied.test']);
const cookieNames=['plain','lax','strict','none','secure','httpOnly'];
const observations=[],requests=[];
let context,http,https,sequence=0;
const watchdog=setTimeout(()=>{void context?.close();},90000);
watchdog.unref();
const id=label=>`${label}-${++sequence}`;
const pattern=(scheme,host)=>`${scheme}://${host}/*`;
const cookieState=header=>Object.fromEntries(cookieNames.map(name=>[name,new RegExp(`(?:^|;\\s*)vh_${name}=`).test(header || '')]));
const received=key=>requests.filter(item=>item.id===key);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function fixture(req,res) {
  let url;
  try {url=new URL(req.url,`${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`);} catch {res.writeHead(400);return res.end();}
  if(!permitted.has(url.hostname)){res.writeHead(403);return res.end();}
  const evidence={id:url.searchParams.get('id'),host:url.hostname,https:Boolean(req.socket.encrypted),method:req.method,
    cookies:cookieState(req.headers.cookie),authorization:Boolean(req.headers.authorization),referer:Boolean(req.headers.referer),range:req.headers.range==='bytes=2-5'};
  // Keep presence bits only, never Cookie/Authorization/Referer values.
  requests.push(evidence);
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(req.headers.origin) {res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Access-Control-Allow-Credentials','true');}
  if(req.method==='OPTIONS'){res.setHeader('Access-Control-Allow-Headers','Authorization, Range');res.writeHead(204);return res.end();}
  if(url.pathname==='/set-cookies') {
    res.setHeader('Set-Cookie',[
      'vh_plain=synthetic; Path=/',
      'vh_lax=synthetic; Path=/; SameSite=Lax',
      'vh_strict=synthetic; Path=/; SameSite=Strict',
      'vh_none=synthetic; Path=/; Secure; SameSite=None',
      'vh_secure=synthetic; Path=/; Secure; SameSite=Lax',
      'vh_httpOnly=synthetic; Path=/; HttpOnly; SameSite=Lax',
    ]);
  }
  if(url.pathname==='/redirect') {
    const status=Number(url.searchParams.get('status')),target=new URL(url.searchParams.get('to'));
    if(![301,302,303,307,308].includes(status) || !permitted.has(target.hostname)) {res.writeHead(400);return res.end();}
    res.writeHead(status,{Location:target.href});return res.end();
  }
  if(url.pathname==='/status') {res.writeHead(Number(url.searchParams.get('status')));return res.end('synthetic status');}
  if(url.pathname==='/auth') {
    if(!req.headers.authorization){res.writeHead(401,{'WWW-Authenticate':'Basic realm="VideoHarbor synthetic"'});return res.end('synthetic authentication required');}
  }
  if(url.pathname==='/range') {
    if(!evidence.range){res.writeHead(416);return res.end();}
    res.writeHead(206,{'Content-Type':'video/mp4','Content-Range':'bytes 2-5/8','Content-Length':'4'});return res.end('2345');
  }
  if(url.pathname==='/download') {
    res.writeHead(200,{'Content-Type':'video/mp4','Content-Disposition':'attachment; filename="synthetic.mp4"'});
    return res.end(Buffer.from([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0]));
  }
  if(['/probe','/auth'].includes(url.pathname)) {res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(evidence));}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><title>Local synthetic network fixture</title><h1>VideoHarbor network fixture</h1>');
}

async function listen(server) {await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});return server.address().port;}
async function close(server) {if(!server)return;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}

try {
  await mkdir(downloadFolder);
  const certificate=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=VideoHarbor synthetic fixture',
    '-keyout',join(scratch,'fixture-key.pem'),'-out',join(scratch,'fixture-cert.pem')],{encoding:'utf8',timeout:15000});
  assert.equal(certificate.status,0,'temporary synthetic certificate can be created');
  http=httpServer(fixture);https=httpsServer({key:await readFile(join(scratch,'fixture-key.pem')),cert:await readFile(join(scratch,'fixture-cert.pem'))},fixture);
  const httpPort=await listen(http),httpsPort=await listen(https);
  const origin=(scheme,host)=>`${scheme}://${host}:${scheme==='https' ? httpsPort : httpPort}`;
  const url=(scheme,host,path,key)=>`${origin(scheme,host)}${path}${path.includes('?') ? '&' : '?'}id=${key}`;
  await cp(fileURLToPath(new URL('../extension',import.meta.url)),extension,{recursive:true});
  const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
  // These concrete synthetic grants exist only in this generated test copy.
  manifest.host_permissions=hosts.flatMap(host=>['http','https'].map(scheme=>pattern(scheme,host)));
  await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
  await writeFile(join(extension,'network-test.html'),'<!doctype html><meta charset="utf-8"><title>Isolated network test</title><script type="module" src="network-test.js"></script>');
  await writeFile(join(extension,'network-test.js'),"import {MediaSaver} from './media-save.js'; globalThis.networkSaver=new MediaSaver({readBlob:async()=>{throw new Error('No blob fixture');}}); globalThis.networkReady=true;\n");
  await mkdir(join(scratch,'profile','Default'),{recursive:true});
  await writeFile(join(scratch,'profile','Default','Preferences'),JSON.stringify({download:{default_directory:downloadFolder,prompt_for_download:false,directory_upgrade:true},profile:{block_third_party_cookies:false}}));
  await writeFile(join(extension,'background.js'),(await readFile(join(extension,'background.js'),'utf8'))+'\nglobalThis.__openWorkspace=openWorkspace;\n');
  const launched=await launchTestExtension(chromium,join(scratch,'profile'),extension,{
    acceptDownloads:false,ignoreDefaultArgs:['--disable-extensions'],
    ignoreHTTPSErrors:true,httpCredentials:{username:'synthetic',password:'synthetic-only',origin:origin('https','a.vh.test')},
    args:['--enable-unsafe-extension-debugging','--no-first-run','--no-proxy-server','--ignore-certificate-errors',
      '--host-resolver-rules=MAP *.vh.test 127.0.0.1, MAP *.other.test 127.0.0.1, MAP denied.test 127.0.0.1'],
  });
  context=launched.context;
  context.setDefaultTimeout(15000);
  const {id:extensionId,legacy}=launched;
  const manager=await context.newPage();await manager.goto(`chrome-extension://${extensionId}/network-test.html`);await manager.waitForFunction(()=>globalThis.networkReady);
  const session=await context.newCDPSession(manager);
  const {targetInfo}=await session.send('Target.getTargetInfo');
  await session.send('Browser.setDownloadBehavior',{behavior:'default',eventsEnabled:true,...(!legacy && targetInfo.browserContextId ? {browserContextId:targetInfo.browserContextId} : {})});
  const page=await context.newPage();
  // Install only synthetic cookies through actual HTTP response headers.
  for(const host of hosts) await page.goto(origin('https',host)+'/set-cookies');
  const saverFetch=(target,options={})=>manager.evaluate(async({target,options})=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
    try {const response=await globalThis.networkSaver.fetchResource(target,{...options,signal:controller.signal});return {ok:true,status:response.status,body:await response.text()};}
    catch(error){return {ok:false,permission:Array.isArray(error.origins),aborted:error.name==='AbortError'};}
    finally {clearTimeout(timer);}
  },{target,options});
  const denied=id('ungranted');const deniedResult=await saverFetch(url('https','denied.test','/probe',denied));
  assert.equal(deniedResult.permission,true);assert.equal(received(denied).length,0,'ungranted host is never contacted');
  observations.push({case:'host-grant gate',pass:true});
  for(const scheme of ['http','https'])for(const host of hosts) {
    const key=id('cookie'),result=await saverFetch(url(scheme,host,'/probe',key));assert.equal(result.status,200);
    const evidence=JSON.parse(result.body);assert.equal(evidence.referer,false);assert.equal(evidence.authorization,false);
    assert.equal(evidence.cookies.httpOnly,true,'HttpOnly is sent by the browser without script cookie reads');
    assert.equal(evidence.cookies.lax,true);assert.equal(evidence.cookies.strict,true,'granted extension requests use Chrome same-site cookie treatment');
    assert.equal(evidence.cookies.secure,scheme==='https');assert.equal(evidence.cookies.none,scheme==='https');
    observations.push({case:'extension cookie matrix',scheme,host,cookies:evidence.cookies,authorization:evidence.authorization,referer:evidence.referer});
  }
  // Regular page controls distinguish same-site and cross-site from extension grants.
  await page.goto(origin('https','a.vh.test')+'/');
  for(const host of hosts) {
    const key=id('page-control'),target=url('https',host,'/probe',key);
    const evidence=await page.evaluate(async target=>{const response=await fetch(target,{credentials:'include'});return response.json();},target);
    if(host==='c.other.test')assert.equal(evidence.cookies.strict,false,'cross-site page fetch does not send Strict cookies');
    else assert.equal(evidence.cookies.strict,true,'same-site page fetch sends Strict cookies');
    observations.push({case:'page cookie control',site:host==='c.other.test' ? 'cross-site' : 'same-site',cookies:evidence.cookies});
  }
  for(const status of [401,403]) {
    const key=id('status'),result=await saverFetch(url('https','b.vh.test',`/status?status=${status}`,key));assert.equal(result.status,status);
    assert.equal(received(key).every(row=>!row.authorization && !row.referer),true);
  }
  const range=id('range'),rangeResult=await saverFetch(url('https','a.vh.test','/range',range),{range:{start:2,end:5}});
  assert.equal(rangeResult.status,206);assert.equal(rangeResult.body,'2345');assert.equal(received(range).at(-1).range,true);
  observations.push({case:'HTTP status and range',statuses:[401,403,206],pass:true});
  // Basic-auth cache behavior is a browser-owned observation, with origin-bound credentials.
  const seed=id('auth-seed');await page.goto(url('https','a.vh.test','/auth',seed));assert.equal(received(seed).some(row=>row.authorization),true);
  for(const host of ['a.vh.test','b.vh.test','c.other.test']) {
    // A challenge at an unconfigured origin can invoke a native auth prompt.
    // Probe other origins without a challenge; native auth dialogs remain manual QA.
    const key=id('auth'),result=await saverFetch(url('https',host,host==='a.vh.test' ? '/auth' : '/probe',key));
    if(host!=='a.vh.test'){assert.equal(result.status,200);assert.equal(received(key).some(row=>row.authorization),false,'auth is not given to another origin');}
    else assert.ok([200,401].includes(result.status),'browser may scope an auth cache differently for extension fetch');
    observations.push({case:'browser Basic-auth cache',host,status:result.status,authorization:received(key).some(row=>row.authorization)});
  }
  for(const status of [301,302,303,307,308])for(const host of hosts) {
    const from=id('redirect-from'),to=id('redirect-to'),destination=url('https',host,'/probe',to);
    const redirect=url('https','a.vh.test',`/redirect?status=${status}&to=${encodeURIComponent(destination)}`,from);
    const result=await saverFetch(redirect);assert.equal(result.ok,false);assert.equal(received(from).length,1);assert.equal(received(to).length,0,'fetch redirect:error never contacts target');
    observations.push({case:'stream redirect blocked',status,target:host,pass:true});
  }
  // Chrome downloads are a separate browser networking path, not fetchResource.
  async function directDownload(target,label) {
    const downloadId=await manager.evaluate(async({target,label})=>chrome.downloads.download({url:target,filename:`VideoHarbor-network/${label}.mp4`,saveAs:false,conflictAction:'uniquify'}),{target,label});
    for(let count=0;count<100;count++) {
      const [item]=await manager.evaluate(id=>chrome.downloads.search({id}),downloadId);
      if(item?.state==='complete') {assert.equal(item.exists,true);assert.ok(item.filename.startsWith(downloadFolder+'/'));return;}
      if(item?.state==='interrupted')assert.fail(`synthetic Chrome download interrupted: ${item.error || 'unknown'}`);
      await sleep(50);
    }
    assert.fail('synthetic Chrome download reached terminal state within deadline');
  }
  for(const status of [301,302,303,307,308])for(const host of ['a.vh.test','b.vh.test','c.other.test']) {
    const from=id('download-from'),to=id('download-to'),destination=url('https',host,'/download',to);
    await directDownload(url('https','a.vh.test',`/redirect?status=${status}&to=${encodeURIComponent(destination)}`,from),`redirect-${status}-${host}`);
    assert.equal(received(to).length,1,'Chrome direct download follows its own redirect policy');
    if(host!=='a.vh.test')assert.equal(received(to).some(row=>row.authorization),false,'no cross-origin Authorization transfer');
    observations.push({case:'direct download redirect observed',status,target:host,sourceAuthorization:received(from).some(row=>row.authorization),targetAuthorization:received(to).some(row=>row.authorization),targetReferer:received(to).some(row=>row.referer),targetCookies:received(to).at(-1).cookies});
  }
  console.log(JSON.stringify({suite:'VideoHarbor local network security',browser:context.browser().version(),pass:true,
    nativePermissionDialogs:false,personalProfile:false,network:'synthetic loopback HTTP/HTTPS only',observations},null,2));
} finally {
  clearTimeout(watchdog);
  await context?.close();await close(http);await close(https);await rm(scratch,{recursive:true,force:true});
}
