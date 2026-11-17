// What an AI agent reads stays English whatever language the reader picked: BRIEF.md, brief.json,
// recent.json and every channel's request. A fake dictionary marks every translated string with
// «»; none may reach the agent's files. (Stored data stays English for the same reason: it is
// re-worded for the reader at display time.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../js/store.js';
import * as D from '../js/derive.js';
import * as cowork from '../js/cowork.js';
import { importGarmin } from '../js/ingest.js';
import { demoGarminPayload } from '../js/demo.js';
import { t } from '../js/i18n.js';

test('the agent-facing files are English even when the reader reads another language', async () => {
  await store.loadState();
  const r = await importGarmin(store.state, demoGarminPayload(new Date(2026, 9, 24, 9)), store.putStream);
  await D.deriveAll(store.state, r.streams);
  const mark = Object.assign((k, p) => '«' + k + '»' + (p ? JSON.stringify(p) : ''), { n: (one, other, n) => '«' + (n === 1 ? one : other) + '»' });
  globalThis.appFont = { t: mark };
  try {
    assert.equal(t('Today'), '«Today»', 'the fake dictionary is in force for the reader');
    const now = new Date(2026, 9, 24, 20);
    // Warm every cache the way a page does, in the reader's language, before the agent's files are built.
    for (const f of ['readinessToday', 'gaps', 'heatState', 'zoneSummary', 'secondOpinion', 'summary', 'stopTotals', 'calibration']) {
      try { if (typeof D[f] === 'function') D[f](store.state, f === 'summary' ? now : undefined); } catch { /* signature differs: skip */ }
    }
    const brief = D.buildBrief(store.state, now);
    const out = { brief, md: D.briefMarkdown(brief), recent: cowork.recentDigest(store.state, now) };
    for (const c of cowork.CHANNELS) out[c.key] = await cowork.channelContext(c.key);
    for (const [k, v] of Object.entries(out)) {
      const text = typeof v === 'string' ? v : JSON.stringify(v);
      const hit = text.match(/«[^»]{0,80}»/);
      assert.equal(hit, null, `${k} carries reader-language text: ${hit && hit[0]}`);
    }
  } finally { delete globalThis.appFont; }
});
