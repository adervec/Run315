// How hard was that week, really?
//
// Volume answers almost nothing. Two runners with identical weekly hours can sit
// on opposite sides of the most repeatable finding in endurance training: the ones
// who keep the easy days genuinely easy, so the hard days can be genuinely hard,
// improve -- and the ones who spend every session at a comfortably uncomfortable
// middle pace mostly do not.
//
// Telling those two apart needs time in each heart-rate zone, and *time* is the
// word that matters. A watch samples unevenly: every second while you run, once a
// minute while it thinks you have stopped, and not at all across a dropout. Count
// samples per zone and the sparse stretches quietly vanish from the week. So
// everything here integrates the seconds between samples instead.
//
// On top of the five Friel zones sit the three buckets coaches actually argue
// about -- easy, the grey zone, and hard -- the published polarisation index that
// puts one number on the shape, and aerobic decoupling for whether a single run
// held together.
//
// Pure functions over stream samples. No I/O, no dependencies. See test/zones.test.mjs.
//
// A sample is [seconds, metres, hr, lat, lon, elevation_m]; everything after the
// first two may be missing or null.
import { dayKey, weekStart, addDayKey } from './dt.js';

// Python 3.12+ sum() of floats is Neumaier-compensated, not a naive running total.
// Ported tests can hinge on the last bit (exact ties between |r| values), so match it.
function pySum(xs) {
  let s = 0.0, c = 0.0;
  for (const x of xs) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s;
    s = t;
  }
  return c && Number.isFinite(c) ? s + c : s;
}


// Friel's zones as fractions of lactate-threshold HR -- the same numbers
// fitness.HR_ZONE_BANDS shows on the dashboard, except that the top band is left
// open: time-in-zone has to put 108% of threshold somewhere.
export const ZONE_BANDS = [
  ['Z1', 'Recovery', 0.00, 0.81],
  ['Z2', 'Aerobic', 0.81, 0.90],
  ['Z3', 'Tempo', 0.90, 0.94],
  ['Z4', 'Threshold', 0.94, 1.00],
  ['Z5', 'VO2max', 1.00, Infinity],
];
export const ZONES = ZONE_BANDS.map(band => band[0]);

// The three buckets the polarisation argument is about. Z3 is the grey zone:
// above the aerobic ceiling, below the threshold that would make it worth it.
export const EASY_ZONES = ['Z1', 'Z2'];
export const MODERATE_ZONES = ['Z3'];
export const HARD_ZONES = ['Z4', 'Z5'];

// Longer than this between two rows and the watch was paused, in a tunnel, or
// sitting in a cafe -- not running for two minutes at the heart rate it last saw.
export const MAX_GAP_S = 120.0;

// Where one distribution stops being another. Round numbers on purpose: these
// are the coaching rules of thumb, not measurements.
export const TOO_HARD_SHARE = 0.30;          // more than this at threshold-and-above is not sustainable
export const THRESHOLD_HEAVY_SHARE = 0.20;   // more than this in the grey zone is the classic mistake
export const POLARISED_EASY_MIN = 0.65;
export const POLARISED_MODERATE_MAX = 0.10;
export const POLARISED_HARD_MIN = 0.10;

export const MIN_DECOUPLING_SAMPLES = 8;

// Python's float(): numbers and bools pass, numeric strings parse, anything else
// is NaN (which every caller here treats as missing).
function toFloat(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return +v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (/^[+-]?(inf|infinity)$/.test(s)) return s[0] === '-' ? -Infinity : Infinity;
    return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(s) ? Number(s) : NaN;
  }
  return NaN;
}

// Sorted [t, d, hr] triples with monotonic distance. Junk rows dropped.
// Streams arrive from a device, so they contain everything: short rows, nulls,
// NaNs, out-of-order timestamps and GPS that briefly runs backwards.
function _clean(samples) {
  const out = [];
  for (const s of samples || []) {
    if (!s || s.length < 2 || s[0] == null || s[1] == null) continue;
    const t = toFloat(s[0]), d = toFloat(s[1]);
    if (Number.isNaN(t) || Number.isNaN(d)) continue;
    let hr = null;
    if (s.length > 2 && s[2] != null) {
      hr = toFloat(s[2]);
      if (Number.isNaN(hr) || hr <= 0) hr = null;
    }
    out.push([t, d, hr]);
  }
  out.sort((a, b) => a[0] - b[0]);

  const clean = [];
  let last = null;
  for (const [t, d0, hr] of out) {
    const d = last === null ? d0 : Math.max(d0, last);
    clean.push([t, d, hr]);
    last = d;
  }
  return clean;
}

