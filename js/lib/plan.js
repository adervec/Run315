// Getting from where you are to the start line.
//
// A training plan bought off a shelf starts from a distance and a number of weeks.
// This one starts from what you are already doing -- your current weekly volume,
// your current fitness, and the paces your own curve says you can hold -- because
// the plan that matters is the one that continues your training rather than
// replacing it.
//
// Three rules shape every plan here, and they are the ones people break:
//
//   * volume rises slowly and comes back down. Three weeks up, one week easy, and
//     a cap on how fast the ramp can go, because the acute-to-chronic ratio is
//     where overuse injuries live.
//   * the long run is a share of the week, not a heroic number on its own. It is
//     also capped by the race: nobody needs a 40 km run to race a 10K.
//   * intensity is prescribed as a *pace band from your own fit*, never as a
//     number off a chart.
//
// Everything below is a schedule, not a prescription. It has no idea whether you
// slept, and it says so on the page.
//
// Pure functions. No I/O, no dependencies. Port of plan.py; see test/plan.test.mjs.
import { pyRound } from './py.js';

// Three up, one down. The easy week is what lets the next block land.
export const CYCLE = 4;
export const EASY_WEEK_SHARE = 0.70;

// How fast weekly volume may rise, week on week, inside a build.
export const MAX_RAMP = 0.10;
// ...and how far above the starting point the plan will ever take you.
export const MAX_TOTAL_GROWTH = 1.60;

// The long run grows as a share of the week through the block: early on it is
// just the longest run of an easy week, by the peak it is the session the whole
// week is arranged around.
export const LONG_RUN_SHARE = { base: 0.26, build: 0.30, peak: 0.34, taper: 0.25 };
// Keys are race distances in metres (numeric-string object keys, sorted numerically below).
export const LONG_RUN_CAP_M = { 5000: 16000, 10000: 22000, 21097: 32000, 42195: 38000 };
export const DEFAULT_LONG_CAP_M = 30000;

// Taper length by race distance. Longer races need longer to unload.
export const TAPER_WEEKS = [[42195, 3], [21097, 2], [10000, 1], [0, 1]];

export const PHASES = ['base', 'build', 'peak', 'taper'];

// How many weeks of unloading this race deserves.
export function taperWeeks(distanceM) {
  for (const [threshold, weeks] of TAPER_WEEKS) if (distanceM >= threshold) return weeks;
  return 1;
}

// The longest single run worth doing for this race.
export function longRunCap(distanceM) {
  let best = DEFAULT_LONG_CAP_M;
  const caps = Object.entries(LONG_RUN_CAP_M).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]);
  for (const [race, cap] of caps) {
    if (distanceM <= race) return cap;
    best = cap;
  }
  return best;
}

// Which part of the block a week belongs to.
//
// Base builds the aerobic engine, build adds the hard work, peak sharpens it
// for the specific race, taper takes the fatigue off. The split is roughly
// 40/35/25 of the non-taper weeks, which is the shape most periodised plans
// use whatever they call it.
export function phaseFor(weekIndex, totalWeeks, taper) {
  const working = Math.max(totalWeeks - taper, 1);
  if (weekIndex >= working) return 'taper';
  const share = weekIndex / working;
  if (share < 0.40) return 'base';
  if (share < 0.75) return 'build';
  return 'peak';
}

// What the taper leaves of the peak week, counting back from the race.
export const TAPER_SHARES = [0.75, 0.55, 0.35];

// Weekly distance targets, ramped and cut back. -> [metres] per week.
//
// The progression is spread across the whole build so the heaviest week lands
// just before the taper. Compounding a fixed percentage instead hits the
// ceiling early and then sits there, which is a ramp followed by a plateau
// rather than a plan -- and the flat weeks are where people get stale.
//
// The week-on-week ramp is still capped, and so is the total: a plan that
// doubles your mileage in twelve weeks is not a plan, it is an injury with a
// calendar.
export function weeklyVolumes(startM, weeks, taper, peakCap = null) {
  if (weeks <= 0 || startM <= 0) return [];
  const peak = peakCap || startM * MAX_TOTAL_GROWTH;
  const buildWeeks = Math.max(weeks - taper, 1);

  const out = [];
  for (let i = 0; i < buildWeeks; i++) {
    const share = i / Math.max(buildWeeks - 1, 1);
    const target = startM + (peak - startM) * share;
    // Every fourth week backs off, without losing the thread of the block.
    const easy = Boolean(i && (i + 1) % CYCLE === 0);
    out.push(easy ? target * EASY_WEEK_SHARE : target);
  }

  // Hold the ramp even if a short block would otherwise ask for a big jump.
  for (let i = 1; i < out.length; i++) {
    const previous = out[i - 1];
    if (out[i] > previous * (1.0 + MAX_RAMP) && !(i && i % CYCLE === 0)) {
      out[i] = previous * (1.0 + MAX_RAMP);
    }
  }

  const peakWeek = out.length ? Math.max(...out) : startM;
  for (let j = 0; j < taper; j++) {
    if (out.length >= weeks) break;
    let share = TAPER_SHARES[Math.min(j, TAPER_SHARES.length - 1)];
    if (taper < TAPER_SHARES.length) {
      // A short taper should still finish light, so take the last shares.
      share = TAPER_SHARES[TAPER_SHARES.length - taper + j];
    }
    out.push(peakWeek * share);
  }
  return out.slice(0, weeks);
}

