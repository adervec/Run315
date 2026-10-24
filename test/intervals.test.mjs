// Self-check for track and interval analysis (port of test_intervals.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../js/lib/intervals.js';
import { pyRound } from '../js/lib/py.js';

const rad = d => d * Math.PI / 180;

// Build a stream for `reps` x `repM` with jog recoveries.
// step is metres between samples; paces are seconds per km.
function session(reps, repM, repPace, recS, { recPace = 330.0, warmupM = 1000.0,
                 warmupPace = 330.0, step = 5.0, hrWork = 178, hrRest = 140 } = {}) {
  const out = [];
  let t = 0.0, d = 0.0;
  const leg = (metres, pace, hr) => {
    const n = Math.max(Math.trunc(metres / step), 1);
    for (let k = 0; k < n; k++) {
      d += metres / n;
      t += (metres / n) / 1000.0 * pace;
      out.push([pyRound(t, 2), pyRound(d, 2), hr]);
    }
  };
  out.push([0.0, 0.0, hrRest]);
  leg(warmupM, warmupPace, hrRest);
  for (let i = 0; i < reps; i++) {
    leg(repM, repPace, hrWork);
    if (i < reps - 1) leg(recS / (recPace / 1000.0), recPace, hrRest);
  }
  leg(warmupM, warmupPace, hrRest);
  return out;
}

test('test_clean_and_speed_series', () => {
  assert.deepEqual(I.speedSeries([]), []);
  assert.deepEqual(I.speedSeries([[0, 0, null], [1, 5, null]]), []);
  const s = I.speedSeries([[0, 0, 100], [1, 3, 100], [2, 6, 100], [3, 9, 100], [4, 12, 100]]);
  assert.equal(s.length, 5);
  assert.ok(s.every(p => Math.abs(p[2] - 3.0) < 0.2), String(s.map(p => p[2])));
  // Junk in, nothing out.
  assert.deepEqual(I.speedSeries([[null, 1, 1], ['x', 2, 1], [NaN, 3, 1]]), []);
  // Distance never goes backwards.
  const back = I.speedSeries([[0, 0, null], [1, 10, null], [2, 4, null], [3, 20, null],
                              [4, 30, null], [5, 40, null]]);
  assert.ok(back.every(p => p[2] >= 0));
});

test('test_otsu_splits_two_clusters', () => {
  assert.equal(I.otsuThreshold([]), null);
  assert.equal(I.otsuThreshold(new Array(20).fill(5.0)), null);
  const cut = I.otsuThreshold([...new Array(50).fill(3.0), ...new Array(50).fill(6.0)]);
  assert.ok(3.0 < cut && cut < 6.0, String(cut));
  // Lopsided sets still split in the gap.
  const cut2 = I.otsuThreshold([...new Array(90).fill(3.0), ...new Array(10).fill(6.0)]);
  assert.ok(3.0 < cut2 && cut2 < 6.0, String(cut2));
});

test('test_snap_distance', () => {
  assert.equal(I.snapDistance(402), 400);
  assert.equal(I.snapDistance(387), 400);          // a GPS-short lap of the oval
  assert.equal(I.snapDistance(415), 400);
  assert.equal(I.snapDistance(1580), 1600);
  assert.equal(I.snapDistance(250), null);         // genuinely between distances
  assert.equal(I.snapDistance(0), null);
  assert.equal(I.snapDistance(null), null);
});

