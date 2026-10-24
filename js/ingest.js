// Garmin and Strava, in: the importers for the cowork replies tools/garmin-export.py and
// tools/strava-export.py write (or an agent writes in the same shape). Pure apart from
// the `putStream` callback, so node can test them.
//
// One run recorded by the watch and uploaded to Strava is one activity, not two. Garmin
// is the record of truth (it has the wide channel capture, laps, weather, gear); Strava
// adds its id, name and suffer score to the matching Garmin record, and only becomes its
// own activity when nothing on Garmin's side matches -- a phone-recorded run, a ride on
// another device. Matching is by the Garmin id Strava kept, else by start time and
// distance, and dedupe() re-runs after every import so the order never matters.
import { put, remove } from './merge.js';
import { normalise as normaliseWeather } from './lib/weather.js';

export const MATCH_WINDOW_MIN = 10;
const DISTANCE_TOLERANCE = 0.15;

// Strava sport_type -> the Garmin typeKey the analysis modules already understand.
const STRAVA_TYPES = {
  Run: 'running', TrailRun: 'trail_running', VirtualRun: 'virtual_run',
  Ride: 'cycling', VirtualRide: 'virtual_ride', MountainBikeRide: 'mountain_biking',
  GravelRide: 'gravel_cycling', EBikeRide: 'cycling', EMountainBikeRide: 'mountain_biking',
  Walk: 'walking', Hike: 'hiking', Swim: 'lap_swimming', Rowing: 'rowing',
  VirtualRow: 'indoor_rowing', Elliptical: 'elliptical', StairStepper: 'stair_climbing',
  WeightTraining: 'strength_training', Workout: 'cardio', Yoga: 'yoga',
};
export function stravaType(a) {
  const t = a.sport_type || a.type || 'Workout';
  if (t === 'Run' && a.trainer) return 'treadmill_running';
  if (t === 'Ride' && a.trainer) return 'indoor_cycling';
  return STRAVA_TYPES[t] || t.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
}

// '2026-08-18T07:00:00Z' -> '2026-08-18T07:00:00'. Strava's start_date_local is local wall
// time with a misleading Z; Garmin's start is local wall time too, so they compare directly.
const localIso = s => (s ? String(s).replace(' ', 'T').slice(0, 19) : null);
const minutesApart = (a, b) => Math.abs(new Date(a) - new Date(b)) / 60000;
const num = v => (v == null || v === '' || !isFinite(+v) ? null : +v);

// The activity on the other side that is this same session, or null: started within
// MATCH_WINDOW_MIN of it, and (when both know their distance) within 15% of its length.
function findTwin(st, start, distance, wantSource, exceptId) {
  let best = null, bestGap = Infinity;
  for (const a of Object.values(st.activities)) {
    if (a.source !== wantSource || a.id === exceptId) continue;
    const gap = minutesApart(a.start, start);
    if (gap > MATCH_WINDOW_MIN || gap >= bestGap) continue;
    if (distance && a.distance_m && Math.abs(a.distance_m / distance - 1) > DISTANCE_TOLERANCE) continue;
    best = a; bestGap = gap;
  }
  return best;
}
// Strava keeps the uploader's own id: a watch sync arrives as "garmin_push_<activityId>"
// (or garmin_ping_, or the bare id in a .fit name). That is an exact match, not a guess.
export function garminIdFromStrava(a) {
  const m = /garmin[_a-z]*?_?(\d{6,})/i.exec(String(a.external_id || ''));
  return m ? m[1] : null;
}

// One session, one activity -- whatever order Garmin and Strava arrived in. Runs after
// every import. Each Strava-only activity is folded into its Garmin twin (by the Garmin id
// Strava kept, else by start time and distance); a second Strava upload of a session that
// is already linked is dropped as the duplicate it is. -> how many records it removed.
export function dedupe(st) {
  let removed = 0;
  const drop = s => {
    remove(st, 'activities', s.id);
    if (st.derived[s.id]) remove(st, 'derived', s.id);
    if (st.activityGear[s.id]) remove(st, 'activityGear', s.id);
    removed++;
  };
  for (const s of Object.values(st.activities)) {
    if (s.source !== 'strava' || !st.activities[s.id]) continue;
    const hinted = s.garmin_hint && st.activities['g' + s.garmin_hint];
    const g = hinted || findTwin(st, s.start, s.distance_m, 'garmin');
    if (g) {
      if (!g.strava_id || g.strava_id === s.strava_id) {
        const gear = st.activityGear[s.id], ggear = st.activityGear[g.id];
        if (gear && !ggear) put(st, 'activityGear', g.id, gear);
        put(st, 'activities', g.id, { ...g, strava_id: s.strava_id, strava_name: s.strava_name, suffer_score: s.suffer_score, kudos: s.kudos });
      }
      drop(s);
      continue;
    }
    // Two Strava-only copies of one session (re-uploaded, or recorded by two apps): keep the first.
    const other = findTwin(st, s.start, s.distance_m, 'strava', s.id);
    if (other) drop(String(other.strava_id) > String(s.strava_id) ? other : s);
  }
  return removed;
}

