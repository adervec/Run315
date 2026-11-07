// Plan a new-ground run: the unrun streets of a loaded municipality (Streets & trails) and the
// unclaimed tiles that would grow the square (Territory), turned into one run that starts and
// finishes at home, routed by BRouter, exported as a GPX for the watch or saved to the Route
// maker library. The planning is js/explorer-route.js -- an orienteering-style heuristic, and
// the page says so; nothing here writes to Garmin or Strava (the GPX is a file the athlete
// moves to the watch).
//
// Street geometry is this device's `city-geo-<id>` cache (Streets & trails' "Load map data");
// coverage and the street list are the synced state.cities record. Tiles are the synced
// derived tiles, through js/explore.js.
import { state, save, idbGet, idbSet } from '../store.js';
import * as C from '../cities.js';
import * as E from '../explore.js';
import * as X from '../explorer-route.js';
import * as BS from '../bitset.js';
import { tileFor, tileKey } from '../lib/territory.js';
import { html, pageHead, emptyState, useCss, toast, link, fmtTime } from '../ui.js';
import { loadLeaflet, whenGone, token, saveRoute } from '../routemaker.js';

export const title = 'Plan a new-ground run';

const CSS = `
.plan { --target: #e8a33d; }
.plan-grid { display: grid; grid-template-columns: minmax(270px, 350px) 1fr; gap: 20px; align-items: start; }
.plan-grid > * { min-width: 0; }
.plan #planmap { height: 64vh; min-height: 420px; border-radius: 3px; background: var(--ground); }
.plan #planmap.picking { cursor: crosshair; }
.plan .leaflet-container { font-family: var(--body); }
.plan select, .plan input[type=number], .plan input[type=text] { width: 100%; }
.plan .field { margin-bottom: 12px; }
.plan .seg { display: flex; border: 1px solid var(--line); border-radius: 3px; overflow: hidden; margin-bottom: 12px; }
.plan .seg button { flex: 1 1 0; font: inherit; font-size: 13px; padding: 7px 6px; background: none; border: 0;
  color: var(--muted); cursor: pointer; }
.plan .seg button + button { border-left: 1px solid var(--line); }
.plan .seg button[aria-pressed="true"] { background: var(--measured); color: var(--on-ink); }
.plan .seg button:disabled { opacity: .45; cursor: not-allowed; }
.plan .sub-eyebrow { font-family: var(--mono); font-size: 10px; letter-spacing: .12em; text-transform: uppercase;
  color: var(--muted); margin: 16px 0 6px; }
.plan .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.plan .check { display: flex; gap: 8px; align-items: flex-start; font-size: 14px; margin: 6px 0 12px; }
.plan .check input { margin-top: 3px; }
.plan .status { font-family: var(--mono); font-size: 12px; color: var(--muted); min-height: 1.3em; margin: 8px 0 0; }
.plan .btns { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.plan .btns .btn { flex: 1 1 auto; text-align: center; }
.plan .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 0 24px; }
.plan .stats .stat { border-top: none; padding-top: 0; }
.plan .warn { color: var(--behind); font-size: 14px; }
.plan .note { font-size: 13px; color: var(--muted); margin: 10px 0 0; }
.plan .approx { display: inline-block; font-family: var(--mono); font-size: 10px; letter-spacing: .08em;
  text-transform: uppercase; padding: 2px 6px; border-radius: 2px; color: var(--projected);
  background: color-mix(in srgb, var(--projected) 14%, transparent); vertical-align: 2px; }
.plan .drop { font: inherit; font-size: 12px; background: none; border: 1px solid var(--line); border-radius: 2px;
  color: var(--muted); cursor: pointer; padding: 2px 7px; }
.plan .drop:hover { border-color: var(--behind); color: var(--behind); }
.plan .ok { color: var(--ahead); }
.plan .miss { color: var(--behind); }
.plan .legend { display: flex; gap: 8px 18px; flex-wrap: wrap; margin-top: 10px; font-family: var(--mono); font-size: 11px;
  letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
.plan .legend i { display: inline-block; width: 18px; height: 0; border-top: 3px solid; margin-right: 6px; vertical-align: 3px; }
.plan .lg-route { border-color: var(--measured); border-top-width: 4px !important; }
.plan .lg-target { border-color: var(--target); border-top-width: 5px !important; }
.plan .lg-unrun { border-color: var(--behind); }
.plan .lg-cand { border-color: var(--target); border-top-style: dashed !important; }
.wp-num { width: 22px; height: 22px; border-radius: 50%; background: #e8a33d; color: #111; border: 2px solid #fff;
  font: 600 11px/18px var(--mono); text-align: center; box-shadow: 0 1px 3px rgba(16, 24, 40, .45); }
@media (max-width: 860px) {
  .plan-grid { grid-template-columns: 1fr; }
  .plan-grid > .plan-mapcol { order: -1; }
  .plan #planmap { height: 48vh; min-height: 300px; }
}
`;

