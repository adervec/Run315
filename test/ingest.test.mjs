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

import { dedupe, garminIdFromStrava } from '../js/ingest.js';

test('dedupe: the Garmin id Strava kept is an exact match, even when the clocks disagree', async () => {
  assert.equal(garminIdFromStrava({ external_id: 'garmin_push_10012345678' }), '10012345678');
  assert.equal(garminIdFromStrava({ external_id: 'iphone-abc.fit' }), null);
  const st = emptyState(), s = sink();
  // Garmin says 07:00 local; Strava filed it an hour off (a travel timezone) -- the window alone would miss it.
  await importGarmin(st, { activities: [{ garmin_id: 10012345678, name: 'Run', type: 'running', start: '2026-08-18T07:00:00', distance_m: 10000 }] }, s.put);
  const r = await importStrava(st, { activities: [{ id: 77, name: 'Run', sport_type: 'Run', start_date_local: '2026-08-18T08:00:00Z',
    distance: 10010, external_id: 'garmin_push_10012345678' }] }, s.put, s.has);
  assert.equal(r.linked, 1);
  assert.deepEqual(Object.keys(st.activities), ['g10012345678']);
});

test('dedupe: a second Strava upload of a linked session is dropped', async () => {
  const st = emptyState(), s = sink();
  await importGarmin(st, { activities: [{ garmin_id: 1, name: 'Run', type: 'running', start: '2026-08-18T07:00:00', distance_m: 8000 }] }, s.put);
  await importStrava(st, { activities: [
    { id: 10, name: 'Run', sport_type: 'Run', start_date_local: '2026-08-18T07:00:30Z', distance: 8000 },
    { id: 11, name: 'Run (copy)', sport_type: 'Run', start_date_local: '2026-08-18T07:01:00Z', distance: 7990 }] }, s.put, s.has);
  assert.deepEqual(Object.keys(st.activities), ['g1']);
  assert.equal(st.activities.g1.strava_id, '10');
});

test('dedupe: two Strava-only copies keep one; a later Garmin import absorbs it and its derived data', async () => {
  const st = emptyState(), s = sink();
  await importStrava(st, { activities: [
    { id: 20, name: 'Ride', sport_type: 'Ride', start_date_local: '2026-08-19T17:00:00Z', distance: 30000, gear_id: 'b1' },
    { id: 21, name: 'Ride', sport_type: 'Ride', start_date_local: '2026-08-19T17:02:00Z', distance: 30100 }] }, s.put, s.has);
  assert.deepEqual(Object.keys(st.activities), ['s20']);
  st.derived.s20 = { u: 'x', tiles: [[1, 2]] };
  await importGarmin(st, { activities: [{ garmin_id: 5, name: 'Ride', type: 'cycling', start: '2026-08-19T17:00:10', distance_m: 30050 }] }, s.put);
  assert.deepEqual(Object.keys(st.activities), ['g5']);
  assert.equal(st.activities.g5.strava_id, '20');
  assert.equal(st.derived.s20, undefined, 'no orphaned tiles double-counting territory');
  assert.deepEqual(st.activityGear.g5.uuids, ['strava:b1']);
  assert.equal(dedupe(st), 0, 'idempotent');
});

test('dedupe: different sessions the same morning stay apart', async () => {
  const st = emptyState(), s = sink();
  await importGarmin(st, { activities: [{ garmin_id: 2, name: 'Run', type: 'running', start: '2026-08-20T07:00:00', distance_m: 5000 }] }, s.put);
  await importStrava(st, { activities: [
    { id: 30, name: 'Walk', sport_type: 'Walk', start_date_local: '2026-08-20T07:05:00Z', distance: 1200 },   // 5 min apart, a quarter the distance
    { id: 31, name: 'Ride', sport_type: 'Ride', start_date_local: '2026-08-20T09:00:00Z', distance: 5000 }] }, s.put, s.has);
  assert.deepEqual(Object.keys(st.activities).sort(), ['g2', 's30', 's31']);
});
