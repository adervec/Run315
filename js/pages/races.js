// Every race on the calendar: the ones ahead with their projection, the ones run with
// their result. Also home to the pieces Today shares -- the start list row, the past
// races table, the calibration line and the add-race form (app.py's add_race / parse_goal).
import { state, save } from '../store.js';
import { put, remove } from '../merge.js';
import * as D from '../derive.js';
import { dayKey, daysBetween } from '../lib/dt.js';
import { html, pageHead, emptyState, fmtTime, fmtPace, toast, useCss } from '../ui.js';

export const title = 'Races';
export const LANES = { high: 3, medium: 2, low: 1, none: 0 };
const DISTANCES = [['5K', 5000], ['10K', 10000], ['Half marathon', 21097], ['Marathon', 42195], ['50K', 50000]];

const CSS = `
.races-past td .behind, .races-past td .ahead { font-family: var(--mono); }
`;

// '1:29:30' or '89:30' or '5400' -> seconds, or null.
export function parseGoal(text) {
  text = String(text ?? '').trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return parseFloat(text);
  const parts = text.split(':');
  if (parts.length > 3 || !parts.every(p => /^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((t, p) => t * 60 + parseFloat(p), 0);
}

const minus = v => (v > 0 ? '+' : '−');

// Upcoming races with their (calibrated) projection; past races most recent first.
export function split(st, now = new Date()) {
  const today = dayKey(now), upcoming = [], past = [];
  for (const r of D.races(st)) {
    if (r.date < today) { past.push(r); continue; }
    upcoming.push([r, D.projection(st, r, now)]);
  }
  return { upcoming, past: past.reverse(), today };
}

// ---------- signature: one row of the start list ----------
export function startRow(race, p, today) {
  const days = daysBetween(today, race.date);
  const diff = p && race.goal_s ? p.seconds - race.goal_s : null;
  return html`<div class="start-row">
    <div class="countdown"><b>${days >= 0 ? days : '--'}</b><small>${days >= 0 ? 'days' : 'past'}</small></div>
    <div class="race-cell">
      <p class="race-name"><a href="#/race/${encodeURIComponent(race.id)}">${race.name}</a></p>
      <p class="race-sub">${race.date} · ${(race.distance_m / 1000).toFixed(2)} km</p>
      <div class="lanes" title="Confidence: ${p ? p.confidence : 'no data'}">
        ${[0, 1, 2].map(i => html`<span class="lane ${p && i < LANES[p.confidence] ? 'on' : ''}"></span>`)}
      </div>
    </div>
    <div class="proj-cell">
      ${p ? html`<div class="projected">${fmtTime(p.seconds)}<small>${fmtPace(p.seconds, race.distance_m)}</small></div>`
        : html`<div class="projected dim" style="font-size:20px">no data<small>sync a few runs first</small></div>`}
    </div>
    <div class="delta">
      ${diff != null ? html`<span class="${diff > 0 ? 'behind' : 'ahead'}">${minus(diff)}${fmtTime(Math.abs(diff))}</span>
        <small>vs ${fmtTime(race.goal_s)}</small>`
        : p ? html`<span class="dim">—</span><small>no goal set</small>` : ''}
    </div>
    <div class="del-cell"><button class="btn-quiet" type="button" data-del-race="${race.id}" title="Remove ${race.name}">×</button></div>
  </div>`;
}

export function pastTable(past) {
  return html`<div class="table-scroll races-past"><table>
    <thead><tr><th>Race</th><th>Date</th><th class="num">Result</th><th class="num">Projected</th><th class="num">Gap</th></tr></thead>
    <tbody>${past.map(r => {
      const gap = r.actual_s && r.predicted_s ? r.actual_s - r.predicted_s : null;
      return html`<tr>
        <td><a class="quiet-link" href="#/race/${encodeURIComponent(r.id)}">${r.name}</a></td>
        <td class="dim">${r.date}</td>
        <td class="num actual">${r.actual_s ? fmtTime(r.actual_s) : '—'}</td>
        <td class="num time">${r.predicted_s ? fmtTime(r.predicted_s) : '—'}</td>
        <td class="num">${gap != null ? html`<span class="${gap > 0 ? 'behind' : 'ahead'}">${minus(gap)}${fmtTime(Math.abs(gap))}</span>`
          : !r.actual_s ? html`<a class="quiet-link" href="#/race/${encodeURIComponent(r.id)}">add result</a>` : '—'}</td>
      </tr>`;
    })}</tbody></table></div>`;
}

export function calibrationNote(cal, anyUpcoming) {
  if (cal) return html`<p class="stat-hint" style="margin-top:12px">
    Calibrated on ${cal.n} past result${cal.n !== 1 ? 's' : ''}: you have run ${cal.direction} by
    ${(cal.mean_abs_error * 100).toFixed(1)}% on average, so projections are
    adjusted ${(cal.factor - 1) * 100 >= 0 ? '+' : ''}${((cal.factor - 1) * 100).toFixed(1)}%.</p>`;
  if (anyUpcoming) return html`<p class="stat-hint" style="margin-top:12px">Once two races have results entered,
    projections calibrate to how you actually race.</p>`;
  return '';
}

export function raceForm() {
  return html`<form class="form-row" data-race-form style="margin-top:18px">
      <div class="field field-grow"><label for="rn">Race</label>
        <input type="text" id="rn" name="name" placeholder="City Marathon" required></div>
      <div class="field"><label for="rd">Date</label>
        <input type="date" id="rd" name="date" required></div>
      <div class="field"><label for="rdist">Distance (m)</label>
        <input type="number" id="rdist" name="distance" list="dists" min="300" max="500000" step="1" required></div>
      <div class="field"><label for="rg">Goal time</label>
        <input type="text" id="rg" name="goal" placeholder="1:29:30" pattern="[0-9:.]*"></div>
      <button class="btn" type="submit">Add race</button>
    </form>
    <datalist id="dists">${DISTANCES.map(([label, d]) => html`<option value="${d}">${label}</option>`)}</datalist>`;
}

// add_race: a name, a real date, a distance in metres; the goal is optional.
export function addRace(fields) {
  const name = String(fields.name || '').trim() || 'Race';
  const date = String(fields.date || '').trim();
  const distance = parseFloat(fields.distance);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date)) || !(distance >= 300 && distance <= 500000))
    throw new Error('Give the race a valid date and a distance in metres.');
  const id = 'race-' + Date.now().toString(36);
  put(state, 'races', id, { id, name: name.slice(0, 120), date, distance_m: distance, goal_s: parseGoal(fields.goal),
    actual_s: null, predicted_s: null, garmin_id: null, created_at: new Date().toISOString() });
  save('edit');
  return id;
}
export function deleteRace(id) {
  if (!state.races[id]) return false;
  remove(state, 'races', id);
  save('edit');
  return true;
}

