// What app.py used to work out from SQLite, worked out from the state instead. Pages
// read through here; nothing here touches the DOM.
//
// Two layers:
//   deriveActivity()  reads one activity's stream ONCE, on the device that has it (the
//                     desktop that imported it), and keeps what the analysis found --
//                     best efforts, reps, stops, tiles, zones, durability, climbing -- in
//                     state.derived, which syncs. So the phone gets every number without
//                     ever downloading a stream.
//   everything else   aggregates state.activities + state.derived, synchronously.
import * as F from './lib/fitness.js';
import * as Z from './lib/zones.js';
import * as IV from './lib/intervals.js';
import * as ST from './lib/stops.js';
import * as TR from './lib/territory.js';
import * as RP from './lib/repeats.js';
import * as DU from './lib/durability.js';
import * as TE from './lib/terrain.js';
import * as RV from './lib/recovery.js';
import * as VI from './lib/vitals.js';
import * as WX from './lib/weather.js';
import * as SO from './lib/secondopinion.js';
import * as LM from './lib/landmarks.js';
import { dayKey, addDayKey, fromDay } from './lib/dt.js';
import { samplesFromChannels } from './ingest.js';
import { put } from './merge.js';
import { getStream, rev } from './store.js';

export const DERIVE_VERSION = 1;
export const DEFAULT_SHOE_LIFE_M = 700000, SHOE_WARN_SHARE = 0.8;
const isRun = a => F.RUN_TYPES.has(a.type);

// One-slot memo per name, invalidated by the store's revision counter -- and by
// deriveActivity, which changes what the memos are built from without a save.
const _memo = new Map();
let _derived = 0;
function memo(name, fn) {
  const key = rev + ':' + _derived, hit = _memo.get(name);
  if (hit && hit.key === key) return hit.value;
  const value = fn();
  _memo.set(name, { key, value });
  return value;
}

// ---- loaders ----
// Activities as the analysis modules expect them: `start` a Date, newest first.
export const activities = st => memo('acts', () => Object.values(st.activities)
  .map(a => ({ ...a, start: new Date(a.start) }))
  .sort((a, b) => b.start - a.start));
export const runs = st => activities(st).filter(isRun);
export const samplesOf = rec => (rec && rec.channels ? samplesFromChannels(rec.channels) : []);

// Best efforts measured inside activities: [[distance, seconds, age_days]].
export function segmentEfforts(st, now) {
  const out = [], today = dayKey(now);
  for (const [id, d] of Object.entries(st.derived)) {
    const a = st.activities[id];
    if (!a || !d.efforts) continue;
    const age = Math.round((fromDay(today) - fromDay(a.start.slice(0, 10))) / 864e5);
    for (const [dist, secs] of Object.entries(d.efforts)) out.push([+dist, secs, age]);
  }
  return out;
}
// [[distance, seconds, 'YYYY-MM-DD', activity id]] for every stored effort.
export function prRows(st) {
  const out = [];
  for (const [id, d] of Object.entries(st.derived)) {
    const a = st.activities[id];
    if (a && d.efforts) for (const [dist, secs] of Object.entries(d.efforts)) out.push([+dist, secs, a.start.slice(0, 10), id]);
  }
  return out;
}
export const personalRecords = st => memo('prs', () => F.personalRecords(prRows(st)));

export function summary(st, now = new Date()) {
  return memo('summary', () => {
    const acts = activities(st);
    return acts.length ? F.summarise(acts, now, segmentEfforts(st, now)) : null;
  });
}

// ---- races ----
export const races = st => Object.values(st.races).sort((a, b) => String(a.date).localeCompare(String(b.date)));
export function results(st) {
  return races(st).filter(r => r.actual_s && r.predicted_s).map(r => [r.predicted_s, r.actual_s, r.date]);
}
export const calibration = (st, now = new Date()) => F.calibration(results(st), dayKey(now));
// A race's projection, calibrated against how the athlete has raced before.
export function projection(st, race, now = new Date()) {
  const s = summary(st, now);
  if (!s) return null;
  return F.applyCalibration(F.projectRace(s, race.distance_m, race.date, dayKey(now)), calibration(st, now));
}

