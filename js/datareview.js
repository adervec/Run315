// Data quality: what looks wrong in the imported data, what the two services disagree on,
// where the gaps are, and Strava segments. GymTracker's log review, for cardio.
//
// CONTRACT (cowork.js depends on these two):
//   reviewContext(st) -> plain object written as datareview/context.json's payload ({findings: [...]})
//   importReview(st, payload) -> {handled: true, note} after storing proposals in state.dataReview
// and the activity page hook: segmentsButton(id) / mountSegmentsButton(el, id).
//
// The app DETECTS; the agent may explain or propose; the athlete decides. Nothing is ever
// changed automatically, and an approved fix changes Run315's copy only -- nothing goes back
// to Garmin or Strava. A finding is {id, kind, activity_id, detail, evidence: {numbers}}, its
// id stable across rescans (kind + activity) so a decision sticks to it.
//
// Two kinds of detector:
//   summary detectors  read only the activity record, so they run anywhere (the phone too)
//   stream detectors   need the per-second stream, which lives only on the device that
//                      imported it. They run there and their findings are kept, compact, on
//                      state.dataReview['scan:<activity id>'] -- synced, so the phone sees
//                      them. The scan record also lists which channels the stream carries,
//                      which is what the sources page's coverage map reads.
import { put } from './merge.js';
import { dedupe, samplesFromChannels, MATCH_WINDOW_MIN } from './ingest.js';
import { RUN_TYPES, implausible, PLAUSIBLE_SPEED, PLAUSIBLE_DEFAULT } from './lib/fitness.js';
import { dayKey, addDayKey, fromDay } from './lib/dt.js';
import { state, save } from './store.js';
import { html } from './ui.js';

export const SCAN_V = 1;
export const CONTEXT_CAP = 40;
const RIDES = /cycl|biking|ride/;
const WALKS = new Set(['walking', 'hiking']);
// Indoors there is no hill: a barometer drifting with the room's air pressure is the only climb.
const INDOOR = new Set(['treadmill_running', 'indoor_running', 'indoor_cycling', 'indoor_rowing', 'elliptical', 'track_running']);
const isRide = t => RIDES.test(String(t || ''));
const onFoot = t => RUN_TYPES.has(t) || WALKS.has(t);
const r1 = v => Math.round(v * 10) / 10;

export const KINDS = {
  'gps-jump': { label: 'GPS jumps', about: 'The track teleports: consecutive points far further apart than the activity ever moved. It inflates distance and can fake a best effort.' },
  'hr-dropout': { label: 'Heart-rate dropouts', about: 'Long stretches mid-activity with no heart rate. Averages, zones and drift are computed around the hole.' },
  'cadence-lock': { label: 'Cadence lock', about: 'An optical sensor that read your footstrike instead of your pulse: HR sitting on your cadence (or half of it) for minutes. A steady run at a heart rate that happens to equal your cadence looks the same, so this is a question, not a verdict.' },
  'type-mismatch': { label: 'Activity type', about: 'The recorded sport does not fit the speed: a "run" at cycling speed, a ride at walking pace. A ride filed as a run pollutes best efforts and the race model.' },
  'elevation-spike': { label: 'Elevation', about: 'Climb that the distance cannot hold, climb on an indoor activity, or the altitude jumping by tens of metres between two samples.' },
  implausible: { label: 'Implausible summary', about: 'Faster on average than the sport goes at all.' },
  'near-miss': { label: 'Garmin / Strava near-misses', about: 'A Strava-only activity and a Garmin activity close in time and length, but outside the automatic match (10 min, 15%). Possibly one session recorded twice.' },
};

// ---------- small numerics ----------
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const R_EARTH = 6371008.8, rad = Math.PI / 180;
export function haversine(la1, lo1, la2, lo2) {
  const dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------- stream detectors (samples: [t, d, hr, lat, lon, ele, cad, ...]) ----------
// GPS steps between consecutive fixes: [i, metres, seconds, m/s].
function gpsSteps(samples) {
  const out = [];
  let prev = null;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (s[3] == null || s[4] == null) continue;
    if (prev) {
      const dt = s[0] - prev[0];
      if (dt > 0) { const m = haversine(prev[3], prev[4], s[3], s[4]); out.push([i, m, dt, m / dt]); }
    }
    prev = s;
  }
  return out;
}
// A jump: implied speed over 3x the activity's own 95th percentile AND over a floor the sport
// cannot reach in a second (12 m/s on foot, 35 on a bike) -- the percentile adapts to the
// sport, the floor stops a slow walk's jitter counting. And it must cover 20 m: 1 Hz GPS
// wobbles by a few metres, which is noise, not a jump.
const JUMP_MIN_M = 20;
function jumpsOf(steps, type) {
  if (steps.length < 10) return { jumps: [], p95: null };
  const p95 = quantile(steps.map(s => s[3]).sort((a, b) => a - b), 0.95);
  const floor = isRide(type) ? 35 : 12;
  const lim = Math.max(3 * p95, floor);
  return { jumps: steps.filter(s => s[3] > lim && s[1] >= JUMP_MIN_M), p95 };
}

