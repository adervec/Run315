// DFA alpha1 from beat-to-beat (RR) intervals, and the aerobic threshold it points to.
//
// Detrended fluctuation analysis asks how the wobble in heart-beat timing scales with the
// number of beats you look at. Over short scales (4–16 beats) at rest and easy running the
// pattern is fractal-like (alpha1 ≈ 1); as intensity climbs it falls through ≈ 0.75 near the
// first ventilatory/aerobic threshold (Rogers, Giles, Draper, Hoos & Gronwald 2021) towards
// ≈ 0.5 (uncorrelated) above it. Reference values: white noise 0.5, 1/f noise 1.0,
// Brownian motion 1.5.
//
// The method here follows Rogers & Gronwald: artefacts corrected; alpha1 from scales 4–16
// beats; 2-minute windows recomputed every 5 seconds; then a linear regression of alpha1 on
// heart rate across a ramping run, and the HR where the line crosses 0.75.
//
// Artefacts matter more than anything else: a few percent of missed or doubled beats push
// alpha1 down and fake a threshold. Windows with more than MAX_ARTEFACT corrected beats are
// dropped, and a chest strap is all but required (optical sensors do not log RR).

export const RR_MIN = 300, RR_MAX = 2000;   // ms; 200 bpm and 30 bpm
export const LOCAL_PCT = 0.20;              // > 20% from the local median is an artefact
export const LOCAL_HALF = 5;                // ... median of the 11 beats around it
export const SCALE_MIN = 4, SCALE_MAX = 16;
export const WINDOW_S = 120, STEP_S = 5;
export const MIN_BEATS = 60;                // a 2-minute window below 30 bpm is not a run
export const MAX_ARTEFACT = 0.05;           // a window with more corrected beats is skipped
export const HRVT1 = 0.75;

const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// rr (ms) -> { rr: corrected ms, t: beat times (s, from the first beat's end), bad: [bool],
//              artefacts, fraction }.
//
// Beat times come from the raw intervals, so the series stays on the watch's clock even where
// a beat was replaced. Flagged beats are replaced by linear interpolation between the nearest
// good neighbours (the ends take the nearest good value).
export function cleanRR(rr, { lo = RR_MIN, hi = RR_MAX, pct = LOCAL_PCT, half = LOCAL_HALF } = {}) {
  const raw = (rr || []).map(Number).filter(x => isFinite(x) && x > 0);
  const n = raw.length, t = new Array(n), bad = new Array(n).fill(false);
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += raw[i]; t[i] = acc / 1000; }
  for (let i = 0; i < n; i++) if (raw[i] < lo || raw[i] > hi) bad[i] = true;
  for (let i = 0; i < n; i++) {
    if (bad[i]) continue;
    const nb = [];
    for (let k = Math.max(0, i - half); k <= Math.min(n - 1, i + half); k++) if (!bad[k]) nb.push(raw[k]);
    const m = median(nb);
    if (Math.abs(raw[i] - m) > pct * m) bad[i] = true;
  }
  const out = raw.slice();
  let prev = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && bad[i]) continue;
    // good beat at i (or the end); fill prev+1 .. i-1
    for (let k = prev + 1; k < i; k++) {
      const a = prev >= 0 ? raw[prev] : null, b = i < n ? raw[i] : null;
      out[k] = a != null && b != null ? a + (b - a) * (k - prev) / (i - prev) : (a ?? b ?? out[k]);
    }
    prev = i;
  }
  const artefacts = bad.filter(Boolean).length;
  return { rr: out, t, bad, artefacts, fraction: n ? artefacts / n : 0 };
}

