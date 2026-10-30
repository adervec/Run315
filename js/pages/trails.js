// Trail completion: which named trails you have run end to end -- the CityStrides model,
// pointed at trails instead of streets (js/lib/trails.js has the engine).
//
// Where things live now that there is no server:
//   state.trailAreas[id]          synced. The area (name, bbox), a compact index of its
//                                 ways ({way id: [name, kind, nodes, length]}), the covered
//                                 nodes as a base64 bitset per way (js/bitset.js; older
//                                 records carry '0'/'1' strings, read either way and
//                                 rewritten as bitsets on first visit) OR'd across every matched
//                                 run, and the new ground per trail per day. Enough for the
//                                 phone to show the ledger, coverage and streaks with no
//                                 streams and no OSM geometry.
//   cache `trail-area-<id>`       this device only: the OSM ways themselves. Re-fetchable
//                                 bulk, so a device without them gets a "load segments"
//                                 button rather than a sync of megabytes of geometry.
//   cache `trail-hits-<activity>` this device only: one run's hit masks, kept so loading
//                                 another area or re-scoring never re-reads a stream.
//   cache `trail-matched`         {activity id: [area ids it was matched against]}, the
//                                 old trail_matched table: what still needs matching.
import { state, save, idbGet, idbSet, idbDel, streamIds } from '../store.js';
import { put, remove } from '../merge.js';
import * as D from '../derive.js';
import * as TR from '../lib/trails.js';
import * as BS from '../bitset.js';
import { fetchStream } from '../drive.js';
import { dayKey } from '../lib/dt.js';
import { html, pageHead, day, toast, useCss, polyline } from '../ui.js';
import { loadLeaflet, whenGone, token, overpass } from '../routemaker.js';

export const title = 'Trails';

const MAX_AREA_SQ_DEG = 0.45;    // bigger than this melts a free mirror
const MAX_DRAWN = 3000;          // ponytail: hard cap on ways drawn; paginate by bbox if it bites
let namedOnly = true, hideDone = false;
let lastView = null;             // the map stays where you left it across a re-render
let busy = false;

const CSS = `
.trails #trailmap { height: 58vh; min-height: 400px; border-radius: 3px; background: var(--ground); }
.trails .leaflet-container { font-family: var(--body); }
.trails .cover-bar {
  display: block; height: 6px; background: var(--track); border-radius: 3px;
  overflow: hidden; margin-top: 5px; min-width: 90px;
}
.trails .cover-bar i { display: block; height: 100%; background: var(--measured); }
.trails .cover-bar i.done { background: var(--ahead); }
.trails .tick { color: var(--ahead); font-weight: 600; }
.trails .filters { display: flex; gap: 14px; flex-wrap: wrap; align-items: center;
           font-family: var(--mono); font-size: 11px; letter-spacing: 0.08em;
           text-transform: uppercase; }
.trails .filters button { font: inherit; letter-spacing: inherit; text-transform: inherit; background: none; border: 0;
  padding: 0; cursor: pointer; color: var(--muted); border-bottom: 1px solid var(--line); }
.trails .filters button.on { color: var(--projected); border-bottom-color: var(--projected); }
.trails .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0 28px; }
.trails .totals .stat { border-top: none; padding-top: 0; }
.trails .area-actions { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
.trails .finished-list { margin: 10px 0 0; padding: 0; list-style: none; font-size: 14px; }
.trails .finished-list li { display: flex; justify-content: space-between; gap: 12px; padding: 4px 0; border-top: 1px solid var(--line); }
.trails .ground-curve { height: 110px; margin-top: 12px; }
@media (max-width: 600px) { .trails #trailmap { height: 48vh; min-height: 300px; } }
`;

