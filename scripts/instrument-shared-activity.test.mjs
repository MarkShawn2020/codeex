import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SHARED_ACTIVITY_INSTRUMENTATION_MARKER,
  instrumentSharedActivity,
} from './instrument-shared-activity.mjs';

const fixture = [
  'function markRecent(e,t,n){let c=new Map(e.get(recentAtom));c.set(t,n),e.set(recentAtom,c)}',
  'function activity(e,t){registry.get(e.node)?.stop();let n=new Map,r=new Set;',
  'for(let{item:n}of readItems(e.get,t))n.kind===`task`&&r.add(n.threadEntry.key);',
  'registry.set(e.node,{archivedItemsById:n,stop:e.watch(({get:l})=>{',
  'let h=readItems(l,t).find(({item:e})=>e.kind===`task`);',
  'if(h?.item.kind===`task`){markRecent(e,h.item.threadEntry.key,h.recencyAt);return}})})}',
  'function stopActivity(e){registry.get(e.node)?.stop(),registry.delete(e.node),e.set(active,null),e.set(recentAtom,new Map)}',
  'function clearRead(e,t){let n=e.get(active);n?.sidebarMode===t&&batch(e,e=>{',
  'e.set(recentAtom,new Map),e.set(active,{...n,items:n.items.filter(n=>visible(e.get,n,t))})})}',
].join('');

test('wires the native activity coordinator to the shared Codeex watermark runtime', () => {
  const result = instrumentSharedActivity(fixture);
  assert.equal(result.activityCoordinators, 1);
  assert.equal(result.clearHandlers, 1);
  assert.match(result.code, /__CODEEX_SHARED_ACTIVITY__\?\.attach/);
  assert.match(result.code, new RegExp(SHARED_ACTIVITY_INSTRUMENTATION_MARKER));
  assert.match(result.code, /__CODEEX_SHARED_ACTIVITY__\?\.detach/);
  assert.match(result.code, /__CODEEX_SHARED_ACTIVITY__\?\.markAllSeen/);
  const repeated = instrumentSharedActivity(result.code);
  assert.equal(repeated.activityCoordinators, 0);
  assert.equal(repeated.code, result.code);
});

