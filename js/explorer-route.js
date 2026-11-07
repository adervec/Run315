// Route planning for exploration: "the nearest unfinished streets" (js/cities.js) and "the
// tiles that would grow the square" (js/explore.js) turned into one run you can load on a
// watch. js/pages/plan-route.js draws it; everything here is pure apart from the injected
// fetch / cache, so node can test all of it.
//
// What it is, honestly: an orienteering-style heuristic, not an optimiser. Choosing which
// targets to visit under a distance budget and in what order is the orienteering problem
// (NP-hard); this does what a person with a map would:
//   1. estimate every leg as the straight line x 1.3 (DETOUR -- streets are not straight
//      and a grid costs ~1.27 x crow-flies on average),
//   2. visit targets nearest-neighbour from the start while the estimate fits the budget,
//      improve the order with 2-opt (and by flipping which end a street is entered from),
//      then squeeze in any further target whose cheapest insertion still fits,
//   3. route the result with BRouter, and if the real line came out longer (or shorter)
//      than the estimate, scale the detour factor by what it learned and plan again --
//      at most a few rounds, because each one is a few requests to a free service.
// A street is run along its length: entered at one end of what is still unrun, left at the
// other, with via points on it so BRouter does not cut the corner. A tile is visited
// through its centre -- which may be a pond, so the routed line is checked afterwards and
// the page says which targets it actually covers rather than which it meant to.
//
// Coordinates are [lat, lon] arrays throughout, as js/cities.js stores them.
import * as BS from './bitset.js';
import { tileBounds } from './lib/territory.js';

export const DETOUR = 1.3;
export const MAX_POINTS_PER_CALL = 20;       // BRouter takes more, but long URLs and long jobs get killed
export const CACHE_DAYS = 7;
export const COVER_TOL_M = 30;               // a node within this of the routed line counts as run
export const COMPLETE_AT = 0.9;              // as js/cities.js
export const MAX_POSTMAN_STREETS = 25;
const VIA_STEP_M = 300;                      // via points along a street, so BRouter stays on it
const MAX_VIA = 8;                           // per street target in the orienteering plan
const PIECE_JOIN_M = 50;                     // two 25 m nodes further apart than this are not one stretch

export const PROFILES = [
  ['hiking-mountain', 'Running · trail'],
  ['trekking', 'Cycling · trekking'],
  ['fastbike', 'Cycling · fast / road'],
  ['mtb', 'Cycling · MTB'],
  ['shortest', 'Shortest line'],
];
export const isCycling = profile => profile === 'trekking' || profile === 'fastbike' || profile === 'mtb';

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

const RAD = Math.PI / 180;
export function distM(a, b) {
  const dLat = (b[0] - a[0]) * RAD, dLon = (b[1] - a[1]) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)));
}
export const lineM = pts => { let d = 0; for (let i = 1; i < pts.length; i++) d += distM(pts[i - 1], pts[i]); return d; };
const okPt = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;

// Points along a polyline every `step` metres, both ends kept.
export function sampleAlong(pts, step = VIA_STEP_M) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += distM(pts[i - 1], pts[i]);
    if (acc >= step && i < pts.length - 1) { out.push(pts[i]); acc = 0; }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Evenly pick n of arr, both ends kept.
export function thin(arr, n) {
  if (arr.length <= n) return arr.slice();
  if (n < 2) return [arr[0]];
  const out = [], step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

// Drop consecutive points closer than `m` (BRouter routes a zero-length leg fine, but it is a wasted slot).
export function dedupe(pts, m = 8) {
  const out = [];
  for (const p of pts) if (!out.length || distM(out[out.length - 1], p) >= m) out.push(p);
  return out;
}

// ---------------------------------------------------------------------------
// targets
// ---------------------------------------------------------------------------

// A way's nodes -> the stretches still unrun (bits null = none run). Neighbouring nodes further
// apart than PIECE_JOIN_M are a gap (the way left the area and came back).
export function unrunPieces(coords, bits) {
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push(cur); cur = []; };
  for (let i = 0; i < coords.length; i++) {
    const run = bits && BS.get(bits, i) === 1;
    if (run) { flush(); continue; }
    if (cur.length && distM(cur[cur.length - 1], coords[i]) > PIECE_JOIN_M) flush();
    cur.push(coords[i]);
  }
  flush();
  // A lone unrun node between run ones is GPS noise far more often than an unrun street;
  // keep singletons only when they are all there is.
  const real = out.filter(p => p.length >= 2);
  return real.length ? real : out;
}

