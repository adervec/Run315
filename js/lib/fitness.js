// Fitness model: training load (CTL/ATL/TSB) and race-time projection.
//
// Pure functions over activity objects. No I/O, no dependencies -- testable on
// its own (see test/fitness.test.mjs).
//
// An activity needs: type, start (Date), distance_m, moving_s, elapsed_s,
// avg_hr. Missing values may be null.
//
// Dates: Python `date` values are 'YYYY-MM-DD' day keys here. `daily` (the
// {date: load} dict) is a plain object keyed by day key.
import { dayKey, addDayKey, daysBetween, weekStart } from './dt.js';
import { pyRound, divmod } from './py.js';

export const RUN_TYPES = new Set(['running', 'trail_running', 'treadmill_running', 'track_running',
  'virtual_run', 'indoor_running']);
export const CARDIO_TYPES = new Set([...RUN_TYPES,
  'cycling', 'road_biking', 'indoor_cycling', 'mountain_biking', 'gravel_cycling',
  'virtual_ride', 'commuting', 'lap_swimming', 'open_water_swimming', 'walking',
  'hiking', 'rowing', 'indoor_rowing', 'elliptical', 'stair_climbing',
  'fitness_equipment', 'cardio', 'other',
]);

// Distance buckets for picking one best effort per range (metres).
export const BUCKETS = [[1500, 3200], [3200, 7000], [7000, 13000], [13000, 25000], [25000, 60000]];

export const RIEGEL = 1.06;          // textbook fatigue exponent, used as fallback + normaliser
export const MIN_EXPONENT = 1.01, MAX_EXPONENT = 1.20;   // physiologically plausible range
export const CTL_DAYS = 42, ATL_DAYS = 7;
export const HALF_LIFE_DAYS = 90.0;  // recency weighting of past efforts in the fit

export const STANDARD_RACES = [
  ['5K', 5000], ['10K', 10000], ['15K', 15000], ['10 mi', 16093],
  ['Half marathon', 21097], ['Marathon', 42195], ['50K', 50000],
];

// Python's min/max(xs, key=f): the FIRST extreme wins on ties.
function _minBy(xs, f) {
  let best, bv;
  for (const x of xs) { const v = f(x); if (best === undefined || v < bv) { best = x; bv = v; } }
  return best;
}
function _maxBy(xs, f) {
  let best, bv;
  for (const x of xs) { const v = f(x); if (best === undefined || v > bv) { best = x; bv = v; } }
  return best;
}
const _pad2 = n => String(n).padStart(2, '0');

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //
// Linear-interpolated percentile. q in [0,1]. null for empty input.
export function percentile(values, q) {
  const vals = values.filter(v => v != null).sort((a, b) => a - b);
  if (!vals.length) return null;
  const k = (vals.length - 1) * q;
  const lo = Math.floor(k), hi = Math.ceil(k);
  if (lo === hi) return vals[lo];
  return vals[lo] + (vals[hi] - vals[lo]) * (k - lo);
}

// Seconds -> h:mm:ss or m:ss.
export function fmtTime(seconds) {
  if (seconds == null) return '--';
  const s = pyRound(seconds);
  const [h, rem] = divmod(s, 3600);
  const [m, sec] = divmod(rem, 60);
  return h ? `${h}:${_pad2(m)}:${_pad2(sec)}` : `${m}:${_pad2(sec)}`;
}

// Pace as m:ss /km.
export function fmtPace(seconds, metres) {
  if (!seconds || !metres) return '--';
  return fmtTime(seconds / (metres / 1000.0)) + ' /km';
}

// Speed as km/h -- how riders and rowers read their efforts.
export function fmtSpeed(seconds, metres) {
  if (!seconds || !metres) return '--';
  return (metres / 1000.0 / (seconds / 3600.0)).toFixed(1) + ' km/h';
}

export const SPEED_TYPES = new Set(['cycling', 'road_biking', 'indoor_cycling', 'mountain_biking',
  'gravel_cycling', 'virtual_ride', 'commuting', 'rowing', 'indoor_rowing']);

// Pace for runs and walks, speed for rides -- whichever the athlete thinks in.
export function fmtEffort(activity) {
  const secs = activity.moving_s || activity.elapsed_s;
  const dist = activity.distance_m;
  const fmt = SPEED_TYPES.has(activity.type) ? fmtSpeed : fmtPace;
  return fmt(secs, dist);
}