// ---------- small codecs ----------
// '0'/'1' strings stay the format of the device-local hit cache (trail-hits-*), which never
// syncs. The synced cover is a base64 bitset: a sixth of the size (5.4 MB -> under 1 MB for
// five areas). coverMask() reads either, so records synced before the switch still work.
const bits = mask => Array.from(mask, b => (b ? '1' : '0')).join('');
const unbits = s => Uint8Array.from(String(s || ''), c => (c === '1' ? 1 : 0));
const coverMask = (s, n) => BS.toMask(BS.decode(s, n), n);
const coverOnes = (s, n) => BS.count(BS.decode(s, n).subarray(0, BS.bytesFor(n)));
const encodeCover = mask => BS.toB64(BS.fromMask(mask));

// Rewrite any area still holding '0'/'1' covers as bitsets. -> number of areas changed.
export function migrateCovers(st) {
  let changed = 0;
  for (const a of Object.values(st.trailAreas || {})) {
    const ways = a.ways || {};
    const legacy = Object.entries(a.cover || {}).filter(([w, s]) => ways[w] && BS.isLegacy(s, ways[w][2]));
    if (!legacy.length) continue;
    const cover = { ...a.cover };
    for (const [w, s] of legacy) { const enc = encodeCover(coverMask(s, ways[w][2])); if (enc) cover[w] = enc; else delete cover[w]; }
    put(st, 'trailAreas', a.id, { ...a, cover });
    changed++;
  }
  return changed;
}
const areaKey = id => 'trail-area-' + id;
const hitsKey = id => 'trail-hits-' + id;
const areasOf = st => Object.values(st.trailAreas).sort((a, b) => String(b.loaded_at).localeCompare(String(a.loaded_at)));
const pct0 = v => (v * 100).toFixed(0);

// overpass_trail_query(): every walkable way in a bbox, plus the routes naming them.
// The relation half is what gives unnamed ways a name -- that is how members of a
// long-distance trail get identified at all.
export function trailQuery(bbox, sidewalks = false) {
  const notSide = sidewalks ? '' : '["footway"!~"^(sidewalk|crossing)$"]';
  const box = bbox.map(v => v.toFixed(6)).join(',');
  return '[out:json][timeout:180];'
    + 'way["highway"~"^(path|footway|track|bridleway|cycleway|steps)$"]'
    + notSide + '["access"!~"^(private|no)$"](' + box + ')->.w;'
    + '.w out geom;'
    + 'rel(bw.w)["route"];'
    + 'out body;';
}

// This device's copy of an area's ways, as TR.Segment objects, or null.
async function localSegs(id) {
  try {
    const rec = await idbGet('cache', areaKey(id));
    return rec && rec.segs ? rec.segs.map(s => TR.Segment(s)) : null;
  } catch { return null; }
}
export const storeSegs = (id, segs) => idbSet('cache', areaKey(id), { fetched_at: new Date().toISOString(),
  segs: segs.map(s => ({ id: s.id, name: s.name, kind: s.kind, motor: s.motor, len_m: +s.len_m.toFixed(1),
    coords: s.coords.map(([a, b]) => [+a.toFixed(6), +b.toFixed(6)]) })) });

// ---------- the ledger, from the synced area summaries (build_trails) ----------
// A trail is complete when the share of its 25 m nodes you have been within 25 m of
// crosses `completeAt`. Reads only state.trailAreas, so the phone gets it too.
export function buildTrails(st, { completeAt = TR.DEFAULT_COMPLETE_AT, named = false } = {}) {
  const grouped = new Map(), seen = new Set();
  for (const a of areasOf(st)) for (const [wid, [name, kind, nodes, len]] of Object.entries(a.ways || {})) {
    // First area to claim a way keeps it, as the trail_segments table did.
    if (seen.has(wid)) continue;
    seen.add(wid);
    if (named && !name) continue;
    const key = TR.trailKey({ id: wid, name });
    let t = grouped.get(key);
    if (!t) grouped.set(key, t = { key, name: name || 'Unnamed way ' + wid, named: !!name, nodes: 0, hit: 0, len_m: 0, kinds: new Set() });
    t.nodes += nodes;
    t.hit += Math.min(coverOnes(a.cover && a.cover[wid], nodes), nodes);
    t.len_m += len;
    t.kinds.add(kind);
  }
  if (!seen.size) return [[], null];
  const out = [...grouped.values()].map(t => {
    const pct = t.nodes ? t.hit / t.nodes : 0;
    return { ...t, pct, done_m: t.len_m * pct, complete: pct >= completeAt, kinds: [...t.kinds].sort() };
  });
  out.sort((a, b) => (b.pct - a.pct) || (b.len_m - a.len_m) || a.name.localeCompare(b.name));
  const totals = {
    trails: out.length,
    complete: out.filter(t => t.complete).length,
    started: out.filter(t => t.pct > 0 && t.pct < completeAt).length,
    len_km: out.reduce((s, t) => s + t.len_m, 0) / 1000,
    done_km: out.reduce((s, t) => s + t.done_m, 0) / 1000,
    complete_at: completeAt,
    segments: seen.size,
  };
  totals.pct = totals.len_km ? totals.done_km / totals.len_km : 0;
  return [out, totals];
}

