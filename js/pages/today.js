// The dashboard: the start list, this week, this morning, form and fitness, what the
// model believes you could race today, the efforts it is built on, the coach's review
// and the log. app.py's index() glue lives here.
import { state, save } from '../store.js';
import { put } from '../merge.js';
import * as D from '../derive.js';
import * as F from '../lib/fitness.js';
import { dayKey } from '../lib/dt.js';
import * as ai from '../ai.js';
import * as cowork from '../cowork.js';
import { html, raw, pageHead, emptyState, fmtTime, fmtPace, signed, day, typeLabel, ago, md, polyline, toast, useCss } from '../ui.js';
import { split, startRow, pastTable, calibrationNote, raceForm, wireRaceForms } from './races.js';

export const title = 'Today';

const CSS = `
.data-status ul { margin: 0; padding-left: 18px; }
.data-status li { margin: 4px 0; color: var(--muted); }
.data-status .kv { display: flex; gap: 6px 18px; flex-wrap: wrap; font-size: 14px; margin: 0 0 10px; }
.data-status .kv b { font-weight: 600; }
.today-actions { display: flex; gap: 8px; flex-wrap: wrap; }
`;

const pct = (v, d = 0) => (v * 100).toFixed(d);
const plus = (v, d = 0) => (v >= 0 ? '+' : '') + v.toFixed(d);
const cap = s => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
const weekday = d => d.toLocaleDateString('en-GB', { weekday: 'short' });

// SVG points for pace against distance, log-scaled on x. -> [points, labels]
function paceCurvePoints(prs, width = 680, height = 150) {
  const usable = prs.filter(([d, s]) => d && s).map(([d, s]) => [d, s]).sort((a, b) => a[0] - b[0]);
  if (usable.length < 2) return ['', []];
  const paces = usable.map(([d, s]) => s / (d / 1000));
  const loP = Math.min(...paces), spanP = Math.max(Math.max(...paces) - loP, 1);
  const loX = Math.log(usable[0][0]), spanX = Math.max(Math.log(usable[usable.length - 1][0]) - loX, 1e-9);
  const pts = [], labels = [];
  usable.forEach(([d, s], i) => {
    const x = (Math.log(d) - loX) / spanX * width, y = (paces[i] - loP) / spanP * (height - 20) + 10;
    pts.push(x.toFixed(1) + ',' + y.toFixed(1));
    labels.push([x, y, d, s, paces[i]]);
  });
  return [pts.join(' '), labels];
}

const latestReview = () => Object.values(state.reviews).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
const lastImport = () => Object.values(state.activities).reduce((m, a) => (a.u && a.u > m ? a.u : m), '');

// ---------- the start list (the races and the add form) ----------
function startList(now) {
  const { upcoming, past, today } = split(state, now);
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Start list</p><p class="panel-note">Projections update on every sync</p></div>
    ${upcoming.length ? html`<div class="startlist">${upcoming.map(([r, p]) => startRow(r, p, today))}</div>`
      : html`<div class="empty"><p>No races on the calendar. Add the next one and Run315 will
        project your finish time from here on.</p></div>`}
    ${past.length ? html`<details class="past-races">
      <summary>${past.length} past race${past.length !== 1 ? 's' : ''}</summary>${pastTable(past)}</details>` : ''}
    ${calibrationNote(D.calibration(state, now), upcoming.length)}
    ${raceForm()}
  </section>`;
}

// ---------- where the data stands (replaces the Garmin connection panel) ----------
function dataStatus() {
  const gaps = D.gaps(state), c = state.local.cloud || {};
  return html`<section class="panel data-status">
    <div class="panel-head"><p class="eyebrow">Data</p><p class="panel-note"><a class="quiet-link" href="#/sync">Sync &amp; cowork</a></p></div>
    <p class="kv"><span>Last import <b>${ago(lastImport())}</b></span>
      <span>Analysed streams <b>${Object.keys(state.derived).length}</b></span>
      ${c.enabled ? html`<span>Drive <b>${ago(c.lastSync)}</b></span>` : ''}</p>
    ${gaps.length ? html`<ul>${gaps.map(g => html`<li>${g}</li>`)}</ul>` : html`<p class="stat-hint">Nothing missing.</p>`}
  </section>`;
}

function weekPanel(digest) {
  if (!digest) return '';
  const { longest, fastest } = digest;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">This week</p><p class="panel-note">Since Monday ${day(digest.week_start)}</p></div>
    <div class="digest">
      <div class="stat"><div class="stat-value">${digest.this.km.toFixed(1)}<small class="unit">km</small></div>
        <div class="stat-label">Distance</div><div class="stat-hint">${signed(digest.km_delta)} km vs last week</div></div>
      <div class="stat"><div class="stat-value">${digest.this.hours.toFixed(1)}<small class="unit">h</small></div>
        <div class="stat-label">Time</div></div>
      <div class="stat"><div class="stat-value">${digest.this.load.toFixed(0)}</div>
        <div class="stat-label">Load</div><div class="stat-hint">${signed(digest.load_delta)} vs last week</div></div>
      ${longest ? html`<div class="stat"><div class="stat-value">${(longest.distance_m / 1000).toFixed(1)}<small class="unit">km</small></div>
        <div class="stat-label">Longest run</div>
        <div class="stat-hint"><a class="quiet-link" href="#/activity/${longest.id}">${weekday(longest.start)} · ${fmtPace(longest.moving_s, longest.distance_m)}</a></div></div>` : ''}
      ${fastest ? html`<div class="stat"><div class="stat-value">${fmtPace(fastest.moving_s, fastest.distance_m).replace(' /km', '')}<small class="unit">/km</small></div>
        <div class="stat-label">Fastest run</div>
        <div class="stat-hint"><a class="quiet-link" href="#/activity/${fastest.id}">${weekday(fastest.start)} · ${(fastest.distance_m / 1000).toFixed(1)} km</a></div></div>` : ''}
    </div></section>`;
}

