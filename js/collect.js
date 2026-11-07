// Collections and sharing, the pure half: the Eddington number, the places you have run,
// privacy zones, the geometry of a share card / poster / track wall, the year in review,
// and air quality per run. No storage, no network, no DOM -- js/share.js does those, and the
// pages (#/records, #/year) put them on screen. See test/collect.test.mjs.
//
// What syncs, and how small it is:
//   state.profile.places  = {cells: {cellKey: [municipality, region, country_code]}}
//                           one entry per ~2 km cluster of start points (dozens, not thousands)
//   state.profile.privacy = {zones: [{lat, lon, radius_m}], trim_m: 0 | 200}
// Air quality is device-local (IndexedDB `cache`, re-fetchable), never synced.
import { RUN_TYPES, fmtTime, fmtPace } from './lib/fitness.js';
import { dayKey, weekStart, addDayKey, daysBetween } from './lib/dt.js';

const KM = 1000, MILE = 1609.344;
export const isRunType = t => RUN_TYPES.has(t);
export const isRideType = t => /cycl|bik|ride/.test(t || '');
// Mirrors derive.isVirtual (kept here so this module has no state dependencies).
export const isVirtual = a => !!a && (/virtual|indoor|treadmill|trainer|zwift/i.test(a.type || '') || !!a.trainer
  || /zwift|watopia|rouvy|mywhoosh|tacx|wahoo systm/i.test(a.name || ''));
const startStr = a => (a.start instanceof Date ? dayKey(a.start) + 'T' + a.start.toTimeString().slice(0, 8) : String(a.start || ''));
const dayOf = a => startStr(a).slice(0, 10);

// ---------------------------------------------------------------------------
// Eddington number: the largest E such that you have covered at least E (km or miles) on
// at least E days. Days are calendar days; two runs on one day add up.
// ---------------------------------------------------------------------------

// values: one total per day, in the unit. -> {E, days, curve: [[n, daysAtLeastN]], next: [{n, have, need}]}
export function eddingtonOf(values) {
  const v = values.filter(x => x > 0).sort((a, b) => b - a);
  let E = 0;
  while (E < v.length && v[E] >= E + 1) E++;
  const atLeast = n => { let lo = 0, hi = v.length; while (lo < hi) { const m = (lo + hi) >> 1; if (v[m] >= n) lo = m + 1; else hi = m; } return lo; };
  const top = Math.min(Math.floor(v[0] || 0), Math.max(E * 3, E + 30), 500), curve = [];
  for (let n = 1; n <= top; n++) curve.push([n, atLeast(n)]);
  const next = [];
  for (let n = E + 1; n <= E + 5; n++) { const have = atLeast(n); next.push({ n, have, need: Math.max(0, n - have) }); }
  return { E, days: v.length, curve, next };
}
// Activities -> Map day -> metres, for those `pred` accepts.
export function dailyMetres(acts, pred) {
  const m = new Map();
  for (const a of acts) if (a && pred(a) && a.distance_m > 0) { const d = dayOf(a); m.set(d, (m.get(d) || 0) + a.distance_m); }
  return m;
}
// The state -> Eddington for running and cycling, in km and miles.
export function eddington(st) {
  const acts = Object.values((st && st.activities) || {});
  const one = pred => {
    const days = [...dailyMetres(acts, pred).values()];
    return { km: eddingtonOf(days.map(m => m / KM)), mi: eddingtonOf(days.map(m => m / MILE)) };
  };
  return { run: one(a => isRunType(a.type)), ride: one(a => isRideType(a.type)) };
}

// ---------------------------------------------------------------------------
// Places: start points clustered on a ~2 km grid, each cluster reverse-geocoded once.
// ---------------------------------------------------------------------------
export const CELL_DEG = 0.02;   // ~2.2 km of latitude; less in longitude away from the equator
const okPt = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180 && !(p[0] === 0 && p[1] === 0);
export const cellKey = (lat, lon, step = CELL_DEG) => (Math.round(lat / step) * step).toFixed(2) + ',' + (Math.round(lon / step) * step).toFixed(2);

