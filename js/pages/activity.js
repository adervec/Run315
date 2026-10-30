// One activity in full: the headline numbers, the session it turned out to be, its
// form, why it stopped, where it went, its splits and best efforts, and what the
// watch actually recorded. Everything the analysis kept (state.derived) shows on any
// device; the per-second stream adds running form and a full-resolution map where it
// is available (this device, or Drive), and with it the stream explorer: every channel
// the watch recorded, stacked on one x axis, with a shared crosshair, drag-to-zoom
// that follows on the map, and another run overlaid by distance.
//
// Hooks from other modules sit where they are used: the journal (effort, feel, notes)
// right under the headline, because logging how it felt is a ten-second job best done
// straight after the run; the Strava segments button in the page head; GymTracker's
// strength sessions (ids 'gt...') get strength.js's own detail instead of this page.
import { state } from '../store.js';
import * as D from '../derive.js';
import * as F from '../lib/fitness.js';
import * as FM from '../lib/form.js';
import * as WX from '../lib/weather.js';
import * as S from '../streams.js';
import { fetchStream, driveOn } from '../drive.js';
import { journalWidget, mountJournal } from '../journal.js';
import { segmentsButton, mountSegmentsButton } from '../datareview.js';
import { strengthDetail } from '../strength.js';
import { html, raw, esc, pageHead, emptyState, fmtTime, fmtPace, typeLabel, useCss, toast } from '../ui.js';

export const title = p => state.activities[p && p.id]?.name
  || (p && String(p.id || '').startsWith('gt') && D.activities(state).find(a => a.id === p.id)?.name) || 'Activity';

// Another module's widget: its markup, or '' when it has nothing (the stubs) or throws.
// Those modules return html``; String() + raw() takes a plain markup string the same way.
function hook(fn) {
  try { const s = String(fn() ?? ''); return s.trim() ? raw(s) : ''; } catch (e) { console.warn('hook', e); return ''; }
}

const CSS = `
.act-src { font-family: var(--mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); margin-left: 8px; }
.act-src.strava { color: #fc4c02; }
#actmap { height: 380px; border-radius: 3px; background: var(--ground); }
.channels { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px 18px; }
.channels li { display: flex; justify-content: space-between; gap: 10px; border-top: 1px solid var(--line); padding: 6px 0; font-size: 14px; }
.channels .num { font-family: var(--mono); font-size: 12px; color: var(--muted); }
@media (max-width: 520px) { #actmap { height: 300px; } }
/* The stream explorer: chart-fig's language (mono axis text, --line grid, --measured
   line), drawn as one stack so the crosshair and a zoom span every channel at once. */
.sx-bar { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; margin: 0 0 10px; font-size: 13px; }
.sx-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 3px; overflow: hidden; }
.sx-seg button { font: 12px var(--mono); padding: 4px 10px; border: 0; background: var(--surface); color: var(--muted); cursor: pointer; }
.sx-seg button[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); }
.sx-bar select { max-width: 100%; font: 13px var(--body); padding: 4px 6px; background: var(--surface); color: var(--ink); border: 1px solid var(--line); border-radius: 3px; }
.sx-bar label { display: inline-flex; gap: 6px; align-items: center; color: var(--muted); max-width: 100%; }
.sx-readout { font: 12px var(--mono); color: var(--muted); min-height: 1.4em; margin: 0 0 4px; }
.sx-stack { position: relative; touch-action: pan-y; user-select: none; -webkit-user-select: none; cursor: crosshair; }
.sx-row { border-top: 1px solid var(--line); padding: 4px 0 2px; }
.sx-head { display: flex; gap: 6px; align-items: baseline; font-size: 12px; color: var(--muted); }
.sx-head .sx-name { color: var(--ink); font-weight: 600; }
.sx-head .sx-val { font: 600 12px var(--mono); color: var(--measured); }
.sx-head .sx-val2 { font: 12px var(--mono); color: var(--series-2); }
.sx-head .sx-lim { margin-left: auto; font: 11px var(--mono); color: var(--faint); }
.sx-plot { position: relative; height: 56px; }
.sx-plot svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.sx-plot .grid { stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.sx-plot .zero { stroke: var(--muted); stroke-dasharray: 3 3; stroke-width: 1; vector-effect: non-scaling-stroke; }
.sx-plot .ln { fill: none; stroke-width: 1.5; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.sx-dot { position: absolute; width: 7px; height: 7px; margin: -3.5px 0 0 -3.5px; border-radius: 50%; background: var(--measured);
  box-shadow: 0 0 0 2px var(--surface); pointer-events: none; display: none; }
.sx-dot.two { background: var(--series-2); }
.sx-dot.gap { background: var(--ink); }
.sx-cross { position: absolute; top: 0; bottom: 0; width: 0; border-left: 1px solid var(--ink); opacity: .45; pointer-events: none; display: none; }
.sx-sel { position: absolute; top: 0; bottom: 0; background: var(--measured); opacity: .14; pointer-events: none; display: none; }
.sx-axis { position: relative; height: 18px; border-top: 1px solid var(--line); font: 11px var(--mono); color: var(--muted); }
.sx-axis span { position: absolute; top: 3px; transform: translateX(-50%); white-space: nowrap; }
.sx-legend { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--muted); margin-top: 6px; }
.sx-legend i { display: inline-block; width: 14px; height: 2px; vertical-align: 3px; margin-right: 5px; }
`;