// Pieces -> one chain: start at the end furthest from the middle, then always the nearest
// remaining piece end, flipping pieces as needed. -> {chain: [[pt...]...], gapM}
export function chainPieces(pieces) {
  if (!pieces.length) return { chain: [], gapM: 0 };
  const all = pieces.flat(), c = [all.reduce((s, p) => s + p[0], 0) / all.length, all.reduce((s, p) => s + p[1], 0) / all.length];
  let first = 0, flip = false, far = -1;
  pieces.forEach((p, i) => {
    const d0 = distM(p[0], c), d1 = distM(p[p.length - 1], c);
    if (d0 > far) { far = d0; first = i; flip = false; }
    if (d1 > far) { far = d1; first = i; flip = true; }
  });
  const left = new Set(pieces.map((_, i) => i));
  left.delete(first);
  const chain = [flip ? pieces[first].slice().reverse() : pieces[first]];
  let gapM = 0;
  while (left.size) {
    const tail = chain[chain.length - 1].at(-1);
    let best = -1, bestD = Infinity, bestFlip = false;
    for (const i of left) {
      const p = pieces[i], d0 = distM(tail, p[0]), d1 = distM(tail, p[p.length - 1]);
      if (d0 < bestD) { bestD = d0; best = i; bestFlip = false; }
      if (d1 < bestD) { bestD = d1; best = i; bestFlip = true; }
    }
    left.delete(best);
    gapM += bestD;
    chain.push(bestFlip ? pieces[best].slice().reverse() : pieces[best]);
  }
  return { chain, gapM };
}

// Via points for a chain: each piece's ends plus a point every VIA_STEP_M, thinned to `max`.
export function chainVia(chain, max = MAX_VIA) {
  const v = dedupe(chain.flatMap(p => sampleAlong(p)));
  return thin(v, max);
}

// geo/rec as js/cities.js keeps them ('city-geo-<id>' and state.cities[id]). -> Map way key -> way
export const wayIndex = geo => new Map(((geo && geo.ways) || []).map(w => [w.k, w]));

// One street (a group key like 's:Main Street') as a target: what is left of it, chained.
// null when the street is unknown or nothing of it is left to run.
export function streetTarget(geo, rec, key, ways = wayIndex(geo), detour = DETOUR) {
  const g = geo && geo.groups && geo.groups[key];
  if (!g) return null;
  const pieces = [];
  for (const k of g.ways) {
    const w = ways.get(k);
    if (!w || !w.c || !w.c.length) continue;
    const s = rec && rec.cover && rec.cover[k];
    pieces.push(...unrunPieces(w.c, s ? BS.decode(s, w.c.length) : null));
  }
  if (!pieces.length) return null;
  const { chain, gapM } = chainPieces(pieces);
  const unrunM = chain.reduce((s, p) => s + lineM(p), 0);
  const [nodes, hit] = (rec && rec.list && rec.list[key]) || [g.nodes || 0, 0];
  return {
    id: key, kind: 'street', name: g.name || key.slice(2),
    chain, via: chainVia(chain), a: chain[0][0], b: chain.at(-1).at(-1),
    // Walking it: the unrun stretches plus the gaps between them (on roads, so detoured).
    len_m: unrunM + gapM * detour, unrun_m: unrunM, pct: nodes ? hit / nodes : 0, nodes, hit,
  };
}

// A tile as a target, visited through its centre.
export function tileTarget(x, y, zoom) {
  const [s, w, n, e] = tileBounds(x, y, zoom), c = [(s + n) / 2, (w + e) / 2];
  return { id: `z${zoom}:${x},${y}`, kind: 'tile', zoom, x, y, name: `Tile ${x},${y} · z${zoom}`,
    via: [c], a: c, b: c, len_m: 0, bounds: [s, w, n, e] };
}
export function parseTileId(id) {
  const m = /^z(\d+):(-?\d+),(-?\d+)$/.exec(String(id));
  return m ? { zoom: +m[1], x: +m[2], y: +m[3] } : null;
}

