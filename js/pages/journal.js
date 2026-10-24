// The athlete's side of the record: eight weeks of days, each run with its effort, feel,
// tags and note editable in place, plus what those entries add up to -- which tags keep
// turning up, whether the felt effort agrees with the model's load, and where "feel" is
// heading.
import { state } from '../store.js';
import { html, raw, pageHead, useCss, km, day as fmtDay, typeLabel } from '../ui.js';
import { renderChart } from '../charts.js';
import { dayKey, addDayKey, fromDay } from '../lib/dt.js';
import * as J from '../journal.js';

export const title = 'Journal';
const WEEKS = 8;
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const CSS = `
.jday { padding: 10px 0; border-bottom: 1px solid var(--line); }
.jday:last-child { border-bottom: 0; }
.jday-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.jday-head b { font-family: var(--mono); font-size: 13px; }
.jday-week { font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); margin: 18px 0 2px; }
.jday details { margin: 6px 0 0; }
.jday summary { cursor: pointer; padding: 6px 0; list-style-position: outside; }
.jday summary .jsum { color: var(--muted); font-size: 13px; }
.jday summary .jsum:empty::before { content: 'add effort, feel, tags'; color: var(--faint); font-style: italic; }
.jday .jdt summary .jsum:empty::before { content: 'tags or a note for the day'; }
.jday .rest { color: var(--faint); font-size: 13px; }
.jtags { display: flex; flex-wrap: wrap; gap: 4px; }
.jtags span { font-family: var(--mono); font-size: 11px; padding: 2px 7px; border-radius: 10px; background: var(--track); color: var(--muted); }
`;

const r2 = v => (v == null ? '--' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2));
const ci = c => (c ? `${r2(c[0])} to ${r2(c[1])}` : '');
const chart = spec => { try { return raw(renderChart(spec)); } catch (e) { return ''; } };

function tagPanel(freq, since) {
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Which tags keep turning up</p>
      <p class="panel-note">since ${fmtDay(since)} · runs and days</p></div>
    ${freq.length ? chart({ type: 'bar', x: { label: 'Tag', type: 'category' }, y: { label: 'Entries', zero: true },
        series: [{ name: 'Entries', points: freq.slice(0, 16).map(([t, n]) => [t, n]) }] })
      : html`<p class="stat-hint">No tags in the last ${WEEKS} weeks. Tags are what the Vitals page
          correlates against your HRV and sleep, so a few taps after each run pay off later.</p>`}
  </section>`;
}

function agreementPanel(a) {
  const enough = a.n >= 8;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Does your effort agree with the model?</p>
      <p class="panel-note">${a.n} rated sessions · session RPE (RPE × minutes) against the model's load</p></div>
    ${a.n >= 2 ? chart({ type: 'scatter', x: { label: 'Model load (TSS-style)', type: 'linear' },
        y: { label: 'Session RPE', unit: 'AU' },
        series: [{ name: 'Session', points: a.points.map(p => [+p.load.toFixed(1), Math.round(p.srpe)]) }] }) : ''}
    ${enough ? html`
      <p class="verdict">Across ${a.n} sessions the two loads correlate at r = ${r2(a.r)}
        (95% interval ${ci(a.ci)}).</p>
      <p class="stat-hint">That number flatters the agreement: both loads grow with minutes, so a long
        easy run is "high" on both for the same reason. Take duration out and compare how hard each
        session felt with how hard the model rates it (its intensity): r = ${r2(a.rIntensity)}
        (${ci(a.ciIntensity)}). That is the honest test of whether your RPE and your heart rate tell
        the same story.</p>
      ${a.surprises.length ? html`<p class="stat-hint" style="margin-top:10px">Sessions that felt
        notably different from what the model expected:</p>
        <ul class="stat-hint">${a.surprises.map(p => html`<li><a class="quiet-link" href="#/activity/${p.id}">${fmtDay(p.day)} · ${p.name || 'run'}</a>
          — RPE ${p.rpe}, the model's intensity suggests about ${p.expected.toFixed(0)}
          (${p.resid > 0 ? 'felt harder' : 'felt easier'})</li>`)}</ul>
        <p class="stat-hint">A run that feels harder than its heart rate says is worth a second look —
          heat, illness and accumulated fatigue all show up there first. One such run means little.</p>` : ''}`
    : html`<p class="stat-hint">Rate ${8 - a.n} more session${8 - a.n === 1 ? '' : 's'} and this will say
        whether your felt effort tracks the model's load. Below eight, any correlation is mostly noise.</p>`}
  </section>`;
}

function feelPanel(trend) {
  const n = trend.reduce((s, w) => s + w[2], 0);
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">How the runs have felt</p>
      <p class="panel-note">weekly average feel, 1 awful – 5 great · ${n} rated runs, last 26 weeks</p></div>
    ${trend.length >= 2 ? chart({ type: 'line', x: { label: 'Week', type: 'time' }, y: { label: 'Feel (1–5)' },
        series: [{ name: 'Average feel', points: trend.map(([w, m]) => [w, +m.toFixed(2)]) }],
        note: 'A week with one or two rated runs is one or two moods, not a trend.' })
      : html`<p class="stat-hint">Rate how a few weeks of runs felt and the trend appears here.</p>`}
  </section>`;
}

