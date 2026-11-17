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
import { normOptions, forecastToday, outcomes, outcomeSummary, todayPod, stepLine, planNow, intensityLabel } from '../pod.js';
import { html, raw, esc, t, pageHead, md, day, toast, useCss } from '../ui.js';

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

// Stored as written here (the agent reads them); shown through t().
// i18n-keys: running | cycling | swimming | strength | walking
// i18n-keys: road | trail | track | treadmill | grass
// i18n-keys: done | swapped | skipped | pending
// i18n-keys: Fewer than five plans so far: read these as anecdotes, not a pattern.
const SPORTS = ['running', 'cycling', 'swimming', 'strength', 'walking'];
const SURFACES = ['road', 'trail', 'track', 'treadmill', 'grass'];
// Where the forecast is for (forecast.js defaultLocation's `source`), in the reader's words.
const NEAR = () => ({ home: t('at home'), 'most-run tile': t('near your most-run tile'), 'latest activity': t('near your latest activity') });
const BLANK_USES = () => ({ 'most-run tile': t('Blank: the forecast uses your most-run tile.'), 'latest activity': t('Blank: the forecast uses your latest activity.') });
// A sentence with a link inside it: the whole sentence is one t() string with {link} as '\u0001',
// escaped, then the link goes in.
const withLink = (translated, linkHtml) => raw(esc(translated).replace('\u0001', linkHtml));
const r0 = v => (v == null ? '--' : String(Math.round(v)));
let _wxError = null, _busy = false;


function readinessNote(rd) {
  if (!rd) return '';
  const low = rd.band === 'depleted' || rd.band === 'strained';
  return html`<div class="flash ${low ? 'flash-error' : 'flash-info'}"><b>${t('Readiness: {band}', { band: rd.band })}</b> (${t('{score}, {level} confidence', { score: r0(rd.score), level: rd.confidence })}) — ${rd.advice || rd.verdict}
    ${rd.band === 'depleted' ? html`<br>${t('A plan that still prescribes training today should say plainly that it is going against this.')}` : ''}</div>`;
}

function card(p, i, rec, cond) {
  const chosen = rec.chosen === p.name;
  return html`<article class="pod-card ${chosen ? 'chosen' : ''}">
    <h3>${p.name}</h3>
    <p class="pod-meta">${t(p.sport)}${p.minutes != null ? ' · ' + p.minutes + ' min' : ''} · ${intensityLabel(p.intensity)}</p>
    ${p.why ? html`<p class="pod-why">${p.why}</p>` : ''}
    ${p.description ? md(p.description) : ''}
    ${p.steps.length ? html`<ol class="pod-steps">${p.steps.map(s => html`<li>${stepLine(s, cond)}</li>`)}</ol>` : ''}
    ${chosen ? html`<button class="btn-ghost btn" type="button" data-unchoose>${t('Chosen — undo')}</button>`
    : html`<button class="btn" type="button" data-choose="${i}">${t("I'll do this one")}</button>`}
  </article>`;
}

function askButtons(rec) {
  const folder = !!(state.local.cowork && state.local.cowork.enabled);
  return html`<div class="pod-actions">
    <button class="${rec ? 'btn btn-ghost' : 'btn'}" type="button" data-act="ask">${rec ? t('Ask the agent again') : t('Ask the agent')}</button>
    ${apiKey() ? html`<button class="btn btn-ghost" type="button" data-act="plan-now">${rec ? t('Re-plan now') : t('Plan it now')}</button>` : ''}
  </div>
  ${!folder ? html`<p class="stat-hint">${withLink(apiKey()
    ? t('The agent reads its request from the cowork folder — set one up on {link}, or plan it now with your own key.', { link: '\u0001' })
    : t('The agent reads its request from the cowork folder — set one up on {link}, or add your own Anthropic key there to plan it from here.', { link: '\u0001' }),
  `<a class="quiet-link" href="#/sync">${esc(t('Sync & cowork'))}</a>`)}</p>` : ''}`;
}