// The legacy 10-wide sample view of a channel capture, as garmin_fetch.streams_from_channels:
// [seconds, metres, hr, lat, lon, elevation, cadence, stride_m, gct_ms, vertical_oscillation_cm].
// Every analysis module reads this shape.
export function samplesFromChannels(ch) {
  if (!ch || !ch.seconds || !ch.metres) return [];
  const n = ch.seconds.length, col = k => ch[k] || null, at = (c, i) => (c ? c[i] ?? null : null);
  const hr = col('hr'), lat = col('lat'), lon = col('lon'),
    ele = col('elevation_m') || col('gps_elevation_m'),
    cad = col('cadence_spm') || col('run_cadence_spm'),
    stride = col('stride_m'), gct = col('gct_ms'), vo = col('vertical_oscillation_cm');
  const out = [];
  for (let i = 0; i < n; i++)
    out.push([ch.seconds[i], ch.metres[i], at(hr, i), at(lat, i), at(lon, i), at(ele, i),
      at(cad, i), at(stride, i), at(gct, i), at(vo, i)]);
  return out;
}

// Strava's key_by_type streams -> the same channel dict Garmin's capture uses.
export function channelsFromStrava(s, type) {
  if (!s || !s.time || !s.distance) return null;
  const ll = s.latlng || [];
  const ch = { seconds: s.time.map(Number), metres: s.distance.map(Number) };
  if (s.heartrate) ch.hr = s.heartrate;
  if (ll.length) { ch.lat = ll.map(p => (p ? p[0] : null)); ch.lon = ll.map(p => (p ? p[1] : null)); }
  if (s.altitude) ch.elevation_m = s.altitude;
  // Strava reports running cadence per leg; Garmin's cadence_spm counts both feet.
  if (s.cadence) ch[/run/.test(type) ? 'cadence_spm' : 'bike_cadence_rpm'] =
    /run/.test(type) ? s.cadence.map(c => (c == null ? null : c * 2)) : s.cadence;
  if (s.watts) ch.power_w = s.watts;
  if (s.velocity_smooth) ch.speed_m_s = s.velocity_smooth;
  if (s.grade_smooth) ch.grade_pct = s.grade_smooth;
  if (s.temp) ch.air_temp_c = s.temp;
  return ch.seconds.length > 1 ? ch : null;
}

// Merge a by-day row: incoming non-null values overwrite, missing ones keep what was there.
function putDay(st, coll, row) {
  if (!row || !row.day) return false;
  const { day, ...vals } = row, cur = st[coll][day] || {};
  const next = { ...cur };
  let changed = false;
  for (const [k, v] of Object.entries(vals)) if (v != null && next[k] !== v) { next[k] = v; changed = true; }
  if (changed || !st[coll][day]) put(st, coll, day, next);
  return changed;
}