// -> [{key, lat, lon, ids: [newest first], first: day, last: day}] by count, most first.
// lat/lon are the mean of the members (a real start area, not the grid corner).
export function startClusters(st) {
  const m = new Map();
  for (const a of Object.values((st && st.activities) || {})) {
    const p = st.derived?.[a.id]?.p0;
    if (!okPt(p) || isVirtual(a)) continue;
    const k = cellKey(p[0], p[1]);
    let c = m.get(k);
    if (!c) m.set(k, c = { key: k, sl: 0, so: 0, ids: [], first: null, last: null, acts: [] });
    c.sl += p[0]; c.so += p[1]; c.acts.push(a);
    const d = dayOf(a);
    if (!c.first || d < c.first) c.first = d;
    if (!c.last || d > c.last) c.last = d;
  }
  return [...m.values()].map(c => ({ key: c.key, lat: c.sl / c.acts.length, lon: c.so / c.acts.length, first: c.first, last: c.last,
    ids: c.acts.sort((a, b) => startStr(b).localeCompare(startStr(a))).map(a => a.id) }))
    .sort((a, b) => b.ids.length - a.ids.length || a.key.localeCompare(b.key));
}

export const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
export const nominatimUrl = (lat, lon) => `${NOMINATIM}?format=jsonv2&zoom=10&lat=${(+lat).toFixed(5)}&lon=${(+lon).toFixed(5)}`;
// Nominatim's jsonv2 answer -> [municipality, region, country_code] ('' for what it lacks), or
// null when it found nothing there (the sea).
export function parseNominatim(j) {
  if (!j || j.error || !j.address) return null;
  const a = j.address;
  const muni = a.city || a.town || a.village || a.municipality || a.hamlet || a.suburb || a.county || j.name || '';
  const region = a.state || a.region || a.province || a.county || a.state_district || '';
  return [String(muni), String(region === muni ? (a.state_district || region) : region), String(a.country_code || '').toLowerCase()];
}
// Keys of clusters that have no place yet.
export const pendingCells = (clusters, cells = {}) => clusters.filter(c => !cells[c.key]).map(c => c.key);