export function streamFindings(a, samples) {
  const out = [], id = a.id, n = samples.length;
  if (n < 10) return out;
  const t0 = samples[0][0];
  const rel = t => Math.round(t - t0);

  // GPS jumps
  const steps = gpsSteps(samples), { jumps, p95 } = jumpsOf(steps, a.type);
  if (jumps.length) {
    const worst = Math.max(...jumps.map(j => j[3])), jumpM = jumps.reduce((s, j) => s + j[1], 0);
    const gpsM = steps.reduce((s, j) => s + j[1], 0);
    out.push({ id: 'gps-jump:' + id, kind: 'gps-jump', activity_id: id,
      detail: `${jumps.length} GPS jump${jumps.length > 1 ? 's' : ''}; the worst implies ${r1(worst)} m/s (${Math.round(worst * 3.6)} km/h). Together ${Math.round(jumpM)} m of the track.`,
      evidence: { jumps: jumps.length, worst_m_s: r1(worst), p95_m_s: r1(p95), jump_m: Math.round(jumpM), gps_track_m: Math.round(gpsM),
        recorded_m: a.distance_m != null ? Math.round(a.distance_m) : null, first_at_s: rel(samples[jumps[0][0]][0]) } });
  }

  // Heart-rate dropouts: only where the activity HAS heart rate (no strap at all is not a
  // dropout), and only between the first and last reading (a late start is not one either).
  const hrIdx = []; for (let i = 0; i < n; i++) if (samples[i][2] > 0) hrIdx.push(i);
  if (hrIdx.length >= n * 0.3) {
    const gaps = [];
    for (let k = 1; k < hrIdx.length; k++) {
      const a0 = hrIdx[k - 1], b0 = hrIdx[k];
      if (b0 - a0 > 1) { const secs = samples[b0][0] - samples[a0][0]; if (secs >= 60) gaps.push([a0, secs]); }
    }
    if (gaps.length) {
      const total = gaps.reduce((s, g) => s + g[1], 0), dur = samples[n - 1][0] - t0;
      out.push({ id: 'hr-dropout:' + id, kind: 'hr-dropout', activity_id: id,
        detail: `${gaps.length} heart-rate gap${gaps.length > 1 ? 's' : ''} of a minute or more, ${Math.round(total / 60)} min in all (${Math.round(100 * total / Math.max(dur, 1))}% of the activity).`,
        evidence: { gaps: gaps.length, longest_s: Math.round(Math.max(...gaps.map(g => g[1]))), total_s: Math.round(total),
          share_pct: Math.round(100 * total / Math.max(dur, 1)), first_at_s: rel(samples[gaps[0][0]][0]) } });
    }
  }

  // Cadence lock: HR within 3 bpm of cadence or half-cadence. A stretch survives a 5 s break
  // in the match (one noisy sample is not the sensor letting go); flagged past 3 minutes.
  const LOCK_BPM = 3, LOCK_GAP_S = 5, LOCK_MIN_S = 180;
  const stretches = [];
  let cur = null;
  for (const s of samples) {
    const hr = s[2], cad = s[6];
    if (!(hr > 0) || !(cad > 0)) continue;
    if (Math.abs(hr - cad) > LOCK_BPM && Math.abs(hr - cad / 2) > LOCK_BPM) continue;
    if (cur && s[0] - cur.last <= LOCK_GAP_S) { cur.last = s[0]; cur.hr.push(hr); cur.cad.push(cad); }
    else { if (cur) stretches.push(cur); cur = { start: s[0], last: s[0], hr: [hr], cad: [cad] }; }
  }
  if (cur) stretches.push(cur);
  const locks = stretches.filter(x => x.last - x.start > LOCK_MIN_S);
  if (locks.length) {
    const longest = locks.reduce((b, x) => (x.last - x.start > b.last - b.start ? x : b));
    const mean = v => v.reduce((s, x) => s + x, 0) / v.length;
    const total = locks.reduce((s, x) => s + x.last - x.start, 0);
    out.push({ id: 'cadence-lock:' + id, kind: 'cadence-lock', activity_id: id,
      detail: `Heart rate sat on the cadence for ${Math.round(total / 60)} min (${locks.length} stretch${locks.length > 1 ? 'es' : ''}, longest ${Math.round((longest.last - longest.start) / 60)} min).`,
      // The ranges are the tell: HR that follows a cadence that varies is a lock; both flat is ambiguous.
      evidence: { stretches: locks.length, total_s: Math.round(total), longest_s: Math.round(longest.last - longest.start),
        avg_hr: Math.round(mean(longest.hr)), avg_cadence: Math.round(mean(longest.cad)),
        hr_range: Math.round(Math.max(...longest.hr) - Math.min(...longest.hr)),
        cadence_range: Math.round(Math.max(...longest.cad) - Math.min(...longest.cad)), first_at_s: rel(locks[0].start) } });
  }

  // Altitude jumping more than 30 m between two consecutive samples.
  const ej = [];
  let pe = null;
  for (const s of samples) {
    if (s[5] == null) continue;
    if (pe && Math.abs(s[5] - pe[5]) > 30) ej.push([s[0], s[5] - pe[5]]);
    pe = s;
  }
  if (ej.length) {
    const worst = ej.reduce((b, x) => (Math.abs(x[1]) > Math.abs(b[1]) ? x : b));
    out.push({ id: 'elev-jump:' + id, kind: 'elevation-spike', activity_id: id,
      detail: `Altitude jumps by more than 30 m between two samples ${ej.length} time${ej.length > 1 ? 's' : ''} (worst ${Math.round(worst[1])} m).`,
      evidence: { jumps: ej.length, worst_m: Math.round(worst[1]), first_at_s: rel(ej[0][0]),
        elev_gain_m: a.elev_gain_m != null ? Math.round(a.elev_gain_m) : null } });
  }
  return out;
}