// --------------------------------------------------------------------------- //
// training load
// --------------------------------------------------------------------------- //
// Self-calibrating threshold HR and per-sport threshold speed. -> [thr_hr, thr_spd]
//
// The 95th percentile of activity-average HR sits close to lactate threshold
// for anyone who does the occasional hard session -- no user input needed.
export function thresholds(activities) {
  // Sessions that bring their own load (GymTracker's strength work) stay out of threshold HR:
  // lifting heart rate says nothing about the top of a run.
  const thrHr = percentile(activities.filter(a => typeof a.load !== 'number').map(a => a.avg_hr), 0.95);
  const bySport = new Map();
  for (const a of activities) {
    const d = a.distance_m, t = a.moving_s;
    if (d && t && t > 0) {
      const k = a.type ?? null;
      if (!bySport.has(k)) bySport.set(k, []);
      bySport.get(k).push(d / t);
    }
  }
  const thrSpd = {};
  for (const [k, v] of bySport) thrSpd[k] = percentile(v, 0.95);
  return [thrHr, thrSpd];
}

// TSS-style load: hours * intensity^2 * 100.
export function activityLoad(activity, thrHr, thrSpd) {
  if (typeof activity.load === 'number') return activity.load;   // precomputed (strength sessions)
  const secs = activity.moving_s || activity.elapsed_s || 0;
  const hours = secs / 3600.0;
  if (hours <= 0) return 0.0;

  const hr = activity.avg_hr, sport = activity.type;
  const dist = activity.distance_m, mov = activity.moving_s;
  const sk = sport ?? null;  // Python keys a missing type as None
  const spd = thrSpd && Object.hasOwn(thrSpd, sk) ? thrSpd[sk] : null;
  let intensity;
  if (hr && thrHr) intensity = hr / thrHr;
  else if (dist && mov && spd) intensity = (dist / mov) / spd;
  // ponytail: no HR and no pace baseline -> assume a steady aerobic effort.
  else intensity = 0.75;
  intensity = Math.max(0.4, Math.min(1.15, intensity));
  return hours * intensity * intensity * 100.0;
}

// {dayKey: total load} over cardio activities.
export function dailyLoads(activities, thrHr, thrSpd) {
  const out = {};
  for (const a of activities) {
    if (!(CARDIO_TYPES.has(a.type) || typeof a.load === 'number') || !a.start) continue;
    const day = dayKey(a.start);
    out[day] = (out[day] ?? 0.0) + activityLoad(a, thrHr, thrSpd);
  }
  return out;
}

// [[day, load, ctl, atl, tsb]] -- CTL/ATL are exponential moving averages.
export function loadCurve(daily, endDate, days = 180) {
  const kc = 1.0 - Math.exp(-1.0 / CTL_DAYS);
  const ka = 1.0 - Math.exp(-1.0 / ATL_DAYS);
  let ctl = 0.0, atl = 0.0;
  const start = addDayKey(endDate, -days);
  const curve = [];
  // Warm the averages up over an equal-length run-in so day one is not zero.
  let day = addDayKey(start, -days);
  while (day <= endDate) {
    const load = daily[day] ?? 0.0;
    ctl += (load - ctl) * kc;
    atl += (load - atl) * ka;
    if (day >= start) curve.push([day, load, ctl, atl, ctl - atl]);
    day = addDayKey(day, 1);
  }
  return curve;
}

// --------------------------------------------------------------------------- //
// race projection
// --------------------------------------------------------------------------- //
export const HARD_HR_FRACTION = 0.88;   // of threshold HR -- below this it is a training run

function _bucketIndex(distanceM) {
  for (let i = 0; i < BUCKETS.length; i++) {
    const [lo, hi] = BUCKETS[i];
    if (lo <= distanceM && distanceM < hi) return i;
  }
  return null;
}

// [[distance_m, time_s, age_days]] of plausible running *efforts*.
//
// An easy long run is not an effort, and letting one into the fit makes the
// athlete look like they fade badly over distance. When heart rate is
// available we keep only the genuinely hard runs; that filter is dropped if it
// would leave too little to fit.
export function bestEfforts(activities, now, days = 180, thrHr = null) {
  let cand = [];
  for (const a of activities) {
    if (!RUN_TYPES.has(a.type)) continue;
    const d = a.distance_m || 0.0;
    const t = a.moving_s || a.elapsed_s || 0.0;
    if (d < 1500 || t <= 0 || !a.start) continue;
    const pace = t / (d / 1000.0);          // s/km
    if (pace < 120 || pace > 720) continue; // 2:00 - 12:00 /km, drops GPS junk
    const age = daysBetween(a.start, now);
    if (0 <= age && age <= days) cand.push([d, t, age, a.avg_hr ?? null]);
  }

  if (thrHr) {
    const hard = cand.filter(c => c[3] && c[3] >= HARD_HR_FRACTION * thrHr);
    if (new Set(hard.map(c => _bucketIndex(c[0]))).size >= 2) cand = hard;
  }
  return cand.map(([d, t, age]) => [d, t, age]);
}

