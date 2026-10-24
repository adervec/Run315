// A career, rather than a rolling twelve-week window.
//
// Every training app forgets. Fitness is a 42-day average, form is a 7-day one, and
// the dashboard resets every January. That is the right way to answer "am I ready
// for Saturday" and the wrong way to answer "what have I actually done".
//
// Taiwan's 馬拉松普查 -- a civilian-run national marathon census, started by one
// veteran runner -- keeps a lifetime ledger instead, with awards at 10, 30, 60, 100
// marathons and beyond, and a published, argued-over standard for what counts as
// one. That is a completely different relationship to your own history, and no
// Western app offers anything like it.
//
// Two things here:
//
//   * **The year.** What you did, against what you did the year before -- the same
//     comparison, honestly made, rather than a highlight reel.
//   * **The career.** Cumulative distance, time and races, with the next milestone
//     named so it is something to walk towards.
//
// Streaks are deliberately counted in weeks rather than days. A daily run streak
// rewards running on days you should not, which is a mechanic this app declines to
// build; a week with a run in it is a habit rather than a compulsion.
//
// Pure functions. No I/O, no dependencies. `today` is a 'YYYY-MM-DD' day key;
// activity `start` is a Date (a day key also works). See test/recap.test.mjs.
import { dayKey, daysBetween, weekStart, addDayKey } from './dt.js';

// Career milestones. Distance in kilometres, races as a count -- both chosen to
// be reachable rather than aspirational, which is the point of a ladder.
export const DISTANCE_TIERS_KM = [100, 500, 1000, 2500, 5000, 10000, 25000, 50000];
export const RACE_TIERS = [1, 5, 10, 25, 50, 100, 200, 500];
// The earth's circumference, because at some point the ladder should end
// somewhere worth arriving at.
export const EQUATOR_KM = 40075;

// Below this share of the current year, last year's record is too thin to be a
// comparison rather than an accident of when tracking started.
export const THIN_BASELINE = 0.25;

const _today = () => dayKey(new Date());

function _yearOf(when) {
  if (when instanceof Date) return when.getFullYear();
  if (typeof when === 'string' && when.length >= 4) return Number(when.slice(0, 4));
  return null;
}
const _monthOf = when => Number(dayKey(when).slice(5, 7));
// Python's timetuple().tm_yday: 1 on January 1st.
const _yday = when => { const k = dayKey(when); return daysBetween(k.slice(0, 4) + '-01-01', k) + 1; };

// Distance, time and count over whatever is passed. -> object.
export function totals(activities) {
  let distance = 0.0, seconds = 0.0, ascent = 0.0;
  for (const a of activities) {
    distance += a.distance_m || 0.0;
    seconds += a.moving_s || 0.0;
    ascent += a.elev_gain_m || 0.0;
  }
  return { runs: activities.length, distance_m: distance, seconds, ascent_m: ascent };
}

// Totals per calendar year, most recent first. -> [object].
export function byYear(activities) {
  const buckets = new Map();
  for (const a of activities) {
    const year = _yearOf(a.start);
    if (year === null) continue;
    if (!buckets.has(year)) buckets.set(year, []);
    buckets.get(year).push(a);
  }
  return [...buckets.keys()].sort((a, b) => b - a).map(year => {
    const row = totals(buckets.get(year));
    row.year = year;
    row.longest_m = Math.max(0.0, ...buckets.get(year).map(a => a.distance_m || 0.0));
    return row;
  });
}

// The month of `year` with the most distance. -> [month, metres]|null.
export function busiestMonth(activities, year) {
  const months = new Map();
  for (const a of activities) {
    const when = a.start;
    if (_yearOf(when) !== year) continue;
    const m = _monthOf(when);
    months.set(m, (months.get(m) ?? 0.0) + (a.distance_m || 0.0));
  }
  if (!months.size) return null;
  // max() keeps the first month seen on a tie, as Python's does.
  let month = null;
  for (const [m, v] of months) if (month === null || v > months.get(month)) month = m;
  return [month, months.get(month)];
}

