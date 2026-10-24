// Every page renders against the demo athlete without throwing, and without leaking
// undefined / NaN / [object Object] into the markup. Run: npm test (or this file alone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import * as store from '../js/store.js';
import { importGarmin } from '../js/ingest.js';
import { demoGarminPayload, demoExtras } from '../js/demo.js';
import * as D from '../js/derive.js';

const pages = readdirSync(new URL('../js/pages/', import.meta.url)).filter(f => f.endsWith('.js'));
let ready = null;
async function demo() {
  if (ready) return ready;
  ready = (async () => {
    await store.loadState();
    const r = await importGarmin(store.state, demoGarminPayload(), store.putStream);
    const x = demoExtras();
    for (const k of Object.keys(x)) Object.assign(store.state[k], x[k]);
    await D.deriveAll(store.state, r.streams);
    store.save('demo');
  })();
  return ready;
}
// Detail pages need an id: the newest run, the first race.
function paramsFor(name) {
  if (name === 'activity') return [{ id: D.runs(store.state)[0].id }, { id: D.activities(store.state).find(a => !D.runs(store.state).includes(a))?.id || D.runs(store.state)[1].id }];
  if (name === 'race') return D.races(store.state).map(r => ({ id: r.id }));
  return [{}];
}
const BAD = /\bundefined\b|\bNaN\b|\[object Object\]/;
for (const f of pages) {
  const name = f.replace(/\.js$/, '');
  test('page renders: ' + name, async () => {
    await demo();
    const mod = await import('../js/pages/' + f);
    for (const params of paramsFor(name)) {
      const out = String(await mod.render(params));
      assert.ok(out.length > 100, name + ' rendered almost nothing');
      const m = out.match(new RegExp('.{0,80}(' + BAD.source + ').{0,80}'));
      assert.ok(!m, name + ' leaks: ' + (m && m[0]));
    }
  });
}
test('empty state renders too', async () => {
  // A fresh device: every page must say something sensible with no data.
  const { emptyState } = await import('../js/merge.js');
  const saved = store.state;
  store.replaceState(emptyState());
  try {
    for (const f of pages) {
      const mod = await import('../js/pages/' + f);
      const out = String(await mod.render({ id: 'nope' }));
      assert.ok(!BAD.test(out), f + ' leaks on empty state');
    }
  } finally { store.replaceState(saved); }
});