// ---- per-activity derivation ----
export function limits(st) {
  let hrMax = null;
  for (const a of Object.values(st.activities)) if (a.max_hr && (!hrMax || a.max_hr > hrMax)) hrMax = a.max_hr;
  const fit = DU.criticalSpeed(personalRecords(st).map(([d, s]) => [d, s]));
  return { hr_max: hrMax, cs: fit ? fit[0] : null, d_prime: fit ? fit[1] : null };
}
// Places the athlete stops on run after run: crossings, learned from their own history.
export function junctions(st) {
  return memo('junctions', () => ST.junctionTiles(
    Object.values(st.derived).filter(d => d.stops && d.stops.interruptions).map(d => d.stops.interruptions), 3));
}

export async function deriveActivity(st, id, ctx = {}) {
  const a = st.activities[id];
  const rec = await (ctx.getStream || getStream)(id);
  if (!a || !rec) return null;
  const samples = samplesOf(rec);
  if (samples.length < 2) return null;
  const run = isRun(a);
  const td = samples.map(s => [s[0], s[1]]);
  const pts = samples.filter(s => s[3] != null && s[4] != null).map(s => [s[3], s[4]]);
  const thrHr = ctx.thrHr !== undefined ? ctx.thrHr : summary(st)?.threshold_hr;
  const lim = ctx.limits || limits(st);
  const temp = st.weather[id]?.temp_c ?? null;
  const hasHr = samples.some(s => s[2]);
  const d = {
    v: DERIVE_VERSION,
    efforts: run ? F.bestEffortCurve(td) : {},
    splits: run ? F.kmSplits(td) : [],
    drift: hasHr ? F.hrDrift(samples.map(s => [s[0], s[1], s[2]])) : null,
    tiles: pts.length ? TR.tilesForTrack(pts) : [],
    sig: run && pts.length >= 10 && (a.distance_m || 0) > 1000 ? RP.signature(pts) : null,
    session: run ? IV.analyse(samples.map(s => [s[0], s[1], s[2]]), pts) : null,
    stops: run ? ST.analyse(samples, ctx.junctions || junctions(st)) : null,
    climb: run && (a.elev_gain_m || 0) > 50 ? TE.climbCost(samples) : null,
    zones: thrHr && hasHr ? { thr: thrHr, secs: Z.timeInZones(samples, thrHr) } : null,
    durability: null, limits: lim,
    points: pts.length ? thinTrack(pts, 400) : null,   // enough to draw the route on the phone
  };
  if (run && lim.hr_max && lim.cs && (a.distance_m || 0) >= DU.MIN_DISTANCE_M && (a.moving_s || 0) >= DU.MIN_DURATION_S)
    d.durability = DU.analyse(samples, lim.hr_max, lim.cs, temp);
  put(st, 'derived', id, d);
  _derived++;
  return d;
}
// Every n-th point, so a map line stays light enough to sync.
function thinTrack(pts, max) {
  if (pts.length <= max) return pts.map(([la, lo]) => [+la.toFixed(5), +lo.toFixed(5)]);
  const step = pts.length / max, out = [];
  for (let i = 0; i < max; i++) { const [la, lo] = pts[Math.floor(i * step)]; out.push([+la.toFixed(5), +lo.toFixed(5)]); }
  out.push(pts[pts.length - 1].map(v => +v.toFixed(5)));
  return out;
}

// Re-derive everything that has a stream on this device. Two passes, as rescan_stops did:
// whether a stop is a crossing depends on how often the athlete stops there, which is
// only knowable once every run has been read.
export async function deriveAll(st, ids, onProgress, opts = {}) {
  const ctx = { thrHr: summary(st)?.threshold_hr, limits: limits(st), getStream: opts.getStream };
  let n = 0;
  for (const id of ids) { await deriveActivity(st, id, ctx); onProgress && onProgress(++n, ids.length * 2); }
  ctx.junctions = ST.junctionTiles(Object.values(st.derived).filter(d => d.stops).map(d => d.stops.interruptions || []), 3);
  ctx.limits = limits(st);   // efforts from pass one feed critical speed
  for (const id of ids) { await deriveActivity(st, id, ctx); onProgress && onProgress(++n, ids.length * 2); }
  return n / 2;
}

