// N-of-1 experiment statistics: the interval, the periods, the verdict wording and the
// confounders. Synthetic states, so every expected number is known in advance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as X from '../js/experiments.js';
import { emptyState } from '../js/merge.js';

const NOW = new Date(2026, 9, 24, 12);   // 2026-10-24
const add = (d, n) => { const t = new Date(d + 'T12:00:00'); t.setDate(t.getDate() + n); return t.toISOString().slice(0, 10); };

test('t95 is close to the t table', () => {
  for (const [df, t] of [[3, 3.182], [5, 2.571], [10, 2.228], [30, 2.042], [40, 2.021], [60, 2.000], [1000, 1.962]])
    assert.ok(Math.abs(X.t95(df) - t) / t < 0.006, `df ${df}: ${X.t95(df)} vs ${t}`);
});

test('welch: known case and degenerate inputs', () => {
  const w = X.welch([1, 2, 3, 4, 5], [3, 4, 5, 6, 7]);
  assert.equal(w.diff, 2);
  assert.ok(Math.abs(w.df - 8) < 1e-9);           // equal variances and n -> df = n1 + n2 - 2
  assert.ok(Math.abs((w.hi - w.lo) / 2 - 2.306 * 1) < 0.02);   // se = 1, t(8) = 2.306
  assert.equal(X.welch([1], [2, 3]), null);
  const flat = X.welch([5, 5], [6, 6]);
  assert.deepEqual([flat.lo, flat.hi], [1, 1]);
});

test('periods: before matches the length, capped at 42 days, ends the day before start', () => {
  const p = X.periods({ start: '2026-10-01', end: '2026-10-10' }, NOW);
  assert.deepEqual(p.during, { from: '2026-10-01', to: '2026-10-10', days: 10 });
  assert.deepEqual(p.before, { from: '2026-09-21', to: '2026-09-30', days: 10 });
  assert.equal(p.ongoing, false);
  const long = X.periods({ start: '2026-06-01', end: null }, NOW);
  assert.equal(long.before.days, 42);
  assert.equal(long.before.to, '2026-05-31');
  assert.equal(long.during.to, '2026-10-24');
  assert.equal(long.ongoing, true);
  assert.equal(X.periods({ start: '2026-11-01' }, NOW).started, false);
});

function stateWith(rhrBefore, rhrDuring, start = '2026-10-01') {
  const st = emptyState();
  rhrBefore.forEach((v, i) => { st.wellness[add(start, -1 - i)] = { rhr: v, hrv_ms: 60 }; });
  rhrDuring.forEach((v, i) => { st.wellness[add(start, i)] = { rhr: v, hrv_ms: 60 + (i % 2) }; });
  return st;
}

test('a clear drop in resting HR is reported as such, never as caused', () => {
  const st = stateWith([50, 51, 50, 52, 51, 50, 51, 52, 50, 51], [47, 48, 47, 46, 48, 47, 47, 46, 48, 47]);
  const exp = { id: 'e1', start: '2026-10-01', end: '2026-10-10', metrics: ['rhr', 'hrv_ms'] };
  const r = X.evaluate(st, exp, { now: NOW });
  const rhr = r.rows.find(x => x.id === 'rhr');
  assert.equal(rhr.n_before, 10); assert.equal(rhr.n_during, 10);
  assert.ok(rhr.diff < -3 && rhr.hi < 0);
  assert.match(rhr.verdict, /^lower resting HR during, CI excludes zero \(the better direction\)/);
  assert.match(rhr.caveat, /not independent/);
  assert.equal(rhr.points.during[0].offset, 0);
  assert.equal(rhr.points.before[0].offset, -1);
  const hrv = r.rows.find(x => x.id === 'hrv_ms');
  assert.match(hrv.verdict, /^higher/);   // 60/61 vs a flat 60: clear, if tiny -- the numbers say what they say
  assert.match(r.summary, /cannot show the change caused/);
  assert.doesNotMatch(r.summary + r.rows.map(x => x.verdict).join(' '), /because of|caused by|due to/);
});

test('noise gives "no clear difference"; thin data says too few', () => {
  const st = stateWith([50, 52, 49, 51, 53, 48], [51, 49, 52, 50, 48, 53]);
  const r = X.evaluate(st, { id: 'e', start: '2026-10-01', end: '2026-10-06', metrics: ['rhr', 'sleep_hours', 'efficiency'] }, { now: NOW });
  assert.match(r.rows[0].verdict, /^no clear difference — small sample/);
  assert.equal(r.rows[1].status, 'thin');
  assert.match(r.rows[1].verdict, /no days/);
  assert.match(r.rows[2].verdict, /no runs/);
  const st2 = stateWith([50, 51], [47, 48, 47]);
  const r2 = X.evaluate(st2, { id: 'e', start: '2026-10-01', end: '2026-10-03', metrics: ['rhr'] }, { now: NOW });
  assert.equal(r2.rows[0].verdict, 'too few days to say (2 before, 3 during)');
  assert.match(r2.summary, /Too little data/);
});

