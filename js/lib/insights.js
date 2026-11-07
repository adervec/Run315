// Seven small questions the rest of the app does not ask, each answered from data it already
// holds. Every function here is pure: the page (js/pages/insights.js) does the I/O -- reading
// streams one at a time and caching what each one gave -- and these turn rows into numbers.
//
//   1. heart-rate recovery     how far HR falls 60 s and 120 s after a hard effort ends
//   2. HRV trend               Plews' 7-day ln(rMSSD) against a 60-day baseline
//   3. running form            cadence, contact time, oscillation... at matched pace, per year
//   4. seasons                 the best-effort curve and critical speed, year by year
//   5. predictor spread        five race predictions side by side, and what a goal requires
//   6. climbs                  hills found in the stream, categorised, and repeated over the years
//   7. time of day             when he runs, and whether the hour or the weekday changes anything
//
// Stream rows are the legacy 10-wide samples (js/ingest.js samplesFromChannels):
// [t, d, hr, lat, lon, ele, cad, stride, gct, vosc].
import { criticalSpeed } from './durability.js';
import { basePrediction, STANDARD_RACES } from './fitness.js';
import { costRatio, haversine } from './racecraft.js';
import { adjust as heatAdjust } from './weather.js';
import { medianCI } from './efficiency.js';

export { medianCI };
export const median = xs => {
  const s = xs.filter(x => x != null && isFinite(x)).sort((a, b) => a - b), n = s.length;
  return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
};
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = xs => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
const r1 = v => (v == null ? null : Math.round(v * 10) / 10);
export const quarterOf = day => day.slice(0, 4) + '-Q' + (Math.floor((+day.slice(5, 7) - 1) / 3) + 1);

// ---- stream helpers ----
// Index of the last sample with t <= x (samples sorted by time). -1 before the start.
function floorIdx(T, x) {
  let lo = 0, hi = T.length - 1;
  if (!T.length || x < T[0]) return -1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (T[m] <= x) lo = m; else hi = m - 1; }
  return lo;
}
// Distance at time x, linearly between samples.
function distAt(T, Dd, x) {
  const i = floorIdx(T, x);
  if (i < 0) return Dd[0];
  if (i >= T.length - 1) return Dd[T.length - 1];
  const f = (x - T[i]) / ((T[i + 1] - T[i]) || 1);
  return Dd[i] + f * (Dd[i + 1] - Dd[i]);
}
const avgSpeed = (T, Dd, a, b) => (b > a ? (distAt(T, Dd, b) - distAt(T, Dd, a)) / (b - a) : null);
// The HR recorded nearest to time x, if one is within tol seconds -- a watch that auto-paused
// through the recovery has no reading there, and an interpolated one would be invented.
function hrNear(T, H, x, tol = 4) {
  const i = floorIdx(T, x);
  let best = null, bd = tol + 1e-9;
  for (const j of [i - 1, i, i + 1, i + 2]) {
    if (j < 0 || j >= T.length || !H[j]) continue;
    const dd = Math.abs(T[j] - x);
    if (dd <= bd) { bd = dd; best = H[j]; }
  }
  return best;
}
function hrMaxIn(T, H, a, b) {
  let m = null;
  for (let i = Math.max(0, floorIdx(T, a)); i < T.length && T[i] <= b; i++) if (H[i] && T[i] >= a && (m == null || H[i] > m)) m = H[i];
  return m;
}
// The median spacing between samples, in seconds.
function sampleStep(T) {
  const d = [];
  for (let i = 1; i < T.length; i += Math.max(1, Math.floor(T.length / 200))) d.push(T[i] - T[i - 1]);
  d.sort((a, b) => a - b);
  return d.length ? d[d.length >> 1] : 1;
}
const columns = samples => {
  const s = samples.filter(r => r && r[0] != null && r[1] != null);
  return { T: s.map(r => +r[0]), Dd: s.map(r => +r[1]), H: s.map(r => (r[2] ? +r[2] : null)), s };
};

// =====================================================================================
// 1. Heart-rate recovery
// =====================================================================================
// HRR60: the fall in heart rate in the first minute after hard work stops. It is mostly
// parasympathetic reactivation and tracks fitness and fatigue within one person (Daanen et
// al. 2012, Int J Sports Physiol Perform), but it depends heavily on how high HR was when the
// effort ended and on what you did in the minute after -- standing, walking or jogging -- so it
// only means something compared with itself, from similar efforts.
//
// Where an effort ends:
//   * the reps of an interval session (intervals.js detectReps: start_s / end_s), when the
//     recovery after them lasts at least the window and is slower than the rep (a float
//     recovery counts; the HR falls less in it, which is why sessions are compared by quarter
//     and not judged one by one);
//   * otherwise, peaks in the top 10% of the run's HR followed by at least 60 s of easing
//     (speed down by a quarter or more against the minute before);
//   * and the end of a run, when the watch kept recording a cool-down walk after it.
export const HRR_VERSION = 1;
export const HRR_MIN_HR0 = 120;          // a "recovery" from 110 bpm is not one
export const HRR_EASE = 0.75;            // speed after <= 75% of speed before counts as easing
export const HRR_EASE_REP = 0.9;         // ...after a detected rep, whose end is already known, any real slow-down
const HRR_PEAK_GAP_S = 150, HRR_MAX_EVENTS = 15;

