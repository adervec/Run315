// Self-check for overnight recovery. Port of test_recovery.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../js/lib/recovery.js';

// n nightly readings sitting exactly `spread` either side of `mean`.
// For even n the population mean is `mean` and the population sd is exactly
// `spread`, which is what makes every z-score below hand-checkable.
const nights = (mean, spread, n = 40) =>
  Array.from({ length: n }, (_, i) => (i % 2 ? mean - spread : mean + spread));

// A runner whose HRV sits at 60 +/- 6 ms and resting HR at 48 +/- 2 bpm.
const bases = (hrv = [60.0, 6.0], rhr = [48.0, 2.0]) =>
  ({ hrv: R.baseline(nights(...hrv)), rhr: R.baseline(nights(...rhr)) });

test('test_baseline_needs_enough_history', () => {
  assert.equal(R.baseline(nights(60, 6, 12)), null);
  const b = R.baseline(nights(60, 6, 14));
  assert.equal(b.n, 14);
  assert.ok(Math.abs(b.mean - 60.0) < 1e-9);
  assert.ok(Math.abs(b.sd - 6.0) < 1e-9);
  // The caller may lower the bar, but not by accident.
  assert.equal(R.baseline(nights(60, 6, 8), undefined, 8).n, 8);
});

test('test_baseline_counts_days_not_readings', () => {
  // Thirty nights, the watch caught every third one: ten readings, not thirty.
  const patchy = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? 60.0 : null));
  assert.equal(R.baseline(patchy), null);
  assert.equal(R.baseline(patchy, undefined, 10).n, 10);

  // Older readings outside the window do not drag the baseline around.
  const b = R.baseline([...nights(90, 1, 40), ...nights(50, 2, 20)], 20);
  assert.ok(Math.abs(b.mean - 50.0) < 1e-9);
  assert.ok(Math.abs(b.sd - 2.0) < 1e-9);
});

test('test_baseline_ignores_junk', () => {
  assert.equal(R.baseline(Array(40).fill(null)), null);
  assert.equal(R.baseline([...nights(60, 6, 20), null, '', 'not a number']).n, 20);
});

test('test_z_score_against_a_hand_computed_value', () => {
  const b = R.baseline(nights(60, 6));                    // mean 60, sd 6 exactly
  assert.ok(Math.abs(R.zScore(48, b) - -2.0) < 1e-9);
  assert.ok(Math.abs(R.zScore(66, b) - 1.0) < 1e-9);
  assert.equal(R.zScore(60, b), 0.0);
  assert.equal(R.zScore(null, b), null);
  assert.equal(R.zScore(60, null), null);
});

test('test_a_flat_history_is_not_divided_by', () => {
  // A watch reporting whole beats can read 48 every morning for a month.
  const flat = R.baseline(Array(30).fill(48.0));
  assert.equal(flat.sd, 0.0);
  assert.equal(R.zScore(48, flat), 0.0);
  const up = R.zScore(49, flat);
  assert.ok(up !== null && up > 0.0 && up <= R.MAX_Z);
  assert.equal(R.zScore(47, flat), -up);
  // Capped rather than allowed to run away.
  assert.equal(R.zScore(200, flat), R.MAX_Z);

  // Flat *and* zero: no mean to take a fraction of either.
  const zero = R.baseline(Array(30).fill(0.0));
  assert.equal(R.zScore(0, zero), 0.0);
  assert.equal(R.zScore(5, zero), R.MAX_Z);
  assert.equal(R.zScore(-5, zero), -R.MAX_Z);
});

test('test_hrv_status_across_the_four_bands', () => {
  const b = R.baseline(nights(60, 6));
  assert.equal(R.hrvStatus(75, b), 'high');            // z = +2.5
  assert.equal(R.hrvStatus(63, b), 'balanced');        // z = +0.5
  assert.equal(R.hrvStatus(60, b), 'balanced');
  assert.equal(R.hrvStatus(53, b), 'low');             // z = -1.17
  assert.equal(R.hrvStatus(45, b), 'very_low');        // z = -2.5
  // Band edges belong to the more serious side.
  assert.equal(R.hrvStatus(66, b), 'high');            // z = +1.0
  assert.equal(R.hrvStatus(54, b), 'low');             // z = -1.0
  assert.equal(R.hrvStatus(48, b), 'very_low');        // z = -2.0
});

test('test_hrv_status_needs_a_baseline', () => {
  assert.equal(R.hrvStatus(60, null), null);
  assert.equal(R.hrvStatus(null, R.baseline(nights(60, 6))), null);
});

test('test_trend_reads_up_down_and_flat', () => {
  assert.equal(R.trend([60, 60, 60, 60, 60, 60, 60]), 'flat');
  assert.equal(R.trend([50, 52, 54, 56, 58, 60, 62]), 'up');
  assert.equal(R.trend([62, 60, 58, 56, 54, 52, 50]), 'down');
  // A wobble that goes nowhere is not a trend.
  assert.equal(R.trend([60, 62, 59, 61, 60, 61, 60]), 'flat');
  // Only the recent window counts.
  assert.equal(R.trend([90, 80, 70, ...Array(7).fill(50)]), 'flat');
});

