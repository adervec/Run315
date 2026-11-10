// The SQL console's engine: every synced collection laid out as SQLite tables, so the athlete
// can ask his own questions without waiting for the agent.
//
// Two halves:
//   buildTables(st)     pure: state -> {name: {columns: [{name, type}], rows: [[...]]}}. Node-tested.
//   load/open/run       the browser part: sql.js (SQLite compiled to wasm), fetched lazily the
//                       first time the console runs a query, and a database rebuilt from the
//                       state only when a query runs after the data changed (store `rev`).
//
// Why sql.js and not DuckDB-wasm: DuckDB is the better analytical engine, but it is a ~30 MB
// download in a worker with an async API, for a database of a few thousand rows that SQLite
// answers in milliseconds. sql.js is ~700 KB, synchronous, and every SQLite feature the
// questions need (window functions, CTEs, date functions, json_*) is in it.
//
// Every table is a scratch copy: a DROP or UPDATE in the console changes the copy, never the
// state, and the next rebuild (or "Reset") puts it back.
import { state as liveState, rev as liveRev, getStream } from './store.js';
import * as D from './derive.js';
import * as F from './lib/fitness.js';
import { dayKey, isoLocal, weekStart } from './lib/dt.js';
import { samplesFromChannels } from './ingest.js';
import { normTag } from './journal.js';

// Pinned: 1.14.2 (Aug 2026). The 1.15 line was three releases in twelve days in Oct 2026 and the
// newest is under two weeks old -- the patch release of the line before is the settled one.
export const SQLJS_VERSION = '1.14.2';
// Vendored from cdnjs into static/vendor/sql.js; the hashes below still pin the exact bytes.
export const SQLJS_BASE = new URL('../static/vendor/sql.js/', import.meta.url).href;
// Subresource integrity of sql-wasm.js (identical bytes on cdnjs and jsDelivr).
export const SQLJS_SRI = 'sha384-7Zym2PlgXfg8ap8cqJUwlZrLl+VEwt0NVbzYfhH28IWLnSpAgQOnSCY2+EXo5MtM';
export const MAX_ROWS = 2000;            // rows the page draws; the count says how many there were
export const MAX_SAMPLE_ACTIVITIES = 30; // ~9,000 rows each: 30 is ~270k rows, a few tens of MB in SQLite

// ---- the tables ----
const isNum = v => typeof v === 'number' && isFinite(v);
const num = v => (isNum(v) ? v : null);
const r = (v, dp = 1) => (isNum(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);
// A key as a column name you can type without quotes: "5000" -> "d5000", "Body Battery" -> "body_battery".
export const colName = k => { const s = String(k).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, ''); return /^[0-9]/.test(s) ? 'd' + s : s || 'col'; };
// A value SQLite can hold: booleans as 0/1, objects and arrays as JSON text (json_extract reads them).
function cell(v) {
  if (v == null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
// Declared type from the values: INTEGER when every value is a whole number, REAL when numeric, else TEXT.
function typeOf(vals) {
  let seen = false, int = true;
  for (const v of vals) {
    if (v == null) continue;
    if (typeof v !== 'number') return 'TEXT';
    seen = true; if (!Number.isInteger(v)) int = false;
  }
  return !seen ? 'TEXT' : int ? 'INTEGER' : 'REAL';
}
// Objects (one per row) -> a table. `first` fixes the leading columns (always present, in that
// order); every other key any record has follows alphabetically, so a new Garmin field shows up
// as a column without a code change.
export function table(objs, first = [], skip = ['u']) {
  const keys = new Set(first);
  const extra = new Set();
  for (const o of objs) for (const k of Object.keys(o)) if (!keys.has(k) && !skip.includes(k)) extra.add(k);
  const names = [...first, ...[...extra].sort()];
  const rows = objs.map(o => names.map(k => cell(o[k])));
  const columns = names.map((name, i) => ({ name: colName(name), type: typeOf(rows.map(row => row[i])) }));
  // Two keys that sanitise to one name (rare): the later gets a suffix rather than a clash.
  const used = new Map();
  for (const c of columns) { const n = used.get(c.name) || 0; used.set(c.name, n + 1); if (n) c.name += '_' + (n + 1); }
  return { columns, rows };
}
const prefixed = (o, p) => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [p + k, v]));

