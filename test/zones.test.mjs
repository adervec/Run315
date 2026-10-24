// Self-check for heart-rate zones and polarisation. Port of test_zones.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Z from '../js/lib/zones.js';
import { pyRound } from '../js/lib/py.js';
import { weekStart, addDayKey, fromDay } from '../js/lib/dt.js';

const NOW = new Date(2026, 7, 19, 12, 0);
const THR = 170.0;            // threshold HR every fixture is written against

// Stream from [[seconds, hr, speed_m_s(, sample_s)], ...] legs.
// Each leg holds its heart rate for its whole duration; the optional fourth
// field says how often the watch wrote a row. `hr` may be a number, null, or a
// function of the fraction through the leg. A closing sample is written at the
// very end so the last leg's time is bounded like every other one.
function build(legs, sampleS = 5.0) {
  const hrAt = (hr, fraction) => (typeof hr === 'function' ? hr(fraction) : hr);
  const out = [];
  let t = 0.0, d = 0.0;
  for (const leg of legs) {
    const [secs, hr, speed] = leg;
    const every = leg.length > 3 ? leg[3] : sampleS;
    const steps = Math.max(Math.trunc(pyRound(secs / every)), 1);
    const dt = secs / steps;
    for (let k = 0; k < steps; k++) {
      out.push([t, d, hrAt(hr, k / steps), null, null, null]);
      t += dt;
      d += speed * dt;
    }
  }
  if (legs.length) out.push([t, d, hrAt(legs[legs.length - 1][1], 1.0), null, null, null]);
  return out;
}

const zoneDict = ({ z1 = 0.0, z2 = 0.0, z3 = 0.0, z4 = 0.0, z5 = 0.0 } = {}) =>
  ({ Z1: z1, Z2: z2, Z3: z3, Z4: z4, Z5: z5 });
const emptyZones = () => Object.fromEntries(Z.ZONES.map(z => [z, 0.0]));
const sumValues = o => Object.values(o).reduce((s, x) => s + x, 0);
const activity = (day, samples) => ({ start: new Date(fromDay(day).getTime() + 9 * 3600e3), samples });

test('test_zone_boundaries', () => {
  // A band owns its lower bound, not its upper -- and Z5 has no ceiling.
  assert.equal(Z.zoneOf(80, 100), 'Z1');
  assert.equal(Z.zoneOf(81, 100), 'Z2');
  assert.equal(Z.zoneOf(89, 100), 'Z2');
  assert.equal(Z.zoneOf(90, 100), 'Z3');
  assert.equal(Z.zoneOf(94, 100), 'Z4');
  assert.equal(Z.zoneOf(99, 100), 'Z4');
  assert.equal(Z.zoneOf(100, 100), 'Z5');
  assert.equal(Z.zoneOf(125, 100), 'Z5');
  assert.equal(Z.zoneOf(null, 100), null);
  assert.equal(Z.zoneOf(150, null), null);
  assert.equal(Z.zoneOf(150, 0), null);
});

test('test_uneven_sampling_is_integrated_not_counted', () => {
  // Five rows a minute apart are five minutes of training, not five units.
  const run = build([[300, 150, 3.0, 1.0],      // 300 rows of easy running
    [300, 176, 4.0, 60.0]]);                    // 5 rows of the same amount of hard
  const z = Z.timeInZones(run, THR);
  assert.ok(Math.abs(z.Z2 - 300.0) < 1e-6, JSON.stringify(z));
  assert.ok(Math.abs(z.Z5 - 300.0) < 1e-6, JSON.stringify(z));
  assert.ok(Math.abs(sumValues(z) - 600.0) < 1e-6);
  // The sparse half is not a rounding error against the dense one.
  assert.ok(z.Z5 > 60.0);
});

test('test_every_zone_is_present_and_the_time_adds_up', () => {
  const run = build([[600, 150, 3.0],      // Z2
    [300, 158, 3.6],                       // Z3
    [240, 163, 4.0],                       // Z4
    [120, 176, 4.6],                       // Z5
    [300, 130, 2.6]]);                     // Z1
  const z = Z.timeInZones(run, THR);
  assert.deepEqual(Object.keys(z).sort(), [...Z.ZONES].sort());
  assert.ok(Math.abs(z.Z1 - 300.0) < 1e-6);
  assert.ok(Math.abs(z.Z2 - 600.0) < 1e-6);
  assert.ok(Math.abs(z.Z3 - 300.0) < 1e-6);
  assert.ok(Math.abs(z.Z4 - 240.0) < 1e-6);
  assert.ok(Math.abs(z.Z5 - 120.0) < 1e-6);
  assert.ok(Math.abs(sumValues(z) - 1560.0) < 1e-6);
});