test('test_trend_needs_a_few_days', () => {
  assert.equal(R.trend(null), null);
  assert.equal(R.trend([]), null);
  assert.equal(R.trend([60]), null);
  assert.equal(R.trend([60, 65]), null);
  assert.equal(R.trend([60, 65, 70]), 'up');
});

test('test_trend_survives_missing_nights', () => {
  assert.equal(R.trend([60, null, 62, null, 64, null, 66]), 'up');
  assert.equal(R.trend([66, null, 64, null, 62, null, 60]), 'down');
  assert.equal(R.trend([60, null, null, null, null, null, 66]), null);
});

test('test_readiness_with_only_tsb', () => {
  const r = R.readiness({ tsb: 10 });
  assert.deepEqual(r.used, ['tsb']);
  assert.ok(Math.abs(r.score - 65.0) < 1e-9);
  assert.equal(r.band, 'ready');
  assert.equal(r.confidence, 'low');                  // one input out of four
  assert.ok(Math.abs(r.components.tsb.weight - 1.0) < 1e-9);
});

test('test_readiness_with_only_hrv', () => {
  const b = bases();
  assert.equal(R.readiness({ hrv: 60, baselines: b }).score, 50.0);
  const low = R.readiness({ hrv: 48, baselines: b });
  assert.deepEqual(low.used, ['hrv']);
  assert.equal(low.score, 10.0);                      // z = -2, twenty points per sd
  assert.equal(low.band, 'depleted');
  assert.equal(low.hrv_status, 'very_low');
  assert.equal(low.confidence, 'low');
});

test('test_readiness_with_everything_reports_what_it_used', () => {
  const r = R.readiness({ hrv: 66, rhr: 46, sleep_hours: 7.5, sleep_score: 80, tsb: 5,
    baselines: bases() });
  assert.deepEqual(r.used, ['hrv', 'rhr', 'sleep_score', 'tsb']);
  // The watch's own sleep score already has duration inside it.
  assert.ok(!r.used.includes('sleep_hours'));
  assert.equal(r.components.sleep.source, 'sleep_score');
  assert.ok(Math.abs(r.coverage - 1.0) < 1e-9);
  assert.equal(r.confidence, 'high');
  assert.ok(Math.abs(Object.values(r.components).reduce((s, c) => s + c.weight, 0) - 1.0) < 1e-9);
  // 0.35*70 + 0.20*65 + 0.25*80 + 0.20*57.5
  assert.ok(Math.abs(r.score - 69.0) < 1e-9);
  assert.equal(r.band, 'ready');
});

test('test_readiness_falls_back_to_sleep_hours', () => {
  const r = R.readiness({ sleep_hours: 8.0, baselines: bases() });
  assert.deepEqual(r.used, ['sleep_hours']);
  assert.equal(r.components.sleep.source, 'sleep_hours');
  assert.equal(r.score, 85.0);
  assert.equal(r.confidence, 'low');
});

test('test_readiness_skips_what_it_cannot_ground', () => {
  // A heart number with no history behind it is a number, not evidence.
  assert.equal(R.readiness({ hrv: 60 }), null);
  assert.equal(R.readiness({ hrv: 60, rhr: 48, baselines: { hrv: null } }), null);
  assert.equal(R.readiness({ hrv: 60, baselines: { hrv: R.baseline([60, 61]) } }), null);
  // ...but the inputs that need no history still come through.
  const r = R.readiness({ hrv: 60, tsb: 0 });
  assert.deepEqual(r.used, ['tsb']);
});

test('test_a_recovered_athlete_scores_high', () => {
  const r = R.readiness({ hrv: 75, rhr: 43, sleep_score: 92, tsb: 12, baselines: bases() });
  assert.ok(r.score > 80.0, String(r.score));
  assert.equal(r.band, 'primed');
  assert.equal(r.hrv_status, 'high');
  assert.ok(r.verdict.includes('ready'));
});

test('test_a_dug_out_athlete_scores_low', () => {
  const r = R.readiness({ hrv: 45, rhr: 53, sleep_hours: 4.8, tsb: -22, baselines: bases() });
  assert.ok(r.score < 30.0, String(r.score));
  assert.equal(r.band, 'depleted');
  assert.equal(r.hrv_status, 'very_low');
  assert.deepEqual(r.used, ['hrv', 'rhr', 'sleep_hours', 'tsb']);
});

test('test_the_body_outvotes_the_plan', () => {
  // TSB says tapered; HRV, resting HR and sleep all say otherwise.
  const onPaper = R.readiness({ tsb: 25 });
  assert.equal(onPaper.band, 'primed');
  const real = R.readiness({ hrv: 48, rhr: 52, sleep_hours: 5.0, tsb: 25, baselines: bases() });
  assert.ok(real.components.tsb.score > 80.0);      // the plan has not changed
  assert.ok(real.score < 45.0, String(real.score));
  assert.ok(['strained', 'depleted'].includes(real.band));
});

