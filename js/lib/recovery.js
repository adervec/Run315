// Overnight recovery: what the night before says about today.
//
// fitness.js measures the training you did. This measures what it cost you, and
// those are different questions. Two athletes can carry the same CTL and the same
// negative TSB while one is absorbing the block and the other is quietly coming
// apart. The difference shows up overnight -- in heart-rate variability, resting
// heart rate and sleep -- hours before it shows up in a session.
//
// Everything here is relative. An HRV of 45 ms means nothing in the abstract and
// everything against your own usual 60: HRV varies more between people than any
// other number a watch records, so a population reference would be worse than no
// reference at all. Every metric is therefore read as standard deviations from the
// athlete's own rolling baseline, and where there is not enough history to have a
// baseline, the answer is null rather than an invented one.
//
// What comes out is a traffic light, not a measurement. A readiness score of 71 is
// not meaningfully different from 68; what is meaningful is whether you are in the
// green, the amber or the red, and whether you have been there one day or five. A
// single low morning is noise -- a late meal, a warm room, a glass of wine. The run
// of days is the signal, which is what trend() is for.
//
// None of this is a health judgement. It reads training signals and says how the
// training might go.
//
// Pure functions. No I/O, no dependencies. See test/recovery.test.mjs.

// Python 3.12+ sum() of floats is Neumaier-compensated, not a naive running total.
// Ported tests can hinge on the last bit (exact ties between |r| values), so match it.
function pySum(xs) {
  let s = 0.0, c = 0.0;
  for (const x of xs) {
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? (s - t) + x : (x - t) + s;
    s = t;
  }
  return c && Number.isFinite(c) ? s + c : s;
}

// The baseline window. Sixty days is long enough to swallow one bad week and
// short enough to follow a real change -- baselines drift with fitness, altitude,
// a new job -- and a fortnight of readings is the least that gives a spread worth
// dividing by. Below that the standard deviation is mostly the sensor.
export const BASELINE_DAYS = 60;
export const MIN_BASELINE_SAMPLES = 14;

// A flat history has no spread to divide by, so the sd is floored at this
// fraction of the mean and the result is capped. See zScore().
export const FLAT_SD_FRACTION = 0.01;
export const MAX_Z = 4.0;

// HRV bands, in standard deviations from the athlete's own mean.
export const HRV_HIGH_Z = 1.0;
export const HRV_LOW_Z = -1.0;
export const HRV_VERY_LOW_Z = -2.0;

export const TREND_DAYS = 7;
export const MIN_TREND_SAMPLES = 3;
export const TREND_PCT_PER_DAY = 0.5;    // under half a percent a day is inside the noise

// --------------------------------------------------------------------------- //
// helpers
// --------------------------------------------------------------------------- //
// Python's float(): numbers and bools pass, numeric strings parse, anything else NaN.
function toFloat(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return +v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (/^[+-]?(inf|infinity)$/.test(s)) return s[0] === '-' ? -Infinity : Infinity;
    return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(s) ? Number(s) : NaN;
  }
  return NaN;
}

// Number, or null for missing, non-numeric and NaN readings.
function _num(value) {
  if (value == null) return null;
  const v = toFloat(value);
  return Number.isNaN(v) ? null : v;
}

// The real numbers in a series, in order. Missing nights simply vanish.
const _usable = values => (values || []).map(_num).filter(v => v !== null);

const _clamp = (value, lo = 0.0, hi = 100.0) => Math.max(lo, Math.min(hi, value));

// Python dict truthiness: null and {} are both false.
const truthy = o => !!o && Object.keys(o).length > 0;

