// Local, value-free information audit. No network requests or third-party code.
import {execFileSync} from 'node:child_process';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const CONTACT='deeple+videoharborstaff@inkboxmail.com';
const MAX_FILE_BYTES=32*1024*1024;
const legacyReferences=new Map([
  ['docs/UX-COMPLETION.md',new Set(['internal-document-link'])],
  ['docs/SECURITY-VALIDATION-2026-10-31.md',new Set(['personal-github-reference'])],
]);
const officialOwners=new Set(['microsoft','google','chromium','nodejs','whatwg','w3c','web-platform-tests','npmcli','github','actions']);
const rules=[
  ['private-key',/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g],
  ['provider-credential',/\b(?:(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,})\b/g],
  ['jwt',/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ['literal-credential',/\b(?:api[_-]?key|secret[_-]?key|(?:aws[_-])?secret[_-]?access[_-]?key|client[_-]?secret|github[_-]?token|password|passwd|access[_-]?token|refresh[_-]?token|authorization|cookie)["']?\s*[:=]\s*["']([^"'\n]{4,})["']/gi],
  ['url-userinfo',/https?:\/\/([^\s/<>"'`:]+):([^\s/<>"'`]+)@[^\s<>"'`]+/gi],
  ['url-sensitive-query',/[?&](?:token|access_token|api_key|key|secret|password|signature|sig|x-amz-signature|x-amz-credential)=([^&#\s"'<>`]+)/gi],
  ['email',/(?<![\w.+-])[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ['personal-path',/\/(?:Users|home)\/[^/\s"'`]+|[A-Za-z]:\\Users\\[^\\\s"'`]+/g],
  ['internal-document-link',/https?:\/\/(?:app\.)?notion\.(?:com|so)\/[^\s"'<>`]+|https?:\/\/docs\.google\.com\/[^\s"'<>`]+/g],
  ['personal-github-reference',/https?:\/\/github\.com\/([A-Za-z0-9_-]+)\/[^\s"'<>`]*/g],
];

function fixturePath(path) {return /^(?:tests\/[^/]+\.(?:test\.js|mjs)|scripts\/ux-fixture\.mjs)$/.test(path);}
function reservedHost(host) {return /^(?:localhost|127\.0\.0\.1|\[::1\]|(?:[^.]+\.)*(?:test|invalid|example)|(?:[^.]+\.)*example\.(?:com|org|net))$/i.test(host);}
function fixtureValue(value) {
  return /^(?:synthetic(?:[-_a-z0-9]+)?|dummy(?:[-_a-z0-9]+)?|test(?:[-_a-z0-9]+)?|fixture(?:[-_a-z0-9]+)?|example|fake|unused|none|secret|pass|user|cookie|name|password|u|p|one|two|private|value|token)$/i.test(value)
    || /^\$\{[^}]+\}$/.test(value);
}
function classification(rule,match,text,path,history) {
  if(rule==='email' && match[0].toLowerCase()===CONTACT) return 'approved-contact';
  if(rule==='email' && path==='scripts/audit-information.mjs' && match[0]==='noreply@github.com')return 'github-service-constant';
  const fixture=fixturePath(path) || history && path==='[unmapped-blob]' && /import\s+test\s+from\s+['"]node:test['"]/.test(text);
  if(fixture) {
    if(rule==='email' && reservedHost(match[0].split('@')[1])) return 'synthetic-fixture';
    if(rule==='personal-path' && /^(?:\/(?:Users|home)\/(?:example|\.example)|[A-Za-z]:\\Users\\(?:example|\.example))$/.test(match[0])) return 'synthetic-fixture';
    if(rule==='literal-credential' && fixtureValue(match[1])) return 'synthetic-fixture';
    if(rule==='url-sensitive-query' && fixtureValue(match[1])) {
      const start=text.lastIndexOf('\n',match.index)+1,end=text.indexOf('\n',match.index);
      const line=text.slice(start,end<0 ? undefined : end);
      // A reserved fixture origin or a relative fixture manifest is required;
      // a real host with a merely dummy-looking token is not an exception.
      const at=match.index-start;
      const enclosing=[...line.matchAll(/https?:\/\/[^\s"'`<>]+/gi)].find(m=>m.index<=at && m.index+m[0].length>at);
      if(enclosing) {
        try {if(reservedHost(new URL(enclosing[0]).hostname))return 'synthetic-fixture';} catch {}
      } else if(/(?:\b|\.)(?:mp4|m3u8|mpd|ts|m4v|m4s)$/.test(line.slice(0,at))) return 'synthetic-fixture';
    }
    if(rule==='url-userinfo') {
      try {if(reservedHost(new URL(match[0]).hostname) && fixtureValue(match[1]) && fixtureValue(match[2]))return 'synthetic-fixture';} catch {}
    }
  }
  if(rule==='personal-path' && /^\/(?:Users|home)\/\$\{/.test(match[0])) return 'dynamic-path-template';
  if(rule==='personal-github-reference' && officialOwners.has(match[1].toLowerCase()))return 'public-source-reference';
  if(history && legacyReferences.get(path)?.has(rule))return 'legacy-reference';
  return 'finding';
}

// Matches never leave this function: findings contain locations and rule IDs.
export function inspectText(text,{path='[unknown]',object,history=false}={}) {
  const findings=[];
  for(const [rule,pattern] of rules) {
    pattern.lastIndex=0;
    for(const match of text.matchAll(pattern)) {
      findings.push({path,rule,line:text.slice(0,match.index).split('\n').length,
        ...(object ? {object} : {}),classification:classification(rule,match,text,path,history)});
    }
  }
  return findings;
}

function git(root,args,options={}) {
  try {return execFileSync('git',['-C',root,...args],{maxBuffer:128*1024*1024,stdio:['pipe','pipe','pipe'],...options});}
  catch {throw new Error('git-read-failed');}
}
const paths=buffer=>buffer.toString('utf8').split('\0').filter(Boolean);
function addLocation(report,stage,entry) {
  report.results.push({stage,...entry});
  const category=entry.classification || 'finding';
  report.classifications[category]=(report.classifications[category] || 0)+1;
  if(category==='finding')report.failures++;
}
const sensitiveFile=path=>/(?:^|\/)\.env(?:\.(?!example$)[^/]+)?$|\.(?:pem|key|p12|pfx|keystore|mp4|webm|mov|mkv|mp3|wav|png|jpe?g|gif|pdf|zip)$/i.test(path);
function identityCategory(email,name) {
  if(email.toLowerCase()===CONTACT && name==='VideoHarbor Staff')return 'staff-identity';
  if(/^[^\s@]+@users\.noreply\.github\.com$/i.test(email))return 'github-noreply-identity';
  if(email.toLowerCase()==='noreply@github.com' && name==='GitHub')return 'github-service-identity';
  return 'finding';
}

export function auditRepository(root) {
  root=resolve(root);
  const report={version:1,rules:rules.map(([name])=>name),coverage:{complete:true,currentFiles:0,untrackedFiles:0,ignoredFiles:0,dependencyIgnoredFiles:0,gitObjects:0,gitBlobs:0,gitCommits:0},
    failures:0,classifications:{},results:[],limitations:[
      'Pattern and context review cannot prove absence of unknown or obfuscated secrets.',
      'Ignored nondependency files are inventoried by name; their private contents are not opened.',
      'Development dependencies under node_modules are inventoried and excluded from first-party content scanning.',
      'Git covers every object available locally, including unreachable objects; remote-only deleted refs, other clones and backups are outside coverage.',
      'A clean working tree does not remove legacy references or identities from Git history.',
    ]};
  const tracked=paths(git(root,['ls-files','-z']));
  const untracked=paths(git(root,['ls-files','--others','--exclude-standard','-z']));
  report.coverage.untrackedFiles=untracked.length;
  for(const path of new Set([...tracked,...untracked])) {
    let stat;
    try {stat=lstatSync(join(root,path));} catch(error) {
      // A deliberately deleted tracked file is absent from the current product;
      // its previous contents are still examined by the Git object scan.
      if(error.code==='ENOENT')addLocation(report,'current',{path,rule:'tracked-file-absent',classification:'absent-current-file'});
      else {report.coverage.complete=false;addLocation(report,'current',{path,rule:'file-not-reviewed',classification:'finding'});}
      continue;
    }
    report.coverage.currentFiles++;
    if(sensitiveFile(path))addLocation(report,'current',{path,rule:'sensitive-file-review',classification:'finding'});
    if(!stat.isFile() || stat.size>MAX_FILE_BYTES) {
      report.coverage.complete=false;addLocation(report,'current',{path,rule:stat.isSymbolicLink() ? 'symlink-not-followed' : 'file-not-reviewed',classification:'finding'});continue;
    }
    const data=readFileSync(join(root,path));
    if(data.includes(0))addLocation(report,'current',{path,rule:'binary-file-review',classification:'finding'});
    for(const entry of inspectText(data.toString('utf8'),{path}))addLocation(report,'current',entry);
  }
  for(const path of paths(git(root,['ls-files','--others','--ignored','--exclude-standard','-z']))) {
    report.coverage.ignoredFiles++;
    if(path.startsWith('node_modules/')) {report.coverage.dependencyIgnoredFiles++;continue;}
    addLocation(report,'ignored',{path,rule:'ignored-first-party-file',classification:path.endsWith('/.DS_Store') || path==='.DS_Store' ? 'os-metadata' : 'finding'});
  }
  const objects=git(root,['cat-file','--batch-all-objects','--batch-check=%(objectname) %(objecttype) %(objectsize)']).toString('utf8').trim().split('\n').filter(Boolean).map(line=>line.split(' '));
  report.coverage.gitObjects=objects.length;
  const objectPaths=new Map();
  // Walk every local commit, including unreachable commits, so fixture and
  // legacy exceptions remain tied to actual historical paths, never all blobs.
  for(const [oid,type] of objects) if(type==='commit') {
    for(const entry of paths(git(root,['ls-tree','-r','-z',oid]))) {
      const tab=entry.indexOf('\t'),header=entry.slice(0,tab).split(' '),path=entry.slice(tab+1);
      if(header[1]==='blob') {
        const existing=objectPaths.get(header[2]) || new Set();existing.add(path);objectPaths.set(header[2],existing);
      }
    }
  }
  for(const [oid,type,size] of objects) {
    if(!['blob','commit'].includes(type))continue;
    if(Number(size)>MAX_FILE_BYTES) {
      report.coverage.complete=false;addLocation(report,'history',{object:oid,rule:'object-not-reviewed',classification:'finding'});continue;
    }
    const data=git(root,['cat-file',type,oid]);
    if(type==='blob') {
      report.coverage.gitBlobs++;
      const knownPaths=[...(objectPaths.get(oid) || ['[unmapped-blob]'])];
      if(data.includes(0))addLocation(report,'history',{object:oid,rule:'binary-blob-review',classification:'finding'});
      for(const path of knownPaths) {
        if(sensitiveFile(path))addLocation(report,'history',{path,object:oid,rule:'sensitive-file-review',classification:'finding'});
        for(const entry of inspectText(data.toString('utf8'),{path,object:oid,history:true}))addLocation(report,'history',entry);
      }
    } else {
      report.coverage.gitCommits++;
      const text=data.toString('utf8'),split=text.indexOf('\n\n');
      for(const entry of inspectText(split<0 ? '' : text.slice(split+2),{path:'[commit-message]',object:oid,history:true}))addLocation(report,'history',entry);
      for(const role of ['author','committer']) {
        const match=new RegExp(`^${role} (.*?) <([^>]*)>`, 'm').exec(text);
        const category=match ? identityCategory(match[2],match[1]) : 'finding';
        // Known account metadata is a count, not another list of identities.
        if(category==='finding')addLocation(report,'metadata',{object:oid,rule:`git-${role}-identity`,classification:category});
        else report.classifications[category]=(report.classifications[category] || 0)+1;
      }
    }
  }
  report.ok=report.failures===0 && report.coverage.complete;
  return report;
}

let isMain=false;
try {isMain=Boolean(process.argv[1]) && import.meta.url===pathToFileURL(realpathSync(resolve(process.argv[1]))).href;} catch {}
if(isMain) {
  try {
    const root=fileURLToPath(new URL('../',import.meta.url));
    const report=auditRepository(root);process.stdout.write(JSON.stringify(report,null,2)+'\n');process.exitCode=report.ok ? 0 : 1;
  } catch {
    process.stdout.write(JSON.stringify({ok:false,coverage:{complete:false},failures:1,results:[{rule:'audit-execution-failed'}]})+'\n');process.exitCode=1;
  }
}
