import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,copyFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inspectText,auditRepository} from '../scripts/audit-information.mjs';

const contact='deeple+videoharborstaff@inkboxmail.com';
const provider=()=>['sk','-proj-','aB2cD3'.repeat(8)].join('');
const assignment=value=>['api_','key = ',JSON.stringify(value)].join('');
const internalLink=()=>['https://','app.','notion.com/p/','0'.repeat(32)].join('');
const findings=entries=>entries.filter(entry=>entry.classification==='finding');
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'videoharbor-information-audit-test-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'};
  const git=(...args)=>execFileSync('git',['-C',root,...args],{env,stdio:['pipe','pipe','pipe']});
  git('init','--quiet');git('config','user.name','VideoHarbor Staff');git('config','user.email',contact);
  const write=(path,content)=>{const parts=path.split('/');parts.pop();mkdirSync(join(root,...parts),{recursive:true});writeFileSync(join(root,path),content);};
  const commit=message=>{git('add','--all');git('commit','--quiet','-m',message);};
  write('README.md','Synthetic repository fixture\n');commit('initial fixture');
  return {root,git,write,commit,env};
}

test('information audit detects strong credentials without returning values or snippets',()=>{
  const jwt=[Buffer.from(JSON.stringify({alg:'HS256'})).toString('base64url'),Buffer.from(JSON.stringify({sub:'SyntheticPerson'})).toString('base64url'),'ABcd12'.repeat(8)].join('.');
  const samples=[
    ['private-key',['-----BEGIN ','PRIVATE KEY-----'].join('')],
    ['provider-credential',['AK','IA','Q1'.repeat(8)].join('')],
    ['provider-credential',['gh','p_','A1'.repeat(20)].join('')],
    ['provider-credential',provider()],['provider-credential',['xox','b-','A1-'.repeat(10)].join('')],
    ['provider-credential',['AI','za','A1'.repeat(18)].join('')],['jwt',jwt],
    ['literal-credential',assignment('Vh'+ 'UnlistedSensitiveValue42')],
  ];
  for(const [rule,value] of samples) {
    const result=inspectText(value,{path:'extension/fixture.js'});
    assert.ok(findings(result).some(entry=>entry.rule===rule),`${rule} must be detected`);
    assert.ok(!JSON.stringify(result).includes(value),'result contains only location metadata');
    assert.ok(result.every(entry=>!('value' in entry) && !('snippet' in entry)));
  }
});

test('information audit preserves bounded synthetic fixtures, hashes and the approved contact',()=>{
  const source=[
    'https://cdn.test/fixture.mp4?token=synthetic',
    'https://name:password@media.invalid/fixture.mp4',
    '/Users/example/Downloads/fixture.mp4',
    'fixture@example.test',contact,
    'sha512-'+Buffer.alloc(64,7).toString('base64'),
    '00000000-0000-4000-8000-000000000001',
  ].join('\n');
  const result=inspectText(source,{path:'tests/example.test.js'});
  assert.equal(findings(result).length,0);
  assert.ok(result.some(entry=>entry.classification==='synthetic-fixture'));
  assert.ok(result.some(entry=>entry.classification==='approved-contact'));
});

test('information audit does not exempt test files, real hosts or unrecognized dummy-looking values',()=>{
  const value=provider();
  assert.ok(findings(inspectText(value,{path:'tests/example.test.js'})).some(entry=>entry.rule==='provider-credential'));
  const realURL=['https://service.com/fixture.mp4','token=synthetic'].join('?');
  assert.ok(findings(inspectText(realURL,{path:'tests/example.test.js'})).some(entry=>entry.rule==='url-sensitive-query'));
  assert.ok(findings(inspectText('https://cdn.test/fixture.mp4?token='+'LongUnlistedOpaqueValue42',{path:'tests/example.test.js'})).some(entry=>entry.rule==='url-sensitive-query'));
  assert.ok(findings(inspectText('https://cdn.test/a.mp4?token=synthetic '+realURL,{path:'tests/example.test.js'})).some(entry=>entry.rule==='url-sensitive-query'));
  assert.ok(findings(inspectText('/Users/'+'SyntheticPerson/private',{path:'tests/example.test.js'})).some(entry=>entry.rule==='personal-path'));
});

