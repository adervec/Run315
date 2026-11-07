// Garmin's "Export your data" archive, read in the browser: eight years in one pass,
// including the history Garmin's API no longer serves at full resolution.
//
// The export (a zip, often several GB) holds, under DI_CONNECT/:
//   DI-Connect-Fitness/*_summarizedActivities.json   every activity's summary (cm, ms, kJ!)
//   DI-Connect-Uploaded-Files/UploadedFiles_*.zip    the device's own FIT files, zipped again
//   DI-Connect-Aggregator/UDSFile_*.json             one row per day: steps, stress, body battery...
//   DI-Connect-Wellness/*sleepData.json              one row per night
//   DI-Connect-Wellness/*healthStatusData.json       overnight HRV / HR (recent weeks only)
//   DI-Connect-Wellness/*userBioMetrics.json         weight, VO2max, lactate threshold
//   DI-Connect-Metrics/TrainingReadinessDTO_*.json, RunRacePredictions_*, EnduranceScore_*, HillScore_*
// importArchive turns it into garmin-output payloads (the shape js/ingest.js importGarmin
// reads), a batch at a time, holding one FIT file and one batch of channels at most.
//
// Units, checked against the same activities' FIT sessions: summary distance and elevation
// are centimetres, durations milliseconds, calories kilojoules (857 kcal in the FIT is
// 3590.8 here), speeds tenths of m/s; startTimeLocal is local wall time as epoch ms.
import { listEntries, streamEntry, readEntry, entryBlob } from './zipread.js';
import { decodeFit, fitType } from './fit.js';
import { html } from './ui.js';

// Garmin's sleep timestamps in the export are GMT ('2019-01-16T01:37:00.0'): local 'HH:MM' on this
// device's clock (the athlete's zone, DST included). null when absent.
const localHM = g => {
  if (!g) return null;
  const t = new Date(String(g).replace(/\.\d+$/, '') + 'Z');
  return isNaN(t) ? null : String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
};
export const BATCH = 50;            // activities with channels per yielded payload
export const SUMMARY_BATCH = 500;   // summary-only activities per payload (no channels: small)
const KJ_PER_KCAL = 4.184;

const num = v => (v == null || v === '' || !isFinite(+v) ? null : +v);
const round = (v, dp) => (v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
const dayOf = v => (v == null ? null : typeof v === 'number' ? new Date(v).toISOString().slice(0, 10) : String(v).slice(0, 10));
const localIso = ms => new Date(ms).toISOString().slice(0, 19);
const tick = () => new Promise(r => setTimeout(r, 0));

// ---------------------------------------------------------------- activity summaries
// One summarizedActivities element -> the garmin-output activity shape, plus `gmt` (unix
// seconds, UTC start) for matching FIT files; importGarmin ignores the extra key.
export function activityFromSummary(a) {
  if (!a || a.activityId == null) return null;
  const gmtMs = num(a.startTimeGmt) ?? num(a.beginTimestamp);
  const localMs = num(a.startTimeLocal) ?? gmtMs;
  if (localMs == null) return null;
  const type = a.activityType && typeof a.activityType === 'object' ? a.activityType.typeKey : a.activityType;
  const ms = v => (num(v) == null ? null : round(num(v) / 1000, 3));
  const cm = v => (num(v) == null ? null : round(num(v) / 100, 2));
  return {
    garmin_id: String(a.activityId),
    name: a.name || String(type || 'activity').replace(/_/g, ' '),
    type: type || 'other',
    start: localIso(localMs),
    distance_m: cm(a.distance) || null,
    moving_s: ms(a.movingDuration) ?? ms(a.duration) ?? ms(a.elapsedDuration),
    elapsed_s: ms(a.elapsedDuration) ?? ms(a.duration),
    avg_hr: num(a.avgHr) || null,
    max_hr: num(a.maxHr) || null,
    elev_gain_m: cm(a.elevationGain),
    calories: num(a.calories) == null ? null : Math.round(num(a.calories) / KJ_PER_KCAL),
    gmt: gmtMs == null ? null : Math.round(gmtMs / 1000),
  };
}

// The elements of a JSON array at `depth` brackets in, from a byte stream, without ever
// holding the whole text: summarizedActivities is [{"summarizedActivitiesExport":[ ...
// ]}] and runs to ~90 MB per thousand activities, most of it per-split detail we drop.
export async function* jsonItems(stream, depth) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let d = 0, inStr = false, bs = false, buf = null;
  for (;;) {
    const { done, value: s } = await reader.read();
    if (done) break;
    let from = buf ? 0 : -1;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (inStr) { if (bs) bs = false; else if (c === 92) bs = true; else if (c === 34) inStr = false; continue; }
      if (c === 34) inStr = true;
      else if (c === 123 || c === 91) { if (d === depth && !buf) { buf = []; from = i; } d++; }
      else if (c === 125 || c === 93) {
        d--;
        if (d === depth && buf) { buf.push(s.slice(from, i + 1)); const text = buf.join(''); buf = null; yield JSON.parse(text); }
      }
    }
    if (buf) buf.push(s.slice(from));
  }
}

