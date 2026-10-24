// Run315 service worker. The app is static files and all data lives in IndexedDB, so the
// whole shell can be served from cache: stale-while-revalidate for our own files (instant
// open, fresh next time), and nothing cross-origin (Google, Anthropic, Overpass, tiles).
// BUILD is stamped by the deploy workflow; a new value retires the old cache.
const BUILD = '__BUILD__';
const CACHE = 'run315-' + BUILD;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', './index.html', './css/app.css', './js/main.js'])).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('run315-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const key = req.mode === 'navigate' ? './' : req;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(key);
    const fresh = fetch(req).then(res => { if (res.ok) c.put(key, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});
