// A calendar day is the runner's LOCAL day. The suite pins TZ=UTC (test/tz.mjs), which hides
// the bug, so this spawns node in São Paulo (UTC-3): a 22:30 run is already tomorrow in UTC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const CHILD = `
const { dayKey } = await import('./js/lib/dt.js');
const { recentDigest } = await import('./js/cowork.js');
const now = new Date(2026, 10, 9, 22, 30);           // 22:30 local on the 9th
const st = { activities: { a: { id: 'a', start: '2026-11-09T22:30:00' } } };
console.log(JSON.stringify({ utc: now.toISOString().slice(0, 10), local: dayKey(now), to: recentDigest(st, now).window.to }));`;

test('a 22:30 run in São Paulo stays on its local day', () => {
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', CHILD],
    { env: { ...process.env, TZ: 'America/Sao_Paulo' }, encoding: 'utf8' }));
  assert.equal(out.utc, '2026-11-10');   // the trap: UTC has already moved on
  assert.equal(out.local, '2026-11-09');
  assert.equal(out.to, '2026-11-09');
});
