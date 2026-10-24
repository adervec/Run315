// Why did you stop?
//
// Every run has interruptions. A GPS trace records all of them identically, but a
// red light, a water fountain and running out of legs are three different things,
// and only one of them is a training signal worth acting on.
//
// They are told apart by evidence rather than by duration alone:
//
//   crossing    a full stop, brief, heart rate barely moves -- no time to recover
//   rest        a full stop, long enough that heart rate actually comes down
//   climb       still moving, but slow because the ground went up
//   exhaustion  still moving, slow, heart rate stays high anyway, and the running
//               after it is worse than the running before -- that is the tell
//   eased       a slow patch with none of the above; not everything means something
//
// Pure functions over stream samples. No I/O, no dependencies. See test/stops.test.mjs.
//
// A sample is [seconds, metres, hr, lat, lon, elevation_m]; everything after the
// first two may be missing or null.
import { pyRound } from './py.js';

export const STOP_SPEED = 0.7;           // m/s -- below this you are standing, not running
export const RUN_SPEED = 2.4;            // m/s -- below this you are not running either (~6:56/km)
export const MIN_INTERRUPTION_S = 6.0;   // shorter than this is a GPS wobble, not an event
export const SMOOTH_S = 7.0;

export const CROSSING_MAX_S = 50.0;      // a light cycle; longer and it was a decision
export const CROSSING_MAX_HR_DROP = 12.0;
export const REST_MIN_HR_DROP = 10.0;

export const CLIMB_GRADE = 0.04;         // 4% up is enough to explain a slow patch
export const LATE_RUN = 0.55;            // "late" starts past here, as a fraction of the run
export const FATIGUE_HR_SHARE = 0.88;    // HR this high vs the run average while going slowly
export const PENALTY = 0.04;             // running 4% slower afterwards than before

export const WINDOW_M = 250.0;           // how much running either side to judge the damage
export const M_PER_DEG = 111320.0;

// Python float(): numbers pass, numeric strings parse, anything else is NaN.
function toFloat(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return +v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

// Sorted, distance-monotonic samples padded to [t, d, hr, lat, lon, ele].
function _norm(samples) {
  const out = [];
  for (const s of samples || []) {
    if (!s || s.length < 2 || s[0] == null || s[1] == null) continue;
    const t = toFloat(s[0]), d = toFloat(s[1]);
    if (Number.isNaN(t) || Number.isNaN(d)) continue;
    const at = i => {
      if (s.length <= i || s[i] == null) return null;
      const v = toFloat(s[i]);
      return Number.isNaN(v) ? null : v;
    };
    out.push([t, d, at(2), at(3), at(4), at(5)]);
  }
  out.sort((a, b) => a[0] - b[0]);

  const clean = [];
  let last = null;
  for (const row of out) {
    const d = last === null ? row[1] : Math.max(row[1], last);
    clean.push([row[0], d, ...row.slice(2)]);
    last = d;
  }
  return clean;
}

// [[t, d, speed_m_s, hr, lat, lon, ele]] with speed smoothed over time.
export function speedAt(pts, smoothS = SMOOTH_S) {
  if (pts.length < 3) return [];
  const raw = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
    const dt = b[0] - a[0];
    raw.push(dt > 0 ? (b[1] - a[1]) / dt : 0.0);
  }

  const out = [];
  let lo = 0, hi = 0;
  const half = smoothS / 2.0;
  for (let i = 0; i < pts.length; i++) {
    const row = pts[i];
    while (lo < i && pts[lo][0] < row[0] - half) lo++;
    while (hi + 1 < pts.length && pts[hi + 1][0] <= row[0] + half) hi++;
    let window = raw.slice(lo, hi + 1);
    if (!window.length) window = [raw[i]];
    let s = 0;
    for (const w of window) s += w;
    out.push([row[0], row[1], s / window.length, ...row.slice(2)]);
  }
  return out;
}

// Seconds per km across a slice, or null if it covers no ground.
function _paceOver(series, i0, i1) {
  if (i1 <= i0) return null;
  const dist = series[i1][1] - series[i0][1];
  const secs = series[i1][0] - series[i0][0];
  return dist > 20 && secs > 0 ? secs / (dist / 1000.0) : null;
}

function _windowBefore(series, i, metres = WINDOW_M) {
  let j = i;
  while (j > 0 && series[i][1] - series[j][1] < metres) j--;
  return _paceOver(series, j, i);
}

