// GymTracker strength sessions: parsing the synced file, the load estimates, the double-count
// rules and the legs-loaded flag. Pure functions only (no Drive, no IndexedDB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/strength.js';
import * as catalog from '../js/gtcatalog.js';
import * as F from '../js/lib/fitness.js';
import * as store from '../js/store.js';

const SQUAT = '68b78b08-0000-0000-0000-000000000000', BENCH = '239a5594-2c8b-40c8-a19c-dd8cfa8b58f8';
const PULLUP = 'e06c4bf6-0000', CLEAN = 'a19dcf36-0000', WALK = '10e6a133-0000';
const NOW = new Date('2026-10-22T12:00:00Z');
const sets = (n, w, r, rpe) => Array.from({ length: n }, () => (rpe == null ? { w, r } : { w, r, rpe }));

function file() {
  return {
    unit: 'kg',
    bodyComp: [{ date: '2026-10-01', weightKg: 70 }],
    customVariations: [{ uuid: 'custom-1', movementId: 'leg-press', title: 'My leg press' }],
    sessions: [
      // legs, RPE logged, end stamp: 60 min
      { id: 'leg-day', date: '2026-10-21T08:00:00Z', endedAt: '2026-10-21T09:00:00Z',
        exercises: [{ varUuid: SQUAT, sets: sets(5, 100, 5, 8) }, { varUuid: 'custom-1', sets: sets(3, 150, 10) }] },
      // upper, no RPE, HR from Strava, linked to a Strava strength activity Run315 also has
      { id: 'upper', date: '2026-10-19T17:00:00Z', endedAt: '2026-10-19T17:50:00Z', stravaId: 777,
        hr: { avg: 120, max: 150, calories: 300 },
        exercises: [{ varUuid: BENCH, sets: sets(4, 80, 8) }, { varUuid: PULLUP, sets: sets(3, 0, 8) }] },
      // no end stamp, no RPE, no HR -> volume estimate, duration from set times
      { id: 'clean', date: '2026-10-15T07:00:00Z',
        exercises: [{ varUuid: CLEAN, sets: [{ w: 60, r: 3, ts: '2026-10-15T07:05:00Z' }, { w: 60, r: 3, ts: '2026-10-15T07:35:00Z' }] }] },
      // GymTracker's Strava orphan, inserted as cardio
      { id: 'orphan', date: '2026-10-18T07:00:00Z', stravaId: 888, source: 'strava-import',
        exercises: [{ varUuid: WALK, sets: [], cardio: { elapsedMin: 40 } }] },
      // strength session linked to a Strava activity Run315 has as a RUN (mis-link): skipped
      { id: 'mislinked', date: '2026-10-17T07:00:00Z', endedAt: '2026-10-17T07:30:00Z', stravaId: 999,
        exercises: [{ varUuid: SQUAT, sets: sets(3, 80, 5) }] },
      // deleted after its last edit
      { id: 'gone', date: '2026-10-10T07:00:00Z', updatedAt: '2026-10-10T08:00:00Z', exercises: [{ varUuid: SQUAT, sets: sets(3, 80, 5) }] },
      // edited after the delete on another device: survives
      { id: 'back', date: '2026-10-09T07:00:00Z', updatedAt: '2026-10-12T08:00:00Z', endedAt: '2026-10-09T07:20:00Z', exercises: [{ varUuid: BENCH, sets: sets(2, 60, 10) }] },
    ],
    deletedSessions: [{ id: 'gone', deletedAt: '2026-10-11T00:00:00Z' }, { id: 'back', deletedAt: '2026-10-11T00:00:00Z' }],
  };
}
const own = [
  { id: 's777', type: 'strength_training', strava_id: 777, start: '2026-10-19T17:00:00Z', avg_hr: 118 },
  { id: 's888', type: 'walking', strava_id: 888, start: '2026-10-18T07:00:00Z', moving_s: 2400 },
  { id: 's999', type: 'running', strava_id: 999, start: '2026-10-17T07:00:00Z', moving_s: 1800, avg_hr: 150 },
];

