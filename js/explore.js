// Exploration on top of the territory tiles: two grids, new ground per activity, tiles the
// athlete has ruled out, and how to colour what is claimed.
//
// Everything here reads what is already synced -- state.derived[id].tiles (zoom-17 [x, y]),
// state.cities gains, state.profile.unreachable -- so nothing needs re-deriving:
//   z17   ~300 m tiles ("squadratinhos"), the derived grid.
//   z14   ~2.4 km at the equator, ~1.7 km here ("squadrats", StatsHunters/VeloViewer's
//         grid). A z14 tile is exactly 8 x 8 z17 tiles, so it is [x >> 3, y >> 3] of them.
//
// Sparse throughout: Maps and Sets of "x,y" keys, never a bounding-box grid -- a single
// stray activity on another continent must not cost anything (see nearMissSquares).
// The heavy pass (every activity in date order) is memoised on the store revision.
import * as TR from './lib/territory.js';
import { NODE_STEP_M } from './lib/trails.js';
import { isVirtual } from './derive.js';
import { rev, state } from './store.js';
import { html, raw } from './ui.js';
import { addDayKey, weekStart } from './lib/dt.js';

export const ZOOMS = [17, 14];
export const ZOOM_NAMES = { 17: 'Squadratinhos', 14: 'Squadrats' };
const SHIFT = 17 - 14;
const fromKey = k => k.split(',').map(Number);

// A z17 tile -> the z14 tile containing it (as a key).
export const z14Key = (x, y) => TR.tileKey(x >> SHIFT, y >> SHIFT);

// ---------------------------------------------------------------------------
// The index: every outdoor activity, oldest first
// ---------------------------------------------------------------------------

// acts: [{id, day: 'YYYY-MM-DD', tiles: [[x, y], ...] (z17)}], any order.
// -> { tiles: {17: Map key -> [firstDay, lastDay, visits], 14: same},
//      per: Map id -> {day, new17: [keys], new14: [keys], n17, n14} (n = tiles touched),
//      order: [ids oldest first] }
// "New" means no earlier activity (by day, then id) touched the tile. Visits count activities,
// so a z14 tile crossed by one run counts once however many z17 tiles of it the run touched.
export function buildIndex(acts) {
  const sorted = [...acts].filter(a => a && a.day && a.tiles && a.tiles.length)
    .sort((a, b) => a.day.localeCompare(b.day) || String(a.id).localeCompare(String(b.id)));
  const t17 = new Map(), t14 = new Map(), per = new Map();
  const touch = (m, k, day, fresh) => {
    const cur = m.get(k);
    if (!cur) { m.set(k, [day, day, 1]); fresh.push(k); return; }
    cur[1] = day; cur[2]++;
  };
  for (const a of sorted) {
    const s17 = new Set(), s14 = new Set();
    for (const t of a.tiles) { s17.add(TR.tileKey(t[0], t[1])); s14.add(z14Key(t[0], t[1])); }
    const new17 = [], new14 = [];
    for (const k of s17) touch(t17, k, a.day, new17);
    for (const k of s14) touch(t14, k, a.day, new14);
    per.set(a.id, { day: a.day, new17, new14, n17: s17.size, n14: s14.size });
  }
  return { tiles: { 17: t17, 14: t14 }, per, order: sorted.map(a => a.id) };
}

// Street (and trail) km first covered by one activity, from the cities' per-day node gains.
// The gains are per day, so the km are only attributable when the activity was the only
// outdoor one that day; otherwise null (two runs on one day share a number we cannot split).
// -> {newStreetKm, newTrailKm} (each null when unattributable or no area is loaded).
export function streetGain(cities, day, sameDay) {
  const recs = Object.values(cities || {}).filter(r => r && Array.isArray(r.gains));
  if (!recs.length || sameDay !== 1) return { newStreetKm: null, newTrailKm: null };
  let s = 0, t = 0;
  for (const r of recs) for (const g of r.gains) if (g[0] === day) { s += g[1] || 0; t += g[2] || 0; }
  return { newStreetKm: (s * NODE_STEP_M) / 1000, newTrailKm: (t * NODE_STEP_M) / 1000 };
}

// The state -> the activities the index reads (outdoor, with tiles).
export function groundActs(st) {
  const out = [];
  for (const a of Object.values(st.activities || {})) {
    const tiles = st.derived?.[a.id]?.tiles;
    if (!tiles || !tiles.length || isVirtual(a)) continue;
    out.push({ id: a.id, day: String(a.start || '').slice(0, 10), tiles });
  }
  return out;
}

