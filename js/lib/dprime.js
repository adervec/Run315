// D′ balance for runs: Skiba's W′bal, carried over from watts to metres.
//
// The critical-speed model says a runner has a speed they can hold for a long time (CS, m/s)
// and a fixed reserve of distance they can cover faster than that (D′, metres). Every second
// above CS spends (v − CS) metres of it; every second below CS wins some back. When the
// reserve reaches zero the model says the pace could not be held: a fade after that point is
// what it predicts, not a failure of will.
//
// Speed is grade-adjusted (Minetti's cost of running on a slope, js/lib/racecraft.js), so a
// climb at an easy-looking pace still spends the reserve, and a descent spends less.
//
// Two recovery models, both Skiba's:
//
//   'differential' (Skiba, Fulford, Clarke & Skiba 2015), the default. Below CS,
//       dD′bal/dt = (D′ − D′bal) · (CS − v) / D′
//     Every term is in metres and m/s, so it carries over to running unchanged: no constant
//     fitted on cyclists is involved. At a standstill the reserve refills with a time
//     constant of D′/CS (e.g. 200 m / 4 m/s = 50 s).
//
//   'integral' (Skiba, Chidnok, Vanhatalo & Jones 2012),
//       D′bal(t) = D′ − Σ spent(u) · e^(−(t − u)/τ),   τ = 546 · e^(−0.01 · DCP) + 316  [s]
//     where DCP is how far (in watts) the rider sat below CP on average while recovering.
//     Those constants were fitted on cyclists in watts and have no running counterpart. The
//     adaptation here: express the gap as a fraction of CS (DCS / CS, the mean recovery
//     speed's shortfall) and map it onto a reference CP of REF_CP_W = 250 W, close to the mean
//     CP of Skiba's subjects. A run 20% below CS therefore recovers like a rider 50 W below a
//     250 W CP. That is an assumption, not a fit; it is offered for comparison only.
//
// Both are models of a lab phenomenon applied to a GPS trace. The numbers are as good as CS
// and D′ (fitted from the athlete's own best efforts, js/lib/durability.js) and the speed.

import { costRatio } from './racecraft.js';

export const SPEED_WINDOW_S = 10;   // speed: distance over this centred window
export const GRADE_WINDOW_S = 30;   // grade: rise over run on this centred window
export const MIN_GRADE_RUN_M = 15;  // ...when at least this much ground was covered
export const PAUSE_S = 30;          // a gap in the recording longer than this is a stop
export const LOW_FRACTION = 0.25;   // "running on fumes"
export const REF_CP_W = 250;        // integral model only: see above

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// samples ([t, d, hr, lat, lon, ele, ...] rows) -> 1 Hz [[t, d, v, gas, grade]].
//
// Distance and elevation are interpolated onto whole seconds; gaps longer than PAUSE_S are
// filled with standing still (v = 0), which is what the runner was doing (or near enough).
export function speedSeries(samples, { speedWindow = SPEED_WINDOW_S, gradeWindow = GRADE_WINDOW_S } = {}) {
  const s = (samples || []).filter(r => r && r[0] != null && r[1] != null).sort((a, b) => a[0] - b[0]);
  if (s.length < 2) return [];
  const t0 = Math.ceil(s[0][0]), t1 = Math.floor(s[s.length - 1][0]);
  const T = [], Dm = [], E = [];
  let j = 0, lastEle = null;
  for (let t = t0; t <= t1; t++) {
    while (j < s.length - 2 && s[j + 1][0] < t) j++;
    const a = s[j], b = s[j + 1];
    const span = b[0] - a[0];
    let d, e;
    if (span <= 0) { d = b[1]; e = b[5]; }
    else if (span > PAUSE_S) { d = t >= b[0] ? b[1] : a[1]; e = t >= b[0] ? b[5] : a[5]; }
    else {
      const f = clamp((t - a[0]) / span, 0, 1);
      d = a[1] + (b[1] - a[1]) * f;
      e = a[5] != null && b[5] != null ? a[5] + (b[5] - a[5]) * f : (a[5] ?? b[5]);
    }
    if (e != null) lastEle = e;
    T.push(t); Dm.push(d); E.push(e ?? lastEle);
  }
  const n = T.length, hs = Math.max(1, Math.round(speedWindow / 2)), hg = Math.max(1, Math.round(gradeWindow / 2));
  const out = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - hs), hi = Math.min(n - 1, i + hs);
    const v = hi > lo ? Math.max(0, (Dm[hi] - Dm[lo]) / (T[hi] - T[lo])) : 0;
    const glo = Math.max(0, i - hg), ghi = Math.min(n - 1, i + hg), run = Dm[ghi] - Dm[glo];
    const grade = run >= MIN_GRADE_RUN_M && E[ghi] != null && E[glo] != null ? clamp((E[ghi] - E[glo]) / run, -0.45, 0.45) : 0;
    out.push([T[i], Dm[i], v, v * costRatio(grade), grade]);
  }
  return out;
}

