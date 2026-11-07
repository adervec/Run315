import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as RP from '../js/replay.js';

// A straight run north at a steady 4 m/s (4:10 /km), one fix a second, from 43.86, -79.33.
const DEG_PER_M = 1 / 111195;
function chans(secs, speed = 4, { hr = true, gapAt = -1 } = {}) {
  const ch = { seconds: [], metres: [], lat: [], lon: [], hr: [], elevation_m: [] };
  for (let s = 0; s <= secs; s++) {
    ch.seconds.push(s); ch.metres.push(s * speed);
    ch.lat.push(s === gapAt ? null : 43.86 + s * speed * DEG_PER_M); ch.lon.push(s === gapAt ? null : -79.33);
    ch.hr.push(hr ? 140 + (s % 10) : null); ch.elevation_m.push(100 + s / 10);
  }
  return ch;
}

test('trackFromChannels packs typed arrays, fills gaps, drops what is missing', () => {
  const tr = RP.trackFromChannels(chans(600, 4, { gapAt: 10 }));
  assert.equal(tr.n, 601);
  assert.ok(tr.t instanceof Float32Array && tr.lat instanceof Float32Array);
  assert.equal(tr.dur, 600); assert.equal(tr.dist, 2400);
  assert.equal(tr.lat[10], tr.lat[9]);            // missing fix holds the last one
  assert.ok(tr.hr && tr.ele); assert.equal(tr.pw, undefined);
  const lite = RP.trackFromChannels(chans(60), { lite: true });
  assert.equal(lite.hr, undefined);
  assert.equal(RP.trackFromChannels({ seconds: [0, 1], metres: [0, 1] }), null);   // no GPS
  assert.equal(RP.trackFromChannels({ seconds: [0, 1], metres: [0, 1], lat: [null, null], lon: [null, null] }), null);
  // Time running backwards is dropped; distance never decreases; t starts at 0.
  const odd = RP.trackFromChannels({ seconds: [100, 101, 99, 102], metres: [5, 6, 2, 4], lat: [1, 1, 1, 1], lon: [2, 2, 2, 2] });
  assert.deepEqual([...odd.t], [0, 1, 2]); assert.deepEqual([...odd.d], [0, 1, 1]);
});

test('interpolation by time and by distance', () => {
  const tr = RP.trackFromChannels(chans(600));
  assert.equal(RP.indexAt(tr.t, 10.5), 10);
  assert.equal(RP.indexAt(tr.t, -5), 0);
  assert.equal(RP.indexAt(tr.t, 1e9), 600);
  assert.ok(Math.abs(RP.distanceAt(tr, 10.5) - 42) < 1e-3);
  assert.ok(Math.abs(RP.timeAtDistance(tr, 1000) - 250) < 1e-3);
  const [la] = RP.posAt(tr, 250), [lb] = RP.posAtDistance(tr, 1000);
  assert.ok(Math.abs(la - lb) < 1e-6);
  assert.ok(Math.abs(RP.paceAt(tr, 300) - 250) < 0.5);   // 4 m/s = 250 s/km
  const r = RP.readout(tr, 300);
  assert.ok(Math.abs(r.d - 1200) < 1e-3); assert.equal(r.pw, null); assert.ok(r.hr >= 140); assert.ok(Math.abs(r.ele - 130) < 0.01);
});

test('a stop: time at distance is the first moment, pace is null while stood', () => {
  const ch = { seconds: [], metres: [], lat: [], lon: [] };
  for (let s = 0; s <= 200; s++) {
    const d = s < 100 ? s * 3 : s < 150 ? 300 : 300 + (s - 150) * 3;
    ch.seconds.push(s); ch.metres.push(d); ch.lat.push(43 + d * DEG_PER_M); ch.lon.push(-79);
  }
  const tr = RP.trackFromChannels(ch);
  assert.ok(Math.abs(RP.timeAtDistance(tr, 300) - 100) < 1e-6);
  assert.equal(RP.paceAt(tr, 140), null);
  assert.equal(RP.timeAtDistance(tr, tr.dist), 200);
});

test('tail chunks are continuous and end at the dot', () => {
  const tr = RP.trackFromChannels(chans(600));
  const ch = RP.tailChunks(tr, 300, 90, 6);
  assert.equal(ch.length, 6);
  for (let k = 1; k < ch.length; k++) assert.deepEqual(ch[k][0], ch[k - 1][ch[k - 1].length - 1]);
  assert.deepEqual(ch[5][ch[5].length - 1], RP.posAt(tr, 300));
  assert.deepEqual(RP.tailChunks(tr, 0), []);
  const th = RP.thin(tr, 100);
  assert.ok(th.length <= 102); assert.deepEqual(th[th.length - 1], [tr.lat[600], tr.lon[600]]);
});

