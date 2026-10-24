// Things worth knowing about along a route.
//
// Toilets, water, coffee, beaches, pools. The map layers a runner actually plans
// around, pulled from OpenStreetMap.
//
// One rule holds this together: the match rules below are the single source of
// truth. The Overpass selector for a layer is *generated* from the same rules used
// to label the results, so the query and the labelling can never drift apart.
//
// Pure functions. No I/O, no dependencies.
import { pyRound } from './py.js';

// Radius around the route corridor, in metres. A toilet has to be close enough to
// be worth the detour; a beach is worth knowing about from further away.
export const NEAR = 120;
export const WIDE = 300;

// Values of `fee` and `access` that mean "not simply free to walk into".
export const PAID = new Set(['yes', 'some']);
export const SHUT = new Set(['private', 'customers', 'permit', 'no', 'members']);

const _cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const _has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// One toggleable map layer.
//
// `match` is a list of tag sets; an element belongs to this layer if it matches
// any one of them completely. A value of null means "this key, any value".
export function Layer(id, label, icon, group, match, radius = NEAR, fee_matters = false) {
  return {
    id, label, icon, group, match, radius,
    fee_matters,     // worth filtering by "free only"
    // OverpassQL tag selectors for this layer, one per match set.
    selectors() {
      return this.match.map(rule =>
        Object.entries(rule)
          .sort((a, b) => _cmp(a[0], b[0]) || _cmp(String(a[1]), String(b[1])))
          .map(([k, v]) => (v === null ? `["${k}"]` : `["${k}"="${v}"]`))
          .join(''));
    },
    matches(tags) {
      return this.match.some(rule =>
        Object.entries(rule).every(([k, v]) => (v !== null ? _has(tags, k) && tags[k] === v : _has(tags, k))));
    },
  };
}

// Order matters: the first layer that matches an element wins, so the specific
// ones (a coffee shop) come before the general ones (somewhere that sells food).
export const LAYERS = [
  // --- the body ---
  Layer('toilets', 'Toilets', '\u{1F6BB}', 'Body',
        [{ amenity: 'toilets' }], NEAR, true),
  Layer('water', 'Drinking water', '\u{1F6B0}', 'Body',
        [{ amenity: 'drinking_water' },
         { man_made: 'water_tap', drinking_water: 'yes' },
         { amenity: 'fountain', drinking_water: 'yes' }]),
  Layer('shower', 'Showers', '\u{1F6BF}', 'Body',
        [{ amenity: 'shower' }], NEAR, true),
  Layer('pharmacy', 'Pharmacy', '\u{1F48A}', 'Body',
        [{ amenity: 'pharmacy' }]),

  // --- fuel ---
  Layer('coffee', 'Coffee', '☕', 'Fuel',
        [{ amenity: 'cafe' }, { shop: 'coffee' }, { cuisine: 'coffee_shop' }]),
  Layer('food', 'Food', '\u{1F374}', 'Fuel',
        [{ amenity: 'restaurant' }, { amenity: 'fast_food' }]),
  Layer('shop', 'Shops', '\u{1F3EA}', 'Fuel',
        [{ shop: 'convenience' }, { shop: 'supermarket' }, { shop: 'bakery' }]),

  // --- water ---
  Layer('beach', 'Beaches', '\u{1F3D6}', 'Water',
        [{ natural: 'beach' }, { leisure: 'beach_resort' }], WIDE),
  Layer('waterpark', 'Water parks', '\u{1F3A2}', 'Water',
        [{ leisure: 'water_park' }], WIDE),
  Layer('pool', 'Pools & lidos', '\u{1F3CA}', 'Water',
        [{ leisure: 'swimming_pool' }, { leisure: 'swimming_area' }],
        WIDE, true),

  // --- getting round ---
  Layer('viewpoint', 'Viewpoints', '\u{1F5FB}', 'Along the way',
        [{ tourism: 'viewpoint' }]),
  Layer('shelter', 'Shelter', '⛺', 'Along the way',
        [{ amenity: 'shelter' }]),
  Layer('bench', 'Benches', '\u{1FA91}', 'Along the way',
        [{ amenity: 'bench' }]),
  Layer('playground', 'Playgrounds', '\u{1F6DD}', 'Along the way',
        [{ leisure: 'playground' }], WIDE),
  Layer('bikerepair', 'Bike repair', '\u{1F527}', 'Along the way',
        [{ amenity: 'bicycle_repair_station' }]),
  Layer('parking', 'Parking', '\u{1F17F}', 'Getting there',
        [{ amenity: 'parking' }], WIDE),
  Layer('transit', 'Transit', '\u{1F689}', 'Getting there',
        [{ railway: 'station' }, { railway: 'tram_stop' }, { highway: 'bus_stop' }]),
];

