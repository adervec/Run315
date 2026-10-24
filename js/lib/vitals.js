// Which of your numbers actually respond to your training?
//
// A watch now records two dozen things a day. Almost every app displays them as
// two dozen separate dials, which pushes the only interesting question onto the
// athlete: *does any of this have anything to do with my running?*
//
// For a given person the answer is usually "three of them do". Which three is
// individual -- one runner's sleep collapses after hard days while their resting
// heart rate never moves, and the next runner is the other way round. Population
// studies wash this out by averaging over people who differ; a single athlete's own
// record does not have that problem.
//
// So this module correlates every daily metric against training load, at several
// lags, and reports the ones that stand up. The lag matters: stress responds the
// same night, sleep architecture the night after, body mass over weeks.
//
// **The statistics are the hard part, and getting them wrong here would be worse
// than not doing it at all.** Two guards:
//
//   * **Multiple comparisons.** Twenty-three metrics times four lags is ninety-two
//     tests. At the usual 5% threshold you would expect four or five to look
//     "significant" from noise alone. Every threshold here is Bonferroni-corrected
//     by the number of tests actually run, and the uncorrected count is reported
//     alongside so the difference is visible rather than hidden.
//   * **Autocorrelation.** Daily training load is not independent day to day --
//     hard days cluster, and so do bad nights. That inflates significance for any
//     naive test, this one included. The correction above does not fix it, so the
//     effective sample size is smaller than the number of days and everything here
//     is reported as *worth looking at*, never as established.
//
// Correlation is not causation and a daily record cannot separate the two. What it
// can do is tell you which dials are worth glancing at and which have never once
// moved with your training.
//
// Pure functions. See test/vitals.test.mjs.
//
// Days are 'YYYY-MM-DD' keys. `daily` is [[day, {metric: value}]]; `loadByDay` is
// {day: load}.
import { normInv } from './py.js';
import { addDayKey } from './dt.js';

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


// Lags to test, in days. Same-day, next-day, and two slower windows for the
// things that move over weeks rather than nights.
export const LAGS = [0, 1, 2, 7];

// Minimum paired days before a correlation means anything at all.
export const MIN_POINTS = 20;

// Significance before correction. Corrected by the number of tests run.
export const ALPHA = 0.05;

// Correlations below this are not worth a sentence even when "significant",
// because with enough days almost anything clears a threshold.
export const MIN_INTERESTING = 0.25;

// Metrics that ARE the training rather than a response to it. Calories burned
// correlating with running is not a finding, it is arithmetic, and letting these
// sit at the top of the list buries the signals that took work to find.
export const MECHANICAL = new Set(['calories_total', 'calories_active', 'intensity_minutes',
  'vigorous_minutes', 'steps', 'floors']);

// Metrics where a *higher* number is the worse outcome, so the wording flips.
export const HIGHER_IS_WORSE = new Set(['stress_avg', 'stress_max', 'avg_stress', 'restless_count',
  'awake_s', 'body_fat_pct', 'fitness_age', 'respiration_avg']);

// Human names, because "spo2_low" on a page is a failure of nerve.
export const LABELS = {
  steps: 'daily steps', floors: 'floors climbed',
  stress_avg: 'average stress', stress_max: 'peak stress',
  body_battery_high: 'body battery peak',
  body_battery_low: 'body battery low point',
  spo2_avg: 'blood oxygen', spo2_low: 'lowest blood oxygen',
  respiration_avg: 'breathing rate',
  intensity_minutes: 'intensity minutes',
  vigorous_minutes: 'vigorous minutes',
  weight_kg: 'body mass', body_fat_pct: 'body fat',
  training_readiness: 'Garmin readiness',
  calories_total: 'total calories', calories_active: 'active calories',
  fitness_age: 'fitness age',
  deep_s: 'deep sleep', light_s: 'light sleep', rem_s: 'REM sleep',
  awake_s: 'time awake', restless_count: 'restlessness',
  avg_stress: 'overnight stress',
  hrv_ms: 'HRV', rhr: 'resting heart rate',
  sleep_hours: 'sleep length', sleep_score: 'sleep score',
};

export function label(name) {
  return Object.hasOwn(LABELS, name) ? LABELS[name] : name.replaceAll('_', ' ');
}

const get = (row, name) => row[name] ?? null;

// Correlation of two equal-length series, ignoring pairs with a gap.
export function pearson(xs, ys) {
  const pairs = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (xs[i] != null && ys[i] != null) pairs.push([xs[i], ys[i]]);
  }
  if (pairs.length < 3) return null;
  const n = pairs.length;
  const meanX = pySum(pairs.map(([x]) => x)) / n;
  const meanY = pySum(pairs.map(([, y]) => y)) / n;
  const sxx = pySum(pairs.map(([x]) => (x - meanX) ** 2));
  const syy = pySum(pairs.map(([, y]) => (y - meanY) ** 2));
  if (sxx <= 0 || syy <= 0) return null;                     // a flat series correlates with nothing
  const sxy = pySum(pairs.map(([x, y]) => (x - meanX) * (y - meanY)));
  return sxy / Math.sqrt(sxx * syy);
}

