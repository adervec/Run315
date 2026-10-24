// Self-check for the POI layer catalogue. Port of test_pois.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/lib/pois.js';

test('test_catalogue_is_coherent', () => {
  const ids = P.LAYERS.map(l => l.id);
  assert.equal(ids.length, new Set(ids).size, 'duplicate layer id');
  assert.ok(P.LAYERS.length >= 15);
  for (const layer of P.LAYERS) {
    assert.ok(layer.label && layer.icon && layer.group);
    assert.ok(layer.match.length, layer.id);
    assert.ok(layer.radius > 0);
    for (const rule of layer.match) {
      assert.ok(rule && typeof rule === 'object' && !Array.isArray(rule) && Object.keys(rule).length);
    }
  }
  // The things that cost money are the ones flagged for a free filter.
  const paid = new Set(P.LAYERS.filter(l => l.fee_matters).map(l => l.id));
  assert.deepEqual(paid, new Set(['toilets', 'shower', 'pool']));
});

test('test_groups_preserve_order_and_cover_everything', () => {
  const gs = P.groups();
  assert.deepEqual(gs.map(([g]) => g), ['Body', 'Fuel', 'Water', 'Along the way', 'Getting there']);
  const covered = gs.flatMap(([, layers]) => layers.map(l => l.id));
  assert.deepEqual([...covered].sort(), P.LAYERS.map(l => l.id).sort());
});

test('test_selectors_are_generated_from_the_match_rules', () => {
  const water = P.BY_ID.water;
  const sels = water.selectors();
  assert.ok(sels.includes('["amenity"="drinking_water"]'));
  // A two-tag rule becomes a two-clause selector, sorted for stability.
  assert.ok(sels.includes('["drinking_water"="yes"]["man_made"="water_tap"]'));
  assert.deepEqual(P.BY_ID.beach.selectors(), ['["natural"="beach"]', '["leisure"="beach_resort"]']);
});

test('test_classify', () => {
  assert.equal(P.classify({ amenity: 'toilets' }).id, 'toilets');
  assert.equal(P.classify({ natural: 'beach' }).id, 'beach');
  assert.equal(P.classify({ leisure: 'water_park' }).id, 'waterpark');
  assert.equal(P.classify({ shop: 'coffee' }).id, 'coffee');
  assert.equal(P.classify({ highway: 'bus_stop' }).id, 'transit');
  assert.equal(P.classify({ amenity: 'bench' }).id, 'bench');
  assert.equal(P.classify({}), null);
  assert.equal(P.classify({ amenity: 'nightclub' }), null);
  // A partial match on a two-tag rule is not a match.
  assert.equal(P.classify({ man_made: 'water_tap' }), null);
  assert.equal(P.classify({ man_made: 'water_tap', drinking_water: 'yes' }).id, 'water');
  // Coffee is listed before food, so a cafe is coffee.
  assert.equal(P.classify({ amenity: 'cafe', cuisine: 'coffee_shop' }).id, 'coffee');
});

test('test_is_free', () => {
  assert.equal(P.isFree({ fee: 'no' }), true);
  assert.equal(P.isFree({ access: 'public' }), true);
  assert.equal(P.isFree({ fee: 'yes' }), false);
  assert.equal(P.isFree({ fee: 'Yes' }), false);              // case does not matter
  assert.equal(P.isFree({ access: 'customers' }), false);
  assert.equal(P.isFree({ access: 'private' }), false);
  assert.equal(P.isFree({}), null);                           // nobody has said
  // Locked beats free: a toilet marked fee=no behind a private door is not free.
  assert.equal(P.isFree({ fee: 'no', access: 'private' }), false);
});

test('test_thin', () => {
  assert.deepEqual(P.thin([]), []);
  assert.deepEqual(P.thin([[1, 2]]), [[1.0, 2.0]]);
  const line = Array.from({ length: 1000 }, (_, i) => [47.0 + i * 0.001, 8.0]);
  const out = P.thin(line, 50);
  assert.equal(out.length, 50);
  assert.deepEqual(out[0], line[0]);                          // both ends kept
  assert.deepEqual(out[out.length - 1], line[line.length - 1]);
  // Junk is dropped, not crashed on.
  assert.deepEqual(P.thin([[null, 1], ['x', 2], [47.0, 8.0], [999, 8.0], [NaN, 8.0]]), [[47.0, 8.0]]);
});

