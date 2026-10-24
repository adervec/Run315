// The routes you run again and again, and whether you are getting quicker on them.
//
// Almost nobody runs somewhere new every day. Most training is a handful of routes
// repeated for years, and that repetition is the most honest fitness test an
// athlete owns: the same roads, the same corners, the same hill into the same
// headwind, so the only thing that changed between March and September is you. A
// lab test costs money and a race costs a weekend. The Tuesday loop is free, and
// you have already run it fourteen times.
//
// The hard part is deciding that two GPS traces are the same route. No two
// recordings of the same roads share a single point, and matching lines against
// each other properly means map matching, projections and a geometry library.
//
// So don't look at the points. Look at the tiles from territory.js: every run
// already claims a set of ~305 m squares, and two runs of the same route claim
// almost exactly the same squares. Jaccard -- shared tiles over total tiles --
// then answers "is this the same route" with two set operations and no
// dependencies, over data the territory game computes for every run anyway.
//
// One trap comes with it. A subset scores well: a 5 km out-and-back down the same
// road claims half the tiles of the 10 km version and none that it does not, so
// the ground agrees while the runs plainly do not. Distance has to agree too.
//
// Pure functions over run objects. No I/O, no dependencies beyond territory.
// See test/repeats.test.mjs.
//
// A run needs: garmin_id, start (Date), distance_m, moving_s, and tiles
// (an array of [x, y], from signature()). Missing values may be null.
import * as territory from './territory.js';

export const DEFAULT_ZOOM = territory.DEFAULT_ZOOM;

// Jaccard over z17 tiles. Two recordings of the same route score above 0.85 in
// practice -- the tiles only disagree where the trace wanders over a boundary --
// so the cutoff is not delicate. 0.6 leaves room for a different finish, a lap of
// the park at the end or a diversion round roadworks, while still refusing two
// routes that merely share the same river path out of town.
export const SAME_ROUTE = 0.6;

// How far two runs may differ in length and still be the same route. Measured
// distance for identical roads varies by a percent or two, and a warm-up lap or
// an extra block at the end is worth maybe ten. Twenty accepts all of that; the
// case it exists to reject -- the same road run twice as far -- is fifty percent
// out, so there is a wide gap either side of the line.
export const DISTANCE_TOLERANCE = 0.20;

export const MIN_REPEATS = 3;   // fewer than three times is a route you tried, not one you run

// Riegel's fatigue exponent, the same one fitness projects race times with.
// ponytail: the textbook value, not this athlete's fitted one. Across the
// +/-20% window one route's distances wobble in, the difference between the two
// is under a percent -- fitting it here would be arithmetic for its own sake.
export const RIEGEL = 1.06;

export const IMPROVEMENT = 0.02;  // 2% of pace is about 7 s/km -- smaller than that is weather

// Fresh ground claimed per metre run, above which a route did not double back.
// Measured on real geometry: loops land at 1.2 (a turning route cuts tiles
// cornerwise, so it claims more than one per tile-width), out-and-backs at 0.55,
// because the way home is the way out. The line sits under both bands.
// ponytail: a crude shape test, and a route that does both reads as whichever
// half is longer. Good enough to name a route; nothing else depends on it.
export const LOOP_COVERAGE = 0.70;

const DAY_MS = 86400000;
// Python's timedelta.days for naive datetimes: floor of the wall-clock gap, so a
// DST change in between does not shave a day off.
const wall = d => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(),
  d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
const tdDays = (a, b) => Math.floor((wall(a) - wall(b)) / DAY_MS);

// --------------------------------------------------------------------------- //
// is this the same route?
// --------------------------------------------------------------------------- //

// A run's ground, as the tiles it touched.
//
// This is the whole trick. A route identified by the squares it covers instead
// of by its points means two recordings of the same roads agree exactly, even
// though no two sets of GPS fixes ever do.
export function signature(points, zoom = DEFAULT_ZOOM) {
  return territory.tilesForTrack(points || [], zoom);
}

// Jaccard index of two tile sets: shared ground over total ground. 0..1.
//
// Two runs with no tiles at all are not the same route -- they are two
// unknowns -- so that case is 0.0 rather than an undefined 0/0.
export function similarity(a, b) {
  const sa = territory.keySet(a), sb = territory.keySet(b);
  let shared = 0;
  for (const k of sa) if (sb.has(k)) shared++;
  const union = sa.size + sb.size - shared;
  if (!union) return 0.0;
  return shared / union;
}

// Whether two runs are close enough in length to be the same route.
//
// Tile overlap alone cannot tell a route from half of it: the shorter run's
// tiles are a subset of the longer one's, which scores far too well. The
// tolerance is taken against the longer distance, so the test is symmetric and
// a doubled route fails it however you order the pair.
function _distanceAgrees(a, b, tolerance = DISTANCE_TOLERANCE) {
  const da = a.distance_m, db = b.distance_m;
  if (!da || !db) return true;   // nothing to check against; the tiles decide alone
  return Math.abs(da - db) <= tolerance * Math.max(da, db);
}

