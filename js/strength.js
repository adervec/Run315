// GymTracker's strength sessions, read (never written) from the shared Drive appDataFolder,
// so leg day counts in fatigue, form and readiness.
// CONTRACT:
//   strengthActivities()  -> pseudo-activities merged into derive.activities() when enabled:
//                            {id: 'gt…', source: 'gymtracker', type: 'strength_training', start: ISO, moving_s, avg_hr, load, ...}
//   strengthPanel()       -> html for Today;  strengthDetail(id) -> html for the activity page (ids 'gt…')
//   refreshStrength({force}) -> fetch + parse gymtracker-state.json (at most every 15 min unless forced)
//   strengthStatus()      -> {enabled, drive, fetchedAt, sessions, counted, lastError, busy}
//
// Where the data comes from: GymTracker pushes its whole user-data state (sessions,
// deletedSessions tombstones, unit, customVariations, bodyComp, ...) to gymtracker-state.json in
// the same appDataFolder Run315 syncs through (same OAuth client). Run315 only calls
// readAppFile() on it. A session there holds variation uuids, not names or muscles; those live in
// GymTracker's catalogue, of which js/gtcatalog.js is a generated slice (tools/gtcatalog.mjs).
//
// The parsed sessions are kept in memory (strengthActivities is synchronous: derive.js calls it
// inside its memo) and in IndexedDB `cache`/'gymtracker-sessions', so a reload, or a phone with no
// signal, still has them. Catalogue lookups happen once, at parse time; the cache holds resolved
// names and group splits, so the 38 KB catalogue is only loaded when a refresh actually runs.
//
// The switch is SYNCED (`state.profile.gymtracker.enabled`): counting gym sessions in load is a
// decision about the athlete's numbers, and two devices disagreeing about CTL would be worse than
// either choice. Each device still needs Drive connected to fetch; until it has, it counts nothing.
import { state, save, rev, onChange, idbGet, idbSet } from './store.js';
import { readAppFile, driveOn } from './drive.js';
import * as F from './lib/fitness.js';
import { weekStart, dayKey } from './lib/dt.js';
import { html, day, ago, fmtTime } from './ui.js';

export const FILE = 'gymtracker-state.json', CACHE_KEY = 'gymtracker-sessions';
export const REFRESH_MIN = 15;
const LB_PER_KG = 2.20462;
export const LEG_GROUPS = ['quads', 'hamstrings', 'glutes', 'calves'];
export const LEG_SETS_MIN = 4;          // fractional leg sets in one session before we call it "legs loaded"
export const LEGS_WINDOW_H = 72;

// GymTracker attributes no muscle group to its "full body" families (cleans, carries, swings,
// sled, box jumps...), yet for a runner they are mostly leg work. Run315's own assumption, shown as
// such: this share of each set goes to the legs, split evenly over quads / hamstrings / glutes.
export const ASSUMED_LEGS = {
  'olympic-lifts': 0.5, 'strongman': 0.4, 'kettlebell-specific': 0.4, 'loaded-carries': 0.3,
  'crossfit-moves': 0.4, 'plyometrics': 0.8, 'plyo-advanced': 0.8, 'hyrox': 0.5,
};

// ---------------------------------------------------------------------------------------
// parsing (pure)
// ---------------------------------------------------------------------------------------
const num = v => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
const sessionKey = s => s.id || 'd:' + s.date;
// GymTracker's own sessionTs(): the newest of updatedAt / endedAt / date / any set's ts.
function sessionTs(s) {
  let t = s.updatedAt || s.endedAt || s.date || '';
  for (const ex of s.exercises || []) for (const st of ex.sets || []) if (st && st.ts && st.ts > t) t = st.ts;
  return t;
}
// An id that is stable across refreshes and safe in a hash route.
export function gtId(s) {
  if (s.id) return 'gt' + String(s.id).replace(/[^A-Za-z0-9-]/g, '');
  const t = Date.parse(s.date);
  return 'gtd' + (Number.isFinite(t) ? t.toString(36) : String(s.date).replace(/[^A-Za-z0-9]/g, ''));
}

