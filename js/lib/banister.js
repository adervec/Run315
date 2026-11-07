// The athlete's own impulse-response model (Banister 1975; Busso's two-component form):
//
//   p(t) = p0 + k1·Σ w(s)·e^{-(t-s)/τ1} − k2·Σ w(s)·e^{-(t-s)/τ2}      (s < t)
//
// w is the daily training load (fitness.dailyLoads), p a measured performance. CTL/ATL use
// textbook constants (42 / 7 days) for everyone; here τ1 (fitness), τ2 (fatigue), k1, k2 and
// p0 are fitted to this athlete's own races and best efforts, so "how long do I take to
// absorb a block" and "how long should I taper" come from their history, not a textbook.
//
// The fit is bounded least squares: for fixed (τ1, τ2) the model is linear in (p0, k1, k2),
// so those come out of a 3×3 weighted normal-equation solve with k1, k2 ≥ 0 (active sets);
// only the two time constants are searched -- a grid over the bounds, then Nelder–Mead from
// the best few cells. The normal-equation sums split into parts that depend on τ1 alone,
// τ2 alone and the one cross term, which is what keeps 200 bootstrap refits under a second
// on eight years of days. Pure: no DOM, no store.
import { daysBetween, addDayKey } from './dt.js';

export const TAU1 = [20, 60], TAU2 = [3, 20];
export const MIN_GAP = 2;                 // τ1 − τ2: equal constants make the two terms one column
export const MIN_PERFORMANCES = 15;       // fewer than this and five parameters fit noise
export const WARMUP_DAYS = 60;            // a performance this soon after the first load has no history behind it
export const RACE_WEIGHT = 3;             // a race is flat out by definition; an effort inside a run may not be
export const REF_M = 10000;               // the common scale: 10 km-equivalent speed
export const EFFORT_MIN_M = 1609, EFFORT_MAX_M = 42195;
export const HARD_HR = 0.88;              // of threshold HR: the same line fitness.js draws for "hard"
export const ENVELOPE = 0.95, ENVELOPE_DAYS = 30;
export const BOOT_N = 200;

// ---------------------------------------------------------------------------------------- //
// performances on one scale
// ---------------------------------------------------------------------------------------- //
// Why 10 km-equivalent speed by Riegel, with the athlete's own exponent (the one their race
// projection fits): a 5K, a parkrun inside a long run and a half marathon all have to land
// on one axis, and Riegel stretches across 1.6–42 km with one number. Critical speed is the
// other candidate, but it only describes efforts of ~2–30 minutes, and the races that
// matter most here (half, marathon) sit outside that. Using the projection's own exponent
// also means a change in p maps straight onto that projection: p is a percentage of the
// athlete's own median, so one point ≈ 1% of race time.
//
// Best efforts measured inside runs are mostly *not* performances -- the fastest 5 km of an
// easy run says little about fitness. So an effort counts only when the run was hard
// (average HR ≥ 88% of threshold, when HR is known) and it is within 5% of the best
// equivalent the athlete produced within a month either side (the "envelope": a slow day
// in a hard session is not a test). One per activity (its best distance), one per day, and
// a race supersedes any effort on its day.
//
// races: [{id, name, date, distance_m, actual_s}]; efforts: D.prRows rows
// [distance, seconds, day, activity id]; acts: {id: {avg_hr, virtual}}.
export function performances({ races = [], efforts = [], acts = {}, thrHr = null, exponent = 1.06, today = null }) {
  const b = Math.max(1.01, Math.min(1.2, exponent || 1.06));
  const speed = (d, s) => REF_M / (s * (REF_M / d) ** b);
  const byAct = new Map();
  for (const [d, s, day, id] of efforts) {
    if (!(d >= EFFORT_MIN_M && d <= EFFORT_MAX_M && s > 0) || (today && day > today)) continue;
    const a = acts[id];
    if (!a || a.virtual) continue;
    if (thrHr && a.avg_hr && a.avg_hr < HARD_HR * thrHr) continue;
    const v = speed(d, s), cur = byAct.get(id);
    if (!cur || v > cur.v) byAct.set(id, { day, v, d, s, id, kind: 'effort' });
  }
  let cand = [...byAct.values()];
  // the envelope
  cand.sort((x, y) => x.day.localeCompare(y.day));
  if (cand.length) {
    const t = cand.map(c => daysBetween(cand[0].day, c.day));
    let lo = 0, hi = 0;
    cand = cand.filter((c, i) => {
      while (t[i] - t[lo] > ENVELOPE_DAYS) lo++;
      while (hi + 1 < cand.length && t[hi + 1] - t[i] <= ENVELOPE_DAYS) hi++;
      let best = 0;
      for (let k = lo; k <= hi; k++) if (cand[k].v > best) best = cand[k].v;
      return c.v >= ENVELOPE * best;
    });
  }
  const byDay = new Map();
  for (const c of cand) { const cur = byDay.get(c.day); if (!cur || c.v > cur.v) byDay.set(c.day, c); }
  for (const r of races) {
    if (!r.actual_s || !r.distance_m || !r.date || (today && r.date > today)) continue;
    byDay.set(r.date, { day: r.date, v: speed(r.distance_m, r.actual_s), d: r.distance_m, s: r.actual_s, id: r.id, name: r.name, kind: 'race' });
  }
  const out = [...byDay.values()].sort((x, y) => x.day.localeCompare(y.day));
  if (!out.length) return [];
  const vs = out.map(o => o.v).sort((x, y) => x - y), med = vs[vs.length >> 1];
  return out.map(o => ({ ...o, p: 100 * o.v / med, w: o.kind === 'race' ? RACE_WEIGHT : 1, ref_v: med }));
}

