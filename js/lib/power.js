// Cycling power: what the power meter (or Zwift's trainer) measured, which nothing read before.
//
// Everything here works on a 1-second series built from the stream's `seconds` and `power_w`
// channels (index-aligned, as ingest.js stores them). The resampling rule, because every number
// downstream depends on it:
//   * a gap of up to 5 s between samples is a dropout (smart recording, a lost ANT+ packet):
//     the seconds in between hold the previous value;
//   * a gap of 5 s to 5 min is time on the bike not pedalling (coasting, a red light with the
//     recording running): those seconds are zeros, as Coggan's NP and every head unit count them;
//   * a gap over 5 min is a pause (auto-pause, a cafe stop): it is cut out, not zero-filled, so
//     a lunch stop does not drag NP and average power down. The series is the moving part only.
// Missing or absurd (> 3000 W) readings count as 0 W.
//
// Per ride: mean-maximal power (MMP) at standard durations, NP (30 s rolling mean, 4th-power
// mean, 4th root -- Coggan), VI = NP/avg, work in kJ, Pw:HR decoupling (first vs second half,
// the way aerobic decoupling compares pace:HR). Across rides: the best-of envelope of MMP over a
// window, critical power and W' from its 3-20 min points (linear work-time model, W = CP*t + W'),
// eFTP, and W' balance through one ride (Skiba's differential form).
import { dayKey, addDayKey } from './dt.js';

// 1, 5, 10, 15, 30 s; 1, 2, 3, 5, 8, 10, 15, 20, 30, 45, 60, 90, 120 min.
export const DURATIONS = [1, 5, 10, 15, 30, 60, 120, 180, 300, 480, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200];
export const HOLD_S = 5, PAUSE_S = 300, MAX_W = 3000;
// CP is fitted from efforts between 3 and 20 minutes: shorter ones are dominated by W' and
// neuromuscular power, longer ones by fatigue the two-parameter model does not have.
export const CP_MIN_S = 180, CP_MAX_S = 1200, CP_MIN_POINTS = 3;
export const WINDOW_DAYS = 90;
export const RIDE_TYPES = new Set(['cycling', 'road_biking', 'indoor_cycling', 'mountain_biking',
  'gravel_cycling', 'virtual_ride', 'commuting']);
export const isRide = a => !!a && RIDE_TYPES.has(a.type);

const clean = v => (v == null || !(v >= 0) || v > MAX_W ? 0 : +v);

// channels -> {p: watts per moving second, hr: bpm per second (null where unknown)}.
export function resample(seconds, watts, hr = null) {
  const p = [], h = [];
  if (!seconds || !watts) return { p, hr: h };
  let prevT = null, prevP = 0, prevH = null;
  for (let i = 0; i < seconds.length; i++) {
    const t = seconds[i];
    if (t == null || !isFinite(t)) continue;
    const w = clean(watts[i]), b = hr && hr[i] > 0 ? +hr[i] : null;
    if (prevT != null) {
      const dt = Math.round(t - prevT);
      if (dt <= 0) continue;                       // duplicate or out-of-order timestamp
      if (dt <= HOLD_S) for (let k = 1; k < dt; k++) { p.push(prevP); h.push(prevH); }
      else if (dt <= PAUSE_S) for (let k = 1; k < dt; k++) { p.push(0); h.push(null); }
      // dt > PAUSE_S: a pause, cut out
    }
    p.push(w); h.push(b);
    prevT = t; prevP = w; prevH = b;
  }
  return { p, hr: h };
}

const prefix = p => { const c = new Float64Array(p.length + 1); for (let i = 0; i < p.length; i++) c[i + 1] = c[i] + p[i]; return c; };

// Mean-maximal power: {seconds: watts} for every standard duration the ride is long enough for.
export function mmp(p, durations = DURATIONS) {
  const out = {}, c = prefix(p), n = p.length;
  for (const d of durations) {
    if (d > n) break;
    let best = 0;
    for (let i = d; i <= n; i++) { const s = c[i] - c[i - d]; if (s > best) best = s; }
    out[d] = Math.round(best / d);
  }
  return out;
}

// Normalized power (Coggan): 30 s rolling mean, raised to the 4th, averaged, 4th root.
export function normalizedPower(p) {
  if (p.length < 30) return null;
  const c = prefix(p);
  let s = 0, n = 0;
  for (let i = 30; i <= p.length; i++) { s += ((c[i] - c[i - 30]) / 30) ** 4; n++; }
  return Math.pow(s / n, 0.25);
}

