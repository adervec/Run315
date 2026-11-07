// Year in review: one year against the one before, its biggest weeks, longest run, best
// efforts, most-run route, new ground, busiest month and streak, with a heatmap thumbnail --
// downloadable as a PNG card. Below it, the poster generator: every route shape as small
// multiples, year rings, and a contribution calendar of every year, as SVG.
// Privacy zones (js/share.js) apply to every track drawn here.
import { state } from '../store.js';
import * as D from '../derive.js';
import * as C from '../collect.js';
import * as S from '../share.js';
import { exploreIndex } from '../explore.js';
import { distLabel } from '../events.js';
import { html, raw, pageHead, emptyState, useCss, toast, day, fmtTime } from '../ui.js';

export const title = 'Year in review';

const CSS = `
.yr-pick { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }
.yr-pick button { font: 13px var(--mono); padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--muted); cursor: pointer; }
.yr-pick button[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
.yr-huge { font-family: var(--display); font-size: 56px; font-weight: 800; letter-spacing: -0.04em; line-height: 1; color: var(--measured); margin: 0; }
.yr-months { display: grid; grid-template-columns: repeat(12, 1fr); gap: 3px; align-items: end; height: 80px; margin-top: 10px; }
.yr-months i { display: block; background: var(--measured); border-radius: 2px 2px 0 0; min-height: 1px; }
.yr-months i.top { background: var(--ink); }
.yr-mlabels { display: grid; grid-template-columns: repeat(12, 1fr); gap: 3px; font: 10px var(--mono); color: var(--faint); text-align: center; }
#yrheat { width: 100%; max-width: 360px; aspect-ratio: 1; border-radius: 4px; background: #0d1117; display: block; }
.poster-prev { margin-top: 12px; max-height: 520px; overflow: auto; border: 1px solid var(--line); border-radius: 4px; background: #0d1117; }
.poster-prev svg { width: 100%; height: auto; display: block; }
.yr-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; font-size: 13px; }
@media (max-width: 520px) { .yr-huge { font-size: 42px; } }
`;
const ui = { year: null, posterScope: 'all' };
const n0 = v => Math.round(v || 0).toLocaleString('en-US');
const km = m => n0((m || 0) / 1000);
const pct = v => (v == null ? '' : (v >= 0 ? '+' : '−') + Math.abs(Math.round(v * 100)) + '%');
const M3 = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

const runsOf = () => D.runs(state).filter(a => a.source !== 'gymtracker');
function inputs(year) {
  let routes = [];
  try { routes = D.repeatedRoutes(state, new Date(year, 11, 31, 23, 59), 366, 2); } catch { routes = []; }
  let tiles = null;
  try { tiles = exploreIndex(state).tiles; } catch { tiles = null; }
  return { runs: runsOf(), prRows: D.prRows(state), routes, tiles, cities: state.cities };
}

