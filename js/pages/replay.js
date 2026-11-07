// Replay and the ghost race: an activity played back on the map at its real pace (times a
// speed-up), and two to eight runs of the same route raced against each other.
//
// Both need the per-second stream (fetchStream: this device, else Drive). A stream becomes a
// handful of Float32Arrays (js/replay.js) the moment it arrives and the record is dropped, so
// eight ghosts never sit in memory as sample objects. The ghosts carry only time, distance
// and position.
//
// The choice lives in state.local.ui.replay (this device): {id, mode, group, ghosts, align,
// speed}. `#/replay?id=<activity id>` preselects an activity too -- what replayButton() links.
import { state, save, streamIds } from '../store.js';
import * as D from '../derive.js';
import { fetchStream, driveOn } from '../drive.js';
import * as RP from '../replay.js';
import { RUN_TYPES } from '../lib/fitness.js';
import { html, pageHead, emptyState, useCss, km, fmtTime, fmtPace, day, typeLabel } from '../ui.js';
import { loadLeaflet, whenGone, token } from '../routemaker.js';

export const title = 'Replay';

const CSS = `
.replay .modes { display: flex; gap: 6px; }
.replay .modes .btn[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); }
.replay .pick { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; font-size: 13px; margin-bottom: 10px; }
.replay .pick select { padding: 4px 6px; max-width: 100%; }
.replay .rmap { height: min(62vh, 640px); border-radius: 3px; border: 1px solid var(--line); background: var(--track); }
.replay .transport { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin-top: 10px; font: 13px var(--mono); }
.replay .transport input[type=range] { flex: 1 1 220px; accent-color: var(--measured); }
.replay .transport .clock { min-width: 120px; color: var(--muted); }
.replay .reads { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 4px 16px; margin-top: 12px; }
.replay .reads .stat { border-top: none; padding: 4px 0; }
.replay .reads .stat-value { font-size: 24px; }
.replay .runs { max-height: 300px; overflow-y: auto; border: 1px solid var(--line); border-radius: 3px; padding: 6px 10px; font-size: 13px; }
.replay .runs label { display: flex; gap: 8px; align-items: baseline; padding: 3px 0; }
.replay .runs .num { margin-left: auto; font-family: var(--mono); color: var(--muted); }
.replay .board { width: 100%; font-size: 13px; }
.replay .board td { padding: 4px 6px; border-top: 1px solid var(--line); }
.replay .board .sw { display: inline-block; width: 10px; height: 10px; border-radius: 50%; vertical-align: -1px; }
.replay .board tr.done td { color: var(--muted); }
.replay .race-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(240px, 1fr); gap: 14px; }
@media (max-width: 860px) { .replay .race-grid { grid-template-columns: 1fr; } }
.replay .kbd { font: 11px var(--mono); color: var(--faint); }
`;

const ui = () => ((state.local.ui = state.local.ui || {}).replay = state.local.ui.replay || {});
const isRide = a => /cycl|bik|ride/.test(a?.type || '');
const isRunA = a => RUN_TYPES.has(a?.type);
const hasGround = id => { const d = state.derived[id]; return !!(d && ((d.tiles && d.tiles.length) || d.p0)); };

// The link the activity page shows. The query survives the router (it routes on the path) and
// render() moves it into state.local.ui.replay, so a reload keeps the choice.
export function replayButton(id, label = 'Replay on the map') {
  return html`<a class="btn btn-ghost" href="#/replay?id=${encodeURIComponent(id)}">${label}</a>`;
}
// The same from code: choose the activity, then go.
export function openReplay(id) {
  Object.assign(ui(), { id, mode: 'replay' });
  save('ui');
  location.hash = '#/replay';
}

function fromHash() {
  if (typeof location === 'undefined') return;
  const q = (location.hash.split('?')[1] || '');
  const id = new URLSearchParams(q).get('id');
  if (id && state.activities[id]) { Object.assign(ui(), { id, mode: 'replay' }); save('ui'); }
  // Consumed: drop the query (without a navigation) so picking another activity sticks.
  if (id) try { history.replaceState(null, '', '#/replay'); } catch { /* fine */ }
}

// Outdoor activities with ground, newest first.
const gpsActivities = () => Object.values(state.activities)
  .filter(a => a && a.start && !D.isVirtual(a) && hasGround(a.id))
  .sort((a, b) => String(b.start).localeCompare(String(a.start)));

