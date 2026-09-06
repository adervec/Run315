/* Run315 route planner — ported from the standalone RouteMaster tool.
   Two things changed on the way in, and both are load-bearing:
   saved routes live on the server (Run315 is multi-user, localStorage is not),
   and every string that came from a person or a third-party API reaches the DOM
   through textContent, never through interpolated markup. */

const $ = id => document.getElementById(id);

// Leaflet comes off a CDN; without it every line below throws anyway, so say so once.
if (typeof L === 'undefined') {
  $('mapstatus').textContent = 'The map library did not load. Check your connection and reload.';
  $('mapstatus').classList.add('is-error');
  throw new Error('Leaflet unavailable');
}

// --- status lines: one owner each, so a slow POI search cannot wipe a routing error ---
function status(id, msg, isError) {
  const el = $(id);
  el.textContent = msg || '';
  el.classList.toggle('is-error', !!isError);
}
const mapStatus = (m, e) => status('mapstatus', m, e);
const poiStatus = (m, e) => status('poistatus', m, e);
const libStatus = (m, e) => status('libstatus', m, e);

// --- map ---
const map = L.map('map').setView([47.37, 8.54], 13); // Zurich; geolocates below
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors',
}).addTo(map);

// Nine visually distinct colours cycled across waypoints and their outgoing segments.
// (The original repeated #f58231 at 3 and 6, so two segments read as one.)
const PALETTE = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4',
                 '#008080', '#f032e6', '#9a6324', '#800000'];
const colorOf = i => PALETTE[i % PALETTE.length];

// --- state ---
const pts = [];            // control points: {lat, lon, marker}
let routeLayer = null;     // layerGroup of coloured segments + arrows
let routeCoords = [];      // [{lat,lon,ele}] of the full routed line
let lastKm = 0;
let routeSeq = 0;          // guards against a slow reply painting over a newer edit
let routeErrored = false;  // so a good route only clears a message routing itself put up

// Only recentre if the user has not already started planning somewhere else.
navigator.geolocation?.getCurrentPosition(
  p => { if (!pts.length) map.setView([p.coords.latitude, p.coords.longitude], 14); },
  () => {});

map.on('click', e => addPoint(e.latlng.lat, e.latlng.lng));

