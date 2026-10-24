// Does your engine hold up, or does it just start well?
//
// Every other number in this app describes a runner who is fresh. Race prediction
// fits a curve to your best efforts, threshold pace is a steady-state number, and
// your training paces assume you can still hold them at the end. None of that says
// anything about hour three, which is exactly where a marathon is decided.
//
// Durability is the fourth axis of endurance, alongside VO2max, economy and
// threshold (Maunder et al., Sports Medicine 2021). The field version of it is
// *decoupling*: the drift between what your body is doing (heart rate) and what it
// is producing (grade-adjusted speed) over a long run. Early on, a given pace costs
// a given heart rate. Later, the same pace costs more. How much more, and how soon
// it starts, is the measurement.
//
// The method here follows Smyth, Maunder, Meyler, Hunter and Muniz-Pumares,
// "Decoupling of Internal and External Workload During a Marathon", Sports Medicine
// 52(9), 2022 -- an analysis of 82,303 recreational runners using exactly the data
// a GPS watch records:
//
//     internal   = mean heart rate / maximum heart rate
//     external   = mean grade-adjusted speed / critical speed
//     ratio      = internal / external
//     decoupling = ratio(late window) / ratio(early window)
//
// Both sides are expressed as a fraction of the runner's own ceiling, which is what
// makes the ratio dimensionless and comparable within an athlete.
//
// Two things matter more than the arithmetic:
//
//   * it needs a long run. Critical power does not budge after 40 or 80 minutes of
//     heavy work and only falls after 120 (Clark et al. 2019). Below the dose gate
//     there is nothing to measure, so this module returns null rather than a
//     number, because a decoupling figure off a 40-minute tempo is noise with a
//     decimal point.
//   * it is not comparable between people. Elites run at ~96% of critical speed
//     from the gun and have no room to drift, so their fade shows up as slowing
//     rather than as a rising heart rate (Takayama and Aoyagi 2025). Women decouple
//     less than men, and later (Smyth 2022; Jaen-Carrillo et al. 2026). Compare a
//     runner with themselves, and with nobody else.
//
// Critical speed comes from Smyth and Muniz-Pumares, "Calculation of Critical Speed
// from Raw Training Data in Recreational Marathon Runners", MSSE 52(12), 2020: fit
// distance = CS * time + Dprime across your own best efforts. CS is the slope,
// Dprime the intercept -- the finite distance available above it.
//
// Pure functions. No I/O, no dependencies beyond racecraft for the grade model.
// Port of durability.py; see test/durability.test.mjs.
import * as RC from './racecraft.js';

// The fitting window for critical speed. Shorter efforts are dominated by the
// anaerobic reserve, longer ones by pacing and fuelling, and both bend the line.
export const CS_MIN_S = 120.0;
export const CS_MAX_S = 900.0;
export const CS_MIN_POINTS = 3;

// Below this there is no durability signal to find (Clark et al. 2019: critical
// power was unchanged at 40 and 80 minutes of heavy exercise, and fell at 120).
export const MIN_DURATION_S = 75 * 60.0;
export const MIN_DISTANCE_M = 12000.0;

// Windows as a fraction of the run. The opening is skipped because heart rate
// takes minutes to catch up with effort, and the finish because people race the
// last part of a long run.
export const EARLY = [0.10, 0.25];
export const LATE = [0.75, 0.90];

// Smyth's bands. The 1.025 onset trigger and the 1.1/1.2 cuts are described in
// the paper itself as arbitrary -- they are conventions with a large sample
// behind them, not physiological boundaries.
export const ONSET_TRIGGER = 1.025;
export const BAND_LOW = 1.10;
export const BAND_HIGH = 1.20;

// Heat inflates decoupling and Smyth explicitly did not correct for it, so a hot
// run gets a caveat rather than an adjustment.
export const HOT_C = 20.0;

// '%.0f' with Python's round-half-even on exact ties.
function _fmt0(x) {
  if (Number.isInteger(x * 2) && !Number.isInteger(x)) {
    const f = Math.floor(x);
    return String(f % 2 === 0 ? f : f + 1);
  }
  return x.toFixed(0);
}

