// Motion on the map: the pure timeline helpers behind the replay, the ghost race and the
// coverage time-lapse (js/pages/replay.js, js/pages/timelapse.js).
//
// A stream is a dict of per-second channels (`seconds`, `metres`, `lat`, `lon`, ...). The
// pages never hold its rows as objects: trackFromChannels() packs what a replay needs into
// Float32Arrays (a 2-hour run is ~7,200 samples, ~30 KB a channel), so eight ghosts cost
// about as much memory as one sample-object array would. Float32 keeps ~7 significant
// digits: a latitude of 43.86 comes back to within half a metre, which is finer than GPS.
//
// Everything is looked up by binary search on time (or distance) and interpolated between
// the two neighbouring samples, so the dot moves smoothly at 1x even though the recording is
// one fix a second (or one every few seconds, on smart recording).
//
// Pure: no DOM, no store. See test/replay.test.mjs.

export const SPEEDS = [1, 2, 5, 10, 20, 30, 60, 120];
export const TAIL_S = 90;           // the fading tail behind the dot: the last minute and a half
export const MAX_GHOSTS = 8;        // one per categorical series token, never cycled

const okLL = (la, lo) => la != null && lo != null && Number.isFinite(+la) && Number.isFinite(+lo)
  && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(+la === 0 && +lo === 0);
const num = v => (v == null || v === '' || !Number.isFinite(+v) ? NaN : +v);
const anyFinite = a => { for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) return true; return false; };

// channels -> {n, t, d, lat, lon, [hr, ele, cad, pw], dur, dist} or null (no GPS).
// Rows with no time, or time running backwards, are dropped; a missing fix holds the last one
// (the first fix fills the rows before it), and distance never decreases. t starts at 0.
// lite: only time, distance and position -- what a ghost needs.
export function trackFromChannels(ch, { lite = false } = {}) {
  if (!ch || !ch.seconds || !ch.metres || !ch.lat || !ch.lon) return null;
  const N = ch.seconds.length, keep = [];
  let lastT = -Infinity, firstFix = -1;
  for (let i = 0; i < N; i++) {
    const t = num(ch.seconds[i]);
    if (!Number.isFinite(t) || t < lastT) continue;
    lastT = t; keep.push(i);
    if (firstFix < 0 && okLL(ch.lat[i], ch.lon[i])) firstFix = i;
  }
  if (firstFix < 0 || keep.length < 2) return null;
  const n = keep.length, t0 = num(ch.seconds[keep[0]]);
  const tr = { n, t: new Float32Array(n), d: new Float32Array(n), lat: new Float32Array(n), lon: new Float32Array(n) };
  let la = +ch.lat[firstFix], lo = +ch.lon[firstFix], d = 0;
  for (let k = 0; k < n; k++) {
    const i = keep[k];
    tr.t[k] = num(ch.seconds[i]) - t0;
    const dd = num(ch.metres[i]);
    if (Number.isFinite(dd) && dd > d) d = dd;
    tr.d[k] = d;
    if (okLL(ch.lat[i], ch.lon[i])) { la = +ch.lat[i]; lo = +ch.lon[i]; }
    tr.lat[k] = la; tr.lon[k] = lo;
  }
  // Distance from the first kept row: a watch started a few metres in still starts at 0.
  const d0 = tr.d[0];
  if (d0) for (let k = 0; k < n; k++) tr.d[k] -= d0;
  if (!lite) {
    const opt = (name, src) => {
      if (!src) return;
      const a = new Float32Array(n);
      for (let k = 0; k < n; k++) a[k] = num(src[keep[k]]);
      if (anyFinite(a)) tr[name] = a;
    };
    opt('hr', ch.hr);
    opt('ele', ch.elevation_m || ch.gps_elevation_m);
    opt('cad', ch.cadence_spm || ch.run_cadence_spm || ch.bike_cadence_rpm);
    opt('pw', ch.power_w);
  }
  tr.dur = tr.t[n - 1]; tr.dist = tr.d[n - 1];
  return tr;
}

