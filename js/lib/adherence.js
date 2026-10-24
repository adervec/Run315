// Did you actually do the plan?
//
// A plan generator that never looks back is a horoscope. It produces a tidy table
// of what you ought to do, the athlete does something else, and nobody finds out
// until the race.
//
// This closes that loop. It compares the plan week by week against what was really
// run, and reports the thing that matters -- not a compliance percentage, but
// *which way* you drifted, because the two directions mean opposite things:
//
//   * consistently under the plan: the plan was too much, or life was. Either way
//     the projections built on it are optimistic.
//   * consistently over the plan: the plan is not the thing governing your
//     training, and the easy weeks it prescribes are the ones being skipped.
//
// Missing a session is normal. The literature on training plans is mostly a
// literature on people not finishing them. What is worth flagging is a *pattern*,
// so nothing here complains about a single week.
//
// Deliberately not built: a streak, a compliance grade, or anything that rewards
// hitting a number on a week you should have rested. The readiness read exists
// precisely to override the plan, and a scoring system that punishes you for
// listening to it would be working against the rest of the app.
//
// Pure functions. No I/O, no dependencies. Dates are 'YYYY-MM-DD' day keys;
// activity `start` may be a Date or a day key. See test/adherence.test.mjs.
import { dayKey, addDayKey, daysBetween, weekStart } from './dt.js';

// How far off a week's target still counts as having done it. Training is not
// surgery, and a plan hit to within a tenth is a plan followed.
export const ON_TARGET = 0.10;
// Below or above this, the week is not a near miss -- it is a different week.
export const WAY_OFF = 0.30;
// A pattern needs this many weeks before it is worth naming.
export const MIN_WEEKS = 3;
// What share of weeks have to lean the same way to count as a drift.
export const DRIFT_SHARE = 0.60;

// The Monday-to-Sunday span of plan week `index` (0-based). -> [begin, end]
export function weekBounds(startDate, index) {
  const begin = addDayKey(weekStart(startDate), 7 * index);
  return [begin, addDayKey(begin, 6)];
}

// What was really run in one week. -> object.
export function actualWeek(activities, begin, end) {
  const inside = [];
  for (const a of activities) {
    const when = a.start;
    if (when == null) continue;
    const day = dayKey(when);
    if (begin <= day && day <= end) inside.push(a);
  }
  let distance = 0.0, longest = 0.0;
  for (const a of inside) {
    const d = a.distance_m || 0.0;
    distance += d;
    if (d > longest) longest = d;
  }
  return { distance_m: distance, longest_m: longest, runs: inside.length };
}

// One planned week against one real one. -> object|null.
//
// `planned` is a row from plan.build(); `actual` from actualWeek().
export function compareWeek(planned, actual) {
  const target = planned.distance_m || 0.0;
  const done = actual.distance_m;
  if (target <= 0) return null;
  const share = done / target;
  let verdict;
  if (Math.abs(share - 1.0) <= ON_TARGET) verdict = 'on target';
  else if (share < 1.0 - WAY_OFF) verdict = 'well under';
  else if (share < 1.0) verdict = 'under';
  else if (share > 1.0 + WAY_OFF) verdict = 'well over';
  else verdict = 'over';

  const longTarget = planned.long_run_m || 0.0;
  const longDone = actual.longest_m;
  return {
    week: planned.week ?? null,
    phase: planned.phase ?? null,
    easy_week: planned.easy_week ?? null,
    planned_m: target,
    actual_m: done,
    share,
    verdict,
    runs: actual.runs,
    long_planned_m: longTarget,
    long_actual_m: longDone,
    long_share: longTarget > 0 ? longDone / longTarget : null,
    long_done: Boolean(longTarget && longDone >= longTarget * (1.0 - ON_TARGET)),
  };
}

