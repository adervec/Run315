// Trail coverage: which named trails you have actually run, end to end.
//
// territory.js asks "have I been in this square?". This asks the harder question:
// "have I run the *whole* of that trail?" -- the CityStrides model, pointed at
// trails instead of streets.
//
// Every path-ish OSM way becomes a SEGMENT whose geometry is resampled to nodes a
// fixed 25 m apart. An activity hits a node when its track passes within tolerance
// of it. A named trail is every segment sharing that name -- OSM splits a trail
// into dozens of ways wherever a tag changes, so the name is the only real
// identity -- and completion is hit nodes over total nodes.
//
// Two things make the numbers honest rather than flattering. Tracks are densified
// to 10 m before matching, so a watch recording every 30 seconds cannot step over
// a node it obviously ran past; and long jumps in a track are breaks, never
// interpolated, so driving between two trailheads does not paint every trail on
// the way. Coverage is then replayed oldest-first, so a node counts for the outing
// that first reached it and a repeat lap scores nothing.
//
// Ported from the TrailTracker engine (engine.js) via trails.py, keeping its
// constants and thresholds so all agree on the same data. Pure functions, no I/O --
// Overpass JSON and lists of [lat, lng] go in, coverage comes out.
//
// Shapes used throughout:
//
//   coords    [[lat, lng], ...] -- a resampled polyline. Node i of a segment is
//             coords[i] and hit-mask byte i refers to that same node, so node
//             indices are the one thing every function here agrees on.
//   Segment   one OSM way; see Segment() below. seg.coords.length is its node count.
//   hits      {way_id: Uint8Array} -- one byte per node, 1 = passed within
//             tolerance. Segments a track never came near are absent, not zeroed,
//             which is what keeps a city of trails out of every activity's record.
//   activity  {id, date: 'YYYY-MM-DD', hits} -- what chronology() and
//             unionCoverage() replay. Other keys are ignored.
import { dayKey, fromDay, daysBetween } from './dt.js';

export const M_PER_DEG_LAT = 111320;    // good to a tenth of a percent anywhere that has trails
export const NODE_STEP_M = 25;          // trail node spacing -- matches CityStrides' 25 m feel
export const TRACK_STEP_M = 10;         // tracks are densified to this so they cannot skip a node
export const TRACK_GAP_M = 150;         // a longer jump is a GPS pause or a drive, never a route
export const DEFAULT_TOL_M = 25;        // how close to a node counts as having been there
export const DEFAULT_COMPLETE_AT = 0.9; // done at 90%: the last stub is usually a car park spur,
                                        // a mapping artefact, or a bit of private land
export const JOIN_TOL_M = 50;           // way ends this close are the same junction, for stitching

const RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

// Metres between two points, equirectangular. Trails are local, so flattening the
// earth about the midpoint latitude is exact enough and much cheaper than
// haversine -- and this runs once per (track point, candidate node) pair, which is
// millions of times per import.
export function distM(aLat, aLng, bLat, bLng) {
  const dy = (bLat - aLat) * M_PER_DEG_LAT;
  const dx = (bLng - aLng) * M_PER_DEG_LAT * Math.cos(((aLat + bLat) / 2.0) * RAD);
  return Math.sqrt(dx * dx + dy * dy);
}

// Python float(): numbers, bools, and numeric strings; anything else is null.
function _float(x) {
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x !== 'string') return null;
  const s = x.trim();
  if (/^[+-]?(inf(inity)?|nan)$/i.test(s)) return /nan/i.test(s) ? NaN : (s[0] === '-' ? -Infinity : Infinity);
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s);
  return null;
}

// [[lat, lng]] with the junk removed: null, NaN, strings, off-Earth points.
// Watches and half-parsed files emit all of these; filtering up front, once,
// keeps a NaN from propagating into the maths.
function _finite(line) {
  const out = [];
  for (const p of line || []) {
    if (!p || !(p.length >= 2)) continue;
    const lat = _float(p[0]), lng = _float(p[1]);
    if (lat === null || lng === null) continue;
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      out.push([lat, lng]);
    }
  }
  return out;
}

