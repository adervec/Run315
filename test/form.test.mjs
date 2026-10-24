// Self-check for running form analysis. Port of test_form.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from '../js/lib/form.js';
import { pyRound } from '../js/lib/py.js';

// Build a stream from [[seconds, speed_m_s, cadence, stride, gct, vosc]] legs.
// One sample a second, which is what a Garmin records at. A leg with speed 0 is
// standing still: time passes, distance does not. Any dynamics value may be
// null, which is what a run without a strap looks like.
function build(legs, { sampleS = 1.0, hr = 150, startLat = 47.3769, startLon = 8.5417, ele = 400.0 } = {}) {
  const out = [];
  let t = 0.0, d = 0.0, lat = startLat;
  for (const [secs, speed, cadence, stride, gct, vosc] of legs) {
    const steps = Math.max(Math.trunc(secs / sampleS), 1);
    for (let k = 0; k < steps; k++) {
      const stepS = secs / steps;
      t += stepS;
      d += speed * stepS;
      lat += speed * stepS / 111320.0;
      out.push([pyRound(t, 2), pyRound(d, 3), hr, pyRound(lat, 6), startLon, ele,
        cadence, stride, gct, vosc]);
    }
  }
  return out;
}

// One unremarkable leg, for tests that only care about one thing.
const steady = ({ secs = 900, speed = 3.3, cadence = 178, stride = 1.2, gct = 240, vosc = 8.0 } = {}) =>
  build([[secs, speed, cadence, stride, gct, vosc]]);

const byMetric = findings => Object.fromEntries(findings.map(f => [f.metric, f]));
const range = n => Array.from({ length: n }, (_, i) => i);

// --------------------------------------------------------------------------- //
// the running portion only
// --------------------------------------------------------------------------- //
test('test_averages_ignore_stops_and_warm_up', () => {
  // A long stand-around must not drag the averages of the running down.
  const run = build([[120, 1.3, 112, 0.72, 330, 6.0],     // warm-up walk to the park
    [600, 3.3, 178, 1.20, 240, 8.0],
    [300, 0.0, 60, 0.40, 420, 3.0],                        // standing at a level crossing
    [600, 3.3, 178, 1.20, 240, 8.0]]);
  const s = F.summarise(run);
  assert.notEqual(s, null);

  // What a naive whole-file average would have said, for contrast.
  const naive = run.reduce((a, row) => a + row[6], 0) / run.length;
  assert.ok(naive < 160, String(naive));

  assert.ok(Math.abs(s.cadence.mean - 178) < 0.5);
  assert.ok(Math.abs(s.gct_ms.mean - 240) < 1.0);
  assert.ok(Math.abs(s.stride_m.mean - 1.20) < 0.01);
  assert.ok(s.cadence.sd < 0.5);          // nothing but the running got in
  // Only the running is counted as time on feet, not the 300 s stop.
  assert.ok(s.seconds > 1100 && s.seconds < 1250, String(s.seconds));
  assert.ok(s.n < run.length);
});

test('test_a_whole_run_below_running_speed_has_no_form', () => {
  const walk = build([[600, 1.4, 110, 0.70, 340, 5.5]]);
  assert.equal(F.summarise(walk), null);
  assert.deepEqual(F.cadenceByPace(walk), []);
  assert.equal(F.fatigueDrift(walk), null);
});

test('test_threshold_is_a_parameter', () => {
  // A treadmill jog at 2.2 m/s is running if the caller says so.
  const slow = build([[600, 2.2, 172, 1.05, 255, 8.0]]);
  assert.equal(F.summarise(slow), null);
  const s = F.summarise(slow, 2.0);
  assert.ok(s && Math.abs(s.cadence.mean - 172) < 0.5);
});

