// The SQL console's table builder against the demo athlete and a hand-made state, and -- when
// sql.js can be fetched (pinned version, hash-checked, cached in the OS temp folder) -- every
// CREATE/INSERT and every starter query run through real SQLite in node. Offline, that part skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import * as store from '../js/store.js';
import { importGarmin } from '../js/ingest.js';
import { demoGarminPayload, demoExtras } from '../js/demo.js';
import { emptyState, put } from '../js/merge.js';
import * as D from '../js/derive.js';
import * as S from '../js/sql.js';

let ready = null;
function demo() {
  return ready || (ready = (async () => {
    await store.loadState();
    const r = await importGarmin(store.state, demoGarminPayload(), store.putStream);
    const x = demoExtras();
    for (const k of Object.keys(x)) Object.assign(store.state[k], x[k]);
    await D.deriveAll(store.state, r.streams);
    store.save('demo');
    return { st: store.state, streams: r.streams };
  })());
}
const cols = t => t.columns.map(c => c.name);
// derive.js memoises on the store's revision, not on the state passed in: build a non-demo state
// as the live one (as the pages test does), then put the demo back.
async function asLive(st, fn) {
  await demo();
  const saved = store.state;
  store.replaceState(st);
  try { return fn(S.buildTables(store.state), store.state); } finally { store.replaceState(saved); }
}
const rowsAs = t => t.rows.map(row => Object.fromEntries(t.columns.map((c, i) => [c.name, row[i]])));

// A small state with the collections the demo leaves empty.
function handState() {
  const st = emptyState();
  put(st, 'activities', 'g1', { id: 'g1', source: 'garmin', garmin_id: '1', strava_id: '9', name: 'Morning Run', type: 'running',
    start: '2026-05-02T07:15:00', distance_m: 10000, moving_s: 2700, elapsed_s: 2760, avg_hr: 150, max_hr: 170, elev_gain_m: 80, calories: 700,
    strava: { distance_m: 10120, moving_s: 2690, avg_hr: 151, device: 'Forerunner 965' } });
  put(st, 'activities', 'g2', { id: 'g2', source: 'garmin', garmin_id: '2', name: 'Ride', type: 'cycling', start: '2026-05-03T18:00:00', distance_m: 30000, moving_s: 3600 });
  put(st, 'journal', 'g1', { kind: 'activity', rpe: 6, feel: 4, note: 'legs, "fine"', tags: ['Poor sleep', 'hot'] });
  put(st, 'journal', '2026-05-03', { kind: 'day', tags: ['travel'] });
  put(st, 'segmentEfforts', 'e1', { id: 'e1', segment_id: '77', segment_name: 'Hill', activity_id: 'g1', elapsed_time: 95, distance: 400, pr_rank: 1 });
  put(st, 'experiments', 'x1', { id: 'x1', name: 'No caffeine', change: 'caffeine', start: '2026-04-01', end: null, metrics: ['hrv_ms', 'rhr'] });
  put(st, 'laps', 'g1', { laps: [{ index: 1, distance_m: 1000, duration_s: 270, avg_hr: 145 }, { index: 2, distance_m: 1000, duration_s: 265, avg_hr: 152, avg_power: 300 }] });
  put(st, 'metrics', '2026-05-01', { threshold_hr: 171, vo2max: 55, races: { 5000: 1100.4, 10000: 2300 } });
  put(st, 'gear', 'sh1', { uuid: 'sh1', name: 'Pegasus', type: 'shoes', retired: false, limit_m: 700000 });
  put(st, 'activityGear', 'g1', { uuids: ['sh1'] });
  put(st, 'derived', 'g1', { v: 4, efforts: { 1000: 250, 5000: 1320.55 }, drift: 3.2, tiles: [[1, 2], [1, 3]], hrf: 1.04,
    zones: { thr: 171, secs: { Z1: 60, Z2: 1200, Z3: 900, Z4: 500, Z5: 40 } }, durability: { decoupling: 1.12, band: 'moderate', hot: false },
    stops: { count: 2, counts: { crossing: 2 }, lost_s: 30 }, session: null });
  return st;
}

