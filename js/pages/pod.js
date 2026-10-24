// Plan of the day: the sessions the agent wrote for today from this morning's numbers,
// the week so far, the training block and the weather -- the athlete picks one, and what
// actually happened goes back to the agent with the next request. Modelled on
// GymTracker's Plan of the Day; the logic lives in js/pod.js and js/forecast.js.
import { state, save } from '../store.js';
import { put } from '../merge.js';
import * as D from '../derive.js';
import * as cowork from '../cowork.js';
import { apiKey } from '../ai.js';
import { dayKey } from '../lib/dt.js';
import { forecastFor, shouldFetch, hourCost, defaultLocation } from '../forecast.js';
import { normOptions, forecastToday, outcomes, outcomeSummary, todayPod, chosenPlan, stepLine, planNow, INTENSITY } from '../pod.js';
import { html, pageHead, md, day, toast, useCss } from '../ui.js';

export const title = 'Plan of the day';

const CSS = `
.pod-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
.pod-card { border: 1.5px solid var(--line); border-radius: 2px; padding: 14px; background: var(--surface); display: flex; flex-direction: column; gap: 8px; }
.pod-card.chosen { border-color: var(--measured); }
.pod-card h3 { margin: 0; font-family: var(--display); font-size: 19px; }
.pod-card .pod-meta { font-family: var(--mono); font-size: 12px; color: var(--muted); margin: 0; }
.pod-card .pod-why { color: var(--muted); font-size: 14px; margin: 0; }
.pod-steps { margin: 0; padding-left: 18px; font-size: 14px; }
.pod-steps li { margin: 3px 0; }
.pod-card .btn, .pod-card .btn-ghost { align-self: flex-start; margin-top: auto; }
.pod-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.wx-strip { display: flex; gap: 4px; overflow-x: auto; padding-bottom: 6px; }
.wx-hour { flex: 0 0 52px; text-align: center; font-family: var(--mono); font-size: 11px; color: var(--muted);
  border: 1.5px solid transparent; border-radius: 2px; padding: 4px 0; background: var(--hover); }
.wx-hour b { display: block; font-size: 14px; color: var(--ink); font-weight: 600; }
.wx-hour.past { opacity: 0.45; }
.wx-hour.best { border-color: var(--measured); background: var(--measured-soft); }
.wx-bar { height: 4px; margin: 4px 6px 0; background: var(--warn); border-radius: 1px; }
.pod-opts textarea { width: 100%; min-height: 64px; font-family: var(--body); font-size: 14px; padding: 8px 10px;
  border: 1.5px solid var(--line); border-radius: 2px; background: var(--surface); color: var(--ink); box-sizing: border-box; }
.pod-opts input[type=number] { width: 84px; }
.pod-checks { display: flex; gap: 6px 14px; flex-wrap: wrap; font-size: 14px; }
.pod-status { font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; padding: 1px 6px;
  border-radius: 2px; color: var(--on-ink); background: var(--muted); }
.pod-status.done { background: var(--ahead); } .pod-status.skipped { background: var(--behind); } .pod-status.swapped { background: var(--warn); }
`;

const SPORTS = ['running', 'cycling', 'swimming', 'strength', 'walking'];
const SURFACES = ['road', 'trail', 'track', 'treadmill', 'grass'];
const r0 = v => (v == null ? '--' : String(Math.round(v)));
let _wxError = null, _busy = false;


function readinessNote(rd) {
  if (!rd) return '';
  const low = rd.band === 'depleted' || rd.band === 'strained';
  return html`<div class="flash ${low ? 'flash-error' : 'flash-info'}"><b>Readiness: ${rd.band}</b> (${r0(rd.score)}, ${rd.confidence} confidence) — ${rd.advice || rd.verdict}
    ${rd.band === 'depleted' ? html`<br>A plan that still prescribes training today should say plainly that it is going against this.` : ''}</div>`;
}

