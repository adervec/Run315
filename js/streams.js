// The per-second stream, made drawable: which channels it carries, pace worked out from
// distance, min/max downsampling so a three-hour run still draws in ~600 points, and
// the arithmetic the overlay compare needs (time gap at equal distance). Pure: no DOM,
// no state. The activity page's stream explorer draws with it; test/streams.test.mjs.
import { SPEED_TYPES } from './lib/fitness.js';

// Channels with a known meaning, in the order they stack. `from` lists the capture
// names (Garmin's FIT-derived names first, then Strava's mapping in ingest.js) and the
// first one present wins. Pace/speed has no `from`: it is worked out from distance,
// because a watch's own speed channel is missing on half the captures and differently
// smoothed on the rest.
export const CHANNELS = [
  { key: 'pace', label: 'Pace', unit: '/km', invert: true, derived: true },
  { key: 'speed', label: 'Speed', unit: 'km/h', dp: 1, derived: true },
  { key: 'hr', label: 'Heart rate', unit: 'bpm', from: ['hr', 'heart_rate'] },
  { key: 'elevation', label: 'Elevation', unit: 'm', from: ['elevation_m', 'gps_elevation_m', 'altitude_m'] },
  { key: 'cadence', label: 'Cadence', unit: 'spm', from: ['cadence_spm', 'run_cadence_spm'] },
  { key: 'bike_cadence', label: 'Cadence', unit: 'rpm', from: ['bike_cadence_rpm'] },
  { key: 'power', label: 'Power', unit: 'W', from: ['power_w', 'power'] },
  { key: 'stride', label: 'Stride length', unit: 'm', dp: 2, from: ['stride_m'] },
  { key: 'gct', label: 'Ground contact', unit: 'ms', from: ['gct_ms'] },
  { key: 'vosc', label: 'Vertical oscillation', unit: 'cm', dp: 1, from: ['vertical_oscillation_cm'] },
  { key: 'vratio', label: 'Vertical ratio', unit: '%', dp: 1, from: ['vertical_ratio_pct', 'vertical_ratio'] },
  { key: 'resp', label: 'Respiration', unit: 'br/min', dp: 1, from: ['respiration_brpm', 'respiration_rate', 'respiration', 'breathing_rate'] },
  { key: 'grade', label: 'Grade', unit: '%', dp: 1, from: ['grade_pct'] },
  { key: 'temp', label: 'Temperature', unit: '°C', dp: 1, from: ['air_temp_c', 'temperature_c', 'temp_c'] },
];
// Never charted on their own: the axes, the position, and the watch's speed (pace replaces it).
const NOT_CHARTED = new Set(['seconds', 'metres', 'lat', 'lon', 'speed_m_s', 'enhanced_speed_m_s', 'timestamp', 'distance_m']);

// Pace from distance over a centred window: ±10 s smooths GPS jitter (a 1 s pace
// trace from a wrist is mostly noise) without hiding a 200 m rep.
export const PACE_HALF_WINDOW_S = 10;
// Slower than this is standing or walking a hill, and drawn as a gap: one stop at a
// crossing would otherwise stretch the pace axis to 40:00 /km and flatten the run.
export const STOPPED_M_S = 1.0;

const num = v => (typeof v === 'number' && isFinite(v) ? v : null);

// Speed (m/s) per sample from the distance channel over a centred time window.
// Two pointers, so O(n) however long the run.
export function windowSpeed(t, d, half = PACE_HALF_WINDOW_S) {
  const n = t.length, out = new Array(n).fill(null);
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    if (num(t[i]) == null) continue;
    while (lo < i && (num(t[lo]) == null || t[i] - t[lo] > half)) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < n && num(t[hi + 1]) != null && t[hi + 1] - t[i] <= half) hi++;
    // A sparse capture (Strava's thinned streams, a watch on smart recording) may hold
    // no other sample inside the window: then the neighbours either side stand in.
    let a = lo, z = hi;
    if (a === z) { a = Math.max(0, i - 1); z = Math.min(n - 1, i + 1); if (num(t[a]) == null) a = i; if (num(t[z]) == null) z = i; }
    const dt = t[z] - t[a], dd = num(d[z]) != null && num(d[a]) != null ? d[z] - d[a] : null;
    if (dt > 0 && dd != null) out[i] = Math.max(0, dd / dt);
  }
  return out;
}

