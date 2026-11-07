import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { decodeFit, fitType, FIT_EPOCH } from '../js/fit.js';
import { FitWriter, T, fitTime, semi, sampleActivity } from './fitenc.mjs';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('fit: records, laps, session, hrv, local offset, in profile units', () => {
  const f = decodeFit(sampleActivity({ start: 1700000000, n: 20 }));
  assert.equal(f.file_type, 4);
  assert.equal(f.sport, 1);
  assert.equal(f.start, '2023-11-14T22:13:20Z');
  assert.equal(f.local_offset_s, -18000);
  assert.equal(f.records.length, 20);
  const r = f.records[10];
  assert.equal(r.timestamp, 1700000010);
  close(r.position_lat, 43.6501, 1e-6);
  close(r.position_long, -79.38, 1e-6);
  assert.equal(r.distance, 30);
  close(r.enhanced_altitude, 102, 1e-9);
  assert.equal(r.heart_rate, 150);
  assert.equal(r.cadence, 85);
  assert.equal(r.fractional_cadence, 0.5);
  assert.equal(r.power, 310);
  assert.equal(r.enhanced_speed, 3);
  assert.equal(r.vertical_oscillation, 95);
  assert.equal(r.stance_time, 250);
  assert.equal(r.step_length, 1200);
  assert.equal(r.vertical_ratio, 7.9);
  assert.equal(r.stance_time_balance, 49.5);
  assert.equal(r.temperature, 21);
  assert.equal(f.laps.length, 1);
  assert.equal(f.laps[0].total_timer_time, 20);
  assert.equal(f.laps[0].total_distance, 57);
  assert.equal(f.session.total_calories, 250);
  assert.equal(f.session.start_time, 1700000000);
  assert.deepEqual(f.rr_ms, [812, 798, 805]);
});

test('fit: compressed timestamps, big-endian definitions, developer fields, unknown messages, invalid values', () => {
  const t0 = 1700000000;
  const w = new FitWriter();
  w.def(0, 0, [[0, T.enum], [4, T.uint32]]).data(0, [4, fitTime(t0)]);
  w.def(1, 20, [[253, T.uint32], [5, T.uint32], [3, T.uint8]], { be: true }).data(1, [fitTime(t0), 0, 120]);
  // a message Run315 does not read (device_info, 23), with a developer field on it
  w.def(2, 23, [[0, T.uint8], [253, T.uint32]], { dev: [[0, 4, 0]] }).data(2, [1, fitTime(t0 + 1)], { devFill: 0xAB });
  // compressed-timestamp records: local 3, no timestamp field, developer bytes too
  w.def(3, 20, [[5, T.uint32], [3, T.uint8], [7, T.uint16]], { dev: [[1, 2, 0], [2, 1, 0]] });
  const base = fitTime(t0 + 1);
  for (let i = 1; i <= 40; i++) w.data(3, [i * 250, i === 5 ? null : 120 + i, 200], { compressed: (base + i) & 0x1F, devFill: 0x7F });
  const f = decodeFit(w.bytes());
  assert.equal(f.records.length, 41);
  assert.equal(f.records[0].heart_rate, 120);           // read big-endian
  assert.equal(f.records[0].timestamp, t0);
  // the 5-bit rollover: every compressed record lands on its true second
  f.records.slice(1).forEach((r, i) => assert.equal(r.timestamp, t0 + 1 + i + 1));
  assert.equal(f.records[5].heart_rate, undefined);    // invalid 0xFF -> absent
  assert.equal(f.records[40].distance, 100);
  assert.equal(f.records[40].power, 200);
  assert.equal(f.start, new Date(t0 * 1000).toISOString().slice(0, 19) + 'Z');
});

test('fit: chained files, truncated tail, not-a-fit', () => {
  const a = sampleActivity({ n: 5, rr: null }), b = sampleActivity({ start: 1700000100, n: 3, rr: null });
  const both = new Uint8Array(a.length + b.length); both.set(a); both.set(b, a.length);
  const f = decodeFit(both);
  assert.equal(f.records.length, 8);
  assert.equal(f.sessions.length, 2);
  const cut = decodeFit(a.subarray(0, a.length - 40));   // a record cut in half: stop, keep what came before
  assert.ok(cut.records.length >= 4 && cut.records.length <= 5);
  assert.throws(() => decodeFit(new Uint8Array(20)), /not a FIT/);
});

test('fit: sport mapping fallback', () => {
  assert.equal(fitType(1, 1), 'treadmill_running');
  assert.equal(fitType(1, 0), 'running');
  assert.equal(fitType(2, 58), 'virtual_ride');
  assert.equal(fitType(10, 20), 'strength_training');
  assert.equal(fitType(99, 0), 'other');
  assert.equal(FIT_EPOCH, Date.UTC(1989, 11, 31) / 1000);
});

// The athlete's own files, when this machine has them (CI does not).
const REAL = 'C:\\Users\\Adam Erik Eryavec\\Documents\\Cowork\\Cowork Link Folders\\Run315\\garmin\\fit';
test('fit: real Garmin files decode', { skip: !existsSync(REAL) && 'no real FIT files on this machine' }, () => {
  const files = readdirSync(REAL).filter(f => /\.fit$/i.test(f)).slice(0, 12);
  assert.ok(files.length);
  for (const name of files) {
    const f = decodeFit(readFileSync(REAL + '\\' + name));
    assert.equal(f.file_type, 4, name);
    assert.ok(f.records.length > 10, name);
    assert.ok(f.session && f.session.total_timer_time > 0, name);
    const last = f.records.filter(r => r.distance != null).at(-1);
    if (last && f.session.total_distance) assert.ok(Math.abs(last.distance / f.session.total_distance - 1) < 0.02, name);
    for (const r of f.records) if (r.heart_rate != null) assert.ok(r.heart_rate >= 0 && r.heart_rate < 255, name);
  }
});
