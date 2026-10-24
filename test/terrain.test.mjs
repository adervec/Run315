// Port of test_terrain.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as RC from '../js/lib/racecraft.js';
import * as T from '../js/lib/terrain.js';

// A run over a given sequence of gradients.
//
// The runner holds exactly the speed the Minetti model predicts for each
// gradient, multiplied by `skill` -- so skill=1.0 is a runner who matches the
// model exactly and climbCost should recover 1.0.
function hillyStream(grades, { stepM = 200.0, flatSpeed = 3.0, skill = 1.0 } = {}) {
  const samples = [];
  let t = 0.0, metres = 0.0, elevation = 100.0;
  samples.push([0.0, 0.0, 150.0, 50.0, 8.0, elevation, 170.0, 1.2, 240.0, 8.0]);
  for (const grade of grades) {
    let speed = flatSpeed / RC.costRatio(grade);
    if (grade >= T.MIN_GRADE) speed *= skill;   // only climbing skill is under test
    t += stepM / speed;
    metres += stepM;
    elevation += stepM * grade;
    samples.push([t, metres, 150.0, 50.0, 8.0, elevation, 170.0, 1.2, 240.0, 8.0]);
  }
  return samples;
}

test('test_book_time_matches_naismith_by_hand', () => {
  // 10 km flat at 5 km/h is two hours.
  assert.ok(Math.abs(T.bookTime(10000.0) - 7200.0) < 1e-6);
  // 600 m of ascent adds exactly one hour.
  assert.ok(Math.abs(T.bookTime(10000.0, 600.0) - 10800.0) < 1e-6);
  // 300 m of ascent adds half an hour.
  assert.ok(Math.abs(T.bookTime(10000.0, 300.0) - 9000.0) < 1e-6);
  assert.equal(T.bookTime(0.0), 0.0);
});

test('test_langmuir_descent_corrections', () => {
  const flat = T.bookTime(10000.0);
  // Gentle descent earns a bonus: 300 m off a -10% slope saves ten minutes.
  const gentle = T.bookTime(10000.0, 0.0, 300.0, -0.10);
  assert.ok(Math.abs(gentle - (flat - 600.0)) < 1e-6, String(gentle));
  // Steep descent costs instead.
  const steep = T.bookTime(10000.0, 0.0, 300.0, -0.30);
  assert.ok(Math.abs(steep - (flat + 600.0)) < 1e-6, String(steep));
  // A moderate descent between the bands is neither.
  assert.equal(T.bookTime(10000.0, 0.0, 300.0, -0.03), flat);
  // Descent with no gradient given cannot be corrected either way.
  assert.equal(T.bookTime(10000.0, 0.0, 300.0), flat);
});

test('test_book_time_never_goes_negative', () => {
  // A huge gentle descent must not produce a negative predicted time.
  assert.ok(T.bookTime(1000.0, 0.0, 20000.0, -0.10) >= 0.0);
});

test('test_difficulty_bands', () => {
  assert.equal(T.difficulty(10000.0, 20.0), 'flat');
  assert.equal(T.difficulty(10000.0, 100.0), 'rolling');
  assert.equal(T.difficulty(10000.0, 250.0), 'hilly');
  assert.equal(T.difficulty(10000.0, 450.0), 'steep');
  assert.equal(T.difficulty(10000.0, 900.0), 'mountainous');
  assert.equal(T.difficulty(0.0, 100.0), null);
});

test('test_terrain_ratio', () => {
  // A runner doing 10 km flat in 50 min against a 2 h book time.
  const r = T.terrainRatio(3000.0, 10000.0);
  assert.ok(Math.abs(r.ratio - 3000.0 / 7200.0) < 1e-9);
  assert.equal(r.difficulty, 'flat');

  // The same ratio on much hillier ground means a better day, because the
  // book time it is measured against is bigger.
  const hilly = T.terrainRatio(3000.0, 10000.0, 600.0);
  assert.ok(hilly.ratio < r.ratio);
  assert.ok(hilly.book_s > r.book_s);
  assert.equal(hilly.difficulty, 'mountainous');   // 60 m of climb per km

  assert.equal(T.terrainRatio(0.0, 10000.0), null);
  assert.equal(T.terrainRatio(3000.0, 0.0), null);
});