test('activities: the asked-for columns, one row per activity', async () => {
  const { st } = await demo();
  const t = S.buildTables(st).activities;
  for (const c of ['id', 'source', 'garmin_id', 'strava_id', 'name', 'type', 'start', 'day', 'distance_m', 'moving_s', 'elapsed_s', 'avg_hr',
    'max_hr', 'elev_gain_m', 'calories', 'load', 'hr_load_factor', 'power_tss', 'strava_distance_m', 'strava_moving_s', 'strava_device'])
    assert.ok(cols(t).includes(c), 'missing ' + c);
  assert.equal(t.rows.length, D.activities(st).length);
  const a = rowsAs(t).find(x => x.id === D.runs(st)[0].id);
  assert.equal(a.day, a.start.slice(0, 10));
  assert.ok(a.load > 0 && a.pace_s_per_km > 120 && a.is_run === 1);
  assert.equal(t.columns.find(c => c.name === 'distance_m').type !== 'TEXT', true);
});

test('every table from the demo; efforts match prRows; derived flattens the core', async () => {
  const { st } = await demo();
  const T = S.buildTables(st);
  for (const n of ['activities', 'daily', 'wellness', 'weather', 'laps', 'gear', 'activity_gear', 'journal', 'journal_tags', 'races', 'efforts', 'derived', 'segments', 'metrics', 'experiments'])
    assert.ok(T[n] && Array.isArray(T[n].rows), n);
  assert.equal(T.efforts.rows.length, D.prRows(st).length);
  assert.equal(T.daily.rows.length, Object.keys(st.daily).length);
  assert.ok(cols(T.daily).includes('steps'));
  assert.equal(T.derived.rows.length, Object.keys(st.derived).length);
  for (const c of ['z1_s', 'z5_s', 'dur_decoupling', 'stops_count', 'climb_factor', 'tiles', 'session_count', 'power_np_w']) assert.ok(cols(T.derived).includes(c), c);
  // Cells are SQLite-safe: numbers, strings or null -- never undefined, objects or NaN.
  for (const [n, t] of Object.entries(T)) for (const row of t.rows) for (const v of row)
    assert.ok(v === null || typeof v === 'string' || (typeof v === 'number' && isFinite(v)), n + ' has ' + v);
  for (const [n, t] of Object.entries(T)) for (const row of t.rows) assert.equal(row.length, t.columns.length, n);
  // Docs describe every table with units from the names.
  const doc = S.describe(T);
  assert.equal(doc.find(d => d.name === 'activities').columns.find(c => c.name === 'distance_m').unit, 'm');
  assert.ok(doc.every(d => d.note));
});

test('a hand state: strava_*, journal + tags, segments, laps, metrics, gear, derived', () => asLive(handState(), (T, st) => {
  const a = rowsAs(T.activities).find(x => x.id === 'g1');
  assert.equal(a.strava_distance_m, 10120); assert.equal(a.strava_device, 'Forerunner 965'); assert.equal(a.hour, 7); assert.equal(a.year, 2026);
  assert.equal(a.pace_s_per_km, 270);
  assert.equal(rowsAs(T.activities).find(x => x.id === 'g2').pace_s_per_km, null);   // not a run
  const j = rowsAs(T.journal);
  assert.deepEqual(j.map(x => [x.id, x.kind, x.activity_id, x.day]).sort(), [['2026-05-03', 'day', null, '2026-05-03'], ['g1', 'activity', 'g1', '2026-05-02']]);
  assert.deepEqual(rowsAs(T.journal_tags).map(x => x.tag).sort(), ['hot', 'poor-sleep', 'travel']);
  assert.equal(rowsAs(T.segments)[0].segment_name, 'Hill');
  assert.equal(rowsAs(T.experiments)[0].metrics, 'hrv_ms,rhr');
  assert.deepEqual(rowsAs(T.laps).map(l => [l.activity_id, l.lap, l.avg_power]), [['g1', 1, null], ['g1', 2, 300]]);
  const m = rowsAs(T.metrics)[0];
  assert.equal(m.race_5000_s, 1100.4); assert.equal(m.vo2max, 55);
  assert.deepEqual(rowsAs(T.gear).map(g => [g.uuid, g.used_runs, g.used_m, g.retired]), [['sh1', 1, 10000, 0]]);
  assert.deepEqual(rowsAs(T.activity_gear), [{ activity_id: 'g1', gear_uuid: 'sh1' }]);
  const d = rowsAs(T.derived)[0];
  assert.equal(d.z2_s, 1200); assert.equal(d.tiles, 2); assert.equal(d.dur_decoupling, 1.12); assert.equal(d.stops_crossing, 2);
  assert.deepEqual(rowsAs(T.efforts).map(e => [e.distance_m, e.seconds]).sort((x, y) => x[0] - y[0]), [[1000, 250], [5000, 1320.6]]);
  assert.equal(S.createSql('laps', T.laps).startsWith('CREATE TABLE "laps" ("activity_id" TEXT, "lap" INTEGER'), true);
  assert.equal(S.insertSql('laps', T.laps).split('?').length - 1, T.laps.columns.length);
  assert.deepEqual(S.idsInResult({ columns: ['activity_id'], rows: [['g1'], ['g1'], ['zz']] }, st), ['g1']);
}));

