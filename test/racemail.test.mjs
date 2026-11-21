// The races channel: replies come from emails and web pages, so every field is checked; an add
// that matches a race on the calendar becomes an update; a source is applied once; scouted races
// never reach the calendar by themselves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/store.js';
import * as R from '../js/racemail.js';
import { previewReply, filterPayload, channelContext, CHANNELS } from '../js/cowork.js';

const src = (key, kind = 'email') => ({ kind, key, subject: 'Your entry', from_domain: 'example-race.com', date: '2026-11-01' });

test('races channel: validate, dedupe, apply once, scout separately', async () => {
  await store.loadState();
  const st = store.state;
  st.races['race-a'] = { id: 'race-a', name: 'Autumn Half', date: '2027-01-08', distance_m: 21097, goal_s: 5400 };
  st.races['race-b'] = { id: 'race-b', name: 'Club 10K', date: '2026-11-08', distance_m: 10000 };
  st.local.raceScout = { at: '2026-11-19T10:00:00Z', region: 'Leeds', months: 6, distances_m: [42195] };
  assert.ok(CHANNELS.some(c => c.key === 'races'));

  assert.ok((await channelContext('races')).races, 'the cowork request is the race context');
  const ctx = R.raceContext(st, new Date(2026, 10, 20));
  const a = ctx.races.find(r => r.id === 'race-a'), b = ctx.races.find(r => r.id === 'race-b');
  assert.ok(a.needs.includes('start_time') && b.needs.includes('result'), 'asks for what is missing');
  assert.equal(ctx.scout.region, 'Leeds');

  const reply = {
    proposals: [
      { id: 'p1', op: 'add', fields: { name: 'Autumn Half Marathon', date: '2027-01-08', distance_m: 21100, bib: '4127', goal_s: 1 }, source: src('<m1@x>'), confidence: 'high' },
      { id: 'p2', op: 'add', fields: { name: 'Spring Marathon', date: '2027-04-25', distance_m: 42195, start_time: '09:40', url: 'javascript:alert(1)', place: '<b>Leeds</b>' }, source: src('<m2@x>'), confidence: 'high' },
      { id: 'p3', op: 'result', raceId: 'race-b', fields: { chip_s: 2412 }, source: src('https://example-race.com/results', 'web'), confidence: 'medium' },
      { id: 'p4', op: 'cancel', raceId: 'race-a', fields: {}, source: src('<m3@x>'), confidence: 'high' },
      { id: 'p5', op: 'update', raceId: 'nope', fields: { bib: '1' }, source: src('<m4@x>') },
      { id: 'p6', op: 'delete', raceId: 'race-a', source: src('<m5@x>') },
      { id: 'p7', op: 'add', fields: { name: 'No source', date: '2027-02-01', distance_m: 5000 } },
    ],
    suggestions: [
      { name: 'Leeds Marathon', date: '2027-05-02', distance_m: 42195, url: 'https://example.org/leeds', why: 'flat, spring' },
      { name: 'Twin of Spring', date: '2027-01-08', distance_m: 21097 },
    ],
  };
  const v = R.validate(st, reply);
  assert.deepEqual(v.proposals.map(x => x.id), ['p1', 'p2', 'p3', 'p4'], 'unknown race, unknown op and no source are dropped');
  assert.equal(v.proposals[0].op, 'update', 'an add matching a race on the calendar updates it');
  assert.equal(v.proposals[0].raceId, 'race-a');
  assert.equal(v.proposals[0].fields.goal_s, undefined, 'never the goal');
  assert.equal(v.proposals[1].fields.url, undefined, 'only https links');
  assert.ok(!/[<>]/.test(v.proposals[1].fields.place), 'no markup');
  assert.equal(v.suggestions.length, 1, 'a suggestion already on the calendar is dropped');

  const rows = previewReply('races-output', reply, st);
  assert.equal(rows.find(r => r.id === 'p4').off, true, 'a cancellation starts unticked');
  assert.ok(rows.some(r => r.id === 'suggestions'));

  // Tick everything but the cancellation and the scouted list.
  const p = filterPayload('races-output', reply, new Set(['p1', 'p2', 'p3']));
  const res = R.importRaces(st, p, new Date(2026, 10, 20));
  assert.match(res.note, /1 races added, 2 updated/);
  assert.equal(st.races['race-a'].bib, '4127');
  assert.equal(st.races['race-a'].goal_s, 5400, 'the goal is the reader\'s');
  assert.equal(st.races['race-a'].name, 'Autumn Half Marathon');
  assert.equal(st.races['race-b'].chip_s, 2412);
  assert.equal(st.races['race-b'].status, 'done');
  const spring = Object.values(st.races).find(r => r.name === 'Spring Marathon');
  assert.equal(spring.status, 'registered');
  assert.equal(spring.start_time, '09:40');
  assert.equal(st.local.raceSuggestions, undefined, 'scouted races only when ticked');
  assert.ok(st.local.raceScout, 'the scout request stays until its list arrives');

  // The same email again is not applied twice; the scouted list arrives on its own.
  const again = R.validate(st, reply);
  assert.deepEqual(again.proposals.map(x => x.id), ['p4'], 'applied sources are skipped');
  R.importRaces(st, filterPayload('races-output', reply, new Set(['suggestions'])), new Date(2026, 10, 20));
  assert.equal(st.local.raceSuggestions.list.length, 1);
  assert.equal(st.local.raceScout, undefined);
  assert.equal(Object.values(st.races).filter(r => r.name === 'Leeds Marathon').length, 0, 'a scouted race is not on the calendar');
});