function activitiesTable(st) {
  const acts = D.activities(st);
  const [thrHr, thrSpd] = F.thresholds(acts);
  return table(acts.map(a => {
    const local = typeof st.activities[a.id]?.start === 'string' ? st.activities[a.id].start.slice(0, 19) : isoLocal(a.start);
    const sv = a.strava || {};
    const run = F.RUN_TYPES.has(a.type);
    return {
      id: a.id, source: a.source, garmin_id: a.garmin_id ?? null, strava_id: a.strava_id ?? null, name: a.name, type: a.type,
      is_run: run, is_virtual: D.isVirtual(a), start: local, day: local.slice(0, 10), week: weekStart(a.start),
      year: +local.slice(0, 4), hour: +local.slice(11, 13),
      distance_m: num(a.distance_m), moving_s: num(a.moving_s), elapsed_s: num(a.elapsed_s),
      pace_s_per_km: run && a.distance_m > 0 && a.moving_s > 0 ? r(a.moving_s / a.distance_m * 1000) : null,
      avg_hr: num(a.avg_hr), max_hr: num(a.max_hr), elev_gain_m: r(a.elev_gain_m), calories: num(a.calories),
      load: r(F.activityLoad(a, thrHr, thrSpd)), hr_load_factor: r(a.hr_load_factor, 3), power_tss: num(a.power_tss),
      suffer_score: num(a.suffer_score), kudos: num(a.kudos), strava_name: a.strava_name ?? null,
      strava_distance_m: num(sv.distance_m), strava_moving_s: num(sv.moving_s), strava_elapsed_s: num(sv.elapsed_s),
      strava_elev_gain_m: num(sv.elev_gain_m), strava_avg_hr: num(sv.avg_hr), strava_max_hr: num(sv.max_hr),
      strava_calories: num(sv.calories), strava_avg_watts: num(sv.avg_watts), strava_device: sv.device ?? null,
    };
  }), ACTIVITY_COLS);
}
const ACTIVITY_COLS = ['id', 'source', 'garmin_id', 'strava_id', 'name', 'type', 'is_run', 'is_virtual', 'start', 'day', 'week', 'year', 'hour',
  'distance_m', 'moving_s', 'elapsed_s', 'pace_s_per_km', 'avg_hr', 'max_hr', 'elev_gain_m', 'calories', 'load', 'hr_load_factor', 'power_tss',
  'suffer_score', 'kudos', 'strava_name', 'strava_distance_m', 'strava_moving_s', 'strava_elapsed_s', 'strava_elev_gain_m', 'strava_avg_hr',
  'strava_max_hr', 'strava_calories', 'strava_avg_watts', 'strava_device'];

// The slim derived core, one row per activity: summaries only (the stop coordinates, tile list
// and route signature stay out -- counts of them are in).
const DERIVED_COLS = ['activity_id', 'v', 'virtual', 'drift_pct', 'hr_load_factor', 'tiles',
  'session_count', 'session_name', 'session_work_s', 'session_work_m', 'session_avg_pace_s_per_km', 'session_fastest_s_per_km',
  'session_slowest_s_per_km', 'session_consistency', 'session_fade', 'session_avg_recovery_s', 'session_on_track', 'session_uniform',
  'stops_count', 'stops_lost_s', 'stops_stopped_s', 'stops_fatigue_count', 'stops_first_fatigue_m',
  'dur_decoupling', 'dur_band', 'dur_onset_m', 'dur_early_ratio', 'dur_late_ratio', 'dur_intensity', 'dur_hot', 'dur_temperature_c',
  'climb_factor', 'climb_flat_speed_m_s', 'climb_segments', 'climb_flat_segments', 'climb_mean_grade',
  'zone_thr_hr', 'z1_s', 'z2_s', 'z3_s', 'z4_s', 'z5_s',
  'power_s', 'power_np_w', 'power_avg_w', 'power_max_w', 'power_vi', 'power_kj', 'power_decoupling'];
