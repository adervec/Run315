import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as EF from '../js/lib/efficiency.js';

test('a steady run is scored; hills and heat are taken out', () => {
  const base = { id: 'g1', type: 'running', start: '2026-05-01T07:00:00', distance_m: 10000, moving_s: 3000, avg_hr: 150 };
  const flat = EF.runEfficiency(base, { thrHr: 175 });
  const hilly = EF.runEfficiency({ ...base, elev_gain_m: 300 }, { thrHr: 175 });
  const hot = EF.runEfficiency(base, { thrHr: 175, tempC: 30, humidity: 70 });
  assert.ok(flat.ef > 1.2 && flat.ef < 1.4);
  assert.ok(hilly.ef > flat.ef, 'the same time with 300 m of climb is a more efficient run');
  assert.ok(hot.ef >= flat.ef, 'and so is the same time on a hot day');
  assert.equal(EF.runEfficiency({ ...base, avg_hr: 172 }, { thrHr: 175 }), null, 'a threshold run is not a steady run');
  assert.equal(EF.runEfficiency(base, { thrHr: 175, interval: true }), null);
  assert.ok(EF.runEfficiency(base, { thrHr: 175, rhr: 50 }).rre > 0);
});

test('trend, interval and slope', () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ date: `202${i < 20 ? 4 : 5}-${String(1 + (i % 12)).padStart(2, '0')}-10`, ef: (i < 20 ? 1.3 : 1.4) + (i % 3) * 0.01 }));
  const t = EF.trend(rows, 'year');
  assert.equal(t.length, 2);
  assert.ok(t[1].ef > t[0].ef && t[0].ef_ci);
  const sl = EF.slope(rows);
  assert.ok(sl.per_year_pct > 0 && sl.ci_pct[0] > 0);
  assert.equal(EF.slope(rows.slice(0, 5)), null);
});

test('the HR trace weights intervals above a steady run of the same average', () => {
  const steady = [], reps = [];
  for (let t = 0; t <= 1800; t += 5) {
    steady.push([t, t * 3, 150]);
    reps.push([t, t * 3, Math.floor(t / 120) % 2 ? 125 : 175]);   // 2 min on, 2 min off, averaging 150
  }
  const fs = EF.hrLoadFactor(steady, 50, 190), fr = EF.hrLoadFactor(reps, 50, 190);
  assert.ok(Math.abs(fs - 1) < 0.01, 'steady ~1, got ' + fs);
  assert.ok(fr > 1.05, 'intervals weigh more, got ' + fr);
});
