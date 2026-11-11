// The cowork round trip against an in-memory folder: requests out, a Garmin reply and a
// dead letter in, imported once, moved to processed/, and the next request asks for less.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/store.js';
import * as cowork from '../js/cowork.js';
import { demoGarminPayload } from '../js/demo.js';

// Just enough of the File System Access API.
class Dir {
  constructor(name) { this.name = name; this.kind = 'directory'; this.kids = new Map(); }
  async getDirectoryHandle(n, o) { if (!this.kids.has(n)) { if (!o?.create) throw new Error('NotFound ' + n); this.kids.set(n, new Dir(n)); } return this.kids.get(n); }
  async getFileHandle(n, o) { if (!this.kids.has(n)) { if (!o?.create) throw new Error('NotFound ' + n); this.kids.set(n, new File_(n)); } return this.kids.get(n); }
  async removeEntry(n) { this.kids.delete(n); }
  async *entries() { yield* this.kids.entries(); }
  async queryPermission() { return 'granted'; }
}
class File_ {
  constructor(name) { this.name = name; this.kind = 'file'; this.text_ = ''; }
  async createWritable() { const f = this; let buf = ''; return { write: async t => { buf += t; }, close: async () => { f.text_ = buf; } }; }
  async getFile() { return { size: this.text_.length, text: async () => this.text_ }; }
}
const read = async (root, path) => { let d = root; const parts = path.split('/'); const f = parts.pop(); for (const p of parts) d = await d.getDirectoryHandle(p); return (await d.getFileHandle(f)).text_; };
const put = async (root, path, text) => { let d = root; const parts = path.split('/'); const f = parts.pop(); for (const p of parts) d = await d.getDirectoryHandle(p, { create: true }); const w = await (await d.getFileHandle(f, { create: true })).createWritable(); await w.write(text); await w.close(); };

test('requests out, replies in, once', async () => {
  await store.loadState();
  const root = new Dir('Run315 cowork');
  await store.idbSet('kv', 'coworkFolder', root);
  store.state.local.cowork = { enabled: true, folderName: root.name };

  assert.ok(await cowork.exportNow(false));
  const manifest = JSON.parse(await read(root, 'cowork.json'));
  assert.deepEqual(manifest.channels.map(c => c.name), ['garmin', 'strava', 'analysis', 'coach', 'pod', 'datareview']);
  const ctx = JSON.parse(await read(root, 'garmin/context.json'));
  assert.equal(ctx.payload.lastActivityStart, null);                      // empty device: ask for everything
  assert.match(await read(root, 'BRIEF.md'), /No activities yet/);

  // The agent answers: a Garmin export, and a strava dead letter.
  await put(root, 'garmin/inbox/output-2026-10-24.json', JSON.stringify({ protocol: 'run315-cowork', protocolVersion: 1,
    kind: 'garmin-output', requestHash: ctx.requestHash, payload: demoGarminPayload(new Date(2026, 9, 24, 9)) }));
  await put(root, 'strava/inbox/error-2026-10-24.json', JSON.stringify({ reason: 'not authorised: run strava-export.py --auth' }));

  // Review is on by default: the reply waits, listed by part, and nothing has changed yet.
  assert.equal(await cowork.pollAll(true), 0);
  assert.equal(Object.keys(store.state.activities).length, 0);
  const [rev] = cowork.pendingReviews();
  assert.equal(rev.channel, 'garmin');
  assert.deepEqual(rev.rows.map(r => r.id), ['activities', 'days', 'gear']);
  assert.match(rev.rows[0].label, /^Activities: \d+ new, 0 updated$/);
  assert.equal(await cowork.pollAll(true), 0);                            // still waiting, not listed twice
  assert.equal(cowork.pendingReviews().length, 1);
  assert.equal(cowork.panelData().channels.find(c => c.channel === 'garmin').review, true);

  // Take the activities and days, leave the gear.
  const applied = await cowork.approve(rev.key, ['activities', 'days']);
  assert.ok(applied.handled && applied.undoKey);
  assert.equal(Object.keys(store.state.gear).length, 0);
  assert.equal(cowork.pendingReviews().length, 0);
  assert.ok(Object.keys(store.state.activities).length > 300);
  assert.ok(Object.keys(store.state.derived).length > 200, 'streams analysed on import');
  const garminDir = await root.getDirectoryHandle('garmin');
  assert.equal([...(await garminDir.getDirectoryHandle('inbox')).kids.keys()].length, 0);
  assert.ok((await garminDir.getDirectoryHandle('processed')).kids.has('output-2026-10-24.json'));
  assert.ok(cowork.runs().some(r => /agent reported: not authorised/.test(r.note)));

  // The import re-exported: the next request starts from the newest activity, and streams are on disk.
  const next = JSON.parse(await read(root, 'garmin/context.json'));
  assert.ok(next.payload.lastActivityStart && next.payload.needDetail.length === 0);
  assert.ok((await root.getDirectoryHandle('data')).kids.size === 1);
  assert.ok((await (await root.getDirectoryHandle('data')).getDirectoryHandle('streams')).kids.size > 200);

  // A second poll finds nothing new.
  assert.equal(await cowork.pollAll(true), 0);

  // A question round-trips through the analysis channel.
  const id = cowork.ask('Is my decoupling improving?');
  await cowork.exportNow(false);
  // The brief's digest carries the imported runs and says when Garmin last landed.
  const recent = JSON.parse(await read(root, 'recent.json')).payload;
  assert.ok(recent.activities.length > 0 && Object.keys(recent.days).length > 0);
  assert.ok(recent.freshness.lastImport.garmin);
  const actx = JSON.parse(await read(root, 'analysis/context.json'));
  assert.equal(actx.payload.requests[0].id, id);
  await put(root, 'analysis/inbox/output-a.json', JSON.stringify({ protocol: 'run315-cowork', protocolVersion: 1,
    kind: 'analysis-output', requestHash: actx.requestHash, payload: { answers: [{ id, answer: 'Yes: 12% to 9%.' }] } }));
  cowork.setReview('analysis', false);                                     // switched to automatic for this channel
  await cowork.pollAll(true);
  assert.equal(store.state.analysisRequests[id].status, 'answered');

  // Undo the Garmin import: every record it added goes (tombstoned, so Drive drops them too), and its streams.
  const before = Object.keys(store.state.activities).length;
  const n = await cowork.undoRun(applied.undoKey);
  assert.ok(n >= before);
  assert.equal(Object.keys(store.state.activities).length, 0);
  assert.equal(Object.keys(store.state.daily).length, 0);
  assert.equal((await store.streamIds()).length, 0);
  assert.ok(Object.keys(store.state.tombs.activities).length >= before);
  assert.ok(cowork.runs().some(r => r.undoKey === applied.undoKey && r.undone));
  await assert.rejects(cowork.undoRun(applied.undoKey), /no longer be undone/);
});

