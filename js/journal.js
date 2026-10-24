// The athlete's own words and numbers: effort (RPE), feel, notes and tags per activity,
// tags per day (illness, travel, alcohol, stress...). state.journal; see merge.js.
// CONTRACT (pages depend on these):
//   journalWidget(activityId) -> html for the activity page;  mountJournal(el, activityId)
//   dayTagsWidget(day)        -> html for Today / a day;       mountDayTags(el, day)
//   journalDaily(st)          -> {'YYYY-MM-DD': {rpe_avg, feel_avg, session_rpe_load, tag_<name>: 1, ...}}
//
// The watch measures what the body did; only the athlete knows what it cost. Session RPE
// (Foster's effort-times-minutes) is the oldest training-load measure there is and still
// one of the best validated, and "how did it feel" is the outcome every other number on
// this app is trying to predict. So the widget has to be fast enough to fill in on a phone
// with cold fingers: one tap per answer, saved as you go, no Save button to forget.
//
// Records: activity id -> {kind:'activity', rpe 1-10, feel 1-5, note, tags: []}
//          'YYYY-MM-DD' -> {kind:'day', tags: [], note}
//
// Everything below the widgets is pure (takes the state, returns numbers) and is tested in
// test/journal.test.mjs; the pages only lay it out.
import { state, save } from './store.js';
import { put, remove } from './merge.js';
import { html, useCss } from './ui.js';
import * as F from './lib/fitness.js';
import { pearson, criticalR, label as vLabel, MIN_POINTS, MIN_INTERESTING, ALPHA } from './lib/vitals.js';
import { addDayKey, dayKey, weekStart } from './lib/dt.js';

// ---- vocabulary ----
export const ACTIVITY_TAGS = ['legs-heavy', 'felt-great', 'niggle', 'fasted', 'hot', 'windy', 'treadmill',
  'race', 'workout', 'group', 'new-shoes'];
export const DAY_TAGS = ['illness', 'travel', 'alcohol', 'poor-sleep', 'stress', 'caffeine-late', 'rest-day',
  'menstruation', 'heat'];
// Borg CR10 wording, which is what session RPE was validated with. The numbers matter
// less than using them the same way every time.
export const RPE_WORDS = ['', 'very easy', 'easy', 'moderate', 'somewhat hard', 'hard', 'hard',
  'very hard', 'very hard', 'near maximal', 'maximal'];
export const FEEL_WORDS = ['', 'awful', 'poor', 'ok', 'good', 'great'];

// Free-typed tags become one spelling, so "Poor sleep" and "poor-sleep" count together.
export function normTag(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}
const isRun = a => F.RUN_TYPES.has(a.type);
const dayOf = a => String(a.start || '').slice(0, 10);   // local wall-clock day, as derive.js keys it
const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const num = v => (typeof v === 'number' && isFinite(v) ? v : null);

// An entry that says nothing is deleted rather than kept: an empty record would still
// mark the day as "journaled", and the tag statistics read absence on a journaled day as
// a real 0 (see journalSignals).
function isEmpty(rec) {
  return !num(rec.rpe) && !num(rec.feel) && !(rec.note || '').trim() && !(rec.tags || []).length;
}
function store(id, rec) {
  if (isEmpty(rec)) { if (state.journal[id]) remove(state, 'journal', id); }
  else put(state, 'journal', id, rec);
  save('edit');
}

// "RPE 6 · feel good · hot, windy" -- the one-line form the journal page shows when closed.
export function entrySummary(rec) {
  if (!rec) return '';
  const parts = [];
  if (num(rec.rpe)) parts.push('RPE ' + rec.rpe);
  if (num(rec.feel)) parts.push('feel ' + FEEL_WORDS[rec.feel]);
  if ((rec.tags || []).length) parts.push(rec.tags.join(', '));
  if ((rec.note || '').trim()) parts.push('note');
  return parts.join(' · ');
}

