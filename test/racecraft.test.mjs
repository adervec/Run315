// Port of test_racecraft.py: race strategy and postmortem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../js/lib/racecraft.js';
import { pyRound } from '../js/lib/py.js';

const LAT0 = 47.3769, LON0 = 8.5417;
const M_PER_DEG = 111320.0;
const sum = xs => xs.reduce((a, b) => a + b, 0);

// Build a course from [[metres, climb_m], ...] running due north.
function course(legs, ele0 = 400.0) {
  const pts = [[LAT0, LON0, ele0]];
  let lat = LAT0, ele = ele0;
  for (const [metres, climb] of legs) {
    const steps = Math.max(Math.trunc(metres / 25), 1);
    for (let k = 0; k < steps; k++) {
      lat += (metres / steps) / M_PER_DEG;
      ele += climb / steps;
      pts.push([pyRound(lat, 7), LON0, pyRound(ele, 2)]);
    }
  }
  return pts;
}

// Build a run stream from [[metres, pace_s_per_km, climb_m], ...].
function stream(legs, startHr = 150, hrRise = 0.0) {
  const out = [];
  let t = 0.0, d = 0.0, ele = 400.0;
  out.push([0.0, 0.0, startHr, LAT0, LON0, ele]);
  const total = sum(legs.map(l => l[0]));
  for (const [metres, pace, climb] of legs) {
    const steps = Math.max(Math.trunc(metres / 50), 1);
    for (let k = 0; k < steps; k++) {
      d += metres / steps;
      t += (metres / steps) / 1000.0 * pace;
      ele += climb / steps;
      const hr = startHr + hrRise * (d / total);
      out.push([pyRound(t, 2), pyRound(d, 2), pyRound(hr), LAT0, LON0, pyRound(ele, 2)]);
    }
  }
  return out;
}

test('test_cost_ratio', () => {
  assert.equal(R.costRatio(0.0), 1.0);
  assert.equal(R.costRatio(null), 1.0);
  // Uphill costs more, downhill less, monotonically over the usable range.
  assert.ok(R.costRatio(0.05) > 1.0);
  assert.ok(R.costRatio(0.10) > R.costRatio(0.05));
  assert.ok(R.costRatio(-0.05) < 1.0);
  // 10% up is roughly two-thirds dearer than flat.
  assert.ok(1.5 < R.costRatio(0.10) && R.costRatio(0.10) < 1.8, String(R.costRatio(0.10)));
  // The downhill benefit is floored: you cannot fall down a hill for free.
  assert.equal(R.costRatio(-0.20), R.MIN_RATIO);
  assert.equal(R.costRatio(-0.90), R.MIN_RATIO);
  assert.ok(R.costRatio(0.90) <= R.MAX_RATIO);
});

test('test_grade_adjusted_pace', () => {
  assert.equal(R.gradeAdjustedPace(null, 0.05), null);
  assert.equal(R.gradeAdjustedPace(300.0, 0.0), 300.0);
  // 5:00/km up a 10% hill is worth much better than 5:00 on the flat.
  assert.ok(R.gradeAdjustedPace(300.0, 0.10) < 200.0);
  // And downhill flatters you, so the adjusted pace is slower than the split.
  assert.ok(R.gradeAdjustedPace(300.0, -0.10) > 300.0);
});

test('test_segment_course_flat', () => {
  const segs = R.segmentCourse(course([[5000, 0]]));
  assert.equal(segs.length, 5);
  for (const s of segs) {
    assert.ok(Math.abs(s.distance_m - 1000) < 60, String(s.distance_m));
    assert.ok(Math.abs(s.grade) < 0.002);
    assert.ok(Math.abs(s.cost - 1.0) < 0.05);
  }
  assert.deepEqual(segs.map(s => s.n), [1, 2, 3, 4, 5]);
});

test('test_segment_course_with_a_hill', () => {
  // 2 km flat, 1 km climbing 60 m, 2 km flat.
  const segs = R.segmentCourse(course([[2000, 0], [1000, 60], [2000, 0]]));
  assert.equal(segs.length, 5);
  const hill = segs[2];
  assert.ok(0.045 < hill.grade && hill.grade < 0.075, String(hill.grade));
  assert.ok(hill.climb_m > 50);
  assert.ok(hill.cost > 1.2);
  assert.ok(segs[0].cost < hill.cost);
});

