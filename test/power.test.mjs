import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/lib/power.js';

const steady = (n, w, hr = null) => ({ seconds: Array.from({ length: n }, (_, i) => i), power_w: Array(n).fill(w), ...(hr ? { hr: Array(n).fill(hr) } : {}) });

test('resample: holds short dropouts, zero-fills coasting, cuts pauses', () => {
  const r = P.resample([0, 1, 4, 14, 1000, 1001], [100, 200, 300, 400, 500, 600]);
  // 1->4: hold 200 for 2 s; 4->14: 9 zeros; 14->1000: pause cut
  assert.deepEqual(r.p, [100, 200, 200, 200, 300, 0, 0, 0, 0, 0, 0, 0, 0, 0, 400, 500, 600]);
  assert.deepEqual(P.resample([0, 1, 2], [null, -5, 9999]).p, [0, 0, 0]);
});

test('mmp and NP on a steady and an interval series', () => {
  const p = [...Array(600).fill(100), ...Array(60).fill(400), ...Array(600).fill(100)];
  const m = P.mmp(p);
  assert.equal(m[1], 400); assert.equal(m[60], 400);
  assert.equal(m[120], 250);
  assert.equal(m[1800], undefined);
  assert.equal(Math.round(P.normalizedPower(Array(100).fill(250))), 250);
  assert.ok(P.normalizedPower(p) > p.reduce((a, b) => a + b) / p.length);
  assert.equal(P.normalizedPower([1, 2]), null);
});

test('summarise: small, sensible, null without power', () => {
  const s = P.summarise(steady(3600, 200, 140));
  assert.equal(s.np, 200); assert.equal(s.avg, 200); assert.equal(s.vi, 1); assert.equal(s.kj, 720);
  assert.equal(s.decoupling, 0); assert.equal(s.s, 3600);
  assert.ok(JSON.stringify(s).length < 400, JSON.stringify(s).length);
  // a 2 h ride with every standard duration still fits
  assert.ok(JSON.stringify(P.summarise(steady(7300, 333))).length < 400);
  assert.equal(P.summarise({ seconds: [0, 1], hr: [1, 2] }), null);
  assert.equal(P.summarise(steady(600, 0)), null);
});

test('powerTss: an hour at FTP is 100', () => {
  assert.equal(P.powerTss(P.summarise(steady(3600, 250)), 250), 100);
  assert.equal(P.powerTss(P.summarise(steady(1800, 200)), 250), 32);
  assert.equal(P.powerTss(null, 250), null);
  assert.equal(P.powerTss({ s: 100, np: 200 }, null), null);
});

test('decoupling: power falling at the same HR is positive', () => {
  const n = 3600, p = [...Array(n / 2).fill(200), ...Array(n / 2).fill(180)], hr = Array(n).fill(150);
  assert.equal(Math.round(P.decoupling(p, hr)), 10);
  assert.equal(P.decoupling(p.slice(0, 600), hr.slice(0, 600)), null);
  assert.equal(P.decoupling(p, Array(n).fill(null)), null);
});

test('fitCP recovers CP and W\' from an ideal curve, refuses too few points', () => {
  const cp = 260, wp = 20000, mmp = {};
  for (const d of P.DURATIONS) mmp[d] = Math.round(cp + wp / d);
  const env = P.envelope([{ id: 'a', date: '2026-01-01', mmp }]);
  const f = P.fitCP(env);
  assert.ok(f.ok); assert.ok(Math.abs(f.cp - cp) <= 1); assert.ok(Math.abs(f.wPrime - wp) < 300);
  assert.equal(f.n, 6); assert.ok(f.maxErrPct < 1);
  const e = P.eftp(env, f);
  assert.equal(e.source, 'cp'); assert.equal(e.value, f.cp); assert.equal(e.check, Math.round(0.95 * mmp[1200]));
  const few = P.fitCP({ 180: { w: 400 }, 300: { w: 350 } });
  assert.equal(few.ok, false); assert.match(few.reason, /has 2/);
  // no fit -> eFTP from 95% of 20 min
  const e2 = P.eftp({ 1200: { w: 300 } });
  assert.equal(e2.source, '20min'); assert.equal(e2.value, 285);
  // flat (all-out at no duration) data gives W' <= 0 -> refused
  assert.equal(P.fitCP({ 180: { w: 200 }, 300: { w: 200 }, 600: { w: 201 } }).ok, false);
});

