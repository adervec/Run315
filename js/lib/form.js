// Running form: how the pace was produced, not just what it was.
//
// Pace is an outcome. Cadence, stride length, ground contact time and vertical
// oscillation are the mechanics that produced it, and unlike pace they are things
// a runner can deliberately change on the next run:
//
//   cadence      steps per minute over both feet. Turnover. Too slow and the foot
//                lands out in front of the hips, braking on every step.
//   stride       metres covered per step. Cadence times stride is speed, so
//                neither number means anything read on its own.
//   contact      milliseconds the foot spends on the ground. Time on the ground
//                is time not spent travelling.
//   oscillation  centimetres of bounce per step. Vertical work is wasted work --
//                but only relative to how far the step went, which is why the
//                ratio below is the number coaches quote, not the raw height.
//
// None of these channels is guaranteed. Treadmill runs have no GPS, plenty of runs
// have no heart rate, and running dynamics need a chest strap or a compatible
// watch. So every function here degrades field by field: a missing channel gives a
// missing answer, never an exception, and a ragged row loses only what it is
// actually short of.
//
// The reference points in assess() are population guidance from coaching and from
// the ranges the watch manufacturers publish. They are not laws. Cadence rises
// with pace and falls with height; a tall runner cruising easily at 165 is not
// doing anything wrong. Treat them as a reason to look, not as a verdict.
//
// Pure functions over stream samples. No I/O, no dependencies. See test/form.test.mjs.
//
// A sample is [seconds, metres, hr, lat, lon, elevation_m, cadence_spm, stride_m,
// gct_ms, vert_osc_cm]. Everything after the first two may be null or absent.
import { pyRound, divmod } from './py.js';

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


export const RUN_SPEED = 2.4;            // m/s -- below this you are not running (~6:56/km)
export const SMOOTH_S = 7.0;             // speed smoothing window; shorter and GPS noise wins

// Plausibility windows. Garmin writes 0 into these fields whenever the pod has
// nothing to say -- standing at a light, or no strap paired at all -- and a zero
// dragged into an average is far worse than no average. The windows are wide on
// purpose: they exist to drop impossible values, not to judge anybody.
export const CADENCE_RANGE = [30.0, 260.0];
export const STRIDE_RANGE = [0.3, 3.0];
export const GCT_RANGE = [100.0, 600.0];
export const VOSC_RANGE = [2.0, 25.0];

// Garmin's directDoubleCadence counts both feet, but some fields -- and some
// third-party exports -- carry single-leg cadence instead, which reads around
// 80-90 while running. Nobody runs at 85 steps a minute; that is a stroll. So a
// running median below this is one foot being counted, not a slow runner.
export const HALVED_MAX_SPM = 110.0;

// What "normal" looks like across a lot of runners. Fuzzy, and deliberately so.
export const CADENCE_TYPICAL = [170.0, 180.0];
export const CADENCE_LOW = 160.0;        // below this at running pace is worth a look
export const CADENCE_HIGH = 190.0;       // above this is unusual, not wrong
export const GCT_GOOD_MS = 250.0;
export const GCT_LONG_MS = 300.0;
export const VERTICAL_RATIO_GOOD = 10.0;
export const VERTICAL_RATIO_HIGH = 12.0;

// Pace bucket edges in seconds per km, fastest first once binned.
export const PACE_BUCKETS = [240.0, 270.0, 300.0, 330.0, 360.0, 420.0];
export const MIN_BUCKET_SAMPLES = 10;    // fewer than this is a transition, not a gear

export const MIN_DRIFT_SAMPLES = 20;     // halves of ten samples each say nothing
export const DRIFT_PCT = 1.0;            // noise floor for a half-to-half change, not a finding
export const CADENCE_SWING_SPM = 12.0;   // rule of thumb for "changes a lot with pace"
export const THIN_RUN_S = 300.0;         // under five minutes of running, averages are thin

// --------------------------------------------------------------------------- //
// reading the stream
// --------------------------------------------------------------------------- //
// Python's float(): numbers and bools pass, numeric strings parse, anything else NaN.
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

// Number, or null for missing, non-numeric, NaN or implausible values.
function _num(value, window = null) {
  if (value == null) return null;
  const v = toFloat(value);
  if (Number.isNaN(v)) return null;
  if (window && !(window[0] <= v && v <= window[1])) return null;
  return v;
}