function derivedTable(st) {
  return table(Object.entries(st.derived).filter(([id]) => st.activities[id]).map(([id, d]) => {
    const s = d.session, so = d.stops, du = d.durability, c = d.climb, z = d.zones, p = d.power;
    return {
      activity_id: id, v: d.v ?? null, virtual: !!d.virtual, drift_pct: r(d.drift, 2), hr_load_factor: r(d.hrf, 3), tiles: (d.tiles || []).length,
      session_count: s?.count ?? null, session_name: s?.name ?? null, session_work_s: r(s?.work_s), session_work_m: r(s?.work_m),
      session_avg_pace_s_per_km: r(s?.avg_pace), session_fastest_s_per_km: r(s?.fastest), session_slowest_s_per_km: r(s?.slowest),
      session_consistency: r(s?.consistency, 4), session_fade: r(s?.fade, 4), session_avg_recovery_s: r(s?.avg_recovery_s),
      session_on_track: s ? !!s.on_track : null, session_uniform: s ? !!s.uniform : null,
      stops_count: so?.count ?? null, stops_lost_s: num(so?.lost_s), stops_stopped_s: num(so?.stopped_s),
      stops_fatigue_count: so?.fatigue_count ?? null, stops_first_fatigue_m: num(so?.first_fatigue_m),
      ...prefixed(so?.counts, 'stops_'),
      dur_decoupling: r(du?.decoupling, 3), dur_band: du?.band ?? null, dur_onset_m: r(du?.onset_m), dur_early_ratio: r(du?.early_ratio, 3),
      dur_late_ratio: r(du?.late_ratio, 3), dur_intensity: r(du?.intensity, 3), dur_hot: du ? !!du.hot : null, dur_temperature_c: num(du?.temperature_c),
      climb_factor: r(c?.factor, 3), climb_flat_speed_m_s: r(c?.flat_speed, 3), climb_segments: c?.climb_segments ?? null,
      climb_flat_segments: c?.flat_segments ?? null, climb_mean_grade: r(c?.mean_climb_grade, 4),
      zone_thr_hr: z?.thr ?? null, ...Object.fromEntries([1, 2, 3, 4, 5].map(i => ['z' + i + '_s', r(z?.secs?.['Z' + i])])),
      power_s: p?.s ?? null, power_np_w: p?.np ?? null, power_avg_w: p?.avg ?? null, power_max_w: p?.max ?? null,
      power_vi: p?.vi ?? null, power_kj: p?.kj ?? null, power_decoupling: p?.decoupling ?? null,
    };
  }), DERIVED_COLS);
}

// state.journal: activity entries carry the activity's day; day entries are keyed by it.
function journalRows(st) {
  return Object.entries(st.journal).map(([id, j]) => {
    const act = st.activities[id];
    const isDay = j.kind === 'day' || /^\d{4}-\d{2}-\d{2}$/.test(id);
    return { id, kind: isDay ? 'day' : 'activity', activity_id: isDay ? null : id,
      day: isDay ? id : act && typeof act.start === 'string' ? act.start.slice(0, 10) : null,
      rpe: num(j.rpe), feel: num(j.feel), note: j.note || null, tags: (j.tags || []).map(normTag).join(','), _tags: j.tags || [] };
  });
}

const byDay = coll => Object.entries(coll).map(([d, v]) => ({ day: d, ...v }));

