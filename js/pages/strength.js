// Strength from GymTracker: the switch that lets gym sessions count in load, where the data
// stands, and every session with its estimated load and how it was estimated. Read-only
// towards GymTracker: Run315 reads gymtracker-state.json and never writes it.
import { state, save } from '../store.js';
import * as S from '../strength.js';
import { html, pageHead, day, ago, fmtTime, toast, useCss } from '../ui.js';

export const title = 'Strength';
const CSS = `
.gt-kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; font-size: 14px; margin: 0; }
.gt-kv dt { color: var(--muted); }
.gt-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.gt-bad { color: var(--behind); }
.gt-switch { display: flex; gap: 10px; align-items: flex-start; }
.gt-switch input { margin-top: 4px; }
`;
const METHOD = { srpe: 'session RPE', hr: 'heart rate', volume: 'volume?' };

function setupPanel(st) {
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">GymTracker</p>
      <p class="panel-note">Synced choice · both devices</p></div>
    <label class="gt-switch"><input type="checkbox" data-act="gt-toggle" ${st.enabled ? 'checked' : ''}>
      <span>Count GymTracker strength sessions in load, form and readiness.<br>
      <span class="stat-hint">Run315 reads GymTracker's file from the same Google Drive app folder (connect Drive in both apps with the same account). It never writes to it. Cardio already in Run315 from Garmin or Strava is skipped, so nothing counts twice.</span></span></label>
    ${st.enabled ? html`<dl class="gt-kv" style="margin-top:12px">
      <dt>Google Drive</dt><dd>${st.drive ? 'connected' : html`<a class="quiet-link" href="#/sync">not connected on this device</a>`}</dd>
      <dt>Last read</dt><dd>${ago(st.fetchedAt)} (every ${S.REFRESH_MIN} min at most, after a Drive sync)</dd>
      <dt>Sessions</dt><dd>${st.sessions} in GymTracker · ${st.counted} counted</dd>
      ${st.lastError ? html`<dt>Problem</dt><dd class="gt-bad">${st.lastError}</dd>` : ''}</dl>
      <div class="gt-actions"><button class="btn" data-act="gt-refresh" ${st.drive && !st.busy ? '' : 'disabled'}>Read GymTracker now</button>
        ${st.sessions ? html`<button class="btn btn-ghost" data-act="gt-clear">Forget on this device</button>` : ''}</div>` : ''}
  </section>`;
}

function methodPanel() {
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">How the load is estimated</p></div>
    <p style="margin-top:0">Each session gets a number on the same scale as a run's load (an hour at threshold = 100), from the best evidence it has:</p>
    <ol>
      <li><b>Session RPE</b>, when you logged RPE on at least three sets: session RPE ≈ your mean set RPE − ${S.RPE_TO_SESSION} (the rests between sets make a session feel easier than its sets), × ${S.LOAD_PER_RPE_HOUR} per hour. A maximal hour is 100; an hour at RPE 6 is 60, about an easy hour's run.</li>
      <li><b>Heart rate</b>, when GymTracker has the session's average HR (from Strava or a strap): exactly as for a run. It tends to read low for lifting.</li>
      <li><b>Volume</b> otherwise: each set's effort is guessed from its weight against your best for that lift, then as 1. A rough guess, marked with ?.</li>
    </ol>
    <p class="stat-hint">There is no agreed conversion between lifting and endurance load; read every number as ±30–40 %. "Legs loaded" means at least ${S.LEG_SETS_MIN} fractional sets on quads, hamstrings, glutes or calves (GymTracker's muscle split) within ${S.LEGS_WINDOW_H} h. It says the legs worked, not how tired they are.</p>
  </section>`;
}

function sessionsTable(acts) {
  if (!acts.length) return '';
  const rows = acts.slice().sort((a, b) => b.start.localeCompare(a.start)).slice(0, 40);
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">Sessions</p>
      <p class="panel-note">${acts.length} counted${acts.length > rows.length ? ` · newest ${rows.length}` : ''}</p></div>
    <div class="table-scroll"><table>
      <thead><tr><th>Date</th><th>Session</th><th class="num">Time</th><th class="num">Sets</th><th class="num">Leg sets</th><th class="num">Load</th><th>From</th></tr></thead>
      <tbody>${rows.map(a => html`<tr>
        <td class="dim">${day(a.start)}</td><td><a class="quiet-link" href="#/activity/${a.id}">${a.name}</a></td>
        <td class="num">${fmtTime(a.moving_s)}</td><td class="num">${a.sets}</td><td class="num">${a.leg_sets.toFixed(1)}</td>
        <td class="num">${Math.round(a.load)}${a.load_confidence === 'low' ? '?' : ''}</td><td class="dim">${METHOD[a.load_method] || ''}</td></tr>`)}</tbody>
    </table></div></section>`;
}

export function render() {
  useCss('strength', CSS);
  const st = S.strengthStatus();
  const acts = S.strengthActivities();
  return html`${pageHead('Strength', 'Gym sessions from GymTracker, counted in your load')}
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
    toast(st.lastError ? st.lastError : `Read ${st.sessions} sessions from GymTracker`);
    redraw();
  });
  el.querySelector('[data-act="gt-clear"]')?.addEventListener('click', async () => { await S.clearStrength(); redraw(); });
}
