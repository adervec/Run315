// Route planning for exploration: targets, the orienteering heuristic, BRouter chunking and
// caching, coverage of the routed line, Chinese-postman-lite, GPX.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as X from '../js/explorer-route.js';
import * as BS from '../js/bitset.js';
import { tileFor } from '../js/lib/territory.js';

const LAT = 43.85, LON = -79.3;
const M_LAT = 6371000 * Math.PI / 180, M_LON = M_LAT * Math.cos(LAT * Math.PI / 180);
const P = (x, y) => [LAT + y / M_LAT, LON + x / M_LON];          // metres east / north
const line = (x0, y0, x1, y1, step = 25) => {
  const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step)), out = [];
  for (let i = 0; i <= n; i++) out.push(P(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n));
  return out;
};
const near = (a, b, tol) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

// A tiny town: three east-west streets 500 m apart, one north-south.
function town() {
  const ways = [
    { k: 'a', t: 's', g: 's:First St', c: line(0, 0, 1000, 0) },
    { k: 'b', t: 's', g: 's:Second St', c: line(0, 500, 1000, 500) },
    { k: 'c', t: 's', g: 's:Third St', c: line(0, 1000, 1000, 1000) },
    { k: 'd', t: 's', g: 's:Cross Rd', c: line(0, 0, 0, 1000) },
    { k: 'e', t: 't', g: null, c: line(500, 0, 500, 1000) },
  ];
  const groups = {};
  for (const w of ways) if (w.g) groups[w.g] = { key: w.g, name: w.g.slice(2), kind: 's', ways: [w.k], nodes: w.c.length, len_m: X.lineM(w.c) };
  return { ways, groups };
}

test('distM and lineM are metres', () => {
  near(X.distM(P(0, 0), P(1000, 0)), 1000, 1);
  near(X.lineM(line(0, 0, 0, 2000)), 2000, 1);
});

test('unrunPieces: run nodes split the way; lone unrun nodes are noise', () => {
  const c = line(0, 0, 1000, 0);                 // 41 nodes
  const bits = BS.create(c.length);
  for (let i = 10; i < 30; i++) BS.set(bits, i);
  const p = X.unrunPieces(c, bits);
  assert.equal(p.length, 2);
  assert.equal(p[0].length, 10);
  assert.equal(p[1].length, c.length - 30);
  // all run except one node in the middle: that singleton is the only thing left, so it stays
  const all = BS.create(c.length);
  for (let i = 0; i < c.length; i++) if (i !== 20) BS.set(all, i);
  assert.equal(X.unrunPieces(c, all).length, 1);
  // a singleton next to a real stretch is dropped
  const mix = BS.create(c.length);
  for (let i = 0; i < c.length; i++) if (i !== 5 && i < 35) BS.set(mix, i);
  assert.deepEqual(X.unrunPieces(c, mix).map(x => x.length), [c.length - 35]);
  assert.equal(X.unrunPieces(c, null)[0].length, c.length);
});

test('chainPieces runs end to end and flips pieces', () => {
  const a = line(0, 0, 300, 0), b = line(700, 0, 400, 0);   // b points backwards
  const { chain, gapM } = X.chainPieces([b, a]);
  assert.equal(chain.length, 2);
  // starts at an outer end, finishes at the other, gap ~100 m
  const s = chain[0][0], e = chain[1].at(-1);
  near(Math.abs(X.distM(s, e)), 700, 2);
  near(gapM, 100, 2);
});

test('streetTarget: what is left of a street, entered at one end and left at the other', () => {
  const geo = town();
  const full = X.streetTarget(geo, {}, 's:First St');
  assert.equal(full.kind, 'street');
  near(full.unrun_m, 1000, 2);
  near(X.distM(full.a, full.b), 1000, 2);
  assert.ok(full.via.length >= 3 && full.via.length <= 8);
  // half run: only the eastern half is left
  const n = geo.ways[0].c.length, bits = BS.create(n);
  for (let i = 0; i < 21; i++) BS.set(bits, i);
  const rec = { cover: { a: BS.toB64(bits) }, list: { 's:First St': [n, 21, 1000] } };
  const half = X.streetTarget(geo, rec, 's:First St');
  near(half.unrun_m, 475, 30);
  assert.ok(half.pct > 0.5);
  // fully run: nothing to do
  const allBits = BS.create(n);
  for (let i = 0; i < n; i++) BS.set(allBits, i);
  assert.equal(X.streetTarget(geo, { cover: { a: BS.toB64(allBits) } }, 's:First St'), null);
  assert.equal(X.streetTarget(geo, {}, 's:Nowhere'), null);
});