// --------------------------------------------------------------------------- //
// cadence counted over one foot
// --------------------------------------------------------------------------- //
test('test_halved_cadence_is_detected', () => {
  assert.equal(F.looksHalved([88, 87, 89, 90]), true);
  assert.equal(F.looksHalved([176, 178, 174]), false);
  assert.equal(F.looksHalved([]), false);
  assert.equal(F.looksHalved([null, null]), false);
  assert.equal(F.looksHalved([20, 21]), false);          // junk, not a halved cadence
  // 110 is where a brisk walk lives; above it, take the number as given.
  assert.equal(F.looksHalved([112, 114, 113]), false);
});

test('test_halved_cadence_is_doubled', () => {
  let [vals, doubled] = F.normaliseCadence([88, null, 90]);
  assert.equal(doubled, true);
  assert.deepEqual(vals, [176.0, null, 180.0]);

  [vals, doubled] = F.normaliseCadence([176, 180]);
  assert.ok(doubled === false);
  assert.deepEqual(vals, [176, 180]);

  const singleLeg = build([[600, 3.2, 88, 1.21, 245, 8.5]]);
  const s = F.summarise(singleLeg);
  assert.equal(s.cadence_doubled, true);
  assert.ok(Math.abs(s.cadence.mean - 176) < 0.5);
  // ...and it says so, so nobody wonders why the number moved.
  const note = F.assess(s).filter(f => f.text.includes('single-leg'));
  assert.ok(note.length === 1 && note[0].severity === 'note');
});

test('test_one_slow_reading_is_not_doubled_on_its_own', () => {
  // The whole stream is judged, not each sample: only the median decides.
  const mixed = [...Array(20).fill(178.0), 85.0];
  const [vals, doubled] = F.normaliseCadence(mixed);
  assert.ok(doubled === false && vals[vals.length - 1] === 85.0);
});

// --------------------------------------------------------------------------- //
// vertical ratio
// --------------------------------------------------------------------------- //
test('test_vertical_ratio_is_bounce_over_stride', () => {
  // 8 cm of bounce on a 1.00 m stride: 0.08 m / 1.00 m = 8%.
  assert.ok(Math.abs(F.verticalRatio(8.0, 1.0) - 8.0) < 1e-9);
  // 9 cm on a 1.20 m stride: 0.09 / 1.20 = 7.5%.
  assert.ok(Math.abs(F.verticalRatio(9.0, 1.2) - 7.5) < 1e-9);
  // A shorter stride makes the same bounce more expensive.
  assert.ok(F.verticalRatio(9.0, 0.9) > F.verticalRatio(9.0, 1.3));
  assert.equal(F.verticalRatio(null, 1.2), null);
  assert.equal(F.verticalRatio(8.0, null), null);
  assert.equal(F.verticalRatio(8.0, 0), null);
  assert.equal(F.verticalRatio('x', 1.2), null);
});

test('test_summary_carries_the_ratio', () => {
  const s = F.summarise(steady({ stride: 1.25, vosc: 10.0 }));
  assert.ok(Math.abs(s.vertical_ratio - 8.0) < 0.01, String(s.vertical_ratio));
  // No stride channel, no ratio -- and no crash.
  const bare = F.summarise(build([[600, 3.3, 178, null, 240, 10.0]]));
  assert.equal(bare.vertical_ratio, null);
  assert.equal(bare.stride_m, null);
  assert.ok(Math.abs(bare.vert_osc_cm.mean - 10.0) < 0.01);
});

// --------------------------------------------------------------------------- //
// cadence against pace
// --------------------------------------------------------------------------- //
test('test_cadence_rises_with_pace', () => {
  const run = build([[600, 2.8, 168, 1.05, 265, 8.6],    // ~5:57/km
    [600, 3.6, 180, 1.20, 235, 8.0],                      // ~4:38/km
    [300, 4.4, 188, 1.40, 215, 7.6]]);                    // ~3:47/km
  const rows = F.cadenceByPace(run);
  assert.ok(rows.length >= 3);

  // Buckets holding a handful of samples are pace transitions, not gears.
  const solid = rows.filter(r => r.n >= 50);
  assert.equal(solid.length, 3, JSON.stringify(solid.map(r => [r.label, r.n])));
  // Fastest bucket first, and cadence falls as the pace does.
  assert.ok(solid[0].mean_pace < solid[1].mean_pace && solid[1].mean_pace < solid[2].mean_pace);
  assert.ok(solid[0].cadence > solid[1].cadence && solid[1].cadence > solid[2].cadence);
  assert.ok(Math.abs(solid[2].cadence - 168) < 1);
  assert.equal(solid[0].label, 'faster than 4:00 /km');
  assert.ok(rows.every(r => r.label));
});