test('envelope, windows, rolling fits, FTP per ride, TSS', () => {
  const curve = cp => Object.fromEntries(P.DURATIONS.filter(d => d >= 120).map(d => [d, Math.round(cp + 18000 / d)]));
  const entries = [
    { id: 'old', date: '2025-01-10', mmp: curve(300) },
    { id: 'a', date: '2026-03-01', mmp: curve(240) },
    { id: 'b', date: '2026-03-20', mmp: { 1: 900, 60: 500 } },
  ];
  const env = P.envelope(entries.slice(1));
  assert.equal(env[1].id, 'b'); assert.equal(env[600].id, 'a');
  const w = P.windowFit(entries, '2026-03-31');
  assert.equal(w.n, 2); assert.ok(w.fit.ok); assert.ok(Math.abs(w.fit.cp - 240) <= 1);
  assert.deepEqual(w.rides.sort(), ['a', 'b']);
  const roll = P.rollingFits(entries);
  assert.equal(roll[0].date, '2025-01-31'); assert.equal(roll.at(-1).date, '2026-03-20');
  assert.ok(roll.every(r => r.n > 0));
  const ftp = P.ftpByRide(entries);
  assert.ok(Math.abs(ftp.a - 240) <= 1); assert.equal(ftp.b, ftp.a);   // b alone has no 3-20 min point
  const tss = P.powerTssById([{ id: 'a', date: '2026-03-01', power: { s: 3600, np: ftp.a, mmp: curve(240) } }]);
  assert.equal(tss.a, 100);
});

test('W\' balance drains above CP and refills below it', () => {
  const ch = { seconds: Array.from({ length: 400 }, (_, i) => i), power_w: [...Array(100).fill(400), ...Array(300).fill(100)] };
  const r = P.wPrimeBalance(ch, 250, 20000);
  assert.equal(r.bal[99], 20000 - 100 * 150); assert.equal(r.minAt, 99);
  assert.ok(r.bal[399] > r.bal[99] && r.bal[399] < 20000);
  assert.equal(P.wPrimeBalance(ch, 0, 20000), null);
});

test('power page renders with rides that have power, and with none', async () => {
  const store = await import('../js/store.js');
  const { emptyState } = await import('../js/merge.js');
  const page = await import('../js/pages/power.js');
  const saved = store.state;
  try {
    store.replaceState(emptyState());
    assert.match(String(page.render()), /power meter|Zwift/);
    const st = emptyState();
    const now = new Date();
    for (let k = 0; k < 30; k++) {
      const d = new Date(now - k * 9 * 864e5), id = 'r' + k, n = 3000 + k * 60;
      const p = Array.from({ length: n }, (_, i) => (i % 900 < 300 ? 320 - k : 180));
      st.activities[id] = { id, name: k % 2 ? 'Zwift - Watopia' : 'Ride', type: k % 2 ? 'virtual_ride' : 'cycling', start: d.toISOString(), moving_s: n, distance_m: n * 8 };
      st.derived[id] = { power: P.summarise({ seconds: p.map((_, i) => i), power_w: p, hr: p.map(w => 120 + w / 10) }) };
    }
    store.replaceState(st);
    const out = String(page.render());
    assert.ok(!/\bundefined\b|\bNaN\b|\[object Object\]/.test(out), out.match(/.{0,80}(undefined|NaN|\[object Object\]).{0,80}/)?.[0]);
    assert.match(out, /eFTP/); assert.match(out, /Power-duration curve/); assert.match(out, /wbal-ride/);
  } finally { store.replaceState(saved); }
});
