// The coverage time-lapse: the whole record replayed as ground claimed. Every territory tile
// appears on the day it was first visited, and -- where a municipality is loaded on this
// device -- every street on the day it was completed, coloured by the year it happened.
//
// It is drawn into its own canvas, not over Leaflet. A video needs one canvas to capture
// (canvas.captureStream), and Leaflet's map is a stack of DOM images that cannot be captured
// without a server. So the page projects Web Mercator itself (js/replay.js: world units are
// z17 tiles), draws the OpenStreetMap tiles under it (crossOrigin, so the canvas stays
// capturable; a plain background when they do not load), and pans and zooms by hand.
//
// Incremental: two accumulation canvases (tiles, streets) are only ever added to as the date
// moves forward -- a frame draws the tiles of the days that just passed, not all 3,000. A
// step backwards, a pan or a zoom redraws them once.
import { state, save } from '../store.js';
import * as D from '../derive.js';
import * as RP from '../replay.js';
import { cities as cityRecs, localGeo } from '../cities.js';
import { html, pageHead, emptyState, useCss, day, toast } from '../ui.js';
import { token } from '../routemaker.js';

export const title = 'Time-lapse';

const CSS = `
.tlapse .controls { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin-bottom: 10px; font-size: 13px; }
.tlapse .controls select { padding: 4px 6px; }
.tlapse .stage { position: relative; height: min(68vh, 700px); border: 1px solid var(--line); border-radius: 3px; overflow: hidden; background: var(--ground); touch-action: none; cursor: grab; }
.tlapse .stage canvas { display: block; width: 100%; height: 100%; }
.tlapse .transport { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin-top: 10px; font: 13px var(--mono); }
.tlapse .transport input[type=range] { flex: 1 1 220px; accent-color: var(--measured); }
.tlapse .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 8px; font: 12px var(--mono); color: var(--muted); }
.tlapse .legend i { display: inline-block; width: 12px; height: 12px; border-radius: 2px; vertical-align: -2px; margin-right: 4px; }
.tlapse .btn[data-rec].on { background: var(--behind); border-color: var(--behind); }
`;

const DEFAULTS = { zoom: 17, bg: 'map', pace: 90, streets: true, frame: 'home' };
const ui = () => { const l = (state.local.ui = state.local.ui || {}); return (l.timelapse = { ...DEFAULTS, ...(l.timelapse || {}) }); };
const PACES = [[30, 'a month a second'], [90, 'a season a second'], [182, 'half a year a second'], [365, 'a year a second']];
// Old to new: the series blue through green and amber to orange. Sequential, not categorical:
// the order of the years is what the colour says.
const RAMP = ['--series-1', '--series-3', '--series-4', '--series-2'];

// First visit of every z17 tile: 'x,y' -> 'YYYY-MM-DD' (tileSummary's first loop, without the
// square and cluster searches the page does not need).
function firstSeen() {
  const first = new Map();
  for (const a of Object.values(state.activities)) {
    const tiles = state.derived[a.id]?.tiles;
    if (!tiles || !tiles.length || !a.start || D.isVirtual(a)) continue;
    const d = String(a.start).slice(0, 10);
    for (const t of tiles) { const k = t[0] + ',' + t[1]; if (!first.has(k) || d < first.get(k)) first.set(k, d); }
  }
  return first;
}
const doneCount = () => Object.values(cityRecs(state)).reduce((n, r) => n + Object.values(r.done || {}).filter(Boolean).length, 0);

