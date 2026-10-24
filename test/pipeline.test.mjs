// The whole path an activity takes: Garmin reply -> state -> derived -> brief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState } from '../js/merge.js';
import { importGarmin } from '../js/ingest.js';
import { demoGarminPayload, demoExtras } from '../js/demo.js';
import * as D from '../js/derive.js';

test('demo athlete end to end', async () => {
  const now = new Date(2026, 9, 24, 9, 0), st = emptyState(), streams = new Map();
  const r = await importGarmin(st, demoGarminPayload(now), async (id, rec) => { streams.set(id, rec); });
  Object.assign(st.races, demoExtras(now).races);
  assert.ok(r.activities > 300 && r.streams.length > 200);
  await D.deriveAll(st, r.streams, null, { getStream: async id => streams.get(id) });
  const s = D.summary(st, now);
  assert.ok(s.ctl > 10 && s.threshold_hr > 120, 'fitness model runs');
  assert.ok(D.personalRecords(st).length >= 3, 'best efforts found inside runs');
  assert.ok(Object.values(st.derived).filter(d => d.session).length >= 40, 'interval sessions detected');
  assert.ok(D.tileSummary(st, now).tiles > 50, 'territory claimed');
  assert.ok(D.repeatedRoutes(st, now).length >= 1, 'repeated routes found');
  const b = D.buildBrief(st, now);
  assert.ok(b.standards.length && b.races.length);
  const md = D.briefMarkdown(b);
  assert.match(md, /Fitness \(CTL/);
  assert.ok(!/undefined|NaN/.test(md), md.split('\n').filter(l => /undefined|NaN/.test(l)).join('\n'));
});
