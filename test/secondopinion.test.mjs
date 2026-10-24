// Port of test_secondopinion.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as SO from '../js/lib/secondopinion.js';

test('test_threshold_hr_agreement', () => {
  const close = SO.thresholdHr(172.0, 170.0);
  assert.equal(close.band, 'agree');
  assert.ok(close.note.includes('agreement'));
  assert.equal(close.difference, 2.0);

  // Reading higher than Garmin should point at the conservative option.
  const higher = SO.thresholdHr(180.0, 172.0);
  assert.equal(higher.band, 'near');
  assert.ok(higher.note.includes('conservative'));

  const lower = SO.thresholdHr(160.0, 178.0);
  assert.equal(lower.band, 'differ');
  assert.ok(lower.note.includes('easy runs feel too easy'));
});

test('test_threshold_hr_needs_both_sides', () => {
  assert.equal(SO.thresholdHr(null, 170.0), null);
  assert.equal(SO.thresholdHr(170.0, null), null);
  assert.equal(SO.thresholdHr(0, 0), null);
});

test('test_threshold_pace_is_relative_not_absolute', () => {
  // Ten seconds matters more to a fast runner than a slow one.
  const fast = SO.thresholdPace(200.0, 190.0);      // 5.3%
  const slow = SO.thresholdPace(400.0, 390.0);      // 2.6%
  assert.ok(fast.difference_s === slow.difference_s && slow.difference_s === 10.0);
  assert.equal(fast.band, 'near');
  assert.equal(slow.band, 'agree');
});

test('test_races_only_compares_shared_distances', () => {
  const ours = { 5000: 1200.0, 10000: 2500.0, 21097: 5600.0 };
  const theirs = { 5000: 1210.0, 10000: 2480.0 };
  const rows = SO.races(ours, theirs);
  assert.deepEqual(rows.map(r => r.distance_m), [5000, 10000]);
  assert.ok(rows.every(r => r.ours && r.theirs));
  // Sorted by distance so the table reads in order.
  assert.ok(rows[0].distance_m < rows[1].distance_m);

  assert.deepEqual(SO.races({}, {}), []);
  assert.deepEqual(SO.races(null, null), []);
  assert.deepEqual(SO.races({ 5000: 1200.0 }, { 10000: 2500.0 }), []);
});

test('test_races_sign_convention', () => {
  // Positive means this app is slower, which is what the wording assumes.
  const rows = SO.races({ 5000: 1300.0 }, { 5000: 1200.0 });
  assert.ok(rows[0].difference_s > 0);
  assert.ok(rows[0].relative > 0);
});

test('test_race_summary_distinguishes_bias_from_scatter', () => {
  // Agreement everywhere.
  const agree = SO.races({ 5000: 1200.0, 10000: 2500.0 }, { 5000: 1205.0, 10000: 2490.0 });
  assert.ok(SO.raceSummary(agree).includes('one answer'));

  // Consistently quicker at every distance.
  const quick = SO.races({ 5000: 1100.0, 10000: 2300.0 }, { 5000: 1200.0, 10000: 2500.0 });
  const summary = SO.raceSummary(quick);
  assert.ok(summary.includes('quicker than Garmin at every distance'));
  assert.ok(summary.includes('threshold'));

  // Consistently slower.
  const slow = SO.races({ 5000: 1300.0, 10000: 2700.0 }, { 5000: 1200.0, 10000: 2500.0 });
  assert.ok(SO.raceSummary(slow).includes('slower than Garmin at every distance'));

  // Disagreeing in different directions is a shape problem, not a level one.
  const mixed = SO.races({ 5000: 1100.0, 10000: 2700.0 }, { 5000: 1200.0, 10000: 2500.0 });
  assert.ok(SO.raceSummary(mixed).includes('shape of the curve'));

  assert.equal(SO.raceSummary([]), null);
});

test('test_review_counts_what_it_compared', () => {
  const ours = { threshold_hr: 172.0, threshold_pace: 250.0, races: { 5000: 1200.0, 10000: 2500.0 } };
  const theirs = { threshold_hr: 170.0, threshold_pace: 248.0, races: { 5000: 1205.0, 10000: 2490.0 } };
  const result = SO.review(ours, theirs);
  assert.equal(result.comparisons, 4);      // two thresholds, two races
  assert.equal(result.disagreements, 0);
  assert.ok(result.race_summary);

  // A real disagreement is counted.
  theirs.threshold_hr = 150.0;
  const worse = SO.review(ours, theirs);
  assert.equal(worse.disagreements, 1);
});

test('test_review_survives_missing_data_entirely', () => {
  const empty = SO.review({}, {});
  assert.ok(empty.comparisons === 0 && empty.disagreements === 0);
  assert.deepEqual(empty.races, []);
  assert.equal(empty.race_summary, null);
  assert.equal(SO.review(null, null).comparisons, 0);

  // One side only is not a comparison.
  const half = SO.review({ threshold_hr: 170.0 }, {});
  assert.equal(half.comparisons, 0);
});

test('test_bands_are_ordered_and_symmetric', () => {
  // The same size of gap reads the same whichever way round it is.
  assert.equal(SO._band(0.0, 5, 12), 'agree');
  assert.equal(SO._band(5.0, 5, 12), 'agree');
  assert.equal(SO._band(-5.0, 5, 12), 'agree');
  assert.equal(SO._band(6.0, 5, 12), 'near');
  assert.equal(SO._band(-6.0, 5, 12), 'near');
  assert.equal(SO._band(13.0, 5, 12), 'differ');
  assert.equal(SO._band(-13.0, 5, 12), 'differ');
});
