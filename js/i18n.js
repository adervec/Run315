// Languages (house standard 20). Write English straight into the code: t('Saved {n} runs', { n }),
// t.n('{n} run', '{n} runs', count). The English is the key; font.js holds the chosen language's
// dictionary (locales/<lang>.json, machine translated, and the app says so). Without font.js (node,
// the tests) the English comes back as written. No imports, so the analysis modules can use it.
//
// Two kinds of text must stay English whatever the reader picked, and go through english():
//   - what is STORED in the synced state (a derived verdict): it is data, read on every device;
//     a page re-words it at display time from the stored numbers instead;
//   - what an AI agent reads (BRIEF.md, brief.json, cowork requests, the Ask/coach prompts).
const interp = (s, p) => (p ? String(s).replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(p, k) ? String(p[k]) : m)) : String(s));
let _english = 0;
const AF = () => (_english ? null : globalThis.appFont && globalThis.appFont.t ? globalThis.appFont : null);

export const t = (key, params) => (AF() ? AF().t(key, params) : interp(key, params));
t.n = (one, other, n, params) => (AF() && AF().t.n ? AF().t.n(one, other, n, params) : interp(n === 1 ? one : other, { n, ...params }));

// Run fn with every t() answering in English. Synchronous on purpose: an await inside would let
// a page render in English meanwhile, so async callers wrap each synchronous step instead.
export function english(fn) {
  _english++;
  try { return fn(); } finally { _english--; }
}
// The reader's formatting (dates, numbers) through font.js, or null for the caller's fallback.
export const fmt = () => (!_english && globalThis.appFont && globalThis.appFont.fmt) || null;
