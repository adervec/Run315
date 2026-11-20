// N-of-1 experiments: "I changed X on this date -- did anything move?" Pure: state in,
// numbers out, no DOM and no storage, so it is testable in node.
//
// The comparison is deliberately plain. The period *during* the experiment (start to end,
// or to today while it runs) is set against the period just *before* it, of the same
// length but never more than 42 days: long enough to average out a bad week, short enough
// that fitness has not drifted on its own. For each metric we report n, the two means,
// the difference and a Welch 95% interval (unequal variances, unequal n -- the honest
// default when two periods hold different numbers of runs).
//
// What this cannot do, and the copy must keep saying: show that the change *caused* the
// difference. One athlete, two consecutive periods, no blinding, no washout: training
// load, the season, illness and any other change made at the same time all move the same
// numbers. So beside the statistics we list the confounders the data itself shows, and the
// verdicts are worded as "lower during", never "X lowered it".
//
// Daily numbers (HRV, resting HR) are autocorrelated -- a good night tends to follow a good
// night -- so their n overstates the independent information, and the interval is
// optimistic. We say so rather than pretend to fix it with a model the data cannot support.
import { RUN_TYPES, classifyRun } from './lib/fitness.js';
import { dayKey, addDayKey, daysBetween } from './lib/dt.js';
// Worded through t(): nothing here is stored (an experiment saves only what the athlete typed),
// and the page builds what it sends the cowork agent inside english().
import { t, fmt as nfmt } from './i18n.js';

export const MAX_BEFORE_DAYS = 42;
// Below these, a mean is an anecdote. Runs are fewer than days, so their floor is lower.
export const MIN_N = { run: 3, day: 5, journal: 3 };
// One whole sentence per kind, so each language words its own noun.
const NONE_IN_EITHER = {
  run: () => t('no runs with this metric in either period'),
  day: () => t('no days with this metric in either period'),
  journal: () => t('no journal entries with this metric in either period'),
};
const TOO_FEW = {
  run: p => t('too few runs to say ({before} before, {during} during)', p),
  day: p => t('too few days to say ({before} before, {during} during)', p),
  journal: p => t('too few journal entries to say ({before} before, {during} during)', p),
};

// better: which direction is the improvement, or null when neither is (cadence, RPE).
// fmt 'pace' shows m:ss /km; otherwise dp decimals and the unit. Labels and hints stay English
// here (the ids are what is stored) and are worded at display time with t(m.label), t(m.hint).
// i18n-keys: Easy pace at matched HR | easy runs, pace adjusted to one common heart rate | Efficiency | metres covered per heartbeat, runs of 3 km and up | Average HR, easy runs | Decoupling (long runs) | late vs early HR-to-pace on runs long enough to measure | Cardiac drift | Cadence | Overnight HRV | Resting HR | Sleep | Sleep score | Body battery (peak) | Average stress | RPE | Feel
export const METRICS = [
  { id: 'easy_pace_hr', label: 'Easy pace at matched HR', unit: '/km', kind: 'run', better: 'lower', fmt: 'pace',
    hint: 'easy runs, pace adjusted to one common heart rate' },
  { id: 'efficiency', label: 'Efficiency', unit: 'm/beat', kind: 'run', better: 'higher', dp: 2,
    hint: 'metres covered per heartbeat, runs of 3 km and up' },
  { id: 'avg_hr', label: 'Average HR, easy runs', unit: 'bpm', kind: 'run', better: null, dp: 0 },
  { id: 'decoupling', label: 'Decoupling (long runs)', unit: '%', kind: 'run', better: 'lower', dp: 1,
    hint: 'late vs early HR-to-pace on runs long enough to measure' },
  { id: 'drift', label: 'Cardiac drift', unit: '%', kind: 'run', better: 'lower', dp: 1 },
  { id: 'cadence', label: 'Cadence', unit: 'spm', kind: 'run', better: null, dp: 0 },
  { id: 'hrv_ms', label: 'Overnight HRV', unit: 'ms', kind: 'day', better: 'higher', dp: 0 },
  { id: 'rhr', label: 'Resting HR', unit: 'bpm', kind: 'day', better: 'lower', dp: 1 },
  { id: 'sleep_hours', label: 'Sleep', unit: 'h', kind: 'day', better: 'higher', dp: 2 },
  { id: 'sleep_score', label: 'Sleep score', unit: '', kind: 'day', better: 'higher', dp: 0 },
  { id: 'body_battery_high', label: 'Body battery (peak)', unit: '', kind: 'day', better: 'higher', dp: 0 },
  { id: 'stress_avg', label: 'Average stress', unit: '', kind: 'day', better: 'lower', dp: 0 },
  { id: 'rpe', label: 'RPE', unit: '/10', kind: 'journal', better: null, dp: 1 },
  { id: 'feel', label: 'Feel', unit: '/5', kind: 'journal', better: 'higher', dp: 1 },
];
export const metric = id => METRICS.find(m => m.id === id);
export const DEFAULT_METRICS = ['easy_pace_hr', 'efficiency', 'rhr', 'hrv_ms'];
const lowerFirst = s => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
// A metric's label inside a sentence: lower-cased in English ('lower resting HR during'), as the
// translation has it otherwise (a German noun keeps its capital).
const inSentence = m => { const l = t(m.label); return l === m.label ? lowerFirst(l) : l; };
// Cadence only once a derive version stores running form per activity; offering it before
// that would only ever say "no runs".
export const available = (st, id) => id !== 'cadence' || Object.values(st.derived || {}).some(d => d && d.form);

