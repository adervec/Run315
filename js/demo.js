// A synthetic athlete so the app can be run without Garmin credentials. Port of
// seed_demo() in the Flask app.py.
//
// The demo is delivered the way real data arrives: demoGarminPayload() is a
// garmin-output payload that ingest.importGarmin() takes exactly as it takes the
// exporter's, so the demo exercises the same code path a Garmin sync does rather
// than writing tidy numbers straight into state. demoExtras() is what Garmin does
// not know about (the athlete's races and their courses).
//
// Deterministic: a seeded PRNG stands in for Python's random.Random(315), and every
// date is relative to `now` exactly as the Python was relative to datetime.now().
// Pure: no DOM, no I/O.
import { dayKey, addDays, fromDay, isoLocal, weekday } from './lib/dt.js';
import { pyRound, sum } from './lib/py.js';
import { summarise, projectRace } from './lib/fitness.js';
import { courseStats } from './lib/racecraft.js';

export const DEMO_HOME = [47.3769, 8.5417];      // Zurich, so the demo map lands somewhere real
const SEED = 315;

// mulberry32 with Python-random-shaped helpers on top.
function makeRng(seed) {
  let a = seed >>> 0;
  const random = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  return {
    random,
    uniform: (lo, hi) => lo + (hi - lo) * random(),
    randint: (lo, hi) => lo + Math.floor(random() * (hi - lo + 1)),
    gauss(mu, sigma) {            // Box-Muller, the second value kept for next time
      if (spare !== null) { const z = spare; spare = null; return mu + sigma * z; }
      let u = 0; while (u === 0) u = random();
      const v = random(), r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v);
      return mu + sigma * r * Math.cos(2 * Math.PI * v);
    },
  };
}

const rad = x => x * Math.PI / 180;

// An out-and-back of `totalM` on a gently curving bearing.
//
// -> [[cumulative_m, lat, lon]]. Curving rather than dead straight means the
// claimed tiles look like a route someone ran, not a ruler line.
export function demoRoute(bearingDeg, totalM, home = DEMO_HOME, steps = 40) {
  const half = totalM / 2.0, step = half / steps;
  let [lat, lon] = home, cum = 0.0;
  const out = [[0.0, lat, lon]];
  for (let i = 0; i < steps; i++) {
    const brg = bearingDeg + 35.0 * Math.sin(Math.PI * i / steps) + (i % 3) * 4.0;
    const r = rad(brg);
    lat += step * Math.cos(r) / 111320.0;
    lon += step * Math.sin(r) / (111320.0 * Math.cos(rad(lat)));
    cum += step;
    out.push([cum, lat, lon]);
  }
  // Retrace the same way home, so distance keeps increasing.
  const back = out.slice(0, -1).reverse().map(([c, la, lo]) => [totalM - c, la, lo]);
  return out.concat(back);
}

// Position at cumulative distance `d` along a demoRoute().
export function demoPoint(route, d) {
  if (d <= route[0][0]) return [route[0][1], route[0][2]];
  for (let i = 1; i < route.length; i++) {
    const [c0, la0, lo0] = route[i - 1], [c1, la1, lo1] = route[i];
    if (d <= c1) {
      const f = c1 > c0 ? (d - c0) / (c1 - c0) : 0.0;
      return [la0 + (la1 - la0) * f, lo0 + (lo1 - lo0) * f];
    }
  }
  const last = route[route.length - 1];
  return [last[1], last[2]];
}

const dayOfYear = d => Math.round((fromDay(dayKey(d)) - new Date(d.getFullYear(), 0, 1)) / 86400000) + 1;
const isParkrun = (dow, daysAgo) => dow === 5 && daysAgo % 28 < 7;

// Per-step pace multiplier: session shape decides where the fast bit is.
function profile(dow, daysAgo, step, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const frac = i / Math.max(count - 1, 1);
    if (dow === 2) out.push((i * step) % 1600 < 900 ? 0.86 : 1.14);   // intervals: 3 min hard / 2 min float
    else if (isParkrun(dow, daysAgo)) out.push(0.99);                  // parkrun: flat out
    else if (dow === 5) out.push(0.3 < frac && frac < 0.7 ? 0.90 : 1.08); // tempo block in the middle
    else if (dow === 6) out.push(frac > 0.75 ? 0.93 : 1.03);           // long run, quick last quarter
    else out.push(1.0);
  }
  return out;
}

