import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/streams.js';

// A steady 4 m/s run for `n` seconds, with an optional stop.
function steady(n = 600, speed = 4, stopAt = null, stopFor = 0) {
  const seconds = [], metres = [], hr = [];
  let d = 0;
  for (let i = 0; i < n; i++) {
    seconds.push(i);
    if (!(stopAt != null && i >= stopAt && i < stopAt + stopFor)) d += i ? speed : 0;
    metres.push(d);
    hr.push(140 + (i % 10));
  }
  return { seconds, metres, hr };
}

test('pace from distance: steady 4 m/s reads 250 s/km, a stop becomes a gap', () => {
  const s = S.buildSeries(steady(600, 4, 300, 60), 'running');
  const pace = s.series.find(x => x.key === 'pace');
  assert.ok(Math.abs(pace.values[100] - 250) < 1e-6);
  assert.equal(pace.values[330], null);           // standing at the crossing
  assert.ok(!s.series.some(x => x.key === 'speed'));
  assert.ok(s.series.some(x => x.key === 'hr'));
});

test('rides get speed, not pace', () => {
  const s = S.buildSeries(steady(100, 8), 'cycling');
  const sp = s.series.find(x => x.key === 'speed');
  assert.ok(sp && Math.abs(sp.values[50] - 28.8) < 1e-6);
  assert.ok(!s.series.some(x => x.key === 'pace'));
});

test('unknown numeric channels are charted under their own name; zeros are gaps for HR', () => {
  const ch = steady(50);
  ch.respiration_brpm = ch.seconds.map(i => 20 + (i % 3));
  ch.core_temp_c = ch.seconds.map(i => 37 + i / 100);
  ch.hr[5] = 0;
  const s = S.buildSeries(ch);
  assert.ok(s.series.some(x => x.key === 'resp'));
  const other = s.series.find(x => x.key === 'x_core_temp_c');
  assert.ok(other && other.unit === '°C' && other.label === 'core temp');
  assert.equal(s.series.find(x => x.key === 'hr').values[5], null);
  assert.equal(S.buildSeries({ seconds: [1] , metres: [0] }), null);
});

test('downsample keeps spikes and stays near the target', () => {
  const n = 10000, xs = Array.from({ length: n }, (_, i) => i), ys = xs.map(i => (i === 4321 ? 999 : i % 7 === 3 ? -5 : 1));
  const pts = S.downsample(xs, ys, 0, n, 600);
  assert.ok(pts.length <= 602, 'got ' + pts.length);
  assert.ok(pts.some(p => p[1] === 999));
  assert.ok(pts.some(p => p[1] === -5));
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i][0] >= pts[i - 1][0]);
  // Short ranges pass through untouched.
  assert.deepEqual(S.downsample([0, 1, 2], [5, null, 7]), [[0, 5], [1, null], [2, 7]]);
});

test('pathOf breaks at nulls', () => {
  const p = S.pathOf([[0, 1], [1, 2], [2, null], [3, 4]], x => x, y => y);
  assert.equal(p, 'M0.0 1.0L1.0 2.0M3.0 4.0');
});

test('robust range ignores the slowest shuffle; nearest/lowerBound', () => {
  const v = Array.from({ length: 100 }, (_, i) => (i === 50 ? 2000 : 250 + (i % 5)));
  const [lo, hi] = S.yRange(v, true);
  assert.ok(hi < 300 && lo > 200);
  assert.equal(S.yRange([null, null]), null);
  const xs = [0, 10, 20, 30];
  assert.equal(S.nearest(xs, 14), 1);
  assert.equal(S.nearest(xs, 16), 2);
  assert.equal(S.nearest(xs, 99), 3);
  assert.equal(S.lowerBound(xs, 20), 2);
});

test('gap by distance: a stop puts this run behind by its length', () => {
  const a = steady(600, 4, 100, 30), b = steady(600, 4);
  const g = S.gapByDistance({ t: a.seconds, d: a.metres }, { t: b.seconds, d: b.metres }, 100);
  assert.ok(g.d.length > 10);
  assert.ok(Math.abs(g.gap[2]) < 1e-6);            // 200 m: before the stop, level
  assert.ok(Math.abs(g.gap[g.gap.length - 1] - 30) < 1e-6);   // after it: 30 s down
  assert.deepEqual(S.gapByDistance({ t: [0], d: [0] }, { t: [0], d: [0] }), { d: [], gap: [] });
});

test('compare candidates: same route first, then similar distance, never itself', () => {
  const act = { id: 'a', distance_m: 10000, start: '2026-05-10' };
  const acts = [act, { id: 'b', distance_m: 10500, start: '2026-05-01', name: 'B' }, { id: 'c', distance_m: 15000, start: '2026-05-02' },
    { id: 'd', distance_m: 9200, start: '2026-05-03', name: 'D' }];
  const routes = [{ name: 'Loop', runs: [{ id: 'a', start: '2026-05-10' }, { id: 'e', start: '2026-04-01', distance_m: 10000 }] }];
  const c = S.compareCandidates(act, acts, routes);
  assert.deepEqual(c.map(x => x.id), ['e', 'd', 'b']);
  assert.equal(c[0].why, 'route');
});

test('nice ticks', () => {
  assert.deepEqual(S.niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(S.niceTicks(5, 5), [5]);
});

test('a sparse capture still gets a pace from its neighbours', () => {
  const s = S.buildSeries({ seconds: [0, 30, 60, 90], metres: [0, 120, 240, 360] }, 'running');
  assert.ok(s.series[0].values.every(v => Math.abs(v - 250) < 1e-6));
});