test('test_segment_course_leaves_a_short_last_piece', () => {
  const segs = R.segmentCourse(course([[2400, 0]]));
  assert.equal(segs.length, 3);
  const last = segs[segs.length - 1].distance_m;
  assert.ok(300 < last && last < 500, String(last));
});

test('test_course_stats', () => {
  const st = R.courseStats(course([[2000, 0], [1000, 80], [1000, -80], [1000, 0]]));
  assert.equal(st.has_elevation, true);
  assert.ok(4900 < st.length_m && st.length_m < 5100);
  assert.ok(70 < st.climb_m && st.climb_m < 95, String(st.climb_m));
  assert.ok(70 < st.drop_m && st.drop_m < 95, String(st.drop_m));
  assert.ok(st.difficulty > 1.0);                 // harder than the same distance flat
  assert.ok(st.steepest.grade > 0.05);
  assert.equal(R.courseStats([]), null);
  assert.equal(R.courseStats([[LAT0, LON0, 400]]), null);

  const flat = R.courseStats(course([[4000, 0]]));
  assert.ok(Math.abs(flat.difficulty - 1.0) < 0.05);   // flat course, no penalty
});

test('test_pace_plan_totals_the_target_and_slows_for_hills', () => {
  const segs = R.segmentCourse(course([[2000, 0], [1000, 70], [2000, 0]]));
  const plan = R.pacePlan(segs, 1500.0);     // 25 minutes for 5 km
  assert.equal(plan.length, segs.length);
  assert.ok(Math.abs(sum(plan.map(p => p.target_s)) - 1500.0) < 0.5);
  assert.ok(Math.abs(plan[plan.length - 1].cumulative_s - 1500.0) < 0.5);
  // The climb gets more time than the flat kilometres around it.
  assert.ok(plan[2].target_pace > plan[0].target_pace);
  assert.ok(plan[2].target_pace > plan[4].target_pace);
  // Cumulative time only goes up.
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i].cumulative_s > plan[i - 1].cumulative_s);
  assert.deepEqual(R.pacePlan([], 1500), []);
  assert.deepEqual(R.pacePlan(segs, 0), []);
});

test('test_pace_plan_negative_split', () => {
  const segs = R.segmentCourse(course([[6000, 0]]));
  const plan = R.pacePlan(segs, 1800.0, 0.02);
  assert.ok(Math.abs(sum(plan.map(p => p.target_s)) - 1800.0) < 0.5);
  assert.ok(plan[0].target_pace > plan[plan.length - 1].target_pace);   // start steadier
  const even = R.pacePlan(segs, 1800.0, 0.0);
  assert.ok(Math.abs(even[0].target_pace - even[even.length - 1].target_pace) < 0.5);
});

test('test_hard_sections', () => {
  const segs = R.segmentCourse(course([[1000, 0], [2000, 140], [1000, 0], [1000, 60]]));
  const hard = R.hardSections(segs);
  assert.ok(hard.length, JSON.stringify(segs));
  const biggest = hard[0];
  assert.ok(biggest.climb_m > 100);
  assert.ok(biggest.from_m >= 900);
  assert.ok(biggest.grade > R.CLIMB_GRADE);
  // A flat course has nothing to warn about.
  assert.deepEqual(R.hardSections(R.segmentCourse(course([[5000, 0]]))), []);
  assert.deepEqual(R.hardSections([]), []);
});

test('test_actual_segments', () => {
  const segs = R.actualSegments(stream([[3000, 300.0, 0]]));
  assert.equal(segs.length, 3);
  for (const s of segs) {
    assert.ok(Math.abs(s.pace - 300.0) < 12, String(s.pace));
    assert.equal(s.avg_hr, 150);
    assert.notEqual(s.gap, null);
  }
  assert.deepEqual(R.actualSegments([]), []);
  assert.deepEqual(R.actualSegments([[0, 0]]), []);
});

test('test_actual_segments_gap_sees_through_a_hill', () => {
  // A slow kilometre uphill can be a better effort than a fast one on the flat.
  const segs = R.actualSegments(stream([[1000, 280.0, 0], [1000, 330.0, 70]]));
  const [flat, hill] = segs;
  assert.ok(hill.pace > flat.pace);            // slower on the clock
  assert.ok(hill.gap < flat.gap);              // but a harder effort
});

