import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, put } from '../js/merge.js';
import * as R from '../js/datareview.js';

// A steady 1 Hz run heading north at ~3.3 m/s: [t, d, hr, lat, lon, ele, cad].
const DEG = 1 / 111195;   // degrees of latitude per metre
function steadyRun(n = 1200, { hr = i => 150, cad = i => 170, ele = i => 400 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) out.push([i, i * 3.3, hr(i), 47 + i * 3.3 * DEG, 8.5, ele(i), cad(i), null, null, null]);
  return out;
}
const run = (id, x = {}) => ({ id, source: 'garmin', garmin_id: id.slice(1), name: 'Run ' + id, type: 'running',
  start: '2026-09-01T07:00:00', distance_m: 4000, moving_s: 1200, elev_gain_m: 20, avg_hr: 150, ...x });

test('a clean run raises nothing', () => {
  assert.deepEqual(R.streamFindings(run('g1'), steadyRun()), []);
});

test('GPS jump: a teleport is caught, wobble is not', () => {
  const s = steadyRun();
  s[600][3] += 500 * DEG;   // one fix 500 m off the track
  const f = R.streamFindings(run('g1'), s);
  const j = f.find(x => x.kind === 'gps-jump');
  assert.ok(j, 'jump found');
  assert.equal(j.id, 'gps-jump:g1');
  assert.equal(j.evidence.jumps, 2);          // out and back
  assert.ok(j.evidence.worst_m_s > 400);
  const w = steadyRun(); for (let i = 0; i < w.length; i += 7) w[i][3] += 4 * DEG;   // 4 m jitter
  assert.ok(!R.streamFindings(run('g1'), w).some(x => x.kind === 'gps-jump'));
});

test('HR dropout mid-run, not a late strap', () => {
  const f = R.streamFindings(run('g1'), steadyRun(1200, { hr: i => (i > 400 && i < 520 ? null : 150) }));
  const d = f.find(x => x.kind === 'hr-dropout');
  assert.ok(d);
  assert.ok(d.evidence.longest_s >= 119 && d.evidence.longest_s <= 121);
  const late = R.streamFindings(run('g1'), steadyRun(1200, { hr: i => (i < 200 ? null : 150) }));
  assert.ok(!late.some(x => x.kind === 'hr-dropout'));
  const none = R.streamFindings(run('g1'), steadyRun(1200, { hr: () => null }));
  assert.ok(!none.some(x => x.kind === 'hr-dropout'), 'no strap at all is not a dropout');
});

test('cadence lock: HR riding the cadence for minutes', () => {
  const f = R.streamFindings(run('g1'), steadyRun(1200, { hr: i => (i > 300 && i < 700 ? 168 + (i % 3) : 145), cad: () => 170 }));
  const c = f.find(x => x.kind === 'cadence-lock');
  assert.ok(c);
  assert.ok(c.evidence.longest_s > 350);
  const half = R.streamFindings(run('g1'), steadyRun(1200, { hr: () => 86, cad: () => 172 }));
  assert.ok(half.some(x => x.kind === 'cadence-lock'), 'half-cadence counts too');
  const short = R.streamFindings(run('g1'), steadyRun(1200, { hr: i => (i < 100 ? 170 : 145), cad: () => 170 }));
  assert.ok(!short.some(x => x.kind === 'cadence-lock'));
});

test('altitude jump between two samples', () => {
  const f = R.streamFindings(run('g1'), steadyRun(1200, { ele: i => (i === 500 ? 460 : 400) }));
  const e = f.find(x => x.id === 'elev-jump:g1');
  assert.ok(e);
  assert.equal(e.kind, 'elevation-spike');
  assert.equal(e.evidence.jumps, 2);
});

test('summary detectors: type, implausible, elevation', () => {
  const st = emptyState();
  put(st, 'activities', 'g1', run('g1', { distance_m: 20000, moving_s: 3000 }));          // 6.7 m/s "run"
  put(st, 'activities', 'g2', run('g2', { distance_m: 30000, moving_s: 3000 }));          // 10 m/s: implausible
  put(st, 'activities', 'g3', run('g3', { type: 'cycling', distance_m: 3000, moving_s: 2400 }));   // 1.25 m/s ride
  put(st, 'activities', 'g4', run('g4', { elev_gain_m: 1500, distance_m: 4000 }));         // 375 m/km
  put(st, 'activities', 'g5', run('g5', { type: 'treadmill_running', elev_gain_m: 80 }));
  put(st, 'activities', 'g6', run('g6'));
  const f = R.summaryFindings(st), ids = f.map(x => x.id).sort();
  assert.deepEqual(ids, ['elev-gain:g4', 'elev-gain:g5', 'implausible:g2', 'type-mismatch:g1', 'type-mismatch:g3']);
  assert.equal(f.find(x => x.id === 'type-mismatch:g1').evidence.likely, 'cycling');
  assert.equal(f.find(x => x.id === 'type-mismatch:g3').evidence.likely, 'walking');
});

