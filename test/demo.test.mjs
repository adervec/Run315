process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoGarminPayload, demoExtras } from '../js/demo.js';
import { emptyState } from '../js/merge.js';
import { importGarmin } from '../js/ingest.js';
import { addDays, dayKey, weekday } from '../js/lib/dt.js';

const NOW = new Date(2026, 9, 24, 14, 5, 0);

// What seed_demo() writes: a run on every day of the last 366 that is not a
// Monday or Friday, plus a ride on each Thursday.
function expected(now) {
  let runs = 0, rides = 0, first = null, last = null;
  for (let ago = 365; ago >= 0; ago--) {
    const d = addDays(now, -ago), dow = weekday(d);
    if (dow === 0 || dow === 4) continue;
    runs++; if (dow === 3) rides++;
    first = first || dayKey(d); last = dayKey(d);
  }
  return { runs, rides, first, last };
}

test('deterministic for the same now', () => {
  assert.deepEqual(demoGarminPayload(NOW), demoGarminPayload(new Date(+NOW)));
  assert.deepEqual(demoExtras(NOW), demoExtras(new Date(+NOW)));
});

test('activity count and date span match the Python demo', () => {
  const p = demoGarminPayload(NOW), e = expected(NOW);
  const runs = p.activities.filter(a => a.type === 'running'), rides = p.activities.filter(a => a.type === 'cycling');
  assert.equal(runs.length, e.runs);
  assert.equal(rides.length, e.rides);
  assert.equal(p.activities[0].start.slice(0, 10), e.first);
  assert.equal(runs[runs.length - 1].start.slice(0, 10), e.last);
  assert.ok(runs.every(a => a.start.endsWith('T07:30:00')));
  assert.ok(rides.every(a => a.start.endsWith('T16:30:00')));
  assert.equal(runs.filter(a => a.distance_m === 5000).length > 8, true);   // the monthly parkruns
  assert.equal(p.daily.length, 74);
  assert.equal(p.wellness.length, 74);
  assert.equal(p.gear.length, 3);
  assert.equal(p.metrics.length, 1);
  assert.deepEqual(Object.keys(p.metrics[0].races), ['5000', '10000', '21097', '42195']);
});

test('channels are equal-length arrays', () => {
  for (const a of demoGarminPayload(NOW).activities) {
    if (!a.channels) continue;
    const lens = new Set(Object.values(a.channels).map(v => v.length));
    assert.equal(lens.size, 1, a.garmin_id);
    assert.ok(a.channels.seconds.length > 100);
  }
});

test('races and courses', () => {
  const { races } = demoExtras(NOW);
  const byName = Object.fromEntries(Object.values(races).map(r => [r.name, r]));
  assert.equal(Object.keys(races).length, 6);
  assert.ok(byName['Club parkrun'].garmin_id && byName['Club parkrun'].course.points.length > 2);
  assert.ok(byName['Autumn Half'].course.length_m > 15000);
  assert.equal(byName['Club 10K'].date, dayKey(addDays(NOW, 21)));
});

test('imports through importGarmin', async () => {
  const p = demoGarminPayload(NOW), e = expected(NOW);
  const st = emptyState(), streams = new Map();
  const res = await importGarmin(st, p, async (id, rec) => { streams.set(id, rec); });
  assert.equal(Object.keys(st.activities).length, e.runs + e.rides);
  assert.equal(streams.size, e.runs);
  assert.equal(res.streams.length, e.runs);
  assert.equal(Object.keys(st.weather).length, e.runs);
  assert.equal(st.weather['gdemo-1'].conditions, 'Partly cloudy');
  assert.equal(Object.keys(st.activityGear).length, e.runs);
  assert.equal(Object.keys(st.daily).length, 74);
  assert.equal(Object.keys(st.wellness).length, 74);
  assert.equal(Object.keys(st.gear).length, 3);
  assert.equal(Object.keys(st.metrics).length, 1);
  assert.ok(JSON.stringify(p).length < 40e6);
});