// Which zone a single heart rate falls in, as a key. null if unplaceable.
// Zones are read against threshold HR rather than max HR because threshold is
// the number the app can estimate from the athlete's own history without
// asking them to go and run themselves into the ground.
export function zoneOf(hr, thrHr, bands = ZONE_BANDS) {
  if (!hr || !thrHr || hr <= 0 || thrHr <= 0) return null;
  const fraction = hr / thrHr;
  for (const [key, , lo, hi] of bands) {
    if (lo <= fraction && fraction < hi) return key;
  }
  // Only reachable if a caller passes bands with a closed top: anything above
  // the last ceiling still belongs to the last zone.
  return fraction >= bands[bands.length - 1][2] ? bands[bands.length - 1][0] : null;
}

// Seconds spent in each zone during one activity. -> {zone: seconds}.
//
// Every zone is present, so callers never have to guess whether a missing key
// means zero. Time is integrated between consecutive samples: a sample holds
// its heart rate until the next one arrives, which is how the device meant it
// to be read, and it is the only way a stretch recorded once a minute counts
// for the minute it actually lasted.
//
// A row without heart rate contributes nothing rather than being filled in --
// the total then honestly falls short of the elapsed time, which is a better
// signal than a confident guess.
export function timeInZones(samples, thrHr, bands = ZONE_BANDS) {
  const out = {};
  for (const [key] of bands) out[key] = 0.0;
  const pts = _clean(samples);
  if (!thrHr || thrHr <= 0 || pts.length < 2) return out;

  for (let i = 0; i + 1 < pts.length; i++) {
    const [t0, , hr0] = pts[i], t1 = pts[i + 1][0];
    const gap = t1 - t0;
    if (gap <= 0) continue;
    const zone = zoneOf(hr0, thrHr, bands);
    if (zone === null) continue;
    // ponytail: the interval goes whole to the zone it started in, so a
    // crossing between zones is credited to the wrong side of the boundary
    // for a few seconds. Upgrade path: interpolate the crossing point if
    // per-zone seconds ever need to be exact rather than indicative.
    out[zone] += Math.min(gap, MAX_GAP_S);
  }
  return out;
}

const emptyZones = () => Object.fromEntries(ZONES.map(z => [z, 0.0]));

// Time in zone rolled up per ISO week. -> [[monday_day_key, {zone: seconds}]].
//
// Oldest first, most recent last, with empty weeks present as zeros -- a week
// with no training is a fact about the block, not a hole to be skipped when
// the shape of a training phase is what you are looking at.
//
// An activity is an object with `start` (Date) and `samples` (or `stream`).
// `now` defaults to the newest activity, so a stored block reads the same way
// a year later as it did on the day.
export function weeklyZones(activities, thrHr, weeks = 12, now = null) {
  const rows = [];
  for (const a of activities || []) {
    const start = a.start;
    const samples = (a.samples && a.samples.length) ? a.samples : a.stream;
    if (!start || !samples || !samples.length) continue;
    rows.push([dayKey(start), timeInZones(samples, thrHr)]);
  }
  if (!rows.length) return [];

  let end = now == null ? null : dayKey(now);
  if (end === null) end = rows.reduce((m, [day]) => (day > m ? day : m), rows[0][0]);
  // Monday of the ISO week is what everyone means by "the week".
  const monday = weekStart(end);

  // Weeks outside the window need no filtering: they simply never get read.
  const buckets = {};
  for (const [day, zoneSeconds] of rows) {
    const week = weekStart(day);
    const acc = buckets[week] || (buckets[week] = emptyZones());
    for (const [zone, secs] of Object.entries(zoneSeconds)) acc[zone] = (acc[zone] || 0.0) + secs;
  }

  const out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const week = addDayKey(monday, -7 * i);
    out.push([week, buckets[week] || emptyZones()]);
  }
  return out;
}

// [easy_s, moderate_s, hard_s] from a timeInZones() object.
export function threeBuckets(zoneSeconds) {
  const total = keys => pySum(keys.map((k) => (zoneSeconds[k] || 0.0)));
  return [total(EASY_ZONES), total(MODERATE_ZONES), total(HARD_ZONES)];
}

// What shape is this training, and is that the shape you wanted? -> object.
//
// Five zones is too fine a grain to argue about. Collapsed to three -- easy
// below the aerobic ceiling, the grey zone in the middle, hard from threshold
// up -- the week takes one of four recognisable shapes, and the label is worth
// more to a runner than the percentages are.
//
// Shares are fractions of the time that could be placed in a zone at all, so
// they always sum to 1 even when the heart-rate trace has holes in it.
export function polarisation(zoneSeconds) {
  const [easyS, moderateS, hardS] = threeBuckets(zoneSeconds);
  const total = easyS + moderateS + hardS;
  if (total <= 0) {
    return { easy_s: 0.0, moderate_s: 0.0, hard_s: 0.0, total_s: 0.0,
      easy: 0.0, moderate: 0.0, hard: 0.0,
      label: null, verdict: verdict(null, 0.0, 0.0, 0.0) };
  }

  const easy = easyS / total, moderate = moderateS / total, hard = hardS / total;
  let label;
  if (hard > TOO_HARD_SHARE) label = 'too-hard';
  else if (moderate > THRESHOLD_HEAVY_SHARE) label = 'threshold-heavy';
  else if (hard >= POLARISED_HARD_MIN && moderate <= POLARISED_MODERATE_MAX
      && easy >= POLARISED_EASY_MIN) label = 'polarised';
  else {
    // Everything else slopes down from a broad easy base without the clean
    // gap in the middle that makes a week polarised.
    label = 'pyramidal';
  }

  return { easy_s: easyS, moderate_s: moderateS, hard_s: hardS, total_s: total,
    easy, moderate, hard, label, verdict: verdict(label, easy, moderate, hard) };
}

