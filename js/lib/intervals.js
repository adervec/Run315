// Track and interval analysis: find the reps inside a run.
//
// Garmin only records laps if the athlete remembered to press the button, and on a
// track nobody presses it for the recovery. So the reps are recovered from the pace
// stream instead: an interval session is bimodal -- hard bits and jog bits -- and
// the split between them is found rather than assumed.
//
// Pure functions over stream samples. No I/O, no dependencies. See
// test/intervals.test.mjs.
//
// A sample is [seconds, cumulative_metres, hr_or_null] or any longer array whose
// first three entries are those; extra fields (lat, lon) are ignored.
import { pyRound, pstdev } from './py.js';

// What counts as a rep. Anything briefer is a traffic light or a GPS wobble.
export const MIN_REP_S = 18.0;
export const MIN_REP_M = 120.0;
export const MERGE_GAP_S = 6.0;          // two "reps" this close are one rep with a glitch
export const SMOOTH_S = 9.0;             // pace smoothing window; shorter and GPS noise wins

// A run only counts as intervals if the hard bits are genuinely a different gear.
export const MIN_SPEED_RATIO = 1.15;     // fast cluster this much faster than the jog
export const MIN_PACE_GAP_S = 25.0;      // ...and at least this many seconds per km quicker

// Standing still is not a recovery jog. Traffic lights make any steady run look
// bimodal, so stationary samples are kept out of the clustering entirely.
// ponytail: this also means a session run with standing recoveries will not be
// detected. Jog recoveries are the common case; revisit by treating long stops
// as rep separators if that stops being true.
export const STANDING_SPEED = 0.8;

// In a real session the reps are a minority of the running -- roughly half, with
// recovery in between. A long run with one walk break is 95% "fast", which is how
// you tell the two apart.
export const MAX_FAST_SHARE = 0.80;

// Standard track and road rep distances, in metres. A GPS lap of a 400 m oval
// routinely measures 385-415, so measured distances get snapped to these.
export const TRACK_DISTANCES = [100, 200, 300, 400, 600, 800, 1000, 1200, 1600, 2000, 3000, 5000];
export const SNAP_TOLERANCE = 0.08;      // within 8% of a standard distance counts as that rep

// A 400 m oval and its infield fit inside about 180 x 100 m.
export const TRACK_BBOX_M = 260.0;
export const TRACK_LOOP_RATIO = 6.0;     // distance run over bbox diagonal: high means laps