// Largest i with arr[i] <= v (arr non-decreasing), clamped to [0, n-1].
export function indexAt(arr, v, n = arr.length) {
  if (!n) return -1;
  if (!(v >= arr[0])) return 0;
  if (v >= arr[n - 1]) return n - 1;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m; else hi = m; }
  return lo;
}

// Interpolate along `key` (t or d) to value v: -> {i, f} (sample i, fraction f to i+1).
function locate(tr, key, v) {
  const a = tr[key], i = indexAt(a, v, tr.n), j = Math.min(i + 1, tr.n - 1);
  const span = a[j] - a[i];
  return { i, j, f: span > 0 ? Math.min(1, Math.max(0, (v - a[i]) / span)) : 0 };
}
const lerp = (a, i, j, f) => a[i] + (a[j] - a[i]) * f;
const fin = v => (Number.isFinite(v) ? v : null);

// Distance covered at elapsed time t, and the elapsed time at distance d.
export const distanceAt = (tr, t) => { const { i, j, f } = locate(tr, 't', t); return lerp(tr.d, i, j, f); };
export function timeAtDistance(tr, d) {
  if (d <= 0) return 0;
  if (d >= tr.dist) {
    // The first moment the full distance was reached (not the end of a cool-down stood still).
    const i = indexAt(tr.d, tr.dist - 1e-3, tr.n);
    return tr.t[Math.min(i + 1, tr.n - 1)];
  }
  // Distance can stand still (a stop): take the first sample at or past d, interpolated.
  let lo = 0, hi = tr.n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tr.d[m] < d) lo = m; else hi = m; }
  const span = tr.d[hi] - tr.d[lo], f = span > 0 ? (d - tr.d[lo]) / span : 1;
  return tr.t[lo] + (tr.t[hi] - tr.t[lo]) * f;
}

// Position at elapsed time t -> [lat, lon]; at distance d -> [lat, lon].
export const posAt = (tr, t) => { const { i, j, f } = locate(tr, 't', t); return [lerp(tr.lat, i, j, f), lerp(tr.lon, i, j, f)]; };
export function posAtDistance(tr, d) {
  const t = timeAtDistance(tr, Math.max(0, Math.min(d, tr.dist)));
  return posAt(tr, t);
}

// Mean of a channel over the last `win` seconds before t (ignoring gaps), or null.
export function meanOver(tr, key, t, win) {
  const a = tr[key];
  if (!a) return null;
  const i1 = indexAt(tr.t, t, tr.n), i0 = indexAt(tr.t, t - win, tr.n);
  let s = 0, k = 0;
  for (let i = i0; i <= i1; i++) if (Number.isFinite(a[i])) { s += a[i]; k++; }
  return k ? s / k : null;
}

// Pace (s/km) over the last `win` seconds -- a 30 s window, because one-second GPS speed
// jitters by a minute a kilometre. null when standing (under a metre a second's worth).
export function paceAt(tr, t, win = 30) {
  const w = Math.min(win, t);
  if (w < 3) return null;
  const dm = distanceAt(tr, t) - distanceAt(tr, t - w);
  return dm >= w * 0.5 ? (w / dm) * 1000 : null;
}

// Everything the readouts show at elapsed time t.
export function readout(tr, t) {
  const tt = Math.max(0, Math.min(t, tr.dur)), { i, j, f } = locate(tr, 't', tt);
  const near = f < 0.5 ? i : j;
  const pick = key => (tr[key] ? fin(tr[key][near]) : null);
  return {
    t: tt, d: lerp(tr.d, i, j, f), lat: lerp(tr.lat, i, j, f), lon: lerp(tr.lon, i, j, f),
    pace: paceAt(tr, tt), hr: pick('hr'), cad: pick('cad'),
    ele: tr.ele && Number.isFinite(tr.ele[i]) && Number.isFinite(tr.ele[j]) ? lerp(tr.ele, i, j, f) : pick('ele'),
    pw: tr.pw ? fin(meanOver(tr, 'pw', tt, 3)) : null,
  };
}

