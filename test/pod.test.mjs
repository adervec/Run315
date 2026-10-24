import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/store.js';
import { importGarmin } from '../js/ingest.js';
import { demoGarminPayload, demoExtras } from '../js/demo.js';
import { emptyState } from '../js/merge.js';
import * as D from '../js/derive.js';
import * as P from '../js/pod.js';
import * as FC from '../js/forecast.js';
import { dayKey, addDayKey } from '../js/lib/dt.js';

const BAD = /\bundefined\b|\bNaN\b|\[object Object\]/;
const EXAMPLE = { date: '2026-07-01', rationale: 'Fresh, warm afternoon.',
  plans: [{ name: 'Easy aerobic + strides', sport: 'running', minutes: 50, intensity: 2, description: 'Easy **and** relaxed.',
    steps: [{ minutes: 40, target: 'easy', pace_s_per_km: [370, 330], hr: [130, 145], note: 'conversational' },
      { reps: 6, minutes: 0.33, target: 'strides', note: '20 s quick, full recovery' }], why: 'TSB is up.' },
  { name: 'Spin', sport: 'Bike', minutes: 60 }, { sport: 'running' }, 'junk'] };

// A hot day of forecast at the default location, so the sync readers have something.
function hotForecast(day) {
  const hours = [];
  for (let h = 0; h < 24; h++) hours.push({ t: day + 'T' + String(h).padStart(2, '0') + ':00', day, hour: h,
    temp: 18 + 12 * Math.max(0, Math.sin((h - 6) / 18 * Math.PI)), feels: 25, dew: 18, rh: 65, wind: 10, rain: h === 17 ? 70 : 5 });
  return hours;
}
let ready = null;
async function demo() {
  if (ready) return ready;
  ready = (async () => {
    await store.loadState();
    const r = await importGarmin(store.state, demoGarminPayload(), store.putStream);
    const x = demoExtras();
    for (const k of Object.keys(x)) Object.assign(store.state[k], x[k]);
    await D.deriveAll(store.state, r.streams);
    store.save('demo');
  })();
  return ready;
}
function primeForecast(loc, days = 8) {
  const t0 = dayKey(new Date()), hours = [];
  for (let i = 0; i < days; i++) hours.push(...hotForecast(addDayKey(t0, i)));
  FC._remember(FC.cacheKey(loc.lat, loc.lon), { lat: loc.lat, lon: loc.lon, hours, fetchedAt: new Date().toISOString() });
}

test('normSport folds free text and Garmin types together', () => {
  assert.equal(P.normSport('trail_running'), 'running');
  assert.equal(P.normSport('Run'), 'running');
  assert.equal(P.normSport('road_biking'), 'cycling');
  assert.equal(P.normSport('Bike'), 'cycling');
  assert.equal(P.normSport('lap_swimming'), 'swimming');
  assert.equal(P.normSport('strength_training'), 'strength');
  assert.equal(P.normSport(''), 'other');
});

test('validatePlan keeps the contract shape and drops junk', () => {
  const p = P.validatePlan(EXAMPLE.plans[0]);
  assert.equal(p.sport, 'running');
  assert.deepEqual(p.steps[0].pace_s_per_km, [330, 370]);   // sorted fast..slow
  assert.equal(p.steps[1].reps, 6);
  assert.equal(P.validatePlan(EXAMPLE.plans[2]), null);     // no name
  assert.equal(P.validatePlan('junk'), null);
  const q = P.validatePlan({ name: 'x', intensity: 9, steps: [{ minutes: 10 }, { minutes: 5, reps: 4 }, null] });
  assert.equal(q.intensity, 5);
  assert.equal(q.minutes, 30);                              // derived from the steps
  assert.equal(q.steps.length, 2);
});

test('importPod stores the day and keeps the pick and outcome on re-import', () => {
  const st = emptyState();
  const r = P.importPod(st, EXAMPLE);
  assert.equal(r.handled, true);
  assert.match(r.note, /2 plans for 2026-07-01, 2 dropped/);
  st.pod['2026-07-01'].chosen = 'Spin';
  st.pod['2026-07-01'].outcome = { status: 'done' };
  P.importPod(st, { ...EXAMPLE, rationale: 'again' });
  assert.equal(st.pod['2026-07-01'].chosen, 'Spin');
  assert.deepEqual(st.pod['2026-07-01'].outcome, { status: 'done' });
  assert.equal(st.pod['2026-07-01'].rationale, 'again');
  assert.ok(st.pod['2026-07-01'].u);
  assert.equal(P.importPod(st, { date: '2026-07-02', plans: [{}] }).handled, false);
  assert.equal(P.importPod(st, {}).handled, false);
});

