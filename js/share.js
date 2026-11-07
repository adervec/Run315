// Collections and sharing, the browser half: privacy zones on the state, Nominatim for
// places, Open-Meteo for air quality, canvas share cards, downloads, and the panels other
// pages embed. The pure logic is js/collect.js.
//
// Network etiquette:
//   Nominatim  at most one request a second, one per ~2 km cluster of start points, each
//              answer cached forever in IndexedDB `cache` ('nom:<cell>'). No custom headers:
//              the browser's own Referer identifies the app, nothing personal is sent.
//   Open-Meteo one request per (0.1° cell, day), cached in `cache` ('aq:<cell>:<day>') and
//              shared by every run that starts there that day; fetched only when asked.
import { put } from './merge.js';
import { state, save, idbGet, idbSet, getDetailRec } from './store.js';
import * as D from './derive.js';
import * as C from './collect.js';
import { renderChart } from './charts.js';
import { html, raw, esc, toast, useCss, day } from './ui.js';

const nowIso = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const n0 = v => Math.round(v || 0).toLocaleString('en-US');

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------
// points [[lat, lon, ...]] -> the points that may be shown (zones removed, ends trimmed as set).
export const applyPrivacy = (points, opts = C.privacyOf(state)) => C.applyPrivacyWith(points, opts);
// The same as separate stretches, for drawing (no line across a zone).
export const privateTrack = (points, opts = C.privacyOf(state)) => C.privateSegments(points, opts);
export function setPrivacy(p) {
  state.profile = { ...state.profile, privacy: { zones: p.zones || [], trim_m: p.trim_m || 0 }, u: nowIso() };
  save('edit');
}

const PRIV_CSS = `
.privzones { list-style: none; margin: 0 0 10px; padding: 0; }
.privzones li { display: flex; gap: 10px; align-items: center; border-top: 1px solid var(--line); padding: 6px 0; font: 13px var(--mono); }
.privzones li button { margin-left: auto; }
.privform { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: end; font-size: 13px; }
.privform label { display: flex; flex-direction: column; gap: 2px; color: var(--muted); }
.privform input[type=number] { width: 120px; padding: 4px 6px; }
`;
function privacyBody() {
  const p = C.privacyOf(state);
  return html`<ul class="privzones">${p.zones.length ? p.zones.map((z, i) => html`<li><span>${z.lat.toFixed(4)}, ${z.lon.toFixed(4)}</span>
      <span class="dim">${n0(z.radius_m)} m</span><button type="button" class="btn-quiet" data-priv-del="${i}">Remove</button></li>`)
    : html`<li class="dim">No zones yet: every share shows the whole track.</li>`}</ul>
    <div class="privform">
      <label>Latitude <input type="number" step="0.0001" data-priv="lat"></label>
      <label>Longitude <input type="number" step="0.0001" data-priv="lon"></label>
      <label>Radius (m) <input type="number" step="50" min="100" value="400" data-priv="r"></label>
      <button type="button" class="btn" data-priv-add>Add zone</button>
      <button type="button" class="btn btn-ghost" data-priv-home>Use my usual start</button>
    </div>
    <p style="margin:10px 0 0;font-size:13px"><label><input type="checkbox" data-priv-trim ${p.trim_m ? 'checked' : ''}> Also trim the first and last ${C.DEFAULT_TRIM_M} m of every shared track</label></p>`;
}
// The Sync & cowork (or records) panel: markup, then mountPrivacy(el) wires it.
export function privacyPanel() {
  useCss('privacy', PRIV_CSS);
  return html`<section class="panel" data-privacy>
    <div class="panel-head"><p class="eyebrow">Privacy zones</p><p class="panel-note">applied to every share card, poster and track wall</p></div>
    <div data-priv-body>${privacyBody()}</div>
    <p class="stat-hint">Anything inside a zone is cut out of shared images, and the line is broken there rather than drawn across.
      Zones sync with your profile. Your own maps on this device still show everything.</p></section>`;
}
export function mountPrivacy(el) {
  const root = el && el.querySelector('[data-privacy]');
  if (!root) return;
  const body = root.querySelector('[data-priv-body]');
  const redraw = () => { body.innerHTML = String(privacyBody()); };
  root.addEventListener('click', async e => {
    const t = e.target.closest('button,input');
    if (!t) return;
    const p = C.privacyOf(state);
    if (t.dataset.privDel != null) { p.zones.splice(+t.dataset.privDel, 1); setPrivacy(p); redraw(); }
    else if (t.hasAttribute('data-priv-add')) {
      const v = k => parseFloat(root.querySelector(`[data-priv="${k}"]`).value);
      const lat = v('lat'), lon = v('lon'), r = v('r');
      if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && r >= 50)) { toast('A zone needs a latitude, a longitude and a radius of at least 50 m.'); return; }
      p.zones.push({ lat: +lat.toFixed(5), lon: +lon.toFixed(5), radius_m: Math.round(r) }); setPrivacy(p); redraw();
    } else if (t.hasAttribute('data-priv-home')) {
      const { homePoint } = await import('./cities.js');
      const h = homePoint(state);
      if (!h) { toast('No start points yet to take it from.'); return; }
      root.querySelector('[data-priv="lat"]').value = h[0].toFixed(4);
      root.querySelector('[data-priv="lon"]').value = h[1].toFixed(4);
    } else if (t.hasAttribute('data-priv-trim')) { p.trim_m = t.checked ? C.DEFAULT_TRIM_M : 0; setPrivacy(p); }
  });
}