// Exercise lookup: built-in variations by uuid prefix, the athlete's custom ones (synced in the
// file, with the movement they belong to) by full uuid.
function resolver(catalog, file) {
  const famById = new Map(catalog.FAMILIES.map(f => [f[0], f]));
  const custom = new Map((file.customVariations || []).filter(c => c && c.uuid).map(c => [c.uuid, c]));
  return varUuid => {
    const v = varUuid && catalog.VARS[String(varUuid).slice(0, 8)];
    if (v) return { title: v[1], fam: catalog.FAMILIES[v[0]], mode: v[2] };
    const c = custom.get(varUuid);
    if (c) return { title: c.title, fam: famById.get(c.movementId) || null, mode: '' };
    return { title: 'Unknown exercise', fam: null, mode: '' };
  };
}
function groupsOf(fam) {
  if (!fam) return { groups: {}, assumed: false };
  const share = ASSUMED_LEGS[fam[0]];
  if (Object.keys(fam[3]).length || !share) return { groups: fam[3], assumed: false };
  const each = +(share / 3).toFixed(3);
  return { groups: { quads: each, hamstrings: each, glutes: each }, assumed: true };
}
// Epley, as GymTracker uses it.
const e1rm = (w, r) => (w > 0 && r >= 1 ? w * (1 + r / 30) : null);

// gymtracker-state.json + the catalogue -> [compact session records], newest first.
// Keeps everything Run315 shows or estimates from; drops nothing but deleted sessions, so the
// cardio-only / already-in-Run315 decisions stay with strengthActivities (they depend on Run315's
// own activities, which change between refreshes).
export function parseGymTracker(file, catalog, now = new Date()) {
  if (!file || !Array.isArray(file.sessions)) return [];
  const unit = file.unit === 'kg' ? 'kg' : 'lb';           // GymTracker's default is lb; w is stored in it
  const look = resolver(catalog, file);
  const tombs = new Map();
  for (const t of file.deletedSessions || []) if (t && t.id && t.deletedAt && !(tombs.get(t.id) > t.deletedAt)) tombs.set(t.id, t.deletedAt);
  // Bodyweight (for bodyweight-mode volume): the newest weigh-in, in the log's unit.
  const bw = (file.bodyComp || []).filter(b => b && num(b.weightKg)).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const bwUnit = bw ? (unit === 'kg' ? num(bw.weightKg) : num(bw.weightKg) * LB_PER_KG) : null;

  const live = file.sessions.filter(s => s && s.date && Number.isFinite(Date.parse(s.date))
    && !(tombs.has(sessionKey(s)) && tombs.get(sessionKey(s)) >= sessionTs(s)));
  // Best e1RM per variation, oldest first, so a set's relative intensity is judged against what
  // the athlete had shown up to and including that day (not against a PR set next month).
  live.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const best = new Map();
  const out = [];
  for (const s of live) {
    const t0 = Date.parse(s.date);
    if (t0 > +now) continue;
    const exercises = [];
    let firstTs = null, lastTs = null, cardioMin = 0;
    for (const ex of s.exercises || []) {
      const info = look(ex.varUuid);
      if (ex.cardio) {
        const m = num(ex.cardio.elapsedMin) || 0;
        cardioMin += m;
        exercises.push({ name: info.title, cardio: true, minutes: m, distance: num(ex.cardio.distance), distance_unit: ex.cardio.distanceUnit || null, sets: [], groups: {} });
        continue;
      }
      const sets = [];
      for (const st of ex.sets || []) {
        const w = num(st.w) || 0, r = num(st.r);
        if (!(r > 0)) continue;
        sets.push([w, r, num(st.rpe)]);
        if (st.ts) { if (!firstTs || st.ts < firstTs) firstTs = st.ts; if (!lastTs || st.ts > lastTs) lastTs = st.ts; }
      }
      if (!sets.length) continue;
      const { groups, assumed } = groupsOf(info.fam);
      // Today's best counts too: the top set of a PR day is near-maximal by definition.
      const key = String(ex.varUuid);
      if (info.mode === '') for (const [w, r] of sets) { const e = e1rm(w, r); if (e && !(best.get(key) >= e)) best.set(key, e); }
      const ref = info.mode === '' ? best.get(key) || null : null;
      let volume = 0;
      for (const [w, r] of sets) {
        if (info.mode === '') volume += w * r;
        else if (info.mode === 'b') volume += ((bwUnit || 0) + w) * r;
      }
      exercises.push({ name: info.title, family: info.fam ? info.fam[1] : null, mode: info.mode, groups, assumed, sets,
        volume: Math.round(volume), e1rm: ref ? Math.round(ref) : null,
        est_rpe: sets.map(([w, r]) => estRpe(w, r, ref, info.mode)) });
    }
    // Duration: GymTracker's end stamp (last set, auto-end, or Strava's elapsed); else the set
    // timestamps plus a last set; else ~2.5 min per set, which is set + rest for most lifting.
    const nSets = exercises.reduce((n, e) => n + e.sets.length, 0);
    let end = s.endedAt && Date.parse(s.endedAt) > t0 ? Date.parse(s.endedAt) : null, durSrc = 'ended';
    if (!end && lastTs && Date.parse(lastTs) > t0) { end = Date.parse(lastTs) + 120000; durSrc = 'sets'; }
    if (!end) { end = t0 + Math.max(cardioMin * 60000, nSets * 150000); durSrc = 'estimate'; }
    const durS = Math.min(4 * 3600, Math.max(0, Math.round((end - t0) / 1000)));
    const hr = s.hr || {};
    out.push({
      key: sessionKey(s), id: gtId(s), start: new Date(t0).toISOString(), end: new Date(t0 + durS * 1000).toISOString(),
      dur_s: durS, dur_src: durSrc, unit,
      avg_hr: num(hr.avg), max_hr: num(hr.max), calories: num(hr.calories),
      strava_id: s.stravaId != null ? String(s.stravaId) : null, imported: s.source === 'strava-import',
      notes: typeof s.notes === 'string' ? s.notes.slice(0, 500) : '', exercises,
    });
  }
  return out.reverse();
}