// ---- aggregates over the derived results ----
export function trainingCalendar(daily, today, weeks = 26) {
  const t = dayKey(today), monday = addDayKey(t, -((fromDay(t).getDay() + 6) % 7)), out = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const start = addDayKey(monday, -7 * w);
    out.push([start, Array.from({ length: 7 }, (_, i) => { const d = addDayKey(start, i); return [d, daily[d] || 0]; })]);
  }
  return out;
}

export function zoneSummary(st, thrHr, weeks = 12, now = new Date()) {
  if (!thrHr) return null;
  const cutoff = addDayKey(dayKey(now), -7 * (weeks + 1));
  const rows = [];
  for (const a of Object.values(st.activities)) {
    const d = st.derived[a.id];
    if (!d || !d.zones || a.start.slice(0, 10) < cutoff) continue;
    rows.push([a.start.slice(0, 10), d.zones.secs]);
  }
  if (!rows.length) return null;
  // Same weekly bucketing as zones.weeklyZones, from stored per-activity seconds.
  const end = dayKey(now), endMonday = addDayKey(end, -((fromDay(end).getDay() + 6) % 7));
  const weekly = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const start = addDayKey(endMonday, -7 * w), stop = addDayKey(start, 7), b = {};
    for (const [z] of Z.ZONE_BANDS) b[z] = 0;
    for (const [day, secs] of rows) if (day >= start && day < stop) for (const [z, s] of Object.entries(secs)) b[z] = (b[z] || 0) + (s || 0);
    weekly.push([start, b]);
  }
  const total = {};
  for (const [, b] of weekly) for (const [z, s] of Object.entries(b)) total[z] = (total[z] || 0) + s;
  if (!Object.values(total).some(Boolean)) return null;
  return { ...Z.polarisation(total), weekly, total, index: Z.polarisationIndex(total), zones: Z.ZONES };
}

export function readinessToday(st, tsb = null) {
  const days = Object.keys(st.wellness).sort();
  if (!days.length) return tsb != null ? RV.readiness({ tsb }) : null;
  const rows = days.map(d => ({ day: d, ...st.wellness[d] }));
  const hrv = rows.filter(r => r.hrv_ms).map(r => r.hrv_ms), rhr = rows.filter(r => r.rhr).map(r => r.rhr);
  const latest = rows[rows.length - 1];
  const result = RV.readiness({ hrv: latest.hrv_ms ?? null, rhr: latest.rhr ?? null, sleep_hours: latest.sleep_hours ?? null,
    sleep_score: latest.sleep_score ?? null, tsb, baselines: { hrv: hrv.length ? RV.baseline(hrv) : null, rhr: rhr.length ? RV.baseline(rhr) : null } });
  if (result) {
    Object.assign(result, { day: latest.day, nights: rows.length, latest,
      hrv_trend: hrv.length > 3 ? RV.trend(hrv.slice(-14)) : null, rhr_trend: rhr.length > 3 ? RV.trend(rhr.slice(-14)) : null });
    result.advice = RV.advice(result);
  }
  return result;
}

export function heatState(st, now = new Date(), days = 60) {
  const cutoff = addDayKey(dayKey(now), -days), rows = [];
  for (const a of Object.values(st.activities)) {
    const wx = st.weather[a.id];
    if (isRun(a) && wx && wx.temp_c != null && a.start.slice(0, 10) >= cutoff) rows.push([new Date(a.start), wx.temp_c, (a.moving_s || 0) / 60]);
  }
  return rows.length ? WX.heatExposure(rows, dayKey(now)) : null;
}