export function render() {
  useCss('timelapse', CSS);
  const head = pageHead('Time-lapse', 'Your ground, claimed day by day over the whole record');
  const any = Object.values(state.derived).some(d => d && d.tiles && d.tiles.length);
  if (!any) return html`${head}${emptyState('No ground yet', 'The time-lapse plays back the map tiles your outdoor activities claimed. Bring in activities with GPS through Sync & cowork.', html`<a class="btn" href="#/sync">Go and sync</a>`)}`;
  const u = ui(), streets = doneCount();
  const opt = (k, v, label) => html`<option value="${v}" ${String(u[k]) === String(v) ? 'selected' : ''}>${label}</option>`;
  return html`<div class="tlapse">${head}<section class="panel">
    <div class="controls">
      <label>Tiles <select data-k="zoom">${opt('zoom', 17, 'z17 (~220 m)')}${opt('zoom', 14, 'z14 (~1.8 km)')}</select></label>
      <label>Speed <select data-k="pace">${PACES.map(([v, l]) => opt('pace', v, l))}</select></label>
      <label>Background <select data-k="bg">${opt('bg', 'map', 'map, dimmed')}${opt('bg', 'plain', 'plain')}</select></label>
      <label>Frame <select data-k="frame">${opt('frame', 'home', 'where you usually run')}${opt('frame', 'all', 'everything')}</select></label>
      ${streets ? html`<label><input type="checkbox" data-k="streets" ${u.streets ? 'checked' : ''}> completed streets (${streets})</label>` : ''}
    </div>
    <div class="stage" data-stage><canvas data-canvas aria-label="Coverage map time-lapse"></canvas></div>
    <div class="transport">
      <button type="button" class="btn" data-play>Play</button>
      <input type="range" min="0" max="1" step="1" value="1" data-scrub aria-label="Date">
      <span data-date>--</span>
      <button type="button" class="btn btn-ghost" data-rec>Record video</button>
    </div>
    <div class="legend" data-legend></div>
    <p class="panel-note" data-note>Drag to pan, scroll or pinch to zoom. Each square is a map tile on the day you first set foot in it;
      ${streets ? 'each line a street on the day you finished it (90% of its length). ' : 'load a municipality on Streets & trails to add streets as you complete them. '}
      Colour is the year. The video is a WebM of this canvas, date and legend included.</p>
  </section></div>`;
}