// --- waypoints ---
function makePoint(lat, lon) {
  // Icon is set at construction so Leaflet never reaches for its default pin PNG.
  const m = L.marker([lat, lon], {draggable: true, icon: wpIcon(pts.length)}).addTo(map);
  const p = {lat, lon, marker: m};
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
  // Interpolated values here are an index and a palette constant — never user input.
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
  if (pts.length) map.fitBounds(pts.map(p => [p.lat, p.lon]), {padding: [40, 40], maxZoom: 15});
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
  const s = pts.map(p => ({lat: p.lat, lon: p.lon}));
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
    if (seq !== routeSeq) return;   // a newer edit already fired; drop this answer
    if (!res.ok) throw new Error(body.slice(0, 200) || `BRouter ${res.status}`);
    routeCoords = parseGpx(body);
    const idx = splitByStops(routeCoords, s);     // route index nearest each stop
    routeLayer = L.layerGroup().addTo(map);
    for (let i = 0; i < s.length - 1; i++) {
      const seg = routeCoords.slice(idx[i], idx[i + 1] + 1);
      if (seg.length < 2) continue;
      const col = colorOf(i);                     // segment shares its start waypoint's colour
      L.polyline(seg.map(c => [c.lat, c.lon]), {color: col, weight: 6, interactive: false}).addTo(routeLayer);
      addArrows(seg, col, routeLayer);
    }
    setStats(distanceKm(routeCoords), climbM(routeCoords));
    drawElev();
  if (activeLayers.size) refreshPoisSoon(700);  // layers follow the route they annotate
    clearRouteError();
  } catch (err) {
    if (seq !== routeSeq) return;
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
function splitByStops(coords, s) {                 // monotonic nearest-point boundaries
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
  const start = {lat: pts[0].lat, lon: pts[0].lon};
  $('rtype').value = 'loop';
  let r = target / (2 * Math.PI);
  const base = Math.random() * 360;
  for (let iter = 0; iter < 4; iter++) {           // ponytail: 4 tries; converges in 2-3
    const ring = [start];
    for (let i = 0; i < 5; i++) ring.push(destPoint(start.lat, start.lon, base + i * 72, r));
    setPoints(ring);
    await route();
    if (!lastKm) break;
    if (Math.abs(lastKm * 1000 - target) / target < 0.08) break;
    r *= target / (lastKm * 1000);
  }
  fitPts();
  if (lastKm) mapStatus(`Loop fitted to ${lastKm.toFixed(2)} km.`);
}

// --- POI layers, fetched through our own server ---
// The standalone tool called Overpass straight from the browser. Going through
// Run315 instead buys mirror failover, a retry, a descriptive User-Agent and a
// cache -- Overpass is donated infrastructure and deserves all four.
const activeLayers = new Set();
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

async function loadPoiCatalogue() {
  const host = $('layers');
  if (!host) return;
  let groups;
  try {
    const res = await fetch('/api/poi-layers', {credentials: 'same-origin'});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    groups = (await res.json()).groups || [];
  } catch (err) {
    poiStatus('Could not load the layer list: ' + err.message, true);
    return;
  }
  host.textContent = '';
  groups.forEach(group => {
    const head = document.createElement('p');
    head.className = 'layer-group';
    head.textContent = group.name;
    host.appendChild(head);

    const row = document.createElement('div');
    row.className = 'chips';
    group.layers.forEach(layer => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.layer = layer.id;
      chip.setAttribute('aria-pressed', 'false');
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
  });
}

$('freeonly').addEventListener('change', () => refreshPoisSoon());

async function refreshPois() {
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
    const res = await fetch('/api/pois', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        points: routeCoords.map(c => [c.lat, c.lon]),
        layers: [...activeLayers],
        free_only: $('freeonly').checked,
      }),
    });
    data = await res.json().catch(() => ({error: 'the server sent a page instead of data'}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  } catch (err) {
    if (mine === poiSeq) poiStatus(err.message, true);
    return;
  }
  if (mine !== poiSeq) return;             // a newer request already answered

  poiFound = data.pois || [];
  const g = L.layerGroup().addTo(map);
  poiFound.forEach(poi => {
    const pin = L.divIcon({className: '', iconSize: [22, 22],
                           html: `<div class="poi-pin">${poi.icon}</div>`});
    L.marker([poi.lat, poi.lon], {icon: pin}).bindPopup(poiPopup(poi)).addTo(g);
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

// --- saved routes: server-side, one library per signed-in user ---
// The standalone tool kept these in localStorage, which is per-browser and per-device.
// Same three verbs, now over HTTP: GET /api/routes, POST /api/routes, DELETE /api/routes/<id>.
let library = [];   // [{id, name, profile, rtype, pts}] exactly as the API returns it

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',                    // the session cookie is the whole auth story
    headers: {'Content-Type': 'application/json'},
    ...opts,
  });
  if (!res.ok) throw new Error(res.status === 401 ? 'you are signed out' : `server said ${res.status}`);
  // An expired session usually arrives as a 200 page of login HTML, not a 401.
  try { return await res.json(); }
  catch { throw new Error('the server sent a page instead of data — try reloading'); }
}

async function refreshLibrary(selectId) {
  let ok = true;
  try {
    library = (await api('/api/routes')).routes || [];
  } catch (err) {
    ok = false;
    library = [];
    libStatus(`Could not load your saved routes: ${err.message}.`, true);
  }
  renderLibrary(selectId);
  return ok;   // callers only report success once the list they show is the real one
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
  for (const r of [...library].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const o = document.createElement('option');
    o.value = String(r.id);
    o.textContent = r.name;   // route names are user input and now shared storage
    if (String(r.id) === String(selectId)) o.selected = true;
    sel.append(o);
  }
}
const selected = () => library.find(r => String(r.id) === String($('rlist').value));

