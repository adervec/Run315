// What stops a decade of data running the browser out of memory: device-local saves are
// not data (no sync, no memo rebuild), a sync that brings nothing changes nothing, and the
// heavy per-activity detail stays out of the synced state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/store.js';
import { emptyState, syncPayload, fingerprint, put } from '../js/merge.js';
import { importGarmin } from '../js/ingest.js';
import { demoGarminPayload } from '../js/demo.js';
import * as D from '../js/derive.js';

test('device-local saves are not data: no revision bump, so no sync and no recompute', () => {
  const r0 = store.rev;
  for (const why of ['local', 'cowork', 'theme', 'ai', 'cloud', 'cloud-meta']) store.save(why);
  assert.equal(store.rev, r0);
  assert.ok(!store.isDataChange('local') && store.isDataChange('edit') && store.isDataChange('cloud-data'));
});

test('a sync that brings nothing new reports no change (the loop breaker)', async () => {
  await store.loadState();
  store.replaceState(emptyState());
  put(store.state, 'races', 'r1', { name: 'A' }, '2026-01-01T00:00:00Z');
  const same = JSON.parse(JSON.stringify(syncPayload(store.state)));
  assert.equal(store.mergeIn(same), false);
  assert.equal(fingerprint(syncPayload(store.state)), fingerprint(same));
  const newer = JSON.parse(JSON.stringify(same)); newer.races.r1 = { name: 'B', u: '2026-02-01T00:00:00Z' };
  assert.equal(store.mergeIn(newer), true);
  assert.equal(store.state.races.r1.name, 'B');
});

test('derived records sync slim; the detail comes back on demand', async () => {
  await store.loadState();
  store.replaceState(emptyState());
  const r = await importGarmin(store.state, demoGarminPayload(new Date(2026, 9, 24, 9)), store.putStream);
  await D.deriveAll(store.state, r.streams);
  const cores = Object.values(store.state.derived);
  assert.ok(cores.length > 200);
  for (const c of cores) assert.ok(!c.points && !c.splits && !(c.session && c.session.reps) && !(c.stops && c.stops.interruptions), 'core carries no detail');
  const perRun = JSON.stringify(store.state.derived).length / cores.length;
  assert.ok(perRun < 3000, 'core stays a few KB per run, got ' + Math.round(perRun));
  const withSession = Object.keys(store.state.derived).find(id => store.state.derived[id].session);
  const full = await D.fullDerived(store.state, withSession);
  assert.ok(full.points.length > 10 && full.session.reps.length === store.state.derived[withSession].session.paces.length);
  assert.ok(D.junctions(store.state).length > 0, 'crossings still learnable from the slim core');

  // A record derived before the split is slimmed at boot, its detail kept.
  const id = withSession, fat = { ...full, u: 'x' };
  store.state.derived[id] = fat;
  assert.equal(await D.slimAll(store.state), 1);
  assert.ok(!store.state.derived[id].points && (await D.getDetail(id)).points.length > 10);
});
