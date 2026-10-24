/* Run315 route planner -- ported from the standalone RouteMaster tool, then from
   Run315's Flask page to the browser app. Three things changed on the way in, and all
   are load-bearing:
   saved routes live in state.routes (synced through Drive, so the phone has them too);
   the POI layers ask Overpass directly, with the mirror failover, retry and cache the
   server used to add; and every string that came from a person or a third-party API
   reaches the DOM through textContent, never through interpolated markup.

   routeMaker(root) wires the markup js/pages/routes.js renders and returns a destroy()
   that takes the map down. The trails and territory pages borrow loadLeaflet(),
   whenGone() and overpass() from here. */
import { state, save, idbGet, idbSet } from './store.js';
import { put, remove } from './merge.js';
import * as POI from './lib/pois.js';

// ---------- Leaflet, loaded once, lazily, by whichever map page gets there first ----------
const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet';
let _leaflet = null;
export function loadLeaflet() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.L) return Promise.resolve(window.L);
  if (_leaflet) return _leaflet;
  if (!document.querySelector(`link[href="${LEAFLET}.css"]`)) {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = LEAFLET + '.css';
    document.head.appendChild(css);
  }
  _leaflet = new Promise((res, rej) => {
    // Another page may have started the same script; wait on it instead of adding a second.
    let s = document.querySelector(`script[src="${LEAFLET}.js"]`);
    if (!s) { s = document.createElement('script'); s.src = LEAFLET + '.js'; document.head.appendChild(s); }
    s.addEventListener('load', () => (window.L ? res(window.L) : rej(new Error('Leaflet unavailable'))));
    s.addEventListener('error', () => { _leaflet = null; rej(new Error('The map library did not load. Check your connection and reload.')); });
  });
  return _leaflet;
}

// Call fn once `node` leaves the document. The router swaps #page's innerHTML on every
// navigation, and a page re-renders itself the same way, so watching the page host's
// children catches both -- a Leaflet map left behind keeps its window listeners forever.
export function whenGone(node, fn) {
  const host = node.closest('#page') || node.parentElement || document.body;
  let done = false;
  const fire = () => { if (done || node.isConnected) return; done = true; obs.disconnect(); removeEventListener('hashchange', late); fn(); };
  const obs = new MutationObserver(fire);
  // childList only, no subtree: Leaflet churns tiles and markers inside the page constantly.
  obs.observe(host, { childList: true });
  // Belt and braces: a navigation that somehow skips the swap still lands here.
  const late = () => setTimeout(fire, 0);
  addEventListener('hashchange', late);
  return () => { done = true; obs.disconnect(); removeEventListener('hashchange', late); };
}

// A theme token's current value, for things Leaflet paints itself (lines, rectangles).
export const token = (name, fallback) =>
  (typeof document !== 'undefined' && getComputedStyle(document.documentElement).getPropertyValue(name).trim()) || fallback;

