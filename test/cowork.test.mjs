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
  async getFile() { return { text: async () => this.text_ }; }
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
  assert.deepEqual(manifest.channels.map(c => c.name), ['garmin', 'strava', 'analysis', 'coach']);
  const ctx = JSON.parse(await read(root, 'garmin/context.json'));
  assert.equal(ctx.payload.lastActivityStart, null);                      // empty device: ask for everything
  assert.match(await read(root, 'BRIEF.md'), /No activities yet/);

  // The agent answers: a Garmin export, and a strava dead letter.
  await put(root, 'garmin/inbox/output-2026-10-24.json', JSON.stringify({ protocol: 'run315-cowork', protocolVersion: 1,
    kind: 'garmin-output', requestHash: ctx.requestHash, payload: demoGarminPayload(new Date(2026, 9, 24, 9)) }));
  await put(root, 'strava/inbox/error-2026-10-24.json', JSON.stringify({ reason: 'not authorised: run strava-export.py --auth' }));

  assert.equal(await cowork.pollAll(true), 1);
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
  const actx = JSON.parse(await read(root, 'analysis/context.json'));
  assert.equal(actx.payload.requests[0].id, id);
  await put(root, 'analysis/inbox/output-a.json', JSON.stringify({ protocol: 'run315-cowork', protocolVersion: 1,
    kind: 'analysis-output', requestHash: actx.requestHash, payload: { answers: [{ id, answer: 'Yes: 12% to 9%.' }] } }));
  await cowork.pollAll(true);
  assert.equal(store.state.analysisRequests[id].status, 'answered');
});