// ---------- chronology, from the synced per-day gains ----------
// TR.chronology's answers -- new ground per day, the day each trail crossed the line,
// the cumulative curve -- rebuilt from each area's [day, trail, nodes, metres] gains,
// so they need neither streams nor geometry. Areas never share a way, so summing their
// gains is the same replay chronology() does over everything at once.
export function newGround(st, completeAt = TR.DEFAULT_COMPLETE_AT, today = dayKey(new Date())) {
  const total = new Map(), seen = new Set(), rows = [];
  for (const a of areasOf(st)) {
    for (const [wid, [name, , nodes]] of Object.entries(a.ways || {})) {
      if (seen.has(wid)) continue;
      seen.add(wid);
      const k = TR.trailKey({ id: wid, name });
      total.set(k, (total.get(k) || 0) + nodes);
    }
    rows.push(...(a.gains || []));
  }
  if (!rows.length) return null;
  rows.sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  const hit = new Map(), doneOn = {}, perDay = new Map();
  for (const [d, key, nodes, m] of rows) {
    perDay.set(d, (perDay.get(d) || 0) + m);
    const before = hit.get(key) || 0, after = before + nodes, n = total.get(key) || 1;
    hit.set(key, after);
    // The crossing, not the state: a trail is finished once, on the day it went over.
    if (before / n < completeAt && completeAt <= after / n) doneOn[key] = d;
  }
  let cum = 0;
  const timeline = [...perDay].map(([date, m]) => ({ date, new_m: m, cum_m: (cum += m) }));
  const names = new Map(buildTrails(st, { completeAt })[0].map(t => [t.key, t.name]));
  const finished = Object.entries(doneOn).map(([key, date]) => ({ key, date, name: names.get(key) || key }))
    .sort((a, b) => b.date.localeCompare(a.date));
  return { timeline, done_on: doneOn, finished, total_m: cum,
    streaks: TR.streaks(timeline.filter(t => t.new_m > 0).map(t => t.date), today) };
}