// ---------------------------------------------------------------- FIT -> channels
const RUNLIKE = new Set([1, 11, 17]);   // running, walking, hiking: cadence counts both feet
// A decoded FIT -> the channel dict js/ingest.js and tools/garmin_fetch.py use, or null.
// `seconds` is elapsed time from the session start (pauses included: the stops analysis
// needs to see them); samples without a distance are left out, as the API fetch does.
export function channelsFromFit(fit) {
  const recs = fit.records.filter(r => r.timestamp != null && r.distance != null);
  if (recs.length < 2) return null;
  const t0 = (fit.session && fit.session.start_time) ?? recs[0].timestamp;
  const runlike = RUNLIKE.has(fit.sport), bike = fit.sport === 2;
  const col = f => { const c = recs.map(f); return c.some(v => v != null) ? c : null; };
  const ch = { seconds: recs.map(r => r.timestamp - t0), metres: recs.map(r => round(r.distance, 2)) };
  const add = (k, f) => { const c = col(f); if (c) ch[k] = c; };
  const pos = r => r.position_lat != null && r.position_long != null && !(r.position_lat === 0 && r.position_long === 0);
  add('hr', r => (r.heart_rate ? r.heart_rate : null));
  add('lat', r => (pos(r) ? round(r.position_lat, 7) : null));
  add('lon', r => (pos(r) ? round(r.position_long, 7) : null));
  add('elevation_m', r => round(r.enhanced_altitude ?? r.altitude ?? null, 1));
  if (bike) add('bike_cadence_rpm', r => r.cadence ?? null);
  else add('cadence_spm', r => (r.cadence == null ? null : round((r.cadence + (runlike ? r.fractional_cadence || 0 : 0)) * 2, 1)));
  add('power_w', r => r.power ?? null);
  add('speed_m_s', r => round(r.enhanced_speed ?? r.speed ?? null, 3));
  add('stride_m', r => (r.step_length ? round(r.step_length / 1000, 3) : null));
  add('gct_ms', r => (r.stance_time ? round(r.stance_time, 1) : null));
  add('vertical_oscillation_cm', r => (r.vertical_oscillation ? round(r.vertical_oscillation / 10, 2) : null));
  add('vertical_ratio_pct', r => (r.vertical_ratio ? round(r.vertical_ratio, 2) : null));
  add('gct_balance_left_pct', r => (r.stance_time_balance ? round(r.stance_time_balance, 2) : null));
  add('air_temp_c', r => r.temperature ?? null);
  add('respiration_brpm', r => (r.respiration_rate ? round(r.respiration_rate, 2) : null));
  return ch;
}

// FIT laps -> the lap shape garmin_fetch.fetch_activity_extras writes (avg_cadence as the
// watch reports it: per leg for runs, like Garmin's averageRunCadence).
export function lapsFromFit(fit) {
  return fit.laps.map((l, i) => ({
    index: (l.message_index ?? i) + 1,
    distance_m: round(l.total_distance ?? null, 2),
    duration_s: round(l.total_timer_time ?? l.total_elapsed_time ?? null, 3),
    avg_hr: l.avg_heart_rate || null,
    max_hr: l.max_heart_rate || null,
    avg_speed: l.enhanced_avg_speed ?? l.avg_speed ?? null,
    elev_gain_m: l.total_ascent ?? null,
    avg_cadence: l.avg_cadence == null ? null : round(l.avg_cadence + (l.avg_fractional_cadence || 0), 2),
    avg_power: l.avg_power ?? null,
  }));
}

