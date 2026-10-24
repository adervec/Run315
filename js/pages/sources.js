// Sources: where Garmin and Strava disagree about the same session, and which of them the
// per-second stream sides with; then a coverage map of every data channel over 26 weeks, so
// the gaps in what arrived are visible at a glance.
import { state, save, streamIds, getStream } from '../store.js';
import { samplesOf } from '../derive.js';
import * as R from '../datareview.js';
import { renderChart } from '../charts.js';
import { html, raw, pageHead, emptyState, km, fmtTime, day, toast, useCss } from '../ui.js';

export const title = 'Sources';
const WORST = 15;

const CSS = `
.cov-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 18px 28px; }
.cov-head { display: flex; gap: 8px; align-items: baseline; margin: 0 0 6px; font-size: 14px; }
.cov-head span { margin-left: auto; font-family: var(--mono); font-size: 11px; color: var(--muted); }
.cov-scroll { overflow-x: auto; }
.cov-grid { display: flex; gap: 2px; min-width: max-content; }
.cov-col { display: flex; flex-direction: column; gap: 2px; }
.cov-cell { width: 8px; height: 8px; border-radius: 1px; display: block; background: var(--track); }
.cv-have, .cv-both { background: var(--measured); }
.cv-garmin { background: var(--series-1); }
.cv-strava { background: var(--series-2); }
.cv-miss { background: var(--behind); opacity: .6; }
.cv-unk { background: transparent; box-shadow: inset 0 0 0 1px var(--faint); }
.cv-future { visibility: hidden; }
.cov-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--muted); margin: 0 0 16px; }
.cov-legend i { display: inline-block; width: 10px; height: 10px; margin-right: 5px; vertical-align: -1px; border-radius: 1px; }
.src-side { font-family: var(--mono); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
`;

const sgn = (v, d = 0) => (v == null ? '--' : (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d));
const sgnTime = v => (v == null ? '--' : (v > 0 ? '+' : v < 0 ? '−' : '±') + fmtTime(Math.abs(v)));
const UNIT = { distance_m: v => sgn(v) + ' m', distance_pct: v => sgn(v, 1) + '%', moving_s: sgnTime, elev_gain_m: v => sgn(v) + ' m', avg_hr: v => sgn(v, 1) + ' bpm' };
const SIDE = { garmin: 'Garmin', strava: 'Strava', tie: 'both' };

async function refereeFor(id, type) {
  try { const rec = await getStream(id); return rec ? { ...R.streamReferee(samplesOf(rec), type), src: rec.src } : null; }
  catch { return null; }
}