// ---------------------------------------------------------------------------------------- //
// the load series and the two filtered impulses
// ---------------------------------------------------------------------------------------- //
// {day: load} -> {start, loads: Float64Array, index(day)} from the first loaded day to `today`.
export function loadSeries(daily, today) {
  const days = Object.keys(daily).filter(d => d <= today && daily[d] > 0).sort();
  if (!days.length) return null;
  const start = days[0], n = daysBetween(start, today) + 1;
  const loads = new Float64Array(n);
  for (const d of days) loads[daysBetween(start, d)] += daily[d];
  return { start, today, n, loads, index: d => daysBetween(start, d) };
}
// G(i) = Σ_{s<i} w(s)·e^{-(i-s)/τ} for every day 0..n (n = the day after the last load).
export function impulse(loads, tau) {
  const e = Math.exp(-1 / tau), g = new Float64Array(loads.length + 1);
  for (let i = 0; i < loads.length; i++) g[i + 1] = e * (g[i] + loads[i]);
  return g;
}
const at = (g, idx) => Float64Array.from(idx, i => g[i]);

// ---------------------------------------------------------------------------------------- //
// the linear part: p0, k1, k2 for fixed τ
// ---------------------------------------------------------------------------------------- //
// Weighted least squares on columns [1, g, −h] with k1, k2 ≥ 0. The sums come in prepared.
// -> {p0, k1, k2, sse, bound} (bound: a k was pinned at 0).
function solve3(A, r) {
  const [a, b, c, d, e, f] = [A[0][0], A[0][1], A[0][2], A[1][1], A[1][2], A[2][2]];
  const det = a * (d * f - e * e) - b * (b * f - e * c) + c * (b * e - d * c);
  if (!(Math.abs(det) > 1e-12 * Math.abs(a * d * f) + 1e-300)) return null;
  const i00 = (d * f - e * e) / det, i01 = (c * e - b * f) / det, i02 = (b * e - c * d) / det;
  const i11 = (a * f - c * c) / det, i12 = (b * c - a * e) / det, i22 = (a * d - b * b) / det;
  return [i00 * r[0] + i01 * r[1] + i02 * r[2], i01 * r[0] + i11 * r[1] + i12 * r[2], i02 * r[0] + i12 * r[1] + i22 * r[2]];
}
function linearFit(S) {
  // S: {w, g, h, gg, hh, gh, p, gp, hp, pp}; columns 1, g, -h
  const sseOf = (p0, k1, k2) => S.pp - 2 * (p0 * S.p + k1 * S.gp - k2 * S.hp)
    + p0 * p0 * S.w + k1 * k1 * S.gg + k2 * k2 * S.hh + 2 * p0 * k1 * S.g - 2 * p0 * k2 * S.h - 2 * k1 * k2 * S.gh;
  const full = solve3([[S.w, S.g, -S.h], [S.g, S.gg, -S.gh], [-S.h, -S.gh, S.hh]], [S.p, S.gp, -S.hp]);
  if (full && full[1] >= 0 && full[2] >= 0) return { p0: full[0], k1: full[1], k2: full[2], sse: sseOf(...full), bound: false };
  // the active sets: one k at zero, or both
  const cands = [];
  const two = (sx, sxx, sxp, sign) => {
    const det = S.w * sxx - sx * sx;
    if (!(det > 1e-12)) return null;
    const p0 = (sxx * S.p - sx * sxp) / det, k = (S.w * sxp - sx * S.p) / det;
    return k * sign >= 0 ? [p0, k * sign] : null;
  };
  const a = two(S.g, S.gg, S.gp, 1);
  if (a) cands.push([a[0], a[1], 0]);
  const b = two(-S.h, S.hh, -S.hp, 1);
  if (b) cands.push([b[0], 0, b[1]]);
  cands.push([S.p / S.w, 0, 0]);
  let best = null;
  for (const c of cands) { const sse = sseOf(...c); if (!best || sse < best.sse) best = { p0: c[0], k1: c[1], k2: c[2], sse, bound: true }; }
  return best;
}

