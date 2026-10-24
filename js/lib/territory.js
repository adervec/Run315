// intvl -- the territory game.
//
// Every run claims the map tiles it passes through. Ground you have never covered
// stays fogged. The scores are the ones that make you plan routes differently:
// total tiles, the biggest solid square you own, and the biggest connected blob.
//
// Pure functions over (lat, lon) points and tile sets. No I/O, no dependencies.
// See test/territory.test.mjs.
//
// JS shapes: a tile is an [x, y] array. Python's tile *sets* are arrays of
// [x, y] here (deduplicated, JSON-safe); any iterable of [x, y] is accepted as
// input. Membership uses "x,y" string keys internally.

// Web Mercator slippy tiles. z17 is ~305 m at the equator, which is the right
// grain for running: a tile is a block or two, so a new street is a new tile.
export const DEFAULT_ZOOM = 17;
export const MERCATOR_LIMIT = 85.05112878;          // Web Mercator is undefined past this

// "x,y" key for set membership (Python used the tuple itself).
export const tileKey = (x, y) => x + ',' + y;
const fromKey = k => k.split(',').map(Number);
// Any iterable of [x, y] -> Set of keys.
export function keySet(tiles) {
  const s = new Set();
  for (const t of tiles || []) s.add(tileKey(t[0], t[1]));
  return s;
}
// Deduplicated array of [x, y], first occurrence order.
const uniq = tiles => [...keySet(tiles)].map(fromKey);
const cmpTile = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);

// Python float(): numbers pass, numeric strings parse, anything else is NaN.
function toFloat(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return +v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

// (lat, lon) -> [x, y] slippy tile. null if the point is not on Earth.
export function tileFor(lat, lon, zoom = DEFAULT_ZOOM) {
  if (lat == null || lon == null) return null;
  lat = toFloat(lat); lon = toFloat(lon);
  // NaN fails every comparison, so this also rejects junk and NaN
  if (!(-180.0 <= lon && lon <= 180.0) || !(-90.0 <= lat && lat <= 90.0)) return null;
  lat = Math.max(-MERCATOR_LIMIT, Math.min(MERCATOR_LIMIT, lat));
  const n = 2 ** zoom;
  const x = Math.trunc((lon + 180.0) / 360.0 * n);
  const rad = lat * Math.PI / 180;
  const y = Math.trunc((1.0 - Math.asinh(Math.tan(rad)) / Math.PI) / 2.0 * n);
  return [Math.min(x, n - 1), Math.min(Math.max(y, 0), n - 1)];
}

// (x, y) -> [south, west, north, east] in degrees, for drawing the square.
export function tileBounds(x, y, zoom = DEFAULT_ZOOM) {
  const n = 2.0 ** zoom;
  const latAt = ty => Math.atan(Math.sinh(Math.PI * (1.0 - 2.0 * ty / n))) * 180 / Math.PI;
  return [latAt(y + 1), x / n * 360.0 - 180.0, latAt(y), (x + 1) / n * 360.0 - 180.0];
}

// Ground width of a tile at this row, in metres. Shrinks toward the poles.
export function tileSizeM(y, zoom = DEFAULT_ZOOM) {
  const [south, , north] = tileBounds(0, y, zoom);
  const midLat = (south + north) / 2.0;
  return 40075016.686 * Math.cos(midLat * Math.PI / 180) / (2.0 ** zoom);
}

// [[lat, lon], ...] -> array of tiles the track touches.
//
// Consecutive points are bridged, so a fast-moving or sparsely sampled track
// does not leave holes in the trail of tiles it obviously ran through.
export function tilesForTrack(points, zoom = DEFAULT_ZOOM) {
  const claimed = new Map();
  let prev = null;
  for (const p of points || []) {
    if (!p || p.length < 2) continue;
    const t = tileFor(p[0], p[1], zoom);
    if (t === null) continue;
    if (prev !== null && (t[0] !== prev[0] || t[1] !== prev[1])) {
      for (const b of _bridge(prev, t)) claimed.set(tileKey(b[0], b[1]), b);
    }
    claimed.set(tileKey(t[0], t[1]), t);
    prev = t;
  }
  return [...claimed.values()];
}

// Tiles on the straight line between two tiles (Bresenham).
//
// A jump longer than `maxSpan` tiles is a GPS glitch or a drive between two
// runs, not a route -- those endpoints are kept but the gap is not filled in.
function _bridge(a, b, maxSpan = 64) {
  let [x0, y0] = a;
  const [x1, y1] = b;
  if (Math.abs(x1 - x0) > maxSpan || Math.abs(y1 - y0) > maxSpan) return [a, b];

  const out = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    out.push([x0, y0]);
    if (x0 === x1 && y0 === y1) return out;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// --------------------------------------------------------------------------- //
// scores
// --------------------------------------------------------------------------- //

// Largest solid n x n block of claimed tiles. -> [n, [x, y] of its top-left].
//
// Classic largest-square DP, but over a sparse map so the empty ocean between
// your home and everywhere else costs nothing.
export function maxSquare(tiles) {
  const list = uniq(tiles);
  if (!list.length) return [0, null];
  const dp = new Map();
  let best = 0, corner = null;
  list.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));
  for (const [x, y] of list) {
    const n = 1 + Math.min(dp.get(tileKey(x - 1, y)) || 0,
                           dp.get(tileKey(x, y - 1)) || 0,
                           dp.get(tileKey(x - 1, y - 1)) || 0);
    dp.set(tileKey(x, y), n);
    if (n > best) { best = n; corner = [x - n + 1, y - n + 1]; }
  }
  return [best, corner];
}