// ---- widgets ----
const CSS = `
.journal-widget, .daytags-widget { display: grid; gap: 10px; padding: 10px 0; }
.jw-row { display: grid; gap: 6px; }
.jw-label { font-family: var(--mono); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.jw-label em { font-style: normal; color: var(--ink); text-transform: none; letter-spacing: 0; margin-left: 6px; }
.jw-scale { display: grid; gap: 4px; }
.jw-scale.rpe { grid-template-columns: repeat(10, 1fr); }
.jw-scale.feel { grid-template-columns: repeat(5, 1fr); }
.jw-scale button, .jw-chip { font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--line);
  border-radius: 8px; cursor: pointer; touch-action: manipulation; }
.jw-scale button { min-height: 42px; padding: 0; font-family: var(--mono); font-size: 15px; }
.jw-scale.feel button { font-size: 12px; }
.jw-scale button[aria-pressed="true"], .jw-chip[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
.jw-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.jw-chip { min-height: 34px; padding: 4px 11px; border-radius: 17px; font-size: 13px; }
.jw-add { display: flex; gap: 6px; }
.jw-add input, .journal-widget textarea, .daytags-widget textarea { font: inherit; font-size: 16px; color: var(--ink);
  background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; min-width: 0; }
.jw-add input { flex: 1; }
.journal-widget textarea, .daytags-widget textarea { width: 100%; box-sizing: border-box; resize: vertical; min-height: 56px; }
.jw-saved { font-family: var(--mono); font-size: 11px; color: var(--ahead); min-height: 14px; opacity: 0; transition: opacity .2s; }
.jw-saved.on { opacity: 1; }
`;

function scale(kind, n, value, words) {
  return html`<div class="jw-scale ${kind}" role="group" aria-label="${kind === 'rpe' ? 'Session effort, 1 to 10' : 'How it felt, 1 to 5'}">
    ${Array.from({ length: n }, (_, i) => i + 1).map(v => html`<button type="button" data-${kind}="${v}"
      aria-pressed="${String(value === v)}" title="${v} · ${words[v]}">${kind === 'feel' ? words[v] : v}</button>`)}
  </div>`;
}
function chips(preset, tags) {
  const all = [...preset, ...tags.filter(t => !preset.includes(t))];
  return html`<div class="jw-chips">${all.map(t => html`<button type="button" class="jw-chip" data-tag="${t}"
    aria-pressed="${String(tags.includes(t))}">${t}</button>`)}</div>
    <div class="jw-add"><input type="text" class="jw-new" placeholder="Add a tag" aria-label="Add a tag" maxlength="32"
      enterkeyhint="done" autocapitalize="off"><button type="button" class="btn btn-ghost jw-addbtn">Add</button></div>`;
}

export function journalWidget(id) {
  useCss('journal', CSS);
  const rec = state.journal[id] || {}, tags = rec.tags || [];
  const rpe = num(rec.rpe), feel = num(rec.feel);
  return html`<div class="journal-widget" data-activity="${id}">
    <div class="jw-row"><span class="jw-label">Effort (RPE)<em class="jw-rpe-word">${rpe ? RPE_WORDS[rpe] : ''}</em></span>
      ${scale('rpe', 10, rpe, RPE_WORDS)}</div>
    <div class="jw-row"><span class="jw-label">How it felt</span>${scale('feel', 5, feel, FEEL_WORDS)}</div>
    <div class="jw-row"><span class="jw-label">Tags</span>${chips(ACTIVITY_TAGS, tags)}</div>
    <div class="jw-row"><span class="jw-label">Note</span>
      <textarea class="jw-note" rows="2" placeholder="Anything the numbers will not show" aria-label="Note">${rec.note || ''}</textarea></div>
    <span class="jw-saved" aria-live="polite"></span>
  </div>`;
}

export function dayTagsWidget(day) {
  useCss('journal', CSS);
  const rec = state.journal[day] || {}, tags = rec.tags || [];
  return html`<div class="daytags-widget" data-day="${day}">
    <div class="jw-row"><span class="jw-label">The day</span>${chips(DAY_TAGS, tags)}</div>
    <div class="jw-row"><span class="jw-label">Note</span>
      <textarea class="jw-note" rows="2" placeholder="Anything about the day" aria-label="Day note">${rec.note || ''}</textarea></div>
    <span class="jw-saved" aria-live="polite"></span>
  </div>`;
}

