// Self-check for vitals. Port of test_vitals.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../js/lib/vitals.js';
import { addDayKey } from '../js/lib/dt.js';

const DAY0 = '2026-06-01';

const series = (n = 60) => Array.from({ length: n }, (_, i) => addDayKey(DAY0, i));

// Python's random.Random (MT19937, init_by_array seeding, random(), uniform(),
// gauss()), so the noise tests draw exactly the numbers the Python tests drew.
class PyRandom {
  constructor(seed) {
    this.mt = new Uint32Array(624);
    this.mti = 625;
    this.gaussNext = null;
    this._initByArray([seed >>> 0]);
  }
  _initGenrand(s) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) mt[i] = (Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i) >>> 0;
    this.mti = 624;
  }
  _initByArray(key) {
    const mt = this.mt;
    this._initGenrand(19650218);
    let i = 1, j = 0;
    for (let k = Math.max(624, key.length); k; k--) {
      mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= 624) { mt[0] = mt[623]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k; k--) {
      mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= 624) { mt[0] = mt[623]; i = 1; }
    }
    mt[0] = 0x80000000;
  }
  _int32() {
    const mt = this.mt;
    if (this.mti >= 624) {
      for (let kk = 0; kk < 624; kk++) {
        const y = (mt[kk] & 0x80000000) | (mt[(kk + 1) % 624] & 0x7fffffff);
        mt[kk] = mt[(kk + 397) % 624] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0);
      }
      this.mti = 0;
    }
    let y = mt[this.mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }
  random() {
    const a = this._int32() >>> 5, b = this._int32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }
  uniform(a, b) { return a + (b - a) * this.random(); }
  gauss(mu, sigma) {
    let z = this.gaussNext;
    this.gaussNext = null;
    if (z === null) {
      const x2pi = this.random() * 2 * Math.PI;
      const g2rad = Math.sqrt(-2.0 * Math.log(1.0 - this.random()));
      z = Math.cos(x2pi) * g2rad;
      this.gaussNext = Math.sin(x2pi) * g2rad;
    }
    return mu + z * sigma;
  }
}

test('PyRandom matches CPython random.Random', () => {
  // python -c "import random; r=random.Random(11); print(r.random(), r.uniform(0,90), r.gauss(0,1), r.gauss(0,1))"
  const r = new PyRandom(11);
  assert.equal(r.random(), 0.4523795535098186);
  assert.equal(r.uniform(0, 90), 50.379514747244635);
  assert.ok(Math.abs(r.gauss(0, 1) - 0.9949996276709397) < 1e-12);    // libm cos/log may differ by an ulp
  assert.ok(Math.abs(r.gauss(0, 1) - -0.5132099485894354) < 1e-12);
});

test('test_pearson_against_known_values', () => {
  assert.ok(Math.abs(V.pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1.0) < 1e-9);
  assert.ok(Math.abs(V.pearson([1, 2, 3, 4], [8, 6, 4, 2]) + 1.0) < 1e-9);
  // A flat series correlates with nothing rather than dividing by zero.
  assert.equal(V.pearson([1, 1, 1, 1], [1, 2, 3, 4]), null);
  assert.equal(V.pearson([1, 2], [3, 4]), null);
  // Gaps are dropped pairwise, not treated as zero.
  assert.ok(Math.abs(V.pearson([1, null, 3, 4], [2, 99, 6, 8]) - 1.0) < 1e-9);
});

test('test_critical_r_behaves_like_a_significance_threshold', () => {
  // More days, easier to clear.
  assert.ok(V.criticalR(100) < V.criticalR(30));
  // More tests, harder to clear -- this is the correction doing its job.
  assert.ok(V.criticalR(60, undefined, 100) > V.criticalR(60, undefined, 1));
  // Sanity against the textbook figure: n=30, alpha .05 two-tailed is ~0.36.
  assert.ok(V.criticalR(30) > 0.33 && V.criticalR(30) < 0.39, String(V.criticalR(30)));
  assert.equal(V.criticalR(3), null);
});

test('test_a_real_relationship_is_found_at_the_right_lag', () => {
  const days = series(60);
  // Hard every third day.
  const load = Object.fromEntries(days.map((d, i) => [d, i % 3 === 0 ? 90.0 : 20.0]));
  // Stress rises the day *after* a hard day, and nothing else moves.
  const daily = days.map((d, i) => {
    const yesterday = i ? load[days[i - 1]] : 20.0;
    return [d, { stress_avg: 20.0 + yesterday * 0.4, spo2_avg: 96.0 }];
  });
  const result = V.correlate(daily, load);
  const found = Object.fromEntries(result.findings.map(f => [f.metric, f]));
  assert.ok('stress_avg' in found);
  assert.equal(found.stress_avg.lag, 1);
  assert.ok(found.stress_avg.r > 0.9);
  // A flat metric must never be reported.
  assert.ok(!('spo2_avg' in found));
});

