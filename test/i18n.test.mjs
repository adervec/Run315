// House standard 20: the English is the key; every language file covers the catalogue
// (locales/en.json, written by CoworkSyncHub/i18n.mjs extract) with the same {placeholders},
// and t() falls back to the English when there is no dictionary (node, or a missing entry).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { t } from '../js/ui.js';

const LANGS = ['fr', 'es', 'pt', 'it', 'hr', 'de', 'zh', 'uk', 'eo', 'sw', 'hi', 'bn', 'id', 'ur', 'fa', 'ar'];
const ph = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
const en = JSON.parse(readFileSync('locales/en.json', 'utf8'));

test('every language file has every string, with the same placeholders', () => {
  assert.ok(Object.keys(en).length > 100);
  assert.deepEqual(readdirSync('locales').filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort(), ['en', ...LANGS].sort());
  for (const l of LANGS) {
    const d = JSON.parse(readFileSync(`locales/${l}.json`, 'utf8'));
    const cats = new Intl.PluralRules(l).resolvedOptions().pluralCategories;
    for (const [k, v] of Object.entries(en)) {
      if (typeof v === 'string') { assert.equal(typeof d[k], 'string', `${l}: ${k}`); assert.equal(ph(d[k]), ph(k), `${l}: placeholders of ${k}`); }
      else for (const c of cats) assert.ok(typeof d[k]?.[c] === 'string' && d[k][c].includes('{n}'), `${l}: ${k} [${c}]`);
    }
  }
});

test('t() without a dictionary: the English, with its placeholders filled; plurals by count', () => {
  assert.equal(t('Folder: {name}', { name: 'Runs' }), 'Folder: Runs');
  assert.equal(t.n('Copy {n} error', 'Copy {n} errors', 1), 'Copy 1 error');
  assert.equal(t.n('Copy {n} error', 'Copy {n} errors', 3), 'Copy 3 errors');
  globalThis.appFont = { t: Object.assign((k, p) => (k === 'Today' ? "Aujourd'hui" : k), { n: () => 'x' }) };
  try { assert.equal(t('Today'), "Aujourd'hui"); } finally { delete globalThis.appFont; }
});