// A set's RPE estimated from how close it sat to the lift's best e1RM: reps the athlete could
// have done at that weight (Epley inverted) minus reps done = reps in reserve. The best e1RM is
// itself rarely a true max, hence the 3% (about one rep) of headroom. Bodyweight, timed and
// distance sets, and lifts with no history, get a neutral 7.
export function estRpe(w, r, ref, mode = '') {
  if (mode !== '' || !ref || !(w > 0)) return 7;
  const possible = 30 * (ref * 1.03 / w - 1);
  return Math.max(5, Math.min(10, 10 - Math.max(0, possible - r)));
}

// ---------------------------------------------------------------------------------------
// load (pure)
// ---------------------------------------------------------------------------------------
// Three estimates, best first. All land on the scale of F.activityLoad (TSS-like: one hour at
// threshold = 100), but none of them measures what lifting does to a runner's legs; treat the
// number as +-30-40 %, and the volume one as a rough guess.
//
// 1. Session RPE (Foster): load = session RPE (CR-10) x minutes. GymTracker logs RPE per SET
//    (proximity to failure, 5-10), not per session; with rests between sets, a session of RPE-8
//    sets is typically rated 5-7 overall, so session RPE ~ mean set RPE - 2. Scaled at 10 per
//    RPE point per hour: a maximal hour = 100 (= an hour at threshold), RPE 6 for an hour = 60,
//    close to an easy hour's run (IF 0.75 -> 56). TrainingPeaks' RPE table runs 10-40 % higher at
//    the top; Foster-to-TSS has no agreed constant.
// 2. Heart rate, exactly as activityLoad does it for a run (hours x (HR/threshold HR)^2 x 100).
//    Lifting HR understates muscular work and includes rests, so this tends to read low.
// 3. Volume: the same formula as 1 with each set's RPE estimated from its weight against the
//    lift's best e1RM (estRpe). Low confidence.
export const RPE_TO_SESSION = 2, LOAD_PER_RPE_HOUR = 10;
export function sessionLoad(rec, thrHr = null) {
  const hours = rec.dur_s / 3600;
  const sets = rec.exercises.flatMap(e => e.sets);
  if (!sets.length || hours <= 0) return { load: 0, method: 'none', confidence: 'none', note: 'No strength sets.' };
  const rated = sets.filter(s => s[2] != null);
  if (rated.length >= 3 && rated.length >= 0.3 * sets.length) {
    const mean = rated.reduce((a, s) => a + s[2], 0) / rated.length;
    const srpe = Math.max(1, Math.min(10, mean - RPE_TO_SESSION));
    return { load: hours * LOAD_PER_RPE_HOUR * srpe, method: 'srpe', confidence: 'medium', srpe, set_rpe: mean, rated: rated.length,
      note: `Session RPE ≈ ${srpe.toFixed(1)} (mean of ${rated.length} logged set RPEs ${mean.toFixed(1)}, minus ${RPE_TO_SESSION} for the rests) × ${Math.round(hours * 60)} min.` };
  }
  if (rec.avg_hr && thrHr) {
    const intensity = Math.max(0.4, Math.min(1.15, rec.avg_hr / thrHr));
    return { load: hours * intensity * intensity * 100, method: 'hr', confidence: 'medium', intensity,
      note: `Average HR ${Math.round(rec.avg_hr)} against a threshold of ${Math.round(thrHr)} (intensity ${intensity.toFixed(2)}) over ${Math.round(hours * 60)} min, as for a run. Tends to read low for lifting.` };
  }
  const est = rec.exercises.flatMap(e => e.est_rpe || e.sets.map(() => 7));
  const mean = est.reduce((a, v) => a + v, 0) / est.length;
  const srpe = Math.max(1, Math.min(10, mean - RPE_TO_SESSION));
  return { load: hours * LOAD_PER_RPE_HOUR * srpe, method: 'volume', confidence: 'low', srpe, set_rpe: mean,
    note: `No RPE or heart rate: each set's effort guessed from its weight against your best for that lift (mean ≈ RPE ${mean.toFixed(1)}), then as session RPE ${srpe.toFixed(1)} × ${Math.round(hours * 60)} min. A rough guess.` };
}