// The tail behind the dot as `chunks` runs of [lat, lon], oldest first, each sharing its last
// point with the next one's first so the line is unbroken, the last ending at the dot. The
// page draws chunk k at opacity (k+1)/chunks: the tail fades out behind the runner.
export function tailChunks(tr, t, secs = TAIL_S, chunks = 6, perChunk = 12) {
  const t1 = Math.max(0, Math.min(t, tr.dur)), t0 = Math.max(0, t1 - secs);
  if (t1 - t0 < 0.5) return [];
  const out = [], step = (t1 - t0) / chunks;
  for (let c = 0; c < chunks; c++) {
    const a = t0 + c * step, b = a + step, seg = [posAt(tr, a)];
    const ia = indexAt(tr.t, a, tr.n) + 1, ib = indexAt(tr.t, b, tr.n);
    const every = Math.max(1, Math.ceil((ib - ia + 1) / perChunk));
    for (let i = ia; i <= ib; i += every) if (tr.t[i] > a && tr.t[i] < b) seg.push([tr.lat[i], tr.lon[i]]);
    seg.push(posAt(tr, b));
    out.push(seg);
  }
  return out;
}

// The whole track thinned to at most maxPts [lat, lon] (both ends kept), for the faint line.
export function thin(tr, maxPts = 800) {
  const out = [], every = Math.max(1, Math.ceil(tr.n / maxPts));
  for (let i = 0; i < tr.n; i += every) out.push([tr.lat[i], tr.lon[i]]);
  if ((tr.n - 1) % every) out.push([tr.lat[tr.n - 1], tr.lon[tr.n - 1]]);
  return out;
}

// ---------------------------------------------------------------------------
// the ghost race
// ---------------------------------------------------------------------------

const R = 6371008.8, rad = x => (x * Math.PI) / 180;
export function distM(a, b) {
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Runs like `anchor`: within `tol` of its distance and starting within `nearM` of where it
// did. cands: [{id, distance_m, p0: [lat, lon]}]. -> candidates (anchor first), nearest
// distance first, at most `max`.
export function similarRuns(cands, anchor, { tol = 0.1, nearM = 300, max = 40 } = {}) {
  if (!anchor || !anchor.p0 || !anchor.distance_m) return [];
  const out = cands.filter(c => c.id !== anchor.id && c.p0 && c.distance_m
    && Math.abs(c.distance_m - anchor.distance_m) <= tol * anchor.distance_m && distM(c.p0, anchor.p0) <= nearM)
    .sort((a, b) => Math.abs(a.distance_m - anchor.distance_m) - Math.abs(b.distance_m - anchor.distance_m));
  return [anchor, ...out].slice(0, max);
}

// Recordings of one route never agree on its length to the metre (GPS, a lap of the car park).
// The race is run over the distance every one of them covered, and each runner's finish is
// the moment they reached it -- not the end of a cool-down walk stood still at the door.
// tracks: non-null tracks (the caller drops runs with no GPS stream).
export function prepareRace(tracks) {
  const raceDist = tracks.length ? Math.min(...tracks.map(t => t.dist)) : 0;
  const finish = tracks.map(t => timeAtDistance(t, raceDist));
  return { raceDist, finish, duration: finish.length ? Math.max(...finish) : 0 };
}

// The leaderboard at race clock `clock` (seconds since everyone started together).
//   mode 'time':     each runner where their own recording had them at that elapsed time.
//   mode 'distance': each runner placed on the reference track (racers[0]) at the distance
//                    they had covered -- one line, so a GPS trace on the other pavement or a
//                    start a few metres apart does not show up as a gap.
// Rows, leader first: {k, d, pos, done, finish, place, gap_s, gap_m}. Finished runners rank by
// finish time; the rest by distance. gap_s is how long ago the leader was where this runner
// is now -- the gap a spectator would time -- and gap_m the distance between them.
export function standings(tracks, race, clock, mode = 'time') {
  const ref = tracks[0];
  const rows = tracks.map((tr, k) => {
    const fin = race.finish[k], done = clock >= fin;
    const d = done ? race.raceDist : Math.min(race.raceDist, distanceAt(tr, clock));
    const pos = mode === 'distance' ? posAtDistance(ref, d) : posAt(tr, done ? fin : clock);
    return { k, d, pos, done, finish: fin };
  });
  rows.sort((a, b) => (a.done !== b.done ? (a.done ? -1 : 1) : a.done ? a.finish - b.finish : b.d - a.d) || a.k - b.k);
  const lead = rows[0];
  rows.forEach((r, i) => {
    r.place = i + 1;
    if (!i) { r.gap_s = 0; r.gap_m = 0; return; }
    r.gap_m = Math.max(0, lead.d - r.d);
    r.gap_s = r.done ? r.finish - lead.finish
      : Math.max(0, clock - timeAtDistance(tracks[lead.k], r.d));
  });
  return rows;
}

// ---------------------------------------------------------------------------
// the coverage time-lapse
// ---------------------------------------------------------------------------

export const WORLD_Z = 17;   // world coordinates are z17 tile units: a tile [x, y] spans [x, x+1)
// [lat, lon] -> [x, y] in z17 tile units (Web Mercator).
export function toWorld(lat, lon) {
  const n = 2 ** WORLD_Z, la = Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI / 180;
  return [((lon + 180) / 360) * n, ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n];
}

// Days as integers, so a slider can step through them.
export const dayNum = s => Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000);
export const dayStr = n => new Date(n * 86400000).toISOString().slice(0, 10);