// Python float(): numbers pass, numeric strings parse, anything else is NaN.
function toFloat(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return +v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

const total = xs => { let s = 0; for (const x of xs) s += x; return s; };

// Sorted [t, d, hr] with monotonic distance and no junk.
function _clean(samples) {
  const out = [];
  for (const s of samples || []) {
    if (!s || s.length < 2) continue;
    if (s[0] == null || s[1] == null) continue;
    const t = toFloat(s[0]), d = toFloat(s[1]);
    if (Number.isNaN(t) || Number.isNaN(d)) continue;
    const hr = s.length > 2 ? s[2] : null;
    out.push([t, d, hr ? toFloat(hr) : null]);
  }
  out.sort((a, b) => a[0] - b[0]);

  const clean = [];
  let lastD = null;
  for (let [t, d, hr] of out) {
    if (lastD !== null && d < lastD) d = lastD;   // GPS distance never goes backwards
    clean.push([t, d, hr]);
    lastD = d;
  }
  return clean;
}

// [[t, d, speed_m_s, hr]] with speed smoothed over `smoothS`.
//
// Central differences, then a time-windowed mean. Raw GPS speed is far too
// noisy to threshold directly -- a single bad fix would split a rep in two.
export function speedSeries(samples, smoothS = SMOOTH_S) {
  const pts = _clean(samples);
  if (pts.length < 3) return [];

  const raw = pts.map(([t, d, hr], i) => {
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
    const dt = b[0] - a[0];
    return [t, d, dt > 0 ? (b[1] - a[1]) / dt : 0.0, hr];
  });

  // Windowed mean over a moving index range; the stream is time-ordered so the
  // window edges only ever move forward.
  const out = [];
  let lo = 0, hi = 0;
  const half = smoothS / 2.0;
  for (let i = 0; i < raw.length; i++) {
    const [t, d, , hr] = raw[i];
    while (lo < i && raw[lo][0] < t - half) lo++;
    while (hi + 1 < raw.length && raw[hi + 1][0] <= t + half) hi++;
    let window = raw.slice(lo, hi + 1);
    if (!window.length) window = [raw[i]];
    out.push([t, d, total(window.map(w => w[2])) / window.length, hr]);
  }
  return out;
}

// The split that best separates two clusters. null if there is only one.
//
// Otsu's method: pick the cut maximising between-class variance. It needs no
// tuning, which matters because a 400 m rep session and a fartlek have very
// different "fast".
export function otsuThreshold(values, bins = 64) {
  const vals = values.filter(v => v != null);
  if (vals.length < 4) return null;
  let lo = Infinity, hi = -Infinity;
  for (const v of vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (hi - lo < 1e-9) return null;

  const hist = new Array(bins).fill(0);
  for (const v of vals) hist[Math.min(Math.trunc((v - lo) / (hi - lo) * bins), bins - 1)] += 1;
  const n = vals.length;
  let grand = 0;
  for (let i = 0; i < bins; i++) grand += (i + 0.5) * hist[i];

  let bestVar = -1.0, bestCut = null, w0 = 0, sum0 = 0.0;
  for (let i = 0; i < bins; i++) {
    w0 += hist[i];
    if (w0 === 0) continue;
    const w1 = n - w0;
    if (w1 === 0) break;
    sum0 += (i + 0.5) * hist[i];
    const between = w0 * w1 * (sum0 / w0 - (grand - sum0) / w1) ** 2;
    if (between > bestVar) { bestVar = between; bestCut = lo + (i + 1) / bins * (hi - lo); }
  }
  return bestCut;
}

// How far apart the two clusters either side of `cut` really are.
//
// -> [fastMean, slowMean, ratio], or null if either side is empty.
//
// Otsu always returns *a* threshold, including for a steady run where there is
// nothing to separate. Without this check a hilly easy hour gets chopped into
// twenty imaginary reps.
export function separation(values, cut) {
  const fast = values.filter(v => v != null && v >= cut);
  const slow = values.filter(v => v != null && v < cut);
  if (!fast.length || !slow.length) return null;
  const fm = total(fast) / fast.length, sm = total(slow) / slow.length;
  if (sm <= 0) return null;
  return [fm, sm, fm / sm];
}

// True when the pace really is bimodal, not just noisy.
//
// Both tests have to pass: the hard bits must be proportionally faster *and*
// faster by an amount a runner would notice.
export function isIntervalShaped(values, cut) {
  const sep = separation(values, cut);
  if (!sep) return false;
  const [fast, slow, ratio] = sep;
  if (ratio < MIN_SPEED_RATIO) return false;
  const share = values.filter(v => v != null && v >= cut).length / values.length;
  if (share > MAX_FAST_SHARE) return false;      // one slow patch, not a session
  const paceGap = 1000.0 / slow - 1000.0 / fast; // seconds per km
  return paceGap >= MIN_PACE_GAP_S;
}

// Nearest standard rep distance, or null if it is not close to one.
export function snapDistance(metres) {
  if (!metres || metres <= 0) return null;
  let best = TRACK_DISTANCES[0];
  for (const d of TRACK_DISTANCES) if (Math.abs(d - metres) < Math.abs(best - metres)) best = d;
  return Math.abs(best - metres) / best <= SNAP_TOLERANCE ? best : null;
}

// Find the work intervals in a run. -> array of rep objects.
//
// Each rep carries its own numbers plus the recovery that followed it, which is
// the half of a session people actually argue about.
export function detectReps(samples, minRepS = MIN_REP_S, minRepM = MIN_REP_M,
                           mergeGapS = MERGE_GAP_S) {
  const series = speedSeries(samples);
  if (series.length < 8) return [];
  // Exclude standing samples *and* the smoothed ramp either side of them. The
  // ramp is an artefact of the smoothing window, not running, and on its own it
  // is enough to fake a slow cluster and turn every red light into a rep.
  const blocked = new Array(series.length).fill(false);
  for (let i = 0; i < series.length; i++) {
    const row = series[i];
    if (row[2] >= STANDING_SPEED) continue;
    for (let j = i; j >= 0 && row[0] - series[j][0] <= SMOOTH_S; j--) blocked[j] = true;
    for (let j = i; j < series.length && series[j][0] - row[0] <= SMOOTH_S; j++) blocked[j] = true;
  }

  const moving = series.filter((_, i) => !blocked[i]).map(r => r[2]);
  const cut = otsuThreshold(moving);
  if (cut === null || !isIntervalShaped(moving, cut)) return [];

  // Contiguous stretches above the cut.
  const spans = [];
  let start = null;
  for (let i = 0; i < series.length; i++) {
    const sp = series[i][2];
    if (sp >= cut && start === null) start = i;
    else if (sp < cut && start !== null) { spans.push([start, i - 1]); start = null; }
  }
  if (start !== null) spans.push([start, series.length - 1]);

  // A dropped fix mid-rep splits it; stitch those back together.
  const merged = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && series[span[0]][0] - series[last[1]][0] <= mergeGapS) merged[merged.length - 1] = [last[0], span[1]];
    else merged.push(span);
  }

  const reps = [];
  for (const [i0, i1] of merged) {
    const [t0, d0] = series[i0], [t1, d1] = series[i1];
    const secs = t1 - t0, dist = d1 - d0;
    if (secs < minRepS || dist < minRepM) continue;
    const hrs = series.slice(i0, i1 + 1).map(s => s[3]).filter(h => h);
    reps.push({
      start_s: t0, end_s: t1,
      seconds: secs, distance_m: dist,
      pace: secs / (dist / 1000.0),
      speed: dist / secs,
      avg_hr: hrs.length ? total(hrs) / hrs.length : null,
      snapped_m: snapDistance(dist),
      recovery_s: null, recovery_m: null,
    });
  }

  for (let k = 0; k + 1 < reps.length; k++) {
    reps[k].recovery_s = reps[k + 1].start_s - reps[k].end_s;
    reps[k].recovery_m = null;
  }
  // Recovery distance needs the stream again, so fill it in one pass.
  for (let k = 0; k + 1 < reps.length; k++) {
    const a = reps[k], b = reps[k + 1];
    const span = series.filter(s => a.end_s <= s[0] && s[0] <= b.start_s);
    if (span.length > 1) a.recovery_m = span[span.length - 1][1] - span[0][1];
  }

  reps.forEach((rep, i) => { rep.n = i + 1; });
  return reps;
}

