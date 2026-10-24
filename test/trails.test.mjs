// Self-check for the trail coverage engine. Port of test_trails.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/lib/trails.js';

const LAT = 45.0;   // everything happens at 45 N, where a degree of longitude is cos(45) wide

// A point `metres` due east of (lat, lng).
const east = (lat, lng, metres) => [lat, lng + metres / (T.M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180))];
// A point `metres` due north of (lat, lng).
const north = (lat, lng, metres) => [lat + metres / T.M_PER_DEG_LAT, lng];
// A straight two-point line running `metres` east.
const lineEast = (metres, lat = LAT, lng = 0.0) => [[lat, lng], east(lat, lng, metres)];

function gaps(coords) {
  const out = [];
  for (let i = 0; i + 1 < coords.length; i++) {
    out.push(T.distM(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]));
  }
  return out;
}

// A hit mask of `n` nodes with `indices` set.
function mask(n, indices) {
  const m = new Uint8Array(n);
  for (const i of indices) m[i] = 1;
  return m;
}
const range = n => Array.from({ length: n }, (_, i) => i);

// A straight segment of `nodes` nodes, `spacing` metres apart.
function flatSeg(wayId, nodes, name = null, lenM = null, spacing = 25.0) {
  const coords = range(nodes).map(i => east(LAT, 0.0, i * spacing));
  return T.Segment({ id: wayId, coords, name, len_m: lenM === null ? spacing * nodes : lenM });
}

// One Overpass `way` element, straight and `metres` long.
function overpassWay(wayId, metres, tags = null) {
  return { type: 'way', id: wayId, tags: tags || { highway: 'path' },
           geometry: lineEast(metres).map(([la, ln]) => ({ lat: la, lon: ln })) };
}

const near = (a, b, tol) => Math.abs(a - b) < tol;

test('test_dist_m_against_known_values', () => {
  // A thousandth of a degree of latitude is 111.32 m anywhere on Earth.
  assert.ok(near(T.distM(45.0, 0.0, 45.001, 0.0), 111.32, 0.001));
  // A degree of longitude shrinks by the cosine of the latitude; at 60 N, half.
  assert.ok(near(T.distM(60.0, 0.0, 60.0, 1.0), T.M_PER_DEG_LAT * 0.5, 0.001));
  assert.equal(T.distM(45.0, 7.0, 45.0, 7.0), 0.0);
  assert.ok(near(T.distM(45.0, 7.0, 45.01, 7.01), T.distM(45.01, 7.01, 45.0, 7.0), 1e-9));
  // 3-4-5: 300 m north and 400 m east is 500 m away.
  const p = north(...east(LAT, 0.0, 400.0), 300.0);
  assert.ok(near(T.distM(LAT, 0.0, p[0], p[1]), 500.0, 0.5));
});

test('test_resample_gives_even_spacing', () => {
  const [coords, lenM] = T.resample(lineEast(1010), 25);
  assert.ok(near(lenM, 1010, 0.01), String(lenM));
  assert.equal(coords.length, 41);        // 0, 25 ... 1000; the last 10 m is a stub
  assert.ok(gaps(coords).every(g => near(g, 25, 0.01)), String(gaps(coords)));
  // The true end is kept when it is more than half a step past the last node.
  const [endsShort] = T.resample(lineEast(1020), 25);
  assert.equal(endsShort.length, 42);
  const g = gaps(endsShort);
  assert.ok(near(g[g.length - 1], 20, 0.01));
});