// Largest 4-connected group of claimed tiles. -> [size, tiles].
export function maxCluster(tiles) {
  const remaining = keySet(tiles);
  let best = [];
  while (remaining.size) {
    const seed = remaining.values().next().value;
    remaining.delete(seed);
    const group = [seed], queue = [seed];
    for (let qi = 0; qi < queue.length; qi++) {
      const [x, y] = fromKey(queue[qi]);
      for (const n of [tileKey(x + 1, y), tileKey(x - 1, y), tileKey(x, y + 1), tileKey(x, y - 1)]) {
        if (remaining.has(n)) {
          remaining.delete(n);
          group.push(n);
          queue.push(n);
        }
      }
    }
    if (group.length > best.length) best = group;
  }
  return [best.length, best.map(fromKey)];
}

// Every tile inside a maxSquare() result, for drawing it.
export function squareTiles(size, corner) {
  if (!size || !corner) return [];
  const [x0, y0] = corner, out = [];
  for (let dx = 0; dx < size; dx++) for (let dy = 0; dy < size; dy++) out.push([x0 + dx, y0 + dy]);
  return out;
}

// Unclaimed tiles touching claimed ones -- the edge of your fog. Sorted.
export function frontier(tiles, limit = null) {
  const have = keySet(tiles), edge = new Set();
  for (const k of have) {
    const [x, y] = fromKey(k);
    for (const n of [tileKey(x + 1, y), tileKey(x - 1, y), tileKey(x, y + 1), tileKey(x, y - 1)]) {
      if (!have.has(n)) edge.add(n);
    }
  }
  const out = [...edge].map(fromKey).sort(cmpTile);
  return limit == null ? out : out.slice(0, limit);
}

export const _MAX_GAP = 6;      // a window needing more than this is not a near miss