test('test_hr_dropouts_lose_only_their_own_time', () => {
  // A blind stretch is left out, not filled in with the last reading.
  const run = build([[300, 150, 3.0], [300, null, 3.0], [300, 176, 3.0]]);
  const z = Z.timeInZones(run, THR);
  assert.ok(Math.abs(z.Z2 - 300.0) < 1e-6);
  assert.ok(Math.abs(z.Z5 - 300.0) < 1e-6);
  assert.ok(Math.abs(sumValues(z) - 600.0) < 1e-6);      // the missing 300 s stays missing
});

test('test_a_paused_watch_does_not_dump_an_hour_into_one_zone', () => {
  // An hour between two rows is a pause or a dropout, not an hour of running.
  const run = [[0.0, 0.0, 150], [10.0, 30.0, 150], [3610.0, 40.0, 150], [3620.0, 70.0, 150]];
  const z = Z.timeInZones(run, THR);
  assert.ok(Math.abs(z.Z2 - (10.0 + Z.MAX_GAP_S + 10.0)) < 1e-6);
});

test('test_samples_need_not_arrive_in_order', () => {
  const run = build([[300, 150, 3.0], [300, 176, 4.0]]);
  assert.deepEqual(Z.timeInZones([...run].reverse(), THR), Z.timeInZones(run, THR));
});

test('test_degenerate_streams', () => {
  assert.deepEqual(Z.timeInZones([], THR), emptyZones());
  assert.deepEqual(Z.timeInZones([[0.0, 0.0, 150]], THR), emptyZones());          // one sample
  assert.deepEqual(Z.timeInZones(build([[600, null, 3.0]]), THR), emptyZones());  // no HR at all
  assert.deepEqual(Z.timeInZones([[null, null, null], [0, 0]], THR), emptyZones());
  // No threshold estimate yet: the zones are unknowable, not zero-ish.
  const good = build([[600, 150, 3.0]]);
  assert.deepEqual(Z.timeInZones(good, null), emptyZones());
  assert.deepEqual(Z.timeInZones(good, 0), emptyZones());
});

test('test_weekly_rollup', () => {
  const monday = weekStart(NOW);
  const easy = build([[600, 150, 3.0]]);
  const hard = build([[600, 176, 4.5]]);
  const acts = [activity(monday, easy),
    activity(addDayKey(monday, 2), hard),
    activity(addDayKey(monday, -7), easy),
    activity(addDayKey(monday, -7 * 20), easy)];     // outside the window

  const weekly = Z.weeklyZones(acts, THR, 4, NOW);
  assert.equal(weekly.length, 4);
  assert.equal(weekly[weekly.length - 1][0], monday);                            // most recent last
  assert.deepEqual(weekly.map(([w]) => w), weekly.map(([w]) => w).sort());
  assert.ok(Math.abs(weekly[3][1].Z2 - 600.0) < 1e-6);
  assert.ok(Math.abs(weekly[3][1].Z5 - 600.0) < 1e-6);
  assert.ok(Math.abs(weekly[2][1].Z2 - 600.0) < 1e-6);
  assert.equal(sumValues(weekly[0][1]), 0.0);                // empty weeks are kept
  assert.equal(weekly[2][1].Z5, 0.0);                        // last week had no hard work
});

test('test_weekly_rollup_edges', () => {
  const monday = weekStart(NOW);
  const easy = build([[600, 150, 3.0]]);
  assert.deepEqual(Z.weeklyZones([], THR), []);
  // Activities without a stream, or without a start, cannot be placed.
  assert.deepEqual(Z.weeklyZones([{ start: NOW, samples: [] }], THR), []);
  assert.deepEqual(Z.weeklyZones([{ samples: easy }], THR), []);
  // With no `now`, the window ends at the newest activity.
  const weekly = Z.weeklyZones([activity(addDayKey(monday, -7), easy)], THR, 2);
  assert.equal(weekly[weekly.length - 1][0], addDayKey(monday, -7));
  assert.ok(Math.abs(weekly[weekly.length - 1][1].Z2 - 600.0) < 1e-6);
  // A stream under the other key the app uses for it still counts.
  const alt = [{ start: NOW, stream: easy }];
  const w = Z.weeklyZones(alt, THR, 1);
  assert.ok(Math.abs(w[w.length - 1][1].Z2 - 600.0) < 1e-6);
});