// Sorted, distance-monotonic [t, d, cadence, stride, gct, vosc].
// Heart rate and position are dropped -- nothing here needs them. Each dynamics
// field is read independently, so a row that stops after elevation simply has
// no dynamics rather than being thrown away.
function _clean(samples) {
  const rows = [];
  for (const s of samples || []) {
    if (!s || s.length < 2) continue;
    const t = _num(s[0]), d = _num(s[1]);
    if (t === null || d === null) continue;
    const field = (i, window) => (s.length > i ? _num(s[i], window) : null);
    rows.push([t, d, field(6, CADENCE_RANGE), field(7, STRIDE_RANGE),
      field(8, GCT_RANGE), field(9, VOSC_RANGE)]);
  }
  rows.sort((a, b) => a[0] - b[0]);

  const clean = [];
  let last = null;
  for (const row of rows) {
    const d = last === null ? row[1] : Math.max(row[1], last);   // GPS goes backwards
    clean.push([row[0], d, ...row.slice(2)]);
    last = d;
  }
  return clean;
}

// [[t, d, speed_m_s, cadence, stride, gct, vosc]] with speed smoothed.
// Speed decides what counts as running, and a raw sample-to-sample speed off a
// metre-quantised distance stream flickers either side of any threshold you
// pick. Smoothing over a few seconds is what makes that decision stable.
function _series(samples, smoothS = SMOOTH_S) {
  const pts = _clean(samples);
  if (pts.length < 2) return [];

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
    out.push([row[0], row[1], pySum(window) / window.length, ...row.slice(2)]);
  }
  return out;
}

// Only the samples where the athlete was actually running.
const _running = (series, minSpeed = RUN_SPEED) => series.filter(r => r[2] >= minSpeed);

// [seconds, metres] actually spent running, charged forward per sample.
function _runningTotals(series, minSpeed = RUN_SPEED) {
  let secs = 0.0, dist = 0.0;
  for (let i = 0; i + 1 < series.length; i++) {
    const row = series[i];
    if (row[2] >= minSpeed) {
      secs += series[i + 1][0] - row[0];
      dist += series[i + 1][1] - row[1];
    }
  }
  return [secs, dist];
}

// --------------------------------------------------------------------------- //
// small arithmetic
// --------------------------------------------------------------------------- //
const present = values => values.filter(v => v != null);

// Mean of the values that exist, or null if none do.
function _mean(values) {
  const vals = present(values);
  return vals.length ? pySum(vals) / vals.length : null;
}

function _median(values) {
  const vals = present(values).sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2.0;
}

// {mean, sd, n, min, max} over the values that exist, or null.
// Population sd, not sample sd: this is the spread of a run that happened, not
// an estimate of some wider population's.
function _stats(values) {
  const vals = present(values);
  if (!vals.length) return null;
  const mean = pySum(vals) / vals.length;
  const variance = pySum(vals.map((v) => (v - mean) ** 2)) / vals.length;
  return { mean, sd: Math.sqrt(variance), n: vals.length,
    // reduce, not Math.min(...vals): a day-long 1 Hz stream overflows the arg limit
    min: vals.reduce((a, b) => (b < a ? b : a)), max: vals.reduce((a, b) => (b > a ? b : a)) };
}

// Percentage change from first to second, or null if it cannot be had.
function _pct(first, second) {
  if (first == null || second == null || !first) return null;
  return (second / first - 1.0) * 100.0;
}