// Fatigue exponent implied by two efforts, or null if they are the same distance.
export function impliedExponent(e1, e2) {
  const [d1, t1] = e1, [d2, t2] = e2;
  if (d1 <= 0 || d2 <= 0 || Math.abs(Math.log(d2) - Math.log(d1)) < 1e-9) return null;
  return (Math.log(t2) - Math.log(t1)) / (Math.log(d2) - Math.log(d1));
}

// One best effort per distance bucket, keeping only plausible race efforts.
//
// A bucket's best is dropped when the exponent it implies against the athlete's
// strongest performance is outside the physiological range -- that is what an
// easy long run looks like, and letting one in fakes a severe fade. A genuinely
// slower-over-distance runner still implies an in-range exponent, so real
// long-distance results survive this.
export function bucketBests(efforts) {
  const norm = e => e[1] * (10000.0 / e[0]) ** RIEGEL;

  const picks = [];
  for (const [lo, hi] of BUCKETS) {
    const cand = efforts.filter(e => lo <= e[0] && e[0] < hi);
    if (cand.length) picks.push(_minBy(cand, norm));
  }
  if (picks.length < 2) return picks;

  const anchor = _minBy(picks, norm);
  const kept = [];
  for (const p of picks) {
    if (p === anchor) { kept.push(p); continue; }
    const [short, long_] = [anchor, p].sort((x, y) => x[0] - y[0]);
    const b = impliedExponent(short, long_);
    if (b !== null && MIN_EXPONENT <= b && b <= MAX_EXPONENT) kept.push(p);
  }
  return kept;
}

// Weighted log-log fit of time vs distance -> [intercept, exponent, points].
//
// Returns null when there is nothing to fit. The exponent is the athlete's
// personal fatigue factor; it is clamped because a 2-point fit on noisy data
// can otherwise produce nonsense.
export function fitPowerLaw(efforts) {
  const pts = bucketBests(efforts);
  if (!pts.length) return null;
  if (pts.length === 1) {
    const [d, t] = pts[0];
    return [Math.log(t) - RIEGEL * Math.log(d), RIEGEL, pts];
  }

  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
  for (const [d, t, age] of pts) {
    const w = 0.5 ** (age / HALF_LIFE_DAYS);
    const x = Math.log(d), y = Math.log(t);
    sw += w;
    swx += w * x;
    swy += w * y;
    swxx += w * x * x;
    swxy += w * x * y;
  }
  const den = sw * swxx - swx * swx;
  if (Math.abs(den) < 1e-9) {
    const [d, t] = pts[0];
    return [Math.log(t) - RIEGEL * Math.log(d), RIEGEL, pts];
  }
  let b = (sw * swxy - swx * swy) / den;
  b = Math.max(MIN_EXPONENT, Math.min(MAX_EXPONENT, b));
  const a = (swy - b * swx) / sw;
  return [a, b, pts];
}

// Predicted seconds at distance_m from current form, no trend applied.
export function basePrediction(fit, distanceM) {
  if (!fit) return null;
  const [a, b] = fit;
  return Math.exp(a + b * Math.log(distanceM));
}

// Multiplier on predicted time for fitness trending up (or down).
//
// ponytail: heuristic -- time scales as fitness ** -0.15, capped at +/-4%.
// Upgrade path: fit the exponent per user once there is race-result history.
export function fitnessFactor(ctlNow, ctlBefore, daysToRace) {
  if (!ctlNow || !ctlBefore || ctlBefore <= 0 || !daysToRace) return 1.0;
  if (daysToRace <= 0) return 1.0;
  const weeklyGrowth = (ctlNow / ctlBefore) ** (1.0 / 6.0) - 1.0;
  const weeks = Math.min(daysToRace / 7.0, 12.0);          // do not extrapolate past ~3 months
  const projected = (1.0 + weeklyGrowth) ** weeks;
  if (projected <= 0) return 1.0;
  return Math.max(0.96, Math.min(1.04, projected ** -0.15));
}

// How much to trust this projection: high / medium / low / none.
export function confidence(fit, distanceM) {
  if (!fit) return 'none';
  const pts = fit[2];
  if (pts.length < 2) return 'low';
  const longest = Math.max(...pts.map(p => p[0]));
  const fresh = Math.min(...pts.map(p => p[2]));
  const stretch = distanceM / longest;
  if (pts.length >= 3 && stretch <= 1.6 && fresh <= 45) return 'high';
  if (stretch <= 3.0 && fresh <= 120) return 'medium';
  return 'low';
}

