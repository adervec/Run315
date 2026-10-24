// Self-check for repeated-route detection (port of test_repeats.py).
//
// The Python fixtures jitter points with random.Random(seed).uniform. Python's
// Mersenne Twister stream is not reproduced here; jitter() uses a seeded
// mulberry32 instead, with the same seeds and the same uniform(-m, m) shape.
// Every assertion is kept as written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../js/lib/repeats.js';
import { keySet } from '../js/lib/territory.js';
import { addDays } from '../js/lib/dt.js';

const HOME = [47.3769, 8.5417];          // Zurich
const M_PER_DEG = 111320.0;
const rad = d => d * Math.PI / 180;
const range = n => Array.from({ length: n }, (_, i) => i);

// Tile "sets" are arrays of [x, y]; set algebra over their keys.
const subsetEq = (a, b) => { const bb = keySet(b); return [...keySet(a)].every(k => bb.has(k)); };
const union = (a, b) => [...a, ...b];
const minus = (a, b) => { const bb = keySet(b); return [...a].filter(t => !bb.has(t[0] + ',' + t[1])); };
const intersects = (a, b) => { const bb = keySet(b); return [...keySet(a)].some(k => bb.has(k)); };

// A circular loop of 2*pi*r metres, sampled n times. -> [points, metres].
function loop(centre = HOME, radiusM = 800.0, n = 400) {
  const [lat, lon] = centre;
  const east = M_PER_DEG * Math.cos(rad(lat));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    pts.push([lat + radiusM * Math.sin(2 * Math.PI * i / n) / M_PER_DEG,
              lon + radiusM * Math.cos(2 * Math.PI * i / n) / east]);
  }
  return [pts, 2 * Math.PI * radiusM];
}

// Straight out due east for half the distance, then back. -> [points, metres].
function outAndBack(centre = HOME, totalM = 5000.0, step = 20.0) {
  const [lat, lon] = centre;
  const east = M_PER_DEG * Math.cos(rad(lat));
  const out = [];
  for (let d = 0.0; d <= totalM / 2.0; d += step) out.push([lat, lon + d / east]);
  return [out.concat([...out].reverse()), totalM];
}

// Seeded PRNG standing in for random.Random(seed).random().
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The same roads recorded on another day: every fix a few metres out.
function jitter(points, metres = 12.0, seed = 1) {
  const rnd = mulberry32(seed);
  const uniform = (a, b) => a + (b - a) * rnd();
  return points.map(([lat, lon]) => [lat + uniform(-metres, metres) / M_PER_DEG,
                                     lon + uniform(-metres, metres) / M_PER_DEG]);
}

function makeRun(gid, day, points, distanceM, movingS) {
  const day0 = new Date(2025, 0, 1);
  return { garmin_id: gid, start: addDays(day0, day),
           distance_m: distanceM, moving_s: movingS, tiles: R.signature(points) };
}

// --------------------------------------------------------------------------- //
test('test_signature_is_the_tracks_tiles', () => {
  const [pts] = loop();
  const tiles = R.signature(pts);
  assert.ok(20 < tiles.length && tiles.length < 100, String(tiles.length));  // a 5 km loop, ~200 m tiles
  assert.ok(tiles.every(t => Array.isArray(t) && t.length === 2));
  assert.deepEqual(R.signature([]), []);
  assert.deepEqual(R.signature(null), []);
});

test('test_similarity_against_hand_computed_values', () => {
  const a = [[0, 0], [1, 0], [2, 0]], b = [[1, 0], [2, 0], [3, 0]];
  assert.equal(R.similarity(a, b), 0.5);             // 2 shared of 4 in total
  assert.equal(R.similarity(a, a), 1.0);
  assert.equal(R.similarity(a, [[9, 9]]), 0.0);
  // A subset scores its own share -- the whole reason distance is checked too.
  assert.equal(R.similarity([[0, 0], [1, 0]], [[0, 0], [1, 0], [2, 0], [3, 0]]), 0.5);
  assert.equal(R.similarity(a, []), 0.0);
  assert.equal(R.similarity([], a), 0.0);
});

test('test_two_empty_tile_sets_do_not_divide_by_zero', () => {
  // Two runs with no GPS are two unknowns, not the same route.
  assert.equal(R.similarity([], []), 0.0);
  assert.equal(R.similarity(null, null), 0.0);
});

