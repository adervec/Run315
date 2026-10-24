// Experiments: the athlete's own N-of-1 trials. "From 1 October I stopped coffee after
// noon" -- and then, with the numbers the app already has, a plain comparison of the
// weeks during against the weeks just before. The statistics live in js/experiments.js;
// this page is the form, the table, the before/during chart and the honest caveats.
// The cowork agent can be asked to judge one: it sees the same record in app-export.json.
import { state, save } from '../store.js';
import { put, remove } from '../merge.js';
import * as cowork from '../cowork.js';
import * as D from '../derive.js';
import * as X from '../experiments.js';
import { renderChart } from '../charts.js';
import { html, raw, pageHead, emptyState, day, toast, useCss } from '../ui.js';
import { dayKey } from '../lib/dt.js';

export const title = 'Experiments';

const CSS = `
.xp-form .form-row { margin-bottom: 12px; }
.xp-form textarea { width: 100%; box-sizing: border-box; min-height: 60px; resize: vertical; font-family: var(--body);
  font-size: 14px; padding: 8px 10px; border: 1.5px solid var(--line); border-radius: 2px; background: var(--surface); color: var(--ink); }
.xp-form textarea:focus { border-color: var(--projected); outline: none; }
.xp-metrics { border: none; margin: 0 0 12px; padding: 0; }
.xp-metrics legend { font-family: var(--mono); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
.xp-metrics .group { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-bottom: 8px; }
.xp-metrics label { font-size: 14px; display: inline-flex; gap: 6px; align-items: center; min-height: 32px; }
.xp-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.xp-head h2 { margin: 0; font-size: 18px; flex: 1 1 220px; }
.xp-when { font-family: var(--mono); font-size: 11px; color: var(--faint); }
.xp-when.on { color: var(--projected); }
.xp-change { margin: 6px 0 0; font-size: 15px; }
.xp-hyp { margin: 4px 0 0; font-size: 13px; color: var(--muted); }
.xp-summary { margin: 14px 0 10px; font-size: 14px; }
.xp-verdict { font-size: 13px; }
.xp-verdict.better { color: var(--ahead); }
.xp-verdict.worse { color: var(--behind); }
.xp-verdict.thin { color: var(--faint); }
.xp-conf { margin: 8px 0 0; padding-left: 18px; font-size: 13px; color: var(--muted); }
.xp-conf li { margin-bottom: 4px; }
.xp-conf li.warn { color: var(--ink); }
.xp-conf li.warn::marker { color: var(--warn); }
.xp-yours { margin-top: 12px; padding-left: 12px; border-left: 3px solid var(--projected); font-size: 14px; }
.xp-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; align-items: center; }
.xp-chart-pick { margin: 16px 0 6px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.xp-caveat { font-size: 12px; color: var(--faint); margin: 6px 0 0; }
`;

let editing = null;          // null, 'new', or an experiment id
const chartPick = {};        // experiment id -> metric id drawn

const list = () => Object.values(state.experiments).filter(e => e && e.id)
  .sort((a, b) => (!a.end === !b.end ? String(b.start).localeCompare(String(a.start)) : a.end ? 1 : -1));
const thrHr = () => { try { return D.summary(state)?.threshold_hr || null; } catch { return null; } };
const judgeQ = id => Object.values(state.analysisRequests).filter(r => r && r.expId === id)
  .sort((a, b) => String(b.created).localeCompare(String(a.created)))[0];

