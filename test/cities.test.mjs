// Street and trail completion by municipality: classification, clipping, matching, size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/cities.js';
import * as BS from '../js/bitset.js';
import * as TR from '../js/lib/trails.js';

const LAT = 43.85, LON = -79.3;   // Markham-ish
const dLon = m => m / (TR.M_PER_DEG_LAT * Math.cos(LAT * Math.PI / 180));
const dLat = m => m / TR.M_PER_DEG_LAT;
const P = (x, y) => ({ lat: LAT + dLat(y), lon: LON + dLon(x) });   // metres east/north of the origin
const ring = (x0, y0, x1, y1) => [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1), P(x0, y0)];

// A 2 km square town with a 200 m hole (an enclave) at 1000-1200 m.
function relation(id = 1) {
  return { type: 'relation', id, tags: { boundary: 'administrative', name: 'Testville', admin_level: '8' },
    bounds: { minlat: LAT, minlon: LON, maxlat: LAT + dLat(2000), maxlon: LON + dLon(2000) },
    members: [
      // the outer ring split into two member ways, as OSM does
      { type: 'way', role: 'outer', geometry: ring(0, 0, 2000, 2000).slice(0, 3) },
      { type: 'way', role: 'outer', geometry: ring(0, 0, 2000, 2000).slice(2) },
      { type: 'way', role: 'inner', geometry: ring(1000, 1000, 1200, 1200) },
      { type: 'node', role: 'admin_centre' },
    ] };
}
let wid = 100;
const way = (tags, x0, y0, x1, y1) => ({ type: 'way', id: wid++, tags: { highway: 'residential', ...tags }, geometry: [P(x0, y0), P(x1, y1)] });

test('classify: streets need a name and public access; no driveways or sidewalks', () => {
  assert.equal(C.classify({ highway: 'residential', name: 'Main St' }), 's');
  assert.equal(C.classify({ highway: 'residential' }), null, 'unnamed street');
  assert.equal(C.classify({ highway: 'residential', name: 'X', access: 'private' }), null);
  assert.equal(C.classify({ highway: 'residential', name: 'X', foot: 'no' }), null);
  assert.equal(C.classify({ highway: 'residential', name: 'X', access: 'customers' }), null);
  assert.equal(C.classify({ highway: 'pedestrian', name: 'Square', access: 'no', foot: 'yes' }), 's', 'foot=yes overrides access');
  assert.equal(C.classify({ highway: 'service', name: 'Mill Lane' }), 's');
  assert.equal(C.classify({ highway: 'service', name: 'Mill Lane', service: 'driveway' }), null);
  assert.equal(C.classify({ highway: 'service', name: 'P', service: 'parking_aisle' }), null);
  assert.equal(C.classify({ highway: 'service', name: 'P', service: 'drive-through' }), null);
  assert.equal(C.classify({ highway: 'service', name: 'Alley', service: 'alley', access: 'private' }), null);
  assert.equal(C.classify({ highway: 'motorway', name: '404' }), null);
  assert.equal(C.classify({ highway: 'trunk', name: '7' }), null);
  assert.equal(C.classify({ highway: 'construction', name: 'New St' }), null);
  assert.equal(C.classify({ highway: 'pedestrian', name: 'Plaza', area: 'yes' }), null);
  assert.equal(C.classify({ highway: 'path' }), 't', 'unnamed trail still counts');
  assert.equal(C.classify({ highway: 'footway', footway: 'sidewalk', name: 'Main St' }), null);
  assert.equal(C.classify({ highway: 'footway', footway: 'crossing' }), null);
  assert.equal(C.classify({ highway: 'footway', footway: 'traffic_island' }), null);
  assert.equal(C.classify({ highway: 'track', access: 'private' }), null);
  assert.equal(C.classify({ highway: 'steps' }), 't');
});

test('point in polygon: outer ring from split members, inner ring is a hole', () => {
  const inside = C.makeContains(C.boundaryLines(relation()));
  const at = (x, y) => { const p = P(x, y); return inside(p.lat, p.lon); };
  assert.equal(at(500, 500), true);
  assert.equal(at(1100, 1100), false, 'in the hole');
  assert.equal(at(1300, 1100), true);
  assert.equal(at(2100, 500), false);
  assert.equal(at(-10, 500), false);
});

