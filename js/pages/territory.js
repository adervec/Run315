// intvl -- the territory game. Every run claims the map tiles it passes through; ground
// never covered stays fogged. The scores are the ones that make you plan routes
// differently: the biggest solid square, the biggest connected cluster, and the tiles
// that would grow the square. Tiles come from state.derived[id].tiles, so the phone has
// the whole map without a single stream.
//
// Two grids, as StatsHunters/VeloViewer/Squadrats play it: z17 (~300 m, "squadratinhos",
// the derived grid) and z14 (8 x 8 of those, "squadrats"), each with its own scores. The
// athlete can rule tiles out (water, the 407, rail lands) by clicking them in mark mode;
// those sync in state.profile.unreachable and, by default, count as claimed for the square.
// The logic is js/explore.js; this page draws it.
//
// The map draws claimed tiles on one canvas layer (an L.GridLayer, one canvas per 256-px
// map tile, only the tiles in view), so 3,000 or 50,000 tiles cost the same per frame.
import { state, save } from '../store.js';
import * as E from '../explore.js';
import { tileBounds, tileFor, tileKey } from '../lib/territory.js';
import { dayKey } from '../lib/dt.js';
import { renderChart } from '../charts.js';
import { html, raw, pageHead, emptyState, day, useCss, toast } from '../ui.js';
import { loadLeaflet, whenGone, token } from '../routemaker.js';

export const title = 'Territory';

const CSS = `
/* The fog map is the page, so it gets real height. */
.terr { --target: #e8a33d; }
.terr #tilemap { height: 62vh; min-height: 420px; border-radius: 3px; background: var(--ground); }
.terr #tilemap.marking { cursor: crosshair; }
.terr .leaflet-container { font-family: var(--body); }
.terr .leaflet-container.marking { cursor: crosshair; }
.terr .score-row {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0 28px;
}
.terr .score-row .stat { border-top: none; padding-top: 0; }
.terr .toolbar { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; margin: 0 0 16px; }
.terr .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 3px; overflow: hidden; }
.terr .seg button {
  font: inherit; font-size: 13px; padding: 6px 12px; background: none; border: 0; color: var(--muted); cursor: pointer;
}
.terr .seg button + button { border-left: 1px solid var(--line); }
.terr .seg button[aria-pressed="true"] { background: var(--measured); color: var(--surface); }
.terr .toolbar label { font-size: 13px; color: var(--muted); display: inline-flex; gap: 6px; align-items: center; }
.terr .legend {
  display: flex; gap: 8px 20px; flex-wrap: wrap; margin-top: 12px;
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--muted);
}
.terr .legend i {
  display: inline-block; width: 12px; height: 12px; margin-right: 6px;
  vertical-align: -2px; border-radius: 2px;
}
.terr .lg-square { background: color-mix(in srgb, var(--projected) 30%, transparent); border: 1px solid var(--projected); }
.terr .lg-target { background: var(--target); opacity: .75; }
.terr .lg-fog { background: var(--ground); border: 1px solid var(--line); }
.terr .lg-unreach {
  background: repeating-linear-gradient(45deg, var(--faint) 0 2px, transparent 2px 5px);
  border: 1px solid var(--faint);
}
.terr .target-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.terr .target-chip {
  font-family: var(--mono); font-size: 12px;
  border: 1px solid var(--line); border-radius: 2px; padding: 5px 9px;
  background: none; cursor: pointer; color: var(--ink);
}
.terr .target-chip:hover { border-color: var(--projected); color: var(--projected); }
@media (max-width: 600px) { .terr #tilemap { height: 52vh; min-height: 320px; } }
`;

// This device's view choices (not synced: a phone and a desktop may want different views).
const DEFAULTS = { zoom: 17, colour: 'plain', stale: 12, countU: true, period: 'month', marking: false };
function ui() {
  const l = state.local || (state.local = {});
  l.ui = l.ui || {};
  l.ui.territory = { ...DEFAULTS, ...(l.ui.territory || {}) };
  return l.ui.territory;
}
const persistUi = () => save('ui');

const today = () => dayKey(new Date());

