// Self-check for the territory game (port of test_territory.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/lib/territory.js';

// Tile "sets" are arrays of [x, y]; compare them as sets of keys.
const K = tiles => T.keySet(tiles);
const sameSet = (a, b) => assert.deepEqual([...K(a)].sort(), [...K(b)].sort());
const subset = (a, b) => { const bb = K(b); return [...K(a)].every(k => bb.has(k)); };
const has = (tiles, t) => K(tiles).has(T.tileKey(t[0], t[1]));
const block = (xr, yr) => { const o = []; for (const x of xr) for (const y of yr) o.push([x, y]); return o; };
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);
const rad = d => d * Math.PI / 180;

// The OSM wiki formula, written out independently of territory.js.
function referenceTile(lat, lon, zoom) {
  const n = 2 ** zoom, r = rad(lat);
  const x = Math.trunc((lon + 180.0) / 360.0 * n);
  const y = Math.trunc((1.0 - Math.log(Math.tan(r) + 1.0 / Math.cos(r)) / Math.PI) / 2.0 * n);
  return [x, y];
}

test('test_tile_for_matches_the_reference_formula', () => {
  for (const [lat, lon] of [[51.4779, -0.0015], [47.3769, 8.5417], [-33.8688, 151.2093],
                            [40.7128, -74.0060], [0.0, 0.0], [60.1699, 24.9384]]) {
    for (const zoom of [12, 14, 17]) {
      assert.deepEqual(T.tileFor(lat, lon, zoom), referenceTile(lat, lon, zoom), String([lat, lon, zoom]));
    }
  }
});

test('test_tile_for_known_points', () => {
  // Greenwich observatory sits just west of the prime meridian, so it lands in
  // the last tile of the western half.
  const [x] = T.tileFor(51.4779, -0.0015, 17);
  assert.equal(x, Math.floor(2 ** 17 / 2) - 1);
  // Tile 0,0 is the top-left of the world.
  assert.deepEqual(T.tileFor(85.0, -179.999, 1), [0, 0]);
  assert.deepEqual(T.tileFor(-85.0, 179.999, 1), [1, 1]);
  // Zoom 0 is one tile for the whole planet.
  assert.deepEqual(T.tileFor(47.37, 8.54, 0), [0, 0]);
});

test('test_tile_for_rejects_junk', () => {
  assert.equal(T.tileFor(null, 8.0), null);
  assert.equal(T.tileFor(47.0, null), null);
  assert.equal(T.tileFor('nope', 8.0), null);
  assert.equal(T.tileFor(47.0, 500.0), null);
  assert.equal(T.tileFor(200.0, 8.0), null);
  assert.equal(T.tileFor(NaN, 8.0), null);
  // Beyond the Mercator limit clamps rather than exploding.
  assert.notEqual(T.tileFor(89.9, 0.0, 5), null);
});

test('test_tile_bounds_round_trip', () => {
  const lat = 47.3769, lon = 8.5417;                       // Zurich
  const [x, y] = T.tileFor(lat, lon);
  const [south, west, north, east] = T.tileBounds(x, y);
  assert.ok(south < lat && lat < north, String([south, lat, north]));
  assert.ok(west < lon && lon < east, String([west, lon, east]));
  // Neighbouring tiles share an edge exactly.
  assert.ok(Math.abs(T.tileBounds(x + 1, y)[1] - east) < 1e-9);
});

test('test_tile_size_shrinks_toward_the_poles', () => {
  const equator = T.tileSizeM(T.tileFor(0.0, 0.0)[1]);
  const zurich = T.tileSizeM(T.tileFor(47.0, 8.0)[1]);
  assert.ok(290 < equator && equator < 320, String(equator));   // ~305 m at z17
  assert.ok(zurich < equator);
  assert.ok(Math.abs(zurich - equator * Math.cos(rad(47.0))) < 5);
});