// ---------- matching (match_activities) ----------
// One area's synced summary from every matched run on this device: covered nodes OR'd
// together (and with what other devices already recorded), plus the new ground each
// day brought, replayed oldest-first so a repeat lap scores nothing.
function areaSummary(area, acts) {
  const ways = area.ways || {}, inArea = wid => wid in ways;
  const cover = TR.unionCoverage(acts, inArea);
  const out = {};
  for (const wid of new Set([...Object.keys(cover), ...Object.keys(area.cover || {})])) {
    const n = ways[wid] ? ways[wid][2] : 0, m = new Uint8Array(n), mine = cover[wid], theirs = coverMask(area.cover?.[wid], n);
    for (let i = 0; i < n; i++) m[i] = (mine && mine[i]) || theirs[i] ? 1 : 0;
    if (m.some(Boolean)) out[wid] = encodeCover(m);
  }
  const order = [...acts].sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')) || String(a.id).localeCompare(String(b.id)));
  const seenNodes = new Map(), agg = new Map();
  for (const act of order) for (const [wid, mask] of Object.entries(act.hits)) {
    const w = ways[wid];
    if (!w) continue;
    const [name, , n, len] = w;
    let cur = seenNodes.get(wid);
    if (!cur) seenNodes.set(wid, cur = new Uint8Array(n));
    let add = 0;
    for (let k = 0; k < Math.min(n, mask.length); k++) if (mask[k] && !cur[k]) { cur[k] = 1; add++; }
    if (!add) continue;
    const key = TR.trailKey({ id: wid, name }), slot = (act.date || '') + '|' + key;
    const g = agg.get(slot) || [act.date || '', key, 0, 0];
    g[2] += add; g[3] += add * (n ? len / n : 0);
    agg.set(slot, g);
  }
  // ponytail: gains come from this device's runs alone. If another device matched runs
  // this one has no stream for, the last device to match wins the streak history.
  const gains = agg.size ? [...agg.values()].map(g => [g[0], g[1], g[2], Math.round(g[3])]) : area.gains || [];
  return { cover: out, gains };
}

// Re-score every area this device holds the ways for, from the stored hit masks.
async function summarise(local) {
  const idx = (await idbGet('cache', 'trail-matched')) || {};
  const acts = [];
  for (const id of Object.keys(idx)) {
    const r = await idbGet('cache', hitsKey(id));
    if (r && r.hits) acts.push({ id, date: r.date, hits: Object.fromEntries(Object.entries(r.hits).map(([w, s]) => [w, unbits(s)])) });
  }
  for (const id of local.keys()) {
    const area = state.trailAreas[id];
    if (area) put(state, 'trailAreas', id, { ...area, ...areaSummary(area, acts), matched_at: new Date().toISOString() });
  }
}

// Match every run with a stream on this device against the areas whose ways it has
// not been checked against yet. -> {matched, touched}. Cheap to re-run: a run already
// matched against an area is skipped, and loading a new area only matches that one.
export async function matchRuns(onProgress) {
  const local = new Map();
  for (const a of areasOf(state)) { const segs = await localSegs(a.id); if (segs) local.set(a.id, segs); }
  if (!local.size) return { matched: 0, touched: 0 };
  const idx = (await idbGet('cache', 'trail-matched')) || {};
  const indexes = new Map();
  let matched = 0, touched = 0, n = 0;
  for (const id of await streamIds()) {
    const have = new Set(idx[id] || []);
    const missing = [...local.keys()].filter(a => !have.has(a)).sort();
    if (!missing.length) continue;
    const k = missing.join('|');
    if (!indexes.has(k)) indexes.set(k, TR.buildIndex(missing.flatMap(a => local.get(a)), TR.DEFAULT_TOL_M));
    const pts = D.samplesOf(await fetchStream(id)).filter(s => s[3] != null && s[4] != null).map(s => [s[3], s[4]]);
    if (pts.length >= 2) {
      const [coords] = TR.resample(pts, TR.TRACK_STEP_M, TR.TRACK_GAP_M);
      const hits = TR.markHits(indexes.get(k), coords, TR.DEFAULT_TOL_M);
      const ways = Object.keys(hits);
      if (ways.length) {
        const rec = (await idbGet('cache', hitsKey(id))) || { hits: {} };
        for (const w of ways) rec.hits[w] = bits(hits[w]);
        rec.date = state.activities[id]?.start?.slice(0, 10) || rec.date || null;
        await idbSet('cache', hitsKey(id), rec);
        touched += ways.length;
      }
      matched++;
    }
    // Runs with no GPS are marked too, so they stop counting as unmatched forever.
    idx[id] = [...have, ...missing];
    if (++n % 25 === 0) { await idbSet('cache', 'trail-matched', idx); onProgress && onProgress(n); }
  }
  await idbSet('cache', 'trail-matched', idx);
  await summarise(local);
  save('edit');
  return { matched, touched };
}

