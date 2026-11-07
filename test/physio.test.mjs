// The D′ and DFA panels render against the demo athlete, the empty state, and a run with RR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/store.js';
import { importGarmin } from '../js/ingest.js';
import { demoGarminPayload, demoExtras } from '../js/demo.js';
import * as D from '../js/derive.js';
import { dprimePanel, dfaPanel, dfaSummary } from '../js/physio.js';

const BAD = /\bundefined\b|\bNaN\b|\[object Object\]/;
const clean = (out, what) => {
  const m = String(out).match(new RegExp('.{0,80}(' + BAD.source + ').{0,80}'));
  assert.ok(!m, what + ' leaks: ' + (m && m[0]));
};
let ready = null;
function demo() {
  return ready || (ready = (async () => {
    await store.loadState();
    const r = await importGarmin(store.state, demoGarminPayload(), store.putStream);
    const x = demoExtras();
    for (const k of Object.keys(x)) Object.assign(store.state[k], x[k]);
    await D.deriveAll(store.state, r.streams);
  })());
}

test('demo runs: both panels render', async () => {
  await demo();
  for (const a of D.runs(store.state).slice(0, 3)) {
    const dp = String(await dprimePanel(a.id));
    clean(dp, 'dprime');
    assert.match(dp, /D′ balance/);
    const df = String(await dfaPanel(a.id));
    clean(df, 'dfa');
    assert.match(df, /Log HRV/);   // the demo logs no RR
  }
});

test('a run with RR data: alpha1 and a threshold', async () => {
  await demo();
  const id = D.runs(store.state)[0].id;
  const rec = await store.getStream(id);
  // a beat series covering the run: easy (correlated) to hard (white)
  let s = 11; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const g = () => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
  const rr = []; let walk = 0;
  const T = rec.channels.seconds[rec.channels.seconds.length - 1];
  for (let t = 0; t < T;) {
    const f = t / T, mean = 60000 / (120 + 50 * f);
    walk = 0.9 * walk + g();
    const x = mean + 0.02 * mean * ((1 - f) * walk / 2.3 + f * g());
    rr.push(Math.round(x)); t += x / 1000;
  }
  const withRR = { ...rec, hrv_rr: rr };
  const out = String(await dfaPanel(id, withRR));
  clean(out, 'dfa with rr');
  assert.match(out, /alpha1/);
  assert.doesNotMatch(out, /Log HRV/);
  const sum = dfaSummary(withRR);
  assert.ok(sum && sum.windows > 0);
  assert.equal(dfaSummary(rec), null);
});

test('empty state: no throw, no leaks', async () => {
  const { emptyState } = await import('../js/merge.js');
  const saved = store.state;
  store.replaceState(emptyState());
  try {
    assert.equal(String(await dprimePanel('nope')), '');
    assert.equal(String(await dfaPanel('nope')), '');
  } finally { store.replaceState(saved); }
});
