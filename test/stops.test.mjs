// Self-check for stop and slow-down analysis (port of test_stops.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/lib/stops.js';
import { pyRound } from '../js/lib/py.js';

// Build a stream from [[metres, speed_m_s, hr, climb_m], ...] legs.
//
// A leg with speed 0 is a standing stop of `metres` SECONDS (there is no other
// sane way to express standing still in a distance-based fixture).
function build(legs, { hrProfile = null, startLat = 47.3769, startLon = 8.5417, ele0 = 400.0,
                       sampleM = 5.0 } = {}) {
  const out = [];
  let t = 0.0, d = 0.0, ele = ele0, lat = startLat;
  const lon = startLon;
  out.push([0.0, 0.0, hrProfile || 150, lat, lon, ele]);
  for (const [metres, speed, hr, climb] of legs) {
    if (speed === 0) {
      // metres is seconds here; time passes, nothing else does.
      const steps = Math.max(Math.trunc(metres / 2), 1);
      for (let k = 0; k < steps; k++) {
        t += metres / steps;
        // HR decays toward 110 while standing.
        const cur = typeof hr === 'function' ? hr(k / steps) : hr;
        out.push([pyRound(t, 2), pyRound(d, 2), cur, lat, lon, pyRound(ele, 1)]);
      }
      continue;
    }
    const steps = Math.max(Math.trunc(metres / sampleM), 1);
    for (let k = 0; k < steps; k++) {
      const stepM = metres / steps;
      d += stepM;
      t += stepM / speed;
      ele += climb / steps;
      lat += stepM / 111320.0;
      const cur = typeof hr === 'function' ? hr(k / steps) : hr;
      out.push([pyRound(t, 2), pyRound(d, 2), cur, pyRound(lat, 6), lon, pyRound(ele, 1)]);
    }
  }
  return out;
}

test('test_no_interruptions_on_a_clean_run', () => {
  const steady = build([[6000, 3.3, 150, 0]]);
  assert.deepEqual(S.findInterruptions(steady), []);
  assert.equal(S.analyse(steady), null);
});

test('test_short_full_stop_is_a_crossing', () => {
  const run = build([[1500, 3.3, 160, 0], [25, 0, 158, 0], [1500, 3.3, 160, 0]]);
  const found = S.findInterruptions(run);
  assert.equal(found.length, 1, JSON.stringify(found));
  const it = found[0];
  assert.equal(it.full_stop, true);
  assert.ok(18 < it.seconds && it.seconds < 35, String(it.seconds));
  const [label, conf] = S.classify(it);
  assert.equal(label, 'crossing', JSON.stringify(it));
  assert.ok(conf > 0.5);
});

test('test_long_stop_with_recovery_is_a_rest', () => {
  const decay = f => 165 - 45 * f;            // HR falls a long way while standing
  const run = build([[1500, 3.3, 165, 0], [180, 0, decay, 0], [1500, 3.3, 165, 0]]);
  const found = S.findInterruptions(run);
  assert.equal(found.length, 1);
  const it = found[0];
  assert.ok(it.seconds > S.CROSSING_MAX_S);
  assert.ok(it.hr_drop >= S.REST_MIN_HR_DROP, String(it.hr_drop));
  assert.equal(S.classify(it)[0], 'rest');
});

test('test_slow_on_a_climb_is_a_climb', () => {
  const run = build([[1500, 3.3, 155, 0], [300, 1.7, 168, 30], [1500, 3.3, 155, 0]]);
  const found = S.findInterruptions(run);
  assert.equal(found.length, 1);
  const it = found[0];
  assert.equal(it.full_stop, false);
  assert.ok(it.grade !== null && it.grade > S.CLIMB_GRADE, String(it.grade));
  assert.equal(S.classify(it)[0], 'climb');
});

test('test_late_slow_with_high_hr_and_a_penalty_is_exhaustion', () => {
  // Walk break at 70% distance, HR stays up, and the running afterwards is worse.
  const run = build([[7000, 3.3, 168, 0],      // the bulk of the run
                     [200, 1.4, 172, 0],       // walking, HR still high
                     [2000, 2.7, 170, 0]]);    // noticeably slower afterwards
  const found = S.findInterruptions(run);
  assert.ok(found.length >= 1);
  const it = found.filter(x => !x.full_stop)[0];
  assert.ok(it.position > S.LATE_RUN, String(it.position));
  assert.ok(it.penalty > S.PENALTY, String(it.penalty));
  const [label, conf, why] = S.classify(it);
  assert.equal(label, 'exhaustion', JSON.stringify(it));
  assert.ok(conf >= 0.6 && why.includes('fatigue'));
});

test('test_early_slow_that_costs_nothing_is_just_eased', () => {
  const run = build([[800, 3.3, 150, 0], [200, 2.0, 140, 0], [6000, 3.3, 150, 0]]);
  const found = S.findInterruptions(run);
  assert.equal(found.length, 1);
  const it = found[0];
  assert.ok(it.position < S.LATE_RUN);
  assert.equal(S.classify(it)[0], 'eased');
});

test('test_a_hill_late_in_a_run_is_still_a_hill', () => {
  // Grade is checked before fatigue, so a climb is not blamed on tiredness.
  const run = build([[7000, 3.3, 165, 0], [300, 1.6, 175, 28], [1500, 3.0, 165, 0]]);
  const it = S.findInterruptions(run).filter(x => !x.full_stop)[0];
  assert.ok(it.position > S.LATE_RUN);
  assert.equal(S.classify(it)[0], 'climb');
});

test('test_start_and_finish_shuffling_is_ignored', () => {
  // The walk to the door and the stop at the end are not events.
  const run = build([[40, 1.0, 110, 0], [5000, 3.3, 155, 0], [40, 1.0, 120, 0]]);
  assert.deepEqual(S.findInterruptions(run), []);
});

