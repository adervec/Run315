// The SQL console: every collection in the state as SQLite tables (js/sql.js), a query box,
// results, CSV, a chart, and saved queries that sync. For the questions no page asks yet --
// without waiting for the agent to answer them.
//
// The engine (sql.js, ~700 KB of wasm) loads the first time a query runs, not when the page
// opens, and the database is rebuilt from the state only when a query runs after the data
// changed. Per-second samples are opt-in, for the activities a result names.
import { state, save, rev } from '../store.js';
import * as S from '../sql.js';
import { renderChart } from '../charts.js';
import { html, raw, pageHead, toast, useCss, link } from '../ui.js';

export const title = 'SQL console';

const CSS = `
.sql-ed textarea { width: 100%; min-height: 180px; resize: vertical; box-sizing: border-box; tab-size: 2;
  font-family: var(--mono); font-size: 13px; line-height: 1.5; padding: 10px 12px; border: 1.5px solid var(--line);
  border-radius: 2px; background: var(--surface); color: var(--ink); }
.sql-ed textarea:focus { border-color: var(--projected); outline: none; }
.sql-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 10px; }
.sql-row input[type=text] { width: 14em; margin: 0; }
.sql-row .grow { flex: 1; }
.sql-hint { font-size: 13px; color: var(--muted); margin: 8px 0 0; }
.sql-status { font-family: var(--mono); font-size: 12px; color: var(--muted); margin: 0 0 8px; }
.sql-err { color: var(--behind); font-family: var(--mono); font-size: 13px; white-space: pre-wrap; margin: 0;
  border-left: 3px solid var(--behind); padding: 6px 10px; }
.sql-res table { font-size: 13px; }
.sql-res td { max-width: 28em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.sql-res .null { color: var(--faint); font-style: italic; }
.sql-res .table-scroll { max-height: 60vh; overflow: auto; }
.sql-res thead th { position: sticky; top: 0; background: var(--surface); }
.sql-lib { display: flex; flex-wrap: wrap; gap: 8px; }
.sql-chip { font-family: var(--body); font-size: 13px; text-align: left; cursor: pointer; padding: 6px 12px; border-radius: 16px;
  border: 1px solid var(--line); background: var(--surface); color: var(--ink); }
.sql-chip:hover { border-color: var(--projected); background: var(--projected-soft); }
.sql-chip:focus-visible { outline: 3px solid var(--projected); outline-offset: 2px; }
.sql-mine { display: inline-flex; align-items: center; gap: 2px; }
.sql-mine button.x { border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 15px; padding: 2px 6px; }
.sql-schema details { border-top: 1px solid var(--line); padding: 8px 0; }
.sql-schema summary { cursor: pointer; font-family: var(--mono); font-size: 13px; }
.sql-schema summary .dim { font-family: var(--body); }
.sql-schema table { font-size: 12px; }
.sql-schema code, .sql-hint code { font-family: var(--mono); font-size: 12px; }
@media (max-width: 600px) { .sql-row input[type=text] { width: 100%; } }
`;

let sql = null;          // the editor's text, kept across re-renders
let last = null;         // {columns, rows, total, ms, statements, sql} or {error}
let chartType = 'line', chartOut = '', busy = '';
let _doc = null, _docRev = -1;
// The schema docs, from the tables themselves (so a new Garmin field documents itself); rebuilt per data revision.
function schema() {
  if (!_doc || _docRev !== rev) { _doc = S.describe(S.buildTables(state)); _docRev = rev; }
  return _doc;
}
const mine = () => (Array.isArray(state.profile.savedQueries) ? state.profile.savedQueries : []);
function setMine(list) { state.profile = { ...state.profile, savedQueries: list, u: new Date().toISOString() }; save('edit'); }

