import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, merge, put, remove, syncPayload } from '../js/merge.js';
import { importGarmin, importStrava, samplesFromChannels, channelsFromStrava } from '../js/ingest.js';

const sink = () => { const m = new Map(); return { m, put: async (id, rec) => { m.set(id, rec); }, has: async (id, src) => m.has(id) && m.get(id).src === src }; };

test('merge: newer edit wins, tombstone only beats older edits', () => {
  const a = emptyState(), b = emptyState();
  put(a, 'races', 'r1', { name: 'old' }, '2026-01-01T00:00:00Z');
  put(b, 'races', 'r1', { name: 'new' }, '2026-01-02T00:00:00Z');
  assert.equal(merge(a, syncPayload(b)).races.r1.name, 'new');
  assert.equal(merge(b, syncPayload(a)).races.r1.name, 'new');
  remove(a, 'races', 'r1', '2026-01-01T12:00:00Z');                 // deleted before b's edit
  assert.equal(merge(b, syncPayload(a)).races.r1.name, 'new');
  remove(a, 'races', 'r1', '2026-01-03T00:00:00Z');                 // deleted after it
  assert.equal(merge(b, syncPayload(a)).races.r1, undefined);
});

test('garmin then strava: one activity, linked', async () => {
  const st = emptyState(), s = sink();
  await importGarmin(st, { activities: [{ garmin_id: 111, name: 'Morning Run', type: 'running',
    start: '2026-08-18T07:00:05', distance_m: 10020, moving_s: 2900,
    channels: { seconds: [0, 1], metres: [0, 3], hr: [120, 121] } }],
    daily: [{ day: '2026-08-17', steps: 9000 }] }, s.put);
  assert.deepEqual(Object.keys(st.activities), ['g111']);
  assert.equal(st.daily['2026-08-17'].steps, 9000);
  const r = await importStrava(st, { activities: [
    { id: 9, name: 'Lunch Run', sport_type: 'Run', start_date_local: '2026-08-18T07:01:00Z', distance: 10000,
      streams: { time: [0, 1], distance: [0, 2.9] } },
    { id: 10, name: 'Ride', sport_type: 'Ride', start_date_local: '2026-08-19T17:00:00Z', distance: 30000 }] }, s.put, s.has);
  assert.equal(r.linked, 1); assert.equal(r.inserted, 1);
  assert.equal(st.activities.g111.strava_id, '9');
  assert.equal(st.activities.s10.type, 'cycling');
  assert.equal(s.m.get('g111').src, 'garmin');                       // Garmin capture kept over Strava's
});

test('strava first, then garmin absorbs the twin', async () => {
  const st = emptyState(), s = sink();
  await importStrava(st, { activities: [{ id: 5, name: 'Run', sport_type: 'Run', start_date_local: '2026-08-18T07:00:00Z', distance: 5000 }] }, s.put, s.has);
  await importGarmin(st, { activities: [{ garmin_id: 7, name: 'Run', type: 'running', start: '2026-08-18T07:03:00', distance_m: 5040 }] }, s.put);
  assert.deepEqual(Object.keys(st.activities), ['g7']);
  assert.equal(st.activities.g7.strava_id, '5');
  assert.ok(st.tombs.activities.s5);
});

test('stream shapes', () => {
  const ch = channelsFromStrava({ time: [0, 1], distance: [0, 3], latlng: [[47, 8], [47.1, 8.1]], cadence: [85, 86] }, 'running');
  assert.deepEqual(ch.cadence_spm, [170, 172]);
  assert.deepEqual(samplesFromChannels(ch)[1], [1, 3, null, 47.1, 8.1, null, 172, null, null, null]);
});