test('outcomes: done, swapped, skipped, pending, and by hand', () => {
  const today = '2026-07-10';
  const plan = (name, sport, minutes, intensity = 2) => ({ name, sport, minutes, intensity, steps: [] });
  const pods = {
    '2026-07-10': { plans: [plan('Easy', 'running', 45)] },                                   // pending
    '2026-07-09': { plans: [plan('Easy', 'running', 45), plan('Spin', 'cycling', 60)], chosen: 'Easy' }, // done, ran long
    '2026-07-08': { plans: [plan('Tempo', 'running', 50, 4)], chosen: 'Tempo' },              // swapped for a ride
    '2026-07-07': { plans: [plan('Easy', 'running', 40)] },                                   // skipped
    '2026-07-06': { plans: [plan('Spin', 'cycling', 60), plan('Easy', 'running', 40)] },      // done, not picked
    '2026-07-05': { plans: [plan('Easy', 'running', 40)], outcome: { status: 'done', note: 'watch died' } },
    '2026-06-01': { plans: [plan('Old', 'running', 40)] },                                    // outside the fortnight
  };
  const acts = [
    { id: 'a1', type: 'running', start: '2026-07-09T07:00:00', moving_s: 70 * 60, distance_m: 12000, avg_hr: 140 },
    { id: 'a2', type: 'road_biking', start: '2026-07-08T18:00:00', moving_s: 90 * 60 },
    { id: 'a3', type: 'trail_running', start: '2026-07-06T09:00:00', moving_s: 38 * 60, avg_hr: 120 },
  ];
  const rows = P.outcomes(pods, acts, { a1: { rpe: 7 } }, 170, today);
  const by = Object.fromEntries(rows.map(r => [r.date, r]));
  assert.deepEqual(rows.map(r => r.date), ['2026-07-10', '2026-07-09', '2026-07-08', '2026-07-07', '2026-07-06', '2026-07-05']);
  assert.equal(by['2026-07-10'].status, 'pending');
  assert.equal(by['2026-07-09'].status, 'done');
  assert.equal(by['2026-07-09'].actual.minutes, 70);
  assert.equal(by['2026-07-09'].actual.intensity, 4);        // RPE 7 -> 4, the athlete's word wins
  assert.equal(by['2026-07-09'].actual.intensityFrom, 'rpe');
  assert.equal(by['2026-07-09'].minutesRatio, 1.6);
  assert.equal(by['2026-07-08'].status, 'swapped');
  assert.deepEqual(by['2026-07-08'].didInstead, [{ name: null, sport: 'cycling', minutes: 90 }]);
  assert.equal(by['2026-07-07'].status, 'skipped');
  assert.equal(by['2026-07-06'].status, 'done');
  assert.equal(by['2026-07-06'].inferred, true);
  assert.equal(by['2026-07-06'].plan, 'Easy');
  assert.equal(by['2026-07-06'].actual.intensityFrom, 'avg hr');
  assert.equal(by['2026-07-05'].status, 'done');
  assert.equal(by['2026-07-05'].byHand, true);
  const sm = P.outcomeSummary(rows);
  assert.deepEqual([sm.done, sm.swapped, sm.skipped, sm.pending], [3, 1, 1, 1]);
  assert.equal(sm.note, null);
  assert.ok(P.outcomeSummary(rows.slice(0, 2)).note);
});

test('normOptions fills defaults and orders the range', () => {
  const o = P.normOptions({ availableMinutes: { min: 90, max: 30 }, niggles: ['calf', ''], hours: { from: 5, to: 9 } });
  assert.deepEqual(o.availableMinutes, { min: 30, max: 90 });
  assert.deepEqual(o.sports, ['running']);
  assert.deepEqual(o.niggles, ['calf']);
  assert.deepEqual(o.hours, { from: 5, to: 9 });
});

