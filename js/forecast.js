// The weather ahead: Open-Meteo's hourly forecast at the athlete's usual start point, and
// the two things a plan needs from it -- when today is kindest for a run, and what the
// heat will cost at a given pace.
//
// Open-Meteo is free, keyless and CORS-enabled, so the browser asks it directly. Answers
// are cached in IndexedDB for an hour: a forecast changes slowly, and a page that redraws
// on every edit must not hammer a free service. A copy also lives in memory so the
// synchronous readers (podContext for the cowork export, the Today panel) can use it
// without awaiting anything.
//
// The costs come from lib/weather.js's penalty() -- a population heat curve, not this
// athlete's own -- so every adjusted pace here is an approximation, said as such.
import { idbGet, idbSet } from './store.js';
import { penalty } from './lib/weather.js';
import { tileBounds } from './lib/territory.js';
import * as D from './derive.js';

export const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';
export const TTL_MS = 3600e3;          // refetch after an hour
export const STALE_MS = 12 * 3600e3;   // a sync reader still uses a forecast this old, saying how old
// Eight days, not seven: a race exactly a week out needs its own day in the answer.
export const DAYS = 8;
const HOURLY = ['temperature_2m', 'apparent_temperature', 'dew_point_2m', 'relative_humidity_2m',
  'wind_speed_10m', 'precipitation_probability'];
export const DEFAULT_HOURS = { from: 6, to: 21 };

// Coordinates rounded to ~1 km: finer than a forecast resolves, coarse enough that two
// runs from the same front door share a cache entry.
export const cacheKey = (lat, lon) => 'wx:' + (+lat).toFixed(2) + ',' + (+lon).toFixed(2);

export function forecastUrl(lat, lon, days = DAYS) {
  const q = new URLSearchParams({ latitude: (+lat).toFixed(4), longitude: (+lon).toFixed(4),
    hourly: HOURLY.join(','), forecast_days: String(days), timezone: 'auto', wind_speed_unit: 'kmh' });
  return OPEN_METEO + '?' + q;
}

// Open-Meteo's column arrays -> one row per hour. Times are local to the location
// (timezone=auto), which for a home location is the athlete's own clock.
export function parseForecast(j) {
  const h = j && j.hourly;
  if (!h || !Array.isArray(h.time) || !h.time.length) return null;
  const col = (k, i) => { const v = (h[k] || [])[i]; return typeof v === 'number' && isFinite(v) ? v : null; };
  const hours = h.time.map((t, i) => ({
    t: String(t).slice(0, 16), day: String(t).slice(0, 10), hour: +String(t).slice(11, 13),
    temp: col('temperature_2m', i), feels: col('apparent_temperature', i), dew: col('dew_point_2m', i),
    rh: col('relative_humidity_2m', i), wind: col('wind_speed_10m', i), rain: col('precipitation_probability', i),
  })).filter(r => r.temp != null);
  return hours.length ? { lat: j.latitude, lon: j.longitude, tz: j.timezone || null, hours } : null;
}

// ---- the cache ----
const _mem = new Map();
let _lastKey = null;
// A cached forecast for this place (or the last one fetched), without waiting. null when
// none, or when it is too old to be worth reading.
export function cachedForecast(lat, lon, now = Date.now()) {
  const key = lat != null && lon != null ? cacheKey(lat, lon) : _lastKey;
  const e = key && _mem.get(key);
  return e && now - Date.parse(e.fetchedAt) < STALE_MS ? e : null;
}
export function _remember(key, e) { _mem.set(key, e); _lastKey = key; }   // exported for tests

export async function forecastFor(lat, lon, { fetchFn = globalThis.fetch, now = Date.now(), force = false } = {}) {
  if (lat == null || lon == null || !isFinite(lat) || !isFinite(lon)) throw new Error('No location for the forecast.');
  const key = cacheKey(lat, lon);
  let e = _mem.get(key) || null;
  if (!e) { try { e = (await idbGet('cache', key)) || null; } catch { e = null; } }
  if (e && !force && now - Date.parse(e.fetchedAt) < TTL_MS) { _remember(key, e); return e; }
  try {
    const r = await fetchFn(forecastUrl(lat, lon));
    if (!r.ok) throw new Error('Open-Meteo answered ' + r.status);
    const f = parseForecast(await r.json());
    if (!f) throw new Error('Open-Meteo sent no hourly forecast.');
    e = { ...f, fetchedAt: new Date(now).toISOString(), key };
    _remember(key, e);
    idbSet('cache', key, e).catch(() => {});
    idbSet('cache', 'wx:last', key).catch(() => {});
    return e;
  } catch (err) {
    if (e) { _remember(key, e); return { ...e, stale: true }; }   // offline: an old forecast beats none
    throw err;
  }
}
// One fetch attempt per place per ten minutes, for pages that fetch from mount() and redraw:
// an offline answer too old to show must not turn mount -> fetch -> redraw into a loop.
const _tried = new Map();
export function shouldFetch(lat, lon, now = Date.now()) {
  const k = cacheKey(lat, lon), t = _tried.get(k);
  if (t != null && now - t < 600e3) return false;
  _tried.set(k, now);
  return true;
}
// After a reload the memory copy is gone; put the last forecast back so the sync readers
// have it before any page asks again.
export async function warm() {
  try {
    const key = await idbGet('cache', 'wx:last');
    const e = key && await idbGet('cache', key);
    if (e && !_mem.has(key)) _remember(key, e);
  } catch { /* nothing cached: fine */ }
}
if (typeof indexedDB !== 'undefined') warm();

