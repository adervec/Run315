// Data review: what the app found suspicious in the imported data, the agent's view on each
// finding, and the athlete's decision. Nothing changes until a button is pressed, and an
// approved fix changes Run315's copy only -- Garmin and Strava are never written to.
import { state, save, streamIds, getStream } from '../store.js';
import * as D from '../derive.js';
import * as R from '../datareview.js';
import { html, pageHead, emptyState, day, typeLabel, ago, toast, useCss } from '../ui.js';

export const title = 'Data review';

const CSS = `
.dr-card { border-top: 1px solid var(--line); padding: 14px 0; }
.dr-card:first-of-type { border-top: none; padding-top: 0; }
.dr-what { margin: 0 0 4px; }
.dr-detail { margin: 0 0 8px; color: var(--muted); }
.dr-ev { display: flex; flex-wrap: wrap; gap: 4px 12px; margin: 0 0 8px; font-family: var(--mono); font-size: 12px; color: var(--muted); }
.dr-ev b { color: var(--ink); font-weight: 600; }
.dr-prop { border-left: 3px solid var(--projected); background: var(--projected-soft); padding: 8px 12px; margin: 0 0 10px; font-size: 14px; }
.dr-prop .eyebrow { margin: 0 0 2px; }
.dr-acts { display: flex; flex-wrap: wrap; gap: 8px; }
.dr-kind-about { margin: -6px 0 14px; color: var(--muted); font-size: 14px; max-width: 70ch; }
.dr-decided td { vertical-align: top; }
`;

const fmtEv = v => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '')) : String(v));
const evLabel = k => k.replace(/_m_s$/, ' (m/s)').replace(/_s$/, ' (s)').replace(/_m$/, ' (m)').replace(/_pct$/, ' (%)').replace(/_/g, ' ');

function actLink(id) {
  const a = state.activities[id];
  if (!a) return html`<span class="dim">${id}</span>`;
  return html`<a class="quiet-link" href="#/activity/${a.id}">${a.name || a.id}</a>
    <span class="dim"> · ${day(a.start)} · ${typeLabel(a.type)} · ${a.source === 'strava' ? 'Strava' : 'Garmin'}</span>`;
}
function fixText(f, p) {
  if (f.kind === 'near-miss') return 'merge the two into the Garmin activity';
  return Object.entries(p.fix || {}).map(([k, v]) => `${k.replace(/_/g, ' ')} → ${typeof v === 'string' ? typeLabel(v) : fmtEv(v)}`).join(', ');
}

function card(f) {
  const rec = state.dataReview[f.id] || {}, p = rec.proposal;
  const canFix = (p && p.action === 'fix') || f.kind === 'near-miss';
  const ev = Object.entries(f.evidence || {}).filter(([, v]) => v != null && v !== '');
  return html`<div class="dr-card" data-finding="${f.id}">
    <p class="dr-what">${actLink(f.activity_id)}${f.other_id ? html` <span class="dim">and</span> ${actLink(f.other_id)}` : ''}</p>
    <p class="dr-detail">${f.detail}</p>
    ${ev.length ? html`<div class="dr-ev">${ev.map(([k, v]) => html`<span>${evLabel(k)} <b>${fmtEv(v)}</b></span>`)}</div>` : ''}
    ${p ? html`<div class="dr-prop"><p class="eyebrow">Agent proposes: ${p.action}</p>
      ${p.action === 'fix' ? html`<p style="margin:0 0 4px"><strong>${fixText(f, p)}</strong></p>` : ''}
      ${p.reason ? html`<p style="margin:0">${p.reason}</p>` : ''}</div>` : ''}
    <div class="dr-acts">
      ${canFix ? html`<button type="button" class="btn" data-dr="fix">${p && p.action === 'fix' ? 'Approve fix' : 'Merge them'}</button>` : ''}
      <button type="button" class="btn btn-ghost" data-dr="keep" title="The data is right">Keep</button>
      <button type="button" class="btn btn-ghost" data-dr="ignore" title="Wrong, but harmless">Ignore</button>
    </div></div>`;
}

function decided(all) {
  const rows = Object.values(state.dataReview).filter(r => r && r.decision && !String(r.id).startsWith('scan:'))
    .sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)));
  if (!rows.length) return '';
  const live = new Map(all.map(f => [f.id, f]));
  return html`<section class="panel"><details><summary class="eyebrow">Decided (${rows.length})</summary>
    <div class="table-scroll"><table class="dr-decided"><thead><tr><th>Finding</th><th>Decision</th><th>When</th><th></th></tr></thead>
    <tbody>${rows.map(r => {
      const f = live.get(r.id), kind = (R.KINDS[String(r.id).split(':')[0]] || R.KINDS[f?.kind] || {}).label || String(r.id).split(':')[0];
      return html`<tr><td>${kind}<br>${actLink(R.findingActivity(r.id))}</td>
        <td>${r.decision}${r.merged ? ' (merged)' : ''}</td><td class="dim">${ago(r.decidedAt)}</td>
        <td>${r.merged ? '' : html`<button type="button" class="btn-quiet" data-reopen="${r.id}">reopen</button>`}</td></tr>`;
    })}</tbody></table></div></details></section>`;
}