let _names = null;
export function countryName(cc) {
  if (!cc) return 'Unknown';
  try { _names = _names || new Intl.DisplayNames(['en'], { type: 'region' }); return _names.of(cc.toUpperCase()) || cc.toUpperCase(); }
  catch { return cc.toUpperCase(); }
}
// clusters + cells -> {countries, regions, municipalities: [{key, name, cc, count, first, last, ids}], unresolved}
// sorted by count. A region is keyed with its country, a municipality with both.
export function placeSummary(clusters, cells = {}) {
  const lv = [new Map(), new Map(), new Map()];
  let unresolved = 0;
  for (const c of clusters) {
    const p = cells[c.key];
    if (!p) { unresolved += c.ids.length; continue; }
    const [muni, region, cc] = p;
    const keys = [[cc, countryName(cc)], [cc + '/' + region, region || '—'], [cc + '/' + region + '/' + muni, muni || '—']];
    keys.forEach(([k, name], i) => {
      let r = lv[i].get(k);
      if (!r) lv[i].set(k, r = { key: k, name, cc, region, count: 0, first: c.first, last: c.last, cells: [] });
      r.count += c.ids.length; r.cells.push(c.key);
      if (c.first < r.first) r.first = c.first;
      if (c.last > r.last) r.last = c.last;
    });
  }
  const out = m => [...m.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { countries: out(lv[0]), regions: out(lv[1]), municipalities: out(lv[2]), unresolved };
}

// ---------------------------------------------------------------------------
// Privacy zones. Every share and export runs its points through applyPrivacy.
// ---------------------------------------------------------------------------
export const DEFAULT_TRIM_M = 200;
export function privacyOf(st) {
  const p = (st && st.profile && st.profile.privacy) || {};
  const zones = (Array.isArray(p.zones) ? p.zones : []).filter(z => z && Number.isFinite(+z.lat) && Number.isFinite(+z.lon) && +z.radius_m > 0)
    .map(z => ({ lat: +z.lat, lon: +z.lon, radius_m: +z.radius_m }));
  return { zones, trim_m: +p.trim_m > 0 ? +p.trim_m : 0 };
}
export function haversineM(a0, o0, a1, o1) {
  const R = 6371008.8, r = Math.PI / 180, dLa = (a1 - a0) * r, dLo = (o1 - o0) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a0 * r) * Math.cos(a1 * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
export const inZone = (p, zones) => zones.some(z => haversineM(p[0], p[1], z.lat, z.lon) <= z.radius_m);

// points: [[lat, lon, ...], ...] -> the visible stretches, [[point, ...], ...]. Points inside a
// zone are dropped and the line is broken there (no straight line drawn across the zone); with
// trim_m the first and last trim_m metres go too.
export function privateSegments(points, { zones = [], trim_m = 0 } = {}) {
  const pts = (points || []).filter(okPt);
  if (!pts.length) return [];
  let keepFrom = 0, keepTo = pts.length - 1;
  if (trim_m > 0) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversineM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
    const total = cum[cum.length - 1];
    if (total <= 2 * trim_m) return [];
    while (keepFrom < pts.length && cum[keepFrom] < trim_m) keepFrom++;
    while (keepTo >= 0 && total - cum[keepTo] < trim_m) keepTo--;
  }
  const out = [];
  let cur = [];
  for (let i = keepFrom; i <= keepTo; i++) {
    if (zones.length && inZone(pts[i], zones)) { if (cur.length) out.push(cur); cur = []; continue; }
    cur.push(pts[i]);
  }
  if (cur.length) out.push(cur);
  return out.filter(s => s.length >= 2);
}
// The same, flattened: the points that may be shown.
export const applyPrivacyWith = (points, opts) => privateSegments(points, opts).flat();

// ---------------------------------------------------------------------------
// Drawing geometry shared by the share card, the posters and the track wall.
// ---------------------------------------------------------------------------
// segments of [lat, lon] -> the same in pixels, fitted into w x h with `pad`, north up,
// longitude shrunk by cos(latitude) so a square block looks square.
export function fitSegments(segs, w, h, pad = 0) {
  const all = segs.flat();
  if (!all.length) return [];
  let la0 = Infinity, la1 = -Infinity, lo0 = Infinity, lo1 = -Infinity;
  for (const [la, lo] of all) { if (la < la0) la0 = la; if (la > la1) la1 = la; if (lo < lo0) lo0 = lo; if (lo > lo1) lo1 = lo; }
  const k = Math.cos(((la0 + la1) / 2) * Math.PI / 180);
  const sw = Math.max((lo1 - lo0) * k, 1e-9), sh = Math.max(la1 - la0, 1e-9);
  const s = Math.min((w - 2 * pad) / sw, (h - 2 * pad) / sh);
  const ox = (w - sw * s) / 2, oy = (h - sh * s) / 2;
  return segs.map(seg => seg.map(([la, lo]) => [ox + (lo - lo0) * k * s, oy + (la1 - la) * s]));
}
// Pixel segments -> an SVG path's d.
export const pathD = pix => pix.map(seg => seg.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1)).join('')).join('');
// A track thinned to at most n points (the wall draws thousands).
export function thin(pts, n) {
  if (!pts || pts.length <= n) return pts || [];
  const step = (pts.length - 1) / (n - 1), out = [];
  for (let i = 0; i < n; i++) out.push(pts[Math.round(i * step)]);
  return out;
}