test('streetCandidates: closest to done first, or untouched nearest; out of reach left out', () => {
  const geo = town();
  const rec = { list: { 's:First St': [41, 30, 1000], 's:Second St': [41, 5, 1000], 's:Third St': [41, 0, 1000], 's:Cross Rd': [41, 41, 1000] } };
  const start = P(0, -50);
  assert.deepEqual(X.streetCandidates(geo, rec, { start, order: 'close' }), ['s:First St', 's:Second St', 's:Third St']);
  assert.deepEqual(X.streetCandidates(geo, rec, { start, order: 'untouched' }), ['s:Third St']);
  // Third St is ~1 km away: 2 x 1050 x 1.3 > 2 km
  assert.deepEqual(X.streetCandidates(geo, rec, { start, order: 'close', budgetM: 2000 }), ['s:First St', 's:Second St']);
});

test('streetAt finds the clicked street', () => {
  const geo = town();
  assert.equal(X.streetAt(geo, P(400, 505)), 's:Second St');
  assert.equal(X.streetAt(geo, P(400, 250)), null);
  assert.equal(X.streetAt(geo, P(500, 250), 40, 't'), null);   // trail ways have no group
});

test('tileTarget and parseTileId round-trip; the centre is inside the tile', () => {
  const [x, y] = tileFor(LAT, LON, 17);
  const t = X.tileTarget(x, y, 17);
  assert.deepEqual(X.parseTileId(t.id), { zoom: 17, x, y });
  assert.deepEqual(tileFor(t.a[0], t.a[1], 17), [x, y]);
  assert.equal(X.parseTileId('nope'), null);
});

// Point targets on a line east of the start, plus one far off.
const pt = (id, x, y) => ({ id, kind: 'tile', name: id, a: P(x, y), b: P(x, y), via: [P(x, y)], len_m: 0, bounds: [0, 0, 0, 0] });

test('planTour: nearest neighbour under the budget, 2-opt removes crossings', () => {
  const start = P(0, 0);
  const ts = [pt('t3', 1500, 0), pt('t1', 500, 0), pt('far', 20000, 0), pt('t2', 1000, 0)];
  const p = X.planTour({ start, optional: ts, budgetM: 5000 });
  assert.deepEqual(p.tour.map(o => o.t.id), ['t1', 't2', 't3']);
  near(p.estM, 2 * 1500 * X.DETOUR, 2);
  assert.deepEqual(p.skipped.map(t => t.id), ['far']);
  // a tight budget takes fewer
  assert.deepEqual(X.planTour({ start, optional: ts, budgetM: 2700 }).tour.map(o => o.t.id), ['t1', 't2']);
  // forced targets are in whatever the budget
  const f = X.planTour({ start, forced: [ts[2]], optional: ts, budgetM: 100 });
  assert.deepEqual(f.tour.map(o => o.t.id), ['far']);
  // 2-opt on a deliberately crossed square
  const sq = [pt('a', 0, 1000), pt('c', 1000, 0), pt('b', 1000, 1000)];
  const crossed = sq.map(t => ({ t, rev: false }));
  const fixed = X.improve(start, crossed);
  assert.ok(X.tourCost(start, fixed) < X.tourCost(start, crossed));
  near(X.tourCost(start, fixed), 4000 * X.DETOUR, 2);
});

test('planTour runs a street from the nearer end', () => {
  const geo = town();
  const s = X.streetTarget(geo, {}, 's:Second St');
  const fromEast = X.planTour({ start: P(1100, 500), optional: [s], budgetM: 10000 });
  const o = fromEast.tour[0], entry = o.rev ? o.t.b : o.t.a;
  assert.ok(X.distM(entry, P(1000, 500)) < 30);
});

test('tourPoints and chunk: start and finish at home, chunks share their seams', () => {
  const start = P(0, 0);
  const tour = [{ t: pt('a', 100, 0), rev: false }, { t: pt('b', 200, 0), rev: false }];
  const { pts, marks } = X.tourPoints(start, tour);
  assert.equal(pts.length, 4);
  assert.deepEqual(pts[0], pts.at(-1));
  assert.deepEqual(marks.map(m => m.at), [1, 2]);
  const many = Array.from({ length: 45 }, (_, i) => P(i * 10, 0));
  const ch = X.chunk(many, 20);
  assert.ok(ch.every(c => c.length <= 20));
  assert.deepEqual(ch[1][0], ch[0].at(-1));
  assert.deepEqual(ch.at(-1).at(-1), many.at(-1));
  assert.equal(ch.reduce((s, c) => s + c.length, 0) - (ch.length - 1), many.length);
  assert.deepEqual(X.chunk(many.slice(0, 5)), [many.slice(0, 5)]);
});