// Sums that depend on one impulse only: Σw·x, Σw·x², Σw·x·p.
function oneSums(x, w, p) {
  let s = 0, ss = 0, sp = 0;
  for (let i = 0; i < x.length; i++) { const wx = w[i] * x[i]; s += wx; ss += wx * x[i]; sp += wx * p[i]; }
  return { s, ss, sp };
}
function baseSums(w, p) {
  let sw = 0, sp = 0, spp = 0;
  for (let i = 0; i < w.length; i++) { sw += w[i]; sp += w[i] * p[i]; spp += w[i] * p[i] * p[i]; }
  return { w: sw, p: sp, pp: spp };
}
function fitAt(gx, hx, w, p, base, gs, hs) {
  gs = gs || oneSums(gx, w, p); hs = hs || oneSums(hx, w, p);
  let gh = 0;
  for (let i = 0; i < w.length; i++) gh += w[i] * gx[i] * hx[i];
  return linearFit({ ...base, g: gs.s, gg: gs.ss, gp: gs.sp, h: hs.s, hh: hs.ss, hp: hs.sp, gh });
}

// ---------------------------------------------------------------------------------------- //
// the search over τ
// ---------------------------------------------------------------------------------------- //
const range = (lo, hi, step) => { const o = []; for (let v = lo; v <= hi + 1e-9; v += step) o.push(+v.toFixed(3)); return o; };
// Best (τ1, τ2) on a grid, from impulses evaluated at the performance days.
// G1[i], G2[j]: impulse values at the performance days for t1s[i], t2s[j].
function gridSearch(t1s, t2s, G1, G2, w, p, keep = 1) {
  const base = baseSums(w, p);
  const s1 = G1.map(g => oneSums(g, w, p)), s2 = G2.map(h => oneSums(h, w, p));
  const top = [];
  for (let i = 0; i < t1s.length; i++) for (let j = 0; j < t2s.length; j++) {
    if (t1s[i] - t2s[j] < MIN_GAP) continue;
    const f = fitAt(G1[i], G2[j], w, p, base, s1[i], s2[j]);
    if (!f) continue;
    const r = { tau1: t1s[i], tau2: t2s[j], ...f };
    if (top.length < keep || r.sse < top[top.length - 1].sse) {
      top.push(r); top.sort((a, b) => a.sse - b.sse); if (top.length > keep) top.pop();
    }
  }
  return top;
}