// The widget's root inside `el` (or `el` itself), matched on its key so several widgets
// can share a page.
function findRoot(el, cls, attr, key) {
  if (!el) return null;
  if (el.matches && el.matches('.' + cls) && el.dataset[attr] === key) return el;
  for (const r of el.querySelectorAll ? el.querySelectorAll('.' + cls) : []) if (r.dataset[attr] === key) return r;
  return null;
}

// One mount for both widgets: they differ only in kind and which fields exist.
function wire(root, id, kind) {
  if (!root || root.dataset.wired) return;
  root.dataset.wired = '1';
  const current = () => {
    const r = state.journal[id] || {};
    return kind === 'activity'
      ? { kind, rpe: num(r.rpe), feel: num(r.feel), note: r.note || '', tags: [...(r.tags || [])] }
      : { kind, note: r.note || '', tags: [...(r.tags || [])] };
  };
  let markTimer;
  const commit = patch => {
    const rec = { ...current(), ...patch };
    store(id, rec);
    const m = root.querySelector('.jw-saved');
    if (m) { m.textContent = 'saved'; m.classList.add('on'); clearTimeout(markTimer); markTimer = setTimeout(() => m.classList.remove('on'), 1400); }
    root.dispatchEvent(new CustomEvent('journal:saved', { bubbles: true, detail: { id, kind } }));
  };
  const press = (sel, val) => root.querySelectorAll(sel).forEach(b => b.setAttribute('aria-pressed', String(val(b))));

  root.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !root.contains(b)) return;
    // A second tap on the chosen number clears it: a mis-tap has to be undoable in one tap too.
    if (b.dataset.rpe) {
      const v = +b.dataset.rpe, next = current().rpe === v ? null : v;
      press('[data-rpe]', x => +x.dataset.rpe === next);
      const w = root.querySelector('.jw-rpe-word'); if (w) w.textContent = next ? RPE_WORDS[next] : '';
      commit({ rpe: next });
    } else if (b.dataset.feel) {
      const v = +b.dataset.feel, next = current().feel === v ? null : v;
      press('[data-feel]', x => +x.dataset.feel === next);
      commit({ feel: next });
    } else if (b.dataset.tag) {
      const t = b.dataset.tag, tags = current().tags, on = !tags.includes(t);
      b.setAttribute('aria-pressed', String(on));
      commit({ tags: on ? [...tags, t] : tags.filter(x => x !== t) });
    } else if (b.classList.contains('jw-addbtn')) addTag();
  });
  const input = root.querySelector('.jw-new');
  function addTag() {
    const t = normTag(input && input.value);
    if (!t) return;
    input.value = '';
    const tags = current().tags;
    let chip = [...root.querySelectorAll('[data-tag]')].find(x => x.dataset.tag === t);
    if (!chip) {
      chip = document.createElement('button');
      chip.type = 'button'; chip.className = 'jw-chip'; chip.dataset.tag = t; chip.textContent = t;
      root.querySelector('.jw-chips').appendChild(chip);
    }
    chip.setAttribute('aria-pressed', 'true');
    if (!tags.includes(t)) commit({ tags: [...tags, t] });
  }
  if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });
  // The note saves while typing (debounced) and on leaving the box, so closing the tab
  // straight after typing loses at most the last half second.
  const note = root.querySelector('.jw-note');
  if (note) {
    let t;
    const flush = () => { clearTimeout(t); if (note.value !== current().note) commit({ note: note.value }); };
    note.addEventListener('input', () => { clearTimeout(t); t = setTimeout(flush, 600); });
    note.addEventListener('blur', flush);
  }
}

export function mountJournal(el, id) { wire(findRoot(el, 'journal-widget', 'activity', String(id)), String(id), 'activity'); }
export function mountDayTags(el, day) { wire(findRoot(el, 'daytags-widget', 'day', String(day)), String(day), 'day'); }