const fmtCell = v => (v == null ? html`<span class="null">NULL</span>` : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(+v.toFixed(4))) : String(v));
function results() {
  if (busy) return html`<p class="sql-status">${busy}</p>`;
  if (!last) return html`<p class="sql-status">Run a query to see rows here. Results show the first ${S.MAX_ROWS.toLocaleString()} rows; the CSV has them all.</p>`;
  if (last.error) return html`<p class="sql-err" role="alert">${last.error}</p>`;
  if (!last.columns.length) return html`<p class="sql-status">Done: ${last.statements} statement${last.statements === 1 ? '' : 's'}, nothing to show (${last.ms} ms). Changes here only touch this scratch copy.</p>`;
  const ids = S.idsInResult(last, state), loaded = S.sampleIds();
  const newIds = ids.filter(id => !loaded.includes(id));
  return html`<p class="sql-status">${last.total.toLocaleString()} row${last.total === 1 ? '' : 's'}${last.total > last.rows.length ? html` · showing the first ${last.rows.length.toLocaleString()}` : ''} · ${last.ms} ms</p>
    <div class="table-scroll"><table><thead><tr>${last.columns.map(c => html`<th>${c}</th>`)}</tr></thead>
      <tbody>${last.rows.map(row => html`<tr>${row.map(v => html`<td class="${typeof v === 'number' ? 'num' : ''}" title="${v == null ? '' : String(v)}">${fmtCell(v)}</td>`)}</tr>`)}</tbody></table></div>
    <div class="sql-row">
      <button class="btn btn-ghost" id="sql-csv" type="button">Download CSV</button>
      <label class="dim" for="sql-ctype">Chart</label>
      <select id="sql-ctype">${['line', 'bar', 'scatter'].map(t => html`<option value="${t}" ${t === chartType ? html`selected` : ''}>${t}</option>`)}</select>
      <button class="btn btn-ghost" id="sql-chart" type="button">Draw chart</button>
      ${newIds.length ? html`<button class="btn btn-quiet" id="sql-samples" type="button" data-ids="${newIds.join(',')}">Load samples for these ${Math.min(newIds.length, S.MAX_SAMPLE_ACTIVITIES - loaded.length)} activities</button>` : ''}
    </div>
    ${newIds.length > S.MAX_SAMPLE_ACTIVITIES - loaded.length ? html`<p class="sql-hint">Samples are capped at ${S.MAX_SAMPLE_ACTIVITIES} activities (about 9,000 rows each); narrow the query to choose which.</p>` : ''}
    <div id="sql-chart-out">${raw(chartOut)}</div>`;
}

function schemaPanel() {
  const loaded = S.sampleIds();
  return html`<section class="panel sql-schema"><div class="panel-head"><p class="eyebrow">Tables</p>
      <p class="panel-note">Units are the column suffix: _m metres, _s seconds, _s_per_km pace, _hr / _bpm beats per minute, _c °C, _w watts.</p></div>
    ${schema().map(t => html`<details><summary>${t.name} <span class="dim">· ${t.rows.toLocaleString()} rows</span></summary>
      <p class="sql-hint">${t.note}</p>
      <div class="table-scroll"><table><thead><tr><th>Column</th><th>Type</th><th>Unit</th><th>Note</th></tr></thead>
        <tbody>${t.columns.map(c => html`<tr><td><code>${c.name}</code></td><td class="dim">${c.type}</td><td>${c.unit}</td><td class="dim">${c.note}</td></tr>`)}</tbody></table></div></details>`)}
    <details><summary>runs <span class="dim">· view</span></summary><p class="sql-hint"><code>${S.VIEWS.runs}</code></p></details>
    <details><summary>samples <span class="dim">· ${loaded.length ? loaded.length + ' activities loaded' : 'on request'}</span></summary>
      <p class="sql-hint">${S.TABLE_NOTES.samples} Run a query that returns an <code>id</code> or <code>activity_id</code> column, then "Load samples" (up to ${S.MAX_SAMPLE_ACTIVITIES} activities, from streams on this device).</p>
      <p class="sql-hint">Columns: ${S.SAMPLE_COLS.map((c, i) => html`${i ? ', ' : ''}<code>${c}</code>`)}.</p>
      ${loaded.length ? html`<button class="btn btn-quiet" id="sql-drop-samples" type="button">Drop the samples table</button>` : ''}</details>
  </section>`;
}

export function render() {
  useCss('sql', CSS);
  if (sql == null) sql = (state.local && state.local.sqlDraft) || S.STARTERS[0].sql;
  const any = Object.keys(state.activities).length;
  return html`${pageHead('SQL console', 'Your whole record as SQLite tables: ask what no page does')}
    <section class="panel sql-ed">
      <label class="eyebrow" for="sql-q">Query</label>
      <textarea id="sql-q" spellcheck="false" autocapitalize="off" autocomplete="off">${sql}</textarea>
      <div class="sql-row">
        <button class="btn" id="sql-run" type="button">Run</button>
        <span class="dim">Ctrl/⌘ + Enter</span>
        <span class="grow"></span>
        <input type="text" id="sql-name" placeholder="Name this query" aria-label="Query name">
        <button class="btn btn-ghost" id="sql-save" type="button">Save</button>
        <button class="btn btn-quiet" id="sql-reset" type="button" title="Rebuild every table from your data">Reset database</button>
      </div>
      <p class="sql-hint">SQLite, in this browser, on a copy of your data${any ? '' : html` (there is none yet: ${link('sync', 'bring some in')})`}: nothing you run here changes it.
        Dates are text (<code>day</code> is YYYY-MM-DD), so <code>strftime</code>, <code>date(day, '+1 day')</code> and <code>substr(day, 1, 7)</code> work.</p>
    </section>
    <section class="panel sql-res" id="sql-out" aria-live="polite">${results()}</section>
    <section class="panel"><div class="panel-head"><p class="eyebrow">Saved queries</p>
      <p class="panel-note">Yours sync between your devices; the starters are always here.</p></div>
      ${mine().length ? html`<div class="sql-lib" style="margin-bottom:12px">${mine().map((q, i) => html`<span class="sql-mine">
        <button class="sql-chip" type="button" data-mine="${i}">${q.name}</button>
        <button class="x" type="button" data-del="${i}" aria-label="Delete ${q.name}">×</button></span>`)}</div>` : ''}
      <div class="sql-lib">${S.STARTERS.map((q, i) => html`<button class="sql-chip" type="button" data-starter="${i}">${q.name}</button>`)}</div>
    </section>
    ${schemaPanel()}`;
}