// ---- statistics ----
export const mean = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
export function variance(xs) {   // sample variance (n - 1)
  if (xs.length < 2) return null;
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
}
// Two-sided 95% t critical value: the table up to df 30 (interpolated, since Welch's df is
// fractional), then the Cornish-Fisher expansion around the normal quantile, which is
// within 0.01% of the table from there on.
const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.160, 2.145, 2.131,
  2.120, 2.110, 2.101, 2.093, 2.086, 2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
export function t95(df) {
  if (!(df >= 1)) return df > 0 ? T95[0] : null;
  if (df <= 30) { const i = Math.floor(df), f = df - i; return i === 30 ? T95[29] : T95[i - 1] + f * (T95[i] - T95[i - 1]); }
  const z = 1.959964, z3 = z ** 3, z5 = z ** 5, z7 = z ** 7;
  return z + (z3 + z) / (4 * df) + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2)
    + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3);
}
// Welch's interval for mean(b) - mean(a). -> {diff, lo, hi, df} or null below two each.
export function welch(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const va = variance(a) / a.length, vb = variance(b) / b.length, diff = mean(b) - mean(a);
  const se = Math.sqrt(va + vb);
  if (!(se > 0)) return { diff, lo: diff, hi: diff, df: a.length + b.length - 2 };
  // Welch-Satterthwaite: the effective df shrinks towards the smaller, noisier group.
  const df = (va + vb) ** 2 / ((va ** 2) / (a.length - 1) + (vb ** 2) / (b.length - 1));
  const h = t95(df) * se;
  return { diff, lo: diff - h, hi: diff + h, df };
}

// ---- periods ----
// -> {before: {from, to, days}, during: {from, to, days}, ongoing, started}. Day keys, inclusive.
export function periods(exp, now = new Date()) {
  const today = dayKey(now), start = exp.start;
  const started = !!start && start <= today;
  const endDay = exp.end && exp.end < today ? exp.end : today;
  const duringDays = started ? Math.max(1, daysBetween(start, endDay) + 1) : 0;
  const beforeDays = Math.min(Math.max(duringDays, 1), MAX_BEFORE_DAYS);
  return {
    started, ongoing: !exp.end || exp.end >= today,
    during: { from: start, to: endDay, days: duringDays },
    before: start ? { from: addDayKey(start, -beforeDays), to: addDayKey(start, -1), days: beforeDays } : null,
  };
}
const inP = (d, p) => !!p && d >= p.from && d <= p.to;