// Channels a stream actually carries (named, with at least one value).
export function channelsOf(ch) {
  return Object.keys(ch || {}).filter(k => k !== 'seconds' && k !== 'metres' && Array.isArray(ch[k]) && ch[k].some(v => v != null)).sort();
}
// Scan one stream record into state.dataReview['scan:<id>']. Returns the scan record.
export function scanRecord(st, id, rec) {
  const a = st.activities[id];
  if (!a || !rec || !rec.channels) return null;
  const findings = streamFindings(a, samplesFromChannels(rec.channels));
  return put(st, 'dataReview', 'scan:' + id, { id: 'scan:' + id, scan: true, v: SCAN_V, src: rec.src || null,
    channels: channelsOf(rec.channels), findings, scannedAt: new Date().toISOString() });
}
export const scanOf = (st, id) => st.dataReview['scan:' + id] || null;
// Scan every stream on this device that has not been scanned at this version (all of them
// with opts.all). Async because streams live in IndexedDB; yields so the page stays live.
export async function scanStreams(st, { ids, getStream, all = false, onProgress } = {}) {
  const todo = ids.filter(id => st.activities[id] && (all || (scanOf(st, id)?.v !== SCAN_V)));
  let n = 0, found = 0;
  for (const id of todo) {
    const r = scanRecord(st, id, await getStream(id));
    if (r) found += r.findings.length;
    n++;
    if (onProgress) onProgress(n, todo.length);
  }
  return { scanned: n, findings: found };
}