test('test_detects_a_clean_400_session', () => {
  // 8 x 400 m at 75 s with 90 s jog: all eight reps, right distance and pace.
  const stream = session(8, 400.0, 187.5, 90.0);  // 187.5 s/km == 75 s per 400
  const reps = I.detectReps(stream);
  assert.equal(reps.length, 8, String(reps.length));
  for (const r of reps) {
    assert.ok(Math.abs(r.distance_m - 400) < 60, String(r.distance_m));
    assert.equal(r.snapped_m, 400);
    assert.ok(Math.abs(r.seconds - 75) < 12, String(r.seconds));
    assert.ok(r.avg_hr && r.avg_hr > 165);
  }
  assert.deepEqual(reps.map(r => r.n), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(reps.slice(0, -1).every(r => r.recovery_s));
  assert.equal(reps[reps.length - 1].recovery_s, null);
  assert.ok(reps.slice(0, -1).every(r => Math.abs(r.recovery_s - 90) < 20),
    String(reps.slice(0, -1).map(r => r.recovery_s)));
});

test('test_warmup_and_cooldown_are_not_reps', () => {
  // A steady run with no hard bits has no rep structure worth reporting.
  const steady = session(0, 0, 0, 0, { warmupM: 8000.0, warmupPace: 300.0 });
  assert.equal(I.analyse(steady), null);
  // And a single hard effort is not a "session" either.
  const one = session(1, 1000.0, 190.0, 0);
  assert.equal(I.analyse(one), null);
});

test('test_traffic_lights_do_not_make_a_steady_run_look_like_intervals', () => {
  // Regression: a standing stop is bimodal against running, but it is not a rep.
  //
  // Two red lights in an easy run had every steady run reporting itself as an
  // interval session.
  const stream = [[0.0, 0.0, 145]];
  let t = 0.0, d = 0.0;
  for (let km = 0; km < 8; km++) {
    for (let k = 0; k < 200; k++) {          // 5 m steps at a steady 5:30/km
      d += 5.0;
      t += 5.0 / 1000.0 * 330.0;
      stream.push([pyRound(t, 2), pyRound(d, 2), 145]);
    }
    if (km === 1 || km === 5) {              // stand at the lights
      for (let k = 0; k < 6; k++) {
        t += 4.0;
        stream.push([pyRound(t, 2), pyRound(d, 2), 138]);
      }
    }
  }
  assert.equal(I.analyse(stream), null);

  // A real session with jog recoveries still registers, stops or not.
  const real = session(6, 800.0, 195.0, 120.0);
  assert.notEqual(I.analyse(real), null);
});

test('test_one_walk_break_in_a_long_run_is_not_a_session', () => {
  // A 20 km run with a single walk break is two gears, but it is not intervals.
  //
  // In a session the reps are a minority of the running; here the running is
  // almost all of it.
  const stream = [[0.0, 0.0, 150]];
  let t = 0.0, d = 0.0;
  for (let step = 0; step < 4000; step++) {  // 20 km in 5 m steps
    const pace = step >= 3100 && step < 3160 ? 460.0 : 300.0;   // a 300 m walk at 16 km
    d += 5.0;
    t += 5.0 / 1000.0 * pace;
    stream.push([pyRound(t, 2), pyRound(d, 2), 152]);
  }
  assert.equal(I.analyse(stream), null);
});

test('test_mixed_ladder_is_described_as_a_range', () => {
  const stream = [];
  let t = 0.0, d = 0.0;
  for (const metres of [1200.0, 800.0, 400.0]) {
    for (const [pace, dist] of [[330.0, 400.0], [190.0, metres]]) {
      const n = Math.trunc(dist / 5);
      for (let k = 0; k < n; k++) {
        d += 5.0;
        t += 5.0 / 1000.0 * pace;
        stream.push([pyRound(t, 2), pyRound(d, 2), pace < 250 ? 175 : 140]);
      }
    }
  }
  const reps = I.detectReps(stream);
  assert.equal(reps.length, 3, String(reps.length));
  assert.deepEqual(reps.map(r => r.snapped_m).sort((a, b) => a - b), [400, 800, 1200]);
  assert.equal(I.describe(reps), '3 reps, 400-1200 m');
});

test('test_describe', () => {
  assert.equal(I.describe([]), null);
  assert.equal(I.describe(new Array(6).fill({ snapped_m: 400, pace: 190, distance_m: 400 })), '6 x 400 m');
  const odd = [{ snapped_m: null, pace: 200, distance_m: 505 },
               { snapped_m: null, pace: 200, distance_m: 500 }];
  assert.equal(I.describe(odd), '2 x ~500 m');
});

test('test_consistency_and_fade', () => {
  const even = [{ pace: 190.0 }, { pace: 190.0 }, { pace: 190.0 }, { pace: 190.0 }];
  assert.equal(I.consistency(even), 0.0);
  assert.equal(I.fade(even), 0.0);
  assert.equal(I.consistency([{ pace: 190.0 }]), null);
  assert.equal(I.fade(even.slice(0, 2)), null);

  const faded = [{ pace: 180.0 }, { pace: 182.0 }, { pace: 195.0 }, { pace: 200.0 }];
  assert.ok(I.fade(faded) > 0.05, String(I.fade(faded)));
  assert.ok(I.consistency(faded) > 0.01);

  const negative = [{ pace: 200.0 }, { pace: 196.0 }, { pace: 184.0 }, { pace: 180.0 }];
  assert.ok(I.fade(negative) < 0);
});

test('test_looks_like_track', () => {
  // 12 laps of a 400 m oval: lots of distance in a tiny box.
  const oval = [], lat0 = 47.3769, lon0 = 8.5417;
  for (let lap = 0; lap < 12; lap++) {
    for (let i = 0; i < 60; i++) {
      const a = 2 * Math.PI * i / 60;
      oval.push([lat0 + 0.00045 * Math.sin(a), lon0 + 0.00090 * Math.cos(a) / Math.cos(rad(lat0))]);
    }
  }
  const [on, diag] = I.looksLikeTrack(oval);
  assert.equal(on, true, String([on, diag]));
  assert.ok(diag < I.TRACK_BBOX_M);

  // A point-to-point road run is not a track, however long.
  const road = Array.from({ length: 300 }, (_, i) => [lat0 + i * 0.0002, lon0 + i * 0.0002]);
  assert.equal(I.looksLikeTrack(road)[0], false);
  assert.equal(I.looksLikeTrack([])[0], false);
  assert.equal(I.looksLikeTrack(new Array(5).fill([1, 1]))[0], false);
});

test('test_analyse_end_to_end', () => {
  const stream = session(6, 800.0, 195.0, 120.0);
  const a = I.analyse(stream);
  assert.notEqual(a, null);
  assert.equal(a.count, 6);
  assert.equal(a.name, '6 x 800 m');
  assert.equal(a.uniform, true);
  assert.ok(Math.abs(a.work_m - 4800) < 400, String(a.work_m));
  assert.ok(a.fastest <= a.avg_pace && a.avg_pace <= a.slowest);
  assert.ok(a.consistency !== null && a.consistency < 0.08);
  assert.ok(a.avg_recovery_s && Math.abs(a.avg_recovery_s - 120) < 25);
  assert.equal(a.on_track, false);          // no GPS given
  assert.equal(a.bbox_m, null);
});

test('test_analyse_flags_a_track_session', () => {
  const stream = session(10, 400.0, 185.0, 75.0);
  const oval = [], lat0 = 47.3769, lon0 = 8.5417;
  for (let i = 0; i < 600; i++) {
    const ang = 2 * Math.PI * i / 50;
    oval.push([lat0 + 0.00045 * Math.sin(ang), lon0 + 0.00090 * Math.cos(ang) / Math.cos(rad(lat0))]);
  }
  const a = I.analyse(stream, oval);
  assert.equal(a.on_track, true);
  assert.equal(a.count, 10);
  assert.equal(a.name, '10 x 400 m');
});

test('test_a_dropped_fix_does_not_split_a_rep', () => {
  // One bad sample mid-rep must not turn 4 reps into 7.
  const stream = session(4, 1000.0, 190.0, 120.0);
  // Blank out a couple of samples partway through the second rep.
  const mid = stream.length >> 1;
  const damaged = [...stream.slice(0, mid), ...stream.slice(mid + 2)];
  const reps = I.detectReps(damaged);
  assert.equal(reps.length, 4, String(reps.length));
});
