// Strava segments, read-only: every segment you have efforts on, how often, your best and
// latest, and which way the times are moving. Efforts arrive only for the activities you
// ask for (each costs Strava a request), through the strava cowork channel.
import { state, save } from '../store.js';
import * as D from '../derive.js';
import * as R from '../datareview.js';
import { renderChart } from '../charts.js';
import { html, raw, pageHead, emptyState, fmtTime, day, toast, useCss } from '../ui.js';

export const title = 'Segments';
const CHARTS = 12;
let lastN = 10;

const CSS = `
.seg-ctl { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.seg-ctl input { width: 5em; }
.seg-charts { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 8px 24px; }
`;

// Runs with a Strava id and no efforts yet, newest first: what "fetch my last N" means.
const stravaRuns = () => D.runs(state).filter(a => a.strava_id);
const hasEfforts = a => R.effortsFor(state, a.id).length > 0;

function trendText(t) {
  if (!t) return html`<span class="dim">too few</span>`;
  const per = t.per30, se = t.se30;
  // Two standard errors either side of zero is the line between a direction and noise.
  const clear = se != null && Math.abs(per) > 2 * se;
  const word = !clear ? 'no clear trend' : per < 0 ? 'faster' : 'slower';
  return html`<span title="least-squares slope over ${t.n} attempts">${word}</span>
    <span class="dim"> ${per < 0 ? '−' : '+'}${Math.abs(per).toFixed(1)}${se != null ? ' ± ' + se.toFixed(1) : ''} s / 30 d</span>`;
}

function chart(s) {
  const mins = s.best.elapsed_time >= 600;
  try {
    return raw(renderChart({ type: 'line', title: s.name, x: { label: 'date', type: 'time' },
      y: { label: 'time', unit: mins ? 'min' : 's' },
      series: [{ name: s.name, points: s.efforts.filter(e => e.start_date_local).map(e => [e.start_date_local.slice(0, 10), mins ? +(e.elapsed_time / 60).toFixed(2) : e.elapsed_time]) }],
      note: `${s.attempts} attempts · lower is faster` }));
  } catch { return ''; }
}

function queuePanel() {
  const want = R.wantedSegments(state), runs = stravaRuns();
  const pending = want.filter(sid => !Object.values(state.segmentEfforts).some(e => e.strava_id === sid));
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Fetch segments</p><p class="panel-note">${pending.length} activities queued for the next Strava pull</p></div>
    <div class="empty"><p>Strava gives segment efforts one activity at a time, so Run315 asks only for the runs you pick
      (up to 40 per pull). Read-only: nothing is written to Strava.${runs.length ? '' : ' None of your runs is linked to Strava yet.'}</p></div>
    ${runs.length ? html`<div class="seg-ctl">
      <label for="seg-n">Fetch segments for my last</label>
      <input type="number" id="seg-n" min="1" max="100" value="${lastN}"> <span>runs</span>
      <button type="button" class="btn" id="seg-fetch">Queue them</button>
      ${pending.length ? html`<button type="button" class="btn-quiet" id="seg-clear">clear the queue</button>` : ''}
    </div>` : html`<a class="btn btn-ghost" href="#/sync">Cowork channels</a>`}
  </section>`;
}

export function render() {
  useCss('segments', CSS);
  const segs = R.segmentSummary(state);
  const head = pageHead('Segments', segs.length ? `${segs.length} Strava segments · ${Object.keys(state.segmentEfforts).length} efforts` : 'From Strava, read-only');
  if (!segs.length) return html`${head}${queuePanel()}${emptyState('No segment efforts yet',
    'Queue some runs above (or use the button on a run\'s page), then run the strava cowork channel.')}`;
  const charted = segs.filter(s => s.attempts >= 2).slice(0, CHARTS);
  return html`${head}${queuePanel()}
    <section class="panel">
      <div class="panel-head"><p class="eyebrow">Every segment</p><p class="panel-note">most attempted first</p></div>
      <div class="table-scroll"><table><thead><tr><th>Segment</th><th class="num">Attempts</th><th class="num">Best</th><th class="num">Latest</th><th>Trend</th></tr></thead>
      <tbody>${segs.map(s => html`<tr>
        <td>${s.name}<span class="dim">${s.distance ? ` · ${(s.distance / 1000).toFixed(2)} km` : ''}${s.grade != null ? ` · ${s.grade.toFixed(1)}%` : ''}${s.city ? ` · ${s.city}` : ''}</span></td>
        <td class="num">${s.attempts}</td>
        <td class="num"><a class="quiet-link" href="#/activity/${s.best.activity_id}">${fmtTime(s.best.elapsed_time)}</a>
          <span class="dim">${s.best.start_date_local ? ' ' + day(s.best.start_date_local) : ''}</span></td>
        <td class="num"><a class="quiet-link" href="#/activity/${s.latest.activity_id}">${fmtTime(s.latest.elapsed_time)}</a>
          <span class="dim">${s.latest.start_date_local ? ' ' + day(s.latest.start_date_local) : ''}</span></td>
        <td>${trendText(s.trend)}</td></tr>`)}</tbody></table></div>
      <p class="panel-note" style="margin:10px 0 0">The trend is a straight line through elapsed times; it says nothing about why
        (wind, a stop at the lights, an easy day). Under three attempts there is none, and "no clear trend" means the slope is
        within two standard errors of flat.</p>
    </section>
    ${charted.length ? html`<section class="panel"><div class="panel-head"><p class="eyebrow">Progression</p>
      <p class="panel-note">${charted.length < segs.filter(s => s.attempts >= 2).length ? `the ${CHARTS} most attempted` : 'segments with two or more attempts'}</p></div>
      <div class="seg-charts">${charted.map(chart)}</div></section>` : ''}`;
}

export function mount(el) {
  const rerender = () => { el.innerHTML = String(render()); mount(el); };
  const input = el.querySelector('#seg-n'), go = el.querySelector('#seg-fetch'), clear = el.querySelector('#seg-clear');
  if (go) go.onclick = () => {
    lastN = Math.max(1, Math.min(100, Math.round(+input.value || 10)));
    const pick = stravaRuns().slice(0, lastN).filter(a => !hasEfforts(a)).map(a => a.strava_id);
    const n = R.setSegmentsWanted(state, pick, true);
    if (n) save('edit');
    toast(n ? `${n} runs queued for the next Strava pull` : 'Those runs are already queued or have their segments');
    rerender();
  };
  if (clear) clear.onclick = () => {
    const n = R.setSegmentsWanted(state, R.wantedSegments(state), false);
    if (n) save('edit');
    toast('Queue cleared');
    rerender();
  };
}