// Fractional sets per muscle group for one session (GymTracker's bpSessionLoad).
export function groupSets(rec) {
  const out = {};
  for (const e of rec.exercises) for (const [g, f] of Object.entries(e.groups || {})) out[g] = (out[g] || 0) + f * e.sets.length;
  return out;
}
export const legSets = rec => { const g = groupSets(rec); return LEG_GROUPS.reduce((a, k) => a + (g[k] || 0), 0); };

// Records -> pseudo-activities, minus what Run315 already counts.
//   - cardio-only sessions (GymTracker's Strava "orphans", manual cardio): Run315 has its own
//     Garmin/Strava copy of nearly all of them, and counting both doubles the load;
//   - sessions linked to a Strava activity Run315 holds as cardio: same reason.
//   A session linked to an activity Run315 holds as strength_training is KEPT: Run315's copy has
//   no sets and is not counted in load (not a cardio type), GymTracker's is the better record.
//   It borrows that copy's HR if it has none, and names it in `shadows`.
export function toActivities(records, ownActivities, thrHr) {
  const byStrava = new Map();
  for (const a of ownActivities) if (a.strava_id != null) byStrava.set(String(a.strava_id), a);
  const out = [];
  for (const r of records) {
    const strengthSets = r.exercises.reduce((n, e) => n + e.sets.length, 0);
    if (!strengthSets || r.imported) continue;
    const twin = r.strava_id ? byStrava.get(r.strava_id) : null;
    if (twin && F.CARDIO_TYPES.has(twin.type)) continue;
    const rec = twin && !r.avg_hr && twin.avg_hr ? { ...r, avg_hr: twin.avg_hr, max_hr: r.max_hr || twin.max_hr || null } : r;
    const L = sessionLoad(rec, thrHr);
    const g = groupSets(rec);
    const top = Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k);
    out.push({
      id: r.id, source: 'gymtracker', type: 'strength_training',
      name: 'Strength' + (top.length ? ' · ' + top.join(', ') : ''),
      start: r.start, moving_s: r.dur_s, elapsed_s: r.dur_s, distance_m: null, elev_gain_m: null,
      avg_hr: rec.avg_hr, max_hr: rec.max_hr, calories: r.calories,
      load: L.load, load_method: L.method, load_confidence: L.confidence,
      sets: strengthSets, leg_sets: LEG_GROUPS.reduce((a, k) => a + (g[k] || 0), 0),
      gt_strava_id: r.strava_id, shadows: twin ? twin.id : null,
    });
  }
  return out;
}

