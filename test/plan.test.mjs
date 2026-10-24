// Port of test_plan.py: the training plan generator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../js/lib/plan.js';

const PACES = [['Easy', 'most of your week', 330.0, 366.0],
  ['Marathon', 'race-pace work', 268.0, 283.0],
  ['Threshold', 'tempo', 250.0, 258.0],
  ['Interval', 'VO2max', 234.0, 245.0],
  ['Repetition', 'speed', 220.0, 232.0]];

test('test_taper_weeks', () => {
  assert.equal(P.taperWeeks(42195), 3);
  assert.equal(P.taperWeeks(21097), 2);
  assert.equal(P.taperWeeks(10000), 1);
  assert.equal(P.taperWeeks(5000), 1);
  // A longer race than any listed still gets the longest taper.
  assert.equal(P.taperWeeks(50000), 3);
});

test('test_long_run_cap', () => {
  assert.equal(P.longRunCap(5000), 16000);
  assert.equal(P.longRunCap(10000), 22000);
  assert.equal(P.longRunCap(21097), 32000);
  assert.equal(P.longRunCap(42195), 38000);
  // Nobody needs a 40 km run to race a 10K.
  assert.ok(P.longRunCap(10000) < P.longRunCap(42195));
});

test('test_phase_for', () => {
  const weeks = 16, taper = 3;
  const phases = [];
  for (let i = 0; i < weeks; i++) phases.push(P.phaseFor(i, weeks, taper));
  assert.equal(phases[0], 'base');
  assert.ok(phases[phases.length - 1] === 'taper' && phases[phases.length - 3] === 'taper');
  assert.notEqual(phases[phases.length - 4], 'taper');
  assert.deepEqual(new Set(phases), new Set(['base', 'build', 'peak', 'taper']));
  // Phases only ever move forwards.
  const order = Object.fromEntries(P.PHASES.map((p, i) => [p, i]));
  for (let i = 1; i < phases.length; i++) assert.ok(order[phases[i]] >= order[phases[i - 1]], String(phases));
});

test('test_weekly_volumes_ramp_and_back_off', () => {
  const vols = P.weeklyVolumes(50000, 12, 2);
  assert.equal(vols.length, 12);
  assert.ok(vols.every(v => v > 0));

  // Every fourth week eases off.
  assert.ok(vols[3] < vols[2], `${vols[2]} ${vols[3]}`);
  assert.ok(vols[7] < vols[6]);

  // The ramp never exceeds the cap between consecutive BUILDING weeks. The
  // week after an easy week climbs back to where the block was, which is the
  // whole point of an easy week rather than a ramp violation.
  for (let i = 1; i < 10; i++) {
    if (i % P.CYCLE === 0) continue;          // previous week was the easy one
    const a = vols[i - 1], b = vols[i];
    if (b > a) assert.ok((b / a) - 1.0 <= P.MAX_RAMP + 1e-9, `${i} ${a} ${b}`);
  }

  // And that rebound really does happen, rather than the block losing its place.
  assert.ok(vols[4] > vols[3], 'the week after an easy week should pick the build back up');

  // And the plan never runs away from where it started.
  assert.ok(Math.max(...vols) <= 50000 * P.MAX_TOTAL_GROWTH + 1);

  // The taper comes down, and keeps coming down.
  const n = vols.length;
  assert.ok(vols[n - 1] < vols[n - 2] && vols[n - 2] < vols[n - 3]);

  assert.deepEqual(P.weeklyVolumes(0, 12, 2), []);
  assert.deepEqual(P.weeklyVolumes(50000, 0, 2), []);
});

test('test_long_run_is_a_share_of_the_week_and_capped', () => {
  // A big week for a 10K is still capped by the race.
  assert.equal(P.longRunFor(100000, 10000), 22000);
  // A normal week is a share of it.
  assert.ok(Math.abs(P.longRunFor(50000, 42195) - 15000) < 1);
  assert.ok(P.longRunFor(50000, 42195) < 50000);
});

test('test_build_shape', () => {
  const weeks = 16;
  const p = P.build(50000, 42195, weeks, PACES);
  assert.equal(p.length, weeks);
  assert.deepEqual(p.map(w => w.week), Array.from({ length: weeks }, (_, i) => i + 1));
  assert.ok(p[0].to_go === weeks && p[p.length - 1].to_go === 1);
  for (const w of p) {
    assert.ok(P.PHASES.includes(w.phase));
    assert.ok(w.sessions.length);
    // The week's parts add up to the week.
    assert.ok(Math.abs(w.long_run_m + w.easy_m - w.distance_m) < 1);
    assert.ok(w.long_run_m <= P.longRunCap(42195) + 1);
  }
  assert.equal(p[p.length - 1].phase, 'taper');
  assert.ok(p.filter(w => w.easy_week).length >= 2);
});