test('empty state: every table exists, no rows', () => asLive(emptyState(), T => {
  for (const t of Object.values(T)) assert.equal(t.rows.length, 0);
  assert.ok(cols(T.activities).includes('strava_distance_m'));
}));

test('colName, unitOf, CSV and chart specs', () => {
  assert.equal(S.colName('5000'), 'd5000'); assert.equal(S.colName('Body Battery'), 'body_battery');
  assert.equal(S.unitOf('pace_s_per_km'), 's/km'); assert.equal(S.unitOf('avg_hr'), 'bpm'); assert.equal(S.unitOf('hrv_ms'), 'ms');
  assert.equal(S.unitOf('threshold_speed_m_s'), 'm/s'); assert.equal(S.unitOf('elapsed_s'), 's');
  assert.equal(S.toCsv(['a', 'b'], [[1, 'x,"y"'], [null, 'z']]), 'a,b\r\n1,"x,""y"""\r\n,z\r\n');
  const two = S.chartSpec(['month', 'km'], [['2026-01', 10], ['2026-02', 12]]);
  assert.equal(two.x.type, 'time'); assert.equal(two.series.length, 1); assert.equal(two.series[0].points[0][0], '2026-01-01');
  const three = S.chartSpec(['week', 'km', 'year'], [[1, 10, '2025'], [1, 12, '2026'], [2, 8, '2026']], 'bar');
  assert.equal(three.series.length, 2); assert.equal(three.x.type, 'linear');
  const counted = S.chartSpec(['month', 'pace', 'runs'], [['a', 300, 2]], 'bar');
  assert.equal(counted.series.length, 1); assert.match(counted.note, /runs/);
  assert.throws(() => S.chartSpec(['x'], [[1]]));
  assert.throws(() => S.chartSpec(['x', 'y'], [[1, 'a']]));
});

test('sampleRows: the ten sample columns plus power', () => {
  const rows = S.sampleRows('g1', { channels: { seconds: [0, 1], metres: [0, 3.1], hr: [100, null], power_w: [200, 210] } });
  assert.equal(rows.length, 2); assert.equal(rows[0].length, S.SAMPLE_COLS.length);
  assert.deepEqual(rows[1].slice(0, 4), ['g1', 1, 3.1, null]); assert.equal(rows[1][11], 210);
  assert.deepEqual(S.sampleRows('x', null), []);
});

// ---- real SQLite (sql.js) in node, when it can be fetched ----
const FILES = { 'sql-wasm.js': S.SQLJS_SRI, 'sql-wasm.wasm': 'sha384-x0YkuPkDHnKTZcB1JO4eb6j5+eU36aka+jBA6tOKTFaTz98b9V7fPT0QgZ9qyQW2' };
async function fetchSqlJs() {
  const out = {};
  for (const [f, sri] of Object.entries(FILES)) {
    const path = join(tmpdir(), `run315-sqljs-${S.SQLJS_VERSION}-${f}`);
    let buf = existsSync(path) ? readFileSync(path) : null;
    if (!buf) { const res = await fetch(S.SQLJS_BASE + f, { signal: AbortSignal.timeout(15000) }); if (!res.ok) throw new Error(f + ' ' + res.status); buf = Buffer.from(await res.arrayBuffer()); }
    if ('sha384-' + createHash('sha384').update(buf).digest('base64') !== sri) throw new Error(f + ': hash mismatch');
    if (!existsSync(path)) writeFileSync(path, buf);
    out[f] = buf;
  }
  const module = { exports: {} };
  new Function('module', 'exports', 'require', '__dirname', '__filename', out['sql-wasm.js'].toString('utf8'))(module, module.exports, createRequire(import.meta.url), tmpdir(), 'sql-wasm.js');
  return module.exports({ wasmBinary: out['sql-wasm.wasm'] });
}
let SQL = null, why = '';
try { SQL = await fetchSqlJs(); } catch (e) { why = 'sql.js unavailable (' + e.message + ')'; }