async function localStreams() {
  try { return new Set((await streamIds()) || []); } catch { return new Set(); }
}

// The activity to replay: the chosen one, else the latest run whose stream is on this device.
function chosenId(list, have) {
  const u = ui();
  if (u.id && state.activities[u.id]) return u.id;
  const run = list.find(a => isRunA(a) && have.has(a.id)) || list.find(a => have.has(a.id)) || list.find(isRunA) || list[0];
  return run ? run.id : null;
}

const actLabel = a => `${day(String(a.start), true)} · ${a.name || typeLabel(a.type)} · ${km(a.distance_m)} km`;

// ---------------------------------------------------------------------------
// ghost race candidates
// ---------------------------------------------------------------------------

// Groups to race: runs like the chosen activity (same start, similar distance), then the
// routes repeats.js found over the last three years. -> [{key, label, runs: [activity]}]
function ghostGroups(anchorId) {
  const groups = [], anchor = state.activities[anchorId];
  const runs = D.runs(state).filter(a => !D.isVirtual(a) && state.derived[a.id]?.p0);
  if (anchor && state.derived[anchorId]?.p0) {
    const cand = runs.map(a => ({ id: a.id, distance_m: a.distance_m, p0: state.derived[a.id].p0 }));
    const like = RP.similarRuns(cand, { id: anchor.id, distance_m: anchor.distance_m, p0: state.derived[anchorId].p0 }, { max: 60 });
    if (like.length >= 2) groups.push({ key: 'like', label: `Runs like ${actLabel(anchor)} (${like.length})`, runs: like.map(r => state.activities[r.id]).filter(Boolean) });
  }
  let routes = [];
  try { routes = D.repeatedRoutes(state, new Date(), 3 * 365) || []; } catch (e) { console.warn('repeated routes', e); }
  routes.slice(0, 30).forEach((r, i) => groups.push({ key: 'r' + i, label: `${r.name} · ${km(r.distance_m)} km (${r.count} runs)`,
    runs: r.runs.map(m => state.activities[m.id]).filter(Boolean) }));
  for (const g of groups) g.runs.sort((a, b) => String(b.start).localeCompare(String(a.start)));
  return groups;
}