// Eight weeks of widgets is a few hundred kB of markup, so a closed entry carries only an
// empty slot that mount() fills when it is opened. The newest unrated runs come open:
// rating the run you just did should not need a tap to find it.
function activityRow(a, fresh) {
  const rec = state.journal[a.id], open = fresh && !rec;
  return html`<details class="jact"${open ? raw(' open') : ''}><summary><a class="quiet-link" href="#/activity/${a.id}">${a.name || typeLabel(a.type)}</a>
      <span class="dim"> · ${a.distance_m ? km(a.distance_m) + ' km' : typeLabel(a.type)}</span>
      <br><span class="jsum" data-sum="${a.id}">${J.entrySummary(rec)}</span></summary>
    ${open ? J.journalWidget(a.id) : html`<div class="jw-slot" data-activity="${a.id}"></div>`}</details>`;
}

function dayRow(d, acts, fresh) {
  const rec = state.journal[d], dt = fromDay(d);
  return html`<article class="jday">
    <div class="jday-head"><b>${DOW[dt.getDay()]} ${fmtDay(d)}</b>
      ${acts.length ? '' : html`<span class="rest">no activity</span>`}</div>
    ${acts.map(a => activityRow(a, fresh))}
    <details class="jdt"><summary><span class="dim">Day</span> <span class="jsum" data-sum="${d}">${J.entrySummary(rec)}</span></summary>
      <div class="jw-slot" data-day="${d}"></div></details>
  </article>`;
}

function days(today) {
  const byDay = {};
  for (const a of Object.values(state.activities)) {
    const d = String(a.start || '').slice(0, 10);
    (byDay[d] || (byDay[d] = [])).push(a);
  }
  const out = [];
  for (let i = 0; i < WEEKS * 7; i++) {
    const d = addDayKey(today, -i), acts = (byDay[d] || []).sort((x, y) => String(x.start).localeCompare(String(y.start)));
    if (fromDay(d).getDay() === 0 || i === 0) out.push(html`<p class="jday-week">Week of ${fmtDay(addDayKey(d, -((fromDay(d).getDay() + 6) % 7)))}</p>`);
    out.push(dayRow(d, acts, i < 2));
  }
  return out;
}

export function render() {
  useCss('journal-page', CSS);
  const today = dayKey(new Date()), since = addDayKey(today, -WEEKS * 7 + 1);
  const entries = Object.keys(state.journal).length;
  const head = pageHead('Journal', 'How the runs felt, in your words',
    html`<a class="btn btn-ghost" href="#/vitals">Vitals</a>`);
  return html`${head}
    <section class="panel">
      <div class="panel-head"><p class="eyebrow">The last ${WEEKS} weeks</p>
        <p class="panel-note">${entries} journal entr${entries === 1 ? 'y' : 'ies'} in all · tap a run to rate it</p></div>
      <div class="empty"><p>The watch knows what your heart did. Only you know what it cost.
        Effort (RPE 1–10) and feel (1–5) take two taps after a run; tags and day notes are
        what the Vitals page lines up against your HRV and sleep.</p></div>
      ${Object.keys(state.activities).length ? '' : html`<p class="stat-hint">No activities yet —
        <a class="quiet-link" href="#/sync">bring them in</a>. Day tags work without them.</p>`}
      ${days(today)}
    </section>
    ${tagPanel(J.tagFrequency(state, since), since)}
    ${agreementPanel(J.rpeVsLoad(state))}
    ${feelPanel(J.feelTrend(state))}`;
}

function fill(slot) {
  if (!slot || slot.childElementCount) return;
  if (slot.dataset.activity) { slot.innerHTML = String(J.journalWidget(slot.dataset.activity)); J.mountJournal(slot, slot.dataset.activity); }
  else if (slot.dataset.day) { slot.innerHTML = String(J.dayTagsWidget(slot.dataset.day)); J.mountDayTags(slot, slot.dataset.day); }
}

export function mount(el) {
  el.querySelectorAll('.journal-widget').forEach(w => J.mountJournal(el, w.dataset.activity));
  // Keep the closed one-line summaries in step without re-rendering (which would close
  // the open entry and drop the keyboard on a phone).
  // `el` is the router's page host and outlives this page, so listen once.
  if (el.dataset.journalSum) return;
  el.dataset.journalSum = '1';
  // 'toggle' does not bubble, hence the capture listener.
  el.addEventListener('toggle', e => {
    const d = e.target;
    if (d && d.open && d.querySelector) fill(d.querySelector(':scope > .jw-slot'));
  }, true);
  el.addEventListener('journal:saved', e => {
    const id = e.detail && e.detail.id;
    for (const s of el.querySelectorAll('.jsum')) if (s.dataset.sum === id) s.textContent = J.entrySummary(state.journal[id]);
  });
}
