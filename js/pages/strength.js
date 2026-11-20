// Strength from GymTracker: the switch that lets gym sessions count in load, where the data
// stands, and every session with its estimated load and how it was estimated. Read-only
// towards GymTracker: Run315 reads gymtracker-state.json and never writes it.
import { state, save } from '../store.js';
import * as S from '../strength.js';
import { html, raw, esc, pageHead, day, ago, fmtTime, toast, useCss, t } from '../ui.js';
import { fmt } from '../i18n.js';

export const title = 'Strength';
const CSS = `
.gt-kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; font-size: 14px; margin: 0; }
.gt-kv dt { color: var(--muted); }
.gt-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.gt-bad { color: var(--behind); }
.gt-switch { display: flex; gap: 10px; align-items: flex-start; }
.gt-switch input { margin-top: 4px; }
`;
// i18n-keys: session RPE | heart rate | volume?
const METHOD = { srpe: 'session RPE', hr: 'heart rate', volume: 'volume?' };
const dec = (v, dp) => (fmt() ? fmt().number(v, { min: dp, max: dp }) : v.toFixed(dp));
// A translated sentence with markup inside it: each \u0001 placeholder becomes the next piece.
const withMarkup = (s, ...parts) => raw(parts.reduce((out, p) => out.replace('\u0001', String(p)), esc(s)));

function setupPanel(st) {
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">GymTracker</p>
      <p class="panel-note">${t('Synced choice · both devices')}</p></div>
    <label class="gt-switch"><input type="checkbox" data-act="gt-toggle" ${st.enabled ? 'checked' : ''}>
      <span>${t('Count GymTracker strength sessions in load, form and readiness.')}<br>
      <span class="stat-hint">${t("Run315 reads GymTracker's file from the same Google Drive app folder (connect Drive in both apps with the same account). It never writes to it. Cardio already in Run315 from Garmin or Strava is skipped, so nothing counts twice.")}</span></span></label>
    ${st.enabled ? html`<dl class="gt-kv" style="margin-top:12px">
      <dt>Google Drive</dt><dd>${st.drive ? t('connected') : html`<a class="quiet-link" href="#/sync">${t('not connected on this device')}</a>`}</dd>
      <dt>${t('Last read')}</dt><dd>${t('{when} (every {n} min at most, after a Drive sync)', { when: ago(st.fetchedAt), n: S.REFRESH_MIN })}</dd>
      <dt>${t('Sessions')}</dt><dd>${t.n('{n} in GymTracker · {counted} counted', '{n} in GymTracker · {counted} counted', st.sessions, { counted: st.counted })}</dd>
      ${st.lastError ? html`<dt>${t('Problem')}</dt><dd class="gt-bad">${st.lastError}</dd>` : ''}</dl>
      <div class="gt-actions"><button class="btn" data-act="gt-refresh" ${st.drive && !st.busy ? '' : 'disabled'}>${t('Read GymTracker now')}</button>
        ${st.sessions ? html`<button class="btn btn-ghost" data-act="gt-clear">${t('Forget on this device')}</button>` : ''}</div>` : ''}
  </section>`;
}

function methodPanel() {
  const b = s => `<b>${esc(s)}</b>`;
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">${t('How the load is estimated')}</p></div>
    <p style="margin-top:0">${t("Each session gets a number on the same scale as a run's load (an hour at threshold = 100), from the best evidence it has:")}</p>
    <ol>
      <li>${withMarkup(t("{method}, when you logged RPE on at least three sets: session RPE ≈ your mean set RPE − {minus} (the rests between sets make a session feel easier than its sets), × {per} per hour. A maximal hour is 100; an hour at RPE 6 is 60, about an easy hour's run.",
        { method: '\u0001', minus: S.RPE_TO_SESSION, per: S.LOAD_PER_RPE_HOUR }), b(t('Session RPE')))}</li>
      <li>${withMarkup(t("{method}, when GymTracker has the session's average HR (from Strava or a strap): exactly as for a run. It tends to read low for lifting.", { method: '\u0001' }), b(t('Heart rate')))}</li>
      <li>${withMarkup(t("{method} otherwise: each set's effort is guessed from its weight against your best for that lift, then as 1. A rough guess, marked with ?.", { method: '\u0001' }), b(t('Volume')))}</li>
    </ol>
    <p class="stat-hint">${t('There is no agreed conversion between lifting and endurance load; read every number as ±30–40 %. "Legs loaded" means at least {sets} fractional sets on quads, hamstrings, glutes or calves (GymTracker\'s muscle split) within {h} h. It says the legs worked, not how tired they are.', { sets: S.LEG_SETS_MIN, h: S.LEGS_WINDOW_H })}</p>
  </section>`;
}

function sessionsTable(acts) {
  if (!acts.length) return '';
  const rows = acts.slice().sort((a, b) => b.start.localeCompare(a.start)).slice(0, 40);
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">${t('Sessions')}</p>
      <p class="panel-note">${acts.length > rows.length
        ? t.n('{n} counted · newest {shown}', '{n} counted · newest {shown}', acts.length, { shown: rows.length })
        : t.n('{n} counted', '{n} counted', acts.length)}</p></div>
    <div class="table-scroll"><table>
      <thead><tr><th>${t('Date')}</th><th>${t('Session')}</th><th class="num">${t('Time')}</th><th class="num">${t('Sets')}</th><th class="num">${t('Leg sets')}</th><th class="num">${t('Load')}</th><th>${t('From')}</th></tr></thead>
      <tbody>${rows.map(a => html`<tr>
        <td class="dim">${day(a.start)}</td><td><a class="quiet-link" href="#/activity/${a.id}">${a.name}</a></td>
        <td class="num">${fmtTime(a.moving_s)}</td><td class="num">${a.sets}</td><td class="num">${dec(a.leg_sets, 1)}</td>
        <td class="num">${Math.round(a.load)}${a.load_confidence === 'low' ? '?' : ''}</td><td class="dim">${METHOD[a.load_method] ? t(METHOD[a.load_method]) : ''}</td></tr>`)}</tbody>
    </table></div></section>`;
}

export function render() {
  useCss('strength', CSS);
  const st = S.strengthStatus();
  const acts = S.strengthActivities();
  return html`${pageHead(t('Strength'), t('Gym sessions from GymTracker, counted in your load'))}
    ${setupPanel(st)}
    ${st.enabled ? S.strengthPanel() : ''}
    ${sessionsTable(acts)}
    ${methodPanel()}`;
}

export function mount(el, params) {
  const redraw = () => { el.innerHTML = String(render(params)); mount(el, params); };
  el.querySelector('[data-act="gt-toggle"]')?.addEventListener('change', async e => {
    const on = e.target.checked;
    state.profile = { ...state.profile, gymtracker: { ...(state.profile.gymtracker || {}), enabled: on }, u: new Date().toISOString() };
    save('edit');
    redraw();
    if (on) { await S.refreshStrength({ force: true }); redraw(); }
  });
  el.querySelector('[data-act="gt-refresh"]')?.addEventListener('click', async e => {
    e.target.disabled = true;
    const st = await S.refreshStrength({ force: true });
    toast(st.lastError ? st.lastError : t.n('Read {n} session from GymTracker', 'Read {n} sessions from GymTracker', st.sessions));
    redraw();
  });
  el.querySelector('[data-act="gt-clear"]')?.addEventListener('click', async () => { await S.clearStrength(); redraw(); });
}