// Which streets to offer the planner, best first, from the synced list (no geometry needed to
// rank) and the geometry (to know how far each is from the start).
//   order 'close'      closest to done first: fewest nodes left to the 90% line, in-progress
//                      streets before untouched ones (CityStrides' "finish what you started")
//   order 'untouched'  streets never touched, nearest the start first
// Streets further than half the budget (as the crow flies x detour) are left out: the run has
// to come back.
export function streetCandidates(geo, rec, { start, budgetM = Infinity, order = 'close', limit = 40, detour = DETOUR, kind = 's' } = {}) {
  if (!geo || !geo.groups) return [];
  const list = (rec && rec.list) || {}, near = new Map();
  if (start) for (const w of geo.ways || []) {
    if (!w.g || w.g[0] !== kind) continue;
    // The nearest of a few nodes is plenty for ranking.
    for (const p of thin(w.c, 6)) {
      const d = distM(start, p), cur = near.get(w.g);
      if (cur == null || d < cur) near.set(w.g, d);
    }
  }
  const rows = [];
  for (const g of Object.values(geo.groups)) {
    if (g.kind !== kind) continue;
    const [nodes, hit] = list[g.key] || [g.nodes, 0];
    if (!nodes || hit / nodes >= COMPLETE_AT) continue;
    if (order === 'untouched' && hit > 0) continue;
    const d = start ? near.get(g.key) : 0;
    if (d == null || 2 * d * detour > budgetM) continue;
    rows.push({ key: g.key, d, left: Math.max(0, Math.ceil(nodes * COMPLETE_AT) - hit), pct: hit / nodes, started: hit > 0 });
  }
  const cmp = order === 'untouched'
    ? (x, y) => x.d - y.d
    : (x, y) => (y.started - x.started) || (x.left - y.left) || (y.pct - x.pct) || (x.d - y.d);
  return rows.sort(cmp).slice(0, limit).map(r => r.key);
}

// The nearest way-street group to a clicked point, within `tolM`. -> group key or null
export function streetAt(geo, pt, tolM = 40, kind = 's') {
  let best = null, bd = tolM;
  for (const w of (geo && geo.ways) || []) {
    if (!w.g || w.t !== kind) continue;
    for (const p of w.c) { const d = distM(pt, p); if (d < bd) { bd = d; best = w.g; } }
  }
  return best;
}

// ---------------------------------------------------------------------------
// the orienteering heuristic
// ---------------------------------------------------------------------------

// A tour is [{t, rev}]: rev = run the street from its b end to its a end.
const ends = o => (o.rev ? [o.t.b, o.t.a] : [o.t.a, o.t.b]);

export function tourCost(start, tour, detour = DETOUR) {
  let d = 0, at = start;
  for (const o of tour) { const [i, x] = ends(o); d += distM(at, i) * detour + o.t.len_m; at = x; }
  return d + distM(at, start) * detour;
}

// 2-opt over the order (reversing a stretch also reverses each street in it) plus single
// flips, until nothing improves. Small n (tens), so a full recompute per move is fine.
export function improve(start, tour, detour = DETOUR, maxSweeps = 60) {
  let best = tour.slice(), bc = tourCost(start, best, detour);
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let better = false;
    for (let i = 0; i < best.length; i++) {
      for (let j = i; j < best.length; j++) {
        const cand = best.slice(0, i).concat(best.slice(i, j + 1).reverse().map(o => ({ t: o.t, rev: !o.rev })), best.slice(j + 1));
        const c = tourCost(start, cand, detour);
        if (c < bc - 1e-6) { best = cand; bc = c; better = true; }
      }
    }
    if (!better) break;
  }
  return best;
}

// Cheapest place (and direction) to insert t. -> {at, rev, delta}
function cheapestInsert(start, tour, t, detour) {
  let best = null;
  for (let at = 0; at <= tour.length; at++) {
    const prev = at ? ends(tour[at - 1])[1] : start, next = at < tour.length ? ends(tour[at])[0] : start;
    const base = distM(prev, next) * detour;
    for (const rev of [false, true]) {
      const [i, x] = rev ? [t.b, t.a] : [t.a, t.b];
      const delta = distM(prev, i) * detour + t.len_m + distM(x, next) * detour - base;
      if (!best || delta < best.delta) best = { at, rev, delta };
    }
  }
  return best;
}

