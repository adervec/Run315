import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as I from '../js/lib/insights.js';

// A 1 Hz interval session: warm-up, 5 x (3 min hard, 2 min jog), with HR rising on each rep and
// falling exponentially in the jog: hr = 115 + (peak - 115) e^(-t/40) -> about 43 bpm in 60 s.
function session({ walkAfter = 0 } = {}) {
  const rows = [], reps = [];
  let t = 0, d = 0, hr = 120;
  const push = (v, h) => { rows.push([t, d, Math.round(h), null, null, null, null, null, null, null]); t += 1; d += v; };
  for (let i = 0; i < 300; i++) push(2.8, 120 + i * 0.05);
  for (let r = 0; r < 5; r++) {
    const s = t;
    for (let i = 0; i < 180; i++) { hr = Math.min(172, hr + 0.6); push(4.6, hr); }
    reps.push({ start_s: s, end_s: t - 1 });
    const peak = hr;
    for (let i = 0; i < 120; i++) { hr = 115 + (peak - 115) * Math.exp(-i / 40); push(2.0, hr); }
  }
  for (let i = 0; i < walkAfter; i++) { hr = 100 + (hr - 100) * 0.985; push(1.2, hr); }
  return { rows, reps };
}

test('HRR after each rep: about the exponential the stream was built with', () => {
  const { rows, reps } = session();
  const ev = I.hrRecovery(rows, reps);
  const r = ev.filter(e => e[0] === 'r');
  assert.equal(r.length, 5, JSON.stringify(ev));
  for (const [, hr0, d60, d120] of r) {
    assert.ok(hr0 >= 160);
    assert.ok(d60 > 30 && d60 < 50, 'd60 ' + d60);
    assert.ok(d120 > d60, 'falls further by 120 s');
  }
  const core = I.hrrCore(ev);
  assert.equal(core[0], 5);
  assert.ok(JSON.stringify(core).length <= 50);
});

test('HRR without reps: peaks followed by easing are found; a steady run gives none', () => {
  const { rows } = session();
  const p = I.hrRecovery(rows, null).filter(e => e[0] === 'p');
  assert.ok(p.length >= 3, 'found ' + p.length);
  const steady = Array.from({ length: 1800 }, (_, t) => [t, t * 3, 150 + (t % 7), null, null, null, null, null, null, null]);
  assert.deepEqual(I.hrRecovery(steady, null).filter(e => e[0] !== 'e'), []);
  assert.deepEqual(I.hrRecovery([], null), []);
});

test('HRR at the end of a run only when the watch kept recording', () => {
  const steadyEnd = [];
  let hr = 165;
  for (let t = 0; t < 1500; t++) steadyEnd.push([t, t * 3.5, 165, null, null, null, null, null, null, null]);
  for (let t = 1500, d = 1500 * 3.5; t < 1700; t++, d += 1.1) { hr = 105 + (hr - 105) * Math.exp(-1 / 45); steadyEnd.push([t, d, Math.round(hr), null, null, null, null, null, null, null]); }
  const e = I.hrRecovery(steadyEnd, null).filter(x => x[0] === 'e');
  assert.equal(e.length, 1);
  assert.ok(e[0][2] > 30, 'd60 ' + e[0][2]);
  assert.deepEqual(I.hrRecovery(steadyEnd.slice(0, 1500), null).filter(x => x[0] === 'e'), [], 'no cool-down, no end-of-run HRR');
});

test('HRR trend: one number per session, per quarter, filtered by HR at the end of the effort', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ date: `2024-0${1 + (i % 3)}-1${i % 9}`, e: [['r', 175, 30 + i % 3, 50], ['r', 176, 32, 52], ['r', 140, 10, 20]] });
  for (let i = 0; i < 12; i++) rows.push({ date: `2025-0${4 + (i % 3)}-1${i % 9}`, e: [['p', 178, 40, 60]] });
  const t = I.hrrTrend(rows, { hrMax: 190 });
  assert.equal(t.length, 2);
  assert.equal(t[0].period, '2024-Q1');
  assert.equal(t[0].sessions, 12);
  assert.equal(t[0].events, 24, 'the effort that ended at 140 bpm (< 85% of 190) is left out');
  assert.ok(t[1].d60 > t[0].d60 && t[0].d60_ci);
});