// channels (the capture dict) -> {n, t, d, series: [{key, label, unit, invert, dp, values}]}
// or null when there is no time/distance axis. `type` picks pace (running, walking) or
// speed (riding, rowing), the way fmtEffort does.
export function buildSeries(ch, type = 'running') {
  if (!ch || !Array.isArray(ch.seconds) || !Array.isArray(ch.metres) || ch.seconds.length < 2) return null;
  const n = ch.seconds.length, t = ch.seconds.map(num), d = ch.metres.map(num);
  const series = [], used = new Set();
  const spd = windowSpeed(t, d);
  const moving = spd.map(v => (v != null && v >= STOPPED_M_S ? v : null));
  const speedType = SPEED_TYPES.has(type);
  for (const c of CHANNELS) {
    let values = null;
    if (c.key === 'pace') { if (!speedType) values = moving.map(v => (v == null ? null : 1000 / v)); }
    else if (c.key === 'speed') { if (speedType) values = moving.map(v => (v == null ? null : v * 3.6)); }
    else {
      const name = c.from.find(k => Array.isArray(ch[k]) && ch[k].length === n && ch[k].some(v => num(v) != null && v !== 0));
      if (!name) continue;
      used.add(name);
      // A watch writes 0 for "no reading" on HR and the running-dynamics channels;
      // a true zero heart rate is not a thing. Elevation and grade can be zero.
      const zeroIsGap = !['elevation', 'grade', 'temp'].includes(c.key);
      values = ch[name].map(v => { const x = num(v); return x == null || (zeroIsGap && x === 0) ? null : x; });
    }
    if (values && values.some(v => v != null)) series.push({ key: c.key, label: c.label, unit: c.unit, invert: !!c.invert, dp: c.dp || 0, values });
  }
  // Anything else the watch recorded gets a chart too, named after its key, so a new
  // channel is visible the day it first arrives rather than once someone codes for it.
  for (const k of Object.keys(ch).sort()) {
    if (NOT_CHARTED.has(k) || used.has(k) || CHANNELS.some(c => c.from && c.from.includes(k))) continue;
    const col = ch[k];
    if (!Array.isArray(col) || col.length !== n) continue;
    const values = col.map(num);
    const real = values.filter(v => v != null);
    if (real.length < n * 0.1 || Math.max(...real) === Math.min(...real)) continue;
    const m = /_(bpm|spm|rpm|ms|cm|mm|m|w|pct|c|kph|kmh)$/i.exec(k);
    series.push({ key: 'x_' + k, label: k.replace(/_(bpm|spm|rpm|ms|cm|mm|m|w|pct|c|kph|kmh)$/i, '').replace(/_/g, ' '),
      unit: m ? ({ pct: '%', c: '°C', w: 'W' }[m[1].toLowerCase()] || m[1]) : '', invert: false, dp: 1, values });
  }
  return { n, t, d, series };
}

// q-quantile of the non-null values (linear interpolation), or null.
export function quantile(values, q) {
  const v = values.filter(x => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const pos = (v.length - 1) * q, i = Math.floor(pos), f = pos - i;
  return i + 1 < v.length ? v[i] + f * (v[i + 1] - v[i]) : v[i];
}

// The y-range a chart draws over. Pace uses the 2nd-98th percentile, because the
// slowest moving seconds (a shuffle out of a stop) would otherwise own the axis; the
// rest use the true range. Padded 8% so the line never touches the frame.
export function yRange(values, robust = false) {
  let lo, hi;
  if (robust) { lo = quantile(values, 0.02); hi = quantile(values, 0.98); }
  else {
    lo = Infinity; hi = -Infinity;
    for (const v of values) if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (lo === Infinity) lo = hi = null;
  }
  if (lo == null) return null;
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

// Index of the first sample with x >= v (xs non-decreasing, nulls skipped forward).
export function lowerBound(xs, v) {
  let lo = 0, hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] ?? -Infinity) < v) lo = mid + 1; else hi = mid;
  }
  return lo;
}
// Nearest sample index to x value v.
export function nearest(xs, v) {
  const i = lowerBound(xs, v);
  if (i <= 0) return 0;
  if (i >= xs.length) return xs.length - 1;
  return Math.abs(xs[i] - v) < Math.abs(v - xs[i - 1]) ? i : i - 1;
}

// x as a non-decreasing array: distance is (a GPS glitch can step it backwards a metre;
// the running max keeps the axis monotone so binary search and drawing stay honest).
export function monotone(xs) {
  let m = -Infinity;
  return xs.map(v => { if (v != null && v > m) m = v; return m === -Infinity ? 0 : m; });
}

