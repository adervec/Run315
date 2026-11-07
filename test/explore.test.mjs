import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../js/explore.js';

const acts = [
  { id: 'b', day: '2024-03-05', tiles: [[800, 800], [801, 800], [807, 800], [808, 800]] },
  { id: 'a', day: '2024-03-01', tiles: [[800, 800], [800, 801]] },
  { id: 'c', day: '2024-03-05', tiles: [[800, 800], [800, 800]] },
  { id: 'v', day: '2024-04-01', tiles: [] },
];

test('z14 is z17 shifted by three', () => {
  assert.equal(E.z14Key(800, 800), '100,100');
  assert.equal(E.z14Key(807, 815), '100,101');
  assert.equal(E.z14Key(808, 800), '101,100');
});

test('index: new tiles per activity in date order, visits per activity', () => {
  const ix = E.buildIndex(acts);
  assert.deepEqual(ix.order, ['a', 'b', 'c']);
  assert.deepEqual(ix.per.get('a').new17.sort(), ['800,800', '800,801']);
  assert.deepEqual(ix.per.get('a').new14, ['100,100']);
  assert.deepEqual(ix.per.get('b').new17.sort(), ['801,800', '807,800', '808,800']);
  assert.deepEqual(ix.per.get('b').new14, ['101,100']);
  assert.equal(ix.per.get('c').new17.length, 0);
  assert.equal(ix.per.get('c').n17, 1);            // duplicates within one activity count once
  assert.deepEqual(ix.tiles[17].get('800,800'), ['2024-03-01', '2024-03-05', 3]);
  assert.deepEqual(ix.tiles[14].get('100,100'), ['2024-03-01', '2024-03-05', 3]);
  assert.equal(ix.per.has('v'), false);
});

test('street gain only when the activity is alone on its day', () => {
  const cities = { r1: { gains: [['2024-03-05', 40, 4]] }, r2: { gains: [['2024-03-05', 8, 0]] } };
  assert.deepEqual(E.streetGain(cities, '2024-03-05', 1), { newStreetKm: 1.2, newTrailKm: 0.1 });
  assert.deepEqual(E.streetGain(cities, '2024-03-05', 2), { newStreetKm: null, newTrailKm: null });
  assert.deepEqual(E.streetGain({}, '2024-03-05', 1), { newStreetKm: null, newTrailKm: null });
  assert.deepEqual(E.streetGain(cities, '2024-03-06', 1), { newStreetKm: 0, newTrailKm: 0 });
});

test('unreachable toggles are sorted, deduplicated, per zoom', () => {
  let u = E.toggleUnreachable(undefined, 17, '5,2');
  u = E.toggleUnreachable(u, 17, '1,9');
  u = E.toggleUnreachable(u, 14, '3,3');
  assert.deepEqual(u, { 17: ['1,9', '5,2'], 14: ['3,3'] });
  u = E.toggleUnreachable(u, 17, '5,2');
  assert.deepEqual(u[17], ['1,9']);
  assert.equal(E.unreachableSet({ unreachable: u }, 14).has('3,3'), true);
  assert.equal(E.unreachableSet({}, 14).size, 0);
});

test('scoreboard: unreachable tiles fill the square when counted', () => {
  const claimed = new Map([['0,0', ['2024-01-01', '2024-01-01', 1]], ['1,0', ['2024-01-02', '2024-01-02', 1]],
    ['0,1', ['2024-02-01', '2024-02-01', 2]]]);
  const u = new Set(['1,1']);
  const on = E.scoreboard(claimed, u, 17, true, '2024-02-05');
  assert.equal(on.max_square, 2);
  assert.equal(on.tiles, 3);
  assert.equal(on.unreachable, 1);
  assert.equal(on.this_week, 1);
  assert.equal(on.since, '2024-01-01');
  assert.ok(!on.targets.some(([t]) => t[0] === 1 && t[1] === 1));
  const off = E.scoreboard(claimed, u, 17, false);
  assert.equal(off.max_square, 1);
  assert.ok(!off.targets.some(([t]) => t[0] === 1 && t[1] === 1), 'never target an unreachable tile');
});

