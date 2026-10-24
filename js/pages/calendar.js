// The calendar and search: a month of training as a grid (weeks as rows, Monday
// first), each day's sessions as chips coloured by sport and sized by load, the day's
// journal tags, races and Plan-of-the-Day plans; and a search across every activity
// by text, sport, source, tag, route, dates and distance.
//
// Filter state lives in this module and in state.local.ui.calendar (this device only:
// a search is not something the phone should inherit). The router passes no query
// params, so a link like #/calendar?q=tempo&sport=run is read from location.hash here.
import { state } from '../store.js';
import * as D from '../derive.js';
import * as F from '../lib/fitness.js';
import { dayKey, addDayKey, fromDay, weekStart } from '../lib/dt.js';
import { dayTagsWidget, mountDayTags } from '../journal.js';
import { html, raw, pageHead, emptyState, fmtTime, typeLabel, day, useCss } from '../ui.js';

export const title = 'Calendar';

const CSS = `
.cal-nav { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.cal-nav h2 { font-family: var(--display); font-size: 20px; margin: 0 auto 0 0; }
.cal-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)) minmax(54px, .9fr); gap: 2px; }
.cal-dow { font: 10px var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--faint); padding: 2px 4px; }
.cal-day { min-height: 74px; background: var(--hover); border: 1px solid transparent; border-radius: 3px; padding: 3px 4px;
  display: flex; flex-direction: column; gap: 3px; cursor: pointer; text-align: left; font: inherit; color: inherit; min-width: 0; }
.cal-day:hover { border-color: var(--line); }
.cal-day.out { background: transparent; opacity: .45; }
.cal-day.today { border-color: var(--measured); }
.cal-day[aria-pressed="true"] { border-color: var(--ink); background: var(--surface); }
.cal-num { font: 11px var(--mono); color: var(--muted); display: flex; justify-content: space-between; gap: 4px; }
.cal-chips { display: flex; flex-wrap: wrap; gap: 2px; align-items: flex-end; }
.cal-chip { display: inline-block; width: calc(7px + 15px * var(--z)); height: calc(7px + 15px * var(--z)); border-radius: 2px; background: var(--c); }
.cal-chip.dim { opacity: .2; }
.cal-tag { font: 10px var(--body); color: var(--muted); background: var(--track); border-radius: 2px; padding: 0 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.cal-race { font: 600 10px var(--body); color: var(--projected); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cal-plan { width: 6px; height: 6px; border-radius: 50%; border: 1.5px solid var(--projected); display: inline-block; }
.cal-plan.chosen { background: var(--projected); }
.cal-week { font: 11px var(--mono); color: var(--muted); padding: 4px 2px 4px 6px; border-left: 1px solid var(--line); display: flex; flex-direction: column; gap: 2px; justify-content: center; }
.cal-week b { color: var(--ink); font-weight: 600; }
.cal-key { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--muted); margin-top: 10px; }
.cal-key i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.cal-detail ul { list-style: none; margin: 0; padding: 0; }
.cal-detail li { border-top: 1px solid var(--line); padding: 7px 0; display: flex; gap: 6px 12px; flex-wrap: wrap; align-items: baseline; }
.cal-filters { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px 14px; }
.cal-filters label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); }
.cal-filters input, .cal-filters select { font: 14px var(--body); padding: 5px 7px; border: 1px solid var(--line); border-radius: 3px; background: var(--surface); color: var(--ink); min-width: 0; }
.cal-filters .pair { display: flex; gap: 6px; }
.cal-filters .pair input { width: 100%; }
.cal-filters .wide { grid-column: 1 / -1; }
@media (max-width: 560px) {
  .cal-grid { grid-template-columns: repeat(7, minmax(0, 1fr)); }
  .cal-week { grid-column: 1 / -1; flex-direction: row; gap: 10px; border-left: 0; border-bottom: 1px solid var(--line); padding: 2px 4px 6px; }
  .cal-dow.wk { display: none; }
  .cal-day { min-height: 54px; padding: 2px; }
  .cal-tag, .cal-race { display: none; }
  .cal-chip { width: calc(5px + 9px * var(--z)); height: calc(5px + 9px * var(--z)); }
}
`;

