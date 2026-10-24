import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../js/lib/dt.js';

test('day keys and arithmetic', () => {
  assert.equal(D.dayKey(new Date(2026, 7, 18, 12)), '2026-08-18');
  assert.equal(D.addDayKey('2026-02-27', 2), '2026-03-01');
  assert.equal(D.daysBetween('2026-08-01', '2026-08-18'), 17);
  assert.equal(D.weekStart('2026-08-20'), '2026-08-17');   // Thu -> Mon
  assert.equal(D.weekday('2026-08-23'), 6);                // Sunday
});

import * as P from '../js/lib/py.js';
test('python semantics', () => {
  assert.equal(P.pyRound(2.5), 2); assert.equal(P.pyRound(3.5), 4); assert.equal(P.pyRound(1.25, 1), 1.2);
  assert.equal(P.pyMod(-1, 7), 6); assert.deepEqual(P.divmod(3725, 60), [62, 5]);
  assert.ok(Math.abs(P.normInv(0.975) - 1.959963984540054) < 1e-12);
  assert.ok(Math.abs(P.normCdf(1.959963984540054) - 0.975) < 1e-12);
  assert.ok(Math.abs(P.stdev([1, 2, 3, 4]) - 1.2909944487358056) < 1e-15);
});