// The daily sweep joined with the overnight numbers: [[day, {metric: value}]].
export function dailyRows(st, days = 180, now = new Date()) {
  const cutoff = addDayKey(dayKey(now), -days), merged = {};
  for (const [d, row] of Object.entries(st.daily)) if (d >= cutoff) {
    const o = {}; for (const [k, v] of Object.entries(row)) if (k !== 'u' && v != null) o[k] = v; merged[d] = o;
  }
  for (const [d, row] of Object.entries(st.wellness)) if (d >= cutoff) {
    const o = merged[d] || (merged[d] = {});
    for (const k of ['hrv_ms', 'rhr', 'sleep_hours', 'sleep_score']) if (row[k] != null) o[k] = row[k];
  }
  return Object.keys(merged).sort().filter(d => Object.keys(merged[d]).length).map(d => [d, merged[d]]);
}
// Minutes of running per calendar day.
export function trainingLoadByDay(st, days = 180, now = new Date()) {
  const cutoff = addDayKey(dayKey(now), -days), out = {};
  for (const a of Object.values(st.activities)) if (isRun(a) && a.start.slice(0, 10) >= cutoff) {
    const d = a.start.slice(0, 10); out[d] = (out[d] || 0) + (a.moving_s || 0) / 60;
  }
  return out;
}
// Which per-sample channels this athlete's watches actually record (from the streams on this device).
export function vitalsReport(st, coverage = []) {
  const daily = dailyRows(st);
  if (daily.length < VI.MIN_POINTS) return null;
  const tracked = [...new Set(daily.flatMap(([, r]) => Object.keys(r)))].sort();
  const trends = tracked.map(n => VI.trend(daily, n)).filter(Boolean).sort((a, b) => Math.abs(b.z || 0) - Math.abs(a.z || 0));
  return { days: daily.length, metrics: tracked.length, correlations: VI.correlate(daily, trainingLoadByDay(st)),
    sleep: VI.sleepArchitecture(daily), trends: trends.slice(0, 10), odd_days: VI.oddDays(daily).slice(0, 6), coverage };
}

export function durabilityRuns(st, limit = 40) {
  const lim = limits(st), out = [];
  for (const a of runs(st)) {
    const d = st.derived[a.id];
    if (!d || !d.durability) continue;
    out.push({ ...d.durability, id: a.id, name: a.name, start: a.start });
    if (out.length >= limit) break;
  }
  return [out, lim];
}

export function climbing(st, now = new Date(), days = 180) {
  const cutoff = addDayKey(dayKey(now), -days);
  const recent = runs(st).filter(a => dayKey(a.start) >= cutoff);
  const ascent = recent.reduce((s, a) => s + (a.elev_gain_m || 0), 0);
  const costs = [], hilliest = [];
  for (const a of [...recent].sort((x, y) => (y.elev_gain_m || 0) - (x.elev_gain_m || 0))) {
    const c = st.derived[a.id]?.climb;
    if (!c) continue;
    costs.push(c);
    if (hilliest.length < 8) hilliest.push({ name: a.name, id: a.id, start: a.start, distance_m: a.distance_m,
      ascent_m: a.elev_gain_m, factor: c.factor, terrain: TE.terrainRatio(a.moving_s, a.distance_m, a.elev_gain_m) });
  }
  return { ascent_m: ascent, runs: recent.length, days, landmark: LM.compare(ascent), next_up: LM.nextUp(ascent),
    ladder: LM.ladder(ascent).filter(r => r.cleared).slice(0, 5), profile: TE.profile(costs), hilliest };
}

