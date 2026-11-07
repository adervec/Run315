// The personal heatmap: every track, drawn additively, so the streets run a hundred times glow
// and the one-offs barely show. Two layers: frequency (how often you ran there, log-scaled so a
// commute does not wash out everything else) and pace (each track tinted by how fast that run
// was, against all your runs). Tracks come from each activity's detail (the thinned track the
// analysis kept) on this device -- the desktop that imports has them all; a phone has the ones it
// has opened.
import { state, idbKeys, getDetailRec } from '../store.js';
import * as D from '../derive.js';
import { RUN_TYPES } from '../lib/fitness.js';
import { html, pageHead, emptyState, useCss } from '../ui.js';
import { loadLeaflet, whenGone } from '../routemaker.js';

export const title = 'Heatmap';
const SPORTS = { runs: a => RUN_TYPES.has(a.type), rides: a => /cycl|bik|ride/.test(a.type), walks: a => /walk|hik/.test(a.type), all: () => true };
const ui = { sport: 'runs', year: 'all', layer: 'frequency', dark: true };
let _tracks = null, _tracksKey = '';

const CSS = `
.heatpage .controls { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin-bottom: 10px; font-size: 13px; }
.heatpage .controls select { padding: 4px 6px; }
.heatpage #heatmap { height: min(72vh, 760px); border-radius: 3px; border: 1px solid var(--line); }
.heatpage.dark .leaflet-tile-pane { filter: brightness(.38) grayscale(1) contrast(1.1); }
.heatpage .scale { display: flex; align-items: center; gap: 8px; font: 12px var(--mono); color: var(--muted); margin-top: 8px; }
.heatpage .scale b { display: inline-block; width: 180px; height: 8px; border-radius: 4px; }
`;

// Ramp for the frequency layer: transparent -> teal -> amber -> white, by log density.
const STOPS = [[0, [11, 110, 121, 0]], [0.15, [11, 110, 121, 170]], [0.45, [63, 184, 196, 230]], [0.75, [240, 190, 80, 245]], [1, [255, 255, 240, 255]]];
const LUT = (() => {
  const out = new Uint8ClampedArray(256 * 4);
  for (let a = 0; a < 256; a++) {
    const t = a === 0 ? 0 : Math.log1p(a) / Math.log(256);
    let k = 0; while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
    const [t0, c0] = STOPS[k], [t1, c1] = STOPS[k + 1], f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    for (let j = 0; j < 4; j++) out[a * 4 + j] = c0[j] + (c1[j] - c0[j]) * f;
  }
  return out;
})();
// Pace layer: the run's pace percentile among all runs of its sport, slow (cool) to fast (warm).
const PACE = ['#2a78d6', '#1baf7a', '#eda100', '#eb6834', '#e34948'];

async function loadTracks() {
  const ids = await idbKeys('detail');
  const key = ids.length + ':' + Object.keys(state.activities).length;
  if (_tracks && _tracksKey === key) return _tracks;
  const out = [];
  for (const id of ids) {
    const a = state.activities[id];
    if (!a || D.isVirtual(a)) continue;
    const det = await getDetailRec(id);
    const p = det && det.points;
    if (!p || p.length < 2) continue;
    const flat = new Float32Array(p.length * 2);
    p.forEach(([la, lo], i) => { flat[2 * i] = la; flat[2 * i + 1] = lo; });
    out.push({ id, a, pts: flat, speed: a.distance_m && a.moving_s ? a.distance_m / a.moving_s : null });
  }
  _tracks = out; _tracksKey = key;
  return out;
}

const chosen = tracks => tracks.filter(t => SPORTS[ui.sport](t.a) && (ui.year === 'all' || String(t.a.start).startsWith(ui.year)));

export function render() {
  useCss('heatmap', CSS);
  if (!Object.keys(state.activities).length) return html`${pageHead('Heatmap')}${emptyState('No activities yet', 'Bring in Garmin and Strava through Sync & cowork.', '')}`;
  const years = [...new Set(Object.values(state.activities).map(a => String(a.start).slice(0, 4)))].sort().reverse();
  return html`<div class="heatpage ${ui.dark ? 'dark' : ''}">${pageHead('Heatmap', 'Every track you have run, drawn on top of each other')}
    <section class="panel"><div class="controls">
      <label>Sport <select data-k="sport">${Object.keys(SPORTS).map(k => html`<option ${ui.sport === k ? 'selected' : ''}>${k}</option>`)}</select></label>
      <label>Year <select data-k="year"><option value="all">every year</option>${years.map(y => html`<option ${ui.year === y ? 'selected' : ''}>${y}</option>`)}</select></label>
      <label>Layer <select data-k="layer"><option value="frequency" ${ui.layer === 'frequency' ? 'selected' : ''}>how often</option><option value="pace" ${ui.layer === 'pace' ? 'selected' : ''}>how fast</option></select></label>
      <label><input type="checkbox" data-k="dark" ${ui.dark ? 'checked' : ''}> lights off</label>
      <span class="panel-note" id="heatcount" style="margin:0">loading tracks…</span></div>
      <div id="heatmap"></div>
      <div class="scale" id="heatscale"></div>
      <p class="panel-note">Each run is its kept track (about 600 points). Virtual rides (Zwift) and treadmill runs have no ground and are left out.
        A phone shows the runs whose detail it has; the desktop that imports shows them all.</p></section></div>`;
}

