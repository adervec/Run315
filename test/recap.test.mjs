// Port of test_recap.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../js/lib/recap.js';
import { addDays, addDayKey, fromDay, weekStart } from '../js/lib/dt.js';

function run(when, km = 10.0, seconds = 3000.0, ascent = 50.0) {
  return { start: when, distance_m: km * 1000.0, moving_s: seconds, elev_gain_m: ascent };
}

// One run a week for `weeks` consecutive weeks.
function weekly(start, weeks, km = 10.0) {
  const out = [];
  for (let i = 0; i < weeks; i++) out.push(run(addDays(start, 7 * i), km));
  return out;
}

test('test_totals', () => {
  const acts = [run(new Date(2026, 0, 1), 10.0), run(new Date(2026, 0, 2), 5.0)];
  const t = R.totals(acts);
  assert.equal(t.runs, 2);
  assert.equal(t.distance_m, 15000.0);
  assert.equal(t.seconds, 6000.0);
  assert.equal(t.ascent_m, 100.0);
  // Missing fields count as zero rather than crashing.
  assert.equal(R.totals([{ start: new Date(2026, 0, 1) }]).distance_m, 0.0);
  assert.equal(R.totals([]).runs, 0);
});

test('test_by_year_is_most_recent_first', () => {
  const acts = [run(new Date(2024, 4, 1), 8.0), run(new Date(2026, 4, 1), 12.0),
    run(new Date(2025, 4, 1), 10.0), run(new Date(2026, 5, 1), 20.0)];
  const rows = R.byYear(acts);
  assert.deepEqual(rows.map(r => r.year), [2026, 2025, 2024]);
  assert.ok(rows[0].runs === 2 && rows[0].distance_m === 32000.0);
  assert.equal(rows[0].longest_m, 20000.0);
});

test('test_busiest_month', () => {
  const acts = [...[1, 2, 3].map(d => run(new Date(2026, 2, d), 10.0)), run(new Date(2026, 6, 1), 25.0)];
  const [month, metres] = R.busiestMonth(acts, 2026);
  assert.ok(month === 3 && metres === 30000.0);
  assert.equal(R.busiestMonth(acts, 2020), null);
});

test('test_week_streak_counts_weeks_not_days', () => {
  const today = '2026-08-20';              // a Thursday
  const monday = weekStart(today);
  const acts = weekly(fromDay(addDayKey(monday, -7 * 9)), 10);
  const streak = R.weekStreak(acts, today);
  assert.equal(streak.current, 10);
  assert.equal(streak.longest, 10);
  assert.equal(streak.weeks_run, 10);

  // Several runs in one week are still one week.
  const sameWeek = [0, 1, 2, 3].map(d => run(fromDay(addDayKey(monday, d))));
  assert.equal(R.weekStreak(sameWeek, today).current, 1);

  assert.deepEqual(R.weekStreak([], today), { current: 0, longest: 0, weeks_run: 0 });
});

test('test_a_week_still_in_progress_does_not_break_the_streak', () => {
  // Running Monday to Sunday last week and not yet this week is not a break.
  const today = '2026-08-18';              // a Tuesday
  const monday = weekStart(today);
  // Runs up to last week only.
  const acts = weekly(fromDay(addDayKey(monday, -7 * 5)), 5);
  assert.equal(R.weekStreak(acts, today).current, 5);
});

test('test_longest_streak_survives_a_later_gap', () => {
  const today = '2026-08-20';
  const monday = weekStart(today);
  const old = weekly(fromDay(addDayKey(monday, -7 * 30)), 12);
  const recent = weekly(fromDay(addDayKey(monday, -7 * 2)), 3);
  const streak = R.weekStreak([...old, ...recent], today);
  assert.equal(streak.longest, 12);
  assert.equal(streak.current, 3);
});

