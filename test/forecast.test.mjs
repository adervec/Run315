import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as FC from '../js/forecast.js';
import { emptyState } from '../js/merge.js';
import { penalty } from '../js/lib/weather.js';

// An Open-Meteo-shaped answer: one day, hourly, warming to 28 C at 15:00 with rain at 18:00.
function fakeOpenMeteo(day = '2026-07-01', days = 1) {
  const time = [], t = [], a = [], dp = [], rh = [], w = [], pr = [];
  for (let d = 0; d < days; d++) for (let h = 0; h < 24; h++) {
    const dd = new Date(Date.parse(day + 'T00:00:00Z') + d * 864e5).toISOString().slice(0, 10);
    time.push(dd + 'T' + String(h).padStart(2, '0') + ':00');
    const temp = 14 + 14 * Math.max(0, Math.sin((h - 6) / 18 * Math.PI));
    t.push(+temp.toFixed(1)); a.push(+(temp + 1).toFixed(1)); dp.push(12 + (h > 10 ? 4 : 0)); rh.push(60);
    w.push(h === 7 ? 35 : 8); pr.push(h === 18 ? 80 : 0);
  }
  return { latitude: 51.5, longitude: -0.12, timezone: 'Europe/London',
    hourly: { time, temperature_2m: t, apparent_temperature: a, dew_point_2m: dp, relative_humidity_2m: rh, wind_speed_10m: w, precipitation_probability: pr } };
}

test('parseForecast turns columns into hour rows', () => {
  const f = FC.parseForecast(fakeOpenMeteo());
  assert.equal(f.hours.length, 24);
  assert.deepEqual(Object.keys(f.hours[0]).sort(), ['day', 'dew', 'feels', 'hour', 'rain', 'rh', 't', 'temp', 'wind']);
  assert.equal(f.hours[5].hour, 5);
  assert.equal(FC.parseForecast({}), null);
  assert.equal(FC.parseForecast({ hourly: { time: ['2026-07-01T00:00'], temperature_2m: [null] } }), null);
});

test('forecastUrl asks for the six hourly fields, eight days, local time', () => {
  const u = new URL(FC.forecastUrl(51.5, -0.12));
  assert.equal(u.origin + u.pathname, FC.OPEN_METEO);
  assert.equal(u.searchParams.get('forecast_days'), '8');
  assert.equal(u.searchParams.get('timezone'), 'auto');
  assert.equal(u.searchParams.get('hourly').split(',').length, 6);
});

test('bestWindow: cool, calm, dry, inside the hours, not in the past', () => {
  const { hours } = FC.parseForecast(fakeOpenMeteo());
  const b = FC.bestWindow(hours, { day: '2026-07-01', from: 6, to: 21, minutes: 50 });
  assert.equal(b.start, '06:00');             // coolest, and 07:00 is windy
  assert.ok(b.matters);
  const later = FC.bestWindow(hours, { day: '2026-07-01', from: 6, to: 21, minutes: 50, notBefore: '2026-07-01T12:30' });
  assert.ok(later.startHour >= 12);
  assert.notEqual(later.start, '18:00');      // rain
  const two = FC.bestWindow(hours, { day: '2026-07-01', from: 6, to: 21, minutes: 100 });
  assert.equal(two.minutes, 120);
  assert.ok(two.startHour + 2 <= 21);
  assert.equal(FC.bestWindow(hours, { day: '2026-07-02' }), null);
  assert.equal(FC.bestWindow(hours, { day: '2026-07-01', from: 20, to: 21, minutes: 90 }), null);
});

test('heatPace and heatBand slow a pace by the weather penalty', () => {
  const hot = { temp: 28, rh: 60, dew: 18 }, p = penalty(28, 60, 18);
  assert.ok(p > 0.03);
  assert.equal(FC.heatPace(300, hot), 300 * (1 + p));
  assert.deepEqual(FC.heatBand([300, 330], hot), [300 * (1 + p), 330 * (1 + p)]);
  assert.equal(FC.heatBand([300, 330], { temp: 10 }), null);   // nothing to correct
  assert.equal(FC.heatPace(null, hot), null);
});

test('normHours falls back on nonsense', () => {
  assert.deepEqual(FC.normHours({ from: '07:30', to: 20 }), { from: 7, to: 20 });
  assert.deepEqual(FC.normHours({ from: 20, to: 6 }), FC.DEFAULT_HOURS);
  assert.deepEqual(FC.normHours(null), FC.DEFAULT_HOURS);
});

test('forecastFor caches for an hour, and falls back to the old answer offline', async () => {
  let calls = 0;
  const ok = async () => { calls++; return { ok: true, json: async () => fakeOpenMeteo() }; };
  const t0 = Date.parse('2026-07-01T06:00:00Z');
  const a = await FC.forecastFor(48.85, 2.35, { fetchFn: ok, now: t0 });
  assert.equal(a.hours.length, 24);
  await FC.forecastFor(48.85, 2.35, { fetchFn: ok, now: t0 + 30 * 60e3 });
  assert.equal(calls, 1);
  assert.ok(FC.cachedForecast(48.85, 2.35, t0 + 60e3));
  assert.ok(FC.cachedForecast(null, null, t0 + 60e3));   // the last one fetched
  const down = async () => { throw new Error('offline'); };
  const b = await FC.forecastFor(48.85, 2.35, { fetchFn: down, now: t0 + 2 * 3600e3 });
  assert.equal(b.stale, true);
  await assert.rejects(FC.forecastFor(10, 10, { fetchFn: down, now: t0 }), /offline/);
  await assert.rejects(FC.forecastFor(null, 10), /location/);
  assert.equal(FC.cachedForecast(48.85, 2.35, t0 + 13 * 3600e3), null);   // too old to read
});

test('shouldFetch allows one attempt per place per ten minutes', () => {
  assert.equal(FC.shouldFetch(1, 2, 0), true);
  assert.equal(FC.shouldFetch(1, 2, 60e3), false);
  assert.equal(FC.shouldFetch(1, 2, 700e3), true);
});

test('defaultLocation: home, then the most-run tile, then the latest track', () => {
  const st = emptyState();
  assert.equal(FC.defaultLocation(st), null);
  st.activities.a = { id: 'a', start: '2026-06-01T07:00:00', type: 'running' };
  st.derived.a = { points: [[51.5, -0.1], [51.51, -0.11]] };
  const fromTrack = FC.defaultLocation(st);
  assert.equal(fromTrack.source, 'latest activity');
  assert.deepEqual([fromTrack.lat, fromTrack.lon], [51.5, -0.1]);
  st.profile = { home: { lat: 40, lon: -3 }, u: 'x' };
  assert.deepEqual(FC.defaultLocation(st), { lat: 40, lon: -3, source: 'home' });
});
