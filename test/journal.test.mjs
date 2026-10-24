// The journal's pure side: daily signals, the journal-vs-watch correlations, what predicts
// a good run, RPE against the model's load -- and the widgets/pages rendering with entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as J from '../js/journal.js';
import * as store from '../js/store.js';
import { emptyState } from '../js/merge.js';
import { addDayKey } from '../js/lib/dt.js';

const DAY0 = '2026-06-01';
const BAD = /\bundefined\b|\bNaN\b|\[object Object\]/;
// Small deterministic noise, so nothing hinges on Math.random.
const noise = i => (((i * 7919) % 101) / 101 - 0.5);

function run(id, day, mins, extra = {}) {
  return { id, type: 'running', start: day + 'T07:00:00', moving_s: mins * 60, distance_m: mins * 200, avg_hr: 140, name: 'Run ' + id, ...extra };
}

test('normTag folds spellings together', () => {
  assert.equal(J.normTag('  Poor Sleep! '), 'poor-sleep');
  assert.equal(J.normTag('legs-heavy'), 'legs-heavy');
  assert.equal(J.normTag('---'), '');
});

test('journalDaily averages per day, sums session RPE load, carries tags', () => {
  const st = emptyState();
  st.activities.a = run('a', DAY0, 30);
  st.activities.b = run('b', DAY0, 60);
  st.journal.a = { kind: 'activity', rpe: 4, feel: 4, tags: ['hot'] };
  st.journal.b = { kind: 'activity', rpe: 6, feel: 2, tags: ['legs-heavy'] };
  st.journal.gone = { kind: 'activity', rpe: 9, feel: 1, tags: [] };   // activity not on this device
  st.journal[DAY0] = { kind: 'day', tags: ['alcohol'], note: '' };
  st.journal['2026-06-02'] = { kind: 'day', tags: ['travel'] };
  const jd = J.journalDaily(st);
  assert.equal(jd[DAY0].rpe_avg, 5);
  assert.equal(jd[DAY0].feel_avg, 3);
  assert.equal(jd[DAY0].session_rpe_load, 4 * 30 + 6 * 60);
  assert.deepEqual(Object.keys(jd[DAY0]).filter(k => k.startsWith('tag_')).sort(), ['tag_alcohol', 'tag_hot', 'tag_legs-heavy']);
  assert.equal(jd['2026-06-02'].tag_travel, 1);
  assert.equal(jd['2026-06-02'].rpe_avg, undefined);
  assert.equal(Object.keys(jd).length, 2);
});

test('journalSignals: a tag is 0 only on journaled days, and rare tags are left out', () => {
  const jd = {};
  for (let i = 0; i < 20; i++) jd[addDayKey(DAY0, i)] = i % 4 === 0 ? { tag_alcohol: 1 } : { rpe_avg: 5 };
  jd[addDayKey(DAY0, 3)].tag_travel = 1;
  const { signals, tags, tagCounts } = J.journalSignals(jd);
  assert.equal(tags.tag_alcohol, 5);
  assert.ok(!signals.tag_travel, 'one travel day is too rare to test');
  assert.equal(tagCounts.tag_travel, 1);
  assert.equal(signals.tag_alcohol[addDayKey(DAY0, 1)], 0);
  assert.equal(signals.tag_alcohol[addDayKey(DAY0, 40)], undefined, 'an unjournaled day is unknown, not 0');
});

test('journalCorrelations finds a next-day tag effect and corrects for every test', () => {
  const watch = [], jd = {};
  for (let i = 0; i < 90; i++) {
    const d = addDayKey(DAY0, i), drank = i % 5 === 0;
    jd[d] = drank ? { tag_alcohol: 1 } : {};   // journaled, nothing tagged
    const drankYesterday = (i - 1) % 5 === 0;
    watch.push([d, { hrv_ms: 60 + noise(i) * 6 - (drankYesterday ? 12 : 0), rhr: 48 + noise(i + 3) * 3 }]);
  }
  const jc = J.journalCorrelations(watch, jd);
  // signals with data: tag_alcohol only (no rpe/feel) x metrics with data (hrv, rhr) x 2 lags
  assert.equal(jc.tested, 4);
  const f = jc.findings.find(x => x.signal === 'tag_alcohol' && x.metric === 'hrv_ms');
  assert.ok(f, 'alcohol -> HRV found');
  assert.equal(f.lag, 1);
  assert.ok(f.r < -0.5);
  assert.ok(f.diff.on < f.diff.off - 8);
  assert.ok(!jc.findings.some(x => x.metric === 'rhr'), 'noise does not clear the bar');
  assert.equal(jc.findings.filter(x => x.signal === 'tag_alcohol' && x.metric === 'hrv_ms').length, 1, 'best lag only');
});

test('journalCorrelations with too little overlap tests nothing', () => {
  const jc = J.journalCorrelations([[DAY0, { hrv_ms: 50 }]], { [DAY0]: { rpe_avg: 5 } });
  assert.equal(jc.tested, 0);
  assert.deepEqual(jc.findings, []);
  assert.equal(jc.critical_r, null);
});