test('test_buckets_are_a_parameter', () => {
  const run = build([[600, 2.8, 168, 1.05, 265, 8.6], [600, 3.6, 180, 1.20, 235, 8.0]]);
  const rows = F.cadenceByPace(run, [300.0]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].label, 'faster than 5:00 /km');
  assert.equal(rows[1].label, 'slower than 5:00 /km');
  assert.ok(rows[0].cadence > rows[1].cadence);
  // No edges at all means one bucket holding everything.
  const single = F.cadenceByPace(run, []);
  assert.ok(single.length === 1 && single[0].label === 'all paces');
});

test('test_cadence_by_pace_needs_a_cadence_channel', () => {
  assert.deepEqual(F.cadenceByPace(build([[600, 3.3, null, 1.2, 240, 8.0]])), []);
});

// --------------------------------------------------------------------------- //
// fatigue drift
// --------------------------------------------------------------------------- //
test('test_drift_catches_cadence_falling_and_contact_rising', () => {
  // Same pace throughout, so the drift is form and not just slowing down.
  const run = build([[900, 3.3, 180, 1.22, 238, 8.0],
    [900, 3.3, 171, 1.29, 262, 8.6]]);
  const d = F.fatigueDrift(run);
  assert.notEqual(d, null);
  assert.ok(Math.abs(d.cadence_first - 180) < 0.5 && Math.abs(d.cadence_second - 171) < 0.5);
  assert.ok(d.cadence_delta < 0 && d.cadence_pct < -4);
  assert.ok(d.gct_delta > 0 && d.gct_pct > 9);
  assert.equal(d.breaking_down, true);
  assert.ok(Math.abs(d.pace_pct) < 1, String(d.pace_pct));     // the pace was held
});

test('test_a_run_that_held_together_is_not_flagged', () => {
  const run = build([[900, 3.3, 179, 1.20, 240, 8.0], [900, 3.3, 179, 1.20, 240, 8.0]]);
  const d = F.fatigueDrift(run);
  assert.equal(d.breaking_down, false);
  assert.ok(Math.abs(d.cadence_pct) < F.DRIFT_PCT);
  assert.ok(Math.abs(d.gct_pct) < F.DRIFT_PCT);
});

test('test_drift_reports_the_fade_that_explains_it', () => {
  // Cadence falling because you slowed down is still reported, with the pace.
  const run = build([[900, 3.6, 182, 1.24, 235, 8.0],
    [900, 2.9, 172, 1.19, 258, 8.5]]);
  const d = F.fatigueDrift(run);
  assert.equal(d.breaking_down, true);
  assert.ok(d.pace_pct > 15, String(d.pace_pct));         // second half a lot slower
  assert.ok(d.pace_second > d.pace_first);
  const text = byMetric(F.assess(F.summarise(run), d)).drift.text;
  assert.ok(text.includes('slowed'));
});

test('test_drift_needs_enough_samples', () => {
  assert.equal(F.fatigueDrift(build([[10, 3.3, 180, 1.2, 240, 8.0]])), null);
  assert.equal(F.fatigueDrift([]), null);
  // Pace only, no dynamics at all: nothing to say about form.
  assert.equal(F.fatigueDrift(range(600).map(t => [t, t * 3.3])), null);
});

// --------------------------------------------------------------------------- //
// plain English
// --------------------------------------------------------------------------- //
const SEVERITIES = ['good', 'watch', 'note'];