export function tileSummary(st, now = new Date()) {
  const visits = new Map(), first = new Map();
  for (const a of Object.values(st.activities)) {
    const tiles = st.derived[a.id]?.tiles;
    if (!tiles) continue;
    const day = a.start.slice(0, 10);
    for (const t of tiles) {
      const k = TR.tileKey(t[0], t[1]);
      visits.set(k, (visits.get(k) || 0) + 1);
      if (!first.has(k) || day < first.get(k)) first.set(k, day);
    }
  }
  if (!visits.size) return null;
  const tiles = [...visits.keys()].map(k => k.split(',').map(Number));
  const s = TR.stats(tiles), today = dayKey(now);
  const weekAgo = addDayKey(today, -7), monthAgo = addDayKey(today, -30);
  s.this_week = [...first.values()].filter(d => d >= weekAgo).length;
  s.this_month = [...first.values()].filter(d => d >= monthAgo).length;
  s.home = TR.homeTile(Object.fromEntries(visits));
  s.coverage = TR.areaCoverage(tiles, s.home);
  s.targets = TR.squareGrowthTargets(tiles);
  s.tiles = tiles.length; s.tile_set = tiles; s.visits = visits; s.first_seen = first;
  return s;
}

export function repeatedRoutes(st, now = new Date(), days = 365, minRepeats = 3) {
  const cutoff = addDayKey(dayKey(now), -days);
  const rs = runs(st).filter(a => dayKey(a.start) >= cutoff && st.derived[a.id]?.sig)
    .map(a => ({ id: a.id, garmin_id: a.id, name: a.name, start: a.start, distance_m: a.distance_m, moving_s: a.moving_s, tiles: st.derived[a.id].sig }))
    .reverse();   // oldest first, as the SQL ordered them
  return RP.summarise(rs, minRepeats);
}

export function gearTable(st) {
  const used = {};
  for (const [id, g] of Object.entries(st.activityGear)) {
    const a = st.activities[id];
    if (!a) continue;
    for (const uuid of g.uuids || []) {
      const u = used[uuid] || (used[uuid] = { runs: 0, distance_m: 0, first_used: null, last_used: null });
      u.runs++; u.distance_m += a.distance_m || 0;
      if (!u.first_used || a.start < u.first_used) u.first_used = a.start;
      if (!u.last_used || a.start > u.last_used) u.last_used = a.start;
    }
  }
  return Object.values(st.gear).map(g => {
    const u = used[g.uuid] || { runs: 0, distance_m: 0, first_used: null, last_used: null };
    const limit = g.limit_m || DEFAULT_SHOE_LIFE_M;
    const worn = u.distance_m >= limit;
    return { ...g, ...u, limit_m: limit, share: Math.min(u.distance_m / limit, 1.5), remaining_m: Math.max(limit - u.distance_m, 0),
      worn_out: worn, getting_on: !worn && u.distance_m >= limit * SHOE_WARN_SHARE };
  }).sort((a, b) => (a.retired ? 1 : 0) - (b.retired ? 1 : 0) || b.distance_m - a.distance_m);
}

export function weatherSeasons(st, now = new Date(), days = 400) {
  const cutoff = addDayKey(dayKey(now), -days), rows = [];
  for (const a of Object.values(st.activities)) {
    const w = st.weather[a.id];
    if (w && isRun(a) && a.start.slice(0, 10) >= cutoff && (a.distance_m || 0) > 1500 && a.moving_s > 0)
      rows.push([w.temp_c, a.moving_s / (a.distance_m / 1000), w.humidity, w.dew_point_c]);
  }
  return WX.seasonSummary(rows);
}

export function stopTotals(st, now = new Date(), days = 90) {
  const cutoff = addDayKey(dayKey(now), -days);
  const t = { runs: 0, crossings: 0, rests: 0, climbs: 0, exhaustion: 0, eased: 0, lost_s: 0, stopped_s: 0, fatigue_runs: 0, days };
  for (const a of Object.values(st.activities)) {
    const s = st.derived[a.id]?.stops;
    if (!s || a.start.slice(0, 10) < cutoff) continue;
    const c = s.counts || {};
    t.runs++; t.crossings += c.crossing || 0; t.rests += c.rest || 0; t.climbs += c.climb || 0;
    t.exhaustion += c.exhaustion || 0; t.eased += c.eased || 0; t.lost_s += s.lost_s || 0; t.stopped_s += s.stopped_s || 0;
    if (c.exhaustion) t.fatigue_runs++;
  }
  return t.runs ? t : null;
}