// ---------- summary detectors ----------
export function summaryFindings(st) {
  const out = [];
  const acts = Object.values(st.activities);
  for (const a of acts) {
    const id = a.id, secs = a.moving_s || a.elapsed_s, dist = a.distance_m;
    const speed = dist && secs > 0 ? dist / secs : null;
    const imp = implausible(a);
    if (imp) {
      const limit = Object.hasOwn(PLAUSIBLE_SPEED, a.type) ? PLAUSIBLE_SPEED[a.type] : PLAUSIBLE_DEFAULT;
      out.push({ id: 'implausible:' + id, kind: 'implausible', activity_id: id, detail: 'Recorded as ' + imp.replace(/^recorded as /, ''),
        evidence: { speed_m_s: r1(speed), km_h: r1(speed * 3.6), limit_m_s: limit, distance_m: Math.round(dist), moving_s: Math.round(secs) } });
    } else if (speed) {
      // Below the implausible line but outside the sport: a "run" at 5.6 m/s (2:58/km) for 3 km
      // or more is world-class or a bike; a ride under 6.5 km/h is a walk; a walk at 9 km/h, a run.
      let likely = null;
      if (RUN_TYPES.has(a.type) && speed > 5.6 && dist >= 3000) likely = 'cycling';
      else if (isRide(a.type) && speed < 1.8 && dist >= 1000 && secs >= 600) likely = 'walking';
      else if (WALKS.has(a.type) && speed > 2.5 && dist >= 1000) likely = 'running';
      if (likely) out.push({ id: 'type-mismatch:' + id, kind: 'type-mismatch', activity_id: id,
        detail: `Recorded as ${String(a.type).replace(/_/g, ' ')} at ${r1(speed * 3.6)} km/h, which is ${likely} speed.`,
        evidence: { speed_m_s: r1(speed), km_h: r1(speed * 3.6), distance_m: Math.round(dist), moving_s: Math.round(secs), likely } });
    }
    // Climb the distance cannot hold: 250 m/km on foot is a vertical-kilometre race all the way;
    // 150 m/km on a bike is a 15% wall for the whole ride.
    const gain = a.elev_gain_m;
    if (gain > 30 && INDOOR.has(a.type)) {
      out.push({ id: 'elev-gain:' + id, kind: 'elevation-spike', activity_id: id,
        detail: `${Math.round(gain)} m of climb on an indoor ${String(a.type).replace(/_/g, ' ')}: barometer drift, most likely.`,
        evidence: { elev_gain_m: Math.round(gain), distance_m: dist != null ? Math.round(dist) : null, indoor: 1 } });
    } else if (gain > 0 && dist >= 1000) {
      const perKm = gain / (dist / 1000), limit = onFoot(a.type) ? 250 : isRide(a.type) ? 150 : null;
      if (limit && perKm > limit) out.push({ id: 'elev-gain:' + id, kind: 'elevation-spike', activity_id: id,
        detail: `${Math.round(gain)} m of climb in ${r1(dist / 1000)} km: ${Math.round(perKm)} m per km, more than the ground can hold.`,
        evidence: { elev_gain_m: Math.round(gain), distance_m: Math.round(dist), m_per_km: Math.round(perKm), limit_m_per_km: limit } });
    }
  }
  // Near-misses: a Strava-only activity and an unlinked Garmin one within 30 min and 25% of
  // length -- beyond what dedupe merges by itself (10 min, 15%), so a human decides.
  const garmin = acts.filter(a => a.source === 'garmin' && !a.strava_id);
  for (const s of acts) {
    if (s.source !== 'strava') continue;
    for (const g of garmin) {
      const mins = Math.abs(new Date(g.start) - new Date(s.start)) / 60000;
      if (!(mins <= 30)) continue;
      const ratio = g.distance_m && s.distance_m ? s.distance_m / g.distance_m : null;
      if (ratio != null && Math.abs(ratio - 1) > 0.25) continue;
      if (mins <= MATCH_WINDOW_MIN && (ratio == null || Math.abs(ratio - 1) <= 0.15)) continue;   // dedupe's own (it will have merged)
      out.push({ id: `near-miss:${s.id}:${g.id}`, kind: 'near-miss', activity_id: s.id, other_id: g.id,
        detail: `Strava's "${s.name || s.id}" and Garmin's "${g.name || g.id}" started ${Math.round(mins)} min apart` +
          (ratio != null ? ` with distances ${Math.round(Math.abs(ratio - 1) * 100)}% apart.` : ' (one has no distance).'),
        evidence: { minutes_apart: Math.round(mins), distance_ratio: ratio != null ? Math.round(ratio * 1000) / 1000 : null,
          strava_m: s.distance_m != null ? Math.round(s.distance_m) : null, garmin_m: g.distance_m != null ? Math.round(g.distance_m) : null,
          strava_s: s.moving_s ?? null, garmin_s: g.moving_s ?? null } });
    }
  }
  return out;
}

// Every live finding: the summary ones plus every kept stream scan, newest activity first.
export function findings(st) {
  const out = summaryFindings(st);
  for (const [k, r] of Object.entries(st.dataReview)) {
    if (!k.startsWith('scan:') || !st.activities[k.slice(5)]) continue;
    for (const f of r.findings || []) out.push(f);
  }
  const start = f => String(st.activities[f.activity_id]?.start || '');
  return out.sort((a, b) => start(b).localeCompare(start(a)) || a.id.localeCompare(b.id));
}
export const decisionOf = (st, id) => (st.dataReview[id] && st.dataReview[id].decision) || null;
export const openFindings = st => findings(st).filter(f => !decisionOf(st, f.id));

// ---------- the cowork channel ----------
const FIX_NUM = { distance_m: [0, 1e6], moving_s: [0, 7 * 86400], elapsed_s: [0, 7 * 86400], elev_gain_m: [0, 20000], avg_hr: [25, 250], max_hr: [25, 250] };
export const FIX_FIELDS = ['type', 'name', ...Object.keys(FIX_NUM)];
// The agent's fix, cleaned -- or null. One bad field drops the whole fix: never half-applied.
export function sanitizeFix(f, fix) {
  if (!f || !fix || typeof fix !== 'object') return null;
  if (f.kind === 'near-miss') return fix.merge === false ? null : { merge: true };
  const out = {};
  for (const [k, v] of Object.entries(fix)) {
    if (k === 'type') { if (typeof v !== 'string' || !/^[a-z_]{2,40}$/.test(v)) return null; out.type = v; }
    else if (k === 'name') { if (typeof v !== 'string' || !v.trim()) return null; out.name = v.trim().slice(0, 120); }
    else if (FIX_NUM[k]) { const n = +v; if (v === null || v === '' || !isFinite(n) || n < FIX_NUM[k][0] || n > FIX_NUM[k][1]) return null; out[k] = n; }
    else return null;
  }
  return Object.keys(out).length ? out : null;
}

