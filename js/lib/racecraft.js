// Racing a course, not a distance.
//
// Two jobs, either side of the day:
//
//   strategy    given the course and a target time, what should each kilometre
//               take? Even *pace* is the wrong answer on a hilly course; even
//               *effort* is the right one, and they are not the same plan.
//   postmortem  given what you actually ran, where did the time go, and was it
//               the hills, the heat or going out too hard?
//
// The gradient model is Minetti's energy cost of running (2002): the metabolic
// cost per metre as a polynomial in gradient. Cost relative to flat gives the pace
// multiplier, which is the basis every grade-adjusted pace uses.
//
// Pure functions. No I/O, no dependencies. Port of racecraft.py; see
// test/racecraft.test.mjs.

export const EARTH_R = 6371000.0;

// Minetti et al. 2002, J/kg/m. Flat is 3.6.
const _MINETTI = [155.4, -30.4, -43.3, 46.3, 19.5, 3.6];
export const FLAT_COST = 3.6;

// The polynomial was fitted between -45% and +45%, and it keeps getting cheaper
// down to about -20%, which would have you running a steep descent twice as fast
// as the flat. Nobody does: you brake, and your quads pay for it. So the benefit
// is floored.
// ponytail: a flat floor, not a braking model. Fit the floor per athlete from
// their own downhill splits if this ever needs to be better.
export const MIN_RATIO = 0.80;
export const MAX_RATIO = 3.00;
export const GRADE_LIMIT = 0.30;

export const CLIMB_GRADE = 0.03;   // what counts as a hill worth naming
export const CLIMB_MIN_M = 200.0;  // ...and long enough to matter

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

// '%.0f' / '%.1f' with Python's round-half-even on exact ties.
function _fmt(x, n) {
  const m = 10 ** n, v = x * m;
  if (Number.isInteger(v * 2) && !Number.isInteger(v)) {
    const f = Math.floor(v);
    return ((f % 2 === 0 ? f : f + 1) / m).toFixed(n);
  }
  return x.toFixed(n);
}

const rad = d => d * Math.PI / 180;

// Metres between two [lat, lon] points.
export function haversine(a, b) {
  const lat1 = rad(a[0]), lon1 = rad(a[1]), lat2 = rad(b[0]), lon2 = rad(b[1]);
  const h = Math.sin((lat2 - lat1) / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1.0, Math.sqrt(h)));
}

// How much more a metre costs at this gradient than on the flat.
export function costRatio(grade) {
  if (grade == null) return 1.0;
  const g = Math.max(-GRADE_LIMIT, Math.min(GRADE_LIMIT, Number(grade)));
  let cost = 0.0;
  for (const coefficient of _MINETTI) cost = cost * g + coefficient;
  return Math.max(MIN_RATIO, Math.min(MAX_RATIO, cost / FLAT_COST));
}

// What a hill pace is worth on the flat. Lower is better, as always.
export function gradeAdjustedPace(paceSPerKm, grade) {
  if (!paceSPerKm) return null;
  return paceSPerKm / costRatio(grade);
}

// [[lat, lon, ele_or_null]] with junk dropped.
export function cleanCourse(points) {
  const out = [];
  for (const p of points || []) {
    if (!p || p.length < 2) continue;
    const lat = _float(p[0]), lon = _float(p[1]);
    if (lat === undefined || lon === undefined) continue;
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
    if (!(-90.0 <= lat && lat <= 90.0 && -180.0 <= lon && lon <= 180.0)) continue;
    let ele = null;
    if (p.length > 2 && p[2] != null) {
      const e = _float(p[2]);
      ele = (e === undefined || Number.isNaN(e)) ? null : e;
    }
    out.push([lat, lon, ele]);
  }
  return out;
}