// The most recent leg-loading session in the window: {hours, legSets, id} or null.
export function legsLoaded(acts, now = new Date(), windowH = LEGS_WINDOW_H, min = LEG_SETS_MIN) {
  let best = null;
  for (const a of acts) {
    const endMs = Date.parse(a.start) + (a.moving_s || 0) * 1000;
    const h = (+now - endMs) / 3600000;
    if (h < 0 || h > windowH || !(a.leg_sets >= min)) continue;
    if (!best || h < best.hours) best = { hours: h, legSets: a.leg_sets, id: a.id };
  }
  return best;
}

// ---------------------------------------------------------------------------------------
// the live layer: memory + IndexedDB + Drive
// ---------------------------------------------------------------------------------------
let _recs = [], _fetchedAt = null, _error = null, _busy = false, _ver = 0, _cacheLoaded = false;
export const strengthEnabled = () => !!(state.profile && state.profile.gymtracker && state.profile.gymtracker.enabled);

export function strengthStatus() {
  return { enabled: strengthEnabled(), drive: driveOn(), loaded: _cacheLoaded, fetchedAt: _fetchedAt,
    sessions: _recs.length, counted: strengthActivities().length, lastError: _error, busy: _busy };
}

let _memo = { key: null, value: [] };
export function strengthActivities() {
  if (!strengthEnabled() || !_recs.length) return [];
  const key = rev + ':' + _ver;
  if (_memo.key === key) return _memo.value;
  // Threshold HR from Run315's own activities only: lifting HR would drag the percentile down.
  const own = Object.values(state.activities);
  const value = toActivities(_recs, own, F.thresholds(own)[0]);
  _memo = { key, value };
  return value;
}

// Tell derive.js (it memoises on store.rev) and the shell that the sessions changed. The
// 'cloud-' prefix keeps drive.js from pushing Run315's state over it. Never before the state
// has loaded: save() persists, and persisting the empty boot state would wipe the real one.
function changed() { _ver++; if (rev > 0) save('cloud-strength'); }

export async function loadStrengthCache() {
  try {
    const c = await idbGet('cache', CACHE_KEY);
    if (c && Array.isArray(c.sessions) && !_recs.length) { _recs = c.sessions; _fetchedAt = c.fetchedAt || null; changed(); }
  } catch (e) { console.warn('gymtracker cache', e); }
  _cacheLoaded = true;
}

export async function refreshStrength({ force = false } = {}) {
  if (!strengthEnabled()) return strengthStatus();
  if (!driveOn()) { _error = 'Google Drive is not connected on this device.'; return strengthStatus(); }
  if (_busy) return strengthStatus();
  if (!force && _fetchedAt && Date.now() - Date.parse(_fetchedAt) < REFRESH_MIN * 60000) return strengthStatus();
  _busy = true;
  try {
    const file = await readAppFile(FILE);
    _fetchedAt = new Date().toISOString();
    if (!file) _error = 'No gymtracker-state.json in the Drive app folder yet: connect Google Drive in GymTracker (Data sync) with the same Google account.';
    else {
      const catalog = await import('./gtcatalog.js');
      _recs = parseGymTracker(file, catalog);
      _error = null;
    }
    await idbSet('cache', CACHE_KEY, { fetchedAt: _fetchedAt, sessions: _recs });
    changed();
  } catch (e) {
    _error = e.message || String(e);
  } finally { _busy = false; }
  return strengthStatus();
}
// Forget the fetched sessions on this device (the switch going off keeps them; this clears them).
export async function clearStrength() {
  _recs = []; _fetchedAt = null; _error = null;
  try { await idbSet('cache', CACHE_KEY, null); } catch {}
  changed();
}

