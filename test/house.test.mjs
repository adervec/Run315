// House standards: no third-party script/style/font hosts, and "Erase everything" removes
// Run315's own data and nothing that belongs to the other apps on the shared origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const walk = d => readdirSync(d).flatMap(f => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const CDN = /fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|cdn\.skypack/;

test('no third-party code, styles or fonts: libraries are vendored', () => {
  const files = ['index.html', 'sw.js', ...walk('css'), ...walk('js'), ...walk('static/vendor')].filter(f => /\.(html|js|mjs|css)$/.test(f));
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), CDN, f);
  for (const f of ['leaflet/leaflet.js', 'leaflet/leaflet.css', 'leaflet/images/marker-icon.png', 'sql.js/sql-wasm.js', 'sql.js/sql-wasm.wasm', 'anthropic-sdk/anthropic-ai_sdk_0.132.1.mjs'])
    assert.ok(existsSync('static/vendor/' + f), f);
  // Every relative import inside the vendored SDK resolves to a file that is there.
  for (const f of walk('static/vendor/anthropic-sdk'))
    for (const [, dep] of readFileSync(f, 'utf8').matchAll(/["'](\.\/[^"']+\.mjs)["']/g)) assert.ok(existsSync(join('static/vendor/anthropic-sdk', dep)), f + ' -> ' + dep);
});

test('erase removes only Run315 data, stops saves, and the Drive copy is left alone', async () => {
  const ls = new Map([['run315-portal-seen', '[1]'], ['maker-font', 'serif'], ['portal-activity', '[]'], ['gymtracker-x', '1']]);
  globalThis.localStorage = { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, v), removeItem: k => ls.delete(k) };
  Object.defineProperty(globalThis.localStorage, 'keys', { enumerable: false, value: null });
  for (const k of ls.keys()) Object.defineProperty(globalThis.localStorage, k, { enumerable: true, configurable: true, get: () => ls.get(k) });
  const deleted = [];
  globalThis.caches = { keys: async () => ['run315-abc', 'tachyread-1'], delete: async k => deleted.push(k) };
  const S = await import('../js/store.js');
  await S.loadState();
  S.state.activities.a = { id: 'a', u: '1' }; S.save('edit');
  await S.eraseDevice();
  assert.deepEqual(Object.keys(S.state.activities), []);
  assert.deepEqual(deleted, ['run315-abc']);
  assert.deepEqual([...ls.keys()].sort(), ['gymtracker-x', 'maker-font', 'portal-activity']);
  S.state.activities.b = { id: 'b' }; S.save('edit');           // a late save must not bring anything back
  await new Promise(r => setTimeout(r, 400));
  assert.equal(await S.idbGet('kv', 'state'), undefined);
  const src = readFileSync('js/pages/sync.js', 'utf8');
  assert.match(src, /drive\.disconnect\(\);\s*busy\(b, async \(\) => \{ await eraseDevice\(\)/);
  assert.match(src, /copy in your Google Drive is not touched/);
  assert.doesNotMatch(readFileSync('js/store.js', 'utf8'), /localStorage\.clear\(\)/);
});
