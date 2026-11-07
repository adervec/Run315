import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, openAsBlob } from 'node:fs';
import { activityFromSummary, jsonItems, channelsFromFit, lapsFromFit, summaryIndex, Days, classify,
  importArchive, archivePanel } from '../js/archive.js';
import { decodeFit } from '../js/fit.js';
import { importGarmin } from '../js/ingest.js';
import { emptyState } from '../js/merge.js';
import { sampleActivity, makeZip, blobBytes, FitWriter, T, fitTime } from './fitenc.mjs';

const T0 = 1700000000;   // 2023-11-14T22:13:20Z; 17:13:20 local at UTC-5
const SUMMARY = {
  activityId: 111, name: 'Run "the [loop]" {x}', activityType: 'running', beginTimestamp: T0 * 1000,
  startTimeGmt: T0 * 1000, startTimeLocal: (T0 - 18000) * 1000, duration: 20000, elapsedDuration: 20000, movingDuration: 19000,
  distance: 5700, elevationGain: 400, avgHr: 150, maxHr: 160, calories: 1046,
  splits: [{ measurements: [{ value: 1, unitEnum: 'CENTIMETER' }] }],
};
const OTHER = { activityId: 222, name: 'Strength', activityType: 'strength_training', startTimeGmt: (T0 + 86400) * 1000,
  startTimeLocal: (T0 + 86400 - 18000) * 1000, duration: 1800000, calories: 418.4 };

test('archive: a summary in Garmin export units -> the garmin-output activity', () => {
  const a = activityFromSummary(SUMMARY);
  assert.deepEqual(a, { garmin_id: '111', name: SUMMARY.name, type: 'running', start: '2023-11-14T17:13:20',
    distance_m: 57, moving_s: 19, elapsed_s: 20, avg_hr: 150, max_hr: 160, elev_gain_m: 4, calories: 250, gmt: T0 });
  assert.equal(activityFromSummary(OTHER).calories, 100);   // kilojoules -> kcal
  assert.equal(activityFromSummary(OTHER).moving_s, 1800);
  assert.equal(activityFromSummary({}), null);
});

test('archive: jsonItems streams array elements across chunk boundaries', async () => {
  const doc = JSON.stringify([{ summarizedActivitiesExport: [SUMMARY, OTHER, { activityId: 3, s: 'esc \\" ] } [' }] }]);
  for (const size of [1, 7, 4096]) {
    const parts = [];
    for (let i = 0; i < doc.length; i += size) parts.push(new TextEncoder().encode(doc.slice(i, i + size)));
    const stream = new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } });
    const got = [];
    for await (const x of jsonItems(stream, 3)) got.push(x);
    assert.deepEqual(got.map(x => x.activityId), [111, 222, 3], `chunk ${size}`);
    assert.equal(got[0].name, SUMMARY.name);
    assert.equal(got[2].s, 'esc \\" ] } [');
  }
});

test('archive: FIT -> channels and laps, in the names ingest.js reads', () => {
  const fit = decodeFit(sampleActivity({ start: T0, n: 20 }));
  const ch = channelsFromFit(fit);
  assert.deepEqual(ch.seconds.slice(0, 3), [0, 1, 2]);
  assert.deepEqual(ch.metres.slice(0, 3), [0, 3, 6]);
  assert.equal(ch.hr[10], 150);
  assert.equal(ch.lat[10], 43.6501);
  assert.equal(ch.lon[0], -79.38);
  assert.equal(ch.elevation_m[10], 102);
  assert.equal(ch.cadence_spm[0], 171);             // (85 + 0.5) per leg, both feet
  assert.equal(ch.power_w[0], 300);
  assert.equal(ch.speed_m_s[0], 3);
  assert.equal(ch.stride_m[0], 1.2);
  assert.equal(ch.gct_ms[0], 250);
  assert.equal(ch.vertical_oscillation_cm[0], 9.5);
  assert.equal(ch.vertical_ratio_pct[0], 7.9);
  assert.equal(ch.gct_balance_left_pct[0], 49.5);
  assert.equal(ch.air_temp_c[0], 21);
  for (const v of Object.values(ch)) assert.equal(v.length, 20);
  const [lap] = lapsFromFit(fit);
  assert.deepEqual(lap, { index: 1, distance_m: 57, duration_s: 20, avg_hr: 150, max_hr: 160, avg_speed: null,
    elev_gain_m: 4, avg_cadence: 85, avg_power: 310 });
  // a strength session with no distance: no trace
  const w = new FitWriter();
  w.def(0, 0, [[0, T.enum]]).data(0, [4]).def(1, 20, [[253, T.uint32], [3, T.uint8]]);
  for (let i = 0; i < 5; i++) w.data(1, [fitTime(T0 + i), 100]);
  assert.equal(channelsFromFit(decodeFit(w.bytes())), null);
});