// One event at time t0: [hr0, d60, d120] (d120 null if the easing did not last that long).
function recoveryAt(T, Dd, H, t0, lastOk, tol = 4) {
  const hr0 = hrMaxIn(T, H, t0 - 5, t0 + 10);
  if (!hr0 || hr0 < HRR_MIN_HR0) return null;
  const h60 = lastOk >= 60 ? hrNear(T, H, t0 + 60, tol) : null;
  if (h60 == null) return null;
  const d60 = hr0 - h60;
  if (d60 < -5 || d60 > 90) return null;         // a strap artefact, not a heart
  const h120 = lastOk >= 120 ? hrNear(T, H, t0 + 120, tol) : null;
  const d120 = h120 != null && hr0 - h120 >= -5 && hr0 - h120 <= 110 ? hr0 - h120 : null;
  return [hr0, d60, d120];
}
// How long after t0 the athlete kept easing (up to 120 s): checked at 60 and 120 s.
function easedFor(T, Dd, t0, before, until = Infinity, ease = HRR_EASE) {
  const lim = Math.min(until, T[T.length - 1]) - t0;
  if (lim < 60 || !(before > 0)) return 0;
  const a60 = avgSpeed(T, Dd, t0, t0 + 60);
  if (a60 == null || a60 > ease * before) return 0;
  if (lim < 120) return 60;
  const a120 = avgSpeed(T, Dd, t0, t0 + 120);
  return a120 != null && a120 <= ease * before ? 120 : 60;
}

// samples (+ the session's reps, if any) -> [[kind, hr0, d60, d120]], kind 'r' rep, 'p' peak, 'e' end.
export function hrRecovery(samples, reps = null) {
  const { T, Dd, H } = columns(samples || []);
  // Smart recording writes a sample every few seconds, not every second: the HR "at" +60 s
  // is the nearest reading within about half a sample interval (never more than 8 s away).
  const tol = Math.min(8, Math.max(4, 0.6 * sampleStep(T)));
  if (T.length < 30 || H.filter(Boolean).length < T.length * 0.5) return [];
  const out = [];
  if (reps && reps.length) {
    reps.forEach((r, k) => {
      const t0 = r.end_s, next = reps[k + 1] ? reps[k + 1].start_s : Infinity;
      const before = avgSpeed(T, Dd, Math.max(r.start_s, t0 - 60), t0);
      const ok = easedFor(T, Dd, t0, before, next, HRR_EASE_REP);
      const ev = ok ? recoveryAt(T, Dd, H, t0, ok, tol) : null;
      if (ev) out.push(['r', ...ev]);
    });
  } else {
    const hs = H.filter(Boolean).sort((a, b) => a - b), p90 = hs[Math.floor(hs.length * 0.9)];
    const cands = [];
    for (let i = 0; i < T.length; i++) {
      if (!H[i] || H[i] < p90) continue;
      // a local maximum over +-30 s, so one long hard stretch gives one candidate
      const lo = floorIdx(T, T[i] - 30), hiT = T[i] + 30;
      let isMax = true;
      for (let j = Math.max(0, lo); j < T.length && T[j] <= hiT; j++) if (H[j] && H[j] > H[i]) { isMax = false; break; }
      if (isMax && (!cands.length || T[i] - cands[cands.length - 1] >= 30)) cands.push(T[i]);
    }
    let last = -Infinity;
    for (const t0 of cands) {
      if (t0 - last < HRR_PEAK_GAP_S) continue;
      const ok = easedFor(T, Dd, t0, avgSpeed(T, Dd, t0 - 60, t0));
      const ev = ok ? recoveryAt(T, Dd, H, t0, ok, tol) : null;
      if (ev) { out.push(['p', ...ev]); last = t0; }
      if (out.length >= HRR_MAX_EVENTS) break;
    }
  }
  // The end of the run: the last minute of running, when the stream goes on for a minute after
  // (a cool-down walk with the watch still recording). Most runs end on the stop button and
  // give nothing here.
  const tEnd = T[T.length - 1], lastRep = reps && reps.length ? reps[reps.length - 1].end_s : -Infinity;
  for (let t = tEnd - 60; t > T[0] + 120; t -= 2) {
    if (!(avgSpeed(T, Dd, t - 10, t) >= 2.0)) continue;
    const sp = avgSpeed(T, Dd, t - 60, t);
    if (sp != null) {
      const ok = t - lastRep > 90 ? easedFor(T, Dd, t, sp) : 0;   // not the last rep again
      const ev = ok ? recoveryAt(T, Dd, H, t, ok, tol) : null;
      if (ev) out.push(['e', ...ev]);
      break;
    }
  }
  return out;
}

// The compact synced form, should derive.js want one: [n, median d60, median d120, median hr0]
// over the effort (rep / peak) events -> ~20 bytes of JSON, or null.
export function hrrCore(events) {
  const ev = (events || []).filter(e => e[0] !== 'e');
  if (!ev.length) return null;
  const d120 = ev.map(e => e[3]).filter(v => v != null);
  return [ev.length, r1(median(ev.map(e => e[2]))), d120.length ? r1(median(d120)) : null, Math.round(median(ev.map(e => e[1])))];
}

// rows [{date, e: [[kind, hr0, d60, d120]]}] -> per-quarter medians, oldest first.
// One number per session first (its median), so a 12 x 400 m session does not outvote a
// tempo run with one effort; then the median and its 95% interval across sessions.
// Only efforts that ended at >= 85% of max HR count, when max HR is known: recovery from a
// lower HR is smaller for reasons that have nothing to do with fitness.
export function hrrTrend(rows, { hrMax = null, period = 'quarter', kinds = ['r', 'p'] } = {}) {
  const key = period === 'year' ? d => d.slice(0, 4) : quarterOf;
  const groups = new Map();
  for (const r of rows || []) {
    const ev = (r.e || []).filter(e => kinds.includes(e[0]) && (!hrMax || e[1] >= 0.85 * hrMax));
    if (!ev.length) continue;
    const k = key(r.date);
    if (!groups.has(k)) groups.set(k, []);
    const d120 = ev.map(e => e[3]).filter(v => v != null);
    groups.get(k).push({ d60: median(ev.map(e => e[2])), d120: d120.length ? median(d120) : null, hr0: median(ev.map(e => e[1])), n: ev.length });
  }
  return [...groups.keys()].sort().map(k => {
    const g = groups.get(k), d60 = g.map(x => x.d60), d120 = g.map(x => x.d120).filter(v => v != null);
    return { period: k, sessions: g.length, events: g.reduce((a, x) => a + x.n, 0),
      d60: median(d60), d60_ci: medianCI(d60), d120: d120.length ? median(d120) : null, d120_ci: medianCI(d120),
      hr0: median(g.map(x => x.hr0)) };
  });
}

