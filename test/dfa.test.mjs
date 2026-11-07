// DFA alpha1: pinned on synthetic series whose scaling exponent is known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../js/lib/dfa.js';

function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function gauss(r) { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
const white = (n, r) => Array.from({ length: n }, () => gauss(r));
// 1/f by spectral synthesis: amplitude ∝ f^(-1/2), random phases.
function pink(n, r) {
  const x = new Array(n).fill(0);
  for (let f = 1; f <= n / 2; f++) {
    const a = gauss(r) / Math.sqrt(f), ph = 2 * Math.PI * r();
    for (let k = 0; k < n; k++) x[k] += a * Math.cos(2 * Math.PI * f * k / n + ph);
  }
  return x;
}
const brown = (n, r) => { let a = 0; return white(n, r).map(v => (a += v)); };
// Scaled into plausible RR intervals (ms) around `mean`.
const asRR = (x, mean, sd) => {
  const m = x.reduce((s, v) => s + v, 0) / x.length, s = Math.sqrt(x.reduce((q, v) => q + (v - m) ** 2, 0) / x.length) || 1;
  return x.map(v => mean + sd * (v - m) / s);
};
const meanAlpha = (gen, n = 256, seeds = 8) => {
  let s = 0;
  for (let k = 1; k <= seeds; k++) s += F.alpha(asRR(gen(n, rng(k)), 600, 20));
  return s / seeds;
};

test('white noise -> alpha1 ~ 0.5', () => {
  const a = meanAlpha(white);
  assert.ok(Math.abs(a - 0.5) < 0.1, String(a));
});
test('1/f noise -> alpha1 ~ 1.0', () => {
  const a = meanAlpha(pink);
  assert.ok(Math.abs(a - 1.0) < 0.12, String(a));
});
test('Brownian (integrated) noise -> alpha1 ~ 1.5', () => {
  const a = meanAlpha(brown);
  assert.ok(Math.abs(a - 1.5) < 0.12, String(a));
});
test('alpha is scale- and offset-free, and needs enough beats', () => {
  const x = white(200, rng(3));
  assert.ok(Math.abs(F.alpha(x) - F.alpha(x.map(v => 900 + 40 * v))) < 1e-9);
  assert.equal(F.alpha(x.slice(0, 20)), null);
});

test('cleanRR: out-of-range and local outliers are interpolated, times kept', () => {
  const rr = Array(30).fill(500);
  rr[10] = 1000;   // a missed beat (two intervals as one)
  rr[20] = 150;    // too short to be a heartbeat
  rr[25] = 560;    // 12%: fine
  const c = F.cleanRR(rr);
  assert.equal(c.artefacts, 2);
  assert.equal(c.rr[10], 500);
  assert.equal(c.rr[20], 500);
  assert.equal(c.rr[25], 560);
  assert.equal(c.bad[10], true);
  // beat times follow the raw clock
  assert.equal(c.t[10], (10 * 500 + 1000) / 1000);
  assert.ok(Math.abs(c.fraction - 2 / 30) < 1e-12);
});
test('cleanRR: interpolates between unequal neighbours and handles ends', () => {
  const c = F.cleanRR([2500, 600, 600, 600, 600, 600, 600, 640, 5000, 700, 700, 700, 700]);
  assert.equal(c.rr[0], 600);
  assert.equal(c.rr[8], 670);
});

// A ramp: HR rises 115 -> 175 over 40 minutes while the beat pattern goes from 1/f to white.
function ramp(seed = 1) {
  const r = rng(seed), out = [];
  for (let stage = 0; stage < 8; stage++) {
    const hr = 115 + stage * (60 / 7), mean = 60000 / hr, w = 1 - stage / 7;
    const n = Math.round(5 * hr);   // five minutes
    const p = asRR(pink(n, r), 0, 1), wn = asRR(white(n, r), 0, 1);
    for (let i = 0; i < n; i++) out.push(mean + 0.02 * mean * (w * p[i] + (1 - w) * wn[i]));
  }
  return out;
}

test('series: 2-minute windows every 5 s, centred, with HR from the beats', () => {
  const rr = Array.from({ length: 600 }, (_, i) => 500 + 10 * Math.sin(i));   // 5 minutes at 120 bpm
  const rows = F.series(rr, { offset: 10 });
  assert.ok(rows.length > 30);
  assert.equal(rows[0].t, 10 + 60);
  assert.equal(rows[1].t - rows[0].t, 5);
  assert.ok(Math.abs(rows[0].hr - 120) < 0.5);
});
test('series: windows thick with artefacts are skipped', () => {
  const rr = Array.from({ length: 600 }, (_, i) => (i % 10 === 0 ? 1000 : 500));   // 10% doubled
  assert.equal(F.series(rr).length, 0);
});

test('threshold: alpha1 regressed on HR crosses 0.75 inside a ramp', () => {
  const rr = ramp();
  const rows = F.series(rr);
  assert.ok(rows[0].a1 > rows[rows.length - 1].a1 + 0.3, `${rows[0].a1} -> ${rows[rows.length - 1].a1}`);
  const th = F.threshold(rows);
  assert.ok(th && th.hr != null, JSON.stringify(th));
  assert.ok(th.slope < 0);
  assert.ok(th.hr > 125 && th.hr < 170, String(th.hr));
  assert.ok(th.ramp);
  assert.ok(th.r2 > 0.5, String(th.r2));
});
test('threshold: a steady run gives no confident answer', () => {
  const r = rng(9);
  const rr = asRR(pink(1800, r), 450, 10);
  const th = F.threshold(F.series(rr));
  assert.ok(!th || th.hr == null || th.quality !== 'good');
});
test('withSpeed adds the stream speed of each window', () => {
  const rows = [{ t: 200, a1: 1, hr: 120 }];
  const samples = Array.from({ length: 601 }, (_, i) => [i, i * 3]);
  assert.equal(F.withSpeed(rows, samples)[0].speed, 3);
});
test('summarise: small, null without RR', () => {
  assert.equal(F.summarise(null), null);
  const s = F.summarise(ramp(2));
  assert.ok(s.windows > 100 && s.hrvt1_hr > 120);
  assert.ok(JSON.stringify(s).length < 300);
});
