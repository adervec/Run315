import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/collect.js';

const run = (start, km, extra = {}) => ({ id: 'r' + start + km, type: 'running', start, distance_m: km * 1000, moving_s: km * 300, ...extra });

test('eddingtonOf: the classic definition', () => {
  assert.equal(C.eddingtonOf([]).E, 0);
  assert.equal(C.eddingtonOf([0.5]).E, 0);
  assert.equal(C.eddingtonOf([1]).E, 1);
  assert.equal(C.eddingtonOf([5, 5, 5, 5, 5]).E, 5);
  assert.equal(C.eddingtonOf([10, 10, 3]).E, 3);
  assert.equal(C.eddingtonOf([2.9, 3, 3, 3]).E, 3);
  const e = C.eddingtonOf([10, 9, 8, 7, 6, 2]);
  assert.equal(e.E, 5);
  // E+1 = 6: five days at >= 6 -> one more needed; E+2 = 7: four days -> three more
  assert.deepEqual(e.next.slice(0, 2), [{ n: 6, have: 5, need: 1 }, { n: 7, have: 4, need: 3 }]);
  assert.deepEqual(e.curve.slice(0, 3), [[1, 6], [2, 6], [3, 5]]);
});

test('eddington: days add up, run and ride apart, km and miles', () => {
  const st = { activities: {
    a: run('2026-01-01T07:00:00', 1), b: run('2026-01-01T18:00:00', 1.5),   // 2.5 km on one day
    c: run('2026-01-02T07:00:00', 3), d: run('2026-01-03T07:00:00', 3.3),
    e: { id: 'e', type: 'cycling', start: '2026-01-04T08:00:00', distance_m: 40000 },
  } };
  const e = C.eddington(st);
  assert.equal(e.run.km.E, 2);           // 2.5, 3, 3.3 km: three days >= 2, two >= 3
  assert.equal(e.run.km.days, 3);
  assert.equal(e.run.mi.E, 1);           // 1.55, 1.86, 2.05 mi: only one day >= 2
  assert.equal(e.ride.km.E, 1);
});

test('startClusters: groups by ~2 km cell, skips virtual and missing points', () => {
  const st = {
    activities: {
      a: run('2026-01-01T07:00:00', 5, { id: 'a' }), b: run('2026-02-01T07:00:00', 5, { id: 'b' }),
      c: run('2026-03-01T07:00:00', 5, { id: 'c' }), v: { id: 'v', type: 'virtual_ride', start: '2026-01-05T07:00:00', distance_m: 1 },
      n: run('2026-01-06T07:00:00', 5, { id: 'n' }),
    },
    derived: { a: { p0: [43.861, -79.331] }, b: { p0: [43.862, -79.333] }, c: { p0: [48.85, 2.35] }, v: { p0: [-11.6, 166.9] }, n: {} },
  };
  const cl = C.startClusters(st);
  assert.equal(cl.length, 2);
  assert.deepEqual(cl[0].ids, ['b', 'a']);
  assert.equal(cl[0].first, '2026-01-01');
  assert.equal(cl[0].last, '2026-02-01');
  assert.ok(Math.abs(cl[0].lat - 43.8615) < 1e-9);
  assert.deepEqual(C.pendingCells(cl, { [cl[1].key]: ['Paris', 'Île-de-France', 'fr'] }), [cl[0].key]);
});

test('parseNominatim and placeSummary', () => {
  const j = { name: 'Markham', address: { city: 'Markham', county: 'York Region', state: 'Ontario', country_code: 'ca' } };
  assert.deepEqual(C.parseNominatim(j), ['Markham', 'Ontario', 'ca']);
  assert.deepEqual(C.parseNominatim({ address: { village: 'X', county: 'Y', country_code: 'GB' } }), ['X', 'Y', 'gb']);
  assert.equal(C.parseNominatim({ error: 'Unable to geocode' }), null);
  const clusters = [
    { key: 'k1', ids: ['a', 'b'], first: '2025-01-01', last: '2026-01-01' },
    { key: 'k2', ids: ['c'], first: '2024-05-01', last: '2024-05-01' },
    { key: 'k3', ids: ['d'], first: '2026-02-01', last: '2026-02-01' },
  ];
  const s = C.placeSummary(clusters, { k1: ['Markham', 'Ontario', 'ca'], k2: ['Toronto', 'Ontario', 'ca'] });
  assert.equal(s.countries.length, 1);
  assert.equal(s.countries[0].count, 3);
  assert.equal(s.countries[0].first, '2024-05-01');
  assert.equal(s.countries[0].last, '2026-01-01');
  assert.equal(s.regions[0].name, 'Ontario');
  assert.deepEqual(s.municipalities.map(m => m.name), ['Markham', 'Toronto']);
  assert.equal(s.unresolved, 1);
});