// A fake BRouter: a straight line through the requested points.
function fakeBrouter(log, failFirst = 0) {
  let fails = failFirst;
  return async url => {
    log.push(url);
    if (fails > 0) { fails--; return { ok: false, status: 503, text: async () => 'busy' }; }
    const ll = new URL(url).searchParams.get('lonlats').split('|').map(s => s.split(',').map(Number));
    const coords = ll.map(([lon, lat]) => [lon, lat, 100]);
    const len = X.lineM(ll.map(([lon, lat]) => [lat, lon]));
    return { ok: true, status: 200, text: async () => JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature',
      properties: { 'track-length': String(Math.round(len)), 'filtered ascend': '12', 'total-time': '600' },
      geometry: { type: 'LineString', coordinates: coords } }] }) };
  };
}
const memCache = () => { const m = new Map(); return { m, cacheGet: async k => m.get(k), cacheSet: async (k, v) => { m.set(k, v); } }; };

test('routeVia: sequential chunks, joined, summed, cached for a week, one polite retry', async () => {
  const pts = Array.from({ length: 30 }, (_, i) => P(i * 100, 0));
  const log = [], c = memCache();
  const io = { fetchFn: fakeBrouter(log), ...c, pauseMs: 0, retryMs: 0 };
  const r = await X.routeVia(pts, 'hiking-mountain', io);
  assert.equal(log.length, 2);
  assert.ok(log[0].includes('format=geojson') && log[0].includes('profile=hiking-mountain') && log[0].includes('alternativeidx=0'));
  assert.equal(r.coords.length, 30);
  near(r.lengthM, 2900, 3);
  assert.equal(r.climbM, 24);
  const again = await X.routeVia(pts, 'hiking-mountain', io);
  assert.equal(log.length, 2);
  assert.equal(again.cached, 2);
  // a stale cache entry is fetched again
  const old = { ...io, now: () => Date.now() + 8 * 864e5 };
  await X.routeVia(pts, 'hiking-mountain', old);
  assert.equal(log.length, 4);
  // 503 once: retried; twice: gives up
  const l2 = [];
  await X.routeVia(pts.slice(0, 3), 'trekking', { fetchFn: fakeBrouter(l2, 1), pauseMs: 0, retryMs: 0 });
  assert.equal(l2.length, 2);
  await assert.rejects(X.routeVia(pts.slice(0, 3), 'trekking', { fetchFn: fakeBrouter([], 2), pauseMs: 0, retryMs: 0 }), /busy/);
  // a 400 is not retried
  const l3 = [];
  const bad = async u => { l3.push(u); return { ok: false, status: 400, text: async () => 'via-position not mapped' }; };
  await assert.rejects(X.routeVia(pts.slice(0, 3), 'trekking', { fetchFn: bad, pauseMs: 0, retryMs: 0 }), /not mapped/);
  assert.equal(l3.length, 1);
});

test('parseBrouter reads coords and the string properties', () => {
  const r = X.parseBrouter({ features: [{ properties: { 'track-length': '1234', 'filtered ascend': '56' }, geometry: { coordinates: [[-79, 43, 10], [-79.01, 43.01, 12]] } }] });
  assert.deepEqual(r.coords[0], [43, -79, 10]);
  assert.equal(r.lengthM, 1234);
  assert.equal(r.climbM, 56);
  assert.throws(() => X.parseBrouter({}), /no route/);
});

test('coverage: street nodes near the line, tiles the line passes through', () => {
  const geo = town();
  const s1 = X.streetTarget(geo, {}, 's:First St'), s3 = X.streetTarget(geo, {}, 's:Third St');
  const [tx, ty] = tileFor(...P(500, 2), 17), tile = X.tileTarget(tx, ty, 17);
  const far = X.tileTarget(tx + 50, ty, 17);
  const coords = [P(0, 10), P(1000, 10)];             // sparse on purpose: densified inside
  const cov = X.coverage(coords, [s1, s3, tile, far]);
  assert.equal(cov.get(s1.id), 1);
  assert.equal(cov.get(s3.id), 0);
  assert.equal(cov.get(tile.id), 1);
  assert.equal(cov.get(far.id), 0);
});

