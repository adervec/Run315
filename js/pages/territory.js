// intvl -- the territory game. Every run claims the map tiles it passes through; ground
// never covered stays fogged. The scores are the ones that make you plan routes
// differently: the biggest solid square, the biggest connected cluster, and the tiles
// that would grow the square. Tiles come from state.derived[id].tiles, so the phone has
// the whole map without a single stream.
import { state } from '../store.js';
import * as D from '../derive.js';
import { tileBounds } from '../lib/territory.js';
import { html, pageHead, emptyState, day, useCss } from '../ui.js';
import { loadLeaflet, whenGone, token } from '../routemaker.js';

export const title = 'Territory';

const CSS = `
/* The fog map is the page, so it gets real height. */
.terr { --target: #e8a33d; }
.terr #tilemap { height: 62vh; min-height: 420px; border-radius: 3px; background: var(--ground); }
.terr .leaflet-container { font-family: var(--body); }
.terr .score-row {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0 28px;
}
.terr .score-row .stat { border-top: none; padding-top: 0; }
.terr .legend {
  display: flex; gap: 20px; flex-wrap: wrap; margin-top: 12px;
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--muted);
}
.terr .legend i {
  display: inline-block; width: 12px; height: 12px; margin-right: 6px;
  vertical-align: -2px; border-radius: 2px;
}
.terr .lg-claimed { background: var(--measured); opacity: .45; }
.terr .lg-square { background: color-mix(in srgb, var(--projected) 30%, transparent); border: 1px solid var(--projected); }
.terr .lg-target { background: var(--target); opacity: .75; }
.terr .lg-fog { background: var(--ground); border: 1px solid var(--line); }
.terr .target-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.terr .target-chip {
  font-family: var(--mono); font-size: 12px;
  border: 1px solid var(--line); border-radius: 2px; padding: 5px 9px;
  background: none; cursor: pointer; color: var(--ink);
}
.terr .target-chip:hover { border-color: var(--projected); color: var(--projected); }
@media (max-width: 600px) { .terr #tilemap { height: 52vh; min-height: 320px; } }
`;

// The day the first tile was claimed (intvl()'s MIN(first_seen)).
function since(t) {
  let first = null;
  for (const d of t.first_seen.values()) if (!first || d < first) first = d;
  return first;
}

