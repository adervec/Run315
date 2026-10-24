// Where state lives on this device. IndexedDB rather than localStorage: a year of runs,
// days and derived results outgrows localStorage's ~5 MB, and the per-second streams are
// far bigger than that. Three stores:
//   kv       the state blob, folder handles, Drive file ids, small device-local things
//   streams  one record per activity: {id, src, channels} (see ingest.js)
//   cache    re-fetchable bulk: trail segments, POI answers
import { normalize, merge as mergeState, syncPayload } from './merge.js';

const DB_NAME = 'run315', STATE_KEY = 'state';
let _db = null;
function db() {
  if (_db) return _db;
  _db = new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      for (const s of ['kv', 'streams', 'cache']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return _db;
}
async function tx(store, mode, fn) {
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
// Bumped on every save: derive.js memoises its expensive model fits on it.
export let rev = 0;
// Persist (debounced) and tell everyone; `why` lets the cloud layer skip its own writes.
export function save(why = 'edit') {
  rev++;
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { idbSet('kv', STATE_KEY, state).catch(e => console.warn('state save failed', e)); }, 250);
  listeners.forEach(fn => { try { fn(why); } catch (e) { console.error(e); } });
}
export async function saveNow() { clearTimeout(_saveTimer); await idbSet('kv', STATE_KEY, state); }

// Fold another device's payload in, keeping this device's local settings.
export function mergeIn(remote) {
  const local = state.local;
  state = mergeState(state, remote);
  state.local = local;
  rev++;
}
export const payload = () => syncPayload(state);
export function replaceState(next) { const local = state.local; state = normalize(next); state.local = local; rev++; }

// ---- streams ----
export const getStream = id => idbGet('streams', id);
export const putStream = (id, rec) => idbSet('streams', id, rec);
export const hasStream = async (id, src) => { const r = await getStream(id); return !!r && (!src || r.src === src); };
export const streamIds = () => idbKeys('streams');