// Pw:HR decoupling, %: how much less power each heartbeat bought in the second half than in
// the first. Under 5% is the usual "aerobically fit for this duration" line. Needs 20 minutes
// and heart rate on at least 80% of the moving seconds; null otherwise.
export function decoupling(p, hr) {
  const n = p.length;
  if (n < 1200 || !hr) return null;
  if (hr.filter(Boolean).length < 0.8 * n) return null;
  const half = (a, b) => {
    let sp = 0, sh = 0, k = 0;
    for (let i = a; i < b; i++) if (hr[i]) { sp += p[i]; sh += hr[i]; k++; }
    return k && sh ? (sp / k) / (sh / k) : null;
  };
  const r1 = half(0, n >> 1), r2 = half(n >> 1, n);
  if (!r1 || r2 == null) return null;
  return (r1 - r2) / r1 * 100;
}

const r1 = v => (v == null || !isFinite(v) ? null : Math.round(v * 10) / 10);

// One ride's stream channels -> the small summary derive.js keeps in state.derived[id].power:
// {s, np, avg, max, vi, kj, decoupling, mmp}. s = moving seconds of the power series (TSS needs
// it). null when the stream has no power, or under a minute of it.
export function summarise(ch) {
  if (!ch || !ch.seconds || !ch.power_w) return null;
  const { p, hr } = resample(ch.seconds, ch.power_w, ch.hr);
  if (p.length < 60 || !p.some(w => w > 0)) return null;
  let sum = 0, max = 0;
  for (const w of p) { sum += w; if (w > max) max = w; }
  const avg = sum / p.length, np = normalizedPower(p);
  return {
    s: p.length, np: Math.round(np), avg: Math.round(avg), max: Math.round(max),
    vi: avg > 0 ? Math.round(np / avg * 100) / 100 : null, kj: Math.round(sum / 1000),
    decoupling: r1(decoupling(p, hr)), mmp: mmp(p),
  };
}

// Intensity factor and TSS from a summary and an FTP. TSS = hours * IF^2 * 100 (Coggan), so an
// hour at FTP scores 100, the same scale fitness.activityLoad uses.
export const intensityFactor = (sm, ftp) => (sm && sm.np && ftp > 0 ? sm.np / ftp : null);
export function powerTss(sm, ftp) {
  const f = intensityFactor(sm, ftp);
  return f == null || !sm.s ? null : Math.round(sm.s / 3600 * f * f * 1000) / 10;
}

// Best-of envelope over rides: entries [{id, date, mmp}] -> {seconds: {w, id, date}}.
export function envelope(entries) {
  const env = {};
  for (const e of entries) for (const [d, w] of Object.entries(e.mmp || {}))
    if (!env[d] || w > env[d].w) env[d] = { w, id: e.id, date: e.date };
  return env;
}

// Critical power and W' from an envelope's 3-20 minute points: least squares on work against
// time, W = CP*t + W'. R^2 on work is always ~1 (work grows with t whatever happens), so the fit
// quality reported is the standard error of CP and W' and the worst miss of the implied power
// curve P(t) = CP + W'/t against the points. Refused (ok: false, with a reason) from fewer than 3
// points, or when it implies a non-positive CP or W'.
export function fitCP(env) {
  const pts = DURATIONS.filter(d => d >= CP_MIN_S && d <= CP_MAX_S && env[d] && env[d].w > 0)
    .map(d => ({ t: d, w: env[d].w, id: env[d].id, date: env[d].date }));
  const n = pts.length;
  if (n < CP_MIN_POINTS) return { ok: false, n, points: pts, reason: `needs best efforts at ${CP_MIN_POINTS} or more of 3, 5, 8, 10, 15 and 20 min; has ${n}` };
  const xs = pts.map(q => q.t), ys = pts.map(q => q.w * q.t);
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2; }
  const cp = sxy / sxx, wPrime = my - cp * mx;
  let sse = 0; for (let i = 0; i < n; i++) sse += (ys[i] - wPrime - cp * xs[i]) ** 2;
  const s2 = n > 2 ? sse / (n - 2) : 0;
  const seCp = Math.sqrt(s2 / sxx), seW = Math.sqrt(s2 * (1 / n + mx * mx / sxx));
  const r2 = syy ? 1 - sse / syy : 1;
  const maxErrPct = Math.max(...pts.map(q => Math.abs(cp + wPrime / q.t - q.w) / q.w * 100));
  const base = { n, points: pts, cp: Math.round(cp), wPrime: Math.round(wPrime), seCp: r1(seCp), seW: Math.round(seW), r2, maxErrPct: r1(maxErrPct) };
  if (!(cp > 0) || !(wPrime > 0)) return { ...base, ok: false, reason: 'the points imply a non-positive CP or W\' (the efforts are not all-out)' };
  return { ...base, ok: true };
}