// Everything the sections draw, for the current grid and toggles.
function view() {
  const u = ui(), ix = E.exploreIndex(state), z = u.zoom;
  const claimed = ix.tiles[z], unreach = E.unreachableSet(state.profile, z);
  const s = E.scoresFor(state, z, u.countU, today());
  const opts = { years: E.yearRange(claimed), staleMonths: u.stale, cutoff: E.staleCutoff(today(), u.stale) };
  return { u, ix, z, claimed, unreach, s, opts, legend: E.legend(u.colour, opts) };
}

// ---- sections (each re-rendered in place when a toggle changes) ----

function toolbar(u) {
  const seg = (name, val, label) => html`<button type="button" data-${name}="${val}" aria-pressed="${String(u[name] === val)}">${label}</button>`;
  return html`<div class="toolbar">
    <span class="seg" role="group" aria-label="Grid">
      ${seg('zoom', 17, 'z17 · squadratinhos')}${seg('zoom', 14, 'z14 · squadrats')}
    </span>
    <label>Colour
      <select data-colour-select>
        ${Object.entries(E.COLOUR_MODES).map(([k, v]) => html`<option value="${k}" ${k === u.colour ? 'selected' : ''}>${v}</option>`)}
      </select>
    </label>
    ${u.colour === 'stale' ? html`<label>Stale after
      <select data-stale-select>
        ${[3, 6, 12, 24, 36].map(m => html`<option value="${m}" ${m === u.stale ? 'selected' : ''}>${m} months</option>`)}
      </select></label>` : ''}
    <label><input type="checkbox" data-countu ${u.countU ? 'checked' : ''}> Count unreachable as claimed</label>
    <button type="button" class="btn btn-ghost" data-mark aria-pressed="${String(!!u.marking)}">${u.marking ? 'Done marking' : 'Mark unreachable'}</button>
  </div>`;
}

function scores(v) {
  const { s, z } = v;
  return html`<div class="panel-head">
      <p class="eyebrow">Your ground · ${E.ZOOM_NAMES[z]}</p>
      <p class="panel-note">${s.tile_metres.toFixed(0)} m tiles · zoom ${z}</p>
    </div>
    <div class="score-row">
      <div class="stat">
        <div class="stat-value">${s.max_square}<small class="unit">×${s.max_square}</small></div>
        <div class="stat-label">Max square</div>
        <div class="stat-hint">The biggest solid block you own${s.unreachable && v.u.countU ? ', unreachable tiles filled in' : ''}.</div>
      </div>
      <div class="stat">
        <div class="stat-value">${s.tiles.toLocaleString()}</div>
        <div class="stat-label">Tiles claimed</div>
        <div class="stat-hint">${s.area_km2.toFixed(1)} km²${s.unreachable ? ` · ${s.unreachable} marked unreachable` : ''}</div>
      </div>
      <div class="stat">
        <div class="stat-value">${s.max_cluster.toLocaleString()}</div>
        <div class="stat-label">Largest cluster</div>
        <div class="stat-hint">Connected without a gap.</div>
      </div>
      <div class="stat">
        <div class="stat-value">${s.this_month}</div>
        <div class="stat-label">New this month</div>
        <div class="stat-hint">${s.this_week} in the last 7 days</div>
      </div>
      ${s.coverage != null ? html`<div class="stat">
        <div class="stat-value">${(s.coverage * 100).toFixed(0)}<small class="unit">%</small></div>
        <div class="stat-label">Around home</div>
        <div class="stat-hint">Of the 25×25 tiles nearest you.</div>
      </div>` : ''}
    </div>`;
}

function legendHtml(v) {
  const sw = l => `background: color-mix(in srgb, var(--${l.tone}) ${Math.round(l.alpha * 100)}%, transparent)`;
  return html`${v.legend.map(l => html`<span><i style="${sw(l)}"></i>${l.label}</span>`)}
    <span><i class="lg-square"></i>Max square</span>
    <span><i class="lg-target"></i>Next tile to take</span>
    <span><i class="lg-unreach"></i>Unreachable</span>
    <span><i class="lg-fog"></i>Fogged</span>`;
}