export function render() {
  useCss('territory', CSS);
  const t = D.tileSummary(state);
  if (!t) return html`<div class="terr">${pageHead('Territory', 'intvl · territory')}
    ${emptyState('No ground claimed yet',
      html`Every run claims the map tiles it passes through. Bring your Garmin history in and
        analyse it — the ground you have covered fills in, and everything else stays fogged.
        Tiles are about 300 m across, so a new street is a new tile.`,
      html`<a class="btn" href="#/sync">Go and sync</a>`)}</div>`;
  const first = since(t), cost0 = t.targets.length ? t.targets[0][2] : 0;
  return html`<div class="terr">
  ${pageHead('Territory', `intvl · territory${first ? ' · since ' + day(first, true) : ''}`,
    html`<a class="btn btn-ghost" href="#/routes">Routes</a><a class="btn btn-ghost" href="#/trails">Trails</a>`)}

  <section class="panel">
    <div class="panel-head">
      <p class="eyebrow">Your ground</p>
      <p class="panel-note">${t.tile_metres.toFixed(0)} m tiles · zoom ${t.zoom}</p>
    </div>
    <div class="score-row">
      <div class="stat">
        <div class="stat-value">${t.max_square}<small class="unit">×${t.max_square}</small></div>
        <div class="stat-label">Max square</div>
        <div class="stat-hint">The biggest solid block you own.</div>
      </div>
      <div class="stat">
        <div class="stat-value">${t.tiles}</div>
        <div class="stat-label">Tiles claimed</div>
        <div class="stat-hint">${t.area_km2.toFixed(1)} km²</div>
      </div>
      <div class="stat">
        <div class="stat-value">${t.max_cluster}</div>
        <div class="stat-label">Largest cluster</div>
        <div class="stat-hint">Connected without a gap.</div>
      </div>
      <div class="stat">
        <div class="stat-value">${t.this_month}</div>
        <div class="stat-label">New this month</div>
        <div class="stat-hint">${t.this_week} in the last 7 days</div>
      </div>
      ${t.coverage != null ? html`<div class="stat">
        <div class="stat-value">${(t.coverage * 100).toFixed(0)}<small class="unit">%</small></div>
        <div class="stat-label">Around home</div>
        <div class="stat-hint">Of the 25×25 tiles nearest you.</div>
      </div>` : ''}
    </div>
  </section>

  <section class="panel">
    <div class="panel-head">
      <p class="eyebrow">The map</p>
      <p class="panel-note" id="maphint">Loading your ground…</p>
    </div>
    <div id="tilemap"></div>
    <div class="legend">
      <span><i class="lg-claimed"></i>Claimed</span>
      <span><i class="lg-square"></i>Max square</span>
      <span><i class="lg-target"></i>Next tile to take</span>
      <span><i class="lg-fog"></i>Fogged</span>
    </div>
  </section>

  ${t.targets.length ? html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">Grow the square</p>
      <p class="panel-note">To reach ${t.max_square + 1}×${t.max_square + 1}</p>
    </div>
    <div class="empty">
      <p>These are the tiles standing between you and a bigger square. The cheapest
        route needs ${cost0} of them${cost0 === 1 ? ' — one run' : ''}.</p>
    </div>
    <div class="target-list">
      ${t.targets.slice(0, 10).map(([tile, , cost]) => html`<button class="target-chip" type="button" data-x="${tile[0]}" data-y="${tile[1]}"
        title="Centre the map here">${tile[0]},${tile[1]} · needs ${cost}</button>`)}
    </div>
  </section>` : ''}
  </div>`;
}

// tileBounds() is [south, west, north, east]; Leaflet wants [[s, w], [n, e]].
const boundsOf = (x, y, z) => { const [s, w, n, e] = tileBounds(x, y, z); return [[s, w], [n, e]]; };

export async function mount(el) {
  const box = el.querySelector('#tilemap'), hint = el.querySelector('#maphint');
  if (!box) return;
  let L;
  try { L = await loadLeaflet(); }
  catch (e) { if (hint) hint.textContent = 'Could not load your ground: ' + e.message; return; }
  if (!box.isConnected) return;
  const t = D.tileSummary(state);
  if (!t) return;

  // Canvas rendering: a busy athlete has thousands of tiles and SVG chokes.
  const map = L.map(box, { preferCanvas: true }).setView([47.3769, 8.5417], 13);
  whenGone(box, () => map.remove());
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  // The api_tiles() payload, straight off the summary.
  const z = t.zoom, all = L.featureGroup();
  const claimed = token('--measured', '#0b6e79'), square = token('--projected', '#5b3fd6');
  const target = getComputedStyle(el.querySelector('.terr') || box).getPropertyValue('--target').trim() || '#e8a33d';
  for (const [x, y] of t.tile_set)
    L.rectangle(boundsOf(x, y, z), { color: claimed, weight: 0, fillOpacity: 0.45, interactive: false }).addTo(all);

  if (t.square_corner) {
    const [cx, cy] = t.square_corner, s = t.max_square;
    const sw = boundsOf(cx, cy + s - 1, z)[0], ne = boundsOf(cx + s - 1, cy, z)[1];
    L.rectangle([sw, ne], { color: square, weight: 2, fillColor: square, fillOpacity: 0.18 })
      .addTo(all).bindTooltip(s + ' × ' + s + ' square');
  }
  for (const [[x, y]] of t.targets)
    L.rectangle(boundsOf(x, y, z), { color: target, weight: 1, fillColor: target, fillOpacity: 0.75 })
      .addTo(all).bindTooltip('Run here to grow the square');

  all.addTo(map);
  if (t.tile_set.length) map.fitBounds(all.getBounds(), { padding: [20, 20] });
  if (hint) hint.textContent = t.tile_set.length.toLocaleString() + ' tiles claimed'
    + (t.targets.length ? ' · ' + t.targets.length + ' would grow the square' : '');

  // Chips jump the map to a suggested tile.
  el.querySelectorAll('.target-chip').forEach(b => b.addEventListener('click', () => {
    const bb = boundsOf(+b.dataset.x, +b.dataset.y, z);
    map.setView([(bb[0][0] + bb[1][0]) / 2, (bb[0][1] + bb[1][1]) / 2], 16);
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
}