test('information audit separates an exact historical document baseline from current leaks and historical credentials',()=>{
  const source=internalLink();
  assert.equal(findings(inspectText(source,{path:'docs/UX-COMPLETION.md'})).length,1);
  assert.equal(inspectText(source,{path:'docs/UX-COMPLETION.md',history:true})[0].classification,'legacy-reference');
  assert.equal(findings(inspectText(source,{path:'extension/fixture.js',history:true})).length,1);
  assert.ok(findings(inspectText(provider(),{path:'docs/UX-COMPLETION.md',history:true})).some(entry=>entry.rule==='provider-credential'));
});

test('information audit fails current untracked credentials and reports paths and lines without secret values',t=>{
  const h=fixture(t),value=provider();h.write('untracked.js','// fixture\n'+assignment(value));
  const report=auditRepository(h.root);
  assert.equal(report.ok,false);assert.equal(report.coverage.untrackedFiles,1);
  assert.ok(report.results.some(entry=>entry.stage==='current' && entry.path==='untracked.js' && entry.line===2 && entry.rule==='provider-credential'));
  assert.ok(!JSON.stringify(report).includes(value));
});

test('information audit scans unreachable blobs and commit messages, while reporting legacy references separately',t=>{
  const h=fixture(t);h.write('docs/UX-COMPLETION.md',internalLink());h.commit('legacy documentation fixture');
  rmSync(join(h.root,'docs/UX-COMPLETION.md'));h.commit('remove current internal link');
  const value=provider();
  const oid=execFileSync('git',['-C',h.root,'hash-object','-w','--stdin'],{input:value,env:h.env,stdio:['pipe','pipe','pipe']}).toString().trim();
  h.git('commit','--allow-empty','--quiet','-m','fixture '+value);
  const report=auditRepository(h.root);
  assert.equal(report.ok,false);
  assert.ok(report.results.some(entry=>entry.classification==='legacy-reference' && entry.stage==='history'));
  assert.ok(report.results.some(entry=>entry.object===oid && entry.rule==='provider-credential' && entry.classification==='finding'));
  assert.ok(report.results.some(entry=>entry.path==='[commit-message]' && entry.rule==='provider-credential'));
  assert.ok(!JSON.stringify(report).includes(value));
});

test('information audit fails unknown private commit email without printing it',t=>{
  const h=fixture(t),email=['private.person','@','mail-provider.com'].join('');
  h.git('-c','user.email='+email,'commit','--allow-empty','--quiet','-m','metadata fixture');
  const report=auditRepository(h.root);
  assert.equal(report.ok,false);assert.ok(report.results.some(entry=>entry.stage==='metadata' && entry.classification==='finding'));
  assert.ok(!JSON.stringify(report).includes(email));
});

test('information audit inventories ignored secrets without following files or scanning dependency copyrights',t=>{
  const h=fixture(t);h.write('.gitignore','.env\nnode_modules/\n');
  symlinkSync(join(h.root,'nonexistent-private-target'),join(h.root,'.env'));
  h.write('node_modules/example/LICENSE',['Copyright contributor ','public.person','@','mail-provider.com'].join(''));
  const report=auditRepository(h.root);
  assert.equal(report.ok,false);assert.equal(report.coverage.dependencyIgnoredFiles,1);
  assert.ok(report.results.some(entry=>entry.stage==='ignored' && entry.path==='.env' && entry.rule==='ignored-first-party-file'));
  assert.ok(!report.results.some(entry=>entry.path==='node_modules/example/LICENSE'));
});

test('information audit CLI uses exit status and emits only value-free structured output',t=>{
  const h=fixture(t),value=provider();h.write('extension/example.js',assignment(value));
  mkdirSync(join(h.root,'scripts'));
  copyFileSync(new URL('../scripts/audit-information.mjs',import.meta.url),join(h.root,'scripts/audit-information.mjs'));
  const run=spawnSync(process.execPath,[join(h.root,'scripts/audit-information.mjs')],{encoding:'utf8',env:h.env});
  assert.equal(run.status,1);assert.equal(run.stderr,'');assert.ok(!run.stdout.includes(value));
  const report=JSON.parse(run.stdout);assert.equal(report.ok,false);assert.equal(report.coverage.complete,true);
});

test('information audit accepts a clean repository with staff metadata and records its limitations',t=>{
  const h=fixture(t),report=auditRepository(h.root);
  assert.equal(report.ok,true);assert.equal(report.coverage.complete,true);assert.equal(report.coverage.gitCommits,1);
  assert.equal(report.classifications['staff-identity'],2);assert.ok(report.limitations.length>=4);
});