test('buildArea: clips to the boundary, groups streets by name case-insensitively', () => {
  wid = 100;
  const data = { elements: [relation(),
    way({ name: 'Main St' }, 100, 500, 600, 500),
    way({ name: 'main st' }, 600, 500, 900, 500),          // same street, other spelling
    way({ name: 'Edge Rd' }, 1500, 300, 2500, 300),        // half outside
    way({ name: 'Hole St' }, 1050, 1100, 1150, 1100),      // wholly in the enclave
    way({ highway: 'path', name: 'Creek Trail' }, 100, 800, 600, 800),
    way({ highway: 'path' }, 100, 900, 400, 900),          // unnamed trail
    way({ highway: 'footway', footway: 'sidewalk', name: 'Main St' }, 100, 510, 600, 510),
  ] };
  const geo = C.buildArea(data, 1);
  const g = geo.groups;
  assert.deepEqual(Object.keys(g).sort(), ['s:Edge Rd', 's:Main St', 't:Creek Trail']);
  assert.equal(g['s:Main St'].ways.length, 2);
  assert.ok(Math.abs(g['s:Main St'].len_m - 800) < 30);
  assert.ok(Math.abs(g['s:Edge Rd'].len_m - 500) < 40, 'only the half inside: ' + g['s:Edge Rd'].len_m);
  assert.equal(geo.ways.filter(w => w.t === 't').length, 2);
  assert.equal(geo.ways.find(w => w.t === 't' && !w.g).g, null);
  assert.throws(() => C.buildArea({ elements: [] }, 1), /boundary/);
});

// Tracks along the test streets, sampled every 10 m like a watch (a long jump is a break).
const track = (x0, y0, x1, y1) => {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 10), out = [];
  for (let i = 0; i <= n; i++) { const p = P(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n); out.push([p.lat, p.lon]); }
  return out;
};

function fixture() {
  wid = 100;
  const data = { elements: [relation(),
    way({ name: 'Main St' }, 100, 500, 1100, 500),       // 1 km
    way({ name: 'Short St' }, 100, 300, 300, 300),       // 200 m
    way({ highway: 'path', name: 'Creek Trail' }, 100, 800, 600, 800),
    way({ highway: 'path' }, 100, 900, 400, 900)] };
  const geo = C.buildArea(data, 1);
  const rec = { id: 'r1', bbox: [LAT, LON, LAT + dLat(2000), LON + dLon(2000)] };
  const tracks = {
    a1: track(100, 300, 300, 300),            // all of Short St
    a2: track(100, 500, 500, 500),            // 40% of Main St
    a3: track(100, 500, 1100, 500),           // all of Main St (repeat of a2's part)
    a4: track(100, 800, 350, 800),            // half of Creek Trail
    far: track(100, 300, 300, 300).map(([a, b]) => [a + 2, b]),   // 200 km north
  };
  const acts = [
    { id: 'a3', date: '2026-03-01', p0: tracks.a3[0] },
    { id: 'a1', date: '2026-01-10', p0: tracks.a1[0] },
    { id: 'a2', date: '2026-02-01', p0: null },
    { id: 'a4', date: '2026-02-01', p0: tracks.a4[0] },
    { id: 'far', date: '2026-01-01', p0: tracks.far[0] },
    { id: 'nogps', date: '2026-01-02', p0: null },
  ];
  const reads = [];
  const loadTrack = async id => { reads.push(id); return tracks[id] ? { coords: tracks[id], coarse: id === 'a4' } : null; };
  return { geo, rec, acts, loadTrack, reads };
}