// One-slot memo on the store revision. The derived count is in the key too: deriveActivity
// adds tiles without a save (derive.js keys its own memos on a private counter for this).
let _memo = null;
export function exploreIndex(st) {
  const key = rev + ':' + Object.keys(st.derived || {}).length;
  if (_memo && _memo.st === st && _memo.key === key) return _memo.value;
  const acts = groundActs(st), value = buildIndex(acts);
  value.perDay = new Map();
  for (const a of acts) value.perDay.set(a.day, (value.perDay.get(a.day) || 0) + 1);
  value.scores = new Map();           // memo of scoreboard() per zoom + toggle
  _memo = { st, key, value };
  return value;
}

// New ground for one activity. -> {newTiles17, newTiles14, newStreetKm, newTrailKm, tiles17, tiles14, first}
// or null (virtual, no track, unknown id).
export function newGroundFor(st, id) {
  const ix = exploreIndex(st), p = ix.per.get(id);
  if (!p) return null;
  return { newTiles17: p.new17.length, newTiles14: p.new14.length,
    ...streetGain(st.cities, p.day, ix.perDay.get(p.day) || 0),
    tiles17: p.n17, tiles14: p.n14, first: ix.order[0] === id };
}

// ---------------------------------------------------------------------------
// Unreachable tiles: state.profile.unreachable = {17: ['x,y', ...], 14: [...]}
// ---------------------------------------------------------------------------

export function unreachableSet(profile, zoom) {
  const l = profile && profile.unreachable && profile.unreachable[zoom];
  return new Set(Array.isArray(l) ? l : []);
}

// Toggle one tile. Pure: -> a new unreachable object, each list sorted and deduplicated so
// two devices marking the same tiles produce the same record.
export function toggleUnreachable(u, zoom, key) {
  const out = {};
  for (const z of ZOOMS) out[z] = [...new Set((u && Array.isArray(u[z])) ? u[z] : [])];
  const s = new Set(out[zoom] || []);
  if (s.has(key)) s.delete(key); else s.add(key);
  out[zoom] = [...s].sort((a, b) => { const [ax, ay] = fromKey(a), [bx, by] = fromKey(b); return (ax - bx) || (ay - by); });
  return out;
}

// ---------------------------------------------------------------------------
// The scoreboard for one grid
// ---------------------------------------------------------------------------

// claimed: Map key -> [first, last, visits]; unreachable: Set of keys.
// countUnreachable: unreachable tiles fill gaps in the square, the cluster and the targets
// (water and highways are not ground anyone can claim, so they should not block a square);
// off, they are left out and never offered as a target.
export function scoreboard(claimed, unreachable, zoom, countUnreachable = true, today = null) {
  const tiles = [...claimed.keys()].map(fromKey);
  const extra = countUnreachable ? [...unreachable].filter(k => !claimed.has(k)).map(fromKey) : [];
  const eff = extra.length ? tiles.concat(extra) : tiles;
  const s = TR.stats(eff, [], zoom);
  // Area and count are what you have run, not what you have ruled out.
  s.tiles = tiles.length;
  s.unreachable = [...unreachable].filter(k => !claimed.has(k)).length;
  s.area_km2 = tiles.length * (s.tile_metres / 1000) ** 2;
  s.targets = TR.squareGrowthTargets(eff, 24).filter(([t]) => !unreachable.has(TR.tileKey(t[0], t[1]))).slice(0, 12);
  if (today) {
    const wk = shiftDay(today, -7), mo = shiftDay(today, -30);
    let w = 0, m = 0;
    for (const v of claimed.values()) { if (v[0] >= wk) w++; if (v[0] >= mo) m++; }
    s.this_week = w; s.this_month = m;
  }
  let first = null, home = null, homeN = -1;
  for (const [k, v] of claimed) {
    if (!first || v[0] < first) first = v[0];
    if (v[2] > homeN) { homeN = v[2]; home = k; }
  }
  s.since = first;
  // Share of the 25 x 25 tiles around the most-visited one (where you start from).
  s.home = home ? fromKey(home) : null;
  s.coverage = home ? TR.areaCoverage(tiles, s.home) : null;
  return s;
}

// Memoised scoreboard over the index (per zoom and toggle; the index itself is per revision,
// and unreachable edits are saves, so they bump the revision).
export function scoresFor(st, zoom, countUnreachable = true, today = null) {
  const ix = exploreIndex(st), key = zoom + ':' + countUnreachable + ':' + today;
  if (!ix.scores.has(key)) ix.scores.set(key, scoreboard(ix.tiles[zoom], unreachableSet(st.profile, zoom), zoom, countUnreachable, today));
  return ix.scores.get(key);
}

const shiftDay = addDayKey;

// ---------------------------------------------------------------------------
// New ground over time
// ---------------------------------------------------------------------------

// Monday of a day key.
export const weekOf = weekStart;