test('archive: matching a FIT to its summary by id in the name, else start time', () => {
  const idx = summaryIndex([activityFromSummary(SUMMARY), activityFromSummary(OTHER), activityFromSummary({ ...OTHER, activityId: 21725246365 })]);
  assert.equal(idx.match('21725246365.fit', null).garmin_id, '21725246365');
  assert.equal(idx.match('adervec_434779004715.fit', T0 + 30).garmin_id, '111');
  assert.equal(idx.match('x.fit', T0 + 86400 - 100).garmin_id, '222');
  assert.equal(idx.match('x.fit', T0 + 500), null);
});

test('archive: days and nights from UDS, sleep, health status, readiness, biometrics', () => {
  const d = new Days();
  d.uds({ calendarDate: '2026-06-01', totalSteps: 12000, floorsAscendedInMeters: 30.48, restingHeartRate: 47,
    moderateIntensityMinutes: 20, vigorousIntensityMinutes: 40, totalKilocalories: 3000, activeKilocalories: 900,
    allDayStress: { aggregatorList: [{ type: 'TOTAL', averageStressLevel: 31, maxStressLevel: 90 }] },
    bodyBattery: { bodyBatteryStatList: [{ bodyBatteryStatType: 'HIGHEST', statsValue: 88 }, { bodyBatteryStatType: 'LOWEST', statsValue: 20 }] },
    respiration: { avgWakingRespirationValue: 12 } });
  d.uds({ calendarDate: '2026-06-02', allDayStress: { aggregatorList: [{ type: 'TOTAL', averageStressLevel: -1 }] } });
  d.sleep({ calendarDate: '2026-06-01', deepSleepSeconds: 3600, lightSleepSeconds: 14400, remSleepSeconds: 7200, awakeSleepSeconds: 600,
    restlessMomentCount: 30, avgSleepStress: 18, averageRespiration: 14, sleepScores: { overallScore: 81 } });
  d.sleep({ retro: false });
  d.healthStatus({ calendarDate: '2026-06-01', metrics: [{ type: 'HRV', value: 63 }, { type: 'HR', value: 52 }] });
  d.readinessRow({ calendarDate: '2026-06-01', timestamp: '2026-06-01T03:00:00.0', score: 40, inputContext: 'UPDATE_REALTIME_VARIABLES' });
  d.readinessRow({ calendarDate: '2026-06-01', timestamp: '2026-06-01T11:00:00.0', score: 70, inputContext: 'AFTER_WAKEUP_RESET' });
  d.readinessRow({ calendarDate: '2026-06-01', timestamp: '2026-06-01T20:00:00.0', score: 20, inputContext: 'AFTER_POST_EXERCISE_RESET' });
  d.bio({ metaData: { calendarDate: '2026-06-01T07:54:00.0' }, weight: { weight: 87589, bodyFat: 22.2 } });
  d.bio({ metaData: { calendarDate: '2026-06-02T07:54:00.0' }, vo2MaxRunning: 53, lactateThresholdHearRate: 173, lactateThresholdSpeed: 0.36944341 });
  d.race({ calendarDate: '2026-06-02', raceTime5K: 1342, raceTime10K: 2900 });
  const { daily, wellness, metrics } = d.rows();
  assert.deepEqual(daily[0], { day: '2026-06-01', steps: 12000, floors: 10, stress_avg: 31, stress_max: 90, body_battery_high: 88,
    body_battery_low: 20, intensity_minutes: 20, vigorous_minutes: 40, calories_total: 3000, calories_active: 900,
    respiration_avg: 14, deep_s: 3600, light_s: 14400, rem_s: 7200, awake_s: 600, restless_count: 30, avg_stress: 18,
    weight_kg: 87.59, body_fat_pct: 22.2, training_readiness: 70 });
  assert.equal(daily[1].stress_avg, undefined);   // Garmin's -1: no reading
  assert.deepEqual(wellness[0], { day: '2026-06-01', rhr: 47, sleep_hours: 7, sleep_score: 81, hrv_ms: 63 });
  assert.equal(metrics.length, 1);
  assert.deepEqual(metrics[0], { day: '2026-06-02', vo2max: 53, threshold_hr: 173, threshold_speed_m_s: 3.694, races: { 5000: 1342, 10000: 2900 } });
});