// =====================================================================================
// 2. HRV: Plews' rolling ln(rMSSD)
// =====================================================================================
// A single morning's HRV is too noisy to act on; the 7-day rolling mean of its natural log is
// what Plews, Laursen, Stanley, Kilding and Buchheit (Sports Med 2013) found tracks adaptation
// and maladaptation, read against the athlete's own baseline with a "smallest worthwhile
// change" of half a standard deviation. The week's coefficient of variation says how unsettled
// it is: a rising CV with a falling mean is the classic overreaching picture.
//
// Garmin's nightly figure is not the measurement those papers used (a short supine or seated
// reading on waking): it is an average of 5-minute rMSSD values across the night. The method
// transfers; the absolute numbers and published thresholds do not.
export const HRV_ROLL = 7, HRV_BASE = 60, HRV_MIN_ROLL = 5, HRV_MIN_BASE = 30;

const addDay = (day, n) => { const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + n)); return d.toISOString().slice(0, 10); };

// wellness {day: {hrv_ms}} -> [{day, ln, roll, cv, base, lo, hi, flag}] for days with a rolling
// mean (>= 5 of 7 nights). base/lo/hi are null until 30 nights of baseline precede the week.
export function hrvTrend(wellness, { roll = HRV_ROLL, base = HRV_BASE } = {}) {
  const ln = new Map();
  for (const [day, w] of Object.entries(wellness || {})) if (w && w.hrv_ms > 0 && /^\d{4}-\d\d-\d\d$/.test(day)) ln.set(day, Math.log(w.hrv_ms));
  if (!ln.size) return [];
  const days = [...ln.keys()].sort(), out = [];
  for (let day = days[0]; day <= days[days.length - 1]; day = addDay(day, 1)) {
    const wk = [];
    for (let k = 0; k < roll; k++) { const v = ln.get(addDay(day, -k)); if (v != null) wk.push(v); }
    if (wk.length < HRV_MIN_ROLL) continue;
    const m = mean(wk), cv = sd(wk) != null ? (sd(wk) / m) * 100 : null;
    // The baseline is the 60 days before this week, so the week is not compared with itself.
    const bl = [];
    for (let k = roll; k < roll + base; k++) { const v = ln.get(addDay(day, -k)); if (v != null) bl.push(v); }
    let b = null, lo = null, hi = null, flag = null;
    if (bl.length >= HRV_MIN_BASE) {
      b = mean(bl);
      const swc = 0.5 * sd(bl);
      lo = b - swc; hi = b + swc;
      flag = m < lo ? 'low' : m > hi ? 'high' : null;
    }
    out.push({ day, ln: ln.get(day) ?? null, roll: m, cv, base: b, lo, hi, flag, n: wk.length });
  }
  return out;
}
// The last 90 days of a trend at a glance.
export function hrvSummary(rows, days = 90) {
  if (!rows.length) return null;
  const last = rows[rows.length - 1], cut = addDay(last.day, -days);
  const recent = rows.filter(r => r.day > cut && r.base != null);
  const cvs = rows.filter(r => r.cv != null).map(r => r.cv);
  return { last, days, judged: recent.length, low: recent.filter(r => r.flag === 'low').length,
    high: recent.filter(r => r.flag === 'high').length, cv_median: median(cvs) };
}

// =====================================================================================
// 3. Running form at matched pace
// =====================================================================================
// Cadence, ground contact and oscillation all change with speed -- faster running is a higher
// cadence and a shorter contact whoever you are -- so a year-on-year comparison of averages
// mostly measures how fast the runs were. Binning by pace (15 s/km bands) and level ground
// takes that out; what is left is the form itself, and how it ages.
export const FORM_VERSION = 1, FORM_BAND_S = 15;
const FORM_LIMITS = { cad: [120, 230], stride: [0.4, 2.6], gct: [120, 420], vo: [2, 16], vr: [2, 16], bal: [40, 60] };
export const FORM_METRICS = [
  ['cad', 'Cadence', 'spm'], ['gct', 'Ground contact time', 'ms'], ['vr', 'Vertical ratio', '%'],
  ['vo', 'Vertical oscillation', 'cm'], ['stride', 'Stride length', 'm'], ['bal', 'GCT balance (left)', '%'],
];
const FORM_KEYS = ['cad', 'gct', 'vo', 'vr', 'stride', 'bal'];

// samples + the raw channels (for vertical ratio and balance, which the 10-wide row lacks)
// -> {band s/km: [seconds, cad, gct, vo, vr, stride, bal]} with nulls for absent metrics.
export function formBands(samples, channels = {}, { bandS = FORM_BAND_S, minS = 30 } = {}) {
  const S = samples || [];
  if (S.length < 30 || !S.some(r => r[6] || r[8] || r[9])) return {};
  const vrC = channels.vertical_ratio_pct || null, balC = channels.gct_balance_left_pct || null;
  const acc = {}, T = S.map(r => r[0]), step = sampleStep(T), half = Math.max(5, step * 1.05), wMax = Math.max(5, 2 * step);
  let j = 0, k = 0;
  for (let i = 0; i < S.length; i++) {
    const t = S[i][0];
    while (j < i && S[j][0] < t - half) j++;
    while (k + 1 < S.length && S[k + 1][0] <= t + half) k++;
    if (k <= j) continue;
    const dt = S[k][0] - S[j][0], dd = S[k][1] - S[j][1];
    if (dt < half || dt > 3 * half || dd <= 0) continue;   // a pause in the window
    const v = dd / dt;
    if (v < 2.2 || v > 6.7) continue;                    // walking, or a GPS jump
    if (S[k][5] != null && S[j][5] != null && Math.abs((S[k][5] - S[j][5]) / dd) > 0.03) continue;
    const w = Math.min(wMax, Math.max(0, (S[i + 1] ? S[i + 1][0] : t + 1) - t));
    if (!w) continue;
    const band = Math.floor(1000 / v / bandS + 1e-6) * bandS;
    const a = acc[band] || (acc[band] = { secs: 0, ...Object.fromEntries(FORM_KEYS.map(m => [m, [0, 0]])) });
    a.secs += w;
    const vals = { cad: S[i][6], stride: S[i][7], gct: S[i][8], vo: S[i][9], vr: vrC ? vrC[i] : null, bal: balC ? balC[i] : null };
    for (const m of FORM_KEYS) {
      const x = vals[m];
      if (x == null || x < FORM_LIMITS[m][0] || x > FORM_LIMITS[m][1]) continue;
      a[m][0] += x * w; a[m][1] += w;
    }
  }
  const out = {};
  for (const [band, a] of Object.entries(acc)) {
    if (a.secs < minS) continue;
    out[band] = [Math.round(a.secs), ...FORM_KEYS.map(m => (a[m][1] >= minS / 2 ? +(a[m][0] / a[m][1]).toFixed(m === 'stride' ? 3 : 2) : null))];
  }
  return out;
}