test('parse: tombstones, names, custom variations, durations, newest first', () => {
  const recs = S.parseGymTracker(file(), catalog, NOW);
  assert.deepEqual(recs.map(r => r.key), ['leg-day', 'upper', 'orphan', 'mislinked', 'clean', 'back']);
  const leg = recs[0];
  assert.equal(leg.id, 'gtleg-day');
  assert.equal(leg.exercises[0].name, 'Barbell Back Squat');
  assert.equal(leg.exercises[1].name, 'My leg press');          // custom variation, leg-press family groups
  assert.ok(leg.exercises[1].groups.quads > 0.5);
  assert.equal(leg.dur_s, 3600);
  assert.equal(leg.exercises[0].volume, 2500);
  const clean = recs.find(r => r.key === 'clean');
  assert.equal(clean.dur_src, 'sets');
  assert.equal(clean.dur_s, 37 * 60);                           // session start .. last set + 2 min
  assert.equal(clean.exercises[0].assumed, true);               // full-body family: Run315's leg assumption
  // bodyweight pull-ups: volume uses the latest weigh-in
  assert.equal(recs.find(r => r.key === 'upper').exercises[1].volume, 3 * 8 * 70);
});

test('the same file twice gives the same ids (stable routes)', () => {
  const a = S.parseGymTracker(file(), catalog, NOW).map(r => r.id), b = S.parseGymTracker(file(), catalog, NOW).map(r => r.id);
  assert.deepEqual(a, b);
  assert.match(S.gtId({ date: '2026-01-01T10:00:00Z' }), /^gtd[0-9a-z]+$/);
});

test('double counting: cardio-only and cardio-linked sessions are skipped; strength twin is kept', () => {
  const recs = S.parseGymTracker(file(), catalog, NOW);
  const acts = S.toActivities(recs, own, 170);
  assert.deepEqual(acts.map(a => a.id), ['gtleg-day', 'gtupper', 'gtclean', 'gtback']);
  const upper = acts.find(a => a.id === 'gtupper');
  assert.equal(upper.shadows, 's777');
  assert.equal(upper.type, 'strength_training');
  assert.equal(upper.source, 'gymtracker');
  assert.ok(!F.CARDIO_TYPES.has(upper.type));     // so Run315's own s777 never counted
});

test('load: session RPE first, then HR, then volume (low confidence)', () => {
  const acts = S.toActivities(S.parseGymTracker(file(), catalog, NOW), own, 170);
  const by = Object.fromEntries(acts.map(a => [a.id, a]));
  // 5 sets RPE 8 of 8 sets (>= 30 %): session RPE 6 x 1 h x 10 = 60
  assert.equal(by['gtleg-day'].load_method, 'srpe');
  assert.ok(Math.abs(by['gtleg-day'].load - 60) < 1e-9);
  // HR 120 / 170 over 50 min, as activityLoad would score it
  assert.equal(by.gtupper.load_method, 'hr');
  const expect = F.activityLoad({ moving_s: 3000, avg_hr: 120 }, 170, {});
  assert.ok(Math.abs(by.gtupper.load - expect) < 1e-9);
  assert.equal(by.gtclean.load_method, 'volume');
  assert.equal(by.gtclean.load_confidence, 'low');
  assert.ok(by.gtclean.load > 0 && by.gtclean.load < 60);
});

test('a maximal hour of session RPE is ~100, the same as an hour at threshold', () => {
  const rec = { dur_s: 3600, exercises: [{ sets: [[100, 1, 10], [100, 1, 10], [100, 1, 10]] }] };
  const L = S.sessionLoad(rec);
  assert.equal(L.srpe, 10 - S.RPE_TO_SESSION);
  assert.ok(Math.abs(L.load - 80) < 1e-9);                     // RPE-10 sets, rests included -> 80
  assert.equal(S.LOAD_PER_RPE_HOUR * 10, F.activityLoad({ moving_s: 3600, avg_hr: 170 }, 170, {}));
});