async function store(name, profile, rtype, points, okMsg) {
  try {
    const {id} = await api('/api/routes', {
      method: 'POST',
      body: JSON.stringify({name, profile, rtype, pts: points}),
    });
    if (await refreshLibrary(id)) libStatus(okMsg);
    return id;
  } catch (err) {
    libStatus(`Save failed: ${err.message}.`, true);
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
        pts.map(p => ({lat: p.lat, lon: p.lon})), `Saved "${name}".`);
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
  while (library.some(x => x.name === c)) c += ' copy';   // POST upserts by name, so never collide
  store(c, r.profile, r.rtype, r.pts, `Duplicated as "${c}".`);
};
$('ren').onclick = async () => {
  const r = selected();
  if (!r) return libStatus('Pick a saved route first.', true);
  const nn = (prompt('New name:', r.name) || '').trim();
  if (!nn || nn === r.name) return;
  if (library.some(x => x.name === nn) && !confirm(`Overwrite "${nn}"?`)) return;
  // ponytail: rename = save under the new name, then delete the old row. Two round
  // trips, but it keeps the API at three verbs instead of adding a PATCH.
  const id = await store(nn, r.profile, r.rtype, r.pts, `Renamed to "${nn}".`);
  if (id === null) return;
  try {
    await api(`/api/routes/${r.id}`, {method: 'DELETE'});
  } catch (err) {
    libStatus(`Renamed, but "${r.name}" is still saved: ${err.message}.`, true);
  }
  if ($('rname').value.trim() === r.name) $('rname').value = nn;
  await refreshLibrary(id);
};
$('delr').onclick = async () => {
  const r = selected();
  if (!r) return libStatus('Pick a saved route first.', true);
  if (!confirm(`Delete "${r.name}"?`)) return;
  try {
    await api(`/api/routes/${r.id}`, {method: 'DELETE'});
  } catch (err) {
    return libStatus(`Delete failed: ${err.message}.`, true);
  }
  if (await refreshLibrary()) libStatus(`Deleted "${r.name}".`);
};

// --- GPX in ---
$('import').onclick = () => $('gpxfile').click();
$('gpxfile').onchange = e => {
  const f = e.target.files[0];
  if (!f) return;
  const fr = new FileReader();
  fr.onload = () => {
    let cps = parseControlPts(fr.result);
    if (!cps.length) cps = downsample(parseGpx(fr.result), 10); // ponytail: a bare track gets re-snapped, so approximate
    if (!cps.length) return mapStatus('No points found in that GPX.', true);
    $('rtype').value = 'p2p';
    setPoints(cps);
    route();
    fitPts();
    $('rname').value = f.name.replace(/\.(gpx|xml)$/i, '');
    mapStatus(`Imported ${cps.length} points from ${f.name}.`);
  };
  fr.onerror = () => mapStatus('Could not read that file.', true);
  fr.readAsText(f);
  e.target.value = '';
};
function parseControlPts(xml) {                              // use explicit route/waypoints if present
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  let n = [...doc.getElementsByTagName('rtept')];
  if (!n.length) n = [...doc.getElementsByTagName('wpt')];
  return n.map(p => ({lat: +p.getAttribute('lat'), lon: +p.getAttribute('lon')}));
}
function downsample(arr, n) {                                // evenly pick n points, keeping both ends
  if (arr.length <= n) return arr.map(c => ({lat: c.lat, lon: c.lon}));
  const out = [], step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return out.map(c => ({lat: c.lat, lon: c.lon}));
}

