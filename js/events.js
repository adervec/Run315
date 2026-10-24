// Achievements and the daily digest: an event feed read back out of the state, so
// nothing has to be recorded at the moment it happens -- a record set on a run synced
// from the phone, or a trail finished by a re-match, shows up the same way.
//
// Each event is {id, at, kind, title, detail, link, noticed?}: `at` is when it happened
// (the activity's start, or the day), `noticed` when this data arrived here (the
// record's `u`), which is what "since you last looked" has to go by -- a run from
// Tuesday imported on Thursday is news on Thursday.
//
// The detectors are deliberately stingy. A feed that congratulates every run is a feed
// nobody reads, and early in a record almost everything is a "best": so a best effort
// needs three earlier efforts at that distance to beat, a longest run needs six weeks
// since anything longer, and trends need a baseline of three weeks of nights.
//
// Pure apart from allEvents(), which reads the state through derive.js. Tests:
// test/events.test.mjs.
import { DISTANCE_TIERS_KM } from './lib/recap.js';
import { weekStart, addDayKey, daysBetween, dayKey, isoLocal } from './lib/dt.js';
import { fmtTime } from './lib/fitness.js';
import { maxSquare } from './lib/territory.js';
import { trailKey, DEFAULT_COMPLETE_AT } from './lib/trails.js';

export const MIN_PRIOR_EFFORTS = 3;      // a best beats at least this many earlier efforts
export const LONGEST_MIN_WEEKS = 6;      // "longest in N weeks" only from six weeks up
export const STREAK_MILESTONES = [4, 8, 12, 16, 26, 39, 52, 78, 104, 156, 208, 260];
export const BIG_TILE_DAY = 50;          // new tiles in a day worth a line of its own (a 10 km run on new ground is ~50)
export const TREND_BASE_NIGHTS = 21, TREND_HOLD_DAYS = 3;

// Activity starts are local wall-clock ISO without a zone (derive hands out Dates of them).
const iso = v => (v instanceof Date ? isoLocal(v) : String(v || ''));
const dayOf = v => iso(v).slice(0, 10);
const atDay = d => d + 'T12:00:00';
const chrono = (a, b) => iso(a.start).localeCompare(iso(b.start));

const DIST_NAMES = { 1609: '1 mile', 16093: '10 miles', 21097: 'half marathon', 42195: 'marathon' };
export function distLabel(m) {
  const r = Math.round(m);
  if (DIST_NAMES[r]) return DIST_NAMES[r];
  return r < 1000 ? r + ' m' : +(r / 1000).toFixed(2) + ' km';
}
const shortDay = d => { const [y, m, dd] = dayOf(d).split('-'); return `${+dd} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1]} ${y}`; };

// ---- best efforts ----
// rows: derive.prRows ([distance, seconds, day, activity id]); acts: id -> activity.
// One event per activity, listing every distance it beat, each with the record it beat.
export function bestEffortEvents(rows, acts = {}, noticed = {}) {
  const byAct = new Map();
  for (const [dist, secs, d, id] of rows) {
    if (!secs) continue;
    if (!byAct.has(id)) byAct.set(id, { id, start: acts[id]?.start || d, efforts: [] });
    byAct.get(id).efforts.push([+dist, secs]);
  }
  const best = new Map(), out = [];   // distance -> {secs, id, start, n}
  for (const a of [...byAct.values()].sort(chrono)) {
    const beat = [];
    for (const [dist, secs] of a.efforts.sort((x, y) => x[0] - y[0])) {
      const b = best.get(dist);
      if (b && b.n >= MIN_PRIOR_EFFORTS && secs < b.secs - 0.5) beat.push([dist, secs, { ...b }]);
      if (!b) best.set(dist, { secs, id: a.id, start: a.start, n: 1 });
      else { b.n++; if (secs < b.secs) Object.assign(b, { secs, id: a.id, start: a.start }); }
    }
    if (!beat.length) continue;
    const top = beat[beat.length - 1];   // the longest distance leads the title
    const name = acts[a.id]?.name;
    out.push({ id: 'pr-' + a.id, at: iso(a.start), kind: 'best', noticed: noticed[a.id] || null,
      title: beat.length === 1 ? `New ${distLabel(top[0])} best: ${fmtTime(top[1])}`
        : `New bests at ${beat.map(b => distLabel(b[0])).join(', ')}`,
      detail: (name ? name + ': ' : '') + beat.map(([d, s, b]) => `${distLabel(d)} ${fmtTime(s)}, was ${fmtTime(b.secs)} (${shortDay(b.start)})`).join('; ') + '.',
      link: '#/activity/' + a.id });
  }
  return out;
}