// forced: targets that must be in (the athlete clicked them); optional: candidates, best
// first; budgetM: the distance to aim for. -> {tour, estM, skipped: [targets left out]}
export function planTour({ start, forced = [], optional = [], budgetM = Infinity, detour = DETOUR }) {
  let tour = [];
  const seen = new Set();
  const uniq = arr => arr.filter(t => t && !seen.has(t.id) && seen.add(t.id));
  const must = uniq(forced), maybe = uniq(optional);
  // Nearest neighbour: forced targets regardless of budget, then -- when nothing was forced --
  // optional ones while the run still gets home inside the budget.
  const nn = (pool, budgeted) => {
    const left = pool.slice();
    let at = tour.length ? ends(tour.at(-1))[1] : start, cost = tourCost(start, tour, detour) - distM(at, start) * detour;
    while (left.length) {
      let bi = -1, brev = false, bd = Infinity;
      left.forEach((t, i) => {
        for (const rev of [false, true]) {
          const [e, x] = rev ? [t.b, t.a] : [t.a, t.b];
          const d = distM(at, e) * detour;
          if (budgeted && cost + d + t.len_m + distM(x, start) * detour > budgetM) continue;
          if (d < bd) { bd = d; bi = i; brev = rev; }
        }
      });
      if (bi < 0) break;
      const t = left.splice(bi, 1)[0];
      tour.push({ t, rev: brev });
      cost += bd + t.len_m;
      at = brev ? t.a : t.b;
    }
    return left;
  };
  let rest = maybe;
  if (must.length) nn(must, false);
  else rest = nn(maybe, true);
  tour = improve(start, tour, detour);
  // Insertion: in priority order, whatever still fits.
  for (let round = 0; round < 2; round++) {
    const still = [];
    let added = false;
    for (const t of rest) {
      const cost = tourCost(start, tour, detour), ins = cheapestInsert(start, tour, t, detour);
      if (cost + ins.delta <= budgetM) { tour.splice(ins.at, 0, { t, rev: ins.rev }); added = true; }
      else still.push(t);
    }
    rest = still;
    if (!added) break;
    tour = improve(start, tour, detour);
  }
  return { tour, estM: tourCost(start, tour, detour), skipped: rest };
}

// The tour -> the points BRouter is asked to pass through, start and finish at `start`.
// marks[i] = index in pts where target tour[i] is entered (for waypoints in the GPX).
export function tourPoints(start, tour) {
  const pts = [start], marks = [];
  for (const o of tour) {
    const v = o.rev ? o.t.via.slice().reverse() : o.t.via;
    marks.push({ at: pts.length, target: o.t });
    pts.push(...v);
  }
  pts.push(start);
  return { pts, marks };
}

// ---------------------------------------------------------------------------
// BRouter
// ---------------------------------------------------------------------------

// Consecutive chunks of at most `max` points, each starting where the last one ended.
export function chunk(pts, max = MAX_POINTS_PER_CALL) {
  if (pts.length <= max) return [pts];
  const out = [];
  for (let i = 0; i < pts.length - 1; i += max - 1) out.push(pts.slice(i, Math.min(pts.length, i + max)));
  return out.filter(c => c.length >= 2);
}

export const lonlats = pts => pts.map(p => `${(+p[1]).toFixed(6)},${(+p[0]).toFixed(6)}`).join('|');
export const brouterUrl = (pts, profile) =>
  `https://brouter.de/brouter?lonlats=${lonlats(pts)}&profile=${encodeURIComponent(profile)}&alternativeidx=0&format=geojson`;