test('test_build_query', () => {
  const line = [[47.37, 8.54], [47.38, 8.55], [47.39, 8.56]];
  const q = P.buildQuery(line, ['toilets', 'beach']);
  assert.ok(q.startsWith('[out:json][timeout:60];('));
  assert.ok(q.endsWith(`out center tags ${P.MAX_RESULTS};`));
  assert.ok(q.includes('["amenity"="toilets"]') && q.includes('["natural"="beach"]'));
  assert.ok(q.includes(`nwr(around:${P.NEAR},`));             // toilets: close
  assert.ok(q.includes(`nwr(around:${P.WIDE},`));             // beach: wider
  assert.ok(q.includes('47.37000,8.54000'));
  // Everything asked for goes in one union, not one query per layer.
  assert.equal(q.split('[out:json]').length - 1, 1);

  assert.equal(P.buildQuery(line, []), null);
  assert.equal(P.buildQuery(line, ['nonsense']), null);
  assert.equal(P.buildQuery([[47.0, 8.0]], ['toilets']), null);
  assert.equal(P.buildQuery([], ['toilets']), null);
});

test('test_build_query_caps_the_corridor', () => {
  const longLine = Array.from({ length: 5000 }, (_, i) => [47.0 + i * 0.0001, 8.0]);
  const q = P.buildQuery(longLine, ['toilets']);
  assert.ok(q.split('47.').length - 1 <= P.MAX_CORRIDOR_POINTS + 2);
});

test('test_parse', () => {
  const data = { elements: [
    { type: 'node', id: 1, lat: 47.1, lon: 8.1,
      tags: { amenity: 'toilets', fee: 'no', name: 'Park WC' } },
    { type: 'node', id: 2, lat: 47.2, lon: 8.2,
      tags: { amenity: 'toilets', fee: 'yes' } },
    { type: 'way', id: 3, center: { lat: 47.3, lon: 8.3 },
      tags: { natural: 'beach', name: 'Strandbad' } },
    { type: 'node', id: 4, lat: 47.4, lon: 8.4,
      tags: { amenity: 'nightclub' } },                       // not in any layer
    { type: 'node', id: 5, lat: 47.5, lon: 8.5, tags: {} },
    { type: 'way', id: 6, tags: { leisure: 'water_park' } },  // no centre
  ] };
  const out = P.parse(data);
  const ids = out.map(o => [o.layer, o.name]);
  assert.ok(ids.some(([l, n]) => l === 'toilets' && n === 'Park WC'));
  assert.ok(ids.some(([l, n]) => l === 'beach' && n === 'Strandbad'));
  assert.equal(out.length, 3, JSON.stringify(ids));           // nightclub, bare node, no-centre dropped

  const free = Object.fromEntries(out.filter(o => o.layer === 'toilets').map(o => [o.name, o.free]));
  assert.equal(free['Park WC'], true);
  assert.equal(free.Toilets, false);                          // unnamed, falls back to the label

  // Ways get their centre, and areas come through as points.
  const beach = out.filter(o => o.layer === 'beach')[0];
  assert.ok(beach.lat === 47.3 && beach.lon === 8.3);

  // free_only drops the paid one but keeps things where fee is irrelevant.
  const onlyFree = P.parse(data, null, true);
  assert.deepEqual(onlyFree.filter(o => o.layer === 'toilets').map(o => o.name), ['Park WC']);
  assert.ok(onlyFree.some(o => o.layer === 'beach'));

  // Asking for one layer returns only that layer.
  assert.deepEqual(new Set(P.parse(data, ['beach']).map(o => o.layer)), new Set(['beach']));
  assert.ok(P.parse({}).length === 0 && P.parse(null).length === 0);
});

test('test_parse_dedupes_and_carries_detail', () => {
  const data = { elements: [
    { type: 'node', id: 9, lat: 47.1, lon: 8.1,
      tags: { amenity: 'cafe', name: 'Kaffee', opening_hours: 'Mo-Fr 07:00-18:00',
              wheelchair: 'yes' } },
    { type: 'node', id: 9, lat: 47.1, lon: 8.1,
      tags: { amenity: 'cafe', name: 'Kaffee' } },             // same element twice
  ] };
  const out = P.parse(data);
  assert.equal(out.length, 1);
  assert.equal(out[0].hours, 'Mo-Fr 07:00-18:00');
  assert.equal(out[0].wheelchair, 'yes');
  assert.equal(out[0].icon, P.BY_ID.coffee.icon);
  assert.equal(out[0].fee_matters, false);
  assert.equal(out[0].free, null);                            // fee is irrelevant for a cafe
});
