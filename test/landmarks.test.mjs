// Self-check for landmarks (port of test_landmarks.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/lib/landmarks.js';

test('test_heights_are_sane', () => {
  // Guard the table itself: these are facts and should stay facts.
  const byName = Object.fromEntries(L.LANDMARKS.map(([n, h]) => [n, h]));
  assert.equal(byName['Everest'], 8849);
  assert.equal(byName['the Eiffel Tower'], 300);
  assert.equal(byName['the Burj Khalifa'], 828);
  assert.equal(byName['Ben Nevis'], 1345);
  // Everest is the tallest thing in the table, and nothing is negative.
  assert.equal(Math.max(...L.LANDMARKS.map(([, h]) => h)), 8849);
  assert.ok(L.LANDMARKS.every(([, h]) => h > 0));
  // No duplicate names.
  const names = L.LANDMARKS.map(([n]) => n);
  assert.equal(names.length, new Set(names).size);
});

test('test_compare_picks_the_tallest_thing_you_have_cleared', () => {
  // 900 m clears the Burj Khalifa (828) but not Table Mountain (1085).
  const result = L.compare(900.0);
  assert.equal(result.name, 'the Burj Khalifa');
  assert.ok(1.0 <= result.repeats && result.repeats < 1.1);

  // 2,700 m clears Ben Nevis (1345) but not Fuji.
  const big = L.compare(2700.0);
  assert.equal(big.name, 'Ben Nevis');
  assert.ok(2.0 < big.repeats && big.repeats < 2.1);
});

test('test_nothing_to_say_below_the_smallest_landmark', () => {
  assert.equal(L.compare(10.0), null);
  assert.equal(L.compare(0.0), null);
  assert.equal(L.compare(null), null);
  // Nelson's Column is the smallest at 52 m.
  assert.equal(L.compare(51.0), null);
  assert.equal(L.compare(53.0).name, "Nelson's Column");
});

test('test_phrases_read_like_a_person_wrote_them', () => {
  // Phrasing is tested against a one-entry table, because against the real one
  // `compare` would keep picking a taller landmark and the multiple would change.
  const only = [['the Eiffel Tower', 300, 'Paris']];
  assert.ok(L.compare(450.0, only).phrase.includes('one and a half'));
  assert.ok(L.compare(570.0, only).phrase.includes('nearly two'));
  // A plain multiple reads as a number and a plural.
  const phrase = L.compare(900.0, only).phrase;
  assert.ok(phrase.startsWith('3.0 ') && phrase.includes('Eiffel Towers'));
  // Just over once is named, not counted.
  assert.equal(L.compare(305.0, only).phrase, 'the Eiffel Tower');
});

test('test_pluralisation', () => {
  assert.equal(L._plural('the Eiffel Tower'), 'Eiffel Towers');
  assert.equal(L._plural('Everest'), 'Everests');
  // Already plural stays put rather than becoming "towerss".
  assert.equal(L._plural('the Golden Gate Bridge towers'), 'Golden Gate Bridge towers');
});

test('test_ladder_is_tallest_first_and_marks_what_is_cleared', () => {
  const rungs = L.ladder(1000.0);
  assert.equal(rungs[0].name, 'Everest');
  const heights = rungs.map(r => r.height_m);
  assert.deepEqual(heights, [...heights].sort((a, b) => b - a));
  const cleared = rungs.filter(r => r.cleared);
  assert.ok(cleared.every(r => r.height_m <= 1000));
  assert.ok(rungs.filter(r => r.height_m > 1000).every(r => !r.cleared));
  assert.deepEqual(L.ladder(0.0), []);
});

test('test_next_up_is_the_nearest_thing_still_out_of_reach', () => {
  // Just past the Eiffel Tower (300), the next rung is the Shard (310).
  const nxt = L.nextUp(305.0);
  assert.equal(nxt.name, 'the Shard');
  assert.ok(Math.abs(nxt.to_go_m - 5.0) < 1e-9);

  // Past Everest there is nothing left to chase.
  assert.equal(L.nextUp(9000.0), null);
  // From nothing, the smallest is next.
  assert.equal(L.nextUp(0.0).name, "Nelson's Column");
});