const tileCount = t => (t == null ? 0 : (t.size ?? t.length ?? 0));

// Group runs into routes. -> [[run, ...], ...], most-run route first.
//
// Each run is compared against one representative per route found so far --
// the first run of that route -- and joins whichever it matches best above
// `threshold`, or founds a new route of its own.
//
// Runs are taken oldest first, so a route's representative is the first time
// the athlete ran it. That keeps the grouping stable: syncing a new run never
// reshuffles the routes already on the page.
//
// Runs with no tiles are dropped. A treadmill hour covers no ground, and a
// route it could belong to cannot be told from any other.
//
// A tile set has no direction, so the same loop run backwards is the same
// route here. That is the answer an athlete wants -- it is the same hill and
// the same corners either way round.
export function cluster(runs, threshold = SAME_ROUTE, tolerance = DISTANCE_TOLERANCE) {
  // Greedy against a representative, not all pairs. All-pairs Jaccard is
  // O(n^2) set operations over an athlete's whole history -- hundreds of runs
  // is tens of thousands of comparisons, recomputed on every page load -- while
  // this is O(n * routes), and routes stays in the dozens no matter how long
  // the history gets.
  // ponytail: a fixed representative rather than average linkage. It can split
  // one route in two when the trace drifts (B matches A, C matches B but not
  // A). Compare against the core tiles of the route instead if that shows up.
  const routes = [];                               // [[representative, [members]]]
  for (const run of _oldestFirst(runs)) {
    if (!tileCount(run.tiles)) continue;
    let best = null, score = 0.0;
    for (const [rep, members] of routes) {
      const s = similarity(rep.tiles, run.tiles);
      if (s < threshold || !_distanceAgrees(rep, run, tolerance)) continue;
      if (best === null || s > score) { best = members; score = s; }
    }
    if (best === null) routes.push([run, [run]]);
    else best.push(run);
  }

  const out = routes.map(([, members]) => members);
  out.sort((a, b) => b.length - a.length);        // stable: ties stay in the order founded
  return out;
}

// Chronological, with undated runs left at the end in the order given.
function _oldestFirst(runs) {
  const all = [...(runs || [])].filter(r => r);
  const dated = all.filter(r => r.start != null).sort((a, b) => a.start - b.start);
  return dated.concat(all.filter(r => r.start == null));
}

// --------------------------------------------------------------------------- //
// are you getting quicker on it?
// --------------------------------------------------------------------------- //
function _median(values) {
  const vals = values.filter(v => v).sort((a, b) => a - b);
  if (!vals.length) return null;
  const mid = vals.length >> 1;
  if (vals.length % 2) return vals[mid];
  return (vals[mid - 1] + vals[mid]) / 2.0;
}

// Seconds per km, normalised to `distanceM`. null without both numbers.
//
// Runs of one route are not all the same length -- a lap of the park at the
// end, a watch that measured 200 m short -- and raw pace reads that wobble as
// form: the longer day looks like a bad day even at identical effort. Riegel
// converts the time to what it would have been over the route's usual
// distance, which is what "your best time on this route" has to mean.
function _pace(run, distanceM = null) {
  let d = run.distance_m, t = run.moving_s;
  if (!d || !t || d <= 0 || t <= 0) return null;
  if (distanceM && distanceM > 0) {
    t = t * (distanceM / d) ** RIEGEL;
    d = distanceM;
  }
  return t / (d / 1000.0);
}

// How one route has gone over time. -> object, or null if it has no runs.
//
// `members` is an array of runs, as one entry of cluster(). Everything compared
// here is pace normalised to the route's median distance; times are reported
// raw, because a time is what the athlete remembers running.
//
// The trend splits the timed runs into an early half and a late half rather
// than fitting a line: it survives one heat wave or one race-pace day, needs
// no statistics, and answers the only question being asked -- is the recent
// version of you quicker round here than the older one.
export function progression(members) {
  const runs = _oldestFirst(members);
  if (!runs.length) return null;

  const distanceM = _median(runs.map(r => r.distance_m));
  const timed = runs.map(r => [r, _pace(r, distanceM)]).filter(([, p]) => p);

  let bestRun = null, bestPace = null;
  for (const [r, p] of timed) if (bestPace === null || p < bestPace) { bestRun = r; bestPace = p; }
  const [lastRun, lastPace] = timed.length ? timed[timed.length - 1] : [null, null];

  // An odd run out of the middle belongs to neither half -- it is the pivot.
  const half = timed.length >> 1;
  let change = null;
  if (half) {
    let early = 0, late = 0;
    for (const [, p] of timed.slice(0, half)) early += p;
    for (const [, p] of timed.slice(timed.length - half)) late += p;
    change = (late / half) / (early / half) - 1.0;
  }
  const offBest = bestPace ? lastPace / bestPace - 1.0 : null;

  const starts = runs.filter(r => r.start != null).map(r => r.start);
  return {
    count: runs.length,
    timed: timed.length,
    first: starts.length ? starts[0] : null,
    last: starts.length ? starts[starts.length - 1] : null,
    days: starts.length > 1 ? tdDays(starts[starts.length - 1], starts[0]) : 0,
    distance_m: distanceM,
    best: bestRun,
    best_s: bestRun ? bestRun.moving_s ?? null : null,
    best_pace: bestPace,
    best_at: bestRun ? bestRun.start ?? null : null,
    latest: lastRun,
    latest_s: lastRun ? lastRun.moving_s ?? null : null,
    latest_pace: lastPace,
    change,                       // negative is quicker
    off_best: offBest,            // how far the last one sits off the best
    improving: change === null ? null : change <= -IMPROVEMENT,
    verdict: _verdict(timed.length, change, offBest),
  };
}