// Elevation smoothed over distance. -> [[lat, lon, ele, cumulative_m]].
//
// Raw barometric and GPS elevation is noisy enough that a flat road can read as
// a series of 5% ramps, which would wreck every gradient below.
export function smoothElevation(points, windowM = 100.0) {
  const pts = cleanCourse(points);
  if (!pts.length) return [];
  const cum = [0.0];
  let total = 0.0;
  for (let i = 1; i < pts.length; i++) {
    total += haversine(pts[i - 1], pts[i]);
    cum.push(total);
  }

  const out = [];
  let lo = 0, hi = 0;
  const half = windowM / 2.0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    while (lo < i && cum[i] - cum[lo] > half) lo++;
    while (hi + 1 < pts.length && cum[hi + 1] - cum[i] <= half) hi++;
    const window = [];
    for (let k = lo; k <= hi; k++) if (pts[k][2] !== null) window.push(pts[k][2]);
    const ele = window.length ? window.reduce((s, x) => s + x, 0) / window.length : null;
    out.push([p[0], p[1], ele, cum[i]]);
  }
  return out;
}

// Split a course into even chunks. -> [object] with distance, climb, grade.
//
// The last chunk is whatever is left, so a marathon ends with a 195 m segment
// rather than pretending the course is a round number.
export function segmentCourse(points, stepM = 1000.0) {
  const pts = smoothElevation(points);
  if (pts.length < 2 || stepM <= 0) return [];
  const total = pts[pts.length - 1][3];

  const segments = [];
  let startI = 0, n = 1;
  while (startI < pts.length - 1) {
    const edge = Math.min(n * stepM, total);
    let endI = startI;
    while (endI < pts.length - 1 && pts[endI][3] < edge) endI++;
    if (endI <= startI) break;

    const span = pts[endI][3] - pts[startI][3];
    let up = 0.0, down = 0.0;
    for (let k = startI; k < endI; k++) {
      const a = pts[k], b = pts[k + 1];
      if (a[2] === null || b[2] === null) continue;
      const delta = b[2] - a[2];
      if (delta > 0) up += delta;
      else down -= delta;
    }
    const e0 = pts[startI][2], e1 = pts[endI][2];
    const grade = (e0 !== null && e1 !== null && span > 0) ? (e1 - e0) / span : null;

    segments.push({
      n,
      from_m: pts[startI][3], to_m: pts[endI][3],
      distance_m: span,
      climb_m: up, drop_m: down,
      grade,
      cost: costRatio(grade),
      lat: pts[startI][0], lon: pts[startI][1],
    });
    startI = endI; n += 1;
    if (edge >= total) break;
  }
  return segments;
}

// Headline numbers for a course.
export function courseStats(points) {
  const segments = segmentCourse(points);
  if (!segments.length) return null;
  const climb = segments.reduce((s, x) => s + x.climb_m, 0);
  const drop = segments.reduce((s, x) => s + x.drop_m, 0);
  const length = segments[segments.length - 1].to_m;
  const graded = segments.filter(s => s.grade !== null);
  let steepest = null;   // first max, as Python's max()
  for (const s of graded) if (steepest === null || s.grade > steepest.grade) steepest = s;
  return {
    length_m: length,
    climb_m: climb,
    drop_m: drop,
    segments,
    steepest,
    has_elevation: graded.length > 0,
    // Effort cost of the whole course against the same distance on the flat.
    difficulty: length ? segments.reduce((s, x) => s + x.distance_m * x.cost, 0) / length : 1.0,
  };
}

// Per-segment targets that spend even effort and total the target time.
//
// Even pace up a hill means uneven effort, and uneven effort is how people
// blow up. So each segment's pace is scaled by what its gradient costs, then
// the whole plan is normalised to land exactly on the target.
export function pacePlan(segments, targetS, negativeSplit = 0.01) {
  if (!segments || !segments.length || !targetS || targetS <= 0) return [];
  const totalM = segments.reduce((s, x) => s + x.distance_m, 0);
  if (totalM <= 0) return [];
  const half = totalM / 2.0;

  // Weight = how much of the target this segment deserves.
  const weights = [];
  let seen = 0.0;
  for (const s of segments) {
    const mid = seen + s.distance_m / 2.0;
    const bias = mid < half ? (1 + negativeSplit) : (1 - negativeSplit);
    weights.push(s.distance_m * s.cost * bias);
    seen += s.distance_m;
  }

  const scale = targetS / weights.reduce((a, b) => a + b, 0);
  const plan = [];
  let cumulative = 0.0;
  segments.forEach((s, i) => {
    const secs = weights[i] * scale;
    cumulative += secs;
    const km = s.distance_m / 1000.0;
    plan.push({ ...s, target_s: secs, target_pace: km > 0 ? secs / km : null, cumulative_s: cumulative });
  });
  return plan;
}