// First visits {'x,y': 'YYYY-MM-DD'} (a Map or an object, z17) -> events sorted by day:
// {n, day: Int32Array (dayNum), x, y: Int32Array (tile at `zoom`)}. At z14 a big tile is
// first visited on the earliest day any of its 64 z17 tiles was.
export function tileEvents(firstSeen, zoom = WORLD_Z) {
  const entries = firstSeen instanceof Map ? [...firstSeen] : Object.entries(firstSeen || {});
  const sh = WORLD_Z - zoom, best = new Map();
  for (const [k, d] of entries) {
    if (!d) continue;
    const [x, y] = String(k).split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const kk = (x >> sh) + ',' + (y >> sh), dn = dayNum(d);
    if (!best.has(kk) || dn < best.get(kk)) best.set(kk, dn);
  }
  const rows = [...best].map(([k, d]) => { const [x, y] = k.split(',').map(Number); return [d, x, y]; })
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  const ev = { n: rows.length, zoom, day: new Int32Array(rows.length), x: new Int32Array(rows.length), y: new Int32Array(rows.length) };
  rows.forEach(([d, x, y], i) => { ev.day[i] = d; ev.x[i] = x; ev.y[i] = y; });
  return ev;
}

// Completed streets of one area -> [{day, k, pts}] sorted by day, pts a Float32Array of world
// x, y pairs with NaN, NaN where the way leaves the area and comes back (nodes more than
// `breakM` apart). geo: buildArea()'s {ways: [{k, c: [[lat, lon]], g}]}; done: {group: date}.
export function streetEvents(geo, done, breakM = 60) {
  const out = [];
  if (!geo || !geo.ways || !done) return out;
  for (const w of geo.ways) {
    const date = w.g && done[w.g];
    if (!date || !w.c || w.c.length < 2) continue;
    const pts = [];
    for (let i = 0; i < w.c.length; i++) {
      if (i && distM(w.c[i - 1], w.c[i]) > breakM) pts.push(NaN, NaN);
      const [x, y] = toWorld(w.c[i][0], w.c[i][1]);
      pts.push(x, y);
    }
    out.push({ day: dayNum(date), k: w.k, g: w.g, pts: Float32Array.from(pts) });
  }
  return out.sort((a, b) => a.day - b.day || String(a.k).localeCompare(String(b.k)));
}

// How many events (sorted by day) have happened by day `d`: the drawing cursor.
export function countBy(days, d, n = days.length) {
  let lo = 0, hi = n;
  while (lo < hi) { const m = (lo + hi) >> 1; if (days[m] <= d) lo = m + 1; else hi = m; }
  return lo;
}