// ---- longest run in N weeks ----
// runs: [{id, start, distance_m, name}]. Needs five earlier runs, so the first weeks of
// a record do not each crown a "longest ever".
export function longestRunEvents(runs, noticed = {}) {
  const rs = runs.filter(r => r.distance_m > 0).sort(chrono), out = [];
  for (let i = 5; i < rs.length; i++) {
    const r = rs[i];
    let j = i - 1;
    while (j >= 0 && rs[j].distance_m < r.distance_m) j--;
    const since = j >= 0 ? daysBetween(dayOf(rs[j].start), dayOf(r.start)) : null;
    const span = daysBetween(dayOf(rs[0].start), dayOf(r.start));
    const km = (r.distance_m / 1000).toFixed(1);
    if (j < 0 && span >= LONGEST_MIN_WEEKS * 7)
      out.push({ id: 'long-' + r.id, at: iso(r.start), kind: 'longest', noticed: noticed[r.id] || null,
        title: `Longest run on record: ${km} km`, detail: `Further than anything in the ${Math.floor(span / 7)} weeks this record covers.`, link: '#/activity/' + r.id });
    else if (since != null && since >= LONGEST_MIN_WEEKS * 7)
      out.push({ id: 'long-' + r.id, at: iso(r.start), kind: 'longest', noticed: noticed[r.id] || null,
        title: `Longest run in ${Math.floor(since / 7)} weeks: ${km} km`,
        detail: `The last one at least this long was ${shortDay(rs[j].start)} (${(rs[j].distance_m / 1000).toFixed(1)} km).`, link: '#/activity/' + r.id });
  }
  return out;
}

// ---- week streaks (weeks with a run, as recap.weekStreak counts them) ----
export function streakEvents(runs, noticed = {}) {
  const firstOfWeek = new Map();
  for (const r of [...runs].sort(chrono)) { const w = weekStart(dayOf(r.start)); if (!firstOfWeek.has(w)) firstOfWeek.set(w, r); }
  const weeks = [...firstOfWeek.keys()].sort(), out = [];
  let n = 0;
  for (let i = 0; i < weeks.length; i++) {
    n = i && daysBetween(weeks[i - 1], weeks[i]) === 7 ? n + 1 : 1;
    if (!STREAK_MILESTONES.includes(n)) continue;
    const r = firstOfWeek.get(weeks[i]);
    out.push({ id: `streak-${n}-${weeks[i]}`, at: iso(r.start), kind: 'streak', noticed: noticed[r.id] || null,
      title: `${n} weeks in a row with a run`, detail: `Streak running since the week of ${shortDay(addDayKey(weeks[i], -7 * (n - 1)))}. Counted in weeks, so rest days never break it.`,
      link: '#/career' });
  }
  return out;
}

// ---- career distance milestones ----
export function careerEvents(runs, noticed = {}, tiers = DISTANCE_TIERS_KM) {
  let km = 0, k = 0;
  const out = [];
  for (const r of [...runs].sort(chrono)) {
    km += (r.distance_m || 0) / 1000;
    while (k < tiers.length && km >= tiers[k]) {
      out.push({ id: 'career-' + tiers[k], at: iso(r.start), kind: 'career', noticed: noticed[r.id] || null,
        title: `${tiers[k].toLocaleString('en-GB')} km on record`, detail: `Crossed on ${r.name || 'a run'}, ${shortDay(r.start)}.`, link: '#/career' });
      k++;
    }
  }
  return out;
}

