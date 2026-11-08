// Run315 service worker. The app is static files and all data lives in IndexedDB, so the
// shell works offline from cache. Network first for our own files, cache only when offline:
// stale-while-revalidate refreshed modules one at a time, so after a deploy a fresh module could
// import a name its stale cached neighbour did not export yet -- a blank page until a reload.
// Nothing cross-origin is touched (Google, Anthropic, Overpass, tiles).
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
    try {
      const res = await fetch(req, { cache: 'no-cache' });   // revalidate: Pages lets browsers keep files 10 min
      if (res.ok) c.put(key, res.clone());
      return res;
    } catch (err) { return (await c.match(key)) || Promise.reject(err); }
  }));
});