// ---- reading values out of state ----
function runList(st) {
  return Object.values(st.activities || {}).filter(a => a && RUN_TYPES.has(a.type) && a.start)
    .map(a => ({ a, day: String(a.start).slice(0, 10) }));
}
// Easy by the app's own classifier when a threshold HR is known; otherwise under 80% of the
// highest HR on record, which is roughly where "easy" ends for most runners.
function isEasy(a, thrHr, hrMax) {
  if (!a.avg_hr) return false;
  if (thrHr) return classifyRun(a, thrHr) === 'easy';
  return hrMax ? a.avg_hr < 0.8 * hrMax : false;
}
const paceOf = a => (a.distance_m > 0 && a.moving_s > 0 ? a.moving_s / (a.distance_m / 1000) : null);

// Per-run values for one metric in the two periods: {before: [{day, v}], during: [...], note}.
function runValues(st, m, P, opts) {
  const all = runList(st).filter(r => inP(r.day, P.before) || inP(r.day, P.during));
  const hrMax = opts.hrMax || Math.max(0, ...Object.values(st.activities || {}).map(a => a.max_hr || 0)) || null;
  const pick = [];
  let note = null;
  for (const { a, day } of all) {
    const d = (st.derived || {})[a.id] || {};
    let v = null;
    if (m.id === 'efficiency') v = a.avg_hr && a.distance_m >= 3000 && a.moving_s ? (a.distance_m / a.moving_s) * 60 / a.avg_hr : null;
    else if (m.id === 'avg_hr') v = isEasy(a, opts.thrHr, hrMax) ? a.avg_hr : null;
    else if (m.id === 'decoupling') v = d.durability && d.durability.decoupling ? (d.durability.decoupling - 1) * 100 : null;
    else if (m.id === 'drift') v = typeof d.drift === 'number' ? d.drift : null;
    // Form is not stored per activity today; read it if a later derive version keeps it.
    else if (m.id === 'cadence') v = (d.form && (d.form.cadence?.mean ?? d.form.cadence_spm)) ?? null;
    else if (m.id === 'easy_pace_hr') v = isEasy(a, opts.thrHr, hrMax) ? paceOf(a) : null;
    if (v != null && isFinite(v)) pick.push({ day, v, hr: a.avg_hr, before: inP(day, P.before) });
  }
  if (m.id === 'easy_pace_hr') {
    // Pace at a matched heart rate: a run done at 150 bpm is not slower than one at 140 bpm
    // for the same reason. Regress pace on HR *within* each period (so the very difference
    // we are testing does not bend the slope), then move every run to the pooled mean HR.
    const groups = [pick.filter(p => p.before), pick.filter(p => !p.before)];
    let sxy = 0, sxx = 0;
    for (const g of groups) {
      const mh = mean(g.map(p => p.hr)), mp = mean(g.map(p => p.v));
      for (const p of g) { sxy += (p.hr - mh) * (p.v - mp); sxx += (p.hr - mh) ** 2; }
    }
    const ref = mean(pick.map(p => p.hr));
    // Faster runs cost more beats, so the slope is negative; a positive one is noise, and
    // then raw pace is the more honest number.
    const slope = pick.length >= 4 && sxx > 0 && sxy / sxx < 0 ? sxy / sxx : 0;
    for (const p of pick) p.v = p.v - slope * (p.hr - ref);
    if (ref) note = slope ? t('matched to {hr} bpm ({slope} s/km per beat)', { hr: Math.round(ref), slope: dec(Math.abs(slope), 1) })
      : t('unadjusted pace: heart rate did not explain pace across these runs');
  }
  return { before: pick.filter(p => p.before), during: pick.filter(p => !p.before), note };
}
function dayValues(st, m, P) {
  const out = { before: [], during: [] };
  const days = new Set([...Object.keys(st.wellness || {}), ...Object.keys(st.daily || {})]);
  for (const day of days) {
    const which = inP(day, P.before) ? 'before' : inP(day, P.during) ? 'during' : null;
    if (!which) continue;
    const w = (st.wellness || {})[day] || {}, d = (st.daily || {})[day] || {};
    const v = w[m.id] ?? d[m.id];
    if (typeof v === 'number' && isFinite(v)) out[which].push({ day, v });
  }
  return out;
}
function journalValues(st, m, P) {
  const out = { before: [], during: [] };
  for (const [id, j] of Object.entries(st.journal || {})) {
    if (!j || typeof j[m.id] !== 'number') continue;
    const a = (st.activities || {})[id];
    const day = a ? String(a.start).slice(0, 10) : /^\d{4}-\d{2}-\d{2}$/.test(id) ? id : null;
    const which = day && (inP(day, P.before) ? 'before' : inP(day, P.during) ? 'during' : null);
    if (which) out[which].push({ day, v: j[m.id] });
  }
  return out;
}

