// Port of test_fitness.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../js/lib/fitness.js';
import { addDays, addDayKey, dayKey, fromDay, weekStart } from '../js/lib/dt.js';
import { pyRound } from '../js/lib/py.js';

const NOW = new Date(2026, 7, 18, 12, 0);
const TODAY = dayKey(NOW);

function run(distM, secs, daysAgo, hr = 155) {
  return { type: 'running', start: addDays(NOW, -daysAgo),
    distance_m: distM, moving_s: secs, elapsed_s: secs, avg_hr: hr };
}
const range = (a, b, step = 1) => { const o = []; for (let i = a; i < b; i += step) o.push(i); return o; };

test('test_percentile', () => {
  assert.equal(F.percentile([], 0.5), null);
  assert.equal(F.percentile([1, 2, 3], 0.5), 2.0);
  assert.equal(F.percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(F.percentile([5, null, 1], 0.0), 1.0);
});

test('test_fmt', () => {
  assert.equal(F.fmtTime(65), '1:05');
  assert.equal(F.fmtTime(3725), '1:02:05');
  assert.equal(F.fmtTime(null), '--');
  assert.equal(F.fmtPace(1200, 5000), '4:00 /km');
});

test('test_power_law_matches_riegel', () => {
  // 5K in 20:00 + 10K in 42:00 -> exponent near the textbook 1.06.
  const fit = F.fitPowerLaw(F.bestEfforts([run(5000, 1200, 10), run(10000, 2520, 20)], NOW));
  const [, b, pts] = fit;
  assert.equal(pts.length, 2);
  assert.ok(1.05 < b && b < 1.09, String(b));
  const marathon = F.basePrediction(fit, 42195);
  assert.ok(11000 < marathon && marathon < 12500, String(marathon));   // ~3:16, sane for that pair
  // Round-trips its own inputs.
  assert.ok(Math.abs(F.basePrediction(fit, 5000) - 1200) < 20);
});

test('test_single_effort_falls_back_to_riegel', () => {
  const fit = F.fitPowerLaw(F.bestEfforts([run(5000, 1200, 3)], NOW));
  assert.equal(fit[1], F.RIEGEL);
  assert.ok(Math.abs(F.basePrediction(fit, 5000) - 1200) < 1);
});

test('test_exponent_is_clamped', () => {
  // A pathological pair must not produce a nonsense exponent.
  const fit = F.fitPowerLaw(F.bestEfforts([run(2000, 700, 5), run(20000, 3800, 5)], NOW));
  assert.ok(1.01 <= fit[1] && fit[1] <= 1.20, String(fit[1]));
});

test('test_junk_efforts_are_dropped', () => {
  const acts = [
    run(1000, 300, 5),        // too short
    run(5000, 300, 5),        // 1:00/km, impossible
    run(5000, 5400, 5),       // 18:00/km, a walk mislabelled
    run(5000, 1200, 400),     // older than the window
    { type: 'cycling', start: NOW, distance_m: 40000, moving_s: 4800, elapsed_s: 4800, avg_hr: 140 },
    run(5000, 1200, 5),       // the only keeper
  ];
  assert.deepEqual(F.bestEfforts(acts, NOW), [[5000, 1200, 5]]);
});

test('test_easy_long_runs_do_not_set_the_curve', () => {
  // A hard 5K plus a pile of easy 12Ks must not look like severe fade.
  const acts = range(1, 90, 3).map(d => run(12000, 3600, d, 140));
  acts.push(run(5000, 1200, 6, 178));
  const s = F.summarise(acts, NOW);
  assert.ok(s.fit[1] < 1.20, String(s.fit[1]));            // not pinned to the clamp
  const half = F.projectRace(s, 21097).seconds;
  assert.ok(5200 < half && half < 6600, String(half));     // ~1:27-1:50, not 2h+
});

test('test_hr_filter_relaxes_when_it_would_starve_the_fit', () => {
  // Only one hard run -> fall back to using everything rather than give up.
  const acts = [3, 9, 15].map(d => run(12000, 3600, d, 140));
  acts.push(run(5000, 1200, 6, 178));
  const efforts = F.bestEfforts(acts, NOW, 180, 178.0);
  assert.equal(efforts.length, 4);                         // kept the easy runs too
  assert.notEqual(F.fitPowerLaw(efforts), null);
});

test('test_quality_backstop_without_hr', () => {
  // No HR at all: a wildly slow bucket best is still discarded.
  const efforts = [[5000, 1200, 5], [10000, 2520, 5], [20000, 9000, 5]];
  const picks = F.bucketBests(efforts);
  assert.ok(!picks.some(p => p[0] === 20000 && p[1] === 9000 && p[2] === 5));
  assert.equal(picks.length, 2);
});

test('test_real_marathon_result_survives_the_filter', () => {
  // A 20:00 5K + 3:45 marathon is a real (fading) athlete, not noise -- keep both.
  const picks = F.bucketBests([[5000, 1200, 20], [42195, 13500, 40]]);
  assert.equal(picks.length, 2);
  const fit = F.fitPowerLaw([[5000, 1200, 20], [42195, 13500, 40]]);
  assert.ok(1.10 < fit[1] && fit[1] < 1.16, String(fit[1]));   // genuine fade, not clamped away
  assert.ok(Math.abs(F.basePrediction(fit, 42195) - 13500) < 200);
});

test('test_no_data_returns_none', () => {
  assert.equal(F.fitPowerLaw([]), null);
  assert.equal(F.basePrediction(null, 5000), null);
  assert.equal(F.projectRace(F.summarise([], NOW), 10000), null);
});

test('test_load_and_ramp', () => {
  const acts = range(0, 60, 2).map(d => run(10000, 2700, d, 150));
  const [thrHr, thrSpd] = F.thresholds(acts);
  assert.equal(thrHr, 150.0);
  const load = F.activityLoad(acts[0], thrHr, thrSpd);
  assert.ok(Math.abs(load - 0.75 * 1.0 * 100.0) < 1.0, String(load));   // 45 min at threshold
  const curve = F.loadCurve(F.dailyLoads(acts, thrHr, thrSpd), TODAY);
  assert.equal(curve.length, 181);
  const ctl = curve[curve.length - 1][2];
  assert.ok(20 < ctl && ctl < 60, String(ctl));            // ~37.5 load/day every other day
  assert.ok(curve.every(c => c[2] >= 0));
});

test('test_detraining_shows_up_as_negative_tsb_recovery', () => {
  // Stop training and ATL must fall below CTL (i.e. TSB goes positive).
  const acts = range(30, 120).map(d => run(10000, 2700, d));   // nothing in the last 30 days
  const s = F.summarise(acts, NOW);
  assert.ok(s.tsb > 0, String(s.tsb));
  assert.ok(s.atl < s.ctl);
});

test('test_fitness_factor_direction_and_caps', () => {
  assert.ok(F.fitnessFactor(50, 40, 56) < 1.0);            // building -> faster
  assert.ok(F.fitnessFactor(30, 40, 56) > 1.0);            // detraining -> slower
  assert.equal(F.fitnessFactor(50, 40, 0), 1.0);           // race is today
  assert.equal(F.fitnessFactor(0, 40, 30), 1.0);           // no data
  assert.ok(F.fitnessFactor(500, 1, 365) >= 0.96);         // cap holds
  assert.ok(F.fitnessFactor(1, 500, 365) <= 1.04);
});

test('test_project_race_end_to_end', () => {
  const acts = [
    ...[5, 40].map(d => run(5000, 1200, d)),
    ...[12, 60].map(d => run(10000, 2520, d)),
    run(21097, 5700, 25),
    ...range(1, 90, 3).map(d => run(12000, 3600, d)),
  ];
  const s = F.summarise(acts, NOW);
  const p = F.projectRace(s, 42195, addDayKey(TODAY, 70), TODAY);
  assert.ok(['high', 'medium', 'low'].includes(p.confidence));
  assert.ok(10000 < p.seconds && p.seconds < 15000, String(p.seconds));
  assert.equal(p.days_to_race, 70);
  assert.ok(0.96 <= p.trend_factor && p.trend_factor <= 1.04);
  assert.ok(p.based_on.length >= 3);
  assert.equal(s.weekly.length, 12);
  assert.ok(s.weekly[s.weekly.length - 1][0] <= TODAY);
});

test('test_confidence_degrades_with_extrapolation', () => {
  const acts = [run(2500, 570, 3), run(5000, 1200, 5), run(10000, 2520, 7)];
  const s = F.summarise(acts, NOW);
  const near = F.projectRace(s, 15000, addDayKey(TODAY, 30), TODAY);
  const far = F.projectRace(s, 50000, addDayKey(TODAY, 30), TODAY);
  assert.equal(near.confidence, 'high');
  assert.equal(far.confidence, 'low');
});

// Samples for a perfectly even run.
function evenRun(totalM, paceSPerKm, stepM = 10.0) {
  const out = [];
  let d = 0.0;
  while (d <= totalM + 1e-9) { out.push([d / 1000.0 * paceSPerKm, d]); d += stepM; }
  return out;
}

test('test_best_effort_curve_even_run', () => {
  // A 10 km at 4:00/km: every sub-distance comes out at 4:00/km.
  const curve = F.bestEffortCurve(evenRun(10000, 240.0));
  assert.deepEqual(new Set(Object.keys(curve).map(Number)), new Set([400, 800, 1000, 1609, 3000, 5000, 10000]));
  for (const [dist, secs] of Object.entries(curve)) {
    assert.ok(Math.abs(secs - Number(dist) / 1000.0 * 240.0) < 1.0, `${dist} ${secs}`);
  }
});

test('test_best_effort_curve_finds_the_surge', () => {
  // A 5 km jog with a fast 1 km in the middle must find that 1 km.
  const samples = [[0.0, 0.0]];
  let t = 0.0, d = 0.0;
  for (let km = 0; km < 5; km++) {
    const pace = km === 2 ? 200.0 : 320.0;          // 3:20/km surge inside a 5:20 jog
    for (let i = 0; i < 100; i++) {                 // 10 m steps
      d += 10.0;
      t += pace / 100.0;
      samples.push([t, d]);
    }
  }
  const curve = F.bestEffortCurve(samples);
  assert.ok(Math.abs(curve[1000] - 200.0) < 2.0, String(curve[1000]));
  assert.ok(Math.abs(curve[3000] - (200.0 + 2 * 320.0)) < 4.0, String(curve[3000]));
  assert.ok(5000 in curve);
});

test('test_best_effort_curve_edges', () => {
  assert.deepEqual(F.bestEffortCurve([]), {});
  assert.deepEqual(F.bestEffortCurve([[0.0, 0.0]]), {});
  assert.ok(!(10000 in F.bestEffortCurve(evenRun(5000, 240.0))));   // never ran that far
  // GPS drifting backwards must not create a negative-length window.
  const jitter = [[0.0, 0.0], [10.0, 50.0], [20.0, 40.0], [30.0, 120.0], [400.0, 1200.0]];
  assert.ok(Object.values(F.bestEffortCurve(jitter)).every(v => v > 0));
});

test('test_best_effort_curve_rejects_gps_artefacts', () => {
  // A teleport that implies 30 s/km is dropped, not recorded as a world record.
  const bogus = [[0.0, 0.0], [12.0, 400.0], [600.0, 2000.0]];
  assert.ok(!(400 in F.bestEffortCurve(bogus)));
});

test('test_personal_records', () => {
  const rows = [[5000, 1200, '2026-05-01'], [5000, 1150, '2026-07-01'],
    [10000, 2500, '2026-06-01'], [5000, 1300, '2026-08-01']];
  assert.deepEqual(F.personalRecords(rows), [[5000, 1150, '2026-07-01'], [10000, 2500, '2026-06-01']]);
  assert.deepEqual(F.personalRecords([]), []);
});

test('test_segment_efforts_beat_whole_activities', () => {
  // A fast 5 km inside a long run should drive the fit, not the long run's average.
  const acts = range(1, 60, 3).map(d => run(20000, 6600, d, 150));   // 5:30/km plods
  const plain = F.summarise(acts, NOW);
  const better = F.summarise(acts, NOW, [[5000, 1150, 4]]);
  assert.ok(F.basePrediction(better.fit, 5000) < F.basePrediction(plain.fit, 5000));
  assert.ok(Math.abs(F.basePrediction(better.fit, 5000) - 1150) < 60);
});

test('test_threshold_pace_and_training_paces', () => {
  const fit = F.fitPowerLaw([[5000, 1200, 5], [10000, 2520, 5]]);
  const thr = F.thresholdPace(fit);
  assert.ok(240 < thr && thr < 300, String(thr));          // between 5K and marathon pace
  const paces = F.trainingPaces(fit);
  assert.deepEqual(paces.map(p => p[0]), ['Easy', 'Marathon', 'Threshold', 'Interval', 'Repetition']);
  for (const [, , fast, slow] of paces) assert.ok(fast < slow);   // fast bound is the lower number
  const [easy, marathon, threshold, interval, rep] = paces;
  assert.ok(easy[2] > marathon[2] && marathon[2] > threshold[2] && threshold[2] > interval[2] && interval[2] > rep[2]);
  assert.deepEqual(F.trainingPaces(null), []);
  assert.equal(F.thresholdPace(null), null);
});

test('test_hr_zones', () => {
  const zones = F.hrZones(170);
  assert.equal(zones.length, 5);
  assert.ok(zones[3][0].startsWith('Z4'));
  assert.ok(zones[3][1] <= 170 && 170 <= zones[3][2]);     // threshold sits in Z4
  for (let i = 0; i < 4; i++) assert.equal(zones[i][2], zones[i + 1][1]);   // no gaps between zones
  assert.deepEqual(F.hrZones(null), []);
});

test('test_session_spike', () => {
  // Replaces the ACWR test: distance vs the longest run of the last 30 days.
  const today = '2026-08-19';
  const base = [28, 21, 14, 7].map(d => [addDayKey(today, -d), 15000.0]);

  // A run in line with recent training is not a spike.
  let [ratio, , longest, verdict] = F.sessionSpike([...base, [today, 14000.0]]);
  assert.ok(ratio < 1.0 && longest === 15000.0);
  assert.ok(verdict.includes('within'));

  // A big jump is flagged, and named for what the evidence actually says.
  [ratio, , , verdict] = F.sessionSpike([...base, [today, 22000.0]]);
  assert.ok(ratio > 1.30);
  assert.ok(verdict.includes('injur'));

  // The reference is the longest recent run, not the average.
  const mixed = [[20, 8000.0], [10, 20000.0], [3, 8000.0]].map(([d, m]) => [addDayKey(today, -d), m]);
  assert.equal(F.sessionSpike([...mixed, [today, 20000.0]])[2], 20000.0);

  // Runs outside the window do not count as the reference.
  const oldLong = [[addDayKey(today, -200), 40000.0], [addDayKey(today, -10), 10000.0]];
  assert.equal(F.sessionSpike([...oldLong, [today, 12000.0]])[2], 10000.0);

  // Nothing to compare against says nothing.
  assert.equal(F.sessionSpike([]), null);
  assert.equal(F.sessionSpike([[today, 10000.0]]), null);
});

test('test_project_form_taper_raises_freshness', () => {
  const today = '2026-08-18';
  const daily = {};
  for (let i = 0; i < 400; i++) daily[addDayKey(today, -i)] = 60.0;
  const p = F.projectForm(daily, today, addDayKey(today, 42));
  assert.ok(p.tsb_with_taper > p.tsb_no_taper);
  assert.equal(p.days_out, 42);
  assert.ok(Math.abs(p.avg_daily_load - 60.0) < 0.01);
  assert.equal(F.projectForm(daily, today, today), null);
  assert.equal(F.projectForm(daily, today, addDayKey(today, -1)), null);
});

test('test_split_targets', () => {
  const splits = F.splitTargets(10000, 2400);
  assert.equal(splits.length, 10);
  assert.equal(splits[splits.length - 1][0], 'Finish');
  assert.ok(Math.abs(splits[splits.length - 1][2] - 2400) < 1.0);     // totals to the target
  for (let i = 1; i < splits.length; i++) assert.ok(splits[i][2] > splits[i - 1][2]);
  const firstHalf = splits[4][2];
  assert.ok(firstHalf > 1200, String(firstHalf));          // negative split: slower start

  const marathon = F.splitTargets(42195, 12600);
  assert.ok(marathon[0][0] === '5K' && marathon[marathon.length - 1][0] === 'Finish');
  assert.ok(Math.abs(marathon[marathon.length - 1][2] - 12600) < 1.0);
  assert.deepEqual(F.splitTargets(0, 100), []);
  assert.deepEqual(F.splitTargets(5000, 0), []);
});

test('test_calibration', () => {
  const today = '2026-08-18';
  assert.equal(F.calibration([], today), null);
  assert.equal(F.calibration([[2400, 2500, '2026-05-01']], today), null);   // one is an anecdote

  // Consistently 3% slower than projected -> factor ~1.03
  const res = [[2400, 2472, '2026-05-01'], [5400, 5562, '2026-06-01'], [1200, 1236, '2026-07-01']];
  const cal = F.calibration(res, today);
  assert.ok(1.025 < cal.factor && cal.factor < 1.035);
  assert.ok(cal.n === 3 && cal.direction === 'slower than projected');
  assert.ok(Math.abs(cal.mean_abs_error - 0.03) < 0.001);

  // A wild outlier is capped, not obeyed.
  const wild = [[2400, 4800, '2026-05-01'], [2400, 4800, '2026-06-01']];
  assert.equal(F.calibration(wild, today).factor, 1.0 + F.CALIBRATION_MAX_ADJUST);

  // Recent results outweigh old ones.
  const mixed = [[1000, 1100, '2023-01-01'], [1000, 950, '2026-08-01']];
  assert.ok(F.calibration(mixed, today).raw_factor < 1.0);

  const p = { seconds: 1000.0, confidence: 'high' };
  assert.ok(F.applyCalibration(p, cal).seconds > 1000.0);
  assert.equal(F.applyCalibration(p, null), p);
  assert.ok('calibration_factor' in F.applyCalibration(p, cal));
});

test('test_km_splits_even_and_surge', () => {
  const even = F.kmSplits(evenRun(5000, 240.0));
  assert.equal(even.length, 5);
  assert.ok(even.every(([, , p]) => Math.abs(p - 240.0) < 0.5));
  assert.ok(F.splitEvenness(even) < 0.005);

  const samples = [[0.0, 0.0]];
  let t = 0.0, d = 0.0;
  for (let km = 0; km < 4; km++) {
    const pace = km === 1 ? 200.0 : 300.0;
    for (let i = 0; i < 100; i++) { d += 10.0; t += pace / 100.0; samples.push([t, d]); }
  }
  const sp = F.kmSplits(samples);
  assert.deepEqual(sp.map(([, , p]) => pyRound(p)), [300, 200, 300, 300]);
  assert.ok(F.splitEvenness(sp) > 0.1);
  assert.deepEqual(F.kmSplits([]), []);
  assert.equal(F.splitEvenness([]), null);

  // A partial final split (5.4 km) is reported at its own pace.
  const part = F.kmSplits(evenRun(5400, 240.0));
  assert.ok(part.length === 6 && Math.abs(part[part.length - 1][2] - 240.0) < 2.0);
});

test('test_hr_drift', () => {
  // HR rises 5% at constant pace -> drift ~ +5%.
  const pts = range(0, 3600, 10).map(t => [t, t * 3.0, t < 1800 ? 150.0 : 157.5]);
  const drift = F.hrDrift(pts);
  assert.ok(4.5 < drift && drift < 5.5, String(drift));
  assert.equal(F.hrDrift(pts.slice(0, 5)), null);
  assert.equal(F.hrDrift(range(0, 3600, 10).map(t => [t, t * 3.0, null])), null);
});

test('test_classify_run', () => {
  const act = (dist, secs, hr) => ({ distance_m: dist, moving_s: secs, avg_hr: hr });
  const thr = 175.0;
  assert.equal(F.classifyRun(act(5000, 1200, 176), thr, null), 'race');
  assert.equal(F.classifyRun(act(10000, 2700, 165), thr, null), 'tempo');
  assert.equal(F.classifyRun(act(6000, 1000, 165), thr, null), 'intervals');
  assert.equal(F.classifyRun(act(22000, 6600, 150), thr, null), 'long');
  assert.equal(F.classifyRun(act(8000, 2700, 140), thr, null), 'easy');
  assert.equal(F.classifyRun(act(8000, 2500, 155), thr, null), 'steady');
  assert.equal(F.classifyRun(act(0, 0, 150), thr, null), 'unknown');
  // falls back to pace when there is no HR
  assert.equal(F.classifyRun(act(5000, 1200, null), null, 245.0), 'race');
});

test('test_week_digest', () => {
  const monday = weekStart(NOW);
  const on = (day, dist, secs, hr = 150) => ({ type: 'running', start: fromDay(day),
    distance_m: dist, moving_s: secs, elapsed_s: secs, avg_hr: hr });
  const acts = [on(monday, 10000, 3000), on(addDayKey(monday, 1), 20000, 6000),
    on(addDayKey(monday, -3), 8000, 2400)];
  const [thrHr, thrSpd] = F.thresholds(acts);
  const dg = F.weekDigest(acts, NOW, thrHr, thrSpd);
  assert.equal(dg.week_start, monday);
  assert.ok(Math.abs(dg.this.km - 30.0) < 0.01);
  assert.ok(Math.abs(dg.last.km - 8.0) < 0.01);
  assert.ok(Math.abs(dg.km_delta - 22.0) < 0.01);
  assert.equal(dg.longest.distance_m, 20000);
  assert.ok([10000, 20000].includes(dg.fastest.distance_m));
});