// -> [[periodStartDay, newTiles], ...] for one zoom, every period from the first to `today`
// (zeros included: a month with no new ground is the point of the chart).
// period 'week' | 'month'; `limit` keeps the last N periods.
export function newGroundSeries(index, zoom, period = 'month', today = null, limit = null) {
  const counts = new Map(), bucket = period === 'week' ? weekOf : d => d.slice(0, 7) + '-01';
  for (const id of index.order) {
    const p = index.per.get(id), n = zoom === 14 ? p.new14.length : p.new17.length;
    if (n) counts.set(bucket(p.day), (counts.get(bucket(p.day)) || 0) + n);
  }
  if (!counts.size) return [];
  const keys = [...counts.keys()].sort(), end = bucket(today || keys[keys.length - 1]);
  const out = [];
  for (let k = keys[0]; k <= end && out.length < 5000; k = nextPeriod(k, period)) out.push([k, counts.get(k) || 0]);
  return limit ? out.slice(-limit) : out;
}
function nextPeriod(k, period) {
  if (period === 'week') return shiftDay(k, 7);
  const [y, m] = k.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

// ---------------------------------------------------------------------------
// Colouring the claimed tiles
// ---------------------------------------------------------------------------

export const COLOUR_MODES = { plain: 'Claimed', year: 'First-visit year', visits: 'Visit count', stale: 'Stale' };
const VISIT_STEPS = [1, 2, 4, 10, 25];           // 1, 2-3, 4-9, 10-24, 25+
const ALPHA = [0.18, 0.32, 0.48, 0.64, 0.82];    // a light-to-strong ramp of one hue

// The palette for a mode: [{label, tone: 'measured'|'behind', alpha}], in legend order.
// opts: {years: [minYear, maxYear], staleMonths}
export function legend(mode, opts = {}) {
  if (mode === 'visits') return VISIT_STEPS.map((v, i) => ({
    label: i === VISIT_STEPS.length - 1 ? v + '+' : (VISIT_STEPS[i + 1] - 1 === v ? String(v) : v + '–' + (VISIT_STEPS[i + 1] - 1)),
    tone: 'measured', alpha: ALPHA[i] }));
  if (mode === 'year') {
    const [lo, hi] = opts.years || [null, null];
    if (lo == null) return [];
    const n = hi - lo + 1, out = [];
    for (let y = lo; y <= hi; y++) out.push({ label: String(y), tone: 'measured', alpha: yearAlpha(y - lo, n) });
    return out;
  }
  if (mode === 'stale') return [
    { label: 'Visited in the last ' + (opts.staleMonths || 12) + ' months', tone: 'measured', alpha: 0.45 },
    { label: 'Not since', tone: 'behind', alpha: 0.55 }];
  return [{ label: 'Claimed', tone: 'measured', alpha: 0.45 }];
}
// Oldest faint, newest strong, over however many years there are.
const yearAlpha = (i, n) => (n <= 1 ? 0.6 : 0.15 + (0.7 * i) / (n - 1));

// The legend entry index for one tile's [first, last, visits]. opts as legend() plus `cutoff`
// (the stale day key: last visit before it is stale).
export function styleIndex(info, mode, opts = {}) {
  if (mode === 'visits') { let i = 0; while (i + 1 < VISIT_STEPS.length && info[2] >= VISIT_STEPS[i + 1]) i++; return i; }
  if (mode === 'year') return opts.years ? +info[0].slice(0, 4) - opts.years[0] : 0;
  if (mode === 'stale') return info[1] < (opts.cutoff || '') ? 1 : 0;
  return 0;
}

// [minYear, maxYear] of first visits, for the year legend.
export function yearRange(claimed) {
  let lo = null, hi = null;
  for (const v of claimed.values()) { const y = +v[0].slice(0, 4); if (lo == null || y < lo) lo = y; if (hi == null || y > hi) hi = y; }
  return [lo, hi];
}

// The stale cutoff: today minus N months, as a day key.
export function staleCutoff(today, months) {
  const [y, m, d] = today.split('-').map(Number), total = y * 12 + (m - 1) - months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-${String(Math.min(d, 28)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Map drawing helpers (pure geometry; the page's canvas layer uses them)
// ---------------------------------------------------------------------------

// Bucket keys by a coarse grid (`shift` levels up) so a low-zoom view never walks every tile.
export function bucketize(keys, shift = 6) {
  const b = new Map();
  for (const k of keys) {
    const [x, y] = fromKey(k), bk = (x >> shift) + ',' + (y >> shift);
    let l = b.get(bk);
    if (!l) b.set(bk, l = []);
    l.push(x, y);
  }
  return b;
}

// The tiles of grid zoom `z` inside slippy map tile (tx, ty) at zoom Z, as [x, y, px, py, size]
// in that map tile's 256-px space. `has(key)` tests membership; `buckets` (bucketize at 6)
// serves views where the map tile spans more than 64 x 64 grid tiles.
export function tilesInMapTile(tx, ty, Z, z, has, buckets, shift = 6) {
  const out = [], d = z - Z;
  if (d <= 0) {
    const f = 2 ** -d, x = Math.floor(tx / f), y = Math.floor(ty / f);
    if (has(TR.tileKey(x, y))) out.push([x, y, (x * f - tx) * 256, (y * f - ty) * 256, 256 * f]);
    return out;
  }
  const span = 2 ** d, size = 256 / span, x0 = tx * span, y0 = ty * span;
  if (d <= shift) {
    for (let dx = 0; dx < span; dx++) for (let dy = 0; dy < span; dy++) {
      if (has(TR.tileKey(x0 + dx, y0 + dy))) out.push([x0 + dx, y0 + dy, dx * size, dy * size, size]);
    }
    return out;
  }
  const bspan = 2 ** (d - shift), bx0 = tx * bspan, by0 = ty * bspan;
  const visit = l => { for (let i = 0; i < l.length; i += 2) out.push([l[i], l[i + 1], (l[i] - x0) * size, (l[i + 1] - y0) * size, size]); };
  if (bspan * bspan <= buckets.size) {
    for (let dx = 0; dx < bspan; dx++) for (let dy = 0; dy < bspan; dy++) { const l = buckets.get((bx0 + dx) + ',' + (by0 + dy)); if (l) visit(l); }
  } else {
    for (const [bk, l] of buckets) {
      const [bx, by] = fromKey(bk);
      if (bx >= bx0 && bx < bx0 + bspan && by >= by0 && by < by0 + bspan) visit(l);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The activity page's panel
// ---------------------------------------------------------------------------

// A small SVG of the activity's z17 tiles, new ones solid, ground already owned faint.
// Inline styles use the theme tokens, so it follows light/dark without page CSS.
export function miniMapSvg(tiles, fresh, maxTiles = 1500) {
  if (!tiles || !tiles.length || tiles.length > maxTiles) return '';
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of tiles) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  if (w > 400 || h > 400) return '';         // a GPS jump across a country: not a useful picture
  const rects = tiles.map(([x, y]) => `<rect x="${x - x0}" y="${y - y0}" width="1" height="1" fill="var(--measured)" fill-opacity="${fresh.has(TR.tileKey(x, y)) ? 0.9 : 0.22}"/>`);
  return `<svg viewBox="-0.5 -0.5 ${w + 1} ${h + 1}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Tiles this activity touched; new ones solid" style="width:100%;max-width:240px;height:auto;max-height:200px;display:block">${rects.join('')}</svg>`;
}

// The "new ground" section for #/activity/<id>. '' when the activity claims no ground
// (virtual, no track, not derived yet), so the caller can drop it in unconditionally.
export function newGroundPanel(id, st = state) {
  const g = newGroundFor(st, id);
  if (!g) return '';
  const p = exploreIndex(st).per.get(id), fresh = new Set(p.new17);
  const svg = miniMapSvg(st.derived?.[id]?.tiles, fresh);
  const km = v => (v >= 10 ? v.toFixed(0) : v.toFixed(1));
  const streets = g.newStreetKm != null && (g.newStreetKm > 0 || g.newTrailKm > 0)
    ? html` · +${km(g.newStreetKm)} km of new streets${g.newTrailKm > 0 ? html`, +${km(g.newTrailKm)} km of trails` : ''}` : '';
  const note = g.first ? 'Your first recorded ground: every tile is new.'
    : g.newTiles17 ? `${Math.round((100 * g.newTiles17) / Math.max(1, g.tiles17))}% of the ${g.tiles17} tiles it touched were new.`
    : `All ${g.tiles17} tiles it touched were already yours.`;
  return html`<section class="panel" data-hook="new-ground">
    <div class="panel-head"><p class="eyebrow">New ground</p><p class="panel-note"><a class="quiet-link" href="#/territory">Territory</a></p></div>
    <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center">
      <div style="flex:1 1 200px">
        <div class="stat-value">+${g.newTiles17}<small class="unit"> tiles</small></div>
        <div class="stat-label">New squadratinhos (z17) · +${g.newTiles14} squadrats (z14)${streets}</div>
        <p class="dim" style="margin:8px 0 0">${note}${g.newStreetKm == null && Object.keys(st.cities || {}).length ? ' Street km are per day, so they are not split between two outings on one day.' : ''}</p>
      </div>
      ${svg ? html`<div style="flex:0 1 240px">${raw(svg)}</div>` : ''}
    </div>
  </section>`;
}