test('privacy: zones cut the line, trim drops the ends', () => {
  // a straight line north, ~111 m per 0.001 deg, 20 points (~2.1 km)
  const pts = Array.from({ length: 20 }, (_, i) => [43.8 + i * 0.001, -79.3]);
  assert.equal(C.privateSegments(pts).length, 1);
  const zone = { lat: 43.81, lon: -79.3, radius_m: 250 };   // around point 10
  const segs = C.privateSegments(pts, { zones: [zone] });
  assert.equal(segs.length, 2);
  for (const p of segs.flat()) assert.ok(C.haversineM(p[0], p[1], zone.lat, zone.lon) > 250);
  const trimmed = C.applyPrivacyWith(pts, { trim_m: 200 });
  assert.ok(C.haversineM(trimmed[0][0], trimmed[0][1], pts[0][0], pts[0][1]) >= 200);
  assert.ok(C.haversineM(trimmed.at(-1)[0], trimmed.at(-1)[1], pts.at(-1)[0], pts.at(-1)[1]) >= 200);
  assert.deepEqual(C.privateSegments(pts.slice(0, 3), { trim_m: 200 }), []);   // shorter than both trims
  assert.deepEqual(C.privacyOf({ profile: { privacy: { zones: [{ lat: '1', lon: 2, radius_m: 300 }, { lat: 1 }], trim_m: 200 } } }),
    { zones: [{ lat: 1, lon: 2, radius_m: 300 }], trim_m: 200 });
  assert.deepEqual(C.privacyOf({}), { zones: [], trim_m: 0 });
});

test('fitSegments keeps aspect and stays inside the box', () => {
  const pix = C.fitSegments([[[0, 0], [1, 0], [1, 1]]], 100, 50, 5);
  for (const [x, y] of pix[0]) { assert.ok(x >= 0 && x <= 100); assert.ok(y >= 5 - 1e-9 && y <= 45 + 1e-9); }
  assert.ok(pix[0][1][1] < pix[0][0][1], 'north is up');
  assert.match(C.pathD(pix), /^M[\d.]+ [\d.]+L/);
  assert.deepEqual(C.fitSegments([], 10, 10), []);
  assert.equal(C.thin(Array.from({ length: 100 }, (_, i) => [i, i]), 10).length, 10);
});

test('cardStats', () => {
  const a = { type: 'running', distance_m: 10000, moving_s: 3000, avg_hr: 151.4, elev_gain_m: 88 };
  assert.deepEqual(C.cardStats(a), [['Distance', '10.00 km'], ['Time', '50:00'], ['Pace', '5:00 /km'], ['Avg HR', '151 bpm'], ['Climb', '88 m']]);
  assert.deepEqual(C.cardStats(a, new Set(['distance'])), [['Distance', '10.00 km']]);
  assert.equal(C.cardStats({ type: 'cycling', distance_m: 30000, moving_s: 3600 }, new Set(['pace']))[0][1], '30.0 km/h');
});

test('yearReview', () => {
  const runs = [
    run('2025-03-03T07:00:00', 10, { id: 'p1' }),
    run('2026-01-05T07:00:00', 5, { id: 'a' }), run('2026-01-06T07:00:00', 8, { id: 'b' }),
    run('2026-01-13T07:00:00', 21, { id: 'c', elev_gain_m: 100 }), run('2026-03-02T07:00:00', 6, { id: 'd' }),
  ];
  const prRows = [[5000, 1500, '2025-03-03', 'p1'], [5000, 1450, '2026-01-13', 'c'], [5000, 1490, '2026-01-05', 'a'], [10000, 3100, '2026-01-13', 'c']];
  const routes = [{ name: 'Loop', distance_m: 5000, runs: [{ id: 'a', start: new Date(2026, 0, 5) }, { id: 'b', start: new Date(2026, 0, 6) }, { id: 'p1', start: new Date(2025, 2, 3) }] }];
  const tiles = { 17: new Map([['1,1', ['2025-03-03']], ['1,2', ['2026-01-05']], ['1,3', ['2026-03-02']]]), 14: new Map([['0,0', ['2025-03-03']]]) };
  const cities = { r1: { gains: [['2026-01-05', 40, 4], ['2025-03-03', 100, 0]], done: { 's:Main St': '2026-01-05', 't:Path': '2026-01-06' } } };
  const r = C.yearReview({ runs, prRows, routes, tiles, cities }, 2026);
  assert.equal(r.totals.runs, 4);
  assert.equal(r.totals.distance_m, 40000);
  assert.equal(r.previous.distance_m, 10000);
  assert.equal(r.change, 3);
  assert.equal(r.longest.id, 'c');
  assert.equal(r.topWeeks[0].week, '2026-01-12');
  assert.equal(r.topWeeks[1].distance_m, 13000);
  assert.equal(r.longestWeekStreak, 2);
  assert.equal(r.weeksRun, 3);
  assert.equal(r.busiestMonth.name, 'January');
  assert.deepEqual(r.bests.map(b => [b.dist, b.secs, b.pr]), [[5000, 1450, true], [10000, 3100, true]]);
  assert.equal(r.bests[0].previous, 1500);
  assert.equal(r.route.count, 2);
  assert.deepEqual(r.newTiles, { z17: 2, z14: 0 });
  assert.deepEqual(r.streets, { new_km: 1, trail_km: 0.1, finished: 1 });
  assert.equal(C.yearReview({ runs }, 2019), null);
  assert.deepEqual(C.reviewYears(runs), [2026, 2025]);
});