test('test_compare_and_postmortem_even_race', () => {
  const segs = R.segmentCourse(course([[5000, 0]]));
  const plan = R.pacePlan(segs, 1500.0, 0.0);
  const actual = R.actualSegments(stream([[5000, 300.0, 0]]));
  const pm = R.postmortem(plan, actual, 1500.0);
  assert.notEqual(pm, null);
  assert.equal(pm.rows.length, actual.length);
  assert.ok(Math.abs(pm.total_s - 1500) < 40);
  assert.ok(Math.abs(pm.fade) < 0.03);
  assert.ok(pm.verdict.includes('Even') || pm.verdict.includes('Negative'), pm.verdict);
  assert.equal(R.postmortem(plan, []), null);
});

test('test_fade_compares_equal_halves', () => {
  // Regression: an odd number of kilometres used to compare 2 against 3.
  // Summed time over unequal halves reported a perfectly even 5 km as a 50% fade.
  for (const km of [5, 7, 9, 13]) {
    const actual = R.actualSegments(stream([[km * 1000, 300.0, 0]]));
    const pm = R.postmortem([], actual);
    assert.ok(Math.abs(pm.fade) < 0.02, `${km} ${pm.fade}`);
    assert.ok(pm.verdict.includes('Even'), `${km} ${pm.verdict}`);
  }
});

test('test_postmortem_calls_out_going_out_too_hard', () => {
  const segs = R.segmentCourse(course([[10000, 0]]));
  const plan = R.pacePlan(segs, 3000.0, 0.0);
  // 4:40/km for 5 km, then falling apart to 5:50/km.
  const actual = R.actualSegments(stream([[5000, 280.0, 0], [5000, 350.0, 0]]));
  const pm = R.postmortem(plan, actual, 3000.0);
  assert.ok(pm.fade > 0.06, String(pm.fade));
  assert.ok(pm.verdict.includes('too hard') || pm.verdict.includes('legs went'), pm.verdict);
  assert.ok(pm.lost_s > 0);
  assert.ok(pm.worst.delta_s > 0);
});

test('test_postmortem_blames_the_hills_when_the_hills_are_to_blame', () => {
  const segs = R.segmentCourse(course([[2000, 0], [1000, 0], [2000, 0]]));
  const plan = R.pacePlan(segs, 1500.0, 0.0);
  // The plan assumed flat; the run met a climb in the middle third.
  const actual = R.actualSegments(stream([[2000, 295.0, 0], [1000, 380.0, 70], [2000, 295.0, 0]]));
  const pm = R.postmortem(plan, actual, 1500.0);
  assert.ok(pm.uphill_segments >= 1);
  assert.ok(pm.uphill_loss_s > 0);
  assert.ok(pm.verdict.includes('climbs'), pm.verdict);
});

test('test_postmortem_negative_split_is_praised', () => {
  const segs = R.segmentCourse(course([[6000, 0]]));
  const plan = R.pacePlan(segs, 1800.0, 0.0);
  const actual = R.actualSegments(stream([[3000, 310.0, 0], [3000, 290.0, 0]]));
  const pm = R.postmortem(plan, actual, 1800.0);
  assert.ok(pm.fade < 0);
  assert.ok(pm.verdict.includes('Negative split'));
  assert.ok(pm.gained_s > 0);
});

test('test_postmortem_without_a_plan_still_reports', () => {
  const actual = R.actualSegments(stream([[5000, 300.0, 0]]));
  const pm = R.postmortem([], actual);
  assert.equal(pm.planned_s, null);
  assert.equal(pm.delta_s, null);
  assert.ok(pm.rows.every(r => r.target_s === null));
  assert.ok(pm.verdict);
});

test('test_hr_drift_is_measured', () => {
  const actual = R.actualSegments(stream([[6000, 300.0, 0]], 150, 20));
  const pm = R.postmortem([], actual);
  assert.ok(pm.hr_drift !== null && pm.hr_drift > 5, String(pm.hr_drift));
});

test('test_junk_input', () => {
  assert.deepEqual(R.cleanCourse(null), []);
  assert.deepEqual(R.cleanCourse([[null, 1], ['x', 2], [999, 8], [NaN, 8]]), []);
  assert.deepEqual(R.segmentCourse([]), []);
  assert.deepEqual(R.smoothElevation([]), []);
  // A course with no elevation still segments, it just has no gradients.
  const pts = [];
  for (let i = 0; i < 200; i++) pts.push([LAT0 + i * 0.0001, LON0]);
  const flat = R.segmentCourse(pts);
  assert.ok(flat.length && flat.every(s => s.grade === null));
  assert.ok(flat.every(s => s.cost === 1.0));
});