export function latestMetrics(st) {
  const day = Object.keys(st.metrics).sort().pop();
  if (!day) return null;
  const m = st.metrics[day];
  return { ...m, day, races: Object.fromEntries(Object.entries(m.races || {}).map(([k, v]) => [+k, v])) };
}
export function secondOpinion(st, s) {
  const theirs = latestMetrics(st);
  if (!theirs || !s) return null;
  const oursRaces = {};
  for (const dist of Object.keys(theirs.races).map(Number).sort((a, b) => a - b)) {
    const p = F.projectRace(s, dist);
    if (p) oursRaces[dist] = p.seconds;
  }
  const result = SO.review({ threshold_hr: s.threshold_hr, threshold_pace: s.threshold_pace, races: oursRaces },
    { threshold_hr: theirs.threshold_hr, threshold_pace: theirs.threshold_speed_m_s ? 1000 / theirs.threshold_speed_m_s : null, races: theirs.races });
  if (!result.comparisons) return null;
  result.garmin = theirs;
  return result;
}

// What the analysis still lacks, said plainly (the brief and the dashboard both show it).
export function gaps(st, now = new Date()) {
  const out = [], acts = activities(st);
  if (!acts.length) return ['No activities yet: run the garmin or strava cowork channel, or load the demo.'];
  const noStream = runs(st).filter(a => !st.derived[a.id]).length;
  if (noStream) out.push(noStream + ' runs have no per-second stream yet, so no best efforts, reps, stops or durability for them.');
  const lastDaily = Object.keys(st.daily).sort().pop();
  if (!lastDaily) out.push('No daily Garmin data (steps, stress, body battery, sleep stages): vitals is empty.');
  else if (lastDaily < addDayKey(dayKey(now), -3)) out.push('Daily Garmin data stops at ' + lastDaily + '.');
  if (!Object.keys(st.wellness).length) out.push('No overnight HRV / resting HR: readiness falls back to form alone.');
  if (!Object.values(st.activities).some(a => a.strava_id)) out.push('Nothing from Strava yet.');
  if (!Object.keys(st.races).length) out.push('No races on the calendar: projections have nothing to aim at.');
  return out;
}