test('HRV: 7-day ln(rMSSD) against the 60 days before; a sustained drop is flagged low', () => {
  const w = {};
  const day = n => new Date(Date.UTC(2025, 0, 1 + n)).toISOString().slice(0, 10);
  for (let n = 0; n < 100; n++) w[day(n)] = { hrv_ms: (n < 90 ? 60 : 42) + ((n * 7) % 5) - 2 };
  delete w[day(50)];
  const rows = I.hrvTrend(w);
  assert.ok(rows.length > 80);
  assert.equal(rows[10].base, null, 'no baseline before 30 nights precede the week');
  const last = rows[rows.length - 1];
  assert.ok(last.base != null && last.lo < last.base && last.hi > last.base);
  assert.equal(last.flag, 'low');
  assert.ok(Math.abs(last.roll - Math.log(42)) < 0.1);
  assert.ok(rows.filter(r => r.day < day(85) && r.base != null).every(r => r.flag !== 'low'), 'the steady stretch is not flagged low');
  const s = I.hrvSummary(rows);
  assert.ok(s.low >= 1 && s.cv_median > 0);
  assert.deepEqual(I.hrvTrend({}), []);
});

// A run at two paces, with cadence and contact time that depend on pace (and a balance offset).
function formRun(cadAt, balance = 50) {
  const rows = [], vr = [], bal = [];
  let d = 0;
  for (let t = 0; t < 1200; t++) {
    const v = t < 600 ? 1000 / 300 : 1000 / 270;      // 5:00/km, then 4:30/km
    rows.push([t, d, 150, null, null, 20, cadAt(v), v / (cadAt(v) / 60), v > 3.5 ? 230 : 250, 8.5, null]);
    vr.push(7.5); bal.push(balance);
    d += v;
  }
  return { rows: rows.map(r => r.slice(0, 10)), ch: { vertical_ratio_pct: vr, gct_balance_left_pct: bal } };
}

test('form at matched pace: per 15 s/km band, then per year', () => {
  const a = formRun(v => (v > 3.5 ? 180 : 170));
  const b = I.formBands(a.rows, a.ch);
  assert.deepEqual(Object.keys(b).sort(), ['270', '300']);
  assert.equal(b['300'][1], 170);
  assert.equal(b['270'][1], 180);
  assert.equal(b['270'][2], 230);
  assert.equal(b['300'][4], 7.5);
  // a year later: two more spm at the same paces, and a balance that drifted left
  const c = formRun(v => (v > 3.5 ? 182 : 172), 51.8);
  const rows = [{ date: '2024-05-01', b }, { date: '2025-05-01', b: I.formBands(c.rows, c.ch) }];
  const y = I.formByYear(rows);
  assert.deepEqual(y.years, ['2024', '2025']);
  assert.deepEqual(y.bands, [270, 300]);
  assert.deepEqual(y.series.cad[300].map(p => p[1]), [170, 172]);
  assert.ok(y.flag && /moved|off even/.test(y.flag), 'balance drift flagged: ' + y.flag);
  assert.equal(I.bandLabel(300), '5:00–5:15');
  assert.deepEqual(I.formBands([], {}), {});
});

test('seasons: best curve per year and critical speed per year', () => {
  const rows = [];
  for (const [y, f] of [['2023', 1.05], ['2024', 1.0]]) {
    for (const [d, s] of [[1000, 200], [1609, 335], [3000, 660], [5000, 1140], [10000, 2400]]) {
      rows.push([d, s * f, `${y}-06-01`, 'a' + y], [d, s * f * 1.1, `${y}-03-01`, 'b' + y]);
    }
  }
  const c = I.seasonCurves(rows);
  assert.deepEqual(c.years, ['2023', '2024']);
  assert.equal(c.best['2024'][5000][0], 1140);
  const cs = I.seasonCS(c);
  assert.ok(cs[1].cs > cs[0].cs, 'the faster year has the higher CS');
  assert.ok(cs[1].d_prime > 0);
});

