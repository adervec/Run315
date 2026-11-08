import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/share.js';

// The pure, state-in parts of share.js (the rest is canvas, network and panels).

test('placesCells: synced places override cells an older version left in the profile', () => {
  const st = {
    profile: { places: { cells: { a: ['Old', '', ''], b: ['Kept', '', ''] } } },
    places: { a: { p: ['New', '', ''] }, c: { p: ['Only synced', '', ''] }, d: null, e: {} },
  };
  assert.deepEqual(S.placesCells(st), { a: ['New', '', ''], b: ['Kept', '', ''], c: ['Only synced', '', ''] });
  assert.deepEqual(S.placesCells({}), {});
});

test('airTargets: outdoor runs with a start point, newest first, with archive coverage', () => {
  const act = (id, start, extra = {}) => ({ id, type: 'running', start, ...extra });
  const st = {
    activities: {
      old: act('old', '2020-05-01T07:00:00'),                 // US, before the global archive
      eu: act('eu', '2020-05-02T07:00:00'),                   // Europe: covered from 2013
      new: act('new', '2026-11-01T07:00:00'),
      tread: act('tread', '2026-11-02T07:00:00', { type: 'treadmill_running' }),
      nogps: act('nogps', '2026-11-03T07:00:00'),
    },
    derived: {
      old: { p0: [40.7, -74.0] }, eu: { p0: [48.2, 16.4] }, new: { p0: [40.7, -74.0] },
      tread: { p0: [40.7, -74.0] }, nogps: {},
    },
  };
  const t = S.airTargets(st, '2026-11-08');
  assert.deepEqual(t.map(x => x.id), ['new', 'eu', 'old']);
  assert.deepEqual(t.map(x => x.cov.ok), [true, true, false]);
  assert.deepEqual([t[0].lat, t[0].lon, t[0].day], [40.7, -74.0, '2026-11-01']);
});

test('slug: filename-safe, with a fallback', () => {
  assert.equal(S.slug('Sunday Long Run — 21 km!'), 'sunday-long-run-21-km');
  assert.equal(S.slug(''), 'run315');
});
