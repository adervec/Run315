// Two estimates disagreeing is information. One estimate alone is not.
//
// This app infers a threshold heart rate from the 95th percentile of your hard
// running, and projects race times from a power law fitted to your best efforts.
// Both are estimates. So are Garmin's, which are computed by an entirely different
// method (Firstbeat's, from the heart-rate/speed relationship) on the same runs.
//
// Where two independent methods agree, the number is probably close. Where they
// disagree, one of them is wrong and you should know which questions to ask. That
// is worth more than either figure presented alone with a confident font.
//
// Neither side is ground truth, and this module does not pretend otherwise:
//
//   * Garmin's lactate threshold detection moved from a chest-strap protocol using
//     HRV-derived respiration to automatic detection from optical wrist heart rate
//     in late 2024. Independent validation of the wrist-based era is thin, and the
//     Fenix 7 was measured underestimating threshold pace by about 12%.
//   * Garmin's VO2max carries a MAPE around 5-8% with a chest strap and degrades at
//     both ends of the fitness range. This app deliberately computes no VO2max of
//     its own, because a heart-rate-derived one adds no information beyond the
//     heart-rate/pace relationship it came from -- it just adds a familiar unit and
//     a false precision.
//
// So the comparisons below are framed as agreement or disagreement, never as
// "Garmin says you are wrong".
//
// Pure functions. No I/O, no dependencies. See test/secondopinion.test.mjs.

// How close two estimates have to be before it is not worth mentioning.
export const HR_CLOSE_BPM = 5.0;
export const HR_FAR_BPM = 12.0;
export const PACE_CLOSE = 0.03;          // 3% of pace
export const PACE_FAR = 0.08;
export const TIME_CLOSE = 0.02;          // 2% of a race time
export const TIME_FAR = 0.06;

// -> 'agree' | 'near' | 'differ'.
export function _band(difference, close, far) {
  const size = Math.abs(difference);
  if (size <= close) return 'agree';
  if (size <= far) return 'near';
  return 'differ';
}

// Compare two threshold heart-rate estimates. -> object|null.
//
// `ours` is this app's inferred value, `theirs` Garmin's measured one.
export function thresholdHr(ours, theirs) {
  if (!ours || !theirs) return null;
  const difference = ours - theirs;
  const band = _band(difference, HR_CLOSE_BPM, HR_FAR_BPM);
  const beats = Math.abs(difference).toFixed(0);
  let note;
  if (band === 'agree') {
    note = 'Both methods put your threshold within a few beats of the same ' +
      'place, which is about as much agreement as either can offer.';
  } else if (difference > 0) {
    note = `This app reads your threshold ${beats} beats higher than Garmin ` +
      "does. If your zones feel too hard, Garmin's is the more " +
      'conservative number to train off.';
  } else {
    note = `This app reads your threshold ${beats} beats lower than Garmin ` +
      'does. If your easy runs feel too easy, that gap is why.';
  }
  return { ours, theirs, difference, band, note };
}

// Compare two threshold pace estimates. -> object|null.
export function thresholdPace(oursSPerKm, theirsSPerKm) {
  if (!oursSPerKm || !theirsSPerKm) return null;
  const relative = (oursSPerKm - theirsSPerKm) / theirsSPerKm;
  return { ours: oursSPerKm, theirs: theirsSPerKm,
    difference_s: oursSPerKm - theirsSPerKm,
    relative,
    band: _band(relative, PACE_CLOSE, PACE_FAR) };
}

// Compare race projections distance by distance. -> [object].
//
// Both arguments are {distance_m: seconds} (plain objects, so keys are strings;
// distance_m comes back as a number). Only distances present in both are
// compared, because a missing projection is not a disagreement.
export function races(ours, theirs) {
  ours = ours || {};
  theirs = theirs || {};
  const shared = Object.keys(ours).filter(k => Object.hasOwn(theirs, k))
    .sort((a, b) => Number(a) - Number(b));
  const out = [];
  for (const key of shared) {
    const mine = ours[key], garmin = theirs[key];
    if (!mine || !garmin) continue;
    const relative = (mine - garmin) / garmin;
    out.push({
      distance_m: Number(key),
      ours: mine,
      theirs: garmin,
      difference_s: mine - garmin,
      relative,
      band: _band(relative, TIME_CLOSE, TIME_FAR),
    });
  }
  return out;
}

// One sentence about the whole set of race projections. -> string|null.
//
// A consistent bias across every distance means something different from
// scatter, so the wording distinguishes them.
export function raceSummary(comparisons) {
  if (!comparisons || !comparisons.length) return null;
  const relatives = comparisons.map(c => c.relative);
  const mean = relatives.reduce((s, r) => s + r, 0) / relatives.length;
  const optimistic = relatives.filter(r => r < -TIME_CLOSE).length;
  const pessimistic = relatives.filter(r => r > TIME_CLOSE).length;
  const total = relatives.length;
  const pct = Math.abs(mean * 100).toFixed(1);

  if (Math.abs(mean) <= TIME_CLOSE && !optimistic && !pessimistic) {
    return 'Both models land within a couple of per cent at every distance. ' +
      'That is the good case: two different methods, one answer.';
  }
  if (optimistic === total) {
    return `This app is quicker than Garmin at every distance, by ${pct}% on ` +
      'average. A consistent offset like that usually means the two ' +
      'disagree about your threshold rather than about any one race.';
  }
  if (pessimistic === total) {
    return `This app is slower than Garmin at every distance, by ${pct}% on ` +
      'average. Garmin leans optimistic for runners whose long-distance ' +
      'work is thin, so check the longer projections against a real ' +
      'race before trusting them.';
  }
  return 'The two models agree at some distances and not others, which points ' +
    'at the shape of the curve rather than at its level -- the fitted ' +
    'fade exponent is where to look.';
}

// Everything comparable, in one call. -> object.
//
// `ours` and `theirs` are objects with any of: threshold_hr, threshold_pace,
// races. Missing pieces simply do not appear.
export function review(ours, theirs) {
  ours = ours || {};
  theirs = theirs || {};
  const raceRows = races(ours.races, theirs.races);
  const result = {
    threshold_hr: thresholdHr(ours.threshold_hr, theirs.threshold_hr),
    threshold_pace: thresholdPace(ours.threshold_pace, theirs.threshold_pace),
    races: raceRows,
    race_summary: raceSummary(raceRows),
  };
  const keys = ['threshold_hr', 'threshold_pace'];
  result.comparisons = keys.filter(k => result[k]).length + raceRows.length;
  result.disagreements = keys.filter(k => result[k] && result[k].band === 'differ').length +
    raceRows.filter(r => r.band === 'differ').length;
  return result;
}