test('review previews: Strava says new vs updated, and filtering keeps only the ticked parts', () => {
  const st = { activities: { g1: { id: 'g1', strava_id: '7' } }, analysisRequests: { q1: { q: 'Why?' } } };
  const rows = cowork.previewReply('strava-output', { activities: [{ id: 7, start_date_local: '2026-11-01T07:00:00' }, { id: 8, start_date_local: '2026-11-03T07:00:00' }], gear: [{ id: 'b1', name: 'Bike' }] }, st);
  assert.deepEqual(rows.map(r => [r.id, r.label]), [['activities', 'Activities: 1 new, 1 updated'], ['gear', 'Gear: 1']]);
  assert.equal(rows[0].detail.split(' · ')[0], '2026-11-01 → 2026-11-03');
  const f = cowork.filterPayload('strava-output', { activities: [1], gear: [2] }, new Set(['gear']));
  assert.deepEqual([f.activities, f.gear], [[], [2]]);
  const a = cowork.filterPayload('analysis-output', { answers: [{ id: 'q1' }, { id: 'q2' }] }, new Set(['q1']));
  assert.deepEqual(a.answers.map(x => x.id), ['q1']);
  assert.equal(cowork.filterPayload('coach-output', { review: 'x' }, new Set()), null);
  assert.equal(cowork.previewReply('analysis-output', { answers: [{ id: 'q1', answer: 'Because.' }] }, st)[0].label, 'Why?');
});

test('recent.json: six weeks whole, nothing older, heavy fields left out', () => {
  const now = new Date(2026, 10, 8, 9);
  const st = { activities: { a: { id: 'a', start: '2026-11-07T07:00:00', distance_m: 10000 }, old: { id: 'old', start: '2026-01-01T07:00:00' } },
    laps: { a: { laps: [{ n: 1 }] } }, derived: { a: { efforts: [1], tiles: ['x'], p0: [1, 2] } },
    daily: { '2026-11-07': { steps: 9000, stress_timeline: Array(200).fill(1) }, '2025-01-01': { steps: 1 } },
    wellness: { '2026-11-08': { hrv_ms: 60 } }, journal: { a: { rpe: 5 }, '2026-11-07': { tags: ['travel'] } },
    races: { r: { id: 'r', date: '2026-12-01' } },
    local: { coworkLocal: { ledger: { garmin: { h1: { at: '2026-11-08T06:00:00Z', ok: true }, h2: { at: '2026-11-08T07:00:00Z', error: 'x' } } } } } };
  const d = cowork.recentDigest(st, now);
  assert.deepEqual(d.activities.map(a => a.id), ['a']);
  assert.equal(d.activities[0].laps.length, 1);
  assert.equal(d.activities[0].journal.rpe, 5);
  assert.deepEqual(Object.keys(d.activities[0].derived), ['efforts']);
  assert.deepEqual(Object.keys(d.days), ['2026-11-08', '2026-11-07']);
  assert.equal(d.days['2026-11-07'].daily.steps, 9000);
  assert.equal(d.days['2026-11-07'].daily.stress_timeline, undefined);
  assert.deepEqual(d.days['2026-11-07'].journal.tags, ['travel']);
  assert.equal(d.freshness.lastDailyDay, '2026-11-07');
  assert.equal(d.freshness.lastImport.garmin, '2026-11-08T06:00:00Z');
  assert.equal(d.races.length, 1);
});