// Resample a polyline to even `stepM` spacing. -> [coords, length_m].
//
// Gaps longer than `maxGapM` are breaks: both endpoints are kept, nothing is
// placed between them, and the jump is not counted as distance. Without that,
// the drive home paints every trail it passes.
//
// The true end of the line is appended unless a node already sits within half
// a step of it, so a trail's end never drifts inward by up to a full step.
export function resample(line, stepM = NODE_STEP_M, maxGapM = null) {
  if (!(stepM && stepM > 0)) throw new RangeError('step_m must be a positive number of metres');
  const pts = _finite(line);
  if (!pts.length) return [[], 0.0];

  const maxGap = !maxGapM ? Infinity : Number(maxGapM);
  const out = [pts[0]];
  let lenM = 0.0;
  let carry = 0.0;    // distance already walked past the last node, carried across vertices
  for (let i = 0; i + 1 < pts.length; i++) {
    const [aLat, aLng] = pts[i], [bLat, bLng] = pts[i + 1];
    const d = distM(aLat, aLng, bLat, bLng);
    if (!(d > 0)) continue;
    if (d > maxGap) {
      out.push([bLat, bLng]);
      carry = 0.0;
      continue;
    }
    lenM += d;
    let t = stepM - carry;
    while (t <= d) {
      const f = t / d;
      out.push([aLat + (bLat - aLat) * f, aLng + (bLng - aLng) * f]);
      t += stepM;
    }
    carry = (carry + d) % stepM;
  }

  const last = pts[pts.length - 1], end = out[out.length - 1];
  if (distM(end[0], end[1], last[0], last[1]) > stepM * 0.5) out.push(last);
  return [out, lenM];
}

// [min_lat, min_lng, max_lat, max_lng], or null for an empty line.
export function bboxOf(coords) {
  if (!coords || !coords.length) return null;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [lat, lng] of coords) {
    if (lat < a) a = lat;
    if (lng < b) b = lng;
    if (lat > c) c = lat;
    if (lng > d) d = lng;
  }
  return [a, b, c, d];
}

const _near = (a, b, tolM) => distM(a[0], a[1], b[0], b[1]) <= tolM;

function _lineLen(pts) {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) s += distM(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
  return s;
}

// ---------------------------------------------------------------------------
// segments
// ---------------------------------------------------------------------------

// One OSM way, resampled. Node i is coords[i] and hit-mask byte i.
//
// `len_m` is the true polyline length, not step * nodes -- coverage converts back
// to metres through it, so a way that ends in a short stub is not credited with a
// full node's worth of distance. (Python's dataclass; a plain object here.)
export function Segment({ id, coords, len_m = 0.0, name = null, kind = 'path', motor = false,
                          bbox = null, region = null }) {
  return { id, coords, len_m, name, kind, motor, bbox, region };
}

// Access tags that mean "you may" rather than "you may not". OSM writes several
// flavours of yes and they all count the same here.
const _YES = new Set(['yes', 'designated', 'permissive', 'official', 'customers']);

// OSM tags -> [kind, motor].
//
// `kind` is the filter bucket the UI offers: path, track, cycleway, bridleway,
// steps, sidewalk. `motor` flags ways that quads, sleds or dirt bikes are allowed
// on, which is the difference between a trail and a road with mud on it. A track
// counts as motorised unless the tagging explicitly says no -- that is what a
// track *is*.
export function wayKind(tags) {
  tags = tags || {};
  const h = tags.highway || '';
  let kind;
  if (['track', 'cycleway', 'bridleway', 'steps'].includes(h)) kind = h;
  else if (h === 'footway' && (tags.footway === 'sidewalk' || tags.footway === 'crossing')) kind = 'sidewalk';
  else kind = 'path';
  const motor = (_YES.has(tags.atv)
                 || _YES.has(tags.snowmobile)
                 || _YES.has(tags.motor_vehicle)
                 || _YES.has(tags.motorcycle)
                 || (h === 'track' && ('motor_vehicle' in tags ? tags.motor_vehicle : '') !== 'no'));
  return [kind, Boolean(motor)];
}

// Which trail a segment belongs to: 'n:<name>' or 'w:<way id>'.
//
// Name is the identity, lowercased so "Bruce trail" and "Bruce Trail" are one
// trail. Unnamed ways stand alone under their own id -- pooling them would build a
// single unfinishable mega-trail out of every scrap of dirt in the county.
export function trailKey(seg) {
  return seg.name ? 'n:' + seg.name.toLowerCase() : 'w:' + String(seg.id);
}

