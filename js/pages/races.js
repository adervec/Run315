// Every race on the calendar: the ones ahead with their projection, the ones run with
// their result. Also home to the pieces Today shares -- the start list row, the past
// races table, the calibration line and the add-race form (app.py's add_race / parse_goal).
import { state, save } from '../store.js';
import { put, remove } from '../merge.js';
import * as D from '../derive.js';
import { dayKey, daysBetween } from '../lib/dt.js';
import { html, raw, esc, ago, pageHead, emptyState, fmtTime, fmtPace, toast, useCss, day, km, t } from '../ui.js';
import { fmt } from '../i18n.js';
import { cleanFields } from '../racemail.js';
import * as cowork from '../cowork.js';

export const title = 'Races';
export const LANES = { high: 3, medium: 2, low: 1, none: 0 };
// The confidence key is data; the tooltip shows it through t():
// i18n-keys: high | medium | low | none
// The datalist shows its label through t():
// i18n-keys: Half marathon | Marathon
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
// A share (0.032) as the reader's percent, one decimal.
const pct = x => (fmt() ? fmt().percent(x, 1) : (x * 100).toFixed(1) + '%');

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
    <div class="countdown"><b>${days >= 0 ? days : '--'}</b><small>${days >= 0 ? t('days') : t('past')}</small></div>
    <div class="race-cell">
      <p class="race-name"><a href="#/race/${encodeURIComponent(race.id)}">${race.name}</a></p>
      <p class="race-sub">${day(race.date, true)} · ${km(race.distance_m, 2)} km</p>
      ${raceFacts(race)}
      <div class="lanes" title="${t('Confidence: {level}', { level: p ? t(p.confidence) : t('no data') })}">
        ${[0, 1, 2].map(i => html`<span class="lane ${p && i < LANES[p.confidence] ? 'on' : ''}"></span>`)}
      </div>
    </div>
    <div class="proj-cell">
      ${p ? html`<div class="projected">${fmtTime(p.seconds)}<small>${fmtPace(p.seconds, race.distance_m)}</small></div>`
        : html`<div class="projected dim" style="font-size:20px">${t('no data')}<small>${t('sync a few runs first')}</small></div>`}
    </div>
    <div class="delta">
      ${diff != null ? html`<span class="${diff > 0 ? 'behind' : 'ahead'}">${minus(diff)}${fmtTime(Math.abs(diff))}</span>
        <small>${t('vs {time}', { time: fmtTime(race.goal_s) })}</small>`
        : p ? html`<span class="dim">—</span><small>${t('no goal set')}</small>` : ''}
    </div>
    <div class="del-cell"><button class="btn-quiet" type="button" data-del-race="${race.id}" title="${t('Remove {name}', { name: race.name })}">×</button></div>
  </div>`;
}

// What the races channel filled in (status, start time, wave, bib, place, pickup), on one quiet line.
// i18n-keys: registered | deferred | cancelled | done
export function raceFacts(r) {
  const bits = [
    r.status && r.status !== 'registered' ? t(r.status) : '',
    r.start_time ? t('start {time}', { time: r.start_time }) : '',
    r.wave ? t('wave {wave}', { wave: r.wave }) : '',
    r.bib ? t('bib {bib}', { bib: r.bib }) : '',
    r.place || '',
    r.pickup ? t('pickup {when}', { when: [r.pickup.date && day(r.pickup.date), r.pickup.where].filter(Boolean).join(', ') }) : '',
  ].filter(Boolean);
  if (!bits.length && !r.url) return '';
  return html`<p class="race-sub dim">${bits.join(' · ')}${r.url ? html`${bits.length ? ' · ' : ''}<a class="quiet-link" href="${r.url}" target="_blank" rel="noopener noreferrer">${t('race website')}</a>` : ''}</p>`;
}

export function pastTable(past) {
  return html`<div class="table-scroll races-past"><table>
    <thead><tr><th>${t('Race')}</th><th>${t('Date')}</th><th class="num">${t('Result')}</th><th class="num">${t('Projected')}</th><th class="num">${t('Gap')}</th></tr></thead>
    <tbody>${past.map(r => {
      const gap = r.actual_s && r.predicted_s ? r.actual_s - r.predicted_s : null;
      return html`<tr>
        <td><a class="quiet-link" href="#/race/${encodeURIComponent(r.id)}">${r.name}</a></td>
        <td class="dim">${day(r.date, true)}</td>
        <td class="num actual">${r.actual_s ? fmtTime(r.actual_s) : '—'}${r.chip_s ? html`<br><small class="dim">${t('chip {time}', { time: fmtTime(r.chip_s) })}</small>` : ''}</td>
        <td class="num time">${r.predicted_s ? fmtTime(r.predicted_s) : '—'}</td>
        <td class="num">${gap != null ? html`<span class="${gap > 0 ? 'behind' : 'ahead'}">${minus(gap)}${fmtTime(Math.abs(gap))}</span>`
          : !r.actual_s ? html`<a class="quiet-link" href="#/race/${encodeURIComponent(r.id)}">${t('add result')}</a>` : '—'}</td>
      </tr>`;
    })}</tbody></table></div>`;
}

export function calibrationNote(cal, anyUpcoming) {
  if (cal) return html`<p class="stat-hint" style="margin-top:12px">${t.n(
    'Calibrated on {n} past result: you have run {direction} by {error} on average, so projections are adjusted {adjust}.',
    'Calibrated on {n} past results: you have run {direction} by {error} on average, so projections are adjusted {adjust}.',
    cal.n, { direction: t(cal.direction), error: pct(cal.mean_abs_error), adjust: (cal.factor - 1 >= 0 ? '+' : '') + pct(cal.factor - 1) })}</p>`;
  if (anyUpcoming) return html`<p class="stat-hint" style="margin-top:12px">${t('Once two races have results entered, projections calibrate to how you actually race.')}</p>`;
  return '';
}

export function raceForm() {
  return html`<form class="form-row" data-race-form style="margin-top:18px">
      <div class="field field-grow"><label for="rn">${t('Race')}</label>
        <input type="text" id="rn" name="name" placeholder="${t('City Marathon')}" required></div>
      <div class="field"><label for="rd">${t('Date')}</label>
        <input type="date" id="rd" name="date" required></div>
      <div class="field"><label for="rdist">${t('Distance (m)')}</label>
        <input type="number" id="rdist" name="distance" list="dists" min="300" max="500000" step="1" required></div>
      <div class="field"><label for="rg">${t('Goal time')}</label>
        <input type="text" id="rg" name="goal" placeholder="1:29:30" pattern="[0-9:.]*"></div>
      <button class="btn" type="submit">${t('Add race')}</button>
    </form>
    <datalist id="dists">${DISTANCES.map(([label, d]) => html`<option value="${d}">${t(label)}</option>`)}</datalist>`;
}

// add_race: a name, a real date, a distance in metres; the goal is optional.
export function addRace(fields) {
  const name = String(fields.name || '').trim() || 'Race';   // stored: stays English
  const date = String(fields.date || '').trim();
  const distance = parseFloat(fields.distance);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date)) || !(distance >= 300 && distance <= 500000))
    throw new Error(t('Give the race a valid date and a distance in metres.'));
  const id = 'race-' + Date.now().toString(36);
  put(state, 'races', id, { id, name: name.slice(0, 120), date, distance_m: distance, goal_s: parseGoal(fields.goal),
    actual_s: null, predicted_s: null, garmin_id: null, created_at: new Date().toISOString(), ...cleanFields({ url: fields.url, place: fields.place }) });
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
    try { addRace(Object.fromEntries(new FormData(f))); toast(t('Race added')); redraw(); }
    catch (e) { toast(e.message); }
  });
  el.querySelectorAll('[data-del-race]').forEach(b => b.onclick = () => {
    const r = state.races[b.dataset.delRace];
    if (!r || (typeof confirm === 'function' && !confirm(t('Remove {name}?', { name: r.name })))) return;
    deleteRace(r.id); toast(t('Race removed')); redraw();
  });
}

export function render() {
  useCss('races', CSS);
  const { upcoming, past, today } = split(state);
  const cal = D.calibration(state);
  if (!upcoming.length && !past.length) return html`${pageHead(t('Races'))}
    ${emptyState(t('No races on the calendar'), t('Add the next one and Run315 will project your finish time from here on.'), raceForm())}
    ${channelPanel()}`;
  return html`${pageHead(t('Races'), t('{ahead} ahead · {run} run', { ahead: upcoming.length, run: past.length }))}
    <section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('Start list')}</p><p class="panel-note">${t('Projections update on every sync')}</p></div>
      ${upcoming.length ? html`<div class="startlist">${upcoming.map(([r, p]) => startRow(r, p, today))}</div>`
        : html`<div class="empty"><p>${t('Nothing ahead. Add the next one and Run315 will project your finish time from here on.')}</p></div>`}
      ${calibrationNote(cal, upcoming.length)}
      ${raceForm()}
    </section>
    ${past.length ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('Run')}</p><p class="panel-note">${t.n('{n} past race · each result teaches the projections', '{n} past races · each result teaches the projections', past.length)}</p></div>
      ${pastTable(past)}</section>` : ''}
    ${channelPanel()}`;
}