test('estRpe: near the best e1RM is hard, far below is easy, no history is neutral', () => {
  const ref = 100 * (1 + 5 / 30);
  assert.ok(S.estRpe(100, 5, ref) > 8.5);   // the best set itself, with ~1 rep of headroom
  assert.equal(S.estRpe(50, 5, ref), 5);
  assert.equal(S.estRpe(50, 5, null), 7);
  assert.equal(S.estRpe(0, 10, ref, 'b'), 7);
});

test('legs loaded: within 72 h, enough leg sets, newest wins', () => {
  const acts = S.toActivities(S.parseGymTracker(file(), catalog, NOW), own, 170);
  const legs = S.legsLoaded(acts, NOW);
  assert.equal(legs.id, 'gtleg-day');
  assert.equal(Math.round(legs.hours), 27);
  assert.ok(legs.legSets >= 5);
  assert.equal(S.legsLoaded(acts, new Date('2026-10-25T12:00:00Z')), null);
  // upper body only -> no flag
  assert.equal(S.legsLoaded(acts.filter(a => a.id === 'gtupper'), new Date('2026-10-20T12:00:00Z')), null);
});

test('week share uses the same thresholds for cardio and strength', () => {
  const acts = [{ start: '2026-10-21T08:00:00Z', load: 60 }];
  const w = S.weekShare(acts, [{ type: 'running', start: '2026-10-20T07:00:00Z', moving_s: 3600, avg_hr: 140 },
    { type: 'running', start: '2026-10-12T07:00:00Z', moving_s: 3600, avg_hr: 170 }], NOW);
  assert.equal(w.strength, 60);
  assert.ok(w.cardio > 0 && w.share > 0 && w.share < 1);
});

test('no file, no sessions, odd values: nothing breaks', () => {
  assert.deepEqual(S.parseGymTracker(null, catalog), []);
  assert.deepEqual(S.parseGymTracker({ sessions: [{ date: 'nonsense' }, { date: '2026-10-01T00:00:00Z', exercises: [{ varUuid: 'x', sets: [{ w: '', r: '' }] }] }] }, catalog, NOW)
    .flatMap(r => r.exercises), []);
  const unknown = S.parseGymTracker({ sessions: [{ id: 'u', date: '2026-10-01T00:00:00Z', exercises: [{ varUuid: 'zzz', sets: sets(3, '40', '10') }] }] }, catalog, NOW);
  assert.equal(unknown[0].exercises[0].name, 'Unknown exercise');
  assert.equal(unknown[0].dur_src, 'estimate');
  assert.equal(unknown[0].exercises[0].volume, 1200);
  assert.equal(unknown[0].unit, 'lb');
});

test('disabled by default: strengthActivities and the Today panel are empty', () => {
  assert.deepEqual(S.strengthActivities(), []);
  assert.equal(S.strengthPanel(), '');
  assert.equal(S.strengthDetail('gtnope'), '');
});

test('enabled, from the cache: Today panel, detail and the page render cleanly', async () => {
  await store.loadState();
  const recs = S.parseGymTracker(file(), catalog, NOW);
  await store.idbSet('cache', S.CACHE_KEY, { fetchedAt: NOW.toISOString(), sessions: recs });
  await S.loadStrengthCache();
  const saved = store.state.profile;
  store.state.profile = { ...saved, gymtracker: { enabled: true } };
  store.save('test');
  try {
    const acts = S.strengthActivities();
    assert.equal(acts.length, 5);                                    // no Run315 activities here: only the cardio-only orphan drops
    const BAD = /undefined|NaN|\[object Object\]/;
    const panel = String(S.strengthPanel(new Date('2026-10-22T12:00:00Z')));
    assert.match(panel, /Legs loaded/);
    assert.ok(!BAD.test(panel), panel);
    for (const a of acts) { const d = String(S.strengthDetail(a.id)); assert.ok(d.length > 100 && !BAD.test(d), d); }
    const page = await import('../js/pages/strength.js');
    const out = String(page.render({}));
    assert.ok(!BAD.test(out) && /Sessions/.test(out));
    const { activities } = await import('../js/derive.js');
    assert.ok(activities(store.state).some(a => a.id === 'gtleg-day'));
  } finally { store.state.profile = saved; await S.clearStrength(); }
});