// Overpass JSON -> [Segment]. Ways inherit a name from their route relation.
//
// Most of a long-distance trail's ways carry no name of their own; the name lives
// on the route relation they belong to. Without this, the Bruce Trail is four
// hundred anonymous paths.
//
// A way can belong to several routes, so hiking and foot routes outrank the rest:
// a path that is both a hiking route and a cycle route is, to someone on foot, the
// hiking route. The way's own name always wins over any of them.
export function segmentsFromOverpass(data, region = null) {
  const elements = (data || {}).elements || [];

  const relName = new Map();    // way id -> [name, preference]
  for (const el of elements) {
    if (el.type !== 'relation') continue;
    const tags = el.tags || {};
    const name = tags.name;
    if (!name) continue;
    const pref = (tags.route === 'hiking' || tags.route === 'foot') ? 2 : 1;
    for (const m of el.members || []) {
      if (m.type !== 'way') continue;
      const ref = String(m.ref);
      const have = relName.get(ref);
      if (have === undefined || have[1] < pref) relName.set(ref, [name, pref]);
    }
  }

  const out = [];
  for (const el of elements) {
    if (el.type !== 'way') continue;
    const geometry = el.geometry || [];
    if (geometry.length < 2) continue;
    const [coords, lenM] = resample(geometry.map(p => [p.lat, p.lon]), NODE_STEP_M);
    if (coords.length < 2) continue;    // under half a node step long: a stub, not a trail
    const tags = el.tags || {};
    const [kind, motor] = wayKind(tags);
    const wayId = String(el.id);
    let name = tags.name ?? null;
    if (!name && relName.has(wayId)) name = relName.get(wayId)[0];
    out.push(Segment({ id: wayId, coords, len_m: lenM, name, kind, motor,
                       bbox: bboxOf(coords), region }));
  }
  return out;
}

// ---------------------------------------------------------------------------
// spatial index and matching
// ---------------------------------------------------------------------------

// Hash-grid spatial index over trail nodes, sized from the tolerance.
// -> {segs, cells: Map('row,col' -> [[segment index, node index], ...]), cell_lat, cell_lng, tol_m}
//
// Cells are at least 1.6x the tolerance wide, so the 3x3 neighbourhood of a track
// point always contains everything within tolerance of it. That is what lets
// markHits() compare each track point against a few dozen candidates instead of
// every node in the county.
export function buildIndex(segs, tolM = DEFAULT_TOL_M) {
  const cellM = Math.max(60.0, tolM * 1.6);

  // ponytail: one reference latitude sizes the whole grid, so cells stretch if a
  // region ever spans several degrees of latitude -- harmless (cells only have to
  // be roughly square), but split the index into latitude bands if someone loads
  // a whole country.
  let refLat = 44.0;
  for (const s of segs) {
    if (s.coords && s.coords.length) { refLat = s.coords[0][0]; break; }
  }

  const cellLat = cellM / M_PER_DEG_LAT;
  const cellLng = cellM / (M_PER_DEG_LAT * Math.cos(refLat * RAD));
  const cells = new Map();
  segs.forEach((seg, si) => {
    seg.coords.forEach(([lat, lng], ni) => {
      const key = Math.floor(lat / cellLat) + ',' + Math.floor(lng / cellLng);
      let bucket = cells.get(key);
      if (!bucket) cells.set(key, bucket = []);
      bucket.push([si, ni]);
    });
  });
  return { segs: [...segs], cells, cell_lat: cellLat, cell_lng: cellLng, tol_m: Number(tolM) };
}

