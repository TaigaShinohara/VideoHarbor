// Test-only unpacked extension bootstrap. Chrome 116 uses the CLI loader;
// current Chrome uses CDP even when CHROME_EXECUTABLE is set globally.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

export async function launchTestExtension(chromium,profile,extension,options={}) {
  const executable=process.env.CHROME_EXECUTABLE;
  let major;
  if(executable) {
    const version=spawnSync(executable,['--version'],{encoding:'utf8',timeout:10000});
    assert.equal(version.status,0,version.error?.message||version.stderr);
    major=Number(version.stdout.match(/\b(\d+)\./)?.[1]);
    assert.ok(Number.isSafeInteger(major),'the selected Chrome executable reports a version');
  }
  const legacy=Boolean(executable&&major<=116),{args=[],...rest}=options;
  const runtimeArgs=legacy ? ['--headless=new',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`] : ['--enable-unsafe-extension-debugging'];
  const context=await chromium.launchPersistentContext(profile,{
    ...rest,
    ...(executable ? {executablePath:executable,headless:!legacy} : {channel:process.env.CHROME_CHANNEL||'chrome',headless:true}),
    args:[...args.filter(arg=>arg!=='--enable-unsafe-extension-debugging'),...runtimeArgs,'--disable-background-networking','--disable-component-update'],
  });
  try {
    const browserSession=await context.browser().newBrowserCDPSession();
    let id,worker;
    if(legacy) {
      worker=context.serviceWorkers().find(worker=>worker.url().endsWith('/background.js'));
      if(!worker)worker=await context.waitForEvent('serviceworker',{predicate:worker=>worker.url().endsWith('/background.js'),timeout:15000});
      id=new URL(worker.url()).hostname;
    } else {
      ({id}=await browserSession.send('Extensions.loadUnpacked',{path:extension}));
      worker=context.serviceWorkers().find(worker=>worker.url().includes(id));
      if(!worker)worker=await context.waitForEvent('serviceworker',{predicate:worker=>worker.url().includes(id)});
    }
    // Chrome 116 can report its worker before extension bindings and the test
    // entry appended after module initialization are ready.
    await worker.evaluate(async()=>{
      for(let tries=0;tries<500;tries++) {
        if(globalThis.chrome?.runtime?.id&&typeof chrome.tabs?.query==='function'&&typeof globalThis.__openWorkspace==='function')return;
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      throw new Error('The extension background module did not become ready.');
    });
    return {context,browserSession,id,worker,legacy};
  } catch(error) {await context.close();throw error;}
}