test('90% rule, completion dates and per-day gains, oldest first', async () => {
  const { geo, rec, acts, loadTrack, reads } = fixture();
  const r = await C.matchArea({ rec, geo, acts, loadTrack, yieldEvery: 2 });
  assert.equal(r.summary.done['s:Short St'], '2026-01-10');
  assert.equal(r.summary.done['s:Main St'], '2026-03-01', 'crossed 90% on the full run, not the partial one');
  assert.ok(!r.summary.done['t:Creek Trail']);
  assert.equal(r.summary.totals.streets.count, 2);
  assert.equal(r.summary.totals.streets.done, 2);
  assert.equal(r.summary.totals.trails.named, 1);
  assert.equal(r.summary.totals.trails.done, 0);
  const [n, hit] = r.summary.list['t:Creek Trail'];
  assert.ok(hit / n > 0.4 && hit / n < 0.65, hit / n);
  assert.deepEqual(r.summary.gains.map(g => g[0]), ['2026-01-10', '2026-02-01', '2026-03-01']);
  // a3 only adds the part a2 had not covered
  const mainNodes = r.summary.list['s:Main St'][0];
  const g3 = r.summary.gains[2][1];
  assert.ok(g3 < mainNodes * 0.7 && g3 > mainNodes * 0.45, g3 + '/' + mainNodes);
  assert.equal(r.matched.far, '-');
  assert.ok(!reads.includes('far'), 'far run skipped from its start point, never read');
  assert.equal(r.matched.nogps, '0');
  assert.equal(r.matched.a4, 'c');
  assert.equal(r.stats.runs, 4);
  assert.equal(r.stats.coarse, 1);
  // totals agree with the list
  const sum = Object.entries(r.summary.list).filter(([k]) => k[0] === 's').reduce((s, [, v]) => s + v[1], 0);
  assert.equal(sum, r.summary.totals.streets.nodesDone);
});

test('a 90% street is done, an 85% one is not', async () => {
  const { geo, rec } = fixture();
  const mainNodes = geo.groups['s:Main St'].nodes;
  const ctx = C.context(geo, rec);
  const [w] = geo.ways.filter(x => x.g === 's:Main St');
  const mask = n => Uint8Array.from({ length: w.c.length }, (_, i) => (i < n ? 1 : 0));
  C.applyHits(ctx, { [w.k]: mask(Math.floor(mainNodes * 0.85)) }, '2026-01-01');
  assert.ok(!ctx.done['s:Main St']);
  const r = C.applyHits(ctx, { [w.k]: mask(Math.ceil(mainNodes * 0.9)) }, '2026-01-02');
  assert.deepEqual(r.finished, ['s:Main St']);
  assert.equal(ctx.done['s:Main St'], '2026-01-02');
});

test('incremental: only new activities are read, coverage carries over', async () => {
  const { geo, rec, acts, loadTrack, reads } = fixture();
  const first = await C.matchArea({ rec, geo, acts: acts.filter(a => a.id !== 'a3'), loadTrack });
  assert.ok(!first.summary.done['s:Main St']);
  const rec2 = { ...rec, ...first.summary };
  reads.length = 0;
  const second = await C.matchArea({ rec: rec2, geo, matched: first.matched, acts, loadTrack });
  assert.deepEqual(reads, ['a3']);
  assert.equal(second.stats.checked, 1);
  assert.equal(second.summary.done['s:Main St'], '2026-03-01');
  assert.equal(second.summary.done['s:Short St'], '2026-01-10');
  // and it agrees with a full replay
  const full = await C.matchArea({ rec: rec2, geo, matched: second.matched, acts, loadTrack, full: true });
  assert.deepEqual(full.summary.cover, second.summary.cover);
  assert.deepEqual(full.summary.done, second.summary.done);
  // nothing new: nothing read
  reads.length = 0;
  const third = await C.matchArea({ rec: { ...rec, ...second.summary }, geo, matched: second.matched, acts, loadTrack });
  assert.equal(third.stats.checked, 0);
  assert.deepEqual(reads, []);
});

test('reading the record: rows, timeline, finished since', async () => {
  const { geo, rec, acts, loadTrack } = fixture();
  const r = await C.matchArea({ rec, geo, acts, loadTrack });
  const full = { ...rec, ...r.summary };
  const rows = C.groupRows(full, 's');
  assert.equal(rows.length, 2);
  assert.ok(rows.every(x => x.complete && x.left === 0 && x.done_on));
  const tl = C.timeline(full);
  assert.equal(tl.length, 3);
  assert.ok(tl[2].streets > 90 && tl[2].streets <= 100);
  assert.equal(C.finishedSince(full, 's', '2026-02-15'), 1);
  assert.deepEqual(C.groupRows({}, 's'), []);
  assert.deepEqual(C.timeline(null), []);
});