// Mark every trail node this track passed within tolerance of.
//
// -> {way_id: Uint8Array}, one byte per node of that segment. `coords` should
// already be densified (resample at TRACK_STEP_M): matching is point-to-node, so a
// sparsely recorded track would otherwise stride over nodes it ran past.
export function markHits(index, coords, tolM = null) {
  const tol = tolM ? Number(tolM) : index.tol_m;
  const { segs, cells } = index;
  const hits = {};
  for (const [lat, lng] of _finite(coords)) {
    const ci = Math.floor(lat / index.cell_lat);
    const cj = Math.floor(lng / index.cell_lng);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const [si, ni] of cells.get((ci + di) + ',' + (cj + dj)) || []) {
          const seg = segs[si];
          const node = seg.coords[ni];
          if (distM(lat, lng, node[0], node[1]) > tol) continue;
          let mask = hits[seg.id];
          if (mask === undefined) mask = hits[seg.id] = new Uint8Array(seg.coords.length);
          mask[ni] = 1;
        }
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// coverage
// ---------------------------------------------------------------------------

// OR every activity's hits together. -> {way_id: Uint8Array}.
//
// `allowSeg(way_id)` returns false for segments the current filters exclude
// (wrong region, motorised, sidewalks off). Filtering here rather than at import
// means the toggles are instant and nothing has to be re-matched.
export function unionCoverage(activities, allowSeg = null) {
  const cover = {};
  for (const act of activities) {
    for (const [wayId, mask] of Object.entries(act.hits || {})) {
      if (allowSeg && !allowSeg(wayId)) continue;
      const have = cover[wayId];
      if (have === undefined) {
        cover[wayId] = Uint8Array.from(mask);    // copied: never mutate an activity
        continue;
      }
      const n = Math.min(mask.length, have.length);
      for (let i = 0; i < n; i++) have[i] |= mask[i];
    }
  }
  return cover;
}

// Nodes covered in a hit mask. Bytes are 0 or 1, so a sum is the popcount.
export function countBits(mask) {
  let s = 0;
  for (const b of mask) s += b;
  return s;
}

// Contiguous covered stretches as [[first_node, last_node]], inclusive.
//
// The runs are what a map draws and what "you have done km 0-4 and 7-9" reads
// off; a bare percentage cannot tell a solid half from a dotted whole.
export function coveredRuns(mask) {
  const runs = [], n = mask.length;
  let i = 0;
  while (i < n) {
    if (!mask[i]) { i++; continue; }
    let j = i;
    while (j < n && mask[j]) j++;
    runs.push([i, j - 1]);
    i = j;
  }
  return runs;
}

// ---------------------------------------------------------------------------
// chronology
// ---------------------------------------------------------------------------

const _cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Python str() of an id, so a missing one sorts as "None" did.
const _str = x => (x == null ? 'None' : String(x));

// Replay every activity oldest-first, crediting each node to its first visit.
//
// Running your usual loop twice does not cover it twice, so new ground is the only
// honest per-activity number, and it depends on the order things happened in. One
// pass gives all of it: new metres per outing, the date each trail crossed the
// completion line, and the cumulative curve.
//
// -> {per_act: {activity id: {new_m, new_nodes, finished}},
//     done_on:  {trail key: date the trail was completed},
//     timeline: [{date, cum_m, new_m}] in chronological order,
//     total_m:  metres of distinct trail covered}
export function chronology(activities, segments, allowSeg = null, keyFn = trailKey,
                           completeAt = DEFAULT_COMPLETE_AT) {
  const info = new Map(), trailTotal = new Map();
  for (const s of segments) {
    if (allowSeg && !allowSeg(s.id)) continue;
    const n = s.coords.length;
    const key = keyFn(s);
    // Metres per node, so a partial mask converts to distance without walking the
    // geometry again.
    info.set(String(s.id), [n, n ? s.len_m / n : 0.0, key]);
    trailTotal.set(key, (trailTotal.get(key) || 0) + n);
  }

  // Undated activities sort last -- they cannot claim first touch of anything a
  // dated outing already reached. Id breaks ties so the result is stable.
  const order = [...activities].sort((a, b) =>
    _cmp(String(a.date || '9999'), String(b.date || '9999')) || _cmp(_str(a.id), _str(b.id)));

  const seen = new Map(), trailHit = new Map();   // way id -> nodes ever hit; trail key -> node count
  const perAct = {}, doneOn = {}, timeline = [];
  let cumM = 0.0;
  for (const act of order) {
    let newM = 0.0, newNodes = 0;
    const finished = [];
    for (const [wayId, mask] of Object.entries(act.hits || {})) {
      const inf = info.get(wayId);
      if (inf === undefined) continue;    // filtered out, or from an unloaded region
      const [n, mPerNode, key] = inf;
      let cur = seen.get(wayId);
      if (cur === undefined) seen.set(wayId, cur = new Uint8Array(n));
      let add = 0;
      const m = Math.min(mask.length, cur.length);
      for (let k = 0; k < m; k++) {
        if (mask[k] && !cur[k]) { cur[k] = 1; add++; }
      }
      if (!add) continue;
      newNodes += add;
      newM += add * mPerNode;
      const before = trailHit.get(key) || 0;
      const after = before + add;
      const total = trailTotal.get(key) || 1;
      trailHit.set(key, after);
      // The crossing, not the state: a trail is finished once, on the day the
      // outing that pushed it over the line happened.
      if (before / total < completeAt && completeAt <= after / total) {
        doneOn[key] = act.date || '';
        finished.push(key);
      }
    }
    cumM += newM;
    perAct[act.id] = { new_m: newM, new_nodes: newNodes, finished };
    timeline.push({ date: act.date || '', cum_m: cumM, new_m: newM });
  }
  return { per_act: perAct, done_on: doneOn, timeline, total_m: cumM };
}

// Python's date.fromisoformat for the 'YYYY-MM-DD' form; null if it will not parse.
function _isoDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = fromDay(s);
  return dayKey(d) === s ? s : null;    // rejects 2026-02-30 and friends
}