function _mmss(seconds) {
  const [m, s] = divmod(Math.trunc(pyRound(seconds)), 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// --------------------------------------------------------------------------- //
// cadence, counted correctly
// --------------------------------------------------------------------------- //
// Is this stream counting one foot rather than two?
// Single-leg cadence reads as a running median around 80-90, which is not a
// cadence any human sustains at running speed -- it is a brisk walk. So a
// median inside the plausible band but below HALVED_MAX_SPM can only be one
// foot, and doubling recovers the real figure.
export function looksHalved(cadences) {
  const med = _median(cadences);
  return med !== null && CADENCE_RANGE[0] <= med && med < HALVED_MAX_SPM;
}

// Steps per minute over both feet. -> [values, doubled].
// Cadence is taken as given unless the whole stream looks single-leg. The
// judgement is made once, on the median, and applied to everything: deciding
// per sample would turn one noisy low reading into a doubled outlier.
export function normaliseCadence(cadences) {
  const vals = [...cadences];
  if (!looksHalved(vals)) return [vals, false];
  return [vals.map(c => (c == null ? null : c * 2.0)), true];
}

// Bounce as a percentage of stride length. Lower is more economical.
// Raw oscillation flatters a short strider: 8 cm of bounce is cheap if the step
// covers 1.4 m and expensive if it covers 0.9 m, which is why coaches quote the
// ratio rather than the height. Centimetres over metres is already a percentage
// (a cm is a hundredth of a metre), so there is no scaling to do.
export function verticalRatio(vertOscCm, strideM) {
  const v = _num(vertOscCm), s = _num(strideM);
  if (v === null || s === null || s <= 0) return null;
  return v / s;
}

// --------------------------------------------------------------------------- //
// one run
// --------------------------------------------------------------------------- //
// Form averages and spread over the running portion of one run. -> object/null.
//
// Warm-up shuffling, traffic lights and the walk back to the door all sit below
// `minSpeed` and are dropped. They are not form, and a five-minute stop with
// the cadence field pinned at walking pace would otherwise pull the average of
// the whole run down by ten steps a minute -- which reads as a form problem
// that never happened.
//
// null when there was no running at all, or when not one of the four dynamics
// channels carried a usable value: a summary of four nulls tells the caller
// nothing the missing fields had not already.
export function summarise(samples, minSpeed = RUN_SPEED) {
  const series = _series(samples);
  const rows = _running(series, minSpeed);
  if (!rows.length) return null;

  const [cadence, doubled] = normaliseCadence(rows.map(r => r[3]));
  const cad = _stats(cadence);
  const stride = _stats(rows.map(r => r[4]));
  const gct = _stats(rows.map(r => r[5]));
  const vosc = _stats(rows.map(r => r[6]));
  if (!(cad || stride || gct || vosc)) return null;

  const [secs, dist] = _runningTotals(series, minSpeed);
  // Ratio of the means rather than the mean of the per-sample ratios: over a
  // whole run the two barely differ, and this one survives samples that carry
  // oscillation but not stride, or the other way round.
  const ratio = vosc && stride ? verticalRatio(vosc.mean, stride.mean) : null;

  return {
    n: rows.length,
    seconds: secs,
    distance_m: dist,
    speed: secs > 0 ? dist / secs : null,
    pace_s_per_km: dist > 0 ? 1000.0 * secs / dist : null,
    cadence: cad,
    stride_m: stride,
    gct_ms: gct,
    vert_osc_cm: vosc,
    vertical_ratio: ratio,
    cadence_doubled: doubled,
  };
}

// How turnover changes as the pace does. -> [object], fastest bucket first.
//
// A settled gait raises cadence only modestly from easy to hard -- a handful of
// steps a minute, with stride length doing most of the work. A big swing means
// the easy running is done with a long reaching stride and a slow turnover,
// which is overstriding dressed up as relaxation.
//
// Every bucket comes back with its own sample count, because a bucket holding
// four samples from a pace transition deserves to be ignored.
export function cadenceByPace(samples, buckets = PACE_BUCKETS, minSpeed = RUN_SPEED) {
  const rows = _running(_series(samples), minSpeed);
  const [cadence] = normaliseCadence(rows.map(r => r[3]));
  const edges = (buckets || []).map(Number).sort((a, b) => a - b);

  const binned = new Map();
  rows.forEach((row, k) => {
    const cad = cadence[k];
    if (cad == null || row[2] <= 0) return;
    const pace = 1000.0 / row[2];
    let i = 0;
    while (i < edges.length && pace >= edges[i]) i++;
    if (!binned.has(i)) binned.set(i, []);
    binned.get(i).push([pace, cad]);
  });

  const out = [];
  for (const i of [...binned.keys()].sort((a, b) => a - b)) {
    const pairs = binned.get(i);
    const lo = i > 0 ? edges[i - 1] : null;
    const hi = i < edges.length ? edges[i] : null;
    out.push({
      label: _bucketLabel(lo, hi),
      pace_lo: lo,
      pace_hi: hi,
      mean_pace: pySum(pairs.map(([p]) => p)) / pairs.length,
      cadence: pySum(pairs.map(([, c]) => c)) / pairs.length,
      n: pairs.length,
    });
  }
  return out;
}

function _bucketLabel(lo, hi) {
  if (lo === null && hi === null) return 'all paces';
  if (lo === null) return `faster than ${_mmss(hi)} /km`;
  if (hi === null) return `slower than ${_mmss(lo)} /km`;
  return `${_mmss(lo)}-${_mmss(hi)} /km`;
}

// First half of the running against the second. -> object or null.
//
// Cadence falling while ground contact rises is the classic picture of a runner
// coming apart late on: turnover slows, the foot sits on the ground longer, and
// the stride starts reaching to make up the difference.
//
// The pace of each half comes back too, because slowing down lowers cadence all
// by itself. Drift at a held pace is a finding; drift while fading is just the
// fade, and the caller needs to be able to tell them apart.
export function fatigueDrift(samples, minSpeed = RUN_SPEED) {
  const rows = _running(_series(samples), minSpeed);
  if (rows.length < MIN_DRIFT_SAMPLES) return null;
  const [cadence] = normaliseCadence(rows.map(r => r[3]));

  // Halves are counted in samples rather than in metres or seconds. Garmin
  // records at a steady rate, so on any normal file the two coincide.
  // ponytail: index halves. Split on elapsed running time if smart-recording
  // files, which sample irregularly, ever turn up here.
  const mid = Math.floor(rows.length / 2);

  const half = (lo, hi) => {
    const chunk = rows.slice(lo, hi);
    return [_mean(cadence.slice(lo, hi)), _mean(chunk.map(r => r[5])), _mean(chunk.map(r => r[2]))];
  };

  const [cad1, gct1, spd1] = half(0, mid);
  const [cad2, gct2, spd2] = half(mid, rows.length);
  if (cad1 === null && cad2 === null && gct1 === null && gct2 === null) return null;

  const cadPct = _pct(cad1, cad2);
  const gctPct = _pct(gct1, gct2);
  const falling = cadPct !== null && cadPct <= -DRIFT_PCT;
  const rising = gctPct !== null && gctPct >= DRIFT_PCT;

  return {
    n: rows.length,
    cadence_first: cad1, cadence_second: cad2,
    cadence_delta: (cad1 && cad2) ? cad2 - cad1 : null,
    cadence_pct: cadPct,
    gct_first: gct1, gct_second: gct2,
    gct_delta: (gct1 && gct2) ? gct2 - gct1 : null,
    gct_pct: gctPct,
    pace_first: spd1 ? 1000.0 / spd1 : null,
    pace_second: spd2 ? 1000.0 / spd2 : null,
    // Positive means the second half was slower, in the direction a runner
    // reads it: seconds per kilometre going up is going backwards.
    pace_pct: _pct(spd2, spd1),
    breaking_down: falling && rising,
  };
}

// --------------------------------------------------------------------------- //
// what the numbers mean
// --------------------------------------------------------------------------- //
const f0 = x => x.toFixed(0), f1 = x => x.toFixed(1);
// Python dict truthiness: null and {} are both false.
const truthy = o => !!o && (typeof o !== 'object' || Object.keys(o).length > 0);

// Turn a summary into plain-English findings. -> [{metric, severity, text}].
//
// Severity is 'good' (nothing to do), 'watch' (worth a session's attention) or
// 'note' (context, or a number only interesting next to another one).
//
// The reference points are population guidance -- roughly 170-180 spm, under
// about 250 ms on the ground, a vertical ratio under about 10% -- and they are
// quoted as such in the text. Cadence in particular rises with pace and falls
// with height, so the honest reading of a low figure is "look at this", never
// "fix this". Where a range is genuinely fuzzy the sentence says so rather than
// hiding it behind a decimal place.
export function assess(summary, drift = null, byPace = null) {
  if (!truthy(summary)) return [];
  const out = [];
  const add = (metric, severity, text) => out.push({ metric, severity, text });
  const [typLo, typHi] = CADENCE_TYPICAL.map(f0);

  const cad = summary.cadence;
  if (truthy(cad)) {
    const spm = cad.mean;
    if (spm < CADENCE_LOW) {
      add('cadence', 'watch',
        `Cadence averaged ${f0(spm)} spm. Most runners sit around ${typLo}-${typHi}, and `
        + 'this far under usually means the foot is landing out in front of '
        + 'you. That band is guidance rather than a rule -- cadence falls '
        + 'with height and with how easy the run was.');
    } else if (spm < CADENCE_TYPICAL[0]) {
      add('cadence', 'note',
        `Cadence averaged ${f0(spm)} spm, a little under the ${typLo}-${typHi} most `
        + 'runners settle at. Unremarkable on an easy run; worth a look if '
        + 'this one was hard.');
    } else if (spm <= CADENCE_HIGH) {
      add('cadence', 'good',
        `Cadence averaged ${f0(spm)} spm, inside the ${typLo}-${typHi} range most runners `
        + 'settle at.');
    } else {
      add('cadence', 'note',
        `Cadence averaged ${f0(spm)} spm, quicker than most. Nothing wrong with `
        + 'that as long as the stride does not feel cramped.');
    }
  }

  const gct = summary.gct_ms;
  if (truthy(gct)) {
    const ms = gct.mean;
    if (ms <= GCT_GOOD_MS) {
      add('gct_ms', 'good',
        `Ground contact averaged ${f0(ms)} ms, the quick side of the ~${f0(GCT_GOOD_MS)} ms `
        + 'usually quoted.');
    } else if (ms <= GCT_LONG_MS) {
      add('gct_ms', 'note',
        `Ground contact averaged ${f0(ms)} ms, a shade over the ~${f0(GCT_GOOD_MS)} ms usually `
        + 'quoted. It shortens as you speed up, so an easy run reading like '
        + 'this means little.');
    } else {
      add('gct_ms', 'watch',
        `Ground contact averaged ${f0(ms)} ms -- a long time on the ground. It `
        + 'usually travels with a slow cadence, so raise the turnover first '
        + 'and expect this to follow.');
    }
  }

  const ratio = summary.vertical_ratio;
  if (ratio != null) {
    if (ratio < VERTICAL_RATIO_GOOD) {
      add('vertical_ratio', 'good',
        `Vertical ratio ${f1(ratio)}%, under the ~${f0(VERTICAL_RATIO_GOOD)}% usually called economical: `
        + 'the bounce is paying for itself in stride.');
    } else if (ratio < VERTICAL_RATIO_HIGH) {
      add('vertical_ratio', 'note',
        `Vertical ratio ${f1(ratio)}%, right around the ~${f0(VERTICAL_RATIO_GOOD)}% mark the usual `
        + 'guidance sits at -- close enough that your own past runs are a '
        + 'better yardstick than any published figure.');
    } else {
      add('vertical_ratio', 'watch',
        `Vertical ratio ${f1(ratio)}%: a lot of the work is going up rather than `
        + 'along. More often a short stride than a high bounce, so check '
        + 'stride length before trying to run flatter.');
    }
  }

  if (truthy(drift)) {
    if (drift.breaking_down) {
      let text = `Cadence fell ${f1(Math.abs(drift.cadence_pct))}% and ground contact rose `
        + `${f1(drift.gct_pct)}% between the `
        + 'first and second half -- the usual signature of form going late '
        + 'in a run.';
      if ((drift.pace_pct || 0) > 2.0) {
        text += ` You also slowed ${f1(drift.pace_pct)}%, which accounts for some of it.`;
      }
      add('drift', 'watch', text);
    } else if (drift.cadence_pct != null || drift.gct_pct != null) {
      add('drift', 'good',
        'Cadence and ground contact held between the halves of the run: the '
        + 'form you finished with was the form you started with.');
    }
  }

  const solid = (byPace || []).filter(b => b.n >= MIN_BUCKET_SAMPLES);
  if (solid.length >= 2) {
    const cadences = solid.map(b => b.cadence);
    const swing = Math.max(...cadences) - Math.min(...cadences);
    const where = `${solid[solid.length - 1].label} to ${solid[0].label}`;
    if (swing >= CADENCE_SWING_SPM) {
      add('cadence_swing', 'watch',
        `Cadence swings ${f0(swing)} spm across your paces (${where}). A swing that big `
        + 'normally means the slow running is done with a long reaching '
        + 'stride rather than a quicker one -- though where a big swing '
        + 'starts is a rule of thumb, not a measurement.');
    } else {
      add('cadence_swing', 'good',
        `Cadence moves only ${f0(swing)} spm from your slowest pace to your fastest, `
        + 'so the gears are coming from stride length. That is what a settled '
        + 'gait looks like.');
    }
  }

  if (summary.cadence_doubled) {
    add('cadence', 'note',
      'This file reported single-leg cadence; it has been doubled to steps per '
      + 'minute over both feet so it can be compared with everything else.');
  }

  if ((summary.seconds || 0) < THIN_RUN_S) {
    add('data', 'note',
      `Only ${f0((summary.seconds || 0) / 60.0)} minutes of actual running here -- thin enough that the `
      + 'averages are indicative rather than solid.');
  }

  return out;
}
