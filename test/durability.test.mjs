// Port of test_durability.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../js/lib/durability.js';
import * as RC from '../js/lib/racecraft.js';

// Build a synthetic stream. `speedAt`/`hrAt` are f(elapsed) -> value.
function stream(durationS, speedAt, hrAt, stepS = 10, elevationAt = null) {
  const out = [];
  let metres = 0.0;
  const n = Math.trunc(durationS / stepS) + 1;
  for (let i = 0; i < n; i++) {
    const t = i * stepS;
    if (i) metres += speedAt(t) * stepS;
    const ele = elevationAt ? elevationAt(t) : 100.0;
    out.push([t, metres, hrAt(t), 50.0, 8.0, ele, 170.0, 1.2, 240.0, 8.0]);
  }
  return out;
}

// A long run at one pace, with an optional linear heart-rate drift.
function steady({ durationS = 100 * 60, speed = 3.2, hr = 150.0, driftBpm = 0.0 } = {}) {
  return stream(durationS, () => speed, t => hr + driftBpm * (t / durationS));
}

test('test_critical_speed_fits_the_line', () => {
  // Points generated from a known model: d = 4.0*t + 120
  const bests = [150, 300, 600, 900].map(t => [4.0 * t + 120.0, t]);
  const fit = D.criticalSpeed(bests);
  assert.notEqual(fit, null);
  const [cs, dPrime] = fit;
  assert.ok(Math.abs(cs - 4.0) < 1e-6, String(cs));
  assert.ok(Math.abs(dPrime - 120.0) < 1e-6, String(dPrime));
});

test('test_critical_speed_uses_only_the_middle_efforts', () => {
  // A sprint and a marathon must not drag the fit.
  const good = [150, 300, 600, 900].map(t => [4.0 * t + 120.0, t]);
  // A 30 s sprint and a 3 h effort both sit off the line.
  const polluted = [...good, [200.0, 30.0], [38000.0, 11000.0]];
  assert.deepEqual(D.criticalSpeed(good), D.criticalSpeed(polluted));
});

test('test_critical_speed_needs_enough_points', () => {
  assert.equal(D.criticalSpeed([]), null);
  assert.equal(D.criticalSpeed([[1000.0, 240.0], [2000.0, 500.0]]), null);
  // Efforts all outside the window give nothing, however many there are.
  assert.equal(D.criticalSpeed([[200.0, 40.0], [400.0, 80.0], [600.0, 110.0]]), null);
});

test('test_critical_speed_rejects_impossible_fits', () => {
  // Times that get *slower* per metre in the wrong direction produce a
  // negative reserve, which is a sign the efforts are not comparable.
  assert.equal(D.criticalSpeed([[1000.0, 300.0], [2000.0, 400.0], [5000.0, 700.0]]), null);
});

test('test_a_steady_run_does_not_decouple', () => {
  const result = D.analyse(steady(), 190.0, 4.0);
  assert.notEqual(result, null);
  assert.ok(Math.abs(result.decoupling - 1.0) < 0.01, String(result.decoupling));
  assert.equal(result.band, 'low');
  assert.equal(result.onset_m, null, 'nothing drifted, so nothing started');
});

test('test_heart_rate_drift_at_constant_pace_is_decoupling', () => {
  // The textbook case: same pace, rising heart rate.
  const result = D.analyse(steady({ driftBpm: 20.0 }), 190.0, 4.0);
  assert.ok(result.decoupling > 1.05, String(result.decoupling));
  assert.notEqual(result.onset_m, null);
  assert.ok(0 < result.onset_m && result.onset_m < result.distance_m);
});

test('test_slowing_down_at_constant_heart_rate_is_also_decoupling', () => {
  // Fading shows up as slowing too -- which is how the fit fade, per Takayama.
  const duration = 100 * 60;
  const faded = stream(duration, t => 3.4 - 0.6 * (t / duration), () => 150.0);
  const result = D.analyse(faded, 190.0, 4.0);
  assert.ok(result.decoupling > 1.10, String(result.decoupling));
});

test('test_the_dose_gate_refuses_short_runs', () => {
  // A 40 minute tempo carries no durability signal, so it must not report one.
  assert.equal(D.analyse(steady({ durationS: 40 * 60 }), 190.0, 4.0), null);
  // Long in time but short in distance (a hike) is refused too.
  const slow = steady({ durationS: 100 * 60, speed: 1.5 });
  assert.equal(D.analyse(slow, 190.0, 4.0), null);
  // And the gate is on the run, not on the data: plenty of samples, still short.
  assert.equal(D.analyse(stream(30 * 60, () => 3.5, () => 150.0, 1), 190.0, 4.0), null);
});