// --------------------------------------------------------------------------- //
// the personal baseline
// --------------------------------------------------------------------------- //
// Rolling personal baseline for one nightly metric. -> {mean, sd, n} or null.
//
// `values` is one reading per day, oldest first, with null for the nights the
// watch spent on the charger. The window is counted in days rather than in
// readings, so a fortnight of missed nights shortens the baseline instead of
// silently reaching back two months for material to fill it with.
//
// null when there is not enough history. A mean over four mornings is not a
// baseline and a standard deviation over four mornings is noise wearing a
// range's clothes; handing either to the caller would produce a confident
// verdict that moves fifteen percent the next time a reading lands.
//
// Population sd, not sample sd: this is the spread of the nights that actually
// happened, not an estimate of some wider population's.
export function baseline(values, days = BASELINE_DAYS, minSamples = MIN_BASELINE_SAMPLES) {
  const window = _usable([...(values || [])].slice(-days));
  if (window.length < minSamples) return null;
  const mean = pySum(window) / window.length;
  const variance = pySum(window.map((v) => (v - mean) ** 2)) / window.length;
  return { mean, sd: Math.sqrt(variance), n: window.length };
}

// How far today sits from the personal baseline, in standard deviations.
//
// null if either side is missing -- there is no answer to "how unusual is
// this" without a usual.
//
// A perfectly flat history has an sd of zero: a resting heart rate that has
// read 48 every morning for a month is common enough, because the watch
// reports whole beats. Dividing by that would turn one beat of difference into
// infinity. The sd is floored at a small fraction of the mean instead, which
// keeps the sign and the ordering honest, and the result is capped at MAX_Z so
// a flat history produces a strong reading rather than an absurd one.
export function zScore(value, base) {
  const v = _num(value);
  if (v === null || !truthy(base)) return null;
  const mean = _num(base.mean);
  if (mean === null) return null;
  const spread = Math.max(_num(base.sd) || 0.0, FLAT_SD_FRACTION * Math.abs(mean));
  if (spread <= 0) {
    // A baseline of zeros with no spread: nothing to measure against.
    return v === mean ? 0.0 : Math.sign(v - mean) * MAX_Z;
  }
  return _clamp((v - mean) / spread, -MAX_Z, MAX_Z);
}

// Today's HRV against the athlete's own range. -> string or null.
//
//   balanced   inside the usual night-to-night spread
//   low        a standard deviation or more below it
//   very_low   two or more below: the range that travels with a block gone
//              too far, or simply with a wretched night
//   high       a standard deviation or more above
//
// One low morning is noise. HRV swings with a late meal, alcohol, a warm room
// and where you are in the training week, and the honest reading of a single
// low morning is "look again tomorrow". Three or four in a row is a different
// statement altogether, and that is the one worth acting on -- trend() makes
// it, this does not.
//
// `high` is the least interesting of the four: usually a genuinely restful
// night, occasionally the rebound after a very hard day, and one number cannot
// tell those apart.
//
// null without a baseline. An HRV of 45 with no history behind it is a number,
// not a status.
export function hrvStatus(today, base) {
  const z = zScore(today, base);
  if (z === null) return null;
  if (z >= HRV_HIGH_Z) return 'high';
  if (z > HRV_LOW_Z) return 'balanced';
  if (z > HRV_VERY_LOW_Z) return 'low';
  return 'very_low';
}

// Is a metric drifting up, down or flat? -> 'up' / 'down' / 'flat' / null.
//
// A least-squares slope through the recent days, expressed as a percentage of
// the window's own mean per day. Normalising like that is what lets one
// threshold serve HRV in milliseconds, resting heart rate in beats and sleep
// in hours; anything under TREND_PCT_PER_DAY -- about three percent across a
// week -- is called flat, because it is inside the noise of all three sensors.
//
// Direction only, and deliberately: three low HRV mornings in a row mean
// something a single low morning does not, and that is the whole reason this
// exists. Which direction is the good one depends on the metric, so the caller
// decides: HRV drifting down is a warning, resting heart rate drifting down is
// the opposite.
//
// Missing nights keep their place in the window rather than closing the gap,
// so a reading either side of a three-day hole does not read as a steep slope.
//
// null with fewer than MIN_TREND_SAMPLES readings in the window.
//
// ponytail: returns the sign, not the slope. Return the number alongside it
// when the dashboard wants to draw how steep the arrow is.
export function trend(values, window = TREND_DAYS) {
  const raw = [...(values || [])].slice(-window);
  const pts = [];
  raw.forEach((x, i) => { const v = _num(x); if (v !== null) pts.push([i, v]); });
  if (pts.length < MIN_TREND_SAMPLES) return null;

  const n = pts.length;
  const mx = pySum(pts.map(([x]) => x)) / n;
  const my = pySum(pts.map(([, y]) => y)) / n;
  const den = pySum(pts.map(([x]) => (x - mx) ** 2));
  if (den <= 0 || my === 0) return 'flat';
  const slope = pySum(pts.map(([x, y]) => (x - mx) * (y - my))) / den;
  const pct = 100.0 * slope / Math.abs(my);
  if (pct >= TREND_PCT_PER_DAY) return 'up';
  if (pct <= -TREND_PCT_PER_DAY) return 'down';
  return 'flat';
}