// ---------- Overpass, straight from the browser ----------
// What app.py's overpass() did: each mirror in turn, two attempts each -- these servers
// shed load with 429s and 504s constantly and a plain retry usually lands.
// ponytail: sequential, not raced -- racing would double the load on free volunteer servers.
export const OVERPASS_MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OVERPASS_ATTEMPTS = 2, OVERPASS_BACKOFF_MS = 2500, OVERPASS_TIMEOUT_MS = 90000;
export async function overpass(query) {
  let last = null, empty = null;
  for (const mirror of OVERPASS_MIRRORS) {
    for (let attempt = 0; attempt < OVERPASS_ATTEMPTS; attempt++) {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), OVERPASS_TIMEOUT_MS);
      try {
        const res = await fetch(mirror, { method: 'POST', body: new URLSearchParams({ data: query }), signal: ctl.signal });
        if (!res.ok) throw new Error(`${new URL(mirror).host} said HTTP ${res.status}`);
        const data = await res.json();
        if (data.elements && data.elements.length) return data;
        // A regional mirror answering 200 with nothing is suspect, not empty -- ask the next.
        empty = data; last = `${new URL(mirror).host} returned no elements`;
      } catch (e) {
        last = e.name === 'AbortError' ? `${new URL(mirror).host} timed out` : e.message;
      } finally { clearTimeout(timer); }
      if (attempt + 1 < OVERPASS_ATTEMPTS) await new Promise(r => setTimeout(r, OVERPASS_BACKOFF_MS * (attempt + 1)));
    }
  }
  // Every mirror agreed there is nothing there: that is an answer, not an outage.
  if (empty) return empty;
  throw new Error(`Overpass is busy right now (${last}). Try again in a minute.`);
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// /api/pois, in the browser: thin the route, one union query for every ticked layer,
// cached by the query's hash for a week so toggling a layer off and on is free.
const POI_CACHE_DAYS = 7;
let _poiChain = Promise.resolve();   // one Overpass question at a time, as the server's per-user lock did
export async function findPois(points, layers, freeOnly) {
  const pts = POI.thin(points || []);
  const wanted = (layers || []).filter(x => x in POI.BY_ID);
  if (pts.length < 2) throw new Error('Draw a route first.');
  if (!wanted.length) return { pois: [], cached: false };
  const query = POI.buildQuery(pts, wanted);
  if (!query) throw new Error('Nothing to look for.');
  const key = 'poi-' + await sha256(query);
  const fresh = Date.now() - POI_CACHE_DAYS * 864e5;
  const cached = async () => { try { const h = await idbGet('cache', key); return h && h.fetched_at >= fresh ? h.data : null; } catch { return null; } };
  const hit = await cached();
  if (hit) return { pois: POI.parse(hit, wanted, freeOnly), cached: true };
  const run = _poiChain.then(async () => {
    // Another request may have filled the cache while this one waited its turn.
    const again = await cached();
    if (again) return { data: again, cached: true };
    const data = await overpass(query);
    idbSet('cache', key, { fetched_at: Date.now(), data }).catch(() => {});
    return { data, cached: false };
  });
  _poiChain = run.catch(() => {});
  const { data, cached: c } = await run;
  return { pois: POI.parse(data, wanted, freeOnly), cached: c };
}

// ---------- saved routes: state.routes, with the server's validation ----------
// These are the only values BRouter and the UI accept; anything else is a bug.
export const ROUTE_PROFILES = new Set(['trekking', 'fastbike', 'mtb', 'hiking-mountain', 'shortest']);
export const ROUTE_TYPES = new Set(['p2p', 'loop', 'outback']);
export const MAX_WAYPOINTS = 50;

// Waypoints as stored: 1-50 of {lat, lon} rounded to 6 dp. null if they are junk.
export function cleanWaypoints(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_WAYPOINTS) return null;
  const out = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') return null;
    const lat = Number(p.lat), lon = Number(p.lon);
    if (p.lat == null || p.lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) return null;
    out.push({ lat: +lat.toFixed(6), lon: +lon.toFixed(6) });
  }
  return out;
}
export const savedRoutes = (st = state) => Object.values(st.routes).sort((a, b) => String(a.name).localeCompare(String(b.name)));

// Upsert by name, as the server's ON CONFLICT(user_id, name) did. -> the id; throws with
// the server's wording when the route will not do.
export function saveRoute(st, { name, profile, rtype, pts }) {
  name = String(name || '').trim().slice(0, 120);
  const clean = cleanWaypoints(pts);
  if (!name) throw new Error('Give the route a name.');
  if (!ROUTE_PROFILES.has(profile) || !ROUTE_TYPES.has(rtype)) throw new Error('Unknown routing profile or route type.');
  if (!clean) throw new Error('That route has no usable waypoints.');
  const have = Object.values(st.routes).find(r => r.name === name);
  const id = have ? have.id : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  put(st, 'routes', id, { id, name, profile, rtype, pts: clean, created_at: have?.created_at || new Date().toISOString() });
  return id;
}
export function deleteRoute(st, id) {
  if (!st.routes[id]) throw new Error('That route is already gone.');
  remove(st, 'routes', id);
}

// ---------- the planner ----------
// The draft survives a re-render (a Drive sync redraws the page): waypoints, shape, name, view.
let draft = null;