function readyPanel(ready) {
  if (!ready || ready.score == null) return '';
  const l = ready.latest || {};
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">This morning</p>
      <p class="panel-note">${ready.day ? ready.day + ' · ' : ''}${cap(ready.confidence)} confidence</p></div>
    <div class="grid-2">
      <div><div class="stat"><div class="stat-value band-${ready.band}">${Math.round(ready.score)}</div>
        <div class="stat-label">Readiness · ${ready.band}</div><div class="stat-hint">${cap(ready.verdict)}.</div></div></div>
      <div><div class="digest">
        ${l.hrv_ms ? html`<div class="stat"><div class="stat-value">${Math.round(l.hrv_ms)}<small class="unit">ms</small></div>
          <div class="stat-label">HRV${ready.hrv_status ? ' · ' + ready.hrv_status.replace(/_/g, ' ') : ''}</div>
          ${ready.hrv_trend ? html`<div class="stat-hint">${ready.hrv_trend} over two weeks</div>` : ''}</div>` : ''}
        ${l.rhr ? html`<div class="stat"><div class="stat-value">${Math.round(l.rhr)}<small class="unit">bpm</small></div>
          <div class="stat-label">Resting HR</div>
          ${ready.rhr_trend ? html`<div class="stat-hint">${ready.rhr_trend} over two weeks</div>` : ''}</div>` : ''}
        ${l.sleep_hours ? html`<div class="stat"><div class="stat-value">${l.sleep_hours.toFixed(1)}<small class="unit">h</small></div>
          <div class="stat-label">Slept</div>
          ${l.sleep_score ? html`<div class="stat-hint">score ${Math.round(l.sleep_score)}</div>` : ''}</div>` : ''}
      </div></div>
    </div>
    ${ready.advice ? html`<p class="stat-hint" style="margin-top:14px">${ready.advice}</p>` : ''}
  </section>`;
}

function heatPanel(heat) {
  if (!heat || !(heat.sessions > 0.4)) return '';
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Heat</p><p class="panel-note">${heat.recent} hot runs in the last fortnight</p></div>
    <div class="grid-2">
      <div><div class="stat"><div class="stat-value">${cap(heat.band)}</div><div class="stat-label">Acclimatisation</div>
        <div class="stat-hint">${heat.sessions.toFixed(1)} sessions' worth still counting${heat.hottest_c != null ? html`; hottest
          ${Math.round(heat.hottest_c)}°C` : ''}.</div></div></div>
      <div><p class="stat-hint">${heat.note}</p></div>
    </div>
    <p class="stat-hint" style="margin-top:10px">
      Ten to fourteen days of running in the heat produces real adaptation, most
      of it in the first week, and it fades within a few weeks of stopping. This
      is bookkeeping on your exposure, not a measurement of your blood plasma.</p>
  </section>`;
}