// Current-form snapshot shared by the dashboard, the projections and the coach.
//
// `segmentEfforts` is [[distance_m, seconds, age_days]] of true best efforts
// measured inside activities. They are strictly better evidence than a whole
// run, so they compete for -- and normally win -- each distance bucket.
export function summarise(activities, now, segmentEfforts = null) {
  const [thrHr, thrSpd] = thresholds(activities);
  const daily = dailyLoads(activities, thrHr, thrSpd);
  const curve = loadCurve(daily, dayKey(now));
  const last = curve.length ? curve[curve.length - 1] : null;
  const ctlNow = last ? last[2] : 0.0;
  const ctlBefore = curve.length >= 43 ? curve[curve.length - 43][2] : (curve.length ? curve[0][2] : 0.0);

  let efforts = bestEfforts(activities, now, 180, thrHr);
  if (segmentEfforts && segmentEfforts.length) {
    efforts = efforts.concat(segmentEfforts.filter(e => 0 <= e[2] && e[2] <= 180));
  }
  const fit = fitPowerLaw(efforts);

  return {
    curve,
    daily,
    ctl: ctlNow,
    atl: last ? last[3] : 0.0,
    tsb: last ? last[4] : 0.0,
    ctl_6w_ago: ctlBefore,
    threshold_hr: thrHr,
    fit,
    efforts,
    weekly: weeklyTotals(activities, now),
    paces: trainingPaces(fit),
    zones: hrZones(thrHr),
    spike: sessionSpike(activities
      .filter(a => RUN_TYPES.has(a.type) && a.distance_m)
      .map(a => [dayKey(a.start), a.distance_m])),
    threshold_pace: thresholdPace(fit),
  };
}

// [[week_start_day, km, hours, load]] most recent last.
export function weeklyTotals(activities, now, weeks = 12) {
  const [thrHr, thrSpd] = thresholds(activities);
  const monday = weekStart(now);
  const first = addDayKey(monday, -7 * (weeks - 1));
  const buckets = {};
  for (const a of activities) {
    if (!(CARDIO_TYPES.has(a.type) || typeof a.load === 'number') || !a.start) continue;
    const wk = weekStart(a.start);
    if (!(first <= wk && wk <= monday)) continue;
    const [km, hrs, load] = buckets[wk] ?? [0.0, 0.0, 0.0];
    buckets[wk] = [
      km + (a.distance_m || 0) / 1000.0,
      hrs + (a.moving_s || a.elapsed_s || 0) / 3600.0,
      load + activityLoad(a, thrHr, thrSpd),
    ];
  }
  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const wk = addDayKey(monday, -7 * i);
    out.push([wk, ...(buckets[wk] ?? [0.0, 0.0, 0.0])]);
  }
  return out;
}

// Projection for one race from a summarise() snapshot. null with no data.
// raceDate / today are day keys.
export function projectRace(summary, distanceM, raceDate = null, today = null) {
  const fit = summary.fit;
  const base = basePrediction(fit, distanceM);
  if (base === null) return null;
  const daysToRace = (raceDate && today) ? daysBetween(today, raceDate) : 0;
  const factor = fitnessFactor(summary.ctl, summary.ctl_6w_ago, daysToRace);
  const [, exponent, pts] = fit;
  return {
    seconds: base * factor,
    base_seconds: base,
    trend_factor: factor,
    exponent,
    confidence: confidence(fit, distanceM),
    based_on: pts.map(([d, t, age]) => ({ distance_m: d, seconds: t, age_days: age })),
    days_to_race: daysToRace,
  };
}

// --------------------------------------------------------------------------- //
// best efforts inside an activity
// --------------------------------------------------------------------------- //
// The fastest continuous stretch of each length within a run. This is what makes
// a 5K inside a long run count, and it is the input Strava's predictor uses.
export const BEST_EFFORT_DISTANCES = [400, 800, 1000, 1609, 3000, 5000, 10000,
  15000, 16093, 21097, 42195];

// Sorted, distance-monotonic [time_s, distance_m] pairs. GPS can go backwards.
function _monotonic(samples) {
  const pts = samples
    .filter(([t, d]) => t != null && d != null)
    .map(([t, d]) => [Number(t), Number(d)])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const clean = [];
  let last = -1.0;
  for (const [t, d0] of pts) {
    const d = Math.max(d0, last);
    clean.push([t, d]);
    last = d;
  }
  return clean;
}