// The smallest correlation that clears significance. -> number|null.
// Uses the normal approximation to the t distribution, which is close enough
// past about thirty paired days, and applies a Bonferroni correction for the
// number of tests actually run.
export function criticalR(n, alpha = ALPHA, tests = 1) {
  if (n < 4) return null;
  const adjusted = alpha / Math.max(tests, 1);
  if (!(adjusted > 0 && adjusted < 1)) return null;
  const z = normInv(1.0 - adjusted / 2.0);
  return z / Math.sqrt(n - 2 + z * z);
}

// Training load `lag` days before each day in `days`.
function _shift(loadByDay, days, lag) {
  return days.map(day => loadByDay[addDayKey(day, -lag)] ?? null);
}

// Every metric against training load, at every lag. -> object.
export function correlate(daily, loadByDay, metrics = null, lags = LAGS) {
  if (!daily || !daily.length) return { findings: [], tested: 0, days: 0, critical_r: null };

  const days = daily.map(([d]) => d);
  const columns = new Map();
  for (const name of (metrics && metrics.length ? metrics : _metricNames(daily))) {
    columns.set(name, daily.map(([, row]) => get(row, name)));
  }

  // Count the tests first, so the correction is honest rather than applied to
  // whatever survived.
  let tested = 0;
  const candidates = [];
  for (const [name, values] of columns) {
    for (const lag of lags) {
      const loads = _shift(loadByDay, days, lag);
      let paired = 0;
      for (let i = 0; i < values.length; i++) if (values[i] !== null && loads[i] !== null) paired++;
      if (paired < MIN_POINTS) continue;
      tested++;
      const r = pearson(values, loads);
      if (r !== null) candidates.push([name, lag, r, paired]);
    }
  }

  let cut = null;
  const findings = [];
  for (const [name, lag, r, paired] of candidates) {
    const threshold = criticalR(paired, ALPHA, tested);
    cut = cut === null ? threshold : Math.max(cut, threshold);
    if (threshold === null || Math.abs(r) < Math.max(threshold, MIN_INTERESTING)) continue;
    findings.push({
      metric: name, label: label(name), lag, r,
      days: paired, threshold,
      note: _findingNote(name, lag, r),
    });
  }

  // Strongest first, and only the best lag per metric: the same signal showing
  // up at lag 0 and lag 1 is one finding, not two.
  findings.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  const best = [], mechanical = [], seen = new Set();
  for (const finding of findings) {
    if (seen.has(finding.metric)) continue;
    seen.add(finding.metric);
    (MECHANICAL.has(finding.metric) ? mechanical : best).push(finding);
  }

  return {
    findings: best, mechanical,
    tested, days: days.length,
    critical_r: cut,
    uncorrected: candidates.filter(([, , r, p]) => Math.abs(r) >= (criticalR(p, ALPHA, 1) || 1.0)).length,
  };
}

function _metricNames(daily) {
  const names = new Set();
  for (const [, row] of daily) {
    for (const [k, v] of Object.entries(row)) if (v != null) names.add(k);
  }
  return [...names].sort();
}

// Python's "%+.2f".
const signed2 = x => (x < 0 || Object.is(x, -0) ? '' : '+') + x.toFixed(2);

function _findingNote(name, lag, r) {
  const direction = r > 0 ? 'rises' : 'falls';
  const when = { 0: 'on a hard day itself', 1: 'the day after a hard day',
    2: 'two days after a hard day' }[lag] ?? 'about a week after a hard day';
  const worse = (r > 0) === HIGHER_IS_WORSE.has(name);
  let tail = worse ? ' That is the direction that costs you.' : ' That is the direction you would hope for.';
  if (lag >= 7) {
    // Training is weekly, so a seven-day lag is nearly the same phase as no
    // lag at all. Saying so is more useful than pretending otherwise.
    tail += ' Careful with this one: training runs on a weekly rhythm, so a '
      + 'seven-day lag lands on almost the same phase as no lag, and the '
      + 'two are hard to tell apart.';
  }
  return `Your ${label(name)} ${direction} ${when} (r = ${signed2(r)}).${tail}`;
}

