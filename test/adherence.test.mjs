// Port of test_adherence.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as AD from '../js/lib/adherence.js';
import { addDayKey, fromDay, weekday } from '../js/lib/dt.js';

const MONDAY = '2026-01-05';          // a Monday, so week bounds are unambiguous

function plannedWeek(n, km, longKm = null, easy = false, phase = 'build') {
  return { week: n, phase, easy_week: easy, distance_m: km * 1000.0,
    long_run_m: (longKm || km * 0.3) * 1000.0 };
}

// Spread `totalKm` over `count` runs inside the week starting `begin`.
function runsInWeek(begin, totalKm, longestKm = null, count = 4) {
  longestKm = longestKm !== null ? longestKm : totalKm / count;
  const rest = totalKm - longestKm;
  const out = [{ start: fromDay(begin), distance_m: longestKm * 1000.0 }];
  for (let i = 1; i < count; i++) {
    out.push({ start: fromDay(addDayKey(begin, i)), distance_m: rest / Math.max(count - 1, 1) * 1000.0 });
  }
  return out;
}

test('test_week_bounds_are_monday_to_sunday', () => {
  const [begin, end] = AD.weekBounds(MONDAY, 0);
  assert.ok(begin === MONDAY && end === addDayKey(MONDAY, 6));
  assert.ok(weekday(begin) === 0 && weekday(end) === 6);
  // Week 2 starts a fortnight later.
  assert.equal(AD.weekBounds(MONDAY, 2)[0], addDayKey(MONDAY, 14));
  // A start date midweek still snaps back to its Monday.
  assert.equal(AD.weekBounds('2026-01-07', 0)[0], MONDAY);
});

test('test_actual_week_only_counts_that_week', () => {
  const acts = [...runsInWeek(MONDAY, 50.0), ...runsInWeek(addDayKey(MONDAY, 7), 30.0)];
  const got = AD.actualWeek(acts, MONDAY, addDayKey(MONDAY, 6));
  assert.ok(Math.abs(got.distance_m - 50000.0) < 1.0);
  assert.equal(got.runs, 4);
  // Nothing in an empty week.
  const empty = AD.actualWeek(acts, addDayKey(MONDAY, 21), addDayKey(MONDAY, 27));
  assert.ok(empty.distance_m === 0.0 && empty.runs === 0);
});

test('test_compare_week_verdicts', () => {
  const plan = plannedWeek(1, 50.0);
  const verdict = km => AD.compareWeek(plan, { distance_m: km * 1000.0, longest_m: 0.0, runs: 4 }).verdict;

  assert.equal(verdict(50.0), 'on target');
  assert.equal(verdict(46.0), 'on target');        // within a tenth
  assert.equal(verdict(54.0), 'on target');
  assert.equal(verdict(42.0), 'under');
  assert.equal(verdict(30.0), 'well under');
  assert.equal(verdict(58.0), 'over');
  assert.equal(verdict(70.0), 'well over');

  // A week with no target cannot be judged.
  assert.equal(AD.compareWeek(plannedWeek(1, 0.0), { distance_m: 10000.0, longest_m: 0.0, runs: 1 }), null);
});

test('test_long_run_is_judged_separately_from_volume', () => {
  // Hitting the mileage with lots of short runs is not the same plan.
  const plan = plannedWeek(1, 50.0, 20.0);
  // Full volume, but the longest run was only 10 km.
  const row = AD.compareWeek(plan, { distance_m: 50000.0, longest_m: 10000.0, runs: 5 });
  assert.equal(row.verdict, 'on target');
  assert.equal(row.long_done, false);
  assert.ok(Math.abs(row.long_share - 0.5) < 1e-9);

  const done = AD.compareWeek(plan, { distance_m: 50000.0, longest_m: 19000.0, runs: 4 });
  assert.equal(done.long_done, true);     // within a tenth counts
});

test('test_review_ignores_a_week_still_in_progress', () => {
  const plan = [1, 2, 3, 4].map(n => plannedWeek(n, 50.0));
  let acts = [];
  for (let i = 0; i < 4; i++) acts = acts.concat(runsInWeek(addDayKey(MONDAY, 7 * i), 50.0));
  // "Today" falls inside week 3, so only weeks 1 and 2 are judged.
  const today = addDayKey(MONDAY, 16);
  const result = AD.review(plan, acts, MONDAY, today);
  assert.equal(result.weeks, 2);
  assert.ok(result.rows.every(r => r.end < today));
});