function plansPanel(rec, fc) {
  const cond = fc.best || null;
  const warm = cond && cond.penalty >= 0.005;
  if (!rec) return html`<section class="panel"><div class="panel-head"><p class="eyebrow">${t('Today')}</p></div>
    <div class="empty"><p>${t("No plan for today yet. The agent gets this morning's readiness, the week so far, your paces and zones, the training block, the forecast and your options below — and what happened to the plans it wrote before.")}</p></div>
    ${askButtons(null)}</section>`;
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">${t('Today')}</p>
      <p class="panel-note">${t.n('{n} option', '{n} options', rec.plans.length)}${rec.via === 'api' ? ' · ' + t('planned here') : ''}</p></div>
    ${rec.rationale ? html`<p>${rec.rationale}</p>` : ''}
    <div class="pod-cards">${rec.plans.map((p, i) => card(p, i, rec, cond))}</div>
    ${warm ? html`<p class="stat-hint" style="margin-top:10px">${t('Paces “in this heat” are slowed for the forecast at {time} ({temp} °C, dew point {dew} °C): about {pct}%, from a population heat curve, not one fitted to you. Run by heart rate where the two disagree.',
      { time: cond.start, temp: r0(cond.temp), dew: r0(cond.dew), pct: (cond.penalty * 100).toFixed(1) })}</p>` : ''}
    ${askButtons(rec)}</section>`;
}

// The day's range: "8–19 °C, dew point up to 12 °C, rain chance up to 30%, wind up to 18 km/h."
function dayLine(td) {
  const parts = [t('{min}–{max} °C', { min: r0(td.min_c), max: r0(td.max_c) })];
  if (td.max_dew_c != null) parts.push(t('dew point up to {n} °C', { n: r0(td.max_dew_c) }));
  if (td.max_rain_pct) parts.push(t('rain chance up to {n}%', { n: td.max_rain_pct }));
  if (td.max_wind_kph != null) parts.push(t('wind up to {n} km/h', { n: r0(td.max_wind_kph) }));
  return t('{list}.', { list: parts.join(', ') });
}

function forecastPanel(fc, opts) {
  const head = html`<div class="panel-head"><p class="eyebrow">${t('Weather today')}</p>
    ${fc.location ? html`<p class="panel-note">${NEAR()[fc.location.source] || fc.location.source}${fc.fetchedAt ? ' · Open-Meteo' : ''}</p>` : ''}</div>`;
  if (!fc.location) return html`<section class="panel">${head}<div class="empty"><p>${t('Where do you run from? No home is set and no run has a GPS track yet. Set it under Options below and the forecast follows.')}</p></div></section>`;
  if (!fc.forecast) return html`<section class="panel">${head}<div class="empty"><p>${_wxError ? t('Forecast unavailable: {error}', { error: _wxError }) : t('Fetching the forecast…')}</p></div></section>`;
  const b = fc.best, td = fc.today, bestHours = new Set(), nowH = (fc.wall || new Date()).getHours();
  if (b) for (let h = b.startHour; h < b.startHour + b.minutes / 60; h++) bestHours.add(h);
  return html`<section class="panel">${head}
    ${td ? html`<p class="stat-hint">${dayLine(td)}</p>` : ''}
    ${fc.hours.length ? html`<div class="wx-strip" role="list">${fc.hours.map(r => html`<div class="wx-hour ${bestHours.has(r.hour) ? 'best' : r.hour < nowH ? 'past' : ''}" role="listitem"
        title="${t('{hour}:00 — {temp} °C, feels {feels}, dew {dew}, {rain}% rain, {wind} km/h', { hour: r.hour, temp: r0(r.temp), feels: r0(r.feels), dew: r0(r.dew), rain: r.rain ?? 0, wind: r0(r.wind) })}">
        ${String(r.hour).padStart(2, '0')}<b>${r0(r.temp)}°</b>dp ${r0(r.dew)}<br>${r.rain ?? 0}%<br>${r0(r.wind)}k
        <div class="wx-bar" style="opacity:${Math.min(1, hourCost(r) / 8).toFixed(2)}"></div></div>`)}</div>`
    : html`<p class="stat-hint">${t('No forecast hours left today inside {from}:00–{to}:00.', { from: opts.hours.from, to: opts.hours.to })}</p>`}
    ${b ? html`<p style="margin-top:10px"><b>${b.minutes / 60 > 1 ? t('Best {n}-hour: {start}–{end}', { n: b.minutes / 60, start: b.start, end: b.end }) : t('Best hour: {start}–{end}', { start: b.start, end: b.end })}</b>
        — ${b.rain ? t('{temp} °C, dew point {dew} °C, wind {wind} km/h, {rain}% rain.', { temp: r0(b.temp), dew: r0(b.dew), wind: r0(b.wind), rain: b.rain })
          : t('{temp} °C, dew point {dew} °C, wind {wind} km/h.', { temp: r0(b.temp), dew: r0(b.dew), wind: r0(b.wind) })}
        ${b.matters ? (b.penalty >= 0.005 ? t('The heat costs about {pct}% then, against {worst}% at {time}.', { pct: (b.penalty * 100).toFixed(1), worst: (b.worst.penalty * 100).toFixed(1), time: b.worst.start }) : t('Clearly the kindest slot today.'))
        : t('Every slot today is much the same; go when it suits.')}</p>` : ''}
    <p class="stat-hint">${t('Bars: how much an hour costs a run (heat, wind above a breeze, rain chance) — a judgement, not a measurement. Inside your hours ({from}:00–{to}:00), from now.', { from: opts.hours.from, to: opts.hours.to })}</p>
  </section>`;
}

function optionsPanel(opts) {
  const home = state.profile && state.profile.home, loc = defaultLocation(state);
  const box = (name, v, on) => html`<label><input type="checkbox" name="${name}" value="${v}" ${on ? 'checked' : ''}> ${t(v)}</label>`;
  const extra = (list, known) => list.filter(x => !known.includes(x)).join(', ');
  return html`<section class="panel pod-opts"><div class="panel-head"><p class="eyebrow">${t('Options')}</p>
      <p class="panel-note">${t('Synced; the agent reads them with every request')}</p></div>
    <form data-form="opts">
      <div class="form-row">
        <div class="field"><label for="po-min">${t('Minutes, at least')}</label><input type="number" id="po-min" name="min" min="5" max="600" step="5" value="${opts.availableMinutes.min}"></div>
        <div class="field"><label for="po-max">${t('At most')}</label><input type="number" id="po-max" name="max" min="5" max="600" step="5" value="${opts.availableMinutes.max}"></div>
        <div class="field"><label for="po-from">${t('Free from (hour)')}</label><input type="number" id="po-from" name="from" min="0" max="23" value="${opts.hours.from}"></div>
        <div class="field"><label for="po-to">${t('Until')}</label><input type="number" id="po-to" name="to" min="1" max="24" value="${opts.hours.to}"></div>
      </div>
      <p class="eyebrow" style="margin-top:14px">${t('Sports')}</p>
      <div class="pod-checks">${SPORTS.map(s => box('sports', s, opts.sports.includes(s)))}</div>
      <div class="field field-grow" style="margin-top:6px"><label for="po-sports">${t('Other sports')}</label><input type="text" id="po-sports" name="sportsMore" value="${extra(opts.sports, SPORTS)}" placeholder="${t('rowing, ski erg')}"></div>
      <p class="eyebrow" style="margin-top:14px">${t('Surfaces')}</p>
      <div class="pod-checks">${SURFACES.map(s => box('surfaces', s, opts.surfaces.includes(s)))}</div>
      <div class="field field-grow" style="margin-top:10px"><label for="po-niggles">${t('Niggles (comma-separated)')}</label><input type="text" id="po-niggles" name="niggles" value="${opts.niggles.join(', ')}" placeholder="${t('left achilles, tight calf')}"></div>
      <div class="field" style="margin-top:10px"><label for="po-notes">${t('Notes for the agent')}</label><textarea id="po-notes" name="notes" placeholder="${t('Track session with the club on Tuesdays; no long runs on weekdays')}">${opts.notes}</textarea></div>
      <p class="eyebrow" style="margin-top:14px">${t('Where you run from')}</p>
      <div class="form-row">
        <div class="field"><label for="po-lat">${t('Latitude')}</label><input type="text" id="po-lat" name="lat" inputmode="decimal" value="${home ? home.lat : ''}" placeholder="${loc ? loc.lat.toFixed(3) : '51.5'}"></div>
        <div class="field"><label for="po-lon">${t('Longitude')}</label><input type="text" id="po-lon" name="lon" inputmode="decimal" value="${home ? home.lon : ''}" placeholder="${loc ? loc.lon.toFixed(3) : '-0.12'}"></div>
        <button class="btn btn-ghost" type="button" data-act="geo">${t('Use my location')}</button>
      </div>
      <p class="stat-hint">${home ? t('Set by hand.') : loc ? BLANK_USES()[loc.source] || '' : t('Blank, and no run has a GPS track yet.')}</p>
      <div class="pod-actions"><button class="btn" type="submit">${t('Save options')}</button></div>
    </form></section>`;
}

function historyPanel(rows) {
  const past = rows.filter(r => r.date < dayKey(new Date()) || r.status !== 'pending');
  if (!past.length) return '';
  const sm = outcomeSummary(rows);
  const plan = r => (r.planned.minutes != null ? r.planned.minutes + ' min' : '') + (r.planned.intensity ? ' · ' + intensityLabel(r.planned.intensity) : '');
  const act = r => (r.actual ? r.actual.minutes + ' min' + (r.actual.intensity ? ' · ' + (r.actual.intensityFrom === 'avg hr'
      ? t('{intensity} (from HR)', { intensity: intensityLabel(r.actual.intensity) }) : intensityLabel(r.actual.intensity)) : '')
    : r.didInstead ? r.didInstead.map(d => t(d.sport) + ' ' + d.minutes + ' min').join(', ') : '—');
  const counts = t('{done} done, {swapped} swapped, {skipped} skipped', { done: sm.done, swapped: sm.swapped, skipped: sm.skipped });
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">${t('What happened to the plans')}</p>
      <p class="panel-note">${t('last 14 days · sent back to the agent')}</p></div>
    <p class="stat-hint">${sm.medianMinutesRatio != null ? t('{counts}; done sessions ran {pct}% of the planned time (median).', { counts, pct: Math.round(sm.medianMinutesRatio * 100) }) : t('{counts}.', { counts })}
      ${sm.note ? t(sm.note) : ''} ${t('Matching is by day and sport; set it by hand where it guessed wrong.')}</p>
    <div class="table-scroll"><table>
      <thead><tr><th>${t('Day')}</th><th>${t('Plan')}</th><th>${t('Status')}</th><th class="num">${t('Planned')}</th><th class="num">${t('Actual')}</th><th>${t('Set by hand')}</th></tr></thead>
      <tbody>${rows.map(r => html`<tr>
        <td>${day(r.date)}</td>
        <td>${r.plan || '—'}${r.chosen ? '' : r.inferred ? html` <span class="dim">${t('(not picked)')}</span>` : ''}</td>
        <td><span class="pod-status ${r.status}">${t(r.status)}</span></td>
        <td class="num dim">${plan(r) || '—'}</td>
        <td class="num">${r.actual ? html`<a class="quiet-link" href="#/activity/${r.actual.id}">${act(r)}</a>` : act(r)}</td>
        <td><select data-outcome="${r.date}" aria-label="${t('Outcome for {day}', { day: day(r.date) })}">
          ${['', 'done', 'swapped', 'skipped'].map(v => html`<option value="${v}" ${(r.byHand ? r.status : '') === v ? 'selected' : ''}>${v ? t(v) : t('auto')}</option>`)}
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
    ${pageHead(t('Plan of the day'), t('A few sessions for today, written from this morning’s numbers, the week so far, the block and the weather. Pick one; what you actually did goes back with the next request.'))}
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
    toast(t('{plan} it is.', { plan: p.name })); redraw();
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
    if (!cowork.supported() || !(state.local.cowork && state.local.cowork.enabled)) { toast(t('Set up the cowork folder on Sync & cowork first.')); return; }
    ev.currentTarget.disabled = true;
    const ok = await cowork.exportNow(false);
    toast(ok ? t('Request written to pod/ in the cowork folder. The reply lands here.') : t('Could not write the request — see Sync & cowork.'));
    if (el.isConnected) redraw();
  });
  on('[data-act="plan-now"]', 'onclick', async ev => {
    if (_busy) return;
    _busy = true; const b = ev.currentTarget; b.disabled = true; b.textContent = t('Planning…');
    try { const r = await planNow(); toast(t.n('{n} plan for {day}.', '{n} plans for {day}.', r.count, { day: day(r.date) })); } catch (e) { toast(e.message || String(e), 6000); }
    finally { _busy = false; if (el.isConnected) redraw(); }
  });

  on('[data-act="geo"]', 'onclick', () => {
    if (!navigator.geolocation) { toast(t('This browser cannot share a location.')); return; }
    navigator.geolocation.getCurrentPosition(p => {
      const f = el.querySelector('[data-form="opts"]');
      if (!f) return;
      f.elements.lat.value = p.coords.latitude.toFixed(4); f.elements.lon.value = p.coords.longitude.toFixed(4);
      toast(t('Location filled in — save to keep it.'));
    }, e => toast(t('No location: {why}', { why: e.message || t('permission denied') })), { timeout: 15000, maximumAge: 3600e3 });
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
      if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) { toast(t('Latitude and longitude need to be numbers, e.g. 51.5 and -0.12.')); return; }
      home = { lat: +lat.toFixed(4), lon: +lon.toFixed(4) };
    }
    const prevHome = state.profile.home || null;
    state.profile = { ...state.profile, podOptions, home, u: new Date().toISOString() };
    save('edit');
    if (JSON.stringify(prevHome) !== JSON.stringify(home)) _wxError = null;
    // The agent reads options from the request, so rewrite it when there is a folder (as GymTracker does).
    if (state.local.cowork && state.local.cowork.enabled) cowork.exportNow(true).catch(() => {});
    toast(t('Options saved.')); redraw();
  });
}