test('near-miss: outside dedupe, inside 30 min / 25%', () => {
  const st = emptyState();
  put(st, 'activities', 'g1', run('g1', { distance_m: 10000 }));
  put(st, 'activities', 's9', { id: 's9', source: 'strava', strava_id: '9', name: 'Lunch Run', type: 'running',
    start: '2026-09-01T07:20:00', distance_m: 9000, moving_s: 3000 });
  put(st, 'activities', 's8', { id: 's8', source: 'strava', strava_id: '8', name: 'Far', type: 'running',
    start: '2026-09-01T09:00:00', distance_m: 10000, moving_s: 3000 });
  const f = R.summaryFindings(st).filter(x => x.kind === 'near-miss');
  assert.equal(f.length, 1);
  assert.equal(f[0].id, 'near-miss:s9:g1');
  assert.equal(f[0].evidence.minutes_apart, 20);
  // approving merges through dedupe: one activity left, carrying the Strava id
  const r = R.applyDecision(st, f[0].id, 'fix');
  assert.ok(r.ok, r.note);
  assert.equal(st.activities.s9, undefined);
  assert.equal(st.activities.g1.strava_id, '9');
  assert.equal(st.dataReview[f[0].id].decision, 'fix');
});

test('scan records sync the stream findings and channels', () => {
  const st = emptyState();
  put(st, 'activities', 'g1', run('g1'));
  const s = steadyRun(); s[600][3] += 500 * DEG;
  const ch = { seconds: s.map(x => x[0]), metres: s.map(x => x[1]), hr: s.map(x => x[2]), lat: s.map(x => x[3]), lon: s.map(x => x[4]),
    elevation_m: s.map(x => x[5]), cadence_spm: s.map(x => x[6]), power_w: s.map(() => null) };
  const rec = R.scanRecord(st, 'g1', { id: 'g1', src: 'garmin', channels: ch });
  assert.deepEqual(rec.channels, ['cadence_spm', 'elevation_m', 'hr', 'lat', 'lon']);   // power all null: not carried
  assert.ok(st.dataReview['scan:g1'].u);
  assert.ok(R.findings(st).some(f => f.id === 'gps-jump:g1'));
  // scan records are not findings themselves, and never go to the agent
  assert.ok(!R.reviewContext(st).findings.some(f => f.id.startsWith('scan:')));
});

test('scanStreams skips what is already scanned at this version', async () => {
  const st = emptyState();
  put(st, 'activities', 'g1', run('g1')); put(st, 'activities', 'g2', run('g2'));
  const s = steadyRun(100);
  const rec = { src: 'garmin', channels: { seconds: s.map(x => x[0]), metres: s.map(x => x[1]), hr: s.map(x => x[2]) } };
  const getStream = async () => rec;
  assert.deepEqual(await R.scanStreams(st, { ids: ['g1', 'g2', 'gone'], getStream }), { scanned: 2, findings: 0 });
  assert.equal((await R.scanStreams(st, { ids: ['g1', 'g2'], getStream })).scanned, 0);
  assert.equal((await R.scanStreams(st, { ids: ['g1', 'g2'], getStream, all: true })).scanned, 2);
});

test('context, proposals, decisions', () => {
  const st = emptyState();
  put(st, 'activities', 'g1', run('g1', { distance_m: 20000, moving_s: 3000 }));
  const ctx = R.reviewContext(st);
  assert.equal(ctx.open, 1);
  assert.equal(ctx.findings[0].activity.id, 'g1');
  const res = R.importReview(st, { proposals: [
    { id: 'type-mismatch:g1', action: 'fix', fix: { type: 'cycling' }, reason: 'bike speed throughout' },
    { id: 'nope:g9', action: 'keep' },
    { id: 'type-mismatch:g1', action: 'fix', fix: { type: 'cycling', avg_hr: 999 } },   // one bad field: whole fix dropped
  ] });
  assert.ok(res.handled);
  assert.match(res.note, /^1 proposals, 2 skipped/);
  assert.equal(st.dataReview['type-mismatch:g1'].proposal.fix.type, 'cycling');
  assert.equal(R.importReview(st, {}).handled, false);
  // nothing changed until approved
  assert.equal(st.activities.g1.type, 'running');
  put(st, 'derived', 'g1', { efforts: { 5000: 600 } });
  const r = R.applyDecision(st, 'type-mismatch:g1', 'fix');
  assert.ok(r.ok);
  assert.equal(st.activities.g1.type, 'cycling');
  assert.deepEqual(st.activities.g1.fixed, { type: 'cycling' });
  assert.deepEqual(st.derived.g1.efforts, {}, 'a ride stops feeding best efforts');
  assert.equal(R.openFindings(st).length, 0);
  // undo puts the old value back
  assert.ok(R.reopen(st, 'type-mismatch:g1').ok);
  assert.equal(st.activities.g1.type, 'running');
  assert.deepEqual(st.activities.g1.fixed, {});
  assert.equal(R.openFindings(st).length, 1);
  R.applyDecision(st, 'type-mismatch:g1', 'keep');
  assert.equal(R.reviewContext(st).open, 0);
});