// ---- formatting (pure, shared with the page) ----
// Decimals in the reader's number format where font.js is there.
const dec = (v, dp) => (nfmt() ? nfmt().number(v, { min: dp, max: dp }) : v.toFixed(dp));
const mmss = s => { const r = Math.round(Math.abs(s)); return Math.floor(r / 60) + ':' + String(r % 60).padStart(2, '0'); };
export function fmt(m, v, diff = false) {
  if (v == null || !isFinite(v)) return '--';
  const sign = diff ? (v > 0 ? '+' : v < 0 ? '−' : '±') : v < 0 ? '−' : '';
  if (m.fmt === 'pace') return diff ? sign + Math.round(Math.abs(v)) + ' s/km' : mmss(v) + ' /km';
  return sign + dec(Math.abs(v), m.dp ?? 1) + (m.unit ? (m.unit.startsWith('/') ? '' : ' ') + m.unit : '');
}

// ---- one metric, judged ----
function judge(m, vals, P) {
  const a = vals.before.map(p => p.v), b = vals.during.map(p => p.v);
  const row = { id: m.id, label: t(m.label), kind: m.kind, better: m.better, n_before: a.length, n_during: b.length,
    mean_before: mean(a), mean_during: mean(b), diff: null, lo: null, hi: null, clear: false, direction: null,
    note: vals.note || null, points: vals };
  const floor = MIN_N[m.kind];
  if (a.length < floor || b.length < floor) {
    row.verdict = a.length + b.length === 0 ? NONE_IN_EITHER[m.kind]()
      : TOO_FEW[m.kind]({ before: a.length, during: b.length });
    row.status = 'thin';
    return row;
  }
  const w = welch(a, b);
  Object.assign(row, { diff: w.diff, lo: w.lo, hi: w.hi });
  row.clear = w.lo > 0 || w.hi < 0;
  if (row.clear) {
    row.direction = w.diff > 0 ? 'higher' : 'lower';
    row.status = !m.better ? 'changed' : row.direction === m.better ? 'better' : 'worse';
    const metric = inSentence(m), up = row.direction === 'higher';
    row.verdict = row.status === 'better'
      ? (up ? t('higher {metric} during, CI excludes zero (the better direction)', { metric }) : t('lower {metric} during, CI excludes zero (the better direction)', { metric }))
      : row.status === 'worse'
        ? (up ? t('higher {metric} during, CI excludes zero (the worse direction)', { metric }) : t('lower {metric} during, CI excludes zero (the worse direction)', { metric }))
        : (up ? t('higher {metric} during, CI excludes zero', { metric }) : t('lower {metric} during, CI excludes zero', { metric }));
  } else {
    row.verdict = t('no clear difference');
    row.status = 'none';
  }
  if (Math.min(a.length, b.length) < 8) row.verdict = t('{verdict} — small sample, read loosely', { verdict: row.verdict });
  if (m.kind === 'day') row.caveat = t('days are not independent, so this interval is optimistic');
  return row;
}