// One run's stream: the legacy 10-wide rows [t, d, hr, lat, lon, ele, cadence,
// stride, gct, vosc], thinned to ~200 samples plus the standing-still rows.
function runStream(rng, run) {
  const { dist, secs, dow, daysAgo, num } = run;
  // Synthesise a within-run pace profile, so the best-effort extractor and the
  // interval detector read the same kind of stream a Garmin capture gives them
  // rather than tidy invented numbers.
  const step = 25.0;
  const count = Math.max(Math.trunc(dist / step), 2);
  const weights = profile(dow, daysAgo, step, count);
  const base = secs / sum(weights);                 // keep the total time honest
  const samples = [[0.0, 0.0]];
  let t = 0.0, d = 0.0;
  for (const w of weights) { t += base * w; d += step; samples.push([t, d]); }

  // Thin the stream to ~200 samples and add a plausible HR trace with drift.
  const keep = Math.max(Math.floor(samples.length / 200), 1);
  const baseHr = dow === 2 ? 172 : dow === 6 ? 148 : isParkrun(dow, daysAgo) ? 181 : 142;
  let bearing;
  // The Python used the loop-final activity counter here, which put every
  // interval session and every easy run on one single bearing. The run's own
  // number is what the comments always meant.
  if (dow === 6) bearing = (daysAgo * 13) % 360;    // long runs explore
  else if (dow === 2) bearing = (num % 4) * 90;     // intervals: four usual ways out
  else bearing = (num % 6) * 60;                    // easy runs: the same few loops
  const gps = demoRoute(bearing, dist);

  // Where this run gets interrupted. The same two corners come up on every
  // easy run, which is what makes them read as junctions rather than
  // decisions. Long runs add a water stop, and a walk break once they are
  // long enough to hurt.
  const standing = [];                 // [distance_m, seconds stood still]
  const walking = [];                  // [distance_m, metres walked]
  if (dow !== 2 && dow !== 5) standing.push([1200.0, 22.0], [dist * 0.62, 18.0]);
  if (dow === 6) {
    standing.push([dist * 0.45, 150.0]);
    if (dist > 16000) walking.push([dist * 0.80, 280.0]);
  }

  const thin = [];
  let prevT = 0.0, prevD = 0.0, clock = 0.0;
  let tired = 1.0;                     // pace penalty carried after a walk
  const hill = rng.uniform(0.0, 6.283);
  const ws = [1.0, ...weights];
  for (let i = 0; i < samples.length; i += keep) {
    const [st, sd] = samples[i], w = ws[i];
    const stepD = Math.max(sd - prevD, 0.0);
    let stepT = Math.max(st - prevT, 0.0) * tired;
    prevT = st; prevD = sd;

    const onFoot = walking.some(([a, m]) => a <= sd && sd <= a + m);
    if (onFoot && stepD > 0) stepT = stepD / 1.35;  // walking, not running
    clock += stepT;

    const [la, lo] = demoPoint(gps, sd);
    const ele = 400.0 + 18.0 * Math.sin(hill + 4.0 * Math.PI * sd / dist);
    const hr = baseHr * (0.94 + 0.10 * (sd / dist)) * (w > 1.05 ? 0.90 : 1.0);

    // Faster running means quicker feet and less time on the ground, and
    // everything drifts the wrong way once you have been out a while.
    const speedNow = onFoot ? 1.35 : (dist / secs) / Math.max(w, 0.01);
    const tiredness = Math.max(0.0, sd / dist - 0.6) * (dist > 16000 ? 1.0 : 0.3);
    const cadence = 158.0 + 7.0 * speedNow - 6.0 * tiredness;
    const gct = 300.0 - 18.0 * speedNow + 22.0 * tiredness;
    const vosc = 9.6 - 0.35 * speedNow;
    const stride = speedNow / (cadence / 60.0);
    thin.push([pyRound(clock, 1), pyRound(sd, 1), pyRound(hr), pyRound(la, 6), pyRound(lo, 6),
      pyRound(ele, 1), pyRound(cadence, 1), pyRound(stride, 3), pyRound(gct, 1), pyRound(vosc, 2)]);

    // Once the walk is done the legs are gone: everything after is slower.
    if (onFoot) tired = 1.09;

    for (const [atM, heldS] of standing) {
      if (atM <= sd && sd < atM + stepD && stepD > 0) {
        let held = 0.0;
        while (held < heldS) {
          held += 4.0; clock += 4.0;
          // Standing: distance frozen, heart rate falling away.
          thin.push([pyRound(clock, 1), pyRound(sd, 1), pyRound(hr - Math.min(held * 0.24, 45)),
            pyRound(la, 6), pyRound(lo, 6), pyRound(ele, 1), null, null, null, null]);
        }
      }
    }
  }
  return thin;
}