test('test_sleep_hours_are_read_absolutely', () => {
  // Six hours is short for everybody -- the one metric with no baseline.
  assert.ok(R.sleepHoursScore(8.0) > R.sleepHoursScore(6.0) && R.sleepHoursScore(6.0) > R.sleepHoursScore(4.0));
  // Another hour in bed past a full night buys nothing.
  assert.equal(R.sleepHoursScore(11.0), R.sleepHoursScore(9.0));
  assert.equal(R.sleepHoursScore(9.0), 90.0);
  assert.equal(R.sleepHoursScore(2.0), 10.0);
});

test('test_tsb_score_is_capped_at_the_top', () => {
  assert.equal(R.tsbScore(0), 50.0);
  assert.equal(R.tsbScore(-20), 20.0);
  assert.equal(R.tsbScore(-40), 0.0);
  assert.equal(R.tsbScore(40), R.TSB_CEILING);          // rested is not the same as fit
});

test('test_bands_line_up_with_the_score', () => {
  assert.equal(R.band(100.0)[0], 'primed');
  assert.equal(R.band(80.0)[0], 'primed');
  assert.equal(R.band(79.9)[0], 'ready');
  assert.equal(R.band(0.0)[0], 'depleted');
  assert.equal(R.band(-5.0)[0], 'depleted');
});

test('test_advice_differs_when_a_hard_session_is_planned', () => {
  const good = R.readiness({ hrv: 66, rhr: 46, sleep_score: 80, tsb: 5, baselines: bases() });
  assert.equal(good.band, 'ready');
  assert.notEqual(R.advice(good, true), R.advice(good));

  const bad = R.readiness({ hrv: 50, rhr: 52, sleep_hours: 5.2, tsb: -15, baselines: bases() });
  assert.ok(['strained', 'depleted'].includes(bad.band), String(bad.score));
  const easy = R.advice(bad), hard = R.advice(bad, true);
  assert.notEqual(easy, hard);
  assert.ok(hard.includes('session'));
});

test('test_advice_says_what_it_was_based_on', () => {
  const r = R.readiness({ hrv: 60, sleep_score: 70, baselines: bases() });
  assert.equal(r.confidence, 'medium');
  const text = R.advice(r);
  assert.ok(text.includes('HRV') && text.includes('sleep quality'));
  assert.ok(!text.includes('thin evidence'));

  const thin = R.advice(R.readiness({ tsb: 0 }));
  assert.ok(thin.includes('training load') && thin.includes('thin evidence'));

  assert.ok(R.advice(null).includes('as planned'));
});

test('test_advice_only_points_elsewhere_when_the_body_said_so', () => {
  // A low score built from TSB alone means the training did it, as intended.
  const fromTheLog = R.advice(R.readiness({ tsb: -30 }));
  assert.ok(!fromTheLog.includes('doctor'));
  const fromTheBody = R.advice(R.readiness({ hrv: 45, rhr: 54, sleep_hours: 4.5, tsb: -30,
    baselines: bases() }));
  assert.ok(fromTheBody.includes('doctor'));
  assert.ok(fromTheBody.includes('not health'));
});

test('test_advice_makes_no_medical_claims', () => {
  const banned = ['illness', 'infection', 'sick', 'diagnos', 'immune', 'syndrome'];
  const seen = new Set();
  for (const tsb of [30, 10, 0, -12, -30]) {                // one per band
    for (const hard of [false, true]) {
      const r = R.readiness({ tsb });
      seen.add(r.band);
      const text = R.advice(r, hard);
      assert.ok(text.endsWith('.'), text);
      assert.ok(!banned.some(word => text.toLowerCase().includes(word)), text);
    }
  }
  assert.deepEqual([...seen].sort(), ['depleted', 'primed', 'ready', 'steady', 'strained']);
});

test('test_degenerate_input', () => {
  assert.equal(R.baseline(null), null);
  assert.equal(R.baseline([]), null);
  assert.equal(R.baseline([60.0]), null);
  assert.equal(R.baseline(Array(40).fill(null)), null);
  assert.equal(R.baseline(['', 'x', null]), null);
  assert.equal(R.baseline([60.0], undefined, 1).sd, 0.0);
  assert.equal(R.trend(null), null);
  assert.equal(R.zScore(null, null), null);
  assert.equal(R.hrvStatus(null, null), null);
  assert.equal(R.readiness(), null);
  assert.equal(R.readiness({ hrv: null, rhr: null, sleep_hours: null, sleep_score: null,
    tsb: null, baselines: null }), null);
  assert.equal(R.sleepHoursScore(null), null);
  assert.equal(R.tsbScore(null), null);
  assert.equal(R.advice({}), R.advice(null));
});
