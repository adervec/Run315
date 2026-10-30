// Streets & trails: completion by municipality, the CityStrides model (js/cities.js is the
// engine). Pick the town you run in, load its public streets and trails from OpenStreetMap,
// and every run marks the 25 m nodes it passed; a street is done at 90% of them.
//
// Everything on this page except the map reads state.cities, which syncs -- so the phone
// shows the totals, the lists, the chart and the completion dates without the geometry.
// The map needs `city-geo-<id>` in this device's cache; a device without it gets a
// "Load map data" button that fetches the same ways from Overpass.
import { state } from '../store.js';
import * as C from '../cities.js';
import * as BS from '../bitset.js';
import { renderChart } from '../charts.js';
import { dayKey } from '../lib/dt.js';
import { html, raw, pageHead, day, ago, toast, useCss, link } from '../ui.js';
import { loadLeaflet, whenGone, token } from '../routemaker.js';

export const title = 'Streets & trails';

// View state survives re-renders (module-level, like the trails page's filters).
let selected = null;          // area id shown in detail
let candidates = null;        // {label, rows} from a boundary lookup
let filter = 'all', sortBy = 'close', listKind = 's', mapShow = 'both';
let busy = false, progress = '';
let lastView = null;
const LIST_MAX = 300;
const MAX_DRAWN = 15000;      // ponytail: a cap on ways drawn; a city is ~10k

const CSS = `
.cities .area-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 14px; }
.cities .area-card { border: 1px solid var(--line); border-radius: 4px; padding: 14px; background: var(--surface);
  text-align: left; font: inherit; color: inherit; cursor: pointer; display: block; width: 100%; }
.cities .area-card[aria-current="true"] { border-color: var(--measured); box-shadow: inset 0 0 0 1px var(--measured); }
.cities .area-card h3 { margin: 0 0 2px; font-family: var(--display); font-size: 17px; }
.cities .area-card .lvl { font-family: var(--mono); font-size: 11px; color: var(--muted); letter-spacing: .06em; text-transform: uppercase; }
.cities .area-card dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 10px 0 0; font-size: 14px; }
.cities .area-card dt { color: var(--muted); }
.cities .area-card dd { margin: 0; text-align: right; font-family: var(--mono); }
.cities .bar { display: block; height: 6px; background: var(--track); border-radius: 3px; overflow: hidden; margin-top: 4px; min-width: 70px; }
.cities .bar i { display: block; height: 100%; background: var(--measured); }
.cities .bar i.done { background: var(--ahead); }
.cities .tick { color: var(--ahead); font-weight: 600; }
.cities .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0 28px; }
.cities .totals .stat { border-top: none; padding-top: 0; }
.cities .filters { display: flex; gap: 14px; flex-wrap: wrap; align-items: center; font-family: var(--mono); font-size: 11px;
  letter-spacing: .08em; text-transform: uppercase; margin-bottom: 12px; }
.cities .filters button { font: inherit; letter-spacing: inherit; text-transform: inherit; background: none; border: 0; padding: 0;
  cursor: pointer; color: var(--muted); border-bottom: 1px solid var(--line); }
.cities .filters button.on { color: var(--projected); border-bottom-color: var(--projected); }
.cities .filters .sep { color: var(--line); }
.cities #citymap { height: 58vh; min-height: 380px; border-radius: 3px; background: var(--ground); }
.cities .leaflet-container { font-family: var(--body); }
.cities .legend { display: flex; gap: 18px; flex-wrap: wrap; margin-top: 10px; font-family: var(--mono); font-size: 11px;
  letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.cities .legend i { display: inline-block; width: 18px; height: 0; border-top: 3px solid; margin-right: 6px; vertical-align: 3px; }
.cities .lg-cov { border-color: var(--measured); }
.cities .lg-unc { border-color: var(--behind); }
.cities .lg-done { border-top-width: 5px !important; border-color: var(--measured); }
.cities .lg-bnd { border-color: var(--projected); border-top-style: dashed !important; }
.cities .cand { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 8px 0; border-top: 1px solid var(--line); flex-wrap: wrap; }
.cities .cand .meta { color: var(--muted); font-size: 13px; }
.cities .warn { color: var(--behind); font-size: 13px; }
.cities .area-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
.cities .progress { font-family: var(--mono); font-size: 12px; color: var(--muted); min-height: 1.2em; }
@media (max-width: 600px) { .cities #citymap { height: 46vh; min-height: 280px; } }
`;