test('test_resample_breaks_on_a_long_gap', () => {
  // A drive between two trailheads must not paint a line across the map.
  const a0 = [LAT, 0.0];
  const a1 = east(...a0, 100);
  const b0 = east(...a0, 5000);
  const b1 = east(...b0, 100);
  const [coords, lenM] = T.resample([a0, a1, b0, b1], 25, 150);
  assert.ok(near(lenM, 200, 0.01), String(lenM));     // the 4.9 km jump is not distance
  assert.equal(coords.length, 10);                     // 5 nodes either side, nothing between
  const jumps = gaps(coords).filter(g => g > 150);
  assert.ok(jumps.length === 1 && near(jumps[0], 4900, 0.01), String(jumps));
  // Without a gap limit the same points are joined right across the map.
  const [joined, joinedLen] = T.resample([a0, a1, b0, b1], 25);
  assert.ok(near(joinedLen, 5100, 0.01));
  assert.ok(joined.length > 200);
});

test('test_a_track_along_a_trail_covers_every_node', () => {
  const [coords, lenM] = T.resample(lineEast(1000), T.NODE_STEP_M);
  const seg = T.Segment({ id: 'w1', coords, len_m: lenM, name: 'Ridge' });
  const [track] = T.resample(lineEast(1000), T.TRACK_STEP_M);
  const hits = T.markHits(T.buildIndex([seg], T.DEFAULT_TOL_M), track);
  assert.deepEqual(Object.keys(hits), ['w1']);
  assert.equal(T.countBits(hits.w1), coords.length);
  assert.deepEqual(T.coveredRuns(hits.w1), [[0, coords.length - 1]]);
});

test('test_a_track_a_hundred_metres_away_marks_nothing', () => {
  const [coords, lenM] = T.resample(lineEast(1000), T.NODE_STEP_M);
  const seg = T.Segment({ id: 'w1', coords, len_m: lenM });
  const [track] = T.resample(lineEast(1000), T.TRACK_STEP_M);
  const parallel = track.map(([la, ln]) => north(la, ln, 100));
  assert.deepEqual(T.markHits(T.buildIndex([seg], T.DEFAULT_TOL_M), parallel), {});
});

test('test_tolerance_boundary', () => {
  const [coords, lenM] = T.resample(lineEast(500), T.NODE_STEP_M);
  const seg = T.Segment({ id: 'w1', coords, len_m: lenM });
  const index = T.buildIndex([seg], 25);
  const justIn = coords.map(([la, ln]) => north(la, ln, 24.9));
  const justOut = coords.map(([la, ln]) => north(la, ln, 25.1));
  assert.equal(T.countBits(T.markHits(index, justIn, 25).w1), coords.length);
  assert.deepEqual(T.markHits(index, justOut, 25), {});
  // Widening the tolerance picks the same track back up -- nothing is cached.
  assert.equal(T.countBits(T.markHits(index, justOut, 30).w1), coords.length);
});

test('test_a_crossing_track_marks_only_the_junction', () => {
  // Running across a trail is not running it.
  const [coords, lenM] = T.resample(lineEast(1000), T.NODE_STEP_M);
  const seg = T.Segment({ id: 'w1', coords, len_m: lenM, name: 'Ridge' });
  const middle = Math.floor(coords.length / 2);
  const mid = coords[middle];
  const [crossing] = T.resample([north(mid[0], mid[1], -200), north(mid[0], mid[1], 200)],
                                T.TRACK_STEP_M);
  const hits = T.markHits(T.buildIndex([seg], 25), crossing);
  const n = T.countBits(hits.w1);
  assert.ok(n >= 1 && n <= 3);                         // the junction node, maybe its neighbours
  const runs = T.coveredRuns(hits.w1);
  assert.equal(runs.length, 1);
  assert.ok(runs[0][0] >= middle - 1 && runs[0][1] <= middle + 1);
});

