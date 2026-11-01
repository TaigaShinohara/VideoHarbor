import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';

// Test code resolves synthetic source URLs through the same module instance.
// Production DOM attributes contain only the resulting opaque IDs.
export async function candidateLocator(manager,url,selector='.video-card') {
  // waitForFunction treats an async predicate's Promise as truthy before its
  // resolved value is checked. Await each probe here so a slower scan cannot
  // turn an unresolved resource into a literal "undefined" selector.
  const deadline=Date.now()+15000;
  while(Date.now()<deadline) {
    const id=await manager.evaluate(async url=>{
      const {resources}=await import(chrome.runtime.getURL('presentation.js'));
      return resources.knownId(url);
    },url);
    if(typeof id==='string' && /^source-\d+$/.test(id))return manager.locator(selector.split(',').map(part=>`${part}[data-candidate-id="${id}"]`).join(','));
    await delay(25);
  }
  assert.fail('the synthetic source did not acquire an opaque candidate ID before the timeout');
}

export async function candidateCount(manager,url,selector='.video-card') {
  return manager.evaluate(async({url,selector})=>{
    const {resources}=await import(chrome.runtime.getURL('presentation.js'));
    const id=resources.knownId(url);
    return id ? document.querySelectorAll(selector.split(',').map(part=>`${part}[data-candidate-id="${id}"]`).join(',')).length : 0;
  },{url,selector});
}

export async function assertPrivateDOM(manager,markers) {
  const result=await manager.evaluate(markers=>{
    const values=[document.documentElement.textContent,...[...document.querySelectorAll('*')].flatMap(node=>
      [...[...node.attributes].map(attribute=>attribute.value),...('value' in node ? [String(node.value)] : [])])];
    return {leaked:markers.some(marker=>values.some(value=>value.includes(marker))),rawURLAttributes:document.querySelectorAll('[data-url]').length,
      privateReferenceValues:[...document.querySelectorAll('#record-video option')].some(option=>option.value && !/^video-\d+$/.test(option.value))};
  },markers);
  assert.equal(result.leaked,false,'synthetic URL markers are absent from DOM text, attributes and form values');
  assert.equal(result.rawURLAttributes,0,'source URLs never serve as DOM operation IDs');
  assert.equal(result.privateReferenceValues,false,'recording selector values reveal no document URLs');
}