function form(e) {
  const x = e || { name: '', change: '', hypothesis: '', start: dayKey(new Date()), end: '', metrics: X.DEFAULT_METRICS, verdict: '' };
  const chosen = new Set(x.metrics && x.metrics.length ? x.metrics : X.DEFAULT_METRICS);
  const group = (kind, label) => html`<p class="dim" style="margin:0 0 2px;font-size:12px">${label}</p><div class="group">
    ${X.METRICS.filter(m => m.kind === kind && (X.available(state, m.id) || chosen.has(m.id))).map(m => html`<label title="${m.hint || ''}">
      <input type="checkbox" name="metric" value="${m.id}" ${chosen.has(m.id) ? 'checked' : ''}> ${m.label}</label>`)}</div>`;
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">${e ? 'Edit experiment' : 'New experiment'}</p>
      <p class="panel-note">one change at a time reads cleanest</p></div>
    <form class="xp-form" id="xp-form">
      <div class="form-row">
        <div class="field field-grow"><label for="xp-name">Name</label>
          <input type="text" id="xp-name" name="name" required value="${x.name || ''}" placeholder="No coffee after noon"></div>
      </div>
      <div class="form-row">
        <div class="field field-grow"><label for="xp-change">What you changed</label>
          <input type="text" id="xp-change" name="change" required value="${x.change || ''}" placeholder="Last caffeine before 12:00, every day"></div>
      </div>
      <div class="form-row">
        <div class="field field-grow"><label for="xp-hyp">What you expect (optional)</label>
          <input type="text" id="xp-hyp" name="hypothesis" value="${x.hypothesis || ''}" placeholder="Lower resting HR, higher HRV within three weeks"></div>
      </div>
      <div class="form-row">
        <div class="field"><label for="xp-start">Started</label><input type="date" id="xp-start" name="start" required value="${x.start || ''}"></div>
        <div class="field"><label for="xp-end">Ended (blank = ongoing)</label><input type="date" id="xp-end" name="end" value="${x.end || ''}"></div>
      </div>
      <fieldset class="xp-metrics"><legend>Compare</legend>
        ${group('run', 'Per run')}${group('day', 'Per day')}${group('journal', 'Your journal')}
      </fieldset>
      ${e ? html`<div class="form-row"><div class="field field-grow"><label for="xp-verdict">Your verdict (optional)</label>
        <textarea id="xp-verdict" name="verdict" placeholder="What you make of it, in your own words">${x.verdict || ''}</textarea></div></div>` : ''}
      <div class="xp-actions">
        <button class="btn" type="submit">${e ? 'Save' : 'Start tracking'}</button>
        <button class="btn btn-ghost" type="button" data-cancel>Cancel</button>
      </div>
    </form></section>`;
}

function chartFor(row) {
  const spec = row && X.chartSpec(row);
  if (!spec) return html`<p class="dim">Nothing to draw for this metric yet.</p>`;
  try { return raw(renderChart(spec)); } catch { return html`<p class="dim">This chart could not be drawn.</p>`; }
}

function card(e) {
  const r = X.evaluate(state, e, { thrHr: thrHr() });
  const P = r.periods, q = judgeQ(e.id);
  const drawable = r.rows.filter(x => x.n_before + x.n_during > 0);
  const pick = drawable.find(x => x.id === chartPick[e.id]) || drawable.find(x => x.status !== 'thin') || drawable[0];
  const when = !P.started ? html`<span class="xp-when on">starts ${day(e.start)}</span>`
    : P.ongoing ? html`<span class="xp-when on">since ${day(e.start)} · day ${P.during.days} · ongoing</span>`
    : html`<span class="xp-when">${day(e.start)} → ${day(e.end)} · ${P.during.days} days</span>`;
  return html`<section class="panel" id="xp-${e.id}">
    <div class="xp-head"><h2>${e.name || 'Untitled'}</h2>${when}</div>
    <p class="xp-change">${e.change}</p>
    ${e.hypothesis ? html`<p class="xp-hyp">Expected: ${e.hypothesis}</p>` : ''}
    ${P.started && P.before ? html`<p class="xp-hyp">Compared with ${day(P.before.from)} → ${day(P.before.to)} (${P.before.days} days before).</p>` : ''}
    <p class="xp-summary">${r.summary}</p>
    ${r.rows.length ? html`<div class="table-scroll"><table>
      <thead><tr><th>Metric</th><th class="num">n before / during</th><th class="num">Before</th><th class="num">During</th>
        <th class="num">Difference</th><th class="num">95% CI</th><th>Verdict</th></tr></thead>
      <tbody>${r.rows.map(row => { const m = X.metric(row.id); return html`<tr>
        <td>${row.label}${row.note ? html`<br><span class="dim" style="font-size:12px">${row.note}</span>` : ''}</td>
        <td class="num">${row.n_before} / ${row.n_during}</td>
        <td class="num">${X.fmt(m, row.mean_before)}</td><td class="num">${X.fmt(m, row.mean_during)}</td>
        <td class="num">${row.diff != null ? X.fmt(m, row.diff, true) : '--'}</td>
        <td class="num">${row.lo != null ? html`${X.fmt(m, row.lo, true)} to ${X.fmt(m, row.hi, true)}` : '--'}</td>
        <td><span class="xp-verdict ${row.status}">${row.verdict}</span></td></tr>`; })}</tbody></table></div>
      ${r.rows.some(x => x.caveat && x.status !== 'thin') ? html`<p class="xp-caveat">Daily numbers run in streaks (a good night follows a good night),
        so their intervals are narrower than the information behind them. Treat a daily verdict near the edge as no verdict.</p>` : ''}` : ''}
    ${r.confounders.length ? html`<p class="eyebrow" style="margin:16px 0 0">What else changed</p>
      <ul class="xp-conf">${r.confounders.map(c => html`<li class="${c.level}">${c.text}</li>`)}</ul>` : ''}
    ${pick ? html`<div class="xp-chart-pick"><label class="eyebrow" for="xp-pick-${e.id}">Before / during</label>
        <select id="xp-pick-${e.id}" data-pick="${e.id}">${drawable.map(x => html`<option value="${x.id}" ${x.id === pick.id ? 'selected' : ''}>${x.label}</option>`)}</select></div>
      <div data-chart="${e.id}">${chartFor(pick)}</div>` : ''}
    ${e.verdict ? html`<div class="xp-yours"><p class="eyebrow" style="margin:0 0 4px">Your verdict</p>${e.verdict}</div>` : ''}
    ${q ? html`<p class="xp-hyp" style="margin-top:12px">${q.answer ? 'The agent has judged it' : 'Queued for the agent'} —
      <a class="quiet-link" href="#/ask">see it on Ask &amp; coach →</a></p>` : ''}
    <div class="xp-actions">
      <button class="btn btn-ghost" data-judge="${e.id}" ${P.started ? '' : 'disabled'}>${q ? 'Ask the agent again' : 'Ask the agent to judge it'}</button>
      <button class="btn-quiet" data-edit="${e.id}">Edit</button>
      ${P.started && !e.end ? html`<button class="btn-quiet" data-end="${e.id}">End today</button>` : ''}
      <button class="btn-quiet" data-del="${e.id}">Delete</button>
    </div>
  </section>`;
}

export function render() {
  useCss('experiments', CSS);
  const xs = list();
  const editRec = editing && editing !== 'new' ? state.experiments[editing] : null;
  const head = pageHead('Experiments', 'Change one thing, then see what moved',
    editing ? '' : html`<button class="btn" data-new>New experiment</button>`);
  return html`<div id="xp-page">${head}
    ${editing ? form(editRec) : ''}
    ${!xs.length && !editing ? emptyState('No experiments yet',
      'Declare a change — a new bedtime, no alcohol on weeknights, a strength routine, a different shoe — and the app compares the weeks during it with the weeks just before, on the numbers you pick: easy pace at a matched heart rate, efficiency, resting HR, HRV, sleep, how runs felt. It says how sure it can be, and what else changed at the same time. It cannot tell you the change caused anything; it can tell you whether there is anything to explain.',
      html`<button class="btn" data-new>Start one</button>`) : ''}
    ${xs.map(card)}
    ${xs.length ? html`<p class="stat-hint">Each period is compared with the one just before it, of the same length (at most 42 days).
      The interval is Welch's 95%: when it spans zero, the data cannot tell the two periods apart.</p>` : ''}
  </div>`;
}

function redraw(el) {
  if (!el.querySelector('#xp-page')) return;
  el.innerHTML = String(render()); mount(el);
}

export function mount(el) {
  el.querySelectorAll('[data-new]').forEach(b => b.onclick = () => { editing = 'new'; redraw(el); });
  el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => { editing = b.dataset.edit; redraw(el); window.scrollTo?.(0, 0); });
  el.querySelectorAll('[data-cancel]').forEach(b => b.onclick = () => { editing = null; redraw(el); });
  const f = el.querySelector('#xp-form');
  if (f) f.onsubmit = ev => {
    ev.preventDefault();
    const start = f.start.value, end = f.end.value || null;
    if (!start) { toast('Pick a start date.'); return; }
    if (end && end < start) { toast('The end is before the start.'); return; }
    const metrics = [...f.querySelectorAll('input[name=metric]:checked')].map(i => i.value);
    if (!metrics.length) { toast('Pick at least one thing to compare.'); return; }
    const prev = editing !== 'new' ? state.experiments[editing] : null;
    const id = prev ? prev.id : 'x' + Date.now().toString(36);
    put(state, 'experiments', id, { ...(prev || {}), id, name: f.name.value.trim(), change: f.change.value.trim(),
      hypothesis: f.hypothesis.value.trim(), start, end, metrics,
      verdict: f.verdict ? f.verdict.value.trim() : (prev?.verdict || ''), created: prev?.created || new Date().toISOString() });
    save('edit');
    editing = null;
    toast(prev ? 'Saved.' : 'Tracking it.');
    redraw(el);
  };
  el.querySelectorAll('[data-end]').forEach(b => b.onclick = () => {
    const e = state.experiments[b.dataset.end];
    if (!e) return;
    put(state, 'experiments', e.id, { ...e, end: dayKey(new Date()) });
    save('edit'); toast('Ended today.'); redraw(el);
  });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const e = state.experiments[b.dataset.del];
    if (!e || !confirm(`Delete “${e.name || 'this experiment'}”? The data it compared stays; only the record goes.`)) return;
    remove(state, 'experiments', e.id); save('edit'); redraw(el);
  });
  el.querySelectorAll('[data-pick]').forEach(s => s.onchange = () => {
    const id = s.dataset.pick, e = state.experiments[id], box = el.querySelector(`[data-chart="${id}"]`);
    chartPick[id] = s.value;
    if (!e || !box) return;
    const row = X.evaluate(state, { ...e, metrics: [s.value] }, { thrHr: thrHr() }).rows[0];
    box.innerHTML = String(chartFor(row));
  });
  el.querySelectorAll('[data-judge]').forEach(b => b.onclick = () => {
    const e = state.experiments[b.dataset.judge];
    if (!e) return;
    const r = X.evaluate(state, e, { thrHr: thrHr() }), P = r.periods;
    if (!P.started) { toast('It has not started yet: nothing to judge.'); return; }
    const labels = (e.metrics || []).map(id => X.metric(id)?.label).filter(Boolean).join(', ');
    const q = `Judge my experiment ${e.id} (“${e.name}”): since ${e.start}${e.end ? ' until ' + e.end : ''} I changed this: ${e.change}. `
      + `Did ${labels || 'anything'} change, compared with the period before? Say how sure the data lets you be, and what else could explain any difference. Chart before against during.`;
    const note = `experiments.${e.id} in app-export.json. The app compared ${P.before.from}–${P.before.to} with ${P.during.from}–${P.during.to}: ${r.summary}`
      + (e.hypothesis ? ` I expected: ${e.hypothesis}.` : '');
    const qid = cowork.ask(q, note);
    // Remember which experiment the question is about, so this page can link to the answer.
    put(state, 'analysisRequests', qid, { ...state.analysisRequests[qid], expId: e.id });
    save('edit');
    toast('Queued for the cowork agent — the answer lands on Ask & coach.');
    redraw(el);
  });
}