// Every table, built from the state. Small: a decade is ~3k activities and ~3k days.
export function buildTables(st = liveState) {
  const jr = journalRows(st);
  const gearUse = Object.fromEntries(D.gearTable(st).map(g => [g.uuid, g]));
  return {
    activities: activitiesTable(st),
    daily: table(byDay(st.daily), ['day']),
    wellness: table(byDay(st.wellness), ['day', 'hrv_ms', 'rhr', 'sleep_hours', 'sleep_score']),
    weather: table(Object.entries(st.weather).map(([id, w]) => ({ activity_id: id, ...w })),
      ['activity_id', 'temp_c', 'humidity', 'dew_point_c', 'wind_kph', 'conditions']),
    laps: table(Object.entries(st.laps).flatMap(([id, l]) => (l.laps || []).map((x, i) => ({ activity_id: id, lap: x.index ?? i + 1, ...x }))),
      ['activity_id', 'lap', 'distance_m', 'duration_s', 'avg_hr', 'max_hr', 'avg_speed', 'elev_gain_m', 'avg_cadence', 'avg_power'], ['u', 'index']),
    gear: table(Object.values(st.gear).map(g => {
      const u = gearUse[g.uuid] || {};
      return { ...g, used_runs: u.runs ?? 0, used_m: r(u.distance_m ?? 0, 0),
        first_used: u.first_used ? dayKey(u.first_used) : null, last_used: u.last_used ? dayKey(u.last_used) : null };
    }), ['uuid', 'name', 'brand', 'model', 'type', 'retired', 'limit_m', 'used_runs', 'used_m', 'first_used', 'last_used']),
    activity_gear: table(Object.entries(st.activityGear).filter(([id]) => st.activities[id])
      .flatMap(([id, g]) => (g.uuids || []).map(uuid => ({ activity_id: id, gear_uuid: String(uuid) }))), ['activity_id', 'gear_uuid'], ['u']),
    journal: table(jr, ['id', 'kind', 'activity_id', 'day', 'rpe', 'feel', 'note', 'tags'], ['u', '_tags']),
    journal_tags: table(jr.flatMap(j => j._tags.map(t => ({ journal_id: j.id, activity_id: j.activity_id, day: j.day, tag: normTag(t) }))),
      ['journal_id', 'activity_id', 'day', 'tag']),
    races: table(Object.values(st.races).map(rc => ({ ...rc, activity_id: rc.garmin_id && st.activities['g' + rc.garmin_id] ? 'g' + rc.garmin_id : null })),
      ['id', 'name', 'date', 'distance_m', 'goal_s', 'predicted_s', 'actual_s', 'garmin_id', 'activity_id'], ['u', 'course']),
    efforts: table(D.prRows(st).map(([d, s, day, id]) => ({ activity_id: id, day, distance_m: d, seconds: r(s), pace_s_per_km: r(s / d * 1000) })),
      ['activity_id', 'day', 'distance_m', 'seconds', 'pace_s_per_km']),
    derived: derivedTable(st),
    segments: table(Object.values(st.segmentEfforts), ['id', 'segment_id', 'segment_name', 'activity_id', 'start_date_local',
      'distance', 'elapsed_time', 'moving_time', 'pr_rank', 'avg_hr', 'avg_watts', 'grade']),
    metrics: table(byDay(st.metrics).map(({ races, ...m }) => ({ ...m, ...Object.fromEntries(Object.entries(races || {}).map(([d, s]) => ['race_' + d + '_s', r(s)])) })),
      ['day', 'threshold_hr', 'threshold_speed_m_s', 'vo2max']),
    experiments: table(Object.values(st.experiments).map(e => ({ ...e, metrics: Array.isArray(e.metrics) ? e.metrics.join(',') : e.metrics })),
      ['id', 'name', 'change', 'start', 'end', 'metrics', 'verdict']),
  };
}
// Views over the tables: the shapes most questions start from.
export const VIEWS = {
  runs: 'SELECT * FROM activities WHERE is_run = 1',
};