// Runs with a stream here that have not met every area this device has ways for.
async function unmatchedCount(localIds) {
  if (!localIds.length) return 0;
  try {
    const idx = (await idbGet('cache', 'trail-matched')) || {};
    return (await streamIds()).filter(id => !localIds.every(a => (idx[id] || []).includes(a))).length;
  } catch { return 0; }
}

// ---------- page ----------
function ledgerPanel(shown, totalShown) {
  const ground = newGround(state), doneOn = ground ? ground.done_on : {};
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">The ledger</p>
      <p class="panel-note">${totalShown} shown</p>
    </div>

    <div class="filters" style="margin-bottom:14px">
      <button type="button" class="${namedOnly ? 'on' : ''}" data-filter="named">Named only</button>
      <button type="button" class="${namedOnly ? '' : 'on'}" data-filter="all">Everything</button>
      <span style="color:var(--line)">|</span>
      <button type="button" class="${hideDone ? 'on' : ''}" data-filter="done">${hideDone ? 'Showing unfinished only' : 'Hide finished'}</button>
    </div>

    ${shown.length ? html`<div class="table-scroll"><table>
      <thead><tr>
        <th>Trail</th><th class="num">Covered</th><th class="num">Length</th>
        <th class="num">Done</th><th></th>
      </tr></thead>
      <tbody>${shown.map(t => html`<tr>
        <td>
          ${t.name}
          ${t.complete ? html`<span class="tick" title="${doneOn[t.key] ? 'Finished ' + day(doneOn[t.key], true) : 'Finished'}">✓</span>` : ''}
          <span class="cover-bar"><i class="${t.complete ? 'done' : ''}" style="width:${(t.pct * 100).toFixed(1)}%"></i></span>
        </td>
        <td class="num actual">${pct0(t.pct)}%</td>
        <td class="num dim">${(t.len_m / 1000).toFixed(2)} km</td>
        <td class="num dim">${(t.done_m / 1000).toFixed(2)} km</td>
        <td class="num dim">${t.kinds.join(', ')}</td>
      </tr>`)}</tbody>
    </table></div>` : html`<div class="empty">
      <p>No trails yet. Load a map area above — Run315 pulls every path, track
        and footway from OpenStreetMap, splits each into nodes 25 m apart, and marks
        the ones your runs have been within 25 m of.</p>
      <p>A trail counts as finished at 90% of its nodes, because the last stub is
        usually a car park spur you will never have a reason to run.</p>
    </div>`}
  </section>`;
}

// New ground over time: what chronology() and streaks() say about the outings.
function groundPanel() {
  const g = newGround(state);
  if (!g || !g.timeline.length) return '';
  const s = g.streaks, cum = g.timeline.map(t => t.cum_m), top = cum[cum.length - 1] || 1;
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">New ground</p>
      <p class="panel-note">Each node counts once, for the run that first reached it</p>
    </div>
    <div class="totals">
      <div class="stat"><div class="stat-value">${s.current}<small class="unit">d</small></div>
        <div class="stat-label">Current streak</div><div class="stat-hint">Days in a row that broke new ground</div></div>
      <div class="stat"><div class="stat-value">${s.best}<small class="unit">d</small></div>
        <div class="stat-label">Best streak</div></div>
      <div class="stat"><div class="stat-value">${s.days}</div>
        <div class="stat-label">Days with new ground</div></div>
      <div class="stat"><div class="stat-value">${(g.total_m / 1000).toFixed(1)}<small class="unit">km</small></div>
        <div class="stat-label">Distinct trail run</div></div>
    </div>
    ${g.timeline.length > 1 ? html`<svg class="chart ground-curve" viewBox="0 0 680 110" preserveAspectRatio="none" role="img"
        aria-label="Cumulative new trail ground, ${day(g.timeline[0].date, true)} to ${day(g.timeline[g.timeline.length - 1].date, true)}">
      <polyline points="${polyline(cum, top, 680, 110)}" fill="none" style="stroke:var(--measured)" stroke-width="2" vector-effect="non-scaling-stroke"/>
    </svg>` : ''}
    ${g.finished.length ? html`<ul class="finished-list">${g.finished.slice(0, 8).map(f =>
      html`<li><span><span class="tick">✓</span> ${f.name}</span><span class="dim">${day(f.date, true)}</span></li>`)}</ul>` : ''}
  </section>`;
}