// Default line-up: the fastest of the group and the most recent, up to five.
function defaultGhosts(runs) {
  const pace = a => (a.moving_s && a.distance_m ? a.moving_s / a.distance_m : Infinity);
  const best = [...runs].sort((a, b) => pace(a) - pace(b))[0];
  return [...new Set([best, ...runs].filter(Boolean).map(a => a.id))].slice(0, 5);
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

export async function render() {
  useCss('replay', CSS);
  fromHash();
  const u = ui(), mode = u.mode === 'ghost' ? 'ghost' : 'replay';
  const modes = html`<div class="modes">
    <button type="button" class="btn btn-ghost" data-mode="replay" aria-pressed="${String(mode === 'replay')}">Replay</button>
    <button type="button" class="btn btn-ghost" data-mode="ghost" aria-pressed="${String(mode === 'ghost')}">Ghost race</button></div>`;
  const head = pageHead('Replay', mode === 'ghost' ? 'Runs of the same route, raced against each other at their real pace' : 'An activity played back on the map', modes);
  if (!Object.keys(state.activities).length) return html`${head}${emptyState('No activities yet', 'Bring in Garmin and Strava through Sync & cowork, then come back to watch a run again.', html`<a class="btn" href="#/sync">Go and sync</a>`)}`;
  const list = gpsActivities();
  if (!list.length) return html`${head}${emptyState('Nothing with a GPS track', 'Replays need an outdoor activity with a GPS track — treadmill runs and virtual rides have no ground to move over.', '')}`;
  const have = await localStreams();
  const id = chosenId(list, have);
  return html`<div class="replay">${head}${mode === 'ghost' ? ghostPanel(id) : replayPanel(list, have, id)}</div>`;
}

function speedSelect(cur) {
  return html`<label>Speed <select data-speed>${RP.SPEEDS.map(s => html`<option value="${s}" ${s === cur ? 'selected' : ''}>${s}×</option>`)}</select></label>`;
}
const transport = speed => html`<div class="transport">
  <button type="button" class="btn" data-play>Play</button>${speedSelect(speed)}
  <input type="range" min="0" max="1" step="1" value="0" data-scrub aria-label="Position in the activity">
  <span class="clock" data-clock>0:00</span></div>
  <p class="kbd">Space play/pause · ← → 10 s (shift: 1 min) · ↑ ↓ speed · Home start</p>`;

function replayPanel(list, have, id) {
  const u = ui(), a = state.activities[id];
  // The newest 300 keep the select usable; the chosen one is always in it.
  const opts = list.slice(0, 300);
  if (a && !opts.includes(a)) opts.unshift(a);
  return html`<section class="panel">
    <div class="pick"><label>Activity <select data-act>${opts.map(x => html`<option value="${x.id}" ${x.id === id ? 'selected' : ''}>${actLabel(x)}${have.has(x.id) ? '' : ' ☁'}</option>`)}</select></label>
      <label><input type="checkbox" data-follow ${u.follow === false ? '' : 'checked'}> follow the dot</label>
      <a class="quiet-link" href="#/activity/${id}">Open the activity</a></div>
    <div class="rmap" data-map></div>
    ${transport(u.speed || 10)}
    <div class="reads" data-reads></div>
    <p class="panel-note" data-note>☁ = the stream is not on this device yet; it comes from Drive when you pick it${driveOn() ? '' : ' (Drive is not connected here)'}.
      The tail is the last ${RP.TAIL_S} seconds; pace is over the last 30 seconds.</p></section>`;
}

function ghostPanel(anchorId) {
  const u = ui(), groups = ghostGroups(anchorId);
  if (!groups.length) return html`<section class="panel"><div class="empty"><p>No route has been run often enough to race yet. A race needs two or more runs
    that start in the same place and cover about the same distance — the routes on ${html`<a class="quiet-link" href="#/repeats">My routes</a>`},
    or runs like the one picked under Replay.</p></div></section>`;
  const g = groups.find(x => x.key === u.group) || groups[0];
  const chosen = new Set((u.group === g.key && Array.isArray(u.ghosts) ? u.ghosts : defaultGhosts(g.runs)).filter(id => g.runs.some(r => r.id === id)));
  return html`<section class="panel">
    <div class="pick"><label>Route <select data-group>${groups.map(x => html`<option value="${x.key}" ${x === g ? 'selected' : ''}>${x.label}</option>`)}</select></label>
      <label>Line up by <select data-align><option value="time" ${u.align !== 'distance' ? 'selected' : ''}>elapsed time, each on its own track</option>
        <option value="distance" ${u.align === 'distance' ? 'selected' : ''}>distance, all on one line</option></select></label></div>
    <div class="runs" data-runs>${g.runs.map(r => html`<label><input type="checkbox" value="${r.id}" ${chosen.has(r.id) ? 'checked' : ''}>
      <span>${day(String(r.start), true)} · ${r.name || 'Run'}</span><span class="num">${km(r.distance_m, 2)} km · ${fmtTime(r.moving_s)} · ${fmtPace(r.moving_s, r.distance_m)}</span></label>`)}</div>
    <p class="panel-note"><span data-count>${chosen.size}</span> of at most ${RP.MAX_GHOSTS} chosen.
      <button type="button" class="btn" data-race>Start the race</button></p>
    <div class="race-grid" data-race-area hidden>
      <div><div class="rmap" data-map></div>${transport(u.speed || 10)}</div>
      <div><p class="eyebrow">Leaderboard</p><table class="board"><tbody data-board></tbody></table><p class="panel-note" data-racenote></p></div>
    </div>
    <p class="panel-note">Everyone starts together and runs at the pace they ran that day. The race is over the distance
      every recording covered, so a lap of the car park at the end does not count. Gaps are how long ago the leader was where
      that runner is now. "Distance, all on one line" puts every dot on the first runner's track at the distance it had
      covered, so two GPS traces on opposite pavements do not look like a gap.</p></section>`;
}

// ---------------------------------------------------------------------------
// mount: the player both modes share
// ---------------------------------------------------------------------------

let _stop = null;

export async function mount(el, params) {
  if (_stop) { _stop(); _stop = null; }
  const root = el.querySelector('.replay');
  if (!root) return;
  const u = ui();
  const rerender = async () => { el.innerHTML = String(await render(params)); return mount(el, params); };
  root.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { u.mode = b.dataset.mode; save('ui'); rerender(); });
  const actSel = root.querySelector('[data-act]');
  if (actSel) actSel.onchange = () => { u.id = actSel.value; save('ui'); rerender(); };
  const follow = root.querySelector('[data-follow]');
  if (follow) follow.onchange = () => { u.follow = follow.checked; save('ui'); };
  const groupSel = root.querySelector('[data-group]');
  if (groupSel) groupSel.onchange = () => { u.group = groupSel.value; u.ghosts = null; save('ui'); rerender(); };
  const alignSel = root.querySelector('[data-align]');
  if (alignSel) alignSel.onchange = () => { u.align = alignSel.value; save('ui'); };
  const runsBox = root.querySelector('[data-runs]');
  if (runsBox) runsBox.onchange = e => {
    const boxes = [...runsBox.querySelectorAll('input:checked')];
    if (boxes.length > RP.MAX_GHOSTS && e.target.checked) e.target.checked = false;
    u.group = groupSel ? groupSel.value : u.group;
    u.ghosts = [...runsBox.querySelectorAll('input:checked')].map(b => b.value);
    root.querySelector('[data-count]').textContent = u.ghosts.length;
    save('ui');
  };

  let cleanup = [];
  const stop = () => { for (const f of cleanup.splice(0)) { try { f(); } catch { /* gone */ } } };
  _stop = stop;
  const mapBox = root.querySelector('[data-map]');
  if (u.mode === 'ghost') {
    const go = root.querySelector('[data-race]');
    if (go) go.onclick = () => { stop(); startRace(root, cleanup); };
  } else if (mapBox) startReplay(root, cleanup);
  return () => { stop(); if (_stop === stop) _stop = null; };
}

