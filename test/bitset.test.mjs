// Compact coverage bitsets: round trips, the legacy '0'/'1' format, and the size win.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as BS from '../js/bitset.js';

test('set/get/count/or', () => {
  const a = BS.create(20);
  assert.equal(a.length, 3);
  BS.set(a, 0); BS.set(a, 9); BS.set(a, 19);
  assert.deepEqual([0, 1, 9, 19].map(i => BS.get(a, i)), [1, 0, 1, 1]);
  assert.equal(BS.count(a), 3);
  const b = BS.create(20); BS.set(b, 1); BS.set(b, 9);
  BS.or(a, b);
  assert.equal(BS.count(a), 4);
});

test('mask <-> bitset <-> base64 round trip, any length', () => {
  for (const n of [0, 1, 7, 8, 9, 23, 24, 25, 100, 1000, 70000]) {
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) m[i] = (i * 7919) % 3 === 0 ? 1 : 0;
    const s = BS.toB64(BS.fromMask(m));
    assert.deepEqual(BS.toMask(BS.decode(s, n), n), m, 'n=' + n);
  }
});

test('trailing zeros are trimmed and read back as zeros', () => {
  const m = new Uint8Array(200); m[3] = 1;
  const s = BS.toB64(BS.fromMask(m));
  assert.ok(s.length <= 4);
  assert.equal(BS.decode(s, 200).length, 25);
  assert.equal(BS.toB64(BS.create(50)), '');
  assert.equal(BS.count(BS.decode('', 50)), 0);
});

test('legacy 0/1 strings decode, base64 is never mistaken for one', () => {
  assert.equal(BS.count(BS.decode('0110100', 7)), 3);
  assert.deepEqual([...BS.toMask(BS.decode('0110100', 7), 7)], [0, 1, 1, 0, 1, 0, 0]);
  for (let n = 1; n < 400; n++) {
    const m = new Uint8Array(n).fill(1);
    const s = BS.toB64(BS.fromMask(m));
    assert.ok(!BS.isLegacy(s, n), 'n=' + n);
    assert.equal(BS.count(BS.decode(s, n)), n);
  }
});

test('about a sixth of the legacy size', () => {
  const n = 6000, legacy = '1'.repeat(n);
  const s = BS.toB64(BS.decode(legacy, n));
  assert.ok(s.length < legacy.length / 5, s.length);
});