test('test_assess_flags_a_low_cadence_run', () => {
  const low = F.summarise(build([[900, 3.0, 152, 1.05, 305, 13.0]]));
  const f = byMetric(F.assess(low));
  assert.equal(f.cadence.severity, 'watch');
  assert.ok(f.cadence.text.includes('170') && f.cadence.text.includes('152'));
  // ...while being honest that the band is guidance.
  assert.ok(f.cadence.text.includes('guidance'));
  assert.equal(f.gct_ms.severity, 'watch');
  assert.equal(f.vertical_ratio.severity, 'watch');
});

test('test_assess_is_happy_with_a_healthy_run', () => {
  const good = F.summarise(build([[900, 3.3, 178, 1.22, 232, 7.4]]));
  const f = byMetric(F.assess(good));
  assert.equal(f.cadence.severity, 'good');
  assert.equal(f.gct_ms.severity, 'good');
  assert.equal(f.vertical_ratio.severity, 'good');
  assert.ok(F.assess(good).every(x => SEVERITIES.includes(x.severity) && x.text));
});

test('test_assess_sits_on_the_fence_in_the_middle', () => {
  // The fuzzy zone gets a note, not a verdict either way.
  const middling = F.summarise(build([[900, 3.1, 166, 1.12, 272, 11.5]]));
  const f = byMetric(F.assess(middling));
  assert.equal(f.cadence.severity, 'note');
  assert.equal(f.gct_ms.severity, 'note');
  assert.equal(f.vertical_ratio.severity, 'note');
});

test('test_assess_reports_drift_and_the_pace_swing', () => {
  const breaking = build([[900, 3.3, 181, 1.21, 236, 8.0],
    [900, 3.3, 170, 1.29, 265, 8.7]]);
  let f = byMetric(F.assess(F.summarise(breaking), F.fatigueDrift(breaking)));
  assert.equal(f.drift.severity, 'watch');
  assert.ok(f.drift.text.includes('second half'));

  const held = build([[900, 3.3, 179, 1.20, 240, 8.0], [900, 3.3, 179, 1.20, 240, 8.0]]);
  f = byMetric(F.assess(F.summarise(held), F.fatigueDrift(held)));
  assert.equal(f.drift.severity, 'good');

  const swinging = build([[600, 2.7, 162, 1.00, 275, 9.0],
    [600, 4.2, 188, 1.34, 220, 7.8]]);
  f = byMetric(F.assess(F.summarise(swinging), null, F.cadenceByPace(swinging)));
  assert.equal(f.cadence_swing.severity, 'watch');
  assert.ok(f.cadence_swing.text.includes('rule of thumb'));

  const settled = build([[600, 2.9, 176, 1.00, 258, 8.4],
    [600, 4.0, 182, 1.32, 224, 7.9]]);
  f = byMetric(F.assess(F.summarise(settled), null, F.cadenceByPace(settled)));
  assert.equal(f.cadence_swing.severity, 'good');
});

test('test_assess_says_nothing_about_channels_it_does_not_have', () => {
  // Only heart rate and pace on this one, plus cadence. No invented findings.
  const part = F.summarise(build([[900, 3.3, 176, null, null, null]]));
  const metrics = new Set(F.assess(part).map(f => f.metric));
  assert.ok(metrics.has('cadence'));
  assert.ok(!metrics.has('gct_ms') && !metrics.has('vertical_ratio'));
  assert.deepEqual(F.assess(null), []);
  assert.deepEqual(F.assess({}), []);
  assert.deepEqual(F.assess(part, null, []), F.assess(part));
});

test('test_a_short_run_is_called_thin', () => {
  const f = byMetric(F.assess(F.summarise(steady({ secs: 120 }))));
  assert.equal(f.data.severity, 'note');
  assert.ok(f.data.text.includes('indicative'));
  assert.ok(!('data' in byMetric(F.assess(F.summarise(steady({ secs: 900 }))))));
});