// ---- the model's load, for comparing against the athlete's ----
// The same TSS-style number the fitness model uses (fitness.js activityLoad), with its
// self-calibrated thresholds, so "the model's load" here is the load everywhere else.
export function modelLoads(st) {
  const acts = Object.values(st.activities || {});
  const [thrHr, thrSpd] = F.thresholds(acts);
  const byId = {}, byDay = {};
  for (const a of acts) {
    if (!F.CARDIO_TYPES.has(a.type) || !a.start) continue;
    const l = F.activityLoad(a, thrHr, thrSpd);
    byId[a.id] = l;
    byDay[dayOf(a)] = (byDay[dayOf(a)] || 0) + l;
  }
  return { byId, byDay };
}

// ---- daily signals for correlations ----
export function journalDaily(st) {
  const out = {}, rpes = {}, feels = {};
  const row = d => out[d] || (out[d] = {});
  for (const [id, rec] of Object.entries(st.journal || {})) {
    if (!rec) continue;
    if (rec.kind === 'day' || /^\d{4}-\d{2}-\d{2}$/.test(id)) {
      const r = row(id);
      for (const t of rec.tags || []) r['tag_' + t] = 1;
      continue;
    }
    const a = st.activities[id];
    if (!a) continue;   // an entry for an activity this device no longer has: no day to put it on
    const d = dayOf(a), r = row(d);
    for (const t of rec.tags || []) r['tag_' + t] = 1;
    if (num(rec.rpe)) {
      (rpes[d] || (rpes[d] = [])).push(rec.rpe);
      if (a.moving_s) r.session_rpe_load = (r.session_rpe_load || 0) + rec.rpe * a.moving_s / 60;
    }
    if (num(rec.feel)) (feels[d] || (feels[d] = [])).push(rec.feel);
  }
  for (const [d, xs] of Object.entries(rpes)) out[d].rpe_avg = mean(xs);
  for (const [d, xs] of Object.entries(feels)) out[d].feel_avg = mean(xs);
  return out;
}

// A tag has to turn up -- and be absent -- on this many journaled days before a 0/1
// correlation on it says anything. Five is a floor, not a comfort.
export const MIN_TAG_DAYS = 5;

// journalDaily -> {signal: {day: value}}. A tag counts as 0 only on days the athlete
// wrote *something*: a day nobody journaled is unknown, not "no alcohol".
export function journalSignals(jd, minTag = MIN_TAG_DAYS) {
  const days = Object.keys(jd), sig = { rpe_avg: {}, feel_avg: {} }, counts = {};
  for (const d of days) {
    for (const k of ['rpe_avg', 'feel_avg']) if (jd[d][k] != null) sig[k][d] = jd[d][k];
    for (const k of Object.keys(jd[d])) if (k.startsWith('tag_')) counts[k] = (counts[k] || 0) + 1;
  }
  const tags = {};
  for (const [k, n] of Object.entries(counts)) {
    if (n < minTag || days.length - n < minTag) continue;
    sig[k] = {};
    for (const d of days) sig[k][d] = jd[d][k] ? 1 : 0;
    tags[k] = n;
  }
  return { signals: sig, tagCounts: counts, tags };
}

export const signalLabel = k => (k === 'rpe_avg' ? 'effort (RPE)' : k === 'feel_avg' ? 'feel' : k === 'session_rpe_load'
  ? 'session RPE load' : k.startsWith('tag_') ? '“' + k.slice(4) + '”' : k);

// What the watch measures that the journal might line up with.
export const WATCH_METRICS = ['hrv_ms', 'rhr', 'sleep_score', 'body_battery_high', 'stress_avg'];
export const JOURNAL_LAGS = [0, 1];