test('nameQuery escapes regex and quotes; areaQuery rejects junk', () => {
  const q = C.nameQuery('St. John\'s "X"');
  assert.ok(q.includes('St\\\\. John'), q);
  assert.ok(q.includes('\\"X\\"'), q);
  assert.throws(() => C.areaQuery('1;out'), /relation id/);
  assert.match(C.areaQuery(123), /rel\(123\)/);
});

test('parseBoundaries: most local first, too-large flagged', () => {
  const rel = (id, name, lvl, s, w, n, e) => ({ type: 'relation', id, tags: { boundary: 'administrative', name, admin_level: String(lvl) },
    bounds: { minlat: s, minlon: w, maxlat: n, maxlon: e } });
  const out = C.parseBoundaries({ elements: [
    rel(1, 'Ontario', 4, 41.6, -95.2, 56.9, -74.3), rel(2, 'Markham', 8, 43.80, -79.43, 43.96, -79.17),
    rel(3, 'York Region', 6, 43.75, -79.75, 44.42, -79.0), rel(2, 'Markham', 8, 43.80, -79.43, 43.96, -79.17)] });
  assert.deepEqual(out.map(b => b.name), ['Markham', 'York Region', 'Ontario']);
  assert.equal(out[0].tooLarge, false);
  assert.ok(out[0].km2 > 200 && out[0].km2 < 500, out[0].km2);
  assert.equal(out[1].tooLarge, true);
  assert.equal(out[2].tooLarge, true);
});

test('loadArea refuses a too-large area before asking Overpass', async () => {
  let asked = 0;
  await assert.rejects(C.loadArea({ id: 3, name: 'York Region', km2: 4000 }, { overpass: async () => { asked++; return {}; } }), /too big/);
  assert.equal(asked, 0);
});

test('the synced record stays small for a 5,000-way area', async () => {
  // 50 rows x 100 named 150-200 m streets and footways; every other row is run end to end.
  wid = 1e9;
  const els = [{ ...relation(9), bounds: { minlat: LAT - 0.1, minlon: LON - 0.1, maxlat: LAT + 0.2, maxlon: LON + 0.2 },
    members: [{ type: 'way', role: 'outer', geometry: ring(-10, -10, 21000, 21000) }] }];
  for (let i = 0; i < 5000; i++) {
    const x = (i % 100) * 200, y = Math.floor(i / 100) * 400;
    const tags = i % 5 === 0 ? { highway: 'footway', ...(i % 10 ? {} : { name: 'Trail ' + (i % 300) }) } : { name: 'Long Street Name Avenue ' + (i % 900) };
    els.push(way(tags, x, y, x + 150 + (i % 3) * 25, y));
  }
  const geo = C.buildArea({ elements: els }, 9);
  assert.equal(geo.ways.length, 5000);
  const tracks = {}, acts = [];
  for (let r = 0; r < 50; r += 2) {
    tracks['x' + r] = track(0, r * 400, 20000, r * 400);
    acts.push({ id: 'x' + r, date: '2026-0' + (1 + (r % 9)) + '-01', p0: null });
  }
  const res = await C.matchArea({ rec: { id: 'r9', bbox: [LAT - 0.1, LON - 0.1, LAT + 0.2, LON + 0.2] }, geo, acts,
    loadTrack: async id => ({ coords: tracks[id], coarse: false }) });
  const rec = { id: 'r9', name: 'Synthetic', admin_level: 8, osm_relation: 9, bbox: [0, 0, 0, 0], loaded_at: new Date().toISOString(),
    matched_at: new Date().toISOString(), runs: 25, coarse: 0, ...res.summary };
  const bytes = JSON.stringify(rec).length;
  assert.ok(Object.keys(rec.cover).length >= 2400, 'half the ways covered');
  assert.ok(bytes < 300 * 1024, 'synced record ' + bytes + ' bytes');
  console.log('synthetic 5,000-way record:', bytes, 'bytes;', Object.keys(rec.list).length, 'groups');
});

test('pieces split at gaps and by coverage', () => {
  const c = [[0, 0], [0, dLon(25)], [0, dLon(50)], [0, dLon(500)], [0, dLon(525)]];
  assert.equal(C.pieces(c).length, 2);
  const bs = BS.create(5); BS.set(bs, 0); BS.set(bs, 1); BS.set(bs, 3);
  assert.equal(C.pieces(c, bs, true).length, 1);
  assert.equal(C.pieces(c, bs, false).length, 0);
});