test('test_threshold_and_first_touch_attribution', () => {
  // A trail is done at 90%, and running it again is worth nothing.
  const seg = flatSeg('w1', 10, 'Ridge', 250.0);      // 25 m per node
  const acts = [
    { id: 'c', date: '2026-05-03', hits: { w1: mask(10, range(9)) } },   // a repeat
    { id: 'a', date: '2026-05-01', hits: { w1: mask(10, range(8)) } },   // 80%
    { id: 'b', date: '2026-05-02', hits: { w1: mask(10, range(9)) } },   // 90%
  ];
  const ch = T.chronology(acts, [seg]);               // deliberately handed over out of order
  assert.equal(ch.per_act.a.new_nodes, 8);
  assert.ok(near(ch.per_act.a.new_m, 200.0, 1e-9));
  assert.deepEqual(ch.per_act.a.finished, []);        // 80% is not done
  assert.equal(ch.per_act.b.new_nodes, 1);            // the node that crossed the line
  assert.deepEqual(ch.per_act.b.finished, ['n:ridge']);
  assert.deepEqual(ch.done_on, { 'n:ridge': '2026-05-02' });
  assert.equal(ch.per_act.c.new_nodes, 0);            // a repeat lap is new ground for nobody
  assert.equal(ch.per_act.c.new_m, 0.0);
  assert.deepEqual(ch.per_act.c.finished, []);        // and it does not finish it twice
  assert.ok(near(ch.total_m, 225.0, 1e-9));
  assert.deepEqual(ch.timeline.map(t => t.date), ['2026-05-01', '2026-05-02', '2026-05-03']);
  assert.deepEqual(ch.timeline.map(t => t.cum_m), [200.0, 225.0, 225.0]);
});

test('test_a_trail_is_the_sum_of_its_ways', () => {
  // Two ways sharing a name are one trail; 90% is 90% of both together.
  const a = flatSeg('w1', 10, 'Ridge', 250.0);
  const b = flatSeg('w2', 10, 'ridge', 250.0);        // same trail, different case
  const acts = [{ id: 'a', date: '2026-05-01', hits: { w1: mask(10, range(10)) } }];
  let ch = T.chronology(acts, [a, b]);
  assert.deepEqual(ch.done_on, {});                   // half of the trail is not done
  acts.push({ id: 'b', date: '2026-05-02', hits: { w2: mask(10, range(8)) } });   // 18 of 20 nodes
  ch = T.chronology(acts, [a, b]);
  assert.deepEqual(ch.done_on, { 'n:ridge': '2026-05-02' });
  assert.ok(near(ch.total_m, 450.0, 1e-9));
});

test('test_chronology_respects_the_segment_filter', () => {
  const ridge = flatSeg('w1', 10, 'Ridge', 250.0);
  const pavement = flatSeg('w2', 10, 'High Street', 250.0);
  const acts = [{ id: 'a', date: '2026-05-01',
                  hits: { w1: mask(10, range(10)), w2: mask(10, range(10)) } }];
  const ch = T.chronology(acts, [ridge, pavement], i => i === 'w1');
  assert.equal(ch.per_act.a.new_nodes, 10);           // the filtered way counted for nothing
  assert.deepEqual(ch.done_on, { 'n:ridge': '2026-05-01' });
  // Hits for a segment that is not loaded at all are ignored, not crashed on.
  const stray = [{ id: 'a', date: '2026-05-01', hits: { w99: mask(4, [0, 1]) } }];
  assert.equal(T.chronology(stray, [ridge]).total_m, 0.0);
});

test('test_union_coverage_ors_the_masks', () => {
  const acts = [{ hits: { w1: mask(6, [0, 1]) } },
                { hits: { w1: mask(6, [1, 4]), w2: mask(3, [0]) } }];
  const cover = T.unionCoverage(acts);
  assert.deepEqual(Array.from(cover.w1), [1, 1, 0, 0, 1, 0]);
  assert.equal(T.countBits(cover.w1), 3);
  assert.equal(T.countBits(cover.w2), 1);
  assert.equal(T.countBits(acts[0].hits.w1), 2);      // the source masks are untouched
  assert.deepEqual(Object.keys(T.unionCoverage(acts, i => i !== 'w2')), ['w1']);
  assert.deepEqual(T.unionCoverage([]), {});
});