test('stepLine shows targets, and heat-adjusted paces when warm', () => {
  const s = P.validatePlan(EXAMPLE.plans[0]).steps;
  const cool = P.stepLine(s[0], { temp: 10 });
  assert.match(cool, /^40 min easy · 5:30–6:10 \/km · HR 130–145 · conversational$/);
  assert.match(P.stepLine(s[0], { temp: 29, rh: 70, dew: 20 }), /in this heat/);
  assert.match(P.stepLine(s[1], null), /^6 × 20 s strides/);
});

test('podContext on the demo athlete: every section, JSON-clean', async () => {
  await demo();
  const st = store.state, now = new Date(), today = dayKey(now);
  const loc = FC.defaultLocation(st);
  assert.ok(loc, 'the demo has tracks, so a location');
  primeForecast(loc);
  st.profile = { ...st.profile, podOptions: { availableMinutes: { min: 40, max: 80 }, niggles: ['left calf'] }, u: now.toISOString() };
  P.importPod(st, { ...EXAMPLE, date: addDayKey(today, -1) });
  const ctx = P.podContext(st, now);
  for (const k of ['date', 'readiness', 'fitness', 'week', 'paces', 'hrZones', 'block', 'forecast', 'options', 'strength', 'recentOutcomes', 'outcomeSummary'])
    assert.ok(k in ctx, k);
  assert.equal(ctx.date, today);
  assert.ok(ctx.paces.length && ctx.hrZones.length);
  assert.ok(ctx.forecast.bestWindow || ctx.forecast.today, 'forecast summary');
  assert.equal(ctx.options.availableMinutes.max, 80);
  assert.ok(ctx.block && ctx.block.race, 'the demo has upcoming races');
  assert.equal(ctx.recentOutcomes[0].date, addDayKey(today, -1));
  const json = JSON.stringify(ctx);
  assert.ok(!/NaN|undefined/.test(json));
  assert.deepEqual(JSON.parse(json).date, today);
});

test('the pod page, the Today panel and the race-day forecast render with data', async () => {
  await demo();
  const st = store.state, now = new Date(), today = dayKey(now);
  primeForecast(FC.defaultLocation(st));
  // All-day hours, so a best window exists whatever time the test runs.
  st.profile = { ...st.profile, podOptions: { availableMinutes: { min: 40, max: 80 }, hours: { from: 0, to: 24 } }, u: now.toISOString() };
  P.importPod(st, { ...EXAMPLE, date: today });
  const page = await import('../js/pages/pod.js');
  let out = String(page.render());
  assert.match(out, /Easy aerobic \+ strides/);
  assert.match(out, /in this heat/);
  assert.match(out, /Best/);
  assert.ok(!BAD.test(out), (out.match(new RegExp('.{0,80}(' + BAD.source + ').{0,80}')) || [])[0]);
  st.pod[today].chosen = 'Spin';
  const panel = String(P.podPanel());
  assert.match(panel, /Spin/);
  assert.match(panel, /#\/pod/);
  assert.ok(!BAD.test(panel));

  // A race in three days, with its course start forecast.
  const race = { id: 'soon', name: 'Soon 10K', date: addDayKey(today, 3), distance_m: 10000, goal_s: 2400,
    course: { points: [[45.1, 7.6, null], [45.11, 7.61, null]] } };
  st.races.soon = race;
  primeForecast({ lat: 45.1, lon: 7.6 });
  const rp = await import('../js/pages/race.js');
  out = String(await rp.render({ id: 'soon' }));
  assert.match(out, /Race-day forecast/);
  assert.match(out, /course start/);
  assert.ok(!BAD.test(out), (out.match(new RegExp('.{0,80}(' + BAD.source + ').{0,80}')) || [])[0]);
  const w = rp.raceWeather(race, today, 2400, st);
  assert.ok(w.rows.length && w.rows.every(r => r.pace >= 240));   // never faster than neutral
  assert.equal(rp.raceWeather({ ...race, date: addDayKey(today, 9) }, today, 2400, st), null);
  delete st.races.soon;
  delete st.pod[today];
});

test('the direct transport: prompt from the channel contract, tolerant reply parsing', async () => {
  const sys = await P.podSystemPrompt();
  assert.match(sys, /pod-output/);
  assert.match(sys, /recentOutcomes/);
  assert.ok(!/inbox/.test(sys));
  assert.deepEqual(P.parseReply('```json\n{"date":"2026-07-01","plans":[]}\n```'), { date: '2026-07-01', plans: [] });
  assert.throws(() => P.parseReply('sorry'), /no JSON/);
});