// Fit distance = CS * time + Dprime to your best efforts.
//
// `bests` is [[distance_m, seconds]]. -> [cs_m_s, d_prime_m] or null.
//
// Only efforts of 2-15 minutes are used. Fit quality is deliberately not
// reported: three points on a near-linear relation always fit beautifully, and
// an R-squared of 0.9999 would say nothing about whether the model is right.
export function criticalSpeed(bests) {
  const points = [];
  for (const [d, s] of bests) {
    if (d && s && CS_MIN_S <= s && s <= CS_MAX_S) points.push([Number(s), Number(d)]);
  }
  if (points.length < CS_MIN_POINTS) return null;

  const n = points.length;
  let sumT = 0, sumD = 0, sumTT = 0, sumTD = 0;
  for (const [t, d] of points) { sumT += t; sumD += d; sumTT += t * t; sumTD += t * d; }
  const denom = n * sumTT - sumT * sumT;
  if (denom <= 0) return null;

  const cs = (n * sumTD - sumT * sumD) / denom;
  const dPrime = (sumD - cs * sumT) / n;
  // A negative reserve, or a critical speed slower than a walk, means these
  // efforts did not come from the same athlete having the same kind of day.
  if (cs <= 1.0 || dPrime < 0) return null;
  return [cs, dPrime];
}

// Rise over run between two samples, as a fraction.
function _grade(previous, current) {
  const run = current[1] - previous[1];
  if (run <= 0 || previous[5] == null || current[5] == null) return 0.0;
  const grade = (current[5] - previous[5]) / run;
  return Math.max(-0.45, Math.min(0.45, grade));
}

// Split a stream into [early, late] sample lists by distance covered.
function _windows(samples) {
  const total = samples[samples.length - 1][1] - samples[0][1];
  if (total <= 0) return [null, null];
  const start = samples[0][1];
  const sliceAt = (lo, hi) => samples.filter(s => {
    const f = (s[1] - start) / total;
    return lo <= f && f <= hi;
  });
  return [sliceAt(...EARLY), sliceAt(...LATE)];
}

// Smyth's internal:external ratio for one window of samples. -> number|null.
//
// Grade-adjusted speed is computed per sample pair and averaged over time, so a
// long flat stretch counts for more than a brief climb.
function _ratio(window, hrMax, cs) {
  if (window.length < 2) return null;

  let hrSum = 0.0, hrSeconds = 0.0, speedSum = 0.0, speedSeconds = 0.0;
  for (let i = 1; i < window.length; i++) {
    const previous = window[i - 1], current = window[i];
    const dt = current[0] - previous[0];
    const dd = current[1] - previous[1];
    if (dt <= 0 || dd < 0) continue;
    if (current[2]) {
      hrSum += current[2] * dt;
      hrSeconds += dt;
    }
    if (dd > 0) {
      // Convert to the equivalent flat speed, so a hilly late window is not
      // mistaken for fatigue.
      const pace = dt / (dd / 1000.0);
      const flatPace = RC.gradeAdjustedPace(pace, _grade(previous, current));
      if (flatPace > 0) {
        speedSum += (1000.0 / flatPace) * dt;
        speedSeconds += dt;
      }
    }
  }

  if (hrSeconds <= 0 || speedSeconds <= 0) return null;
  const internal = (hrSum / hrSeconds) / hrMax;
  const external = (speedSum / speedSeconds) / cs;
  if (external <= 0) return null;
  return internal / external;
}

// Where the drift starts and does not come back. -> metres from the start.
//
// Walks a rolling window forwards and takes the first point past the trigger
// that stays past it. A single hill can push one window over; a real onset does
// not recover.
function _onset(samples, hrMax, cs, earlyRatio) {
  if (!earlyRatio) return null;
  const total = samples[samples.length - 1][1] - samples[0][1];
  const start = samples[0][1];
  const step = Math.max(total / 20.0, 500.0);

  const crossings = [];
  let at = start + total * EARLY[1];
  while (at < start + total) {
    const window = samples.filter(s => at <= s[1] && s[1] <= at + step);
    const ratio = _ratio(window, hrMax, cs);
    if (ratio) crossings.push([at - start, ratio / earlyRatio]);
    at += step;
  }

  let onset = null;
  for (const [distance, drift] of crossings) {
    if (drift > ONSET_TRIGGER) {
      if (onset === null) onset = distance;
    } else {
      onset = null;       // came back down: not the onset after all
    }
  }
  return onset;
}