// rows [{date, b: formBands}] -> {years, bands, series: {metric: {band: [[year, value]]}}, balance}.
// A band is drawn when it has >= minSecs in at least two years (one, if that is all there is); at most maxBands of them, the
// ones he runs most. Balance pools every band (it barely moves with pace) and gets a flag when
// the latest year sits >= 1.5 points off 50/50 or has moved >= 1 point from the first year --
// cut-offs chosen here as "worth a look", not clinical thresholds.
export function formByYear(rows, { minSecs = 300, maxBands = 4 } = {}) {
  const cell = {};   // year -> band -> {secs, m: {metric: [sum, w]}}
  const bal = {};    // year -> [sum, w]
  for (const r of rows || []) {
    const y = r.date.slice(0, 4);
    for (const [band, v] of Object.entries(r.b || {})) {
      const c = ((cell[y] || (cell[y] = {}))[band]) || (cell[y][band] = { secs: 0, m: {} });
      c.secs += v[0];
      FORM_KEYS.forEach((m, i) => {
        const x = v[i + 1];
        if (x == null) return;
        const s = c.m[m] || (c.m[m] = [0, 0]); s[0] += x * v[0]; s[1] += v[0];
        if (m === 'bal') { const b = bal[y] || (bal[y] = [0, 0]); b[0] += x * v[0]; b[1] += v[0]; }
      });
    }
  }
  const years = Object.keys(cell).sort();
  const bandYears = {}, bandSecs = {};
  for (const y of years) for (const [band, c] of Object.entries(cell[y])) {
    bandSecs[band] = (bandSecs[band] || 0) + c.secs;
    if (c.secs >= minSecs) bandYears[band] = (bandYears[band] || 0) + 1;
  }
  const need = Math.min(2, years.length);   // one year of data still shows its bands
  const bands = Object.keys(bandYears).filter(b => bandYears[b] >= need)
    .sort((a, b) => bandSecs[b] - bandSecs[a]).slice(0, maxBands).map(Number).sort((a, b) => a - b);
  const series = {};
  for (const m of FORM_KEYS) {
    if (m === 'bal') continue;
    const per = {};
    for (const band of bands) {
      const pts = years.map(y => { const c = cell[y][band], s = c && c.m[m]; return c && c.secs >= minSecs && s && s[1] >= minSecs / 2 ? [y, s[0] / s[1]] : null; }).filter(Boolean);
      if (pts.length >= need) per[band] = pts;
    }
    if (Object.keys(per).length) series[m] = per;
  }
  const balance = years.filter(y => bal[y] && bal[y][1] >= minSecs).map(y => [y, bal[y][0] / bal[y][1], Math.round(bal[y][1])]);
  let flag = null;
  if (balance.length) {
    const lastB = balance[balance.length - 1][1], firstB = balance[0][1];
    if (Math.abs(lastB - 50) >= 1.5) flag = `${lastB.toFixed(1)}% left in ${balance[balance.length - 1][0]}: ${Math.abs(lastB - 50).toFixed(1)} points off even`;
    else if (balance.length >= 2 && Math.abs(lastB - firstB) >= 1.0) flag = `moved ${Math.abs(lastB - firstB).toFixed(1)} points since ${balance[0][0]}`;
  }
  return { years, bands, series, balance, flag };
}
export const bandLabel = (band, bandS = FORM_BAND_S) => `${fmtMS(band)}–${fmtMS(+band + bandS)}`;
const fmtMS = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// =====================================================================================
// 4. Seasons: the best-effort curve and critical speed, year by year
// =====================================================================================
// prRows [[distance, seconds, day, id]] -> {years, dists, best: {year: {dist: [secs, day, id]}}}
// over the last `years` years that have any effort.
export function seasonCurves(prRows, { years = 8 } = {}) {
  const best = {};
  for (const [d, s, day, id] of prRows || []) {
    if (!s || !day) continue;
    const y = day.slice(0, 4), b = best[y] || (best[y] = {});
    if (!b[d] || s < b[d][0]) b[d] = [s, day, id];
  }
  const ys = Object.keys(best).sort().slice(-years);
  const dists = [...new Set(ys.flatMap(y => Object.keys(best[y]).map(Number)))].sort((a, b) => a - b);
  return { years: ys, dists, best: Object.fromEntries(ys.map(y => [y, best[y]])) };
}
// Critical speed and D' fitted to each year's bests (durability.criticalSpeed: efforts of
// 2-15 minutes, at least three of them). -> [{year, cs, d_prime, points}] for the years it fits.
export function seasonCS(curves) {
  return curves.years.map(y => {
    const pts = Object.entries(curves.best[y]).map(([d, v]) => [+d, v[0]]);
    const fit = criticalSpeed(pts);
    return { year: y, cs: fit ? fit[0] : null, d_prime: fit ? fit[1] : null,
      points: pts.filter(([, s]) => s >= 120 && s <= 900).length };
  });
}