// eFTP: CP when the fit holds, else 95% of the best 20 minutes; both reported so they can be
// compared (CP from 3-20 min efforts tends to sit a few % above an hour's power).
export function eftp(env, fit = fitCP(env)) {
  const p20 = env[1200] ? env[1200].w : null, check = p20 ? Math.round(0.95 * p20) : null;
  const value = fit.ok ? fit.cp : check;
  return { value, source: fit.ok ? 'cp' : check ? '20min' : null, p20, check,
    diffPct: fit.ok && check ? r1((fit.cp - check) / check * 100) : null };
}

// The fit as of a day, over the WINDOW_DAYS before it (inclusive): entries [{id, date, mmp}],
// date a day key. -> {env, fit, eftp, rides: [ids that set a point], n: rides in the window}.
export function windowFit(entries, end, days = WINDOW_DAYS) {
  const start = addDayKey(end, -(days - 1));
  const inWin = entries.filter(e => e.date >= start && e.date <= end);
  const env = envelope(inWin), fit = fitCP(env);
  const rides = [...new Set(Object.values(env).map(v => v.id))];
  return { start, end, env, fit, eftp: eftp(env, fit), rides, n: inWin.length };
}

// Rolling fits at each month end that had rides in its window: [{date, cp, wPrime, eftp, n}].
export function rollingFits(entries, days = WINDOW_DAYS) {
  if (!entries.length) return [];
  const dates = entries.map(e => e.date).sort();
  const out = [];
  let [y, m] = dates[0].slice(0, 7).split('-').map(Number);
  const last = dates[dates.length - 1];
  for (;;) {
    const monthEnd = dayKey(new Date(y, m, 0, 12));        // day 0 of next month = last of this one
    const end = monthEnd > last ? last : monthEnd;
    const f = windowFit(entries, end, days);
    if (f.n) out.push({ date: end, cp: f.fit.ok ? f.fit.cp : null, wPrime: f.fit.ok ? f.fit.wPrime : null, eftp: f.eftp.value, n: f.n });
    if (end >= last) break;
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

// The FTP each ride is scored against: the eFTP of the WINDOW_DAYS up to and including its day.
// A window with no usable effort carries the last known eFTP forward (up to a year), so one
// quiet month does not drop the rides back to heart-rate load. -> {id: ftp}.
export function ftpByRide(entries, days = WINDOW_DAYS) {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const out = {}, cache = new Map();
  let lastFtp = null, lastDate = null;
  for (const e of sorted) {
    if (!cache.has(e.date)) cache.set(e.date, windowFit(sorted, e.date, days).eftp.value);
    let f = cache.get(e.date);
    if (f) { lastFtp = f; lastDate = e.date; }
    else if (lastFtp && lastDate >= addDayKey(e.date, -365)) f = lastFtp;
    if (f) out[e.id] = f;
  }
  return out;
}

// {id: power TSS} for every ride entry [{id, date, power}] (power = the summarise() result).
export function powerTssById(entries, days = WINDOW_DAYS) {
  const ftp = ftpByRide(entries.map(e => ({ id: e.id, date: e.date, mmp: e.power.mmp })), days), out = {};
  for (const e of entries) { const t = powerTss(e.power, ftp[e.id]); if (t != null) out[e.id] = t; }
  return out;
}

// W' balance through a ride, in joules, per moving second. Skiba's differential form (Skiba,
// Fulford, Clarke & Skiba 2015; the integral form is Skiba 2012): above CP W' drains by
// (P - CP) each second; below it, it refills in proportion to how empty it is,
// (CP - P) * (W' - bal) / W'. -> {bal: [J], min, minAt: seconds} or null.
export function wPrimeBalance(ch, cp, wPrime) {
  if (!ch || !(cp > 0) || !(wPrime > 0)) return null;
  const { p } = resample(ch.seconds, ch.power_w);
  if (!p.length) return null;
  const bal = new Array(p.length);
  let w = wPrime, min = wPrime, minAt = 0;
  for (let i = 0; i < p.length; i++) {
    if (p[i] > cp) w -= p[i] - cp;
    else w += (cp - p[i]) * (wPrime - w) / wPrime;
    bal[i] = w;
    if (w < min) { min = w; minAt = i; }
  }
  return { bal, min, minAt };
}