// ---------------------------------------------------------------------------
// Downloads and canvases
// ---------------------------------------------------------------------------
export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
export const toBlob = canvas => new Promise(res => canvas.toBlob(res, 'image/png'));
export const slug = s => String(s || 'run315').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'run315';
const INK = '#e8ecf2', FAINT = '#8b96a8', TEAL = '#3fb8c4', BG0 = '#0d1117', BG1 = '#14202a';
const FONT = 'Helvetica, Arial, sans-serif';
function cardBase(w, h) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const g = cv.getContext('2d'), grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, BG1); grad.addColorStop(1, BG0);
  g.fillStyle = grad; g.fillRect(0, 0, w, h);
  return [cv, g];
}
function wordmark(g, w, h) {
  g.fillStyle = INK; g.font = `800 34px ${FONT}`; g.textAlign = 'right'; g.textBaseline = 'alphabetic';
  g.fillText('RUN315', w - 60, h - 56); g.textAlign = 'left';
}
// Pixel segments onto a canvas, with a soft glow under the line.
function strokeTrack(g, pix, width = 6, colour = TEAL, glow = true) {
  g.lineJoin = 'round'; g.lineCap = 'round';
  for (const pass of glow ? [[width * 3, 'rgba(63,184,196,0.18)'], [width, colour]] : [[width, colour]]) {
    g.lineWidth = pass[0]; g.strokeStyle = pass[1];
    for (const seg of pix) { g.beginPath(); seg.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); }
  }
}
function fitText(g, text, maxW, size, weight = 800) {
  let s = size;
  do { g.font = `${weight} ${s}px ${FONT}`; s -= 2; } while (g.measureText(text).width > maxW && s > 18);
}

