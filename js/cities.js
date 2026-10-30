// Street and trail completion by municipality -- the CityStrides model.
//
// js/lib/trails.js answers "have I run the whole of that trail?" for a box drawn on a map.
// This asks it of an administrative area instead ("Markham", "York Region"), and of its
// public streets as well as its trails, because a municipality is what a runner means by
// "my town" and a box never is: it cuts streets in half and drags in the neighbours.
//
// The engine is the trails one, unchanged: every way resampled to nodes 25 m apart, a run
// hits a node when it passes within 25 m, a street is complete at 90% of its nodes. What
// is new here:
//   classify()     which OSM ways count -- public, named streets (CityStrides' rule) and
//                  public trails; sidewalks, driveways, parking aisles and private roads
//                  never do, or a city could never be finished.
//   makeContains() the boundary as a point-in-polygon test, so a way that crosses the
//                  town line only counts the part inside it.
//   matchArea()    every activity, oldest first, one track in memory at a time, so each
//                  street records the day it crossed the line; incremental after that.
//
// Where things live (the app crashed when synced state grew, so the split is strict):
//   state.cities[areaId]           synced, small (< 300 KB for a city): totals, a base64
//                                  bitset of covered nodes per way, completion dates, the
//                                  per-day gains and per-street [nodes, hit, metres] --
//                                  enough for the phone to show everything but the map.
//   cache `city-geo-<areaId>`      this device: the resampled ways and the boundary.
//   cache `city-matched-<areaId>`  this device: {activity id: 's'|'c'|'-'|'0'} -- matched
//                                  from a stream, from a coarse track, outside the area,
//                                  no track here. Only ids missing from it get matched.
import * as TR from './lib/trails.js';
import * as BS from './bitset.js';
import { tileBounds } from './lib/territory.js';
import { state, save, idbGet, idbSet, idbDel, getStream, streamIds } from './store.js';
import { put, remove } from './merge.js';
import * as D from './derive.js';
import { samplesFromChannels } from './ingest.js';

export const NODE_STEP_M = TR.NODE_STEP_M;   // 25 m, as trails and CityStrides
export const TOL_M = TR.DEFAULT_TOL_M;       // 25 m from a node counts as having been there
// A thinned track (getDetail) has lost its corners' detail: allow a little more slack, and
// let it bridge long straight gaps, since thinning removes the points in between on purpose.
export const COARSE_TOL_M = 40, COARSE_GAP_M = 2000;
export const COMPLETE_AT = 0.9;              // the last 10% is a car-park spur or a mapping stub
export const MAX_AREA_KM2 = 2500;            // bbox estimate; bigger melts a browser tab and Overpass
export const MAX_WAYS = 60000;               // after the fetch: more than this and we stop
export const NEAR_KM = 30;                   // a run starting further than this from the area is skipped unread
const YIELD_EVERY = 4;                       // activities between yields to the event loop

export const geoKey = id => 'city-geo-' + id;
export const matchedKey = id => 'city-matched-' + id;
export const areaId = relId => 'r' + relId;

// ---------------------------------------------------------------------------
// Overpass queries
// ---------------------------------------------------------------------------

export const STREET_HW = ['residential', 'living_street', 'unclassified', 'tertiary', 'tertiary_link',
  'secondary', 'secondary_link', 'primary', 'primary_link', 'pedestrian', 'road', 'service'];
export const TRAIL_HW = ['path', 'footway', 'track', 'bridleway', 'cycleway', 'steps'];

const f6 = v => Number(v).toFixed(6);
// Every administrative boundary containing a point: Markham (8), York Region (6), Ontario (4)...
export const isInQuery = (lat, lon) =>
  `[out:json][timeout:60];is_in(${f6(lat)},${f6(lon)})->.a;rel(pivot.a)["boundary"="administrative"];out tags bb;`;

// By name, case-insensitive and anchored. The name is a regex inside a QL string, so it is
// regex-escaped first and then QL-escaped (backslashes and quotes).
export function nameQuery(name) {
  const re = String(name).trim().slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ql = re.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `[out:json][timeout:60];rel["boundary"="administrative"]["name"~"^${ql}$",i];out tags bb center;`;
}