function reviewHtml(r) {
  const t = r.totals, p = r.previous, top = Math.max(1, ...r.months);
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${r.year} in running</p>
      <p class="panel-note">${p.runs ? html`${km(p.distance_m)} km in ${r.year - 1}` : 'first year on record'}</p></div>
    <div class="grid-2"><div>
      <p class="yr-huge">${km(t.distance_m)}<small class="unit" style="font-size:20px"> km</small></p>
      <p class="stat-hint">${t.runs} runs on ${t.days} days, ${n0(t.seconds / 3600)} hours, ${n0(t.ascent_m)} m climbed${r.change != null ? html` · <b>${pct(r.change)}</b> on ${r.year - 1}` : ''}.</p>
      <canvas id="yrheat" width="720" height="720" aria-label="Heatmap of the year's runs"></canvas>
    </div><div>
      <div class="digest">
        <div class="stat"><div class="stat-value">${r.longest ? (r.longest.distance_m / 1000).toFixed(1) : '—'}<small class="unit">km</small></div><div class="stat-label">Longest run</div>
          ${r.longest ? html`<div class="stat-hint"><a class="quiet-link" href="#/activity/${r.longest.id}">${r.longest.name || 'Run'}, ${day(r.longest.start instanceof Date ? r.longest.start.toISOString() : r.longest.start, true)}</a></div>` : ''}</div>
        <div class="stat"><div class="stat-value">${r.longestWeekStreak}</div><div class="stat-label">Longest week streak</div><div class="stat-hint">${r.weeksRun} weeks with a run</div></div>
        ${r.newTiles ? html`<div class="stat"><div class="stat-value">+${n0(r.newTiles.z17)}</div><div class="stat-label">New tiles (z17)</div><div class="stat-hint">+${n0(r.newTiles.z14)} squadrats (z14)</div></div>` : ''}
        ${r.streets ? html`<div class="stat"><div class="stat-value">+${r.streets.new_km.toFixed(1)}<small class="unit">km</small></div><div class="stat-label">New streets</div><div class="stat-hint">${r.streets.finished} finished${r.streets.trail_km ? html`, +${r.streets.trail_km.toFixed(1)} km of trails` : ''}</div></div>` : ''}
      </div>
      <p class="eyebrow" style="margin-top:16px">Month by month${r.busiestMonth ? html` · busiest ${r.busiestMonth.name}, ${km(r.busiestMonth.distance_m)} km` : ''}</p>
      <div class="yr-months">${r.months.map((m, i) => html`<i class="${r.busiestMonth && r.busiestMonth.month === i + 1 ? 'top' : ''}" style="height:${((m / top) * 100).toFixed(1)}%" title="${km(m)} km"></i>`)}</div>
      <div class="yr-mlabels">${M3.map(m => html`<span>${m}</span>`)}</div>
    </div></div>
    <div class="yr-actions"><button type="button" class="btn" data-yr-card>Download the year as a PNG card</button><span class="dim">Privacy zones apply to the heatmap.</span></div>
  </section>
  <section class="panel">
    <div class="grid-half" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px">
      <div><p class="eyebrow">Biggest weeks</p><div class="table-scroll"><table><tbody>
        ${r.topWeeks.map(w => html`<tr><td>Week of ${day(w.week, true)}</td><td class="num">${(w.distance_m / 1000).toFixed(1)} km</td><td class="num dim">${w.runs} runs</td></tr>`)}</tbody></table></div>
        ${r.route ? html`<p class="eyebrow" style="margin-top:16px">Most-run route</p>
          <p style="margin:4px 0"><b>${r.route.name}</b> · ${r.route.count} times${/km/.test(r.route.name) ? '' : html` · ${(r.route.distance_m / 1000).toFixed(1)} km`}
          ${r.route.id ? html` · <a class="quiet-link" href="#/activity/${r.route.id}">one of them</a>` : ''}</p>` : ''}</div>
      <div><p class="eyebrow">Best efforts in ${r.year}</p>
        ${r.bests.length ? html`<div class="table-scroll"><table><thead><tr><th></th><th class="num">Best</th><th class="num">Before</th><th></th></tr></thead><tbody>
          ${r.bests.map(b => html`<tr><td><a class="quiet-link" href="#/activity/${b.id}">${distLabel(b.dist)}</a></td><td class="num">${fmtTime(b.secs)}</td>
            <td class="num dim">${b.previous ? fmtTime(b.previous) : '—'}</td><td>${b.pr ? html`<b>PR</b>` : ''}</td></tr>`)}</tbody></table></div>`
          : html`<p class="dim">No measured efforts this year.</p>`}</div>
    </div></section>`;
}

function postersHtml(years) {
  return html`<section class="panel" id="posters">
    <div class="panel-head"><p class="eyebrow">Posters</p><p class="panel-note">SVG, to print or to keep</p></div>
    <div class="yr-actions">
      <label>Routes from <select data-poster-scope><option value="all" ${ui.posterScope === 'all' ? 'selected' : ''}>every year</option>
        ${years.map(y => html`<option value="${y}" ${String(ui.posterScope) === String(y) ? 'selected' : ''}>${y}</option>`)}</select></label>
      <button type="button" class="btn btn-ghost" data-poster="grid">Every route shape</button>
      <button type="button" class="btn btn-ghost" data-poster="rings">Year rings</button>
      <button type="button" class="btn btn-ghost" data-poster="calendar">Every day you ran</button>
      <button type="button" class="btn" data-poster-dl disabled>Download SVG</button>
    </div>
    <div class="poster-prev" data-poster-prev hidden></div>
    <p class="stat-hint">The route grid draws every outdoor run whose track is on this device, each scaled to its own square, with your privacy zones cut out.
      Rings are one circle per year, a tick per running day as long as its distance; the calendar shades each day by distance against your busiest days.</p></section>`;
}

export function render() {
  useCss('review', CSS);
  const head = pageHead('Year in review', 'One year against the one before', html`<a class="btn btn-ghost" href="#/records">Records &amp; collections</a>`);
  const runs = runsOf(), years = C.reviewYears(runs);
  if (!years.length) return html`${head}${emptyState('No runs yet', 'The review fills in from your runs. Bring them in through Sync &amp; cowork, or load the demo athlete.', html`<a class="btn" href="#/sync">Set up sync</a>`)}`;
  if (!years.includes(ui.year)) ui.year = years[0];
  const r = C.yearReview(inputs(ui.year), ui.year);
  return html`${head}
    <div class="yr-pick" role="group" aria-label="Year">${years.map(y => html`<button type="button" data-year="${y}" aria-pressed="${String(y === ui.year)}">${y}</button>`)}</div>
    ${r ? reviewHtml(r) : emptyState('Nothing that year', 'No runs in ' + ui.year + '.', '')}
    ${postersHtml(years)}`;
}

// ---- drawing ----
// The year's tracks (this device's detail, privacy applied), nearest the year's main start area.
async function yearTracks(year, n = 160) {
  const ids = runsOf().filter(a => a.start.getFullYear() === year && !D.isVirtual(a)).map(a => a.id);
  const out = [];
  for (const id of ids) { const segs = await S.localTrack(id, n); if (segs && segs.length) out.push({ id, segs }); }
  return out;
}
function localCluster(tracks, km = 25) {
  if (!tracks.length) return [];
  const cells = new Map();
  for (const t of tracks) { const p = t.segs[0][0], k = C.cellKey(p[0], p[1], 0.2); cells.set(k, (cells.get(k) || 0) + 1); }
  const best = [...cells].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
  return tracks.filter(t => C.haversineM(t.segs[0][0][0], t.segs[0][0][1], best[0], best[1]) < km * 1000);
}
function drawHeat(g, tracks, x, y, w, h) {
  const near = localCluster(tracks);
  if (!near.length) return 0;
  // One fit for all of them: the union of their points.
  const all = near.flatMap(t => t.segs);
  const pix = C.fitSegments(all, w, h, w * 0.04);
  g.save(); g.globalCompositeOperation = 'lighter'; g.lineJoin = 'round'; g.lineCap = 'round';
  g.strokeStyle = 'rgba(63,184,196,0.35)'; g.lineWidth = Math.max(1.2, w / 400);
  for (const seg of pix) { g.beginPath(); seg.forEach(([px, py], i) => (i ? g.lineTo(x + px, y + py) : g.moveTo(x + px, y + py))); g.stroke(); }
  g.restore();
  return near.length;
}
async function heatThumb(el, year) {
  const cv = el.querySelector('#yrheat');
  if (!cv) return;
  const tracks = await yearTracks(year);
  if (!cv.isConnected) return;
  const g = cv.getContext('2d');
  g.fillStyle = '#0d1117'; g.fillRect(0, 0, cv.width, cv.height);
  if (!drawHeat(g, tracks, 0, 0, cv.width, cv.height)) { g.fillStyle = S.FAINT; g.font = `500 26px ${S.FONT}`; g.fillText('No tracks on this device for ' + year, 30, 60); }
}
async function yearCard(r) {
  const w = 1080, h = 1350, [cv, g] = S.cardBase(w, h);
  const tracks = await yearTracks(r.year);
  g.globalAlpha = 0.9; drawHeat(g, tracks, 540, 90, 480, 480); g.globalAlpha = 1;
  g.fillStyle = S.FAINT; g.font = `600 30px ${S.FONT}`; g.fillText(`${r.year} IN RUNNING`, 60, 130);
  g.fillStyle = S.TEAL; S.fitText(g, km(r.totals.distance_m), 460, 150); g.fillText(km(r.totals.distance_m), 60, 290);
  g.fillStyle = S.INK; g.font = `700 40px ${S.FONT}`; g.fillText('kilometres', 64, 345);
  g.fillStyle = S.FAINT; g.font = `500 30px ${S.FONT}`;
  g.fillText(`${r.totals.runs} runs · ${n0(r.totals.seconds / 3600)} h · ${n0(r.totals.ascent_m)} m up`, 60, 405);
  if (r.change != null) g.fillText(`${pct(r.change)} on ${r.year - 1}`, 60, 450);
  const rows = [
    r.longest && ['Longest run', (r.longest.distance_m / 1000).toFixed(1) + ' km'],
    r.busiestMonth && ['Busiest month', `${r.busiestMonth.name}, ${km(r.busiestMonth.distance_m)} km`],
    r.topWeeks[0] && ['Biggest week', (r.topWeeks[0].distance_m / 1000).toFixed(1) + ' km'],
    ['Week streak', `${r.longestWeekStreak} weeks`],
    r.route && ['Most-run route', `${r.route.name} ×${r.route.count}`],
    r.newTiles && r.newTiles.z17 && ['New ground', `${n0(r.newTiles.z17)} tiles`],
    ...r.bests.filter(b => b.pr).slice(-3).map(b => [`${distLabel(b.dist)} PR`, fmtTime(b.secs)]),
  ].filter(Boolean).slice(0, 9);
  rows.forEach(([label, value], i) => {
    const y = 640 + i * 66;
    g.fillStyle = S.FAINT; g.font = `600 24px ${S.FONT}`; g.fillText(label.toUpperCase(), 60, y);
    g.fillStyle = S.INK; S.fitText(g, value, 560, 40, 700); g.fillText(value, 460, y);
  });
  S.wordmark(g, w, h);
  return S.toBlob(cv);
}

async function poster(kind) {
  const runs = runsOf(), years = C.reviewYears(runs);
  if (kind === 'grid') {
    const scope = ui.posterScope, ys = scope === 'all' ? years : [+scope], tracks = [];
    for (const y of ys.sort((a, b) => a - b)) tracks.push(...(await yearTracks(y, 80)));
    return { name: `routes-${scope}.svg`, svg: C.routeGridSvg(tracks, { title: scope === 'all' ? 'Every route' : `Every route, ${scope}`, sub: `${tracks.length} runs · privacy zones applied` }) };
  }
  const days = C.dailyMetres(runs, () => true);
  if (kind === 'rings') return { name: 'year-rings.svg', svg: C.yearRingsSvg(days, years, { title: `${years[years.length - 1]}–${years[0]}` }) };
  return { name: 'every-day.svg', svg: C.contributionSvg(days, years) };
}

export function mount(el) {
  el.querySelectorAll('[data-year]').forEach(b => b.onclick = () => {
    ui.year = +b.dataset.year;
    el.innerHTML = String(render()); mount(el);
  });
  heatThumb(el, ui.year);
  const cardBtn = el.querySelector('[data-yr-card]');
  if (cardBtn) cardBtn.onclick = async () => {
    cardBtn.disabled = true;
    try { const r = C.yearReview(inputs(ui.year), ui.year); S.download(`run315-${ui.year}.png`, await yearCard(r)); }
    catch (e) { toast('The card did not draw: ' + e.message); }
    cardBtn.disabled = false;
  };
  const prev = el.querySelector('[data-poster-prev]'), dl = el.querySelector('[data-poster-dl]');
  const scope = el.querySelector('[data-poster-scope]');
  if (scope) scope.onchange = () => { ui.posterScope = scope.value; };
  let last = null;
  el.querySelectorAll('[data-poster]').forEach(b => b.onclick = async () => {
    b.disabled = true; prev.hidden = false; prev.innerHTML = '<p class="dim" style="padding:12px;margin:0">Drawing…</p>';
    try { last = await poster(b.dataset.poster); if (prev.isConnected) { prev.innerHTML = last.svg; dl.disabled = false; } }
    catch (e) { prev.innerHTML = ''; toast('The poster did not draw: ' + e.message); }
    b.disabled = false;
  });
  if (dl) dl.onclick = () => { if (last) S.download(last.name, last.svg, 'image/svg+xml'); };
}