test('test_milestone_ladder', () => {
  const m = R.milestone(1200.0, R.DISTANCE_TIERS_KM);
  assert.ok(m.last === 1000 && m.next === 2500);
  assert.ok(Math.abs(m.to_go - 1300.0) < 1e-9);
  assert.ok(0 < m.progress && m.progress < 1);
  assert.equal(m.cleared, 3);          // 100, 500, 1000

  // Below the first rung there is nothing cleared but something to aim at.
  const low = R.milestone(10.0, R.DISTANCE_TIERS_KM);
  assert.ok(low.last === null && low.next === 100 && low.cleared === 0);

  // Past the top there is nothing left to chase.
  const top = R.milestone(999999.0, R.DISTANCE_TIERS_KM);
  assert.ok(top.next === null && top.to_go === null && top.progress === 1.0);

  assert.equal(R.milestone(null, R.DISTANCE_TIERS_KM), null);
  assert.equal(R.milestone(-1, R.DISTANCE_TIERS_KM), null);
});

test('test_career', () => {
  const acts = weekly(new Date(2024, 0, 1), 100, 10.0);
  const c = R.career(acts, 12, '2026-08-20');
  assert.equal(c.totals.runs, 100);
  assert.ok(Math.abs(c.km - 1000.0) < 1e-6);
  assert.equal(c.distance_milestone.last, 1000);
  assert.ok(c.race_milestone.last === 10 && c.race_milestone.next === 25);
  assert.ok(c.years > 2.0);
  assert.ok(0 < c.equator && c.equator < 1);
  assert.deepEqual(c.first_run, new Date(2024, 0, 1));

  const empty = R.career([], 0, '2026-08-20');
  assert.ok(empty.km === 0.0 && empty.years === null);
});

test('test_compare_years', () => {
  const rows = R.byYear([run(new Date(2025, 4, 1), 100.0), run(new Date(2026, 4, 1), 150.0)]);
  const c = R.compareYears(rows, 2026);
  assert.ok(Math.abs(c.change - 0.5) < 1e-9);
  assert.ok(c.note.includes('more running'));

  const down = R.compareYears(R.byYear([run(new Date(2025, 4, 1), 100.0),
    run(new Date(2026, 4, 1), 50.0)]), 2026);
  assert.ok(down.note.includes('less running'));

  const level = R.compareYears(R.byYear([run(new Date(2025, 4, 1), 100.0),
    run(new Date(2026, 4, 1), 103.0)]), 2026);
  assert.ok(level.note.includes('About the same'));

  // Nothing to compare against.
  assert.equal(R.compareYears(rows, 2025), null);
});

test('test_partial_year_compares_like_for_like', () => {
  // Eleven months against twelve is not a decline, and must not read as one.
  const today = '2026-08-20';
  const months = n => Array.from({ length: n }, (_, i) => i);
  const acts = [
    // Last year: steady all year, so the full year dwarfs this year to date.
    ...months(12).map(m => run(new Date(2025, m, 1), 100.0)),
    // This year: the same rate, but only up to August.
    ...months(8).map(m => run(new Date(2026, m, 1), 100.0)),
  ];
  const result = R.partialYearCompare(acts, 2026, today);
  assert.notEqual(result, null);
  // Same rate to the same point in the year: no change.
  assert.ok(Math.abs(result.change) < 1e-9);
  assert.ok(result.note.includes('About the same'));

  // The naive full-year comparison would have shown a big fall.
  const naive = R.compareYears(R.byYear(acts), 2026);
  assert.ok(naive.change < -0.3, String(naive.change));

  // A record that only began partway through last year is not a comparison.
  // The 2025 run must fall *before* day 232, or there is no baseline at all
  // and the function correctly returns null instead.
  const lateStart = [run(new Date(2025, 7, 1), 5.0), ...months(8).map(m => run(new Date(2026, m, 1), 100.0))];
  const thin = R.partialYearCompare(lateStart, 2026, today);
  assert.equal(thin.thin_baseline, true);
  assert.ok(thin.note.includes('first full year'));
  assert.ok(!thin.note.includes('%'), 'a 15,900% figure helps nobody');

  // A real comparison is not flagged.
  assert.equal(R.partialYearCompare(acts, 2026, today).thin_baseline, false);

  // Not applicable to a past year.
  assert.equal(R.partialYearCompare(acts, 2025, today), null);
  // Nothing last year means nothing to compare.
  assert.equal(R.partialYearCompare([run(new Date(2026, 0, 1), 10.0)], 2026, today), null);
});