test('archive: classify the export layout', () => {
  assert.equal(classify('DI_CONNECT/DI-Connect-Fitness/a@b.com_0_summarizedActivities.json'), 'summaries');
  assert.equal(classify('DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip'), 'fitzip');
  assert.equal(classify('DI_CONNECT/DI-Connect-Device/device-backups-files_Part1.zip'), null);
  assert.equal(classify('DI_CONNECT/DI-Connect-Aggregator/UDSFile_2018-06-29_2018-10-07.json'), 'uds');
  assert.equal(classify('DI_CONNECT/DI-Connect-Aggregator/HydrationLogFile_2022.json'), null);
  assert.equal(classify('DI_CONNECT/DI-Connect-Wellness/2022-08-08_2022-11-16_70711444_sleepData.json'), 'sleep');
  assert.equal(classify('DI_CONNECT/DI-Connect-Metrics/TrainingReadinessDTO_20231024_20240201_70711444.json'), 'readiness');
  assert.equal(classify('x/123.FIT'), 'fit');
});

async function exportZip() {
  const json = o => JSON.stringify(o);
  const monitoring = new FitWriter().def(0, 0, [[0, T.enum]]).data(0, [32]).bytes();
  const uploads = await blobBytes(makeZip([
    { name: 'a@b.com_434779004715.fit', data: sampleActivity({ start: T0 + 5, n: 20 }) },
    { name: 'a@b.com_434779004716.fit', data: monitoring },
    { name: 'a@b.com_434779004717.fit', data: sampleActivity({ start: T0 + 9999, n: 5 }) },   // no summary
    { name: 'a@b.com_434779004718.fit', data: new Uint8Array([1, 2, 3]) },                   // unreadable
  ]));
  return makeZip([
    { name: 'customer_data/customer.json', data: '{}' },
    { name: 'DI_CONNECT/DI-Connect-Fitness/a@b.com_0_summarizedActivities.json', data: json([{ summarizedActivitiesExport: [SUMMARY, OTHER] }]) },
    { name: 'DI_CONNECT/DI-Connect-Aggregator/UDSFile_2023-11-01_2024-02-01.json', data: json([{ calendarDate: '2023-11-14', totalSteps: 9000, restingHeartRate: 48 }]) },
    { name: 'DI_CONNECT/DI-Connect-Wellness/2023-11-01_2024-02-01_1_sleepData.json', data: json([{ calendarDate: '2023-11-14', deepSleepSeconds: 3600, lightSleepSeconds: 18000, sleepScores: { overallScore: 77 } }]) },
    { name: 'DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip', data: uploads },
  ]);
}