// Whole days from ISO date `a` to ISO date `b`. null if either will not parse.
export function dayDiff(a, b) {
  const x = _isoDay(a), y = _isoDay(b);
  return x === null || y === null ? null : daysBetween(x, y);
}

// Consecutive-day runs over the days that broke new ground.
//
// -> {current, best, days}. The current streak only counts when the last
// new-ground day was today or yesterday; anything older is a streak you have
// already lost, and displaying it would be a lie.
//
// `today` is a parameter rather than a look at the clock, so the result is
// testable and so a caller can ask what this looked like back in June.
export function streaks(days, today = null) {
  const uniq = [...new Set(days.filter(d => d))].sort(_cmp);
  let best = 0, run = 0, prev = null;
  for (const d of uniq) {
    run = (prev && dayDiff(prev, d) === 1) ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  let current = 0;
  if (uniq.length) {
    const gap = dayDiff(uniq[uniq.length - 1], today || dayKey(new Date()));
    current = (gap === 0 || gap === 1) ? run : 0;
  }
  return { current, best, days: uniq.length };
}

// Total metres climbed over an elevation stream. -> integer.
//
// Barometric and GPS altitude wander by a metre while you stand still, so a rise
// has to clear `minStep` before it counts -- otherwise a flat run climbs a hundred
// metres of noise. Pass 0 for a line drawn off a smooth elevation model, which
// would otherwise lose a third of its real climb to the filter.
export function climbM(eles, minStep = 1.0) {
  const vals = eles.filter(e => typeof e === 'number' && Number.isFinite(e));
  let up = 0;
  for (let i = 0; i + 1 < vals.length; i++) {
    const d = vals[i + 1] - vals[i];
    if (d > minStep) up += d;
  }
  return Math.trunc(up + 0.5);    // half up, as Math.round; never Python's half-to-even
}

// ---------------------------------------------------------------------------
// stitching
// ---------------------------------------------------------------------------

// Chain a trail's ways end to end. -> [{pts: [[lat, lng]...], len_m}].
//
// A trail arrives as an unordered bag of OSM ways pointing whichever way the
// mapper drew them. Reading it as "km 4 to km 9", or handing it to a watch, needs
// them in order. Greedy and longest-first, so chains grow out from the trail's
// spine; a way whose ends meet nothing stays its own chain, which is exactly what
// a spur or a gap in the mapping is.
export function stitchTrail(segs, joinTolM = JOIN_TOL_M) {
  const pool = segs.filter(s => s.coords.length > 1).map(s => [...s.coords]);
  pool.sort((a, b) => b.length - a.length);
  const chains = [];
  while (pool.length) {
    let chain = pool.shift();
    let grew = true;
    while (grew) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const g = pool[i];
        const start = chain[0], end = chain[chain.length - 1];
        // The shared point is dropped from the piece being added, so a junction
        // does not become a zero-length duplicate node.
        if (_near(end, g[0], joinTolM)) chain = chain.concat(g.slice(1));
        else if (_near(end, g[g.length - 1], joinTolM)) chain = chain.concat(g.slice(0, -1).reverse());
        else if (_near(start, g[g.length - 1], joinTolM)) chain = g.slice(0, -1).concat(chain);
        else if (_near(start, g[0], joinTolM)) chain = g.slice(1).reverse().concat(chain);
        else continue;
        pool.splice(i, 1);
        grew = true;
        break;
      }
    }
    chains.push({ pts: chain, len_m: _lineLen(chain) });
  }
  chains.sort((a, b) => b.len_m - a.len_m);
  return chains;
}