// Coefficient of variation of rep pace. 0 means metronomic. null if < 2.
export function consistency(reps) {
  const paces = reps.map(r => r.pace).filter(p => p);
  if (paces.length < 2) return null;
  const mean = total(paces) / paces.length;
  if (mean <= 0) return null;
  return pstdev(paces) / mean;
}

// How much the second half of the set slowed relative to the first, as a
// fraction. Positive means you faded; negative means you negative-split it.
export function fade(reps) {
  const paces = reps.map(r => r.pace).filter(p => p);
  if (paces.length < 4) return null;
  const half = paces.length >> 1;
  const first = total(paces.slice(0, half)) / half;
  const second = total(paces.slice(paces.length - half)) / half;
  return first > 0 ? second / first - 1.0 : null;
}

// Was this run done on a 400 m oval? -> [bool, bboxDiagonalM].
//
// A track session covers a lot of distance inside a very small box. That ratio
// separates it from a road loop far more reliably than distance alone.
export function looksLikeTrack(points) {
  const coords = (points || [])
    .filter(p => p && p.length >= 2 && p[0] != null && p[1] != null)
    .map(p => [p[0], p[1]]);
  if (coords.length < 20) return [false, null];
  const lats = coords.map(c => c[0]), lons = coords.map(c => c[1]);
  const mid = (total(lats) / lats.length) * Math.PI / 180;
  const dy = (Math.max(...lats) - Math.min(...lats)) * 111320.0;
  const dx = (Math.max(...lons) - Math.min(...lons)) * 111320.0 * Math.cos(mid);
  const diag = Math.hypot(dx, dy);
  if (diag <= 0) return [false, diag];

  let run = 0.0;
  for (let i = 0; i + 1 < coords.length; i++) {
    const a = coords[i], b = coords[i + 1];
    run += Math.hypot((b[0] - a[0]) * 111320.0, (b[1] - a[1]) * 111320.0 * Math.cos(mid));
  }
  return [diag <= TRACK_BBOX_M && run / diag >= TRACK_LOOP_RATIO, diag];
}

// A one-line name for the session, the way a coach would write it.
//
// "8 x 400 m" when the set is uniform, "6 reps, 400-1000 m" when it is not.
export function describe(reps) {
  if (!reps || !reps.length) return null;
  const snapped = reps.map(r => r.snapped_m ?? null);
  if (snapped.every(s => s !== null) && new Set(snapped).size === 1) {
    return `${reps.length} x ${Math.trunc(snapped[0])} m`;
  }
  const known = snapped.filter(s => s !== null);
  if (known.length === reps.length && known.length) {
    return `${reps.length} reps, ${Math.trunc(Math.min(...known))}-${Math.trunc(Math.max(...known))} m`;
  }
  const lo = Math.min(...reps.map(r => r.distance_m));
  const hi = Math.max(...reps.map(r => r.distance_m));
  if (Math.abs(hi - lo) / Math.max(hi, 1.0) < 0.1) {
    return `${reps.length} x ~${pyRound((lo + hi) / 2 / 10) * 10} m`;
  }
  return `${reps.length} reps, ${pyRound(lo)}-${pyRound(hi)} m`;
}

// Full session analysis. -> object, or null when there is no rep structure.
export function analyse(samples, points = null) {
  const reps = detectReps(samples);
  if (reps.length < 2) return null;
  const [onTrack, diag] = looksLikeTrack(points || []);
  const workS = total(reps.map(r => r.seconds));
  const workM = total(reps.map(r => r.distance_m));
  const recoveries = reps.map(r => r.recovery_s).filter(r => r);
  const paces = reps.map(r => r.pace);
  return {
    reps,
    count: reps.length,
    name: describe(reps),
    work_s: workS,
    work_m: workM,
    avg_pace: workM ? workS / (workM / 1000.0) : null,
    fastest: Math.min(...paces),
    slowest: Math.max(...paces),
    consistency: consistency(reps),
    fade: fade(reps),
    avg_recovery_s: recoveries.length ? total(recoveries) / recoveries.length : null,
    on_track: onTrack,
    bbox_m: diag,
    uniform: new Set(reps.map(r => r.snapped_m)).size === 1 && reps[0].snapped_m !== null,
  };
}