test('archive: a whole export -> batches importGarmin takes', async () => {
  const st = emptyState(), streams = new Map(), batches = [], seen = [];
  for await (const p of importArchive(await exportZip(), { onProgress: x => seen.push(x) })) {
    batches.push(p);
    await importGarmin(st, p, async (id, rec) => { streams.set(id, rec); });
  }
  assert.equal(batches.length, 3);   // summaries, days and nights, one detail batch
  assert.deepEqual(Object.keys(st.activities).sort(), ['g111', 'g222']);
  const a = st.activities.g111;
  assert.equal(a.start, '2023-11-14T17:13:20');
  assert.equal(a.distance_m, 57);
  assert.equal(a.calories, 250);
  assert.equal(a.detail, 'ok');
  assert.equal(st.activities.g222.detail, undefined);   // no FIT: summary only
  assert.equal(streams.get('g111').channels.hr.length, 20);
  assert.equal(st.laps.g111.laps.length, 1);
  assert.deepEqual(batches[2].activities[0].hrv_rr, [812, 798, 805]);
  assert.equal(st.daily['2023-11-14'].steps, 9000);
  assert.deepEqual({ ...st.wellness['2023-11-14'], u: undefined }, { rhr: 48, sleep_hours: 6, sleep_score: 77, u: undefined });
  const done = seen.at(-1);
  assert.equal(done.phase, 'done');
  assert.equal(done.files, 4);
  assert.equal(done.filesKnown, 4);
  assert.equal(done.withChannels, 1);
  assert.equal(done.withRR, 1);
  assert.equal(done.notActivity, 1);
  assert.equal(done.unmatched, 1);
  assert.equal(done.failed, 1);
  assert.equal(done.mb, done.mbTotal);
});

test('archive: a plain zip of <activityId>.fit files, no summaries', async () => {
  const z = makeZip([{ name: 'fit/21725246365.fit', data: sampleActivity({ start: T0, n: 10 }) }]);
  const st = emptyState();
  for await (const p of importArchive(z)) await importGarmin(st, p, async () => {});
  const a = st.activities.g21725246365;
  assert.equal(a.start, '2023-11-14T17:13:20');   // the FIT's own local offset
  assert.equal(a.type, 'running');
  assert.equal(a.detail, 'ok');
});

test('archive: batches stay small, cancel stops the walk', async () => {
  const files = [];
  const summaries = [];
  for (let i = 0; i < 7; i++) {
    summaries.push({ ...SUMMARY, activityId: 1000 + i, startTimeGmt: (T0 + i * 3600) * 1000, startTimeLocal: (T0 + i * 3600) * 1000 });
    files.push({ name: `f/${1000 + i}.fit`, data: sampleActivity({ start: T0 + i * 3600, n: 5, rr: null }) });
  }
  files.push({ name: 'DI_CONNECT/DI-Connect-Fitness/x_summarizedActivities.json', data: JSON.stringify([{ summarizedActivitiesExport: summaries }]) });
  const sizes = [];
  for await (const p of importArchive(makeZip(files), { batchSize: 3 })) if (p.activities && p.activities[0].channels) sizes.push(p.activities.length);
  assert.deepEqual(sizes, [3, 3, 1]);
  const ctl = new AbortController();
  await assert.rejects((async () => { for await (const p of importArchive(makeZip(files), { signal: ctl.signal })) ctl.abort(); })(), /cancelled/);
});

test('archive: the panel renders', () => {
  const h = String(archivePanel());
  assert.match(h, /data-archive-file/);
  assert.match(h, /Export your data/);
});

// The real export, when this machine has one: every summary reads, the units come out sane.
const REAL = 'C:\\Users\\Adam Erik Eryavec\\Downloads\\366ba449-ce28-41cc-b707-bfbbf7d732ea_1.zip';
test('archive: real export summaries', { skip: !existsSync(REAL) && 'no Garmin export on this machine' }, async () => {
  let n = 0;
  for await (const p of importArchive(await openAsBlob(REAL))) {
    if (!p.activities || p.activities[0].detail_only) break;   // summaries only: the FIT pass takes a minute
    for (const a of p.activities) {
      n++;
      if (/running/.test(a.type) && a.distance_m && a.moving_s) {
        const pace = a.moving_s / (a.distance_m / 1000);
        assert.ok(pace > 120 && pace < 3600,   // centimetres or milliseconds left unconverted would be 100x off
           `${a.garmin_id} pace ${pace}`);
      }
      if (a.calories) assert.ok(a.calories < 8000, `${a.garmin_id} calories ${a.calories}`);
    }
  }
  assert.ok(n > 100);
});