function card(p, i, rec, cond) {
  const chosen = rec.chosen === p.name;
  return html`<article class="pod-card ${chosen ? 'chosen' : ''}">
    <h3>${p.name}</h3>
    <p class="pod-meta">${p.sport}${p.minutes != null ? ' · ' + p.minutes + ' min' : ''} · ${INTENSITY[p.intensity] || ''}</p>
    ${p.why ? html`<p class="pod-why">${p.why}</p>` : ''}
    ${p.description ? md(p.description) : ''}
    ${p.steps.length ? html`<ol class="pod-steps">${p.steps.map(s => html`<li>${stepLine(s, cond)}</li>`)}</ol>` : ''}
    ${chosen ? html`<button class="btn-ghost btn" type="button" data-unchoose>Chosen — undo</button>`
    : html`<button class="btn" type="button" data-choose="${i}">I'll do this one</button>`}
  </article>`;
}

function askButtons(rec) {
  const folder = !!(state.local.cowork && state.local.cowork.enabled);
  return html`<div class="pod-actions">
    <button class="${rec ? 'btn btn-ghost' : 'btn'}" type="button" data-act="ask">${rec ? 'Ask the agent again' : 'Ask the agent'}</button>
    ${apiKey() ? html`<button class="btn btn-ghost" type="button" data-act="plan-now">${rec ? 'Re-plan now' : 'Plan it now'}</button>` : ''}
  </div>
  ${!folder ? html`<p class="stat-hint">The agent reads its request from the cowork folder — set one up on
    <a class="quiet-link" href="#/sync">Sync &amp; cowork</a>${apiKey() ? ', or plan it now with your own key' : ', or add your own Anthropic key there to plan it from here'}.</p>` : ''}`;
}

function plansPanel(rec, fc) {
  const cond = fc.best || null;
  const warm = cond && cond.penalty >= 0.005;
  if (!rec) return html`<section class="panel"><div class="panel-head"><p class="eyebrow">Today</p></div>
    <div class="empty"><p>No plan for today yet. The agent gets this morning's readiness, the week so far, your
      paces and zones, the training block, the forecast and your options below — and what happened to the plans it wrote before.</p></div>
    ${askButtons(null)}</section>`;
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">Today</p>
      <p class="panel-note">${rec.plans.length} options${rec.via === 'api' ? ' · planned here' : ''}</p></div>
    ${rec.rationale ? html`<p>${rec.rationale}</p>` : ''}
    <div class="pod-cards">${rec.plans.map((p, i) => card(p, i, rec, cond))}</div>
    ${warm ? html`<p class="stat-hint" style="margin-top:10px">Paces “in this heat” are slowed for the forecast at
      ${cond.start} (${r0(cond.temp)} °C, dew point ${r0(cond.dew)} °C): about ${(cond.penalty * 100).toFixed(1)}%, from a
      population heat curve, not one fitted to you. Run by heart rate where the two disagree.</p>` : ''}
    ${askButtons(rec)}</section>`;
}