// The box [x0, y0, x1, y1] (world units) holding the middle of the tiles: the lo..hi quantile
// of x and of y, so a holiday on another continent does not shrink home to a dot.
export function quantileBox(xs, ys, lo = 0.03, hi = 0.97, unit = 1) {
  const n = xs.length;
  if (!n) return null;
  const sx = Float64Array.from(xs).sort(), sy = Float64Array.from(ys).sort();
  const q = (s, p) => s[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  return [q(sx, lo) * unit, q(sy, lo) * unit, (q(sx, hi) + 1) * unit, (q(sy, hi) + 1) * unit];
}

// "Where you usually run": the median tile (the home holding most tiles wins outright), the tiles
// within ~30 km of it, then the middle of those. The plain quantile box spans the ocean when the
// record holds two homes (a move, a long stay abroad); this frames the main one.
export function homeBox(xs, ys, zoom, unit = 1, radiusM = 30000) {
  const n = xs.length;
  if (!n) return null;
  const med = a => Float64Array.from(a).sort()[n >> 1];
  const mx = med(xs), my = med(ys);
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * my / 2 ** zoom)));   // tile y -> latitude
  const tileM = 40075016 * Math.cos(lat) / 2 ** zoom, r = radiusM / tileM;
  const kx = [], ky = [];
  for (let i = 0; i < n; i++) if (Math.abs(xs[i] - mx) <= r && Math.abs(ys[i] - my) <= r) { kx.push(xs[i]); ky.push(ys[i]); }
  return quantileBox(kx.length ? kx : xs, kx.length ? ky : ys, 0.03, 0.97, unit);
}

// Hex colour mixing for the year ramp: '#rrggbb' x2, f in [0, 1] -> '#rrggbb'.
const hex = c => { const m = /^#?([0-9a-f]{6})$/i.exec(String(c).trim()); const v = m ? parseInt(m[1], 16) : 0x808080; return [v >> 16, (v >> 8) & 255, v & 255]; };
export function mixHex(a, b, f) {
  const A = hex(a), B = hex(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * Math.min(1, Math.max(0, f))).toString(16).padStart(2, '0')).join('');
}
// Years -> {year: colour}, oldest at stops[0], newest at the last stop, evenly in between.
// Sequential on purpose: the order of the years is the point, not which year is which hue.
export function yearRamp(years, stops) {
  const ys = [...new Set(years)].sort((a, b) => a - b), out = {};
  ys.forEach((y, i) => {
    const t = ys.length > 1 ? i / (ys.length - 1) : 1, seg = t * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(seg));
    out[y] = stops.length > 1 ? mixHex(stops[k], stops[k + 1], seg - k) : mixHex(stops[0], stops[0], 0);
  });
  return out;
}
export const yearOf = dn => +dayStr(dn).slice(0, 4);

// The first WebM flavour this browser records. isSupported: MediaRecorder.isTypeSupported.
export function pickMime(isSupported) {
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
    try { if (isSupported(m)) return m; } catch { /* keep looking */ }
  }
  return '';
}

// Background map tiles covering a view: view {cx, cy (world units), s (px per world unit),
// w, h (px)} -> {z, list: [{z, x, y, px, py, size}]} at the OSM zoom whose tiles come
// closest to 256 px on screen.
export function bgTiles(view, maxZ = 18, minZ = 2) {
  const z = Math.max(minZ, Math.min(maxZ, Math.round(WORLD_Z + Math.log2(view.s / 256))));
  const span = 2 ** (WORLD_Z - z), size = span * view.s, n = 2 ** z;
  const x0 = view.cx - view.w / 2 / view.s, y0 = view.cy - view.h / 2 / view.s;
  const tx0 = Math.floor(x0 / span), ty0 = Math.floor(y0 / span);
  const tx1 = Math.floor((x0 + view.w / view.s) / span), ty1 = Math.floor((y0 + view.h / view.s) / span);
  const list = [];
  for (let ty = Math.max(0, ty0); ty <= Math.min(n - 1, ty1); ty++)
    for (let tx = tx0; tx <= tx1; tx++)
      list.push({ z, x: ((tx % n) + n) % n, y: ty, px: (tx * span - x0) * view.s, py: (ty * span - y0) * view.s, size });
  return { z, list };
}
