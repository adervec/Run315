// What to carry, and when to take it.
//
// The app will tell you what pace to run a marathon at and how your engine holds
// up over three hours, and then says nothing at all about the thing that most
// often ends those three hours badly. Running out of carbohydrate is not a pacing
// error and no amount of grade-adjusted anything will save you from it.
//
// The numbers here are the published consensus ranges, not invented ones:
//
//   * Under 45 minutes: nothing needed. Muscle glycogen covers it.
//   * 45-75 minutes: small amounts, or a carbohydrate mouth rinse, which works
//     through the brain rather than the gut.
//   * 1-2.5 hours: 30-60 g of carbohydrate per hour.
//   * Beyond ~2.5 hours: up to 90 g per hour, but only using *multiple
//     transportable carbohydrates* -- glucose and fructose together, roughly 2:1.
//     Glucose transport alone saturates near 60 g/h, so a single-sugar gel taken
//     faster than that mostly sits in your stomach.
//
// That last point is the one people get wrong, and it is why the recommendation is
// a sugar mix rather than simply "more gels".
//
// Source: Jeukendrup, A Step Towards Personalized Sports Nutrition: Carbohydrate
// Intake During Exercise (Sports Medicine 44, 2014), and the joint position stand
// of the Academy of Nutrition and Dietetics, Dietitians of Canada and the ACSM
// (2016). Both are consensus documents rather than single studies.
//
// On fluid, this module deliberately gives a range and a warning rather than a
// number. Drinking to a schedule regardless of thirst is how people end up
// hyponatraemic, which is more dangerous than being a bit dehydrated and has
// killed runners in big-city marathons. Thirst is the instrument.
//
// Nothing here is medical advice, and gut tolerance is individual: 90 g/h is a
// trained capacity, not a starting point.
//
// Pure functions. No I/O, no dependencies. Port of fuelling.py; see
// test/fuelling.test.mjs.
import { pyRound } from './py.js';

// Carbohydrate, grams per hour, by how long you will be out there.
// [duration_hours_at_least, low, high, note_key]
export const CARB_BANDS = [
  [0.0, 0, 0, 'none'],
  [0.75, 0, 30, 'rinse'],
  [1.0, 30, 60, 'standard'],
  [2.5, 60, 90, 'multiple'],
];

// Beyond this, a single sugar cannot be absorbed fast enough on its own.
export const SINGLE_SUGAR_CEILING = 60;

// Fluid, millilitres per hour. A range, and the wide end is for heat.
export const FLUID_BASE = [400, 600];
export const FLUID_HOT = [500, 800];
export const HOT_C = 20.0;

// Sodium, milligrams per litre of fluid, for efforts long enough to matter.
export const SODIUM_PER_LITRE = [300, 600];
export const SODIUM_MATTERS_H = 2.0;

// Carbohydrate loading, grams per kilo per day, for races over this long.
export const LOADING_MATTERS_H = 1.5;
export const LOADING_G_PER_KG = [8, 12];

// A gel is about this much carbohydrate, which is how people actually count.
export const GEL_G = 22;

// Carbohydrate per hour for an effort of this length. -> object|null.
export function carbTarget(durationS) {
  if (!durationS || durationS <= 0) return null;
  const hours = durationS / 3600.0;
  let low = 0, high = 0, key = 'none';
  for (const [threshold, lo, hi, noteKey] of CARB_BANDS) {
    if (hours >= threshold) { low = lo; high = hi; key = noteKey; }
  }
  return {
    hours,
    per_hour_low: low,
    per_hour_high: high,
    total_low: low * hours,
    total_high: high * hours,
    needs_mixed_sugars: high > SINGLE_SUGAR_CEILING,
    note: _carbNote(key, low, high),
  };
}

function _carbNote(key, low, high) {
  const d = Math.trunc;   // '%d'
  if (key === 'none') {
    return 'Short enough that stored glycogen covers it. Carrying anything is optional.';
  }
  if (key === 'rinse') {
    return 'Around this length a carbohydrate mouth rinse works about as ' +
      'well as swallowing one -- the effect is on the brain, not the gut.';
  }
  if (key === 'standard') {
    return `${d(low)}-${d(high)} g of carbohydrate an hour. A single sugar is fine at this ` +
      'rate; the gut absorbs it without help.';
  }
  return `${d(low)}-${d(high)} g an hour, and above ${SINGLE_SUGAR_CEILING} g it has to be a glucose-and-fructose ` +
    `mix, roughly 2:1. Glucose transport saturates near ${SINGLE_SUGAR_CEILING} g/h, so ` +
    'taking more of a single-sugar gel mostly leaves it in your stomach.';
}