// The clock: real time x speed, a scrubber, keyboard. onFrame(clock) draws; onSlow(clock)
// (about 8 times a second) updates the text, which is too expensive to touch every frame.
function player(root, cleanup, dur, onFrame, onSlow) {
  const u = ui(), playBtn = root.querySelector('[data-play]'), scrub = root.querySelector('[data-scrub]'),
    clockEl = root.querySelector('[data-clock]'), speedSel = root.querySelector('[data-speed]');
  let clock = 0, playing = false, last = 0, raf = 0, lastSlow = 0, speed = +(u.speed || 10);
  scrub.max = String(Math.max(1, Math.ceil(dur)));
  const show = force => {
    onFrame(clock);
    const now = performance.now();
    if (force || now - lastSlow > 120) { lastSlow = now; scrub.value = String(Math.round(clock)); clockEl.textContent = `${fmtTime(clock)} / ${fmtTime(dur)}`; onSlow(clock); }
  };
  const tick = now => {
    if (!playing) return;
    clock = Math.min(dur, clock + ((now - last) / 1000) * speed); last = now;
    if (clock >= dur) { playing = false; playBtn.textContent = 'Play'; show(true); return; }
    show(false);
    raf = requestAnimationFrame(tick);
  };
  const setPlaying = p => {
    playing = p; playBtn.textContent = p ? 'Pause' : 'Play';
    if (p) { if (clock >= dur) clock = 0; last = performance.now(); raf = requestAnimationFrame(tick); } else cancelAnimationFrame(raf);
  };
  const seek = t => { clock = Math.max(0, Math.min(dur, t)); show(true); };
  const setSpeed = s => { speed = s; u.speed = s; speedSel.value = String(s); save('ui'); };
  playBtn.onclick = () => setPlaying(!playing);
  scrub.oninput = () => seek(+scrub.value);
  speedSel.onchange = () => setSpeed(+speedSel.value);
  const key = e => {
    if (!root.isConnected || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.closest && e.target.closest('input, select, textarea, button, [contenteditable]')) return;
    const i = RP.SPEEDS.indexOf(speed);
    if (e.key === ' ') setPlaying(!playing);
    else if (e.key === 'ArrowLeft') seek(clock - (e.shiftKey ? 60 : 10));
    else if (e.key === 'ArrowRight') seek(clock + (e.shiftKey ? 60 : 10));
    else if (e.key === 'ArrowUp') setSpeed(RP.SPEEDS[Math.min(RP.SPEEDS.length - 1, i + 1)] || speed);
    else if (e.key === 'ArrowDown') setSpeed(RP.SPEEDS[Math.max(0, i - 1)] || speed);
    else if (e.key === 'Home') seek(0);
    else if (e.key === 'End') seek(dur);
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', key);
  cleanup.push(() => { cancelAnimationFrame(raf); playing = false; document.removeEventListener('keydown', key); });
  show(true);
  return { seek, setPlaying };
}

async function newMap(box, cleanup) {
  const L = await loadLeaflet();
  if (!box.isConnected) return null;
  const map = L.map(box, { preferCanvas: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  const gone = whenGone(box, () => map.remove());
  cleanup.push(() => { gone(); try { map.remove(); } catch { /* already */ } });
  return { L, map };
}

const stat = (label, value, unit = '') => html`<div class="stat"><div class="stat-value">${value}${unit ? html`<small class="unit"> ${unit}</small>` : ''}</div><div class="stat-label">${label}</div></div>`;

async function startReplay(root, cleanup) {
  const u = ui(), id = root.querySelector('[data-act]')?.value, a = state.activities[id];
  const box = root.querySelector('[data-map]'), reads = root.querySelector('[data-reads]'), note = root.querySelector('[data-note]');
  if (!a) return;
  reads.textContent = 'Loading the stream…';
  let tr = null;
  try { const rec = await fetchStream(id); tr = rec && RP.trackFromChannels(rec.channels); } catch (e) { console.warn('replay stream', e); }
  if (!box.isConnected) return;
  if (!tr) {
    reads.textContent = '';
    box.textContent = '';
    note.textContent = driveOn() ? 'This activity has no GPS stream on this device or in Drive — it may have been imported without one.'
      : 'The stream for this activity is not on this device, and Drive is not connected to fetch it. Open it on the device that imported it, or connect Drive on Sync & cowork.';
    return;
  }
  let m;
  try { m = await newMap(box, cleanup); } catch { box.textContent = 'The map did not load (offline?).'; return; }
  if (!m) return;
  const { L, map } = m, colour = token('--measured', '#0b6e79');
  const line = L.polyline(RP.thin(tr), { color: token('--faint', '#8b94a3'), weight: 3, opacity: 0.7, interactive: false }).addTo(map);
  map.fitBounds(line.getBounds(), { padding: [24, 24] });
  const CH = 6, tails = Array.from({ length: CH }, (_, k) => L.polyline([], { color: colour, weight: 5, opacity: (k + 1) / CH, interactive: false }).addTo(map));
  const dot = L.circleMarker(RP.posAt(tr, 0), { radius: 8, color: token('--surface', '#fff'), weight: 2, fillColor: colour, fillOpacity: 1, interactive: false }).addTo(map);
  const ride = isRide(a);
  const onFrame = t => {
    const p = RP.posAt(tr, t), ch = RP.tailChunks(tr, t, RP.TAIL_S, CH);
    dot.setLatLng(p);
    tails.forEach((pl, k) => pl.setLatLngs(ch[k] || []));
    if (u.follow !== false && !map.getBounds().pad(-0.2).contains(p)) map.panTo(p, { animate: false });
  };
  const onSlow = t => {
    const r = RP.readout(tr, t);
    const speed = r.pace ? (ride ? stat('Speed', (3600 / r.pace).toFixed(1), 'km/h') : stat('Pace', fmtTime(r.pace), '/km')) : stat(ride ? 'Speed' : 'Pace', '--');
    reads.innerHTML = String(html`${stat('Time', fmtTime(r.t))}${stat('Distance', km(r.d, 2), 'km')}${speed}
      ${tr.hr ? stat('Heart rate', r.hr != null ? Math.round(r.hr) : '--', 'bpm') : ''}
      ${tr.ele ? stat('Elevation', r.ele != null ? Math.round(r.ele) : '--', 'm') : ''}
      ${tr.pw ? stat('Power', r.pw != null ? Math.round(r.pw) : '--', 'W') : ''}
      ${tr.cad ? stat('Cadence', r.cad != null ? Math.round(r.cad) : '--', ride ? 'rpm' : 'spm') : ''}`);
  };
  player(root, cleanup, tr.dur, onFrame, onSlow);
}

async function startRace(root, cleanup) {
  const u = ui(), area = root.querySelector('[data-race-area]'), board = root.querySelector('[data-board]'), note = root.querySelector('[data-racenote]');
  const ids = (u.ghosts && u.ghosts.length ? u.ghosts : [...root.querySelectorAll('[data-runs] input:checked')].map(b => b.value)).slice(0, RP.MAX_GHOSTS);
  if (ids.length < 2) { note.textContent = 'Pick at least two runs.'; area.hidden = false; return; }
  area.hidden = false;
  // One stream at a time, straight into typed arrays; the record goes out of scope each turn.
  const racers = [], missing = [];
  for (let i = 0; i < ids.length; i++) {
    note.textContent = `Loading stream ${i + 1} of ${ids.length}…`;
    let tr = null;
    try { const rec = await fetchStream(ids[i]); tr = rec && RP.trackFromChannels(rec.channels, { lite: true }); } catch (e) { console.warn('ghost stream', e); }
    if (!root.isConnected) return;
    if (tr && tr.dist > 100) racers.push({ id: ids[i], a: state.activities[ids[i]], tr }); else missing.push(ids[i]);
  }
  const missNote = missing.length ? `${missing.length} run${missing.length > 1 ? 's have' : ' has'} no stream on this device${driveOn() ? ' or in Drive' : ' (Drive is not connected)'} and ${missing.length > 1 ? 'are' : 'is'} sitting this one out. ` : '';
  if (racers.length < 2) { note.textContent = missNote + 'A race needs two runs with streams.'; return; }
  const box = root.querySelector('[data-map]');
  let m;
  try { m = await newMap(box, cleanup); } catch { box.textContent = 'The map did not load (offline?).'; return; }
  if (!m) return;
  const { L, map } = m, mode = u.align === 'distance' ? 'distance' : 'time';
  const tracks = racers.map(r => r.tr), race = RP.prepareRace(tracks);
  const colours = racers.map((_, k) => token(`--series-${k + 1}`, '#2a78d6'));
  const lines = (mode === 'distance' ? [tracks[0]] : tracks).map((tr, k) =>
    L.polyline(RP.thin(tr, 400), { color: mode === 'distance' ? token('--faint', '#8b94a3') : colours[k], weight: 2, opacity: 0.35, interactive: false }).addTo(map));
  map.fitBounds(L.featureGroup(lines).getBounds(), { padding: [24, 24] });
  const tails = racers.map((_, k) => L.polyline([], { color: colours[k], weight: 4, opacity: 0.8, interactive: false }).addTo(map));
  const dots = racers.map((_, k) => L.circleMarker(RP.posAt(tracks[k], 0), { radius: 7, color: token('--surface', '#fff'), weight: 2, fillColor: colours[k], fillOpacity: 1, interactive: false }).addTo(map));
  const label = r => day(String(r.a?.start || ''), true);
  const onFrame = clock => {
    const rows = RP.standings(tracks, race, clock, mode);
    for (const r of rows) {
      dots[r.k].setLatLng(r.pos);
      const tr = tracks[r.k], t = r.done ? race.finish[r.k] : clock;
      if (mode === 'distance') {
        const pts = [];
        for (let s = 8; s >= 0; s--) pts.push(RP.posAtDistance(tracks[0], r.d - s * 15));
        tails[r.k].setLatLngs(pts);
      } else tails[r.k].setLatLngs(RP.tailChunks(tr, t, 30, 1, 30)[0] || []);
    }
    // Leader first on top.
    for (let i = rows.length - 1; i >= 0; i--) dots[rows[i].k].bringToFront();
  };
  const onSlow = clock => {
    const rows = RP.standings(tracks, race, clock, mode);
    board.innerHTML = String(html`${rows.map(r => {
      const tr = tracks[r.k], p = r.done ? null : RP.paceAt(tr, clock);
      const gap = r.place === 1 ? (r.done ? fmtTime(r.finish) : 'leads') : (r.done ? '+' + fmtTime(r.gap_s) : `+${fmtTime(r.gap_s)} · ${Math.round(r.gap_m)} m`);
      return html`<tr class="${r.done ? 'done' : ''}"><td class="num">${r.place}</td>
        <td><span class="sw" style="background:${colours[r.k]}"></span> ${label(racers[r.k])}</td>
        <td class="num">${km(r.d, 2)}</td><td class="num">${r.done ? 'finished' : p ? fmtTime(p) + '/km' : '--'}</td><td class="num">${gap}</td></tr>`;
    })}`);
    const all = rows.every(r => r.done);
    note.textContent = missNote + (all
      ? `Finishing order over ${km(race.raceDist, 2)} km: ` + rows.map(r => `${r.place}. ${label(racers[r.k])} ${fmtTime(r.finish)}`).join(' · ')
      : `Race distance ${km(race.raceDist, 2)} km — the shortest recording of the ${racers.length}.`);
  };
  player(root, cleanup, race.duration, onFrame, onSlow).setPlaying(true);
}