// ---------------------------------------------------------------------------
// Share card
// ---------------------------------------------------------------------------
// One activity -> a PNG Blob: the track (privacy applied, on a plain background), its name
// and date, the chosen stats, the wordmark. stats: keys of C.CARD_STATS.
export async function shareCard(id, { stats = C.CARD_STATS.map(s => s[0]), w = 1080, h = 1350 } = {}) {
  const a = state.activities[id];
  if (!a) throw new Error('No such activity');
  let segs = [];
  if (!D.isVirtual(a)) {
    const det = await D.getDetail(id).catch(() => null);
    segs = privateTrack(det && det.points);
  }
  const [cv, g] = cardBase(w, h);
  const mapTop = 80, mapH = h - 520;
  if (segs.length) strokeTrack(g, C.fitSegments(segs, w - 120, mapH, 30).map(s => s.map(([x, y]) => [x + 60, y + mapTop])), 7);
  else { g.fillStyle = FAINT; g.font = `500 28px ${FONT}`; g.fillText(D.isVirtual(a) ? 'Indoor / virtual: no map' : 'No track to draw', 60, mapTop + 40); }
  g.fillStyle = FAINT; g.font = `500 30px ${FONT}`;
  g.fillText(new Date(a.start).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), 60, h - 380);
  g.fillStyle = INK; fitText(g, a.name || 'Run', w - 120, 64);
  g.fillText(a.name || 'Run', 60, h - 310);
  const rows = C.cardStats(a, new Set(stats)), colW = (w - 120) / Math.max(1, Math.min(rows.length, 3));
  rows.forEach(([label, value], i) => {
    const x = 60 + (i % 3) * colW, y = h - 220 + Math.floor(i / 3) * 110;
    g.fillStyle = FAINT; g.font = `600 22px ${FONT}`; g.fillText(label.toUpperCase(), x, y - 46);
    g.fillStyle = INK; g.font = `800 50px ${FONT}`; g.fillText(value, x, y + 4);
  });
  wordmark(g, w, h);
  return toBlob(cv);
}
const SHARE_CSS = `
.sharecard { position: relative; display: inline-block; }
.sharecard > summary { list-style: none; cursor: pointer; }
.sharecard > summary::-webkit-details-marker { display: none; }
.sharecard .sharebox { position: absolute; right: 0; z-index: 20; margin-top: 6px; background: var(--surface); border: 1px solid var(--line);
  border-radius: 6px; padding: 12px; width: min(280px, 80vw); box-shadow: 0 6px 24px rgba(0,0,0,.18); font-size: 13px; }
.sharecard .sharebox label { display: block; margin: 3px 0; }
.sharecard .sharebox img { width: 100%; margin-top: 8px; border-radius: 4px; }
`;
// A button (with a little menu of which stats to show) for the activity page's head.
export function shareButton(id) {
  useCss('sharecard', SHARE_CSS);
  listen();
  return html`<details class="sharecard" data-share="${id}"><summary class="btn btn-ghost">Share card</summary>
    <div class="sharebox">${C.CARD_STATS.map(([k, l]) => html`<label><input type="checkbox" data-share-stat="${k}" checked> ${l}</label>`)}
      <p style="margin:8px 0 0"><button type="button" class="btn" data-share-go>Download PNG</button></p>
      <p class="dim" style="margin:6px 0 0">Privacy zones apply. <a class="quiet-link" href="#/records">Set them</a></p></div></details>`;
}
let _listening = false;
function listen() {
  if (_listening || typeof document === 'undefined') return;
  _listening = true;
  document.addEventListener('click', async e => {
    const b = e.target.closest && e.target.closest('[data-share-go]');
    if (!b) return;
    const box = b.closest('[data-share]'), id = box.dataset.share;
    const stats = [...box.querySelectorAll('[data-share-stat]')].filter(c => c.checked).map(c => c.dataset.shareStat);
    b.disabled = true;
    try {
      const blob = await shareCard(id, { stats });
      const a = state.activities[id];
      download(`${String(a?.start || '').slice(0, 10)}-${slug(a?.name)}.png`, blob);
    } catch (err) { toast('The card did not draw: ' + err.message); }
    b.disabled = false;
  });
}

// ---------------------------------------------------------------------------
// Eddington panel (for #/achievements and #/records)
// ---------------------------------------------------------------------------
function eddRow(label, e, unit) {
  const nx = e.next.slice(0, 3);
  return html`<tr><td>${label}</td><td class="num"><b>${e.E}</b></td>
    <td class="dim">${nx.map(x => html`<span style="white-space:nowrap">${x.n} ${unit}: ${x.need} more day${x.need === 1 ? '' : 's'}</span>`).reduce((acc, v, i) => (i ? html`${acc} · ${v}` : v), '')}</td></tr>`;
}
export function eddingtonPanel(st = state, { link = true } = {}) {
  const e = C.eddington(st), hasRide = e.ride.km.days > 0;
  if (!e.run.km.days && !hasRide) return '';
  const curve = e.run.km.days ? e.run.km : e.ride.km;
  const top = Math.min(curve.curve.length, Math.max(curve.E * 2, 20));
  let chart = '';
  try {
    chart = renderChart({ type: 'line', title: `Days at or over n km (${e.run.km.days ? 'running' : 'cycling'})`,
      note: 'Where the two lines cross is your Eddington number.',
      x: { label: 'n (km)', type: 'linear' }, y: { label: 'days', zero: true },
      series: [{ name: 'Days at or over n km', points: curve.curve.slice(0, top) },
        { name: 'n (the line to cross)', points: curve.curve.slice(0, top).map(([n]) => [n, n]) }] });
  } catch { chart = ''; }
  return html`<section class="panel" data-hook="eddington">
    <div class="panel-head"><p class="eyebrow">Eddington number</p>${link ? html`<p class="panel-note"><a class="quiet-link" href="#/records">Records &amp; collections</a></p>` : ''}</div>
    <div class="table-scroll"><table><thead><tr><th></th><th class="num">E</th><th>Days still needed for E+1, E+2, E+3</th></tr></thead><tbody>
      ${e.run.km.days ? html`${eddRow('Running, km', e.run.km, 'km')}${eddRow('Running, miles', e.run.mi, 'mi')}` : ''}
      ${hasRide ? html`${eddRow('Cycling, km', e.ride.km, 'km')}${eddRow('Cycling, miles', e.ride.mi, 'mi')}` : ''}
    </tbody></table></div>
    ${chart ? raw(chart) : ''}
    <p class="stat-hint">E is the largest number such that you have covered at least E on at least E different days. Two runs on one day add up.
      It only ever goes up, and each step is harder than the last.</p></section>`;
}