// ---- where ----
// profile.home if the athlete set one, else the centre of the most-run tile (where runs
// start from, near enough), else the start of the latest run with a track. null: ask.
export function defaultLocation(st) {
  const h = st.profile && st.profile.home;
  if (h && isFinite(h.lat) && isFinite(h.lon)) return { lat: +h.lat, lon: +h.lon, source: 'home' };
  let ts = null;
  try { ts = D.tileSummary(st); } catch { ts = null; }
  if (ts && ts.home) {
    const [s, w, n, e] = tileBounds(ts.home[0], ts.home[1]);
    return { lat: (s + n) / 2, lon: (w + e) / 2, source: 'most-run tile' };
  }
  const latest = Object.values(st.activities).filter(a => st.derived[a.id]?.p0 || st.derived[a.id]?.points?.length)
    .sort((a, b) => String(b.start).localeCompare(String(a.start)))[0];
  if (latest) { const d = st.derived[latest.id], [lat, lon] = d.p0 || d.points[0]; return { lat, lon, source: 'latest activity' }; }
  return null;
}

// ---- what it means for a run ----
const hourOf = v => (typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,2}/.test(v) ? parseInt(v, 10) : null);
export function normHours(h) {
  const from = hourOf(h && h.from), to = hourOf(h && h.to);
  const f = from != null && from >= 0 && from <= 23 ? from : DEFAULT_HOURS.from;
  const t = to != null && to >= 1 && to <= 24 ? to : DEFAULT_HOURS.to;
  return t > f ? { from: f, to: t } : { ...DEFAULT_HOURS };
}

// What one hour costs a run, in "percent slower"-like units: the heat penalty itself,
// plus wind above a breeze and the chance of rain. The weights are a judgement, not a
// measurement: 60% rain weighs about like 20 C of heat, a 30 km/h wind a little more.
export function hourCost(r) {
  const heat = penalty(r.temp, r.rh, r.dew) * 100;
  return heat + Math.max(0, (r.wind || 0) - 12) / 4 + (r.rain || 0) / 15;
}
const fmtH = h => String(h).padStart(2, '0') + ':00';

// The kindest window today for a run of `minutes` inside the athlete's hours: coolest
// dew point, least wind, least rain, as one cost. `notBefore` ('YYYY-MM-DDTHH:MM') drops
// hours already gone. -> {start, end, temp, dew, rh, wind, rain, penalty, cost, alternatives} | null.
export function bestWindow(hours, { day, from = DEFAULT_HOURS.from, to = DEFAULT_HOURS.to, minutes = 60, notBefore = null } = {}) {
  const today = (hours || []).filter(r => r.day === day);
  const need = Math.max(1, Math.ceil((minutes || 60) / 60));
  const cands = [];
  for (let i = 0; i < today.length; i++) {
    const s = today[i];
    if (s.hour < from || s.hour + need > to) continue;
    if (notBefore && s.t.slice(0, 13) < notBefore.slice(0, 13)) continue;   // the current hour still counts
    const win = today.slice(i, i + need);
    if (win.length < need || win[need - 1].hour !== s.hour + need - 1) continue;   // a gap in the data
    const mean = k => { const v = win.map(r => r[k]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const max = k => { const v = win.map(r => r[k]).filter(x => x != null); return v.length ? Math.max(...v) : null; };
    cands.push({ start: fmtH(s.hour), end: fmtH(s.hour + need), startHour: s.hour,
      temp: mean('temp'), feels: mean('feels'), dew: max('dew'), rh: mean('rh'), wind: max('wind'), rain: max('rain'),
      penalty: Math.max(...win.map(r => penalty(r.temp, r.rh, r.dew))),
      cost: win.reduce((a, r) => a + hourCost(r), 0) / need });
  }
  if (!cands.length) return null;
  const sorted = [...cands].sort((a, b) => a.cost - b.cost || a.startHour - b.startHour);
  const best = sorted[0], worst = sorted[sorted.length - 1];
  return { ...best, minutes: need * 60, worst: { start: worst.start, cost: worst.cost, penalty: worst.penalty },
    // Whether the choice of hour matters at all today: under a point of cost apart, it does not.
    matters: worst.cost - best.cost >= 1 };
}

// One day at a glance.
export function daySummary(hours, day) {
  const d = (hours || []).filter(r => r.day === day);
  if (!d.length) return null;
  const ext = (k, fn) => { const v = d.map(r => r[k]).filter(x => x != null); return v.length ? fn(...v) : null; };
  return { day, min_c: ext('temp', Math.min), max_c: ext('temp', Math.max), max_dew_c: ext('dew', Math.max),
    max_rain_pct: ext('rain', Math.max), max_wind_kph: ext('wind', Math.max) };
}

// A pace in these conditions: the neutral-conditions pace slowed by the heat penalty
// (lib/weather.adjust run backwards). Lower is faster; null in, null out.
export function heatPace(paceSPerKm, cond) {
  if (!paceSPerKm || !cond) return paceSPerKm || null;
  return paceSPerKm * (1 + penalty(cond.temp, cond.rh ?? null, cond.dew ?? null));
}
// [fast, slow] -> the same band in the heat, or null when the heat costs under half a
// percent (not worth a second number on the screen).
export function heatBand(band, cond) {
  if (!band || !cond) return null;
  const p = penalty(cond.temp, cond.rh ?? null, cond.dew ?? null);
  if (p < 0.005) return null;
  return [band[0] * (1 + p), band[1] * (1 + p)];
}