function growth(v) {
  const t = v.s.targets;
  if (!t.length) return '';
  const cost0 = t[0][2];
  return html`<div class="panel-head">
      <p class="eyebrow">Grow the square</p>
      <p class="panel-note">To reach ${v.s.max_square + 1}×${v.s.max_square + 1} · ${E.ZOOM_NAMES[v.z].toLowerCase()}</p>
    </div>
    <div class="empty">
      <p>These are the tiles standing between you and a bigger square. The cheapest
        route needs ${cost0} of them${cost0 === 1 ? ' — one run' : ''}.${v.unreach.size && !v.u.countU ? ' Unreachable tiles are never suggested.' : ''}</p>
    </div>
    <div class="target-list">
      ${t.slice(0, 10).map(([tile, , cost]) => html`<button class="target-chip" type="button" data-x="${tile[0]}" data-y="${tile[1]}"
        title="Centre the map here">${tile[0]},${tile[1]} · needs ${cost}</button>`)}
    </div>`;
}

function newGround(v) {
  const p = v.u.period, series = E.newGroundSeries(v.ix, v.z, p, today(), p === 'week' ? 52 : null);
  if (!series.length) return '';
  let chart = '';
  try {
    chart = raw(renderChart({ type: 'bar', title: 'New tiles per ' + p,
      note: `${E.ZOOM_NAMES[v.z]} first claimed, by the ${p} of the activity that claimed them${p === 'week' ? ', last 52 weeks' : ''}.`,
      x: { label: p === 'week' ? 'Week' : 'Month', type: 'time' }, y: { label: 'New tiles', zero: true },
      series: [{ name: 'New tiles (z' + v.z + ')', points: series }] }));
  } catch { chart = ''; }
  const active = series.filter(r => r[1] > 0).length;
  return html`<div class="panel-head">
      <p class="eyebrow">New ground</p>
      <p class="panel-note"><span class="seg" role="group" aria-label="Period">
        <button type="button" data-period="month" aria-pressed="${String(p === 'month')}">Monthly</button><button type="button" data-period="week" aria-pressed="${String(p === 'week')}">Weekly</button>
      </span></p>
    </div>
    <p class="dim">${active} of ${series.length} ${p}s broke new ground.</p>
    ${chart}`;
}

export function render() {
  useCss('territory', CSS);
  const ix = E.exploreIndex(state);
  if (!ix.tiles[17].size) return html`<div class="terr">${pageHead('Territory', 'intvl · territory')}
    ${emptyState('No ground claimed yet',
      html`Every run claims the map tiles it passes through. Bring your Garmin history in and
        analyse it — the ground you have covered fills in, and everything else stays fogged.
        Tiles are about 300 m across, so a new street is a new tile.`,
      html`<a class="btn" href="#/sync">Go and sync</a>`)}</div>`;
  const v = view(), g = growth(v), n = newGround(v);
  return html`<div class="terr">
  ${pageHead('Territory', `intvl · territory${v.s.since ? ' · since ' + day(v.s.since, true) : ''}`,
    html`<a class="btn btn-ghost" href="#/routes">Routes</a><a class="btn btn-ghost" href="#/trails">Trails</a>`)}

  <section class="panel">
    <div id="terr-toolbar">${toolbar(v.u)}</div>
    <div id="terr-scores">${scores(v)}</div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <p class="eyebrow">The map</p>
      <p class="panel-note" id="maphint">Loading your ground…</p>
    </div>
    <div id="tilemap"></div>
    <div class="legend" id="terr-legend">${legendHtml(v)}</div>
  </section>

  <section class="panel" id="terr-growth" ${g ? '' : 'hidden'}>${g}</section>
  <section class="panel" id="terr-new" ${n ? '' : 'hidden'}>${n}</section>
  </div>`;
}

// tileBounds() is [south, west, north, east]; Leaflet wants [[s, w], [n, e]].
const boundsOf = (x, y, z) => { const [s, w, n, e] = tileBounds(x, y, z); return [[s, w], [n, e]]; };

