import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateLocator} from './privacy-browser-helpers.mjs';

test('browser candidate lookup waits for a resolved ID when a scan finishes after the first async probe',async()=>{
  let probes=0;
  const manager={
    // Model Playwright's async-predicate behavior: a Promise can be truthy even
    // when the value eventually returned by jsonValue is still undefined.
    waitForFunction:async()=>({jsonValue:async()=>undefined,dispose:async()=>{}}),
    evaluate:async()=>++probes<3 ? undefined : 'source-7',
    locator:selector=>selector,
  };
  const selector=await candidateLocator(manager,'https://fixture.test/synthetic.mp4','button.media-save,button.direct-save');
  assert.equal(probes,3,'the helper waited for the delayed scan result');
  assert.equal(selector,'button.media-save[data-candidate-id="source-7"],button.direct-save[data-candidate-id="source-7"]');
  assert.equal(selector.includes('undefined'),false,'no selector is constructed from an unresolved ID');
});