// ---- the brief: the app's conclusions, for the cowork folder and the coach ----
export function buildBrief(st, now = new Date()) {
  const s = summary(st, now), today = dayKey(now);
  const cal = calibration(st, now);
  const prs = personalRecords(st);
  const rs = races(st).map(r => {
    const p = r.date >= today ? projection(st, r, now) : null;
    const form = p && s ? F.projectForm(s.daily || {}, today, r.date) : null;
    return { name: r.name, date: r.date, distance_m: r.distance_m, goal_s: r.goal_s ?? null, actual_s: r.actual_s ?? null,
      predicted_s: r.predicted_s ?? null, projected_s: p ? p.seconds : null, confidence: p ? p.confidence : null,
      days_to_race: p ? p.days_to_race : null, trend_factor: p ? p.trend_factor : null, form };
  });
  const acts = activities(st);
  return {
    generatedAt: now.toISOString(),
    counts: { activities: acts.length, runs: runs(st).length, withStreams: Object.keys(st.derived).length,
      days: Object.keys(st.daily).length, nights: Object.keys(st.wellness).length,
      strava: acts.filter(a => a.strava_id).length, races: rs.length },
    fitness: s ? { ctl: s.ctl, atl: s.atl, tsb: s.tsb, ctl_6w_ago: s.ctl_6w_ago, threshold_hr: s.threshold_hr,
      threshold_pace_s_per_km: s.threshold_pace, fatigue_exponent: s.fit ? s.fit[1] : null,
      fit_points: s.fit ? s.fit[2].map(([d, t, age]) => ({ distance_m: d, seconds: t, age_days: age })) : [],
      spike: s.spike ? { ratio: s.spike[0], distance_m: s.spike[1], longest_m: s.spike[2], verdict: s.spike[3] } : null } : null,
    weekly: s ? s.weekly.map(([w, km, h, l]) => ({ week: w, km, hours: h, load: l })) : [],
    week: s ? F.weekDigest(acts, now, s.threshold_hr, F.thresholds(acts)[1]) : null,
    paces: s ? s.paces.map(([name, purpose, fast, slow]) => ({ name, purpose, fast_s_per_km: fast, slow_s_per_km: slow })) : [],
    hrZones: s ? s.zones.map(([name, lo, hi]) => ({ name, low: lo, high: hi })) : [],
    standards: s ? F.STANDARD_RACES.map(([label, d]) => { const p = F.projectRace(s, d); return p ? { label, distance_m: d, seconds: F.applyCalibration(p, cal).seconds, confidence: p.confidence } : null; }).filter(Boolean) : [],
    calibration: cal,
    races: rs,
    personalRecords: prs.map(([d, secs, when]) => ({ distance_m: d, seconds: secs, date: when })),
    zones: s ? zoneSummary(st, s.threshold_hr, 12, now) : null,
    readiness: readinessToday(st, s ? s.tsb : null),
    heat: heatState(st, now),
    stops: stopTotals(st, now),
    durability: durabilityRuns(st, 12)[0].map(r => ({ id: r.id, name: r.name, date: dayKey(r.start), ...Object.fromEntries(Object.entries(r).filter(([k]) => !['id', 'name', 'start'].includes(k))) })),
    secondOpinion: secondOpinion(st, s),
    garminMetrics: latestMetrics(st),
    recent: acts.slice(0, 20).map(a => ({ id: a.id, date: dayKey(a.start), name: a.name, type: a.type, km: a.distance_m ? +(a.distance_m / 1000).toFixed(2) : null,
      minutes: a.moving_s ? Math.round(a.moving_s / 60) : null, avg_hr: a.avg_hr, source: a.source, strava: !!a.strava_id })),
    gaps: gaps(st, now),
  };
}