// Nelder–Mead on (τ1, τ2), bounds by clamping (and the gap by penalty).
function nelderMead(f, x0, step, iters = 80) {
  let s = [x0, [x0[0] + step[0], x0[1]], [x0[0], x0[1] + step[1]]].map(x => ({ x, v: f(x) }));
  for (let k = 0; k < iters; k++) {
    s.sort((a, b) => a.v - b.v);
    if (Math.abs(s[2].v - s[0].v) <= 1e-10 * (Math.abs(s[0].v) + 1e-12)) break;
    const c = [(s[0].x[0] + s[1].x[0]) / 2, (s[0].x[1] + s[1].x[1]) / 2];
    const pt = t => [c[0] + t * (s[2].x[0] - c[0]), c[1] + t * (s[2].x[1] - c[1])];
    const r = { x: pt(-1) }; r.v = f(r.x);
    if (r.v < s[0].v) { const e = { x: pt(-2) }; e.v = f(e.x); s[2] = e.v < r.v ? e : r; }
    else if (r.v < s[1].v) s[2] = r;
    else {
      const ct = { x: pt(r.v < s[2].v ? -0.5 : 0.5) }; ct.v = f(ct.x);
      if (ct.v < Math.min(r.v, s[2].v)) s[2] = ct;
      else s = [s[0], ...s.slice(1).map(q => { const x = [(q.x[0] + s[0].x[0]) / 2, (q.x[1] + s[0].x[1]) / 2]; return { x, v: f(x) }; })];
    }
  }
  s.sort((a, b) => a.v - b.v);
  return s[0];
}
const clampTau = x => [Math.max(TAU1[0], Math.min(TAU1[1], x[0])), Math.max(TAU2[0], Math.min(TAU2[1], x[1]))];

// Seeded PRNG so a bootstrap gives the same answer on every render (and in tests).
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function quantile(xs, q) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return v[lo] + (v[hi] - v[lo]) * (pos - lo);
}

// ---------------------------------------------------------------------------------------- //
// derived quantities
// ---------------------------------------------------------------------------------------- //
// Days from a single training bout to its best effect: where k1·e^{-t/τ1} − k2·e^{-t/τ2} peaks.
// 0 when fitness outweighs fatigue from the first day (the bout helps at once).
export function timeToPeak({ tau1, tau2, k1, k2 }) {
  if (!(tau1 > tau2) || !(k1 > 0)) return null;
  const arg = (k2 * tau1) / (k1 * tau2);
  if (!(arg > 1)) return 0;
  return (tau1 * tau2 / (tau1 - tau2)) * Math.log(arg);
}
// The impulse after a long steady block at load 1, then n days at fraction f.
function taperImpulse(tau, n, f) {
  const e = Math.exp(-1 / tau), ss = e / (1 - e), en = Math.exp(-n / tau);
  return ss * en + f * e * (1 - en) / (1 - e);
}
// Gain in p (per unit of steady daily load) of an n-day taper at fraction f, vs no taper.
export function taperGain(m, n, f) {
  return m.k1 * (taperImpulse(m.tau1, n, f) - taperImpulse(m.tau1, 0, f)) - m.k2 * (taperImpulse(m.tau2, n, f) - taperImpulse(m.tau2, 0, f));
}
// The taper length that maximises race-day p after a steady block, at a load fraction f.
export function optimalTaper(m, f = 0.5, maxDays = 42) {
  let best = 0, bestV = 0;
  for (let n = 1; n <= maxDays; n++) { const v = taperGain(m, n, f); if (v > bestV + 1e-12) { best = n; bestV = v; } }
  return best;
}

// p on day index i (i ≤ n) from the series, for one parameter set.
export function predictSeries(m, series) {
  const g = impulse(series.loads, m.tau1), h = impulse(series.loads, m.tau2);
  return Float64Array.from(g, (x, i) => m.p0 + m.k1 * x - m.k2 * h[i]);
}

// Forward from today: p on race day, given the future daily loads for tomorrow .. the day before
// the race (today's own load is what was recorded). g1T / g2T are the impulses at today.
export function forward(m, g1T, g2T, loadToday, plan) {
  const e1 = Math.exp(-1 / m.tau1), e2 = Math.exp(-1 / m.tau2);
  let g = e1 * (g1T + loadToday), h = e2 * (g2T + loadToday);
  const path = [m.p0 + m.k1 * g - m.k2 * h];
  for (const w of plan) { g = e1 * (g + w); h = e2 * (h + w); path.push(m.p0 + m.k1 * g - m.k2 * h); }
  return path;   // path[j]: p on today + 1 + j; the last entry is race day
}
// The two plans to a race `daysOut` away: hold `load`, or the last n days at fraction f.
export function plans(daysOut, load, n, f) {
  const len = Math.max(0, daysOut - 1);
  const keep = new Array(len).fill(load);
  const taper = keep.map((w, i) => (len - i <= n ? w * f : w));
  return { keep, taper };
}