// The channels samplesFromChannels folds into the 10-wide sample rows; anything else the
// watch recorded (power, respiration, temperature...) nothing used to show.
const SAMPLE_CHANNELS = new Set(['seconds', 'metres', 'hr', 'lat', 'lon', 'elevation_m', 'gps_elevation_m',
  'cadence_spm', 'run_cadence_spm', 'stride_m', 'gct_ms', 'vertical_oscillation_cm']);
const sgn = (v, d = 0) => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(d);
const fade = v => (v > 0.02 ? 'behind' : v < -0.02 ? 'ahead' : 'dim');

// What mount() needs to draw: the last render's route.
let _view = { id: null, track: null, sx: null };

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
  _view = { id, track: null, sx: null };
  // GymTracker's strength sessions live in D.activities, not state.activities.
  if (String(id || '').startsWith('gt')) {
    const g = D.activities(state).find(a => a.id === id);
    const body = hook(() => strengthDetail(id));
    return html`${pageHead(g?.name || 'Strength session', g ? dateLine(g.start) : '', html`<a class="btn btn-ghost" href="#/activities">All activities</a>`)}
      ${body || emptyState('Strength session', 'GymTracker has not shared the detail of this session with this device (yet).',
        html`<a class="btn" href="#/activities">All activities</a>`)}`;
  }
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
  const der = await D.fullDerived(state, id);
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

  // The explorer's data: every channel, plus where each sample was (for the map).
  const built = hasStream ? S.buildSeries(rec.channels, act.type) : null;
  if (built && built.series.length) {
    const same = D.activities(state).filter(a => a.id !== id && (isRun ? F.RUN_TYPES.has(a.type) : a.type === act.type));
    const candidates = S.compareCandidates(act, same, isRun ? D.repeatedRoutes(state) : []);
    _view.sx = { built, act, ll: samples.map(s => (s[3] != null && s[4] != null ? [s[3], s[4]] : null)), candidates };
  }
  const journal = hook(() => journalWidget(id)), segs = hook(() => segmentsButton(id));

  return html`
    ${pageHead(act.name, dateLine(act.start), html`${segs ? html`<span data-hook="segments">${segs}</span>` : ''}<a class="btn btn-ghost" href="#/activities">All activities</a>`)}

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

    ${journal ? html`<section class="panel" data-hook="journal">
      <div class="panel-head"><p class="eyebrow">How it went</p><p class="panel-note">Your own words and numbers · synced</p></div>
      ${journal}</section>` : ''}

    ${session ? sessionPanel(session, prescribed, band) : ''}

    ${wxLine ? html`<p class="wx-line">${wxLine}</p>` : ''}

    ${shape && findings.length ? formPanel(shape, formDrift, findings) : ''}

    ${breaks ? breaksPanel(breaks) : ''}

    ${_view.track ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">Where you ran</p>
        <p class="panel-note">${track.length} points${fullTrack.length ? '' : ' · thinned for sync'}</p></div>
      <div id="actmap"></div>
    </section>` : ''}

    ${_view.sx ? explorerPanel(_view.sx) : ''}

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

// ---- the stream explorer ----
// One small plot per channel, every plot sharing the x axis. The plots are stretched
// SVGs (preserveAspectRatio none, non-scaling strokes) so they fill any width at a fixed
// height; text and the hover dots live in HTML so they never stretch with them.
// renderChart cannot do this: it has no shared crosshair and no zoom.
const VW = 680, VH = 56;