// --------------------------------------------------------------------------- //
// ragged, missing and plain broken input
// --------------------------------------------------------------------------- //
test('test_empty_and_tiny_input', () => {
  assert.equal(F.summarise([]), null);
  assert.equal(F.summarise(null), null);
  assert.deepEqual(F.cadenceByPace([]), []);
  assert.deepEqual(F.cadenceByPace(null), []);
  assert.equal(F.fatigueDrift([]), null);
  // A single sample has no speed, so there is nothing to say about it.
  assert.equal(F.summarise([[0.0, 0.0, 150, 47.4, 8.5, 400.0, 178, 1.2, 240, 8.0]]), null);
  assert.equal(F.summarise([[0, 0]]), null);
});

test('test_no_dynamics_fields_at_all', () => {
  // A watch with no strap: a perfectly good run with no form data in it.
  const bare = range(600).map(t => [t, t * 3.3]);
  assert.equal(F.summarise(bare), null);
  assert.deepEqual(F.cadenceByPace(bare), []);
  assert.equal(F.fatigueDrift(bare), null);

  const withHr = range(600).map(t => [t, t * 3.3, 150]);
  assert.equal(F.summarise(withHr), null);
});

test('test_short_tuples_lose_only_what_they_are_missing', () => {
  const full = steady({ secs: 600 });
  const ragged = full.map((row, i) => (i % 2 ? row : row.slice(0, 6)));
  const s = F.summarise(ragged);
  assert.notEqual(s, null);
  assert.ok(Math.abs(s.cadence.mean - 178) < 0.5);
  assert.ok(s.cadence.n > 0 && s.cadence.n < s.n, String([s.cadence.n, s.n]));
  // Truncated after distance is still a usable pace stream.
  assert.equal(F.summarise(full.map(row => row.slice(0, 2))), null);
});

test('test_nones_scattered_through_the_stream', () => {
  const full = steady({ secs: 600 });
  const holes = full.map((row, i) => (i % 3 === 0 ? [...row.slice(0, 6), null, null, null, null] : row));
  const s = F.summarise(holes);
  assert.ok(Math.abs(s.cadence.mean - 178) < 0.5);
  assert.ok(Math.abs(s.gct_ms.mean - 240) < 0.5);
  assert.ok(s.cadence.n < s.n);
  const d = F.fatigueDrift(holes);
  assert.ok(d !== null && d.breaking_down === false);
});

test('test_impossible_values_are_dropped', () => {
  // Garmin writes zeros when the pod has nothing to say.
  const zeros = build([[600, 3.3, 0, 0, 0, 0]]);
  assert.equal(F.summarise(zeros), null);
  // One absurd reading does not move the average.
  const run = steady({ secs: 600 });
  run[10] = [...run[10].slice(0, 6), 900, 12.0, 5000, 90.0];
  const s = F.summarise(run);
  assert.ok(Math.abs(s.cadence.mean - 178) < 0.5);
  assert.ok(s.cadence.max <= 178);
});

test('test_junk_types_do_not_crash', () => {
  assert.equal(F.summarise([['x', 'y'], [null, 5], [1, null]]), null);
  const nan = NaN;
  assert.equal(F.summarise([[0, 0], [1, nan], [2, nan]]), null);
  const messy = range(300).map(t => [t, t * 3.3, 150, null, null, null, '178', 1.2, 240, 8.0]);
  const s = F.summarise(messy);
  assert.ok(Math.abs(s.cadence.mean - 178) < 0.5);    // numeric strings are numbers
  assert.equal(F.summarise([null, [], [0, 0, 0]]), null);
});

test('test_samples_out_of_order_and_gps_going_backwards', () => {
  const run = steady({ secs: 300 });
  const forwards = F.summarise(run);
  const backwards = F.summarise([...run].reverse());
  assert.ok(Math.abs(backwards.cadence.mean - forwards.cadence.mean) < 1e-9);
  assert.ok(Math.abs(backwards.distance_m - forwards.distance_m) < 1e-6);
  // A distance that jumps backwards is clamped, not treated as a stop.
  const jumpy = [...run];
  jumpy[100] = [jumpy[100][0], jumpy[100][1] - 40.0, ...jumpy[100].slice(2)];
  const s = F.summarise(jumpy);
  assert.ok(Math.abs(s.cadence.mean - 178) < 0.5);
});