// Fastest time for each distance within one activity. -> {distance_m: seconds}
// (a plain object, so its keys come back as strings).
//
// `samples` is [[elapsed_seconds, cumulative_metres]]. Uses a sliding window and
// interpolates the window start, so a 400m best is not skewed by sample spacing.
export function bestEffortCurve(samples, distances = BEST_EFFORT_DISTANCES) {
  const pts = _monotonic(samples);
  if (pts.length < 2) return {};
  const total = pts[pts.length - 1][1] - pts[0][1];

  const out = {};
  for (const target of distances) {
    if (target <= 0 || target > total) continue;
    let best = null, i = 0;
    for (let j = 0; j < pts.length; j++) {
      // advance to the tightest window ending at j that still spans `target`
      while (i + 1 < pts.length && pts[j][1] - pts[i + 1][1] >= target) i++;
      if (pts[j][1] - pts[i][1] < target) continue;
      let startT = pts[i][0];
      if (i + 1 < pts.length) {
        const need = pts[j][1] - target;
        const d0 = pts[i][1], d1 = pts[i + 1][1];
        if (d1 > d0 && d0 <= need && need <= d1) {
          startT += (pts[i + 1][0] - pts[i][0]) * (need - d0) / (d1 - d0);
        }
      }
      const span = pts[j][0] - startT;
      if (span > 0 && (best === null || span < best)) best = span;
    }
    // A 400m "best" of 40 seconds is a GPS artefact, not a runner.
    if (best) {
      const pace = best / (target / 1000.0);
      if (120 <= pace && pace <= 900) out[target] = best;
    }
  }
  return out;
}

// Best time per distance across all stored efforts.
//
// `effortRows` is [[distance_m, seconds, date]] -> [[distance_m, seconds, date]]
// sorted by distance, one row per distance.
export function personalRecords(effortRows) {
  const best = new Map();
  for (const [dist, secs, when] of effortRows) {
    if (secs && (!best.has(dist) || secs < best.get(dist)[0])) best.set(dist, [secs, when]);
  }
  return [...best.keys()].sort((a, b) => a - b).map(d => [d, best.get(d)[0], best.get(d)[1]]);
}

// --------------------------------------------------------------------------- //
// prescriptions: what to actually run
// --------------------------------------------------------------------------- //
// Pace (s/km) you could hold for one hour, solved from your own fitted curve.
//
// Threshold is defined by duration, not distance, so it is read off the curve
// rather than assumed to be some fixed race distance.
export function thresholdPace(fit) {
  if (!fit) return null;
  const [a, b] = fit;
  // Python catches overflow / zero division; in JS those surface as Infinity or
  // NaN, which the range check below rejects.
  const distance = Math.exp((Math.log(3600.0) - a) / b);
  if (!(2000.0 <= distance && distance <= 40000.0)) return null;
  return 3600.0 / (distance / 1000.0);
}

// Fractions of threshold speed. Slower fraction first -> slower pace bound.
export const TRAINING_PACE_BANDS = [
  ['Easy', 'Most of your week. Conversational.', 0.70, 0.78],
  ['Marathon', 'Race-pace work for the long stuff.', 0.90, 0.95],
  ['Threshold', 'Tempo and cruise intervals. ~1 hour race effort.', 0.98, 1.02],
  ['Interval', 'VO2max work. 3-5 minute reps.', 1.04, 1.09],
  ['Repetition', 'Speed and economy. 200-600m reps.', 1.10, 1.16],
];

// [[name, purpose, fast_s_per_km, slow_s_per_km]] from current fitness.
export function trainingPaces(fit) {
  const thr = thresholdPace(fit);
  if (!thr) return [];
  // Faster fraction of threshold speed -> lower (faster) pace.
  return TRAINING_PACE_BANDS.map(([name, purpose, lo, hi]) => [name, purpose, thr / hi, thr / lo]);
}

// Friel-style zones anchored on lactate-threshold HR.
export const HR_ZONE_BANDS = [
  ['Z1 Recovery', 0.00, 0.81],
  ['Z2 Aerobic', 0.81, 0.90],
  ['Z3 Tempo', 0.90, 0.94],
  ['Z4 Threshold', 0.94, 1.00],
  ['Z5 VO2max', 1.00, 1.15],
];

// [[name, low_bpm, high_bpm]] from the estimated threshold HR.
export function hrZones(thrHr) {
  if (!thrHr) return [];
  return HR_ZONE_BANDS.map(([name, lo, hi]) => [name, pyRound(thrHr * lo), pyRound(thrHr * hi)]);
}

// How far past your recent longest run a session has to go before it is worth
// mentioning, and where the evidence puts the elevated-risk band.
export const SPIKE_REFERENCE_DAYS = 30;
export const SPIKE_NOTE = 0.10;
export const SPIKE_HIGH = 0.30;

// The fastest a human plausibly sustains each activity, in m/s, over a whole
// session. Well clear of world-record average pace -- this catches a mislabelled
// activity, not a fast one.
export const PLAUSIBLE_SPEED = {
  running: 7.0, trail_running: 6.5, treadmill_running: 7.0,
  walking: 3.0, hiking: 3.0,
  cycling: 20.0, virtual_ride: 20.0,
};
export const PLAUSIBLE_DEFAULT = 25.0;