test('test_covered_runs_finds_the_gaps', () => {
  assert.deepEqual(T.coveredRuns(new Uint8Array([0, 1, 1, 0, 1, 0, 0, 1])), [[1, 2], [4, 4], [7, 7]]);
  assert.deepEqual(T.coveredRuns(new Uint8Array([1, 1, 1])), [[0, 2]]);
  assert.deepEqual(T.coveredRuns(new Uint8Array(4)), []);
  assert.deepEqual(T.coveredRuns(new Uint8Array()), []);
});

test('test_trail_key_groups_by_name', () => {
  const a = T.Segment({ id: '1', coords: [], name: 'Blue Trail' });
  const b = T.Segment({ id: '2', coords: [], name: 'blue trail' });
  const c = T.Segment({ id: '3', coords: [], name: null });
  assert.equal(T.trailKey(a), 'n:blue trail');
  assert.equal(T.trailKey(b), 'n:blue trail');
  assert.equal(T.trailKey(c), 'w:3');
  // Two unnamed ways are two trails, not one unfinishable mega-trail.
  assert.notEqual(T.trailKey(c), T.trailKey(T.Segment({ id: '4', coords: [] })));
  assert.equal(T.trailKey(T.Segment({ id: 99, coords: [] })), 'w:99');
});

test('test_stitch_joins_ways_that_meet', () => {
  const p0 = [LAT, 0.0], p1 = east(LAT, 0.0, 100), p2 = east(LAT, 0.0, 200);
  const a = T.Segment({ id: 'w1', coords: [p0, p1] });
  const b = T.Segment({ id: 'w2', coords: [p1, p2] });
  let chains = T.stitchTrail([a, b]);
  assert.equal(chains.length, 1);
  assert.deepEqual(chains[0].pts, [p0, p1, p2]);      // the shared node appears once
  assert.ok(near(chains[0].len_m, 200, 0.01));
  // Direction does not matter: OSM ways point whichever way the mapper drew them.
  for (const flipped of [[p2, p1], [p1, p0]]) {
    const joined = T.stitchTrail([a, T.Segment({ id: 'w2', coords: flipped })]);
    assert.ok(joined.length === 1 && joined[0].pts.length === 3, JSON.stringify(flipped));
  }
  // Ends within the join tolerance still count as meeting; beyond it they do not.
  const nearSeg = T.Segment({ id: 'w2', coords: [east(...p1, 40), east(...p1, 140)] });
  assert.equal(T.stitchTrail([a, nearSeg]).length, 1);
  const far = T.Segment({ id: 'w2', coords: [east(...p1, 60), east(...p1, 160)] });
  assert.equal(T.stitchTrail([a, far]).length, 2);
  // A spur that meets nothing is its own chain, and the spine sorts first.
  const lonely = T.Segment({ id: 'w3', coords: [east(LAT, 0.0, 5000), east(LAT, 0.0, 5050)] });
  chains = T.stitchTrail([lonely, a, b]);
  assert.equal(chains.length, 2);
  assert.ok(near(chains[0].len_m, 200, 0.01) && near(chains[1].len_m, 50, 0.01));
});

test('test_way_kind_buckets_and_motor_flag', () => {
  assert.deepEqual(T.wayKind({ highway: 'path' }), ['path', false]);
  assert.deepEqual(T.wayKind({ highway: 'steps' }), ['steps', false]);
  assert.deepEqual(T.wayKind({ highway: 'cycleway' }), ['cycleway', false]);
  assert.deepEqual(T.wayKind({ highway: 'bridleway' }), ['bridleway', false]);
  assert.deepEqual(T.wayKind({ highway: 'footway' }), ['path', false]);
  assert.deepEqual(T.wayKind({ highway: 'footway', footway: 'sidewalk' }), ['sidewalk', false]);
  assert.deepEqual(T.wayKind({ highway: 'footway', footway: 'crossing' }), ['sidewalk', false]);
  assert.deepEqual(T.wayKind({}), ['path', false]);
  assert.deepEqual(T.wayKind(null), ['path', false]);
  // A track is a vehicle road until the tagging says otherwise.
  assert.deepEqual(T.wayKind({ highway: 'track' }), ['track', true]);
  assert.deepEqual(T.wayKind({ highway: 'track', motor_vehicle: 'no' }), ['track', false]);
  assert.deepEqual(T.wayKind({ highway: 'path', atv: 'designated' }), ['path', true]);
  assert.deepEqual(T.wayKind({ highway: 'path', snowmobile: 'yes' }), ['path', true]);
  assert.deepEqual(T.wayKind({ highway: 'path', motorcycle: 'permissive' }), ['path', true]);
  assert.deepEqual(T.wayKind({ highway: 'path', atv: 'no' }), ['path', false]);
});

