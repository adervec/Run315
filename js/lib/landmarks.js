// What 2,700 metres of climbing actually looks like.
//
// Cumulative ascent is the least legible number in running. Nobody has an
// intuition for what 2,700 m means, and the usual presentation -- a total, in a
// box, next to a distance -- does nothing to build one.
//
// Korea's Runday maps stair-climbing onto world landmark buildings, which is the
// right idea in the wrong sport: the useful move is to turn a number nobody can
// picture into a thing everybody can. "You have climbed three and a half Eiffel
// Towers this month" is a better answer than 1,150 m, and it is the same fact.
//
// Heights are structural, to the architectural top rather than the tip of an
// aerial, because that is the figure people picture. The natural features are
// prominence above sea level. Both are stable, published numbers that will not
// need maintaining.
//
// Pure functions. No I/O, no dependencies. See test/landmarks.test.mjs.

// [name, metres, where]. Ordered small to large; the picker relies on it.
export const LANDMARKS = [
  ['the Statue of Liberty', 93, 'New York'],
  ['Big Ben', 96, 'London'],
  ["Nelson's Column", 52, 'London'],
  ['the Great Pyramid', 139, 'Giza'],
  ['the Washington Monument', 169, 'Washington DC'],
  ['the Golden Gate Bridge towers', 227, 'San Francisco'],
  ['the Eiffel Tower', 300, 'Paris'],
  ['the Chrysler Building', 319, 'New York'],
  ['the Empire State Building', 381, 'New York'],
  ['the Shard', 310, 'London'],
  ['One World Trade Center', 541, 'New York'],
  ['the CN Tower', 553, 'Toronto'],
  ['the Burj Khalifa', 828, 'Dubai'],
  ['Table Mountain', 1085, 'Cape Town'],
  ['Ben Nevis', 1345, 'Scotland'],
  ['Snowdon', 1085, 'Wales'],
  ['Mount Fuji', 3776, 'Japan'],
  ['the Matterhorn', 4478, 'the Alps'],
  ['Mont Blanc', 4808, 'the Alps'],
  ['Denali', 6190, 'Alaska'],
  ['Everest', 8849, 'the Himalaya'],
];

// How many repeats of a landmark still mean something. Past this the comparison
// stops being a picture and turns back into a number.
export const MAX_REPEATS = 12.0;
export const MIN_REPEATS = 1.0;

// The landmark that best pictures this much climbing. -> object|null.
//
// Picks the largest landmark you have climbed at least once, so the count stays
// small and imaginable. Below the smallest landmark there is nothing useful to
// say, and null is the honest answer.
export function compare(ascentM, landmarks = LANDMARKS) {
  if (!ascentM || ascentM <= 0) return null;

  let best = null;
  for (const [name, height, where] of landmarks) {
    if (height <= 0) continue;
    const repeats = ascentM / height;
    if (repeats < MIN_REPEATS) continue;
    // Prefer the tallest thing still climbed at least once; among those, the
    // one giving the most readable count.
    if (best === null || height > best[1]) best = [name, height, where, repeats];
  }

  if (best === null) return null;
  const [name, height, where, repeats] = best;
  return { name, height_m: height, where, repeats, phrase: _phrase(name, repeats) };
}

// Python's str.capitalize(): first letter up, the rest down.
const capitalize = s => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

// Say it the way a person would.
function _phrase(name, repeats) {
  if (repeats < 1.1) return name.startsWith('the ') ? name : capitalize(name);
  if (repeats < 1.6) return `one and a half ${_plural(name)}`;
  if (repeats < 2.0) return `nearly two ${_plural(name)}`;
  if (repeats < MAX_REPEATS) return `${repeats.toFixed(1)} ${_plural(name)}`;
  return `${repeats.toFixed(0)} ${_plural(name)}`;
}

// Rough pluralisation for the handful of shapes in the table.
export function _plural(name) {
  const stem = name.startsWith('the ') ? name.slice(4) : name;
  if (stem.endsWith('s')) return stem;
  // 'aeiou'.includes('') is true, like Python's '' in "aeiou", so a 1-char stem matches too
  if (stem.endsWith('y') && !'aeiou'.includes(stem.slice(-2, -1))) return stem.slice(0, -1) + 'ies';
  return stem + 's';
}

// Everything this much climbing has cleared, tallest first. -> [object].
//
// Useful as a progress list: what you have passed, and what is next.
export function ladder(ascentM, landmarks = LANDMARKS) {
  if (!ascentM || ascentM <= 0) return [];
  const out = landmarks.map(([name, height, where]) => ({
    name, height_m: height, where, repeats: ascentM / height, cleared: ascentM >= height,
  }));
  out.sort((a, b) => b.height_m - a.height_m);     // stable, like Python's reverse sort
  return out;
}

// The next landmark still out of reach. -> object|null.
export function nextUp(ascentM, landmarks = LANDMARKS) {
  const have = ascentM || 0;
  let best = null;
  for (const lm of landmarks) if (lm[1] > have && (best === null || lm[1] < best[1])) best = lm;
  if (best === null) return null;
  const [name, height, where] = best;
  return { name, height_m: height, where, to_go_m: height - have };
}