// ---- pure helpers (exported for tests) ----
// Sport family for colour and the sport filter.
export function sportOf(type) {
  const t = String(type || '');
  if (F.RUN_TYPES.has(t)) return 'run';
  if (/cycl|bik|ride/.test(t)) return 'ride';
  if (/swim/.test(t)) return 'swim';
  if (/walk|hik/.test(t)) return 'walk';
  if (/strength|gym|weight/.test(t)) return 'strength';
  return 'other';
}
export const SPORTS = [['run', 'Run', 'var(--measured)'], ['ride', 'Ride', 'var(--series-1)'], ['swim', 'Swim', 'var(--series-3)'],
  ['walk', 'Walk / hike', 'var(--series-4)'], ['strength', 'Strength', 'var(--series-7)'], ['other', 'Other', 'var(--faint)']];
const colourOf = s => (SPORTS.find(x => x[0] === s) || SPORTS[5])[2];

// The weeks (Monday first) covering 'YYYY-MM'. -> [[7 day keys]]
export function monthWeeks(month) {
  const first = month + '-01', weeks = [];
  let w = weekStart(first);
  const next = dayKey(new Date(fromDay(first).getFullYear(), fromDay(first).getMonth() + 1, 1));
  while (w < next) { weeks.push(Array.from({ length: 7 }, (_, i) => addDayKey(w, i))); w = addDayKey(w, 7); }
  return weeks;
}
export function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number), d = new Date(y, m - 1 + n, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

export const EMPTY_FILTERS = { q: '', sport: '', source: '', tag: '', route: '', from: '', to: '', min: '', max: '' };
export const filtersActive = f => Object.keys(EMPTY_FILTERS).some(k => String(f[k] ?? '').trim() !== '');
// Where an activity came from: Garmin, Strava, or both (a Garmin activity linked to its Strava twin).
export const onGarmin = a => a.source === 'garmin';
export const onStrava = a => a.source === 'strava' || !!a.strava_id;
// Does activity `a` pass filters `f`? ctx: {journal, routes: Map(key -> {name, ids:Set})}
export function matches(a, f, ctx = {}) {
  const d = dayKey(a.start), j = (ctx.journal || {})[a.id] || {}, dj = (ctx.journal || {})[d] || {};
  const tags = [...(j.tags || []), ...(dj.tags || [])];
  if (f.sport && sportOf(a.type) !== f.sport) return false;
  if (f.source === 'garmin' && !onGarmin(a)) return false;
  if (f.source === 'strava' && !onStrava(a)) return false;
  if (f.source === 'both' && !(onGarmin(a) && onStrava(a))) return false;
  if (f.tag && !tags.includes(f.tag)) return false;
  const route = f.route && ctx.routes ? ctx.routes.get(f.route) : null;
  if (f.route && !(route && route.ids.has(a.id))) return false;
  if (f.from && d < f.from) return false;
  if (f.to && d > f.to) return false;
  const km = (a.distance_m || 0) / 1000;
  if (f.min !== '' && f.min != null && isFinite(+f.min) && km < +f.min) return false;
  if (f.max !== '' && f.max != null && isFinite(+f.max) && km > +f.max) return false;
  const q = String(f.q || '').trim().toLowerCase();
  if (q) {
    const hay = [a.name, typeLabel(a.type), a.type, j.note, dj.note, ...tags, d].filter(Boolean).join(' ').toLowerCase();
    if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
  }
  return true;
}
// Filters from a hash like '#/calendar?q=tempo&sport=run' (unknown keys ignored).
export function filtersFromHash(hash) {
  const qs = String(hash || '').split('?')[1];
  if (!qs) return null;
  const p = new URLSearchParams(qs), out = {};
  for (const k of [...Object.keys(EMPTY_FILTERS), 'month', 'day']) if (p.has(k)) out[k] = p.get(k);
  return Object.keys(out).length ? out : null;
}

// ---- module state ----
const ui = () => ((state.local.ui = state.local.ui || {}).calendar = state.local.ui.calendar || {});
let _month = null, _day = null, _f = null, _hashSeen = null;
function initState() {
  const u = ui();
  if (!_f) _f = { ...EMPTY_FILTERS, ...(u.filters || {}) };
  if (!_month) _month = u.month || dayKey(new Date()).slice(0, 7);
  const h = typeof location !== 'undefined' ? location.hash : '';
  if (h && h !== _hashSeen) {
    _hashSeen = h;
    const p = filtersFromHash(h);
    if (p) {
      const { month, day: d, ...f } = p;
      if (Object.keys(f).length) _f = { ...EMPTY_FILTERS, ...f };
      if (/^\d{4}-\d{2}-\d{2}$/.test(d || '')) { _day = d; _month = d.slice(0, 7); }
      else if (/^\d{4}-\d{2}$/.test(month || '')) _month = month;
    }
  }
}
const remember = () => { const u = ui(); u.filters = { ..._f }; u.month = _month; };

// What every part of the page reads, built once per render.
function context() {
  const acts = D.activities(state), byDay = new Map();
  for (const a of acts) { const k = dayKey(a.start); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(a); }
  const s = D.summary(state), thrHr = s ? s.threshold_hr : null, thrSpd = acts.length ? F.thresholds(acts)[1] : null;
  const load = a => { try { return thrHr ? F.activityLoad(a, thrHr, thrSpd) : null; } catch (e) { return null; } };
  const routes = new Map();
  for (const r of D.repeatedRoutes(state)) if (r.runs && r.runs.length) routes.set(String(r.runs[0].id), { name: r.name, count: r.count, ids: new Set(r.runs.map(m => m.id)) });
  const racesByDay = new Map();
  for (const r of D.races(state)) if (r.date) { if (!racesByDay.has(r.date)) racesByDay.set(r.date, []); racesByDay.get(r.date).push(r); }
  const tags = [...new Set(Object.values(state.journal || {}).flatMap(j => j.tags || []))].sort();
  return { acts, byDay, load, routes, racesByDay, tags, journal: state.journal || {}, today: dayKey(new Date()) };
}
// Chip size: training load where there is a threshold to score it, else duration.
const chipZ = (a, c) => { const l = c.load(a); return Math.min(1, Math.sqrt((l != null && l > 0 ? l / 150 : (a.moving_s || 0) / 5400))); };

function monthHtml(c) {
  const weeks = monthWeeks(_month), active = filtersActive(_f);
  const [y, m] = _month.split('-').map(Number);
  const label = new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return html`<div class="cal-nav"><h2>${label}</h2>
      <button class="btn btn-quiet" type="button" data-nav="-1" aria-label="Previous month">←</button>
      <button class="btn btn-quiet" type="button" data-nav="0">Today</button>
      <button class="btn btn-quiet" type="button" data-nav="1" aria-label="Next month">→</button></div>
    <div class="cal-grid" role="group" aria-label="${label}">
      ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => html`<span class="cal-dow">${d}</span>`)}<span class="cal-dow wk">Week</span>
      ${weeks.map(w => {
        let km = 0, secs = 0, load = 0;
        const cells = w.map(d => {
          const acts = c.byDay.get(d) || [], tags = (c.journal[d] && c.journal[d].tags) || [], races = c.racesByDay.get(d) || [];
          const pod = state.pod && state.pod[d];
          for (const a of acts) { km += (a.distance_m || 0) / 1000; secs += a.moving_s || 0; load += c.load(a) || 0; }
          const chosen = pod && pod.chosen != null && Array.isArray(pod.plans) ? pod.plans.find(p => p && (p.id === pod.chosen || p.name === pod.chosen)) : null;
          return html`<button type="button" class="cal-day${d.slice(0, 7) !== _month ? ' out' : ''}${d === c.today ? ' today' : ''}" data-day="${d}"
              aria-pressed="${String(d === _day)}" aria-label="${day(d, true)}: ${acts.length} activities">
            <span class="cal-num"><span>${+d.slice(8)}</span>${pod && Array.isArray(pod.plans) && pod.plans.length
              ? html`<span class="cal-plan${chosen ? ' chosen' : ''}" title="${chosen ? 'Plan: ' + (chosen.name || 'chosen') : pod.plans.length + ' plan options'}"></span>` : ''}</span>
            <span class="cal-chips">${acts.map(a => html`<i class="cal-chip${active && !matches(a, _f, c) ? ' dim' : ''}"
              style="--c:${colourOf(sportOf(a.type))};--z:${chipZ(a, c).toFixed(2)}" title="${a.name} · ${typeLabel(a.type)} · ${((a.distance_m || 0) / 1000).toFixed(1)} km"></i>`)}</span>
            ${races.map(r => html`<span class="cal-race" title="${r.name}">${r.name}</span>`)}
            ${tags.slice(0, 2).map(t => html`<span class="cal-tag">${t}</span>`)}${tags.length > 2 ? html`<span class="cal-tag">+${tags.length - 2}</span>` : ''}
          </button>`;
        });
        return html`${cells}<span class="cal-week" title="Week of ${day(w[0], true)}"><b>${km.toFixed(1)} km</b><span>${(secs / 3600).toFixed(1)} h</span>${load ? html`<span>${Math.round(load)} load</span>` : ''}</span>`;
      })}
    </div>
    <div class="cal-key">${SPORTS.map(([, l, col]) => html`<span><i style="background:${col}"></i>${l}</span>`)}
      <span>Bigger chip, more load (or longer, without a threshold to score it)</span>
      <span><i class="cal-plan chosen" style="border-radius:50%"></i>Plan of the day</span></div>`;
}

function dayHtml(c) {
  if (!_day) return html`<p class="stat-hint">Pick a day for its sessions, plans and tags.</p>`;
  const acts = c.byDay.get(_day) || [], races = c.racesByDay.get(_day) || [], pod = state.pod && state.pod[_day];
  const w = (() => { try { const s = String(dayTagsWidget(_day) ?? ''); return s.trim() ? raw(s) : ''; } catch (e) { return ''; } })();
  return html`<div class="panel-head"><p class="eyebrow">${fromDay(_day).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p></div>
    ${acts.length ? html`<ul>${acts.map(a => html`<li><a class="quiet-link" href="#/activity/${a.id}"><b>${a.name}</b></a>
      <span class="dim">${typeLabel(a.type)}</span><span class="num">${((a.distance_m || 0) / 1000).toFixed(2)} km</span>
      <span class="num">${fmtTime(a.moving_s)}</span><span class="num dim">${F.fmtEffort(a)}</span></li>`)}</ul>`
      : html`<p class="stat-hint">No activities${_day > c.today ? ' yet' : ''}.</p>`}
    ${races.map(r => html`<p>Race: <a class="quiet-link" href="#/race/${r.id}">${r.name}</a>
      <span class="dim">· ${((r.distance_m || 0) / 1000).toFixed(1)} km${r.actual_s ? ' · ran ' + fmtTime(r.actual_s) : ''}</span></p>`)}
    ${pod && Array.isArray(pod.plans) && pod.plans.length ? html`<p class="eyebrow" style="margin-top:12px">Plan of the day</p>
      <ul>${pod.plans.map(p => html`<li><b>${(p && p.name) || 'Plan'}</b>${p && (p.id === pod.chosen || p.name === pod.chosen) ? html` <span class="tag">chosen</span>` : ''}
        ${p && p.minutes != null ? html`<span class="dim">${p.minutes} min</span>` : ''}${p && p.why ? html`<span class="dim">${p.why}</span>` : ''}</li>`)}</ul>` : ''}
    ${w ? html`<div data-hook="daytags" style="margin-top:12px">${w}</div>` : ''}`;
}

function resultsHtml(c) {
  if (!filtersActive(_f)) return html`<p class="stat-hint">Search by name, note or tag, or narrow by sport, source, route, dates and distance.</p>`;
  const hits = c.acts.filter(a => matches(a, _f, c));
  const km = hits.reduce((s, a) => s + (a.distance_m || 0), 0) / 1000, secs = hits.reduce((s, a) => s + (a.moving_s || 0), 0);
  const shown = hits.slice(0, 300);
  return html`<p class="stat-hint">${hits.length} match${hits.length === 1 ? '' : 'es'}${hits.length ? html` · ${km.toFixed(1)} km · ${fmtTime(secs)}` : ''}${hits.length > shown.length ? ` · newest ${shown.length} shown` : ''}</p>
    ${shown.length ? html`<div class="table-scroll"><table>
      <thead><tr><th>Date</th><th>Activity</th><th class="num">Distance</th><th class="num">Time</th><th class="num">Pace / speed</th><th>From</th></tr></thead>
      <tbody>${shown.map(a => html`<tr>
        <td class="dim"><a class="quiet-link" href="#/calendar" data-goto="${dayKey(a.start)}">${day(dayKey(a.start))}</a></td>
        <td><a class="quiet-link" href="#/activity/${a.id}">${a.name}</a><span class="dim"> · ${typeLabel(a.type)}</span></td>
        <td class="num">${((a.distance_m || 0) / 1000).toFixed(2)} km</td><td class="num">${fmtTime(a.moving_s)}</td>
        <td class="num dim">${F.fmtEffort(a)}</td>
        <td class="dim">${onGarmin(a) && onStrava(a) ? 'both' : onStrava(a) ? 'Strava' : a.source === 'gymtracker' ? 'GymTracker' : 'Garmin'}</td></tr>`)}</tbody>
    </table></div>` : ''}`;
}

function filtersHtml(c) {
  const sel = (k, opts) => html`<select data-f="${k}">${opts.map(([v, l]) => html`<option value="${v}" ${String(_f[k]) === v ? raw('selected') : ''}>${l}</option>`)}</select>`;
  return html`<div class="cal-filters">
    <label class="wide">Search<input type="search" data-f="q" value="${_f.q}" placeholder="Name, note, tag…" enterkeyhint="search"></label>
    <label>Sport${sel('sport', [['', 'Any'], ...SPORTS.map(([v, l]) => [v, l])])}</label>
    <label>Source${sel('source', [['', 'Any'], ['garmin', 'Garmin'], ['strava', 'Strava'], ['both', 'On both']])}</label>
    <label>Tag${sel('tag', [['', 'Any'], ...c.tags.map(t => [t, t])])}</label>
    <label>Route${sel('route', [['', 'Any'], ...[...c.routes].map(([k, r]) => [k, `${r.name} (${r.count})`])])}</label>
    <label>Dates<span class="pair"><input type="date" data-f="from" value="${_f.from}" aria-label="From"><input type="date" data-f="to" value="${_f.to}" aria-label="To"></span></label>
    <label>Distance, km<span class="pair"><input type="number" inputmode="decimal" min="0" step="0.5" data-f="min" value="${_f.min}" placeholder="min" aria-label="Minimum km">
      <input type="number" inputmode="decimal" min="0" step="0.5" data-f="max" value="${_f.max}" placeholder="max" aria-label="Maximum km"></span></label>
  </div>
  <p style="margin-top:10px"><button class="btn btn-quiet" type="button" data-act="clear">Clear filters</button></p>`;
}

export function render() {
  useCss('calendar', CSS);
  initState();
  const c = context();
  if (!c.acts.length && !Object.keys(state.races).length) return html`${pageHead('Calendar')}
    ${emptyState('Nothing on the calendar yet', 'Activities appear here once Garmin or Strava data comes in through the cowork folder.',
      html`<a class="btn" href="#/sync">Sync &amp; cowork</a>`)}`;
  return html`<div class="cal-page">${pageHead('Calendar', `${c.acts.length} activities · search and browse`)}
    <section class="panel" id="cal-month">${monthHtml(c)}</section>
    <section class="panel cal-detail" id="cal-day">${dayHtml(c)}</section>
    <section class="panel"><div class="panel-head"><p class="eyebrow">Search</p>
      <p class="panel-note">Matching days stay bright on the calendar</p></div>
      ${filtersHtml(c)}<div id="cal-results" style="margin-top:14px">${resultsHtml(c)}</div></section></div>`;
}

export function mount(page) {
  // Listen on the page's own root: the router's #page element outlives this page, and
  // listeners on it would keep firing on whatever page comes next.
  const el = page.querySelector('.cal-page');
  if (!el) return;
  let c = context();
  const part = (id, fn) => { const box = el.querySelector('#' + id); if (box) box.innerHTML = String(fn(c)); };
  const showDay = () => {
    part('cal-day', dayHtml);
    const h = el.querySelector('#cal-day [data-hook="daytags"]');
    try { if (h) mountDayTags(h, _day); } catch (e) { console.warn('day tags', e); }
  };
  const showMonth = () => part('cal-month', monthHtml);
  el.addEventListener('click', e => {
    const nav = e.target.closest('[data-nav]'), cell = e.target.closest('.cal-day'), go = e.target.closest('[data-goto]');
    if (nav) { const n = +nav.dataset.nav; _month = n ? shiftMonth(_month, n) : c.today.slice(0, 7); remember(); showMonth(); return; }
    if (cell) { _day = cell.dataset.day === _day ? null : cell.dataset.day; showMonth(); showDay(); return; }
    if (go) {
      e.preventDefault();
      _day = go.dataset.goto; _month = _day.slice(0, 7); remember(); showMonth(); showDay();
      const m = el.querySelector('#cal-month'); if (m && m.scrollIntoView) m.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  let t;
  const onFilter = e => {
    const k = e.target.dataset && e.target.dataset.f;
    if (!k) return;
    _f[k] = e.target.value;
    remember();
    // Typing re-filters after a beat; a select or date re-filters at once.
    clearTimeout(t);
    t = setTimeout(() => { part('cal-results', resultsHtml); showMonth(); }, e.type === 'input' && k === 'q' ? 180 : 0);
  };
  el.addEventListener('input', onFilter);
  el.addEventListener('change', onFilter);
  const clr = el.querySelector('[data-act="clear"]');
  if (clr) clr.onclick = () => {
    _f = { ...EMPTY_FILTERS }; remember();
    el.querySelectorAll('[data-f]').forEach(i => { i.value = ''; });
    part('cal-results', resultsHtml); showMonth();
  };
  // Data that changed since render (a journal tag set in the day panel) shows on the next redraw.
  el.addEventListener('journal:saved', () => { c = context(); showMonth(); });
  if (_day) showDay();
}