test('real SQLite: the statements load, every starter query runs', { skip: !SQL && why }, async () => {
  const { st, streams } = await demo();
  const db = new SQL.Database();
  S.loadTables(db, S.buildTables(st));
  const one = sql => S.runSql(db, sql).rows[0][0];
  assert.equal(one('SELECT count(*) FROM activities'), D.activities(st).length);
  assert.equal(one('SELECT count(*) FROM runs'), D.runs(st).length);
  assert.equal(one('SELECT count(*) FROM efforts'), D.prRows(st).length);
  assert.ok(one('SELECT count(*) FROM derived WHERE z4_s > 0') > 0);
  for (const s of S.STARTERS) {
    const res = S.runSql(db, s.sql);
    assert.ok(res.columns.length >= 2, s.name + ' returned no columns');
  }
  // The demo has enough runs for the questions that need no journal or Strava.
  for (const n of ['Weekly km, one line per year', 'Best 10 km each year', 'Shoes by km', 'Longest running streaks', 'Runs per hour of day', 'Hottest runs vs pace'])
    assert.ok(S.runSql(db, S.STARTERS.find(s => s.name === n).sql).total > 0, n + ' found nothing');
  // Cap, multiple statements, rebuild over itself, and a chartable result.
  const capped = S.runSql(db, 'CREATE TEMP TABLE n AS SELECT 1; SELECT * FROM activities a, activities b', 10);
  assert.equal(capped.rows.length, 10); assert.equal(capped.total, D.activities(st).length ** 2); assert.equal(capped.statements, 2);
  S.loadTables(db, S.buildTables(st));
  assert.ok(S.chartSpec(...Object.values((({ columns, rows }) => ({ columns, rows }))(S.runSql(db, S.STARTERS[0].sql)))).series.length >= 1);
  // Samples for one demo run, through the same INSERT the browser uses.
  db.run(S.createSql('samples', S.samplesTable));
  const s = db.prepare(S.insertSql('samples', S.samplesTable));
  const rows = S.sampleRows(streams[0], await store.getStream(streams[0]));
  for (const row of rows) s.run(row);
  s.free();
  assert.equal(one('SELECT count(*) FROM samples'), rows.length);
  assert.ok(one('SELECT max(hr_bpm) FROM samples') > 0);
  assert.throws(() => S.runSql(db, 'SELECT nope FROM activities'), /no such column/);
  db.close();
});

test('real SQLite: openDb rebuilds only after a data change; samples survive the rebuild', { skip: !SQL && why }, async () => {
  const { st, streams } = await demo();
  S.useEngine(SQL);
  const db1 = await S.openDb();
  assert.equal(await S.openDb(), db1);                 // same revision: same database
  const r = await S.addSamples([streams[0], streams[1], 'nope']);
  assert.deepEqual([r.added, r.missing], [2, ['nope']]);
  assert.deepEqual(S.sampleIds().sort(), [streams[0], streams[1]].sort());
  const n = S.runSql(db1, 'SELECT count(DISTINCT activity_id) FROM samples').rows[0][0];
  assert.equal(n, 2);
  db1.run('DELETE FROM activities');                    // a scratch copy...
  store.save('edit');                                   // ...and new data: the next query rebuilds
  const db2 = await S.openDb();
  assert.notEqual(db2, db1);
  assert.equal(S.runSql(db2, 'SELECT count(*) FROM activities').rows[0][0], D.activities(st).length);
  assert.equal(S.runSql(db2, 'SELECT count(DISTINCT activity_id) FROM samples').rows[0][0], 2);
  S.dropSamples();
  assert.deepEqual(S.sampleIds(), []);
  assert.throws(() => S.runSql(db2, 'SELECT * FROM samples'), /no such table/);
});