// The whole plan against the whole record. -> object|null.
//
// Only weeks that have already finished are judged. A week still in progress is
// not a week you failed.
export function review(plan, activities, startDate, today = null) {
  if (!plan || !plan.length || !startDate) return null;
  const rows = [];
  for (let index = 0; index < plan.length; index++) {
    const [begin, end] = weekBounds(startDate, index);
    if (today && end >= today) break;     // not finished yet, so not judged
    const row = compareWeek(plan[index], actualWeek(activities, begin, end));
    if (row) {
      row.begin = begin; row.end = end;
      rows.push(row);
    }
  }
  if (!rows.length) return null;

  const plannedTotal = rows.reduce((s, r) => s + r.planned_m, 0);
  const actualTotal = rows.reduce((s, r) => s + r.actual_m, 0);
  const on = rows.filter(r => r.verdict === 'on target');
  const under = rows.filter(r => r.verdict === 'under' || r.verdict === 'well under');
  const over = rows.filter(r => r.verdict === 'over' || r.verdict === 'well over');
  const longRuns = rows.filter(r => r.long_planned_m);

  return {
    weeks: rows.length,
    rows,
    planned_m: plannedTotal,
    actual_m: actualTotal,
    share: plannedTotal ? actualTotal / plannedTotal : null,
    on_target: on.length,
    under: under.length,
    over: over.length,
    long_runs_done: longRuns.filter(r => r.long_done).length,
    long_runs_planned: longRuns.length,
    drift: _drift(rows),
    note: _note(rows, actualTotal, plannedTotal),
  };
}

// Which way the athlete leans, if consistently. -> string|null.
function _drift(rows) {
  if (rows.length < MIN_WEEKS) return null;
  const under = rows.filter(r => r.verdict === 'under' || r.verdict === 'well under').length;
  const over = rows.filter(r => r.verdict === 'over' || r.verdict === 'well over').length;
  if (under >= rows.length * DRIFT_SHARE) return 'under';
  if (over >= rows.length * DRIFT_SHARE) return 'over';
  return null;
}

// The sentence worth reading, which depends on the direction.
function _note(rows, actualTotal, plannedTotal) {
  if (rows.length < MIN_WEEKS) {
    return 'Too early in the block to see a pattern -- one week either way ' +
      'is just a week.';
  }
  const drift = _drift(rows);
  const share = plannedTotal ? actualTotal / plannedTotal : 1.0;
  const pct = (share * 100).toFixed(0);

  if (drift === 'under') {
    return `You are running ${pct}% of what the plan asks, most weeks. That ` +
      'is worth taking seriously in the other direction: the race ' +
      'projections assume the training in the plan, so either the plan ' +
      'needs to come down to meet you, or they are optimistic.';
  }
  if (drift === 'over') {
    const skipped = rows.filter(r => r.easy_week && r.share > 1.0 + ON_TARGET);
    let tail = '';
    if (skipped.length) {
      tail = ` ${skipped.length} of the easy weeks were run through, which is the part ` +
        'that costs you later.';
    }
    return `You are running ${pct}% of the plan, most weeks over rather than under.${tail}`;
  }
  const onTarget = rows.filter(r => r.verdict === 'on target').length;
  if (onTarget >= rows.length * DRIFT_SHARE) {
    return 'You are tracking the plan closely -- within a tenth on most ' +
      'weeks, which is as close as anyone follows a schedule.';
  }
  // Neither a consistent drift nor consistent accuracy: the weeks disagree
  // with each other, which is its own finding and should not be dressed up as
  // either success or failure.
  return 'Your weeks land on both sides of the plan rather than drifting one ' +
    `way -- ${onTarget} of ${rows.length} on target, and the rest split. The totals come out ` +
    `at ${pct}%, so the volume is roughly right and the week-to-week ` +
    'shape is not.';
}

// The week the athlete is in now, and what it asks for. -> object|null.
export function nextSession(plan, startDate, today) {
  if (!plan || !plan.length || !startDate || !today) return null;
  for (let index = 0; index < plan.length; index++) {
    const [begin, end] = weekBounds(startDate, index);
    if (begin <= today && today <= end) {
      return { ...plan[index], begin, end, days_left: daysBetween(today, end) + 1 };
    }
  }
  return null;
}