// Min/max downsampling over [i0, i1): per bucket keep the lowest and the highest sample,
// in time order, so a spike or a stop survives the thinning that an average would erase.
// -> [[x, y|null]], y null marks a gap the line must break at.
export function downsample(xs, ys, i0 = 0, i1 = xs.length, target = 600) {
  const out = [], n = i1 - i0;
  if (n <= 0) return out;
  if (n <= target) { for (let i = i0; i < i1; i++) out.push([xs[i], ys[i] ?? null]); return out; }
  const buckets = Math.max(1, Math.floor(target / 2)), size = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const lo = i0 + Math.floor(b * size), hi = Math.min(i1, i0 + Math.floor((b + 1) * size));
    let mn = -1, mx = -1, gaps = 0;
    for (let i = lo; i < hi; i++) {
      const y = ys[i];
      if (y == null) { gaps++; continue; }
      if (mn < 0 || y < ys[mn]) mn = i;
      if (mx < 0 || y > ys[mx]) mx = i;
    }
    // A bucket mostly stopped draws as a gap, so a long stop reads as a break, not a line.
    if (mn < 0 || gaps > (hi - lo) / 2) { out.push([xs[lo], null]); if (mn < 0) continue; }
    if (mn === mx) out.push([xs[mn], ys[mn]]);
    else if (mn < mx) out.push([xs[mn], ys[mn]], [xs[mx], ys[mx]]);
    else out.push([xs[mx], ys[mx]], [xs[mn], ys[mn]]);
  }
  return out;
}

// [[x, y|null]] -> an SVG path, broken at nulls. X/Y map values to the viewBox.
export function pathOf(pts, X, Y) {
  let s = '', pen = false;
  for (const [x, y] of pts) {
    if (y == null || x == null) { pen = false; continue; }
    s += (pen ? 'L' : 'M') + X(x).toFixed(1) + ' ' + Y(y).toFixed(1);
    pen = true;
  }
  return s;
}

// Elapsed seconds when each grid distance was first reached (linear between samples).
export function timeAtDistance(t, d, grid) {
  const md = monotone(d), out = [];
  for (const g of grid) {
    const i = lowerBound(md, g);
    if (i >= md.length) { out.push(null); continue; }
    if (i === 0 || md[i] === md[i - 1]) { out.push(t[i]); continue; }
    const f = (g - md[i - 1]) / (md[i] - md[i - 1]);
    out.push(t[i - 1] + f * (t[i] - t[i - 1]));
  }
  return out;
}

// The overlay's delta line: how far behind (+s) or ahead (−s) this run was at each
// distance, against the other. Elapsed time, so a stop counts -- which is what a race
// against your own ghost would show. -> {d: [...], gap: [...]} over the shared distance.
export function gapByDistance(a, b, step = 25) {
  const da = monotone(a.d), db = monotone(b.d);
  const end = Math.min(da[da.length - 1], db[db.length - 1]);
  if (!(end > step)) return { d: [], gap: [] };
  const grid = [];
  for (let g = 0; g <= end; g += step) grid.push(g);
  const ta = timeAtDistance(a.t, a.d, grid), tb = timeAtDistance(b.t, b.d, grid);
  const t0a = ta[0] ?? 0, t0b = tb[0] ?? 0;
  return { d: grid, gap: grid.map((_, i) => (ta[i] == null || tb[i] == null ? null : (ta[i] - t0a) - (tb[i] - t0b))) };
}

// Which runs are worth overlaying on this one: the same repeated route first (from
// derive.repeatedRoutes' clusters), then the nearest in distance (±10%), newest first
// within each. `acts` are runs ({id, name, start, distance_m}). -> [{id, label, why}]
export function compareCandidates(act, acts, routes = [], max = 10) {
  const out = [], seen = new Set([act.id]);
  const dateOf = a => String(a.start instanceof Date ? a.start.toISOString() : a.start || '').slice(0, 10);
  const route = (routes || []).find(r => (r.runs || []).some(m => m.id === act.id));
  // The route's runs take most of the list but leave room for a few near in distance.
  if (route) {
    for (const m of [...route.runs].sort((x, y) => dateOf(y).localeCompare(dateOf(x)))) {
      if (seen.has(m.id) || out.length >= Math.max(1, max - 4)) continue;
      seen.add(m.id);
      out.push({ id: m.id, label: `${dateOf(m)} · ${m.name || 'run'} · ${((m.distance_m || 0) / 1000).toFixed(1)} km`, why: 'route', group: route.name });
    }
  }
  const dist = act.distance_m || 0;
  if (dist > 0) {
    const near = acts.filter(a => !seen.has(a.id) && a.distance_m && Math.abs(a.distance_m - dist) <= dist * 0.1)
      .sort((x, y) => dateOf(y).localeCompare(dateOf(x)));
    for (const a of near.slice(0, Math.max(0, max - out.length))) {
      seen.add(a.id);
      out.push({ id: a.id, label: `${dateOf(a)} · ${a.name || 'run'} · ${(a.distance_m / 1000).toFixed(1)} km`, why: 'distance' });
    }
  }
  return out;
}

// "nice" ticks for an x axis between lo and hi: ~n round values.
export function niceTicks(lo, hi, n = 5) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(9));
  return out;
}