// Nine visually distinct colours cycled across waypoints and their outgoing segments.
// (The original repeated #f58231 at 3 and 6, so two segments read as one.) These are a
// categorical map palette, not theme colours: they must stay apart on OSM tiles in either theme.
const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
                 '#008080', '#f032e6', '#9a6324', '#800000'];
const colorOf = i => PALETTE[i % PALETTE.length];

export function routeMaker(root, L) {
  const $ = id => root.querySelector('#' + id);
  let alive = true;

  // --- status lines: one owner each, so a slow POI search cannot wipe a routing error ---
  function status(id, msg, isError) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('is-error', !!isError);
  }
  const mapStatus = (m, e) => status('mapstatus', m, e);
  const poiStatus = (m, e) => status('poistatus', m, e);
  const libStatus = (m, e) => status('libstatus', m, e);

  // --- map ---
  const map = L.map($('map')).setView([47.37, 8.54], 13); // Zurich; geolocates below
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  // --- state ---
  const pts = [];            // control points: {lat, lon, marker}
  let routeLayer = null;     // layerGroup of coloured segments + arrows
  let routeCoords = [];      // [{lat,lon,ele}] of the full routed line
  let lastKm = 0;
  let routeSeq = 0;          // guards against a slow reply painting over a newer edit
  let routeErrored = false;  // so a good route only clears a message routing itself put up

  // Only recentre if the user has not already started planning somewhere else.
  if (!draft) navigator.geolocation?.getCurrentPosition(
    p => { if (alive && !pts.length) map.setView([p.coords.latitude, p.coords.longitude], 14); },
    () => {});

  map.on('click', e => addPoint(e.latlng.lat, e.latlng.lng));

  // --- waypoints ---
  function makePoint(lat, lon) {
    // Icon is set at construction so Leaflet never reaches for its default pin PNG.
    const m = L.marker([lat, lon], { draggable: true, icon: wpIcon(pts.length) }).addTo(map);
    const p = { lat, lon, marker: m };
    m.on('drag', ev => { p.lat = ev.latlng.lat; p.lon = ev.latlng.lng; });
    m.on('dragend', () => { renderWaypoints(); route(); });
    return p;
  }
  function addPoint(lat, lon) { pts.push(makePoint(lat, lon)); renderWaypoints(); route(); }
  function setPoints(arr) {     // replace all; caller triggers route()
    pts.forEach(p => map.removeLayer(p.marker));
    pts.length = 0;
    arr.forEach(a => pts.push(makePoint(a.lat, a.lon)));
    renderWaypoints();
  }
  function wpIcon(i) {
    // Interpolated values here are an index and a palette constant -- never user input.
    return L.divIcon({
      className: '', iconSize: [26, 26], iconAnchor: [13, 26],
      html: `<div class="wp-pin" style="background:${colorOf(i)}"><span>${i + 1}</span></div>`,
    });
  }
  const WP_ACTIONS = [['up', '↑', 'Move up'], ['down', '↓', 'Move down'], ['del', '×', 'Delete']];
  function renderWaypoints() {
    const list = $('wplist');
    list.textContent = '';
    $('wpempty').style.display = pts.length ? 'none' : '';
    pts.forEach((p, i) => {
      p.marker.setIcon(wpIcon(i));
      const row = document.createElement('div');
      row.className = 'wp-row';

      const badge = document.createElement('span');
      badge.className = 'wp-badge';
      badge.style.background = colorOf(i);
      badge.textContent = i + 1;

      const co = document.createElement('span');
      co.className = 'wp-co';
      co.textContent = `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
      row.append(badge, co);

      for (const [act, glyph, label] of WP_ACTIONS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'wp-btn';
        b.textContent = glyph;
        b.title = `${label} waypoint ${i + 1}`;
        // Listener rather than an inline onclick: no id ever gets spliced into markup.
        b.addEventListener('click', () => moveWaypoint(i, act));
        row.append(b);
      }
      list.append(row);
    });
  }
  function moveWaypoint(i, act) {
    if (act === 'del') { map.removeLayer(pts[i].marker); pts.splice(i, 1); }
    if (act === 'up' && i > 0)                [pts[i - 1], pts[i]] = [pts[i], pts[i - 1]];
    if (act === 'down' && i < pts.length - 1) [pts[i + 1], pts[i]] = [pts[i], pts[i + 1]];
    renderWaypoints();
    route();
  }
  function fitPts() {
    if (pts.length) map.fitBounds(pts.map(p => [p.lat, p.lon]), { padding: [40, 40], maxZoom: 15 });
  }

  $('undo').onclick = () => {
    const p = pts.pop();
    if (p) { map.removeLayer(p.marker); renderWaypoints(); route(); }
  };
  $('clear').onclick   = () => { setPoints([]); route(); };
  $('reverse').onclick = () => { setPoints([...pts].reverse()); route(); };
  $('profile').onchange = route;
  $('rtype').onchange   = route;
  $('autoloop').onclick = autoLoop;

  // --- routing: one BRouter request, split into coloured segments by waypoint ---
  function stops() {
    const s = pts.map(p => ({ lat: p.lat, lon: p.lon }));
    const t = $('rtype').value;
    if (t === 'loop' && s.length > 1) s.push(s[0]);
    if (t === 'outback' && s.length > 1) s.push(...s.slice(0, -1).reverse());
    return s;
  }
  async function route() {
    const seq = ++routeSeq;
    routeLayer?.remove();
    routeLayer = null;
    routeCoords = [];
    const s = stops();
    if (s.length < 2) { setStats(0, 0); drawElev(); clearRouteError(); return; }
    const profile = $('profile').value;
    const lonlats = s.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
    const url = `https://brouter.de/brouter?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=gpx`;
    try {
      const res = await fetch(url);
      const body = await res.text();
      if (seq !== routeSeq || !alive) return;   // a newer edit already fired; drop this answer
      if (!res.ok) throw new Error(body.slice(0, 200) || `BRouter ${res.status}`);
      routeCoords = parseGpx(body);
      const idx = splitByStops(routeCoords, s);     // route index nearest each stop
      routeLayer = L.layerGroup().addTo(map);
      for (let i = 0; i < s.length - 1; i++) {
        const seg = routeCoords.slice(idx[i], idx[i + 1] + 1);
        if (seg.length < 2) continue;
        const col = colorOf(i);                     // segment shares its start waypoint's colour
        L.polyline(seg.map(c => [c.lat, c.lon]), { color: col, weight: 6, interactive: false }).addTo(routeLayer);
        addArrows(seg, col, routeLayer);
      }
      setStats(distanceKm(routeCoords), climbM(routeCoords));
      drawElev();
      if (activeLayers.size) refreshPoisSoon(700);  // layers follow the route they annotate
      clearRouteError();
    } catch (err) {
      if (seq !== routeSeq || !alive) return;
      setStats(0, 0);
      drawElev();
      // ponytail: no retry/queue; brouter.de is the SPOF. Surface it and let the user re-try.
      mapStatus(`Routing failed: ${err.message}`, true);
      routeErrored = true;
    }
  }
  function clearRouteError() {
    if (routeErrored) { mapStatus(''); routeErrored = false; }
  }
  function addArrows(seg, color, layer) {            // direction markers every ~300 m
    let acc = 0;
    for (let i = 1; i < seg.length; i++) {
      acc += haversine(seg[i - 1], seg[i]);
      if (acc >= 300) {
        acc = 0;
        const ang = bearing(seg[i - 1], seg[i]);
        L.marker([seg[i].lat, seg[i].lon], {
          interactive: false,
          icon: L.divIcon({
            className: '', iconSize: [16, 16], iconAnchor: [8, 8],
            html: `<div class="wp-arrow" style="transform:rotate(${ang - 90}deg);color:${color}">➤</div>`,
          }),
        }).addTo(layer);
      }
    }
  }

  // --- auto-loop: ring of points, scale radius to hit target distance ---
  async function autoLoop() {
    if (!pts.length) return mapStatus('Click a start point on the map first.', true);
    const target = +$('target').value * 1000;
    if (!(target > 0)) return mapStatus('Enter a target distance in km.', true);
    const start = { lat: pts[0].lat, lon: pts[0].lon };
    $('rtype').value = 'loop';
    let r = target / (2 * Math.PI);
    const base = Math.random() * 360;
    for (let iter = 0; iter < 4; iter++) {           // ponytail: 4 tries; converges in 2-3
      const ring = [start];
      for (let i = 0; i < 5; i++) ring.push(destPoint(start.lat, start.lon, base + i * 72, r));
      setPoints(ring);
      await route();
      if (!alive || !lastKm) break;
      if (Math.abs(lastKm * 1000 - target) / target < 0.08) break;
      r *= target / (lastKm * 1000);
    }
    if (!alive) return;
    fitPts();
    if (lastKm) mapStatus(`Loop fitted to ${lastKm.toFixed(2)} km.`);
  }

  // --- POI layers, asked of Overpass directly (findPois above) ---
  // The server used to add mirror failover, a retry and a cache -- Overpass is donated
  // infrastructure and deserves all three, so findPois keeps them.
  const activeLayers = new Set(draft?.layers || []);
  let poiGroup = null;                       // one Leaflet group for every pin
  let poiFound = [];                         // raw results, so GPX export can name them
  let poiSeq = 0;                            // guards against an out-of-order reply
  let poiTimer = null;

  // Ticking five boxes should be one question, not five. Without this each toggle
  // fires its own Overpass query and they arrive on top of each other -- which is
  // both rude to a donated service and slower for the user, because the server
  // starts refusing connections.
  function refreshPoisSoon(delay = 350) {
    clearTimeout(poiTimer);
    poiTimer = setTimeout(refreshPois, delay);
  }

  function loadPoiCatalogue() {
    const host = $('layers');
    host.textContent = '';
    for (const [name, layers] of POI.groups()) {
      const head = document.createElement('p');
      head.className = 'layer-group';
      head.textContent = name;
      host.appendChild(head);

      const row = document.createElement('div');
      row.className = 'chips';
      layers.forEach(layer => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.dataset.layer = layer.id;
        const on0 = activeLayers.has(layer.id);
        chip.classList.toggle('on', on0);
        chip.setAttribute('aria-pressed', String(on0));
        chip.textContent = layer.icon + ' ' + layer.label;
        chip.addEventListener('click', () => {
          const on = !activeLayers.has(layer.id);
          if (on) activeLayers.add(layer.id); else activeLayers.delete(layer.id);
          chip.classList.toggle('on', on);
          chip.setAttribute('aria-pressed', String(on));
          refreshPoisSoon();
        });
        row.appendChild(chip);
      });
      host.appendChild(row);
    }
  }

  $('freeonly').addEventListener('change', () => refreshPoisSoon());

  async function refreshPois() {
    if (!alive) return;
    poiGroup?.remove();
    poiGroup = null;
    poiFound = [];
    if (!activeLayers.size) { poiStatus(''); return; }
    if (routeCoords.length < 2) { poiStatus('Draw a route first, then pick layers.', true); return; }

    clearTimeout(poiTimer);
    const mine = ++poiSeq;
    poiStatus('Looking along the route…');
    let data;
    try {
      data = await findPois(routeCoords.map(c => [c.lat, c.lon]), [...activeLayers], $('freeonly').checked);
    } catch (err) {
      if (alive && mine === poiSeq) poiStatus(err.message, true);
      return;
    }
    if (!alive || mine !== poiSeq) return;   // a newer request already answered

    poiFound = data.pois || [];
    const g = L.layerGroup().addTo(map);
    poiFound.forEach(poi => {
      const pin = L.divIcon({ className: '', iconSize: [22, 22],
                              html: `<div class="poi-pin">${poi.icon}</div>` });
      L.marker([poi.lat, poi.lon], { icon: pin }).bindPopup(poiPopup(poi)).addTo(g);
    });
    poiGroup = g;
    poiStatus(poiFound.length
      ? `${poiFound.length} found along the route${data.cached ? ' (cached)' : ''}`
      : 'Nothing of those kinds near this route.');
  }

  function poiPopup(poi) {
    // Every string here is arbitrary text edited by strangers on OSM. Build the
    // popup out of nodes so none of it can ever become markup.
    const box = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = poi.icon + ' ' + poi.name;
    box.appendChild(name);
    if (poi.free === true) box.appendChild(poiTag('free', 'poi-free'));
    else if (poi.free === false) box.appendChild(poiTag('costs money', 'poi-paid'));
    else if (poi.fee_matters) box.appendChild(poiTag('fee unknown', 'poi-unknown'));
    [poi.hours, poi.wheelchair === 'yes' ? 'step-free' : null].forEach(line => {
      if (!line) return;
      const el = document.createElement('div');
      el.className = 'poi-meta';
      el.textContent = line;
      box.appendChild(el);
    });
    return box;
  }

  function poiTag(text, cls) {
    const el = document.createElement('span');
    el.className = 'poi-tag ' + cls;
    el.textContent = text;
    return el;
  }

  loadPoiCatalogue();

  // --- saved routes: state.routes, one library that follows the athlete across devices ---
  // The standalone tool kept these in localStorage, the Flask app on the server. Same
  // verbs, now on the synced state: list, upsert by name, delete.
  let library = [];   // [{id, name, profile, rtype, pts}]

  function refreshLibrary(selectId) {
    library = savedRoutes();
    renderLibrary(selectId);
  }
  function renderLibrary(selectId) {
    const sel = $('rlist');
    sel.textContent = '';
    if (!library.length) {
      const o = document.createElement('option');
      o.value = '';
      o.disabled = true;
      o.textContent = '— no saved routes —';
      sel.append(o);
      return;
    }
    for (const r of library) {
      const o = document.createElement('option');
      o.value = String(r.id);
      o.textContent = r.name;   // route names are user input and synced storage
      if (String(r.id) === String(selectId)) o.selected = true;
      sel.append(o);
    }
  }
  const selected = () => library.find(r => String(r.id) === String($('rlist').value));

  function store(name, profile, rtype, points, okMsg) {
    try {
      const id = saveRoute(state, { name, profile, rtype, pts: points });
      save('edit');
      refreshLibrary(id);
      libStatus(okMsg);
      return id;
    } catch (err) {
      libStatus(`Save failed: ${err.message}`, true);
      return null;
    }
  }
  function applyRoute(r) {
    $('profile').value = r.profile || 'trekking';
    $('rtype').value = r.rtype || 'p2p';
    setPoints(r.pts || []);
    route();
    fitPts();
  }

  // ponytail: confirm()/prompt() for intent, status lines for outcomes. A modal of our
  // own is the upgrade path, but it buys nothing until these get more than one field.
  $('save').onclick = () => {
    const name = $('rname').value.trim();
    if (!name) return libStatus('Name the route first.', true);
    if (!pts.length) return libStatus('Add some points first.', true);
    if (library.some(r => r.name === name) && !confirm(`Overwrite "${name}"?`)) return;
    store(name, $('profile').value, $('rtype').value,
          pts.map(p => ({ lat: p.lat, lon: p.lon })), `Saved "${name}".`);
  };
  $('load').onclick = () => {
    const r = selected();
    if (!r) return libStatus('Pick a saved route first.', true);
    applyRoute(r);
    $('rname').value = r.name;
    libStatus(`Opened "${r.name}".`);
  };
  $('dup').onclick = () => {
    const r = selected();
    if (!r) return libStatus('Pick a saved route first.', true);
    let c = r.name + ' copy';
    while (library.some(x => x.name === c)) c += ' copy';   // saving upserts by name, so never collide
    store(c, r.profile, r.rtype, r.pts, `Duplicated as "${c}".`);
  };
  $('ren').onclick = () => {
    const r = selected();
    if (!r) return libStatus('Pick a saved route first.', true);
    const nn = (prompt('New name:', r.name) || '').trim();
    if (!nn || nn === r.name) return;
    if (library.some(x => x.name === nn) && !confirm(`Overwrite "${nn}"?`)) return;
    // ponytail: rename = save under the new name, then delete the old record. It keeps
    // the verbs at three, and a rename synced to the phone is just those two edits.
    const id = store(nn, r.profile, r.rtype, r.pts, `Renamed to "${nn}".`);
    if (id === null) return;
    if (id !== r.id) { try { deleteRoute(state, r.id); save('edit'); } catch { /* already gone */ } }
    if ($('rname').value.trim() === r.name) $('rname').value = nn;
    refreshLibrary(id);
  };
  $('delr').onclick = () => {
    const r = selected();
    if (!r) return libStatus('Pick a saved route first.', true);
    if (!confirm(`Delete "${r.name}"?`)) return;
    try { deleteRoute(state, r.id); save('edit'); }
    catch (err) { return libStatus(`Delete failed: ${err.message}`, true); }
    refreshLibrary();
    libStatus(`Deleted "${r.name}".`);
  };

  // --- GPX in ---
  $('import').onclick = () => $('gpxfile').click();
  $('gpxfile').onchange = e => {
    const f = e.target.files[0];
    if (!f) return;
    const fr = new FileReader();
    fr.onload = () => {
      if (!alive) return;
      let cps = parseControlPts(fr.result);
      if (!cps.length) cps = downsample(parseGpx(fr.result), 10); // ponytail: a bare track gets re-snapped, so approximate
      if (!cps.length) return mapStatus('No points found in that GPX.', true);
      $('rtype').value = 'p2p';
      setPoints(cps.slice(0, MAX_WAYPOINTS));
      route();
      fitPts();
      $('rname').value = f.name.replace(/\.(gpx|xml)$/i, '');
      mapStatus(`Imported ${Math.min(cps.length, MAX_WAYPOINTS)} points from ${f.name}.`);
    };
    fr.onerror = () => mapStatus('Could not read that file.', true);
    fr.readAsText(f);
    e.target.value = '';
  };

  // --- GPX out: control points as a route, track, selected POIs as waypoints ---
  $('dl').onclick = () => {
    if (!routeCoords.length) return mapStatus('Nothing to export yet.', true);
    const name = $('rname').value.trim() || 'run315-route';
    const url = URL.createObjectURL(new Blob([buildGpx(name, pts, routeCoords, poiFound)], { type: 'application/gpx+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = (name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'route') + '.gpx';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);   // revoking synchronously can cancel the download
  };

  function setStats(km, m) {
    lastKm = km;
    $('km').textContent = km.toFixed(2);
    $('climb').textContent = m;
  }

  // --- elevation profile ---
  const svgEl = (tag, attrs) => {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  };
  function drawElev() {
    const svg = $('elevsvg');
    svg.textContent = '';
    if (routeCoords.length < 2) {
      svg.style.display = 'none';
      $('elevempty').style.display = '';
      $('elevrange').textContent = '';
      return;
    }
    svg.style.display = '';
    $('elevempty').style.display = 'none';
    // A loop, not Math.min(...eles): spreading a 100k-point track blows the argument limit.
    let lo = Infinity, hi = -Infinity;
    for (const c of routeCoords) { if (c.ele < lo) lo = c.ele; if (c.ele > hi) hi = c.ele; }
    const span = hi - lo || 1;
    let cum = 0;
    const total = distanceKm(routeCoords) * 1000 || 1;
    const xy = routeCoords.map((c, i) => {
      if (i) cum += haversine(routeCoords[i - 1], c);
      return `${(cum / total * 1000).toFixed(1)},${(100 - (c.ele - lo) / span * 90 - 5).toFixed(1)}`;
    }).join(' ');
    // Teal because elevation is measured ground truth, not a projection. The fill and
    // stroke use the token through CSS, so a theme switch repaints it too.
    svg.append(
      svgEl('polygon', { points: `0,100 ${xy} 1000,100`, style: 'fill:var(--measured)', 'fill-opacity': '0.13' }),
      svgEl('polyline', { points: xy, fill: 'none', style: 'stroke:var(--measured)', 'stroke-width': '2', 'vector-effect': 'non-scaling-stroke' }),
    );
    $('elevrange').textContent = `${Math.round(lo)}–${Math.round(hi)} m`;
  }

  // --- boot ---
  if (draft) {
    $('profile').value = draft.profile; $('rtype').value = draft.rtype;
    $('rname').value = draft.name; $('target').value = draft.target; $('freeonly').checked = draft.freeOnly;
    if (draft.view) map.setView(draft.view.center, draft.view.zoom);
    setPoints(draft.pts);
  }
  renderWaypoints();
  setStats(0, 0);
  drawElev();
  refreshLibrary();
  if (pts.length) route();

  // Leaving the page: keep the draft for next time, take the map down, stop timers.
  return function destroy() {
    if (!alive) return;
    alive = false;
    clearTimeout(poiTimer);
    let view = null;
    try { const c = map.getCenter(); view = { center: [c.lat, c.lng], zoom: map.getZoom() }; } catch { /* detached map */ }
    try {
      draft = { pts: pts.map(p => ({ lat: p.lat, lon: p.lon })), profile: $('profile').value, rtype: $('rtype').value,
        name: $('rname').value, target: $('target').value, freeOnly: $('freeonly').checked, layers: [...activeLayers], view };
    } catch { /* the markup is already gone; keep the last draft */ }
    try { map.remove(); } catch { /* already torn down */ }
  };
}

// ---------- geo + GPX math (the non-trivial logic; pure, so test/ can reach it) ----------
export function splitByStops(coords, s) {           // monotonic nearest-point boundaries
  const idx = [0];
  let from = 0;
  for (let k = 1; k < s.length - 1; k++) {
    let best = from, bd = Infinity;
    for (let j = from; j < coords.length; j++) {
      const d = haversine(coords[j], s[k]);
      if (d < bd) { bd = d; best = j; }
    }
    idx.push(best);
    from = best;
  }
  idx.push(coords.length - 1);
  return idx;
}
export function parseControlPts(xml) {              // use explicit route/waypoints if present
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  let n = [...doc.getElementsByTagName('rtept')];
  if (!n.length) n = [...doc.getElementsByTagName('wpt')];
  return n.map(p => ({ lat: +p.getAttribute('lat'), lon: +p.getAttribute('lon') }))
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));
}
export function downsample(arr, n) {                // evenly pick n points, keeping both ends
  if (arr.length <= n) return arr.map(c => ({ lat: c.lat, lon: c.lon }));
  const out = [], step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return out.map(c => ({ lat: c.lat, lon: c.lon }));
}
export const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function buildGpx(name, pts, routeCoords, poiFound = []) {
  const wpts = poiFound.map(poi =>
    `<wpt lat="${poi.lat}" lon="${poi.lon}"><name>${xmlEsc(poi.name)}</name>` +
    `<type>${xmlEsc(poi.layer)}</type></wpt>`);
  // The control points ship as <rte> so re-importing restores the waypoints exactly,
  // instead of mistaking the POI <wpt>s for them.
  const rtepts = pts.map(p => `<rtept lat="${p.lat}" lon="${p.lon}"/>`);
  const trkpts = routeCoords.map(c => `<trkpt lat="${c.lat}" lon="${c.lon}"><ele>${c.ele}</ele></trkpt>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Run315" xmlns="http://www.topografix.com/GPX/1/1">
${wpts.join('\n')}
<rte><name>${xmlEsc(name)}</name>${rtepts.join('')}</rte>
<trk><name>${xmlEsc(name)}</name><trkseg>${trkpts.join('')}</trkseg></trk>
</gpx>`;
}
export function parseGpx(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return [...doc.getElementsByTagName('trkpt')].map(pt => ({
    lat: +pt.getAttribute('lat'), lon: +pt.getAttribute('lon'),
    ele: +(pt.getElementsByTagName('ele')[0]?.textContent ?? 0),
  }));
}
export function haversine(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
export function bearing(a, b) {
  const rad = x => x * Math.PI / 180, deg = x => x * 180 / Math.PI;
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
export function destPoint(lat, lon, bearingDeg, distM) {
  const R = 6371000, br = bearingDeg * Math.PI / 180, d = distM / R;
  const la1 = lat * Math.PI / 180, lo1 = lon * Math.PI / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: la2 * 180 / Math.PI, lon: ((lo2 * 180 / Math.PI) + 540) % 360 - 180 };
}
export function distanceKm(c) {
  let d = 0;
  for (let i = 1; i < c.length; i++) d += haversine(c[i - 1], c[i]);
  return d / 1000;
}
export function climbM(c) {
  // ponytail: raw DEM is noisy; only count gains past 1 m to avoid inflation.
  let up = 0;
  for (let i = 1; i < c.length; i++) { const d = c[i].ele - c[i - 1].ele; if (d > 1) up += d; }
  return Math.round(up);
}