test('test_tiles_for_track_bridges_gaps', () => {
  // Two points far apart in tile terms must leave a continuous trail.
  const a = [47.3769, 8.5417], b = [47.3769, 8.5600];
  const claimed = T.tilesForTrack([a, b]);
  const xs = claimed.map(t => t[0]).sort((p, q) => p - q);
  assert.ok(claimed.length > 3);
  assert.deepEqual(xs, range(xs[0], xs[xs.length - 1] + 1), 'gap in the bridged trail');
  assert.ok(new Set(claimed.map(t => t[1])).size <= 2);        // same latitude, one row
});

test('test_tiles_for_track_ignores_teleports', () => {
  // A GPS glitch across the country must not paint a line through it.
  const near = T.tilesForTrack([[47.37, 8.54], [47.371, 8.541]]);
  const far = T.tilesForTrack([[47.37, 8.54], [52.52, 13.40]]);   // Zurich -> Berlin
  assert.equal(far.length, 2, String(far.length));
  assert.ok(near.length >= 2);
});

test('test_tiles_for_track_edges', () => {
  assert.deepEqual(T.tilesForTrack([]), []);
  assert.deepEqual(T.tilesForTrack([[null, null]]), []);
  assert.deepEqual(T.tilesForTrack([[47.0, 8.0], [47.0, 8.0]]), [T.tileFor(47.0, 8.0)]);
  assert.equal(T.tilesForTrack([[47.0, 8.0], null, [47.0, 8.0]]).length, 1);
});

test('test_max_square', () => {
  assert.deepEqual(T.maxSquare([]), [0, null]);
  assert.deepEqual(T.maxSquare([[5, 5]]), [1, [5, 5]]);

  // A solid 3x3 block.
  const b = block(range(10, 13), range(20, 23));
  const [size, corner] = T.maxSquare(b);
  assert.ok(size === 3);
  assert.deepEqual(corner, [10, 20]);

  // Every 2x2 window inside a 3x3 contains the centre, so losing the centre
  // drops the best square all the way to 1.
  const holed = b.filter(t => !(t[0] === 11 && t[1] === 21));
  assert.equal(T.maxSquare(holed)[0], 1);

  // Losing a corner instead still leaves a 2x2.
  const cornerless = b.filter(t => !(t[0] === 12 && t[1] === 22));
  assert.equal(T.maxSquare(cornerless)[0], 2);

  // A long thin line is never more than 1.
  assert.equal(T.maxSquare(range(0, 50).map(x => [x, 0]))[0], 1);

  // The reported corner really is the top-left of a solid square.
  const big = [...block(range(0, 4), range(0, 4)), [100, 100]];
  const [s2, c2] = T.maxSquare(big);
  assert.equal(s2, 4);
  assert.ok(subset(T.squareTiles(s2, c2), big));
});

test('test_max_cluster', () => {
  assert.deepEqual(T.maxCluster([]), [0, []]);
  // Two islands: 4-connected group of 5, and a lone tile.
  const tiles = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [50, 50]];
  const [size, group] = T.maxCluster(tiles);
  assert.equal(size, 5);
  assert.ok(!has(group, [50, 50]));
  // Diagonals do not connect.
  assert.equal(T.maxCluster([[0, 0], [1, 1]])[0], 1);
});

test('test_frontier', () => {
  assert.deepEqual(T.frontier([]), []);
  const edge = T.frontier([[0, 0]]);
  sameSet(edge, [[1, 0], [-1, 0], [0, 1], [0, -1]]);
  // Interior tiles of a block contribute nothing to the frontier.
  const b = block(range(0, 3), range(0, 3));
  assert.ok(!has(T.frontier(b), [1, 1]));
  assert.equal(T.frontier(b).length, 12);
  assert.equal(T.frontier(b, 5).length, 5);
});