// --------------------------------------------------------------------------- //
// readiness
// --------------------------------------------------------------------------- //
// What each input is worth. The weights are renormalised over whatever actually
// arrived, so a call carrying nothing but TSB still spans the full 0-100.
//
// HRV leads because it is the most direct read on where the autonomic nervous
// system settled overnight, and because it moves first -- before resting heart
// rate, and days before a session feels wrong. It does not lead by more than
// this because it is also the noisiest of the four night to night.
//
// Sleep is next. It is the input the athlete can actually do something about
// tonight, and a short night predicts a bad session about as well as anything
// else here does.
//
// Resting heart rate tells much the same story as HRV -- the same system, read a
// blunter way -- so weighting the two equally would be counting one signal
// twice. It is also quantised to whole beats, which makes it coarse.
//
// TSB comes last on purpose. It is the plan's opinion of your fatigue, computed
// from the sessions you fed it, not a measurement of you: an athlete in the
// middle of a build is *meant* to be at -20, and that is not a reason to skip
// the session. It anchors the score when nothing else is available, and it is
// not allowed to outvote the body when something is.
//
// ponytail: fixed weights, one set for everybody. The upgrade path is to fit
// them per athlete against how the sessions actually went -- which needs a year
// of labelled days nobody has yet.
export const WEIGHTS = { hrv: 0.35, sleep: 0.25, rhr: 0.20, tsb: 0.20 };

export const HRV_PER_SD = 20.0;       // one sd below your own normal costs twenty points
export const HRV_CEILING = 90.0;      // a high morning is good news, not a perfect score
export const RHR_PER_SD = 15.0;       // gentler: RHR is whole beats, so its sd is small and
                                      // its z-score swings hard on a single beat

export const SLEEP_SHORT_H = 5.0, SLEEP_GOOD_H = 8.0;
export const SLEEP_SHORT_SCORE = 20.0, SLEEP_GOOD_SCORE = 85.0;

export const TSB_PER_POINT = 1.5;
export const TSB_CEILING = 85.0;      // being rested is not the same as being fit

// Coverage: how much of the total weight the inputs actually accounted for.
export const CONFIDENT_WEIGHT = 0.70;
export const FAIR_WEIGHT = 0.45;

// Score floor, machine-readable band, and the phrase a human would use.
export const BANDS = [
  [80.0, 'primed', 'fresh and ready'],
  [62.0, 'ready', 'ready to train'],
  [45.0, 'steady', 'trainable, not sharp'],
  [30.0, 'strained', 'carrying fatigue'],
  [0.0, 'depleted', 'dug out'],
];

export const INPUT_LABELS = {
  hrv: 'HRV', rhr: 'resting heart rate', sleep_hours: 'sleep length',
  sleep_score: 'sleep quality', tsb: 'training load',
};

// 0-100 for the length of a night. -> number or null.
//
// The one place in this module that is not relative to the athlete. HRV is
// meaningless without your own baseline; six hours is short for everybody. So
// this is an absolute band -- linear from SLEEP_SHORT_H to SLEEP_GOOD_H and
// clamped either side, because eleven hours in bed does not leave you more
// ready than nine did.
//
// ponytail: absolute band, no personal history. Blend in a sleep baseline once
// there are enough nights of it to be worth trusting.
export function sleepHoursScore(hours) {
  const h = _num(hours);
  if (h === null) return null;
  const frac = (h - SLEEP_SHORT_H) / (SLEEP_GOOD_H - SLEEP_SHORT_H);
  return _clamp(SLEEP_SHORT_SCORE + frac * (SLEEP_GOOD_SCORE - SLEEP_SHORT_SCORE), 10.0, 90.0);
}