// Say what the shape means, in the terms a coach would put it in.
export function verdict(label, easy, moderate, hard) {
  const e = (easy * 100.0).toFixed(0), m = (moderate * 100.0).toFixed(0), h = (hard * 100.0).toFixed(0);
  if (label === 'polarised') {
    return `Polarised: ${e}% easy, ${h}% hard, and almost nothing in between. `
      + 'This is the shape the evidence keeps landing on -- the easy days are '
      + 'easy enough to recover from, which is what lets the hard days be hard.';
  }
  if (label === 'threshold-heavy') {
    return `Threshold-heavy: ${m}% of your time sits in the grey zone between `
      + 'easy and hard. That is the classic mistake -- too hard to recover '
      + 'from, too easy to force an adaptation. Slow the easy days down and '
      + 'let the hard days go properly hard.';
  }
  if (label === 'too-hard') {
    return `Too hard: ${h}% of your time at threshold or above, with only `
      + `${e}% easy. There is nothing left to recover with. This is the `
      + 'shape that plateaus first and breaks second.';
  }
  if (label === 'pyramidal') {
    if (hard * 100.0 <= 0.0 && moderate * 100.0 <= 0.0) {
      return 'All of it easy. A fine base, and a fine block to spend a few '
        + 'weeks in, but there is no stimulus here to make you faster at '
        + 'the sharp end.';
    }
    return `Pyramidal: ${e}% easy, tapering through ${m}% moderate to ${h}% `
      + 'hard. A broad base with a point on it -- blunter than polarised, and '
      + 'it works, particularly early in a build.';
  }
  return 'No heart-rate time to judge this on yet.';
}

// Treff's polarisation index: one number for the shape. -> number or null.
//
// PI = log10(Z1 / Z2 * Z3 * 100) with the three bucket shares as percentages;
// above 2.0 is the published cut for polarised training. It rewards a big easy
// base and a hollowed-out middle, and it is deliberately crude -- it is a way
// to plot the shape of a block over time, not a replacement for looking at the
// three shares themselves.
//
// null when any bucket is empty. A week with no hard running has no polarity
// to index, and the formula would divide by zero or take the log of it.
export function polarisationIndex(zoneSeconds) {
  const [easyS, moderateS, hardS] = threeBuckets(zoneSeconds);
  const total = easyS + moderateS + hardS;
  if (total <= 0) return null;
  const [z1, z2, z3] = [easyS, moderateS, hardS].map(part => 100.0 * part / total);
  if (z1 <= 0 || z2 <= 0 || z3 <= 0) return null;
  return Math.log10(z1 / z2 * z3 * 100.0);
}

// Heart rate per unit of speed across a slice of [t, d, hr]. null if flat.
// The heart-rate average is time-weighted for the same reason timeInZones
// integrates: on a stream that thins out when you slow down, a plain mean of
// the rows over-weights the fast, densely sampled parts.
function _hrPerSpeed(chunk) {
  if (chunk.length < 2) return null;
  const spanS = chunk[chunk.length - 1][0] - chunk[0][0];
  const spanM = chunk[chunk.length - 1][1] - chunk[0][1];
  if (spanS <= 0 || spanM <= 0) return null;
  const weighted = pySum(chunk.slice(0, -1).map((p, i) => p[2] * (chunk[i + 1][0] - p[0])));
  const avgHr = weighted / spanS;
  return avgHr / (spanM / spanS);
}

// Aerobic decoupling across one run: % change in HR-per-speed. -> % or null.
//
// The number that says whether an endurance run held together. Positive means
// the second half cost more heartbeats per metre than the first, which is the
// direction heat, dehydration and plain fatigue all push it; under about 5% on
// a steady aerobic run means the aerobic system carried the whole distance.
//
// The run is split at its halfway point in *time*, not at its middle sample.
// With uneven sampling those are different places, and the middle sample tends
// to sit wherever the watch happened to be chatty.
export function decoupling(samples) {
  const pts = _clean(samples).filter(p => p[2]);
  if (pts.length < MIN_DECOUPLING_SAMPLES) return null;
  const midT = (pts[0][0] + pts[pts.length - 1][0]) / 2.0;
  const first = pts.filter(p => p[0] <= midT);
  const second = pts.filter(p => p[0] >= midT);

  const before = _hrPerSpeed(first), after = _hrPerSpeed(second);
  if (!before || !after) return null;
  return (after / before - 1.0) * 100.0;
}