test('test_pure_noise_does_not_produce_findings', () => {
  // The multiple-comparison guard is the whole point of this module.
  const rng = new PyRandom(11);
  const days = series(70);
  const load = {};
  for (const d of days) load[d] = rng.uniform(0, 90);
  // Twenty unrelated metrics of pure noise.
  const daily = days.map(d => {
    const row = {};
    for (let k = 0; k < 20; k++) row[`m${k}`] = rng.gauss(0, 1);
    return [d, row];
  });
  const result = V.correlate(daily, load);
  assert.ok(result.tested >= 60, String(result.tested));
  assert.deepEqual(result.findings, []);
});

test('test_the_correction_is_visibly_stricter_than_no_correction', () => {
  // Uncorrected testing should flag more than corrected -- and be reported.
  const rng = new PyRandom(5);
  const days = series(70);
  const load = {};
  for (const d of days) load[d] = rng.uniform(0, 90);
  const daily = days.map(d => {
    const row = {};
    for (let k = 0; k < 25; k++) row[`m${k}`] = rng.gauss(0, 1);
    return [d, row];
  });
  const result = V.correlate(daily, load);
  // With 100 tests of noise, a few clear the uncorrected bar. That number is
  // surfaced precisely so the difference is not hidden.
  assert.ok(result.uncorrected >= result.findings.length);
  assert.ok(result.critical_r > V.criticalR(result.days, undefined, 1));
});

test('test_correlate_needs_enough_paired_days', () => {
  const days = series(10);
  const load = Object.fromEntries(days.map((d, i) => [d, 50.0 + i]));
  const daily = days.map((d, i) => [d, { stress_avg: 20.0 + i }]);
  const result = V.correlate(daily, load);
  assert.ok(result.tested === 0);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(V.correlate([], {}).findings, []);
});

test('test_finding_note_knows_which_direction_is_bad', () => {
  const days = series(60);
  const load = Object.fromEntries(days.map((d, i) => [d, i % 2 === 0 ? 90.0 : 10.0]));
  // Stress tracking load upward is the bad direction.
  const bad = days.map(d => [d, { stress_avg: 20.0 + load[d] * 0.5 }]);
  let note = V.correlate(bad, load).findings[0].note;
  assert.ok(note.includes('costs you'));

  // Deep sleep tracking load upward is the good direction.
  const good = days.map(d => [d, { deep_s: 4000.0 + load[d] * 10 }]);
  note = V.correlate(good, load).findings[0].note;
  assert.ok(note.includes('would hope for'));
});

test('test_only_the_best_lag_survives_per_metric', () => {
  // A slow-moving signal correlates at several lags; that is one finding.
  const days = series(60);
  const load = Object.fromEntries(days.map((d, i) => [d, 40.0 + 30.0 * Math.sin(i / 8.0)]));
  const daily = days.map(d => [d, { stress_avg: 20.0 + load[d] * 0.5 }]);
  const result = V.correlate(daily, load);
  const metrics = result.findings.map(f => f.metric);
  assert.equal(metrics.filter(m => m === 'stress_avg').length, 1);
});

test('test_sleep_architecture', () => {
  const days = series(30);
  // 18% deep, 22% REM: both inside the usual adult ranges.
  const daily = days.map(d => [d, { deep_s: 0.18 * 28800, light_s: 0.60 * 28800, rem_s: 0.22 * 28800 }]);
  const result = V.sleepArchitecture(daily);
  assert.ok(result.deep_typical && result.rem_typical);
  assert.ok(Math.abs(result.deep_share - 0.18) < 1e-9);
  assert.ok(result.note.includes('usual adult proportions'));

  // Very little deep sleep is named, with the estimate caveat attached.
  const poor = days.map(d => [d, { deep_s: 0.05 * 28800, light_s: 0.73 * 28800, rem_s: 0.22 * 28800 }]);
  const note = V.sleepArchitecture(poor).note;
  assert.ok(note.includes('less deep sleep') && note.includes('estimate'));

  assert.equal(V.sleepArchitecture([]), null);
});