test('test_the_same_route_recorded_twice_clusters', () => {
  const [pts, metres] = loop();
  const runs = [makeRun(1, 0, pts, metres, 1500),
                makeRun(2, 7, jitter(pts, 12, 1), metres * 1.01, 1490),
                makeRun(3, 14, jitter(pts, 40, 2), metres * 0.99, 1510)];
  const groups = R.cluster(runs);
  assert.equal(groups.length, 1, String(groups.map(g => g.length)));
  assert.deepEqual(groups[0].map(r => r.garmin_id), [1, 2, 3]);
  // Even 40 m of wobble leaves the tile sets plainly the same route.
  assert.ok(R.similarity(runs[0].tiles, runs[2].tiles) > R.SAME_ROUTE);
});

test('test_a_sparsely_recorded_run_still_matches', () => {
  // One fix every 125 m instead of every 12 m must not found a new route.
  const [dense, metres] = loop(HOME, 800.0, 400);
  const [sparse] = loop(HOME, 800.0, 40);
  assert.ok(R.similarity(R.signature(dense), R.signature(sparse)) > R.SAME_ROUTE);
  const groups = R.cluster([makeRun(1, 0, dense, metres, 1500),
                            makeRun(2, 3, sparse, metres, 1500)]);
  assert.equal(groups.length, 1);
});

test('test_a_different_route_does_not_join_the_cluster', () => {
  const [pts, metres] = loop();
  const [away, awayM] = loop([47.4100, 8.5900]);           // 4 km across town
  const [shifted, shiftedM] = loop([47.3769 + 250 / M_PER_DEG, 8.5417]);

  const groups = R.cluster([makeRun(1, 0, pts, metres, 1500),
                            makeRun(2, 1, jitter(pts, 12), metres, 1520),
                            makeRun(3, 2, away, awayM, 1500)]);
  assert.equal(groups.length, 2, String(groups.map(g => g.length)));
  assert.ok(groups[0].length === 2 && groups[1].length === 1);
  assert.equal(groups[1][0].garmin_id, 3);

  // Harder: a loop of the same length from the same door, one street north.
  // It shares real ground, so this is the case a lazy threshold gets wrong.
  const near = R.similarity(R.signature(pts), R.signature(shifted));
  assert.ok(0.0 < near && near < R.SAME_ROUTE, String(near));
  assert.equal(R.cluster([makeRun(1, 0, pts, metres, 1500),
                          makeRun(2, 1, shifted, shiftedM, 1500)]).length, 2);
});

test('test_half_a_route_is_not_the_same_route', () => {
  // The subset trap: 5 km out and back down a road the 10 km version uses.
  // Every tile of the short run is a tile of the long one, so the ground agrees
  // and only the distance says otherwise.
  const [shortPts, shortM] = outAndBack(HOME, 5000);
  const [longPts, longM] = outAndBack(HOME, 10000);
  const short = R.signature(shortPts), long = R.signature(longPts);
  assert.ok(subsetEq(short, long) && keySet(short).size < keySet(long).size,
    'the fixture is meant to be a strict subset');
  assert.ok(R.similarity(short, long) > 0.5, 'the trap has to be real to be worth guarding');

  const runs = [makeRun(1, 0, shortPts, shortM, 1450),
                makeRun(2, 1, longPts, longM, 3000)];
  assert.equal(R.cluster(runs).length, 2);

  // ...and it is the distance guard doing the work, not the threshold. Drop
  // the tile threshold below what the pair scores and they still stay apart;
  // only unbolting the distance check merges them.
  assert.equal(R.cluster(runs, 0.4).length, 2);
  assert.equal(R.cluster(runs, 0.4, 10.0).length, 1);
});

test('test_a_slightly_longer_day_is_still_the_same_route', () => {
  // The guard must not be so tight that an extra block founds a new route.
  const [pts, metres] = loop();
  const runs = [makeRun(1, 0, pts, metres, 1500),
                makeRun(2, 7, jitter(pts, 15), metres * 1.08, 1620)];
  assert.equal(R.cluster(runs).length, 1);
});

test('test_runs_without_gps_are_not_a_route', () => {
  const [pts, metres] = loop();
  const treadmill = { garmin_id: 9, start: new Date(2025, 1, 1),
                      distance_m: 5000.0, moving_s: 1500, tiles: [] };
  const groups = R.cluster([makeRun(1, 0, pts, metres, 1500),
                            makeRun(2, 1, jitter(pts), metres, 1500), treadmill]);
  assert.ok(groups.length === 1 && groups[0].length === 2);
  assert.deepEqual(R.cluster([treadmill]), []);
});

test('test_clusters_come_back_most_run_first', () => {
  const [pts, metres] = loop();
  const [away, awayM] = loop([47.4100, 8.5900]);
  const runs = [makeRun(1, 0, away, awayM, 1500)];                 // founded first
  for (const i of range(4)) runs.push(makeRun(10 + i, 1 + i, jitter(pts, 10, i), metres, 1500));
  const groups = R.cluster(runs);
  assert.deepEqual(groups.map(g => g.length), [4, 1]);
});