test('new ground series fills empty periods', () => {
  const ix = E.buildIndex([{ id: 'a', day: '2024-01-10', tiles: [[1, 1]] }, { id: 'b', day: '2024-03-02', tiles: [[2, 1], [3, 1]] }]);
  assert.deepEqual(E.newGroundSeries(ix, 17, 'month'), [['2024-01-01', 1], ['2024-02-01', 0], ['2024-03-01', 2]]);
  assert.deepEqual(E.newGroundSeries(ix, 14, 'month', '2024-04-15'), [['2024-01-01', 1], ['2024-02-01', 0], ['2024-03-01', 0], ['2024-04-01', 0]]);
  assert.equal(E.weekOf('2024-03-03'), '2024-02-26');   // a Sunday -> its Monday
  assert.equal(E.weekOf('2024-03-04'), '2024-03-04');
  const w = E.newGroundSeries(ix, 17, 'week', null, 2);
  assert.deepEqual(w, [['2024-02-19', 0], ['2024-02-26', 2]]);
});

test('colouring buckets and legends', () => {
  assert.equal(E.styleIndex(['2020-01-01', '2024-01-01', 1], 'visits'), 0);
  assert.equal(E.styleIndex(['2020-01-01', '2024-01-01', 3], 'visits'), 1);
  assert.equal(E.styleIndex(['2020-01-01', '2024-01-01', 30], 'visits'), 4);
  assert.equal(E.legend('visits').map(l => l.label).join(' '), '1 2–3 4–9 10–24 25+');
  assert.equal(E.styleIndex(['2021-05-01', '2024-01-01', 1], 'year', { years: [2019, 2024] }), 2);
  assert.equal(E.legend('year', { years: [2019, 2024] }).length, 6);
  const cutoff = E.staleCutoff('2024-03-31', 6);
  assert.equal(cutoff, '2023-09-28');
  assert.equal(E.staleCutoff('2024-02-10', 14), '2022-12-10');
  assert.equal(E.styleIndex(['2020-01-01', '2023-01-01', 1], 'stale', { cutoff }), 1);
  assert.equal(E.styleIndex(['2020-01-01', '2024-01-01', 1], 'stale', { cutoff }), 0);
  assert.deepEqual(E.yearRange(new Map([['a', ['2019-02-01']], ['b', ['2022-01-01']]])), [2019, 2022]);
});

test('tiles in a map tile: same zoom, finer, coarse and bucketed', () => {
  const keys = ['8,8', '9,8', '1000,1000'], set = new Set(keys), has = k => set.has(k);
  const buckets = E.bucketize(keys, 2);
  // same zoom: one tile, the whole canvas
  assert.deepEqual(E.tilesInMapTile(8, 8, 17, 17, has, buckets, 2), [[8, 8, 0, 0, 256]]);
  // map zoomed in one level past the grid: the grid tile is twice the canvas
  assert.deepEqual(E.tilesInMapTile(17, 16, 18, 17, has, buckets, 2), [[8, 8, -256, 0, 512]]);
  // one map zoom out: map tile (4, 4) spans grid tiles 8..9
  assert.deepEqual(E.tilesInMapTile(4, 4, 16, 17, has, buckets, 2).map(t => t.slice(0, 2)), [[8, 8], [9, 8]]);
  // far out (d = 4 > shift 2): through the buckets
  const far = E.tilesInMapTile(0, 0, 13, 17, has, buckets, 2);
  assert.deepEqual(far.map(t => t.slice(0, 2)).sort(), [[8, 8], [9, 8]]);
  assert.equal(far[0][4], 16);
  // very far: the whole world in one map tile
  assert.equal(E.tilesInMapTile(0, 0, 0, 17, has, buckets, 2).length, 3);
});

test('mini map svg: new tiles solid, nothing for huge spans', () => {
  const svg = E.miniMapSvg([[1, 1], [2, 1]], new Set(['2,1']));
  assert.match(svg, /fill-opacity="0.9"/);
  assert.match(svg, /fill-opacity="0.22"/);
  assert.equal(E.miniMapSvg([[1, 1], [9000, 1]], new Set()), '');
});