// One request: the boundary with its geometry, then every candidate way inside it. Only
// the highway values classify() can accept are asked for -- motorways and bus stops are
// half the payload of a bare way["highway"].
export function areaQuery(relId) {
  if (!/^\d+$/.test(String(relId))) throw new Error('Not an OSM relation id: ' + relId);
  const hw = [...STREET_HW, ...TRAIL_HW].join('|');
  return `[out:json][timeout:300][maxsize:1073741824];rel(${relId})->.r;.r out geom;`
    + `.r map_to_area->.a;way["highway"~"^(${hw})$"](area.a);out tags geom;`;
}

// ---------------------------------------------------------------------------
// boundaries
// ---------------------------------------------------------------------------

// A bbox's ground area, km². Overestimates any shape that is not a rectangle, which is the
// safe direction for a "too big to load" check.
export function bboxKm2(b) {
  if (!b || !b.every(Number.isFinite)) return null;
  const [s, w, n, e] = b, k = TR.M_PER_DEG_LAT / 1000;
  return Math.abs(n - s) * k * Math.abs(e - w) * k * Math.cos(((s + n) / 2) * Math.PI / 180);
}

// Overpass relations (out tags bb [center]) -> candidate areas, most local first.
export function parseBoundaries(data) {
  const seen = new Set(), out = [];
  for (const e of (data && data.elements) || []) {
    if (e.type !== 'relation' || !e.tags || e.tags.boundary !== 'administrative' || seen.has(e.id)) continue;
    seen.add(e.id);
    const t = e.tags, b = e.bounds;
    const bbox = b ? [b.minlat, b.minlon, b.maxlat, b.maxlon].map(Number) : null;
    const km2 = bboxKm2(bbox);
    // Whatever the tags offer to tell two "Richmond"s apart.
    const where = [t['is_in'], t['is_in:state'], t['is_in:province'], t['is_in:county'], t['is_in:country'], t['ISO3166-2']]
      .filter(Boolean).join(' · ');
    out.push({ id: e.id, name: t.name || t['name:en'] || 'Relation ' + e.id, admin_level: Number(t.admin_level) || null,
      bbox, km2: km2 == null ? null : Math.round(km2), tooLarge: km2 != null && km2 > MAX_AREA_KM2,
      wikidata: t.wikidata || null, where, center: e.center ? [e.center.lat, e.center.lon] : null });
  }
  return out.sort((a, b) => (b.admin_level || 0) - (a.admin_level || 0) || (a.km2 || 0) - (b.km2 || 0));
}

// The relation's member ways as polylines. Roles are not needed: even-odd crossing over
// every edge of every ring gives "inside an outer and not inside an inner" by itself, and
// the edges do not have to be stitched into rings in order.
export function boundaryLines(rel) {
  const out = [];
  for (const m of (rel && rel.members) || []) {
    if (m.type !== 'way' || !Array.isArray(m.geometry)) continue;
    const pts = m.geometry.filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon)).map(p => [p.lat, p.lon]);
    if (pts.length >= 2) out.push(pts);
  }
  return out;
}

// lines -> (lat, lon) => inside? Edges are bucketed into latitude bands so a point only
// tests the few edges that span its latitude: a city boundary has thousands of edges and
// a city has tens of thousands of nodes.
export function makeContains(lines) {
  const edges = [];
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
  for (const pts of lines) for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    if (a[0] === b[0]) continue;    // horizontal edges never cross a horizontal ray
    edges.push([a[0], a[1], b[0], b[1]]);
    s = Math.min(s, a[0], b[0]); n = Math.max(n, a[0], b[0]);
    w = Math.min(w, a[1], b[1]); e = Math.max(e, a[1], b[1]);
  }
  if (!edges.length) return () => false;
  const B = Math.max(1, Math.min(2048, edges.length >> 2)), h = (n - s) / B || 1;
  const band = lat => Math.min(B - 1, Math.max(0, Math.floor((lat - s) / h)));
  const bands = Array.from({ length: B }, () => []);
  for (const ed of edges) {
    const lo = band(Math.min(ed[0], ed[2])), hi = band(Math.max(ed[0], ed[2]));
    for (let k = lo; k <= hi; k++) bands[k].push(ed);
  }
  return (lat, lon) => {
    if (!(lat >= s && lat <= n && lon >= w && lon <= e)) return false;
    let inside = false;
    for (const [y1, x1, y2, x2] of bands[band(lat)]) {
      if ((y1 > lat) === (y2 > lat)) continue;
      if (lon < x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1)) inside = !inside;
    }
    return inside;
  };
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