const brief = a => a && { id: a.id, name: a.name, type: a.type, start: a.start, source: a.source, distance_m: a.distance_m ?? null,
  moving_s: a.moving_s ?? null, elev_gain_m: a.elev_gain_m ?? null, avg_hr: a.avg_hr ?? null, max_hr: a.max_hr ?? null,
  strava_id: a.strava_id || null, strava: a.strava || null };

export function reviewContext(st) {
  const open = openFindings(st), prop = f => (st.dataReview[f.id] && st.dataReview[f.id].proposal) || null;
  // The ones the agent has not seen yet go first; the cap keeps the request readable.
  const ordered = [...open.filter(f => !prop(f)), ...open.filter(f => prop(f))];
  const byKind = {};
  for (const f of open) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  const scans = Object.keys(st.dataReview).filter(k => k.startsWith('scan:')).length;
  return {
    open: open.length, byKind, more: Math.max(0, open.length - CONTEXT_CAP),
    streamsScanned: scans,
    fixable: { fields: FIX_FIELDS, nearMiss: { merge: true },
      note: 'A fix sets fields on Run315\'s copy of the activity only. For a near-miss, {"merge": true} folds the Strava-only record into the Garmin one.' },
    findings: ordered.slice(0, CONTEXT_CAP).map(f => ({ ...f, activity: brief(st.activities[f.activity_id]),
      ...(f.other_id ? { other: brief(st.activities[f.other_id]) } : {}), proposal: prop(f) })),
  };
}

export function importReview(st, p) {
  const props = (p && Array.isArray(p.proposals)) ? p.proposals : null;
  if (!props) return { handled: false, note: 'no proposals array' };
  const live = new Map(findings(st).map(f => [f.id, f]));
  let n = 0, skipped = 0;
  for (const x of props) {
    const f = x && live.get(String(x.id));
    const action = x && ['fix', 'keep', 'ignore'].includes(x.action) ? x.action : null;
    const fix = action === 'fix' ? sanitizeFix(f, x.fix) : null;
    if (!f || !action || (action === 'fix' && !fix)) { skipped++; continue; }
    const cur = st.dataReview[f.id] || {};
    put(st, 'dataReview', f.id, { ...cur, id: f.id, proposal: { action, fix, reason: String(x.reason || '').slice(0, 600), at: new Date().toISOString() } });
    n++;
  }
  return { handled: true, note: n + ' proposals' + (skipped ? `, ${skipped} skipped (unknown finding or unusable fix)` : '') };
}