// 0-100 for training stress balance: the plan's view of freshness.
// Roughly +20 TSB reads as tapered and -20 as deep in a block. The top is
// capped: a TSB of +40 means you have stopped training, which is restfulness
// rather than readiness.
export function tsbScore(tsb) {
  const t = _num(tsb);
  if (t === null) return null;
  return _clamp(50.0 + t * TSB_PER_POINT, 0.0, TSB_CEILING);
}

// Score -> [band, short verdict phrase].
export function band(score) {
  for (const [floor, name, phrase] of BANDS) {
    if (score >= floor) return [name, phrase];
  }
  const last = BANDS[BANDS.length - 1];
  return [last[1], last[2]];
}

// Everything the night knows, in one number. -> object or null.
//
// Takes one options object with the Python keyword names:
// {hrv, rhr, sleep_hours, sleep_score, tsb, baselines}.
//
// `baselines` is {hrv: ..., rhr: ...} of baseline() results. The two heart
// measures are scored against them and are skipped entirely when the matching
// baseline is missing, because an HRV of 45 with no history behind it says
// nothing at all. Sleep and TSB carry their own meaning and need no history.
//
// Every input that arrives contributes its weight and the weights are then
// renormalised over what was used, so the score always spans 0-100: with TSB
// alone it still answers, with everything it answers better. `used` names the
// inputs that made it in, so a caller can honestly say "based on HRV and
// sleep", and `confidence` says how much of the picture they covered.
//
// Where both sleep numbers arrive, the watch's own sleep score wins and the
// raw hours sit it out -- the score already has duration inside it, and
// averaging the two would count the same night twice.
//
// null when nothing usable arrived. Returning 50 for an empty morning would
// look exactly like a measurement, and be one.
export function readiness({ hrv = null, rhr = null, sleep_hours = null, sleep_score = null,
  tsb = null, baselines = null } = {}) {
  baselines = baselines || {};
  const parts = {}, used = [];

  const hrvZ = zScore(hrv, baselines.hrv);
  if (hrvZ !== null) {
    parts.hrv = {
      score: _clamp(50.0 + hrvZ * HRV_PER_SD, 0.0, HRV_CEILING),
      z: hrvZ, value: _num(hrv),
      status: hrvStatus(hrv, baselines.hrv),
    };
    used.push('hrv');
  }

  const rhrZ = zScore(rhr, baselines.rhr);
  if (rhrZ !== null) {
    // Inverted: a resting heart rate above your own normal is the bad way.
    parts.rhr = { score: _clamp(50.0 - rhrZ * RHR_PER_SD), z: rhrZ, value: _num(rhr) };
    used.push('rhr');
  }

  const watchSleep = _num(sleep_score);
  if (watchSleep !== null) {
    parts.sleep = { score: _clamp(watchSleep), value: watchSleep, source: 'sleep_score' };
    used.push('sleep_score');
  } else {
    const hours = sleepHoursScore(sleep_hours);
    if (hours !== null) {
      parts.sleep = { score: hours, value: _num(sleep_hours), source: 'sleep_hours' };
      used.push('sleep_hours');
    }
  }

  const freshness = tsbScore(tsb);
  if (freshness !== null) {
    parts.tsb = { score: freshness, value: _num(tsb) };
    used.push('tsb');
  }

  const keys = Object.keys(parts);
  if (!keys.length) return null;

  const coverage = pySum(keys.map((k) => WEIGHTS[k]));
  const score = pySum(keys.map((k) => parts[k].score * WEIGHTS[k])) / coverage;
  for (const k of keys) parts[k].weight = WEIGHTS[k] / coverage;

  const [name, phrase] = band(score);
  const confidence = coverage >= CONFIDENT_WEIGHT ? 'high'
    : coverage >= FAIR_WEIGHT ? 'medium' : 'low';
  return {
    score,
    band: name,
    verdict: phrase,
    used,
    coverage,
    confidence,
    components: parts,
    hrv_status: parts.hrv ? (parts.hrv.status ?? null) : null,
  };
}