// Consecutive weeks containing at least one run. -> object.
//
// Counted in weeks on purpose. A daily streak rewards running on the days you
// should not, and this app is not going to hand out a badge for that.
export function weekStreak(activities, today = null) {
  today = today || _today();
  const weeks = new Set();
  for (const a of activities) {
    if (a.start == null) continue;
    weeks.add(weekStart(a.start));
  }
  if (!weeks.size) return { current: 0, longest: 0, weeks_run: 0 };

  const ordered = [...weeks].sort();
  let longest = 1, run = 1;
  for (let i = 1; i < ordered.length; i++) {
    run = daysBetween(ordered[i - 1], ordered[i]) === 7 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  // The current streak may end this week or last: a week still in progress
  // should not break it.
  const thisWeek = weekStart(today);
  let current = 0;
  let cursor = weeks.has(thisWeek) ? thisWeek : addDayKey(thisWeek, -7);
  while (weeks.has(cursor)) {
    current++;
    cursor = addDayKey(cursor, -7);
  }
  return { current, longest, weeks_run: weeks.size };
}

// Where a running total sits on a ladder. -> object|null.
//
// Reports the last tier passed and the next one coming, so the number always
// has somewhere to be going.
export function milestone(value, tiers, unit = 'km') {
  if (value == null || value < 0 || !tiers || !tiers.length) return null;
  const passed = tiers.filter(t => value >= t);
  const upcoming = tiers.filter(t => t > value);
  return {
    value,
    last: passed.length ? passed[passed.length - 1] : null,
    next: upcoming.length ? upcoming[0] : null,
    to_go: upcoming.length ? upcoming[0] - value : null,
    progress: upcoming.length ? value / upcoming[0] : 1.0,
    unit,
    cleared: passed.length,
  };
}

// The lifetime ledger. -> object.
export function career(activities, racesFinished = 0, today = null) {
  const life = totals(activities);
  const km = life.distance_m / 1000.0;
  let first = null;
  for (const a of activities) if (a.start && (first === null || a.start < first)) first = a.start;
  return {
    totals: life,
    km,
    years: _spanYears(first, today),
    first_run: first,
    distance_milestone: milestone(km, DISTANCE_TIERS_KM, 'km'),
    race_milestone: milestone(racesFinished, RACE_TIERS, 'races'),
    races_finished: racesFinished,
    equator: km / EQUATOR_KM,
    streak: weekStreak(activities, today),
  };
}

// How long the record covers, in years. -> number|null.
function _spanYears(first, today = null) {
  if (!first) return null;
  today = today || _today();
  return Math.max(daysBetween(first, today) / 365.25, 0.0);
}

// This year against last. -> object|null.
//
// Only compares the part of last year that has already elapsed this year, so a
// half-finished year is not held against a complete one.
export function compareYears(rows, year) {
  const current = rows.find(r => r.year === year) ?? null;
  const previous = rows.find(r => r.year === year - 1) ?? null;
  if (!current || !previous || !previous.distance_m) return null;
  const change = current.distance_m / previous.distance_m - 1.0;
  return { year, distance_m: current.distance_m, previous_m: previous.distance_m,
    change, note: _yearNote(change) };
}

function _yearNote(change) {
  const percent = (Math.abs(change) * 100.0).toFixed(0);
  if (change > 0.10) return `${percent}% more running than the year before.`;
  if (change < -0.10) return `${percent}% less running than the year before.`;
  return 'About the same as the year before.';
}

// This year so far against the same span of last year. -> object|null.
//
// The comparison every app gets wrong: eleven months of this year against
// twelve of last is not a decline.
export function partialYearCompare(activities, year, today = null) {
  today = today || _today();
  if (year !== _yearOf(today)) return null;
  const cutoff = _yday(today);

  const upto = targetYear => {
    let s = 0.0;
    for (const a of activities) {
      if (_yearOf(a.start) === targetYear && _yday(a.start) <= cutoff) s += a.distance_m || 0.0;
    }
    return s;
  };

  const now = upto(year), before = upto(year - 1);
  if (!before) return null;
  const change = now / before - 1.0;

  // A record that only started partway through last year is not a training
  // comparison, it is an artefact of when you began. Expressing it as a
  // percentage produces things like "26,090% more running", which is true and
  // useless.
  const thin = before < now * THIN_BASELINE;
  const note = thin
    ? "Last year's record does not go back far enough to compare against " +
      '-- this is effectively your first full year.'
    : _yearNote(change);
  return { so_far_m: now, same_point_last_year_m: before, change, day_of_year: cutoff,
    thin_baseline: thin, note };
}