// Is this activity moving faster than its own sport allows? -> string|null.
//
// Borrowed from Tranggle, the Korean tracker, which refuses to award anything
// to a "hike" recorded at 30 km/h. Strava will happily take a mislabelled bike
// ride as a run and put it in your personal bests, where it stays forever.
export function implausible(activity) {
  const kind = activity.type;
  const distance = activity.distance_m;
  const seconds = activity.moving_s || activity.elapsed_s;
  if (!kind || !distance || !seconds || seconds <= 0) return null;

  const speed = distance / seconds;
  const limit = Object.hasOwn(PLAUSIBLE_SPEED, kind) ? PLAUSIBLE_SPEED[kind] : PLAUSIBLE_DEFAULT;
  if (speed <= limit) return null;
  const shown = RUN_TYPES.has(kind)
    ? fmtPace(seconds / (distance / 1000.0), 1000)
    : (speed * 3.6).toFixed(1) + ' km/h';
  return `recorded as ${kind.replaceAll('_', ' ')} but averaging ${shown} -- faster than that sport goes, so ` +
    'it is probably mislabelled';
}

// Was the most recent run longer than recent training supports?
//
// -> [ratio, distance_m, longest_recent_m, verdict] or null.
//
// `runs` is [[day, distance_m]] in any order. `ratio` is the session distance
// over the longest run of the preceding `referenceDays`, so 1.0 means "as long
// as anything you have done lately" and 1.4 means half again as far.
//
// This replaces the acute:chronic workload ratio, which this app used to show
// and which does not survive scrutiny. Impellizzeri et al. (Sports Medicine
// 2021, "Time to Dismiss ACWR and Its Underlying Theory") recomputed published
// ACWR results with the chronic load replaced by *random numbers* and
// reproduced the effect; the ratio predicted injury barely better than chance
// (c-statistic 0.574, against 0.544 for acute load alone) and only in-sample.
// The numerator and denominator also share data, so part of the correlation is
// definitional (Lolli et al., BJSM 2019).
//
// What replaced it is narrower and better evidenced. Frandsen et al., BJSM 2025
// followed 5,205 Garmin-tracked runners over 588,071 sessions and 1,820
// injuries, and compared three ways of expressing a spike. The single-session
// one won: distance relative to the longest run of the past 30 days. Against a
// rise of 10% or less, a rise of 10-30% carried a hazard rate ratio of 1.64
// (95% CI 1.31-2.05) and a rise of 30-100% one of 1.52 (1.16-2.00).
//
// Note the second number is *lower* than the first, so this is not a clean
// dose-response and the wording below does not pretend otherwise.
export function sessionSpike(runs, referenceDays = SPIKE_REFERENCE_DAYS) {
  const dated = runs
    .filter(([d, m]) => d && m && m > 0)
    .map(([d, m]) => [dayKey(d), m])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (!dated.length) return null;
  const [day, distance] = dated[dated.length - 1];
  const window = [];
  for (const [d, m] of dated.slice(0, -1)) {
    const age = daysBetween(d, day);
    if (0 <= age && age <= referenceDays) window.push(m);
  }
  if (!window.length) return null;

  const longest = Math.max(...window);
  const ratio = distance / longest;
  let verdict;
  if (ratio > 1.0 + SPIKE_HIGH) {
    verdict = 'further than anything in the last month by a good margin -- ' +
      'the sessions that precede injuries look like this one';
  } else if (ratio > 1.0 + SPIKE_NOTE) verdict = 'a step up on your longest run of the last month';
  else if (ratio > 1.0) verdict = 'your longest run in a month, but only just';
  else verdict = 'within what you have been running';
  return [ratio, distance, longest, verdict];
}

// Simulate CTL/ATL to race day, with and without a taper.
//
// Assumes you keep your recent average daily load. -> object, or null if the
// race is not ahead of today. today / raceDate are day keys.
export function projectForm(daily, today, raceDate, taperDays = 14, taperFactor = 0.55) {
  const daysOut = daysBetween(today, raceDate);
  if (daysOut == null || daysOut <= 0) return null;

  let total = 0;
  for (let i = 0; i < 28; i++) total += daily[addDayKey(today, -i)] ?? 0.0;
  const recent = total / 28.0;
  const kc = 1.0 - Math.exp(-1.0 / CTL_DAYS);
  const ka = 1.0 - Math.exp(-1.0 / ATL_DAYS);

  const simulate = taper => {
    let ctl = 0.0, atl = 0.0;
    let day = addDayKey(today, -365);
    while (day <= today) {
      const load = daily[day] ?? 0.0;
      ctl += (load - ctl) * kc;
      atl += (load - atl) * ka;
      day = addDayKey(day, 1);
    }
    for (let i = 1; i <= daysOut; i++) {
      let load = recent;
      if (taper && (daysOut - i) < taperDays) load *= taperFactor;
      ctl += (load - ctl) * kc;
      atl += (load - atl) * ka;
    }
    return [ctl, atl];
  };

  const [flatCtl, flatAtl] = simulate(false);
  const [tapCtl, tapAtl] = simulate(true);
  return {
    days_out: daysOut,
    avg_daily_load: recent,
    tsb_no_taper: flatCtl - flatAtl,
    tsb_with_taper: tapCtl - tapAtl,
    ctl_race_day: tapCtl,
    taper_days: taperDays,
  };
}

