// D′ balance: the bookkeeping on synthetic runs where the answer is known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/lib/dprime.js';

// [t, d, hr, lat, lon, ele, ...] rows; speedAt/eleAt are f(t).
function stream(durationS, speedAt, eleAt = () => 100, step = 1) {
  const out = [];
  let d = 0;
  for (let t = 0; t <= durationS; t += step) {
    if (t) d += speedAt(t) * step;
    out.push([t, d, 150, 50, 8, eleAt(t, d), 170, 1.2, 240, 8]);
  }
  return out;
}
const CS = 4.0, DP = 200;

test('speedSeries: 1 Hz, speed from distance, gaps are stops', () => {
  const s = P.speedSeries(stream(120, () => 3.5, () => 100, 5));
  assert.equal(s.length, 121);
  assert.ok(Math.abs(s[60][2] - 3.5) < 1e-9);
  assert.equal(s[60][3], s[60][2]);   // flat: GAS = speed
  const gap = [[0, 0], [10, 40], [100, 40], [110, 80]].map(([t, d]) => [t, d, null, null, null, 100]);
  const g = P.speedSeries(gap);
  assert.equal(g[55][2], 0);
});
test('speedSeries: a climb is worth more than its speed', () => {
  const s = P.speedSeries(stream(300, () => 3, (t, d) => 100 + 0.08 * d));
  const mid = s[150];
  assert.ok(Math.abs(mid[4] - 0.08) < 1e-6);
  assert.ok(mid[3] > mid[2] * 1.3, `${mid[3]} vs ${mid[2]}`);
});

test('differential: above CS spends exactly (v - CS) per second', () => {
  const r = P.analyse(stream(100, () => 5), CS, DP);
  // 100 s at 1 m/s over CS = 100 m (the window edges shave a little speed)
  assert.ok(Math.abs(r.min - 100) < 3, String(r.min));
  assert.equal(r.empty, false);
  assert.ok(Math.abs(r.min_frac - 0.5) < 0.02);
});
test('differential: runs dry, and says where', () => {
  const r = P.analyse(stream(400, () => 5), CS, DP);
  assert.equal(r.empty, true);
  assert.ok(Math.abs(r.empty_t - 200) < 3, String(r.empty_t));
  assert.ok(Math.abs(r.empty_d - 1000) < 15, String(r.empty_d));
  assert.ok(r.low_s > 240);
  assert.match(P.verdict(r), /ran out at 1\.0 km/);
});
test('differential: recovery below CS follows (D′ − bal)(CS − v)/D′', () => {
  // 100 s hard (spend 100 m), then 3 m/s: time constant D′/(CS − v) = 200 s.
  const r = P.analyse(stream(400, t => (t <= 100 ? 5 : 3)), CS, DP);
  const at = t => r.points.find(p => p[0] === t)[2];
  const deficit0 = DP - at(110), deficit1 = DP - at(310);
  assert.ok(Math.abs(deficit1 / deficit0 - Math.exp(-1)) < 0.02, String(deficit1 / deficit0));
});
test('integral: Skiba 2012 tau with the speed adaptation', () => {
  const r = P.analyse(stream(400, t => (t <= 100 ? 5 : 3)), CS, DP, { model: 'integral' });
  // mean shortfall while recovering ~1 m/s = 25% of CS -> 62.5 W on the 250 W reference
  const want = 546 * Math.exp(-0.01 * (r.dcs / CS) * P.REF_CP_W) + 316;
  assert.ok(Math.abs(r.tau_s - want) < 1e-9);
  assert.ok(r.dcs > 0.9 && r.dcs < 1.05, String(r.dcs));
  // the integral form lets spending decay even while it is still being spent
  assert.ok(r.min > 98 && r.min < 112, String(r.min));
  // recovery: deficit decays with tau
  const at = t => r.points.find(p => p[0] === t)[2];
  assert.ok(Math.abs((DP - at(300)) / (DP - at(100)) - Math.exp(-200 / r.tau_s)) < 0.03);
});
test('easy run never touches the reserve', () => {
  const r = P.analyse(stream(1800, () => 3), CS, DP);
  assert.equal(r.min, DP);
  assert.equal(r.low_s, 0);
  assert.match(P.verdict(r), /Comfortably/);
});
test('no CS, no answer', () => {
  assert.equal(P.analyse(stream(100, () => 5), null, DP), null);
  assert.equal(P.analyse(stream(100, () => 5), CS, 0), null);
  assert.match(P.verdict(null), /critical speed/);
});
test('summary is small; thin keeps the minimum and the ends', () => {
  const r = P.analyse(stream(3000, t => (t % 600 < 120 ? 5 : 3.5)), CS, DP);
  assert.ok(JSON.stringify(P.summary(r)).length < 150);
  const th = P.thin(r.points, 100);
  assert.ok(th.length <= 103);
  assert.ok(th.some(p => p[2] === r.min));
  assert.equal(th[th.length - 1], r.points[r.points.length - 1]);
});