// ---------------------------------------------------------------------------------------- //
// the whole fit
// ---------------------------------------------------------------------------------------- //
// daily: {day: load}; perfs: performances(); -> the model, or {ok: false, reason, ...}.
export function fitModel(daily, perfs, today, { boot = BOOT_N, seed = 315 } = {}) {
  const series = loadSeries(daily, today);
  if (!series) return { ok: false, reason: 'No training load recorded yet.', n: 0 };
  const warm = addDayKey(series.start, WARMUP_DAYS);
  const use = perfs.filter(q => q.day >= warm && q.day <= today);
  if (use.length < MIN_PERFORMANCES) {
    return { ok: false, n: use.length, series, perfs: use,
      reason: `Only ${use.length} usable performance${use.length === 1 ? '' : 's'} (races, and hard best efforts after the first ${WARMUP_DAYS} days of the record); the model has five parameters and needs at least ${MIN_PERFORMANCES} to say anything.` };
  }
  const idx = use.map(q => series.index(q.day)), w = Float64Array.from(use, q => q.w), p = Float64Array.from(use, q => q.p);

  // 1. grid, fine enough for the main fit
  const t1s = range(TAU1[0], TAU1[1], 1), t2s = range(TAU2[0], TAU2[1], 0.5);
  const G1full = t1s.map(t => impulse(series.loads, t)), G2full = t2s.map(t => impulse(series.loads, t));
  const G1 = G1full.map(g => at(g, idx)), G2 = G2full.map(g => at(g, idx));
  const top = gridSearch(t1s, t2s, G1, G2, w, p, 3);
  if (!top.length) return { ok: false, n: use.length, series, perfs: use, reason: 'The fit could not be solved (the load history is too flat to separate fitness from fatigue).' };

  // 2. refine from the best three cells
  const base = baseSums(w, p);
  const cost = x => {
    const [t1, t2] = clampTau(x);
    const pen = (Math.abs(t1 - x[0]) + Math.abs(t2 - x[1])) * 1e3 + (t1 - t2 < MIN_GAP ? (MIN_GAP - (t1 - t2)) * 1e3 : 0);
    const f = fitAt(at(impulse(series.loads, t1), idx), at(impulse(series.loads, t2), idx), w, p, base);
    return f ? f.sse * (1 + pen) + pen : Infinity;
  };
  let best = top[0];
  for (const st of top) {
    const r = nelderMead(cost, [st.tau1, st.tau2], [3, 1.5]);
    const [t1, t2] = clampTau(r.x);
    if (t1 - t2 < MIN_GAP) continue;
    const f = fitAt(at(impulse(series.loads, t1), idx), at(impulse(series.loads, t2), idx), w, p, base);
    if (f && f.sse < best.sse) best = { tau1: t1, tau2: t2, ...f };
  }

  // 3. quality
  const g = impulse(series.loads, best.tau1), h = impulse(series.loads, best.tau2);
  const fitted = idx.map(i => best.p0 + best.k1 * g[i] - best.k2 * h[i]);
  const resid = use.map((q, i) => q.p - fitted[i]);
  const mean = base.p / base.w;
  let sst = 0;
  for (let i = 0; i < p.length; i++) sst += w[i] * (p[i] - mean) ** 2;
  const r2 = sst > 0 ? 1 - best.sse / sst : 0;
  const dof = Math.max(1, use.length - 5);
  const residSd = Math.sqrt(resid.reduce((s, r) => s + r * r, 0) / dof);
  const races = use.map((q, i) => (q.kind === 'race' ? resid[i] : null)).filter(r => r != null);
  const raceResidSd = races.length >= 5 ? Math.sqrt(races.reduce((s, r) => s + r * r, 0) / (races.length - 1)) : null;
  // How alike the two impulses are at the performance days: near 1, k1 and k2 trade off freely.
  const gx = at(g, idx), hx = at(h, idx);
  const corr = weightedCorr(gx, hx, w);

  // 4. bootstrap over performances, on a coarser grid (τ1 every 2 days, τ2 every day)
  const rnd = mulberry32(seed), n = use.length;
  const bi = t1s.map((t, i) => i).filter(i => i % 2 === 0), bj = t2s.map((t, j) => j).filter(j => j % 2 === 0);
  const bt1 = bi.map(i => t1s[i]), bt2 = bj.map(j => t2s[j]), bG1 = bi.map(i => G1[i]), bG2 = bj.map(j => G2[j]);
  const sets = [];
  for (let b = 0; b < boot; b++) {
    const c = new Float64Array(n);
    for (let k = 0; k < n; k++) c[Math.floor(rnd() * n)] += 1;
    const wb = Float64Array.from(w, (x, k) => x * c[k]);
    const r = gridSearch(bt1, bt2, bG1, bG2, wb, p, 1)[0];
    if (r) sets.push({ tau1: r.tau1, tau2: r.tau2, p0: r.p0, k1: r.k1, k2: r.k2, bound: r.bound });
  }
  const iv = f => [quantile(sets.map(f), 0.1), quantile(sets.map(f), 0.9)];
  const model = { tau1: best.tau1, tau2: best.tau2, p0: best.p0, k1: best.k1, k2: best.k2 };
  const tStar = timeToPeak(model);
  const ci = {
    tau1: iv(s => s.tau1), tau2: iv(s => s.tau2), k1: iv(s => s.k1), k2: iv(s => s.k2),
    t_star: iv(s => timeToPeak(s)), taper: iv(s => optimalTaper(s, 0.5)),
  };

  // 5. what to warn about
  const warnings = [];
  if (n < 25) warnings.push(`Only ${n} performances: treat every number here as a rough first estimate.`);
  if (best.bound) warnings.push(best.k1 === 0 ? 'The best fit puts no weight on fitness (k1 = 0): the load history does not explain these performances.'
    : 'The best fit puts no weight on fatigue (k2 = 0): the performances do not show a cost of recent load, so taper advice is weak.');
  if (Math.abs(corr) > 0.99) warnings.push('Fitness and fatigue move almost together in this history (correlation ' + corr.toFixed(3) + '), so k1 and k2 are poorly separated.');
  if (best.tau1 <= TAU1[0] + 0.5 || best.tau1 >= TAU1[1] - 0.5) warnings.push(`τ1 sits on its bound (${TAU1.join('–')} days): the data would like it outside the plausible range.`);
  if (best.tau2 <= TAU2[0] + 0.25 || best.tau2 >= TAU2[1] - 0.25) warnings.push(`τ2 sits on its bound (${TAU2.join('–')} days).`);
  if (ci.tau1[1] - ci.tau1[0] > 25) warnings.push('τ1 is poorly determined: resampling the performances moves it across most of its range.');
  if (r2 < 0.1) warnings.push(`The model explains little of the variation (R² ${r2.toFixed(2)}): day-to-day noise and things load cannot see (terrain, heat, pacing) dominate.`);
  if (!(best.k2 > best.k1)) warnings.push('k2 ≤ k1, unusual (fatigue per unit load is normally larger than fitness): a bout never costs form, even the day after.');
  if (sets.filter(s => s.bound).length > boot * 0.3) warnings.push('In many resamples a k hits zero: the split between fitness and fatigue is fragile.');

  return {
    ok: true, n, n_races: use.filter(q => q.kind === 'race').length, series, perfs: use, fitted, resid,
    model, sse: best.sse, bound: best.bound, r2, resid_sd: residSd, race_resid_sd: raceResidSd, corr,
    t_star: tStar, optimal_taper: optimalTaper(model, 0.5), ci, boot: sets, warnings,
    g_today: g[series.n - 1], h_today: h[series.n - 1], load_today: series.loads[series.n - 1],
    p_today: best.p0 + best.k1 * g[series.n - 1] - best.k2 * h[series.n - 1],
    curve: Float64Array.from(g, (x, i) => best.p0 + best.k1 * x - best.k2 * h[i]),
  };
}

