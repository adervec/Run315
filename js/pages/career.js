// Everything, not the last twelve weeks: the lifetime ledger, the week streak, this
// year against the same point last year, year by year, and all the climbing as a landmark.
import { state } from '../store.js';
import * as D from '../derive.js';
import * as RE from '../lib/recap.js';
import * as LM from '../lib/landmarks.js';
import { dayKey } from '../lib/dt.js';
import { html, pageHead, emptyState, useCss } from '../ui.js';

export const title = 'Career';

const CSS = `
.huge { font-family: var(--display); font-size: 56px; font-weight: 800; letter-spacing: -0.04em; line-height: 1; color: var(--measured); }
.ladder-bar { height: 10px; border-radius: 5px; background: var(--track); overflow: hidden; margin: 10px 0 6px; }
.ladder-bar i { display: block; height: 100%; background: var(--measured); }
.tier { display: inline-block; font-family: var(--mono); font-size: 11px; padding: 2px 7px; border-radius: 10px;
  margin: 2px 3px 2px 0; background: var(--track); color: var(--muted); }
.tier.done { background: var(--measured); color: var(--on-ink); }
.yeartrack { display: block; height: 10px; background: var(--track); border-radius: 2px; }
.yearbar { display: block; height: 100%; background: var(--measured); border-radius: 2px; min-width: 2px; }
@media (max-width: 520px) { .huge { font-size: 42px; } }
`;

const n = v => Math.round(v || 0).toLocaleString('en-US');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : '');

export function render() {
  useCss('career', CSS);
  const head = pageHead('Career', 'Everything, not the last twelve weeks', html`<a class="btn btn-ghost" href="#/climbing">Climbing</a>`);
  const runs = D.runs(state);
  if (!runs.length) return html`${head}${emptyState('No runs yet',
    'The ledger counts every run you have ever logged. Bring in Garmin and Strava through the cowork folder, or load the demo athlete to look around.',
    html`<a class="btn" href="#/sync">Set up sync</a>`)}`;

  const now = new Date(), today = dayKey(now), year = now.getFullYear();
  // A race counts as finished once it has a time or a linked activity.
  const finished = Object.values(state.races).filter(r => r.actual_s != null || r.garmin_id != null).length;
  const career = RE.career(runs, finished, today);
  const years = RE.byYear(runs);
  const thisYear = RE.partialYearCompare(runs, year, today);
  const landmark = LM.compare(runs.reduce((s, a) => s + (a.elev_gain_m || 0), 0));
  const top = Math.max(1, ...years.map(y => y.distance_m));
  const m = career.distance_milestone, rm = career.race_milestone, st = career.streak;
  const first = career.first_run ? new Date(career.first_run) : null;

  return html`${head}
  <section class="panel">
    <div class="panel-head">
      <p class="eyebrow">The ledger</p>
      ${career.years ? html`<p class="panel-note">${career.years.toFixed(1)} years on record</p>` : ''}
    </div>
    <div class="grid-2">
      <div>
        <p class="huge">${n(career.km)}<small class="unit" style="font-size:20px"> km</small></p>
        <p class="stat-hint">across ${n(career.totals.runs)} runs
          and ${Math.round(career.totals.seconds / 3600)} hours${first ? `, since ${MONTHS[first.getMonth()]} ${first.getFullYear()}` : ''}.</p>
        ${career.equator && career.equator > 0.02 ? html`<p class="stat-hint">That is
          ${(career.equator * 100).toFixed(1)}% of the way round the equator.</p>` : ''}
      </div>
      <div>
        ${m && m.next ? html`<p class="eyebrow">Next milestone</p>
          <p style="font-size:19px;font-weight:600;margin:4px 0">${n(m.next)} km</p>
          <div class="ladder-bar"><i style="width:${(m.progress * 100).toFixed(1)}%"></i></div>
          <p class="stat-hint">${n(m.to_go)} km to go.</p>` : ''}
        <div style="margin-top:10px">
          ${RE.DISTANCE_TIERS_KM.map(t => html`<span class="tier ${career.km >= t ? 'done' : ''}">${n(t)}</span>`)}
        </div>
      </div>
    </div>
  </section>

  <section class="panel">
    <div class="panel-head"><p class="eyebrow">Habit</p></div>
    <div class="digest">
      <div class="stat"><div class="stat-value">${st.current}</div><div class="stat-label">Week streak</div>
        <div class="stat-hint">Consecutive weeks with a run in them.</div></div>
      <div class="stat"><div class="stat-value">${st.longest}</div><div class="stat-label">Longest ever</div></div>
      <div class="stat"><div class="stat-value">${st.weeks_run}</div><div class="stat-label">Weeks with a run</div></div>
      ${career.races_finished ? html`<div class="stat"><div class="stat-value">${career.races_finished}</div>
        <div class="stat-label">Races finished</div>
        ${rm && rm.next ? html`<div class="stat-hint">${Math.round(rm.to_go)} more to reach ${rm.next}.</div>` : ''}</div>` : ''}
    </div>
    <p class="stat-hint" style="margin-top:12px">
      Streaks are counted in weeks, not days, and that is a deliberate choice. A
      daily streak rewards running on the days you should not, which is how
      people get hurt. A week with a run in it is a habit; a run every single day
      is a compulsion with a badge attached.
    </p>
  </section>

  ${thisYear ? html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">${year} so far</p>
      <p class="panel-note">against the same point last year</p>
    </div>
    <div class="grid-2">
      <div><div class="stat">
        <div class="stat-value">${Math.round(thisYear.so_far_m / 1000)}<small class="unit">km</small></div>
        <div class="stat-label">This year to day ${thisYear.day_of_year}</div>
        <div class="stat-hint">${Math.round(thisYear.same_point_last_year_m / 1000)} km by this point last year.</div>
      </div></div>
      <div>
        <p class="verdict ${thisYear.change > 0.10 ? 'ahead' : thisYear.change < -0.10 ? 'behind' : ''}">${thisYear.note}</p>
        <p class="stat-hint">Compared like for like: only the part of last year
          that had happened by this date counts, because eleven months against
          twelve is not a decline.</p>
      </div>
    </div>
  </section>` : ''}

  ${years.length ? html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">Year by year</p>
      <p class="panel-note">${years.length} years</p>
    </div>
    <div class="table-scroll"><table>
      <thead><tr><th>Year</th><th class="num">Distance</th><th></th><th class="num">Runs</th>
        <th class="num">Hours</th><th class="num">Longest</th><th class="num">Ascent</th></tr></thead>
      <tbody>${years.map(y => html`<tr>
        <td><b>${y.year}</b>${y.year === year ? html` <span class="dim">so far</span>` : ''}</td>
        <td class="num actual">${Math.round(y.distance_m / 1000)} km</td>
        <td style="width:34%;min-width:80px"><span class="yeartrack"><i class="yearbar" style="width:${(y.distance_m / top * 100).toFixed(1)}%"></i></span></td>
        <td class="num dim">${y.runs}</td>
        <td class="num dim">${Math.round(y.seconds / 3600)}</td>
        <td class="num dim">${(y.longest_m / 1000).toFixed(1)} km</td>
        <td class="num dim">${Math.round(y.ascent_m)} m</td>
      </tr>`)}</tbody>
    </table></div>
  </section>` : ''}

  ${landmark ? html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Everything you have climbed</p></div>
    <p class="huge" style="font-size:34px">${landmark.phrase}</p>
    <p class="stat-hint">${cap(landmark.name)} is ${landmark.height_m} m, in ${landmark.where}.
      <a class="quiet-link" href="#/climbing">How you climb →</a></p>
  </section>` : ''}`;
}
