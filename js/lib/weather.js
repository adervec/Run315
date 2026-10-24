// What the weather did to the run.
//
// A summer easy run at the same heart rate is simply slower, and comparing it
// against a January one without saying so makes an athlete think they have lost
// fitness in a heatwave. So the pace gets corrected for the conditions before it
// gets compared to anything.
//
// The correction is built on two well-established observations:
//
//   * running slows in a roughly quadratic way once the air is above about 13 C,
//     which is where most published heat-and-pace tables put the inflection
//   * humidity matters through the heat index, not on its own -- 25 C at 30%
//     humidity and 25 C at 90% are very different runs
//
// Everything here is an approximation of a population effect. Individuals
// acclimatise at different rates and the same athlete responds differently in
// April and in August. It is a lens, not a measurement.
//
// Pure functions. No I/O, no dependencies. Port of weather.py; see
// test/weather.test.mjs.
import { daysBetween } from './dt.js';

// Below this, temperature is not what is slowing you down.
export const NEUTRAL_C = 13.0;

// Fraction slower per degree above neutral, applied quadratically. Calibrated so
// 20 C costs about 1.5%, 25 C about 4% and 30 C about 8-9%, which is where the
// published heat-and-pace tables sit.
// ponytail: one curve for everybody. An acclimatised athlete suffers far less;
// fit the coefficient per athlete once there are enough hot runs to fit it from.
export const HEAT_K = 0.0003;

// The heat index is built for perceived comfort standing still, and it amplifies
// humidity hard. Applying the pace curve to the raw index double-counts it, so
// only half the amplification is carried through.
export const HUMIDITY_WEIGHT = 0.5;

export const MAX_PENALTY = 0.15;   // a run you finished was not 25% slower
export const COLD_C = -5.0;        // below this, cold and footing start costing time too
export const COLD_K = 0.0012;

// '%.Nf' with Python's round-half-even on exact ties.
function _fmt(x, n = 0) {
  const m = 10 ** n, v = x * m;
  if (Number.isInteger(v * 2) && !Number.isInteger(v)) {
    const f = Math.floor(v);
    return ((f % 2 === 0 ? f : f + 1) / m).toFixed(n);
  }
  return x.toFixed(n);
}

// Python's float(): numbers pass, bools become 0/1, numeric strings parse,
// anything else fails (returns undefined, where Python raised).
function _float(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const s = v.trim().replace(/_/g, '');
    if (/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return Number(s);
    if (/^[+-]?(inf|infinity)$/i.test(s)) return s[0] === '-' ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(s)) return NaN;
  }
  return undefined;
}

const _isDict = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);

// Apparent temperature in Celsius, or the plain temperature if unknown.
//
// The Rothfusz regression is defined in Fahrenheit, so the conversion happens
// here rather than leaving a magic table in the caller. Below about 27 C the
// regression is not meaningful and the dry temperature is the honest answer.
export function heatIndexC(tempC, humidityPct) {
  if (tempC == null) return null;
  if (humidityPct == null) return Number(tempC);
  const humidity = Math.max(0.0, Math.min(100.0, Number(humidityPct)));
  const tF = Number(tempC) * 9.0 / 5.0 + 32.0;
  if (tF < 80.0) return Number(tempC);

  const hi = (-42.379 + 2.04901523 * tF + 10.14333127 * humidity
    - 0.22475541 * tF * humidity - 0.00683783 * tF * tF
    - 0.05481717 * humidity * humidity + 0.00122874 * tF * tF * humidity
    + 0.00085282 * tF * humidity * humidity
    - 0.00000199 * tF * tF * humidity * humidity);
  return (hi - 32.0) * 5.0 / 9.0;
}