// ---- territory: big new-tile days and max-square growth ----
// firstSeen: Map tile key 'x,y' -> first day (derive.tileSummary().first_seen). The
// first day of the record is skipped: every tile is "new" on the day tracking began.
export function tileEvents(firstSeen) {
  if (!firstSeen || !firstSeen.size) return [];
  const byDay = new Map();
  for (const [k, d] of firstSeen) { if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(k.split(',').map(Number)); }
  const days = [...byDay.keys()].sort(), all = [], out = [];
  let sq = 0;
  days.forEach((d, i) => {
    const fresh = byDay.get(d);
    all.push(...fresh);
    const [n] = maxSquare(all);
    if (i > 0 && fresh.length >= BIG_TILE_DAY)
      out.push({ id: 'tiles-' + d, at: atDay(d), kind: 'tiles', title: `${fresh.length} new tiles in a day`,
        detail: `${all.length} claimed in all.`, link: '#/territory' });
    if (i > 0 && n > sq && n >= 2)
      out.push({ id: 'square-' + n, at: atDay(d), kind: 'square', title: `Max square grew to ${n}×${n}`,
        detail: `Up from ${sq}×${sq}.`, link: '#/territory' });
    sq = Math.max(sq, n);
  });
  return out;
}

// ---- trails finished (from the synced per-day gains, as the trails page reads them) ----
// A trail is finished once, on the day its covered share crossed `completeAt`.
export function trailEvents(areas, completeAt = DEFAULT_COMPLETE_AT) {
  const total = new Map(), names = new Map(), seen = new Set(), rows = [];
  for (const a of Object.values(areas || {})) {
    for (const [wid, w] of Object.entries(a.ways || {})) {
      if (seen.has(wid)) continue;
      seen.add(wid);
      const [name, , nodes] = w, k = trailKey({ id: wid, name });
      total.set(k, (total.get(k) || 0) + (nodes || 0));
      if (name) names.set(k, name);
    }
    rows.push(...(a.gains || []));
  }
  rows.sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  const hit = new Map(), out = [];
  for (const [d, key, nodes] of rows) {
    const before = hit.get(key) || 0, after = before + (nodes || 0), n = total.get(key) || 1;
    hit.set(key, after);
    if (before / n < completeAt && completeAt <= after / n)
      out.push({ id: 'trail-' + key, at: atDay(d), kind: 'trail', title: `Finished ${names.get(key) || 'a trail'}`,
        detail: `${Math.round(completeAt * 100)}% of its length covered.`, link: '#/trails' });
  }
  return out;
}

// ---- races that beat the projection ----
export function raceEvents(races) {
  const out = [];
  for (const r of Object.values(races || {})) {
    if (!r.actual_s || !r.predicted_s || !(r.actual_s < r.predicted_s)) continue;
    const goal = r.goal_s ? (r.actual_s <= r.goal_s ? `, goal ${fmtTime(r.goal_s)} met` : `, goal ${fmtTime(r.goal_s)} missed by ${fmtTime(r.actual_s - r.goal_s)}`) : '';
    out.push({ id: 'race-' + r.id, at: atDay(r.date), kind: 'race', noticed: r.u || null,
      title: `${r.name}: beat the projection by ${fmtTime(r.predicted_s - r.actual_s)}`,
      detail: `Ran ${fmtTime(r.actual_s)} against a projected ${fmtTime(r.predicted_s)}${goal}.`, link: '#/race/' + r.id });
  }
  return out;
}