// The stats a share card can show, in the order they print. `pick` is a set of keys.
export const CARD_STATS = [['distance', 'Distance'], ['time', 'Time'], ['pace', 'Pace'], ['hr', 'Avg HR'], ['climb', 'Climb']];
export function cardStats(a, pick = new Set(CARD_STATS.map(s => s[0]))) {
  if (!a) return [];
  const ride = isRideType(a.type), out = [];
  const t = a.moving_s || a.elapsed_s;
  if (pick.has('distance') && a.distance_m) out.push(['Distance', (a.distance_m / KM).toFixed(2) + ' km']);
  if (pick.has('time') && t) out.push(['Time', fmtTime(t)]);
  if (pick.has('pace') && t && a.distance_m) out.push(ride ? ['Speed', (a.distance_m / KM / (t / 3600)).toFixed(1) + ' km/h'] : ['Pace', fmtPace(t, a.distance_m)]);
  if (pick.has('hr') && a.avg_hr) out.push(['Avg HR', Math.round(a.avg_hr) + ' bpm']);
  if (pick.has('climb') && a.elev_gain_m) out.push(['Climb', Math.round(a.elev_gain_m) + ' m']);
  return out;
}

// ---------------------------------------------------------------------------
// Year in review. Inputs are plain data (the page builds them from the state), so this
// stays testable without the derive memos.
//   runs:    [{id, name, start, distance_m, moving_s, elev_gain_m}]
//   prRows:  [[distance, seconds, day, id]]   (derive.prRows)
//   routes:  repeats.summarise output (for the year), or []
//   tiles:   {17: Map key -> [firstDay, ...], 14: same}  (explore index), or null
//   cities:  state.cities
// ---------------------------------------------------------------------------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const inYear = (d, y) => String(d).slice(0, 4) === String(y);
function totalsOf(rs) {
  let distance_m = 0, seconds = 0, ascent_m = 0;
  for (const a of rs) { distance_m += a.distance_m || 0; seconds += a.moving_s || 0; ascent_m += a.elev_gain_m || 0; }
  return { runs: rs.length, distance_m, seconds, ascent_m, days: new Set(rs.map(dayOf)).size };
}
export function reviewYears(runs) {
  return [...new Set(runs.map(a => +dayOf(a).slice(0, 4)).filter(Boolean))].sort((a, b) => b - a);
}
export function yearReview({ runs = [], prRows = [], routes = [], tiles = null, cities = {} } = {}, year) {
  const mine = runs.filter(a => inYear(dayOf(a), year));
  if (!mine.length) return null;
  const totals = totalsOf(mine), prev = totalsOf(runs.filter(a => inYear(dayOf(a), year - 1)));
  const change = prev.distance_m ? totals.distance_m / prev.distance_m - 1 : null;
  // weeks
  const weeks = new Map();
  for (const a of mine) { const w = weekStart(dayOf(a)); const r = weeks.get(w) || { week: w, distance_m: 0, runs: 0 }; r.distance_m += a.distance_m || 0; r.runs++; weeks.set(w, r); }
  const topWeeks = [...weeks.values()].sort((a, b) => b.distance_m - a.distance_m).slice(0, 3);
  const ws = [...weeks.keys()].sort();
  let longestStreak = ws.length ? 1 : 0, run = 1;
  for (let i = 1; i < ws.length; i++) { run = daysBetween(ws[i - 1], ws[i]) === 7 ? run + 1 : 1; longestStreak = Math.max(longestStreak, run); }
  // months
  const months = new Array(12).fill(0);
  for (const a of mine) months[+dayOf(a).slice(5, 7) - 1] += a.distance_m || 0;
  const bm = months.indexOf(Math.max(...months));
  const longest = mine.reduce((b, a) => ((a.distance_m || 0) > (b?.distance_m || 0) ? a : b), null);
  // best efforts: the year's best at each distance, and whether it beat everything before the year
  const yearBest = new Map(), before = new Map();
  for (const [dist, secs, d, id] of prRows) {
    if (!secs) continue;
    if (inYear(d, year)) { const b = yearBest.get(dist); if (!b || secs < b.secs) yearBest.set(dist, { dist, secs, day: d, id }); }
    else if (String(d) < year + '-01-01') { const b = before.get(dist); if (b == null || secs < b) before.set(dist, secs); }
  }
  const bests = [...yearBest.values()].sort((a, b) => a.dist - b.dist)
    .map(b => ({ ...b, previous: before.get(b.dist) ?? null, pr: !before.has(b.dist) || b.secs < before.get(b.dist) }));
  // the most-run route, counting only this year's runs on it
  let route = null;
  for (const r of routes || []) {
    const n = (r.runs || []).filter(m => inYear(dayOf(m), year)).length;
    if (n >= 2 && (!route || n > route.count)) route = { name: r.name, count: n, distance_m: r.distance_m, id: r.runs.find(m => inYear(dayOf(m), year))?.id };
  }
  // new ground
  let newTiles = null;
  if (tiles) {
    const count = m => { let n = 0; for (const v of (m || new Map()).values()) if (inYear(v[0], year)) n++; return n; };
    newTiles = { z17: count(tiles[17]), z14: count(tiles[14]) };
  }
  let streetNodes = 0, trailNodes = 0, streetsDone = 0, haveCities = false;
  for (const c of Object.values(cities || {})) {
    if (!c) continue; haveCities = true;
    for (const g of c.gains || []) if (inYear(g[0], year)) { streetNodes += g[1] || 0; trailNodes += g[2] || 0; }
    for (const [k, d] of Object.entries(c.done || {})) if (k[0] === 's' && d && inYear(d, year)) streetsDone++;
  }
  return {
    year, totals, previous: prev, change,
    topWeeks, longest, bests, route, newTiles,
    streets: haveCities ? { new_km: (streetNodes * 25) / KM, trail_km: (trailNodes * 25) / KM, finished: streetsDone } : null,
    busiestMonth: months[bm] > 0 ? { month: bm + 1, name: MONTHS[bm], distance_m: months[bm] } : null,
    months, weeksRun: weeks.size, longestWeekStreak: longestStreak,
  };
}