test('planAndRoute learns the detour and keeps the best fitting round', async () => {
  const start = P(0, 0);
  const ts = Array.from({ length: 10 }, (_, i) => pt('t' + i, 300 * (i + 1), 0));
  let rounds = 0;
  // A router whose real line is 1.8 x the crow-flies: the first plan (at 1.3) overshoots.
  const router = async pts => { rounds++; const l = X.lineM(pts) * 1.8; return { coords: pts, lengthM: l, climbM: 0 }; };
  const r = await X.planAndRoute({ start, optional: ts, budgetM: 6000, router });
  assert.ok(rounds >= 2 && rounds <= 3);
  assert.ok(r.route.lengthM <= 6600, 'fits within 10%: ' + r.route.lengthM);
  assert.ok(r.detour > X.DETOUR);
  // forced only: one round
  rounds = 0;
  await X.planAndRoute({ start, forced: ts.slice(0, 2), budgetM: 100, router });
  assert.equal(rounds, 1);
  // nothing reachable
  const none = await X.planAndRoute({ start, optional: [pt('far', 90000, 0)], budgetM: 1000, router });
  assert.equal(none.tour.length, 0);
  assert.equal(none.route, null);
});

test('postman: a grid of streets as one closed route, odd junctions paired', () => {
  const geo = town();
  const streets = ['s:First St', 's:Second St', 's:Third St', 's:Cross Rd'].map(k => X.streetTarget(geo, {}, k));
  const start = P(-30, -30);
  const r = X.postman(start, streets);
  assert.ok(r);
  assert.deepEqual(r.pts[0], start);
  assert.deepEqual(r.pts.at(-1), start);
  near(r.streetM, 4000, 20);
  // Cross Rd is split at Second St: junctions at its ends and middle, plus the three street ends east
  assert.ok(r.odd >= 2 && r.odd % 2 === 0, 'odd ' + r.odd);
  // every street's nodes lie close to the straight-line chain of waypoints
  const cov = X.coverage(r.pts, streets, 30);
  for (const s of streets) assert.ok(cov.get(s.id) > 0.95, s.id + ' ' + cov.get(s.id));
  // two separate streets get linked
  const apart = X.postman(start, [streets[0], streets[2]]);
  assert.equal(apart.links, 1);
  assert.equal(X.postman(start, []), null);
});

test('GPX: track with elevation, named and escaped waypoints', () => {
  const g = X.buildGpx('Run <new> & "ground"', [[43, -79, 100], [43.001, -79, null]], [{ pt: [43, -79], name: 'O\'Neil & Sons St', desc: 'x' }]);
  assert.ok(g.includes('<trkpt lat="43.000000" lon="-79.000000"><ele>100.0</ele></trkpt>'));
  assert.ok(g.includes('<trkpt lat="43.001000" lon="-79.000000"></trkpt>'));
  assert.ok(g.includes('O&apos;Neil &amp; Sons St'));
  assert.ok(g.includes('Run &lt;new&gt; &amp; &quot;ground&quot;'));
  assert.ok(!/undefined|NaN/.test(g));
});

test('libraryPoints: plan points when they fit, else 50 off the routed line', () => {
  const pts = [P(0, 0), P(100, 0)], coords = Array.from({ length: 200 }, (_, i) => P(i, 0));
  assert.equal(X.libraryPoints(pts, coords).length, 2);
  const many = Array.from({ length: 60 }, (_, i) => P(i, 0));
  const lp = X.libraryPoints(many, coords);
  assert.equal(lp.length, 50);
  assert.ok('lat' in lp[0] && 'lon' in lp[0]);
});

test('typicalPace: median of recent runs, null with too few', () => {
  const acts = [5, 6, 7].map((m, i) => ({ type: 'running', distance_m: 10000, moving_s: m * 600, start: '2026-01-0' + (i + 1) }));
  assert.equal(X.typicalPace(acts), 360);
  assert.equal(X.typicalPace(acts.slice(0, 2)), null);
  assert.equal(X.typicalPace(acts, true), null);
  assert.equal(X.typicalPace([...acts, { type: 'treadmill_running', distance_m: 5000, moving_s: 100, start: '2026-02-01' }]), 360);
});
