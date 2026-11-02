import {readFile,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('extension/manifest.json',root),'utf8'));
assert.equal(manifest.manifest_version,3);
assert.equal(manifest.background.type,'module');
assert.ok(!manifest.host_permissions && !manifest.content_scripts && !manifest.externally_connectable);
assert.ok(!manifest.permissions.some(x=>['debugger','webRequest','history','cookies','tabs'].includes(x)));
assert.deepEqual(manifest.optional_host_permissions,['https://*/*','http://*/*'],'Site access must remain optional, never a required grant');
for(const icons of [manifest.icons,manifest.action.default_icon]) {
  for(const [size,path] of Object.entries(icons)) {
    const png=await readFile(new URL('extension/'+path,root));
    assert.ok(png.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),`${path}: expected PNG`);
    assert.equal(png.readUInt32BE(16),Number(size),`${path}: icon width`);
    assert.equal(png.readUInt32BE(20),Number(size),`${path}: icon height`);
  }
}
const html=await readFile(new URL('extension/workspace.html',root),'utf8');
assert.ok(!/<script[^>]*>\s*[^<\s]/i.test(html),'Inline scripts are forbidden');
for(const m of html.matchAll(/(?:src|href)="([^"#]+)"/g)) {
  assert.ok(!/^https?:/i.test(m[1]),'No remote executable UI assets');
  await readFile(new URL('extension/'+m[1],root));
}
for(const name of await readdir(new URL('extension/',root))) {
  if(!name.endsWith('.js'))continue;
  const path=new URL(`extension/${name}`,root);
  const result=spawnSync(process.execPath,['--check',path.pathname],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const source=await readFile(path,'utf8');
  for(const m of source.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) await readFile(new URL(m[1],path));
  for(const m of source.matchAll(/new URL\(['"](\.\/[^'"]+)['"],\s*import\.meta\.url\)/g)) await readFile(new URL(m[1],path));
}
for(const path of ['workspace.html','workspace.css',manifest.background.service_worker]) await readFile(new URL('extension/'+path,root));
console.log(`${manifest.name}: manifest, permissions, PNG icons, local UI/module references and JavaScript syntax OK`);