// ---------------------------------------------------------------------------
// Posters: SVG strings, standalone (their own colours: a poster is printed, not themed).
// ---------------------------------------------------------------------------
export const POSTER = { bg: '#0d1117', ink: '#e8ecf2', faint: '#6f7a8a', line: '#3fb8c4',
  ramp: ['#161b24', '#12414a', '#0b6e79', '#2a9aa6', '#3fb8c4', '#bfeef2'] };
const x = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const svgOpen = (w, h, title) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="Helvetica, Arial, sans-serif"><title>${x(title)}</title><rect width="${w}" height="${h}" fill="${POSTER.bg}"/>`;
const wordmark = (w, h) => `<text x="${w - 40}" y="${h - 32}" text-anchor="end" font-size="20" font-weight="800" fill="${POSTER.ink}" letter-spacing="1">RUN315</text>`;

// tracks: [{segs: [[[lat, lon], ...], ...]}] (privacy already applied). Small multiples, each
// normalised into its own cell.
export function routeGridSvg(tracks, { title = 'Every route', sub = '', cols = null, cell = 60 } = {}) {
  const list = tracks.filter(t => t.segs && t.segs.length);
  const n = list.length, c = cols || Math.max(1, Math.ceil(Math.sqrt(n * 0.75)));
  const rows = Math.max(1, Math.ceil(n / c)), m = 40, head = 110;
  const W = c * cell + 2 * m, H = rows * cell + head + 80;
  const paths = list.map((t, i) => {
    const pix = fitSegments(t.segs, cell, cell, cell * 0.1);
    return `<path transform="translate(${m + (i % c) * cell} ${head + Math.floor(i / c) * cell})" d="${pathD(pix)}"/>`;
  });
  return svgOpen(W, H, title) + `<text x="${m}" y="60" font-size="34" font-weight="800" fill="${POSTER.ink}">${x(title)}</text>`
    + `<text x="${m}" y="88" font-size="15" fill="${POSTER.faint}">${x(sub || n + ' routes')}</text>`
    + `<g fill="none" stroke="${POSTER.line}" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round">${paths.join('')}</g>` + wordmark(W, H) + '</svg>';
}
// Level 0..5 of a day's distance against the busiest days (quantiles of the non-zero days).
export function levels(values) {
  const v = values.filter(d => d > 0).sort((a, b) => a - b);
  const q = f => v[Math.floor(f * (v.length - 1))];
  const cuts = v.length ? [q(0.2), q(0.45), q(0.7), q(0.9)] : [];
  return d => (!(d > 0) ? 0 : 1 + cuts.filter(c => d > c).length);
}
// days: Map 'YYYY-MM-DD' -> metres. One ring per year (oldest innermost), a tick per day
// whose length is the day's distance.
export function yearRingsSvg(days, years, { title = 'Year rings' } = {}) {
  const ys = [...years].sort((a, b) => a - b), S = 900, cx = S / 2, cy = S / 2 + 30;
  const r0 = 70, band = Math.max(12, Math.min(48, (S / 2 - 60 - r0) / Math.max(1, ys.length)));
  const top = Math.max(1, ...days.values());
  let ticks = '', labels = '';
  ys.forEach((y, i) => {
    const r = r0 + i * band, len = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 366 : 365;
    ticks += `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="${POSTER.ramp[0]}" stroke-width="1"/>`;
    for (let d = 0; d < len; d++) {
      const k = addDayKey(y + '-01-01', d), v = days.get(k);
      if (!v) continue;
      const a = (d / len) * 2 * Math.PI - Math.PI / 2, l = Math.max(1.5, (band - 3) * Math.sqrt(v / top));
      const c = Math.cos(a), s = Math.sin(a);
      ticks += `<line x1="${(cx + r * c).toFixed(1)}" y1="${(cy + r * s).toFixed(1)}" x2="${(cx + (r + l) * c).toFixed(1)}" y2="${(cy + (r + l) * s).toFixed(1)}"/>`;
    }
    labels += `<text x="${cx + 4}" y="${(cy - r - 2).toFixed(1)}" font-size="10" fill="${POSTER.faint}">${y}</text>`;
  });
  return svgOpen(S, S + 60, title) + `<text x="40" y="56" font-size="30" font-weight="800" fill="${POSTER.ink}">${x(title)}</text>`
    + `<g stroke="${POSTER.line}" stroke-width="1.4" stroke-linecap="round">${ticks}</g>${labels}` + wordmark(S, S + 60) + '</svg>';
}
// A GitHub-style calendar per year, every year stacked, newest on top.
export function contributionSvg(days, years, { title = 'Every day you ran' } = {}) {
  const ys = [...years].sort((a, b) => b - a), c = 13, g = 2, m = 60, head = 100, block = 7 * (c + g) + 34;
  const W = m + 54 * (c + g) + 40, H = head + ys.length * block + 60;
  const lvl = levels([...days.values()]);
  let out = '';
  ys.forEach((y, i) => {
    const y0 = head + i * block, jan1 = y + '-01-01', dow0 = (new Date(y, 0, 1).getDay() + 6) % 7;
    let km = 0;
    out += `<text x="${m - 10}" y="${y0 + 3 * (c + g) + 10}" text-anchor="end" font-size="13" fill="${POSTER.ink}">${y}</text>`;
    for (let d = 0; d < 366; d++) {
      const k = addDayKey(jan1, d);
      if (!k.startsWith(String(y))) break;
      const v = days.get(k) || 0; km += v / KM;
      const col = Math.floor((d + dow0) / 7), row = (d + dow0) % 7;
      out += `<rect x="${m + col * (c + g)}" y="${y0 + row * (c + g)}" width="${c}" height="${c}" rx="2" fill="${POSTER.ramp[lvl(v)]}"/>`;
    }
    out += `<text x="${m}" y="${y0 + 7 * (c + g) + 14}" font-size="11" fill="${POSTER.faint}">${Math.round(km).toLocaleString('en-US')} km</text>`;
  });
  return svgOpen(W, H, title) + `<text x="${m}" y="56" font-size="30" font-weight="800" fill="${POSTER.ink}">${x(title)}</text>` + out + wordmark(W, H) + '</svg>';
}

