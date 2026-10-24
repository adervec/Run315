// Google Drive sync, in the app's private appDataFolder -- GymTracker's backend, same
// OAuth client, same rules: the access token lives in memory only, the folder is
// invisible in the user's Drive, and the app never sees any other file.
//
// Two kinds of file:
//   run315-state.json      the synced state (merge.js); read-merge-write on every push
//   stream-<id>.json       one per activity, written once by the device that imported
//                          it (the desktop), fetched on demand by the others (the phone)
import { state, save, mergeIn, payload, idbGet, idbSet, getStream, putStream } from './store.js';

const CLIENT_ID = '547617739897-br6dj2facmsc34qnkjb5u4dbfhju39pu.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata openid https://www.googleapis.com/auth/userinfo.profile';
const STATE_FILE = 'run315-state.json';
const GIS = 'https://accounts.google.com/gsi/client';
// The client id only works from origins registered with Google; refuse elsewhere rather than
// show a consent screen that will fail.
const ORIGINS = ['https://adervec.github.io'];
const API = 'https://www.googleapis.com/drive/v3/files', UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

export function originAllowed() {
  if (typeof location === 'undefined') return false;
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || ORIGINS.includes(location.origin);
}
const meta = () => (state.local.cloud = state.local.cloud || {});
export const driveOn = () => !!meta().enabled;

let _token = null, _client = null, _gis = null;
function loadGis() {
  if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
  return _gis || (_gis = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = GIS; s.async = true;
    s.onload = res; s.onerror = () => { _gis = null; rej(new Error('Google sign-in did not load')); };
    document.head.appendChild(s);
  }));
}
async function token(force) {
  if (!force && _token && _token.exp > Date.now() + 60000) return _token.value;
  await loadGis();
  if (!_client) _client = google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPE, callback: () => {} });
  return new Promise((res, rej) => {
    _client.callback = r => r && r.access_token
      ? (_token = { value: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 }, res(r.access_token))
      : rej(new Error((r && r.error) || 'authorisation failed'));
    _client.error_callback = e => rej(new Error((e && (e.type || e.message)) || 'authorisation error'));
    // prompt '' is silent when a grant and a Google session exist; a popup otherwise.
    try { _client.requestAccessToken({ prompt: '' }); } catch (e) { rej(e); }
  });
}
// fetch with the bearer token, retrying once on an expired one.
async function gfetch(url, opts = {}) {
  const go = async force => fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + (await token(force)) } });
  let r = await go(false);
  if (r.status === 401) r = await go(true);
  return r;
}

// name -> file id, cached in IndexedDB so a reload does not re-list.
async function fileId(name, create) {
  const ids = (await idbGet('kv', 'driveIds')) || {};
  if (ids[name]) return ids[name];
  const q = encodeURIComponent(`name='${name}' and trashed=false`);
  const r = await gfetch(`${API}?spaces=appDataFolder&fields=files(id,name)&q=${q}`);
  if (!r.ok) throw new Error('Drive list ' + r.status);
  let id = ((await r.json()).files || [])[0]?.id;
  if (!id && create) {
    const b = 'run315boundary';
    const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: ['appDataFolder'] })}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n{}\r\n--${b}--`;
    const c = await gfetch(`${UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body });
    if (!c.ok) throw new Error('Drive create ' + c.status);
    id = (await c.json()).id;
  }
  if (id) { ids[name] = id; await idbSet('kv', 'driveIds', ids); }
  return id || null;
}
async function forget(name) { const ids = (await idbGet('kv', 'driveIds')) || {}; delete ids[name]; await idbSet('kv', 'driveIds', ids); }
async function readJson(name) {
  const id = await fileId(name, false);
  if (!id) return null;
  const r = await gfetch(`${API}/${id}?alt=media`);
  if (r.status === 404) { await forget(name); return null; }
  if (!r.ok) throw new Error('Drive read ' + r.status);
  const t = await r.text();
  try { return t ? JSON.parse(t) : null; } catch { return null; }
}
async function writeJson(name, obj) {
  const id = await fileId(name, true);
  const r = await gfetch(`${UPLOAD}/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  if (r.status === 404) { await forget(name); return writeJson(name, obj); }
  if (!r.ok) throw new Error('Drive write ' + r.status);
}

// Another app's file in the shared appDataFolder (same OAuth client), read-only. GymTracker's
// gymtracker-state.json is the one Run315 reads; it never writes there.
export async function readAppFile(name) { return driveOn() ? readJson(name) : null; }

let _busy = false;
function stamp(patch) { Object.assign(meta(), patch); save('cloud-meta'); }

// Pull, merge, push. One function, because a push is never safe without the pull before it.
export async function sync() {
  if (!driveOn() || _busy) return false;
  _busy = true;
  try {
    const remote = await readJson(STATE_FILE);
    if (remote) mergeIn(remote);
    await writeJson(STATE_FILE, payload());
    await pushStreams();
    stamp({ lastSync: new Date().toISOString(), lastError: null });
    save('cloud');
    return true;
  } catch (e) {
    stamp({ lastError: e.message || String(e) });
    return false;
  } finally { _busy = false; }
}

// Streams this device imported and has not uploaded yet.
export async function queueStream(id) {
  const q = new Set((await idbGet('kv', 'streamQueue')) || []); q.add(id); await idbSet('kv', 'streamQueue', [...q]);
}
async function pushStreams(limit = 25) {
  const q = (await idbGet('kv', 'streamQueue')) || [];
  const left = [...q];
  for (const id of q.slice(0, limit)) {
    const rec = await getStream(id);
    if (rec) await writeJson(`stream-${id}.json`, rec);
    left.splice(left.indexOf(id), 1);
    await idbSet('kv', 'streamQueue', left);
  }
  return left.length;
}
// The stream for one activity: local first, then Drive (and keep it).
export async function fetchStream(id) {
  const local = await getStream(id);
  if (local || !driveOn()) return local || null;
  try {
    const rec = await readJson(`stream-${id}.json`);
    if (rec && rec.channels) { await putStream(id, rec); return rec; }
  } catch (e) { console.warn('stream fetch failed', id, e); }
  return null;
}

export async function connect() {
  if (!originAllowed()) throw new Error('Google Drive sync only works on adervec.github.io (or localhost).');
  await token(true);
  stamp({ enabled: true, lastError: null });
  try {
    const r = await gfetch('https://www.googleapis.com/oauth2/v3/userinfo');
    if (r.ok) { const u = await r.json(); stamp({ account: { name: u.name, picture: u.picture } }); }
  } catch { /* the name is a nicety */ }
  return sync();
}
export function disconnect() { _token = null; stamp({ enabled: false, account: null }); }

// Push soon after an edit; pull on focus and every few minutes.
let _timer = null;
export function startAutoSync(everyMin = 5) {
  let debounce = null;
  const soon = () => { clearTimeout(debounce); debounce = setTimeout(() => sync(), 2000); };
  import('./store.js').then(s => s.onChange(why => { if (driveOn() && !String(why).startsWith('cloud')) soon(); }));
  addEventListener('focus', () => { if (driveOn()) sync(); });
  clearInterval(_timer);
  _timer = setInterval(() => { if (driveOn() && document.visibilityState === 'visible') sync(); }, everyMin * 60000);
  if (driveOn()) sync();
}