// Boot: in the browser only, load the cache now and refresh after each Drive sync (drive.js
// emits 'cloud' when one succeeded), at most every REFRESH_MIN minutes.
if (typeof window !== 'undefined' && typeof indexedDB !== 'undefined') {
  loadStrengthCache().then(() => { if (rev > 0) refreshStrength(); });
  onChange(why => { if (why === 'cloud-data') refreshStrength(); });
}

// ---------------------------------------------------------------------------------------
// html
// ---------------------------------------------------------------------------------------
const METHOD = { srpe: 'session RPE', hr: 'heart rate', volume: 'volume (rough)', none: '—' };
const fmtH = h => (h < 1 ? '<1 h' : h < 48 ? Math.round(h) + ' h' : (h / 24).toFixed(1) + ' days');
const r0 = v => Math.round(v || 0);

// This week's load from Run315's own cardio and from GymTracker, with the same thresholds.
export function weekShare(acts, own, now = new Date()) {
  const wk = weekStart(now);
  const [thrHr, thrSpd] = F.thresholds(own);
  let cardio = 0, strength = 0;
  for (const a of own) if (F.CARDIO_TYPES.has(a.type) && a.start && weekStart(new Date(a.start)) === wk) cardio += F.activityLoad(a, thrHr, thrSpd);
  for (const a of acts) if (weekStart(new Date(a.start)) === wk) strength += a.load;
  return { cardio, strength, share: cardio + strength > 0 ? strength / (cardio + strength) : 0 };
}