// Updates from email and race websites, and the races the agent scouted when asked.
function channelPanel() {
  const waiting = cowork.pendingReviews().filter(p => p.channel === 'races').length;
  const sc = state.local.raceScout, sug = (state.local.raceSuggestions && state.local.raceSuggestions.list) || [];
  const lnk = '<a class="quiet-link" href="#/sync">' + esc(t('Sync & cowork')) + '</a>';
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('From your email and the web')}</p>
      <p class="panel-note">${waiting ? t.n('{n} race update waiting for you', '{n} race updates waiting for you', waiting) : ''}</p></div>
    <p class="stat-hint">${raw(esc(t("The cowork races channel reads your race emails (entries, bibs, start times, changes, results) and each race's website, then proposes updates you tick on {link}. Only races you have entered are added.", { link: '\u0001' })).replace('\u0001', lnk))}</p>
    <form class="form-row" data-scout-form style="margin-top:14px">
      <div class="field field-grow"><label for="sreg">${t('Scout for races near')}</label>
        <input type="text" id="sreg" name="region" maxlength="80" value="${(sc && sc.region) || ''}" placeholder="${t('a city or region')}"></div>
      <div class="field"><label for="smo">${t('Within')}</label>
        <select id="smo" name="months">${[3, 6, 12].map(m => html`<option value="${m}" ${(sc ? sc.months : 6) === m ? 'selected' : ''}>${t.n('{n} month', '{n} months', m)}</option>`)}</select></div>
      <fieldset class="field"><legend>${t('Distances')}</legend>${DISTANCES.map(([label, d]) => html`<label><input type="checkbox" name="d" value="${d}" ${sc && (sc.distances_m || []).includes(d) ? 'checked' : ''}> ${t(label)}</label> `)}</fieldset>
      <button class="btn" type="submit">${sc ? t('Scout again') : t('Scout')}</button>
    </form>
    ${sc ? html`<p class="stat-hint">${t('Asked {when}: the next races reply brings suggestions.', { when: ago(sc.at) })}</p>` : ''}
    ${sug.length ? html`<div class="table-scroll"><table><thead><tr><th>${t('Suggested race')}</th><th>${t('Date')}</th><th class="num">km</th><th></th></tr></thead>
      <tbody>${sug.map((x, i) => html`<tr><td>${x.url ? html`<a class="quiet-link" href="${x.url}" target="_blank" rel="noopener noreferrer">${x.name}</a>` : x.name}
        ${x.place || x.why ? html`<br><small class="dim">${[x.place, x.why].filter(Boolean).join(' · ')}</small>` : ''}</td>
        <td class="dim">${day(x.date, true)}</td><td class="num">${km(x.distance_m, 1)}</td>
        <td><button class="btn btn-quiet" type="button" data-sug-add="${i}">${t('Add')}</button> <button class="btn-quiet" type="button" data-sug-drop="${i}" title="${t('Not for me')}">×</button></td></tr>`)}</tbody></table></div>` : ''}
  </section>`;
}

function wireChannel(el, redraw) {
  const f = el.querySelector('[data-scout-form]');
  if (f) f.onsubmit = ev => {
    ev.preventDefault();
    const fd = new FormData(f);
    state.local.raceScout = { at: new Date().toISOString(), region: String(fd.get('region') || '').trim().slice(0, 80) || null,
      months: [3, 6, 12].includes(+fd.get('months')) ? +fd.get('months') : 6, distances_m: fd.getAll('d').map(Number).filter(Boolean) };
    save('local');
    cowork.exportNow(false).catch(e => console.warn('scout export', e));
    toast(t('Asked: the next races reply brings suggestions.')); redraw();
  };
  const list = () => (state.local.raceSuggestions && state.local.raceSuggestions.list) || [];
  el.querySelectorAll('[data-sug-add]').forEach(b => b.onclick = () => {
    const x = list()[+b.dataset.sugAdd]; if (!x) return;
    try { addRace({ name: x.name, date: x.date, distance: x.distance_m, url: x.url, place: x.place }); } catch (e) { toast(e.message); return; }
    list().splice(+b.dataset.sugAdd, 1); save('local'); toast(t('Race added')); redraw();
  });
  el.querySelectorAll('[data-sug-drop]').forEach(b => b.onclick = () => { list().splice(+b.dataset.sugDrop, 1); save('local'); redraw(); });
}

export function mount(el) {
  const redraw = () => { el.innerHTML = String(render()); mount(el); };
  wireRaceForms(el, redraw);
  wireChannel(el, redraw);
}