test('runPredictors waits for 15 rated runs, then reports r with an interval', () => {
  const few = J.runPredictors(Array.from({ length: 9 }, () => ({ feel: 3 })));
  assert.equal(few.needed, 6);
  assert.deepEqual(few.results, []);

  const st = emptyState();
  for (let i = 0; i < 30; i++) {
    const d = addDayKey(DAY0, i * 2), feel = 1 + (i % 5);
    st.activities['r' + i] = run('r' + i, d, 40);
    st.journal['r' + i] = { kind: 'activity', feel, rpe: 5 };
    st.wellness[d] = { hrv_ms: 40 + feel * 5 + noise(i) * 2, rhr: 48 + noise(i) * 4, sleep_score: 70 + noise(i + 9) * 20 };
    st.weather['r' + i] = { temp_c: 15 + noise(i + 4) * 10 };
  }
  const rows = J.feelRuns(st);
  assert.equal(rows.length, 30);
  assert.ok(rows.every(r => r.load7 >= 0));
  const p = J.runPredictors(rows);
  assert.equal(p.needed, 0);
  const hrv = p.results.find(x => x.key === 'hrv_ms');
  assert.ok(hrv.clears && hrv.r > 0.9);
  assert.ok(hrv.ci[0] < hrv.r && hrv.r < hrv.ci[1]);
  assert.ok(!p.results.find(x => x.key === 'sleep_hours'), 'no sleep length recorded: not tested');
  assert.equal(p.tested, p.results.length);
});

test('rpeVsLoad pairs session RPE with the model load', () => {
  const st = emptyState();
  for (let i = 0; i < 12; i++) {
    st.activities['r' + i] = run('r' + i, addDayKey(DAY0, i), 30 + i * 5, { avg_hr: 130 + (i % 4) * 10 });
    st.journal['r' + i] = { kind: 'activity', rpe: 3 + (i % 4) };
  }
  const a = J.rpeVsLoad(st);
  assert.equal(a.n, 12);
  assert.ok(a.r > 0.5, 'longer and harder runs score higher on both');
  assert.ok(a.points.every(p => p.srpe === p.rpe * (st.activities[p.id].moving_s / 60)));
  assert.ok(a.rIntensity > 0.9, 'RPE tracks the HR-based intensity here by construction');
});

test('widgets render the saved entry and have a stable root', () => {
  const saved = store.state, st = emptyState();
  st.activities.a = run('a', DAY0, 30);
  st.journal.a = { kind: 'activity', rpe: 7, feel: 4, note: '<b>windy</b>', tags: ['hot', 'my-custom'] };
  st.journal[DAY0] = { kind: 'day', tags: ['travel'], note: '' };
  store.replaceState(st);
  try {
    const w = String(J.journalWidget('a'));
    assert.match(w, /class="journal-widget" data-activity="a"/);
    assert.match(w, /data-rpe="7"\s+aria-pressed="true"/);
    assert.match(w, /data-rpe="6"\s+aria-pressed="false"/);
    assert.match(w, /data-tag="my-custom"\s+aria-pressed="true"/);
    assert.ok(w.includes('&lt;b&gt;windy'), 'note is escaped');
    assert.ok(!BAD.test(w));
    const d = String(J.dayTagsWidget(DAY0));
    assert.match(d, /class="daytags-widget" data-day="2026-06-01"/);
    assert.match(d, /data-tag="travel"\s+aria-pressed="true"/);
    assert.ok(!BAD.test(String(J.journalWidget('unknown'))));
    assert.equal(J.entrySummary(st.journal.a), 'RPE 7 · feel good · hot, my-custom · note');
  } finally { store.replaceState(saved); }
});

test('journal and vitals pages render with a full journal', async () => {
  const { importGarmin } = await import('../js/ingest.js');
  const { demoGarminPayload } = await import('../js/demo.js');
  const D = await import('../js/derive.js');
  const saved = store.state;
  store.replaceState(emptyState());
  try {
    await importGarmin(store.state, demoGarminPayload(), store.putStream);
    const runs = D.runs(store.state);
    runs.forEach((a, i) => {
      store.state.journal[a.id] = { kind: 'activity', rpe: 3 + (i % 6), feel: 1 + (i % 5), note: '', tags: i % 3 ? ['hot'] : ['workout'], u: 'x' };
      const d = a.start.toISOString().slice(0, 10);
      if (i % 4 === 0) store.state.journal[d] = { kind: 'day', tags: ['alcohol'], note: '', u: 'x' };
    });
    store.save('test');
    for (const name of ['journal', 'vitals']) {
      const mod = await import('../js/pages/' + name + '.js');
      const out = String(await mod.render({}));
      const m = out.match(new RegExp('.{0,80}(' + BAD.source + ').{0,80}'));
      assert.ok(!m, name + ' leaks: ' + (m && m[0]));
    }
    const vit = String(await (await import('../js/pages/vitals.js')).render({}));
    assert.ok(vit.includes('What predicts a good run'));
    assert.ok(!vit.includes('more.'), 'enough rated runs: the table, not the countdown');
  } finally { store.replaceState(saved); }
});