function _windowAfter(series, i, metres = WINDOW_M) {
  let j = i;
  while (j < series.length - 1 && series[j][1] - series[i][1] < metres) j++;
  return _paceOver(series, i, j);
}

// Rise over run across a span, as a fraction. null without elevation.
function _grade(series, i0, i1) {
  const e0 = series[i0][6], e1 = series[i1][6];
  const run = series[i1][1] - series[i0][1];
  if (e0 == null || e1 == null || run < 20) return null;
  return (e1 - e0) / run;
}

const avg = xs => { let s = 0; for (const x of xs) s += x; return s / xs.length; };

// Every stretch where the running stopped or dropped to a walk.
//
// -> array of objects, each describing one interruption and the running around it.
export function findInterruptions(samples, minS = MIN_INTERRUPTION_S) {
  const pts = _norm(samples);
  const series = speedAt(pts);
  if (series.length < 8) return [];

  const totalS = series[series.length - 1][0] - series[0][0];
  const hrs = series.map(r => r[3]).filter(h => h);
  const runHr = hrs.length ? avg(hrs) : null;

  const spans = [];
  let start = null;
  for (let i = 0; i < series.length; i++) {
    const row = series[i];
    if (row[2] < RUN_SPEED && start === null) start = i;
    else if (row[2] >= RUN_SPEED && start !== null) { spans.push([start, i - 1]); start = null; }
  }
  if (start !== null) spans.push([start, series.length - 1]);

  const out = [];
  for (const [i0, i1] of spans) {
    const secs = series[i1][0] - series[i0][0];
    if (secs < minS) continue;
    // The very start and end of a file are the warm-up walk to the door.
    if (series[i0][1] < 100 || series[series.length - 1][1] - series[i1][1] < 100) continue;

    const dist = series[i1][1] - series[i0][1];
    const speeds = [], spanHrs = [];
    for (let k = i0; k <= i1; k++) {
      speeds.push(series[k][2]);
      if (series[k][3]) spanHrs.push(series[k][3]);
    }
    const meanSpeed = avg(speeds);

    // Smoothing bleeds running speed into the edges of a stop, so the span's
    // mean is not stationary even when the athlete plainly was. The minimum
    // is: nothing that is still moving ever reads near zero.
    const minSpeed = Math.min(...speeds);
    let stoppedS = 0.0;
    for (let k = i0; k < i1; k++) {
      if (series[k][2] < STOP_SPEED) stoppedS += series[k + 1][0] - series[k][0];
    }
    const before = _windowBefore(series, i0), after = _windowAfter(series, i1);
    const has = spanHrs.length > 0;

    out.push({
      start_s: series[i0][0], end_s: series[i1][0], seconds: secs,
      at_m: series[i0][1], distance_m: dist,
      mean_speed: meanSpeed,
      min_speed: minSpeed,
      stopped_s: stoppedS,
      full_stop: minSpeed < STOP_SPEED,
      hr_in: has ? spanHrs[0] : null,
      hr_out: has ? spanHrs[spanHrs.length - 1] : null,
      hr_drop: has ? spanHrs[0] - Math.min(...spanHrs) : null,
      hr_mean: has ? avg(spanHrs) : null,
      run_hr: runHr,
      pace_before: before, pace_after: after,
      penalty: before && after ? after / before - 1.0 : null,
      grade: _grade(series, i0, i1),
      position: totalS > 0 ? (series[i0][0] - series[0][0]) / totalS : 0.0,
      lat: series[i0][4], lon: series[i0][5],
    });
  }
  return out;
}