test('test_sessions_carry_the_athletes_own_paces', () => {
  const p = P.build(50000, 42195, 16, PACES);
  const buildWeek = p.filter(w => w.phase === 'build')[0];
  const names = buildWeek.sessions.map(s => s[0]);
  assert.ok(names.includes('Threshold') && names.includes('Intervals'));
  // Every session with a band carries the real numbers, not a chart.
  for (const [, , band] of buildWeek.sessions) {
    if (band) {
      const [fast, slow] = band;
      assert.ok(fast < slow);
      assert.ok(200 < fast && fast < 400);
    }
  }

  // A 5K peak sharpens differently from a marathon peak.
  const five = P.build(50000, 5000, 16, PACES);
  const peak5 = five.filter(w => w.phase === 'peak')[0];
  const peak42 = p.filter(w => w.phase === 'peak')[0];
  assert.ok(peak42.sessions.map(s => s[0]).includes('Race pace'));
  assert.ok(!peak5.sessions.map(s => s[0]).includes('Race pace'));
  assert.ok(peak5.sessions.map(s => s[0]).includes('Intervals'));

  // No paces available: the plan still builds, the bands are just empty.
  const bare = P.build(50000, 42195, 8, null);
  assert.ok(bare.length && bare.every(w => w.sessions.length));
  assert.ok(bare.every(w => w.sessions.every(s => s[2] === null)));
});

test('test_build_edges', () => {
  assert.deepEqual(P.build(0, 42195, 12, PACES), []);
  assert.deepEqual(P.build(50000, 42195, 0, PACES), []);
  assert.deepEqual(P.build(50000, 0, 12, PACES), []);
  // A two-week "plan" must not taper for longer than it exists.
  const tiny = P.build(50000, 42195, 2, PACES);
  assert.equal(tiny.length, 2);
  assert.ok(tiny.filter(w => w.phase === 'taper').length <= 1);
});

test('test_summarise', () => {
  const p = P.build(50000, 42195, 16, PACES);
  const s = P.summarise(p, 42195);
  assert.equal(s.weeks, 16);
  assert.equal(s.taper_weeks, 3);
  assert.equal(s.peak_week_m, Math.max(...p.map(w => w.distance_m)));
  assert.ok(1 <= s.peak_week_n && s.peak_week_n <= 16);
  assert.ok(s.longest_run_m <= P.longRunCap(42195) + 1);
  assert.ok(s.total_m > s.peak_week_m);
  assert.ok(0 < s.growth && s.growth <= P.MAX_TOTAL_GROWTH);
  assert.equal(P.summarise([]), null);
});

test('test_sanity_warnings', () => {
  assert.deepEqual(P.sanity([], 50000), []);
  // A sensible plan off a real base has nothing to complain about.
  const good = P.build(50000, 42195, 16, PACES);
  assert.deepEqual(P.sanity(good, 50000), []);
  // A short block says so.
  const short = P.build(50000, 42195, 6, PACES);
  assert.ok(P.sanity(short, 50000).some(n => n.includes('eight weeks')));
  // A plan built off a much smaller current base is flagged as provisional.
  assert.ok(P.sanity(good, 20000).some(n => n.includes('above what you are running now')));
});

test('test_the_peak_lands_late_in_the_build', () => {
  // Regression: compounding a fixed ramp hit the ceiling at week 7 of 16 and
  // then sat flat for six weeks. The heaviest week belongs just before the taper.
  const p = P.build(45000, 42195, 16, PACES);
  const s = P.summarise(p, 42195);
  const buildWeeks = p.length - s.taper_weeks;
  assert.ok(s.peak_week_n >= buildWeeks - 1, `${s.peak_week_n} ${buildWeeks}`);

  // And the build genuinely progresses rather than plateauing: no more than a
  // couple of weeks share the top volume.
  const top = s.peak_week_m;
  assert.ok(p.filter(w => w.distance_m > top * 0.99).length <= 2);

  // The long run grows through the block rather than being flat.
  const early = p.filter(w => w.phase === 'base' && !w.easy_week)[0];
  const lates = p.filter(w => w.phase === 'peak' && !w.easy_week);
  const late = lates[lates.length - 1];
  assert.ok(late.long_run_m > early.long_run_m * 1.5);
});

test('test_a_bigger_base_earns_a_bigger_long_run', () => {
  // A 70 km/week athlete should reach the marathon long-run cap; 45 should not.
  const small = P.summarise(P.build(45000, 42195, 16, PACES), 42195);
  const big = P.summarise(P.build(70000, 42195, 16, PACES), 42195);
  assert.ok(big.longest_run_m > small.longest_run_m);
  assert.ok(big.longest_run_m <= P.longRunCap(42195) + 1);
  assert.ok(small.longest_run_m < P.longRunCap(42195));
});

test('test_a_realistic_marathon_block', () => {
  // Read the plan the way an athlete would, and check it is sane.
  const p = P.build(45000, 42195, 16, PACES);
  const s = P.summarise(p, 42195);
  const peakKm = s.peak_week_m / 1000.0;
  const longKm = s.longest_run_m / 1000.0;
  assert.ok(45 < peakKm && peakKm < 80, String(peakKm));       // a real build, not a fantasy
  assert.ok(20 < longKm && longKm <= 38, String(longKm));      // a real long run, capped
  assert.ok(p[p.length - 1].distance_m < p[0].distance_m, 'race week should be light');
  // The heaviest week is not the last one before the race.
  assert.ok(s.peak_week_n <= p.length - s.taper_weeks);
});
