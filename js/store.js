// Where state lives on this device. IndexedDB rather than localStorage: a year of runs,
// days and derived results outgrows localStorage's ~5 MB, and the per-second streams are
// far bigger than that. Three stores:
//   kv       the state blob, folder handles, Drive file ids, small device-local things
//   streams  one record per activity: {id, src, channels} (see ingest.js)
//   cache    re-fetchable bulk: trail segments, POI answers
//   detail   per activity, the heavy part of what the analysis found (track points, splits,
//            every stop, every rep) -- kept out of the synced state, fetched on demand like streams
import { normalize, merge as mergeState, syncPayload, fingerprint } from './merge.js';

const DB_NAME = 'run315', STATE_KEY = 'state';
let _db = null;
function db() {
  if (_db) return _db;
  _db = new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, 2);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      for (const s of ['kv', 'streams', 'cache', 'detail']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return _db;
}
// No IndexedDB (node, the page smoke tests): a Map per store, same interface.
const _mem = {};
async function tx(store, mode, fn) {
  if (typeof indexedDB === 'undefined') {
    const m = _mem[store] || (_mem[store] = new Map());
    const s = { get: k => ({ result: m.get(k) }), put: (v, k) => { m.set(k, v); return { result: k }; },
      delete: k => { m.delete(k); return {}; }, getAllKeys: () => ({ result: [...m.keys()] }) };
    return fn(s).result;
  }
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), s = t.objectStore(store);
    const rq = fn(s);
    t.oncomplete = () => res(rq && rq.result);
    t.onerror = () => rej(t.error);
  });
}
export const idbGet = (store, k) => tx(store, 'readonly', s => s.get(k));
export const idbSet = (store, k, v) => tx(store, 'readwrite', s => s.put(v, k));
export const idbDel = (store, k) => tx(store, 'readwrite', s => s.delete(k));
export const idbKeys = store => tx(store, 'readonly', s => s.getAllKeys());

// ---- the state ----
// `state.local` is this device's own settings (cowork folder, cloud meta, UI); it never syncs.
export let state = normalize(null);
const listeners = new Set();
export const onChange = fn => { listeners.add(fn); return () => listeners.delete(fn); };

export async function loadState() {
  let saved = null;
  try { saved = await idbGet('kv', STATE_KEY); } catch (e) { console.warn('state load failed', e); }
  state = normalize(saved);
  state.local = state.local || {};
  rev++;
  return state;
}

let _saveTimer = null;
// Bumped on every save that changes data: derive.js memoises its expensive model fits on it.
export let rev = 0;
// Saves that only touch this device (state.local) or report on a sync: they persist, but do not
// count as data -- no Drive sync, no memo rebuild. Anything else is data.
const LOCAL_WHYS = new Set(['local', 'cowork', 'theme', 'ai', 'ui', 'cloud', 'cloud-meta']);
export const isDataChange = why => !LOCAL_WHYS.has(why);
// Persist (debounced) and tell everyone; `why` lets the cloud layer skip its own writes.
export function save(why = 'edit') {
  if (isDataChange(why)) rev++;
  clearTimeout(_saveTimer);
  if (_erased) return;
  _saveTimer = setTimeout(() => { idbSet('kv', STATE_KEY, state).catch(e => console.warn('state save failed', e)); }, 250);
  listeners.forEach(fn => { try { fn(why); } catch (e) { console.error(e); } });
}
// Device-local crash log: the last 30 uncaught errors, shown (and copyable) on Sync & cowork.
export function logError(e, where = '') {
  try {
    const L = state.local || (state.local = {}), list = L.errors || (L.errors = []);
    const msg = String((e && (e.message || e.reason)) || e).slice(0, 300);
    if (list[0] && list[0].msg === msg && list[0].where === where) { list[0].n = (list[0].n || 1) + 1; list[0].at = new Date().toISOString(); }
    else list.unshift({ at: new Date().toISOString(), where, route: globalThis.location ? location.hash : '', msg, stack: String((e && e.stack) || '').slice(0, 1500) });
    list.length = Math.min(list.length, 30);
    save('local');
  } catch { /* the log must never throw */ }
}
// Erase everything Run315 keeps on this device -- and only that: every app shares the
// adervec.github.io origin, so this names its own database, caches, storage keys and service
// worker rather than clearing the origin. Saves are stopped first: a pending debounced save
// would otherwise re-create the database the moment it was deleted. The Drive copy is untouched.
export const OWN_LOCAL_KEYS = key => /^run315/i.test(key);
let _erased = false;
export async function eraseDevice() {
  _erased = true; clearTimeout(_saveTimer);
  if (typeof indexedDB === 'undefined') { for (const k of Object.keys(_mem)) delete _mem[k]; }
  else {
    if (_db) { try { (await _db).close(); } catch { /* never opened */ } _db = null; }
    await new Promise(res => { const rq = indexedDB.deleteDatabase(DB_NAME); rq.onsuccess = rq.onerror = rq.onblocked = () => res(); });
  }
  if (globalThis.caches) for (const k of await caches.keys()) if (k.startsWith('run315-')) await caches.delete(k);
  try { for (const k of Object.keys(localStorage)) if (OWN_LOCAL_KEYS(k)) localStorage.removeItem(k); } catch { /* no storage */ }
  if (globalThis.navigator && navigator.serviceWorker)
    for (const r of await navigator.serviceWorker.getRegistrations()) if (/\/Run315\/$/.test(r.scope)) await r.unregister();
  state = normalize(null); state.local = {}; rev++;
}
export async function saveNow() { clearTimeout(_saveTimer); await idbSet('kv', STATE_KEY, state); }

// Fold another device's payload in, keeping this device's local settings. -> whether anything changed.
export function mergeIn(remote) {
  const before = fingerprint(state);
  const local = state.local;
  state = mergeState(state, remote);
  state.local = local;
  const changed = fingerprint(state) !== before;
  if (changed) rev++;
  return changed;
}
export const payload = () => syncPayload(state);
export function replaceState(next) { const local = state.local; state = normalize(next); state.local = local; rev++; }

// ---- streams ----
export const getStream = id => idbGet('streams', id);
export const putStream = (id, rec) => idbSet('streams', id, rec);
export const hasStream = async (id, src) => { const r = await getStream(id); return !!r && (!src || r.src === src); };
export const streamIds = () => idbKeys('streams');

// ---- detail (see the store list above) ----
export const getDetailRec = id => idbGet('detail', id);
export const putDetailRec = (id, rec) => idbSet('detail', id, rec);