// Every journal signal against every watch metric at lags 0 and 1, the way vitals.js
// correlate() does it: count every test first, Bonferroni-correct by that count, drop
// anything under MIN_INTERESTING, keep only the best lag per pair. Lag 1 pairs the
// journal on day d-1 with the watch on day d ("the day after a day tagged alcohol").
// `watchRows` is derive.js dailyRows(): [[day, {metric: value}]].
export function journalCorrelations(watchRows, jd, metrics = WATCH_METRICS, lags = JOURNAL_LAGS) {
  const { signals, tags, tagCounts } = journalSignals(jd);
  const days = (watchRows || []).map(([d]) => d);
  let tested = 0, cut = null;
  const candidates = [];
  for (const [sname, series] of Object.entries(signals)) {
    for (const m of metrics) {
      const ys = (watchRows || []).map(([, r]) => num(r[m]));
      for (const lag of lags) {
        const xs = days.map(d => series[addDayKey(d, -lag)] ?? null);
        let paired = 0;
        for (let i = 0; i < xs.length; i++) if (xs[i] != null && ys[i] != null) paired++;
        if (paired < MIN_POINTS) continue;
        tested++;
        const r = pearson(xs, ys);
        if (r === null) continue;
        // For a 0/1 tag the plain difference in means reads better than r.
        let diff = null;
        if (sname.startsWith('tag_')) {
          const on = [], off = [];
          xs.forEach((x, i) => { if (x != null && ys[i] != null) (x ? on : off).push(ys[i]); });
          diff = { on: mean(on), off: mean(off), n_on: on.length, n_off: off.length };
        }
        candidates.push({ signal: sname, metric: m, lag, r, days: paired, diff });
      }
    }
  }
  const findings = [];
  for (const c of candidates) {
    const threshold = criticalR(c.days, ALPHA, tested);
    cut = cut === null ? threshold : Math.max(cut, threshold);
    if (threshold === null || Math.abs(c.r) < Math.max(threshold, MIN_INTERESTING)) continue;
    findings.push({ ...c, threshold, label: signalLabel(c.signal), metricLabel: vLabel(c.metric) });
  }
  findings.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  const seen = new Set(), best = [];
  for (const f of findings) {
    const k = f.signal + '|' + f.metric;
    if (!seen.has(k)) { seen.add(k); best.push(f); }
  }
  return {
    findings: best, tested, critical_r: cut,
    uncorrected: candidates.filter(c => Math.abs(c.r) >= (criticalR(c.days, ALPHA, 1) || 1)).length,
    signals: Object.keys(signals).filter(k => Object.keys(signals[k]).length),
    tags, tagCounts, journaledDays: Object.keys(jd).length,
  };
}

// 95% interval for r (Fisher z). Uncorrected for multiple tests -- it is there to show how
// wide the uncertainty is with this many runs, not to rule on significance.
export function rInterval(r, n) {
  if (r == null || n < 4) return null;
  const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, r))), se = 1 / Math.sqrt(n - 3);
  return [Math.tanh(z - 1.96 * se), Math.tanh(z + 1.96 * se)];
}

// ---- what predicts a good run ----
export const MIN_FEEL_RUNS = 15;
export const PREDICTORS = [
  ['hrv_ms', 'HRV the night before', 'ms'],
  ['sleep_score', 'sleep score the night before', ''],
  ['sleep_hours', 'sleep length the night before', 'h'],
  ['rhr', 'resting HR that morning', 'bpm'],
  ['temp_c', 'temperature on the run', '°C'],
  ['load7', 'load over the previous 7 days', ''],
];

// One row per run that has a feel rating. Garmin files a night under the morning it
// ends, so wellness[run day] *is* the night before the run.
export function feelRuns(st) {
  const { byDay } = modelLoads(st), out = [];
  for (const a of Object.values(st.activities || {})) {
    const rec = st.journal[a.id];
    if (!isRun(a) || !rec || !num(rec.feel)) continue;
    const d = dayOf(a), w = { ...(st.daily[d] || {}), ...(st.wellness[d] || {}) };
    let load7 = 0;
    for (let i = 1; i <= 7; i++) load7 += byDay[addDayKey(d, -i)] || 0;
    out.push({ id: a.id, day: d, feel: rec.feel, rpe: num(rec.rpe), hrv_ms: num(w.hrv_ms), sleep_score: num(w.sleep_score),
      sleep_hours: num(w.sleep_hours), rhr: num(w.rhr), temp_c: num(st.weather[a.id]?.temp_c), load7 });
  }
  return out.sort((x, y) => x.day.localeCompare(y.day));
}