// series ([[t, d, v, gas]] at 1 Hz) -> the D′ balance over time and what it says.
//
// -> null without a usable CS and D′, else
//    { model, cs, d_prime, tau_s?, dcs?, points: [[t, d, bal]], min, min_frac, min_t, min_d,
//      low_s, empty, empty_t, empty_d, spent }
// `points` is every second; thin it to draw.
export function balance(series, cs, dPrime, { model = 'differential', low = LOW_FRACTION } = {}) {
  if (!(cs > 0) || !(dPrime > 0) || !series || series.length < 2) return null;
  const pts = [];
  let bal = dPrime, spent = 0, tau = null, dcs = null;
  if (model === 'integral') {
    // One τ for the whole run, from the mean shortfall below CS while recovering (as Skiba did).
    let sum = 0, k = 0;
    for (const r of series) if (r[3] < cs) { sum += cs - r[3]; k++; }
    dcs = k ? sum / k : 0;
    tau = 546 * Math.exp(-0.01 * (dcs / cs) * REF_CP_W) + 316;
  }
  let owed = 0;   // integral form: decaying sum of what was spent
  pts.push([series[0][0], series[0][1], dPrime]);
  for (let i = 1; i < series.length; i++) {
    const dt = series[i][0] - series[i - 1][0];
    if (!(dt > 0)) continue;
    const v = series[i][3];
    if (model === 'integral') {
      owed *= Math.exp(-dt / tau);
      if (v > cs) { owed += (v - cs) * dt; spent += (v - cs) * dt; }
      bal = dPrime - owed;
    } else if (v > cs) {
      bal -= (v - cs) * dt; spent += (v - cs) * dt;
    } else {
      // Exact for constant v over the step. Below zero the deficit recovers the same way.
      bal = dPrime - (dPrime - bal) * Math.exp(-(cs - v) * dt / dPrime);
    }
    pts.push([series[i][0], series[i][1], bal]);
  }
  let mi = 0, lowS = 0, emptyAt = -1;
  for (let i = 0; i < pts.length; i++) {
    if (pts[i][2] < pts[mi][2]) mi = i;
    if (i && pts[i][2] < low * dPrime) lowS += pts[i][0] - pts[i - 1][0];
    if (emptyAt < 0 && pts[i][2] <= 0) emptyAt = i;
  }
  return {
    model, cs, d_prime: dPrime, ...(tau != null ? { tau_s: tau, dcs } : {}),
    points: pts, min: pts[mi][2], min_frac: pts[mi][2] / dPrime, min_t: pts[mi][0], min_d: pts[mi][1],
    low_s: lowS, empty: emptyAt >= 0,
    empty_t: emptyAt >= 0 ? pts[emptyAt][0] : null, empty_d: emptyAt >= 0 ? pts[emptyAt][1] : null,
    spent,
  };
}

// samples + CS/D′ -> balance(...) (or null).
export function analyse(samples, cs, dPrime, opts = {}) {
  return balance(speedSeries(samples, opts), cs, dPrime, opts);
}

// One plain sentence about a result.
export function verdict(r) {
  if (!r) return 'No D′ balance: it needs a critical speed and D′ from your best efforts.';
  const pct = Math.round(r.min_frac * 100);
  if (r.empty) return `The reserve ran out at ${(r.empty_d / 1000).toFixed(1)} km: by the model this pace was not sustainable from there, so a fade after it is expected.`;
  if (r.min_frac < LOW_FRACTION) return `Close to the edge: the reserve bottomed out at ${pct}% at ${(r.min_d / 1000).toFixed(1)} km and you spent ${Math.round(r.low_s / 60)} min below a quarter.`;
  if (r.min_frac < 0.75) return `A real effort: the reserve dipped to ${pct}% (at ${(r.min_d / 1000).toFixed(1)} km) and you never ran it dry.`;
  return `Comfortably within your limits: the reserve never fell below ${pct}%.`;
}

// Small, for the synced state or trends.
export function summary(r) {
  if (!r) return null;
  const k = x => Math.round(x);
  return { min_frac: Math.round(r.min_frac * 1000) / 1000, min_d: k(r.min_d), low_s: k(r.low_s),
    empty: r.empty, empty_d: r.empty ? k(r.empty_d) : null, model: r.model };
}

// Every `step`-th point (and the minimum), for a chart.
export function thin(points, max = 400) {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max), out = [];
  let mi = 0;
  for (let i = 0; i < points.length; i++) if (points[i][2] < points[mi][2]) mi = i;
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  if (!out.includes(points[mi])) out.push(points[mi]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out.sort((a, b) => a[0] - b[0]);
}