// Wire the add-race form and the × buttons inside `el`; `redraw` re-renders the page.
export function wireRaceForms(el, redraw) {
  el.querySelectorAll('[data-race-form]').forEach(f => f.onsubmit = ev => {
    ev.preventDefault();
    try { addRace(Object.fromEntries(new FormData(f))); toast('Race added'); redraw(); }
    catch (e) { toast(e.message); }
  });
  el.querySelectorAll('[data-del-race]').forEach(b => b.onclick = () => {
    const r = state.races[b.dataset.delRace];
    if (!r || (typeof confirm === 'function' && !confirm(`Remove ${r.name}?`))) return;
    deleteRace(r.id); toast('Race removed'); redraw();
  });
}

export function render() {
  useCss('races', CSS);
  const { upcoming, past, today } = split(state);
  const cal = D.calibration(state);
  if (!upcoming.length && !past.length) return html`${pageHead('Races')}
    ${emptyState('No races on the calendar', 'Add the next one and Run315 will project your finish time from here on.', raceForm())}`;
  return html`${pageHead('Races', `${upcoming.length} ahead · ${past.length} run`)}
    <section class="panel">
      <div class="panel-head"><p class="eyebrow">Start list</p><p class="panel-note">Projections update on every sync</p></div>
      ${upcoming.length ? html`<div class="startlist">${upcoming.map(([r, p]) => startRow(r, p, today))}</div>`
        : html`<div class="empty"><p>Nothing ahead. Add the next one and Run315 will
          project your finish time from here on.</p></div>`}
      ${calibrationNote(cal, upcoming.length)}
      ${raceForm()}
    </section>
    ${past.length ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">Run</p><p class="panel-note">${past.length} past race${past.length !== 1 ? 's' : ''} · each result teaches the projections</p></div>
      ${pastTable(past)}</section>` : ''}`;
}

export function mount(el) {
  const redraw = () => { el.innerHTML = String(render()); mount(el); };
  wireRaceForms(el, redraw);
}
