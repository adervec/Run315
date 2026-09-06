// Run315 service worker. Rendered by Flask so the paths follow the mount
// point -- the static demo lives under /Run315/, a real install under /.
//
// Pages are network-first: this app shows your data, and a stale dashboard is
// worse than a spinner. The cache is only there for the tunnel and the plane.
// Static assets are cache-first, because they change when V changes.
const V = 'run315-v1';
const PAGES = V + '-pages';
const ASSETS = V + '-assets';
const HOME = '/Run315/';
const SHELL = [
  HOME,
  '/Run315/static/style.css',
  '/Run315/static/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(ASSETS).then((c) => c.addAll(SHELL))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(
      keys.filter((k) => !k.startsWith(V)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;

  // Anything that writes -- sync, logout, adding a race -- makes every cached
  // page wrong, so drop them and let the request go to the network untouched.
  // This is also what signs you out of the offline copy.
  if (req.method !== 'GET') { caches.delete(PAGES); return; }

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // map tiles, BRouter

  if (url.pathname.includes('/static/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(ASSETS).then((c) => c.put(req, copy));
      return res;
    })));
    return;
  }

  e.respondWith(fetch(req).then((res) => {
    // A redirect cannot be replayed from cache to a navigation -- the
    // browser rejects it as a network error -- so do not store one.
    if (res.ok && res.type === 'basic' && !res.redirected) {
      const copy = res.clone();
      caches.open(PAGES).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req)
    .then((hit) => hit || caches.match(HOME))
    .then((hit) => hit || new Response(
      '<h1>Offline</h1><p>Run315 has not cached this page yet.</p>',
      {headers: {'Content-Type': 'text/html'}, status: 503}))));
});