function zonePanel(z) {
  if (!z) return '';
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">How hard you train</p>
      <p class="panel-note">Last 12 weeks${z.label ? ' · ' + cap(z.label) : ''}${z.index ? ' · PI ' + z.index.toFixed(1) : ''}</p></div>
    <div class="polar-bar">
      <span class="p-easy" style="width:${pct(z.easy, 1)}%" title="Easy ${pct(z.easy)}%"></span>
      <span class="p-mod" style="width:${pct(z.moderate, 1)}%" title="Moderate ${pct(z.moderate)}%"></span>
      <span class="p-hard" style="width:${pct(z.hard, 1)}%" title="Hard ${pct(z.hard)}%"></span>
    </div>
    <div class="polar-key">
      <span><i class="p-easy"></i>${pct(z.easy)}% easy</span>
      <span><i class="p-mod"></i>${pct(z.moderate)}% moderate</span>
      <span><i class="p-hard"></i>${pct(z.hard)}% hard</span>
    </div>
    <p class="stat-hint" style="margin-top:12px">${z.verdict}</p>
  </section>`;
}

function territoryPanel(t) {
  if (!t) return '';
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">intvl · territory</p>
      <p class="panel-note"><a class="quiet-link" href="#/territory">Open the map</a></p></div>
    <div class="digest">
      <div class="stat"><div class="stat-value">${t.max_square}<small class="unit">×${t.max_square}</small></div><div class="stat-label">Max square</div></div>
      <div class="stat"><div class="stat-value">${t.tiles}</div><div class="stat-label">Tiles claimed</div>
        <div class="stat-hint">${t.area_km2.toFixed(1)} km²</div></div>
      <div class="stat"><div class="stat-value">${t.this_week}</div><div class="stat-label">New this week</div></div>
      ${t.targets && t.targets.length ? html`<div class="stat"><div class="stat-value">${t.targets[0][2]}</div>
        <div class="stat-label">Tiles to ${t.max_square + 1}×${t.max_square + 1}</div>
        <div class="stat-hint">Nearest way to grow the square.</div></div>` : ''}
    </div></section>`;
}