test('test_missing_inputs_return_nothing_rather_than_a_guess', () => {
  const good = steady();
  assert.equal(D.analyse(good, null, 4.0), null);
  assert.equal(D.analyse(good, 190.0, null), null);
  assert.equal(D.analyse([], 190.0, 4.0), null);
  // A run with no heart rate at all cannot be decoupled.
  const noHr = stream(100 * 60, () => 3.2, () => null);
  assert.equal(D.analyse(noHr, 190.0, 4.0), null);
});

test('test_hills_do_not_masquerade_as_fatigue', () => {
  // A run that finishes uphill at the same effort is not decoupling.
  // Without grade adjustment the late window looks slow and the ratio jumps.
  const duration = 100 * 60;

  // Slower over the ground on the climb, but at the same metabolic cost. The
  // equal-effort speed comes from the grade model rather than a guessed number,
  // so this test asserts what it claims to.
  const GRADE = 0.03;
  const climbSpeed = 3.2 / RC.costRatio(GRADE);

  // Flat for the first three quarters, then a steady climb. The rise is per
  // metre travelled, not per second, or the grade is not the one we paced.
  const uphillFinish = t => (t < duration * 0.75 ? 100.0
    : 100.0 + (t - duration * 0.75) * GRADE * climbSpeed);
  const speed = t => (t < duration * 0.75 ? 3.2 : climbSpeed);

  const climbing = stream(duration, speed, () => 150.0, 10, uphillFinish);
  const result = D.analyse(climbing, 190.0, 4.0);
  assert.notEqual(result, null);
  // The grade model should absorb most of the apparent slowdown.
  assert.ok(result.decoupling < 1.02, String(result.decoupling));

  // Prove the adjustment is doing the work: flatten the hill and the same
  // slowdown becomes real decoupling.
  const flat = stream(duration, speed, () => 150.0);
  const naive = D.analyse(flat, 190.0, 4.0);
  assert.ok(naive.decoupling > result.decoupling + 0.10, `${naive.decoupling} ${result.decoupling}`);
});

test('test_bands_match_the_published_cuts', () => {
  assert.equal(D.band(1.05), 'low');
  assert.equal(D.band(1.15), 'moderate');
  assert.equal(D.band(1.35), 'high');
  assert.equal(D.band(null), null);
  // Boundaries belong to the gentler band.
  assert.equal(D.band(D.BAND_LOW), 'moderate');
  assert.equal(D.band(D.BAND_HIGH), 'high');
});

test('test_the_reference_values_from_the_paper_land_in_the_right_bands', () => {
  // Smyth 2022 reported mean 1.16, and tertile means of 1.01 / 1.15 / 1.33.
  assert.equal(D.band(1.16), 'moderate');
  assert.equal(D.band(1.01), 'low');
  assert.equal(D.band(1.15), 'moderate');
  assert.equal(D.band(1.33), 'high');
});

test('test_heat_is_flagged_not_corrected', () => {
  const hot = D.analyse(steady({ driftBpm: 20.0 }), 190.0, 4.0, 27.0);
  const cool = D.analyse(steady({ driftBpm: 20.0 }), 190.0, 4.0, 8.0);
  assert.ok(hot.hot && !cool.hot);
  // Same run, same number: the flag is a caveat, not an adjustment.
  assert.equal(hot.decoupling, cool.decoupling);
});

test('test_verdict_mentions_pace_when_the_run_was_quick', () => {
  const quick = D.analyse(steady({ speed: 3.9 }), 190.0, 4.0);
  const easy = D.analyse(steady({ speed: 3.0 }), 190.0, 4.0);
  assert.ok(quick.verdict.includes('critical speed'));
  assert.ok(!easy.verdict.includes('critical speed'));
});

test('test_trend_compares_only_comparable_runs', () => {
  const run = (decoupling, durationS = 100 * 60) => ({ decoupling, duration_s: durationS });

  const improving = [0, 1, 2, 3].map(i => [`2026-01-0${i + 1}`, run(1.30 - i * 0.05)]);
  const result = D.trend(improving);
  assert.notEqual(result, null);
  assert.ok(result.change < 0);
  assert.ok(result.note.includes('better'));
  assert.ok(Math.abs(result.best - 1.15) < 1e-9);

  // Too few runs says nothing.
  assert.equal(D.trend(improving.slice(0, 2)), null);
  assert.equal(D.trend([]), null);

  // A short run is dropped rather than compared against long ones.
  const mixed = [...improving, ['2026-02-01', run(1.05, 76 * 60)]];
  assert.equal(D.trend(mixed).runs, 4, 'the 76-minute run is not comparable');
});

test('test_trend_ignores_runs_that_could_not_be_analysed', () => {
  const runs = [['2026-01-01', null],
    ['2026-01-02', { decoupling: 1.2, duration_s: 6000 }],
    ['2026-01-03', { decoupling: 1.1, duration_s: 6000 }],
    ['2026-01-04', { decoupling: 1.0, duration_s: 6000 }]];
  assert.equal(D.trend(runs).runs, 3);
});