// ---------- decisions ----------
// decision: 'fix' | 'keep' | 'ignore'. A fix applies the agent's proposal (or, for a
// near-miss, the merge itself) to Run315's copy. -> {ok, note, changed: activity id | null}.
export function applyDecision(st, id, decision, f = findings(st).find(x => x.id === id)) {
  const cur = st.dataReview[id] || {}, at = new Date().toISOString();
  if (decision === 'keep' || decision === 'ignore') {
    put(st, 'dataReview', id, { ...cur, id, decision, decidedAt: at });
    return { ok: true, note: decision === 'keep' ? 'Kept as it is' : 'Ignored', changed: null };
  }
  if (decision !== 'fix' || !f) return { ok: false, note: 'That finding is gone', changed: null };
  const fix = cur.proposal && cur.proposal.action === 'fix' ? sanitizeFix(f, cur.proposal.fix) : f.kind === 'near-miss' ? { merge: true } : null;
  if (!fix) return { ok: false, note: 'No fix to apply', changed: null };
  if (fix.merge) {
    const s = st.activities[f.activity_id], g = st.activities[f.other_id];
    if (!s || s.source !== 'strava' || !g || g.source !== 'garmin' || g.strava_id) return { ok: false, note: 'Those two have changed since', changed: null };
    // dedupe() honours garmin_hint before any time window: the same path a Strava upload that
    // kept its Garmin id takes, so the merge is the ordinary one.
    put(st, 'activities', s.id, { ...s, garmin_hint: g.garmin_id });
    dedupe(st);
    if (st.activities[s.id]) return { ok: false, note: 'The merge did not take', changed: null };
    put(st, 'dataReview', id, { ...cur, id, decision: 'fix', decidedAt: at, merged: g.id });
    return { ok: true, note: 'Merged into the Garmin activity', changed: g.id };
  }
  const a = st.activities[f.activity_id];
  if (!a) return { ok: false, note: 'That activity is gone', changed: null };
  const before = {};
  for (const k of Object.keys(fix)) before[k] = a[k] ?? null;
  // `fixed` remembers the hand corrections, so an importer can keep them over a re-import.
  put(st, 'activities', a.id, { ...a, ...fix, fixed: { ...(a.fixed || {}), ...fix } });
  // A run refiled as something else must stop feeding best efforts and the race model; the
  // per-second results are re-derived where the stream is (the page does that).
  if (fix.type && RUN_TYPES.has(a.type) && !RUN_TYPES.has(fix.type) && st.derived[a.id])
    put(st, 'derived', a.id, { ...st.derived[a.id], efforts: {}, splits: [], session: null, durability: null, sig: null, stops: null, climb: null });
  put(st, 'dataReview', id, { ...cur, id, decision: 'fix', decidedAt: at, before });
  return { ok: true, note: 'Fixed in Run315 (not on Garmin or Strava)', changed: a.id };
}
// Undo a decision. A field fix puts the old values back; a merge cannot be unpicked.
export function reopen(st, id) {
  const cur = st.dataReview[id];
  if (!cur || !cur.decision) return { ok: false, changed: null };
  if (cur.merged) return { ok: false, changed: null };
  let changed = null;
  const aid = cur.decision === 'fix' && cur.before ? findingActivity(id) : null;
  const a = aid && st.activities[aid];
  if (a) {
    const fixed = { ...(a.fixed || {}) };
    for (const k of Object.keys(cur.before)) delete fixed[k];
    put(st, 'activities', a.id, { ...a, ...cur.before, fixed });
    changed = a.id;
  }
  put(st, 'dataReview', id, { ...cur, decision: null, decidedAt: null, before: null });
  return { ok: true, changed };
}
// 'kind:<activity id>' (near-miss: 'near-miss:<strava id>:<garmin id>') -> the activity id.
export const findingActivity = id => String(id).split(':')[1] || null;

// ---------- Garmin vs Strava ----------
const METRICS = [['distance_m', 'Distance', 'm'], ['moving_s', 'Moving time', 's'], ['elev_gain_m', 'Elevation gain', 'm'], ['avg_hr', 'Average HR', 'bpm']];
export const SOURCE_METRICS = METRICS;
// Linked activities (Garmin records that carry Strava's own numbers): Strava minus Garmin.
export function linkedPairs(st) {
  const out = [];
  for (const a of Object.values(st.activities)) {
    if (a.source !== 'garmin' || !a.strava) continue;
    const d = {};
    for (const [k] of METRICS) d[k] = a[k] != null && a.strava[k] != null ? a.strava[k] - a[k] : null;
    d.distance_pct = d.distance_m != null && a.distance_m ? 100 * d.distance_m / a.distance_m : null;
    out.push({ id: a.id, name: a.name, start: a.start, type: a.type, d,
      g: Object.fromEntries(METRICS.map(([k]) => [k, a[k] ?? null])), s: Object.fromEntries(METRICS.map(([k]) => [k, a.strava[k] ?? null])) });
  }
  return out.sort((x, y) => String(y.start).localeCompare(String(x.start)));
}
// Median and interquartile range of each delta: the typical disagreement and how much it varies.
export function deltaStats(pairs) {
  const out = {};
  for (const k of [...METRICS.map(m => m[0]), 'distance_pct']) {
    const v = pairs.map(p => p.d[k]).filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
    out[k] = v.length ? { n: v.length, median: quantile(v, 0.5), p25: quantile(v, 0.25), p75: quantile(v, 0.75), min: v[0], max: v[v.length - 1] } : { n: 0 };
  }
  return out;
}
// The stream's own reading of the session, as a referee: the GPS track's length (jumps left
// out), the climb (3 m hysteresis, so sensor noise does not add up), moving time (moving at
// 0.5 m/s or more, no gaps over 10 s) and the mean of the HR samples.
export function streamReferee(samples, type) {
  if (!samples || samples.length < 10) return null;
  const steps = gpsSteps(samples), { jumps } = jumpsOf(steps, type), bad = new Set(jumps.map(j => j[0]));
  const gps = steps.length ? steps.filter(s => !bad.has(s[0])).reduce((s, x) => s + x[1], 0) : null;
  let gain = 0, ref = null, moving = 0;
  for (let i = 0; i < samples.length; i++) {
    const e = samples[i][5];
    if (e != null) { if (ref == null) ref = e; else if (e - ref >= 3) { gain += e - ref; ref = e; } else if (e < ref) ref = e; }
    if (i) {
      const dt = samples[i][0] - samples[i - 1][0], dd = samples[i][1] - samples[i - 1][1];
      if (dt > 0 && dt <= 10 && dd / dt >= 0.5) moving += dt;
    }
  }
  const hr = samples.map(s => s[2]).filter(h => h > 0);
  return { gps_m: gps != null && gps > 0 ? gps : null, elev_gain_m: ref != null ? gain : null, moving_s: moving || null,
    avg_hr: hr.length ? hr.reduce((s, h) => s + h, 0) / hr.length : null };
}
// Which service the stream sides with for one metric: 'garmin' | 'strava' | 'tie' | null.
// A tie is when the two are within 1% of each other's distance from the referee.
export function sideWith(g, s, ref) {
  if (g == null || s == null || ref == null) return null;
  const dg = Math.abs(g - ref), ds = Math.abs(s - ref);
  if (Math.abs(dg - ds) <= 0.01 * Math.max(Math.abs(ref), 1)) return 'tie';
  return dg < ds ? 'garmin' : 'strava';
}