test('test_all_easy_is_all_easy', () => {
  const p = Z.polarisation(zoneDict({ z1: 3000, z2: 3000 }));
  assert.equal(p.easy, 1.0);
  assert.ok(p.moderate === 0.0 && p.hard === 0.0);
  assert.equal(p.total_s, 6000);
  assert.equal(p.label, 'pyramidal');
  assert.ok(p.verdict.includes('All of it easy'));
  assert.ok(p.verdict.includes('base'));
});

test('test_polarised_week', () => {
  // 80% easy, a sliver of grey, the rest hard: the shape everyone is after.
  const p = Z.polarisation(zoneDict({ z1: 4800, z2: 1600, z3: 200, z4: 800, z5: 600 }));
  assert.ok(Math.abs(p.easy - 0.80) < 0.005);
  assert.ok(Math.abs(p.hard - 0.175) < 0.005);
  assert.equal(p.label, 'polarised');
  assert.ok(p.verdict.includes('80% easy'));
  assert.ok(Z.polarisationIndex(zoneDict({ z1: 4800, z2: 1600, z3: 200, z4: 800, z5: 600 })) > 2.0);
});

test('test_threshold_heavy_week', () => {
  // The grey zone eats the week: not the same problem as training too hard.
  const p = Z.polarisation(zoneDict({ z1: 2000, z2: 2000, z3: 3000, z4: 800, z5: 200 }));
  assert.equal(p.label, 'threshold-heavy');
  assert.ok(Math.abs(p.moderate - 0.375) < 0.005);       // the grey zone is the problem
  assert.ok(Math.abs(p.hard - 0.125) < 0.005);           // not the hard running
  assert.ok(p.verdict.includes('grey zone'));
});

test('test_pyramidal_week', () => {
  // Easy > moderate > hard, with no gap in the middle: broad, not polarised.
  const p = Z.polarisation(zoneDict({ z1: 3600, z2: 2000, z3: 1440, z4: 800, z5: 160 }));
  assert.equal(p.label, 'pyramidal');
  assert.ok(p.easy > p.moderate && p.moderate > p.hard);
  assert.ok(Math.abs(p.moderate - 0.18) < 0.005);          // what stops it being polarised
  assert.ok(p.verdict.includes('Pyramidal'));
});

test('test_too_hard_week', () => {
  const p = Z.polarisation(zoneDict({ z1: 2000, z2: 1000, z3: 1200, z4: 2400, z5: 1400 }));
  assert.equal(p.label, 'too-hard');
  assert.ok(Math.abs(p.hard - 0.475) < 0.005);       // nearly half the week at threshold+
  assert.ok(Math.abs(p.easy - 0.375) < 0.005);
  assert.ok(p.verdict.includes('recover'));
});

test('test_polarisation_with_nothing_to_judge', () => {
  const p = Z.polarisation(emptyZones());
  assert.equal(p.label, null);
  assert.equal(p.total_s, 0.0);
  assert.equal(p.easy, 0.0);
  assert.ok(p.verdict);
  assert.equal(Z.polarisation({}).label, null);
});

test('test_polarisation_index_matches_the_formula', () => {
  // 80 / 10 / 10 -> log10(80/10 * 10 * 100) = log10(8000) = 3.9031.
  const pi = Z.polarisationIndex(zoneDict({ z1: 4800, z2: 3200, z3: 1000, z4: 600, z5: 400 }));
  assert.ok(Math.abs(pi - 3.9031) < 0.001, String(pi));
  assert.ok(pi > 2.0);
  // Same shares, ten times the volume: the index is about shape, not hours.
  const bigger = Z.polarisationIndex(zoneDict({ z1: 48000, z2: 32000, z3: 10000, z4: 6000, z5: 4000 }));
  assert.ok(Math.abs(bigger - pi) < 1e-9);
  // Hollowing out the middle raises it; filling the middle lowers it.
  const hollow = Z.polarisationIndex(zoneDict({ z1: 8000, z3: 100, z4: 1900 }));
  const grey = Z.polarisationIndex(zoneDict({ z1: 5000, z3: 4000, z4: 1000 }));
  assert.ok(hollow > pi && pi > grey, String([hollow, pi, grey]));
});