async function disagreement() {
  const pairs = R.linkedPairs(state);
  if (!pairs.length) return html`<section class="panel"><div class="panel-head"><p class="eyebrow">Garmin vs Strava</p></div>
    <div class="empty"><p>No activity is on both yet. Once the strava channel links Strava's copy of a Garmin activity,
      the two services' numbers for the same session are compared here.</p></div><a class="btn btn-ghost" href="#/sync">Cowork channels</a></section>`;
  const stats = R.deltaStats(pairs);
  const worst = pairs.filter(p => p.d.distance_pct != null).sort((a, b) => Math.abs(b.d.distance_pct) - Math.abs(a.d.distance_pct)).slice(0, WORST);
  // The stream is the referee: its GPS track for distance, its altitude for the climb.
  const refs = {};
  for (const p of worst) refs[p.id] = await refereeFor(p.id, p.type);
  const sides = { distance: {}, climb: {} };
  for (const p of worst) {
    const r = refs[p.id]; if (!r) continue;
    const sd = R.sideWith(p.g.distance_m, p.s.distance_m, r.gps_m), sc = R.sideWith(p.g.elev_gain_m, p.s.elev_gain_m, r.elev_gain_m);
    if (sd) sides.distance[sd] = (sides.distance[sd] || 0) + 1;
    if (sc) sides.climb[sc] = (sides.climb[sc] || 0) + 1;
    p.sideD = sd; p.sideC = sc;
  }
  const verdict = (o, what) => {
    const n = Object.values(o).reduce((s, x) => s + x, 0);
    if (!n) return '';
    return `${what}: the stream sides with Garmin ${o.garmin || 0}, Strava ${o.strava || 0}, neither clearly ${o.tie || 0} of ${n}` + (n < 8 ? ' — too few to call a habit.' : '.');
  };
  const pts = pairs.filter(p => p.g.distance_m && p.s.distance_m).map(p => [+(p.g.distance_m / 1000).toFixed(2), +(p.s.distance_m / 1000).toFixed(2)]);
  const n = pairs.length;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Garmin vs Strava</p><p class="panel-note">${n} linked activities · Strava minus Garmin</p></div>
    <div class="empty"><p>The same session, measured twice. Strava recomputes distance, climb and moving time from the
      file the watch uploads, with its own smoothing and its own idea of when you were stopped, so small steady
      differences are normal; the outliers are where one of them went wrong.${n < 10 ? ` Only ${n} pairs so far: read the medians as rough.` : ''}</p></div>
    <div class="table-scroll"><table><thead><tr><th>Difference</th><th class="num">n</th><th class="num">Median</th><th class="num">Middle half</th><th class="num">Range</th></tr></thead>
      <tbody>${[['distance_m', 'Distance'], ['distance_pct', 'Distance, %'], ['moving_s', 'Moving time'], ['elev_gain_m', 'Elevation gain'], ['avg_hr', 'Average HR']].map(([k, label]) => {
        const s = stats[k];
        return html`<tr><td>${label}</td><td class="num">${s.n}</td>${s.n ? html`<td class="num">${UNIT[k](s.median)}</td>
          <td class="num dim">${UNIT[k](s.p25)} to ${UNIT[k](s.p75)}</td><td class="num dim">${UNIT[k](s.min)} to ${UNIT[k](s.max)}</td>` : html`<td class="num" colspan="3">--</td>`}</tr>`;
      })}</tbody></table></div>
    ${pts.length ? raw(renderChart({ type: 'scatter', title: 'Distance: Garmin against Strava', x: { label: 'Garmin', type: 'linear' },
      y: { label: 'Strava', unit: 'km' }, series: [{ name: 'linked activities', points: pts }],
      note: 'Each point is one session; on the diagonal the two agree.' })) : ''}
    <h3 style="margin:18px 0 6px;font-size:16px">The ${worst.length} biggest distance disagreements</h3>
    <p class="panel-note" style="margin:0 0 10px">${[verdict(sides.distance, 'Distance (GPS track length)'), verdict(sides.climb, 'Climb (stream altitude)')].filter(Boolean).join(' ')
      || 'No stream for these on this device, so no referee: open this page on the desktop that imported them.'}</p>
    <div class="table-scroll"><table><thead><tr><th>Activity</th><th class="num">Garmin</th><th class="num">Strava</th><th class="num">Δ</th>
      <th class="num">Δ moving</th><th class="num">Δ climb</th><th class="num">Δ HR</th><th class="num">GPS track</th><th>Distance: stream says</th></tr></thead>
      <tbody>${worst.map(p => { const r = refs[p.id]; return html`<tr>
        <td><a class="quiet-link" href="#/activity/${p.id}">${p.name || p.id}</a><span class="dim"> · ${day(p.start)}</span></td>
        <td class="num">${km(p.g.distance_m, 2)}</td><td class="num">${km(p.s.distance_m, 2)}</td>
        <td class="num">${UNIT.distance_pct(p.d.distance_pct)}</td><td class="num dim">${UNIT.moving_s(p.d.moving_s)}</td>
        <td class="num dim">${p.d.elev_gain_m != null ? UNIT.elev_gain_m(p.d.elev_gain_m) : '--'}</td>
        <td class="num dim">${p.d.avg_hr != null ? UNIT.avg_hr(p.d.avg_hr) : '--'}</td>
        <td class="num dim">${r && r.gps_m ? km(r.gps_m, 2) : '--'}</td>
        <td>${p.sideD ? html`<span class="src-side">${SIDE[p.sideD]}</span>` : html`<span class="dim">${r ? 'no GPS' : 'no stream here'}</span>`}</td></tr>`; })}</tbody></table></div>
  </section>`;
}

const STATE_LABEL = { have: 'recorded', miss: 'missing', unk: 'unknown until the stream is scanned', none: 'no activity', both: 'Garmin and Strava', garmin: 'Garmin only', strava: 'Strava only' };
function coveragePanel(unscanned) {
  const c = R.coverage(state, new Date());
  const weeks = c.grid;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Coverage</p><p class="panel-note">last ${weeks.length} weeks · Monday at the top</p></div>
    <div class="empty"><p>One grid per data channel, a column per week. Activity channels count only the days with an
      activity; the daily ones count every day. Running dynamics count run days only.</p></div>
    <div class="cov-legend">
      <span><i class="cv-have"></i>recorded</span><span><i class="cv-miss"></i>missing</span>
      <span><i class="cv-unk"></i>unknown (stream not scanned)</span><span><i class="cov-cell" style="display:inline-block"></i>no activity</span>
      <span><i class="cv-garmin"></i>Garmin only</span><span><i class="cv-strava"></i>Strava only</span>
    </div>
    <div class="cov-list">${c.channels.map(ch => html`<div>
      <p class="cov-head"><strong>${ch.label}</strong><span>${ch.key === 'activities' ? `${ch.of} days` : `${ch.have} / ${ch.of} days${ch.unk ? ` · ${ch.unk} unknown` : ''}`}</span></p>
      <div class="cov-scroll"><div class="cov-grid">${weeks.map(w => html`<div class="cov-col">${w.map(d => {
        const v = ch.cells[d];
        return html`<span class="cov-cell cv-${v}" title="${d} · ${ch.label}: ${STATE_LABEL[v] || ''}"></span>`;
      })}</div>`)}</div></div></div>`)}</div>
    ${unscanned ? html`<p style="margin-top:16px"><button type="button" class="btn btn-ghost" id="src-scan">Read the channels of ${unscanned} streams on this device</button></p>` : ''}
  </section>`;
}

export async function render() {
  useCss('sources', CSS);
  const head = pageHead('Sources', 'Garmin against Strava, and what is missing', html`<a class="btn btn-ghost" href="#/datareview">Data review</a>`);
  if (!Object.keys(state.activities).length && !Object.keys(state.daily).length) return html`${head}${emptyState('Nothing imported yet',
    'Once Garmin and Strava arrive through the cowork folder, this page shows where they disagree and where the gaps are.', html`<a class="btn" href="#/sync">Set up sync</a>`)}`;
  let ids = [];
  try { ids = (await streamIds()) || []; } catch { /* no IndexedDB */ }
  const unscanned = ids.filter(id => state.activities[id] && R.scanOf(state, id)?.v !== R.SCAN_V).length;
  return html`${head}${await disagreement()}${coveragePanel(unscanned)}`;
}

export function mount(el) {
  const b = el.querySelector('#src-scan');
  if (b) b.onclick = async () => {
    b.disabled = true;
    try {
      const r = await R.scanStreams(state, { ids: (await streamIds()) || [], getStream, onProgress: (n, of) => { b.textContent = `Reading ${n} / ${of}…`; } });
      save('edit');
      toast(`${r.scanned} streams read · ${r.findings} findings for the data review`);
    } catch (e) { toast('Failed: ' + (e.message || e)); }
    el.innerHTML = String(await render()); mount(el);
  };
}