// How much slower these conditions make you, as a fraction. 0 when benign.
//
// Dew point is the better single number for how hard it is to shed heat, so it
// wins when the watch reports it; humidity is the fallback.
export function penalty(tempC, humidityPct = null, dewPointC = null) {
  if (tempC == null) return 0.0;
  const index = heatIndexC(tempC, humidityPct);
  let felt = Number(tempC) + HUMIDITY_WEIGHT * (index - Number(tempC));
  if (dewPointC != null) {
    // Above a dew point of about 15 C sweat stops evaporating usefully, and
    // each further degree costs more than the dry temperature alone implies.
    const muggy = Math.max(0.0, Number(dewPointC) - 15.0);
    felt = Math.max(felt, Number(tempC) + muggy * 0.8);
  }

  if (felt > NEUTRAL_C) {
    const over = felt - NEUTRAL_C;
    return Math.min(MAX_PENALTY, HEAT_K * over * over);
  }
  if (felt < COLD_C) return Math.min(MAX_PENALTY, COLD_K * (COLD_C - felt));
  return 0.0;
}

// What this pace would have been in neutral conditions. Lower is better.
export function adjust(paceSPerKm, tempC, humidityPct = null, dewPointC = null) {
  if (!paceSPerKm) return null;
  return paceSPerKm / (1.0 + penalty(tempC, humidityPct, dewPointC));
}

// One line on the conditions and what they cost.
export function describe(tempC, humidityPct = null, dewPointC = null) {
  if (tempC == null) return null;
  const cost = penalty(tempC, humidityPct, dewPointC);
  const felt = heatIndexC(tempC, humidityPct);
  const bits = [_fmt(tempC) + ' C'];
  if (humidityPct != null) bits.push(_fmt(humidityPct) + '% humidity');
  if (dewPointC != null) bits.push(_fmt(dewPointC) + ' C dew point');
  if (felt != null && Math.abs(felt - tempC) >= 1.0) bits.push('feels like ' + _fmt(felt) + ' C');

  const conditions = bits.join(', ');
  if (cost < 0.005) return conditions + ' -- good conditions, no correction worth making.';
  return conditions + ' -- worth about ' + _fmt(cost * 100, 1) + '%, so your corrected pace is what matters.';
}

// Group runs by how hot they were, to show the effect over a whole year.
//
// `rows` is [[temp_c, pace_s_per_km, humidity, dew_point]]. -> [object] per band,
// coldest first, with the raw and corrected mean pace in each.
export function seasonSummary(rows) {
  const bands = [[-99.0, 5.0, 'Under 5 C'], [5.0, 13.0, '5-13 C'],
    [13.0, 20.0, '13-20 C'], [20.0, 26.0, '20-26 C'],
    [26.0, 99.0, 'Over 26 C']];
  const out = [];
  for (const [lo, hi, label] of bands) {
    const got = rows.filter(r => r && r.length && r[0] != null && r[1] && lo <= r[0] && r[0] < hi);
    if (!got.length) continue;
    const raw = got.reduce((a, r) => a + r[1], 0) / got.length;
    const corrected = got.map(r => adjust(r[1], r[0],
      r.length > 2 ? r[2] : null,
      r.length > 3 ? r[3] : null));
    out.push({
      label, runs: got.length,
      mean_pace: raw,
      mean_adjusted: corrected.reduce((a, b) => a + b, 0) / corrected.length,
      mean_temp: got.reduce((a, r) => a + r[0], 0) / got.length,
    });
  }
  return out;
}

// Garmin's activity weather blob -> the fields we care about, or null.
//
// Garmin reports Fahrenheit for accounts set to imperial units and Celsius for
// everyone else, with no flag saying which. A "temperature" of 86 is not a
// summer's day in Celsius, so the unit is inferred from the value.
export function normalise(raw) {
  if (!_isDict(raw)) return null;

  const num = (...keys) => {
    for (const key of keys) {
      const value = raw[key];
      if (value == null) continue;
      const out = _float(value);
      if (out === undefined) continue;
      return Number.isNaN(out) ? null : out;
    }
    return null;
  };

  let temp = num('temp', 'temperature', 'apparentTemp');
  let dew = num('dewPoint', 'dewpoint');
  // Nobody runs in 45 C and everyone has run in 5 C, so a high reading is F.
  if (temp !== null && temp > 45.0) {
    temp = (temp - 32.0) * 5.0 / 9.0;
    if (dew !== null) dew = (dew - 32.0) * 5.0 / 9.0;
  }

  let humidity = num('relativeHumidity', 'humidity');
  if (humidity !== null && !(0.0 <= humidity && humidity <= 100.0)) humidity = null;

  if (temp === null && humidity === null) return null;
  let conditions = null;
  if (_isDict(raw.weatherTypeDTO)) conditions = raw.weatherTypeDTO.desc ?? null;
  else if (_isDict(raw.weatherStationDTO)) conditions = raw.weatherStationDTO.desc ?? null;
  return {
    temp_c: temp,
    humidity,
    dew_point_c: dew,
    wind_kph: num('windSpeed', 'windSpeedKph'),
    conditions,
  };
}