// garmin-output payload -> state. Returns counts plus the ids whose stream is new.
export async function importGarmin(st, p, putStream) {
  const res = { activities: 0, details: 0, days: 0, nights: 0, gear: 0, streams: [] };
  for (const a of p.activities || []) {
    if (!a || !a.garmin_id) continue;
    const id = 'g' + a.garmin_id;
    const cur = st.activities[id];
    if (!a.detail_only) {
      const start = localIso(a.start);
      const rec = {
        ...(cur || {}), id, source: 'garmin', garmin_id: String(a.garmin_id),
        name: a.name, type: a.type || 'other', start,
        distance_m: num(a.distance_m), moving_s: num(a.moving_s), elapsed_s: num(a.elapsed_s),
        avg_hr: num(a.avg_hr), max_hr: num(a.max_hr), elev_gain_m: num(a.elev_gain_m), calories: num(a.calories),
      };
      put(st, 'activities', id, rec);
      res.activities++;
    } else if (!cur) continue;   // details for an activity we do not have: nothing to hang them on
    if ('channels' in a) {
      if (a.channels && a.channels.seconds) {
        await putStream(id, { id, src: 'garmin', channels: a.channels });
        res.streams.push(id);
      }
      res.details++;
      put(st, 'activities', id, { ...st.activities[id], detail: a.channels ? 'ok' : (a.detail_error || 'none') });
    }
    if (a.laps && a.laps.length) put(st, 'laps', id, { laps: a.laps });
    if (a.weather_raw) { const wx = normaliseWeather(a.weather_raw); if (wx) put(st, 'weather', id, wx); }
    if (a.gear && a.gear.length) put(st, 'activityGear', id, { uuids: a.gear.map(String) });
  }
  for (const r of p.daily || []) if (putDay(st, 'daily', r)) res.days++;
  for (const r of p.wellness || []) if (putDay(st, 'wellness', r)) res.nights++;
  for (const r of p.metrics || []) putDay(st, 'metrics', r);
  for (const g of p.gear || []) {
    if (!g || !g.uuid) continue;
    const cur = st.gear[g.uuid] || {};
    // ponytail: a replace-at figure already on the record wins (the user may have set it on the
    // gear page); Garmin's only fills an empty one. A user_limit flag if Garmin edits must win too.
    put(st, 'gear', String(g.uuid), { ...cur, ...g, uuid: String(g.uuid), limit_m: cur.limit_m ?? g.limit_m ?? null }); res.gear++;
  }
  for (const pr of p.personalRecords || []) if (pr && pr.type_id != null) put(st, 'personalRecords', String(pr.type_id), pr);
  res.remaining = p.remainingDetail || 0;
  res.deduped = dedupe(st);
  return res;
}

// strava-output payload -> state.
export async function importStrava(st, p, putStream, hasStream) {
  const res = { activities: 0, linked: 0, inserted: 0, streams: [] };
  for (const a of p.activities || []) {
    if (!a || a.id == null) continue;
    const sid = String(a.id);
    let target = Object.values(st.activities).find(x => x.strava_id === sid) || null;
    if (!a.streams_only) {
      const start = localIso(a.start_date_local || a.start_date), type = stravaType(a);
      const hint = garminIdFromStrava(a);
      if (!target && hint && st.activities['g' + hint]) target = st.activities['g' + hint];
      if (!target) target = findTwin(st, start, num(a.distance), 'garmin');
      // A Garmin activity already linked to a different Strava id: this one is a re-upload.
      if (target && target.source === 'garmin' && target.strava_id && target.strava_id !== sid) { res.duplicates = (res.duplicates || 0) + 1; continue; }
      const extra = { strava_id: sid, strava_name: a.name, suffer_score: num(a.suffer_score), kudos: num(a.kudos_count), ...(hint ? { garmin_hint: hint } : {}) };
      if (target && target.source === 'garmin') {
        if (!target.strava_id) res.linked++;
        put(st, 'activities', target.id, { ...target, ...extra });
      } else {
        const id = 's' + sid;
        if (!st.activities[id]) res.inserted++;
        target = put(st, 'activities', id, {
          ...(st.activities[id] || {}), ...extra, id, source: 'strava', name: a.name, type, start,
          distance_m: num(a.distance), moving_s: num(a.moving_time), elapsed_s: num(a.elapsed_time),
          avg_hr: num(a.average_heartrate), max_hr: num(a.max_heartrate),
          elev_gain_m: num(a.total_elevation_gain), calories: num(a.calories),
        });
        if (a.gear_id) put(st, 'activityGear', id, { uuids: ['strava:' + a.gear_id] });
      }
      res.activities++;
    }
    // A Garmin capture beats Strava's resampled streams; only fill a gap with them.
    if (target && a.streams && !(await hasStream(target.id, 'garmin'))) {
      const ch = channelsFromStrava(a.streams, target.type);
      if (ch) { await putStream(target.id, { id: target.id, src: 'strava', channels: ch }); res.streams.push(target.id); }
    }
  }
  for (const g of p.gear || []) {
    if (!g || !g.id) continue;
    const uuid = 'strava:' + g.id;
    put(st, 'gear', uuid, { ...(st.gear[uuid] || {}), uuid, name: g.name, type: g.type === 'bikes' ? 'bike' : 'shoes',
      retired: !!g.retired, source: 'strava' });
  }
  res.remaining = p.remainingStreams || 0;
  res.deduped = dedupe(st);
  return res;
}