// Label one interruption. -> [label, confidence 0-1, plain-English reason].
export function classify(it, junction = false) {
  const hrDrop = it.hr_drop ?? null;
  const grade = it.grade ?? null;
  // For a stop, judge on the time actually spent standing -- the smoothed ramp
  // either side would otherwise turn a 20 s light into a 35 s "decision".
  const secs = it.full_stop ? (it.stopped_s || it.seconds) : it.seconds;

  if (it.full_stop) {
    if (junction && secs <= CROSSING_MAX_S * 1.5) {
      return ['crossing', 0.9, 'Stopped dead where you often stop -- a junction, not a decision.'];
    }
    if (secs <= CROSSING_MAX_S && (hrDrop === null || hrDrop <= CROSSING_MAX_HR_DROP)) {
      return ['crossing', 0.75, 'Short full stop with heart rate barely moving: a road crossing.'];
    }
    if (secs > CROSSING_MAX_S && (hrDrop === null || hrDrop >= REST_MIN_HR_DROP)) {
      return ['rest', 0.8, 'Stood still long enough for heart rate to come down: a real break.'];
    }
    if (secs > CROSSING_MAX_S) {
      return ['rest', 0.55, 'A long stop, though heart rate stayed up -- a queue or a chat.'];
    }
    return ['crossing', 0.5, 'Brief full stop.'];
  }

  // Still moving, just not running.
  if (grade !== null && grade >= CLIMB_GRADE) {
    return ['climb', 0.8, `Slowed on a ${(grade * 100).toFixed(0)}% climb -- the hill explains this one.`];
  }

  const hot = it.hr_mean != null && !!it.run_hr && it.hr_mean >= FATIGUE_HR_SHARE * it.run_hr;
  const worse = it.penalty != null && it.penalty > PENALTY;
  const late = it.position >= LATE_RUN;

  if (late && hot && worse) {
    return ['exhaustion', 0.85,
      'Late, heart rate still high while barely moving, and you never got ' +
      'the pace back: this was fatigue.'];
  }
  if (late && (hot || worse)) {
    return ['exhaustion', 0.6, 'Late in the run and the pace afterwards was worse -- probably fatigue.'];
  }
  if (grade !== null && grade <= -CLIMB_GRADE) {
    return ['eased', 0.6, 'Slow patch on a descent -- most likely terrain underfoot.'];
  }
  return ['eased', 0.4, 'Eased off briefly with nothing else to explain it.'];
}

const cellKey = (lat, lon) => lat + ',' + lon;

// Places you stop on many different runs. -> array of rounded [lat, lon].
//
// A spot where you stop dead on run after run is a road crossing. No map data
// needed: your own history says so. `runs` is [[interruption, ...], ...].
export function junctionTiles(runs, minRuns = 3, precision = 4) {
  const seen = new Map();                      // key -> [cell, Set of run indices]
  (runs || []).forEach((interruptions, idx) => {
    for (const it of interruptions) {
      if (!it.full_stop || it.lat == null) continue;
      const cell = [pyRound(it.lat, precision), pyRound(it.lon, precision)];
      const k = cellKey(cell[0], cell[1]);
      if (!seen.has(k)) seen.set(k, [cell, new Set()]);
      seen.get(k)[1].add(idx);
    }
  });
  return [...seen.values()].filter(([, hits]) => hits.size >= minRuns).map(([cell]) => cell);
}

// Classify every interruption in one run and summarise them. -> object or null.
// `junctions` is what junctionTiles() returns (any iterable of [lat, lon]).
export function analyse(samples, junctions = null) {
  const found = findInterruptions(samples);
  if (!found.length) return null;
  const jset = new Set();
  for (const c of junctions || []) jset.add(cellKey(c[0], c[1]));

  const labelled = [];
  for (const it of found) {
    const near = it.lat != null && jset.has(cellKey(pyRound(it.lat, 4), pyRound(it.lon, 4)));
    const [label, confidence, reason] = classify(it, near);
    labelled.push({ ...it, label, confidence, reason, junction: near });
  }

  const counts = {};
  for (const row of labelled) counts[row.label] = (counts[row.label] || 0) + 1;
  let lost = 0, stopped = 0;
  for (const r of labelled) { lost += r.seconds; stopped += r.stopped_s || 0.0; }
  const fatigue = labelled.filter(r => r.label === 'exhaustion');

  return {
    interruptions: labelled,
    count: labelled.length,
    counts,
    lost_s: lost,
    stopped_s: stopped,
    fatigue_count: fatigue.length,
    first_fatigue_m: fatigue.length ? Math.min(...fatigue.map(r => r.at_m)) : null,
    verdict: verdict(counts, labelled),
  };
}

const s = n => (n === 1 ? '' : 's');

// One line summing the run up, in the terms a runner would use.
export function verdict(counts, rows) {
  if (!rows || !rows.length) return null;
  const fatigue = counts.exhaustion || 0;
  if (fatigue >= 3) return `You came apart in the back half -- ${fatigue} fatigue breaks.`;
  if (fatigue) return `Mostly held together, with ${fatigue} fatigue break${s(fatigue)} late on.`;
  if (counts.rest) return `Clean running either side of ${counts.rest} deliberate stop${s(counts.rest)}.`;
  if (counts.crossing) return `Only traffic broke this one up -- ${counts.crossing} crossing${s(counts.crossing)}, no fade.`;
  if (counts.climb) return 'The only slow patches were climbs.';
  return 'A few easy patches, nothing that reads as fatigue.';
}