// ---------------------------------------------------------------------------
// Places (Nominatim)
// ---------------------------------------------------------------------------
// Cells from the synced places collection, plus any left in the profile by an earlier version.
export const placesCells = (st = state) => {
  const out = { ...((st.profile && st.profile.places && st.profile.places.cells) || {}) };
  for (const [k, r] of Object.entries(st.places || {})) if (r && r.p) out[k] = r.p;
  return out;
};
let _placing = null;
// Geocode every cluster that has no place yet: cache first, else one request a second.
// -> {done, fetched, failed}. One run at a time; a second call joins the first.
export function resolvePlaces({ onProgress, signal, fetchJson = u => fetch(u).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }) } = {}) {
  if (_placing) return _placing;
  _placing = (async () => {
    const clusters = C.startClusters(state), todo = C.pendingCells(clusters, placesCells());
    const byKey = new Map(clusters.map(c => [c.key, c]));
    const found = {};
    let fetched = 0, failed = 0, done = 0, last = 0;
    const flush = () => {
      if (!Object.keys(found).length) return;
      for (const [k, p] of Object.entries(found)) put(state, 'places', k, { p });
      for (const k of Object.keys(found)) delete found[k];
      save('edit');
    };
    for (const k of todo) {
      if (signal && signal.aborted) break;
      const c = byKey.get(k);
      let p = await idbGet('cache', 'nom:' + k).catch(() => null);
      if (p === undefined || p === null) {
        const wait = 1100 - (Date.now() - last);
        if (wait > 0) await sleep(wait);
        last = Date.now();
        try { p = C.parseNominatim(await fetchJson(C.nominatimUrl(c.lat, c.lon))) || ['', '', '']; fetched++; await idbSet('cache', 'nom:' + k, p); }
        catch { failed++; p = null; }
      }
      if (p) found[k] = p;
      done++;
      onProgress && onProgress(done, todo.length);
      if (done % 10 === 0) flush();
    }
    flush();
    return { done, fetched, failed, total: todo.length };
  })().finally(() => { _placing = null; });
  return _placing;
}