// --- GPX out: control points as a route, track, selected POIs as waypoints ---
const xmlEsc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
$('dl').onclick = () => {
  if (!routeCoords.length) return mapStatus('Nothing to export yet.', true);
  const name = $('rname').value.trim() || 'run315-route';
  const url = URL.createObjectURL(new Blob([buildGpx(name)], {type: 'application/gpx+xml'}));
  const a = document.createElement('a');
  a.href = url;
  a.download = (name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'route') + '.gpx';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);   // revoking synchronously can cancel the download
};
function buildGpx(name) {
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

// --- geo + GPX math (the non-trivial logic) ---
function parseGpx(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return [...doc.getElementsByTagName('trkpt')].map(pt => ({
    lat: +pt.getAttribute('lat'), lon: +pt.getAttribute('lon'),
    ele: +(pt.getElementsByTagName('ele')[0]?.textContent ?? 0),
  }));
}
function haversine(a, b) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function bearing(a, b) {
  const rad = x => x * Math.PI / 180, deg = x => x * 180 / Math.PI;
  const dLon = rad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
function destPoint(lat, lon, bearingDeg, distM) {
  const R = 6371000, br = bearingDeg * Math.PI / 180, d = distM / R;
  const la1 = lat * Math.PI / 180, lo1 = lon * Math.PI / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return {lat: la2 * 180 / Math.PI, lon: ((lo2 * 180 / Math.PI) + 540) % 360 - 180};
}
function distanceKm(c) {
  let d = 0;
  for (let i = 1; i < c.length; i++) d += haversine(c[i - 1], c[i]);
  return d / 1000;
}
function climbM(c) {
  // ponytail: raw DEM is noisy; only count gains past 1 m to avoid inflation.
  let up = 0;
  for (let i = 1; i < c.length; i++) { const d = c[i].ele - c[i - 1].ele; if (d > 1) up += d; }
  return Math.round(up);
}
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
  // Teal because elevation is measured ground truth, not a projection.
  const col = getComputedStyle(document.documentElement).getPropertyValue('--measured').trim() || '#0b6e79';
  svg.append(
    svgEl('polygon', {points: `0,100 ${xy} 1000,100`, fill: col, 'fill-opacity': '0.13'}),
    svgEl('polyline', {points: xy, fill: 'none', stroke: col, 'stroke-width': '2'}),
  );
  $('elevrange').textContent = `${Math.round(lo)}–${Math.round(hi)} m`;
}

// --- boot ---
renderWaypoints();
drawElev();
setStats(0, 0);
refreshLibrary();

// Self-check: open with #selftest to assert the math (no framework).
if (location.hash === '#selftest') {
  const sq = [{lat: 0, lon: 0, ele: 0}, {lat: 0, lon: 1, ele: 10}, {lat: 0, lon: 2, ele: 5}];
  console.assert(Math.abs(distanceKm(sq) - 222.6) < 1, 'distance ~222.6 km/deg at equator');
  console.assert(climbM(sq) === 10, 'climb counts the +10, not the -5');
  console.assert(parseGpx('<gpx><trkpt lat="1" lon="2"><ele>3</ele></trkpt></gpx>')[0].ele === 3, 'parse ele');
  console.assert(Math.abs(bearing({lat: 0, lon: 0}, {lat: 0, lon: 1}) - 90) < 0.1, 'bearing east = 90');
  console.assert(Math.abs(bearing({lat: 0, lon: 0}, {lat: 1, lon: 0}) - 0) < 0.1, 'bearing north = 0');
  const dp = destPoint(0, 0, 90, 111320);
  console.assert(Math.abs(dp.lon - 1) < 0.01 && Math.abs(dp.lat) < 0.01, 'destPoint east ~1 deg');
  const line = [{lat: 0, lon: 0}, {lat: 0, lon: 1}, {lat: 0, lon: 2}, {lat: 0, lon: 3}];
  const idx = splitByStops(line, [{lat: 0, lon: 0}, {lat: 0, lon: 1.5}, {lat: 0, lon: 3}]);
  console.assert(idx[0] === 0 && idx[2] === 3 && idx[1] > 0 && idx[1] < 3 && idx[1] >= idx[0], 'split monotonic');
  const ds = downsample(Array.from({length: 100}, (_, i) => ({lat: i, lon: 0})), 5);
  console.assert(ds.length === 5 && ds[0].lat === 0 && ds[4].lat === 99, 'downsample keeps both ends');
  console.assert(new Set(PALETTE).size === PALETTE.length, 'palette colours are distinct');
  console.assert(xmlEsc('<a & "b">') === '&lt;a &amp; &quot;b&quot;&gt;', 'gpx text is escaped');
  console.log('selftest done', {idx});
}