// Every `size` x `size` window missing between 1 and `maxGap` tiles.
//
// -> [[missingTiles, corner]], cheapest first. A 2D prefix sum counts each
// window in constant time, so this stays fast over a whole city.
export function nearMissSquares(tiles, size, maxGap = _MAX_GAP) {
  const have = keySet(tiles);
  if (!have.size || size < 1) return [];
  const list = [...have].map(fromKey);
  const xs = list.map(t => t[0]), ys = list.map(t => t[1]);
  const x0 = Math.min(...xs) - size + 1, x1 = Math.max(...xs);
  const y0 = Math.min(...ys) - size + 1, y1 = Math.max(...ys);
  const w = x1 - x0 + size, h = y1 - y0 + size;

  // ps[j][i] = claimed tiles in the rectangle above-left of (x0+i, y0+j)
  const ps = Array.from({ length: h + 1 }, () => new Array(w + 1).fill(0));
  for (let j = 0; j < h; j++) {
    const row = ps[j + 1], prev = ps[j];
    for (let i = 0; i < w; i++) {
      row[i + 1] = row[i] + prev[i + 1] - prev[i] + (have.has(tileKey(x0 + i, y0 + j)) ? 1 : 0);
    }
  }

  const out = [];
  for (let j = 0; j < h - size + 1; j++) {
    for (let i = 0; i < w - size + 1; i++) {
      const got = ps[j + size][i + size] - ps[j][i + size] - ps[j + size][i] + ps[j][i];
      const gap = size * size - got;
      if (gap >= 1 && gap <= maxGap) {
        const cx = x0 + i, cy = y0 + j, missing = [];
        for (let dx = 0; dx < size; dx++) {
          for (let dy = 0; dy < size; dy++) {
            if (!have.has(tileKey(cx + dx, cy + dy))) missing.push([cx + dx, cy + dy]);
          }
        }
        out.push([missing, [cx, cy]]);
      }
    }
  }
  out.sort((a, b) => (a[0].length - b[0].length) || cmpTile(a[1], b[1]));
  return out;
}

// Which unclaimed tiles would grow your max square, and what it takes.
//
// This is the question the game actually asks: not "where have I not been"
// but "where do I run to make the square bigger".
// -> [[tile, newSize, tilesStillNeeded]], easiest win first.
export function squareGrowthTargets(tiles, limit = 12) {
  if (!keySet(tiles).size) return [];
  const target = maxSquare(tiles)[0] + 1;
  const best = new Map();          // key -> [tile, cost]
  for (const [missing] of nearMissSquares(tiles, target)) {
    for (const m of missing) {
      const k = tileKey(m[0], m[1]), cur = best.get(k);
      if (!cur || missing.length < cur[1]) best.set(k, [m, missing.length]);
    }
  }
  const ranked = [...best.values()].sort((a, b) => (a[1] - b[1]) || cmpTile(a[0], b[0])).slice(0, limit);
  return ranked.map(([t, cost]) => [t, target, cost]);
}

// The scoreboard.
export function stats(tiles, newTiles = [], zoom = DEFAULT_ZOOM) {
  const list = uniq(tiles), have = keySet(list);
  const [sqSize, sqCorner] = maxSquare(list);
  const [clSize, cluster] = maxCluster(list);
  const rows = list.map(t => t[1]).sort((a, b) => a - b);
  const metres = rows.length ? tileSizeM(rows[rows.length >> 1], zoom) : 0.0;
  let fresh = 0;
  for (const k of keySet(newTiles)) if (!have.has(k)) fresh++;
  return {
    tiles: list.length,
    new_tiles: fresh,
    max_square: sqSize,
    square_corner: sqCorner,
    max_cluster: clSize,
    cluster,
    tile_metres: metres,
    area_km2: list.length * (metres / 1000.0) ** 2,
    zoom,
  };
}

// What share of a square area around `centre` you have claimed. 0..1.
export function areaCoverage(tiles, centre, radiusTiles = 12) {
  if (!centre) return null;
  const [cx, cy] = centre, have = keySet(tiles);
  const total = (radiusTiles * 2 + 1) ** 2;
  let got = 0;
  for (let dx = -radiusTiles; dx <= radiusTiles; dx++) {
    for (let dy = -radiusTiles; dy <= radiusTiles; dy++) if (have.has(tileKey(cx + dx, cy + dy))) got++;
  }
  return got / total;
}

// Most-visited tile -- where you start from. -> tile.
// Python took {tile: times_run}; here a Map of [x, y] -> count, an array of
// [tile, count] entries, or a plain object keyed "x,y".
export function homeTile(tilesWithCounts) {
  if (!tilesWithCounts) return null;
  const entries = tilesWithCounts instanceof Map || Array.isArray(tilesWithCounts)
    ? [...tilesWithCounts]
    : Object.entries(tilesWithCounts).map(([k, v]) => [fromKey(k), v]);
  let best = null;
  // max by (count, tile): ties on count go to the larger tile, as in Python
  for (const [t, n] of entries) {
    if (best === null || n > best[1] || (n === best[1] && cmpTile(t, best[0]) > 0)) best = [t, n];
  }
  return best ? best[0] : null;
}