export async function render() {
  useCss('trails', CSS);
  const areas = areasOf(state);
  const [all, stats] = buildTrails(state, { named: namedOnly });
  const shown = all.filter(t => !(hideDone && t.complete));
  const local = [];
  for (const a of areas) if (await localSegs(a.id)) local.push(a.id);
  const unmatched = await unmatchedCount(local);
  return html`<div class="trails">
  ${pageHead('Trails', `Trail completion${stats ? ` · ${stats.segments} ways loaded` : ''}`,
    html`<a class="btn btn-ghost" href="#/cities">By municipality</a><a class="btn btn-ghost" href="#/territory">Territory</a><a class="btn btn-ghost" href="#/routes">Routes</a>`)}

  ${stats ? html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">Coverage</p>
      <p class="panel-note">Complete at ${pct0(stats.complete_at)}% of a trail's nodes</p>
    </div>
    <div class="totals">
      <div class="stat">
        <div class="stat-value">${stats.complete}</div>
        <div class="stat-label">Trails finished</div>
        <div class="stat-hint">of ${stats.trails} known</div>
      </div>
      <div class="stat">
        <div class="stat-value">${stats.done_km.toFixed(0)}<small class="unit">km</small></div>
        <div class="stat-label">Trail covered</div>
        <div class="stat-hint">of ${stats.len_km.toFixed(0)} km</div>
      </div>
      <div class="stat">
        <div class="stat-value">${(stats.pct * 100).toFixed(1)}<small class="unit">%</small></div>
        <div class="stat-label">Of everything loaded</div>
      </div>
      <div class="stat">
        <div class="stat-value">${stats.started}</div>
        <div class="stat-label">Started, not finished</div>
      </div>
    </div>
  </section>` : ''}

  <!-- load an area -->
  <section class="panel">
    <div class="panel-head">
      <p class="eyebrow">Load an area</p>
      <p class="panel-note" id="areahint">Pan and zoom to the ground you want to track</p>
    </div>
    <div id="trailmap"></div>
    <form class="form-row" id="loadform" style="margin-top:14px">
      <div class="field field-grow"><label for="aname">Call it</label>
        <input type="text" id="aname" name="name" placeholder="Home forest" maxlength="80"></div>
      <button class="btn" type="submit" id="loadbtn" disabled>Load trails in this view</button>
    </form>
    <p class="stat-hint" style="margin-top:8px">
      Trail geometry comes from OpenStreetMap via Overpass, a free volunteer service.
      Load a town at a time rather than a county.
    </p>

    ${areas.length ? html`<div class="table-scroll" style="margin-top:16px"><table>
      <thead><tr><th>Area</th><th>Loaded</th><th class="num">Ways</th><th></th></tr></thead>
      <tbody>${areas.map(a => html`<tr>
        <td>${a.name}${local.includes(a.id) ? '' : html`<div class="stat-hint">Coverage synced; the trail lines are not on this device yet.</div>`}</td>
        <td class="dim">${String(a.loaded_at || '').slice(0, 10)}</td>
        <td class="num">${a.seg_count ?? 0}</td>
        <td class="num"><div class="area-actions">
          ${local.includes(a.id) ? '' : html`<button class="btn btn-ghost btn-sm" type="button" data-refetch="${a.id}">Load segments</button>`}
          <button class="btn-quiet" type="button" data-remove="${a.id}">remove</button>
        </div></td>
      </tr>`)}</tbody>
    </table></div>` : ''}
  </section>

  ${unmatched ? html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Unmatched runs</p></div>
    <div class="empty"><p>${unmatched} run${unmatched !== 1 ? 's' : ''} with GPS
      ${unmatched !== 1 ? 'have' : 'has'} not been checked against the trails
      you have loaded.</p></div>
    <button class="btn" type="button" id="matchbtn">Match them now</button>
  </section>` : ''}

  ${groundPanel()}

  ${ledgerPanel(shown.slice(0, 400), shown.length)}
  </div>`;
}

