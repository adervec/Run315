// Was that hard because of you, or because of the hill?
//
// Pace means nothing on a route you have never run. A 5:30/km on the flat and a
// 5:30/km up a fell are different efforts, and every summary that averages them
// together is throwing the interesting part away.
//
// Two questions here, and they are not the same one:
//
//   * How hard was the route? Answered against an external, published standard
//     -- Naismith's rule, with Langmuir's descent corrections. This is what the
//     hiking world has used since 1892 and what Taiwan's and Korea's national trail
//     databases still quote as the official time for a course. It knows nothing
//     about you, which is exactly why it is useful as a yardstick.
//
//   * How well do *you* climb? Answered against the metabolic model. Minetti's
//     energy-cost polynomial says what a given gradient should cost an average
//     runner. Fitting your own observed slowdown against it says whether hills cost
//     you more or less than the model expects -- a personal number that ordinary
//     grade-adjusted pace hides, because GAP *applies* the model rather than
//     testing it.
//
// The second one is the interesting half and, as far as the survey went, nobody
// ships it. Strava's GAP adjusts for grade but has no ground truth to check itself
// against, so it can never tell you that you are a good climber.
//
// Naismith: 5 km/h on the flat, plus one hour for every 600 m of ascent
// (Naismith, Scottish Mountaineering Club Journal, 1892). Langmuir's corrections
// subtract 10 minutes per 300 m of gentle descent and add 10 minutes per 300 m of
// steep descent (Langmuir, Mountaincraft and Leadership, 1984).
//
// Pure functions. Depends on racecraft for the Minetti model. Port of terrain.py;
// see test/terrain.test.mjs.
import * as RC from './racecraft.js';

// Naismith's constants, in the units the rule was written in.
export const FLAT_SPEED_KMH = 5.0;
export const ASCENT_M_PER_HOUR = 600.0;

// Langmuir: gentle descent is quicker than flat, steep descent is slower.
export const GENTLE_DESCENT = [-0.20, -0.05];     // grade band that earns the bonus
export const DESCENT_BONUS_S_PER_M = -10 * 60.0 / 300.0;
export const DESCENT_PENALTY_S_PER_M = 10 * 60.0 / 300.0;
export const STEEP_DESCENT = -0.20;

// Grade bands for describing a route, and the ascent-per-km that defines them.
export const DIFFICULTY = [[5.0, 'flat'], [15.0, 'rolling'], [30.0, 'hilly'], [60.0, 'steep']];

// Fitting the personal climb cost. Segments flatter than this carry no
// information about climbing, and anything past the Minetti model's range is
// outside what the polynomial was fitted on.
export const MIN_GRADE = 0.02;
export const MAX_GRADE = 0.30;
export const MIN_SEGMENTS = 8;
export const MIN_FLAT_SEGMENTS = 3;

// '%.0f' with Python's round-half-even on exact ties.
function _fmt0(x) {
  if (Number.isInteger(x * 2) && !Number.isInteger(x)) {
    const f = Math.floor(x);
    return String(f % 2 === 0 ? f : f + 1);
  }
  return x.toFixed(0);
}

// Naismith's rule with Langmuir's descent corrections. -> seconds.
//
// This is a *walking* standard, so a runner will come in well under it. That is
// fine and expected: it is a fixed yardstick, not a prediction.
export function bookTime(distanceM, ascentM = 0.0, descentM = 0.0, descentGrade = null) {
  if (distanceM <= 0) return 0.0;
  let seconds = (distanceM / 1000.0) / FLAT_SPEED_KMH * 3600.0;
  seconds += (ascentM || 0.0) / ASCENT_M_PER_HOUR * 3600.0;
  if (descentM && descentGrade != null) {
    if (descentGrade <= STEEP_DESCENT) {
      seconds += descentM * DESCENT_PENALTY_S_PER_M;
    } else if (GENTLE_DESCENT[0] < descentGrade && descentGrade <= GENTLE_DESCENT[1]) {
      seconds += descentM * DESCENT_BONUS_S_PER_M;
    }
  }
  return Math.max(seconds, 0.0);
}

// A word for how hilly a route is, from ascent per kilometre.
export function difficulty(distanceM, ascentM) {
  if (distanceM <= 0) return null;
  const perKm = (ascentM || 0.0) / (distanceM / 1000.0);
  for (const [limit, name] of DIFFICULTY) if (perKm < limit) return name;
  return 'mountainous';
}