// An activity from its FIT alone, for a zip of <activityId>.fit files with no summaries.
export function activityFromFit(fit, garminId) {
  const s = fit.session || {};
  const t0 = s.start_time ?? (fit.records[0] && fit.records[0].timestamp);
  if (t0 == null) return null;
  const off = fit.local_offset_s != null && Math.abs(fit.local_offset_s) <= 14 * 3600 ? fit.local_offset_s : 0;
  return {
    garmin_id: String(garminId), name: fitType(fit.sport, fit.sub_sport).replace(/_/g, ' '),
    type: fitType(fit.sport, fit.sub_sport), start: localIso((t0 + off) * 1000),
    distance_m: s.total_distance ?? null, moving_s: s.total_timer_time ?? null, elapsed_s: s.total_elapsed_time ?? null,
    avg_hr: s.avg_heart_rate || null, max_hr: s.max_heart_rate || null, elev_gain_m: s.total_ascent ?? null,
    calories: s.total_calories ?? null, gmt: t0,
  };
}

// Summaries indexed for matching a FIT: by Garmin activity id, else by UTC start.
export function summaryIndex(list) {
  const byId = new Map(), byTime = [];
  for (const a of list) { byId.set(a.garmin_id, a); if (a.gmt != null) byTime.push(a); }
  byTime.sort((x, y) => x.gmt - y.gmt);
  return {
    byId, size: byId.size,
    match(fileName, fitStart) {
      for (const m of String(fileName).matchAll(/\d{6,}/g)) if (byId.has(m[0])) return byId.get(m[0]);
      if (fitStart == null) return null;
      let lo = 0, hi = byTime.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (byTime[mid].gmt < fitStart) lo = mid + 1; else hi = mid; }
      let best = null;
      for (const i of [lo - 1, lo]) {
        const a = byTime[i];
        if (a && Math.abs(a.gmt - fitStart) <= 120 && (!best || Math.abs(a.gmt - fitStart) < Math.abs(best.gmt - fitStart))) best = a;
      }
      return best;
    },
  };
}