test('test_segments_from_overpass_inherits_relation_names', () => {
  const hiking = { type: 'relation', id: 9, tags: { name: 'Bruce Trail', route: 'hiking' },
                   members: [{ type: 'way', ref: 1 }, { type: 'way', ref: 2 },
                             { type: 'node', ref: 77 }] };
  const cycling = { type: 'relation', id: 8, tags: { name: 'Waterfront Loop', route: 'bicycle' },
                    members: [{ type: 'way', ref: 1 }] };
  const ways = [overpassWay(1, 410),
                overpassWay(2, 410, { highway: 'track' }),
                overpassWay(3, 410, { highway: 'path', name: 'Own Name' })];

  let segs;
  for (const relations of [[hiking, cycling], [cycling, hiking]]) {
    segs = Object.fromEntries(T.segmentsFromOverpass({ elements: [...relations, ...ways] }, 'r1')
      .map(s => [s.id, s]));
    assert.deepEqual(new Set(Object.keys(segs)), new Set(['1', '2', '3']));
    assert.equal(segs['1'].name, 'Bruce Trail');      // a hiking route outranks the cycle route
    assert.equal(segs['2'].name, 'Bruce Trail');
    assert.equal(segs['3'].name, 'Own Name');         // the way's own name always wins
  }

  const seg = segs['1'];
  assert.ok(seg.kind === 'path' && seg.motor === false);
  assert.ok(segs['2'].kind === 'track' && segs['2'].motor === true);
  assert.equal(seg.region, 'r1');
  assert.ok(near(seg.len_m, 410, 0.01));
  assert.equal(seg.coords.length, 17);                // 0, 25 ... 400
  assert.ok(seg.bbox[0] <= LAT && LAT <= seg.bbox[2]);
  assert.equal(T.trailKey(seg), 'n:bruce trail');
  assert.equal(T.trailKey(segs['2']), 'n:bruce trail');
});

test('test_segments_from_overpass_skips_junk', () => {
  const data = { elements: [
    overpassWay(1, 5),                                          // a 5 m stub: one node
    { type: 'way', id: 2, tags: { highway: 'path' },
      geometry: [{ lat: LAT, lon: 0.0 }] },                     // a single point
    { type: 'way', id: 3, tags: { highway: 'path' } },          // no geometry at all
    { type: 'node', id: 4, lat: LAT, lon: 0.0 },
    { type: 'relation', id: 5, tags: { route: 'hiking' } },     // unnamed relation
    overpassWay(6, 410),
  ] };
  assert.deepEqual(T.segmentsFromOverpass(data).map(s => s.id), ['6']);
  assert.deepEqual(T.segmentsFromOverpass({}), []);
  assert.deepEqual(T.segmentsFromOverpass({ elements: [] }), []);
  assert.deepEqual(T.segmentsFromOverpass(null), []);
});