function explorerPanel(sx) {
  const { built, candidates } = sx;
  const route = candidates.filter(c => c.why === 'route'), near = candidates.filter(c => c.why === 'distance');
  return html`<section class="panel" id="sx">
    <div class="panel-head"><p class="eyebrow">Stream explorer</p>
      <p class="panel-note">${built.n.toLocaleString('en-GB')} samples · ${built.series.length} channel${built.series.length === 1 ? '' : 's'} · drag across to zoom</p></div>
    <div class="sx-bar">
      <span class="sx-seg" role="group" aria-label="x axis"><button type="button" data-x="d" aria-pressed="true">Distance</button><button type="button" data-x="t" aria-pressed="false">Time</button></span>
      <button class="btn btn-quiet" type="button" data-sx="reset" hidden>Reset zoom</button>
      ${candidates.length ? html`<label>Compare <select data-sx="compare"><option value="">nothing</option>
        ${route.length ? html`<optgroup label="${'Same route' + (route[0].group ? ' · ' + route[0].group : '')}">${route.map(c => html`<option value="${c.id}">${c.label}</option>`)}</optgroup>` : ''}
        ${near.length ? html`<optgroup label="Similar distance (±10%)">${near.map(c => html`<option value="${c.id}">${c.label}</option>`)}</optgroup>` : ''}
      </select></label>` : ''}
    </div>
    <p class="sx-readout" aria-live="polite"></p>
    <div class="sx-stack"></div>
    <div class="sx-legend" hidden></div>
    <p class="stat-hint" style="margin-top:8px">Pace is distance over a 20-second window, drawn faster-up; standing still is a gap,
      not a line. Charts are thinned to about 600 points, keeping each stretch's highs and lows; zoom in to see every second.
      The overlay lines the two runs up by distance, and the gap counts stops: it is the race against your own earlier self.</p>
  </section>`;
}