test('test_progression_spots_a_genuine_improvement', () => {
  const [pts, metres] = loop();
  const times = [1600, 1590, 1580, 1520, 1500, 1480];               // ~7% quicker
  const runs = times.map((t, i) => makeRun(i, i * 14, pts, metres, t));
  const p = R.progression(runs);
  assert.ok(p.count === 6 && p.timed === 6);
  assert.ok(p.first === runs[0].start && p.last === runs[runs.length - 1].start);
  assert.equal(p.days, 70);
  assert.ok(p.best_s === 1480 && p.best.garmin_id === 5);
  assert.equal(p.latest_s, 1480);
  assert.ok(p.change < -R.IMPROVEMENT, String(p.change));
  assert.equal(p.improving, true);
  assert.ok(Math.abs(p.off_best) < 1e-9, 'the last run is the best one');
  assert.ok(p.verdict.includes('quicker'), p.verdict);
  assert.ok(Math.abs(p.distance_m - metres) < 1.0);
});

test('test_progression_spots_a_genuine_decline', () => {
  const [pts, metres] = loop();
  const times = [1450, 1460, 1470, 1560, 1580, 1600];
  const runs = times.map((t, i) => makeRun(i, i * 14, pts, metres, t));
  const p = R.progression(runs);
  assert.ok(p.change > R.IMPROVEMENT, String(p.change));
  assert.equal(p.improving, false);
  assert.ok(p.best_s === 1450 && p.latest_s === 1600);
  assert.ok(p.off_best > 0.09, String(p.off_best));
  assert.ok(p.verdict.includes('slower'), p.verdict);
});

test('test_progression_calls_a_flat_route_flat', () => {
  const [pts, metres] = loop();
  const runs = [1500, 1510, 1495, 1505].map((t, i) => makeRun(i, i * 7, pts, metres, t));
  const p = R.progression(runs);
  assert.ok(Math.abs(p.change) < R.IMPROVEMENT);
  assert.equal(p.improving, false);
  assert.ok(p.verdict.includes('Level'), p.verdict);
});

test('test_a_faster_pace_over_a_shorter_day_is_not_a_course_record', () => {
  // Pace is normalised to the route's own distance before anything is ranked.
  //
  // Run 2 cuts 600 m off the route and is quicker per kilometre for it -- 298.9
  // against 300.0 s/km -- but Riegel says the shorter effort is worth 301 s/km
  // over the full route, so run 1 still holds it.
  const [pts] = loop();
  const full = makeRun(1, 0, pts, 5000.0, 1500);          // 300.0 s/km
  const short = makeRun(2, 7, pts, 4400.0, 1315);         // 298.9 s/km raw
  assert.ok(1315 / 4.4 < 1500 / 5.0, 'the naive comparison must favour the short one');
  const p = R.progression([full, short]);
  assert.equal(p.best.garmin_id, 1, String(p.best_pace));
  assert.ok(p.best_pace < p.latest_pace);
});

test('test_a_longer_day_at_the_same_effort_is_not_a_slower_day', () => {
  // Two runs 10% longer at the Riegel-equivalent effort: no trend at all.
  const [pts] = loop();
  const longS = 1500 * (5500.0 / 5000.0) ** R.RIEGEL;
  const runs = [makeRun(1, 0, pts, 5000.0, 1500), makeRun(2, 7, pts, 5000.0, 1500),
                makeRun(3, 14, pts, 5500.0, longS), makeRun(4, 21, pts, 5500.0, longS)];
  const naive = (longS / 5.5) / (1500 / 5.0) - 1.0;
  assert.ok(naive > 0.004, String(naive));      // raw pace would call these slower
  const p = R.progression(runs);
  assert.ok(Math.abs(p.change) < 1e-6, String(p.change));
  assert.equal(p.improving, false);
});

test('test_untimed_runs_still_count_as_repeats', () => {
  const [pts, metres] = loop();
  const runs = [makeRun(1, 0, pts, metres, 1500),
                makeRun(2, 7, pts, metres, null),
                makeRun(3, 14, pts, null, null)];
  const p = R.progression(runs);
  assert.ok(p.count === 3 && p.timed === 1);
  assert.ok(p.change === null && p.improving === null);
  assert.equal(p.best_s, 1500);
  assert.ok(p.verdict.includes('nothing to compare'));

  const noneTimed = R.progression([makeRun(4, 0, pts, null, null)]);
  assert.ok(noneTimed.best === null && noneTimed.best_pace === null);
  assert.equal(noneTimed.verdict, 'Never timed this route.');
});

