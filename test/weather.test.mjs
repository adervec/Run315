// Port of test_weather.py: weather correction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../js/lib/weather.js';
import { addDayKey } from '../js/lib/dt.js';

test('test_heat_index', () => {
  assert.equal(W.heatIndexC(null, 50), null);
  // Below the regression's range, the dry temperature is the honest answer.
  assert.equal(W.heatIndexC(10.0, 90), 10.0);
  assert.equal(W.heatIndexC(20.0, null), 20.0);
  // Hot and humid feels hotter than the thermometer says.
  assert.ok(W.heatIndexC(32.0, 80) > 36.0);
  // Hot and dry barely does.
  assert.ok(Math.abs(W.heatIndexC(32.0, 20) - 32.0) < 3.0);
  // Humidity is clamped rather than trusted blindly.
  assert.equal(W.heatIndexC(32.0, 500), W.heatIndexC(32.0, 100));
});

test('test_penalty_shape', () => {
  assert.equal(W.penalty(null), 0.0);
  assert.equal(W.penalty(10.0), 0.0);                    // cool is free
  assert.equal(W.penalty(W.NEUTRAL_C), 0.0);
  // It grows with heat, and faster than linearly.
  const p20 = W.penalty(20.0), p25 = W.penalty(25.0), p30 = W.penalty(30.0);
  assert.ok(0 < p20 && p20 < p25 && p25 < p30);
  assert.ok((p30 - p25) > (p25 - p20), 'should be quadratic, not linear');
  // A hot humid day costs several percent, but never absurdly much.
  assert.ok(0.03 < W.penalty(30.0, 85) && W.penalty(30.0, 85) < W.MAX_PENALTY);
  assert.ok(W.penalty(55.0, 100) <= W.MAX_PENALTY);
  // Real cold costs something too.
  assert.ok(W.penalty(-15.0) > 0);
});

test('test_penalty_matches_published_guidance', () => {
  // Pinned against the reference points the heat-and-pace tables agree on.
  // These are the numbers the whole module is calibrated to; if they drift, the
  // correction has quietly become someone else's opinion.
  const between = (lo, x, hi) => lo < x && x < hi;
  assert.ok(W.penalty(15.0, 60) < 0.01);                    // barely anything
  assert.ok(between(0.010, W.penalty(20.0, 60), 0.025));    // ~1.5%
  assert.ok(between(0.030, W.penalty(25.0, 70), 0.055));    // ~4%
  assert.ok(between(0.070, W.penalty(30.0, 60), 0.115));    // ~10%
  // Even a brutal day stays inside a believable ceiling.
  assert.equal(W.penalty(38.0, 95), W.MAX_PENALTY);
});

test('test_humidity_and_dew_point_matter', () => {
  const dry = W.penalty(30.0, 25);
  const humid = W.penalty(30.0, 90);
  assert.ok(humid > dry, `${dry} ${humid}`);
  // A high dew point is worse than the dry temperature alone suggests.
  assert.ok(W.penalty(24.0, null, 20.0) > W.penalty(24.0, null, 5.0));
  assert.equal(W.penalty(24.0, null, 5.0), W.penalty(24.0));
});

test('test_adjust', () => {
  assert.equal(W.adjust(null, 30.0), null);
  assert.equal(W.adjust(300.0, 10.0), 300.0);            // nothing to correct
  const hot = W.adjust(300.0, 30.0, 85);
  assert.ok(hot < 300.0, String(hot));                   // corrected pace is quicker
  // The correction is exactly the penalty, no more.
  assert.ok(Math.abs(hot * (1 + W.penalty(30.0, 85)) - 300.0) < 0.01);
});

test('test_describe', () => {
  assert.equal(W.describe(null), null);
  const cool = W.describe(9.0);
  assert.ok(cool.includes('no correction'));
  const hot = W.describe(31.0, 85);
  assert.ok(hot.includes('%') && hot.includes('31 C') && hot.includes('85% humidity'));
  assert.ok(hot.includes('feels like'));
});