test('VDOT, Cameron and the predictor spread', () => {
  assert.ok(Math.abs(I.vdot(5000, 19 * 60 + 57) - 50) < 0.2, 'Daniels table: VDOT 50 = 19:57 5K');
  assert.ok(Math.abs(I.vdot(42195, 3 * 3600 + 10 * 60 + 49) - 50) < 0.2, '...and 3:10:49 marathon');
  assert.ok(Math.abs(I.vdotTime(50, 5000) - 1197) < 5);
  assert.equal(Math.round(I.cameron(5000, 1200, 5000)), 1200);
  const mar = I.cameron(5000, 1200, 42195);
  assert.ok(mar > 3.1 * 3600 && mar < 3.4 * 3600, 'a 20:00 5K is a 3:10-3:25 marathon by Cameron: ' + mar);
  const prs = [[5000, 1200, '2026-10-01', 'x'], [10000, 2520, '2026-09-01', 'y'], [3000, 690, '2026-08-01', 'z'], [1609, 345, '2026-08-01', 'z'], [1000, 205, '2026-08-01', 'z']];
  const ref = I.referenceEffort(prs, '2026-11-06');
  assert.equal(ref.vdot, Math.max(...prs.filter(p => p[0] >= 1500).map(p => I.vdot(p[0], p[1]))), 'the best VDOT of 1.5 km and up');
  const cs = I.recentCS(prs, '2026-11-06');
  assert.ok(cs && cs.cs > 4 && cs.cs < 4.8);
  const rows = I.predictorSpread({ fit: [Math.log(1200) - 1.06 * Math.log(5000), 1.06, []], cs, ref, garmin: { 5000: 1190 } });
  const k5 = rows.find(r => r.d === 5000), mara = rows.find(r => r.d === 42195);
  assert.equal(k5.n, 5);
  assert.ok(k5.spread_pct >= 0 && k5.spread_pct < 10);
  assert.ok(mara.cs_out, 'CS past an hour is marked out of range');
  assert.ok(mara.lo <= mara.hi);
  const goals = I.goalRequirements([{ id: 'r1', name: 'Goal 10K', date: '2027-03-01', distance_m: 10000, goal_s: 2400 },
    { id: 'r2', name: 'M', date: '2027-04-01', distance_m: 42195, goal_s: 3 * 3600 }, { id: 'old', date: '2020-01-01', distance_m: 5000, goal_s: 1000 }],
  '2026-11-06', { ref, cs });
  assert.equal(goals.length, 2);
  assert.ok(goals[0].req_vdot > ref.vdot, 'a 40:00 10K asks for more than the best recent effort gives');
  assert.ok(goals[0].req_cs > 4 && goals[1].cs_how.includes('85%'));
});

// A route: 1 km flat, 700 m at ~5% with a 4 m dip in the middle, 1 km flat, a 150 m bump at 6%,
// then 1.2 km down. Elevation sampled every 2 m with a little noise.
function hillRun(lat0 = 51.5) {
  const rows = [];
  let e = 50;
  const prof = [];
  for (let d = 0; d <= 1000; d += 2) prof.push(e);
  for (let d = 2; d <= 700; d += 2) { e += d > 330 && d < 380 ? -0.16 : 0.05 * 2 + (d > 380 && d < 430 ? 0.16 : 0); prof.push(e); }
  for (let d = 2; d <= 1000; d += 2) prof.push(e);
  for (let d = 2; d <= 150; d += 2) { e += 0.12; prof.push(e); }
  for (let d = 2; d <= 1200; d += 2) { e -= 0.05 * 2; prof.push(e); }
  prof.forEach((el, i) => {
    const d = i * 2, t = d / 3.2;
    rows.push([t, d, 150, lat0 + d / 111000, -0.1, el + ((i * 37) % 7 - 3) * 0.05, 175, null, null, null]);
  });
  return rows;
}

test('climbs: found on the smoothed profile, dips merged, short bumps ignored', () => {
  const rec = I.climbsOf(hillRun());
  assert.equal(rec.c.length, 1, JSON.stringify(rec.c));
  const [lat0, , , , len, gain, grade, maxG, secs] = rec.c[0];
  assert.ok(len > 550 && len < 800, 'length ' + len);
  assert.ok(grade > 4 && grade < 6.5, 'grade ' + grade);
  assert.ok(maxG >= grade);
  assert.ok(gain > 25 && gain < 45, 'gain ' + gain);
  assert.ok(secs > 150 && lat0 > 51.5);
  assert.equal(I.category(len, grade), null, 'a 700 m 5% hill is uncategorised by length x grade');
  assert.equal(I.category(6000, 6), 'Cat 2');
  assert.ok(Math.abs(I.fiets(500, 10000, 1500) - 3) < 1e-9);
  assert.deepEqual(I.climbsOf([]), { c: [], g: null });
});