// --------------------------------------------------------------------------- //
// calibration: learn from races you actually ran
// --------------------------------------------------------------------------- //
export const CALIBRATION_HALF_LIFE_DAYS = 365.0;
export const CALIBRATION_MAX_ADJUST = 0.06;      // never move a projection more than 6% either way

// How far off the model has been for this athlete. -> object or null.
//
// `results` is [[predicted_s, actual_s, race_day]] for past races where both
// are known. The bias is a recency-weighted geometric mean of actual/predicted;
// it multiplies future projections. Two results minimum -- one race is an
// anecdote, not a pattern.
export function calibration(results, today) {
  const pairs = results.filter(([p, a]) => p && a && p > 0 && a > 0);
  if (pairs.length < 2) return null;
  let sw = 0.0, swl = 0.0;
  for (const [p, a, d] of pairs) {
    const age = Math.max(daysBetween(d, today), 0);
    const w = 0.5 ** (age / CALIBRATION_HALF_LIFE_DAYS);
    sw += w;
    swl += w * Math.log(a / p);
  }
  if (sw <= 0) return null;
  const raw = Math.exp(swl / sw);
  const factor = Math.max(1.0 - CALIBRATION_MAX_ADJUST, Math.min(1.0 + CALIBRATION_MAX_ADJUST, raw));
  const errors = pairs.map(([p, a]) => Math.abs(a / p - 1.0));
  return {
    factor,
    raw_factor: raw,
    n: pairs.length,
    mean_abs_error: errors.reduce((s, x) => s + x, 0) / errors.length,
    direction: raw > 1.005 ? 'slower than projected'
      : raw < 0.995 ? 'faster than projected' : 'on the money',
  };
}

// Return a copy of a projectRace() object with the athlete's bias applied.
export function applyCalibration(projection, cal) {
  if (!projection || !cal) return projection;
  return { ...projection, seconds: projection.seconds * cal.factor, calibration_factor: cal.factor };
}

// --------------------------------------------------------------------------- //
// per-activity analysis
// --------------------------------------------------------------------------- //
// Split times from a [time, distance] stream. -> [[km_index, seconds, pace_s_per_km]].
//
// Interpolates each split boundary so the result does not depend on where the
// watch happened to record a sample.
export function kmSplits(samples, splitM = 1000.0) {
  const pts = _monotonic(samples);
  if (pts.length < 2) return [];
  const out = [];
  let k = 1, prevT = pts[0][0], i = 0;
  const total = pts[pts.length - 1][1];
  while (k * splitM <= total + 1e-6) {
    const target = k * splitM;
    while (i + 1 < pts.length && pts[i + 1][1] < target) i++;
    if (i + 1 >= pts.length) break;
    const [t0, d0] = pts[i], [t1, d1] = pts[i + 1];
    const tAt = d1 > d0 ? t0 + (t1 - t0) * (target - d0) / (d1 - d0) : t1;
    const secs = tAt - prevT;
    if (secs > 0) out.push([k, secs, secs / (splitM / 1000.0)]);
    prevT = tAt;
    k++;
  }
  // partial last split
  if (total - (k - 1) * splitM > 100 && pts[pts.length - 1][0] > prevT) {
    const rem = total - (k - 1) * splitM;
    const secs = pts[pts.length - 1][0] - prevT;
    out.push([k, secs, secs / (rem / 1000.0)]);
  }
  return out;
}

// 0 = perfectly even. Coefficient of variation of the full-km split paces.
export function splitEvenness(splits) {
  const paces = (splits.length > 1 ? splits.slice(0, -1) : splits).map(s => s[2]);
  if (paces.length < 2) return null;
  const mean = paces.reduce((s, p) => s + p, 0) / paces.length;
  if (mean <= 0) return null;
  const variance = paces.reduce((s, p) => s + (p - mean) ** 2, 0) / paces.length;
  return Math.sqrt(variance) / mean;
}