// This session's choices (module-level, so a Drive sync re-render keeps them).
const ui = { mode: 'streets', area: null, streetOrder: 'close', zoom: 17, tileOrder: 'growth',
  budgetBy: 'km', km: 10, min: 60, profile: 'hiking-mountain', click: 'start', postman: false, name: '' };
let start = null;                   // [lat, lon] chosen on the map; null = home
const picked = new Set();           // street keys ('s:Main St') and tile ids ('z17:x,y') clicked in
const dropped = new Set();          // targets the athlete struck off the automatic picks
let plan = null;                    // the last result (see doPlan)
let busy = false, progress = '', lastView = null;
const MAX_DRAWN = 15000;
const TARGET = '#e8a33d';           // a map colour on OSM tiles in either theme, as Territory's

const areasOf = () => Object.values(C.cities()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
const hasTiles = () => { try { return E.exploreIndex(state).tiles[17].size > 0; } catch { return false; } };
const kmTxt = (m, d = 1) => ((m || 0) / 1000).toFixed(d);
const fmtPt = p => `${p[0].toFixed(4)}, ${p[1].toFixed(4)}`;

function startPt() { return start || C.homePoint(state); }
function paceS() {
  const cyc = X.isCycling(ui.profile);
  return X.typicalPace(Object.values(state.activities || {}), cyc) || (cyc ? 144 : 360);
}
function budgetM() {
  return ui.budgetBy === 'km' ? Math.max(1, +ui.km || 0) * 1000 : (Math.max(5, +ui.min || 0) * 60 / paceS()) * 1000;
}
const wantStreets = () => ui.mode !== 'tiles';
const wantTiles = () => ui.mode !== 'streets';

// ---------- panels ----------

function seg(name, val, label, disabled = false) {
  return html`<button type="button" data-ui="${name}" data-val="${val}" aria-pressed="${String(String(ui[name]) === String(val))}" ${disabled ? 'disabled' : ''}>${label}</button>`;
}

function controls(areas, tilesOk) {
  const pace = paceS(), cyc = X.isCycling(ui.profile);
  const s = startPt();
  const pickedS = [...picked].filter(k => k[1] === ':').length, pickedT = picked.size - pickedS;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">What to run</p></div>
    <div class="seg" role="group" aria-label="Targets">
      ${seg('mode', 'streets', 'Unrun streets', !areas.length)}${seg('mode', 'tiles', 'Missing tiles', !tilesOk)}${seg('mode', 'both', 'Both', !areas.length || !tilesOk)}
    </div>

    ${wantStreets() ? html`<p class="sub-eyebrow">Streets</p>
      <div class="field"><label for="pr-area">Area</label>
        <select id="pr-area">${areas.map(a => html`<option value="${a.id}" ${a.id === ui.area ? 'selected' : ''}>${a.name}</option>`)}</select></div>
      <div class="field"><label for="pr-sorder">Pick streets</label>
        <select id="pr-sorder">
          ${[['close', 'Closest to done first'], ['untouched', 'Untouched, nearest the start'], ['manual', 'Only the ones I click']].map(([k, l]) =>
            html`<option value="${k}" ${ui.streetOrder === k ? 'selected' : ''}>${l}</option>`)}
        </select></div>
      <label class="check"><input type="checkbox" id="pr-postman" ${ui.postman ? 'checked' : ''}>
        <span>One continuous route over the streets, repeating as little as possible
          <span class="approx">approximate</span><br><span class="dim" style="font-size:13px">Chinese-postman-lite, up to
          ${X.MAX_POSTMAN_STREETS} streets: the ones you click, else the plan's picks. Ignores tiles and the budget.</span></span></label>` : ''}

    ${wantTiles() ? html`<p class="sub-eyebrow">Tiles</p>
      <div class="seg" role="group" aria-label="Grid">${seg('zoom', 17, 'z17 · ~300 m')}${seg('zoom', 14, 'z14 · ~1.7 km')}</div>
      <div class="field"><label for="pr-torder">Pick tiles</label>
        <select id="pr-torder">
          ${[['growth', 'Ones that would grow the square'], ['manual', 'Only the ones I click']].map(([k, l]) =>
            html`<option value="${k}" ${ui.tileOrder === k ? 'selected' : ''}>${l}</option>`)}
        </select></div>` : ''}

    <p class="sub-eyebrow">How far</p>
    <div class="seg" role="group" aria-label="Budget">${seg('budgetBy', 'km', 'Distance')}${seg('budgetBy', 'min', 'Time')}</div>
    ${ui.budgetBy === 'km'
      ? html`<div class="field"><label for="pr-km">Target distance (km)</label><input type="number" id="pr-km" min="1" max="200" step="0.5" value="${ui.km}"></div>`
      : html`<div class="field"><label for="pr-min">Target time (minutes)</label><input type="number" id="pr-min" min="5" max="600" step="5" value="${ui.min}">
        <span class="stat-hint">≈ ${kmTxt(budgetM())} km at ${fmtTime(pace)} /km, your median ${cyc ? 'ride' : 'run'} pace lately</span></div>`}
    <div class="field"><label for="pr-profile">Routing profile</label>
      <select id="pr-profile">${X.PROFILES.map(([k, l]) => html`<option value="${k}" ${ui.profile === k ? 'selected' : ''}>${l}</option>`)}</select></div>

    <p class="sub-eyebrow">Start</p>
    <p style="margin:0 0 6px;font-size:14px">${start ? html`Chosen on the map · <span class="dim">${fmtPt(start)}</span>
      <button type="button" class="drop" id="pr-home">use home</button>`
      : s ? html`Home, your most common start · <span class="dim">${fmtPt(s)}</span>` : html`<span class="warn">No home point yet — click the map to choose a start.</span>`}</p>

    <p class="sub-eyebrow">Clicking the map</p>
    <div class="seg" role="group" aria-label="Map click">
      ${seg('click', 'start', 'Sets start')}${seg('click', 'street', 'Picks streets', !wantStreets())}${seg('click', 'tile', 'Picks tiles', !wantTiles())}
    </div>
    <p class="stat-hint" id="pr-picks" style="margin-top:0">${picked.size ? `Clicked in: ${pickedS} street${pickedS === 1 ? '' : 's'}, ${pickedT} tile${pickedT === 1 ? '' : 's'} — always included.` : 'Streets and tiles you click are always included; the automatic picks fill the rest of the budget.'}
      ${picked.size ? html` <button type="button" class="drop" id="pr-clearpicks">clear</button>` : ''}
      ${dropped.size ? html` · ${dropped.size} struck off <button type="button" class="drop" id="pr-cleardrops">restore</button>` : ''}</p>

    <div class="btns"><button class="btn" type="button" id="pr-plan" ${busy ? 'disabled' : ''}>${plan ? 'Re-plan' : 'Plan the run'}</button></div>
    <p class="status" id="pr-status" role="status">${progress}</p>
  </section>`;
}

function mapPanel() {
  return html`<section class="panel" style="padding:0;overflow:hidden"><div id="planmap"></div></section>
    <div class="legend"><span><i class="lg-route"></i>Planned route</span><span><i class="lg-target"></i>Target in the plan</span>
      <span><i class="lg-cand"></i>Candidate / clicked</span>${wantStreets() ? html`<span><i class="lg-unrun"></i>Unrun street</span>` : ''}</div>`;
}

function resultPanel() {
  if (!plan) return '';
  const r = plan.route, targets = plan.tour.map(o => o.t);
  if (!targets.length) return html`<section class="panel"><div class="panel-head"><p class="eyebrow">The plan</p></div>
    <p class="warn">Nothing fits: no target is close enough to get there and back in ${kmTxt(plan.budgetM)} km. Raise the
      distance, move the start, or click a target in to force it.</p></section>`;
  const covered = targets.filter(t => (plan.cover.get(t.id) || 0) >= (t.kind === 'tile' ? 1 : 0.9)).length;
  const over = r && r.lengthM > plan.budgetM * 1.1;
  const pm = plan.postman;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">The plan ${pm ? html`<span class="approx">approximate</span>` : ''}</p>
      <p class="panel-note">${pm ? 'Chinese-postman-lite' : 'Orienteering heuristic'} · BRouter ${X.PROFILES.find(p => p[0] === plan.profile)?.[1] || plan.profile}</p></div>
    <div class="stats">
      <div class="stat"><div class="stat-value">${kmTxt(r.lengthM, 2)}<small class="unit">km</small></div><div class="stat-label">Distance</div>
        <div class="stat-hint">target ${kmTxt(plan.budgetM)} km</div></div>
      <div class="stat"><div class="stat-value">${Math.round(r.climbM || 0)}<small class="unit">m</small></div><div class="stat-label">Climb</div></div>
      <div class="stat"><div class="stat-value">${fmtTime((r.lengthM / 1000) * plan.pace)}</div><div class="stat-label">At your pace</div>
        <div class="stat-hint">${fmtTime(plan.pace)} /km median</div></div>
      <div class="stat"><div class="stat-value">${covered}<small class="unit">/ ${targets.length}</small></div><div class="stat-label">Targets covered</div>
        <div class="stat-hint">checked on the routed line</div></div>
    </div>
    ${over && !pm ? html`<p class="warn">The routed line is ${kmTxt(r.lengthM - plan.budgetM)} km over the target: the targets you clicked in do not fit. Strike some off and re-plan.</p>` : ''}
    <p class="note">${pm
      ? `One continuous route over ${targets.length} street${targets.length === 1 ? '' : 's'}: ${pm.odd} dead end${pm.odd === 1 ? '' : 's'} or odd junction${pm.odd === 1 ? '' : 's'} — the two nearest home are where the run leaves and rejoins the streets, the rest paired greedily (closest first, not an optimal matching) into ${pm.repeats} repeated stretch${pm.repeats === 1 ? '' : 'es'}, ${pm.links} link${pm.links === 1 ? '' : 's'} between separate streets. Junctions are guessed from the 25 m nodes; the repeated stretches are whatever BRouter finds. Street length ${kmTxt(pm.streetM, 2)} km of the ${kmTxt(r.lengthM, 2)} km.`
      : `Targets chosen nearest-neighbour from the start under the budget, the order improved with 2-opt, every leg estimated at the straight line × ${plan.detour.toFixed(2)}${plan.detour !== X.DETOUR ? ` (learned from BRouter; it started at × ${X.DETOUR})` : ''}, then routed for real — ${plan.rounds} routing round${plan.rounds === 1 ? '' : 's'}. A heuristic: a good run, not the provably best one.`}
      ${r.calls ? ` ${r.calls} BRouter request${r.calls === 1 ? '' : 's'}` : ''}${r.cached ? `${r.calls ? ',' : ''} ${r.cached} leg${r.cached === 1 ? '' : 's'} from this week's cache` : ''}.
      ${plan.skipped ? ` ${plan.skipped} more candidate${plan.skipped === 1 ? '' : 's'} did not fit.` : ''}</p>
    <div class="table-scroll" style="margin-top:12px"><table>
      <thead><tr><th>#</th><th>Target</th><th class="num">To run</th><th class="num">Route covers</th><th></th></tr></thead>
      <tbody>${targets.map((t, i) => {
        const c = plan.cover.get(t.id) || 0, ok = t.kind === 'tile' ? c >= 1 : c >= 0.9;
        return html`<tr>
          <td class="num dim">${i + 1}</td>
          <td>${t.name}${picked.has(t.id) ? html` <span class="dim">· clicked</span>` : ''}<br><span class="dim" style="font-size:12px">${t.kind === 'street' ? `street · ${Math.round(t.pct * 100)}% done before` : 'tile · unclaimed'}</span></td>
          <td class="num dim">${t.kind === 'street' ? `${kmTxt(t.unrun_m, 2)} km` : '—'}</td>
          <td class="num ${ok ? 'ok' : 'miss'}">${t.kind === 'tile' ? (c ? 'passes through' : 'misses it') : `${Math.round(c * 100)}%`}</td>
          <td><button type="button" class="drop" data-drop="${t.id}" title="Strike off and re-plan">drop</button></td>
        </tr>`;
      })}</tbody>
    </table></div>
    <p class="note">A tile is visited through its centre; if that is a pond or a rail yard BRouter routes to the nearest path, which can
      fall outside the tile — those show as “misses it”. A street counts as covered at 90% of its unrun nodes within 30 m of the line.</p>
    <div class="form-row" style="margin-top:14px">
      <div class="field field-grow" style="margin:0"><label for="pr-name">Name</label>
        <input type="text" id="pr-name" maxlength="120" value="${ui.name || plan.defaultName}"></div>
      <button class="btn" type="button" id="pr-gpx">Download GPX</button>
      <button class="btn btn-ghost" type="button" id="pr-save">Save &amp; open in Route maker</button>
    </div>
    <p class="note">The GPX holds the track and a named waypoint at each target. Move it to the watch yourself (Garmin Connect's
      course import, or copy it into the watch's GPX folder) — Run315 never writes to Garmin or Strava.
      Route maker keeps at most 50 points and re-routes between them${plan.pts.length > 50 ? ', so this plan is saved as 50 points read off the routed line' : ''}.</p>
  </section>`;
}

export async function render() {
  useCss('plan-route', CSS);
  const areas = areasOf(), tilesOk = hasTiles();
  if (ui.area && !C.cities()[ui.area]) ui.area = null;
  if (!ui.area && areas.length) ui.area = areas[0].id;
  if (!areas.length && tilesOk) ui.mode = 'tiles';
  if (areas.length && !tilesOk) ui.mode = 'streets';
  if ((ui.click === 'street' && !wantStreets()) || (ui.click === 'tile' && !wantTiles())) ui.click = 'start';
  const head = pageHead('Plan a new-ground run', 'Unrun streets and unclaimed tiles, turned into one run for the watch',
    html`${link('cities', 'Streets & trails', 'btn btn-ghost')}${link('territory', 'Territory', 'btn btn-ghost')}${link('routes', 'Route maker', 'btn btn-ghost')}`);
  if (!areas.length && !tilesOk) {
    return html`<div class="plan">${head}${emptyState('Nothing to explore from yet',
      'This planner works from two things: the streets of a town loaded on Streets & trails, and the territory tiles your GPS runs claim. Load your town, or sync a few outdoor runs, and come back.',
      html`<p>${link('cities', 'Load a town', 'btn')} ${link('sync', 'Sync & cowork', 'btn btn-ghost')}</p>`)}</div>`;
  }
  let geoNote = '';
  if (wantStreets() && ui.area && !(await C.localGeo(ui.area))) {
    geoNote = html`<section class="panel"><p class="warn" style="margin:0">The street lines for ${C.cities()[ui.area]?.name || 'this area'} are not on this
      device. Open ${link('cities', 'Streets & trails')} and press “Load map data” first.</p></section>`;
  }
  return html`<div class="plan">${head}
    <div class="plan-grid">
      <div>${controls(areas, tilesOk)}</div>
      <div class="plan-mapcol">${geoNote}${mapPanel()}${resultPanel()}</div>
    </div>
  </div>`;
}

// ---------- planning ----------

function tileTargetsFor(st, s, budget) {
  const z = ui.zoom, claimed = E.exploreIndex(st).tiles[z], forced = [], optional = [];
  for (const id of picked) {
    const t = X.parseTileId(id);
    if (t && t.zoom === z && !claimed.has(tileKey(t.x, t.y))) forced.push(X.tileTarget(t.x, t.y, z));
  }
  if (ui.tileOrder === 'growth') {
    for (const [tile] of E.scoresFor(st, z, true).targets || []) {
      const t = X.tileTarget(tile[0], tile[1], z);
      if (dropped.has(t.id) || 2 * X.distM(s, t.a) * X.DETOUR > budget) continue;
      optional.push(t);
    }
  }
  return { forced, optional };
}

async function doPlan(say) {
  const s = startPt();
  if (!s) throw new Error('Click the map to choose a start first.');
  const budget = budgetM(), forced = [], optional = [];
  let streetSet = [];
  if (wantStreets()) {
    const geo = ui.area ? await C.localGeo(ui.area) : null, rec = C.cities()[ui.area];
    if (!geo) throw new Error('This device has no street lines for that area yet: Streets & trails → Load map data.');
    const ways = X.wayIndex(geo);
    for (const k of picked) if (k[1] === ':' && geo.groups[k]) { const t = X.streetTarget(geo, rec, k, ways); if (t) forced.push(t); }
    if (ui.streetOrder !== 'manual') {
      for (const k of X.streetCandidates(geo, rec, { start: s, budgetM: budget, order: ui.streetOrder, limit: 40 })) {
        if (dropped.has(k) || picked.has(k)) continue;
        const t = X.streetTarget(geo, rec, k, ways);
        if (t) optional.push(t);
      }
    }
    streetSet = forced.slice();
  }
  if (wantTiles() && !(ui.postman && wantStreets())) {
    const t = tileTargetsFor(state, s, budget);
    forced.push(...t.forced); optional.push(...t.optional);
  }
  if (!forced.length && !optional.length) throw new Error('Nothing to aim for within reach: raise the distance, or click streets or tiles on the map.');
  const router = pts => X.routeVia(pts, ui.profile, {
    fetchFn: u => fetch(u),
    cacheGet: k => idbGet('cache', k), cacheSet: (k, v) => idbSet('cache', k, v),
    onProgress: (i, n) => say(`Asking BRouter… leg ${i} of ${n}`),
  });
  let result;
  if (ui.postman && wantStreets()) {
    // The streets: the clicked ones, else the ones the orienteering plan would pick.
    if (!streetSet.length) streetSet = X.planTour({ start: s, optional, budgetM: budget }).tour.map(o => o.t);
    streetSet = streetSet.slice(0, X.MAX_POSTMAN_STREETS);
    const pm = X.postman(s, streetSet);
    if (!pm) throw new Error('No streets to cover.');
    say(`Covering ${streetSet.length} streets as one route…`);
    const route = await router(pm.pts);
    // A waypoint per street where the route first comes near it.
    const marks = streetSet.map(t => {
      let at = 0, bd = Infinity;
      pm.pts.forEach((p, i) => { const d = X.distM(p, t.a); if (d < bd) { bd = d; at = i; } });
      return { at, target: t };
    }).sort((a, b) => a.at - b.at);
    result = { tour: marks.map(m => ({ t: m.target, rev: false })), route, pts: pm.pts, marks, detour: X.DETOUR, rounds: 1, skipped: [], postman: pm };
  } else {
    result = await X.planAndRoute({ start: s, forced, optional, budgetM: budget, router,
      onRound: (n, p) => say(`Round ${n}: ${p.tour.length} targets, ~${kmTxt(p.estM)} km estimated…`) });
  }
  if (!result.route) { plan = { ...result, tour: [], budgetM: budget, cover: new Map() }; return; }
  const targets = result.tour.map(o => o.t);
  const area = C.cities()[ui.area];
  plan = { ...result, skipped: (result.skipped || []).length, cover: X.coverage(result.route.coords, targets),
    budgetM: budget, profile: ui.profile, pace: paceS(), start: s,
    defaultName: `New ground ${wantStreets() && area ? area.name + ' ' : ''}${kmTxt(result.route.lengthM)} km` };
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/gpx+xml' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = (name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'new-ground') + '.gpx';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);   // revoking synchronously can cancel the download
}

// ---------- mount ----------

export async function mount(el) {
  const redraw = async () => { if (!el.isConnected) return; el.innerHTML = String(await render()); mount(el); };
  const say = msg => { progress = msg; const p = el.querySelector('#pr-status'); if (p) p.textContent = msg; };

  el.querySelectorAll('[data-ui]').forEach(b => b.onclick = () => {
    const k = b.dataset.ui, v = b.dataset.val;
    ui[k] = k === 'zoom' ? +v : v;
    redraw();
  });
  const bind = (sel, key, num = false, re = false) => {
    const n = el.querySelector(sel);
    if (n) n.onchange = () => { ui[key] = num ? +n.value : n.value; if (re) redraw(); };
  };
  bind('#pr-area', 'area', false, true);
  bind('#pr-sorder', 'streetOrder');
  bind('#pr-torder', 'tileOrder');
  bind('#pr-km', 'km', true);
  bind('#pr-min', 'min', true, true);
  bind('#pr-profile', 'profile', false, true);
  const pmBox = el.querySelector('#pr-postman');
  if (pmBox) pmBox.onchange = () => { ui.postman = pmBox.checked; };
  const nm = el.querySelector('#pr-name');
  if (nm) nm.oninput = () => { ui.name = nm.value; };
  const on = (sel, fn) => { const n = el.querySelector(sel); if (n) n.onclick = fn; };
  on('#pr-home', () => { start = null; redraw(); });
  on('#pr-clearpicks', () => { picked.clear(); redraw(); });
  on('#pr-cleardrops', () => { dropped.clear(); redraw(); });

  const runPlan = async () => {
    if (busy) return toast('Still planning the last one.');
    busy = true;
    const b = el.querySelector('#pr-plan'); if (b) b.disabled = true;
    say('Planning…');
    try { await doPlan(say); }
    catch (e) { console.error(e); toast('⚠ ' + (e.message || e), 7000); }
    finally { busy = false; progress = ''; await redraw(); }
  };
  on('#pr-plan', runPlan);
  el.querySelectorAll('[data-drop]').forEach(b => b.onclick = () => {
    const id = b.dataset.drop;
    picked.delete(id); dropped.add(id);
    runPlan();
  });
  on('#pr-gpx', () => {
    if (!plan || !plan.route) return;
    const name = (el.querySelector('#pr-name')?.value || '').trim() || plan.defaultName;
    download(name, X.buildGpx(name, plan.route.coords, X.gpxWaypoints(plan, plan.cover)));
  });
  on('#pr-save', () => {
    if (!plan || !plan.route) return;
    const name = (el.querySelector('#pr-name')?.value || '').trim() || plan.defaultName;
    if (Object.values(state.routes || {}).some(r => r.name === name) && !confirm(`Overwrite the saved route "${name}"?`)) return;
    try {
      saveRoute(state, { name, profile: plan.profile, rtype: 'p2p', pts: X.libraryPoints(plan.pts, plan.route.coords) });
      save('edit');
      toast(`Saved “${name}”. Open it from Saved routes.`, 5000);
      location.hash = '#/routes';
    } catch (e) { toast('⚠ ' + e.message, 6000); }
  });

  // ---- the map ----
  const box = el.querySelector('#planmap');
  if (!box) return;
  let L;
  try { L = await loadLeaflet(); } catch (e) { say(e.message); return; }
  if (!box.isConnected) return;
  const map = L.map(box, { preferCanvas: true });
  whenGone(box, () => {
    try { const c = map.getCenter(); lastView = [[c.lat, c.lng], map.getZoom()]; } catch { /* detached */ }
    map.remove();
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  const s = startPt(), area = ui.area && C.cities()[ui.area];
  if (lastView) map.setView(lastView[0], lastView[1]);
  else if (plan && plan.route) map.fitBounds(plan.route.coords.map(c => [c[0], c[1]]), { padding: [20, 20] });
  else if (s) map.setView(s, 14);
  else if (area && area.bbox && area.bbox.length === 4) map.fitBounds([[area.bbox[0], area.bbox[1]], [area.bbox[2], area.bbox[3]]]);
  else map.setView([43.86, -79.33], 12);
  requestAnimationFrame(() => { try { map.invalidateSize(); } catch { /* gone */ } });
  const tip = text => () => { const sp = document.createElement('span'); sp.textContent = text; return sp; };
  const cUnrun = token('--behind', '#a5321f'), cRoute = token('--measured', '#0b6e79');

  // Unrun streets of the area, thin, for picking by click.
  const geo = wantStreets() && ui.area ? await C.localGeo(ui.area) : null;
  if (!box.isConnected) return;
  if (geo) {
    let drawn = 0;
    for (const w of geo.ways) {
      if (w.t !== 's' || !w.g) continue;
      if (drawn++ >= MAX_DRAWN) break;
      const bits = area && area.cover && area.cover[w.k] ? BS.decode(area.cover[w.k], w.c.length) : null;
      for (const p of C.pieces(w.c, bits, false)) L.polyline(p, { color: cUnrun, weight: 2, opacity: 0.6 }).bindTooltip(tip(w.g.slice(2))).addTo(map);
    }
  }
  const overlay = L.layerGroup().addTo(map);
  const ways = geo ? X.wayIndex(geo) : null;
  function drawTarget(t, inPlan) {
    if (t.kind === 'street') for (const p of t.chain) {
      L.polyline(p, { color: TARGET, weight: inPlan ? 6 : 4, dashArray: inPlan ? null : '6 5', opacity: 0.95 }).bindTooltip(tip(t.name)).addTo(overlay);
    } else {
      const [ss, ww, nn, ee] = t.bounds;
      L.rectangle([[ss, ww], [nn, ee]], { color: TARGET, weight: inPlan ? 2.5 : 1.5, dashArray: inPlan ? null : '5 4',
        fillColor: TARGET, fillOpacity: inPlan ? 0.35 : 0.15 }).bindTooltip(tip(t.name)).addTo(overlay);
    }
  }
  function drawOverlay() {
    overlay.clearLayers();
    const inPlan = new Set(plan ? plan.tour.map(o => o.t.id) : []);
    // Candidates the planner would consider: the square's growth tiles; clicked streets and tiles.
    if (wantTiles() && ui.tileOrder === 'growth' && !plan) {
      try { for (const [tile] of E.scoresFor(state, ui.zoom, true).targets || []) drawTarget(X.tileTarget(tile[0], tile[1], ui.zoom), false); } catch { /* no tiles */ }
    }
    for (const id of picked) {
      if (inPlan.has(id)) continue;
      const tt = X.parseTileId(id);
      if (tt) { if (tt.zoom === ui.zoom) drawTarget(X.tileTarget(tt.x, tt.y, tt.zoom), false); continue; }
      if (geo) { const t = X.streetTarget(geo, area, id, ways); if (t) drawTarget(t, false); }
    }
    if (plan && plan.route) {
      L.polyline(plan.route.coords.map(c => [c[0], c[1]]), { color: cRoute, weight: 5, opacity: 0.9, interactive: false }).addTo(overlay);
      for (const o of plan.tour) drawTarget(o.t, true);
      plan.marks.forEach(({ at, target }, i) => {
        const p = target.kind === 'tile' ? target.a : plan.pts[at];
        L.marker(p, { icon: L.divIcon({ className: '', html: `<div class="wp-num">${i + 1}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }) })
          .bindTooltip(tip(`${i + 1}. ${target.name}`)).addTo(overlay);
      });
    }
    const sp = startPt();
    if (sp) L.circleMarker(sp, { radius: 8, color: '#fff', weight: 3, fillColor: cRoute, fillOpacity: 1 }).bindTooltip(tip(start ? 'Start' : 'Start · home')).addTo(overlay);
  }
  drawOverlay();
  if (ui.click !== 'start') box.classList.add('picking');

  map.on('click', ev => {
    const p = [ev.latlng.lat, ev.latlng.lng];
    if (ui.click === 'start') { start = p; plan = null; redraw(); return; }
    if (ui.click === 'tile') {
      const t = tileFor(p[0], p[1], ui.zoom);
      if (!t) return;
      if (E.exploreIndex(state).tiles[ui.zoom].has(tileKey(t[0], t[1]))) return toast('You have already claimed that tile.');
      const id = X.tileTarget(t[0], t[1], ui.zoom).id;
      if (picked.has(id)) picked.delete(id); else { picked.add(id); dropped.delete(id); }
    } else if (ui.click === 'street') {
      if (!geo) return toast('Load this area\'s map data on Streets & trails first.');
      const k = X.streetAt(geo, p, Math.max(25, 40 * 2 ** (15 - map.getZoom())));
      if (!k) return toast('No street there — click closer to a red line.');
      if (!X.streetTarget(geo, area, k, ways)) return toast('That street is already run.');
      if (picked.has(k)) picked.delete(k); else { picked.add(k); dropped.delete(k); }
    }
    drawOverlay();
    const hint = el.querySelector('#pr-picks');
    if (hint) {
      const ns = [...picked].filter(k => k[1] === ':').length;
      hint.textContent = `Clicked in: ${ns} street${ns === 1 ? '' : 's'}, ${picked.size - ns} tile${picked.size - ns === 1 ? '' : 's'} — always included. Re-plan to use them.`;
    }
  });
}