const lum = c => { const m = /^#?([0-9a-f]{6})$/i.exec(c || ''); if (!m) return 1; const v = parseInt(m[1], 16); return (0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255; };

export async function mount(el) {
  const root = el.querySelector('.tlapse');
  if (!root) return;
  const u = ui(), stage = root.querySelector('[data-stage]'), canvas = root.querySelector('[data-canvas]');
  const scrub = root.querySelector('[data-scrub]'), dateEl = root.querySelector('[data-date]'), playBtn = root.querySelector('[data-play]');
  const recBtn = root.querySelector('[data-rec]'), legendEl = root.querySelector('[data-legend]'), note = root.querySelector('[data-note]');
  const rerender = () => { el.innerHTML = String(render()); return mount(el); };
  const cleanup = [];
  let alive = true;
  const stop = () => { alive = false; for (const f of cleanup.splice(0)) { try { f(); } catch { /* gone */ } } };

  root.querySelectorAll('[data-k]').forEach(c => c.onchange = () => {
    const k = c.dataset.k;
    u[k] = c.type === 'checkbox' ? c.checked : (k === 'zoom' || k === 'pace' ? +c.value : c.value);
    state.local.ui.timelapse = u; save('ui');
    if (k === 'pace') return;              // read live by the clock
    stop(); rerender();
  });

  // ---- the events ----
  const ev = RP.tileEvents(firstSeen(), u.zoom), unit = 2 ** (RP.WORLD_Z - u.zoom);
  let streets = [];
  if (u.streets) {
    let missingGeo = 0;
    for (const [id, rec] of Object.entries(cityRecs(state))) {
      if (!rec || !rec.done || !Object.keys(rec.done).length) continue;
      const geo = await localGeo(id);         // device-only geometry; dropped after this turn
      if (!geo) { missingGeo++; continue; }
      streets.push(...RP.streetEvents(geo, rec.done));
    }
    streets.sort((a, b) => a.day - b.day);
    if (missingGeo && note) note.append(` ${missingGeo} loaded area${missingGeo > 1 ? 's have' : ' has'} no street geometry on this device; open it on Streets & trails to fetch it.`);
  }
  if (!alive || !canvas.isConnected) return;
  if (!ev.n) return stop;
  const sDays = Int32Array.from(streets.map(s => s.day));
  const d0 = Math.min(ev.day[0], streets.length ? sDays[0] : Infinity);
  const d1 = Math.max(ev.day[ev.n - 1], streets.length ? sDays[sDays.length - 1] : -Infinity);
  const years = []; for (let y = RP.yearOf(d0); y <= RP.yearOf(d1); y++) years.push(y);
  const colour = RP.yearRamp(years, RAMP.map((t, i) => token(t, ['#2a78d6', '#1baf7a', '#eda100', '#eb6834'][i])));
  const tileCol = new Array(ev.n), streetCol = streets.map(s => colour[RP.yearOf(s.day)]);
  for (let i = 0; i < ev.n; i++) tileCol[i] = colour[RP.yearOf(ev.day[i])];
  legendEl.innerHTML = String(html`${years.map(y => html`<span><i style="background:${colour[y]}"></i>${y}</span>`)}`);
  scrub.max = String(d1 - d0 + 1); scrub.value = scrub.max;

  // ---- the canvases and the view ----
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const bg = document.createElement('canvas'), accT = document.createElement('canvas'), accS = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const ground = token('--ground', '#eceff3'), ink = token('--ink', '#101828'), muted = token('--muted', '#5b6675');
  const dark = lum(ground) < 0.5;
  const view = { cx: 0, cy: 0, s: 1, w: 2, h: 2 };
  function size() {
    // Even pixel sizes: VP8/VP9 encoders want them.
    const w = Math.max(2, Math.round(stage.clientWidth * dpr) & ~1), h = Math.max(2, Math.round(stage.clientHeight * dpr) & ~1);
    for (const c of [canvas, bg, accT, accS]) { c.width = w; c.height = h; }
    view.w = w; view.h = h;
  }
  function fit(which) {
    const xs = ev.x, ys = ev.y;
    const b = which === 'all' ? RP.quantileBox(xs, ys, 0, 1, unit) : RP.quantileBox(xs, ys, 0.03, 0.97, unit);
    const bw = Math.max(4, b[2] - b[0]), bh = Math.max(4, b[3] - b[1]);
    view.cx = (b[0] + b[2]) / 2; view.cy = (b[1] + b[3]) / 2;
    view.s = Math.min(view.w / bw, view.h / bh) * 0.92;
  }
  const sx = x => (x - view.cx) * view.s + view.w / 2, sy = y => (y - view.cy) * view.s + view.h / 2;

  // Background map tiles, cached as images; a tile arriving later redraws the background once.
  const imgs = new Map();
  let bgPending = false;
  function drawBg() {
    const b = bg.getContext('2d');
    b.fillStyle = ground; b.fillRect(0, 0, bg.width, bg.height);
    if (u.bg !== 'map') return;
    b.filter = dark ? 'grayscale(1) brightness(0.42) contrast(1.1)' : 'grayscale(1) contrast(0.85) brightness(1.04)';
    for (const t of RP.bgTiles(view).list) {
      const key = `${t.z}/${t.x}/${t.y}`;
      let im = imgs.get(key);
      if (!im) {
        if (imgs.size > 400) imgs.delete(imgs.keys().next().value);
        im = new Image(); im.crossOrigin = 'anonymous';
        im.onload = () => { if (!bgPending && alive) { bgPending = true; requestAnimationFrame(() => { bgPending = false; if (alive) { drawBg(); compose(); } }); } };
        im.onerror = () => { im.failed = true; };
        im.src = `https://tile.openstreetmap.org/${key}.png`;
        imgs.set(key, im);
      }
      if (im.complete && im.naturalWidth && !im.failed) b.drawImage(im, t.px, t.py, t.size + 0.5, t.size + 0.5);
    }
    b.filter = 'none';
  }

  // ---- incremental drawing ----
  let drawnT = 0, drawnS = 0, curDay = d1;
  function clearAcc() { accT.getContext('2d').clearRect(0, 0, accT.width, accT.height); accS.getContext('2d').clearRect(0, 0, accS.width, accS.height); drawnT = drawnS = 0; }
  function drawTo(dayN) {
    const nt = RP.countBy(ev.day, dayN, ev.n), ns = RP.countBy(sDays, dayN);
    if (nt < drawnT || ns < drawnS) clearAcc();
    const t = accT.getContext('2d'), px = Math.max(1, unit * view.s), gap = px > 6 ? 1 : 0;
    t.globalAlpha = 0.72;
    let last = '';
    const xMin = view.cx - view.w / 2 / view.s - unit, xMax = view.cx + view.w / 2 / view.s, yMin = view.cy - view.h / 2 / view.s - unit, yMax = view.cy + view.h / 2 / view.s;
    for (let i = drawnT; i < nt; i++) {
      const wx = ev.x[i] * unit, wy = ev.y[i] * unit;
      if (wx < xMin || wx > xMax || wy < yMin || wy > yMax) continue;
      if (tileCol[i] !== last) t.fillStyle = last = tileCol[i];
      t.fillRect(sx(wx), sy(wy), px - gap, px - gap);
    }
    drawnT = nt;
    if (ns > drawnS) {
      const s = accS.getContext('2d');
      s.lineWidth = Math.max(1.5 * dpr, view.s * 0.07); s.lineCap = s.lineJoin = 'round';
      for (let i = drawnS; i < ns; i++) {
        const p = streets[i].pts;
        s.strokeStyle = streetCol[i]; s.beginPath();
        let pen = false;
        for (let j = 0; j < p.length; j += 2) {
          if (Number.isNaN(p[j])) { pen = false; continue; }
          const X = sx(p[j]), Y = sy(p[j + 1]);
          if (pen) s.lineTo(X, Y); else { s.moveTo(X, Y); pen = true; }
        }
        s.stroke();
      }
      drawnS = ns;
    }
    curDay = dayN;
  }
  // The frame: background, tiles, streets, then the date, counts and legend -- painted into
  // the canvas so a recording carries them.
  function compose() {
    ctx.globalAlpha = 1;
    ctx.drawImage(bg, 0, 0); ctx.drawImage(accT, 0, 0); ctx.drawImage(accS, 0, 0);
    const f = Math.round(13 * dpr), pad = Math.round(12 * dpr);
    ctx.textBaseline = 'top';
    const date = RP.dayStr(curDay), label = day(date, true);
    ctx.font = `700 ${Math.round(26 * dpr)}px ${token('--display', 'sans-serif')}`;
    ctx.fillStyle = ground; ctx.globalAlpha = 0.78; ctx.fillRect(0, 0, Math.min(view.w, 340 * dpr), pad * 2 + 44 * dpr); ctx.globalAlpha = 1;
    ctx.fillStyle = ink; ctx.fillText(label, pad, pad);
    ctx.font = `${f}px ${token('--mono', 'monospace')}`; ctx.fillStyle = muted;
    ctx.fillText(`${drawnT.toLocaleString()} tiles (z${u.zoom})${streets.length ? ` · ${drawnS.toLocaleString()} streets` : ''}`, pad, pad + 32 * dpr);
    // Year legend, bottom left; attribution bottom right.
    let x = pad; const y = view.h - pad - f;
    ctx.globalAlpha = 0.78; ctx.fillStyle = ground; ctx.fillRect(0, y - pad / 2, view.w, f + pad * 1.5); ctx.globalAlpha = 1;
    for (const yr of years) {
      const on = yr <= +date.slice(0, 4);
      ctx.fillStyle = colour[yr]; ctx.globalAlpha = on ? 1 : 0.3; ctx.fillRect(x, y, f, f);
      ctx.fillStyle = ink; ctx.fillText(String(yr), x + f + 4 * dpr, y);
      x += f + 4 * dpr + ctx.measureText(String(yr)).width + 10 * dpr;
      if (x > view.w - 200 * dpr) break;
    }
    ctx.globalAlpha = 1;
    if (u.bg === 'map') { const a = '© OpenStreetMap contributors'; ctx.fillStyle = muted; ctx.fillText(a, view.w - pad - ctx.measureText(a).width, y); }
  }
  function setDay(dn, force) {
    dn = Math.max(d0, Math.min(d1, Math.floor(dn)));
    if (!force && dn === curDay) return;
    drawTo(dn); compose();
    scrub.value = String(dn - d0 + 1); dateEl.textContent = RP.dayStr(dn);
  }
  // A view change: everything at the current day, once.
  let viewPending = false;
  function redrawView() {
    if (viewPending) return;
    viewPending = true;
    requestAnimationFrame(() => { viewPending = false; if (!alive) return; drawBg(); clearAcc(); drawTo(curDay); compose(); });
  }

  size(); fit(u.frame); drawBg(); clearAcc(); setDay(d1, true);

  // ---- pan and zoom ----
  const zoomAt = (k, px, py) => {
    const wx = view.cx + (px - view.w / 2) / view.s, wy = view.cy + (py - view.h / 2) / view.s;
    view.s = Math.max(0.02, Math.min(4096, view.s * k));
    view.cx = wx - (px - view.w / 2) / view.s; view.cy = wy - (py - view.h / 2) / view.s;
    redrawView();
  };
  const local = e => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr]; };
  canvas.addEventListener('wheel', e => { e.preventDefault(); const [px, py] = local(e); zoomAt(e.deltaY < 0 ? 1.25 : 0.8, px, py); }, { passive: false });
  canvas.addEventListener('dblclick', e => { const [px, py] = local(e); zoomAt(2, px, py); });
  const pts = new Map();
  let pinch = 0;
  canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, local(e)); pinch = 0; });
  canvas.addEventListener('pointermove', e => {
    if (!pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId), cur = local(e);
    if (pts.size === 1) { view.cx -= (cur[0] - prev[0]) / view.s; view.cy -= (cur[1] - prev[1]) / view.s; redrawView(); }
    pts.set(e.pointerId, cur);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()], dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch) zoomAt(dist / pinch, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      pinch = dist;
    }
  });
  const up = e => { pts.delete(e.pointerId); pinch = 0; };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => { if (stage.clientWidth * dpr !== view.w) { size(); redrawView(); } });
    ro.observe(stage); cleanup.push(() => ro.disconnect());
  }

  // ---- the clock ----
  let playing = false, raf = 0, last = 0, pos = d1;
  const onEnd = [];
  function tick(now) {
    if (!playing || !alive) return;
    pos += ((now - last) / 1000) * (u.pace || 90); last = now;
    if (pos >= d1) { setDay(d1); setPlaying(false); onEnd.splice(0).forEach(f => f()); return; }
    setDay(pos);
    raf = requestAnimationFrame(tick);
  }
  function setPlaying(p) {
    playing = p; playBtn.textContent = p ? 'Pause' : 'Play';
    if (p) { if (curDay >= d1) { pos = d0; setDay(d0, true); } else pos = curDay; last = performance.now(); raf = requestAnimationFrame(tick); }
    else cancelAnimationFrame(raf);
  }
  playBtn.onclick = () => setPlaying(!playing);
  scrub.oninput = () => { pos = d0 + +scrub.value - 1; setDay(pos); };
  cleanup.push(() => { playing = false; cancelAnimationFrame(raf); });

  // ---- recording: the canvas as WebM, from the first day to the last ----
  let recorder = null;
  recBtn.onclick = () => {
    if (recorder) { recorder.stop(); return; }
    const MR = window.MediaRecorder;
    if (!MR || !canvas.captureStream) { toast('This browser cannot record a canvas (no MediaRecorder).'); return; }
    const mimeType = RP.pickMime(m => MR.isTypeSupported(m));
    if (!mimeType) { toast('This browser cannot record WebM video.'); return; }
    let stream;
    try { stream = canvas.captureStream(30); } catch (e) { toast('Recording was refused: ' + e.message); return; }
    const chunks = [];
    recorder = new MR(stream, { mimeType, videoBitsPerSecond: 8e6 });
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      recorder = null; recBtn.textContent = 'Record video'; recBtn.classList.remove('on');
      if (!chunks.length) return;
      const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' })), a = document.createElement('a');
      a.href = url; a.download = `run315-coverage-${RP.dayStr(d0)}-to-${RP.dayStr(curDay)}.webm`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    };
    recorder.start(250);
    recBtn.textContent = 'Stop recording'; recBtn.classList.add('on');
    setPlaying(false); pos = d0; setDay(d0, true);
    // Hold the last frame a moment, then stop. A redraw keeps frames coming while it holds.
    onEnd.push(() => setTimeout(() => { if (recorder) { compose(); setTimeout(() => recorder && recorder.stop(), 1500); } }, 300));
    setPlaying(true);
  };
  cleanup.push(() => { if (recorder) { try { recorder.ondataavailable = null; recorder.onstop = null; recorder.stop(); } catch { /* done */ } recorder = null; } });

  return stop;
}