const GRADES = [0.0, 0.05, 0.0, 0.08, 0.0, 0.06, 0.10, 0.0, 0.04, 0.0, 0.07, 0.0];

test('test_a_runner_who_matches_the_model_scores_one', () => {
  // The calibration anchor: skill=1.0 must come back as factor 1.0.
  const result = T.climbCost(hillyStream(GRADES, { skill: 1.0 }));
  assert.notEqual(result, null);
  assert.ok(Math.abs(result.factor - 1.0) < 1e-6, String(result.factor));
  assert.ok(result.verdict.includes('about as the energy model expects'));
});

test('test_a_strong_climber_scores_above_one', () => {
  const result = T.climbCost(hillyStream(GRADES, { skill: 1.15 }));
  assert.ok(Math.abs(result.factor - 1.15) < 1e-6, String(result.factor));
  assert.ok(result.verdict.includes('strength'));
});

test('test_a_weak_climber_scores_below_one', () => {
  const result = T.climbCost(hillyStream(GRADES, { skill: 0.85 }));
  assert.ok(Math.abs(result.factor - 0.85) < 1e-6, String(result.factor));
  assert.ok(result.verdict.includes('cost you'));
});

test('test_the_factor_is_independent_of_how_fit_or_fresh_you_are', () => {
  // Everything except the gradient must cancel out.
  // A runner half as fast overall, with the same climbing bias, scores the same.
  const grades = [0.0, 0.06, 0.0, 0.09, 0.0, 0.05, 0.0, 0.07, 0.0, 0.08];
  const quick = T.climbCost(hillyStream(grades, { flatSpeed: 4.0, skill: 1.10 }));
  const slow = T.climbCost(hillyStream(grades, { flatSpeed: 2.0, skill: 1.10 }));
  assert.ok(Math.abs(quick.factor - slow.factor) < 1e-9);
  assert.ok(quick.flat_speed > slow.flat_speed);
});

test('test_climb_cost_needs_hills_and_flat_to_compare', () => {
  // All flat: no climbing to judge.
  assert.equal(T.climbCost(hillyStream(Array(12).fill(0.0))), null);
  // All uphill: no flat reference to judge it against.
  assert.equal(T.climbCost(hillyStream(Array(12).fill(0.06))), null);
  // Too short to say anything.
  assert.equal(T.climbCost(hillyStream([0.0, 0.05, 0.0])), null);
  assert.equal(T.climbCost([]), null);
});

test('test_segments_ignore_samples_without_elevation', () => {
  // A watch with no barometer must produce nothing rather than nonsense.
  const stream = hillyStream(GRADES);
  const blind = stream.map(s => [...s.slice(0, 5), null, ...s.slice(6)]);
  assert.equal(T.climbCost(blind), null);
});

test('test_absurd_gradients_are_dropped', () => {
  // A GPS elevation spike must not be read as a cliff.
  const grades = [0.0, 0.05, 0.0, 0.08, 0.0, 0.06, 0.0, 0.04, 0.0, 0.07, 0.0];
  const clean = T.climbCost(hillyStream(grades));
  let spiked = hillyStream(grades);
  // Insert a 60% "gradient" -- beyond anything the model was fitted on.
  spiked = [...spiked.slice(0, 5),
    [spiked[5][0], spiked[5][1], 150.0, 50.0, 8.0, spiked[5][5] + 200.0, ...spiked[5].slice(6)],
    ...spiked.slice(6)];
  const result = T.climbCost(spiked);
  assert.notEqual(result, null);
  // The spike is excluded, so the factor stays close to the clean run.
  assert.ok(Math.abs(result.factor - clean.factor) < 0.05, `${result.factor} ${clean.factor}`);
});

test('test_profile_weights_by_how_much_climbing_each_run_had', () => {
  const run = (factor, segments) => ({ factor, climb_segments: segments });

  // One big hilly run should dominate two runs with a single hill each.
  const result = T.profile([run(1.20, 40), run(0.90, 2), run(0.90, 2)]);
  assert.ok(result.factor > 1.15, String(result.factor));
  assert.ok(result.runs === 3 && result.climb_segments === 44);

  // Too few runs is not a trait.
  assert.equal(T.profile([run(1.2, 10), run(1.1, 10)]), null);
  assert.equal(T.profile([]), null);
  assert.equal(T.profile([null, null, null]), null);
});