// feel against each predictor. Corrected for the number of predictors actually tested;
// below MIN_FEEL_RUNS rated runs it only says how many more are needed.
export function runPredictors(rows, minRuns = MIN_FEEL_RUNS) {
  const n = rows.length;
  if (n < minRuns) return { n, needed: minRuns - n, results: [] };
  const tests = [];
  for (const [key, lbl, unit] of PREDICTORS) {
    const xs = rows.map(r => r[key]), ys = rows.map(r => r.feel);
    const paired = xs.filter(x => x != null).length;
    if (paired < Math.min(10, minRuns)) continue;
    tests.push({ key, label: lbl, unit, xs, ys, n: paired });
  }
  const results = tests.map(t => {
    const r = pearson(t.xs, t.ys), threshold = criticalR(t.n, ALPHA, tests.length);
    return { key: t.key, label: t.label, unit: t.unit, n: t.n, r, ci: rInterval(r, t.n), threshold,
      clears: r != null && threshold != null && Math.abs(r) >= threshold };
  });
  return { n, needed: 0, tested: tests.length, results };
}

// ---- journal page aggregates ----
// Does the athlete's effort track the model's load? Per rated activity: the model's
// TSS-style load, session RPE (rpe x minutes), and the model's intensity (load per hour).
// Both loads scale with minutes, so their agreement is partly just duration agreeing
// with itself -- the intensity comparison takes duration out and is the harder test.
export function rpeVsLoad(st) {
  const { byId } = modelLoads(st), pts = [];
  for (const [id, rec] of Object.entries(st.journal || {})) {
    const a = st.activities[id];
    if (!a || !num(rec.rpe) || !a.moving_s || byId[id] == null) continue;
    const mins = a.moving_s / 60;
    pts.push({ id, day: dayOf(a), name: a.name, rpe: rec.rpe, srpe: rec.rpe * mins, load: byId[id], intensity: byId[id] / (mins / 60) });
  }
  pts.sort((x, y) => x.day.localeCompare(y.day));
  const r = pearson(pts.map(p => p.load), pts.map(p => p.srpe));
  const rI = pearson(pts.map(p => p.intensity), pts.map(p => p.rpe));
  // Where the athlete and the model disagree most: residuals of RPE on intensity.
  let surprises = [];
  if (pts.length >= 8 && rI != null) {
    const mx = mean(pts.map(p => p.intensity)), my = mean(pts.map(p => p.rpe));
    const sxx = pts.reduce((s, p) => s + (p.intensity - mx) ** 2, 0);
    const b = pts.reduce((s, p) => s + (p.intensity - mx) * (p.rpe - my), 0) / sxx;
    surprises = pts.map(p => ({ ...p, expected: my + b * (p.intensity - mx) }))
      .map(p => ({ ...p, resid: p.rpe - p.expected }))
      .filter(p => Math.abs(p.resid) >= 1.5)
      .sort((x, y) => Math.abs(y.resid) - Math.abs(x.resid)).slice(0, 4);
  }
  return { points: pts, n: pts.length, r, ci: rInterval(r, pts.length), rIntensity: rI, ciIntensity: rInterval(rI, pts.length), surprises };
}

// Tag -> number of entries carrying it, since `fromDay` (activity and day entries both).
export function tagFrequency(st, fromDay) {
  const out = {};
  for (const [id, rec] of Object.entries(st.journal || {})) {
    const d = rec.kind === 'day' ? id : st.activities[id] ? dayOf(st.activities[id]) : null;
    if (!d || d < fromDay) continue;
    for (const t of rec.tags || []) out[t] = (out[t] || 0) + 1;
  }
  return Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// Weekly mean feel: [[monday, mean, n]], oldest first.
export function feelTrend(st, now = new Date(), weeks = 26) {
  const from = addDayKey(dayKey(now), -7 * weeks), buckets = {};
  for (const [id, rec] of Object.entries(st.journal || {})) {
    const a = st.activities[id];
    if (!a || !num(rec.feel) || dayOf(a) < from) continue;
    const w = weekStart(dayOf(a));
    (buckets[w] || (buckets[w] = [])).push(rec.feel);
  }
  return Object.keys(buckets).sort().map(w => [w, mean(buckets[w]), buckets[w].length]);
}