test('climb catalogue clusters the same hill and keeps its times per year', () => {
  const a = I.climbsOf(hillRun()).c, b = I.climbsOf(hillRun(51.5001)).c, far = I.climbsOf(hillRun(52)).c;
  const cat = I.climbCatalogue([{ id: 'r1', date: '2024-05-01', c: a }, { id: 'r2', date: '2025-05-01', c: b.map(x => { const y = [...x]; y[8] -= 20; return y; }) },
    { id: 'r3', date: '2025-06-01', c: far }]);
  assert.equal(cat.length, 2);
  const big = cat.find(c => c.n === 2);
  assert.deepEqual(big.by_year.map(y => y[0]), ['2024', '2025']);
  assert.equal(big.best.id, 'r2');
});

test('time of day: the grid, and heat-corrected pace per hour over steady runs', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ start: `2025-06-${String(2 + (i % 5)).padStart(2, '0')}T07:10:00`, pace: 300, hr: 145, temp_c: 12, steady: true });
  for (let i = 0; i < 20; i++) rows.push({ start: `2025-06-${String(2 + (i % 5)).padStart(2, '0')}T18:10:00`, pace: 310, hr: 150, temp_c: 28, humidity: 60, steady: true });
  rows.push({ start: '2025-06-07T09:00:00', pace: 240, steady: false });
  const t = I.timeOfDay(rows);
  assert.equal(t.total, 41);
  assert.equal(t.grid[0][7], 4, '2025-06-02 is a Monday');
  assert.equal(t.grid[5][9], 1);
  assert.equal(t.hours[7].pace, 300);
  assert.ok(t.hours[18].pace < 310, 'the hot evening runs are corrected towards neutral');
  assert.equal(t.hours[9].pace, null, 'a non-steady run is counted, not compared');
});

test('sleep timing: says so when the data has no clock times', () => {
  const none = I.sleepTiming({ '2025-01-01': { deep_s: 3000, rem_s: 4000 } });
  assert.equal(none.present, false);
  assert.deepEqual(none.fields, ['deep_s', 'rem_s']);
  const d = {};
  for (let n = 0; n < 28; n++) {
    const day = new Date(Date.UTC(2025, 0, 6 + n)).toISOString().slice(0, 10), weekend = n % 7 >= 5;
    d[day] = { sleep_start: weekend ? '00:30' : '23:00', sleep_end: weekend ? '08:30' : '07:00' };
  }
  const s = I.sleepTiming(d);
  assert.equal(s.present, true);
  assert.equal(s.wake, 7 * 60);
  assert.equal(s.jetlag, 90, 'mid-sleep 90 min later at weekends');
  assert.ok(s.bed_sd > 0);
});

test('the stream pass reads each stream once and then lives off the cache', async () => {
  const { rows, reps } = session();
  const cache = new Map();
  let reads = 0;
  const io = { getCache: k => cache.get(k), setCache: (k, v) => { cache.set(k, v); }, getStream: () => { reads++; return { rows }; },
    samples: rec => [rec.rows, {}], getReps: () => reps };
  const items = [{ id: 'a', date: '2025-01-01', hasSession: true }, { id: 'b', date: '2025-02-01', virtual: true }];
  const one = await I.scanActivities(items, io);
  assert.equal(reads, 2);
  assert.equal(one.hrr.length, 2);
  assert.ok(one.hrr[0].e.some(e => e[0] === 'r'));
  assert.ok(one.hrr[1].e.every(e => e[0] !== 'r'), 'no session, no reps');
  const two = await I.scanActivities(items, io);
  assert.equal(reads, 2, 'second visit reads no stream');
  assert.equal(two.cached, 2);
  assert.deepEqual(two.hrr, one.hrr);
  assert.ok(JSON.stringify(cache.get('hrr-a')).length < 400, 'the per-activity cache is compact');
});