// The week's long run: a share of the week, capped by the race.
export function longRunFor(weekM, distanceM, phase = 'build') {
  const share = Object.hasOwn(LONG_RUN_SHARE, phase) ? LONG_RUN_SHARE[phase] : LONG_RUN_SHARE.build;
  return Math.min(weekM * share, longRunCap(distanceM));
}

// The two or three sessions that give a week its purpose. -> [[name, description, band]].
//
// `paces` is fitness.trainingPaces() output: [name, purpose, fast, slow].
// Everything is expressed as a band from the athlete's own curve, so the plan
// stays correct as they get fitter rather than going stale the day it is made.
export function keySessions(phase, distanceM, paces, weekM) {
  const band = new Map();
  for (const [name, , fast, slow] of paces || []) band.set(name, [fast, slow]);
  const at = name => (band.has(name) ? band.get(name) : null);

  const out = [];
  if (phase === 'base') {
    out.push(['Steady', '20-30 min continuous, comfortably hard', at('Marathon')]);
    out.push(['Strides', '6 x 20 s relaxed and fast off a jog', at('Repetition')]);
  } else if (phase === 'build') {
    out.push(['Threshold', '3 x 8 min with 2 min jog', at('Threshold')]);
    out.push(['Intervals', '6 x 3 min hard with 2 min jog', at('Interval')]);
  } else if (phase === 'peak') {
    if (distanceM >= 21097) {
      out.push(['Race pace', '2 x 20 min at goal pace inside the long run', at('Marathon')]);
      out.push(['Threshold', '4 x 8 min with 2 min jog', at('Threshold')]);
    } else {
      out.push(['Intervals', '5 x 1000 m with 3 min jog', at('Interval')]);
      out.push(['Threshold', '20 min continuous', at('Threshold')]);
    }
  } else {
    out.push(['Sharpener', '10 min easy, 6 x 90 s at race effort, 10 min easy', at('Threshold')]);
  }
  return out;
}

// A week-by-week plan. -> [object] one per week, first week first.
//
// `startWeekM` is what the athlete is actually running now, not what they
// wish they were running.
export function build(startWeekM, raceDistanceM, weeks, paces = null, peakCap = null) {
  if (weeks <= 0 || startWeekM <= 0 || raceDistanceM <= 0) return [];
  const taper = Math.min(taperWeeks(raceDistanceM), Math.max(weeks - 1, 1));
  const volumes = weeklyVolumes(startWeekM, weeks, taper, peakCap);

  return volumes.map((weekM, i) => {
    const phase = phaseFor(i, weeks, taper);
    const longM = longRunFor(weekM, raceDistanceM, phase);
    return {
      week: i + 1,
      to_go: weeks - i,
      phase,
      distance_m: weekM,
      long_run_m: longM,
      easy_m: Math.max(weekM - longM, 0.0),
      sessions: keySessions(phase, raceDistanceM, paces, weekM),
      easy_week: Boolean(i && (i + 1) % CYCLE === 0 && phase !== 'taper'),
    };
  });
}

// Headline numbers for a built plan, or null when there is no plan.
export function summarise(plan, raceDistanceM = null) {
  if (!plan || !plan.length) return null;
  // First max wins, as Python's max(key=...).
  let peak = plan[0], longest = plan[0];
  for (const w of plan) {
    if (w.distance_m > peak.distance_m) peak = w;
    if (w.long_run_m > longest.long_run_m) longest = w;
  }
  return {
    weeks: plan.length,
    peak_week_m: peak.distance_m,
    peak_week_n: peak.week,
    longest_run_m: longest.long_run_m,
    total_m: plan.reduce((a, w) => a + w.distance_m, 0),
    taper_weeks: plan.filter(w => w.phase === 'taper').length,
    growth: plan[0].distance_m ? (peak.distance_m / plan[0].distance_m) - 1.0 : 0.0,
    race_distance_m: raceDistanceM,
  };
}

// Warnings worth showing before anyone follows this. -> [string].
//
// A generated plan should be able to say when it is asking for something
// unreasonable, rather than presenting every number with equal confidence.
export function sanity(plan, currentWeekM) {
  const notes = [];
  if (!plan || !plan.length) return notes;
  const peak = Math.max(...plan.map(w => w.distance_m));
  if (currentWeekM && peak > currentWeekM * MAX_TOTAL_GROWTH + 1) {
    notes.push('This peaks a long way above what you are running now. ' +
      'Treat the later weeks as provisional.');
  }
  if (plan.length < 8) {
    notes.push('Under eight weeks is short for a real build -- expect to ' +
      'arrive fit rather than peaked.');
  }
  // The week after an easy week climbs back to where the build was, which is
  // the point of an easy week -- it is not a ramp violation. Compare each week
  // against the last one that was actually part of the build.
  const jumps = [];
  for (let i = 1; i < plan.length; i++) {
    const previous = plan[i - 1], week = plan[i];
    if (previous.easy_week || previous.distance_m <= 0) continue;
    if (week.distance_m > previous.distance_m) jumps.push(week.distance_m / previous.distance_m - 1.0);
  }
  if (jumps.length && Math.max(...jumps) > MAX_RAMP + 0.005) {
    notes.push('One week rises faster than the ' + pyRound(MAX_RAMP * 100) + '% ramp this plan is ' +
      'meant to hold to.');
  }
  return notes;
}