// Fluid per hour, as a range. -> object|null.
//
// A range on purpose. Sweat rates vary several-fold between people and this
// module knows nothing about yours.
export function fluidTarget(durationS, tempC = null) {
  if (!durationS || durationS <= 0) return null;
  const hot = tempC != null && tempC >= HOT_C;
  const [low, high] = hot ? FLUID_HOT : FLUID_BASE;
  const hours = durationS / 3600.0;
  return {
    per_hour_low: low, per_hour_high: high,
    total_low: low * hours, total_high: high * hours,
    hot,
    note: 'Drink to thirst inside this range rather than to a schedule. ' +
      'Overdrinking dilutes your blood sodium, which is more ' +
      'dangerous than mild dehydration and does put runners in ' +
      'hospital every year.',
  };
}

// Sodium, for efforts long enough for it to matter. -> object|null.
export function sodiumTarget(durationS, tempC = null) {
  if (!durationS || durationS / 3600.0 < SODIUM_MATTERS_H) return null;
  const fluid = fluidTarget(durationS, tempC);
  if (!fluid) return null;
  return {
    per_litre_low: SODIUM_PER_LITRE[0],
    per_litre_high: SODIUM_PER_LITRE[1],
    total_low: SODIUM_PER_LITRE[0] * fluid.total_low / 1000.0,
    total_high: SODIUM_PER_LITRE[1] * fluid.total_high / 1000.0,
    note: 'Most sports drinks land in this range already. It matters ' +
      'more the longer and hotter the race, and more again if you ' +
      'finish races with salt on your face.',
  };
}

// Whether a carbohydrate load is worth doing, and how much. -> object|null.
export function loading(durationS, weightKg = null) {
  if (!durationS || durationS / 3600.0 < LOADING_MATTERS_H) return null;
  const [low, high] = LOADING_G_PER_KG;
  const out = {
    g_per_kg_low: low, g_per_kg_high: high, days: 2,
    note: 'For a race this long, 36-48 hours of high-carbohydrate ' +
      'eating beforehand measurably helps. It is about eating ' +
      'more carbohydrate, not more food -- and the training taper ' +
      'is what makes room for it.',
  };
  if (weightKg) {
    out.grams_low = low * weightKg;
    out.grams_high = high * weightKg;
  }
  return out;
}

// When to take something, in minutes from the start. -> [object].
//
// Spaced evenly rather than crammed late, because the gut empties at a rate
// and a backlog does not clear once you are working hard.
export function schedule(durationS, carbsPerHour = null, gelG = GEL_G) {
  const target = carbTarget(durationS);
  if (!target || !target.per_hour_high) return [];
  const perHour = carbsPerHour || (target.per_hour_low + target.per_hour_high) / 2.0;
  if (perHour <= 0 || gelG <= 0) return [];

  const hours = durationS / 3600.0;
  const count = Math.trunc(pyRound(perHour * hours / gelG));
  if (count < 1) return [];
  // Nothing in the last ten minutes: it will not be absorbed in time.
  const usable = Math.max(durationS - 600.0, 0.0);
  if (usable <= 0) return [];
  const gap = usable / count;
  const out = [];
  for (let i = 0; i < count; i++) {
    const at = gap * (i + 1) - gap / 2.0;
    out.push({ at_s: at, at_min: at / 60.0, grams: gelG, cumulative_g: gelG * (i + 1) });
  }
  return out;
}

// Everything for one race. -> object|null.
export function plan(durationS, tempC = null, weightKg = null) {
  const carbs = carbTarget(durationS);
  if (!carbs) return null;
  return {
    duration_s: durationS,
    carbs,
    fluid: fluidTarget(durationS, tempC),
    sodium: sodiumTarget(durationS, tempC),
    loading: loading(durationS, weightKg),
    schedule: schedule(durationS),
    temp_c: tempC,
  };
}