function forecastPanel(fc, opts) {
  const head = html`<div class="panel-head"><p class="eyebrow">Weather today</p>
    ${fc.location ? html`<p class="panel-note">${fc.location.source === 'home' ? 'at home' : 'near your ' + fc.location.source}${fc.fetchedAt ? ' · Open-Meteo' : ''}</p>` : ''}</div>`;
  if (!fc.location) return html`<section class="panel">${head}<div class="empty"><p>Where do you run from? No home is set and no run
    has a GPS track yet. Set it under Options below and the forecast follows.</p></div></section>`;
  if (!fc.forecast) return html`<section class="panel">${head}<div class="empty"><p>${_wxError ? 'Forecast unavailable: ' + _wxError : 'Fetching the forecast…'}</p></div></section>`;
  const b = fc.best, t = fc.today, bestHours = new Set(), nowH = new Date().getHours();
  if (b) for (let h = b.startHour; h < b.startHour + b.minutes / 60; h++) bestHours.add(h);
  return html`<section class="panel">${head}
    ${t ? html`<p class="stat-hint">${r0(t.min_c)}–${r0(t.max_c)} °C${t.max_dew_c != null ? ', dew point up to ' + r0(t.max_dew_c) + ' °C' : ''}${t.max_rain_pct ? ', rain chance up to ' + t.max_rain_pct + '%' : ''}${t.max_wind_kph != null ? ', wind up to ' + r0(t.max_wind_kph) + ' km/h' : ''}.</p>` : ''}
    ${fc.hours.length ? html`<div class="wx-strip" role="list">${fc.hours.map(r => html`<div class="wx-hour ${bestHours.has(r.hour) ? 'best' : r.hour < nowH ? 'past' : ''}" role="listitem"
        title="${r.hour}:00 — ${r0(r.temp)} °C, feels ${r0(r.feels)}, dew ${r0(r.dew)}, ${r.rain ?? 0}% rain, ${r0(r.wind)} km/h">
        ${String(r.hour).padStart(2, '0')}<b>${r0(r.temp)}°</b>dp ${r0(r.dew)}<br>${r.rain ?? 0}%<br>${r0(r.wind)}k
        <div class="wx-bar" style="opacity:${Math.min(1, hourCost(r) / 8).toFixed(2)}"></div></div>`)}</div>`
    : html`<p class="stat-hint">No forecast hours left today inside ${opts.hours.from}:00–${opts.hours.to}:00.</p>`}
    ${b ? html`<p style="margin-top:10px"><b>Best ${b.minutes / 60 > 1 ? b.minutes / 60 + '-hour' : 'hour'}: ${b.start}–${b.end}</b>
        — ${r0(b.temp)} °C, dew point ${r0(b.dew)} °C, wind ${r0(b.wind)} km/h${b.rain ? ', ' + b.rain + '% rain' : ''}.
        ${b.matters ? (b.penalty >= 0.005 ? `The heat costs about ${(b.penalty * 100).toFixed(1)}% then, against ${(b.worst.penalty * 100).toFixed(1)}% at ${b.worst.start}.` : 'Clearly the kindest slot today.')
        : 'Every slot today is much the same; go when it suits.'}</p>` : ''}
    <p class="stat-hint">Bars: how much an hour costs a run (heat, wind above a breeze, rain chance) — a judgement, not a measurement.
      Inside your hours (${opts.hours.from}:00–${opts.hours.to}:00), from now.</p>
  </section>`;
}

function optionsPanel(opts) {
  const home = state.profile && state.profile.home, loc = defaultLocation(state);
  const box = (name, v, on) => html`<label><input type="checkbox" name="${name}" value="${v}" ${on ? 'checked' : ''}> ${v}</label>`;
  const extra = (list, known) => list.filter(x => !known.includes(x)).join(', ');
  return html`<section class="panel pod-opts"><div class="panel-head"><p class="eyebrow">Options</p>
      <p class="panel-note">Synced; the agent reads them with every request</p></div>
    <form data-form="opts">
      <div class="form-row">
        <div class="field"><label for="po-min">Minutes, at least</label><input type="number" id="po-min" name="min" min="5" max="600" step="5" value="${opts.availableMinutes.min}"></div>
        <div class="field"><label for="po-max">At most</label><input type="number" id="po-max" name="max" min="5" max="600" step="5" value="${opts.availableMinutes.max}"></div>
        <div class="field"><label for="po-from">Free from (hour)</label><input type="number" id="po-from" name="from" min="0" max="23" value="${opts.hours.from}"></div>
        <div class="field"><label for="po-to">Until</label><input type="number" id="po-to" name="to" min="1" max="24" value="${opts.hours.to}"></div>
      </div>
      <p class="eyebrow" style="margin-top:14px">Sports</p>
      <div class="pod-checks">${SPORTS.map(s => box('sports', s, opts.sports.includes(s)))}</div>
      <div class="field field-grow" style="margin-top:6px"><label for="po-sports">Other sports</label><input type="text" id="po-sports" name="sportsMore" value="${extra(opts.sports, SPORTS)}" placeholder="rowing, ski erg"></div>
      <p class="eyebrow" style="margin-top:14px">Surfaces</p>
      <div class="pod-checks">${SURFACES.map(s => box('surfaces', s, opts.surfaces.includes(s)))}</div>
      <div class="field field-grow" style="margin-top:10px"><label for="po-niggles">Niggles (comma-separated)</label><input type="text" id="po-niggles" name="niggles" value="${opts.niggles.join(', ')}" placeholder="left achilles, tight calf"></div>
      <div class="field" style="margin-top:10px"><label for="po-notes">Notes for the agent</label><textarea id="po-notes" name="notes" placeholder="Track session with the club on Tuesdays; no long runs on weekdays">${opts.notes}</textarea></div>
      <p class="eyebrow" style="margin-top:14px">Where you run from</p>
      <div class="form-row">
        <div class="field"><label for="po-lat">Latitude</label><input type="text" id="po-lat" name="lat" inputmode="decimal" value="${home ? home.lat : ''}" placeholder="${loc ? loc.lat.toFixed(3) : '51.5'}"></div>
        <div class="field"><label for="po-lon">Longitude</label><input type="text" id="po-lon" name="lon" inputmode="decimal" value="${home ? home.lon : ''}" placeholder="${loc ? loc.lon.toFixed(3) : '-0.12'}"></div>
        <button class="btn btn-ghost" type="button" data-act="geo">Use my location</button>
      </div>
      <p class="stat-hint">${home ? 'Set by hand.' : loc ? 'Blank: the forecast uses your ' + loc.source + '.' : 'Blank, and no run has a GPS track yet.'}</p>
      <div class="pod-actions"><button class="btn" type="submit">Save options</button></div>
    </form></section>`;
}

