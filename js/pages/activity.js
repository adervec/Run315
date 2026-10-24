// One activity in full: the headline numbers, the session it turned out to be, its
// form, why it stopped, where it went, its splits and best efforts, and what the
// watch actually recorded. Everything the analysis kept (state.derived) shows on any
// device; the per-second stream adds running form and a full-resolution map where it
// is available (this device, or Drive).
import { state } from '../store.js';
import * as D from '../derive.js';
import * as F from '../lib/fitness.js';
import * as FM from '../lib/form.js';
import * as WX from '../lib/weather.js';
import { fetchStream, driveOn } from '../drive.js';
import { html, pageHead, emptyState, fmtTime, fmtPace, typeLabel, useCss } from '../ui.js';

export const title = p => state.activities[p && p.id]?.name || 'Activity';

const CSS = `
.act-src { font-family: var(--mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); margin-left: 8px; }
.act-src.strava { color: #fc4c02; }
#actmap { height: 380px; border-radius: 3px; background: var(--ground); }
.channels { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px 18px; }
.channels li { display: flex; justify-content: space-between; gap: 10px; border-top: 1px solid var(--line); padding: 6px 0; font-size: 14px; }
.channels .num { font-family: var(--mono); font-size: 12px; color: var(--muted); }
@media (max-width: 520px) { #actmap { height: 300px; } }
`;

// The channels samplesFromChannels folds into the 10-wide sample rows; anything else the
// watch recorded (power, respiration, temperature...) nothing used to show.
const SAMPLE_CHANNELS = new Set(['seconds', 'metres', 'hr', 'lat', 'lon', 'elevation_m', 'gps_elevation_m',
  'cadence_spm', 'run_cadence_spm', 'stride_m', 'gct_ms', 'vertical_oscillation_cm']);
const sgn = (v, d = 0) => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(d);
const fade = v => (v > 0.02 ? 'behind' : v < -0.02 ? 'ahead' : 'dim');

// What mount() needs to draw: the last render's route.
let _view = { id: null, track: null };