test('test_polarisation_index_needs_all_three_buckets', () => {
  assert.equal(Z.polarisationIndex(zoneDict({ z1: 3600 })), null);            // nothing hard
  assert.equal(Z.polarisationIndex(zoneDict({ z1: 3600, z3: 600 })), null);   // still nothing hard
  assert.equal(Z.polarisationIndex(zoneDict({ z1: 3600, z4: 600 })), null);   // no grey zone
  assert.equal(Z.polarisationIndex(zoneDict({ z3: 600, z4: 600 })), null);    // nothing easy
  assert.equal(Z.polarisationIndex(emptyZones()), null);
  assert.equal(Z.polarisationIndex({}), null);
});

test('test_decoupling_is_zero_on_a_run_that_held_together', () => {
  const steady = build([[3600, 150, 3.0]], 10.0);
  assert.ok(Math.abs(Z.decoupling(steady)) < 1e-6);
});

test('test_decoupling_is_positive_when_hr_climbs_at_the_same_pace', () => {
  const drift = fraction => 145 + 20 * fraction;
  const run = build([[3600, drift, 3.0]], 10.0);
  const d = Z.decoupling(run);
  assert.notEqual(d, null);
  assert.ok(d > 5.0 && d < 10.0, String(d));           // ~150 bpm then ~160 bpm for the same speed
});

test('test_decoupling_is_positive_when_the_pace_fades_at_the_same_hr', () => {
  // The other half of the ratio: same heart rate, less speed for it.
  const faded = build([[1800, 155, 3.0], [1800, 155, 2.7]], 10.0);
  assert.ok(Z.decoupling(faded) > 8.0, String(Z.decoupling(faded)));
  // And a negative split with a flat heart rate reads negative, as it should.
  const strong = build([[1800, 155, 2.7], [1800, 155, 3.0]], 10.0);
  assert.ok(Z.decoupling(strong) < 0.0);
});

test('test_decoupling_splits_on_time_not_on_sample_count', () => {
  // The first half hour is recorded every second and the second every minute;
  // the middle *sample* sits well inside the first half hour, so a naive split
  // would compare 25 minutes of steady running against 35 minutes of drift.
  const run = build([[1800, 150, 3.0, 1.0], [1800, 165, 3.0, 60.0]]);
  const d = Z.decoupling(run);
  assert.notEqual(d, null);
  assert.ok(d > 9.0 && d < 11.0, String(d));           // 165/150 - 1 = 10%, cleanly split at 1800 s
});

test('test_decoupling_degenerate_streams', () => {
  assert.equal(Z.decoupling([]), null);
  assert.equal(Z.decoupling([[0.0, 0.0, 150]]), null);
  assert.equal(Z.decoupling(build([[600, null, 3.0]])), null);       // no HR
  assert.equal(Z.decoupling(build([[600, 150, 0.0]])), null);        // went nowhere
  assert.equal(Z.decoupling(build([[600, 150, 3.0]], 200.0)), null); // too few rows
});

test('test_a_real_week_of_streams', () => {
  // End to end: three easy runs and two sessions should read as polarised.
  const monday = weekStart(NOW);
  const easy = build([[3600, 150, 3.0]], 10.0);
  const session = build([[300, 150, 3.0],     // warm-up, easy
    [120, 158, 4.0],                          // a couple of minutes through the grey zone
    [1200, 176, 4.5],                         // the work
    [180, 150, 3.0]]);                        // jog home
  const acts = [0, 2, 5].map(i => activity(addDayKey(monday, i), easy))
    .concat([1, 3].map(i => activity(addDayKey(monday, i), session)));

  const weekly = Z.weeklyZones(acts, THR, 1, NOW);
  const total = weekly[weekly.length - 1][1];
  assert.ok(Math.abs(sumValues(total) - (3 * 3600 + 2 * 1800)) < 1e-6, JSON.stringify(total));

  const p = Z.polarisation(total);
  assert.equal(p.label, 'polarised');
  assert.ok(Math.abs(p.easy - 11760 / 14400.0) < 0.01);
  assert.ok(Math.abs(p.hard - 2400 / 14400.0) < 0.01);
  const pi = Z.polarisationIndex(total);
  assert.ok(pi > 2.0, String(pi));
  assert.notEqual(Z.decoupling(easy), null);
});