const pct = (a, b, d = 0) => (b ? ((100 * a) / b).toFixed(d) : (0).toFixed(d));
const kmTxt = m => ((m || 0) / 1000).toFixed(1);
const LEVELS = { 2: 'country', 4: 'province / state', 5: 'region', 6: 'county / region', 7: 'district', 8: 'city / town', 9: 'borough', 10: 'neighbourhood' };
const levelName = l => (l ? `Level ${l}${LEVELS[l] ? ' · ' + LEVELS[l] : ''}` : 'Boundary');
const areasOf = () => Object.values(C.cities()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
const bar = (frac, done) => html`<span class="bar"><i class="${done ? 'done' : ''}" style="width:${(Math.min(1, frac || 0) * 100).toFixed(1)}%"></i></span>`;

// ---------- panels ----------
function card(a) {
  const s = a.totals?.streets || {}, t = a.totals?.trails || {};
  return html`<button type="button" class="area-card" data-area="${a.id}" aria-current="${a.id === selected ? 'true' : 'false'}">
    <h3>${a.name}</h3><div class="lvl">${levelName(a.admin_level)}</div>
    <dl>
      <dt>Streets</dt><dd>${s.done || 0} / ${s.count || 0} · ${pct(s.done, s.count)}%</dd>
      <dt>Street length</dt><dd>${pct(s.lengthDone_m, s.length_m)}%</dd>
      <dt>Trails</dt><dd>${pct(t.lengthDone_m, t.length_m)}%</dd>
      <dt>Named trails</dt><dd>${t.done || 0} / ${t.named || 0}</dd>
      <dt>Matched</dt><dd>${a.matched_at ? ago(a.matched_at) : 'not yet'}</dd>
    </dl>
    ${bar(s.count ? s.done / s.count : 0, s.count && s.done === s.count)}
  </button>`;
}

function addPanel(hasAreas) {
  return html`<section class="panel" id="addarea">
    <div class="panel-head">
      <p class="eyebrow">${hasAreas ? 'Add an area' : 'Pick your town'}</p>
      <p class="panel-note">Administrative boundaries from OpenStreetMap</p>
    </div>
    <div class="form-row">
      <button class="btn" type="button" id="findhome">Areas where I run</button>
      <form class="form-row" id="namesearch" style="flex:1 1 260px">
        <div class="field field-grow"><label for="cityname">Or search by name</label>
          <input type="text" id="cityname" name="name" placeholder="Markham" maxlength="80"></div>
        <button class="btn btn-ghost" type="submit">Search</button>
      </form>
    </div>
    ${candidates ? html`<div style="margin-top:14px">
      <p class="stat-hint">${candidates.label}</p>
      ${candidates.rows.length ? candidates.rows.map(b => html`<div class="cand">
        <div><strong>${b.name}</strong> <span class="meta">${levelName(b.admin_level)}${b.km2 != null ? ` · ~${b.km2.toLocaleString()} km² (bounding box)` : ''}${b.where ? ' · ' + b.where : ''}${b.wikidata ? ' · ' + b.wikidata : ''}</span>
          ${b.tooLarge ? html`<div class="warn">Too large to load in a browser — pick a city or town inside it.</div>` : ''}</div>
        ${b.tooLarge ? '' : C.cities()[C.areaId(b.id)] ? html`<span class="dim">Loaded</span>`
          : html`<button class="btn btn-sm" type="button" data-load="${b.id}">Load</button>`}
      </div>`) : html`<p class="dim">Nothing found.</p>`}
    </div>` : ''}
    <p class="stat-hint" style="margin-top:10px">Streets count when they are public and named (no driveways,
      parking aisles or private roads); trails are paths, footways, tracks, cycleways and steps, without
      sidewalks. Loading a town takes Overpass, a free volunteer service, anywhere from ten seconds to a few minutes.</p>
  </section>`;
}

function statsPanel(a) {
  const s = a.totals?.streets || {}, t = a.totals?.trails || {}, today = dayKey(new Date());
  const month = today.slice(0, 8) + '01', year = today.slice(0, 5) + '01-01';
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">${a.name}</p>
      <p class="panel-note">Complete at ${pct(C.COMPLETE_AT, 1)}% of a street's 25 m nodes ·
        ${a.runs || 0} activit${a.runs === 1 ? 'y' : 'ies'} matched${a.coarse ? ` (${a.coarse} from coarse tracks)` : ''}
        · ${a.matched_at ? 'matched ' + ago(a.matched_at) : 'not matched yet'}</p>
    </div>
    <div class="totals">
      <div class="stat"><div class="stat-value">${pct(s.done, s.count, 1)}<small class="unit">%</small></div>
        <div class="stat-label">Streets complete</div><div class="stat-hint">${s.done || 0} of ${s.count || 0}</div></div>
      <div class="stat"><div class="stat-value">${pct(s.lengthDone_m, s.length_m, 1)}<small class="unit">%</small></div>
        <div class="stat-label">Street length run</div><div class="stat-hint">${kmTxt(s.lengthDone_m)} of ${kmTxt(s.length_m)} km</div></div>
      <div class="stat"><div class="stat-value">${pct(t.lengthDone_m, t.length_m, 1)}<small class="unit">%</small></div>
        <div class="stat-label">Trail length run</div><div class="stat-hint">${kmTxt(t.lengthDone_m)} of ${kmTxt(t.length_m)} km, named or not</div></div>
      <div class="stat"><div class="stat-value">${t.done || 0}</div>
        <div class="stat-label">Named trails complete</div><div class="stat-hint">of ${t.named || 0}</div></div>
      <div class="stat"><div class="stat-value">${C.finishedSince(a, 's', month)}</div>
        <div class="stat-label">New streets this month</div><div class="stat-hint">${C.finishedSince(a, 's', year)} this year</div></div>
    </div>
  </section>`;
}

function mapPanel(a, hasGeo) {
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">Map</p>
      <div class="area-actions">
        ${hasGeo ? '' : html`<button class="btn btn-ghost btn-sm" type="button" data-refetch="${a.id}">Load map data</button>`}
        <button class="btn btn-ghost btn-sm" type="button" data-rematch="${a.id}" ${hasGeo ? '' : 'disabled'}>Re-match</button>
        <button class="btn-quiet" type="button" data-remove="${a.id}">remove</button>
      </div>
    </div>
    <p class="progress" id="cityprogress">${progress}</p>
    ${hasGeo ? html`
      <div class="filters">
        ${[['both', 'Streets and trails'], ['s', 'Streets'], ['t', 'Trails']].map(([k, l]) =>
          html`<button type="button" class="${mapShow === k ? 'on' : ''}" data-show="${k}">${l}</button>`)}
      </div>
      <div id="citymap"></div>
      <div class="legend"><span><i class="lg-cov"></i>Run</span><span><i class="lg-unc"></i>Not yet</span>
        <span><i class="lg-done"></i>Complete street</span><span><i class="lg-bnd"></i>Boundary</span></div>`
    : html`<div class="empty"><p>The coverage above is synced; the street and trail lines are not on this
        device. Load them to see the map and to match this device's runs.</p></div>`}
  </section>`;
}

function chartPanel(a) {
  const tl = C.timeline(a);
  if (!tl.length) return '';
  let chart = '';
  try {
    chart = raw(renderChart({ type: 'line', title: 'Coverage over time',
      note: 'Share of the area\'s street and trail nodes run, cumulative. Each node counts once, on the day it was first reached.',
      x: { label: 'Date', type: 'time' }, y: { label: 'Covered', unit: '%', zero: true },
      series: [{ name: 'Streets', points: tl.map(p => [p.date, +p.streets.toFixed(2)]) },
               { name: 'Trails', points: tl.map(p => [p.date, +p.trails.toFixed(2)]) }] }));
  } catch { chart = ''; }
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Progress</p>
      <p class="panel-note">${tl.length} day${tl.length === 1 ? '' : 's'} broke new ground</p></div>
    ${chart}
  </section>`;
}

const SORTS = {
  // CityStrides' motivation: the unfinished streets nearest the line first, then the done ones.
  close: (x, y) => (x.complete - y.complete) || (x.left - y.left) || (y.pct - x.pct) || x.name.localeCompare(y.name),
  name: (x, y) => x.name.localeCompare(y.name),
  length: (x, y) => y.len_m - x.len_m,
  pct: (x, y) => y.pct - x.pct || x.name.localeCompare(y.name),
  date: (x, y) => String(y.done_on || '').localeCompare(String(x.done_on || '')) || x.name.localeCompare(y.name),
};
const FILTERS = { all: () => true, done: r => r.complete, progress: r => !r.complete && r.hit > 0, untouched: r => r.hit === 0 };

function listPanel(a) {
  const all = C.groupRows(a, listKind);
  const rows = all.filter(FILTERS[filter] || FILTERS.all).sort(SORTS[sortBy] || SORTS.close);
  const noun = listKind === 's' ? 'street' : 'named trail';
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">${listKind === 's' ? 'Streets' : 'Named trails'}</p>
      <p class="panel-note">${rows.length} of ${all.length} ${noun}s${rows.length > LIST_MAX ? ` · first ${LIST_MAX} shown` : ''}</p>
    </div>
    <div class="filters">
      ${[['s', 'Streets'], ['t', 'Named trails']].map(([k, l]) => html`<button type="button" class="${listKind === k ? 'on' : ''}" data-kind="${k}">${l}</button>`)}
      <span class="sep">|</span>
      ${[['all', 'All'], ['progress', 'In progress'], ['untouched', 'Untouched'], ['done', 'Done']].map(([k, l]) =>
        html`<button type="button" class="${filter === k ? 'on' : ''}" data-filter="${k}">${l}</button>`)}
      <span class="sep">|</span>
      ${[['close', 'Closest to done'], ['pct', '%'], ['length', 'Length'], ['name', 'Name'], ['date', 'Completed']].map(([k, l]) =>
        html`<button type="button" class="${sortBy === k ? 'on' : ''}" data-sort="${k}">${l}</button>`)}
    </div>
    ${rows.length ? html`<div class="table-scroll"><table>
      <thead><tr><th>${listKind === 's' ? 'Street' : 'Trail'}</th><th class="num">Length</th><th class="num">Done</th>
        <th class="num">Nodes left</th><th class="num">Completed</th></tr></thead>
      <tbody>${rows.slice(0, LIST_MAX).map(r => html`<tr>
        <td>${r.name} ${r.complete ? html`<span class="tick">✓</span>` : ''}${bar(r.pct, r.complete)}</td>
        <td class="num dim">${(r.len_m / 1000).toFixed(2)} km</td>
        <td class="num">${pct(r.hit, r.nodes)}%</td>
        <td class="num dim">${r.complete ? '—' : html`${r.left} <span class="dim">(~${(r.left * C.NODE_STEP_M / 1000).toFixed(2)} km)</span>`}</td>
        <td class="num dim">${r.done_on ? day(r.done_on, true) : ''}</td>
      </tr>`)}</tbody>
    </table></div>` : html`<p class="dim">${all.length ? `No ${noun}s match this filter.` : `No ${noun}s in this area.`}</p>`}
  </section>`;
}

export async function render() {
  useCss('cities', CSS);
  const areas = areasOf();
  if (selected && !C.cities()[selected]) selected = null;
  if (!selected && areas.length) selected = areas[0].id;
  const a = selected ? C.cities()[selected] : null;
  const hasGeo = a ? !!(await C.localGeo(a.id)) : false;
  return html`<div class="cities">
    ${pageHead('Streets & trails', 'Public street and trail completion by municipality, the CityStrides way',
      html`${link('trails', 'Trails by map area', 'btn btn-ghost')}${link('territory', 'Territory', 'btn btn-ghost')}`)}
    ${areas.length ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">Your areas</p><p class="panel-note">${areas.length} loaded</p></div>
      <div class="area-cards">${areas.map(card)}</div>
    </section>` : html`<section class="panel"><div class="empty">
      <p>Every public street and trail in your town, split into nodes 25 m apart. A run marks every node it
        passes within 25 m of; a street is finished at 90% of its nodes, because the last stub is usually a
        cul-de-sac bulb or a mapping artefact. Pick an area below to start.</p></div></section>`}
    ${a ? html`${statsPanel(a)}${mapPanel(a, hasGeo)}${chartPanel(a)}${listPanel(a)}` : ''}
    ${addPanel(areas.length > 0)}
  </div>`;
}

export async function mount(el) {
  const redraw = async () => { if (!el.isConnected) return; el.innerHTML = String(await render()); mount(el); };
  const say = msg => { progress = msg; const p = el.querySelector('#cityprogress'); if (p) p.textContent = msg; };
  const work = async (label, fn) => {
    if (busy) return toast('Still working on the last request.');
    busy = true;
    el.querySelectorAll('button').forEach(b => { b.disabled = true; });
    say(label);
    try { const msg = await fn(); if (msg) toast(msg, 5000); }
    catch (e) { console.error(e); toast('⚠ ' + (e.message || e), 7000); }
    finally { busy = false; progress = ''; await redraw(); }
  };
  const onProgress = (id, i, n) => say(`Matching ${C.cities()[id]?.name || ''}: ${i} of ${n} activities…`);
  const matchMsg = r => {
    const s = Object.values(r)[0];
    return s ? `Checked ${s.checked} activities; ${s.runs} ran in this area${s.coarse ? ` (${s.coarse} from coarse tracks)` : ''}.` : '';
  };

  el.querySelectorAll('[data-area]').forEach(b => b.onclick = () => { selected = b.dataset.area; lastView = null; redraw(); });
  el.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { filter = b.dataset.filter; redraw(); });
  el.querySelectorAll('[data-sort]').forEach(b => b.onclick = () => { sortBy = b.dataset.sort; redraw(); });
  el.querySelectorAll('[data-kind]').forEach(b => b.onclick = () => { listKind = b.dataset.kind; redraw(); });
  el.querySelectorAll('[data-show]').forEach(b => b.onclick = () => { mapShow = b.dataset.show; redraw(); });

  const fh = el.querySelector('#findhome');
  if (fh) fh.onclick = () => work('Looking up the boundaries around where you run…', async () => {
    const p = C.homePoint();
    if (!p) { candidates = { label: 'No GPS runs yet to find your home area from. Search by name instead.', rows: [] }; return null; }
    candidates = { label: 'Boundaries containing your most common start point, most local first:', rows: await C.areasAround(p[0], p[1]) };
    return null;
  });
  const ns = el.querySelector('#namesearch');
  if (ns) ns.onsubmit = ev => {
    ev.preventDefault();
    const q = el.querySelector('#cityname').value.trim();
    if (!q) return;
    work(`Searching for “${q}”…`, async () => {
      candidates = { label: `Administrative areas named “${q}”:`, rows: await C.areasNamed(q) };
      return null;
    });
  };
  el.querySelectorAll('[data-load]').forEach(b => b.onclick = () => {
    const cand = (candidates?.rows || []).find(r => String(r.id) === b.dataset.load);
    if (!cand) return;
    work(`Loading every street and trail in ${cand.name} from Overpass… (a city can take a few minutes)`, async () => {
      const id = await C.loadArea(cand);
      selected = id; candidates = null; lastView = null;
      const geo = await C.localGeo(id);
      say(`Loaded ${geo ? geo.ways.length : 0} ways. Matching your activities…`);
      return matchMsg(await C.matchNew([id], { onProgress }));
    });
  });
  el.querySelectorAll('[data-refetch]').forEach(b => b.onclick = () => work('Fetching the street and trail lines…', async () => {
    await C.refetchGeo(b.dataset.refetch);
    return matchMsg(await C.matchNew([b.dataset.refetch], { onProgress }));
  }));
  el.querySelectorAll('[data-rematch]').forEach(b => b.onclick = () => {
    if (!confirm('Re-match every activity against this area from scratch? It rebuilds the completion dates, and can take a while.')) return;
    work('Re-matching…', async () => matchMsg(await C.matchNew([b.dataset.rematch], { full: true, onProgress })));
  });
  el.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
    const a = C.cities()[b.dataset.remove];
    if (!a || !confirm(`Remove ${a.name} and its coverage, on every device?`)) return;
    await C.removeArea(a.id);
    toast('Area removed.');
    redraw();
  });

  // ---- the map ----
  const box = el.querySelector('#citymap');
  const a = selected && C.cities()[selected];
  if (!box || !a) return;
  const geo = await C.localGeo(a.id);
  if (!geo || !box.isConnected) return;
  let L;
  try { L = await loadLeaflet(); } catch (e) { say(e.message); return; }
  if (!box.isConnected) return;
  const map = L.map(box, { preferCanvas: true });
  whenGone(box, () => {
    try { const c = map.getCenter(); lastView = [[c.lat, c.lng], map.getZoom()]; } catch { /* detached */ }
    map.remove();
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  const [s, w, n, e] = a.bbox || [];
  if (lastView) map.setView(lastView[0], lastView[1]);
  else if ([s, w, n, e].every(Number.isFinite)) {
    map.fitBounds([[s, w], [n, e]]);
    // The container may not have its size yet on first paint; fit again once it does.
    requestAnimationFrame(() => { try { map.invalidateSize(); map.fitBounds([[s, w], [n, e]]); } catch { /* gone */ } });
  }
  else map.setView([43.86, -79.33], 12);

  const cCov = token('--measured', '#0b6e79'), cUnc = token('--behind', '#a5321f'), cBnd = token('--projected', '#6b4fd8');
  // OSM names reach Leaflet's tooltip as text nodes, never as markup.
  const tip = text => () => { const sp = document.createElement('span'); sp.textContent = text; return sp; };
  const done = a.done || {}, list = a.list || {};
  const isDone = g => g && list[g] && list[g][0] && list[g][1] / list[g][0] >= C.COMPLETE_AT;
  for (const line of geo.boundary || []) L.polyline(line, { color: cBnd, weight: 2, dashArray: '6 6', interactive: false }).addTo(map);
  let drawn = 0;
  for (const wy of geo.ways) {
    if (mapShow !== 'both' && wy.t !== mapShow) continue;
    if (drawn++ >= MAX_DRAWN) break;
    const bits = a.cover && a.cover[wy.k] ? BS.decode(a.cover[wy.k], wy.c.length) : null;
    const thick = wy.t === 's' && isDone(wy.g) ? 5 : 3;
    const label = (wy.g ? wy.g.slice(2) : 'Unnamed trail') + (done[wy.g] ? ' — complete ' + done[wy.g] : '');
    const dash = wy.t === 't' ? '4 4' : null;
    for (const p of C.pieces(wy.c, bits, false)) L.polyline(p, { color: cUnc, weight: 2, dashArray: dash }).bindTooltip(tip(label)).addTo(map);
    if (bits) for (const p of C.pieces(wy.c, bits, true)) L.polyline(p, { color: cCov, weight: thick }).bindTooltip(tip(label)).addTo(map);
  }
  if (drawn > MAX_DRAWN) say(`Showing the first ${MAX_DRAWN} of ${geo.ways.length} ways.`);
}