test('test_near_miss_squares', () => {
  // A 3x3 with one hole: exactly one tile completes it.
  const b = block(range(0, 3), range(0, 3)).filter(t => !(t[0] === 1 && t[1] === 1));
  let misses = T.nearMissSquares(b, 3);
  assert.deepEqual(misses[0][0], [[1, 1]]);
  assert.deepEqual(misses[0][1], [0, 0]);
  // A window that is already complete is not a "near miss" -- but windows
  // offset from it still are, which is exactly what growth suggestions need.
  const full = block(range(0, 3), range(0, 3));
  misses = T.nearMissSquares(full, 3);
  const corners = misses.map(([, c]) => T.tileKey(c[0], c[1]));
  assert.ok(!corners.includes(T.tileKey(0, 0)), 'the completed square should not be suggested');
  assert.ok(misses.every(([m]) => 1 <= m.length && m.length <= T._MAX_GAP));
  assert.ok(misses.length, 'offset windows are still reachable');
  assert.deepEqual(T.nearMissSquares([], 3), []);
  assert.deepEqual(T.nearMissSquares(full, 0), []);
});

test('test_square_growth_targets', () => {
  assert.deepEqual(T.squareGrowthTargets([]), []);

  // A solid 2x2. Growing to 3x3 needs 5 more tiles wherever you put it.
  const b = block(range(0, 2), range(0, 2));
  const targets = T.squareGrowthTargets(b);
  assert.ok(targets.length, 'should suggest something');
  assert.ok(targets.every(([, size]) => size === 3));
  assert.ok(targets.every(([t]) => !has(b, t)));
  assert.equal(targets[0][2], 5);

  // An almost-complete 3x3 should suggest the single missing tile first,
  // because that is the cheapest way to reach 3.
  const almost = block(range(0, 3), range(0, 3)).filter(t => !(t[0] === 2 && t[1] === 2));
  const best = T.squareGrowthTargets(almost);
  assert.ok(best[0][1] === 3 && best[0][2] === 1);
  assert.deepEqual(best[0][0], [2, 2]);
});

test('test_stats_and_coverage', () => {
  const tiles = block(range(0, 4), range(0, 4));
  const s = T.stats(tiles);
  assert.equal(s.tiles, 16);
  assert.equal(s.max_square, 4);
  assert.equal(s.max_cluster, 16);
  assert.ok(s.area_km2 > 0);
  assert.equal(s.zoom, T.DEFAULT_ZOOM);
  assert.equal(s.new_tiles, 0);

  // new_tiles counts only what is genuinely new.
  assert.equal(T.stats(tiles, [[0, 0], [99, 99]]).new_tiles, 1);

  const empty = T.stats([]);
  assert.ok(empty.tiles === 0 && empty.max_square === 0 && empty.area_km2 === 0);

  assert.equal(T.areaCoverage(tiles, null), null);
  const full = block(range(-1, 2), range(-1, 2));
  assert.ok(Math.abs(T.areaCoverage(full, [0, 0], 1) - 1.0) < 1e-9);
  assert.equal(T.areaCoverage([], [0, 0], 1), 0.0);
});

test('test_home_tile', () => {
  assert.equal(T.homeTile({}), null);
  assert.equal(T.homeTile(new Map()), null);
  assert.deepEqual(T.homeTile(new Map([[[1, 1], 3], [[2, 2], 9], [[3, 3], 1]])), [2, 2]);
});

test('test_a_real_looking_run_claims_a_sensible_amount', () => {
  // A 5 km loop should claim tens of tiles, not thousands.
  const lat = 47.3769, lon = 8.5417, r = 0.009;              // ~1 km radius circle
  const pts = [];
  for (let i = 0; i < 200; i++) {
    const a = 2 * Math.PI * i / 200;
    pts.push([lat + r * Math.sin(a), lon + r * Math.cos(a) / Math.cos(rad(lat))]);
  }
  const claimed = T.tilesForTrack(pts);
  assert.ok(20 < claimed.length && claimed.length < 200, String(claimed.length));
  assert.equal(T.maxCluster(claimed)[0], claimed.length, 'a loop should be one blob');
});