const CHANNEL_KEYS = ['seconds', 'metres', 'hr', 'lat', 'lon', 'elevation_m',
  'cadence_spm', 'stride_m', 'gct_ms', 'vertical_oscillation_cm'];
// The 10-wide rows -> the channel dict Garmin's capture uses (samplesFromChannels in reverse).
function toChannels(rows) {
  const ch = {};
  CHANNEL_KEYS.forEach((k, j) => { ch[k] = rows.map(r => r[j]); });
  return ch;
}

// Three pairs on rotation: one worn out, one getting on, one barely used.
const SHOES = [
  { uuid: 'demo-shoe-1', name: 'Pegasus 40', brand: 'Nike', model: 'Pegasus 40', type: 'shoes', retired: false, limit_m: 800000.0 },
  { uuid: 'demo-shoe-2', name: 'Endorphin Speed', brand: 'Saucony', model: 'Endorphin Speed 3', type: 'shoes', retired: false, limit_m: 700000.0 },
  { uuid: 'demo-shoe-3', name: 'Novablast 4', brand: 'Asics', model: 'Novablast 4', type: 'shoes', retired: false, limit_m: 800000.0 },
];

function shoeFor(dow, daysAgo) {
  if (daysAgo < 45) return 'demo-shoe-3';           // the new pair, only recently in rotation
  if (dow === 2 || dow === 5) return 'demo-shoe-2'; // the quick pair for fast days
  return 'demo-shoe-1';                             // the daily trainer, doing the miles
}