// =====================================================================================
// 5. Race predictor spread
// =====================================================================================
// Daniels & Gilbert (Oxygen Power, 1979): the oxygen cost of running at v metres per minute,
// and the fraction of VO2max sustainable for t minutes. VDOT = cost / fraction.
export function vdot(distanceM, seconds) {
  if (!(distanceM > 0 && seconds > 0)) return null;
  const v = distanceM / (seconds / 60), t = seconds / 60;
  const cost = -4.60 + 0.182258 * v + 0.000104 * v * v;
  const frac = 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t);
  return cost / frac;
}
// The time at distance that a VDOT predicts: VDOT falls as time rises, so bisect.
export function vdotTime(v, distanceM) {
  if (!(v > 0 && distanceM > 0)) return null;
  let lo = distanceM / 12, hi = distanceM / 0.8;   // 12 m/s .. a walk
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (vdot(distanceM, mid) > v) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
// Dave Cameron's formula (distances in miles): an empirical fit to world-class performances,
// so like Riegel it says how times scale between distances, not how fit you are.
const cameronA = miles => 13.49681 - 0.048865 * miles + 2.438936 / miles ** 0.7905;
export function cameron(d1, t1, d2) {
  if (!(d1 > 0 && t1 > 0 && d2 > 0)) return null;
  const m1 = d1 / 1609.344, m2 = d2 / 1609.344;
  return t1 * (d2 / d1) * (cameronA(m1) / cameronA(m2));
}
// Critical speed extrapolated: distance = CS x t + D'. The model is fitted on 2-15 minute
// efforts and is known to be optimistic beyond roughly half an hour to an hour, where the
// runner is no longer near CS; past an hour the figure is shown but marked out of range.
export const csTime = (distanceM, cs, dPrime) => (cs > 0 && distanceM > (dPrime || 0) ? (distanceM - (dPrime || 0)) / cs : null);
export const CS_RANGE_S = 3600;
// Recreational marathoners in Smyth & Muniz-Pumares (MSSE 2020) ran at about 85% of their
// critical speed; used only to say what CS a marathon goal implies.
export const MARATHON_CS_FRACTION = 0.85;

// The reference performance for VDOT and Cameron: the best VDOT among efforts of 1.5 km to the
// marathon in the last `days`. -> {d, t, day, id, vdot} or null.
export function referenceEffort(prRows, today, days = 180) {
  const cut = addDay(today, -days);
  let best = null;
  for (const [d, s, day, id] of prRows || []) {
    if (!day || day < cut || day > today || d < 1500 || d > 42195 || !s) continue;
    const v = vdot(d, s);
    if (v && (!best || v > best.vdot)) best = { d, t: s, day, id, vdot: v };
  }
  return best;
}
// Critical speed from the last `days` of bests (the app-wide one in derive.limits() is all-time).
export function recentCS(prRows, today, days = 365) {
  const cut = addDay(today, -days), best = {};
  for (const [d, s, day] of prRows || []) if (day && day >= cut && day <= today && s && (!best[d] || s < best[d])) best[d] = s;
  const fit = criticalSpeed(Object.entries(best).map(([d, s]) => [+d, s]));
  return fit ? { cs: fit[0], d_prime: fit[1] } : null;
}

// -> [{label, d, riegel, cs, cs_out, vdot, cameron, garmin, lo, hi, spread_pct, n}]
export function predictorSpread({ fit = null, cs = null, ref = null, garmin = null } = {}, races = STANDARD_RACES) {
  return races.map(([label, d]) => {
    const p = {
      riegel: fit ? basePrediction(fit, d) : null,
      cs: cs ? csTime(d, cs.cs, cs.d_prime) : null,
      vdot: ref ? vdotTime(ref.vdot, d) : null,
      cameron: ref ? cameron(ref.d, ref.t, d) : null,
      garmin: garmin && garmin[d] ? +garmin[d] : null,
    };
    // The spread is taken over the models within their range: CS past an hour would widen it
    // with a number nobody should believe.
    const cs_out = p.cs != null && p.cs > CS_RANGE_S;
    const vals = Object.entries(p).filter(([k, v]) => v != null && !(k === 'cs' && cs_out)).map(([, v]) => v);
    const lo = vals.length ? Math.min(...vals) : null, hi = vals.length ? Math.max(...vals) : null;
    return { label, d, ...p, cs_out, lo, hi, n: vals.length, spread_pct: vals.length >= 2 ? ((hi - lo) / median(vals)) * 100 : null };
  });
}
// What each upcoming race's goal asks for, against now.
// -> [{id, name, date, d, goal, req_vdot, cur_vdot, req_cs, cur_cs, cs_how}]
export function goalRequirements(races, today, { ref = null, cs = null } = {}) {
  return (races || []).filter(r => r && r.goal_s && r.distance_m && r.date && String(r.date).slice(0, 10) >= today)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map(r => {
      const d = +r.distance_m, g = +r.goal_s;
      let req_cs = null, cs_how = null;
      if (g <= CS_RANGE_S) { req_cs = (d - (cs ? cs.d_prime : 0)) / g; cs_how = cs ? 'model' : 'model, no D′'; }
      else if (Math.abs(d - 42195) < 1000) { req_cs = d / g / MARATHON_CS_FRACTION; cs_how = 'marathon at ~85% of CS'; }
      return { id: r.id, name: r.name, date: String(r.date).slice(0, 10), d, goal: g, req_vdot: vdot(d, g),
        cur_vdot: ref ? ref.vdot : null, req_cs, cur_cs: cs ? cs.cs : null, cs_how };
    });
}

// =====================================================================================
// 6. Climbs
// =====================================================================================
// A climb is a stretch of road that keeps going up: >= 300 m long at >= 3% on average, with
// short dips inside it forgiven (a 5 m drop on the way up a hill does not make two hills).
// Found on the elevation profile smoothed over 100 m, because raw GPS or barometric altitude
// turns a flat road into a saw-tooth of fake 5% ramps.
//
// Categories: the length x grade score (metres x percent) that cycling apps such as Strava use:
// Cat 4 >= 8000, Cat 3 >= 16000, Cat 2 >= 32000, Cat 1 >= 64000, HC >= 80000. Most running
// climbs are uncategorised by it, honestly so. FIETS (Fiets magazine): H^2 / (10 L) plus
// (top - 1000) / 1000 above 1000 m; there is no official category table for it.
export const CLIMB_VERSION = 1, CLIMB_MIN_M = 300, CLIMB_MIN_GRADE = 0.03, CLIMB_STEP_M = 10;
export const CATEGORIES = [[80000, 'HC'], [64000, 'Cat 1'], [32000, 'Cat 2'], [16000, 'Cat 3'], [8000, 'Cat 4']];
export const category = (lenM, gradePct) => (CATEGORIES.find(([s]) => lenM * gradePct >= s) || [0, null])[1];
export const fiets = (gainM, lenM, topM = 0) => (lenM > 0 ? (gainM * gainM) / (lenM * 10) + Math.max(0, (topM - 1000) / 1000) : null);

// samples -> a 10 m grid: [{d, e (smoothed), t, lat, lon, hr}], or [] without elevation.
export function profile(samples, step = CLIMB_STEP_M) {
  const S = (samples || []).filter(r => r[1] != null && r[5] != null && r[0] != null);
  if (S.length < 20) return [];
  const raw = [];
  let i = 0;
  const d0 = S[0][1], d1 = S[S.length - 1][1];
  for (let d = d0; d <= d1; d += step) {
    while (i + 1 < S.length && S[i + 1][1] < d) i++;
    const a = S[i], b = S[Math.min(i + 1, S.length - 1)];
    const f = b[1] > a[1] ? Math.min(1, Math.max(0, (d - a[1]) / (b[1] - a[1]))) : 0;
    raw.push({ d: d - d0, e: a[5] + f * (b[5] - a[5]), t: a[0] + f * (b[0] - a[0]),
      lat: a[3], lon: a[4], hr: a[2] && b[2] ? a[2] + f * (b[2] - a[2]) : a[2] || null });
  }
  const half = Math.round(50 / step), out = [];
  let sum = 0, lo = 0, hi = -1;
  for (let k = 0; k < raw.length; k++) {
    while (hi < Math.min(raw.length - 1, k + half)) sum += raw[++hi].e;
    while (lo < k - half) sum -= raw[lo++].e;
    out.push({ ...raw[k], e: sum / (hi - lo + 1) });
  }
  return out;
}

// profile -> [{i0, i1}] climbs (grid indices).
// Stretches where the smoothed road rises at >= 1.5% are the raw material; neighbouring ones
// are joined across a gap (a dip, a flatter bit) of up to 300 m when the height lost in it is
// small against the climb so far -- max(10 m, a quarter of the gain) -- and the joined whole
// still averages the minimum grade. A long flat between two hills keeps them two hills.
export function findClimbs(prof, { minLen = CLIMB_MIN_M, minGrade = CLIMB_MIN_GRADE, rising = 0.015, gapM = 300 } = {}) {
  if (prof.length < 3) return [];
  const runs = [];
  let s0 = null;
  for (let k = 0; k + 1 < prof.length; k++) {
    const up = (prof[k + 1].e - prof[k].e) / ((prof[k + 1].d - prof[k].d) || 1) >= rising;
    if (up && s0 === null) s0 = k;
    if (!up && s0 !== null) { runs.push([s0, k]); s0 = null; }
  }
  if (s0 !== null) runs.push([s0, prof.length - 1]);
  const E = k => prof[k].e, gradeOf = (a, b) => (E(b) - E(a)) / Math.max(1, prof[b].d - prof[a].d);
  const merged = [];
  for (const r of runs) {
    const cur = merged[merged.length - 1];
    if (cur && prof[r[0]].d - prof[cur[1]].d <= gapM) {
      let low = Infinity;
      for (let k = cur[1]; k <= r[0]; k++) low = Math.min(low, E(k));
      const lost = E(cur[1]) - low, gain = E(cur[1]) - E(cur[0]);
      if (lost <= Math.max(10, 0.25 * gain) && E(r[1]) > E(cur[1]) && gradeOf(cur[0], r[1]) >= minGrade) { cur[1] = r[1]; continue; }
    }
    merged.push([...r]);
  }
  return merged.filter(([a, b]) => prof[b].d - prof[a].d >= minLen && gradeOf(a, b) >= minGrade).map(([i0, i1]) => ({ i0, i1 }));
}

// samples -> {c: [[lat0, lon0, lat1, lon1, len, gain, grade%, maxGrade%, secs, top, km into the run]], g: [up, down] | null}
// The compact per-activity record the page caches.
export function climbsOf(samples) {
  const prof = profile(samples);
  if (!prof.length) return { c: [], g: null };
  const c = [];
  for (const { i0, i1 } of findClimbs(prof)) {
    const a = prof[i0], b = prof[i1], len = b.d - a.d, gain = b.e - a.e;
    let maxG = 0;
    for (let k = i0; k + 10 <= i1; k++) maxG = Math.max(maxG, (prof[k + 10].e - prof[k].e) / (prof[k + 10].d - prof[k].d));
    const secs = b.t - a.t;
    c.push([a.lat != null ? +a.lat.toFixed(5) : null, a.lon != null ? +a.lon.toFixed(5) : null,
      b.lat != null ? +b.lat.toFixed(5) : null, b.lon != null ? +b.lon.toFixed(5) : null,
      Math.round(len), r1(gain), r1((gain / len) * 100), r1(maxG * 100), secs > 0 ? Math.round(secs) : null, Math.round(b.e), +(a.d / 1000).toFixed(2)]);
  }
  return { c, g: gradeEfficiency(prof) };
}
// Uphill and downhill against the flat, in grade-adjusted speed per heartbeat: Minetti's cost
// model (racecraft.costRatio) says what each gradient should cost; a ratio over 1 means you
// make more of hills than the model expects, relative to your heart rate. HR lags the ground by
// 20-30 s, which flatters short climbs and penalises the descent after them -- read it as a
// trend over many runs, never one. -> [up, down] or null under 2 minutes in any band.
export function gradeEfficiency(prof) {
  const bins = { up: [0, 0], flat: [0, 0], down: [0, 0] }, secs = { up: 0, flat: 0, down: 0 };
  for (let k = 5; k + 5 < prof.length; k += 5) {
    const a = prof[k - 5], b = prof[k + 5], dt = b.t - a.t, dd = b.d - a.d;
    if (!(dt > 0) || dt > 60 || !b.hr || b.hr < 90) continue;
    const v = dd / dt;
    if (v < 1.5 || v > 7) continue;
    const g = (b.e - a.e) / dd, bin = g > 0.03 ? 'up' : g < -0.03 ? 'down' : Math.abs(g) < 0.01 ? 'flat' : null;
    if (!bin) continue;
    bins[bin][0] += (v * costRatio(g) * 60 / b.hr) * dt; bins[bin][1] += dt; secs[bin] += dt;
  }
  if (secs.up < 120 || secs.flat < 120 || secs.down < 120) return null;
  const ef = k => bins[k][0] / bins[k][1];
  return [+(ef('up') / ef('flat')).toFixed(3), +(ef('down') / ef('flat')).toFixed(3)];
}

// rows [{id, date, c}] -> clusters of the same climb run again: start within 50 m, top within
// 100 m (so the same hill the other way is a different climb), length within 30%.
// -> [{key, n, len, gain, grade, max_grade, cat, fiets, top, lat, lon, efforts: [{id, date, secs, vam}], best, by_year}]
export function climbCatalogue(rows, { startM = 50, endM = 100 } = {}) {
  const clusters = [], grid = new Map();
  const cellOf = (lat, lon) => `${Math.floor(lat * 500)}:${Math.floor(lon * 500)}`;   // ~200 m cells
  const sorted = [...(rows || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const r of sorted) for (const x of r.c || []) {
    const [la0, lo0, la1, lo1, len, gain, grade, maxG, secs, top, km] = x;
    if (la0 == null || lo0 == null) continue;
    let hit = null;
    const ci = Math.floor(la0 * 500), cj = Math.floor(lo0 * 500);
    for (let di = -1; di <= 1 && !hit; di++) for (let dj = -1; dj <= 1 && !hit; dj++) {
      for (const cl of grid.get(`${ci + di}:${cj + dj}`) || []) {
        if (haversine([la0, lo0], [cl.lat, cl.lon]) <= startM && (la1 == null || cl.lat1 == null || haversine([la1, lo1], [cl.lat1, cl.lon1]) <= endM)
          && Math.abs(len - cl.len0) <= 0.3 * cl.len0) { hit = cl; break; }
      }
    }
    if (!hit) {
      hit = { lat: la0, lon: lo0, lat1: la1, lon1: lo1, len0: len, raw: [] };
      clusters.push(hit);
      const k = cellOf(la0, lo0);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(hit);
    }
    hit.raw.push({ id: r.id, date: r.date, km: km ?? null, len, gain, grade, maxG, secs, top, vam: secs ? Math.round(gain / secs * 3600) : null });
  }
  return clusters.map((cl, i) => {
    const len = median(cl.raw.map(e => e.len)), gain = median(cl.raw.map(e => e.gain)), grade = (gain / len) * 100;
    const timed = cl.raw.filter(e => e.secs);
    const best = timed.length ? timed.reduce((a, b) => (b.secs < a.secs ? b : a)) : null;
    const byYear = {};
    for (const e of timed) { const y = e.date.slice(0, 4); if (!byYear[y] || e.secs < byYear[y].secs) byYear[y] = e; }
    return { key: 'c' + i, n: cl.raw.length, len, gain, grade, max_grade: median(cl.raw.map(e => e.maxG)), top: median(cl.raw.map(e => e.top)),
      cat: category(len, grade), fiets: fiets(gain, len, median(cl.raw.map(e => e.top))), lat: cl.lat, lon: cl.lon,
      efforts: cl.raw, best, by_year: Object.keys(byYear).sort().map(y => [y, byYear[y].secs, byYear[y].id]) };
  });
}
// Uphill/downhill efficiency per year: rows [{date, g: [up, down]}] -> [{year, n, up, down}].
export function gradeEfficiencyByYear(rows) {
  const ys = {};
  for (const r of rows || []) if (r.g) (ys[r.date.slice(0, 4)] || (ys[r.date.slice(0, 4)] = [])).push(r.g);
  return Object.keys(ys).sort().map(y => ({ year: y, n: ys[y].length, up: median(ys[y].map(g => g[0])), down: median(ys[y].map(g => g[1])) }));
}

// =====================================================================================
// 7. Time of day and weekday
// =====================================================================================
// rows [{start: 'YYYY-MM-DDTHH:MM...' local, pace s/km, hr, temp_c, humidity, dew_point_c, steady}]
// -> {grid[7][24] counts (Monday first), hours: [...], weekdays: [...]} where hours/weekdays
// carry n, median heat-corrected pace and its interval, and median HR -- over steady runs only:
// intervals and races are run at set times of the week and would otherwise be the whole effect.
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function timeOfDay(rows, { minN = 5 } = {}) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const byH = Array.from({ length: 24 }, () => []), byW = Array.from({ length: 7 }, () => []);
  for (const r of rows || []) {
    const s = String(r.start || '');
    if (!/^\d{4}-\d\d-\d\dT\d\d/.test(s)) continue;
    const h = +s.slice(11, 13), wd = (new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))).getUTCDay() + 6) % 7;
    grid[wd][h]++;
    if (!r.steady || !r.pace) continue;
    const p = { pace: heatAdjust(r.pace, r.temp_c ?? null, r.humidity ?? null, r.dew_point_c ?? null), hr: r.hr || null };
    byH[h].push(p); byW[wd].push(p);
  }
  const sum = (g, label) => {
    const paces = g.map(p => p.pace), hrs = g.map(p => p.hr).filter(Boolean);
    return { label, n: g.length, pace: g.length >= minN ? median(paces) : null, pace_ci: g.length >= minN ? medianCI(paces) : null,
      hr: hrs.length >= minN ? median(hrs) : null };
  };
  return { grid, total: grid.flat().reduce((a, b) => a + b, 0),
    hours: byH.map((g, h) => sum(g, String(h).padStart(2, '0') + ':00')), weekdays: byW.map((g, w) => sum(g, WEEKDAYS[w])) };
}

