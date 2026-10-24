// Every activity, newest first, filterable by sport and source.
import { state } from '../store.js';
import * as D from '../derive.js';
import { RUN_TYPES } from '../lib/fitness.js';
import { html, pageHead, emptyState, km, pace, fmtTime, day, typeLabel, useCss } from '../ui.js';

export const title = 'Activities';
const RIDES = /cycl|biking|ride/;
const FILTERS = { all: () => true, runs: a => RUN_TYPES.has(a.type), rides: a => RIDES.test(a.type), other: a => !RUN_TYPES.has(a.type) && !RIDES.test(a.type) };
let filter = 'all', limit = 100;

const CSS = `
.act-filters { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
.act-filters button[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); }
.src { font-family: var(--mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); }
.src.strava { color: #fc4c02; }
`;

export function render() {
  useCss('activities', CSS);
  const all = D.activities(state);
  if (!all.length) return html`${pageHead('Activities')}${emptyState('No activities yet',
    'Bring in Garmin and Strava through the cowork folder, or load the demo athlete to look around.',
    html`<a class="btn" href="#/sync">Set up sync</a>`)}`;
  const shown = all.filter(FILTERS[filter]);
  return html`
    ${pageHead('Activities', `${all.length} activities · ${all.filter(a => a.strava_id).length} linked to Strava`)}
    <div class="act-filters" role="group" aria-label="Filter">
      ${Object.keys(FILTERS).map(k => html`<button class="btn btn-ghost" data-filter="${k}" aria-pressed="${k === filter}">${k}</button>`)}
    </div>
    <section class="panel"><div class="table-scroll"><table>
      <thead><tr><th>Date</th><th>Activity</th><th class="num">Distance</th><th class="num">Time</th>
        <th class="num">Pace</th><th class="num">HR</th><th class="num">Climb</th></tr></thead>
      <tbody>${shown.slice(0, limit).map(a => html`<tr>
        <td class="dim">${day(a.start.toISOString())}</td>
        <td><a class="quiet-link" href="#/activity/${a.id}">${a.name}</a>
          <span class="dim"> · ${typeLabel(a.type)}</span>
          ${a.strava_id ? html` <span class="src strava" title="Also on Strava">Strava</span>` : ''}
          ${state.derived[a.id] ? '' : html` <span class="src" title="No per-second stream yet">no stream</span>`}</td>
        <td class="num">${km(a.distance_m, 2)} km</td>
        <td class="num">${fmtTime(a.moving_s)}</td>
        <td class="num">${RUN_TYPES.has(a.type) ? pace(a.moving_s, a.distance_m) : a.distance_m && a.moving_s ? (a.distance_m / a.moving_s * 3.6).toFixed(1) + ' km/h' : '--'}</td>
        <td class="num">${a.avg_hr ? Math.round(a.avg_hr) : '--'}</td>
        <td class="num">${a.elev_gain_m ? Math.round(a.elev_gain_m) + ' m' : '--'}</td>
      </tr>`)}</tbody></table></div>
      ${shown.length > limit ? html`<p><button class="btn btn-ghost" id="more-acts">Show ${Math.min(100, shown.length - limit)} more</button></p>` : ''}
    </section>`;
}

export function mount(el) {
  el.querySelectorAll('[data-filter]').forEach(b => b.onclick = () => { filter = b.dataset.filter; limit = 100; rerender(el); });
  const more = el.querySelector('#more-acts');
  if (more) more.onclick = () => { limit += 100; rerender(el); };
}
function rerender(el) { el.innerHTML = String(render()); mount(el); }