// DFA-1 scaling exponent of x over box sizes nMin..nMax. -> number|null.
//
// Profile y = cumsum(x − mean). For each box size n, non-overlapping boxes from the start; a
// least-squares line removed from each; F(n) = RMS of what is left. alpha = slope of
// log F(n) on log n.
export function alpha(x, nMin = SCALE_MIN, nMax = SCALE_MAX) {
  const N = x.length;
  if (N < nMax * 2) return null;
  let mean = 0;
  for (const v of x) mean += v;
  mean /= N;
  const y = new Float64Array(N);
  let acc = 0;
  for (let i = 0; i < N; i++) { acc += x[i] - mean; y[i] = acc; }
  const lx = [], ly = [];
  for (let n = nMin; n <= nMax; n++) {
    const boxes = Math.floor(N / n);
    // x positions 0..n-1: sums are fixed per n
    const sx = n * (n - 1) / 2, sxx = (n - 1) * n * (2 * n - 1) / 6, den = n * sxx - sx * sx;
    let ss = 0;
    for (let b = 0; b < boxes; b++) {
      const o = b * n;
      let sy = 0, sxy = 0;
      for (let k = 0; k < n; k++) { sy += y[o + k]; sxy += k * y[o + k]; }
      const slope = (n * sxy - sx * sy) / den, icpt = (sy - slope * sx) / n;
      for (let k = 0; k < n; k++) { const r = y[o + k] - (icpt + slope * k); ss += r * r; }
    }
    const F = Math.sqrt(ss / (boxes * n));
    if (!(F > 0)) return null;
    lx.push(Math.log(n)); ly.push(Math.log(F));
  }
  return fit(lx, ly).slope;
}

// Least squares y = a + b x. -> { slope, intercept, r2, n }.
export function fit(xs, ys) {
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; syy += ys[i] * ys[i]; }
  const vx = n * sxx - sx * sx, vy = n * syy - sy * sy, cxy = n * sxy - sx * sy;
  const slope = vx ? cxy / vx : 0, intercept = (sy - slope * sx) / (n || 1);
  const r2 = vx && vy ? (cxy * cxy) / (vx * vy) : 0;
  return { slope, intercept, r2, n };
}

// rr (ms) -> [{ t, a1, hr, artefact }]: one row per 2-minute window, every 5 s.
// `t` is the window's centre in seconds on the run's clock (offset added: the first beat's
// start is assumed to coincide with the recording's first second, which is how FIT hrv
// messages are written); `hr` is the window's mean heart rate from its own beats.
export function series(rr, { windowS = WINDOW_S, stepS = STEP_S, offset = 0, maxArtefact = MAX_ARTEFACT } = {}) {
  const c = cleanRR(rr);
  const n = c.rr.length, out = [];
  if (!n) return out;
  const end = c.t[n - 1];
  let lo = 0, hi = 0;
  for (let we = windowS; we <= end + 1e-9; we += stepS) {
    const ws = we - windowS;
    while (lo < n && c.t[lo] <= ws) lo++;
    while (hi < n && c.t[hi] <= we) hi++;
    const k = hi - lo;
    if (k < MIN_BEATS) continue;
    let badN = 0, sum = 0;
    for (let i = lo; i < hi; i++) { if (c.bad[i]) badN++; sum += c.rr[i]; }
    if (badN / k > maxArtefact) continue;
    const a1 = alpha(c.rr.slice(lo, hi));
    if (a1 == null) continue;
    out.push({ t: offset + ws + windowS / 2, a1, hr: 60000 / (sum / k), artefact: badN / k });
  }
  return out;
}

// Give each window the mean speed (m/s) of the stream over the same 2 minutes.
// samples: [t, d, ...] rows.
export function withSpeed(rows, samples, windowS = WINDOW_S) {
  const s = (samples || []).filter(r => r && r[0] != null && r[1] != null);
  if (s.length < 2) return rows.map(r => ({ ...r, speed: null }));
  const at = t => {   // distance at time t, by interpolation
    let lo = 0, hi = s.length - 1;
    if (t <= s[0][0]) return s[0][1];
    if (t >= s[hi][0]) return s[hi][1];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m][0] <= t) lo = m; else hi = m; }
    const f = (t - s[lo][0]) / ((s[hi][0] - s[lo][0]) || 1);
    return s[lo][1] + (s[hi][1] - s[lo][1]) * f;
  };
  return rows.map(r => ({ ...r, speed: Math.max(0, (at(r.t + windowS / 2) - at(r.t - windowS / 2)) / windowS) }));
}

