// Aerobic efficiency over a whole career: is the engine better than it was?
//
// Two measures, both per steady run, both needing nothing but distance, time and heart rate:
//   EF   efficiency factor -- flat-equivalent metres per minute per beat per minute (speed / HR).
//        Higher is fitter. (Coggan's EF, as GoldenCheetah and Athlytics use it.)
//   RRE  relative running economy -- 100000 / heartbeats above resting per km (Runalyze). It takes
//        the morning's resting HR out, so a run on a high-RHR day is not mistaken for unfitness.
// Corrected for the two things that move both without fitness changing: hills (Naismith-style
// book time from terrain.js) and heat (the pace penalty from weather.js).
//
// "Steady" means a continuous aerobic run: running, at least 5 km and 20 minutes, average HR
// between 65% and 90% of threshold, and no interval session found in it. Intervals, races and
// recovery jogs measure something else.
import { bookTime } from './terrain.js';
import { penalty } from './weather.js';
import { dayKey } from './dt.js';

export const MIN_DISTANCE_M = 5000, MIN_MOVING_S = 1200, HR_LO = 0.65, HR_HI = 0.90;
const RUNNING = new Set(['running', 'track_running', 'road_running', 'street_running']);

// One run -> {date, ef, rre, speed_m_min, hr, corrected: {hill, heat}} or null when it is not a steady run.
export function runEfficiency(a, { thrHr, rhr = null, tempC = null, humidity = null, dewPointC = null, interval = false } = {}) {
  if (!a || !RUNNING.has(a.type) || interval) return null;
  const d = a.distance_m, t = a.moving_s, hr = a.avg_hr;
  if (!d || !t || !hr || d < MIN_DISTANCE_M || t < MIN_MOVING_S || !thrHr) return null;
  if (hr < HR_LO * thrHr || hr > HR_HI * thrHr) return null;
  // Hills: the time the run would have taken on the flat, by the ratio of book times.
  const book = bookTime(d, a.elev_gain_m || 0), flat = bookTime(d, 0);
  const hill = book && flat ? flat / book : 1;
  // Heat: weather.penalty is the fraction a hot day slows the same effort.
  const p = tempC != null ? penalty(tempC, humidity, dewPointC) || 0 : 0;
  const heat = 1 / (1 + p);
  const flatT = t * hill * heat;
  const speed = d / (flatT / 60);              // flat, temperate metres per minute
  const out = { date: dayKey(a.start), id: a.id, ef: speed / hr, speed_m_min: speed, hr, corrected: { hill, heat } };
  if (rhr && hr > rhr) out.rre = 100000 / ((hr - rhr) * (flatT / 60) / (d / 1000));
  return out;
}

const median = xs => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
// A distribution-free 95% interval for a median: the order statistics a binomial puts around it.
export function medianCI(xs) {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  if (n < 6) return null;
  const half = 1.96 * Math.sqrt(n) / 2;
  return [s[Math.max(0, Math.floor(n / 2 - half))], s[Math.min(n - 1, Math.ceil(n / 2 + half) - 1)]];
}

// Rows -> per-period medians with intervals: [{period, n, ef, ef_ci, rre, rre_ci}], oldest first.
// period: 'month' | 'quarter' | 'year'.
export function trend(rows, period = 'quarter') {
  const key = d => period === 'year' ? d.slice(0, 4) : period === 'month' ? d.slice(0, 7)
    : d.slice(0, 4) + '-Q' + (Math.floor((+d.slice(5, 7) - 1) / 3) + 1);
  const groups = new Map();
  for (const r of rows) { const k = key(r.date); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  return [...groups.keys()].sort().map(k => {
    const g = groups.get(k), ef = g.map(r => r.ef), rre = g.filter(r => r.rre).map(r => r.rre);
    return { period: k, n: g.length, ef: median(ef), ef_ci: medianCI(ef), rre: rre.length ? median(rre) : null, rre_ci: medianCI(rre) };
  });
}

// Least-squares slope of EF against time, as % per year with a 95% interval. null under 12 runs.
export function slope(rows, field = 'ef') {
  const pts = rows.filter(r => r[field] != null).map(r => [Date.parse(r.date) / (365.25 * 864e5), r[field]]);
  const n = pts.length;
  if (n < 12) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, sxy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
  if (!sxx) return null;
  const b = sxy / sxx, a = my - b * mx;
  let sse = 0; for (const [x, y] of pts) sse += (y - a - b * x) ** 2;
  const se = Math.sqrt(sse / (n - 2) / sxx);
  const pct = v => 100 * v / my;
  return { per_year_pct: pct(b), ci_pct: [pct(b - 1.96 * se), pct(b + 1.96 * se)], n, years: (pts[n - 1][0] - pts[0][0]) };
}

// How much more load the HR trace implies than its average does. Banister's TRIMP weights each
// moment by x*e^(1.92x), x the fraction of heart-rate reserve, so time near max counts far more
// than time near rest; scoring a session by its average HR alone flattens that, and under-counts
// intervals (half the time at x 0.9, half at 0.5, averages to 0.7: weighted 1.19x more than the
// average says). The factor is mean(f(x)) / f(mean x), time-weighted over the moving part; a
// steady run is ~1.0. It multiplies the existing average-HR load, so the TSS-like scale stays.
// rest/max: resting and maximum HR (defaults when unknown). -> null with too little HR.
const banister = x => x * Math.exp(1.92 * x);
export function hrLoadFactor(samples, rest = 50, max = null) {
  let w = 0, s1 = 0, sf = 0, top = 0;
  for (const s of samples) if (s[2] > top) top = s[2];
  const hmax = max || top * 1.03;
  if (!(hmax > rest + 20)) return null;
  const x = hr => Math.max(0, Math.min(1.1, (hr - rest) / (hmax - rest)));
  for (let i = 1; i < samples.length; i++) {
    const hr = samples[i][2], dt = samples[i][0] - samples[i - 1][0], dd = samples[i][1] - samples[i - 1][1];
    if (!hr || !(dt > 0) || dt > 30 || !(dd / dt > 0.5)) continue;   // moving only; gaps skipped
    w += dt; s1 += x(hr) * dt; sf += banister(x(hr)) * dt;
  }
  if (w < 300) return null;
  const f = banister(s1 / w);
  return f > 0 ? Math.max(1, Math.min(1.6, (sf / w) / f)) : null;
}
