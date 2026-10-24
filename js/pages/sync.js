// Where data comes from and goes: Google Drive (phone <-> desktop), the cowork folder
// (Garmin and Strava in, analysis out), manual import/export, the demo, and settings.
import { state, save, putStream, hasStream, streamIds, replaceState } from '../store.js';
import { emptyState as freshState, syncPayload } from '../merge.js';
import * as drive from '../drive.js';
import * as cowork from '../cowork.js';
import * as D from '../derive.js';
import { importGarmin, importStrava } from '../ingest.js';
import { setKey, apiKey, MODEL } from '../ai.js';
import { html, pageHead, ago, toast, useCss } from '../ui.js';

export const title = 'Sync & cowork';
const CSS = `
.sync-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; }
.sync-grid .panel { margin: 0; }
.row-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.runlog { font-family: var(--mono); font-size: 12px; max-height: 280px; overflow: auto; }
.runlog td { padding: 4px 8px; vertical-align: top; }
.bad { color: var(--behind); } .good { color: var(--ahead); }
.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; font-size: 14px; margin: 0; }
.kv dt { color: var(--muted); }
`;

function drivePanel() {
  const c = state.local.cloud || {};
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">Google Drive</p></div>
    <p class="panel-note" style="margin:0 0 12px">Phone and desktop share one copy in Drive's private app folder: invisible in your Drive, readable only by this app.</p>
    ${c.enabled ? html`<dl class="kv"><dt>Account</dt><dd>${c.account?.name || 'connected'}</dd>
      <dt>Last sync</dt><dd>${ago(c.lastSync)}</dd>
      ${c.lastError ? html`<dt>Error</dt><dd class="bad">${c.lastError}</dd>` : ''}</dl>
      <div class="row-actions"><button class="btn" data-act="drive-sync">Sync now</button><button class="btn btn-ghost" data-act="drive-off">Disconnect</button></div>`
    : html`<div class="row-actions"><button class="btn" data-act="drive-on" ${drive.originAllowed() ? '' : 'disabled'}>Connect Google Drive</button></div>
      ${drive.originAllowed() ? '' : html`<p class="panel-note">Only on adervec.github.io or localhost.</p>`}`}
  </section>`;
}

function coworkPanel() {
  const c = state.local.cowork || {}, runs = cowork.runs().slice(0, 30), s = c.schedules || { pushMin: 60, checkMin: 5 };
  if (!cowork.supported()) return html`<section class="panel"><div class="panel-head"><p class="eyebrow">Cowork folder</p></div>
    <p>The cowork folder needs a desktop Chromium browser (Chrome, Edge). On this device, data arrives through Drive from the desktop that runs it.</p></section>`;
  return html`<section class="panel" style="grid-column:1/-1"><div class="panel-head"><p class="eyebrow">Cowork folder</p>
      <p class="panel-note">${c.enabled ? 'Folder: ' + (c.folderName || '?') : 'Not set up'}</p></div>
    <p style="margin-top:0">A folder an AI agent shares with this app. The app writes what it is missing and what you asked; the agent runs the Garmin and Strava exporters (or uses its connectors), answers your questions, and drops the replies in each channel's <code>inbox/</code>. Point CoworkSyncHub (<code>coworkhub.py add run315 manifest &lt;folder&gt;</code>) or Claude Desktop at it.</p>
    <div id="cowork-panel-host"></div>
    <div class="row-actions">
      <button class="btn" data-act="cw-pick">${c.enabled ? 'Change folder' : 'Choose folder'}</button>
      ${c.enabled ? html`<button class="btn btn-ghost" data-act="cw-push">Send requests</button><button class="btn btn-ghost" data-act="cw-poll">Check for replies</button>` : ''}
    </div>
    ${c.enabled ? html`<p class="panel-note" style="margin:12px 0 0">Send every <input type="number" min="0" style="width:70px" data-sched="pushMin" value="${s.pushMin}"> min,
      check every <input type="number" min="0" style="width:70px" data-sched="checkMin" value="${s.checkMin}"> min (0 = manual).</p>` : ''}
    ${runs.length ? html`<div class="runlog"><table><tbody>${runs.map(r => html`<tr><td class="dim">${ago(r.at)}</td><td>${r.kind}${r.channel ? ' · ' + r.channel : ''}</td>
      <td class="${r.ok ? 'good' : 'bad'}">${r.ok ? 'ok' : 'failed'}</td><td>${r.note || ''}</td></tr>`)}</tbody></table></div>` : ''}
  </section>`;
}

function dataPanel() {
  const n = Object.keys(state.activities).length;
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">Data</p></div>
    <dl class="kv"><dt>Activities</dt><dd>${n}</dd><dt>Analysed streams</dt><dd>${Object.keys(state.derived).length}</dd>
      <dt>Days / nights</dt><dd>${Object.keys(state.daily).length} / ${Object.keys(state.wellness).length}</dd></dl>
    <div class="row-actions">
      <label class="btn btn-ghost">Import reply JSON<input type="file" accept=".json,application/json" data-act="import" hidden></label>
      <button class="btn btn-ghost" data-act="export">Download everything</button>
      <button class="btn btn-ghost" data-act="csv">Activities CSV</button>
      <button class="btn btn-ghost" data-act="rederive">Re-analyse streams</button>
    </div>
    <div class="row-actions">
      <button class="btn btn-ghost" data-act="demo">Load demo athlete</button>
      <button class="btn-quiet" data-act="wipe">Erase everything on this device</button>
    </div></section>`;
}