function weightedCorr(x, y, w) {
  let sw = 0, sx = 0, sy = 0;
  for (let i = 0; i < w.length; i++) { sw += w[i]; sx += w[i] * x[i]; sy += w[i] * y[i]; }
  const mx = sx / sw, my = sy / sw;
  let cxy = 0, cxx = 0, cyy = 0;
  for (let i = 0; i < w.length; i++) { const a = x[i] - mx, b = y[i] - my; cxy += w[i] * a * b; cxx += w[i] * a * a; cyy += w[i] * b * b; }
  return cxx > 0 && cyy > 0 ? cxy / Math.sqrt(cxx * cyy) : 1;
}

// Mean load per day over the last 28 days (today included), as fitness.projectForm holds it.
export function recentLoad(series, days = 28) {
  let t = 0;
  for (let i = 0; i < days; i++) { const k = series.n - 1 - i; if (k >= 0) t += series.loads[k]; }
  return t / days;
}

// The form a race-time projection stands on: the weighted mean of p over the days its efforts
// came from (ref: [[day, weight]]; none -> today), for the fit and for every bootstrap set.
export function referenceP(fit, ref = null) {
  const of = (m, g, h) => {
    const pAt = i => m.p0 + m.k1 * g[i] - m.k2 * h[i];
    let sw = 0, s = 0;
    for (const [day, wt] of ref || []) { const i = fit.series.index(day); if (i >= 0 && i <= fit.series.n) { s += wt * pAt(i); sw += wt; } }
    return { p: sw > 0 ? s / sw : pAt(fit.series.n - 1), gT: g[fit.series.n - 1], hT: h[fit.series.n - 1] };
  };
  const imp = m => of(m, impulse(fit.series.loads, m.tau1), impulse(fit.series.loads, m.tau2));
  return { main: imp(fit.model), boot: fit.boot.map(imp) };
}

