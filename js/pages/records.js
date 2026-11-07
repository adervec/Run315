// Records & collections: the Eddington number, every place you have started a run (and a
// map of them), the privacy zones every share respects, the air you ran in against how you
// ran, and the track wall -- every route as a thumbnail, grouped by where it started.
import { state } from '../store.js';
import * as D from '../derive.js';
import * as C from '../collect.js';
import * as S from '../share.js';
import { renderChart } from '../charts.js';
import { html, raw, pageHead, emptyState, useCss, toast, day, fmtTime } from '../ui.js';
import { loadLeaflet, whenGone } from '../routemaker.js';

export const title = 'Records & collections';

const CSS = `
.places-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 18px; }
.places-grid table { font-size: 13px; }
.places-grid h3 { font-size: 14px; margin: 0 0 6px; }
#placemap { height: 420px; border-radius: 3px; border: 1px solid var(--line); margin-top: 14px; background: var(--ground); }
.tw-group { margin: 14px 0 0; }
.tw-group h3 { font-size: 13px; font-weight: 600; margin: 0 0 6px; color: var(--muted); }
.tw-grid { display: flex; flex-wrap: wrap; gap: 4px; }
.tw { width: 64px; height: 64px; display: block; border-radius: 3px; background: var(--track); content-visibility: auto; contain-intrinsic-size: 64px 64px; }
.tw:hover, .tw:focus-visible { outline: 2px solid var(--measured); }
.tw svg { width: 100%; height: 100%; display: block; }
.tw svg path { fill: none; stroke: var(--measured); stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; }
.rec-actions { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin: 10px 0 0; font-size: 13px; }
`;
const ui = { allMunis: false };
const n0 = v => Math.round(v || 0).toLocaleString('en-US');
const span = r => (r.first === r.last ? day(r.first, true) : html`${day(r.first, true)} – ${day(r.last, true)}`);

function placeTable(rows, label, limit) {
  const shown = limit ? rows.slice(0, limit) : rows;
  return html`<div><h3>${label} <span class="dim">· ${rows.length}</span></h3><div class="table-scroll"><table>
    <thead><tr><th></th><th class="num">Runs</th><th>First – last</th></tr></thead>
    <tbody>${shown.map(r => html`<tr><td>${r.name}${label === 'Regions' || label === 'Municipalities' ? html` <span class="dim">${r.cc.toUpperCase()}</span>` : ''}</td>
      <td class="num">${r.count}</td><td class="dim">${span(r)}</td></tr>`)}</tbody></table></div>
    ${limit && rows.length > limit ? html`<button type="button" class="btn-quiet" data-allmunis>Show all ${rows.length}</button>` : ''}</div>`;
}