function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function mount(el) {
  const ta = el.querySelector('#sql-q');
  if (!ta) return;
  const out = el.querySelector('#sql-out');
  const redraw = () => { out.innerHTML = String(results()); wireResults(); };
  const rerender = () => { el.innerHTML = String(render()); mount(el); };

  async function run(force = false) {
    sql = ta.value;
    if (!sql.trim()) return;
    state.local = { ...(state.local || {}), sqlDraft: sql };
    save('local');
    chartOut = '';
    busy = 'Loading the SQL engine and your tables…'; redraw();
    try {
      const db = await S.openDb(force);
      busy = '';
      last = { ...S.runSql(db, sql), sql };
    } catch (e) {
      busy = '';
      last = { error: String((e && e.message) || e) };
    }
    redraw();
  }
  function wireResults() {
    const csv = out.querySelector('#sql-csv');
    if (csv) csv.onclick = async () => {
      try {
        const res = S.allRows(await S.openDb(), last.sql);
        download('run315-query.csv', S.toCsv(res.columns, res.rows));
      } catch (e) { toast('CSV failed: ' + e.message); }
    };
    const sel = out.querySelector('#sql-ctype');
    if (sel) sel.onchange = () => { chartType = sel.value; };
    const ch = out.querySelector('#sql-chart');
    if (ch) ch.onclick = () => {
      try { chartOut = renderChart({ ...S.chartSpec(last.columns, last.rows, chartType), title: '' }); }
      catch (e) { chartOut = `<p class="sql-err" role="alert">${String(html`${e.message}`)}</p>`; }
      out.querySelector('#sql-chart-out').innerHTML = chartOut;
    };
    const sm = out.querySelector('#sql-samples');
    if (sm) sm.onclick = async () => {
      sm.disabled = true; sm.textContent = 'Loading samples…';
      try {
        const r = await S.addSamples(sm.dataset.ids.split(','));
        toast(`samples: ${r.added} activit${r.added === 1 ? 'y' : 'ies'} added` + (r.missing.length ? `, ${r.missing.length} with no stream on this device` : '') + (r.capped ? `, ${r.capped} over the cap` : ''));
        if (r.added && !/\bsamples\b/i.test(sql)) {
          const first = sm.dataset.ids.split(',')[0];
          ta.value = sql = `-- Per-second rows; t_s from the start.\nSELECT * FROM samples WHERE activity_id = '${first.replace(/'/g, "''")}' LIMIT 500`;
        }
      } catch (e) { toast('Samples failed: ' + e.message); }
      rerender();
    };
  }
  wireResults();

  el.querySelector('#sql-run').onclick = () => run();
  el.querySelector('#sql-reset').onclick = () => { S.dropSamples(); run(true); };
  ta.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); }
    // Tab indents rather than leaving the box (Shift+Tab still leaves it, for keyboard users).
    else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
  });
  ta.addEventListener('input', () => { sql = ta.value; });
  el.querySelector('#sql-save').onclick = () => {
    const name = el.querySelector('#sql-name').value.trim();
    if (!name) { toast('Give the query a name first.'); el.querySelector('#sql-name').focus(); return; }
    sql = ta.value;
    const list = mine().filter(q => q.name !== name), replaced = list.length < mine().length;
    setMine([...list, { name, sql }]);
    toast(replaced ? `Updated “${name}”.` : `Saved “${name}”.`);
    rerender();
  };
  const load = text => { ta.value = sql = text; ta.focus(); run(); };
  el.querySelectorAll('[data-starter]').forEach(b => b.onclick = () => load(S.STARTERS[+b.dataset.starter].sql));
  el.querySelectorAll('[data-mine]').forEach(b => b.onclick = () => {
    const q = mine()[+b.dataset.mine];
    if (q) { el.querySelector('#sql-name').value = q.name; load(q.sql); }
  });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
    const q = mine()[+b.dataset.del];
    if (!q || !confirm(`Delete the saved query “${q.name}”?`)) return;
    setMine(mine().filter((_, i) => i !== +b.dataset.del));
    rerender();
  });
  const drop = el.querySelector('#sql-drop-samples');
  if (drop) drop.onclick = () => { S.dropSamples(); toast('Samples dropped.'); rerender(); };
}