// Sleep timing. The Garmin data this app keeps holds sleep *amounts* (stages, score, hours) and
// no clock times, so this looks for any timing field and says plainly when there is none.
// Accepted when present: daily[day].sleep_start / sleep_end as local 'YYYY-MM-DDTHH:MM' or 'HH:MM'.
// -> {present: false, fields} or {present: true, n, bed, wake, bed_sd, wake_sd, mid_weekday, mid_weekend, jetlag}
// (times in minutes after midnight; bedtime unwrapped around midnight so 23:30 and 00:30 are an hour apart).
const TIMING_RX = /sleep_?start|sleep_?end|bed_?time|wake|sleep_?onset/i;
const minuteOf = v => {
  const m = String(v || '').match(/(\d\d):(\d\d)/);
  return m ? +m[1] * 60 + +m[2] : null;
};
export function sleepTiming(daily) {
  const fields = new Set(), timing = new Set();
  for (const r of Object.values(daily || {})) for (const k of Object.keys(r || {})) {
    if (/sleep|deep|rem|light|awake|restless/i.test(k)) fields.add(k);
    if (TIMING_RX.test(k) && r[k] != null) timing.add(k);
  }
  if (!timing.has('sleep_start') || !timing.has('sleep_end')) return { present: false, fields: [...fields].sort(), timing: [...timing].sort() };
  const nights = [];
  for (const [day, r] of Object.entries(daily)) {
    let b = minuteOf(r.sleep_start), w = minuteOf(r.sleep_end);
    if (b == null || w == null) continue;
    if (b < 12 * 60) b += 24 * 60;              // after midnight: same night, later
    let mid = (b + (w + 24 * 60 < b ? w + 48 * 60 : w + 24 * 60)) / 2;
    if (mid >= 24 * 60) mid -= 24 * 60;
    const wd = (new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10))).getUTCDay() + 6) % 7;
    nights.push({ b, w, mid, weekend: wd >= 5 });
  }
  if (nights.length < 7) return { present: true, n: nights.length };
  const mw = median(nights.filter(n => !n.weekend).map(n => n.mid)), me = median(nights.filter(n => n.weekend).map(n => n.mid));
  return { present: true, n: nights.length, bed: median(nights.map(n => n.b)) % (24 * 60), wake: median(nights.map(n => n.w)),
    bed_sd: sd(nights.map(n => n.b)), wake_sd: sd(nights.map(n => n.w)), mid_weekday: mw, mid_weekend: me,
    jetlag: mw != null && me != null ? me - mw : null };
}

