import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../js/lib/banister.js';
import { addDayKey } from '../js/lib/dt.js';

// Eight years of a periodised athlete: base, builds, recovery weeks, a break each winter.
function synth({ years = 8, truth = { p0: 90, k1: 0.004, k2: 0.012, tau1: 42, tau2: 8 }, noise = 0.6, every = 9, seed = 7 } = {}) {
  let a = seed;
  const rnd = () => { a = (a * 16807) % 2147483647; return a / 2147483647; };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const start = '2018-11-01', n = Math.round(years * 365), daily = {};
  for (let i = 0; i < n; i++) {
    const wk = Math.floor(i / 7), phase = (i % 365) / 365;
    const block = phase > 0.9 ? 0.2 : 0.6 + 0.6 * ((wk % 4) / 3) * (wk % 4 === 3 ? 0 : 1) + 0.3 * Math.sin(2 * Math.PI * phase);
    const load = (i % 7 === 0 ? 0 : 1) * Math.max(0, 70 * block * (0.7 + 0.6 * rnd()));
    if (load > 0) daily[addDayKey(start, i)] = load;
  }
  const today = addDayKey(start, n - 1);
  const series = B.loadSeries(daily, today);
  const p = B.predictSeries(truth, series);
  const perfs = [];
  for (let i = 70; i < series.n; i += every + Math.floor(rnd() * 5)) {
    const day = addDayKey(series.start, i), race = rnd() < 0.15;
    perfs.push({ day, p: p[i] + gauss() * noise * (race ? 0.6 : 1), w: race ? 3 : 1, kind: race ? 'race' : 'effort' });
  }
  return { daily, today, perfs, truth };
}

test('recovers the constants it was built from, within a second', () => {
  const { daily, today, perfs, truth } = synth();
  const t0 = performance.now();
  const f = B.fitModel(daily, perfs, today);
  const ms = performance.now() - t0;
  assert.ok(f.ok, f.reason);
  assert.ok(ms < 1500, 'fit took ' + ms.toFixed(0) + ' ms');
  assert.ok(Math.abs(f.model.tau1 - truth.tau1) < 10, 'tau1 ' + f.model.tau1);
  assert.ok(Math.abs(f.model.tau2 - truth.tau2) < 4, 'tau2 ' + f.model.tau2);
  assert.ok(f.r2 > 0.5 && f.resid_sd < 1.2, `r2 ${f.r2} sd ${f.resid_sd}`);
  assert.ok(f.ci.tau1[0] <= f.model.tau1 + 1e-9 && f.ci.tau1[1] >= f.model.tau1 - 1e-9 || f.ci.tau1[1] - f.ci.tau1[0] < 6);
  assert.ok(f.boot.length > 150);
  assert.ok(Math.abs(f.t_star - B.timeToPeak(truth)) < 8, 't* ' + f.t_star + ' vs ' + B.timeToPeak(truth));
  assert.ok(f.optimal_taper >= 3 && f.optimal_taper <= 30, 'taper ' + f.optimal_taper);
});

test('refuses with too few performances, and on no load', () => {
  const { daily, today, perfs } = synth({ every: 200 });
  const f = B.fitModel(daily, perfs.slice(0, 10), today);
  assert.equal(f.ok, false);
  assert.match(f.reason, /at least 15/);
  assert.equal(B.fitModel({}, [], '2026-01-01').ok, false);
});

test('time to peak and the taper follow the closed forms', () => {
  const m = { tau1: 42, tau2: 8, k1: 0.004, k2: 0.012, p0: 0 };
  const t = B.timeToPeak(m);
  assert.ok(Math.abs(t - (42 * 8 / 34) * Math.log((0.012 * 42) / (0.004 * 8))) < 1e-9);
  // the bout's effect really peaks there
  const eff = d => m.k1 * Math.exp(-d / m.tau1) - m.k2 * Math.exp(-d / m.tau2);
  assert.ok(eff(t) > eff(t - 1) && eff(t) > eff(t + 1));
  assert.equal(B.timeToPeak({ ...m, k2: 0.0001 }), 0, 'fitness outweighs fatigue from the first day');
  const n = B.optimalTaper(m, 0.5);
  assert.ok(B.taperGain(m, n, 0.5) > 0 && B.taperGain(m, n, 0.5) >= B.taperGain(m, n + 3, 0.5));
  assert.equal(B.optimalTaper({ ...m, k2: 0 }, 0.5), 0, 'no fatigue, no taper');
});

test('a race outlook: a sensible taper beats holding load, with a band', () => {
  const { daily, today, perfs } = synth();
  const f = B.fitModel(daily, perfs, today, { boot: 40 });
  const ref = B.referenceP(f, null);
  const o = B.raceOutlook(f, ref, 30, f.optimal_taper, 0.5);
  assert.ok(o.p_taper >= o.p_keep - 1e-9);
  assert.ok(o.taper.ratio <= o.keep.ratio + 1e-9, 'a better form means a shorter time');
  assert.ok(o.taper.lo < o.taper.ratio && o.taper.hi > o.taper.ratio);
  assert.equal(o.keep_path.length, 30);
  assert.ok(o.best_taper >= 0 && o.best_taper <= 29);
});

test('performances: one scale, hard efforts only, races win their day', () => {
  const acts = { a: { avg_hr: 165 }, b: { avg_hr: 130 }, c: { avg_hr: 168, virtual: true }, d: { avg_hr: 166 } };
  const efforts = [
    [5000, 1200, '2026-03-01', 'a'], [10000, 2600, '2026-03-01', 'a'], [400, 60, '2026-03-01', 'a'],
    [5000, 1200, '2026-03-05', 'b'],            // easy run: out
    [5000, 1150, '2026-03-08', 'c'],            // treadmill: out
    [5000, 1500, '2026-03-10', 'd'],            // hard but far off the envelope: out
  ];
  const races = [{ id: 'r', name: 'Half', date: '2026-03-01', distance_m: 21097, actual_s: 5400 }, { id: 'f', date: '2026-09-01', distance_m: 5000, actual_s: 1100 }];
  const p = B.performances({ races, efforts, acts, thrHr: 180, exponent: 1.06, today: '2026-06-01' });
  assert.equal(p.length, 1, JSON.stringify(p));
  assert.equal(p[0].kind, 'race');
  assert.equal(p[0].w, B.RACE_WEIGHT);
  const q = B.performances({ efforts: efforts.slice(0, 3).concat([[5000, 1210, '2026-03-20', 'd']]), acts, thrHr: 180 });
  assert.equal(q.length, 2);
  // a 10K in 2600 s and a 5K in 1200 s on Riegel 1.06: the 10K equivalent of the 5K is 1200·2^1.06
  assert.ok(Math.abs(q[0].v - 10000 / (1200 * 2 ** 1.06)) < 1e-9, 'the better of the two distances');
  assert.ok(q.every(x => x.p > 95 && x.p < 105));
});