// ---- confounders the data shows ----
const TAGS = { illness: 'warn', sick: 'warn', injury: 'warn', travel: 'info', alcohol: 'info', stress: 'info', 'poor-sleep': 'info' };
function confounders(st, exp, P) {
  const out = [], runs = runList(st);
  // Training load: minutes of running per week. Fitness, HRV and resting HR all move with
  // load on their own, so a 20% swing is enough to explain a small difference.
  const mins = p => runs.filter(r => inP(r.day, p)).reduce((s, r) => s + (r.a.moving_s || 0) / 60, 0) / (p.days / 7);
  const lb = mins(P.before), ld = mins(P.during);
  if (lb || ld) {
    const ch = lb ? (ld - lb) / lb : null;
    const big = ch == null || Math.abs(ch) >= 0.2;
    const p = { before: Math.round(lb), during: Math.round(ld), change: ch == null ? '' : `${ch >= 0 ? '+' : '−'}${Math.round(Math.abs(ch) * 100)}%` };
    out.push({ level: big ? 'warn' : 'info', key: 'load',
      text: ch == null ? t('Running {before} → {during} min/week (no running before). Load changed enough to move these numbers by itself.', p)
        : big ? t('Running {before} → {during} min/week ({change}). Load changed enough to move these numbers by itself.', p)
          : t('Running {before} → {during} min/week ({change}). Load was similar, which helps.', p) });
  }
  // Temperature: heat raises HR at a given pace and inflates drift and decoupling.
  const temp = p => runs.filter(r => inP(r.day, p)).map(r => (st.weather || {})[r.a.id]?.temp_c).filter(c => typeof c === 'number');
  const tb = temp(P.before), td = temp(P.during);
  if (tb.length >= 2 && td.length >= 2) {
    const dt = mean(td) - mean(tb);
    const p = { by: Math.abs(dt).toFixed(0), before: mean(tb).toFixed(0), during: mean(td).toFixed(0) };
    if (Math.abs(dt) >= 3) out.push({ level: 'warn', key: 'temp',
      text: dt > 0 ? t('Runs were {by} °C warmer during ({before} → {during} °C): temperature moves heart rate and drift at any pace.', p)
        : t('Runs were {by} °C cooler during ({before} → {during} °C): temperature moves heart rate and drift at any pace.', p) });
  }
  // Other experiments in the same window: their effects cannot be told apart from this one.
  for (const o of Object.values(st.experiments || {})) {
    if (!o || o.id === exp.id || !o.start) continue;
    const oEnd = o.end || '9999-12-31';
    if (o.start <= P.during.to && oEnd >= P.before.from)
    {
      const during = o.start <= P.during.to && oEnd >= P.during.from;
      const p = { name: o.name || o.change || o.id, from: o.start, to: o.end || t('ongoing') };
      out.push({ level: during ? 'warn' : 'info', key: 'overlap:' + o.id,
        text: during ? t('Overlaps “{name}” ({from} → {to}): its effect cannot be separated from this one.', p)
          : t('Overlaps “{name}” ({from} → {to}) in the before period, so the baseline was not a plain one either.', p) });
    }
  }
  // Day tags from the journal.
  const count = {};
  for (const [id, j] of Object.entries(st.journal || {})) {
    if (!j || !/^\d{4}-\d{2}-\d{2}$/.test(id) || !Array.isArray(j.tags)) continue;
    const which = inP(id, P.before) ? 0 : inP(id, P.during) ? 1 : -1;
    if (which < 0) continue;
    for (const tag of j.tags) { const k = String(tag).toLowerCase(); (count[k] = count[k] || [0, 0])[which]++; }
  }
  for (const [tag, [b, d]] of Object.entries(count)) {
    if (!(tag in TAGS) || (TAGS[tag] === 'info' && Math.abs(d - b) < 2)) continue;
    out.push({ level: TAGS[tag], key: 'tag:' + tag, text: t.n('“{tag}” tagged on {n} day during, {before} before.', '“{tag}” tagged on {n} days during, {before} before.', d, { tag, before: b }) });
  }
  if (P.ongoing && P.during.days < 14)
    out.push({ level: 'info', key: 'early', text: t.n('{n} day in: most changes take weeks to show, if they show at all.', '{n} days in: most changes take weeks to show, if they show at all.', P.during.days) });
  return out;
}