// ---- readiness trends: a week of nights against the nights before it ----
// rows: [{day, hrv_ms, rhr}] sorted. For each day, the median of the last 7 nights against
// the mean and spread of up to 60 nights before them; a change of band (beyond ±1 SD)
// is reported once it has held three days, so one bad night is not news.
export function trendEvents(rows, metric = 'hrv_ms') {
  const v = rows.filter(r => typeof r[metric] === 'number' && r[metric] > 0);
  const out = [], label = metric === 'hrv_ms' ? 'HRV' : 'Resting HR', unit = metric === 'hrv_ms' ? 'ms' : 'bpm';
  let state = null, cand = null, held = 0;
  for (let i = 0; i < v.length; i++) {
    const recent = v.slice(Math.max(0, i - 6), i + 1), base = v.slice(Math.max(0, i - 66), Math.max(0, i - 6));
    if (recent.length < 5 || base.length < TREND_BASE_NIGHTS) continue;
    // Median of the week, so one bad night (a late dinner, a broken strap) moves nothing.
    const sorted = recent.map(r => r[metric]).sort((a, b) => a - b), mid = sorted.length >> 1;
    const m = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const bm = base.reduce((s, r) => s + r[metric], 0) / base.length;
    const sd = Math.sqrt(base.reduce((s, r) => s + (r[metric] - bm) ** 2, 0) / (base.length - 1)) || 1e-9;
    const z = (m - bm) / sd, band = z >= 1 ? 'high' : z <= -1 ? 'low' : 'usual';
    if (band === cand) held++; else { cand = band; held = 1; }
    if (held < TREND_HOLD_DAYS || band === state) continue;
    if (state !== null) {
      const words = band === 'usual' ? 'back in your usual range' : band === 'high' ? 'above your usual range' : 'below your usual range';
      const good = metric === 'hrv_ms' ? band !== 'low' : band !== 'high';
      out.push({ id: `trend-${metric}-${v[i].day}`, at: atDay(v[i].day), kind: 'trend', noticed: v[i].u || null, good,
        title: `${label} ${words}`,
        detail: `7-night median ${m.toFixed(0)} ${unit} against ${bm.toFixed(0)} ± ${sd.toFixed(0)} ${unit} over the ${base.length} nights before. A trend in the numbers, not a diagnosis.`,
        link: '#/vitals' });
    }
    state = band;
  }
  return out;
}

const newestFirst = (a, b) => String(b.at).localeCompare(String(a.at)) || String(a.id).localeCompare(String(b.id));

// Everything, newest first. `D` is derive.js (passed in so this module stays importable
// without the store); memoised on the store's revision by the caller if it wants.
export function allEvents(st, D) {
  const acts = st.activities || {}, runs = D.runs(st).filter(a => a.source !== 'gymtracker');
  const actNoticed = {}, effortNoticed = {};
  for (const [id, a] of Object.entries(acts)) actNoticed[id] = a.u || null;
  for (const [id, d] of Object.entries(st.derived || {})) effortNoticed[id] = d.u || actNoticed[id] || null;
  const tiles = D.tileSummary(st);
  const wellness = Object.keys(st.wellness || {}).sort().map(day => ({ day, ...st.wellness[day] }));
  const out = [
    ...bestEffortEvents(D.prRows(st), acts, effortNoticed),
    ...longestRunEvents(runs, actNoticed),
    ...streakEvents(runs, actNoticed),
    ...careerEvents(runs, actNoticed),
    ...(tiles ? tileEvents(tiles.first_seen) : []),
    ...trailEvents(st.trailAreas),
    ...raceEvents(st.races),
    ...trendEvents(wellness, 'hrv_ms'),
    ...trendEvents(wellness, 'rhr'),
  ];
  return out.sort(newestFirst);
}
// allEvents is ~150 ms on a year of data (the square replay dominates): once per state
// revision, shared by Today and the achievements page.
let _cache = { st: null, rev: -1, events: [] };
export function cachedEvents(st, D, rev) {
  if (_cache.st !== st || _cache.rev !== rev) _cache = { st, rev, events: allEvents(st, D) };
  return _cache.events;
}

// "Since you last looked": events that arrived after `lastSeen` and happened in the
// last `recentDays` (a re-derive re-stamps old records; their events are not news),
// the cowork imports since then, and what is still missing. No lastSeen (first look
// on this device): the last fortnight.
export function digest(events, { lastSeen = null, now = new Date(), coworkRuns = [], gaps = [], recentDays = 30 } = {}) {
  const today = dayKey(now);
  const since = lastSeen || addDayKey(today, -14) + 'T00:00:00';
  const recent = addDayKey(today, -recentDays);
  const fresh = events.filter(e => String(e.at).slice(0, 10) >= recent && String(e.noticed || e.at) > since);
  const brought = coworkRuns.filter(r => r && r.kind === 'check' && r.ok && r.channel && String(r.at) > since && r.note)
    .map(r => ({ at: r.at, channel: r.channel, note: r.note }));
  return { since, first: !lastSeen, events: fresh, cowork: brought, gaps };
}
