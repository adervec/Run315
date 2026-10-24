// The synced state and how two copies of it merge. Pure: no storage, no network.
//
// Every synced collection is an object keyed by a stable id (an activity id, a day,
// a race id), and every record carries `u`, the ISO time it last changed. Merging
// two devices is then one rule for everything: union by key, newer `u` wins, and a
// tombstone deletes a record only when the deletion is at least as new as its last
// edit -- so an edit made on the phone after a delete on the desktop survives.
// This is GymTracker's per-record merge with the per-collection special cases gone.

export const SCHEMA = 1;

// Collections that travel between devices. Everything else in state is device-local.
export const SYNCED = [
  'activities',      // id -> {id, garmin_id, strava_id, source, name, type, start, distance_m, ...}
  'laps',            // activity id -> {u, laps: [...]}
  'weather',         // activity id -> {temp_c, humidity, dew_point_c, wind_kph, conditions}
  'activityGear',    // activity id -> {u, uuids: [...]}
  'gear',            // uuid -> {uuid, name, brand, model, type, retired, limit_m}
  'daily',           // day -> the daily sweep (steps, stress, body battery, sleep stages...)
  'wellness',        // day -> {hrv_ms, rhr, sleep_hours, sleep_score}
  'metrics',         // day -> Garmin's own estimates (threshold, VO2max, race predictions)
  'personalRecords', // type id -> Garmin's record book
  'derived',         // activity id -> what the analysis read out of its stream (efforts, reps, stops, tiles)
  'races',           // id -> {id, name, date, distance_m, goal_s, actual_s, predicted_s, garmin_id, course}
  'routes',          // id -> {id, name, profile, rtype, pts}
  'trailAreas',      // id -> {id, name, bbox, loaded_at, seg_count, ways, cover, gains, matched_at}
  'reviews',         // id -> {id, created_at, markdown, source}
  'analysisRequests',// id -> {id, q, note, created, status, answer, answeredAt}
];
// Single records that sync on their own timestamp.
export const SYNCED_SINGLE = ['profile'];

export function emptyState() {
  const s = { schema: SCHEMA, tombs: {} };
  SYNCED.forEach(k => { s[k] = {}; });
  s.profile = { u: '' };
  return s;
}

// Fill in anything an older or partial state is missing, without touching what is there.
export function normalize(st) {
  const base = emptyState();
  const s = { ...base, ...(st || {}) };
  SYNCED.forEach(k => { if (!s[k] || typeof s[k] !== 'object' || Array.isArray(s[k])) s[k] = {}; });
  if (!s.tombs || typeof s.tombs !== 'object') s.tombs = {};
  if (!s.profile || typeof s.profile !== 'object') s.profile = { u: '' };
  return s;
}

const ts = r => (r && r.u) || '';

// Stamp a record as changed now (or at `at`). Returns the record.
export function touch(rec, at) { rec.u = at || new Date().toISOString(); return rec; }

// Put / delete through these so every write carries its timestamp.
export function put(st, coll, id, rec, at) { st[coll][id] = touch({ ...rec }, at); return st[coll][id]; }
export function remove(st, coll, id, at) {
  delete st[coll][id];
  (st.tombs[coll] || (st.tombs[coll] = {}))[id] = at || new Date().toISOString();
}

// What goes to the cloud: the synced keys only.
export function syncPayload(st) {
  const o = { schema: st.schema || SCHEMA, tombs: st.tombs || {} };
  SYNCED.forEach(k => { o[k] = st[k] || {}; });
  SYNCED_SINGLE.forEach(k => { o[k] = st[k] || { u: '' }; });
  return o;
}

// Merge `incoming` (another device's syncPayload) into `local`. Returns a new state;
// device-local keys of `local` are kept as they are.
export function merge(local, incoming) {
  const out = normalize(local);
  if (!incoming || typeof incoming !== 'object') return out;
  const tombs = {};
  for (const coll of new Set([...Object.keys(out.tombs), ...Object.keys(incoming.tombs || {})])) {
    tombs[coll] = { ...(out.tombs[coll] || {}) };
    for (const [id, at] of Object.entries((incoming.tombs || {})[coll] || {}))
      if (!tombs[coll][id] || at > tombs[coll][id]) tombs[coll][id] = at;
  }
  for (const coll of SYNCED) {
    const m = { ...out[coll] };
    for (const [id, rec] of Object.entries(incoming[coll] || {}))
      if (!m[id] || ts(rec) > ts(m[id])) m[id] = rec;
    for (const [id, at] of Object.entries(tombs[coll] || {}))
      if (m[id] && at >= ts(m[id])) delete m[id];
    out[coll] = m;
  }
  for (const k of SYNCED_SINGLE)
    if (incoming[k] && ts(incoming[k]) > ts(out[k])) out[k] = incoming[k];
  out.tombs = tombs;
  return out;
}