export function strengthPanel(now = new Date()) {
  if (!strengthEnabled()) return '';
  const acts = strengthActivities();
  if (!acts.length) {
    return html`<section class="panel"><div class="panel-head"><p class="eyebrow">Strength</p>
      <p class="panel-note"><a class="quiet-link" href="#/strength">GymTracker</a></p></div>
      <p class="stat-hint">${_error || (_fetchedAt ? 'No strength sessions in GymTracker yet.' : 'Waiting for the first read of GymTracker’s file.')}</p></section>`;
  }
  const legs = legsLoaded(acts, now);
  const wk = weekShare(acts, Object.values(state.activities), now);
  const recent = acts.slice().sort((a, b) => b.start.localeCompare(a.start)).slice(0, 3);
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Strength</p><p class="panel-note"><a class="quiet-link" href="#/strength">From GymTracker · ${ago(_fetchedAt)}</a></p></div>
    <p style="margin-top:0">${legs
      ? html`<b>Legs loaded ${fmtH(legs.hours)} ago</b> (${legs.legSets.toFixed(0)} leg sets). Heavy leg work can leave easy pace feeling hard and intervals flat for 48–72 h; a quality run may go better after it has passed.`
      : html`No leg session in the last ${LEGS_WINDOW_H} h.`}</p>
    <p class="stat-hint">This week: strength ≈ <b>${r0(wk.strength)}</b> of ${r0(wk.cardio + wk.strength)} load (${r0(wk.share * 100)} %). Estimated, ±30–40 %.</p>
    <div class="table-scroll"><table><tbody>${recent.map(a => html`<tr>
      <td class="dim">${day(a.start)}</td>
      <td><a class="quiet-link" href="#/activity/${a.id}">${a.name}</a></td>
      <td class="num">${a.sets} sets</td><td class="num">${r0(a.load)}${a.load_confidence === 'low' ? '?' : ''}</td></tr>`)}</tbody></table></div>
  </section>`;
}

export function strengthDetail(id) {
  const rec = _recs.find(r => r.id === id);
  if (!rec) return '';
  const act = strengthActivities().find(a => a.id === id) || null;
  const own = Object.values(state.activities);
  const L = sessionLoad(act ? { ...rec, avg_hr: act.avg_hr } : rec, F.thresholds(own)[0]);
  const g = Object.entries(groupSets(rec)).sort((a, b) => b[1] - a[1]);
  const legs = LEG_GROUPS.reduce((a, k) => a + (groupSets(rec)[k] || 0), 0);
  const assumed = rec.exercises.some(e => e.assumed);
  const fmtSet = (e, [w, r, rpe]) => (e.mode === 't' ? `${fmtTime(r)}${w ? ' @ ' + w : ''}` : e.mode === 'd' ? `${w} × ${r} m`
    : e.mode === 'b' ? `${w ? (w > 0 ? '+' : '') + w + ' × ' : 'BW × '}${r}` : `${w} × ${r}`) + (rpe != null ? ` @${rpe}` : '');
  const vol = rec.exercises.reduce((a, e) => a + (e.volume || 0), 0);
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">GymTracker session</p>
      <p class="panel-note">${fmtTime(rec.dur_s)}${rec.dur_src === 'estimate' ? ' (estimated from set count)' : rec.dur_src === 'sets' ? ' (from set times)' : ''}${rec.avg_hr ? ` · avg HR ${r0(rec.avg_hr)}` : ''}</p></div>
    ${act ? '' : html`<p class="stat-hint">Not counted in load: ${rec.imported || !rec.exercises.some(e => e.sets.length) ? 'cardio only, Run315 has its own copy.' : 'its Strava activity is already in Run315.'}</p>`}
    <div class="table-scroll"><table>
      <thead><tr><th>Exercise</th><th>Sets (${rec.unit})</th><th class="num">Volume</th></tr></thead>
      <tbody>${rec.exercises.map(e => html`<tr>
        <td>${e.name}${e.family && e.family !== e.name ? html`<span class="dim"> · ${e.family}</span>` : ''}</td>
        <td>${e.cardio ? `${r0(e.minutes)} min${e.distance ? ` · ${e.distance} ${e.distance_unit || ''}` : ''}` : e.sets.map(s => fmtSet(e, s)).join(', ')}</td>
        <td class="num">${e.volume ? e.volume.toLocaleString() : '--'}</td></tr>`)}</tbody>
      <tfoot><tr><td>Total</td><td>${rec.exercises.reduce((n, e) => n + e.sets.length, 0)} sets</td><td class="num">${vol.toLocaleString()} ${rec.unit}</td></tr></tfoot>
    </table></div>
    <div class="grid-2" style="margin-top:14px">
      <div><div class="stat"><div class="stat-value">${r0(L.load)}</div>
        <div class="stat-label">Estimated load · ${METHOD[L.method]}</div>
        <div class="stat-hint">${L.note} ${L.confidence === 'low' ? 'Low confidence.' : 'About ±30–40 %.'} Same scale as a run's load (an hour at threshold = 100).</div></div></div>
      <div><div class="stat"><div class="stat-value">${legs.toFixed(1)}</div><div class="stat-label">Leg sets</div>
        <div class="stat-hint">${g.length ? g.map(([k, v]) => `${k} ${v.toFixed(1)}`).join(' · ') : 'No muscle groups known for these exercises.'}
          Fractional sets, as GymTracker splits each exercise over muscles.${assumed ? ' Full-body moves (cleans, carries, swings, jumps) are counted as part leg work: Run315’s assumption.' : ''}</div></div></div>
    </div>
    ${act && act.shadows ? html`<p class="stat-hint">Also in Run315 from Strava as <a class="quiet-link" href="#/activity/${act.shadows}">this activity</a>; only this one counts.</p>` : ''}
    ${rec.notes ? html`<p class="stat-hint">${rec.notes}</p>` : ''}
  </section>`;
}
