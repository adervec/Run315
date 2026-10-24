// The calendar page's pure helpers: the month grid, the filters, deep-link parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../js/pages/calendar.js';

test('month weeks are Monday first and cover the whole month', () => {
  const w = C.monthWeeks('2026-10');            // 1 Oct 2026 is a Thursday
  assert.equal(w[0][0], '2026-09-28');
  assert.equal(w[w.length - 1][6], '2026-11-01');
  assert.ok(w.every(r => r.length === 7));
  assert.equal(C.monthWeeks('2021-02').length, 4);   // Feb 2021 starts on a Monday, 28 days
  assert.equal(C.shiftMonth('2026-12', 1), '2027-01');
  assert.equal(C.shiftMonth('2026-01', -1), '2025-12');
});

test('filters', () => {
  const a = { id: 'g1', name: 'Tempo Tuesday', type: 'running', start: new Date(2026, 4, 5, 7), distance_m: 10000, source: 'garmin', strava_id: 9 };
  const b = { id: 's2', name: 'Commute', type: 'cycling', start: new Date(2026, 4, 6, 8), distance_m: 20000, source: 'strava' };
  const ctx = { journal: { g1: { tags: ['heat'] }, '2026-05-06': { tags: ['travel'], note: 'airport' } },
    routes: new Map([['g1', { name: 'Loop', ids: new Set(['g1']) }]]) };
  const f = o => ({ ...C.EMPTY_FILTERS, ...o });
  assert.ok(C.matches(a, f({ q: 'tempo' }), ctx));
  assert.ok(!C.matches(b, f({ q: 'tempo' }), ctx));
  assert.ok(C.matches(b, f({ q: 'airport' }), ctx));         // the day's note
  assert.ok(C.matches(b, f({ tag: 'travel' }), ctx));
  assert.ok(C.matches(a, f({ sport: 'run', source: 'both', route: 'g1' }), ctx));
  assert.ok(!C.matches(b, f({ source: 'garmin' }), ctx));
  assert.ok(C.matches(b, f({ source: 'strava' }), ctx));
  assert.ok(!C.matches(a, f({ min: '12' }), ctx));
  assert.ok(C.matches(a, f({ from: '2026-05-05', to: '2026-05-05' }), ctx));
  assert.ok(!C.matches(b, f({ to: '2026-05-05' }), ctx));
  assert.ok(!C.filtersActive(C.EMPTY_FILTERS));
  assert.ok(C.filtersActive(f({ min: '5' })));
  assert.equal(C.sportOf('trail_running'), 'run');
  assert.equal(C.sportOf('strength_training'), 'strength');
});

test('deep links', () => {
  assert.deepEqual(C.filtersFromHash('#/calendar?q=tempo&sport=run&bogus=1'), { q: 'tempo', sport: 'run' });
  assert.equal(C.filtersFromHash('#/calendar'), null);
  assert.deepEqual(C.filtersFromHash('#/calendar?day=2026-05-05'), { day: '2026-05-05' });
});