const t = s => F.fmtTime(s), p = (s, m) => F.fmtPace(s, m);
// The brief as prose an agent (or the coach prompt) reads first -- coach._brief's sections.
export function briefMarkdown(b) {
  const L = ['# Run315 — morning brief', '', `Generated ${b.generatedAt}. ${b.counts.activities} activities (${b.counts.runs} runs, ${b.counts.withStreams} with streams), ${b.counts.days} days and ${b.counts.nights} nights of Garmin data, ${b.counts.strava} linked to Strava.`, ''];
  const f = b.fitness;
  L.push('## Training load (TSS-style, exponential averages)');
  if (f) {
    L.push(`- Fitness (CTL, 42 d): **${f.ctl.toFixed(0)}** (6 weeks ago ${f.ctl_6w_ago.toFixed(0)})`, `- Fatigue (ATL, 7 d): ${f.atl.toFixed(0)}`, `- Form (TSB): ${f.tsb >= 0 ? '+' : ''}${f.tsb.toFixed(0)}`);
    if (f.threshold_hr) L.push(`- Estimated threshold HR: ${f.threshold_hr.toFixed(0)} bpm`);
    if (f.threshold_pace_s_per_km) L.push(`- Threshold pace: ${p(f.threshold_pace_s_per_km, 1000)}`);
    if (f.spike) L.push(`- Latest run against the 30-day longest: ${(f.spike.distance_m / 1000).toFixed(1)} km vs ${(f.spike.longest_m / 1000).toFixed(1)} km — ${f.spike.verdict}`);
  } else L.push('- No activities yet.');
  if (b.weekly.length) {
    L.push('', '## Weekly volume (last 12 weeks, oldest first)', '', '| week | km | hours | load |', '|---|---|---|---|');
    for (const w of b.weekly) L.push(`| ${w.week} | ${w.km.toFixed(1)} | ${w.hours.toFixed(1)} | ${w.load.toFixed(0)} |`);
  }
  if (f && f.fit_points.length) {
    L.push('', '## Best efforts driving the model');
    for (const e of f.fit_points) L.push(`- ${(e.distance_m / 1000).toFixed(2)} km in ${t(e.seconds)} (${p(e.seconds, e.distance_m)}, ${e.age_days} days ago)`);
    L.push(`- Fitted fatigue exponent ${f.fatigue_exponent.toFixed(3)} (textbook ${F.RIEGEL}; higher fades more over distance)`);
  }
  if (b.standards.length) {
    L.push('', '## Projections at standard distances (today\'s form' + (b.calibration ? ', calibrated' : '') + ')');
    for (const s of b.standards) L.push(`- ${s.label}: ${t(s.seconds)} (${p(s.seconds, s.distance_m)}, confidence ${s.confidence})`);
  }
  if (b.races.length) {
    L.push('', '## Races');
    for (const r of b.races) {
      const bits = [`${r.name} — ${r.date}, ${(r.distance_m / 1000).toFixed(2)} km`];
      if (r.actual_s) bits.push(`ran ${t(r.actual_s)}`);
      if (r.projected_s) bits.push(`projected ${t(r.projected_s)} (${r.confidence}) in ${r.days_to_race} days`);
      if (r.goal_s) bits.push(`goal ${t(r.goal_s)}`);
      if (r.form) bits.push(`race-day form ${r.form.tsb_no_taper.toFixed(0)} holding load, ${r.form.tsb_with_taper.toFixed(0)} with a ${r.form.taper_days}-day taper`);
      L.push('- ' + bits.join('; '));
    }
  }
  if (b.paces.length) { L.push('', '## Training paces implied by current fitness'); for (const x of b.paces) L.push(`- ${x.name}: ${t(x.fast_s_per_km)}–${p(x.slow_s_per_km, 1000)}`); }
  if (b.personalRecords.length) { L.push('', '## Best efforts measured inside runs'); for (const r of b.personalRecords) L.push(`- ${(r.distance_m / 1000).toFixed(2)} km: ${t(r.seconds)} (${p(r.seconds, r.distance_m)}), ${r.date}`); }
  if (b.zones) L.push('', '## Intensity (12 weeks)', `- ${b.zones.label || ''}: ${b.zones.verdict || ''}`);
  if (b.readiness) L.push('', '## Readiness today', `- ${b.readiness.band || ''} ${b.readiness.score != null ? '(' + Math.round(b.readiness.score) + ')' : ''} — ${b.readiness.advice || ''}`);
  if (b.stops) L.push('', '## Interruptions (90 days)', `- ${b.stops.runs} runs: ${b.stops.crossings} crossings, ${b.stops.rests} rests, ${b.stops.climbs} climbs, ${b.stops.exhaustion} fatigue stops; ${t(b.stops.lost_s)} lost`);
  if (b.durability.length) { L.push('', '## Durability (long runs, newest first)'); for (const r of b.durability.slice(0, 6)) L.push(`- ${r.date} ${r.name}: drift ${r.decoupling != null ? ((r.decoupling - 1) * 100).toFixed(1) + '%' : '--'}${r.verdict ? ' — ' + r.verdict : ''}`); }
  if (b.secondOpinion) L.push('', '## Against Garmin\'s own numbers', '- ' + (b.secondOpinion.summary || b.secondOpinion.comparisons + ' comparisons'));
  L.push('', '## Recent activities');
  for (const a of b.recent.slice(0, 12)) L.push(`- ${a.date} ${a.name} (${a.type.replace(/_/g, ' ')}) ${a.km != null ? a.km + ' km' : ''} ${a.minutes != null ? a.minutes + ' min' : ''}${a.avg_hr ? ' · HR ' + Math.round(a.avg_hr) : ''}`);
  L.push('', '## What is missing');
  for (const g of b.gaps.length ? b.gaps : ['Nothing obvious.']) L.push('- ' + g);
  L.push('', '---', 'Full numbers: `brief.json`. Raw data: `app-export.json`, `data/streams/`.');
  return L.join('\n');
}