test('test_review_totals_and_drift_under', () => {
  const plan = [1, 2, 3, 4, 5].map(n => plannedWeek(n, 50.0));
  let acts = [];
  for (let i = 0; i < 5; i++) acts = acts.concat(runsInWeek(addDayKey(MONDAY, 7 * i), 35.0));
  const result = AD.review(plan, acts, MONDAY, addDayKey(MONDAY, 40));
  assert.equal(result.weeks, 5);
  assert.equal(result.drift, 'under');
  assert.ok(result.under === 5 && result.on_target === 0);
  assert.ok(Math.abs(result.share - 0.7) < 0.01);
  assert.ok(result.note.includes('optimistic'));
});

test('test_review_drift_over_calls_out_skipped_easy_weeks', () => {
  const plan = [plannedWeek(1, 50.0), plannedWeek(2, 50.0), plannedWeek(3, 50.0),
    plannedWeek(4, 35.0, null, true)];
  let acts = [];
  // Runs 60 km every week, including through the easy one.
  for (let i = 0; i < 4; i++) acts = acts.concat(runsInWeek(addDayKey(MONDAY, 7 * i), 60.0));
  const result = AD.review(plan, acts, MONDAY, addDayKey(MONDAY, 35));
  assert.equal(result.drift, 'over');
  assert.ok(result.note.includes('easy weeks were run through'));
});

test('test_review_on_target_says_so_plainly', () => {
  const plan = [1, 2, 3, 4].map(n => plannedWeek(n, 50.0));
  let acts = [];
  for (let i = 0; i < 4; i++) acts = acts.concat(runsInWeek(addDayKey(MONDAY, 7 * i), 51.0));
  const result = AD.review(plan, acts, MONDAY, addDayKey(MONDAY, 35));
  assert.equal(result.drift, null);
  assert.equal(result.on_target, 4);
  assert.ok(result.note.includes('tracking the plan closely'));
});

test('test_scattered_weeks_are_not_called_close_tracking', () => {
  // Regression: 4 of 16 weeks on target once read as "within a tenth on most
  // weeks", which the numbers plainly did not support.
  const plan = [1, 2, 3, 4, 5, 6, 7, 8].map(n => plannedWeek(n, 50.0));
  let acts = [];
  // Alternating well over and well under: the total comes out right, the
  // individual weeks do not.
  for (let i = 0; i < 8; i++) acts = acts.concat(runsInWeek(addDayKey(MONDAY, 7 * i), i % 2 ? 70.0 : 30.0));
  const result = AD.review(plan, acts, MONDAY, addDayKey(MONDAY, 70));
  assert.equal(result.drift, null);            // neither direction dominates
  assert.equal(result.on_target, 0);
  assert.ok(!result.note.includes('tracking the plan closely'));
  assert.ok(result.note.includes('both sides of the plan'));
  // The totals really are about right, which is the point being made.
  assert.ok(0.9 < result.share && result.share < 1.1);
});

test('test_a_short_block_does_not_get_a_verdict', () => {
  // Two weeks is not a pattern, and must not be reported as one.
  const plan = [plannedWeek(1, 50.0), plannedWeek(2, 50.0)];
  const acts = runsInWeek(MONDAY, 20.0);
  const result = AD.review(plan, acts, MONDAY, addDayKey(MONDAY, 21));
  assert.equal(result.drift, null);
  assert.ok(result.note.includes('Too early'));
});

test('test_review_edges', () => {
  assert.equal(AD.review([], [], MONDAY), null);
  assert.equal(AD.review(null, [], MONDAY), null);
  assert.equal(AD.review([plannedWeek(1, 50.0)], [], null), null);
  // Every week still ahead means nothing to judge.
  assert.equal(AD.review([plannedWeek(1, 50.0)], [], MONDAY, MONDAY), null);
});

test('test_next_session_finds_the_week_you_are_in', () => {
  const plan = [1, 2, 3, 4].map(n => plannedWeek(n, 50.0));
  // Wednesday of week 2.
  const today = addDayKey(MONDAY, 9);
  const nxt = AD.nextSession(plan, MONDAY, today);
  assert.equal(nxt.week, 2);
  assert.ok(nxt.begin <= today && today <= nxt.end);
  assert.equal(nxt.days_left, 5);          // Wed, Thu, Fri, Sat, Sun

  // Past the end of the plan there is no current week.
  assert.equal(AD.nextSession(plan, MONDAY, addDayKey(MONDAY, 200)), null);
  assert.equal(AD.nextSession([], MONDAY, today), null);
});