// A theme colour as rgba() for the canvas: token() may hand back #hex or rgb().
function rgba(col, a) {
  const c = String(col).trim();
  let r, g, b;
  if (c[0] === '#') {
    const h = c.length === 4 ? c.slice(1).split('').map(x => x + x).join('') : c.slice(1, 7);
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else {
    const m = c.match(/[\d.]+/g) || [0, 0, 0];
    [r, g, b] = m.map(Number);
  }
  return `rgba(${r},${g},${b},${a})`;
}

// The canvas layer: claimed tiles coloured by the legend, unreachable hatched, the grid lines
// once tiles are big enough to read. Rebuilt (cheaply) when the grid or colouring changes.
function tileLayer(L, getV) {
  let st = null;
  const prep = () => {
    const v = getV(), keys = [...v.claimed.keys()];
    for (const k of v.unreach) if (!v.claimed.has(k)) keys.push(k);
    const tones = { measured: token('--measured', '#0b6e79'), behind: token('--behind', '#a5321f') };
    st = { v, buckets: E.bucketize(keys), fills: v.legend.map(l => rgba(tones[l.tone], l.alpha)),
      unreach: rgba(token('--faint', '#8b94a3'), 0.35), hatch: rgba(token('--faint', '#8b94a3'), 0.9),
      grid: rgba(token('--line', '#d6dbe2'), 0.7),
      has: k => v.claimed.has(k) || v.unreach.has(k) };
  };
  const Layer = L.GridLayer.extend({
    createTile(coords) {
      const c = document.createElement('canvas'), dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = c.height = 256 * dpr;
      const ctx = c.getContext('2d');
      ctx.scale(dpr, dpr);
      if (!st) prep();
      const { v } = st, z = v.z, list = E.tilesInMapTile(coords.x, coords.y, coords.z, z, st.has, st.buckets);
      for (const [x, y, px, py, size] of list) {
        const k = tileKey(x, y), info = v.claimed.get(k), s = Math.max(1, size);
        if (info) { ctx.fillStyle = st.fills[E.styleIndex(info, v.u.colour, v.opts)] || st.fills[0]; ctx.fillRect(px, py, s, s); continue; }
        ctx.fillStyle = st.unreach; ctx.fillRect(px, py, s, s);
        if (size >= 6) {      // hatching, clipped to the tile
          ctx.save(); ctx.beginPath(); ctx.rect(px, py, size, size); ctx.clip();
          ctx.strokeStyle = st.hatch; ctx.lineWidth = 1; ctx.beginPath();
          for (let o = -size; o < size; o += 6) { ctx.moveTo(px + o, py + size); ctx.lineTo(px + o + size, py); }
          ctx.stroke(); ctx.restore();
        }
      }
      // The grid itself, so the fog has squares to aim at.
      const d = z - coords.z, size = d >= 0 ? 256 / 2 ** d : 256 * 2 ** -d;
      if (size >= 12) {
        ctx.strokeStyle = st.grid; ctx.lineWidth = 0.5; ctx.beginPath();
        const off = d >= 0 ? 0 : (-(coords.x % 2 ** -d) * 256) % size, offY = d >= 0 ? 0 : (-(coords.y % 2 ** -d) * 256) % size;
        for (let p = off; p <= 256; p += size) { ctx.moveTo(p, 0); ctx.lineTo(p, 256); }
        for (let p = offY; p <= 256; p += size) { ctx.moveTo(0, p); ctx.lineTo(256, p); }
        ctx.stroke();
      }
      return c;
    },
  });
  const layer = new Layer({ tileSize: 256, maxZoom: 19, updateWhenZooming: false });
  layer.reset = () => { st = null; layer.redraw(); };
  return layer;
}

export async function mount(el) {
  const box = el.querySelector('#tilemap'), hint = el.querySelector('#maphint');
  const root = el.querySelector('.terr'), $ = s => root.querySelector(s);
  if (!root || !$('#terr-scores')) return;
  ui().marking = false;           // never arrive in mark mode: a stray tap would rule out a tile
  let v = view();

  // ---- toggles: re-render the sections in place, keep the map ----
  let map = null, layer = null, overlay = null, L = null;
  const refresh = (redrawMap = true) => {
    v = view();
    $('#terr-toolbar').innerHTML = String(toolbar(v.u));
    $('#terr-scores').innerHTML = String(scores(v));
    $('#terr-legend').innerHTML = String(legendHtml(v));
    const g = String(growth(v)), n = String(newGround(v));
    $('#terr-growth').innerHTML = g; $('#terr-growth').hidden = !g;
    $('#terr-new').innerHTML = n; $('#terr-new').hidden = !n;
    box.classList.toggle('marking', !!v.u.marking);
    if (map && redrawMap) { layer.reset(); drawOverlay(); }
  };
  // Listeners on the page's own root, which goes with the page (#page itself outlives it).
  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !root.contains(b)) return;
    const u = ui();
    if (b.dataset.zoom) { u.zoom = +b.dataset.zoom; persistUi(); refresh(); }
    else if (b.dataset.period) { u.period = b.dataset.period; persistUi(); refresh(false); }
    else if (b.hasAttribute('data-mark')) {
      u.marking = !u.marking; persistUi(); refresh(false);
      if (u.marking) toast('Click a fogged tile to mark it unreachable; click it again to undo.');
    } else if (b.classList.contains('target-chip') && map) {
      const bb = boundsOf(+b.dataset.x, +b.dataset.y, v.z);
      map.setView([(bb[0][0] + bb[1][0]) / 2, (bb[0][1] + bb[1][1]) / 2], v.z === 14 ? 13 : 16);
      box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
  root.addEventListener('change', e => {
    const t = e.target, u = ui();
    if (t.matches('[data-colour-select]')) u.colour = t.value;
    else if (t.matches('[data-stale-select]')) u.stale = +t.value;
    else if (t.matches('[data-countu]')) u.countU = t.checked;
    else return;
    persistUi(); refresh();
  });

  // ---- the map ----
  if (!box) return;
  try { L = await loadLeaflet(); }
  catch (e) { if (hint) hint.textContent = 'Could not load your ground: ' + e.message; return; }
  if (!box.isConnected) return;
  map = L.map(box, { preferCanvas: true }).setView([47.3769, 8.5417], 13);
  whenGone(box, () => map.remove());
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  layer = tileLayer(L, () => v).addTo(map);
  overlay = L.featureGroup().addTo(map);
  const square = token('--projected', '#5b3fd6');
  const target = getComputedStyle(root).getPropertyValue('--target').trim() || '#e8a33d';

  // The square and the targets: a dozen vectors at most.
  function drawOverlay() {
    overlay.clearLayers();
    const { s, z } = v;
    if (s.square_corner) {
      const [cx, cy] = s.square_corner, n = s.max_square;
      const sw = boundsOf(cx, cy + n - 1, z)[0], ne = boundsOf(cx + n - 1, cy, z)[1];
      L.rectangle([sw, ne], { color: square, weight: 2, fillColor: square, fillOpacity: 0.12, interactive: false })
        .addTo(overlay);
    }
    for (const [[x, y]] of s.targets)
      L.rectangle(boundsOf(x, y, z), { color: target, weight: 1, fillColor: target, fillOpacity: 0.75 })
        .addTo(overlay).bindTooltip('Run here to grow the square');
    if (hint) hint.textContent = s.tiles.toLocaleString() + ' tiles claimed'
      + (s.targets.length ? ' · ' + s.targets.length + ' would grow the square' : '')
      + (v.u.marking ? ' · marking unreachable tiles' : '');
  }
  drawOverlay();

  // Fit on the square (home ground), not every tile: one holiday abroad would zoom the map
  // out to a continent. Falls back to the home tile's neighbourhood.
  if (v.s.square_corner) {
    const [cx, cy] = v.s.square_corner, n = Math.max(v.s.max_square, 1), pad = v.z === 14 ? 4 : 12;
    map.fitBounds([boundsOf(cx - pad, cy + n - 1 + pad, v.z)[0], boundsOf(cx + n - 1 + pad, cy - pad, v.z)[1]]);
  }

  // Mark mode: a click toggles the tile under it (only fogged tiles: claimed ground is reachable).
  map.on('click', e => {
    if (!ui().marking) return;
    const t = tileFor(e.latlng.lat, e.latlng.lng, v.z);
    if (!t) return;
    const k = tileKey(t[0], t[1]);
    if (v.claimed.has(k)) { toast('You have already run that tile.'); return; }
    const was = v.unreach.has(k);
    state.profile = { ...state.profile, unreachable: E.toggleUnreachable(state.profile.unreachable, v.z, k), u: new Date().toISOString() };
    save('edit');
    refresh();
    toast(was ? 'Tile back in play.' : 'Marked unreachable.');
  });
}