// What each table is, and what a column means where its name and unit do not say it.
export const TABLE_NOTES = {
  activities: 'One row per activity (Garmin, Strava, GymTracker). start is local wall-clock time; day/week (Monday)/year/hour come from it. load is the app\'s TSS-style training load; strava_* are Strava\'s own numbers for the same session. View: runs = is_run = 1.',
  daily: 'Garmin\'s daily sweep, one row per day (steps, stress, Body Battery, sleep stages...). Columns follow whatever Garmin sent.',
  wellness: 'Overnight numbers, one row per morning: HRV, resting HR, sleep.',
  weather: 'Conditions at the start of an activity.',
  laps: 'Watch laps (what the lap button or auto-lap recorded).',
  gear: 'Shoes and bikes, with how far each has gone in the activities linked to it (used_m).',
  activity_gear: 'Which gear an activity used (join to gear.uuid).',
  journal: 'Your own words: RPE 1-10, feel 1-5, notes, tags (comma-separated). kind is activity or day.',
  journal_tags: 'One row per journal tag, normalised (lower case, hyphens).',
  races: 'Races and goals: goal, the model\'s prediction and the actual time, in seconds.',
  efforts: 'Best efforts inside each run (from its stream): the fastest seconds over each standard distance.',
  derived: 'What the analysis read out of each stream: intervals (session_*), stops, durability (dur_decoupling 1.28 = 28% more HR per pace late than early), climbing, time in zones (z1_s..z5_s, against zone_thr_hr), power, tiles visited.',
  segments: 'Strava segment efforts (only for activities you asked segments for). distance in metres, times in seconds.',
  metrics: 'Garmin\'s own estimates per day: threshold, VO2max, race predictions (race_<metres>_s).',
  experiments: 'Your N-of-1 experiments.',
  samples: 'Per-second stream rows, loaded on request for chosen activities only (t_s from the start).',
};
const COLUMN_NOTES = {
  rpe: '1-10', feel: '1-5', is_run: '0/1', is_virtual: '0/1 (Zwift, trainer, treadmill)', hour: '0-23, local', week: 'Monday, YYYY-MM-DD',
  start: 'local, YYYY-MM-DDTHH:MM:SS', load: 'TSS-style, an hour at threshold ≈ 100', hr_load_factor: 'HR-trace load over the average-HR load',
  power_tss: 'TSS from power vs eFTP', drift_pct: '% HR rise, second half vs first', climb_factor: '>1: faster on climbs than the energy model expects',
  dur_band: 'low / moderate / high', vo2max: 'ml/kg/min', pr_rank: '1 = your best on the segment', grade: '%', tiles: 'zoom-17 tiles touched',
  sleep_score: '0-100', humidity: '%', tags: 'comma-separated', avg_speed: 'm/s', session_consistency: 'spread of rep paces (lower = more even)',
  session_fade: 'pace change first to last rep (+ = slower)',
};
// The unit a column's name implies (the app's naming rule: the unit is the suffix).
export function unitOf(name) {
  const rules = [[/_s_per_km$/, 's/km'], [/_m_s$|speed/, 'm/s'], [/_ms$/, 'ms'], [/_kg$/, 'kg'], [/_pct$/, '%'], [/_c$/, '°C'],
    [/_kph$/, 'km/h'], [/_w$|watts|power$/, 'W'], [/_kj$/, 'kJ'], [/_spm$/, 'steps/min'], [/_cm$/, 'cm'], [/_hours$/, 'h'], [/(^|_)(hr|rhr|thr_hr)$|_hr$/, 'bpm'],
    [/_s$|^seconds$|_time$/, 's'], [/_m$|^distance$/, 'm'], [/calories/, 'kcal']];
  for (const [re, u] of rules) if (re.test(name)) return u;
  return '';
}
export function describe(tables) {
  return Object.entries(tables).map(([name, t]) => ({
    name, rows: t.rows.length, note: TABLE_NOTES[name] || '',
    columns: t.columns.map(c => ({ ...c, unit: unitOf(c.name), note: COLUMN_NOTES[c.name] || '' })),
  }));
}