// ---------------------------------------------------------------------------
// Air quality (Open-Meteo, CAMS). Coverage, probed November 2026:
//   * Europe (CAMS European, ~0.1°, roughly 30–71°N, 25°W–45°E): from 2013-01-01.
//   * Elsewhere (CAMS global, ~0.4°): from about 2022-08-04; us_aqi (a 24 h average of PM)
//     from a day later. Anything earlier comes back all null.
//   * Pollen (grass, birch, alder, mugwort, olive, ragweed): Europe only, seasonal, and
//     only from about December 2020.
// ---------------------------------------------------------------------------
export const AQ_API = 'https://air-quality-api.open-meteo.com/v1/air-quality';
export const AQ_VARS = ['pm2_5', 'pm10', 'us_aqi', 'ozone'];
export const POLLEN_VARS = ['alder_pollen', 'birch_pollen', 'grass_pollen', 'mugwort_pollen', 'olive_pollen', 'ragweed_pollen'];
export const AQ_EUROPE_FROM = '2013-01-01', AQ_GLOBAL_FROM = '2022-08-05';
export const inEurope = (lat, lon) => lat >= 30 && lat <= 71 && lon >= -25 && lon <= 45;
// -> {ok, from, why}
export function airCoverage(lat, lon, day, today = dayKey(new Date())) {
  const eu = inEurope(lat, lon), from = eu ? AQ_EUROPE_FROM : AQ_GLOBAL_FROM;
  if (day > addDayKey(today, 4)) return { ok: false, from, why: 'in the future' };
  if (day < from) return { ok: false, from, why: eu ? 'before 2013 (the European record starts then)' : 'before August 2022 (the global record starts then)' };
  return { ok: true, from, why: '' };
}
export const airUrl = (lat, lon, day, pollen = inEurope(lat, lon)) =>
  `${AQ_API}?latitude=${(+lat).toFixed(3)}&longitude=${(+lon).toFixed(3)}&start_date=${day}&end_date=${day}&timezone=auto`
  + `&hourly=${[...AQ_VARS, ...(pollen ? POLLEN_VARS : [])].join(',')}`;