const NO_ACCESS = new Set(['private', 'no', 'customers']);
const FOOT_YES = new Set(['yes', 'designated', 'permissive', 'official']);
const BAD_SERVICE = new Set(['driveway', 'parking_aisle', 'drive-through']);
const BAD_FOOTWAY = new Set(['sidewalk', 'crossing', 'traffic_island']);
const STREETS = new Set(STREET_HW), TRAILS = new Set(TRAIL_HW);

// May someone on foot be here? An explicit foot= decides; otherwise access= does. So a
// pedestrianised square tagged access=no + foot=yes counts, a gated road does not.
export function publicOnFoot(t) {
  if (t.foot) return FOOT_YES.has(t.foot) || !NO_ACCESS.has(t.foot);
  return !NO_ACCESS.has(t.access);
}

// OSM tags -> 's' (public street), 't' (public trail) or null (does not count).
//
// Streets follow CityStrides: named, public, not a motorway or trunk (not even asked for),
// and a service road only when it is a real named lane -- never a driveway, parking aisle
// or drive-through. Unnamed streets are left out entirely: there is no street to finish.
// Trails: paths, footways, tracks, bridleways, cycleways and steps, minus sidewalks and
// crossings (they belong to the street they run beside) and anything private.
export function classify(tags) {
  const t = tags || {}, h = t.highway;
  if (!h || t.area === 'yes' || !publicOnFoot(t)) return null;
  if (STREETS.has(h)) {
    if (!String(t.name || '').trim()) return null;
    if (h === 'service' && BAD_SERVICE.has(t.service)) return null;
    return 's';
  }
  if (TRAILS.has(h)) {
    if (h === 'footway' && BAD_FOOTWAY.has(t.footway)) return null;
    return 't';
  }
  return null;
}

// ---------------------------------------------------------------------------
// the area's geometry (device-local)
// ---------------------------------------------------------------------------

const r6 = v => Math.round(v * 1e6) / 1e6;

// Overpass answer (areaQuery) -> geo:
//   {rel, ways: [{k, t, g, c, len}], groups: {key: {key, name, kind, ways, nodes, len_m}}, boundary}
// k  the way id in base 36 (short keys keep the synced cover small)
// t  's' | 't';  g  the group (street or named trail) key or null for an unnamed trail way
// c  the nodes INSIDE the boundary, 25 m apart; len  metres of the way inside the boundary
// Group keys are 's:<Name>' / 't:<Name>' with the first spelling seen; grouping itself is
// case-insensitive, so "Main St" split by a tag change is still one street.
export function buildArea(data, relId) {
  const els = (data && data.elements) || [];
  const rel = els.find(e => e.type === 'relation' && String(e.id) === String(relId));
  const boundary = boundaryLines(rel);
  if (!boundary.length) throw new Error('Overpass did not return the boundary of this area.');
  const inside = makeContains(boundary);
  const ways = [], groups = {}, byLower = new Map();
  for (const el of els) {
    if (el.type !== 'way') continue;
    const t = classify(el.tags);
    if (!t) continue;
    const geom = (el.geometry || []).filter(p => p && Number.isFinite(p.lat)).map(p => [p.lat, p.lon]);
    if (geom.length < 2) continue;
    const [coords, len] = TR.resample(geom, NODE_STEP_M);
    if (!coords.length) continue;
    const kept = coords.filter(([a, b]) => inside(a, b));
    if (!kept.length) continue;
    const name = String((el.tags || {}).name || '').trim() || null;
    let g = null;
    if (name) {
      const lk = t + ':' + name.toLowerCase();
      g = byLower.get(lk);
      if (!g) { g = t + ':' + name; byLower.set(lk, g); groups[g] = { key: g, name, kind: t, ways: [], nodes: 0, len_m: 0 }; }
    }
    const k = Number(el.id).toString(36), lenIn = Math.round((len * kept.length) / coords.length * 10) / 10;
    ways.push({ k, t, g, c: kept.map(([a, b]) => [r6(a), r6(b)]), len: lenIn });
    if (g) { groups[g].ways.push(k); groups[g].nodes += kept.length; groups[g].len_m += lenIn; }
  }
  return { rel: Number(relId), ways, groups,
    boundary: boundary.map(l => l.map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5])) };
}