// ---------- form + fitness curve ----------
function fitnessPanel(s) {
  const top = Math.max(...s.curve.map(c => c[2]), ...s.curve.map(c => c[3]), 1);
  const ctl = polyline(s.curve.map(c => c[2]), top), atl = polyline(s.curve.map(c => c[3]), top);
  const sp = s.spike;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Fitness and freshness</p><p class="panel-note">Last 180 days</p></div>
    <div class="grid-2">
      <div>
        <div class="stat"><div class="stat-value">${s.ctl.toFixed(0)}</div><div class="stat-label">Fitness · CTL</div>
          <div class="stat-hint">${signed(s.ctl - s.ctl_6w_ago)} over six weeks</div></div>
        <div class="stat"><div class="stat-value">${s.atl.toFixed(0)}</div><div class="stat-label">Fatigue · ATL</div></div>
        <div class="stat"><div class="stat-value">${signed(s.tsb)}</div><div class="stat-label">Form · TSB</div>
          <div class="stat-hint">${s.tsb > 5 ? 'Fresh — good for racing.' : s.tsb < -20 ? 'Deep in a training block.' : 'Training steadily.'}</div></div>
        ${s.threshold_hr ? html`<div class="stat"><div class="stat-value">${s.threshold_hr.toFixed(0)}</div>
          <div class="stat-label">Threshold HR · est.</div></div>` : ''}
        ${sp ? html`<div class="stat"><div class="stat-value ${sp[0] > 1.30 ? 'risk' : ''}">${plus((sp[0] - 1) * 100)}<small class="unit">%</small></div>
          <div class="stat-label">Last run vs your longest</div>
          <div class="stat-hint">${(sp[1] / 1000).toFixed(1)} km against ${(sp[2] / 1000).toFixed(1)} km — ${sp[3]}.</div></div>` : ''}
      </div>
      <div>
        <svg class="chart" viewBox="0 0 680 140" preserveAspectRatio="none" role="img"
             aria-label="Fitness and fatigue over the last 180 days, peak ${top.toFixed(0)}">
          ${[35, 70, 105].map(y => html`<line x1="0" y1="${y}" x2="680" y2="${y}" style="stroke:var(--line)" stroke-width="1"/>`)}
          ${ctl ? html`<polygon points="0,140 ${ctl} 680,140" style="fill:var(--measured)" fill-opacity="0.10"/>
          <polyline points="${atl}" fill="none" style="stroke:var(--projected)" stroke-width="1.5" stroke-opacity="0.55" vector-effect="non-scaling-stroke"/>
          <polyline points="${ctl}" fill="none" style="stroke:var(--measured)" stroke-width="2.5" vector-effect="non-scaling-stroke"/>` : ''}
        </svg>
        <div class="chart-legend">
          <span><i class="swatch" style="background:var(--measured)"></i>Fitness</span>
          <span><i class="swatch" style="background:var(--projected);opacity:.55"></i>Fatigue</span>
        </div>
      </div>
    </div></section>`;
}

// ---------- equivalents + efforts ----------
function modelPanels(s) {
  const standards = F.STANDARD_RACES.map(([label, dist]) => [label, dist, F.projectRace(s, dist)]).filter(x => x[2]);
  const fit = s.fit;
  return html`<div class="grid-half">
    <section class="panel"><div class="panel-head"><p class="eyebrow">If you raced today</p></div>
      ${standards.length ? html`<div class="table-scroll"><table>
        <thead><tr><th>Distance</th><th class="num">Projected</th><th class="num">Pace</th></tr></thead>
        <tbody>${standards.map(([label, dist, p]) => html`<tr><td>${label}</td>
          <td class="num time">${fmtTime(p.seconds)}</td><td class="num dim">${fmtPace(p.seconds, dist)}</td></tr>`)}</tbody>
      </table></div>` : html`<div class="empty"><p>No projection yet: the model needs a hard run or two first.</p></div>`}
    </section>
    <section class="panel"><div class="panel-head"><p class="eyebrow">Efforts driving the model</p></div>
      ${fit ? html`<div class="table-scroll"><table>
          <thead><tr><th>Distance</th><th class="num">Time</th><th class="num">Pace</th><th class="num">Ago</th></tr></thead>
          <tbody>${fit[2].map(([d, t, age]) => html`<tr><td>${(d / 1000).toFixed(2)} km</td>
            <td class="num actual">${fmtTime(t)}</td><td class="num dim">${fmtPace(t, d)}</td><td class="num dim">${Math.round(age)}d</td></tr>`)}</tbody>
        </table></div>
        <p class="stat-hint" style="margin-top:12px">Fatigue exponent ${fit[1].toFixed(3)} —
          ${fit[1] > 1.09 ? 'you fade more than average over distance.' : fit[1] < 1.04 ? 'you hold pace unusually well as distance grows.' : 'close to the textbook 1.06.'}</p>`
      : html`<div class="empty"><p>No hard runs found in the last 180 days. Run a 5K or 10K
          flat out and the projections sharpen immediately.</p></div>`}
    </section></div>`;
}

// ---------- best-effort curve + records ----------
function recordPanels(prs) {
  if (!prs.length) return '';
  const [pts, labels] = paceCurvePoints(prs);
  const paces = labels.map(l => l[4]);
  return html`<div class="grid-half">
    <section class="panel"><div class="panel-head"><p class="eyebrow">Your pace curve</p><p class="panel-note">Measured inside runs</p></div>
      ${pts ? html`<svg class="chart chart-curve" viewBox="0 0 680 150" role="img" aria-label="Fastest pace held against distance">
          <polyline points="${pts}" fill="none" style="stroke:var(--measured)" stroke-width="2"/>
          <text x="0" y="9" class="axis-label">${fmtPace(Math.min(...paces), 1000)}</text>
          <text x="0" y="148" class="axis-label">${fmtPace(Math.max(...paces), 1000)}</text>
          ${labels.map(([x, y]) => html`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" style="fill:var(--measured)"/>`)}
        </svg>
        <div class="chart-legend"><span>${(prs[0][0] / 1000).toFixed(1)} km</span>
          <span style="margin-left:auto">slower as distance grows →</span><span>${(prs[prs.length - 1][0] / 1000).toFixed(1)} km</span></div>`
      : html`<div class="empty"><p>Two or more best efforts are needed to draw the curve.</p></div>`}
    </section>
    <section class="panel"><div class="panel-head"><p class="eyebrow">Personal records</p><p class="panel-note">All time, from inside every run</p></div>
      <div class="table-scroll"><table>
        <thead><tr><th>Distance</th><th class="num">Best</th><th class="num">Pace</th><th class="num">Set</th></tr></thead>
        <tbody>${prs.map(([dist, secs, when]) => html`<tr><td>${(dist / 1000).toFixed(2)} km</td>
          <td class="num actual">${fmtTime(secs)}</td><td class="num dim">${fmtPace(secs, dist)}</td><td class="num dim">${when}</td></tr>`)}</tbody>
      </table></div></section></div>`;
}

// ---------- prescriptions ----------
function prescriptionPanels(s) {
  if (!s.paces.length && !s.zones.length) return '';
  return html`<div class="grid-half">
    ${s.paces.length ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">Your training paces</p><p class="panel-note">From today's fitness</p></div>
      <div class="table-scroll"><table><thead><tr><th>Type</th><th class="num">Pace range</th></tr></thead>
        <tbody>${s.paces.map(([name, purpose, fast, slow]) => html`<tr><td>${name}<span class="dim"><br>${purpose}</span></td>
          <td class="num actual">${fmtTime(fast)}–${fmtPace(slow, 1000)}</td></tr>`)}</tbody></table></div>
      ${s.threshold_pace ? html`<p class="stat-hint" style="margin-top:12px">Anchored on ${fmtPace(s.threshold_pace, 1000)},
        the pace your curve says you could hold for an hour.</p>` : ''}
    </section>` : ''}
    ${s.zones.length ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">Heart rate zones</p><p class="panel-note">On threshold ${s.threshold_hr.toFixed(0)} bpm</p></div>
      <div class="table-scroll"><table><thead><tr><th>Zone</th><th class="num">Range</th></tr></thead>
        <tbody>${s.zones.map(([name, lo, hi]) => html`<tr><td>${name}</td><td class="num">${lo ? `${lo}–${hi}` : `under ${hi}`} bpm</td></tr>`)}</tbody>
      </table></div></section>` : ''}
  </div>`;
}

// ---------- AI review ----------
// With the athlete's own key the review is written here and now; without one it is
// the cowork coach channel's standing weekly job.
function reviewPanel() {
  const r = latestReview();
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Coach review</p>
      ${r ? html`<p class="panel-note">${String(r.created_at).slice(0, 16).replace('T', ' ')}${r.source ? ' · ' + r.source : ''}</p>` : ''}</div>
    ${r ? html`<div class="review">${md(r.markdown)}</div>`
      : html`<div class="empty"><p>Have Claude read your load, your best efforts and your race
        calendar, then say what to change over the next four weeks.</p></div>`}
    <div style="margin-top:16px"><button class="btn${r ? ' btn-ghost' : ''}" type="button" data-act="review">
      ${r ? 'Run a new review' : 'Write my review'}</button></div>
    ${ai.apiKey() ? '' : html`<p class="panel-note" style="margin-top:8px">No API key on this device: reviews arrive through the
      cowork folder's coach channel. Add a key on <a class="quiet-link" href="#/sync">Sync &amp; cowork</a> to write one here.</p>`}
  </section>`;
}

// ---------- training calendar ----------
function calendarPanel(s, now) {
  const cal = D.trainingCalendar(s.daily, now);
  const top = Math.max(1, ...cal.flatMap(([, days]) => days.map(([, l]) => l)));
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Training log</p><p class="panel-note">Last 26 weeks · darker is a harder day</p></div>
    <div class="heat-scroll"><div class="heat">
      ${cal.map(([, days]) => html`<div class="heat-col">${days.map(([d, load]) => html`<span class="heat-cell${load ? '' : ' heat-empty'}"
        ${load ? raw(`style="opacity:${(0.2 + 0.8 * load / top).toFixed(2)}"`) : ''} title="${d} · load ${Math.round(load)}"></span>`)}</div>`)}
    </div></div></section>`;
}

function recentPanel(acts) {
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Recent activity</p><p class="panel-note"><a class="quiet-link" href="#/activities">All activities</a></p></div>
    <div class="table-scroll"><table>
      <thead><tr><th>Date</th><th>Activity</th><th class="num">Distance</th><th class="num">Time</th><th class="num">Pace / speed</th><th class="num">HR</th></tr></thead>
      <tbody>${acts.map(a => html`<tr>
        <td class="dim">${day(dayKey(a.start))}</td>
        <td><a class="quiet-link" href="#/activity/${a.id}">${a.name}</a><span class="dim"> · ${typeLabel(a.type)}</span></td>
        <td class="num">${((a.distance_m || 0) / 1000).toFixed(2)} km</td>
        <td class="num">${fmtTime(a.moving_s)}</td>
        <td class="num dim">${F.fmtEffort(a)}</td>
        <td class="num dim">${a.avg_hr ? Math.round(a.avg_hr) : '--'}</td>
      </tr>`)}</tbody></table></div></section>`;
}

export function render() {
  useCss('today', CSS);
  const now = new Date(), acts = D.activities(state);
  if (!acts.length) return html`${pageHead('Today')}
    ${emptyState('No data yet', 'Bring in Garmin and Strava through the cowork folder (up to a year of history on the first pass), or load the demo athlete to look around.',
      html`<div class="today-actions"><button class="btn" type="button" data-act="demo">Load demo athlete</button>
        <a class="btn btn-ghost" href="#/sync">Set up sync</a></div>`)}
    ${startList(now)}`;
  const s = D.summary(state, now);
  const digest = s ? F.weekDigest(acts, now, s.threshold_hr, F.thresholds(acts)[1]) : null;
  return html`
    ${pageHead('Today', `${acts.length} activities · last import ${ago(lastImport())}`)}
    ${startList(now)}
    ${s ? html`
      ${weekPanel(digest)}
      ${readyPanel(D.readinessToday(state, s.tsb))}
      ${heatPanel(D.heatState(state, now))}
      ${zonePanel(D.zoneSummary(state, s.threshold_hr, 12, now))}
      ${territoryPanel(D.tileSummary(state, now))}
      ${fitnessPanel(s)}
      ${modelPanels(s)}
      ${recordPanels(D.personalRecords(state))}
      ${prescriptionPanels(s)}
      ${reviewPanel()}
      ${calendarPanel(s, now)}` : ''}
    ${recentPanel(acts.slice(0, 15))}
    ${dataStatus()}`;
}

// Report finished runs to the maker's app portal (same-origin localStorage, this
// browser only). Each activity counts once ever -- the ids already reported are
// remembered -- and the demo athlete is excluded, because a synthetic athlete's
// runs are not yours.
function reportToPortal() {
  try {
    const acts = D.activities(state).slice(0, 15).filter(a => !String(a.garmin_id || '').startsWith('demo-'));
    const seenKey = 'run315-portal-seen', k = 'portal-activity';
    const seen = JSON.parse(localStorage.getItem(seenKey) || '[]'), log = JSON.parse(localStorage.getItem(k) || '[]');
    let added = 0;
    for (const a of acts) {
      if (seen.includes(a.id)) continue;
      seen.push(a.id);
      log.push([Math.round(Date.now() / 1000), 'Run315', 'cardio', Math.max(1, Math.round((a.moving_s || 0) / 600))]);
      added++;
    }
    if (added) {
      localStorage.setItem(k, JSON.stringify(log.slice(-2000)));
      localStorage.setItem(seenKey, JSON.stringify(seen.slice(-500)));
    }
  } catch (e) { /* quota or private mode - ignore */ }
}

export function mount(el) {
  const redraw = () => { el.innerHTML = String(render()); mount(el); };
  wireRaceForms(el, redraw);
  reportToPortal();
  const demo = el.querySelector('[data-act="demo"]');
  if (demo) demo.onclick = async () => {
    demo.disabled = true;
    try { const { loadDemo } = await import('./sync.js'); const r = await loadDemo(); toast(`Demo athlete loaded: ${r.activities} activities`); }
    catch (e) { toast('⚠ ' + (e.message || e)); console.error(e); }
    redraw();
  };
  const rev = el.querySelector('[data-act="review"]');
  if (rev) rev.onclick = async () => {
    if (!ai.apiKey()) {
      // No key: the coach channel writes the review on its next pass.
      if ((state.local.cowork || {}).enabled) cowork.exportNow(false).catch(() => {});
      toast('Queued for the cowork coach channel: the review lands here when the agent replies.');
      return;
    }
    rev.disabled = true; rev.textContent = 'Writing…';
    try {
      const markdown = await ai.coachReview();
      const id = 'r' + Date.now();
      put(state, 'reviews', id, { id, created_at: new Date().toISOString(), markdown, source: 'api' });
      save('edit');
      toast('New review ready.');
    } catch (e) { toast('The AI review failed: ' + (e.message || e)); console.error(e); }
    redraw();
  };
}