// The whole judgement for one experiment.
//   opts: {now, thrHr, hrMax}  -> {periods, rows, confounders, summary} | {periods, rows: [], summary} when not started
export function evaluate(st, exp, opts = {}) {
  const P = periods(exp, opts.now || new Date());
  if (!P.started) return { periods: P, rows: [], confounders: [], summary: exp.start ? t('Starts {date}: nothing to compare yet.', { date: exp.start }) : t('No start date.') };
  const ids = (exp.metrics && exp.metrics.length ? exp.metrics : DEFAULT_METRICS).filter(metric);
  const rows = ids.map(id => {
    const m = metric(id);
    const vals = m.kind === 'run' ? runValues(st, m, P, opts) : m.kind === 'day' ? dayValues(st, m, P) : journalValues(st, m, P);
    // Days from the start on every point, for the before/during chart.
    for (const side of ['before', 'during']) for (const p of vals[side]) p.offset = daysBetween(exp.start, p.day);
    return judge(m, vals, P);
  });
  const conf = confounders(st, exp, P);
  const clear = rows.filter(r => r.clear), thin = rows.filter(r => r.status === 'thin');
  let summary;
  if (!rows.length) summary = t('Pick at least one metric to compare.');
  else if (thin.length === rows.length) summary = t('Too little data in one of the periods to say anything yet.');
  else if (!clear.length) summary = thin.length
    ? t.n('No clear difference between the two periods on any metric ({n} too thin to judge).', 'No clear difference between the two periods on any metric ({n} too thin to judge).', thin.length)
    : t('No clear difference between the two periods on any metric.');
  else {
    const list = clear.map(r => {
      const name = inSentence(metric(r.id));
      return r.direction === 'higher' ? t('{metric} higher', { metric: name }) : t('{metric} lower', { metric: name });
    }).join(', ');
    summary = rows.length === 1 ? t('The one metric differs clearly: {list}.', { list })
      : t.n('{n} of {total} metrics differs clearly: {list}.', '{n} of {total} metrics differ clearly: {list}.', clear.length, { total: rows.length, list });
  }
  summary = conf.some(c => c.level === 'warn')
    ? t('{summary} This compares two periods; it cannot show the change caused any difference, and the data shows other things that changed too.', { summary })
    : t('{summary} This compares two periods; it cannot show the change caused any difference.', { summary });
  return { periods: P, rows, confounders: conf, summary };
}

// A renderChart spec for one judged row: each value against days from the start, before
// in one colour and during in another, so a step at day 0 (or its absence) is visible.
export function chartSpec(row, m = metric(row.id)) {
  const pts = side => (row.points[side] || []).map(p => [p.offset, +p.v.toFixed(3)]);
  const series = [{ name: t('before'), points: pts('before') }, { name: t('during'), points: pts('during') }].filter(s => s.points.length);
  if (!series.length) return null;
  return { type: m.kind === 'day' ? 'line' : 'scatter', title: t(m.label),
    x: { label: t('days from start'), type: 'linear' }, y: { label: t(m.label), unit: m.fmt === 'pace' ? 's/km' : m.unit },
    series, note: t('means: before {before}, during {during}', { before: fmt(m, row.mean_before), during: fmt(m, row.mean_during) }) };
}