export const BY_ID = Object.fromEntries(LAYERS.map(l => [l.id, l]));
// An around: polyline this long already blankets the route -- more points only
// make the query heavier for the same answer, and Overpass starts refusing.
export const MAX_CORRIDOR_POINTS = 80;
export const MAX_RESULTS = 600;

// [[group name, [layers]]] in catalogue order, for building the UI.
export function groups() {
  const out = [], seen = new Map();
  for (const layer of LAYERS) {
    if (!seen.has(layer.group)) {
      seen.set(layer.group, []);
      out.push([layer.group, seen.get(layer.group)]);
    }
    seen.get(layer.group).push(layer);
  }
  return out;
}

// true / false / null (nobody has said). Only meaningful where fee matters.
export function isFree(tags) {
  const fee = String(tags.fee || '').trim().toLowerCase();
  const access = String(tags.access || '').trim().toLowerCase();
  if (SHUT.has(access)) return false;
  if (PAID.has(fee)) return false;
  if (fee === 'no' || access === 'yes' || access === 'public' || access === 'permissive') return true;
  return null;
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

// Evenly reduce a route to at most `limit` points, keeping both ends.
export function thin(points, limit = MAX_CORRIDOR_POINTS) {
  const clean = [];
  for (const p of points || []) {
    if (!p || !(p.length >= 2)) continue;
    const lat = _float(p[0]), lon = _float(p[1]);
    if (lat === null || lon === null) continue;
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
    if (lat >= -90.0 && lat <= 90.0 && lon >= -180.0 && lon <= 180.0) clean.push([lat, lon]);
  }
  if (clean.length <= limit) return clean;
  const step = (clean.length - 1) / (limit - 1);
  const out = [];
  for (let i = 0; i < limit; i++) out.push(clean[pyRound(i * step)]);
  return out;
}

// OverpassQL for every requested layer along a route corridor.
//
// All layers go in one union so this is a single request no matter how many boxes
// are ticked -- Overpass is donated infrastructure and one query that asks for
// everything is far kinder than fifteen that each ask for one thing.
export function buildQuery(points, layerIds, timeout = 60) {
  const corridor = thin(points);
  if (corridor.length < 2) return null;
  const wanted = layerIds.filter(i => _has(BY_ID, i)).map(i => BY_ID[i]);
  if (!wanted.length) return null;

  const line = corridor.map(([lat, lon]) => lat.toFixed(5) + ',' + lon.toFixed(5)).join(',');
  const parts = [];
  for (const layer of wanted) {
    for (const sel of layer.selectors()) {
      // nwr, not node: a beach or a pool is an area, not a pin.
      parts.push(`nwr(around:${Math.trunc(layer.radius)},${line})${sel};`);
    }
  }
  return `[out:json][timeout:${Math.trunc(timeout)}];(${parts.join('')});out center tags ${MAX_RESULTS};`;
}

// Which layer an element belongs to, or null.
export function classify(tags) {
  for (const layer of LAYERS) if (layer.matches(tags)) return layer;
  return null;
}

// Overpass JSON -> [{lat, lon, layer, icon, name, free, fee_matters, hours, wheelchair}].
//
// Elements are labelled by re-matching their tags, so a cafe that came back
// because it is also a shop still lands in exactly one layer.
export function parse(data, layerIds = null, freeOnly = false) {
  const allowed = layerIds && layerIds.length ? new Set(layerIds) : null;
  const out = [], seen = new Set();
  for (const el of (data || {}).elements || []) {
    const tags = el.tags || {};
    const layer = classify(tags);
    if (!layer || (allowed && !allowed.has(layer.id))) continue;

    let lat = el.lat, lon = el.lon;
    if (lat == null || lon == null) {             // ways and relations
      const centre = el.center || {};
      lat = centre.lat; lon = centre.lon;
    }
    if (lat == null || lon == null) continue;

    const free = layer.fee_matters ? isFree(tags) : null;
    if (freeOnly && layer.fee_matters && free === false) continue;

    const key = JSON.stringify([el.type ?? null, el.id ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      lat: pyRound(Number(lat), 6),
      lon: pyRound(Number(lon), 6),
      layer: layer.id,
      icon: layer.icon,
      name: String(tags.name || '').trim() || layer.label,
      free,
      fee_matters: layer.fee_matters,
      hours: String(tags.opening_hours || '').trim() || null,
      wheelchair: tags.wheelchair ?? null,
    });
  }
  return out;
}