// One upcoming race, daysOut ≥ 1 away: predicted p on the day if the athlete holds their recent
// load ("keep") or tapers the last n days to fraction f, for the fit and for every bootstrap
// set. A race time is scaled by p(ref) / p(race day); ref from referenceP().
export function raceOutlook(fit, ref, daysOut, n, f) {
  const L = recentLoad(fit.series);
  const { keep, taper } = plans(daysOut, L, n, f);
  const one = (m, r) => ({ keep: forward(m, r.gT, r.hT, fit.load_today, keep), taper: forward(m, r.gT, r.hT, fit.load_today, taper) });
  const main = one(fit.model, ref.main);
  const ratios = { keep: [], taper: [] };
  fit.boot.forEach((m, i) => {
    const r = one(m, ref.boot[i]);
    ratios.keep.push(ref.boot[i].p / r.keep[r.keep.length - 1]); ratios.taper.push(ref.boot[i].p / r.taper[r.taper.length - 1]);
  });
  // The band on a race time: the model's own uncertainty (bootstrap spread of the time ratio)
  // and one day's scatter around the curve (the residual SD -- of races when there are five,
  // else of every performance -- in % because p is in % of the athlete's median).
  const noise = (fit.race_resid_sd ?? fit.resid_sd) / 100;
  const band = (rs, central) => {
    const sd = sdOf(rs), hw = 1.2816 * Math.sqrt(sd * sd + noise * noise);
    return { ratio: central, lo: central * (1 - hw), hi: central * (1 + hw), model_sd: sd, noise };
  };
  const pk = main.keep[main.keep.length - 1], pt = main.taper[main.taper.length - 1];
  return {
    days_out: daysOut, load: L, taper_days: n, taper_frac: f,
    p_keep: pk, p_taper: pt, p_ref: ref.main.p,
    keep: band(ratios.keep, ref.main.p / pk), taper: band(ratios.taper, ref.main.p / pt),
    keep_path: main.keep, taper_path: main.taper,
    best_taper: bestRaceTaper(fit, daysOut, f, L),
  };
}
const sdOf = xs => { const v = xs.filter(Number.isFinite); if (v.length < 2) return 0; const m = v.reduce((a, b) => a + b, 0) / v.length; return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)); };
// The taper length (0..min(42, daysOut−1)) that maximises race-day p for this race, from today.
export function bestRaceTaper(fit, daysOut, f, L = recentLoad(fit.series)) {
  let best = 0, bestV = -Infinity;
  for (let n = 0; n <= Math.min(42, daysOut - 1); n++) {
    const path = forward(fit.model, fit.g_today, fit.h_today, fit.load_today, plans(daysOut, L, n, f).taper);
    const v = path[path.length - 1];
    if (v > bestV + 1e-9) { best = n; bestV = v; }
  }
  return best;
}