export async function mount(el) {
  // One-off: covers synced in the old '0'/'1' format are rewritten as bitsets.
  if (migrateCovers(state)) save('edit');
  const redraw = async () => { if (!el.isConnected) return; el.innerHTML = String(await render()); mount(el); };
  const hint = el.querySelector('#areahint');
  // Long jobs: one at a time, buttons off while they run, the hint line says what is happening.
  const work = async (label, fn) => {
    if (busy) return toast('Still working on the last request.');
    busy = true;
    el.querySelectorAll('button').forEach(b => { b.disabled = true; });
    if (hint) { hint.textContent = label; hint.style.color = ''; }
    try { const msg = await fn(); if (msg) toast(msg); }
    catch (e) { console.error(e); toast('⚠ ' + (e.message || e), 6000); }
    finally { busy = false; await redraw(); }
  };

  el.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => {
    const f = b.dataset.filter;
    if (f === 'named') namedOnly = true; else if (f === 'all') namedOnly = false; else hideDone = !hideDone;
    redraw();
  });
  const mb = el.querySelector('#matchbtn');
  if (mb) mb.onclick = () => work('Matching your runs…', async () => {
    const r = await matchRuns(n => { if (hint) hint.textContent = `Matched ${n} runs…`; });
    return r.matched ? `Matched ${r.matched} runs, touching ${r.touched} trail sections.`
      : 'Nothing new to match. Load a map area first, or sync more runs.';
  });
  el.querySelectorAll('[data-remove]').forEach(b => b.onclick = async () => {
    const a = state.trailAreas[b.dataset.remove];
    if (!a || !confirm(`Remove "${a.name}" and its trails?`)) return;
    remove(state, 'trailAreas', a.id);
    save('edit');
    await idbDel('cache', areaKey(a.id)).catch(() => {});
    toast('Area removed.');
    redraw();
  });
  // Another device loaded this area: fetch the same ways again, keep only the ones the
  // area owns, and match this device's runs against them.
  el.querySelectorAll('[data-refetch]').forEach(b => b.onclick = () => work('Asking Overpass for the trail lines…', async () => {
    const a = state.trailAreas[b.dataset.refetch];
    if (!a) return null;
    const segs = TR.segmentsFromOverpass(await overpass(trailQuery(a.bbox)));
    const owned = a.ways && Object.keys(a.ways).length ? segs.filter(s => s.id in a.ways) : segs;
    await storeSegs(a.id, owned);
    const r = await matchRuns();
    return `Loaded ${owned.length} trail lines for ${a.name}.` + (r.matched ? ` Matched ${r.matched} of your runs against them.` : '');
  }));

  // ---- the map ----
  const box = el.querySelector('#trailmap');
  if (!box) return;
  let L;
  try { L = await loadLeaflet(); }
  catch (e) { if (hint) hint.textContent = e.message; return; }
  if (!box.isConnected) return;
  const map = L.map(box, { preferCanvas: true });
  whenGone(box, () => {
    try { const c = map.getCenter(); lastView = [[c.lat, c.lng], map.getZoom()]; } catch { /* detached */ }
    map.remove();
  });
  if (lastView) map.setView(lastView[0], lastView[1]); else map.setView([47.3769, 8.5417], 13);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
              { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);

  // How big the view is, so nobody asks a free mirror for a county.
  const loadBtn = el.querySelector('#loadbtn');
  const viewBox = () => { const b = map.getBounds(); return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]; };
  function syncBounds() {
    if (busy || !hint) return;
    const [s, w, n, e] = viewBox(), sq = (n - s) * (e - w);
    hint.textContent = sq > MAX_AREA_SQ_DEG ? 'This view is too big to load — zoom in.' : 'Ready to load this view';
    hint.style.color = sq > MAX_AREA_SQ_DEG ? 'var(--behind)' : '';
  }
  map.on('moveend', syncBounds);
  syncBounds();
  if (loadBtn && !busy) loadBtn.disabled = false;

  // trails_load: pull every walkable way in the view from Overpass.
  el.querySelector('#loadform').onsubmit = ev => {
    ev.preventDefault();
    const bbox = viewBox();
    if (!bbox.every(Number.isFinite) || !(-90 <= bbox[0] && bbox[0] < bbox[2] && bbox[2] <= 90 && -180 <= bbox[1] && bbox[1] < bbox[3] && bbox[3] <= 180))
      return toast('That is not a valid map area.');
    if ((bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) > MAX_AREA_SQ_DEG)
      return toast('That area is too big to ask a free Overpass server for. Zoom in and load it in pieces.');
    const name = el.querySelector('#aname').value.trim().slice(0, 80) || `Area ${bbox[0].toFixed(3)},${bbox[1].toFixed(3)}`;
    work('Asking Overpass for every path in this view…', async () => {
      const segs = TR.segmentsFromOverpass(await overpass(trailQuery(bbox)));
      if (!segs.length) return 'No trails found in that area.';
      // First area to claim a way keeps it, so two overlapping areas never count a way twice.
      const known = new Set(Object.values(state.trailAreas).flatMap(a => Object.keys(a.ways || {})));
      const added = segs.filter(s => !known.has(s.id));
      const id = 'a' + Date.now().toString(36);
      await storeSegs(id, added);
      put(state, 'trailAreas', id, { id, name, bbox: bbox.map(v => +v.toFixed(6)), loaded_at: new Date().toISOString(),
        seg_count: added.length, cover: {}, gains: [],
        ways: Object.fromEntries(added.map(s => [s.id, [s.name, s.kind, s.coords.length, +s.len_m.toFixed(1)]])) });
      save('edit');
      const r = await matchRuns(n => { if (hint) hint.textContent = `Matched ${n} runs…`; });
      return `Loaded ${added.length} trails from ${name} (${segs.length - added.length} already known). Matched ${r.matched} of your runs against them.`;
    });
  };

  // Draw what is loaded: grey for known trail, teal for ground covered. Areas whose ways
  // are not on this device show as their outline.
  const known = token('--faint', '#8b94a3'), covered = token('--measured', '#0b6e79');
  const all = L.featureGroup();
  let drawn = 0, ways = 0;
  for (const a of areasOf(state)) {
    const segs = await localSegs(a.id);
    if (!box.isConnected) return;
    if (!segs) {
      const [s, w, n, e] = a.bbox || [];
      if ([s, w, n, e].every(Number.isFinite))
        L.rectangle([[s, w], [n, e]], { color: known, weight: 1, dashArray: '4 4', fill: false }).addTo(all).bindTooltip(a.name);
      continue;
    }
    ways += segs.length;
    for (const sg of segs) {
      if (drawn >= MAX_DRAWN) break;
      drawn++;
      L.polyline(sg.coords, { color: known, weight: 2, opacity: 0.7 }).addTo(all);
      const mask = a.cover && a.cover[sg.id];
      for (const [i, j] of mask ? TR.coveredRuns(coverMask(mask, sg.coords.length)) : []) {
        const part = sg.coords.slice(i, j + 1);
        if (part.length > 1) L.polyline(part, { color: covered, weight: 4 }).addTo(all).bindTooltip(sg.name || 'Unnamed way');
      }
    }
  }
  if (ways > drawn && hint) hint.textContent = `Showing the first ${drawn} of ${ways} ways.`;
  if (all.getLayers().length) {
    all.addTo(map);
    if (!lastView) map.fitBounds(all.getBounds(), { padding: [20, 20] });
    syncBounds();
  }
}