test('posters are well-formed SVG', () => {
  const days = new Map([['2025-01-01', 5000], ['2025-06-01', 21000], ['2026-02-03', 10000]]);
  for (const svg of [C.yearRingsSvg(days, [2025, 2026]), C.contributionSvg(days, [2025, 2026]),
    C.routeGridSvg([{ segs: [[[43.8, -79.3], [43.81, -79.31], [43.8, -79.32]]] }, { segs: [] }], { title: 'A & B' })]) {
    assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.match(svg, /<\/svg>$/);
    assert.ok(!/NaN|undefined/.test(svg));
  }
  assert.match(C.routeGridSvg([{ segs: [[[0, 0], [1, 1]]] }], { title: 'A & B' }), /A &amp; B/);
  const cal = C.contributionSvg(days, [2025]);
  assert.equal((cal.match(/<rect x=/g) || []).length, 365);
  const lv = C.levels([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(lv(0), 0);
  assert.equal(lv(10), 5);
  assert.ok(lv(1) >= 1 && lv(1) < lv(10));
});

test('air: coverage, url, parse, bands, correlation', () => {
  assert.equal(C.airCoverage(48.85, 2.35, '2014-06-01', '2026-11-07').ok, true);
  assert.equal(C.airCoverage(43.86, -79.33, '2021-06-01', '2026-11-07').ok, false);
  assert.equal(C.airCoverage(43.86, -79.33, '2023-06-01', '2026-11-07').ok, true);
  assert.equal(C.airCoverage(48.85, 2.35, '2012-06-01', '2026-11-07').ok, false);
  assert.match(C.airUrl(48.85, 2.35, '2024-05-01'), /grass_pollen/);
  assert.doesNotMatch(C.airUrl(43.86, -79.33, '2024-05-01'), /pollen/);
  const j = { hourly: { time: ['2024-05-01T06:00', '2024-05-01T07:00'], pm2_5: [3, 4.5], pm10: [5, 6], us_aqi: [20, 25], ozone: [50, null], grass_pollen: [null, 12] } };
  assert.deepEqual(C.parseAir(j, '2024-05-01T07:42:00'), { pm2_5: 4.5, pm10: 6, us_aqi: 25, ozone: null, pollen: { grass: 12 }, hour: '2024-05-01T07:00' });
  assert.equal(C.parseAir({ hourly: { time: ['2021-01-01T07:00'], pm2_5: [null], pm10: [null], us_aqi: [null], ozone: [null] } }, '2021-01-01T07:00'), null);
  assert.equal(C.parseAir(j, '2024-05-02T07:00:00'), null);
  assert.equal(C.aqiBand(42), 'Good');
  assert.equal(C.aqiBand(120), 'Unhealthy for sensitive groups');
  assert.equal(C.aqiBand(null), null);
  const rows = [10, 20, 30, 60, 80, 120].map(aqi => ({ aqi, pace: 300 + aqi / 10, hr: 150 }));
  const c = C.airCorrelation(rows);
  assert.equal(c.n, 6);
  assert.ok(c.r_pace > 0.99);
  assert.equal(c.r_hr, null);   // constant HR: no correlation to speak of
  assert.deepEqual(c.bands.map(b => b.n), [3, 2, 1]);
});