// How the night is built, against the usual adult proportions. -> object|null.
// Reference shares for adults are roughly 13-23% deep, 20-25% REM, the rest
// light. They are population figures and individual variation is wide, so this
// reports where you sit rather than whether you pass.
export function sleepArchitecture(daily) {
  const stages = [];
  for (const [, row] of daily || []) {
    const deep = get(row, 'deep_s'), light = get(row, 'light_s'), rem = get(row, 'rem_s');
    if (!deep || !light || !rem) continue;
    const total = deep + light + rem;
    if (total <= 0) continue;
    stages.push([deep / total, light / total, rem / total, total]);
  }
  if (stages.length < 7) return null;

  const n = stages.length;
  const avg = k => pySum(stages.map((st) => st[k])) / n;
  const deep = avg(0), light = avg(1), rem = avg(2), asleep = avg(3);
  return {
    nights: n,
    deep_share: deep, light_share: light, rem_share: rem,
    asleep_s: asleep,
    deep_typical: deep >= 0.13 && deep <= 0.23,
    rem_typical: rem >= 0.20 && rem <= 0.25,
    note: _sleepNote(deep, rem),
  };
}

function _sleepNote(deep, rem) {
  const parts = [];
  if (deep < 0.13) parts.push('less deep sleep than the usual adult range');
  else if (deep > 0.23) parts.push('more deep sleep than the usual adult range');
  if (rem < 0.20) parts.push('less REM than typical');
  else if (rem > 0.25) parts.push('more REM than typical');
  if (!parts.length) {
    return 'Your nights are built in roughly the usual adult proportions. '
      + 'Sleep staging from a wrist device is an estimate, so read this '
      + 'as a shape rather than a measurement.';
  }
  return `Your nights show ${parts.join(' and ')}. Wrist-based sleep staging is an estimate and `
    + 'disagrees with a sleep lab often enough that this is worth watching '
    + 'for a trend, not acting on from one week.';
}

// Where a metric is heading. -> object|null.
// Compares the mean of the last `window` days with the window before it, which
// is blunt and survives missing days, and reports the change relative to the
// metric's own spread so a number in kilograms and one in beats per minute can
// sit in the same table.
export function trend(daily, metric, window = 14) {
  const values = (daily || []).filter(([, row]) => get(row, metric) !== null)
    .map(([d, row]) => [d, row[metric]]);
  if (values.length < window + 4) return null;
  values.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const recent = values.slice(-window).map(([, v]) => v);
  const before = values.slice(-2 * window, -window).map(([, v]) => v);
  if (before.length < 4) return null;

  const recentMean = pySum(recent) / recent.length;
  const beforeMean = pySum(before) / before.length;
  const everything = values.map(([, v]) => v);
  const spread = _stdev(everything);
  const change = recentMean - beforeMean;
  return {
    metric, label: label(metric),
    recent: recentMean, before: beforeMean,
    change,
    relative: beforeMean ? change / beforeMean : null,
    z: spread ? change / spread : null,
    notable: !!(spread && Math.abs(change) > spread * 0.5),
    better: _isBetter(metric, change),
  };
}

function _isBetter(metric, change) {
  if (change === 0) return null;
  return HIGHER_IS_WORSE.has(metric) ? change < 0 : change > 0;
}

// Sample sd; 0 below two values rather than an error.
function _stdev(values) {
  if (values.length < 2) return 0.0;
  const mean = pySum(values) / values.length;
  return Math.sqrt(pySum(values.map((v) => (v - mean) ** 2)) / (values.length - 1));
}

// Days where one metric was genuinely unlike the others. -> [object].
export function outliers(daily, metric, sigma = 2.5) {
  const values = (daily || []).filter(([, row]) => get(row, metric) !== null)
    .map(([d, row]) => [d, row[metric]]);
  if (values.length < MIN_POINTS) return [];
  const numbers = values.map(([, v]) => v);
  const mean = pySum(numbers) / numbers.length;
  const spread = _stdev(numbers);
  if (spread <= 0) return [];
  return values.filter(([, v]) => Math.abs(v - mean) / spread >= sigma)
    .map(([d, v]) => ({ day: d, metric, label: label(metric), value: v, z: (v - mean) / spread }));
}

// Days that were unusual across *several* metrics at once. -> [object].
// One metric out of range is noise. Four at once, on the same day, is the day
// you were coming down with something -- and that is a pattern a per-metric
// chart cannot show you.
export function oddDays(daily, sigma = 2.0, minMetrics = 3) {
  if (!daily || daily.length < MIN_POINTS) return [];
  // Mechanical metrics spike on every long run, which is not the day being
  // unusual -- it is the day being long. An odd day should be about your body.
  const names = _metricNames(daily).filter(n => !MECHANICAL.has(n));
  const byDay = new Map();
  for (const name of names) {
    for (const hit of outliers(daily, name, sigma)) {
      if (!byDay.has(hit.day)) byDay.set(hit.day, []);
      byDay.get(hit.day).push(hit);
    }
  }
  const out = [];
  for (const [day, hits] of byDay) {
    if (hits.length >= minMetrics) {
      out.push({ day, count: hits.length,
        metrics: [...hits].sort((a, b) => Math.abs(b.z) - Math.abs(a.z)) });
    }
  }
  out.sort((a, b) => b.count - a.count || (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  return out;
}