function historyPanel(rows) {
  const past = rows.filter(r => r.date < dayKey(new Date()) || r.status !== 'pending');
  if (!past.length) return '';
  const sm = outcomeSummary(rows);
  const plan = r => (r.planned.minutes != null ? r.planned.minutes + ' min' : '') + (r.planned.intensity ? ' · ' + (INTENSITY[r.planned.intensity] || '') : '');
  const act = r => (r.actual ? r.actual.minutes + ' min' + (r.actual.intensity ? ' · ' + INTENSITY[r.actual.intensity] + (r.actual.intensityFrom === 'avg hr' ? ' (from HR)' : '') : '')
    : r.didInstead ? r.didInstead.map(d => d.sport + ' ' + d.minutes + ' min').join(', ') : '—');
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">What happened to the plans</p>
      <p class="panel-note">last 14 days · sent back to the agent</p></div>
    <p class="stat-hint">${sm.done} done, ${sm.swapped} swapped, ${sm.skipped} skipped${sm.medianMinutesRatio != null ? `; done sessions ran ${Math.round(sm.medianMinutesRatio * 100)}% of the planned time (median)` : ''}.
      ${sm.note || ''} Matching is by day and sport; set it by hand where it guessed wrong.</p>
    <div class="table-scroll"><table>
      <thead><tr><th>Day</th><th>Plan</th><th>Status</th><th class="num">Planned</th><th class="num">Actual</th><th>Set by hand</th></tr></thead>
      <tbody>${rows.map(r => html`<tr>
        <td>${day(r.date)}</td>
        <td>${r.plan || '—'}${r.chosen ? '' : r.inferred ? html` <span class="dim">(not picked)</span>` : ''}</td>
        <td><span class="pod-status ${r.status}">${r.status}</span></td>
        <td class="num dim">${plan(r) || '—'}</td>
        <td class="num">${r.actual ? html`<a class="quiet-link" href="#/activity/${r.actual.id}">${act(r)}</a>` : act(r)}</td>
        <td><select data-outcome="${r.date}" aria-label="Outcome for ${r.date}">
          ${['', 'done', 'swapped', 'skipped'].map(v => html`<option value="${v}" ${(r.byHand ? r.status : '') === v ? 'selected' : ''}>${v || 'auto'}</option>`)}
        </select></td></tr>`)}</tbody></table></div>
  </section>`;
}

export function render() {
  useCss('pod', CSS);
  const now = new Date(), rec = todayPod(state, now), opts = normOptions(state.profile && state.profile.podOptions);
  const fc = forecastToday(state, now, opts), s = D.summary(state, now);
  const acts = D.activities(state);
  const rows = outcomes(state.pod, acts, state.journal, s ? s.threshold_hr : null, dayKey(now));
  return html`
    ${pageHead('Plan of the day', 'A few sessions for today, written from this morning’s numbers, the week so far, the block and the weather. Pick one; what you actually did goes back with the next request.')}
    ${readinessNote(D.readinessToday(state, s ? s.tsb : null))}
    ${plansPanel(rec, fc)}
    ${forecastPanel(fc, opts)}
    ${optionsPanel(opts)}
    ${historyPanel(rows)}`;
}

export function mount(el) {
  const redraw = () => { el.innerHTML = String(render()); mount(el); };
  const on = (sel, ev, fn) => el.querySelectorAll(sel).forEach(n => { n[ev] = fn; });
  const today = dayKey(new Date());

  // The forecast: fetched once an hour at most (forecast.js caches), then the page redraws.
  const fc = forecastToday(state);
  if (fc.location && !fc.forecast && !_wxError && shouldFetch(fc.location.lat, fc.location.lon)) forecastFor(fc.location.lat, fc.location.lon)
    .then(() => { if (el.isConnected) redraw(); })
    .catch(e => { _wxError = e.message || String(e); if (el.isConnected) redraw(); });

  on('[data-choose]', 'onclick', ev => {
    const rec = state.pod[today], p = rec && rec.plans[+ev.currentTarget.dataset.choose];
    if (!p) return;
    put(state, 'pod', today, { ...rec, chosen: p.name, chosenAt: new Date().toISOString() }); save('edit');
    toast(p.name + ' it is.'); redraw();
  });
  on('[data-unchoose]', 'onclick', () => {
    const rec = state.pod[today]; if (!rec) return;
    put(state, 'pod', today, { ...rec, chosen: null, chosenAt: null }); save('edit'); redraw();
  });
  on('[data-outcome]', 'onchange', ev => {
    const date = ev.target.dataset.outcome, rec = state.pod[date]; if (!rec) return;
    const v = ev.target.value;
    put(state, 'pod', date, { ...rec, outcome: v ? { status: v, at: new Date().toISOString() } : null }); save('edit'); redraw();
  });

  on('[data-act="ask"]', 'onclick', async ev => {
    if (!cowork.supported() || !(state.local.cowork && state.local.cowork.enabled)) { toast('Set up the cowork folder on Sync & cowork first.'); return; }
    ev.currentTarget.disabled = true;
    const ok = await cowork.exportNow(false);
    toast(ok ? 'Request written to pod/ in the cowork folder. The reply lands here.' : 'Could not write the request — see Sync & cowork.');
    if (el.isConnected) redraw();
  });
  on('[data-act="plan-now"]', 'onclick', async ev => {
    if (_busy) return;
    _busy = true; const b = ev.currentTarget; b.disabled = true; b.textContent = 'Planning…';
    try { const r = await planNow(); toast(r.note); } catch (e) { toast(e.message || String(e), 6000); }
    finally { _busy = false; if (el.isConnected) redraw(); }
  });

  on('[data-act="geo"]', 'onclick', () => {
    if (!navigator.geolocation) { toast('This browser cannot share a location.'); return; }
    navigator.geolocation.getCurrentPosition(p => {
      const f = el.querySelector('[data-form="opts"]');
      if (!f) return;
      f.elements.lat.value = p.coords.latitude.toFixed(4); f.elements.lon.value = p.coords.longitude.toFixed(4);
      toast('Location filled in — save to keep it.');
    }, e => toast('No location: ' + (e.message || 'permission denied')), { timeout: 15000, maximumAge: 3600e3 });
  });
  on('[data-form="opts"]', 'onsubmit', ev => {
    ev.preventDefault();
    const f = ev.target.elements, list = v => String(v || '').split(',').map(x => x.trim()).filter(Boolean);
    const checked = name => [...ev.target.querySelectorAll(`input[name="${name}"]:checked`)].map(x => x.value);
    const podOptions = normOptions({ availableMinutes: { min: +f.min.value, max: +f.max.value },
      sports: [...checked('sports'), ...list(f.sportsMore.value)], surfaces: checked('surfaces'), niggles: list(f.niggles.value),
      notes: f.notes.value, hours: { from: +f.from.value, to: +f.to.value } });
    const lat = parseFloat(f.lat.value), lon = parseFloat(f.lon.value);
    let home = null;
    if (f.lat.value.trim() || f.lon.value.trim()) {
      if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) { toast('Latitude and longitude need to be numbers, e.g. 51.5 and -0.12.'); return; }
      home = { lat: +lat.toFixed(4), lon: +lon.toFixed(4) };
    }
    const prevHome = state.profile.home || null;
    state.profile = { ...state.profile, podOptions, home, u: new Date().toISOString() };
    save('edit');
    if (JSON.stringify(prevHome) !== JSON.stringify(home)) _wxError = null;
    // The agent reads options from the request, so rewrite it when there is a folder (as GymTracker does).
    if (state.local.cowork && state.local.cowork.enabled) cowork.exportNow(true).catch(() => {});
    toast('Options saved.'); redraw();
  });
}