// BRouter's GeoJSON -> {coords: [[lat, lon, ele]], lengthM, climbM, timeS}. Its numbers come
// as strings in properties ("track-length", "filtered ascend", "total-time").
export function parseBrouter(gj) {
  const f = gj && Array.isArray(gj.features) && gj.features[0];
  const c = f && f.geometry && Array.isArray(f.geometry.coordinates) ? f.geometry.coordinates : null;
  if (!c || c.length < 2) throw new Error('BRouter returned no route.');
  const p = f.properties || {}, num = v => (Number.isFinite(+v) ? +v : null);
  const coords = c.map(q => [q[1], q[0], Number.isFinite(q[2]) ? q[2] : null]);
  return { coords, lengthM: num(p['track-length']) ?? lineM(coords), climbM: num(p['filtered ascend']) ?? 0, timeS: num(p['total-time']) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Route through every point, chunk by chunk, one request at a time, each answer cached for a
// week. Polite: a short pause between calls, one retry after a back-off on a 429 / 5xx /
// network failure, then give up with the reason. A 4xx with a message (a point BRouter
// cannot place on its map) is not retried -- it would fail the same way.
//   io = {fetchFn, cacheGet(key), cacheSet(key, value), now(), pauseMs, retryMs, onProgress(i, n)}
// -> {coords, lengthM, climbM, timeS, calls, cached}
export async function routeVia(pts, profile, io = {}) {
  const { fetchFn = globalThis.fetch, cacheGet = async () => null, cacheSet = async () => {},
    now = () => Date.now(), pauseMs = 400, retryMs = 4000, onProgress = null } = io;
  const parts = chunk(pts);
  let coords = [], lengthM = 0, climbM = 0, timeS = 0, calls = 0, cached = 0;
  for (let i = 0; i < parts.length; i++) {
    onProgress && onProgress(i + 1, parts.length);
    const key = 'brouter-' + profile + '-' + lonlats(parts[i]);
    let hit = null;
    try { const h = await cacheGet(key); if (h && h.fetched_at >= now() - CACHE_DAYS * 864e5) hit = h.data; } catch { /* no cache */ }
    let r;
    if (hit) { r = hit; cached++; }
    else {
      if (calls) await sleep(pauseMs);
      let last = null;
      for (let attempt = 0; attempt < 2 && !r; attempt++) {
        if (attempt) await sleep(retryMs);
        calls++;
        try {
          const res = await fetchFn(brouterUrl(parts[i], profile));
          const body = await res.text();
          if (!res.ok) {
            const msg = String(body || '').trim().slice(0, 200) || `HTTP ${res.status}`;
            if (res.status === 429 || res.status >= 500) { last = `BRouter is busy (${msg})`; continue; }
            throw Object.assign(new Error(`BRouter could not route leg ${i + 1} of ${parts.length}: ${msg}`), { final: true });
          }
          r = parseBrouter(JSON.parse(body));
        } catch (e) {
          if (e.final) throw e;
          last = e.message || String(e);
        }
      }
      if (!r) throw new Error(`Routing failed on leg ${i + 1} of ${parts.length}: ${last}. Try again in a minute.`);
      try { await cacheSet(key, { fetched_at: now(), data: r }); } catch { /* cache is a nicety */ }
    }
    coords = coords.length ? coords.concat(r.coords.slice(1)) : r.coords.slice();
    lengthM += r.lengthM || 0; climbM += r.climbM || 0; timeS += r.timeS || 0;
  }
  return { coords, lengthM, climbM, timeS, calls, cached };
}

// ---------------------------------------------------------------------------
// what the routed line actually covers
// ---------------------------------------------------------------------------

// The routed line as a grid of points every ~15 m, for "is this node near the line" lookups.
function lineGrid(coords, tolM) {
  const lat0 = coords.length ? coords[0][0] : 0, dLat = tolM / 111320, dLon = dLat / Math.max(0.1, Math.cos(lat0 * RAD));
  const cells = new Map(), key = (a, b) => Math.floor(a / dLat) + ',' + Math.floor(b / dLon);
  const add = p => { const k = key(p[0], p[1]); let c = cells.get(k); if (!c) cells.set(k, c = []); c.push(p); };
  for (let i = 0; i < coords.length; i++) {
    add(coords[i]);
    if (i) {
      const a = coords[i - 1], b = coords[i], n = Math.floor(distM(a, b) / 15);
      for (let k = 1; k < n; k++) add([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
  }
  const near = p => {
    const ci = Math.floor(p[0] / dLat), cj = Math.floor(p[1] / dLon);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const q of cells.get((ci + di) + ',' + (cj + dj)) || []) if (distM(p, q) <= tolM) return true;
    }
    return false;
  };
  return { cells, near };
}

// -> Map target id -> share covered (0..1): a street's unrun nodes within COVER_TOL_M of the
// line; a tile 1 when the line passes through it, else 0.
export function coverage(coords, targets, tolM = COVER_TOL_M) {
  const out = new Map();
  if (!coords || coords.length < 2) { for (const t of targets) out.set(t.id, 0); return out; }
  const g = lineGrid(coords, tolM);
  let dense = null;
  for (const t of targets) {
    if (t.kind === 'street') {
      const nodes = t.chain.flat();
      out.set(t.id, nodes.length ? nodes.filter(g.near).length / nodes.length : 0);
    } else if (t.kind === 'tile') {
      dense = dense || [...g.cells.values()].flat();
      const [s, w, n, e] = t.bounds;
      out.set(t.id, dense.some(p => p[0] >= s && p[0] <= n && p[1] >= w && p[1] <= e) ? 1 : 0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// plan, route, learn the detour, plan again
// ---------------------------------------------------------------------------

// router: async pts -> routeVia()'s result. -> {tour, route, estM, detour, rounds, skipped, pts, marks}
// Keeps the best round: the most targets whose real length is within 10% of the budget, else
// the shortest one tried.
export async function planAndRoute({ start, forced = [], optional = [], budgetM, router, detour = DETOUR, maxRounds = 3, onRound = null }) {
  let best = null, f = detour;
  const tried = new Set();
  for (let round = 1; round <= maxRounds; round++) {
    const p = planTour({ start, forced, optional, budgetM, detour: f });
    if (!p.tour.length) { if (!best) best = { ...p, route: null, detour: f, pts: [start], marks: [], fits: false }; break; }
    const sig = p.tour.map(o => o.t.id + (o.rev ? '<' : '>')).join('|');
    if (tried.has(sig)) break;           // the same plan again: routing it again would not help
    tried.add(sig);
    onRound && onRound(round, p);
    const { pts, marks } = tourPoints(start, p.tour);
    const route = await router(pts);
    const cand = { ...p, route, detour: f, pts, marks };
    const fits = route.lengthM <= budgetM * 1.1;
    if (!best || (fits && (!best.fits || cand.tour.length > best.tour.length))
      || (!fits && !best.fits && route.lengthM < best.route.lengthM)) best = { ...cand, fits };
    // Close enough to the budget (or nothing optional to trade): stop asking BRouter.
    const ratio = route.lengthM / Math.max(1, p.estM);
    if (!optional.length || (fits && route.lengthM >= budgetM * 0.85) || !Number.isFinite(ratio)) break;
    f = Math.min(3, Math.max(1, f * ratio));
  }
  best.rounds = Math.max(1, tried.size);
  return best;
}

// ---------------------------------------------------------------------------
// Chinese-postman-lite: one continuous route over a handful of streets
// ---------------------------------------------------------------------------

// The textbook answer: make every junction even by repeating the cheapest set of streets
// (a minimum-weight matching of the odd-degree junctions), then walk an Euler circuit. This
// is the "lite" version and says so:
//   - junctions are guessed from the 25 m nodes (ends within 30 m are one junction; a street
//     passing within 20 m of another's node is split there), not read from OSM's topology;
//   - the run leaves home for the odd junction nearest it and comes back from the next
//     nearest; the other odd junctions are paired greedily, closest pair first, not by an
//     optimal matching;
//   - the repeated stretches and the links between separate groups of streets are routed by
//     BRouter as plain point-to-point legs, so their length is only known after routing.
// streets: street targets (streetTarget()). -> {pts, streetM, extraEstM, odd, links, edges} or null
export function postman(start, streets, { snapM = 20, detour = DETOUR } = {}) {
  const polys = [];
  for (const t of streets.slice(0, MAX_POSTMAN_STREETS)) for (const p of t.chain) if (p.length >= 2) polys.push({ id: t.id, c: p });
  if (!polys.length) return null;
  // 1. Split each stretch wherever another one comes within snapM of it.
  const all = [];
  polys.forEach((p, pi) => p.c.forEach((q, i) => all.push([q, pi, i])));
  const edges = [];
  polys.forEach((p, pi) => {
    const cut = new Set([0, p.c.length - 1]);
    let runStart = -1;
    for (let i = 1; i < p.c.length - 1; i++) {
      const touch = all.some(([q, pj]) => pj !== pi && Math.abs(q[0] - p.c[i][0]) < 1e-3 && distM(q, p.c[i]) <= snapM);
      if (touch && runStart < 0) runStart = i;
      if ((!touch || i === p.c.length - 2) && runStart >= 0) { cut.add(Math.round((runStart + (touch ? i : i - 1)) / 2)); runStart = -1; }
    }
    const idx = [...cut].sort((a, b) => a - b);
    for (let k = 0; k + 1 < idx.length; k++) {
      const c = p.c.slice(idx[k], idx[k + 1] + 1);
      if (c.length >= 2) edges.push({ id: p.id, c, len: lineM(c), street: true });
    }
  });
  // 2. Junctions: edge ends within 1.5 x snapM are one vertex (union-find).
  const ptsV = [];
  edges.forEach(e => { e.u = ptsV.length; ptsV.push(e.c[0]); e.v = ptsV.length; ptsV.push(e.c.at(-1)); });
  const par = ptsV.map((_, i) => i), find = i => (par[i] === i ? i : (par[i] = find(par[i])));
  for (let i = 0; i < ptsV.length; i++) for (let j = i + 1; j < ptsV.length; j++) {
    if (distM(ptsV[i], ptsV[j]) <= snapM * 1.5) par[find(i)] = find(j);
  }
  for (const e of edges) { e.u = find(e.u); e.v = find(e.v); }
  const verts = [...new Set(edges.flatMap(e => [e.u, e.v]))];
  // 3. Join separate groups of streets: repeatedly link the closest pair of junctions in
  //    different components (a greedy spanning tree). Each link is run once, so it adds one
  //    to the degree of both its ends -- exactly like a street.
  const comp = new Map(verts.map(v => [v, v]));
  const cfind = v => { while (comp.get(v) !== v) v = comp.get(v); return v; };
  for (const e of edges) comp.set(cfind(e.u), cfind(e.v));
  const links = [];
  for (;;) {
    const roots = new Set(verts.map(cfind));
    if (roots.size <= 1) break;
    let best = null;
    for (const a of verts) for (const b of verts) {
      if (cfind(a) === cfind(b)) continue;
      const d = distM(ptsV[a], ptsV[b]);
      if (!best || d < best.d) best = { a, b, d };
    }
    comp.set(cfind(best.a), cfind(best.b));
    const l = { u: best.a, v: best.b, c: [ptsV[best.a], ptsV[best.b]], len: best.d * detour, street: false };
    edges.push(l); links.push(l);
  }
  // 4. The start joins the graph as a vertex. The run leaves home for one odd junction and
  //    comes back from another (the two nearest home), which evens both without repeating a
  //    street -- one street from its middle is then there and back, not round twice. With no
  //    odd junction (a closed block), home links to the nearest junction there and back.
  const deg = new Map();
  for (const e of edges) { deg.set(e.u, (deg.get(e.u) || 0) + 1); deg.set(e.v, (deg.get(e.v) || 0) + 1); }
  const odd = verts.filter(v => deg.get(v) % 2 === 1);
  const S = ptsV.length;
  ptsV.push(start);
  const byHome = [...(odd.length ? odd : verts)].sort((x, y) => distM(start, ptsV[x]) - distM(start, ptsV[y]));
  const homeEnds = odd.length ? byHome.slice(0, 2) : [byHome[0], byHome[0]];
  const homeLegs = homeEnds.map(v => ({ u: S, v, c: [start, ptsV[v]], len: distM(start, ptsV[v]) * detour, street: false }));
  edges.push(...homeLegs);
  //    The other odd junctions, paired greedily (closest pair first): each pair a repeat leg.
  const rest = odd.filter(v => !homeEnds.includes(v)), pairs = [];
  for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) pairs.push([distM(ptsV[rest[i]], ptsV[rest[j]]), rest[i], rest[j]]);
  pairs.sort((x, y) => x[0] - y[0]);
  const matched = new Set(), repeats = [];
  for (const [d, a, b] of pairs) {
    if (matched.has(a) || matched.has(b)) continue;
    matched.add(a); matched.add(b);
    const r = { u: a, v: b, c: [ptsV[a], ptsV[b]], len: d * detour, street: false };
    edges.push(r); repeats.push(r);
  }
  // 5. Euler circuit (Hierholzer) from home.
  const adj = new Map([...verts, S].map(v => [v, []]));
  edges.forEach((e, i) => { adj.get(e.u).push(i); adj.get(e.v).push(i); });
  const used = new Uint8Array(edges.length), stack = [[S, -1]], circuit = [];
  while (stack.length) {
    const [v] = stack.at(-1), list = adj.get(v);
    while (list.length && used[list.at(-1)]) list.pop();
    if (!list.length) { circuit.push(stack.pop()); continue; }
    const ei = list.pop();
    used[ei] = 1;
    const e = edges[ei];
    stack.push([e.u === v ? e.v : e.u, ei]);
  }
  circuit.reverse();           // [[vertex, edge that arrived here]...], first has edge -1
  const pts = [start];
  for (let k = 1; k < circuit.length; k++) {
    const [v, ei] = circuit[k], e = edges[ei], from = circuit[k - 1][0];
    const c = e.u === from && e.v === v ? e.c : e.u === v && e.v === from ? e.c.slice().reverse() : e.c;
    // A street is pinned with via points along it; a link or repeat leg is left to BRouter.
    pts.push(...(e.street ? sampleAlong(c, 250) : [c[0], c.at(-1)]));
  }
  return {
    pts: dedupe(pts), edges: edges.length, odd: odd.length, links: links.length, repeats: repeats.length,
    streetM: edges.filter(e => e.street).reduce((s, e) => s + e.len, 0),
    extraEstM: [...links, ...repeats, ...homeLegs].reduce((s, e) => s + e.len, 0),
  };
}

// ---------------------------------------------------------------------------
// out: GPX, the route library, time budgets
// ---------------------------------------------------------------------------

const xmlEsc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const f6 = v => (+v).toFixed(6);

// Track + a named waypoint at each target. wpts: [{pt: [lat, lon], name, desc}]
export function buildGpx(name, coords, wpts = []) {
  const w = wpts.filter(x => okPt(x.pt)).map(x =>
    `<wpt lat="${f6(x.pt[0])}" lon="${f6(x.pt[1])}"><name>${xmlEsc(x.name)}</name>${x.desc ? `<desc>${xmlEsc(x.desc)}</desc>` : ''}<sym>Flag</sym></wpt>`);
  const t = coords.filter(okPt).map(c =>
    `<trkpt lat="${f6(c[0])}" lon="${f6(c[1])}">${Number.isFinite(c[2]) ? `<ele>${(+c[2]).toFixed(1)}</ele>` : ''}</trkpt>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Run315" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${xmlEsc(name)}</name></metadata>
${w.join('\n')}
<trk><name>${xmlEsc(name)}</name><trkseg>${t.join('')}</trkseg></trk>
</gpx>`;
}

// The waypoints for a GPX: where each target is entered (a tile: its centre).
export function gpxWaypoints(plan, cover = new Map()) {
  return (plan.marks || []).map(({ at, target: t }, i) => ({
    pt: t.kind === 'tile' ? t.a : plan.pts[at],
    name: `${i + 1}. ${t.name}`,
    desc: t.kind === 'street' ? `Unrun street, ~${(t.unrun_m / 1000).toFixed(2)} km left${cover.has(t.id) ? `; the route covers ${Math.round(cover.get(t.id) * 100)}%` : ''}`
      : `Unclaimed tile (zoom ${t.zoom})${cover.has(t.id) ? (cover.get(t.id) ? '; the route passes through it' : '; the route misses it') : ''}`,
  }));
}

// Route maker stores at most 50 control points and re-routes between them. The plan's own
// points when they fit (they are what BRouter routed); else 50 points off the routed line,
// which Route maker will snap back onto nearly the same roads. -> [{lat, lon}]
export function libraryPoints(pts, coords, max = 50) {
  const src = pts.length <= max ? pts : thin(coords, max);
  return src.filter(okPt).map(p => ({ lat: +(+p[0]).toFixed(6), lon: +(+p[1]).toFixed(6) }));
}

// Median pace (s/km) of the athlete's recent activities of a kind. null with fewer than 3.
// acts: [{type, distance_m, moving_s, start}]
export function typicalPace(acts, cycling = false, n = 30) {
  const re = cycling ? /cycl|ride|bik/i : /run/i, virt = /virtual|indoor|treadmill|trainer/i;
  const p = (acts || []).filter(a => a && re.test(a.type || '') && !virt.test(a.type || '') && a.distance_m > 1000 && a.moving_s > 0)
    .sort((a, b) => String(b.start).localeCompare(String(a.start))).slice(0, n)
    .map(a => a.moving_s / (a.distance_m / 1000)).sort((a, b) => a - b);
  if (p.length < 3) return null;
  return p.length % 2 ? p[(p.length - 1) / 2] : (p[p.length / 2 - 1] + p[p.length / 2]) / 2;
}