test('per-run metrics, pace matched to HR, and the confounders', () => {
  const st = emptyState(), start = '2026-09-15';
  // Before: 4 easy runs a week-ish at 6:00/km, ~140 bpm, 15 C. During: faster at the same HR, hot, more running.
  for (let i = 0; i < 8; i++) {
    const day = add(start, -2 - i * 3), hr = 138 + (i % 3) * 2;
    st.activities['b' + i] = { id: 'b' + i, type: 'running', start: day + 'T07:00:00', distance_m: 8000, moving_s: 2880 + (hr - 140) * -10, avg_hr: hr, max_hr: 190 };
    st.weather['b' + i] = { temp_c: 14 + (i % 2) };
  }
  for (let i = 0; i < 8; i++) {
    const day = add(start, i * 3), hr = 138 + (i % 3) * 2;
    st.activities['d' + i] = { id: 'd' + i, type: 'running', start: day + 'T07:00:00', distance_m: 12000, moving_s: 4140 + (hr - 140) * -15, avg_hr: hr, max_hr: 190 };
    st.weather['d' + i] = { temp_c: 22 + (i % 2) };
  }
  st.experiments.o = { id: 'o', name: 'More sleep', start: '2026-09-20', end: null };
  st.journal['2026-09-20'] = { kind: 'day', tags: ['illness'] };
  st.journal.d1 = { kind: 'activity', rpe: 4, feel: 4 };
  const exp = { id: 'e', start, end: '2026-10-08', metrics: ['easy_pace_hr', 'efficiency', 'avg_hr', 'rpe'] };
  const r = X.evaluate(st, exp, { now: NOW, hrMax: 190 });
  const pace = r.rows.find(x => x.id === 'easy_pace_hr');
  assert.equal(pace.n_before, 8); assert.equal(pace.n_during, 8);
  assert.ok(Math.abs(pace.diff - (345 - 360)) < 0.5, 'pace diff ' + pace.diff);   // 6:00 -> 5:45 /km
  assert.match(pace.note, /matched to 140 bpm/);
  assert.equal(pace.status, 'better');
  assert.equal(r.rows.find(x => x.id === 'avg_hr').status, 'none');
  assert.match(r.rows.find(x => x.id === 'rpe').verdict, /too few journal entries/);
  const keys = r.confounders.map(c => c.key);
  assert.ok(keys.includes('load') && keys.includes('temp') && keys.includes('overlap:o') && keys.includes('tag:illness'), keys.join());
  assert.equal(r.confounders.find(c => c.key === 'load').level, 'warn');
  assert.match(r.summary, /other things that changed too/);
  const spec = X.chartSpec(pace);
  assert.equal(spec.series.length, 2);
  assert.equal(spec.type, 'scatter');
});

test('fmt: pace, signed differences, units', () => {
  const pace = X.metric('easy_pace_hr'), rhr = X.metric('rhr');
  assert.equal(X.fmt(pace, 345), '5:45 /km');
  assert.equal(X.fmt(pace, -15.2, true), '−15 s/km');
  assert.equal(X.fmt(rhr, 47.25), '47.3 bpm');
  assert.equal(X.fmt(rhr, 2, true), '+2.0 bpm');
  assert.equal(X.fmt(rhr, null), '--');
});

test('not started yet', () => {
  const r = X.evaluate(emptyState(), { id: 'e', start: '2026-12-01' }, { now: NOW });
  assert.equal(r.rows.length, 0);
  assert.match(r.summary, /Starts 2026-12-01/);
});

// The two pages with records in them (pages.test.mjs only sees the demo, which has neither).
test('pages render an experiment and a standing question with history', async () => {
  const store = await import('../js/store.js');
  const { importGarmin } = await import('../js/ingest.js');
  const { demoGarminPayload } = await import('../js/demo.js');
  const D = await import('../js/derive.js');
  const cowork = await import('../js/cowork.js');
  await store.loadState();
  const r = await importGarmin(store.state, demoGarminPayload(), store.putStream);
  await D.deriveAll(store.state, r.streams);
  const today = new Date(), iso = d => d.toISOString().slice(0, 10);
  const start = iso(new Date(today - 20 * 864e5));
  store.state.experiments.x1 = { id: 'x1', name: 'Earlier bedtime', change: 'Lights out by 22:30', start, end: null,
    metrics: ['easy_pace_hr', 'efficiency', 'decoupling', 'rhr', 'hrv_ms', 'sleep_hours', 'stress_avg', 'feel'], hypothesis: 'Higher HRV', verdict: '<b>maybe</b>' };
  store.state.experiments.x2 = { id: 'x2', name: 'Future', change: 'Later', start: iso(new Date(+today + 5 * 864e5)), end: null, metrics: [] };
  const qid = cowork.ask('Is my decoupling improving?', '', { standing: true, everyDays: 14 });
  cowork.applyAnswer(qid, 'First look: drift 8%.\n\nMore detail.', 'cowork');
  cowork.applyAnswer(qid, 'Drift down to 6% since last time.\n\n```chart\n{"type":"line","series":[{"name":"a","points":[[1,2],[2,3]]}]}\n```', 'api');
  await new Promise(r => setTimeout(r, 5));   // cowork.ask ids are per-millisecond
  const stopped = cowork.ask('Old standing one', '', { standing: true });
  store.state.analysisRequests[stopped] = { ...store.state.analysisRequests[stopped], standing: false, status: 'answered' };
  const BAD = /\bundefined\b|\bNaN\b|\[object Object\]/;
  for (const name of ['experiments', 'ask']) {
    const out = String(await (await import('../js/pages/' + name + '.js')).render({}));
    const m = out.match(new RegExp('.{0,80}(' + BAD.source + ').{0,80}'));
    assert.ok(!m, name + ' leaks: ' + (m && m[0]));
    if (name === 'experiments') {
      assert.match(out, /Earlier bedtime/); assert.match(out, /95% CI/); assert.match(out, /&lt;b&gt;maybe/);
      assert.match(out, /Starts \d{4}/);
    } else {
      assert.match(out, /Standing questions/); assert.match(out, /What changed/); assert.match(out, /Earlier answers \(1\)/);
      assert.match(out, /First look: drift 8%/); assert.match(out, /chart-fig/); assert.match(out, /stopped before an answer/);
    }
  }
  assert.equal(store.state.analysisRequests[qid].history.length, 2);
});