// Contiguous climbs worth warning about. -> [object] biggest climb first.
export function hardSections(segments, grade = CLIMB_GRADE, minM = CLIMB_MIN_M) {
  const out = [];
  let run = [];
  for (const s of segments) {
    if (s.grade !== null && s.grade >= grade) { run.push(s); continue; }
    if (run.length) { out.push(run); run = []; }
  }
  if (run.length) out.push(run);

  const sections = [];
  for (const group of out) {
    const span = group.reduce((a, s) => a + s.distance_m, 0);
    if (span < minM) continue;
    const climb = group.reduce((a, s) => a + s.climb_m, 0);
    sections.push({
      from_m: group[0].from_m, to_m: group[group.length - 1].to_m,
      distance_m: span, climb_m: climb,
      grade: span ? climb / span : 0.0,
      segments: group.map(s => s.n),
    });
  }
  sections.sort((a, b) => b.climb_m - a.climb_m);
  return sections;
}

// --------------------------------------------------------------------------- //
// after the race
// --------------------------------------------------------------------------- //

// Python sorts the (t, d, hr, ele) tuples lexicographically.
function _cmpTuple(a, b) {
  for (let k = 0; k < a.length; k++) {
    if (a[k] === b[k]) continue;
    if (a[k] === null || b[k] === null) return 0;
    return a[k] < b[k] ? -1 : 1;
  }
  return 0;
}

// Per-segment splits from a run's stream. -> [object] matching segmentCourse.
export function actualSegments(samples, stepM = 1000.0) {
  const pts = [];
  for (const s of samples || []) {
    if (!s || s.length < 2 || s[0] == null || s[1] == null) continue;
    const t = _float(s[0]), d = _float(s[1]);
    if (t === undefined || d === undefined) continue;
    const hr = s.length > 2 ? (s[2] ?? null) : null;
    const ele = s.length > 5 ? (s[5] ?? null) : null;
    pts.push([t, d, hr, ele]);
  }
  if (pts.length < 2) return [];
  pts.sort(_cmpTuple);

  const d0 = pts[0][1];
  const total = pts[pts.length - 1][1] - d0;
  const out = [];
  let i = 0, n = 1;
  while (i < pts.length - 1) {
    const edge = Math.min(n * stepM, total);
    let j = i;
    while (j < pts.length - 1 && (pts[j][1] - d0) < edge) j++;
    if (j <= i) break;
    const span = pts[j][1] - pts[i][1];
    const secs = pts[j][0] - pts[i][0];
    const hrs = [];
    for (let k = i; k <= j; k++) if (pts[k][2]) hrs.push(pts[k][2]);
    const e0 = pts[i][3], e1 = pts[j][3];
    const grade = (e0 !== null && e1 !== null && span > 0) ? (e1 - e0) / span : null;
    if (span > 0 && secs > 0) {
      out.push({
        n,
        from_m: pts[i][1] - d0, to_m: pts[j][1] - d0,
        distance_m: span, seconds: secs,
        pace: secs / (span / 1000.0),
        avg_hr: hrs.length ? hrs.reduce((a, b) => a + b, 0) / hrs.length : null,
        grade,
        gap: gradeAdjustedPace(secs / (span / 1000.0), grade),
      });
    }
    i = j; n += 1;
    if (edge >= total) break;
  }
  return out;
}

// Line the plan up against what happened. -> [object] per segment.
export function compare(plan, actual) {
  return actual.map((act, i) => {
    const want = i < plan.length ? plan[i] : null;
    return {
      n: act.n,
      from_m: act.from_m, to_m: act.to_m,
      target_s: want ? want.target_s : null,
      target_pace: want ? want.target_pace : null,
      seconds: act.seconds, pace: act.pace,
      delta_s: want ? act.seconds - want.target_s : null,
      avg_hr: act.avg_hr, grade: act.grade, gap: act.gap,
    };
  });
}