// The answer + the run's local start ('YYYY-MM-DDTHH:MM...') -> the start hour's values, or
// null when the archive has nothing then. `timezone=auto` makes the hours local, like `start`.
export function parseAir(j, start) {
  const h = j && j.hourly;
  if (!h || !Array.isArray(h.time)) return null;
  const want = String(start).slice(0, 13) + ':00';
  const i = h.time.indexOf(want);
  if (i < 0) return null;
  const out = {};
  for (const k of AQ_VARS) out[k] = h[k] && h[k][i] != null ? +h[k][i] : null;
  const pollen = {};
  for (const k of POLLEN_VARS) if (h[k] && h[k][i] != null) pollen[k.replace('_pollen', '')] = +h[k][i];
  if (Object.keys(pollen).length) out.pollen = pollen;
  if (AQ_VARS.every(k => out[k] == null) && !out.pollen) return null;
  out.hour = h.time[i];
  return out;
}
export const AQI_BANDS = [[50, 'Good'], [100, 'Moderate'], [150, 'Unhealthy for sensitive groups'], [200, 'Unhealthy'], [300, 'Very unhealthy'], [Infinity, 'Hazardous']];
export const aqiBand = v => (v == null ? null : AQI_BANDS.find(([hi]) => v <= hi)[1]);

export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
const median = xs => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
// rows: [{aqi, pace (heat- and hill-corrected s/km), hr}] -> {n, r_pace, r_hr, bands: [{band, n, pace, hr}]}
// Positive r_pace: dirtier air, slower corrected pace.
export function airCorrelation(rows) {
  const ok = rows.filter(r => r && r.aqi != null && r.pace > 0 && r.hr > 0);
  const bands = [[0, 50, 'Good (0–50)'], [51, 100, 'Moderate (51–100)'], [101, Infinity, 'Worse (101+)']].map(([lo, hi, band]) => {
    const m = ok.filter(r => r.aqi >= lo && r.aqi <= hi);
    return { band, n: m.length, pace: median(m.map(r => r.pace)), hr: median(m.map(r => r.hr)) };
  });
  return { n: ok.length, r_pace: pearson(ok.map(r => r.aqi), ok.map(r => r.pace)), r_hr: pearson(ok.map(r => r.aqi), ok.map(r => r.hr)), bands };
}
