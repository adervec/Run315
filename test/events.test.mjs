import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../js/events.js';
import { addDayKey } from '../js/lib/dt.js';

const run = (id, day, km, name = 'Run') => ({ id, start: day + 'T07:00:00', distance_m: km * 1000, name });

test('a best needs three earlier efforts to beat, and names the record it beat', () => {
  const rows = [
    [5000, 1300, '2026-01-01', 'a'], [5000, 1290, '2026-01-08', 'b'], [5000, 1310, '2026-01-15', 'c'],
    [5000, 1250, '2026-01-22', 'd'], [1000, 230, '2026-01-22', 'd'],
  ];
  const acts = { a: run('a', '2026-01-01', 5), b: run('b', '2026-01-08', 5), c: run('c', '2026-01-15', 5), d: run('d', '2026-01-22', 5, 'Tempo') };
  const ev = E.bestEffortEvents(rows, acts);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].id, 'pr-d');
  assert.match(ev[0].title, /5 km best: 20:50/);
  assert.match(ev[0].detail, /was 21:30 \(8 Jan 2026\)/);
  // With only two before it, the same time is not an event.
  assert.equal(E.bestEffortEvents(rows.filter(r => r[3] !== 'c'), acts).length, 0);
});

test('longest run in N weeks', () => {
  const rs = [run('a', '2026-01-01', 20)];
  for (let i = 1; i <= 10; i++) rs.push(run('w' + i, addDayKey('2026-01-01', 7 * i), 10));
  rs.push(run('z', '2026-03-20', 18));
  rs.push(run('y', '2026-03-27', 25));
  const ev = E.longestRunEvents(rs);
  // z: nothing as long since January's 20 km, eleven weeks back; y: the longest of all.
  assert.deepEqual(ev.map(e => e.id), ['long-z', 'long-y']);
  assert.match(ev[0].title, /Longest run in 11 weeks: 18.0 km/);
  assert.match(ev[1].title, /Longest run on record: 25.0 km/);
  rs[rs.length - 1].distance_m = 19000;
  const ev2 = E.longestRunEvents(rs);
  assert.match(ev2[1].title, /Longest run in 12 weeks/);
});

test('week streak milestones and career distance', () => {
  const rs = [];
  for (let i = 0; i < 9; i++) rs.push(run('r' + i, addDayKey('2026-01-05', 7 * i), 15));
  const s = E.streakEvents(rs);
  assert.deepEqual(s.map(e => e.title), ['4 weeks in a row with a run', '8 weeks in a row with a run']);
  const c = E.careerEvents(rs);
  assert.deepEqual(c.map(e => e.id), ['career-100']);
  assert.equal(c[0].link, '#/career');
});

test('tiles: the first day is not news; big days and square growth are', () => {
  const fs = new Map();
  fs.set('0,0', '2026-01-01');
  ['1,0', '0,1', '1,1'].forEach(k => fs.set(k, '2026-01-02'));
  for (let i = 0; i < 55; i++) fs.set(`${10 + i},50`, '2026-01-03');
  const ev = E.tileEvents(fs);
  assert.ok(ev.some(e => e.id === 'square-2'));
  assert.ok(ev.some(e => e.id === 'tiles-2026-01-03'));
  assert.ok(!ev.some(e => e.at.startsWith('2026-01-01')));
});

test('trails finish once, on the crossing day', () => {
  const areas = { x: { ways: { 1: ['Ridge', 'path', 10, 250] }, gains: [['2026-02-01', 'n:ridge', 5, 100], ['2026-02-03', 'n:ridge', 5, 100]] } };
  // Gains are keyed by trails.trailKey: 'n:<lower-case name>' for a named way.
  const ev = E.trailEvents(areas);
  assert.equal(ev.length, 1);
  assert.ok(ev[0].at.startsWith('2026-02-03'));
  assert.equal(ev[0].title, 'Finished Ridge');
});

test('races beating projection only', () => {
  const ev = E.raceEvents({ a: { id: 'a', name: '10K', date: '2026-04-01', actual_s: 2400, predicted_s: 2460, goal_s: 2430 },
    b: { id: 'b', name: 'Half', date: '2026-05-01', actual_s: 5900, predicted_s: 5800 } });
  assert.equal(ev.length, 1);
  assert.match(ev[0].title, /beat the projection by 1:00/);
  assert.match(ev[0].detail, /goal 40:30 met/);
});

test('HRV trend: a held drop is reported once, a single bad night is not', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ day: addDayKey('2026-01-01', i), hrv_ms: 60 + (i % 3) - 1 });
  rows[30].hrv_ms = 30;   // one bad night
  assert.equal(E.trendEvents(rows).length, 0);
  for (let i = 40; i < 50; i++) rows.push({ day: addDayKey('2026-01-01', i), hrv_ms: 45 });
  const ev = E.trendEvents(rows);
  assert.equal(ev.length, 1);
  assert.match(ev[0].title, /HRV below your usual range/);
  assert.equal(ev[0].good, false);
});

test('digest: what arrived since last look, recent only, plus cowork notes', () => {
  const now = new Date('2026-06-10T12:00:00');
  const events = [
    { id: 'a', at: '2026-06-09T07:00:00', noticed: '2026-06-10T06:00:00Z' },
    { id: 'b', at: '2026-06-01T07:00:00', noticed: '2026-06-02T06:00:00Z' },
    { id: 'c', at: '2025-01-01T07:00:00', noticed: '2026-06-10T06:00:00Z' },   // re-derived, old
  ];
  const runs = [{ at: '2026-06-10T05:00:00Z', kind: 'check', channel: 'garmin', ok: true, note: '3 activities' },
    { at: '2026-06-10T05:00:00Z', kind: 'push', ok: true, note: 'requests written' }];
  const d = E.digest(events, { lastSeen: '2026-06-05T00:00:00Z', now, coworkRuns: runs, gaps: ['x'] });
  assert.deepEqual(d.events.map(e => e.id), ['a']);
  assert.equal(d.cowork.length, 1);
  assert.deepEqual(d.gaps, ['x']);
  const first = E.digest(events, { now });
  assert.ok(first.first);
  assert.deepEqual(first.events.map(e => e.id), ['a', 'b']);
});

test('distance labels', () => {
  assert.equal(E.distLabel(400), '400 m');
  assert.equal(E.distLabel(21097), 'half marathon');
  assert.equal(E.distLabel(5000), '5 km');
});