test('test_wobbles_are_too_short_to_count', () => {
  const run = build([[2000, 3.3, 155, 0], [4, 0, 155, 0], [2000, 3.3, 155, 0]]);
  assert.deepEqual(S.findInterruptions(run), []);
});

test('test_standing_and_walking_are_told_apart_by_the_minimum', () => {
  // Regression: a stop used to be judged by the span's *mean* speed.
  //
  // Smoothing bleeds running speed into a stop's edges, so on a sparsely sampled
  // stream the mean of a red light can rise above walking pace. That made a late
  // traffic light look like a walk break and get blamed on fatigue. The minimum
  // is the honest discriminator: standing reads near zero, walking never does.
  const light = build([[5000, 3.3, 158, 0], [20, 0, 156, 0], [2000, 3.3, 158, 0]], { sampleM: 50.0 });
  const it = S.findInterruptions(light)[0];
  assert.ok(it.position > S.LATE_RUN, String(it.position));
  assert.ok(it.min_speed < S.STOP_SPEED);
  assert.equal(it.full_stop, true);
  // The standing time is measured, not taken from the whole span, so the
  // smoothed ramp cannot inflate a 20 s light past the crossing cutoff.
  assert.ok(it.stopped_s <= it.seconds);
  assert.equal(S.classify(it)[0], 'crossing');

  const walk = build([[5000, 3.3, 168, 0], [250, 1.4, 172, 0], [2000, 2.9, 170, 0]], { sampleM: 50.0 });
  const w = S.findInterruptions(walk).filter(x => x.at_m > 4000)[0];
  assert.ok(w.min_speed >= S.STOP_SPEED, String(w.min_speed));
  assert.equal(w.full_stop, false);
  assert.equal(S.classify(w)[0], 'exhaustion');
});

test('test_junction_tiles_need_repetition', () => {
  const at = (lat, lon) => ({ full_stop: true, lat, lon });
  const corner = [47.3800, 8.5500], oneoff = [47.3900, 8.5600];
  const runs = [[at(...corner)], [at(...corner)], [at(...corner)], [at(...oneoff)]];
  const j = S.junctionTiles(runs, 3);
  const keys = new Set(j.map(c => c.join(',')));
  assert.ok(keys.has([pyRound(corner[0], 4), pyRound(corner[1], 4)].join(',')));
  assert.ok(!keys.has([pyRound(oneoff[0], 4), pyRound(oneoff[1], 4)].join(',')));
  // Stopping twice at the same corner within ONE run is still one run.
  assert.deepEqual(S.junctionTiles([[at(...corner), at(...corner)]], 2), []);
  assert.deepEqual(S.junctionTiles([]), []);
});

test('test_junction_evidence_overrides_duration', () => {
  // A long-ish stop somewhere you always stop is still a crossing.
  const it = { full_stop: true, seconds: 60.0, hr_drop: 20.0, grade: null,
               hr_mean: 150, run_hr: 155, penalty: 0.0, position: 0.4,
               lat: 47.38, lon: 8.55 };
  assert.equal(S.classify(it, false)[0], 'rest');
  assert.equal(S.classify(it, true)[0], 'crossing');
});

test('test_analyse_summarises_a_messy_run', () => {
  const decay = f => 168 - 40 * f;
  const run = build([[1500, 3.3, 160, 0],
                     [25, 0, 158, 0],          // crossing
                     [2500, 3.3, 162, 0],
                     [150, 0, decay, 0],       // rest stop
                     [3000, 3.3, 168, 0],
                     [250, 1.4, 172, 0],       // fatigue walk
                     [1500, 2.7, 170, 0]]);
  const a = S.analyse(run);
  assert.notEqual(a, null);
  assert.ok(a.count >= 3);
  assert.ok((a.counts.crossing || 0) >= 1);
  assert.ok((a.counts.rest || 0) >= 1);
  assert.ok((a.counts.exhaustion || 0) >= 1);
  assert.ok(a.lost_s > a.stopped_s && a.stopped_s > 0);
  assert.ok(a.first_fatigue_m && a.first_fatigue_m > 6000);
  assert.ok(a.verdict.includes('fatigue'));
  for (const row of a.interruptions) {
    assert.ok(['crossing', 'rest', 'climb', 'exhaustion', 'eased'].includes(row.label));
    assert.ok(row.reason);
  }
});

test('test_verdict_wording', () => {
  assert.equal(S.verdict({}, []), null);
  assert.ok(S.verdict({ exhaustion: 4 }, [{ x: 1 }]).includes('came apart'));
  assert.ok(S.verdict({ rest: 1 }, [{ x: 1 }]).includes('deliberate stop'));
  assert.ok(S.verdict({ crossing: 2 }, [{ x: 1 }]).includes('traffic'));
  assert.ok(S.verdict({ climb: 2 }, [{ x: 1 }]).includes('climbs'));
});

test('test_junk_input', () => {
  assert.deepEqual(S.findInterruptions([]), []);
  assert.deepEqual(S.findInterruptions([[0, 0]]), []);
  assert.deepEqual(S.findInterruptions([[null, null, null]]), []);
  assert.equal(S.analyse([]), null);
  // Missing HR and elevation must not crash the classifier.
  const bare = [];
  for (let t = 0; t < 600; t += 5) bare.push([t, t * 3.0]);
  assert.deepEqual(S.findInterruptions(bare), []);
  const mixed = build([[1500, 3.3, null, 0], [25, 0, null, 0], [1500, 3.3, null, 0]]);
  const found = S.findInterruptions(mixed);
  assert.ok(found.length === 1 && found[0].hr_drop === null);
  assert.equal(S.classify(found[0])[0], 'crossing');
});