function explorer(el, sx, mapRef) {
  const root = el.querySelector('#sx');
  if (!root) return;
  const stack = root.querySelector('.sx-stack'), readout = root.querySelector('.sx-readout'), legend = root.querySelector('.sx-legend');
  const reset = root.querySelector('[data-sx="reset"]'), pick = root.querySelector('[data-sx="compare"]');
  const b = sx.built, t0 = b.t.find(x => x != null) || 0;
  const ax = { d: S.monotone(b.d), t: S.monotone(b.t) };
  const v = { x: 'd', zoom: null, other: null, charts: [], x0: 0, x1: 1, drag: null };
  const map = () => mapRef.api || null;
  const yOf = c => y => {
    const f = (y - c.range[0]) / (c.range[1] - c.range[0]), g = c.invert ? f : 1 - f;
    return Math.max(0, Math.min(VH, g * VH));
  };
  const fmtV = (c, y) => (y == null ? '—' : c.isGap ? (y > 0.5 ? '+' : y < -0.5 ? '−' : '') + fmtTime(Math.abs(y))
    : c.key === 'pace' ? fmtTime(y) : y.toFixed(c.dp || 0));
  const pctX = x => ((x - v.x0) / (v.x1 - v.x0)) * 100;
  const defaultReadout = () => (v.zoom ? `Zoomed: ${fmtX(v.x0)} to ${fmtX(v.x1)}` : 'Hover or touch for values');
  const fmtX = x => (v.x === 'd' ? (x / 1000).toFixed(v.x1 - v.x0 < 3000 ? 2 : 1) + ' km' : fmtTime(x - t0));

  function rowHtml(c, X) {
    const Y = c.range ? yOf(c) : null;
    const lim = c.lim ? (c.key === 'pace' ? `${fmtTime(c.lim[0])}–${fmtTime(c.lim[1])}` : c.isGap
      ? `${fmtV(c, c.lim[0])} to ${fmtV(c, c.lim[1])}` : `${c.lim[0].toFixed(c.dp || 0)}–${c.lim[1].toFixed(c.dp || 0)}`) : 'no data here';
    return String(html`<div class="sx-row"><div class="sx-head"><span class="sx-name">${c.label}</span>
      <span class="sx-val" data-v></span>${c.other ? html`<span class="sx-val2" data-v2></span>` : ''}<span>${c.unit}</span>
      <span class="sx-lim" title="${c.key === 'pace' ? '2nd to 98th percentile in view' : 'Range in view'}">${lim}</span></div>
      <div class="sx-plot"><svg viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="none" aria-hidden="true">
        <line class="grid" x1="0" x2="${VW}" y1="${VH / 2}" y2="${VH / 2}"/>
        ${c.zero && Y ? raw(`<line class="zero" x1="0" x2="${VW}" y1="${Y(0).toFixed(1)}" y2="${Y(0).toFixed(1)}"/>`) : ''}
        ${c.other && Y ? raw(`<path class="ln" style="stroke:var(--series-2)" d="${S.pathOf(c.other.pts, X, Y)}"/>`) : ''}
        ${Y ? raw(`<path class="ln" style="stroke:${c.isGap ? 'var(--ink)' : 'var(--measured)'}" d="${S.pathOf(c.pts, X, Y)}"/>`) : ''}
      </svg><span class="sx-dot${c.isGap ? ' gap' : ''}" data-d></span>${c.other ? html`<span class="sx-dot two" data-d2></span>` : ''}</div></div>`);
  }
  function axisHtml() {
    const ticks = v.x === 'd'
      ? S.niceTicks(v.x0 / 1000, v.x1 / 1000, 5).map(k => [k * 1000, +k.toFixed(2) + ' km'])
      : S.niceTicks((v.x0 - t0) / 60, (v.x1 - t0) / 60, 5).map(m => [t0 + m * 60, fmtTime(m * 60)]);
    return `<div class="sx-axis">${ticks.filter(([x]) => x >= v.x0 && x <= v.x1)
      .map(([x, l]) => `<span style="left:${pctX(x).toFixed(2)}%">${esc(l)}</span>`).join('')}</div>`;
  }
  const visibleRange = (xs, x0, x1) => [Math.max(0, S.lowerBound(xs, x0) - 1), Math.min(xs.length, S.lowerBound(xs, x1) + 1)];
  const limOf = (vals, robust) => {
    const lo = S.quantile(vals, robust ? 0.02 : 0), hi = S.quantile(vals, robust ? 0.98 : 1);
    return lo == null ? null : [lo, hi];
  };

  function draw() {
    const xs = ax[v.x], n = xs.length;
    const [x0, x1] = v.zoom || [xs[0], xs[n - 1]];
    v.x0 = x0; v.x1 = x1 > x0 ? x1 : x0 + 1;
    const [i0, i1] = visibleRange(xs, v.x0, v.x1);
    const X = x => ((x - v.x0) / (v.x1 - v.x0)) * VW;
    const o = v.x === 'd' ? v.other : null, charts = [];
    if (o && o.gap.d.length) {
      const [j0, j1] = visibleRange(o.gap.d, v.x0, v.x1), vis = o.gap.gap.slice(j0, j1);
      charts.push({ key: 'gap', label: 'Gap', unit: 'behind (+) / ahead (−)', invert: true, isGap: true, zero: true,
        xs: o.gap.d, values: o.gap.gap, range: S.yRange([...vis, 0]), lim: limOf(vis), pts: S.downsample(o.gap.d, o.gap.gap, j0, j1) });
    }
    for (const s of b.series) {
      const vis = s.values.slice(i0, i1);
      let other = null;
      const twin = o && ['pace', 'speed', 'hr'].includes(s.key) ? o.b.series.find(q => q.key === s.key) : null;
      if (twin) {
        const [j0, j1] = visibleRange(o.dx, v.x0, v.x1);
        other = { xs: o.dx, values: twin.values, vis: twin.values.slice(j0, j1), pts: S.downsample(o.dx, twin.values, j0, j1) };
      }
      const robust = s.key === 'pace';
      charts.push({ ...s, xs, range: S.yRange(other ? [...vis, ...other.vis] : vis, robust), lim: limOf(vis, robust),
        pts: S.downsample(xs, s.values, i0, i1), other });
    }
    v.charts = charts;
    stack.innerHTML = charts.map(c => rowHtml(c, X)).join('') + axisHtml() + '<div class="sx-cross"></div><div class="sx-sel"></div>';
    reset.hidden = !v.zoom;
    root.querySelectorAll('[data-x]').forEach(bt => bt.setAttribute('aria-pressed', String(bt.dataset.x === v.x)));
    legend.hidden = !v.other;
    if (v.other) legend.innerHTML = String(html`<span><i style="background:var(--measured)"></i>This run</span>
      <span><i style="background:var(--series-2)"></i>${v.other.label}</span>
      ${v.x === 'd' ? html`<span>Gap: above the dashed line is ahead of that run</span>` : html`<span>The overlay is by distance: switch the axis back to see it</span>`}`);
    readout.textContent = defaultReadout();
  }

  const fracOf = e => { const r = stack.getBoundingClientRect(); return r.width ? Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) : 0; };
  function place(dot, c, x, y) {
    if (!dot) return;
    if (y == null || !c.range || x < v.x0 || x > v.x1) { dot.style.display = 'none'; return; }
    dot.style.display = 'block';
    dot.style.left = pctX(x).toFixed(2) + '%';
    dot.style.top = ((yOf(c)(y) / VH) * 100).toFixed(2) + '%';
  }
  function hover(f) {
    const xs = ax[v.x], i = S.nearest(xs, v.x0 + f * (v.x1 - v.x0));
    const cross = stack.querySelector('.sx-cross');
    cross.style.display = 'block';
    cross.style.left = pctX(xs[i]).toFixed(2) + '%';
    const rows = stack.querySelectorAll('.sx-row');
    v.charts.forEach((c, k) => {
      const row = rows[k];
      if (!row) return;
      const j = c.isGap ? S.nearest(c.xs, ax.d[i]) : i;
      row.querySelector('[data-v]').textContent = fmtV(c, c.values[j]);
      place(row.querySelector('[data-d]'), c, c.xs[j], c.values[j]);
      if (c.other) {
        const j2 = S.nearest(c.other.xs, ax.d[i]);
        row.querySelector('[data-v2]').textContent = fmtV(c, c.other.values[j2]);
        place(row.querySelector('[data-d2]'), c, c.other.xs[j2], c.other.values[j2]);
      }
    });
    readout.textContent = `${(ax.d[i] / 1000).toFixed(2)} km · ${fmtTime(ax.t[i] - t0)}`;
    map() && map().hover(sx.ll[i]);
  }
  function unhover() {
    const cross = stack.querySelector('.sx-cross');
    if (cross) cross.style.display = 'none';
    stack.querySelectorAll('.sx-dot').forEach(d => { d.style.display = 'none'; });
    stack.querySelectorAll('[data-v],[data-v2]').forEach(d => { d.textContent = ''; });
    readout.textContent = defaultReadout();
    map() && map().hover(null);
  }
  function zoomTo(xa, xb) {
    v.zoom = xa == null ? null : [Math.min(xa, xb), Math.max(xa, xb)];
    draw();
    const m = map();
    if (!m) return;
    if (!v.zoom) { m.clear(); return; }
    const [i0, i1] = visibleRange(ax[v.x], v.zoom[0], v.zoom[1]);
    m.select(sx.ll.slice(i0, i1).filter(Boolean));
  }

  stack.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    v.drag = { f0: fracOf(e) };
    try { stack.setPointerCapture(e.pointerId); } catch (_) { /* not capturable: fine */ }
  });
  stack.addEventListener('pointermove', e => {
    const f = fracOf(e);
    hover(f);
    if (!v.drag) return;
    const sel = stack.querySelector('.sx-sel'), a = Math.min(f, v.drag.f0), w = Math.abs(f - v.drag.f0);
    sel.style.display = w > 0.005 ? 'block' : 'none';
    sel.style.left = (a * 100).toFixed(2) + '%';
    sel.style.width = (w * 100).toFixed(2) + '%';
  });
  stack.addEventListener('pointerup', e => {
    const d = v.drag; v.drag = null;
    const sel = stack.querySelector('.sx-sel'); if (sel) sel.style.display = 'none';
    if (!d) return;
    const f = fracOf(e);
    // A tap is a look, not a zoom; and a zoom narrower than ~30 samples shows nothing new.
    if (Math.abs(f - d.f0) < 0.015) return;
    const xa = v.x0 + d.f0 * (v.x1 - v.x0), xb = v.x0 + f * (v.x1 - v.x0);
    const [i0, i1] = visibleRange(ax[v.x], Math.min(xa, xb), Math.max(xa, xb));
    if (i1 - i0 < 30) { toast('That is about as close as the stream goes.'); return; }
    zoomTo(xa, xb);
  });
  stack.addEventListener('pointercancel', () => { v.drag = null; const sel = stack.querySelector('.sx-sel'); if (sel) sel.style.display = 'none'; });
  stack.addEventListener('pointerleave', () => { if (!v.drag) unhover(); });
  stack.addEventListener('dblclick', () => zoomTo(null));
  reset.onclick = () => zoomTo(null);
  root.querySelectorAll('[data-x]').forEach(bt => { bt.onclick = () => setAxis(bt.dataset.x); });
  // Switching axis keeps the zoomed stretch: the same samples, measured the other way.
  function setAxis(x) {
    if (x === v.x) return;
    let z = null;
    if (v.zoom) { const [i0, i1] = visibleRange(ax[v.x], v.zoom[0], v.zoom[1]); z = [ax[x][i0], ax[x][Math.max(i0, i1 - 1)]]; }
    v.x = x; v.zoom = z;
    draw();
  }
  if (pick) pick.onchange = async () => {
    const id = pick.value;
    if (!id) { v.other = null; draw(); return; }
    pick.disabled = true;
    let rec = null;
    try { rec = await fetchStream(id); } catch (e) { console.warn('compare stream', e); }
    pick.disabled = false;
    const a = D.activities(state).find(x => x.id === id);
    const ob = rec && rec.channels ? S.buildSeries(rec.channels, a ? a.type : sx.act.type) : null;
    if (!ob) {
      toast(driveOn() ? 'That run has no per-second stream on this device or on Drive.' : 'That run has no per-second stream on this device.');
      pick.value = ''; v.other = null; draw(); return;
    }
    v.other = { id, b: ob, dx: S.monotone(ob.d), gap: S.gapByDistance(b, ob), label: pick.selectedOptions[0] ? pick.selectedOptions[0].textContent : id };
    if (v.x !== 'd') setAxis('d'); else draw();
  };
  draw();
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