test('test_trend_compares_windows_and_knows_which_way_is_better', () => {
  const days = series(40);
  // Resting stress falling over the block is an improvement.
  let daily = days.map((d, i) => [d, { stress_avg: 40.0 - i * 0.4 }]);
  const result = V.trend(daily, 'stress_avg', 14);
  assert.ok(result.change < 0);
  assert.equal(result.better, true);
  assert.equal(result.notable, true);

  // Deep sleep falling is not.
  daily = days.map((d, i) => [d, { deep_s: 6000.0 - i * 40 }]);
  assert.equal(V.trend(daily, 'deep_s', 14).better, false);

  // Not enough history says nothing.
  assert.equal(V.trend([[DAY0, { stress_avg: 20.0 }]], 'stress_avg'), null);
});

test('test_outliers_and_odd_days', () => {
  const days = series(40);
  const daily = days.map((d, i) => {
    let row = { stress_avg: 25.0, rhr: 48.0, spo2_avg: 96.0, deep_s: 5000.0 };
    if (i === 20) {
      // One day where several things go wrong at once.
      row = { stress_avg: 70.0, rhr: 62.0, spo2_avg: 89.0, deep_s: 5000.0 };
    }
    return [d, row];
  });

  const hits = V.outliers(daily, 'stress_avg');
  assert.ok(hits.length === 1 && hits[0].day === days[20]);

  const odd = V.oddDays(daily, undefined, 3);
  assert.ok(odd.length && odd[0].day === days[20]);
  assert.ok(odd[0].count >= 3);
  // The metric that did not move is not listed among the reasons.
  assert.ok(!odd[0].metrics.map(m => m.metric).includes('deep_s'));

  // A long run is not an odd day: the metrics that always spike when you run
  // further must not be what makes a day look unusual.
  const mechanicalSpike = days.map((d, i) => {
    let row = { calories_active: 400.0, steps: 9000.0, vigorous_minutes: 10.0,
      intensity_minutes: 20.0, stress_avg: 25.0 };
    if (i === 12) {
      row = { calories_active: 1600.0, steps: 26000.0, vigorous_minutes: 70.0,
        intensity_minutes: 120.0, stress_avg: 25.0 };
    }
    return [d, row];
  });
  assert.deepEqual(V.oddDays(mechanicalSpike, undefined, 3), [], 'that is just a long run');

  // A single metric moving is not an odd day.
  const quiet = days.map((d, i) => [d, { stress_avg: i === 5 ? 70.0 : 25.0 }]);
  assert.deepEqual(V.oddDays(quiet, undefined, 3), []);
});

test('test_mechanical_restatements_are_separated_from_findings', () => {
  // Calories correlating with running is arithmetic, not a discovery.
  const days = series(60);
  const load = Object.fromEntries(days.map((d, i) => [d, i % 3 === 0 ? 90.0 : 15.0]));
  const daily = days.map(d => [d, { calories_active: 300 + load[d] * 10,       // mechanical
    stress_avg: 20.0 + load[d] * 0.4 }]);                                      // a real response
  const result = V.correlate(daily, load);
  const names = result.findings.map(f => f.metric);
  assert.ok(names.includes('stress_avg'));
  assert.ok(!names.includes('calories_active'), 'arithmetic must not top the findings');
  assert.ok(result.mechanical.map(f => f.metric).includes('calories_active'));
});

test('test_a_seven_day_lag_carries_its_own_warning', () => {
  const days = series(60);
  // A purely weekly rhythm: lag 0 and lag 7 are the same phase.
  const load = Object.fromEntries(days.map((d, i) => [d, i % 7 === 0 ? 90.0 : 15.0]));
  const daily = days.map((d, i) => [d, { hrv_ms: 60.0 - load[days[Math.max(i - 7, 0)]] * 0.2 }]);
  const result = V.correlate(daily, load);
  const seven = result.findings.filter(f => f.lag === 7);
  if (seven.length) assert.ok(seven[0].note.includes('weekly rhythm'));
});

test('test_lag_zero_reads_as_english', () => {
  const days = series(60);
  const load = Object.fromEntries(days.map((d, i) => [d, i % 2 === 0 ? 90.0 : 10.0]));
  const daily = days.map(d => [d, { stress_avg: 20.0 + load[d] * 0.5 }]);
  const note = V.correlate(daily, load).findings[0].note;
  assert.ok(!note.includes('on the same day a hard day'));
  assert.ok(note.includes('on a hard day itself'));
});

test('test_labels_are_human', () => {
  assert.equal(V.label('spo2_low'), 'lowest blood oxygen');
  assert.equal(V.label('rem_s'), 'REM sleep');
  // An unknown metric degrades to something readable rather than a key.
  assert.equal(V.label('some_new_metric'), 'some new metric');
});