function settingsPanel() {
  const t = state.local.theme || 'system';
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">AI & appearance</p></div>
    <p class="panel-note" style="margin:0 0 8px">Your own Anthropic key lets Ask and the coach answer instantly, without the folder. Kept on this device only; sent only to api.anthropic.com. Model: ${MODEL}.</p>
    <div class="row-actions"><input type="password" placeholder="sk-ant-…" data-key value="${apiKey() ? '••••••••' : ''}" style="flex:1"><button class="btn btn-ghost" data-act="key">Save key</button></div>
    <div class="row-actions" role="group" aria-label="Theme">${['system', 'light', 'dark'].map(x =>
      html`<button class="btn btn-ghost" data-theme="${x}" aria-pressed="${t === x}">${x}</button>`)}</div></section>`;
}

export function render() {
  useCss('sync', CSS);
  return html`${pageHead('Sync & cowork', 'Garmin and Strava in · analysis out · every device in step')}
    <div class="sync-grid">${coworkPanel()}${drivePanel()}${dataPanel()}${settingsPanel()}</div>`;
}

function download(name, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
// The demo goes through the same importer as real Garmin data.
export async function loadDemo() {
  const { demoGarminPayload, demoExtras } = await import('../demo.js');
  const r = await importGarmin(state, demoGarminPayload(), putStream);
  const x = demoExtras();
  for (const k of Object.keys(x)) Object.assign(state[k], x[k]);
  await D.deriveAll(state, r.streams);
  save('demo');
  return r;
}

async function importFile(file) {
  const env = cowork.parseEnvelope(await file.text());
  if (!env.ok) throw new Error(env.reason);
  const r = env.kind === 'garmin-output' ? await importGarmin(state, env.payload, putStream)
    : env.kind === 'strava-output' ? await importStrava(state, env.payload, putStream, hasStream) : null;
  if (!r) throw new Error('Not a garmin-output or strava-output file');
  for (const id of r.streams) await drive.queueStream(id);
  await D.deriveAll(state, r.streams);
  save('cowork-import');
  return r;
}

export function mount(el) {
  const redraw = () => { el.innerHTML = String(render()); mount(el); };
  const busy = async (btn, fn, ok) => {
    btn.disabled = true;
    try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok); }
    catch (e) { toast('⚠ ' + (e.message || e)); console.error(e); }
    finally { redraw(); }
  };
  const host = el.querySelector('#cowork-panel-host');
  if (host && (state.local.cowork || {}).enabled) {
    const s = document.createElement('script'); s.src = 'https://adervec.github.io/cowork.js'; s.async = true;
    s.onload = () => {
      if (!customElements.get('cowork-panel') || !host.isConnected) return;
      const p = document.createElement('cowork-panel'); p.setAttribute('mode', 'data'); p.data = cowork.panelData();
      p.addEventListener('cowork-action', ev => {
        const a = ev.detail && ev.detail.action;
        (a === 'push' ? cowork.exportNow(false) : a === 'poll' ? cowork.pollAll(true) : Promise.resolve()).then(() => { p.data = cowork.panelData(); });
      });
      host.replaceChildren(p);
    };
    document.head.appendChild(s);
  }
  el.querySelectorAll('[data-act]').forEach(b => {
    const act = b.dataset.act;
    if (act === 'import') { b.onchange = () => b.files[0] && busy(b, () => importFile(b.files[0]), r => `Imported ${r.activities} activities, ${r.streams.length} streams`); return; }
    b.onclick = () => ({
      'drive-on': () => busy(b, drive.connect, 'Google Drive connected'),
      'drive-sync': () => busy(b, drive.sync, 'Synced'),
      'drive-off': () => { drive.disconnect(); redraw(); },
      'cw-pick': () => busy(b, cowork.pickFolder, 'Cowork folder ready: requests written'),
      'cw-push': () => busy(b, () => cowork.exportNow(false), 'Requests written'),
      'cw-poll': () => busy(b, () => cowork.pollAll(true), n => n ? `Imported ${n} replies` : 'No new replies'),
      export: () => download('run315-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(syncPayload(state))),
      csv: () => {
        const rows = [['start', 'name', 'type', 'distance_m', 'moving_s', 'elapsed_s', 'avg_hr', 'max_hr', 'elev_gain_m', 'calories', 'garmin_id', 'strava_id']];
        for (const a of D.activities(state)) rows.push([a.start.toISOString(), a.name, a.type, a.distance_m, a.moving_s, a.elapsed_s, a.avg_hr, a.max_hr, a.elev_gain_m, a.calories, a.garmin_id, a.strava_id]);
        download('run315-activities.csv', rows.map(r => r.map(v => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(',')).join('\n'), 'text/csv');
      },
      rederive: () => busy(b, async () => { const n = await D.deriveAll(state, await streamIds()); save('derive'); return n; }, n => `Re-analysed ${n} streams`),
      demo: () => busy(b, loadDemo, r => `Demo athlete loaded: ${r.activities} activities`),
      wipe: () => {
        if (!confirm('Erase every activity, race and setting on this device? Drive keeps its copy.')) return;
        replaceState(freshState()); state.local = {}; save('cloud'); indexedDB.deleteDatabase('run315'); setTimeout(() => location.reload(), 300);
      },
      key: () => { const v = el.querySelector('[data-key]').value; if (!v.startsWith('•')) { setKey(v); toast(v ? 'Key saved on this device' : 'Key removed'); } },
    }[act] || (() => {}))();
  });
  el.querySelectorAll('[data-theme]').forEach(b => b.onclick = () => { state.local.theme = b.dataset.theme; save('theme'); redraw(); });
  el.querySelectorAll('[data-sched]').forEach(i => i.onchange = () => {
    const c = state.local.cowork; c.schedules = { ...(c.schedules || {}), [i.dataset.sched]: Math.max(0, +i.value || 0) }; save('cowork');
  });
}