// --------------------------------------------------------------------------- //
// what to do about it
// --------------------------------------------------------------------------- //
// band -> planned_hard -> what to do. (Python keyed this on a (band, planned_hard)
// tuple; here it is ADVICE[band][true|false].) Every one of these is a sentence
// about the session, never about the athlete's health.
export const ADVICE = {
  primed: {
    true: 'Everything is at or above your own normal, so run the hard '
      + 'session as planned and spend it properly.',
    false: 'You are fresher than usual. Nothing needs changing, though '
      + 'this is a good morning to pull a hard session forward if one '
      + 'is due later in the week.',
  },
  ready: {
    true: 'Nothing here argues against the hard session. Run it as '
      + 'planned and judge it on the first rep.',
    false: 'Train as planned.',
  },
  steady: {
    true: 'A middling morning. Do the session, but warm up properly and '
      + 'be willing to drop the last rep or two rather than grind them '
      + 'out.',
    false: 'Train as planned, and keep the easy running properly easy.',
  },
  strained: {
    true: 'Today reads low, so take the easy version of the session '
      + '-- fewer reps, or the same reps a shade slower -- rather '
      + 'than forcing the planned one.',
    false: 'Today reads low. An easy hour, or a short one; nothing '
      + 'that needs recovering from tomorrow.',
  },
  depleted: {
    true: 'This is a morning to move the hard session rather than '
      + 'survive it. Easy running or nothing at all today, and take '
      + 'the session again once the numbers come back.',
    false: 'Take the day off, or walk. One low morning is noise, but '
      + 'this is low enough that a day costs you nothing and buys '
      + 'you the week.',
  },
};

// Only attached to the bottom two bands, and only when a body signal put them
// there: a low score built from TSB alone means the training did it, which is
// what training is for. Phrased as a pointer rather than a worry, and it names no
// cause because this module can see none.
export const REFERRAL = 'Several mornings like this with no hard training behind them are worth '
  + 'raising with a coach or a doctor; this score reads training signals, '
  + 'not health.';
export const BODY_INPUTS = ['hrv', 'rhr', 'sleep_hours', 'sleep_score'];

// 'HRV, sleep quality and training load' -- what the score was built from.
function _inputsPhrase(used) {
  const names = (used || []).map(u => INPUT_LABELS[u] ?? u);
  if (!names.length) return 'nothing';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// One thing to do with today, in a sentence or two. -> string.
//
// Concrete and non-alarmist. The worst thing this could do is tell a healthy
// athlete that something is wrong with them, so it talks about the session and
// nothing else: no illness, no diagnosis, no physiology it cannot see. A run of
// low mornings with no training to explain it is worth taking to a person, and
// the bottom two bands say so -- without naming a cause, and only when it was
// an overnight number rather than the training log that put them there.
//
// `plannedHard` changes the answer, because the decision is the whole point of
// the score. An amber morning is a perfectly good day for an easy hour and a
// poor day for a threshold session, and one sentence cannot cover both.
export function advice(result, plannedHard = false) {
  if (!truthy(result)) {
    return 'No overnight data for today, so there is nothing here to weigh. '
      + 'Train as planned and go on feel.';
  }

  const name = result.band;
  const used = result.used || [];
  const hard = String(!!plannedHard);
  const body = (Object.hasOwn(ADVICE, name) && ADVICE[name][hard]) || ADVICE.steady[hard];

  let tail = `Based on ${_inputsPhrase(used)}.`;
  if (result.confidence === 'low') tail += ' That is thin evidence, so let the warm-up have the final say.';
  if ((name === 'strained' || name === 'depleted') && used.some(u => BODY_INPUTS.includes(u))) {
    tail += ' ' + REFERRAL;
  }
  return `${body} ${tail}`;
}