// A way's kept nodes split wherever two neighbours are not neighbours on the ground (the
// way left the area and came back), optionally only the covered stretches. -> [[lat, lon]...][]
export function pieces(coords, bits = null, covered = true) {
  const out = [];
  let cur = [];
  for (let i = 0; i < coords.length; i++) {
    const on = !bits || (BS.get(bits, i) === 1) === covered;
    const joined = cur.length && TR.distM(cur[cur.length - 1][0], cur[cur.length - 1][1], coords[i][0], coords[i][1]) <= NODE_STEP_M * 2;
    if (!on || (cur.length && !joined)) { if (cur.length > 1) out.push(cur); cur = []; }
    if (on) cur.push(coords[i]);
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// coverage: the matching context, applying hits, the synced summary
// ---------------------------------------------------------------------------

// Working state for one area: decoded bitsets, hit nodes per group, done dates, gains.
export function context(geo, rec = {}) {
  const ways = new Map(geo.ways.map(w => [w.k, w]));
  const cover = new Map(), groupHit = new Map();
  for (const [k, s] of Object.entries(rec.cover || {})) {
    const w = ways.get(k);
    if (!w) continue;
    const bs = BS.decode(s, w.c.length).subarray(0, BS.bytesFor(w.c.length));
    cover.set(k, bs);
    if (w.g) groupHit.set(w.g, (groupHit.get(w.g) || 0) + BS.count(bs));
  }
  return { geo, ways, cover, groupHit, done: { ...(rec.done || {}) },
    gains: new Map((rec.gains || []).map(g => [g[0], [g[1] || 0, g[2] || 0]])) };
}

// OR one activity's hits ({way key: byte mask}, markHits' shape) into the context.
// -> {s, t, finished}: new street and trail nodes, groups that crossed COMPLETE_AT.
// A group is finished once, on the date of the activity that pushed it over the line.
export function applyHits(ctx, hits, date) {
  let s = 0, t = 0;
  const finished = [];
  for (const [k, mask] of Object.entries(hits || {})) {
    const w = ctx.ways.get(k);
    if (!w) continue;
    const n = w.c.length;
    let bs = ctx.cover.get(k);
    if (!bs) ctx.cover.set(k, bs = BS.create(n));
    let add = 0;
    for (let i = 0; i < n && i < mask.length; i++) if (mask[i] && !BS.get(bs, i)) { BS.set(bs, i); add++; }
    if (!add) continue;
    if (w.t === 's') s += add; else t += add;
    if (!w.g) continue;
    const g = ctx.geo.groups[w.g], before = ctx.groupHit.get(w.g) || 0, after = before + add;
    ctx.groupHit.set(w.g, after);
    if (before / g.nodes < COMPLETE_AT && after / g.nodes >= COMPLETE_AT && !ctx.done[w.g]) {
      ctx.done[w.g] = date || '';
      finished.push(w.g);
    }
  }
  if ((s || t) && date) {
    const gn = ctx.gains.get(date) || [0, 0];
    gn[0] += s; gn[1] += t;
    ctx.gains.set(date, gn);
  }
  return { s, t, finished };
}

const blankTotals = () => ({ count: 0, done: 0, nodes: 0, nodesDone: 0, length_m: 0, lengthDone_m: 0 });

// The context -> the synced fields: totals, list, cover, done, gains.
// `list` is {group key: [nodes, nodes hit, metres]} so the phone can show the street list
// without geometry; it is the biggest field after cover and still ~40 bytes a street.
export function summarize(ctx) {
  const streets = blankTotals(), trails = { ...blankTotals(), named: 0, unnamed_m: 0 };
  for (const w of ctx.geo.ways) {
    const n = w.c.length, bs = ctx.cover.get(w.k), hit = bs ? BS.count(bs) : 0, tot = w.t === 's' ? streets : trails;
    tot.nodes += n; tot.nodesDone += hit; tot.length_m += w.len; tot.lengthDone_m += n ? (w.len * hit) / n : 0;
    if (w.t === 't' && !w.g) trails.unnamed_m += w.len;
  }
  const list = {};
  for (const g of Object.values(ctx.geo.groups)) {
    const hit = ctx.groupHit.get(g.key) || 0, tot = g.kind === 's' ? streets : trails;
    tot.count++;
    if (g.nodes && hit / g.nodes >= COMPLETE_AT) tot.done++;
    list[g.key] = [g.nodes, hit, Math.round(g.len_m)];
  }
  trails.named = trails.count;
  for (const t of [streets, trails]) for (const f of ['length_m', 'lengthDone_m', 'unnamed_m']) if (f in t) t[f] = Math.round(t[f]);
  const cover = {};
  for (const [k, bs] of ctx.cover) { const s = BS.toB64(bs); if (s) cover[k] = s; }
  const gains = [...ctx.gains].sort((a, b) => a[0].localeCompare(b[0])).map(([d, [s, t]]) => [d, s, t]);
  return { totals: { streets, trails }, list, cover, done: { ...ctx.done }, gains };
}

// Does a [lat, lon] lie within `km` of a [s, w, n, e] box?
export function nearBox(p, b, km = NEAR_KM) {
  if (!p || !b) return true;    // cannot tell: read the track
  const dLat = km / 111.32, dLon = dLat / Math.max(0.1, Math.cos(p[0] * Math.PI / 180));
  return p[0] >= b[0] - dLat && p[0] <= b[2] + dLat && p[1] >= b[1] - dLon && p[1] <= b[3] + dLon;
}
const boxesMeet = (a, b) => a && b && a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

// Match activities against one area, oldest first. Pure apart from the injected loader.
//   rec       the synced record (its cover/done/gains are the starting point unless full)
//   geo       buildArea()'s output;  matched  {activity id: code} already seen
//   acts      [{id, date: 'YYYY-MM-DD', p0: [lat, lon] | null}]
//   loadTrack async id -> {coords: [[lat, lon]...], coarse: bool} | null
// -> {summary, matched, stats: {checked, runs, coarse}}. Only one track is held at a time.
export async function matchArea({ rec, geo, matched = {}, acts, loadTrack, onProgress, full = false, yieldEvery = YIELD_EVERY }) {
  const ctx = context(geo, full ? {} : rec);
  const seen = full ? {} : { ...matched };
  const todo = acts.filter(a => !(a.id in seen))
    .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')) || String(a.id).localeCompare(String(b.id)));
  const box = rec.bbox;
  let index = null, read = 0;
  for (let i = 0; i < todo.length; i++) {
    const a = todo[i];
    if (!nearBox(a.p0, box)) { seen[a.id] = '-'; continue; }
    const tr = await loadTrack(a.id);
    read++;
    if (!tr || !tr.coords || tr.coords.length < 2) seen[a.id] = '0';
    else if (!boxesMeet(TR.bboxOf(tr.coords), box)) seen[a.id] = '-';
    else {
      index = index || TR.buildIndex(geo.ways.map(w => ({ id: w.k, coords: w.c })), TOL_M);
      const [coords] = TR.resample(tr.coords, TR.TRACK_STEP_M, tr.coarse ? COARSE_GAP_M : TR.TRACK_GAP_M);
      applyHits(ctx, TR.markHits(index, coords, tr.coarse ? COARSE_TOL_M : TOL_M), a.date);
      seen[a.id] = tr.coarse ? 'c' : 's';
    }
    if (read % yieldEvery === 0) {
      onProgress && onProgress(i + 1, todo.length);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  const vals = Object.values(seen);
  const coarse = vals.filter(v => v === 'c').length;
  return { summary: summarize(ctx), matched: seen,
    stats: { checked: todo.length, runs: coarse + vals.filter(v => v === 's').length, coarse } };
}

// ---------------------------------------------------------------------------
// reading the synced record (works on the phone)
// ---------------------------------------------------------------------------

const pctOf = (a, b) => (b ? a / b : 0);

// Rows for the street / trail lists from the synced `list` and `done`.
export function groupRows(rec, kind) {
  const out = [];
  for (const [key, [nodes, hit, len]] of Object.entries((rec && rec.list) || {})) {
    if (key[0] !== kind) continue;
    const pct = pctOf(hit, nodes);
    out.push({ key, name: key.slice(2), nodes, hit, len_m: len, pct, complete: pct >= COMPLETE_AT,
      left: Math.max(0, Math.ceil(nodes * COMPLETE_AT - 1e-9) - hit), done_on: (rec.done || {})[key] || null });
  }
  return out;
}

// Cumulative node coverage (%) over time, streets and trails, from the per-day gains.
export function timeline(rec) {
  const T = (rec && rec.totals) || {}, sN = T.streets?.nodes || 0, tN = T.trails?.nodes || 0;
  let s = 0, t = 0;
  return ((rec && rec.gains) || []).map(([d, a, b]) => {
    s += a || 0; t += b || 0;
    return { date: d, streets: sN ? (100 * s) / sN : 0, trails: tN ? (100 * t) / tN : 0 };
  });
}

// Streets (or trails) finished since a day, from the done dates.
export const finishedSince = (rec, kind, since) =>
  Object.entries((rec && rec.done) || {}).filter(([k, d]) => k[0] === kind && d && d >= since).length;

// ---------------------------------------------------------------------------
// I/O: home point, Overpass, IndexedDB, the state
// ---------------------------------------------------------------------------

const okPt = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;

// Where the athlete usually starts: the most common ~1 km cell of recent start points,
// averaged; else the centre of territory's home tile. null when there is nothing to go on.
export function homePoint(st = state) {
  const cells = new Map();
  const acts = Object.values(st.activities || {}).sort((a, b) => String(b.start).localeCompare(String(a.start))).slice(0, 300);
  for (const a of acts) {
    const p = st.derived?.[a.id]?.p0;
    if (!okPt(p)) continue;
    const k = p[0].toFixed(2) + ',' + p[1].toFixed(2), c = cells.get(k) || [0, 0, 0];
    c[0]++; c[1] += p[0]; c[2] += p[1];
    cells.set(k, c);
  }
  let best = null;
  for (const c of cells.values()) if (!best || c[0] > best[0]) best = c;
  if (best) return [best[1] / best[0], best[2] / best[0]];
  try {
    const home = D.tileSummary(st)?.home;
    if (home) { const [s, w, n, e] = tileBounds(home[0], home[1]); return [(s + n) / 2, (w + e) / 2]; }
  } catch { /* no tiles */ }
  return null;
}

// Overpass by default; tests pass their own.
async function defaultOverpass(q) { return (await import('./routemaker.js')).overpass(q); }

export async function areasAround(lat, lon, { overpass = defaultOverpass } = {}) {
  return parseBoundaries(await overpass(isInQuery(lat, lon)));
}
export async function areasNamed(name, { overpass = defaultOverpass } = {}) {
  if (!String(name || '').trim()) return [];
  return parseBoundaries(await overpass(nameQuery(name)));
}

export const cities = (st = state) => st.cities || {};
export async function localGeo(id) {
  try { return (await idbGet('cache', geoKey(id))) || null; } catch { return null; }
}

// Fetch an area's geometry, refusing what would not fit. -> geo
async function fetchGeo(relId, km2, overpass) {
  if (km2 != null && km2 > MAX_AREA_KM2)
    throw new Error(`That area is about ${Math.round(km2).toLocaleString()} km² — too big to load in a browser. Pick a town or city (admin level 8 or so).`);
  const data = await overpass(areaQuery(relId));
  const n = ((data && data.elements) || []).filter(e => e.type === 'way').length;
  if (n > MAX_WAYS) throw new Error(`That area has ${n.toLocaleString()} streets and paths — more than a browser tab can match. Pick a smaller area.`);
  const geo = buildArea(data, relId);
  if (!geo.ways.length) throw new Error('No public streets or trails inside that boundary.');
  return geo;
}

// Load a boundary (a parseBoundaries row) as an area: geometry to IndexedDB, the record
// to state.cities. Re-loading an area keeps its coverage. -> area id
export async function loadArea(b, { overpass = defaultOverpass } = {}) {
  const geo = await fetchGeo(b.id, b.km2, overpass);
  const id = areaId(b.id);
  await idbSet('cache', geoKey(id), geo);
  if (!state.cities) state.cities = {};
  const prev = state.cities[id] || {};
  const sum = summarize(context(geo, prev));
  put(state, 'cities', id, { ...prev, id, name: b.name, admin_level: b.admin_level, osm_relation: b.id,
    bbox: (b.bbox || []).map(v => +(+v).toFixed(5)), loaded_at: new Date().toISOString(), matched_at: prev.matched_at || null,
    runs: prev.runs || 0, coarse: prev.coarse || 0, ...sum });
  save('edit');
  return id;
}

// Another device loaded this area: fetch the same geometry here.
export async function refetchGeo(id, { overpass = defaultOverpass } = {}) {
  const rec = cities()[id];
  if (!rec) return null;
  const geo = await fetchGeo(rec.osm_relation, null, overpass);
  await idbSet('cache', geoKey(id), geo);
  return geo;
}

export async function removeArea(id) {
  if (!state.cities || !state.cities[id]) return;
  remove(state, 'cities', id);
  save('edit');
  await idbDel('cache', geoKey(id)).catch(() => {});
  await idbDel('cache', matchedKey(id)).catch(() => {});
}

// This device's best track for an activity: the stream when it is here, else the thinned
// detail track (coarse). lat/lon are read straight off the channels when present, so a
// 9,000-sample stream does not become 9,000 ten-wide rows just to drop eight columns.
export async function loadTrack(id) {
  try {
    const rec = await getStream(id), ch = rec && rec.channels;
    if (ch) {
      let pts = [];
      if (Array.isArray(ch.lat) && Array.isArray(ch.lon)) {
        for (let i = 0; i < ch.lat.length; i++) if (ch.lat[i] != null && ch.lon[i] != null) pts.push([ch.lat[i], ch.lon[i]]);
      } else pts = samplesFromChannels(ch).filter(s => s[3] != null && s[4] != null).map(s => [s[3], s[4]]);
      if (pts.length >= 2) return { coords: pts, coarse: false };
    }
  } catch { /* fall through to the coarse track */ }
  try {
    const d = typeof D.getDetail === 'function' ? await D.getDetail(id) : null;
    const pts = d && d.points;
    if (Array.isArray(pts) && pts.length >= 2) return { coords: pts, coarse: true };
  } catch { /* none */ }
  return null;
}

const activityList = st => Object.values(st.activities || {}).map(a => ({
  id: a.id, date: String(a.start || '').slice(0, 10) || null, p0: okPt(st.derived?.[a.id]?.p0) ? st.derived[a.id].p0 : null,
}));

// Match activities this device has not matched yet against every area (or `areaIds`) whose
// geometry is here. Call after every import; cheap when nothing is new. `full` forgets
// what was matched and replays everything (the Re-match button: exact completion dates).
// One run at a time across calls, so an import landing mid-match queues behind it.
let _chain = Promise.resolve();
export function matchNew(areaIds = null, opts = {}) {
  const run = _chain.then(() => _matchNew(areaIds, opts));
  _chain = run.catch(() => {});
  return run;
}
async function _matchNew(areaIds, { onProgress, full = false, loader = loadTrack } = {}) {
  const all = cities();
  const ids = (areaIds || Object.keys(all)).filter(id => all[id]);
  const out = {};
  for (const id of ids) {
    const geo = await localGeo(id);
    if (!geo) continue;
    const matched = full ? {} : ((await idbGet('cache', matchedKey(id)).catch(() => null)) || {});
    // A run matched with no track, or only the coarse one, is matched again once its stream is
    // on this device (a backfill brings streams for runs imported long before). Coverage is an
    // OR of bits, so the second pass only ever adds.
    if (!full) { const have = new Set(await streamIds()); for (const [aid, m] of Object.entries(matched)) if ((m === '0' || m === 'c') && have.has(aid)) delete matched[aid]; }
    const r = await matchArea({ rec: all[id], geo, matched, acts: activityList(state), loadTrack: loader, full,
      onProgress: (i, n) => onProgress && onProgress(id, i, n) });
    await idbSet('cache', matchedKey(id), r.matched);
    out[id] = r.stats;
    const cur = cities()[id];
    if (!cur || (!r.stats.checked && !full)) continue;    // removed meanwhile, or nothing new
    put(state, 'cities', id, { ...cur, ...r.summary, runs: r.stats.runs, coarse: r.stats.coarse, matched_at: new Date().toISOString() });
  }
  if (Object.values(out).some(s => s.checked) || full) save('edit');
  return out;
}
