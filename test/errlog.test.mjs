import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadState, logError, state } from '../js/store.js';

test('crash log folds repeats and keeps the last 30', async () => {
  await loadState();
  logError(new Error('boom'), 'render x'); logError(new Error('boom'), 'render x');
  assert.equal(state.local.errors.length, 1);
  assert.equal(state.local.errors[0].n, 2);
  for (let i = 0; i < 40; i++) logError('e' + i, 'w');
  assert.equal(state.local.errors.length, 30);
  assert.equal(state.local.errors[0].msg, 'e39');
  logError(null); logError(undefined);   // never throws
});