// One line on the route, in the terms a runner would use.
function _verdict(timed, change, offBest) {
  if (!timed) return 'Never timed this route.';
  if (change === null) return 'Only one timed run on this route -- nothing to compare it to yet.';
  if (change <= -IMPROVEMENT) return `${(-change * 100).toFixed(1)}% quicker over ${timed} runs on the same ground.`;
  if (change >= IMPROVEMENT) return `${(change * 100).toFixed(1)}% slower here than when you started running it.`;
  if (offBest !== null && offBest < 0.005) return `Level across ${timed} runs, but the last one was your best.`;
  return `Level across ${timed} runs -- this route is not testing you.`;
}

// --------------------------------------------------------------------------- //
// naming the thing
// --------------------------------------------------------------------------- //

// "loop" or "out and back", from how much ground the tiles cover per metre.
//
// The tile count already knows the answer, so the points do not need looking
// at again: running out and back down one road claims each tile twice and so
// covers about half the ground of a loop of the same length.
export function shape(tiles, distanceM, zoom = DEFAULT_ZOOM) {
  if (!tileCount(tiles) || !distanceM) return 'route';
  const list = [...territory.keySet(tiles)].map(k => k.split(',').map(Number));
  const rows = list.map(t => t[1]).sort((a, b) => a - b);
  const metres = territory.tileSizeM(rows[rows.length >> 1], zoom);
  const covered = list.length * metres / distanceM;
  return covered >= LOOP_COVERAGE ? 'loop' : 'out and back';
}

// A name the athlete would recognise: "8.4 km loop", "5.0 km out and back".
//
// ponytail: distance and shape only. The athlete knows which 8 km loop it is;
// if two of them ever collide, name them from the streets the core tiles cover
// (pois already talks to Overpass) or just let the athlete rename it.
export function nameFor(tiles, distanceM, zoom = DEFAULT_ZOOM) {
  if (!distanceM) return 'Unnamed route';
  return `${(distanceM / 1000.0).toFixed(1)} km ${shape(tiles, distanceM, zoom)}`;
}

// Tiles claimed on at least half of a route's runs -- the route, no detours.
//
// One run's diversion round a closed bridge is not part of the route, and
// drawing the union would show every such diversion at once.
function _coreTiles(members) {
  const counts = new Map();                        // key -> [tile, n]
  for (const r of members) {
    for (const k of territory.keySet(r.tiles)) {
      const c = counts.get(k);
      if (c) c[1]++; else counts.set(k, [k.split(',').map(Number), 1]);
    }
  }
  const need = members.length / 2.0;
  return [...counts.values()].filter(([, n]) => n >= need).map(([t]) => t);
}

// --------------------------------------------------------------------------- //
// the pipeline
// --------------------------------------------------------------------------- //

// Runs in, repeated routes out, most-run first. -> [object, ...].
//
// Routes run fewer than `minRepeats` times are dropped. A one-off is a nice
// memory but it says nothing about form, and left in, the exploring an athlete
// does on holiday would bury the loop they actually train on.
export function summarise(runs, minRepeats = MIN_REPEATS, threshold = SAME_ROUTE,
                          tolerance = DISTANCE_TOLERANCE, zoom = DEFAULT_ZOOM) {
  const out = [];
  for (const members of cluster(runs, threshold, tolerance)) {
    if (members.length < minRepeats) continue;
    const prog = progression(members);
    const tiles = _coreTiles(members);
    out.push({
      name: nameFor(tiles, prog.distance_m, zoom),
      shape: shape(tiles, prog.distance_m, zoom),
      count: members.length,
      distance_m: prog.distance_m,
      tiles,
      runs: members,
      garmin_ids: members.map(r => r.garmin_id ?? null),
      progression: prog,
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}