test('trails page: legacy 0/1 covers read the same and migrate to bitsets', async () => {
  const { migrateCovers, buildTrails } = await import('../js/pages/trails.js');
  const { emptyState } = await import('../js/merge.js');
  const st = emptyState();
  st.trailAreas.a = { id: 'a', name: 'A', loaded_at: '2026-01-01', cover: { 1: '1111100000', 2: '0000000000000000000011' },
    ways: { 1: ['Creek', 'path', 10, 250], 2: ['Creek', 'path', 22, 550] } };
  const before = buildTrails(st)[0][0];
  assert.equal(before.hit, 7);
  assert.equal(migrateCovers(st), 1);
  assert.ok(!BS.isLegacy(st.trailAreas.a.cover[1], 10));
  assert.ok(st.trailAreas.a.u);
  assert.deepEqual(buildTrails(st)[0][0].hit, 7);
  assert.equal(migrateCovers(st), 0, 'idempotent');
});

test('cities page renders a synced area without geometry (the phone)', async () => {
  const store = await import('../js/store.js');
  const page = await import('../js/pages/cities.js');
  const { geo, rec, acts, loadTrack } = fixture();
  const r = await C.matchArea({ rec, geo, acts, loadTrack });
  store.state.cities = { r1: { ...rec, name: 'Testville', admin_level: 8, osm_relation: 1, loaded_at: '2026-01-01T00:00:00Z',
    matched_at: new Date().toISOString(), runs: 4, coarse: 1, ...r.summary } };
  try {
    const out = String(await page.render({}));
    assert.ok(!/\bundefined\b|\bNaN\b|\[object Object\]/.test(out), out.match(/.{0,80}(undefined|NaN|\[object Object\]).{0,80}/)?.[0]);
    for (const s of ['Testville', 'Short St', 'Load map data', 'Coverage over time', '1 from coarse tracks']) assert.ok(out.includes(s), s);
  } finally { delete store.state.cities; }
});

test('matchNew: end to end against the demo athlete, from streams, incremental', async () => {
  const store = await import('../js/store.js');
  const { emptyState } = await import('../js/merge.js');
  const { importGarmin } = await import('../js/ingest.js');
  const { demoGarminPayload } = await import('../js/demo.js');
  const D = await import('../js/derive.js');
  await store.loadState();
  store.replaceState(emptyState());
  const r = await importGarmin(store.state, demoGarminPayload(), store.putStream);
  await D.deriveAll(store.state, r.streams);
  let line = null;
  for (const a of D.runs(store.state)) { const det = await D.getDetail(a.id); if (det && det.points && det.points.length > 20) { line = det.points.slice(0, 20); break; } }
  assert.ok(line, 'a demo run with a track');
  const lats = line.map(p => p[0]), lons = line.map(p => p[1]);
  const [s, w, n, e] = [Math.min(...lats) - 0.05, Math.min(...lons) - 0.05, Math.max(...lats) + 0.05, Math.max(...lons) + 0.05];
  const sq = [[s, w], [s, e], [n, e], [n, w], [s, w]].map(([lat, lon]) => ({ lat, lon }));
  const geo = C.buildArea({ elements: [
    { type: 'relation', id: 5, tags: { boundary: 'administrative' }, members: [{ type: 'way', role: 'outer', geometry: sq }] },
    { type: 'way', id: 77, tags: { highway: 'residential', name: 'Demo Street' }, geometry: line.map(([lat, lon]) => ({ lat, lon })) },
  ] }, 5);
  await store.idbSet('cache', C.geoKey('r5'), geo);
  store.state.cities = store.state.cities || {};
  store.state.cities.r5 = { id: 'r5', name: 'Demo', bbox: [s, w, n, e] };
  const out = await C.matchNew(['r5']);
  assert.ok(out.r5.runs >= 1, JSON.stringify(out));
  const rec = store.state.cities.r5;
  assert.ok(rec.totals.streets.nodesDone > 0);
  assert.ok(rec.list['s:Demo Street'][1] > 0);
  assert.ok(rec.matched_at);
  const again = await C.matchNew();
  assert.equal(again.r5.checked, 0, 'nothing new the second time');
});