function placesSection(clusters) {
  const cells = S.placesCells(), sum = C.placeSummary(clusters, cells), pending = C.pendingCells(clusters, cells);
  return html`<section class="panel" id="places">
    <div class="panel-head"><p class="eyebrow">Places you have run</p><p class="panel-note">${clusters.length} start areas · from where each activity began</p></div>
    ${sum.countries.length ? html`<div class="places-grid">
      ${placeTable(sum.countries, 'Countries')}${placeTable(sum.regions, 'Regions')}${placeTable(sum.municipalities, 'Municipalities', ui.allMunis ? 0 : 12)}</div>`
      : html`<p class="dim">No places looked up yet.</p>`}
    <div class="rec-actions">${pending.length ? html`<button type="button" class="btn" data-places>Look up ${pending.length} start area${pending.length === 1 ? '' : 's'}</button>
      <span class="dim" data-places-status>About ${Math.ceil(pending.length * 1.1)} s at OpenStreetMap's limit of one a second.${sum.unresolved ? ` ${sum.unresolved} runs wait on them.` : ''}</span>`
      : html`<span class="dim">Every start area has a place.</span>`}</div>
    <div id="placemap"></div>
    <p class="stat-hint">Start points are grouped on a ~2 km grid and each group is looked up once with OpenStreetMap's Nominatim, then cached on this
      device forever; only the place names sync. Virtual and indoor sessions are left out. Colours on the map are the most-run municipalities.</p></section>`;
}

function wallSection(clusters) {
  const cells = S.placesCells();
  const groups = clusters.filter(c => c.ids.length);
  return html`<section class="panel" id="wall">
    <div class="panel-head"><p class="eyebrow">Track wall</p><p class="panel-note">${n0(groups.reduce((s, g) => s + g.ids.length, 0))} outdoor activities · grouped by where they started</p></div>
    ${groups.map(g => {
      const p = cells[g.key];
      return html`<div class="tw-group"><h3>${p ? [p[0], p[1]].filter(Boolean).join(', ') : 'Near ' + g.key} <span class="dim">· ${g.ids.length}</span></h3>
        <div class="tw-grid">${g.ids.map(id => html`<a class="tw" href="#/activity/${id}" data-tw="${id}" title="${state.activities[id]?.name || ''} · ${String(state.activities[id]?.start || '').slice(0, 10)}"></a>`)}</div></div>`;
    })}
    <p class="stat-hint">Thumbnails draw as they scroll into view, from the tracks on this device (privacy zones applied). A blank tile is an activity whose track lives on another device.</p></section>`;
}

function airSection() {
  const t = S.airTargets(state), ok = t.filter(x => x.cov.ok).length;
  return html`<section class="panel" id="air">
    <div class="panel-head"><p class="eyebrow">Air quality and how you ran</p><p class="panel-note">${ok} of ${t.length} outdoor activities are inside the archive</p></div>
    <div data-air-out><p class="dim">Reading what is cached…</p></div>
    <div class="rec-actions">${ok ? html`<button type="button" class="btn" data-air-more>Fetch air for the next 40 runs</button><span class="dim" data-air-status></span>` : ''}</div>
    <p class="stat-hint">US AQI, PM and ozone for each run's start hour, from the Copernicus (CAMS) models via Open-Meteo, cached on this device.
      The record starts in 2013 in Europe and in August 2022 everywhere else; pollen is Europe-only, from 2021. Paces are the steady runs'
      paces corrected for hills and heat (as on Efficiency), so a hot smoggy day is not counted twice.</p></section>`;
}

export function render() {
  useCss('records', CSS);
  const head = pageHead('Records & collections', 'Eddington, places, the track wall, and the air you ran in',
    html`<a class="btn btn-ghost" href="#/year">Year in review</a>`);
  if (!Object.keys(state.activities).length) return html`${head}${emptyState('Nothing to collect yet',
    'The Eddington number, the places you have run and the track wall fill in from your activities. Bring them in through Sync &amp; cowork.',
    html`<a class="btn" href="#/sync">Set up sync</a>`)}${S.privacyPanel()}`;
  const clusters = C.startClusters(state);
  return html`${head}
    ${S.eddingtonPanel(state, { link: false }) || html`<section class="panel"><p class="eyebrow">Eddington number</p><p class="dim">No runs or rides with a distance yet.</p></section>`}
    ${clusters.length ? placesSection(clusters) : html`<section class="panel"><p class="eyebrow">Places you have run</p><p class="dim">No outdoor activity has a start point yet.</p></section>`}
    ${S.privacyPanel()}
    ${airSection()}
    ${clusters.length ? wallSection(clusters) : ''}`;
}

async function fillAir(el) {
  const out = el.querySelector('[data-air-out]');
  if (!out) return;
  const rows = await S.airRows(state);
  if (!out.isConnected) return;
  if (rows.length < 3) { out.innerHTML = String(html`<p class="dim">${rows.length ? `Only ${rows.length} steady runs have air quality so far: fetch some more.` : 'No steady run has air quality yet. Fetch some below.'}</p>`); return; }
  const c = C.airCorrelation(rows);
  const r = v => (v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2));
  let chart = '';
  try {
    chart = renderChart({ type: 'scatter', title: 'Corrected pace against US AQI', x: { label: 'US AQI', type: 'linear' }, y: { label: 'pace', unit: 's/km' },
      series: [{ name: 'Steady runs', points: rows.map(x => [Math.round(x.aqi), Math.round(x.pace)]) }] });
  } catch { chart = ''; }
  out.innerHTML = String(html`<div class="digest">
      <div class="stat"><div class="stat-value">${c.n}</div><div class="stat-label">Steady runs with air</div></div>
      <div class="stat"><div class="stat-value">${r(c.r_pace)}</div><div class="stat-label">r, AQI vs pace</div><div class="stat-hint">positive: slower in dirtier air</div></div>
      <div class="stat"><div class="stat-value">${r(c.r_hr)}</div><div class="stat-label">r, AQI vs HR</div></div></div>
    <div class="table-scroll"><table><thead><tr><th>Air</th><th class="num">Runs</th><th class="num">Median corrected pace</th><th class="num">Median HR</th></tr></thead>
      <tbody>${c.bands.map(b => html`<tr><td>${b.band}</td><td class="num">${b.n}</td><td class="num">${b.pace ? fmtTime(b.pace) + ' /km' : '—'}</td><td class="num">${b.hr ? Math.round(b.hr) : '—'}</td></tr>`)}</tbody></table></div>
    ${chart ? raw(chart) : ''}
    <p class="stat-hint">A correlation across runs, not an experiment: dirty-air days are also summer days, race weeks, holidays. Below |r| = 0.2 there is nothing to see.</p>`);
}

let _io = null;
function wall(el) {
  if (_io) _io.disconnect();
  const tiles = [...el.querySelectorAll('[data-tw]')];
  if (!tiles.length || typeof IntersectionObserver === 'undefined') return () => {};
  const io = _io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const a = e.target;
      S.localTrack(a.dataset.tw, 80).then(segs => {
        if (!segs || !segs.length || !a.isConnected) return;
        a.innerHTML = `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="${C.pathD(C.fitSegments(segs, 64, 64, 6))}"/></svg>`;
      });
    }
  }, { rootMargin: '300px' });
  tiles.forEach(t => io.observe(t));
  return () => { if (_io) _io.disconnect(); _io = null; };
}

async function placeMap(el) {
  const box = el.querySelector('#placemap');
  if (!box) return () => {};
  let L; try { L = await loadLeaflet(); } catch { box.textContent = 'The map did not load (offline?).'; return () => {}; }
  if (!box.isConnected) return () => {};
  const clusters = C.startClusters(state), cells = S.placesCells(), sum = C.placeSummary(clusters, cells);
  const css = getComputedStyle(document.documentElement);
  const palette = [1, 2, 3, 4, 5, 6, 7, 8].map(i => css.getPropertyValue('--series-' + i).trim()).filter(Boolean);
  const grey = css.getPropertyValue('--faint').trim() || '#888';
  const colourOf = new Map(sum.municipalities.slice(0, palette.length).map((m, i) => [m.key, palette[i]]));
  const map = L.map(box, { preferCanvas: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap' }).addTo(map);
  const pts = [];
  for (const c of clusters) {
    const p = cells[c.key], k = p ? p[2] + '/' + p[1] + '/' + p[0] : null, col = (k && colourOf.get(k)) || grey;
    pts.push([c.lat, c.lon]);
    L.circleMarker([c.lat, c.lon], { radius: Math.min(16, 3 + Math.sqrt(c.ids.length) * 1.6), color: col, fillColor: col, fillOpacity: 0.55, weight: 1 })
      .bindTooltip(`${p ? [p[0], p[1], p[2].toUpperCase()].filter(Boolean).join(', ') : c.key} · ${c.ids.length}`).addTo(map);
  }
  if (pts.length) map.fitBounds(pts, { padding: [20, 20], maxZoom: 13 }); else map.setView([20, 0], 2);
  const stop = whenGone(box, () => map.remove());
  return () => { stop(); try { map.remove(); } catch { /* gone */ } };
}

export async function mount(el) {
  S.mountPrivacy(el);
  const cleanups = [wall(el)];
  wirePlaces(el);
  const airBtn = el.querySelector('[data-air-more]'), airStatus = el.querySelector('[data-air-status]');
  if (airBtn) airBtn.onclick = async () => {
    airBtn.disabled = true;
    const ids = [];
    for (const t of S.airTargets(state).filter(t => t.cov.ok)) {
      if (ids.length >= 40) break;
      if (!(await S.airFor(t.id, { cachedOnly: true }).catch(() => null))) ids.push(t.id);
    }
    if (!ids.length) { airStatus.textContent = 'Every run in the archive has its air already.'; return; }
    await S.airMany(ids, { onProgress: (i, n) => { airStatus.textContent = `${i} of ${n}…`; } });
    airStatus.textContent = 'Done.'; airBtn.disabled = false;
    fillAir(el);
  };
  fillAir(el);
  cleanups.push(await placeMap(el));
  return () => cleanups.forEach(f => { try { f(); } catch { /* gone */ } });
}
// The places table changed: redraw just that section (and the wall's headings) without a full route.
function rerenderSection(el) {
  const clusters = C.startClusters(state);
  const old = el.querySelector('#places'), oldWall = el.querySelector('#wall');
  if (old) { old.outerHTML = String(placesSection(clusters)); }
  if (oldWall) { oldWall.outerHTML = String(wallSection(clusters)); wall(el); }
  wirePlaces(el);
  placeMap(el);
}
function wirePlaces(el) {
  const more = el.querySelector('[data-allmunis]');
  if (more) more.onclick = () => { ui.allMunis = true; rerenderSection(el); };
  const btn = el.querySelector('[data-places]'), status = el.querySelector('[data-places-status]');
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    const r = await S.resolvePlaces({ onProgress: (i, n) => { if (status) status.textContent = `${i} of ${n}…`; } });
    toast(`Looked up ${r.fetched} new place${r.fetched === 1 ? '' : 's'}${r.failed ? `, ${r.failed} failed (try again later)` : ''}.`);
    if (el.isConnected) rerenderSection(el);
  };
}