// Draw the route; return what the explorer drives on it: a hover marker and a highlighted stretch.
async function drawMap(box, pts) {
  let L;
  try { L = await leaflet(); } catch (e) { box.textContent = 'The map did not load (offline?).'; return null; }
  if (!box.isConnected) return null;
  const map = L.map(box, { preferCanvas: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);
  const line = L.polyline(pts, { color: token('--measured', '#0b6e79'), weight: 4 }).addTo(map);
  map.fitBounds(line.getBounds(), { padding: [18, 18] });
  L.circleMarker(pts[0], { radius: 6, color: token('--ahead', '#17694a'), fillOpacity: 1 }).addTo(map).bindTooltip('Start');
  L.circleMarker(pts[pts.length - 1], { radius: 6, color: token('--behind', '#a5321f'), fillOpacity: 1 }).addTo(map).bindTooltip('Finish');
  let marker = null, sel = null;
  return {
    hover(ll) {
      if (!ll) { if (marker) { marker.remove(); marker = null; } return; }
      if (!marker) marker = L.circleMarker(ll, { radius: 6, color: token('--ink', '#101828'), weight: 2, fillColor: token('--surface', '#fff'), fillOpacity: 1 }).addTo(map);
      else marker.setLatLng(ll);
    },
    select(seg) {
      if (sel) { sel.remove(); sel = null; }
      if (seg.length < 2) return;
      sel = L.polyline(seg, { color: token('--ink', '#101828'), weight: 6, opacity: 0.75 }).addTo(map);
      map.fitBounds(sel.getBounds(), { padding: [24, 24], maxZoom: 17 });
    },
    clear() { if (sel) { sel.remove(); sel = null; } map.fitBounds(line.getBounds(), { padding: [18, 18] }); },
  };
}

export async function mount(el, params = {}) {
  if (_view.id !== params.id) return;
  const j = el.querySelector('[data-hook="journal"]'), sg = el.querySelector('[data-hook="segments"]');
  try { if (j) mountJournal(j, params.id); } catch (e) { console.warn('journal', e); }
  try { if (sg) mountSegmentsButton(sg, params.id); } catch (e) { console.warn('segments', e); }
  const mapRef = { api: null };
  if (_view.sx) { try { explorer(el, _view.sx, mapRef); } catch (e) { console.error('explorer', e); } }
  const box = el.querySelector('#actmap'), pts = _view.track;
  if (box && pts) mapRef.api = await drawMap(box, pts);
}