// ---- statements (pure: what the loader runs) ----
const q = n => '"' + String(n).replace(/"/g, '""') + '"';
export const createSql = (name, t) => `CREATE TABLE ${q(name)} (${t.columns.map(c => q(c.name) + ' ' + c.type).join(', ')})`;
export const insertSql = (name, t) => `INSERT INTO ${q(name)} VALUES (${t.columns.map(() => '?').join(', ')})`;
// A sql.js Database (or anything with run/prepare) <- the tables, in one transaction.
export function loadTables(db, tables) {
  db.run('BEGIN');
  try {
    for (const [name, t] of Object.entries(tables)) {
      db.run(`DROP TABLE IF EXISTS ${q(name)}`);
      db.run(createSql(name, t));
      if (!t.rows.length) continue;
      const s = db.prepare(insertSql(name, t));
      try { for (const row of t.rows) s.run(row); } finally { s.free(); }
    }
    for (const [name, sql] of Object.entries(VIEWS)) { db.run(`DROP VIEW IF EXISTS ${q(name)}`); db.run(`CREATE VIEW ${q(name)} AS ${sql}`); }
    db.run('COMMIT');
  } catch (e) { try { db.run('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
}

// One activity's stream -> samples rows (with power, which only the channel dict carries).
export const SAMPLE_COLS = ['activity_id', 't_s', 'distance_m', 'hr_bpm', 'lat', 'lon', 'ele_m', 'cadence_spm', 'stride_m', 'gct_ms', 'vosc_cm', 'power_w'];
export function sampleRows(id, rec) {
  if (!rec || !rec.channels) return [];
  const pw = rec.channels.power_w || null;
  return samplesFromChannels(rec.channels).map((s, i) => [id, ...s.map(v => (isNum(v) ? v : null)), pw && isNum(pw[i]) ? pw[i] : null]);
}
export const samplesTable = { columns: SAMPLE_COLS.map(n => ({ name: n, type: n === 'activity_id' ? 'TEXT' : 'REAL' })), rows: [] };
// Activity ids a result names: an `activity_id` column, else an `id` column of activity ids.
export function idsInResult(res, st = liveState) {
  if (!res || !res.columns) return [];
  let i = res.columns.indexOf('activity_id');
  if (i < 0) i = res.columns.indexOf('id');
  if (i < 0) return [];
  return [...new Set(res.rows.map(row => row[i]).filter(v => typeof v === 'string' && st.activities[v]))];
}

// ---- results -> CSV and chart ----
export function toCsv(columns, rows) {
  const f = v => { if (v == null) return ''; const s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return [columns, ...rows].map(row => row.map(f).join(',')).join('\r\n') + '\r\n';
}
const isDateish = v => typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?([T ][\d:]+)?$/.test(v);
// (x, y) or (x, y, series) -> a renderChart spec. A third column that is a number is not a
// series name (it is usually a count): it is left out and the note says so.
export function chartSpec(columns, rows, type = 'line') {
  if (!columns || columns.length < 2) throw new Error('A chart needs at least two columns: x, then y.');
  const ys = rows.filter(row => isNum(row[1]));
  if (!ys.length) throw new Error(`The second column (${columns[1]}) has no numbers to plot.`);
  const xs = ys.map(row => row[0]);
  const xt = xs.every(isNum) ? 'linear' : type !== 'bar' && xs.every(isDateish) ? 'time' : 'category';
  const bySeries = columns.length >= 3 && rows.some(row => row[2] != null && !isNum(row[2]));
  const groups = new Map();
  for (const row of ys) {
    const k = bySeries ? String(row[2] ?? '(none)') : columns[1];
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push([xt === 'time' && /^\d{4}-\d{2}$/.test(row[0]) ? row[0] + '-01' : row[0], row[1]]);
  }
  const ignored = columns.slice(bySeries ? 3 : 2);
  return { type, x: { label: columns[0], type: xt }, y: { label: columns[1], unit: unitOf(columns[1]) },
    series: [...groups].map(([name, points]) => ({ name, points })),
    note: ((ignored.length ? `Not drawn: ${ignored.join(', ')}.` : '') + (ys.length < rows.length ? ` ${rows.length - ys.length} rows without a number left out.` : '')).trim() || undefined };
}

// ---- the starter library ----
// Questions worth asking of this athlete's history; each one runs against the demo in the tests.
export const STARTERS = [
  { name: 'Weekly km, one line per year', sql:
`-- Week of the year (x), km (y), year (series): chart it as a line.
SELECT CAST(strftime('%W', day) AS INTEGER) AS week,
       round(sum(distance_m) / 1000.0, 1)  AS km,
       strftime('%Y', day)                  AS year
FROM runs
GROUP BY year, week
ORDER BY year DESC, week` },
  { name: 'Pace at a fixed heart rate, by month', sql:
`-- Steady runs at 140-150 bpm average: the same effort, so pace is the fitness signal.
-- Change the band to your own easy HR.
SELECT substr(day, 1, 7)                    AS month,
       round(avg(pace_s_per_km))            AS pace_s_per_km,
       count(*)                             AS runs
FROM runs
WHERE avg_hr BETWEEN 140 AND 150 AND distance_m >= 5000 AND is_virtual = 0
GROUP BY month
HAVING runs >= 2
ORDER BY month` },
  { name: 'Best 10 km each year', sql:
`-- The fastest 10 km inside any run, per year (from the stream, not just 10 km races).
SELECT substr(e.day, 1, 4)                  AS year,
       min(e.seconds)                       AS seconds,
       printf('%d:%02d', min(e.seconds) / 60, CAST(min(e.seconds) AS INTEGER) % 60) AS time,
       e.activity_id, a.name, e.day
FROM efforts e JOIN activities a ON a.id = e.activity_id
WHERE e.distance_m = 10000
GROUP BY year
ORDER BY year` },
  { name: 'Hottest runs vs pace', sql:
`-- Temperature (x) against pace (y) on runs of 5 km or more: chart as a scatter.
SELECT w.temp_c, a.pace_s_per_km, a.day, a.name, a.avg_hr, a.id
FROM runs a JOIN weather w ON w.activity_id = a.id
WHERE a.distance_m >= 5000 AND w.temp_c IS NOT NULL
ORDER BY w.temp_c DESC` },
  { name: 'HRV vs next-day run feel', sql:
`-- HRV of one morning against how the next day's run felt (journal feel 1-5).
-- Wellness rows are keyed by the morning you woke; use '+0 day' for that same day's run.
SELECT CAST(w.hrv_ms / 5 AS INTEGER) * 5 AS hrv_band_ms,
       round(avg(j.feel), 2)              AS avg_feel,
       count(*)                           AS runs
FROM wellness w
JOIN journal j ON j.day = date(w.day, '+1 day') AND j.kind = 'activity' AND j.feel IS NOT NULL
GROUP BY hrv_band_ms
ORDER BY hrv_band_ms` },
  { name: 'Shoes by km', sql:
`SELECT g.name, g.brand, g.retired,
       round(sum(a.distance_m) / 1000.0)   AS km,
       count(*)                           AS runs,
       min(a.day) AS first_run, max(a.day) AS last_run,
       round(g.limit_m / 1000.0)          AS replace_at_km
FROM gear g
JOIN activity_gear ag ON ag.gear_uuid = g.uuid
JOIN activities a ON a.id = ag.activity_id
GROUP BY g.uuid
ORDER BY km DESC` },
  { name: 'Longest running streaks', sql:
`-- Consecutive days with at least one run (gaps and islands).
WITH d AS (SELECT DISTINCT day FROM runs),
     g AS (SELECT day, julianday(day) - ROW_NUMBER() OVER (ORDER BY day) AS grp FROM d)
SELECT min(day) AS first_day, max(day) AS last_day, count(*) AS days
FROM g GROUP BY grp
ORDER BY days DESC, first_day DESC
LIMIT 15` },
  { name: 'Runs per hour of day', sql:
`SELECT hour, count(*) AS runs, round(avg(pace_s_per_km)) AS avg_pace_s_per_km
FROM runs
GROUP BY hour
ORDER BY hour` },
  { name: 'Strava vs Garmin distance disagreement', sql:
`-- Linked activities where the two services measured the same session differently.
SELECT id, day, name,
       round(distance_m) AS garmin_m, round(strava_distance_m) AS strava_m,
       round((strava_distance_m - distance_m) * 100.0 / distance_m, 2) AS diff_pct,
       strava_device
FROM activities
WHERE source = 'garmin' AND strava_distance_m > 0 AND distance_m > 0
ORDER BY abs(strava_distance_m - distance_m) * 1.0 / distance_m DESC
LIMIT 50` },
  { name: 'Runs with the biggest decoupling', sql:
`-- dur_decoupling 1.20 = it took 20% more heart rate per unit of pace late than early.
SELECT a.day, a.name, round(a.distance_m / 1000.0, 1) AS km,
       round((d.dur_decoupling - 1) * 100, 1) AS decoupling_pct,
       d.dur_band, d.dur_temperature_c, a.id
FROM derived d JOIN activities a ON a.id = d.activity_id
WHERE d.dur_decoupling IS NOT NULL
ORDER BY d.dur_decoupling DESC
LIMIT 25` },
  { name: 'Time in zones per month', sql:
`-- Hours per heart-rate zone per month; chart as a bar (x month, y hours, series zone).
SELECT month, hours, zone FROM (
  SELECT substr(a.day, 1, 7) AS month, 'Z1' AS zone, round(sum(d.z1_s) / 3600.0, 1) AS hours FROM derived d JOIN activities a ON a.id = d.activity_id GROUP BY month
  UNION ALL SELECT substr(a.day, 1, 7), 'Z2', round(sum(d.z2_s) / 3600.0, 1) FROM derived d JOIN activities a ON a.id = d.activity_id GROUP BY 1
  UNION ALL SELECT substr(a.day, 1, 7), 'Z3', round(sum(d.z3_s) / 3600.0, 1) FROM derived d JOIN activities a ON a.id = d.activity_id GROUP BY 1
  UNION ALL SELECT substr(a.day, 1, 7), 'Z4', round(sum(d.z4_s) / 3600.0, 1) FROM derived d JOIN activities a ON a.id = d.activity_id GROUP BY 1
  UNION ALL SELECT substr(a.day, 1, 7), 'Z5', round(sum(d.z5_s) / 3600.0, 1) FROM derived d JOIN activities a ON a.id = d.activity_id GROUP BY 1)
WHERE hours IS NOT NULL
ORDER BY month, zone` },
  { name: 'Resting HR and HRV by month', sql:
`SELECT substr(day, 1, 7) AS month, round(avg(rhr), 1) AS rhr, round(avg(hrv_ms)) AS hrv_ms,
       round(avg(sleep_hours), 2) AS sleep_hours, count(*) AS nights
FROM wellness
GROUP BY month
ORDER BY month` },
  { name: 'Races: goal, prediction, result', sql:
`SELECT date, name, round(distance_m / 1000.0, 2) AS km,
       goal_s, predicted_s, actual_s,
       actual_s - predicted_s AS vs_prediction_s,
       actual_s - goal_s      AS vs_goal_s
FROM races
ORDER BY date DESC` },
];

// ---- the browser half ----
let _engine = null;
// sql.js, once: the classic script defines window.initSqlJs; the wasm comes from the same folder.
export function loadEngine() {
  if (_engine) return _engine;
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  _engine = new Promise((res, rej) => {
    const go = () => window.initSqlJs({ locateFile: f => SQLJS_BASE + f }).then(res, rej);
    if (window.initSqlJs) return go();
    const s = document.createElement('script');
    s.src = SQLJS_BASE + 'sql-wasm.js'; s.integrity = SQLJS_SRI; s.crossOrigin = 'anonymous';
    s.onload = () => (window.initSqlJs ? go() : rej(new Error('sql.js did not define initSqlJs')));
    s.onerror = () => rej(new Error('The SQL engine did not load. Check your connection and try again.'));
    document.head.appendChild(s);
  }).catch(e => { _engine = null; throw e; });
  return _engine;
}

// An engine already in hand (node tests load sql.js themselves).
export function useEngine(SQL) { _engine = Promise.resolve(SQL); }

// The database for the current data: rebuilt when the state changed since it was built (and
// only then -- the page calls this when a query runs, not on every save).
let _db = null, _dbRev = -1;
const _sampleIds = new Set();
export async function openDb(force = false) {
  const SQL = await loadEngine();
  if (_db && _dbRev === liveRev && !force) return _db;
  if (_db) { try { _db.close(); } catch { /* gone */ } }
  const db = new SQL.Database();
  loadTables(db, buildTables(liveState));
  _db = db; _dbRev = liveRev;
  if (_sampleIds.size) await addSamples([..._sampleIds], { db, reload: true });
  return db;
}
export const sampleIds = () => [..._sampleIds];
// Per-second rows for these activities, from streams on this device. -> {added, missing, capped}.
export async function addSamples(ids, { db = _db, reload = false } = {}) {
  if (!db) db = await openDb();
  db.run(`CREATE TABLE IF NOT EXISTS samples (${samplesTable.columns.map(c => q(c.name) + ' ' + c.type).join(', ')})`);
  const want = ids.filter(id => reload || !_sampleIds.has(id));
  const room = MAX_SAMPLE_ACTIVITIES - (reload ? 0 : _sampleIds.size);
  const take = want.slice(0, Math.max(0, room));
  let added = 0; const missing = [];
  for (const id of take) {
    const rows = sampleRows(id, await getStream(id));
    if (!rows.length) { missing.push(id); _sampleIds.delete(id); continue; }
    db.run('BEGIN');
    const s = db.prepare(insertSql('samples', samplesTable));
    try { for (const row of rows) s.run(row); db.run('COMMIT'); } catch (e) { db.run('ROLLBACK'); throw e; } finally { s.free(); }
    _sampleIds.add(id); added++;
  }
  try { db.run('CREATE INDEX IF NOT EXISTS samples_activity ON samples (activity_id, t_s)'); } catch { /* fine without */ }
  return { added, missing, capped: want.length - take.length };
}
export function dropSamples() {
  _sampleIds.clear();
  if (_db) _db.run('DROP TABLE IF EXISTS samples');
}

// Run every statement in `sql`; the last one that returns columns is the result. Rows past
// `cap` are counted, not kept. -> {columns, rows, total, statements, ms}
export function runSql(db, sql, cap = MAX_ROWS) {
  const t0 = Date.now();
  let res = null, n = 0;
  for (const stmt of db.iterateStatements(sql)) {
    n++;
    try {
      const cols = stmt.getColumnNames();
      if (!cols.length) { while (stmt.step()); continue; }
      const rows = []; let total = 0;
      while (stmt.step()) { if (total < cap) rows.push(stmt.get()); total++; }
      res = { columns: cols, rows, total };
    } finally { stmt.free(); }
  }
  return { ...(res || { columns: [], rows: [], total: 0 }), statements: n, ms: Date.now() - t0 };
}
// Every row of a query (for the CSV), however many.
export function allRows(db, sql) { return runSql(db, sql, Infinity); }