test('ghost race: common distance, ranks and gaps, both alignments', () => {
  const fast = RP.trackFromChannels(chans(1300, 4), { lite: true });     // 5.2 km
  const slow = RP.trackFromChannels(chans(1300, 3.8), { lite: true });   // 4.94 km
  const race = RP.prepareRace([slow, fast]);
  assert.ok(Math.abs(race.raceDist - 4940) < 1e-3);
  assert.ok(Math.abs(race.finish[1] - 1235) < 1e-3);
  const mid = RP.standings([slow, fast], race, 600);
  assert.equal(mid[0].k, 1); assert.equal(mid[1].place, 2);
  assert.ok(Math.abs(mid[1].gap_m - 120) < 1e-3);                 // 2400 vs 2280 m
  assert.ok(Math.abs(mid[1].gap_s - 30) < 1e-3);                  // fast was at 2280 m at 570 s
  const end = RP.standings([slow, fast], race, 5000);
  assert.ok(end.every(r => r.done)); assert.equal(end[0].k, 1);
  assert.ok(Math.abs(end[1].gap_s - (1300 - 1235)) < 1e-3);
  const byD = RP.standings([slow, fast], race, 600, 'distance');
  assert.deepEqual(byD.find(r => r.k === 1).pos, RP.posAtDistance(slow, 2400));
});

test('similar runs: near the same start, similar distance', () => {
  const a = { id: 'a', distance_m: 10000, p0: [43.86, -79.33] };
  const c = [a, { id: 'b', distance_m: 10500, p0: [43.861, -79.33] }, { id: 'c', distance_m: 12000, p0: [43.86, -79.33] },
    { id: 'd', distance_m: 10000, p0: [43.9, -79.33] }, { id: 'e', distance_m: 9950, p0: [43.8601, -79.3301] }];
  assert.deepEqual(RP.similarRuns(c, a).map(r => r.id), ['a', 'e', 'b']);
  assert.deepEqual(RP.similarRuns(c, { id: 'x' }), []);
});

test('time-lapse events: tiles by first day, z14 roll-up, streets, cursor', () => {
  const ev = RP.tileEvents(new Map([['100,200', '2020-05-01'], ['101,200', '2019-01-02'], ['900,900', '2021-03-04']]));
  assert.equal(ev.n, 3); assert.equal(ev.x[0], 101); assert.equal(RP.dayStr(ev.day[0]), '2019-01-02');
  const z14 = RP.tileEvents({ '100,200': '2020-05-01', '101,200': '2019-01-02', '103,207': '2022-01-01' }, 14);
  assert.equal(z14.n, 1); assert.equal(z14.x[0], 12); assert.equal(z14.y[0], 25); assert.equal(RP.dayStr(z14.day[0]), '2019-01-02');
  assert.equal(RP.countBy(ev.day, RP.dayNum('2020-05-01')), 2);
  assert.equal(RP.countBy(ev.day, RP.dayNum('2000-01-01')), 0);
  assert.equal(RP.countBy(ev.day, RP.dayNum('2030-01-01')), 3);
  const geo = { ways: [
    { k: 'w1', g: 's:Main St', c: [[43.86, -79.33], [43.8602, -79.33], [43.87, -79.33], [43.8702, -79.33]] },
    { k: 'w2', g: 's:Elm St', c: [[43.86, -79.32], [43.8602, -79.32]] }, { k: 'w3', c: [[1, 1], [1, 1.0001]] }] };
  const st = RP.streetEvents(geo, { 's:Main St': '2021-06-01', 's:Elm St': '2020-01-01' });
  assert.deepEqual(st.map(s => s.k), ['w2', 'w1']);
  assert.equal(st[1].pts.length, 10); assert.ok(Number.isNaN(st[1].pts[4]));   // the jump is broken
  const [x, y] = RP.toWorld(43.86, -79.33);
  assert.ok(x > 0 && y > 0 && x < 2 ** 17 && y < 2 ** 17);
});

test('year ramp, quantile box, recorder mime, background tiles', () => {
  const r = RP.yearRamp([2019, 2021, 2020, 2019], ['#000000', '#ffffff']);
  assert.deepEqual(Object.keys(r), ['2019', '2020', '2021']);
  assert.equal(r[2019], '#000000'); assert.equal(r[2021], '#ffffff'); assert.equal(r[2020], '#808080');
  assert.equal(RP.yearRamp([2020], ['#000000', '#ffffff'])[2020], '#ffffff');
  assert.equal(RP.mixHex('#000000', '#ff0000', 0.5), '#800000');
  const xs = [], ys = [];
  for (let i = 0; i < 100; i++) { xs.push(1000 + i); ys.push(2000 + i); }
  xs.push(99999); ys.push(1);
  const b = RP.quantileBox(xs, ys);
  assert.ok(b[2] < 2000 && b[1] > 1000);
  assert.equal(RP.quantileBox([], []), null);
  assert.equal(RP.pickMime(m => m === 'video/webm'), 'video/webm');
  assert.equal(RP.pickMime(() => false), '');
  const bg = RP.bgTiles({ cx: 1000.5, cy: 2000.5, s: 32, w: 512, h: 256 });
  assert.equal(bg.z, 14);    // 8 world units a tile x 32 px = 256 px
  assert.ok(bg.list.length >= 2 && bg.list.every(t => t.size === 256));
});