// =====================================================================================
// The stream pass
// =====================================================================================
// Reads each activity's stream at most once and caches what the three stream-based analyses
// found, compactly, under 'hrr-<id>', 'form-<id>' and 'climbs-<id>'. Records carry a version so
// a change to the method re-reads only what it must. One stream in memory at a time.
//
// items [{id, date, virtual, hasSession}]; io {getCache(k), setCache(k, v), getStream(id),
// samples(rec) -> [samples, channels], getReps(id) -> reps|null, yield?(), stop?() -> true to abandon}.
// -> {hrr: [{id, date, e}], form: [{id, date, b}], climbs: [{id, date, c, g}], read, cached}
export async function scanActivities(items, io, onProgress) {
  const out = { hrr: [], form: [], climbs: [], read: 0, cached: 0 };
  let k = 0;
  for (const it of items || []) {
    if (io.stop && io.stop()) break;
    k++;
    const keys = ['hrr-' + it.id, 'form-' + it.id, 'climbs-' + it.id];
    let [h, f, c] = await Promise.all(keys.map(x => Promise.resolve(io.getCache(x)).catch(() => null)));
    const fresh = [h && h.v === HRR_VERSION, f && f.v === FORM_VERSION, c && c.v === CLIMB_VERSION];
    if (fresh.every(Boolean)) out.cached++;
    else {
      const rec = await Promise.resolve(io.getStream(it.id)).catch(() => null);
      if (rec) {
        out.read++;
        const [samples, ch] = io.samples(rec);
        if (!fresh[0]) {
          const reps = it.hasSession && io.getReps ? await Promise.resolve(io.getReps(it.id)).catch(() => null) : null;
          h = { v: HRR_VERSION, e: hrRecovery(samples, reps) };
          await io.setCache(keys[0], h);
        }
        if (!fresh[1]) { f = { v: FORM_VERSION, b: it.virtual ? {} : formBands(samples, ch || {}) }; await io.setCache(keys[1], f); }
        if (!fresh[2]) { c = { v: CLIMB_VERSION, ...(it.virtual ? { c: [], g: null } : climbsOf(samples)) }; await io.setCache(keys[2], c); }
      }
    }
    if (h && h.e && h.e.length) out.hrr.push({ id: it.id, date: it.date, e: h.e });
    if (f && f.b && Object.keys(f.b).length) out.form.push({ id: it.id, date: it.date, b: f.b });
    if (c && (c.c?.length || c.g)) out.climbs.push({ id: it.id, date: it.date, c: c.c || [], g: c.g || null });
    if (onProgress) onProgress(k, items.length);
    if (io.yield && k % 5 === 0) await io.yield();
  }
  return out;
}
