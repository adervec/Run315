// Port of test_fuelling.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as FU from '../js/lib/fuelling.js';

test('test_carb_bands_match_the_published_guidance', () => {
  // Under 45 minutes: nothing needed.
  const short = FU.carbTarget(30 * 60);
  assert.equal(short.per_hour_high, 0);
  assert.ok(short.note.includes('glycogen covers it'));

  // 45-75 minutes: small amounts or a mouth rinse.
  const rinse = FU.carbTarget(60 * 60 - 1);
  assert.equal(rinse.per_hour_high, 30);
  assert.ok(rinse.note.includes('mouth rinse'));

  // 1-2.5 hours: the familiar 30-60 g/h.
  const standard = FU.carbTarget(90 * 60);
  assert.deepEqual([standard.per_hour_low, standard.per_hour_high], [30, 60]);
  assert.equal(standard.needs_mixed_sugars, false);

  // Beyond 2.5 hours: up to 90, and only with mixed sugars.
  const longRace = FU.carbTarget(3 * 3600);
  assert.deepEqual([longRace.per_hour_low, longRace.per_hour_high], [60, 90]);
  assert.equal(longRace.needs_mixed_sugars, true);
  assert.ok(longRace.note.includes('fructose'));
});

test('test_the_mixed_sugar_ceiling_is_the_point', () => {
  // Above the single-transporter ceiling the advice must change, not just scale.
  const below = FU.carbTarget(2 * 3600);
  const above = FU.carbTarget(4 * 3600);
  assert.ok(below.per_hour_high <= FU.SINGLE_SUGAR_CEILING);
  assert.ok(above.per_hour_high > FU.SINGLE_SUGAR_CEILING);
  assert.ok(!below.needs_mixed_sugars && above.needs_mixed_sugars);
  assert.ok(!below.note.includes('fructose'));
});

test('test_carb_totals_scale_with_duration', () => {
  const two = FU.carbTarget(2 * 3600);
  assert.ok(Math.abs(two.total_low - 60) < 1e-9);        // 30 g/h for 2 h
  assert.ok(Math.abs(two.total_high - 120) < 1e-9);
  assert.equal(FU.carbTarget(0), null);
  assert.equal(FU.carbTarget(null), null);
});

test('test_fluid_widens_in_the_heat_and_warns_about_overdrinking', () => {
  const cool = FU.fluidTarget(3 * 3600, 8.0);
  const hot = FU.fluidTarget(3 * 3600, 28.0);
  assert.ok(hot.per_hour_high > cool.per_hour_high);
  assert.ok(hot.hot && !cool.hot);
  // The hyponatraemia warning is a safety point, not decoration.
  assert.ok(cool.note.includes('thirst') && cool.note.includes('sodium'));
  // No temperature at all is treated as not hot rather than crashing.
  assert.equal(FU.fluidTarget(3600).hot, false);
  assert.equal(FU.fluidTarget(0), null);
});

test('test_sodium_only_appears_when_it_matters', () => {
  assert.equal(FU.sodiumTarget(60 * 60), null);          // an hour: not yet
  const longRace = FU.sodiumTarget(3 * 3600, 25.0);
  assert.notEqual(longRace, null);
  assert.equal(longRace.per_litre_low, 300);
  assert.ok(longRace.total_high > longRace.total_low && longRace.total_low > 0);
});

test('test_loading_only_for_races_long_enough_to_need_it', () => {
  assert.equal(FU.loading(45 * 60), null);
  const marathon = FU.loading(3.5 * 3600, 70);
  assert.equal(marathon.g_per_kg_low, 8);
  assert.ok(Math.abs(marathon.grams_low - 560) < 1e-9);   // 8 g/kg x 70 kg
  assert.ok(Math.abs(marathon.grams_high - 840) < 1e-9);
  // Without a weight it still gives the per-kilo figures.
  assert.ok(!('grams_low' in FU.loading(3.5 * 3600)));
});

test('test_schedule_spaces_intake_and_stops_before_the_finish', () => {
  const items = FU.schedule(3 * 3600);
  assert.ok(items.length, 'a three-hour race needs a schedule');
  // Nothing in the last ten minutes: it would not be absorbed in time.
  assert.ok(items.every(i => i.at_s <= 3 * 3600 - 600));
  // Evenly spaced, so no gap is more than a little larger than any other.
  const gaps = [];
  for (let i = 1; i < items.length; i++) gaps.push(items[i].at_s - items[i - 1].at_s);
  if (gaps.length) assert.ok(Math.max(...gaps) - Math.min(...gaps) < 1.0);
  // Cumulative total lands inside the recommended band.
  const target = FU.carbTarget(3 * 3600);
  const total = items[items.length - 1].cumulative_g;
  assert.ok(target.total_low * 0.8 <= total && total <= target.total_high * 1.2, String(total));

  // A short run needs no schedule at all.
  assert.deepEqual(FU.schedule(20 * 60), []);
  assert.deepEqual(FU.schedule(0), []);
});

test('test_schedule_respects_a_custom_rate', () => {
  // An athlete who has trained their gut can ask for more.
  const def = FU.schedule(3 * 3600);
  const trained = FU.schedule(3 * 3600, 90);
  assert.ok(trained.length > def.length);
  assert.ok(trained[trained.length - 1].cumulative_g > def[def.length - 1].cumulative_g);
});

test('test_plan_assembles_the_parts_that_apply', () => {
  const marathon = FU.plan(3.5 * 3600, 24.0, 70);
  assert.ok(marathon.carbs.needs_mixed_sugars);
  assert.ok(marathon.fluid.hot);
  assert.ok(marathon.sodium && marathon.loading);
  assert.ok(marathon.schedule.length);

  // A parkrun gets carbohydrate advice saying "none" and nothing else.
  const parkrun = FU.plan(22 * 60);
  assert.equal(parkrun.carbs.per_hour_high, 0);
  assert.ok(parkrun.sodium === null && parkrun.loading === null);
  assert.deepEqual(parkrun.schedule, []);

  assert.equal(FU.plan(0), null);
});