// ---------------------------------------------------------------- days and nights
// Accumulates the by-day files into daily / wellness / metrics rows (the importGarmin
// shapes, same column names tools/garmin_fetch.py writes).
export class Days {
  constructor() { this.daily = new Map(); this.wellness = new Map(); this.metrics = new Map(); this.readiness = new Map(); }
  set(coll, day, vals) {
    if (!day) return;
    const m = this[coll], row = m.get(day) || { day };
    for (const [k, v] of Object.entries(vals)) if (v != null && (row[k] == null || !vals._weak)) row[k] = v;
    delete row._weak;
    m.set(day, row);
  }
  uds(r) {
    const day = dayOf(r.calendarDate);
    if (!day) return;
    const agg = ((r.allDayStress && r.allDayStress.aggregatorList) || []).find(x => x.type === 'TOTAL') || {};
    const bb = ((r.bodyBattery && r.bodyBattery.bodyBatteryStatList) || []);
    const stat = t => { const s = bb.find(x => x.bodyBatteryStatType === t); return s ? num(s.statsValue) : null; };
    const pos = v => (num(v) != null && num(v) >= 0 ? num(v) : null);
    this.set('daily', day, {
      steps: num(r.totalSteps), floors: num(r.floorsAscendedInMeters) == null ? null : Math.round(r.floorsAscendedInMeters / 3.048),
      stress_avg: pos(agg.averageStressLevel), stress_max: pos(agg.maxStressLevel),
      body_battery_high: stat('HIGHEST'), body_battery_low: stat('LOWEST'),
      intensity_minutes: num(r.moderateIntensityMinutes), vigorous_minutes: num(r.vigorousIntensityMinutes),
      calories_total: num(r.totalKilocalories), calories_active: num(r.activeKilocalories),
      spo2_avg: num(r.averageSpo2), spo2_low: num(r.lowestSpo2),
    });
    // Waking respiration only if the night gave none (the API prefers the sleeping figure).
    if (r.respiration) this.set('daily', day, { _weak: true, respiration_avg: num(r.respiration.avgSleepRespirationValue) ?? num(r.respiration.avgWakingRespirationValue) });
    this.set('wellness', day, { _weak: true, rhr: num(r.restingHeartRate) || null });
  }
  sleep(r) {
    // A window the watch says it was off the wrist for has no timing worth keeping.
    if (r.sleepWindowConfirmationType === 'OFF_WRIST') { r = { ...r, sleepStartTimestampGMT: null, sleepEndTimestampGMT: null }; }
    const day = dayOf(r.calendarDate);
    if (!day) return;
    const asleep = ['deepSleepSeconds', 'lightSleepSeconds', 'remSleepSeconds'].map(k => num(r[k]) || 0).reduce((a, b) => a + b, 0);
    const sc = r.sleepScores || {};
    this.set('wellness', day, {
      sleep_hours: asleep ? round(asleep / 3600, 3) : null,
      sleep_score: num(sc.overallScore) ?? num(sc.overall && sc.overall.value),
    });
    this.set('daily', day, {
      deep_s: num(r.deepSleepSeconds), light_s: num(r.lightSleepSeconds), rem_s: num(r.remSleepSeconds),
      awake_s: num(r.awakeSleepSeconds), restless_count: num(r.restlessMomentCount ?? r.restlessMomentsCount),
      avg_stress: num(r.avgSleepStress), respiration_avg: num(r.averageRespiration),
      sleep_start: localHM(r.sleepStartTimestampGMT), sleep_end: localHM(r.sleepEndTimestampGMT),
    });
  }
  healthStatus(r) {
    const day = dayOf(r.calendarDate), m = t => ((r.metrics || []).find(x => x.type === t) || {}).value;
    this.set('wellness', day, { hrv_ms: num(m('HRV')) });
    this.set('wellness', day, { _weak: true, rhr: num(m('HR')) });
  }
  hrvStatus(r) {   // lenient: Garmin's hrvStatus rows, if an export carries them
    const s = r.hrvSummary || r;
    this.set('wellness', dayOf(s.calendarDate || r.calendarDate), { hrv_ms: num(s.lastNightAvg), hrv_status: s.status || null });
  }
  readinessRow(r) {
    const day = dayOf(r.calendarDate);
    if (!day || num(r.score) == null) return;
    // The morning figure is the one the watch shows on waking; else the day's first.
    const rank = r.inputContext === 'AFTER_WAKEUP_RESET' ? 0 : 1, ts = String(r.timestamp || '');
    const cur = this.readiness.get(day);
    if (!cur || rank < cur.rank || (rank === cur.rank && ts < cur.ts)) this.readiness.set(day, { rank, ts, score: num(r.score) });
  }
  bio(r) {
    const day = dayOf(r.metaData && r.metaData.calendarDate);
    if (!day) return;
    const w = r.weight || {};
    if (num(w.weight)) this.set('daily', day, { weight_kg: round(w.weight > 500 ? w.weight / 1000 : w.weight, 2), body_fat_pct: num(w.bodyFat) });
    const lt = num(r.lactateThresholdSpeed);   // tenths of m/s, like the summaries' speeds
    this.set('metrics', day, { vo2max: num(r.vo2MaxRunning), threshold_hr: num(r.lactateThresholdHearRate ?? r.lactateThresholdHeartRate),
      threshold_speed_m_s: lt ? round(lt < 1.5 ? lt * 10 : lt, 3) : null });
  }
  race(r) {
    const races = {};
    for (const [d, k] of [[5000, 'raceTime5K'], [10000, 'raceTime10K'], [21097, 'raceTimeHalf'], [42195, 'raceTimeMarathon']]) if (num(r[k])) races[d] = num(r[k]);
    if (Object.keys(races).length) this.set('metrics', dayOf(r.calendarDate), { races });
  }
  score(r, key) { this.set('metrics', dayOf(r.calendarDate), { [key]: num(r.overallScore) }); }
  // -> { daily, wellness, metrics }. Metrics are kept one row per week (the week's last),
  // so eight years of daily race predictions stay a few hundred rows.
  rows() {
    for (const [day, r] of this.readiness) this.set('daily', day, { training_readiness: r.score });
    const weekly = new Map();
    for (const row of [...this.metrics.values()].sort((a, b) => (a.day < b.day ? -1 : 1))) {
      const d = new Date(row.day + 'T00:00:00Z'), wk = new Date(d - ((d.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
      weekly.set(wk, { ...(weekly.get(wk) || {}), ...row });
    }
    const sorted = m => [...m.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
    return { daily: sorted(this.daily), wellness: sorted(this.wellness), metrics: sorted(weekly) };
  }
}

// Which part of the export a zip entry is. Lenient about prefixes and numbering.
export function classify(name) {
  const base = name.split('/').pop();
  if (/\.fit$/i.test(base)) return 'fit';
  if (/\.zip$/i.test(base)) return /Uploaded|\bfit\b/i.test(name) ? 'fitzip' : null;
  if (!/\.json$/i.test(base)) return null;
  if (/summarizedActivities/i.test(base)) return 'summaries';
  if (/^UDSFile/i.test(base)) return 'uds';
  if (/sleepData/i.test(base)) return 'sleep';
  if (/healthStatusData/i.test(base)) return 'health';
  if (/hrvStatus|hrvData/i.test(base)) return 'hrv';
  if (/TrainingReadiness/i.test(base)) return 'readiness';
  if (/userBioMetrics\.json$/i.test(base)) return 'bio';
  if (/RunRacePredictions/i.test(base)) return 'race';
  if (/EnduranceScore/i.test(base)) return 'endurance';
  if (/HillScore/i.test(base)) return 'hill';
  return null;
}

// ---------------------------------------------------------------- the walk
// Yields garmin-output payloads: summary batches (every activity, no channels), one
// days-and-nights batch, then detail batches of <= BATCH activities ({garmin_id,
// detail_only, channels, laps, hrv_rr}) as the FIT files are read. Feed each to
// importGarmin and drop it. onProgress gets {phase, files, filesKnown, mb, mbTotal, ...}.
export async function* importArchive(file, { onProgress = () => {}, signal, batchSize = BATCH } = {}) {
  const stats = { phase: 'scan', files: 0, filesKnown: 0, mb: 0, mbTotal: 0, activities: 0, withChannels: 0,
    withRR: 0, unmatched: 0, notActivity: 0, failed: 0, days: 0, nights: 0, summaries: 0 };
  const report = () => onProgress({ ...stats, mb: round(stats.mb, 1), mbTotal: round(stats.mbTotal, 1) });
  const stop = () => { if (signal && signal.aborted) throw new DOMException('Import cancelled', 'AbortError'); };
  const entries = await listEntries(file);
  const kinds = new Map();
  for (const e of entries) { const k = classify(e.name); if (k) (kinds.get(k) || kinds.set(k, []).get(k)).push(e); }
  const of = k => kinds.get(k) || [];
  stats.mbTotal = [...of('fit'), ...of('fitzip')].reduce((a, e) => a + e.csize, 0) / 1e6;
  stats.filesKnown = of('fit').length;
  report();

  // 1. Summaries: every activity, streamed so the 90 MB files never sit in memory as text.
  stats.phase = 'summaries'; report();
  const summaries = [];
  let out = [];
  for (const e of of('summaries')) {
    let n = 0;
    for (const depth of [3, 1]) {
      for await (const item of jsonItems(await streamEntry(file, e), depth)) {
        const a = activityFromSummary(item);
        if (!a) continue;
        n++; summaries.push(a); out.push(a);
        if (out.length >= SUMMARY_BATCH) { stop(); yield { activities: strip(out) }; out = []; await tick(); }
      }
      if (n) break;
    }
  }
  if (out.length) yield { activities: strip(out) };
  out = [];
  stats.summaries = summaries.length; stats.activities = summaries.length;
  const index = summaryIndex(summaries);
  report();

  // 2. Days and nights: small files, parsed whole.
  stats.phase = 'wellness'; report();
  const days = new Days();
  const each = async (k, fn) => {
    for (const e of of(k)) {
      stop();
      let j;
      try { j = JSON.parse(new TextDecoder().decode(await readEntry(file, e))); } catch { stats.failed++; continue; }
      for (const r of Array.isArray(j) ? j : [j]) if (r && typeof r === 'object') fn(r);
      await tick();
    }
  };
  await each('uds', r => days.uds(r));
  await each('sleep', r => days.sleep(r));
  await each('health', r => days.healthStatus(r));
  await each('hrv', r => days.hrvStatus(r));
  await each('readiness', r => days.readinessRow(r));
  await each('bio', r => days.bio(r));
  await each('race', r => days.race(r));
  await each('endurance', r => days.score(r, 'endurance_score'));
  await each('hill', r => days.score(r, 'hill_score'));
  const dw = days.rows();
  stats.days = dw.daily.length; stats.nights = dw.wellness.length;
  if (dw.daily.length || dw.wellness.length || dw.metrics.length) yield dw;
  report();

  // 3. FIT files, one at a time, in batches of channels.
  stats.phase = 'fit'; report();
  const seen = new Set();
  let batch = [];
  const one = async (blob, e) => {
    stop();
    try {
      const fit = decodeFit(await readEntry(blob, e));
      if (fit.file_type !== 4) { stats.notActivity++; return; }
      const start = (fit.session && fit.session.start_time) ?? (fit.records[0] && fit.records[0].timestamp);
      let a = index.match(e.name, start);
      let fromFit = null;
      if (!a && !index.size) {   // a plain zip of <activityId>.fit files, no summaries to lean on
        const id = (/(\d{8,})\.fit$/i.exec(e.name) || [])[1];
        if (id) fromFit = activityFromFit(fit, id);
      }
      if (!a && !fromFit) { stats.unmatched++; return; }
      const id = a ? a.garmin_id : fromFit.garmin_id;
      if (seen.has(id)) return;   // the same activity uploaded twice
      seen.add(id);
      const rec = fromFit ? { ...strip([fromFit])[0] } : { garmin_id: id, detail_only: true };
      rec.channels = channelsFromFit(fit);
      const laps = lapsFromFit(fit);
      if (laps.length) rec.laps = laps;
      if (fit.rr_ms.length) { rec.hrv_rr = fit.rr_ms; stats.withRR++; }
      if (rec.channels) stats.withChannels++;
      if (fromFit) stats.activities++;
      batch.push(rec);
    } catch { stats.failed++; }
  };
  const flush = function* () { if (batch.length) { const p = { activities: batch }; batch = []; yield p; } };
  const after = async () => { stats.files++; if (stats.files % 10 === 0) report(); await tick(); };
  for (const e of of('fit')) {
    await one(file, e); stats.mb += e.csize / 1e6; await after();
    if (batch.length >= batchSize) yield* flush();
  }
  for (const z of of('fitzip')) {
    stop();
    let inner, list;
    try { inner = await entryBlob(file, z); list = (await listEntries(inner)).filter(x => /\.fit$/i.test(x.name)); } catch { stats.failed++; continue; }
    stats.filesKnown += list.length;
    const scale = list.reduce((a, x) => a + x.csize, 0) || 1;
    for (const e of list) {
      await one(inner, e); stats.mb += (e.csize / scale) * z.csize / 1e6; await after();
      if (batch.length >= batchSize) yield* flush();
    }
    inner = null;
  }
  yield* flush();
  stats.phase = 'done'; report();
}
const strip = list => list.map(({ gmt, ...a }) => a);

// ---------------------------------------------------------------- the panel
export function archivePanel() {
  return html`<section class="panel" data-archive style="grid-column:1/-1"><div class="panel-head"><p class="eyebrow">Garmin export archive</p>
      <p class="panel-note">Everything at once, read on this device</p></div>
    <p class="panel-note" style="margin:0 0 12px">Ask Garmin for <b>Export your data</b> (Garmin account &rarr; Data management &rarr; Export your data); the zip arrives by email.
      Choose it here: it is read in place, a file at a time, and nothing is uploaded anywhere.</p>
    <div class="row-actions">
      <label class="btn btn-ghost">Choose the export zip<input type="file" accept=".zip,application/zip" data-archive-file hidden></label>
      <button class="btn-quiet" data-archive-cancel hidden>Cancel</button>
    </div>
    <div data-archive-progress hidden style="margin-top:12px"><progress max="1" value="0" style="width:100%"></progress>
      <p class="panel-note" data-archive-status style="margin:6px 0 0"></p></div>
    <div data-archive-result></div>
    <details style="margin-top:12px"><summary class="panel-note">What the export has, and what it does not</summary>
      <ul class="panel-note">
        <li>Has: every activity's summary since the account began; the watch's own FIT files at one-second resolution, with heart rate, GPS, power and running dynamics, and beat-to-beat intervals where HRV logging was switched on; daily steps, stress, body battery, intensity minutes and calories; sleep stages and scores; training readiness (from 2022); weight; VO2max, lactate threshold and race predictions.</li>
        <li>Thin: overnight HRV covers only Garmin's recent weeks (healthStatusData), not the years of HRV status the app can show.</li>
        <li>Not there: weather, which shoes each activity used, Strava; activities typed in by hand or from apps that sent no file have a summary but no trace. A FIT that matches no summary is skipped.</li>
        <li>Safe to repeat: activities keep their Garmin ids, so a second import updates instead of duplicating. A big export takes minutes; keep the tab open.</li>
      </ul></details></section>`;
}

// Wires archivePanel()'s markup inside `el`. onBatch(payload) is awaited per payload.
// -> cleanup (cancels a running import).
export function mountArchive(el, { onBatch, onDone } = {}) {
  const root = el.querySelector('[data-archive]') || el;
  const input = root.querySelector('[data-archive-file]'), cancel = root.querySelector('[data-archive-cancel]');
  const box = root.querySelector('[data-archive-progress]'), bar = box && box.querySelector('progress');
  const status = root.querySelector('[data-archive-status]'), result = root.querySelector('[data-archive-result]');
  if (!input) return () => {};
  let ctl = null;
  const show = p => {
    if (!box) return;
    box.hidden = false;
    const phase = { scan: 'Reading the archive', summaries: 'Activity summaries', wellness: 'Days and nights', fit: 'FIT files', done: 'Done' }[p.phase] || p.phase;
    if (bar) { bar.max = p.mbTotal || 1; bar.value = p.phase === 'done' ? bar.max : p.mb; }
    status.textContent = `${phase} · ${p.summaries} activities · ${p.files}/${p.filesKnown} files · ${p.mb} / ${p.mbTotal} MB · ${p.withChannels} traces`;
  };
  const onChange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    ctl = new AbortController(); input.disabled = true; if (cancel) cancel.hidden = false;
    if (result) result.innerHTML = '';
    let last = null;
    try {
      for await (const payload of importArchive(f, { signal: ctl.signal, onProgress: p => { last = p; show(p); } })) {
        if (onBatch) await onBatch(payload);
        if (ctl.signal.aborted) break;
      }
      if (result && last) result.innerHTML = String(html`<dl class="kv" style="margin-top:12px">
        <dt>Activities</dt><dd>${last.summaries}</dd><dt>With a full trace</dt><dd>${last.withChannels}</dd>
        <dt>With beat-to-beat HRV</dt><dd>${last.withRR}</dd><dt>Days / nights</dt><dd>${last.days} / ${last.nights}</dd>
        <dt>Other device files</dt><dd>${last.notActivity}</dd><dt>FIT with no summary</dt><dd>${last.unmatched}</dd>
        ${last.failed ? html`<dt>Unreadable</dt><dd class="bad">${last.failed}</dd>` : ''}</dl>`);
      if (onDone) onDone(last);
    } catch (e) {
      if (result) result.innerHTML = String(html`<p class="panel-note bad">${e.name === 'AbortError' ? 'Cancelled; what was imported so far is kept.' : 'Import stopped: ' + e.message}</p>`);
    } finally { input.disabled = false; input.value = ''; if (cancel) cancel.hidden = true; ctl = null; }
  };
  const onCancel = () => ctl && ctl.abort();
  input.addEventListener('change', onChange);
  if (cancel) cancel.addEventListener('click', onCancel);
  return () => { onCancel(); input.removeEventListener('change', onChange); if (cancel) cancel.removeEventListener('click', onCancel); };
}