test('test_climb_m_ignores_gps_noise', () => {
  assert.equal(T.climbM([100.0, 100.4, 100.0, 100.6, 100.1]), 0);   // standing still
  assert.equal(T.climbM([100.0, 110.0, 105.0, 115.0]), 20);
  assert.equal(T.climbM([0.0, 1.0, 2.0, 3.0]), 0);                  // 1 m steps miss the floor
  assert.equal(T.climbM([0.0, 1.0, 2.0, 3.0], 0), 3);               // a smooth model needs no filter
  assert.equal(T.climbM([200.0, 100.0]), 0);                        // descent is not climb
  assert.equal(T.climbM([100.0, null, 130.0]), 30);                 // a dropped sample is not a cliff
  assert.ok(T.climbM([]) === 0 && T.climbM([100.0]) === 0);
});

test('test_streaks', () => {
  const days = ['2026-08-01', '2026-08-02', '2026-08-02', '2026-08-03', '2026-08-10', ''];
  const s = T.streaks(days, '2026-08-11');
  assert.equal(s.days, 4);                            // duplicates and blanks collapse
  assert.equal(s.best, 3);
  assert.equal(s.current, 1);                         // yesterday still counts
  assert.equal(T.streaks(days, '2026-08-10').current, 1);
  assert.equal(T.streaks(days, '2026-08-12').current, 0);     // already lost it
  assert.equal(T.streaks(['2026-08-09', '2026-08-10'], '2026-08-10').current, 2);
  assert.equal(T.dayDiff('2026-08-01', '2026-09-01'), 31);
  assert.equal(T.dayDiff('nope', '2026-09-01'), null);
  assert.equal(T.streaks(['nope', '2026-08-10'], '2026-08-10').best, 1);
});

test('test_none_and_nan_points_are_dropped', () => {
  // Watches emit null and NaN samples; neither may crash or move a node.
  const [coords, lenM] = T.resample(
    [[LAT, 0.0], [null, 0.0], [LAT, NaN], ['x', 'y'], [LAT], null,
     east(LAT, 0.0, 100)], 25);
  assert.ok(near(lenM, 100, 0.01));
  assert.equal(coords.length, 5);
  const seg = flatSeg('w1', 5);
  const index = T.buildIndex([seg], 25);
  assert.deepEqual(T.markHits(index, [[NaN, NaN], [null, null], [200.0, 0.0]]), {});
  assert.deepEqual(T.markHits(index, [[NaN, NaN], ...seg.coords]), { w1: new Uint8Array([1, 1, 1, 1, 1]) });
  // Off-Earth coordinates go too, without taking the good ones with them.
  assert.deepEqual(T.resample([[200.0, 0.0], [LAT, 0.0]], 25), [[[LAT, 0.0]], 0.0]);
});

test('test_empty_and_degenerate_input', () => {
  assert.deepEqual(T.resample([], 25), [[], 0.0]);
  assert.deepEqual(T.resample(null, 25), [[], 0.0]);
  assert.deepEqual(T.resample([[LAT, 0.0]], 25), [[[LAT, 0.0]], 0.0]);
  assert.deepEqual(T.resample([[LAT, 0.0], [LAT, 0.0]], 25), [[[LAT, 0.0]], 0.0]);   // zero length
  assert.equal(T.bboxOf([]), null);
  assert.deepEqual(T.markHits(T.buildIndex([], 25), [[LAT, 0.0]]), {});
  assert.deepEqual(T.markHits(T.buildIndex([flatSeg('w1', 4)], 25), []), {});
  assert.deepEqual(T.stitchTrail([]), []);
  assert.deepEqual(T.stitchTrail([T.Segment({ id: 'w1', coords: [[LAT, 0.0]] })]), []);   // cannot chain a point
  assert.equal(T.countBits(new Uint8Array()), 0);
  assert.deepEqual(T.chronology([], []), { per_act: {}, done_on: {}, timeline: [], total_m: 0.0 });
  assert.equal(T.chronology([], [T.Segment({ id: 'w1', coords: [] })]).total_m, 0.0);
  assert.deepEqual(T.streaks([]), { current: 0, best: 0, days: 0 });
  // A zero step would loop forever; it has to be refused, not survived.
  assert.throws(() => T.resample(lineEast(100), 0), RangeError);
});