// ---------------------------------------------------------------------------
// Heat acclimatisation
//
// Repeated exposure to running in the heat produces real, measurable adaptation:
// plasma volume expands, sweating starts earlier and more dilutely, and heart
// rate at a given effort falls. The classic protocol is 10-14 consecutive days
// of heat exposure, with most of the adaptation arriving in the first week
// (Periard, Racinais & Sawka, Scand J Med Sci Sports 2015, is the standard
// review). It also decays: roughly a quarter of the gain is lost within a week
// of stopping, and most of it within a month.
//
// What follows is a bookkeeping model, not a physiological one. It tracks how
// much heat exposure is in the recent past, decayed over time, and says where
// that puts you. It cannot measure your plasma volume, and does not pretend to.

export const ACCLIMATION_DAYS = 14;        // the window the classic protocols use
export const ACCLIMATION_HALF_LIFE = 8.0;  // days; decay is faster than the gain, as reported
export const HOT_RUN_C = 22.0;             // below this a run does not count as heat exposure
export const FULL_EXPOSURE_MIN = 45.0;     // minutes in the heat for a session to count fully
// Sessions needed for the bands. Ten to fourteen is the published protocol.
// Calibrated against the protocol rather than guessed: decay means 14 consecutive
// hot sessions bank ~8.5 units, not 14, so the top band sits there. Three
// consecutive hot days bank ~2.8, which should read as "starting", not "none".
export const ACCLIMATION_BANDS = [[0.5, 'none'], [2.0, 'starting'], [5.0, 'partial'],
  [8.0, 'most of the way']];

// How much heat training is still in the bank. -> object.
//
// `runs` is [[date, temp_c, minutes]], date a 'YYYY-MM-DD' key or a Date (its
// calendar day is used); `today` likewise. Each hot session counts for up to one
// unit, scaled by how long it lasted, then decayed by how long ago it was.
export function heatExposure(runs, today, halfLife = ACCLIMATION_HALF_LIFE) {
  if (!runs || !runs.length) {
    return { sessions: 0.0, recent: 0, band: 'none', hottest_c: null,
      note: 'No hot running on record recently.' };
  }

  let total = 0.0, recent = 0, hottest = null;
  for (const [when, tempC, minutes] of runs) {
    if (tempC == null || tempC < HOT_RUN_C) continue;
    const daysAgo = daysBetween(when, today);
    if (daysAgo < 0) continue;
    hottest = hottest === null ? tempC : Math.max(hottest, tempC);
    if (daysAgo <= ACCLIMATION_DAYS) recent += 1;
    // A longer session in the heat is worth more, up to one whole unit.
    const weight = Math.min((minutes || 0.0) / FULL_EXPOSURE_MIN, 1.0);
    total += weight * (0.5 ** (daysAgo / halfLife));
  }

  let band = 'none';
  for (const [threshold, name] of ACCLIMATION_BANDS) if (total >= threshold) band = name;
  return { sessions: total, recent, band, hottest_c: hottest, note: _acclimationNote(band, total) };
}

function _acclimationNote(band, sessions) {
  if (band === 'none') {
    return 'Nothing recent in the heat. A hot race would cost you more than ' +
      'the pace adjustment on this page suggests.';
  }
  if (band === 'starting') {
    return 'A couple of hot sessions in the bank. The first week of heat ' +
      'training is where most of the adaptation happens, so this is ' +
      'the part worth continuing.';
  }
  if (band === 'partial') {
    return 'Part-adapted: roughly ' + _fmt(sessions) + " sessions' worth of heat exposure " +
      'still counting. Another week of it would finish the job.';
  }
  return 'Well heat-adapted on paper -- around ' + _fmt(sessions) + " sessions' worth still in " +
    'the bank. It fades within a few weeks of stopping.';
}