// The whole demo, built once per `now` and shared by both exports.
let cache = null;
function build(now) {
  const key = +now;
  if (cache && cache.key === key) return cache.value;
  const rng = makeRng(SEED);
  const today = new Date(now); today.setHours(7, 30, 0, 0);
  const todayKey = dayKey(today);

  const activities = [], runs = [];
  let n = 0;
  for (let daysAgo = 365; daysAgo >= 0; daysAgo--) {
    const day = addDays(today, -daysAgo);
    const dow = weekday(day);
    if (dow === 0 || dow === 4) continue;             // rest days
    // Fitness improves over the year: volume ramps and pace follows.
    const progress = 1 - daysAgo / 365.0;
    const form = 1.0 - 0.06 * progress;
    const ramp = 0.70 + 0.30 * progress;

    // Zurich weather over the year, and the slowdown that comes with it.
    // Deliberately a different shape from the correction model, so the demo
    // is a demonstration rather than a tautology.
    const doy = dayOfYear(day);
    const tempC = 12.0 + 12.0 * Math.sin(2 * Math.PI * (doy - 100) / 365.0);
    const humidity = 62.0 + 18.0 * Math.sin(2 * Math.PI * (doy - 40) / 365.0);
    const heatDrag = 1.0 + 0.004 * Math.max(0.0, tempC - 14.0);
    const parkrun = isParkrun(dow, daysAgo);
    let dist, pace, hr;
    if (dow === 6) [dist, pace, hr] = [rng.uniform(18000, 26000), 300 * form, 148];      // long run
    else if (dow === 2) [dist, pace, hr] = [rng.uniform(9000, 12000), 258 * form, 172];  // intervals
    else if (parkrun) [dist, pace, hr] = [5000.0, 243 * form, 181];                     // a real 5K, flat out
    else if (dow === 5) [dist, pace, hr] = [rng.uniform(10000, 14000), 276 * form, 165]; // tempo
    else [dist, pace, hr] = [rng.uniform(8000, 12000), 312 * form, 142];
    if (!parkrun) dist *= ramp;                       // a 5K is always 5 km
    const secs = dist / 1000.0 * pace * heatDrag * rng.uniform(0.99, 1.01);
    n += 1;
    const start = isoLocal(day);
    const act = {
      garmin_id: 'demo-' + n, name: 'Run', type: 'running', start,
      distance_m: pyRound(dist, 1), moving_s: pyRound(secs, 1), elapsed_s: pyRound(secs * 1.01, 1),
      avg_hr: hr + rng.randint(-3, 3), max_hr: hr + 12, elev_gain_m: rng.uniform(20, 180),
      calories: pyRound(secs / 60 * 11),
      weather_raw: {
        temp: pyRound(tempC, 1), relativeHumidity: pyRound(humidity, 0),
        dewPoint: pyRound(tempC - (100 - humidity) / 5.0, 1),
        weatherTypeDTO: { desc: 'Partly cloudy' },
      },
      gear: [shoeFor(dow, daysAgo)],
    };
    activities.push(act);
    runs.push({ act, start, dist, secs, dow, daysAgo, num: n });
    if (dow === 3) {                                  // easy spin
      n += 1;
      const rideM = rng.uniform(30000, 55000);
      const rideS = rideM / 1000.0 / rng.uniform(26.0, 30.0) * 3600.0;
      const rideStart = new Date(day); rideStart.setHours(rideStart.getHours() + 9);
      activities.push({
        garmin_id: 'demo-' + n, name: 'Bike', type: 'cycling', start: isoLocal(rideStart),
        distance_m: pyRound(rideM, 1), moving_s: pyRound(rideS, 1), elapsed_s: pyRound(rideS * 1.04, 1),
        avg_hr: 128 + rng.randint(-5, 5), max_hr: 155, elev_gain_m: rng.uniform(100, 600),
        calories: pyRound(rideS / 60 * 9),
        channels: null,                               // no stream for rides; the detail is "done"
      });
    }
  }

  for (const r of runs) r.act.channels = toChannels(r.thin = runStream(rng, r));

  // The off-run day: stress, body battery, sleep stages, weight, oxygen. All of
  // it correlates with training load, because in a real athlete it does.
  const loadByDay = {};
  for (const r of runs) { const d = r.start.slice(0, 10); loadByDay[d] = (loadByDay[d] || 0.0) + (r.secs || 0) / 60.0; }
  const daily = [];
  let weight = 70.5;
  for (let back = 1; back < 75; back++) {
    const day = addDays(today, -back), iso = dayKey(day);
    const minutes = loadByDay[iso] || 0.0;
    const hard = minutes > 55;
    // Stress rises with yesterday's load; body battery falls.
    const yesterday = loadByDay[dayKey(addDays(day, -1))] || 0.0;
    const stress = 26.0 + yesterday * 0.18 + rng.gauss(0, 5);
    const batteryHigh = 88.0 - yesterday * 0.10 + rng.gauss(0, 4);
    const deep = 4800.0 + rng.gauss(0, 700) + (hard ? 400 : 0);
    const rem = 5100.0 + rng.gauss(0, 800);
    const light = 13800.0 + rng.gauss(0, 1500);
    weight += rng.gauss(0, 0.12) - 0.004;             // a slow drift down over the block
    daily.push({
      day: iso,
      steps: pyRound(7200 + minutes * 95 + rng.gauss(0, 1200)),
      floors: pyRound(Math.max(0, 8 + rng.gauss(0, 5))),
      stress_avg: pyRound(Math.max(8.0, stress), 1),
      stress_max: pyRound(Math.min(99.0, Math.max(40.0, stress * 2.4 + rng.gauss(0, 8))), 1),
      body_battery_high: pyRound(Math.min(100.0, Math.max(40.0, batteryHigh))),
      body_battery_low: pyRound(Math.max(5.0, batteryHigh - 30 - minutes * 0.22)),
      spo2_avg: pyRound(Math.min(99.0, 95.5 + rng.gauss(0, 1.0)), 1),
      spo2_low: pyRound(Math.min(97.0, 90.0 + rng.gauss(0, 2.0)), 1),
      respiration_avg: pyRound(13.2 + rng.gauss(0, 0.8), 1),
      intensity_minutes: pyRound(Math.max(0.0, minutes * 0.8 + rng.gauss(0, 8))),
      vigorous_minutes: pyRound(Math.max(0.0, minutes * 0.35 + rng.gauss(0, 6))),
      weight_kg: pyRound(weight, 2),
      body_fat_pct: pyRound(12.4 + rng.gauss(0, 0.35), 1),
      training_readiness: pyRound(Math.min(99.0, Math.max(20.0, 72.0 - yesterday * 0.16 + rng.gauss(0, 9)))),
      calories_total: pyRound(2450 + minutes * 11 + rng.gauss(0, 120)),
      calories_active: pyRound(380 + minutes * 10.5 + rng.gauss(0, 90)),
      fitness_age: pyRound(31.0 + rng.gauss(0, 0.4), 1),
      deep_s: pyRound(Math.max(1800.0, deep)),
      light_s: pyRound(Math.max(6000.0, light)),
      rem_s: pyRound(Math.max(1800.0, rem)),
      awake_s: pyRound(Math.max(120.0, 900.0 + rng.gauss(0, 400))),
      restless_count: pyRound(Math.max(0.0, 12 + rng.gauss(0, 6))),
      avg_stress: pyRound(Math.max(5.0, 17.0 + yesterday * 0.05 + rng.gauss(0, 4)), 1),
    });
  }

  // Overnight numbers: HRV drifts with the training load, dips after the hard
  // days, and carries the night-to-night noise that makes a baseline mean
  // anything at all.
  const hardDays = new Set(runs.filter(r => r.dow === 2 || r.dow === 5 || r.dow === 6).map(r => r.start.slice(0, 10)));
  const wellness = [];
  for (let back = 1; back < 75; back++) {
    const night = addDays(today, -back);
    const afterHard = hardDays.has(dayKey(addDays(night, -1)));
    const hrv = 60.0 + rng.gauss(0, 5.5) - (afterHard ? 5.0 : 0.0);
    const rhr = 47.0 + rng.gauss(0, 1.8) + (afterHard ? 1.5 : 0.0);
    const hours = 7.4 + rng.gauss(0, 0.7) - (afterHard ? 0.3 : 0.0);
    wellness.push({
      day: dayKey(night), hrv_ms: pyRound(hrv, 1), rhr: pyRound(rhr, 1),
      sleep_hours: pyRound(Math.max(hours, 4.0), 2),
      sleep_score: pyRound(Math.max(40.0, Math.min(95.0, 78.0 + rng.gauss(0, 9))), 0),
    });
  }

  // Garmin's own estimates. Generated by perturbing our numbers rather than
  // inventing free-standing ones, so the comparison page shows the realistic
  // case: two methods that mostly agree and disagree in one specific place.
  const metrics = [];
  const summary = summarise(activities, today);
  if (summary && summary.fit) {
    const theirRaces = {};
    for (const distance of [5000, 10000, 21097, 42195]) {
      const projected = projectRace(summary, distance);
      if (!projected) continue;
      // Garmin leans optimistic at longer distances, which is the bias the
      // validation literature reports and the thing worth showing.
      const optimism = 1.0 - 0.012 * (distance / 21097.0);
      theirRaces[String(distance)] = projected.seconds * optimism;
    }
    metrics.push({
      day: todayKey,
      threshold_hr: (summary.threshold_hr || 170) - 4,
      // Not simply our own number handed back: seeding it identical would
      // make the comparison agree by construction and prove nothing. The
      // validation literature has Garmin's wrist-based threshold reading
      // slow, so the demo shows it a few per cent slow.
      threshold_speed_m_s: summary.threshold_pace ? 1000.0 / (summary.threshold_pace * 1.04) : null,
      vo2max: 52.0,
      endurance_score: 7100.0,
      hill_score: 68.0,
      races: theirRaces,
    });
  }

  const payload = { activities, daily, wellness, metrics, gear: SHOES.map(g => ({ ...g })), personalRecords: [] };
  cache = { key, value: { payload, runs, today, todayKey } };
  return cache.value;
}