// Cardiac drift: % rise in HR-to-speed between the halves of a steady run.
//
// `samplesHr` is [[time_s, distance_m, hr]]. Above ~5% on an easy run means it
// was hotter, longer, or harder than it should have been. -> percentage or null.
export function hrDrift(samplesHr) {
  const pts = samplesHr.filter(([t, d, h]) => h && t != null && d != null)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  if (pts.length < 20) return null;
  const mid = Math.floor(pts.length / 2);
  const first = pts.slice(0, mid), second = pts.slice(mid);

  const ratio = chunk => {
    const dt = chunk[chunk.length - 1][0] - chunk[0][0];
    const dd = chunk[chunk.length - 1][1] - chunk[0][1];
    if (dt <= 0 || dd <= 0) return null;
    const avgHr = chunk.reduce((s, c) => s + c[2], 0) / chunk.length;
    return avgHr / (dd / dt);
  };

  const r1 = ratio(first), r2 = ratio(second);
  if (!r1 || !r2) return null;
  return (r2 / r1 - 1.0) * 100.0;
}

// Label a run by what it was: easy, long, tempo, intervals, race, or unknown.
export function classifyRun(activity, thrHr, thrPace) {
  const dist = activity.distance_m || 0;
  const secs = activity.moving_s || activity.elapsed_s || 0;
  const hr = activity.avg_hr;
  if (!dist || !secs) return 'unknown';
  const pace = secs / (dist / 1000.0);
  const intensity = (hr && thrHr) ? hr / thrHr : (thrPace ? thrPace / pace : null);
  if (intensity === null) return 'unknown';
  if (intensity >= 0.98 && dist >= 3000) return 'race';
  if (intensity >= 0.92) return secs >= 1200 ? 'tempo' : 'intervals';
  if (secs >= 5400 || dist >= 18000) return 'long';
  if (intensity < 0.85) return 'easy';
  return 'steady';
}

// --------------------------------------------------------------------------- //
// weekly digest
// --------------------------------------------------------------------------- //
// Numbers for the weekly summary: this week vs last, and the standouts.
export function weekDigest(activities, now, thrHr, thrSpd) {
  const monday = weekStart(now);
  const prevMonday = addDayKey(monday, -7);

  const bucket = (start, end) => {
    let km = 0.0, hrs = 0.0, load = 0.0;
    const runs = [];
    for (const a of activities) {
      if (!(CARDIO_TYPES.has(a.type) || typeof a.load === 'number') || !a.start) continue;
      const d = dayKey(a.start);
      if (!(start <= d && d < end)) continue;
      km += (a.distance_m || 0) / 1000.0;
      hrs += (a.moving_s || a.elapsed_s || 0) / 3600.0;
      load += activityLoad(a, thrHr, thrSpd);
      if (RUN_TYPES.has(a.type)) runs.push(a);
    }
    return { km, hours: hrs, load, runs };
  };

  const thisWk = bucket(monday, addDayKey(monday, 7));
  const last = bucket(prevMonday, monday);
  const longest = _maxBy(thisWk.runs, a => a.distance_m || 0) ?? null;

  const paceOf = a => {
    const d = a.distance_m || 0, s = a.moving_s || a.elapsed_s || 0;
    return d >= 1500 && s ? s / (d / 1000.0) : null;
  };

  const paced = thisWk.runs.filter(a => paceOf(a)).map(a => [paceOf(a), a]);
  const fastest = (_minBy(paced, x => x[0]) ?? [null, null])[1];
  return {
    week_start: monday,
    this: thisWk, last,
    km_delta: thisWk.km - last.km,
    load_delta: thisWk.load - last.load,
    longest, fastest,
  };
}

// Python's "%g": up to 6 significant digits, trailing zeros dropped.
const _fmtG = x => String(Number(x.toPrecision(6)));

// Checkpoint splits for a race. -> [[label, metres, cumulative_seconds]].
//
// Slightly negative: the first half is run `negativeSplit` slower than average
// and the second half that much faster, which is how the distance is best run.
export function splitTargets(distanceM, seconds, negativeSplit = 0.01) {
  if (!distanceM || !seconds) return [];
  const step = distanceM <= 12000 ? 1000.0 : 5000.0;
  const marks = [];
  let d = step;
  while (d < distanceM - 1) { marks.push(d); d += step; }
  marks.push(distanceM);

  const half = distanceM / 2.0;
  const avg = seconds / distanceM;           // s per metre
  const slow = avg * (1 + negativeSplit), fast = avg * (1 - negativeSplit);

  return marks.map(m => {
    const first = Math.min(m, half);
    const second = Math.max(0.0, m - half);
    const cumulative = first * slow + second * fast;
    const label = Math.abs(m - distanceM) < 1 ? 'Finish' : _fmtG(pyRound(m / 1000.0, 2)) + 'K';
    return [label, m, cumulative];
  });
}