// Smyth's three groups. Lower is more durable.
export function band(value) {
  if (value == null) return null;
  if (value < BAND_LOW) return 'low';
  if (value < BAND_HIGH) return 'moderate';
  return 'high';
}

// The run's average speed as a fraction of critical speed.
function _meanIntensity(samples, cs) {
  const duration = samples[samples.length - 1][0] - samples[0][0];
  const distance = samples[samples.length - 1][1] - samples[0][1];
  if (duration <= 0 || cs <= 0) return null;
  return (distance / duration) / cs;
}

// One sentence, in the runner's terms.
function _verdict(value, intensity) {
  const percent = (value - 1.0) * 100.0;
  let head;
  if (value < BAND_LOW) {
    head = 'Your heart rate held its pace to the end -- ' + _fmt0(percent) + '% drift, which ' +
      'is the durable end of the range.';
  } else if (value < BAND_HIGH) {
    head = _fmt0(percent) + '% drift between the start and the end: the ordinary amount ' +
      'of fade for a long run.';
  } else {
    head = _fmt0(percent) + '% drift -- the same pace cost markedly more by the end than ' +
      'it did at the start.';
  }
  if (intensity && intensity > 0.90) {
    head += ' You were running at ' + _fmt0(intensity * 100) + '% of critical speed, quicker than a ' +
      'long run usually goes, so some of this is the pace.';
  }
  return head;
}

// Decoupling over one long run. -> object, or null if the run cannot answer.
//
// `samples` is the 10-wide stream tuple: [seconds, metres, hr, lat, lon,
// elevation_m, cadence, stride, gct, vertical_oscillation].
export function analyse(samples, hrMax, cs, temperatureC = null) {
  if (!samples || samples.length < 20 || !hrMax || !cs) return null;
  const duration = samples[samples.length - 1][0] - samples[0][0];
  const distance = samples[samples.length - 1][1] - samples[0][1];
  if (duration < MIN_DURATION_S || distance < MIN_DISTANCE_M) return null;

  const [earlySamples, lateSamples] = _windows(samples);
  if (!earlySamples || !earlySamples.length || !lateSamples || !lateSamples.length) return null;
  const early = _ratio(earlySamples, hrMax, cs);
  const late = _ratio(lateSamples, hrMax, cs);
  if (!early || !late) return null;

  const value = late / early;
  const intensity = _meanIntensity(samples, cs);
  return {
    decoupling: value,
    band: band(value),
    onset_m: _onset(samples, hrMax, cs, early),
    early_ratio: early,
    late_ratio: late,
    duration_s: duration,
    distance_m: distance,
    intensity,
    hot: Boolean(temperatureC != null && temperatureC >= HOT_C),
    temperature_c: temperatureC,
    verdict: _verdict(value, intensity),
  };
}

// Decoupling over time on comparable runs. -> object, or null.
//
// `runs` is [[date, analysis]], oldest first. Only runs within a fifth of
// the longest are compared, because durability measured over 80 minutes and
// over three hours are not the same measurement. Hunter et al. (2025) lay the
// standardisation problem out and decline to solve it; this is the conservative
// reading of it.
export function trend(runs) {
  const usable = runs.filter(([, a]) => a && a.decoupling);
  if (usable.length < 3) return null;

  const longest = Math.max(...usable.map(([, a]) => a.duration_s));
  const comparable = usable.filter(([, a]) => a.duration_s >= longest * 0.80);
  if (comparable.length < 3) return null;

  const half = Math.floor(comparable.length / 2);
  const mean = xs => xs.reduce((s, [, a]) => s + a.decoupling, 0) / half;
  const early = mean(comparable.slice(0, half));
  const late = mean(comparable.slice(comparable.length - half));
  const change = late - early;
  let note;
  if (change < -0.03) note = 'You are holding together better over distance than you were.';
  else if (change > 0.03) note = 'You are fading more over distance than you were.';
  else note = 'Your durability is level across this block.';
  return {
    runs: comparable.length, early, late, change, note,
    best: Math.min(...comparable.map(([, a]) => a.decoupling)),
  };
}