export async function render() {
  useCss('datareview', CSS);
  let ids = [];
  try { ids = (await streamIds()) || []; } catch { /* no IndexedDB: nothing on this device */ }
  const onDevice = ids.filter(id => state.activities[id]);
  const unscanned = onDevice.filter(id => R.scanOf(state, id)?.v !== R.SCAN_V).length;
  const scanned = Object.keys(state.dataReview).filter(k => k.startsWith('scan:')).length;
  const all = R.findings(state), open = all.filter(f => !R.decisionOf(state, f.id));
  const head = pageHead('Data review', open.length ? `${open.length} findings to look at` : 'Nothing open',
    html`<a class="btn btn-ghost" href="#/sources">Sources &amp; coverage</a>`);
  const scanPanel = html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Per-second checks</p><p class="panel-note">${scanned} activities scanned (on any device)</p></div>
    <div class="empty"><p>GPS jumps, heart-rate dropouts, cadence lock and altitude spikes can only be read from the
      per-second stream, which lives on the device that imported it. ${onDevice.length
        ? `${onDevice.length} streams are on this device${unscanned ? `, ${unscanned} not scanned yet` : ', all scanned'}. What the scan finds syncs to your other devices.`
        : 'There are none on this device: scan on the desktop that runs the cowork folder.'}</p></div>
    ${onDevice.length ? html`<button type="button" class="btn${unscanned ? '' : ' btn-ghost'}" id="dr-scan" data-all="${unscanned ? '' : '1'}">
      ${unscanned ? `Scan ${unscanned} streams on this device` : `Rescan all ${onDevice.length}`}</button>` : ''}
  </section>`;
  if (!Object.keys(state.activities).length) return html`${head}${emptyState('No activities yet',
    'Bring in Garmin and Strava through the cowork folder first; the review checks what arrives.', html`<a class="btn" href="#/sync">Set up sync</a>`)}`;
  const groups = Object.keys(R.KINDS).map(k => [k, open.filter(f => f.kind === k)]).filter(([, fs]) => fs.length);
  const proposed = open.filter(f => state.dataReview[f.id]?.proposal).length;
  return html`${head}
    <section class="panel"><div class="empty"><p>Things in the imported data that look wrong. The datareview cowork channel
      sends the open ones (up to ${R.CONTEXT_CAP} at a time) to the agent with their evidence; it proposes a fix, keep or ignore,
      and you decide. <strong>Approving a fix changes Run315's copy only</strong> — nothing is sent to Garmin or Strava.
      ${open.length ? `${proposed} of ${open.length} have a proposal.` : ''}</p></div>
      <a class="quiet-link" href="#/sync">Cowork channels</a></section>
    ${scanPanel}
    ${groups.length ? groups.map(([k, fs]) => html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">${R.KINDS[k].label}</p><p class="panel-note">${fs.length}</p></div>
      <p class="dr-kind-about">${R.KINDS[k].about}</p>
      ${fs.slice(0, 60).map(card)}
      ${fs.length > 60 ? html`<p class="dim">${fs.length - 60} more not shown; decide these first.</p>` : ''}
    </section>`) : emptyState('Nothing open', onDevice.length && unscanned
      ? 'The summaries look sound. Scan the streams on this device to check the per-second data too.'
      : 'Every check came back clean, or you have decided on everything it found.')}
    ${decided(all)}`;
}

async function rederive(id) {
  // A fixed type changes what the stream means (a run's efforts, a ride's none); re-read it where it is.
  try { if (id && await D.deriveActivity(state, id)) save('derive'); } catch (e) { console.warn('re-derive failed', e); }
}

export function mount(el) {
  const rerender = async () => { el.innerHTML = String(await render()); mount(el); };
  el.querySelectorAll('[data-finding] [data-dr]').forEach(b => b.onclick = async () => {
    const id = b.closest('[data-finding]').dataset.finding, act = b.dataset.dr;
    if (act === 'fix') {
      const f = R.findings(state).find(x => x.id === id), p = state.dataReview[id]?.proposal;
      const what = f && f.kind === 'near-miss' ? 'Merge the Strava activity into the Garmin one' : 'Apply ' + (f && p ? fixText(f, p) : 'the fix');
      if (!window.confirm(what + ' in Run315? (Garmin and Strava are not changed.)')) return;
    }
    const r = R.applyDecision(state, id, act);
    toast(r.note);
    if (r.ok) { save('edit'); if (act === 'fix') await rederive(r.changed); }
    rerender();
  });
  el.querySelectorAll('[data-reopen]').forEach(b => b.onclick = async () => {
    const r = R.reopen(state, b.dataset.reopen);
    if (r.ok) { save('edit'); await rederive(r.changed); toast('Reopened'); }
    rerender();
  });
  const scan = el.querySelector('#dr-scan');
  if (scan) scan.onclick = async () => {
    scan.disabled = true;
    try {
      const ids = (await streamIds()) || [];
      const r = await R.scanStreams(state, { ids, getStream, all: !!scan.dataset.all,
        onProgress: (n, of) => { scan.textContent = `Scanning ${n} / ${of}…`; } });
      save('edit');
      toast(`${r.scanned} streams scanned, ${r.findings} findings`);
    } catch (e) { toast('Scan failed: ' + (e.message || e)); }
    rerender();
  };
}