// ---------- coverage ----------
// Per data channel, for each day of the last `weeks` weeks (Monday-aligned, like the training
// calendar): 'have' | 'miss' | 'unk' (needs a stream scan to know) | 'none' (no activity that
// day, for activity channels) | 'future'; the activities channel says 'garmin' | 'strava' | 'both'.
export const COVERAGE_CHANNELS = [
  ['activities', 'Activities', 'act'], ['stream', 'Per-second stream', 'act'], ['hr', 'Heart rate', 'act'],
  ['gps', 'GPS', 'act'], ['dynamics', 'Running dynamics', 'run'], ['power', 'Power', 'act'],
  ['weather', 'Weather', 'act'], ['daily', 'Daily sweep', 'day'], ['hrv', 'Overnight HRV', 'day'],
  ['sleep', 'Sleep stages', 'day'],
];
const DYN = ['stride_m', 'gct_ms', 'vertical_oscillation_cm', 'vertical_ratio', 'ground_contact_balance'];
export function coverage(st, today = new Date(), weeks = 26) {
  const t = dayKey(today), monday = addDayKey(t, -((fromDay(t).getDay() + 6) % 7));
  const grid = [];
  for (let w = weeks - 1; w >= 0; w--) { const s = addDayKey(monday, -7 * w); grid.push(Array.from({ length: 7 }, (_, i) => addDayKey(s, i))); }
  const first = grid[0][0], byDay = {};
  for (const a of Object.values(st.activities)) {
    const d = String(a.start || '').slice(0, 10);
    if (d >= first && d <= t) (byDay[d] || (byDay[d] = [])).push(a);
  }
  // One activity's answer for a channel: true / false / null (unknown).
  const chans = id => { const s = scanOf(st, id); return s ? s.channels || [] : null; };
  const has = {
    stream: a => !!st.derived[a.id],
    // Both services report an average HR whenever the session had one, so its absence is an answer.
    hr: a => a.avg_hr > 0 || !!(st.derived[a.id] && (st.derived[a.id].zones || st.derived[a.id].drift)) || !!chans(a.id)?.includes('hr'),
    gps: a => { const d = st.derived[a.id], c = chans(a.id); if ((d && (d.points?.length || d.tiles?.length)) || (c && c.includes('lat'))) return true; return d || c ? false : null; },
    dynamics: a => { const c = chans(a.id); return c ? DYN.some(k => c.includes(k)) : null; },
    power: a => { const c = chans(a.id); return c ? c.includes('power_w') : (a.strava?.avg_watts ? true : null); },
    weather: a => !!st.weather[a.id],
  };
  const out = [];
  for (const [key, label, scope] of COVERAGE_CHANNELS) {
    const cells = {}, n = { have: 0, miss: 0, unk: 0, of: 0 };
    for (const d of grid.flat()) {
      if (d > t) { cells[d] = 'future'; continue; }
      let v;
      if (scope === 'day') {
        const row = key === 'daily' ? st.daily[d] : key === 'hrv' ? st.wellness[d] : st.daily[d];
        v = key === 'daily' ? (row ? 'have' : 'miss') : key === 'hrv' ? (row && row.hrv_ms != null ? 'have' : 'miss')
          : (row && (row.deep_s || row.rem_s || row.light_s) ? 'have' : 'miss');
      } else {
        const acts = (byDay[d] || []).filter(a => scope !== 'run' || RUN_TYPES.has(a.type));
        if (!acts.length) v = 'none';
        else if (key === 'activities') {
          const both = acts.some(a => a.source === 'garmin' && a.strava_id) || (acts.some(a => a.source === 'garmin') && acts.some(a => a.source === 'strava'));
          v = both ? 'both' : acts.some(a => a.source === 'strava') ? 'strava' : 'garmin';
        } else {
          const r = acts.map(has[key]);
          v = r.some(x => x === true) ? 'have' : r.some(x => x === null) ? 'unk' : 'miss';
        }
      }
      cells[d] = v;
      if (v === 'none') continue;
      n.of++;
      if (v === 'miss') n.miss++; else if (v === 'unk') n.unk++; else n.have++;
    }
    out.push({ key, label, scope, cells, ...n });
  }
  return { grid, today: t, channels: out };
}

