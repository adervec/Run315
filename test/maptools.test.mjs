// The map pages' glue: route validation and the route maker's maths (js/routemaker.js),
// and the trails page's matching and synced summaries (js/pages/trails.js) run end to
// end against the demo athlete, with a fake Overpass answer laid over one demo run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/store.js';
import { importGarmin } from '../js/ingest.js';
import { demoGarminPayload } from '../js/demo.js';
import { emptyState, put } from '../js/merge.js';
import * as D from '../js/derive.js';
import * as TR from '../js/lib/trails.js';
import * as RM from '../js/routemaker.js';
import * as TP from '../js/pages/trails.js';

test('saved routes: the server validation, upsert by name', () => {
  const st = emptyState();
  assert.throws(() => RM.saveRoute(st, { name: ' ', profile: 'trekking', rtype: 'p2p', pts: [{ lat: 1, lon: 2 }] }), /name/);
  assert.throws(() => RM.saveRoute(st, { name: 'a', profile: 'car', rtype: 'p2p', pts: [{ lat: 1, lon: 2 }] }), /profile/);
  assert.throws(() => RM.saveRoute(st, { name: 'a', profile: 'mtb', rtype: 'zigzag', pts: [{ lat: 1, lon: 2 }] }), /profile/);
  assert.throws(() => RM.saveRoute(st, { name: 'a', profile: 'mtb', rtype: 'loop', pts: [] }), /waypoints/);
  assert.throws(() => RM.saveRoute(st, { name: 'a', profile: 'mtb', rtype: 'loop', pts: [{ lat: 91, lon: 0 }] }), /waypoints/);
  assert.equal(RM.cleanWaypoints(Array.from({ length: 51 }, () => ({ lat: 0, lon: 0 }))), null);
  const id = RM.saveRoute(st, { name: 'x'.repeat(200), profile: 'mtb', rtype: 'loop', pts: [{ lat: 1.123456789, lon: '2.5' }] });
  assert.equal(st.routes[id].name.length, 120);
  assert.deepEqual(st.routes[id].pts, [{ lat: 1.123457, lon: 2.5 }]);
  const again = RM.saveRoute(st, { name: 'x'.repeat(120), profile: 'trekking', rtype: 'p2p', pts: [{ lat: 0, lon: 0 }] });
  assert.equal(again, id, 'same name is the same route');
  assert.equal(Object.keys(st.routes).length, 1);
  RM.deleteRoute(st, id);
  assert.ok(st.tombs.routes[id]);
});

test('route maker maths (the old #selftest)', () => {
  const sq = [{ lat: 0, lon: 0, ele: 0 }, { lat: 0, lon: 1, ele: 10 }, { lat: 0, lon: 2, ele: 5 }];
  assert.ok(Math.abs(RM.distanceKm(sq) - 222.6) < 1);
  assert.equal(RM.climbM(sq), 10);
  assert.ok(Math.abs(RM.bearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 90) < 0.1);
  const dp = RM.destPoint(0, 0, 90, 111320);
  assert.ok(Math.abs(dp.lon - 1) < 0.01 && Math.abs(dp.lat) < 0.01);
  const idx = RM.splitByStops([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 2 }, { lat: 0, lon: 3 }],
    [{ lat: 0, lon: 0 }, { lat: 0, lon: 1.5 }, { lat: 0, lon: 3 }]);
  assert.ok(idx[0] === 0 && idx[2] === 3 && idx[1] > 0 && idx[1] < 3);
  const ds = RM.downsample(Array.from({ length: 100 }, (_, i) => ({ lat: i, lon: 0 })), 5);
  assert.ok(ds.length === 5 && ds[0].lat === 0 && ds[4].lat === 99);
  assert.equal(RM.xmlEsc('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
  assert.match(RM.buildGpx('a<b', [{ lat: 1, lon: 2 }], [{ lat: 1, lon: 2, ele: 3 }]), /<rtept lat="1" lon="2"\/>.*a&lt;b/s);
});

test('trails: match demo runs, summarise into the synced area, ledger without geometry', async () => {
  await store.loadState();
  store.replaceState(emptyState());
  const r = await importGarmin(store.state, demoGarminPayload(), store.putStream);
  await D.deriveAll(store.state, r.streams);
  // A trail laid exactly along the first stretch of a demo run, plus one nobody ran.
  const run = D.runs(store.state).find(a => store.state.derived[a.id]?.points?.length > 20);
  const line = store.state.derived[run.id].points.slice(0, 20);
  const geom = pts => pts.map(([lat, lon]) => ({ lat, lon }));
  const far = line.map(([la, lo]) => [la + 0.05, lo]);
  const segs = TR.segmentsFromOverpass({ elements: [
    { type: 'way', id: 1, tags: { highway: 'path', name: 'Demo Trail' }, geometry: geom(line) },
    { type: 'way', id: 2, tags: { highway: 'track' }, geometry: geom(far) },
  ] });
  assert.equal(segs.length, 2);
  await TP.storeSegs('a1', segs);
  put(store.state, 'trailAreas', 'a1', { id: 'a1', name: 'Test', bbox: [0, 0, 1, 1], loaded_at: '2026-01-01T00:00:00Z', seg_count: 2,
    cover: {}, gains: [], ways: Object.fromEntries(segs.map(s => [s.id, [s.name, s.kind, s.coords.length, s.len_m]])) });
  const m = await TP.matchRuns();
  assert.ok(m.matched >= 1 && m.touched >= 1);
  const area = store.state.trailAreas.a1;
  assert.ok(area.cover['1'] && /1/.test(area.cover['1']), 'the run trail is covered');
  assert.ok(!area.cover['2'], 'the far way is not');
  assert.ok(area.gains.length >= 1);
  const [trails, totals] = TP.buildTrails(store.state);
  const demo = trails.find(t => t.name === 'Demo Trail');
  assert.ok(demo.pct > 0.5, 'most of the trail is covered: ' + demo.pct);
  assert.equal(totals.segments, 2);
  const g = TP.newGround(store.state);
  assert.ok(g.total_m > 0 && g.streaks.days >= 1);
  // Re-running matches nothing new.
  assert.equal((await TP.matchRuns()).matched, 0);
  const html = String(await TP.render());
  assert.match(html, /Demo Trail/);
  assert.doesNotMatch(html, /\bundefined\b|\bNaN\b|\[object Object\]/);
});