function dateLine(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' })
    + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
function sourceLabel(a, rec) {
  const both = a.source === 'garmin' && a.strava_id;
  const from = both ? 'Garmin + Strava' : a.source === 'strava' ? 'Strava' : 'Garmin';
  return from + (rec ? ' · stream from ' + (rec.src === 'strava' ? 'Strava' : 'Garmin') : '');
}

export async function render(params = {}) {
  useCss('activity', CSS);
  const id = params.id, act = state.activities[id];
  _view = { id, track: null };
  if (!act) return html`${pageHead('Activity')}${emptyState('No such activity',
    'It may have been merged into its Garmin twin, or not synced to this device yet.',
    html`<a class="btn" href="#/activities">All activities</a>`)}`;

  const isRun = F.RUN_TYPES.has(act.type);
  const acts = D.activities(state);
  const summary = D.summary(state);
  const thrHr = summary ? summary.threshold_hr : null, thrPace = summary ? summary.threshold_pace : null;

  // The stream, if any device has it: local first, then Drive. A phone without a Drive
  // copy, or a ride with no capture, still gets everything the analysis kept.
  let rec = null;
  try { rec = await fetchStream(id); } catch (e) { console.warn('stream', e); }
  const samples = D.samplesOf(rec);
  const hasStream = samples.length > 1;
  const der = state.derived[id] || null;
  // Prefer what was derived (identical, and already done); compute from the stream only
  // when this activity was never derived.
  const td = hasStream && !der ? samples.map(s => [s[0], s[1]]) : null;
  const splits = der ? der.splits || [] : td && isRun ? F.kmSplits(td) : [];
  const curve = der ? der.efforts || {} : td && isRun ? F.bestEffortCurve(td) : {};
  const drift = der ? der.drift : hasStream ? F.hrDrift(samples.map(s => [s[0], s[1], s[2]])) : null;
  const fullTrack = hasStream ? samples.filter(s => s[3] != null && s[4] != null).map(s => [s[3], s[4]]) : [];
  const track = fullTrack.length ? fullTrack : der && der.points ? der.points : [];
  _view.track = track.length > 1 ? track : null;
  const load = summary ? F.activityLoad(act, thrHr, F.thresholds(acts)[1]) : null;

  // Where does this run sit against the athlete's records at each distance?
  const prs = new Map(D.personalRecords(state).map(([d, s]) => [d, s]));
  const efforts = Object.entries(curve).map(([d, s]) => [+d, s]).sort((a, b) => a[0] - b[0])
    .map(([d, s]) => [d, s, prs.get(d) ?? null, prs.has(d) ? s <= prs.get(d) + 0.5 : false]);

  const shape = hasStream ? FM.summarise(samples) : null;
  const formDrift = hasStream ? FM.fatigueDrift(samples) : null;
  const formByPace = hasStream ? FM.cadenceByPace(samples) : null;
  const findings = shape ? FM.assess(shape, formDrift, formByPace) : [];

  const wx = state.weather[id];
  let wxLine = null, adjustedPace = null;
  if (wx && wx.temp_c != null) {
    wxLine = WX.describe(wx.temp_c, wx.humidity, wx.dew_point_c);
    if (act.distance_m && act.moving_s) {
      const rawPace = act.moving_s / (act.distance_m / 1000);
      const corrected = WX.adjust(rawPace, wx.temp_c, wx.humidity, wx.dew_point_c);
      if (corrected && Math.abs(corrected - rawPace) >= 1) adjustedPace = corrected;
    }
  }

  const st = der && der.stops;
  const breaks = st ? { ...st, crossings: st.counts?.crossing || 0, rests: st.counts?.rest || 0, climbs: st.counts?.climb || 0,
    exhaustion: st.counts?.exhaustion || 0, eased: st.counts?.eased || 0 } : null;

  const session = der && der.session;
  let prescribed = null, band = null;
  if (summary) for (const [name, , fast, slow] of summary.paces) if (name === 'Interval') prescribed = [fast, slow];
  if (prescribed && session) {
    const [lo, hi] = prescribed, paces = session.reps.map(r => r.pace);
    band = { quicker: paces.filter(p => p < lo).length, inside: paces.filter(p => lo <= p && p <= hi).length,
      slower: paces.filter(p => p > hi).length, total: paces.length };
  }

  const splitMax = Math.max(0, ...splits.map(s => s[2])), splitMin = splits.length ? Math.min(...splits.map(s => s[2])) : 0;
  const evenness = F.splitEvenness(splits);
  const kind = isRun ? F.classifyRun(act, thrHr, thrPace) : act.type;
  const laps = (state.laps[id] && state.laps[id].laps) || [];
  const extra = rec && rec.channels ? Object.keys(rec.channels).filter(k => !SAMPLE_CHANNELS.has(k) && Array.isArray(rec.channels[k])) : [];

  return html`
    ${pageHead(act.name, dateLine(act.start), html`<a class="btn btn-ghost" href="#/activities">All activities</a>`)}

    <section class="panel">
      <div class="panel-head">
        <p class="eyebrow">${typeLabel(act.type)}${kind && kind !== act.type ? html` · read as <b>${kind}</b>` : ''}
          <span class="act-src ${act.strava_id ? 'strava' : ''}" title="Where this activity came from">${sourceLabel(act, hasStream ? rec : null)}</span></p>
      </div>
      <div class="race-headline">
        <div><div class="projected measured">${((act.distance_m || 0) / 1000).toFixed(2)} <small>km</small></div></div>
        <div><div class="projected measured">${fmtTime(act.moving_s)} <small>moving</small></div></div>
        <div><div class="projected measured">${F.fmtEffort(act)} <small>average</small></div></div>
        ${adjustedPace ? html`<div><div class="projected">${fmtPace(adjustedPace, 1000)} <small>corrected for the heat</small></div></div>` : ''}
        ${act.avg_hr ? html`<div><div class="projected measured">${act.avg_hr.toFixed(0)}
          <small>avg bpm${act.max_hr ? html` · max ${act.max_hr.toFixed(0)}` : ''}</small></div></div>` : ''}
        ${load ? html`<div><div class="projected measured">${load.toFixed(0)} <small>training load</small></div></div>` : ''}
      </div>
    </section>

    ${session ? sessionPanel(session, prescribed, band) : ''}

    ${wxLine ? html`<p class="wx-line">${wxLine}</p>` : ''}

    ${shape && findings.length ? formPanel(shape, formDrift, findings) : ''}

    ${breaks ? breaksPanel(breaks) : ''}

    ${_view.track ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">Where you ran</p>
        <p class="panel-note">${track.length} points${fullTrack.length ? '' : ' · thinned for sync'}</p></div>
      <div id="actmap"></div>
    </section>` : ''}

    ${splits.length ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">Kilometre splits</p>
        <p class="panel-note">${evenness == null ? '' : evenness < 0.03 ? 'Very even pacing.'
          : evenness < 0.08 ? 'Steady, with some variation.' : 'Uneven — a workout, or a run that got away from you.'}</p></div>
      <div class="splits">${splits.map(([k, , p]) => {
        const span = splitMax - splitMin, frac = span > 1 ? (p - splitMin) / span : 0.5;
        return html`<div class="split-row"><span class="split-k">${k}</span>
          <span class="split-bar-wrap"><span class="split-bar" style="width:${(45 + 55 * (1 - frac)).toFixed(0)}%"></span></span>
          <span class="split-pace">${fmtPace(p, 1000)}</span></div>`;
      })}</div>
      <p class="stat-hint" style="margin-top:10px">Longer bar is faster. Last split may be partial.</p>
    </section>` : ''}

    ${laps.length ? lapsPanel(laps) : ''}

    <div class="grid-half">
      ${efforts.length ? html`<section class="panel">
        <div class="panel-head"><p class="eyebrow">Best efforts in this run</p></div>
        <div class="table-scroll"><table>
          <thead><tr><th>Distance</th><th class="num">Time</th><th class="num">Pace</th><th class="num">vs record</th></tr></thead>
          <tbody>${efforts.map(([d, s, pr, isPr]) => html`<tr>
            <td>${(d / 1000).toFixed(2)} km${isPr ? html` <span class="tag">PR</span>` : ''}</td>
            <td class="num actual">${fmtTime(s)}</td>
            <td class="num dim">${fmtPace(s, d)}</td>
            <td class="num dim">${pr ? (s > pr + 0.5 ? '+' + fmtTime(s - pr) : 'record') : '—'}</td>
          </tr>`)}</tbody>
        </table></div>
      </section>` : ''}

      <section class="panel">
        <div class="panel-head"><p class="eyebrow">Signals</p></div>
        ${drift != null ? html`<div class="stat">
          <div class="stat-value ${drift > 8 ? 'risk' : ''}">${sgn(drift, 1)}%</div>
          <div class="stat-label">Cardiac drift</div>
          <div class="stat-hint">${drift < 3 ? 'Well within aerobic range. This effort was sustainable.'
            : drift < 8 ? 'Some drift — warm conditions, or the top end of easy.'
            : 'High drift. Hotter, longer, or harder than it should have been.'}</div>
        </div>` : ''}
        ${act.elev_gain_m ? html`<div class="stat"><div class="stat-value">${act.elev_gain_m.toFixed(0)}</div><div class="stat-label">Metres climbed</div></div>` : ''}
        ${act.calories ? html`<div class="stat"><div class="stat-value">${act.calories.toFixed(0)}</div><div class="stat-label">Calories</div></div>` : ''}
        ${extra.length ? channelsList(rec.channels, extra) : ''}
        ${hasStream ? '' : html`<div class="empty"><p>${der
          ? 'The per-second stream is not on this device, so running form and the full-resolution map are missing. Splits, efforts, stops and the route above come from the analysis the importing device synced. ' + (state.local && driveOn() ? 'Drive has no copy of the stream yet; the importing device uploads it on its next sync.' : 'Connect Google Drive and the stream comes down with it.')
          : 'No per-second data for this activity yet, so no splits, efforts, form or route. It fills in once the device that imports from Garmin or Strava has the stream — '}${der ? '' : html`<a class="quiet-link" href="#/sync">Sync &amp; cowork</a>.`}</p></div>`}
      </section>
    </div>`;
}

function sessionPanel(session, prescribed, band) {
  const paces = session.reps.map(r => r.pace), slow = Math.max(...paces), fast = Math.min(...paces), span = slow - fast;
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">Session · ${session.name} ${session.on_track ? html`<span class="badge-track">TRACK</span>` : ''}</p>
      <p class="panel-note"><a class="quiet-link" href="#/sessions">All sessions</a></p>
    </div>
    <div class="race-headline" style="margin-bottom:20px">
      <div><div class="projected measured">${session.reps.length} <small>reps</small></div></div>
      <div><div class="projected measured">${fmtPace(session.avg_pace, 1000)} <small>average rep</small></div></div>
      <div><div class="projected measured">${(session.work_m / 1000).toFixed(2)} <small>km at effort</small></div></div>
      ${session.consistency != null ? html`<div><div class="projected measured">±${(session.consistency * 100).toFixed(1)}<small>% spread</small></div></div>` : ''}
      ${session.fade != null ? html`<div><div class="projected ${session.fade > 0.02 ? 'behind' : session.fade < -0.02 ? 'ahead' : 'measured'}">
        ${sgn(session.fade * 100, 1)}<small>% fade</small></div></div>` : ''}
    </div>
    ${band ? html`<p class="stat-hint" style="margin-bottom:14px">
      Your interval band right now is ${fmtTime(prescribed[0])}–${fmtPace(prescribed[1], 1000)}.
      ${band.quicker === band.total ? html`Every rep was <span class="ahead">quicker than that</span> — either a good day,
          or the band is stale and your next hard effort will move it.`
        : band.slower === band.total ? html`Every rep came in <span class="behind">slower than that</span>.`
        : html`${band.inside} of ${band.total} landed inside it${band.quicker ? html`, ${band.quicker} <span class="ahead">quicker</span>` : ''}${band.slower ? html`, ${band.slower} <span class="behind">slower</span>` : ''}.`}
    </p>` : ''}
    <div class="table-scroll"><table>
      <thead><tr><th>Rep</th><th class="num">Distance</th><th class="num">Time</th>
        <th class="num">Pace</th><th class="num">HR</th><th class="num">Recovery</th><th></th></tr></thead>
      <tbody>${session.reps.map(r => html`<tr>
        <td>${r.n}</td>
        <td class="num">${r.snapped_m ? html`${r.snapped_m} m <span class="dim">(${r.distance_m.toFixed(0)})</span>` : r.distance_m.toFixed(0) + ' m'}</td>
        <td class="num actual">${fmtTime(r.seconds)}</td>
        <td class="num ${r.pace === fast ? 'actual' : 'dim'}">${fmtPace(r.pace, 1000)}</td>
        <td class="num dim">${r.avg_hr ? r.avg_hr.toFixed(0) : '—'}</td>
        <td class="num dim">${r.recovery_s ? html`${fmtTime(r.recovery_s)}${r.recovery_m ? html` <span class="dim">/ ${r.recovery_m.toFixed(0)} m</span>` : ''}` : '—'}</td>
        <td style="width:34%"><span class="split-bar-wrap" style="display:block">
          <span class="split-bar" style="width:${(45 + 55 * (span > 1 ? (slow - r.pace) / span : 0.5)).toFixed(0)}%"></span></span></td>
      </tr>`)}</tbody>
    </table></div>
    <p class="stat-hint" style="margin-top:10px">Reps were found from the pace stream, not from lap presses. Longer bar is faster.</p>
  </section>`;
}

function formPanel(shape, fd, findings) {
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Running form</p><p class="panel-note">Over the running portion only</p></div>
    <div class="digest">
      ${shape.cadence && shape.cadence.mean ? html`<div class="stat">
        <div class="stat-value">${shape.cadence.mean.toFixed(0)}<small class="unit">spm</small></div>
        <div class="stat-label">Cadence</div>
        ${shape.cadence.sd ? html`<div class="stat-hint">±${shape.cadence.sd.toFixed(0)} spread</div>` : ''}
      </div>` : ''}
      ${shape.stride_m && shape.stride_m.mean ? html`<div class="stat">
        <div class="stat-value">${shape.stride_m.mean.toFixed(2)}<small class="unit">m</small></div>
        <div class="stat-label">Stride length</div></div>` : ''}
      ${shape.gct_ms && shape.gct_ms.mean ? html`<div class="stat">
        <div class="stat-value">${shape.gct_ms.mean.toFixed(0)}<small class="unit">ms</small></div>
        <div class="stat-label">Ground contact</div></div>` : ''}
      ${shape.vertical_ratio ? html`<div class="stat">
        <div class="stat-value">${shape.vertical_ratio.toFixed(1)}<small class="unit">%</small></div>
        <div class="stat-label">Vertical ratio</div>
        <div class="stat-hint">Bounce as a share of stride.</div></div>` : ''}
    </div>
    ${fd && fd.cadence_delta != null ? html`<p class="stat-hint" style="margin-top:14px">
      Second half against the first: cadence
      <span class="${fd.cadence_delta < -2 ? 'behind' : 'dim'}">${sgn(fd.cadence_delta)} spm</span>${fd.gct_delta != null
        ? html`, ground contact <span class="${fd.gct_delta > 5 ? 'behind' : 'dim'}">${sgn(fd.gct_delta)} ms</span>` : ''}.
      ${fd.pace_first && fd.pace_second ? html`Pace went ${fmtPace(fd.pace_first, 1000)} to ${fmtPace(fd.pace_second, 1000)}, which moves cadence on its own.` : ''}
    </p>` : ''}
    <ul class="findings">${findings.map(f => html`<li class="sev-${f.severity}"><span class="sev-dot"></span>${f.text}</li>`)}</ul>
  </section>`;
}

const BREAK_KINDS = [['crossings', 'Crossings', 'k-crossing'], ['rests', 'Rest stops', 'k-rest'], ['climbs', 'Climbs', 'k-climb'],
  ['exhaustion', 'Fatigue', 'k-exhaustion'], ['eased', 'Eased off', 'k-eased']];
function breaksPanel(b) {
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Why you stopped</p><p class="panel-note">${fmtTime(b.lost_s)} not running</p></div>
    ${b.verdict ? html`<p class="verdict">${b.verdict}</p>` : ''}
    <div class="break-counts">${BREAK_KINDS.filter(([k]) => b[k]).map(([k, label, cls]) => html`<span class="break-chip ${cls}">${b[k]} ${label}</span>`)}</div>
    <div class="table-scroll" style="margin-top:16px"><table>
      <thead><tr><th>At</th><th>What it was</th><th class="num">For</th><th class="num">HR</th><th class="num">Pace after</th><th></th></tr></thead>
      <tbody>${(b.interruptions || []).map(it => html`<tr>
        <td class="dim">${(it.at_m / 1000).toFixed(2)} km</td>
        <td><span class="break-dot k-${it.label}"></span> <b>${cap(it.label)}</b>
          ${it.junction ? html`<span class="dim"> · known corner</span>` : ''}<br><span class="dim">${it.reason}</span></td>
        <td class="num actual">${fmtTime(it.seconds)}</td>
        <td class="num dim">${it.hr_drop != null ? '−' + it.hr_drop.toFixed(0) : '—'}</td>
        <td class="num">${it.penalty != null ? html`<span class="${fade(it.penalty)}">${sgn(it.penalty * 100, 1)}%</span>` : html`<span class="dim">—</span>`}</td>
        <td class="num dim">${(it.confidence * 100).toFixed(0)}% sure</td>
      </tr>`)}</tbody>
    </table></div>
    <p class="stat-hint" style="margin-top:10px">“Pace after” compares the 250 m before the interruption with the 250 m
      after. A stop you recover from costs nothing; fatigue shows up here.</p>
  </section>`;
}

// The athlete's own lap structure: what they pressed the button for (Garmin only).
function lapsPanel(laps) {
  const has = k => laps.some(l => l[k] != null);
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Laps</p><p class="panel-note">${laps.length} from the watch · what you pressed the button for</p></div>
    <div class="table-scroll"><table>
      <thead><tr><th>Lap</th><th class="num">Distance</th><th class="num">Time</th><th class="num">Pace</th>
        ${has('avg_hr') ? html`<th class="num">HR</th>` : ''}${has('elev_gain_m') ? html`<th class="num">Climb</th>` : ''}
        ${has('avg_cadence') ? html`<th class="num">Cadence</th>` : ''}${has('avg_power') ? html`<th class="num">Power</th>` : ''}</tr></thead>
      <tbody>${laps.map((l, i) => html`<tr>
        <td>${l.index ?? i + 1}</td>
        <td class="num">${l.distance_m != null ? (l.distance_m / 1000).toFixed(2) + ' km' : '—'}</td>
        <td class="num actual">${l.duration_s != null ? fmtTime(l.duration_s) : '—'}</td>
        <td class="num dim">${fmtPace(l.duration_s, l.distance_m)}</td>
        ${has('avg_hr') ? html`<td class="num dim">${l.avg_hr != null ? Math.round(l.avg_hr) : '—'}</td>` : ''}
        ${has('elev_gain_m') ? html`<td class="num dim">${l.elev_gain_m != null ? Math.round(l.elev_gain_m) + ' m' : '—'}</td>` : ''}
        ${has('avg_cadence') ? html`<td class="num dim">${l.avg_cadence != null ? Math.round(l.avg_cadence) : '—'}</td>` : ''}
        ${has('avg_power') ? html`<td class="num dim">${l.avg_power != null ? Math.round(l.avg_power) + ' W' : '—'}</td>` : ''}
      </tr>`)}</tbody>
    </table></div>
  </section>`;
}

// Channels the watch recorded beyond the ten the analysis reads: name and average.
function channelsList(ch, keys) {
  const avg = k => {
    const v = ch[k].filter(x => typeof x === 'number' && isFinite(x));
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };
  return html`<div class="stat"><div class="stat-label" style="margin-bottom:8px">Channels recorded</div>
    <ul class="channels">${keys.sort().map(k => { const m = avg(k); return html`<li><span>${k.replace(/_/g, ' ')}</span>
      <span class="num" title="Average over the activity">${m == null ? '—' : Math.abs(m) >= 100 ? m.toFixed(0) : m.toFixed(1)}</span></li>`; })}</ul>
    <div class="stat-hint">Recorded by the watch, not yet read by any analysis here. Averages over the whole activity.</div></div>`;
}

// ---- the map ----
const LEAFLET = 'https://unpkg.com/leaflet@1.9.4/dist/';
let _leaflet = null;
function leaflet() {
  if (window.L) return Promise.resolve(window.L);
  return _leaflet || (_leaflet = new Promise((res, rej) => {
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = LEAFLET + 'leaflet.css'; document.head.appendChild(css);
    const s = document.createElement('script'); s.src = LEAFLET + 'leaflet.js';
    s.onload = () => res(window.L); s.onerror = () => { _leaflet = null; rej(new Error('Leaflet did not load')); };
    document.head.appendChild(s);
  }));
}
const token = (n, fallback) => (getComputedStyle(document.documentElement).getPropertyValue(n) || '').trim() || fallback;

export async function mount(el, params = {}) {
  const box = el.querySelector('#actmap'), pts = _view.id === params.id ? _view.track : null;
  if (!box || !pts) return;
  let L;
  try { L = await leaflet(); } catch (e) { box.textContent = 'The map did not load (offline?).'; return; }
  if (!box.isConnected) return;
  const map = L.map(box, { preferCanvas: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  const line = L.polyline(pts, { color: token('--measured', '#0b6e79'), weight: 4 }).addTo(map);
  map.fitBounds(line.getBounds(), { padding: [18, 18] });
  L.circleMarker(pts[0], { radius: 6, color: token('--ahead', '#17694a'), fillOpacity: 1 }).addTo(map).bindTooltip('Start');
  L.circleMarker(pts[pts.length - 1], { radius: 6, color: token('--behind', '#a5321f'), fillOpacity: 1 }).addTo(map).bindTooltip('Finish');
}