test('context is capped', () => {
  const st = emptyState();
  for (let i = 0; i < 55; i++) put(st, 'activities', 'g' + i, run('g' + i, { distance_m: 20000, moving_s: 3000 }));
  const ctx = R.reviewContext(st);
  assert.equal(ctx.findings.length, R.CONTEXT_CAP);
  assert.equal(ctx.more, 55 - R.CONTEXT_CAP);
});

test('Garmin vs Strava deltas and the stream referee', () => {
  const st = emptyState();
  put(st, 'activities', 'g1', run('g1', { distance_m: 10000, strava: { distance_m: 10200, moving_s: 1250, elev_gain_m: 30, avg_hr: 151 } }));
  put(st, 'activities', 'g2', run('g2', { distance_m: 5000, strava: { distance_m: 4950, moving_s: 1200, elev_gain_m: null, avg_hr: null } }));
  put(st, 'activities', 'g3', run('g3'));   // not linked
  const p = R.linkedPairs(st);
  assert.equal(p.length, 2);
  const g1 = p.find(x => x.id === 'g1');
  assert.equal(g1.d.distance_m, 200);
  assert.equal(g1.d.distance_pct, 2);
  const stats = R.deltaStats(p);
  assert.equal(stats.distance_m.n, 2);
  assert.equal(stats.distance_m.median, 75);
  assert.equal(stats.avg_hr.n, 1);
  const ref = R.streamReferee(steadyRun(1000), 'running');
  assert.ok(Math.abs(ref.gps_m - 999 * 3.3) < 5);
  assert.equal(ref.moving_s, 999);
  assert.equal(R.sideWith(3300, 3500, ref.gps_m), 'garmin');
  assert.equal(R.sideWith(3300, 3301, ref.gps_m), 'tie');
});

test('coverage marks gaps per channel', () => {
  const st = emptyState();
  put(st, 'activities', 'g1', run('g1', { start: '2026-10-20T07:00:00', strava_id: '5' }));
  put(st, 'activities', 'g2', run('g2', { start: '2026-10-21T07:00:00', avg_hr: null }));
  put(st, 'derived', 'g1', { points: [[47, 8]] });
  put(st, 'daily', '2026-10-20', { steps: 1, deep_s: 3000 });
  R.scanRecord(st, 'g1', { src: 'garmin', channels: { seconds: [0, 1], metres: [0, 1], stride_m: [1, 1] } });
  const c = R.coverage(st, new Date(2026, 9, 22), 2);
  const ch = k => c.channels.find(x => x.key === k);
  assert.equal(c.grid.length, 2);
  assert.equal(ch('activities').cells['2026-10-20'], 'both');
  assert.equal(ch('activities').cells['2026-10-21'], 'garmin');
  assert.equal(ch('activities').cells['2026-10-19'], 'none');
  assert.equal(ch('stream').cells['2026-10-21'], 'miss');
  assert.equal(ch('hr').cells['2026-10-21'], 'miss');
  assert.equal(ch('gps').cells['2026-10-20'], 'have');
  assert.equal(ch('gps').cells['2026-10-21'], 'unk');
  assert.equal(ch('dynamics').cells['2026-10-20'], 'have');
  assert.equal(ch('daily').cells['2026-10-20'], 'have');
  assert.equal(ch('daily').cells['2026-10-19'], 'miss');
  assert.equal(ch('daily').cells['2026-10-23'], 'future');
  assert.equal(ch('sleep').have, 1);
});

test('segments: summary, trend, wish list', () => {
  const st = emptyState();
  [400, 390, 385, 370].forEach((t, i) => put(st, 'segmentEfforts', 'e' + i, { id: 'e' + i, segment_id: '77', segment_name: 'Hill',
    activity_id: 'g' + i, strava_id: String(i), elapsed_time: t, start_date_local: `2026-0${i + 5}-01T07:00:00`, distance: 1200 }));
  put(st, 'segmentEfforts', 'x', { id: 'x', segment_id: '88', segment_name: 'Flat', activity_id: 'g1', elapsed_time: 200, start_date_local: '2026-06-01T07:00:00' });
  const s = R.segmentSummary(st);
  assert.equal(s.length, 2);
  assert.equal(s[0].name, 'Hill');
  assert.equal(s[0].attempts, 4);
  assert.equal(s[0].best.elapsed_time, 370);
  assert.equal(s[0].latest.id, 'e3');
  assert.ok(s[0].trend.per30 < 0, 'getting faster');
  assert.equal(s[1].trend, null, 'one attempt: no trend');
  assert.equal(R.setSegmentsWanted(st, ['1', '2']), 2);
  assert.equal(R.setSegmentsWanted(st, ['2']), 0);
  assert.deepEqual(R.wantedSegments(st), ['1', '2']);
  assert.equal(R.setSegmentsWanted(st, ['1'], false), 1);
  assert.deepEqual(R.wantedSegments(st), ['2']);
  assert.ok(st.profile.u);
});