// ---------------------------------------------------------------------------
// Air quality (Open-Meteo)
// ---------------------------------------------------------------------------
const aqCell = (lat, lon) => (Math.round(lat * 10) / 10).toFixed(1) + ',' + (Math.round(lon * 10) / 10).toFixed(1);
// Outdoor activities that have a start point, with whether the archive covers them.
export function airTargets(st = state, today = new Date().toISOString().slice(0, 10)) {
  const out = [];
  for (const a of Object.values(st.activities)) {
    const p = st.derived?.[a.id]?.p0;
    if (!p || D.isVirtual(a)) continue;
    const dayK = String(a.start).slice(0, 10);
    out.push({ id: a.id, lat: p[0], lon: p[1], day: dayK, start: a.start, cov: C.airCoverage(p[0], p[1], dayK, today) });
  }
  return out.sort((x, y) => String(y.start).localeCompare(String(x.start)));
}
async function dayJson(lat, lon, dayK) {
  const key = 'aq:' + aqCell(lat, lon) + ':' + dayK;
  const hit = await idbGet('cache', key).catch(() => null);
  if (hit) return hit;
  const r = await fetch(C.airUrl(lat, lon, dayK));
  if (!r.ok) throw new Error('Open-Meteo ' + r.status);
  const j = await r.json();
  const keep = { hourly: j.hourly || null, at: nowIso() };
  // An empty answer for a recent day may fill in later; an old one never will.
  const old = dayK < new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10);
  if (j.hourly && (old || C.parseAir(j, dayK + 'T12:00'))) await idbSet('cache', key, keep);
  return keep;
}
// One activity's air at its start hour: {pm2_5, pm10, us_aqi, ozone, pollen?, hour, band} or
// null (indoor, no start point, outside the archive, or nothing recorded). `cachedOnly` never
// touches the network.
export async function airFor(id, { cachedOnly = false } = {}) {
  const a = state.activities[id], p = state.derived?.[id]?.p0;
  if (!a || !p || D.isVirtual(a)) return null;
  const dayK = String(a.start).slice(0, 10);
  if (!C.airCoverage(p[0], p[1], dayK).ok) return null;
  let j;
  if (cachedOnly) j = await idbGet('cache', 'aq:' + aqCell(p[0], p[1]) + ':' + dayK).catch(() => null);
  else j = await dayJson(p[0], p[1], dayK);
  const v = j && C.parseAir(j, a.start);
  return v ? { ...v, band: C.aqiBand(v.us_aqi) } : null;
}
// Many, gently: sequential, a short pause between network calls. -> how many have air.
export async function airMany(ids, { onProgress, signal } = {}) {
  let n = 0, i = 0;
  for (const id of ids) {
    if (signal && signal.aborted) break;
    const before = Date.now();
    try { if (await airFor(id)) n++; } catch { /* next */ }
    onProgress && onProgress(++i, ids.length);
    if (Date.now() - before > 30) await sleep(150);   // it went to the network
  }
  return n;
}
const fmtV = (v, u) => (v == null ? '—' : (v >= 10 ? Math.round(v) : v.toFixed(1)) + (u ? ' ' + u : ''));
function airBody(v, cov) {
  if (!v) return html`<p class="dim" style="margin:0">${cov && !cov.ok ? `No air-quality record for this run: it is ${cov.why}.` : 'Nothing recorded for this hour and place.'}</p>`;
  const pol = v.pollen ? Object.entries(v.pollen).filter(([, x]) => x > 0) : [];
  return html`<div class="digest">
    <div class="stat"><div class="stat-value">${v.us_aqi == null ? '—' : Math.round(v.us_aqi)}</div><div class="stat-label">US AQI</div><div class="stat-hint">${v.band || ''}</div></div>
    <div class="stat"><div class="stat-value">${fmtV(v.pm2_5)}</div><div class="stat-label">PM2.5 µg/m³</div></div>
    <div class="stat"><div class="stat-value">${fmtV(v.pm10)}</div><div class="stat-label">PM10 µg/m³</div></div>
    <div class="stat"><div class="stat-value">${fmtV(v.ozone)}</div><div class="stat-label">Ozone µg/m³</div></div>
  </div>${pol.length ? html`<p class="stat-hint">Pollen (grains/m³): ${pol.map(([k, x]) => `${k} ${fmtV(x)}`).join(' · ')}</p>` : ''}
  <p class="stat-hint">Modelled (CAMS via Open-Meteo) for the start hour, ${esc(String(v.hour).slice(11))} local, on a ~10–40 km grid: the air of the area, not of your street.</p>`;
}
// The activity page's panel: a placeholder, filled by mountAir(el, id). '' for indoor runs
// and runs without a start point.
export function airPanel(id) {
  const a = state.activities[id], p = state.derived?.[id]?.p0;
  if (!a || !p || D.isVirtual(a)) return '';
  const cov = C.airCoverage(p[0], p[1], String(a.start).slice(0, 10));
  return html`<section class="panel" data-air="${id}">
    <div class="panel-head"><p class="eyebrow">Air quality</p><p class="panel-note"><a class="quiet-link" href="#/records">Against your pace</a></p></div>
    <div data-air-body>${cov.ok ? html`<p class="dim" style="margin:0">Looking up the air…</p>` : airBody(null, cov)}</div></section>`;
}
export async function mountAir(el, id) {
  const box = el && el.querySelector(`[data-air="${CSS.escape(id)}"] [data-air-body]`);
  if (!box) return;
  const a = state.activities[id], p = state.derived?.[id]?.p0;
  const cov = C.airCoverage(p[0], p[1], String(a.start).slice(0, 10));
  if (!cov.ok) return;
  try { const v = await airFor(id); if (box.isConnected) box.innerHTML = String(airBody(v, cov)); }
  catch (e) { if (box.isConnected) box.innerHTML = String(html`<p class="dim" style="margin:0">The air-quality service did not answer (${e.message}).</p>`); }
}
// Rows for C.airCorrelation from what is cached: steady runs (efficiency rows: pace already
// corrected for hills and heat) that have air.
export async function airRows(st = state) {
  const out = [];
  for (const r of D.efficiencyRows(st)) {
    const v = await airFor(r.id, { cachedOnly: true }).catch(() => null);
    if (v && v.us_aqi != null) out.push({ id: r.id, aqi: v.us_aqi, pm2_5: v.pm2_5, pace: 60000 / r.speed_m_min, hr: r.hr, date: r.date });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tracks for the wall, posters and the year card: this device's detail only (no Drive
// fetch per thumbnail), privacy applied.
// ---------------------------------------------------------------------------
export async function localTrack(id, n = 120) {
  const det = await getDetailRec(id).catch(() => null);
  const pts = det && det.points;
  if (!pts || pts.length < 2) return null;
  return privateTrack(C.thin(pts, n));
}
export { cardBase, strokeTrack, wordmark, fitText, INK, FAINT, TEAL, FONT, day };