// A course from a run's own track, as save_course() stored it.
function courseFrom(thin, addedAt) {
  const points = thin.filter(x => x.length > 4 && x[3] != null).map(x => [x[3], x[4], x.length > 5 ? x[5] : null]);
  if (points.length <= 2) return null;
  const stats = courseStats(points);
  if (!stats) return null;
  // ponytail: thinned to ~2000 points. Plenty for gradients at 1 km grain, and
  // it keeps a marathon GPX from becoming a megabyte of JSON per race.
  const step = Math.max(Math.floor(points.length / 2000), 1);
  const thinned = [];
  for (let i = 0; i < points.length; i += step) {
    const p = points[i];
    thinned.push([pyRound(p[0], 6), pyRound(p[1], 6), p[2] != null ? pyRound(p[2], 1) : null]);
  }
  return { source: 'activity', points: thinned, length_m: stats.length_m, climb_m: stats.climb_m,
    drop_m: stats.drop_m, added_at: addedAt };
}

// The demo athlete as a garmin-output payload, for ingest.importGarmin().
export function demoGarminPayload(now = new Date()) {
  return structuredClone(build(now).payload);
}

// What Garmin does not hold: the athlete's races (and their courses), keyed by id
// for the synced collections. The demo seeded no routes, reviews or trail areas.
export function demoExtras(now = new Date()) {
  const { runs, today } = build(now);
  const created = isoLocal(new Date(now));
  const races = {};
  let id = 0;
  const add = rec => {
    id += 1;
    const rid = 'demo-race-' + id;
    races[rid] = { id: rid, goal_s: null, predicted_s: null, actual_s: null, garmin_id: null, ...rec, created_at: created };
    return races[rid];
  };
  for (const [name, weeks, dist, goal] of [['Autumn Half', 7, 21097.0, 5400.0],
    ['City Marathon', 16, 42195.0, 11700.0], ['Club 10K', 3, 10000.0, 2340.0]])
    add({ name, date: dayKey(addDays(today, 7 * weeks)), distance_m: dist, goal_s: goal });
  for (const [name, weeksAgo, dist, predicted, actual] of [['Spring 10K', 14, 10000.0, 2520.0, 2551.0],
    ['Riverside Half', 8, 21097.0, 5760.0, 5842.0]])
    add({ name, date: dayKey(addDays(today, -7 * weeksAgo)), distance_m: dist, predicted_s: predicted, actual_s: actual });

  // A race that actually happened, so the postmortem has something to read: the
  // most recent flat-out 5 km becomes a race, with its own track as the course.
  const fives = runs.filter(r => r.act.distance_m >= 4900 && r.act.distance_m <= 5100);
  const parkrun = fives[fives.length - 1];
  if (parkrun) {
    const mv = parkrun.act.moving_s;
    const race = add({ name: 'Club parkrun', date: parkrun.start.slice(0, 10), distance_m: 5000.0,
      goal_s: pyRound(mv - 12), predicted_s: pyRound(mv + 8), actual_s: pyRound(mv), garmin_id: parkrun.act.garmin_id });
    const course = courseFrom(parkrun.thin, created);
    if (course) race.course = course;
  }

  // And a course on an upcoming race, so the plan has ground to work with.
  let longRun = null;
  for (const r of runs)
    if (r.act.distance_m > 15000 && (!longRun || Math.abs(r.act.distance_m - 21097) < Math.abs(longRun.act.distance_m - 21097))) longRun = r;
  if (longRun) {
    const course = courseFrom(longRun.thin, created);
    if (course) races['demo-race-1'].course = course;
  }
  return { races, routes: {}, reviews: {}, trailAreas: {} };
}