// The first aerobic threshold from windows: regress alpha1 on HR (and on speed) and solve
// for 0.75. -> null when there is nothing to fit, else
//   { hr, speed, r2, n, slope, hr_range, ramp, quality: 'good'|'fair'|'poor', reason }
// `ramp` says whether HR rose steadily over the run (corr of HR with time ≥ 0.6, ≥ 20 bpm):
// on a steady run alpha1 barely moves and the line is not worth much.
export function threshold(rows, { target = HRVT1, skipS = 300 } = {}) {
  const r = (rows || []).filter(x => x.t >= (rows[0]?.t ?? 0) + skipS && x.a1 > 0.2 && x.a1 < 1.8 && x.hr > 0
    && (x.speed == null || x.speed > 1.0));
  if (r.length < 10) return null;
  const hrs = r.map(x => x.hr), a1s = r.map(x => x.a1);
  const f = fit(hrs, a1s);
  const lo = Math.min(...hrs), hi = Math.max(...hrs), range = hi - lo;
  const tf = fit(r.map(x => x.t), hrs);
  const ramp = range >= 20 && tf.slope > 0 && tf.r2 >= 0.36;
  const sp = r.filter(x => x.speed != null);
  const fs = sp.length >= 10 ? fit(sp.map(x => x.speed), sp.map(x => x.a1)) : null;
  let hr = f.slope < 0 ? (target - f.intercept) / f.slope : null;
  let speed = fs && fs.slope < 0 ? (target - fs.intercept) / fs.slope : null;
  let reason = null;
  if (hr == null) reason = 'alpha1 did not fall as heart rate rose';
  else if (hr < lo - 5 || hr > hi + 5) { reason = 'the 0.75 crossing lies outside the heart rates you ran at'; }
  if (reason) { hr = null; speed = null; }
  else if (speed != null) {
    const slo = Math.min(...sp.map(x => x.speed)), shi = Math.max(...sp.map(x => x.speed));
    if (speed < slo * 0.9 || speed > shi * 1.1) speed = null;
  }
  const quality = hr == null ? 'poor' : (f.r2 >= 0.6 && ramp && r.length >= 30) ? 'good' : f.r2 >= 0.35 ? 'fair' : 'poor';
  if (!reason && !ramp) reason = 'heart rate did not ramp: an easy-to-hard run gives the clearest line';
  return { hr, speed, r2: f.r2, n: r.length, slope: f.slope, intercept: f.intercept, hr_range: [lo, hi], ramp, quality, reason };
}

// A stream record ({channels, hrv_rr}) -> a small object for trends, or null without RR.
// samples: optional [t, d, ...] rows (for speed).
export function summarise(rr, samples = null, offset = 0) {
  if (!rr || rr.length < MIN_BEATS * 2) return null;
  const c = cleanRR(rr);
  const rows = withSpeed(series(rr, { offset }), samples);
  if (!rows.length) return { beats: rr.length, artefact_pct: round(c.fraction * 100, 1), windows: 0 };
  const th = threshold(rows);
  const a1 = rows.map(x => x.a1);
  return {
    beats: rr.length, artefact_pct: round(c.fraction * 100, 1), windows: rows.length,
    a1_mean: round(a1.reduce((s, x) => s + x, 0) / a1.length, 3), a1_min: round(Math.min(...a1), 3),
    hrvt1_hr: th && th.hr != null ? Math.round(th.hr) : null,
    hrvt1_speed: th && th.speed != null ? round(th.speed, 2) : null,
    r2: th ? round(th.r2, 2) : null, quality: th ? th.quality : null,
  };
}
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