export async function mount(el) {
  const box = el.querySelector('#heatmap'), count = el.querySelector('#heatcount'), scale = el.querySelector('#heatscale');
  el.querySelectorAll('[data-k]').forEach(c => c.onchange = () => {
    ui[c.dataset.k] = c.type === 'checkbox' ? c.checked : c.value;
    if (c.dataset.k === 'dark') el.querySelector('.heatpage').classList.toggle('dark', ui.dark);
    redraw();
  });
  let L; try { L = await loadLeaflet(); } catch { box.textContent = 'The map did not load (offline?).'; return; }
  if (!box.isConnected) return;
  const map = L.map(box, { preferCanvas: true, zoomControl: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap' }).addTo(map);
  const home = D.tileSummary(state);
  map.setView([43.86, -79.33], 12);
  const tracks = await loadTracks();
  if (!box.isConnected) return;

  // A canvas over the map, redrawn on every move: the density pass draws white lines additively
  // into an offscreen canvas, then each pixel's accumulated alpha goes through the log ramp.
  const canvas = L.DomUtil.create('canvas', '', map.getPanes().overlayPane);
  canvas.style.pointerEvents = 'none';
  const off = document.createElement('canvas');
  function draw() {
    const size = map.getSize(), tl = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(canvas, tl);
    canvas.width = off.width = size.x; canvas.height = off.height = size.y;
    const ctx = canvas.getContext('2d'), oc = off.getContext('2d');
    const list = chosen(tracks), z = map.getZoom(), w = z >= 15 ? 2.5 : z >= 13 ? 1.6 : 1.1;
    const b = map.getBounds().pad(0.1);
    let shown = 0;
    const path = (c, t) => {
      c.beginPath();
      for (let i = 0; i < t.pts.length; i += 2) {
        const p = map.latLngToContainerPoint([t.pts[i], t.pts[i + 1]]);
        if (i) c.lineTo(p.x, p.y); else c.moveTo(p.x, p.y);
      }
      c.stroke();
    };
    const inView = t => { const la = t.pts[0], lo = t.pts[1]; return b.contains([la, lo]) || b.contains([t.pts[t.pts.length - 2], t.pts[t.pts.length - 1]]) || b.contains([t.pts[(t.pts.length >> 2) * 2], t.pts[(t.pts.length >> 2) * 2 + 1]]); };
    if (ui.layer === 'frequency') {
      oc.clearRect(0, 0, off.width, off.height);
      oc.globalCompositeOperation = 'lighter'; oc.strokeStyle = 'rgba(255,255,255,0.012)'; oc.lineWidth = w; oc.lineJoin = 'round';
      for (const t of list) if (inView(t)) { path(oc, t); shown++; }
      const img = oc.getImageData(0, 0, off.width, off.height), d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const j = d[i + 3] * 4;   // alpha carries the count (getImageData un-premultiplies colour)
        d[i] = LUT[j]; d[i + 1] = LUT[j + 1]; d[i + 2] = LUT[j + 2]; d[i + 3] = LUT[j + 3];
      }
      ctx.putImageData(img, 0, 0);
      scale.innerHTML = `once <b style="background:linear-gradient(90deg, rgba(11,110,121,.7), rgb(63,184,196), rgb(240,190,80), rgb(255,255,240))"></b> hundreds of times`;
    } else {
      const sp = list.map(t => t.speed).filter(Boolean).sort((a, b) => a - b);
      const q = v => sp.length ? Math.min(4, Math.floor(5 * sp.findIndex(s => s >= v) / sp.length)) : 2;
      ctx.lineWidth = w; ctx.lineJoin = 'round'; ctx.globalAlpha = 0.35;
      for (const t of list) if (inView(t) && t.speed) { ctx.strokeStyle = PACE[q(t.speed)]; path(ctx, t); shown++; }
      scale.innerHTML = `slowest fifth ${PACE.map(c => `<b style="width:28px;background:${c}"></b>`).join('')} fastest fifth <span class="dim">· of the runs shown</span>`;
    }
    // Missing = outdoor activities that claimed ground (so had GPS) but whose track is not here.
    const have = new Set(tracks.map(t => t.id));
    const missing = Object.entries(state.derived).filter(([id, d]) => d.tiles && d.tiles.length && !have.has(id)).length;
    count.textContent = `${shown} of ${list.length} tracks in view` + (missing ? ` · ${missing} more have a track on another device` : '');
  }
  function redraw() { if (map) draw(); }
  map.on('moveend zoomend resize', draw);
  // Start where the tracks are: the home tile, else the bounds of everything.
  const list = chosen(tracks);
  if (list.length) {
    const lat = [], lon = [];
    for (const t of list) { lat.push(t.pts[0]); lon.push(t.pts[1]); }
    lat.sort((a, b) => a - b); lon.sort((a, b) => a - b);
    const mid = k => k[k.length >> 1];
    map.setView([mid(lat), mid(lon)], 12);
  } else if (home && home.home) map.setView([43.86, -79.33], 12);
  draw();
  const stop = whenGone(box, () => map.remove());
  return () => { stop(); try { map.remove(); } catch { /* gone */ } };
}