// ---------- Strava segments ----------
export const wantedSegments = st => ((st.profile && st.profile.segmentsWanted) || []).map(String);
export const effortsFor = (st, id) => {
  const a = st.activities[id];
  return Object.values(st.segmentEfforts).filter(e => e.activity_id === id || (a && a.strava_id && e.strava_id === String(a.strava_id)));
};
// Add (on) or drop (off) Strava ids from the athlete's segment wish list. Mutates st.profile
// the synced way (a new record, a new `u`). -> how many it changed.
export function setSegmentsWanted(st, sids, on = true) {
  const cur = wantedSegments(st), set = new Set(cur), before = set.size;
  for (const s of sids.map(String)) on ? set.add(s) : set.delete(s);
  const changed = Math.abs(set.size - before);
  if (changed) st.profile = { ...st.profile, segmentsWanted: [...set], u: new Date().toISOString() };
  return changed;
}
// Least-squares slope of seconds against days, with its standard error: how fast the times
// move, and how sure that is. Under 3 attempts there is no slope worth quoting.
export function trend(points) {
  const n = points.length;
  if (n < 3) return null;
  const mx = points.reduce((s, p) => s + p[0], 0) / n, my = points.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, sxy = 0;
  for (const [x, y] of points) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
  if (!(sxx > 0)) return null;
  const b = sxy / sxx, a = my - b * mx;
  const rss = points.reduce((s, [x, y]) => s + (y - a - b * x) ** 2, 0);
  const se = n > 2 ? Math.sqrt(rss / (n - 2) / sxx) : null;
  return { slope: b, se, n };
}
export function segmentSummary(st) {
  const by = {};
  for (const e of Object.values(st.segmentEfforts)) {
    if (!e || e.segment_id == null || !(e.elapsed_time > 0)) continue;
    (by[e.segment_id] || (by[e.segment_id] = [])).push(e);
  }
  return Object.entries(by).map(([sid, es]) => {
    es.sort((a, b) => String(a.start_date_local).localeCompare(String(b.start_date_local)));
    const best = es.reduce((b, e) => (e.elapsed_time < b.elapsed_time ? e : b));
    const t0 = Date.parse(es[0].start_date_local);
    const tr = trend(es.filter(e => e.start_date_local).map(e => [(Date.parse(e.start_date_local) - t0) / 864e5, e.elapsed_time]));
    const last = es[es.length - 1];
    return { segment_id: sid, name: last.segment_name || 'Segment ' + sid, distance: last.distance ?? null, grade: last.grade ?? null,
      city: last.city || null, attempts: es.length, best, latest: last, efforts: es,
      trend: tr && { per30: tr.slope * 30, se30: tr.se != null ? tr.se * 30 : null, n: tr.n } };
  }).sort((a, b) => b.attempts - a.attempts || String(b.latest.start_date_local).localeCompare(String(a.latest.start_date_local)));
}

// ---------- activity page hook ----------
export function segmentsButton(id) {
  const a = state.activities[id];
  if (!a || !a.strava_id) return '';
  const n = effortsFor(state, id).length;
  if (n) return html`<span class="seg-toggle" data-seg-for="${id}"><a class="quiet-link" href="#/segments">${n} Strava segment${n > 1 ? 's' : ''}</a></span>`;
  if (wantedSegments(state).includes(String(a.strava_id)))
    return html`<span class="seg-toggle" data-seg-for="${id}"><span class="dim">Strava segments queued for the next Strava pull</span>
      <button type="button" class="btn-quiet" data-seg-toggle>cancel</button></span>`;
  return html`<span class="seg-toggle" data-seg-for="${id}"><button type="button" class="btn btn-ghost" data-seg-toggle>Fetch Strava segments for this run</button></span>`;
}
export function mountSegmentsButton(el, id) {
  const host = [...(el ? el.querySelectorAll('[data-seg-for]') : [])].find(h => h.dataset.segFor === String(id));
  const btn = host && host.querySelector('[data-seg-toggle]');
  if (!btn) return;
  btn.onclick = () => {
    const a = state.activities[id];
    if (!a || !a.strava_id) return;
    setSegmentsWanted(state, [a.strava_id], !wantedSegments(state).includes(String(a.strava_id)));
    save('edit');
    const tmp = document.createElement('div');
    tmp.innerHTML = String(segmentsButton(id));
    if (tmp.firstElementChild) host.replaceWith(tmp.firstElementChild);
    mountSegmentsButton(el, id);
  };
}