const _sum = xs => xs.reduce((a, b) => a + b, 0);

// What the race actually did, and the honest reason. -> object or null.
export function postmortem(plan, actual, targetS = null) {
  if (!actual || !actual.length) return null;
  plan = plan || [];
  const rows = compare(plan, actual);
  const total = _sum(actual.map(a => a.seconds));
  const planned = plan.length ? _sum(plan.map(p => p.target_s)) : null;

  const paced = rows.filter(r => r.delta_s !== null);
  const lost = _sum(paced.filter(r => r.delta_s > 0).map(r => r.delta_s));
  const gained = -_sum(paced.filter(r => r.delta_s < 0).map(r => r.delta_s));
  let worst = null;
  for (const r of paced) if (worst === null || r.delta_s > worst.delta_s) worst = r;

  // Equal counts either side, and mean pace rather than summed time: an odd
  // number of kilometres would otherwise compare two against three and report
  // a perfectly even race as a 50% fade.
  const paces = actual.filter(a => a.pace).map(a => a.pace);
  let fade = null;
  if (paces.length >= 2) {
    const h = Math.floor(paces.length / 2);
    const early = _sum(paces.slice(0, h)) / h;
    const late = _sum(paces.slice(-h)) / h;
    fade = early > 0 ? late / early - 1.0 : null;
  }

  // Effort, not pace: on a hilly course the two tell different stories.
  const gaps = actual.filter(a => a.gap).map(a => a.gap);
  let gapFade = null;
  if (gaps.length >= 4) {
    const h = Math.floor(gaps.length / 2);
    const early = _sum(gaps.slice(0, h)) / h;
    const late = _sum(gaps.slice(-h)) / h;
    gapFade = early > 0 ? late / early - 1.0 : null;
  }

  const hrs = actual.filter(a => a.avg_hr).map(a => a.avg_hr);
  let hrDrift = null;
  if (hrs.length >= 4) {
    const h = Math.floor(hrs.length / 2);
    hrDrift = _sum(hrs.slice(-h)) / h - _sum(hrs.slice(0, h)) / h;
  }

  // Where the climbs were, so a slow split on a hill is not called a blow-up.
  const uphill = actual.filter(a => a.grade !== null && a.grade >= CLIMB_GRADE);
  const uphillLoss = _sum(paced
    .filter(r => r.grade !== null && r.grade >= CLIMB_GRADE && r.delta_s > 0)
    .map(r => r.delta_s));

  return {
    rows,
    total_s: total,
    planned_s: planned,
    delta_s: planned ? total - planned : null,
    target_s: targetS,
    vs_target_s: targetS ? total - targetS : null,
    lost_s: lost, gained_s: gained,
    worst,
    fade, gap_fade: gapFade,
    hr_drift: hrDrift,
    uphill_segments: uphill.length,
    uphill_loss_s: uphillLoss,
    verdict: verdict(fade, gapFade, lost, uphillLoss, hrDrift),
  };
}

// One line on how the race was run.
export function verdict(fade, gapFade, lostS, uphillLossS, hrDrift) {
  if (fade === null || fade === undefined) {
    return 'Not enough of the race recorded to judge how it was run.';
  }
  if (fade > 0.06) {
    if (gapFade != null && gapFade < fade - 0.03) {
      return 'You slowed a long way, but the course did most of it -- on ' +
        'effort you held together better than the splits suggest.';
    }
    if (hrDrift != null && hrDrift < 3) {
      return 'Second half ' + _fmt(fade * 100, 0) + '% slower with heart rate flat: the legs went ' +
        'before the engine did.';
    }
    return 'Second half ' + _fmt(fade * 100, 0) + '% slower. You went out too hard.';
  }
  if (lostS && uphillLossS >= 0.6 * lostS) {
    return 'Paced it well; almost all the lost time was on the climbs.';
  }
  if (fade < -0.02) return 'Negative split. Exactly how it is supposed to be done.';
  return 'Evenly run, start to finish.';
}