test('test_shape_tells_a_loop_from_an_out_and_back', () => {
  const [pts, metres] = loop();
  assert.equal(R.shape(R.signature(pts), metres), 'loop');
  const [backPts, backM] = outAndBack(HOME, 8000);
  assert.equal(R.shape(R.signature(backPts), backM), 'out and back');
  assert.equal(R.shape([], 5000.0), 'route');
  assert.equal(R.shape(R.signature(pts), null), 'route');
  assert.equal(R.nameFor(R.signature(pts), 8420.0), '8.4 km loop');
  assert.equal(R.nameFor(R.signature(backPts), backM), '8.0 km out and back');
  assert.equal(R.nameFor([], null), 'Unnamed route');
});

test('test_summarise_keeps_only_the_routes_you_repeat', () => {
  const [pts, metres] = loop();
  const [away, awayM] = loop([47.4100, 8.5900]);
  const runs = range(5).map(i => makeRun(100 + i, i * 7, jitter(pts, 10, i), metres, 1600 - 20 * i));
  for (const i of range(2)) runs.push(makeRun(200 + i, 3 + i * 7, jitter(away, 10, i), awayM, 1500));

  const routes = R.summarise(runs);
  assert.equal(routes.length, 1, String(routes.map(r => r.name)));
  const route = routes[0];
  assert.equal(route.count, 5);
  assert.equal(route.name, '5.0 km loop', route.name);
  assert.deepEqual(route.garmin_ids, [100, 101, 102, 103, 104]);
  assert.equal(route.progression.improving, true);
  assert.ok(subsetEq(route.tiles, union(runs[0].tiles, runs[1].tiles)), 'core, not invented');
  assert.ok(route.tiles.length, 'something has to be left to draw');

  // Loosen the bar and the twice-run route appears, still behind the main one.
  const both = R.summarise(runs, 2);
  assert.deepEqual(both.map(r => r.count), [5, 2]);
});

test('test_summarise_names_routes_by_distance_and_shape', () => {
  const [pts, metres] = loop(HOME, 1340.0);                  // ~8.4 km
  const [backPts, backM] = outAndBack([47.4100, 8.5900], 10000);
  const runs = range(3).map(i => makeRun(i, i * 5, jitter(pts, 10, i), metres, 2500));
  for (const i of range(4)) runs.push(makeRun(50 + i, 2 + i * 5, jitter(backPts, 10, i), backM, 3000));
  const names = R.summarise(runs).map(r => r.name);
  assert.deepEqual(names, ['10.0 km out and back', '8.4 km loop']);
});

test('test_core_tiles_drop_a_one_off_diversion', () => {
  // A single run's detour is not part of the route, so it is not drawn.
  const [pts, metres] = loop();
  const detour = [...pts, [47.3769 + 900 / M_PER_DEG, 8.5417 + 0.02]];
  const runs = [makeRun(1, 0, pts, metres, 1500),
                makeRun(2, 7, pts, metres, 1500),
                makeRun(3, 14, detour, metres * 1.05, 1600)];
  const route = R.summarise(runs)[0];
  assert.equal(route.count, 3);
  const extra = minus(runs[2].tiles, runs[0].tiles);
  assert.ok(extra.length, 'the fixture is meant to add ground');
  assert.ok(!intersects(extra, route.tiles), "one run's detour leaked into the route");
});

test('test_degenerate_input', () => {
  assert.deepEqual(R.cluster([]), []);
  assert.deepEqual(R.summarise([]), []);
  assert.equal(R.progression([]), null);
  assert.equal(R.progression(null), null);

  const [pts, metres] = loop();
  const one = makeRun(1, 0, pts, metres, 1500);
  assert.deepEqual(R.cluster([one]), [[one]]);
  assert.deepEqual(R.summarise([one]), []);
  const alone = R.summarise([one], 1);
  assert.ok(alone.length === 1 && alone[0].count === 1);
  assert.equal(alone[0].progression.change, null);

  // No GPS anywhere: nothing to cluster, and nothing that crashes.
  const blank = range(3).map(i => ({ garmin_id: i, start: new Date(2025, 2, i + 1), distance_m: 5000.0,
                                     moving_s: 1500, tiles: [] }));
  assert.deepEqual(R.cluster(blank), []);
  assert.deepEqual(R.summarise(blank), []);

  // Tiles but no numbers at all, including no date.
  const bare = { garmin_id: 7, tiles: R.signature(pts), start: null,
                 distance_m: null, moving_s: null };
  const route = R.summarise([bare, { ...bare, garmin_id: 8 }], 1)[0];
  assert.equal(route.name, 'Unnamed route');
  assert.ok(route.progression.first === null && route.progression.days === 0);
  assert.equal(route.shape, 'route');
});