// Your time against the published standard for that ground. -> object|null.
//
// Lower is stronger. Because the standard is a walking pace the number will
// look small, so what matters is comparing it between your own outings: the
// same ratio on a much hillier route is a better day.
export function terrainRatio(actualS, distanceM, ascentM = 0.0, descentM = 0.0, descentGrade = null) {
  const book = bookTime(distanceM, ascentM, descentM, descentGrade);
  if (!book || !actualS || actualS <= 0) return null;
  return {
    ratio: actualS / book,
    book_s: book,
    actual_s: actualS,
    difficulty: difficulty(distanceM, ascentM),
    ascent_per_km: (ascentM || 0.0) / (distanceM / 1000.0),
  };
}

// Chop a stream into fixed-distance pieces. -> [[grade, speed_m_s]].
//
// 200 m is long enough that GPS and barometric noise average out, and short
// enough that a segment has one gradient rather than several.
function _segments(samples, stepM = 200.0) {
  if (!samples || samples.length < 4) return [];
  const out = [];
  let anchor = samples[0];
  for (const sample of samples.slice(1)) {
    const run = sample[1] - anchor[1];
    if (run < stepM) continue;
    const seconds = sample[0] - anchor[0];
    if (seconds > 0 && anchor[5] != null && sample[5] != null) {
      const grade = (sample[5] - anchor[5]) / run;
      if (-MAX_GRADE <= grade && grade <= MAX_GRADE) out.push([grade, run / seconds]);
    }
    anchor = sample;
  }
  return out;
}

// How much hills actually cost you, against what the model predicts.
// -> object, or null when the run has nothing to say about climbing.
//
// The method is deliberately simple: take the runner's own speed on the flat
// parts of this run as the reference, then for each climbing segment compare
// the speed they actually held with the speed Minetti's cost model says they
// should have held for the same metabolic outlay. The average of those is the
// factor.
//
//     factor < 1  -- hills cost you more than the model expects
//     factor > 1  -- you climb better than the model expects
//
// This is a *within-run* comparison, so it is unaffected by fitness, weather or
// how hard the day was: everything cancels except the gradient.
export function climbCost(samples, stepM = 200.0) {
  const segments = _segments(samples, stepM);
  if (segments.length < MIN_SEGMENTS) return null;

  const flat = segments.filter(([g]) => Math.abs(g) < MIN_GRADE).map(([, s]) => s);
  const climbs = segments.filter(([g]) => g >= MIN_GRADE);
  if (flat.length < MIN_FLAT_SEGMENTS || !climbs.length) return null;

  const flatSpeed = flat.reduce((a, b) => a + b, 0) / flat.length;
  if (flatSpeed <= 0) return null;

  const ratios = [];
  for (const [grade, speed] of climbs) {
    // What the model says you should manage on this gradient for the same
    // cost as your flat running.
    const expected = flatSpeed / RC.costRatio(grade);
    if (expected > 0) ratios.push(speed / expected);
  }
  if (!ratios.length) return null;

  const factor = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return {
    factor,
    flat_speed: flatSpeed,
    climb_segments: climbs.length,
    flat_segments: flat.length,
    mean_climb_grade: climbs.reduce((a, [g]) => a + g, 0) / climbs.length,
    verdict: _climbVerdict(factor),
  };
}

function _climbVerdict(factor) {
  const percent = Math.abs(factor - 1.0) * 100.0;
  if (factor >= 1.05) {
    return 'You hold ' + _fmt0(percent) + '% more speed on the climbs than the energy model ' +
      'expects. Hills are a strength.';
  }
  if (factor <= 0.95) {
    return 'Climbs cost you ' + _fmt0(percent) + '% more than the energy model expects -- ' +
      'the flat is where your running is strongest.';
  }
  return 'You climb about as the energy model expects. No particular bias.';
}

// Average the climbing factor over several runs. -> object|null.
//
// `runs` is [climbCost result]. One hilly run is a mood; a dozen is a trait.
export function profile(runs) {
  const usable = runs.filter(r => r && r.factor);
  if (usable.length < 3) return null;
  const weight = usable.reduce((a, r) => a + r.climb_segments, 0);
  if (weight <= 0) return null;
  // Weighted by how much climbing each run actually contained, so a run with
  // two hills does not count as much as one that was uphill all day.
  const factor = usable.reduce((a, r) => a + r.factor * r.climb_segments, 0) / weight;
  return { factor, runs: usable.length, climb_segments: weight, verdict: _climbVerdict(factor) };
}