test('test_season_summary', () => {
  const rows = [[2.0, 300.0], [3.0, 302.0],               // cold
    [16.0, 305.0],                                          // neutral
    [30.0, 330.0], [31.0, 335.0]];                          // hot
  const out = W.seasonSummary(rows);
  const labels = out.map(b => b.label);
  assert.deepEqual(labels, ['Under 5 C', '13-20 C', 'Over 26 C']);
  const cold = out[0], hot = out[out.length - 1];
  assert.ok(cold.runs === 2 && hot.runs === 2);
  // Raw pace looks much worse in the heat...
  assert.ok(hot.mean_pace > cold.mean_pace);
  // ...and the correction closes some of that gap, without inverting it.
  assert.ok(hot.mean_adjusted < hot.mean_pace);
  assert.ok(Math.abs(cold.mean_adjusted - cold.mean_pace) < 1.0);
  assert.deepEqual(W.seasonSummary([]), []);
  assert.deepEqual(W.seasonSummary([[null, 300.0], [20.0, null]]), []);
});

test('test_normalise_units', () => {
  assert.equal(W.normalise(null), null);
  assert.equal(W.normalise({}), null);
  assert.equal(W.normalise('nope'), null);

  const metric = W.normalise({ temp: 22, relativeHumidity: 60, dewPoint: 14 });
  assert.equal(metric.temp_c, 22.0);
  assert.equal(metric.humidity, 60.0);
  assert.equal(metric.dew_point_c, 14.0);

  // 86 is not a Celsius running day, so it must be read as Fahrenheit.
  const imperial = W.normalise({ temp: 86, dewPoint: 68, relativeHumidity: 55 });
  assert.ok(29.0 < imperial.temp_c && imperial.temp_c < 31.0, String(imperial.temp_c));
  assert.ok(19.0 < imperial.dew_point_c && imperial.dew_point_c < 21.0, String(imperial.dew_point_c));

  // Nonsense humidity is dropped rather than believed.
  assert.equal(W.normalise({ temp: 20, relativeHumidity: 900 }).humidity, null);
  assert.equal(W.normalise({ temp: 'warm' }), null);
  assert.equal(W.normalise({ temp: NaN, relativeHumidity: 50 }).temp_c, null);
});

test('test_a_summer_run_stops_looking_like_lost_fitness', () => {
  // The point of all this: same effort, two seasons, one comparable number.
  const winter = 300.0, summer = 322.0;                   // 5:00 vs 5:22 per km
  const wAdj = W.adjust(winter, 4.0, 70);
  const sAdj = W.adjust(summer, 29.0, 80);
  assert.ok(summer - winter > 20);                        // looks like a big loss
  assert.ok(Math.abs(sAdj - wAdj) < (summer - winter));   // corrected, much of it goes
  assert.ok(sAdj < summer);
});

test('test_heat_acclimation_bands_match_the_protocol', () => {
  // Pinned against the 10-14 day protocol, allowing for the decay.
  const today = '2026-08-20';
  const hotDays = (n, ago = 0, temp = 27.0, minutes = 60.0) =>
    Array.from({ length: n }, (_, i) => [addDayKey(today, -(ago + i)), temp, minutes]);

  assert.equal(W.heatExposure([], today).band, 'none');

  // Three consecutive hot days is the start of something.
  const three = W.heatExposure(hotDays(3), today);
  assert.equal(three.band, 'starting', JSON.stringify(three));
  assert.equal(three.recent, 3);

  // A full two-week protocol is the top band.
  const full = W.heatExposure(hotDays(14), today);
  assert.equal(full.band, 'most of the way', JSON.stringify(full));
  assert.ok(full.sessions > three.sessions);

  // The same block six weeks ago has decayed away, which is the point.
  const stale = W.heatExposure(hotDays(14, 42), today);
  assert.equal(stale.band, 'none', JSON.stringify(stale));
  assert.equal(stale.recent, 0);
  assert.ok(stale.sessions < full.sessions * 0.1);
});

test('test_only_genuinely_hot_runs_count', () => {
  const today = '2026-08-20';
  const mild = Array.from({ length: 14 }, (_, i) => [addDayKey(today, -i), 14.0, 60.0]);
  assert.equal(W.heatExposure(mild, today).sessions, 0.0);
  assert.equal(W.heatExposure(mild, today).hottest_c, null);

  // A short hot run counts for less than a long one.
  const short = W.heatExposure([[today, 30.0, 15.0]], today);
  const longRun = W.heatExposure([[today, 30.0, 90.0]], today);
  assert.ok(short.sessions < longRun.sessions);
  assert.ok(longRun.sessions <= 1.0, 'one session cannot bank more than one');

  // Future-dated runs are ignored rather than counted backwards.
  const future = W.heatExposure([[addDayKey(today, 5), 30.0, 60.0]], today);
  assert.equal(future.sessions, 0.0);
});
