// The dashboard: the start list, this week, this morning, form and fitness, what the
// model believes you could race today, the efforts it is built on, the coach's review
// and the log. app.py's index() glue lives here.
//
// It is a list of panels the athlete can hide and reorder (PANELS below), led by
// "Since you last looked": what arrived, what the cowork agent brought, what is missing.
import { state, save, rev } from '../store.js';
import { put } from '../merge.js';
import * as D from '../derive.js';
import * as F from '../lib/fitness.js';
import { dayKey } from '../lib/dt.js';
import * as ai from '../ai.js';
import * as cowork from '../cowork.js';
import * as E from '../events.js';
import { podPanel, mountPodPanel } from '../pod.js';
import { dayTagsWidget, mountDayTags } from '../journal.js';
import { strengthPanel } from '../strength.js';
import { html, raw, esc, t, pageHead, emptyState, fmtTime, fmtPace, signed, day, typeLabel, ago, md, polyline, toast, useCss } from '../ui.js';
import { split, startRow, pastTable, calibrationNote, raceForm, wireRaceForms } from './races.js';

export const title = 'Today';

const CSS = `
.data-status ul { margin: 0; padding-left: 18px; }
.data-status li { margin: 4px 0; color: var(--muted); }
.data-status .kv { display: flex; gap: 6px 18px; flex-wrap: wrap; font-size: 14px; margin: 0 0 10px; }
.data-status .kv b { font-weight: 600; }
.today-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.ev-list { list-style: none; margin: 0; padding: 0; }
.ev-list .ev { display: grid; grid-template-columns: auto 1fr; gap: 0 10px; padding: 8px 0; border-top: 1px solid var(--line); }
.ev-list .ev:first-child { border-top: 0; }
.ev-kind { font: 10px var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--measured); align-self: center; }
.ev-when { font: 11px var(--mono); color: var(--faint); text-align: right; align-self: center; }
.ev-title { grid-column: 1 / -1; color: var(--ink); font-weight: 600; text-decoration: none; }
.ev-title:hover { text-decoration: underline; }
.ev-detail { grid-column: 1 / -1; font-size: 13px; color: var(--muted); }
.ev-trend .ev-kind, .ev-race .ev-kind { color: var(--projected); }
.ev-plain { margin: 4px 0 0; padding-left: 18px; font-size: 14px; color: var(--muted); }
.ev-plain li { margin: 3px 0; }
.ev-plain b { color: var(--ink); font-weight: 600; }
.layout-list { list-style: none; margin: 0; padding: 0; }
.layout-list li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; padding: 8px 0; border-top: 1px solid var(--line); }
.layout-list li.off .layout-name { color: var(--faint); text-decoration: line-through; }
.layout-name { font-weight: 600; }
.layout-list .dim { font-size: 12px; }
.layout-btns { margin-left: auto; display: inline-flex; gap: 4px; }
.layout-btns .btn { min-width: 40px; }
`;

const pct = (v, d = 0) => (v * 100).toFixed(d);
const plus = (v, d = 0) => (v >= 0 ? '+' : '') + v.toFixed(d);
const cap = s => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
const weekday = d => (globalThis.appFont?.fmt?.custom ? globalThis.appFont.fmt.custom(d, { weekday: 'short' }) : d.toLocaleDateString(undefined, { weekday: 'short' }));   // iso-ok: a weekday name, not a date

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
    <div class="panel-head"><p class="eyebrow">${t('Start list')}</p><p class="panel-note">${t('Projections update on every sync')}</p></div>
    ${upcoming.length ? html`<div class="startlist">${upcoming.map(([r, p]) => startRow(r, p, today))}</div>`
      : html`<div class="empty"><p>${t('No races on the calendar. Add the next one and Run315 will project your finish time from here on.')}</p></div>`}
    ${past.length ? html`<details class="past-races">
      <summary>${t.n('{n} past race', '{n} past races', past.length)}</summary>${pastTable(past)}</details>` : ''}
    ${calibrationNote(D.calibration(state, now), upcoming.length)}
    ${raceForm()}
  </section>`;
}

// ---------- where the data stands (replaces the Garmin connection panel) ----------
function dataStatus() {
  const gaps = D.gaps(state), c = state.local.cloud || {};
  return html`<section class="panel data-status">
    <div class="panel-head"><p class="eyebrow">${t('Data')}</p><p class="panel-note"><a class="quiet-link" href="#/sync">${t('Sync & cowork')}</a></p></div>
    <p class="kv"><span>${t('Last import')} <b>${ago(lastImport())}</b></span>
      <span>${t('Analysed streams')} <b>${Object.keys(state.derived).length}</b></span>
      ${c.enabled ? html`<span>${t('Drive')} <b>${ago(c.lastSync)}</b></span>` : ''}</p>
    ${gaps.length ? html`<ul>${gaps.map(g => html`<li>${g}</li>`)}</ul>` : html`<p class="stat-hint">${t('Nothing missing.')}</p>`}
  </section>`;
}

function weekPanel(digest) {
  if (!digest) return '';
  const { longest, fastest } = digest;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('This week')}</p><p class="panel-note">${t('Since Monday {date}', { date: day(digest.week_start) })}</p></div>
    <div class="digest">
      <div class="stat"><div class="stat-value">${digest.this.km.toFixed(1)}<small class="unit">km</small></div>
        <div class="stat-label">${t('Distance')}</div><div class="stat-hint">${t('{delta} km vs last week', { delta: signed(digest.km_delta) })}</div></div>
      <div class="stat"><div class="stat-value">${digest.this.hours.toFixed(1)}<small class="unit">h</small></div>
        <div class="stat-label">${t('Time')}</div></div>
      <div class="stat"><div class="stat-value">${digest.this.load.toFixed(0)}</div>
        <div class="stat-label">${t('Load')}</div><div class="stat-hint">${t('{delta} vs last week', { delta: signed(digest.load_delta) })}</div></div>
      ${longest ? html`<div class="stat"><div class="stat-value">${(longest.distance_m / 1000).toFixed(1)}<small class="unit">km</small></div>
        <div class="stat-label">${t('Longest run')}</div>
        <div class="stat-hint"><a class="quiet-link" href="#/activity/${longest.id}">${weekday(longest.start)} · ${fmtPace(longest.moving_s, longest.distance_m)}</a></div></div>` : ''}
      ${fastest ? html`<div class="stat"><div class="stat-value">${fmtPace(fastest.moving_s, fastest.distance_m).replace(' /km', '')}<small class="unit">/km</small></div>
        <div class="stat-label">${t('Fastest run')}</div>
        <div class="stat-hint"><a class="quiet-link" href="#/activity/${fastest.id}">${weekday(fastest.start)} · ${(fastest.distance_m / 1000).toFixed(1)} km</a></div></div>` : ''}
    </div></section>`;
}

function readyPanel(ready) {
  if (!ready || ready.score == null) return '';
  const l = ready.latest || {};
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('This morning')}</p>
      <p class="panel-note">${ready.day ? ready.day + ' · ' : ''}${t('{level} confidence', { level: cap(ready.confidence) })}</p></div>
    <div class="grid-2">
      <div><div class="stat"><div class="stat-value band-${ready.band}">${Math.round(ready.score)}</div>
        <div class="stat-label">${t('Readiness')} · ${ready.band}</div><div class="stat-hint">${cap(ready.verdict)}.</div></div></div>
      <div><div class="digest">
        ${l.hrv_ms ? html`<div class="stat"><div class="stat-value">${Math.round(l.hrv_ms)}<small class="unit">ms</small></div>
          <div class="stat-label">${t('HRV')}${ready.hrv_status ? ' · ' + ready.hrv_status.replace(/_/g, ' ') : ''}</div>
          ${ready.hrv_trend ? html`<div class="stat-hint">${t('{trend} over two weeks', { trend: ready.hrv_trend })}</div>` : ''}</div>` : ''}
        ${l.rhr ? html`<div class="stat"><div class="stat-value">${Math.round(l.rhr)}<small class="unit">bpm</small></div>
          <div class="stat-label">${t('Resting HR')}</div>
          ${ready.rhr_trend ? html`<div class="stat-hint">${t('{trend} over two weeks', { trend: ready.rhr_trend })}</div>` : ''}</div>` : ''}
        ${l.sleep_hours ? html`<div class="stat"><div class="stat-value">${l.sleep_hours.toFixed(1)}<small class="unit">h</small></div>
          <div class="stat-label">${t('Slept')}</div>
          ${l.sleep_score ? html`<div class="stat-hint">${t('score {n}', { n: Math.round(l.sleep_score) })}</div>` : ''}</div>` : ''}
      </div></div>
    </div>
    ${ready.advice ? html`<p class="stat-hint" style="margin-top:14px">${ready.advice}</p>` : ''}
  </section>`;
}

function heatPanel(heat) {
  if (!heat || !(heat.sessions > 0.4)) return '';
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('Heat')}</p><p class="panel-note">${t.n('{n} hot run in the last fortnight', '{n} hot runs in the last fortnight', heat.recent)}</p></div>
    <div class="grid-2">
      <div><div class="stat"><div class="stat-value">${cap(t(heat.band))}</div><div class="stat-label">${t('Acclimatisation')}</div>
        <div class="stat-hint">${heat.hottest_c != null
          ? t("{n} sessions' worth still counting; hottest {c}°C.", { n: heat.sessions.toFixed(1), c: Math.round(heat.hottest_c) })
          : t("{n} sessions' worth still counting.", { n: heat.sessions.toFixed(1) })}</div></div></div>
      <div><p class="stat-hint">${heat.note}</p></div>
    </div>
    <p class="stat-hint" style="margin-top:10px">
      ${t('Ten to fourteen days of running in the heat produces real adaptation, most of it in the first week, and it fades within a few weeks of stopping. This is bookkeeping on your exposure, not a measurement of your blood plasma.')}</p>
  </section>`;
}

function zonePanel(z) {
  if (!z) return '';
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('How hard you train')}</p>
      <p class="panel-note">${t('Last 12 weeks')}${z.label ? ' · ' + cap(z.label) : ''}${z.index ? ' · ' + t('PI {n}', { n: z.index.toFixed(1) }) : ''}</p></div>
    <div class="polar-bar">
      <span class="p-easy" style="width:${pct(z.easy, 1)}%" title="${t('Easy {n}%', { n: pct(z.easy) })}"></span>
      <span class="p-mod" style="width:${pct(z.moderate, 1)}%" title="${t('Moderate {n}%', { n: pct(z.moderate) })}"></span>
      <span class="p-hard" style="width:${pct(z.hard, 1)}%" title="${t('Hard {n}%', { n: pct(z.hard) })}"></span>
    </div>
    <div class="polar-key">
      <span><i class="p-easy"></i>${t('{n}% easy', { n: pct(z.easy) })}</span>
      <span><i class="p-mod"></i>${t('{n}% moderate', { n: pct(z.moderate) })}</span>
      <span><i class="p-hard"></i>${t('{n}% hard', { n: pct(z.hard) })}</span>
    </div>
    <p class="stat-hint" style="margin-top:12px">${z.verdict}</p>
  </section>`;
}

function territoryPanel(tr) {
  if (!tr) return '';
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('intvl · territory')}</p>
      <p class="panel-note"><a class="quiet-link" href="#/territory">${t('Open the map')}</a></p></div>
    <div class="digest">
      <div class="stat"><div class="stat-value">${tr.max_square}<small class="unit">×${tr.max_square}</small></div><div class="stat-label">${t('Max square')}</div></div>
      <div class="stat"><div class="stat-value">${tr.tiles}</div><div class="stat-label">${t('Tiles claimed')}</div>
        <div class="stat-hint">${tr.area_km2.toFixed(1)} km²</div></div>
      <div class="stat"><div class="stat-value">${tr.this_week}</div><div class="stat-label">${t('New this week')}</div></div>
      ${tr.targets && tr.targets.length ? html`<div class="stat"><div class="stat-value">${tr.targets[0][2]}</div>
        <div class="stat-label">${t('Tiles to {size}', { size: `${tr.max_square + 1}×${tr.max_square + 1}` })}</div>
        <div class="stat-hint">${t('Nearest way to grow the square.')}</div></div>` : ''}
    </div></section>`;
}

// ---------- form + fitness curve ----------
function fitnessPanel(s) {
  const top = Math.max(...s.curve.map(c => c[2]), ...s.curve.map(c => c[3]), 1);
  const ctl = polyline(s.curve.map(c => c[2]), top), atl = polyline(s.curve.map(c => c[3]), top);
  const sp = s.spike;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('Fitness and freshness')}</p><p class="panel-note">${t('Last 180 days')}</p></div>
    <div class="grid-2">
      <div>
        <div class="stat"><div class="stat-value">${s.ctl.toFixed(0)}</div><div class="stat-label">${t('Fitness · CTL')}</div>
          <div class="stat-hint">${t('{delta} over six weeks', { delta: signed(s.ctl - s.ctl_6w_ago) })}</div></div>
        <div class="stat"><div class="stat-value">${s.atl.toFixed(0)}</div><div class="stat-label">${t('Fatigue · ATL')}</div></div>
        <div class="stat"><div class="stat-value">${signed(s.tsb)}</div><div class="stat-label">${t('Form · TSB')}</div>
          <div class="stat-hint">${s.tsb > 5 ? t('Fresh — good for racing.') : s.tsb < -20 ? t('Deep in a training block.') : t('Training steadily.')}</div></div>
        ${s.threshold_hr ? html`<div class="stat"><div class="stat-value">${s.threshold_hr.toFixed(0)}</div>
          <div class="stat-label">${t('Threshold HR · est.')}</div></div>` : ''}
        ${sp ? html`<div class="stat"><div class="stat-value ${sp[0] > 1.30 ? 'risk' : ''}">${plus((sp[0] - 1) * 100)}<small class="unit">%</small></div>
          <div class="stat-label">${t('Last run vs your longest')}</div>
          <div class="stat-hint">${t('{last} km against {longest} km — {verdict}.', { last: (sp[1] / 1000).toFixed(1), longest: (sp[2] / 1000).toFixed(1), verdict: t(sp[3]) })}</div></div>` : ''}
      </div>
      <div>
        <svg class="chart" viewBox="0 0 680 140" preserveAspectRatio="none" role="img"
             aria-label="${t('Fitness and fatigue over the last 180 days, peak {n}', { n: top.toFixed(0) })}">
          ${[35, 70, 105].map(y => html`<line x1="0" y1="${y}" x2="680" y2="${y}" style="stroke:var(--line)" stroke-width="1"/>`)}
          ${ctl ? html`<polygon points="0,140 ${ctl} 680,140" style="fill:var(--measured)" fill-opacity="0.10"/>
          <polyline points="${atl}" fill="none" style="stroke:var(--projected)" stroke-width="1.5" stroke-opacity="0.55" vector-effect="non-scaling-stroke"/>
          <polyline points="${ctl}" fill="none" style="stroke:var(--measured)" stroke-width="2.5" vector-effect="non-scaling-stroke"/>` : ''}
        </svg>
        <div class="chart-legend">
          <span><i class="swatch" style="background:var(--measured)"></i>${t('Fitness')}</span>
          <span><i class="swatch" style="background:var(--projected);opacity:.55"></i>${t('Fatigue')}</span>
        </div>
      </div>
    </div></section>`;
}

// ---------- equivalents + efforts ----------
function modelPanels(s) {
  const standards = F.STANDARD_RACES.map(([label, dist]) => [label, dist, F.projectRace(s, dist)]).filter(x => x[2]);
  const fit = s.fit;
  return html`<div class="grid-half">
    <section class="panel"><div class="panel-head"><p class="eyebrow">${t('If you raced today')}</p></div>
      ${standards.length ? html`<div class="table-scroll"><table>
        <thead><tr><th>${t('Distance')}</th><th class="num">${t('Projected')}</th><th class="num">${t('Pace')}</th></tr></thead>
        <tbody>${standards.map(([label, dist, p]) => html`<tr><td>${t(label)}</td>
          <td class="num time">${fmtTime(p.seconds)}</td><td class="num dim">${fmtPace(p.seconds, dist)}</td></tr>`)}</tbody>
      </table></div>` : html`<div class="empty"><p>${t('No projection yet: the model needs a hard run or two first.')}</p></div>`}
    </section>
    <section class="panel"><div class="panel-head"><p class="eyebrow">${t('Efforts driving the model')}</p></div>
      ${fit ? html`<div class="table-scroll"><table>
          <thead><tr><th>${t('Distance')}</th><th class="num">${t('Time')}</th><th class="num">${t('Pace')}</th><th class="num">${t('Ago')}</th></tr></thead>
          <tbody>${fit[2].map(([d, secs, age]) => html`<tr><td>${(d / 1000).toFixed(2)} km</td>
            <td class="num actual">${fmtTime(secs)}</td><td class="num dim">${fmtPace(secs, d)}</td><td class="num dim">${t('{n}d', { n: Math.round(age) })}</td></tr>`)}</tbody>
        </table></div>
        <p class="stat-hint" style="margin-top:12px">${fit[1] > 1.09 ? t('Fatigue exponent {n} — you fade more than average over distance.', { n: fit[1].toFixed(3) })
          : fit[1] < 1.04 ? t('Fatigue exponent {n} — you hold pace unusually well as distance grows.', { n: fit[1].toFixed(3) })
          : t('Fatigue exponent {n} — close to the textbook 1.06.', { n: fit[1].toFixed(3) })}</p>`
      : html`<div class="empty"><p>${t('No hard runs found in the last 180 days. Run a 5K or 10K flat out and the projections sharpen immediately.')}</p></div>`}
    </section></div>`;
}

// ---------- best-effort curve + records ----------
function recordPanels(prs) {
  if (!prs.length) return '';
  const [pts, labels] = paceCurvePoints(prs);
  const paces = labels.map(l => l[4]);
  return html`<div class="grid-half">
    <section class="panel"><div class="panel-head"><p class="eyebrow">${t('Your pace curve')}</p><p class="panel-note">${t('Measured inside runs')}</p></div>
      ${pts ? html`<svg class="chart chart-curve" viewBox="0 0 680 150" role="img" aria-label="${t('Fastest pace held against distance')}">
          <polyline points="${pts}" fill="none" style="stroke:var(--measured)" stroke-width="2"/>
          <text x="0" y="9" class="axis-label">${fmtPace(Math.min(...paces), 1000)}</text>
          <text x="0" y="148" class="axis-label">${fmtPace(Math.max(...paces), 1000)}</text>
          ${labels.map(([x, y]) => html`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" style="fill:var(--measured)"/>`)}
        </svg>
        <div class="chart-legend"><span>${(prs[0][0] / 1000).toFixed(1)} km</span>
          <span style="margin-left:auto">${t('slower as distance grows →')}</span><span>${(prs[prs.length - 1][0] / 1000).toFixed(1)} km</span></div>`
      : html`<div class="empty"><p>${t('Two or more best efforts are needed to draw the curve.')}</p></div>`}
    </section>
    <section class="panel"><div class="panel-head"><p class="eyebrow">${t('Personal records')}</p><p class="panel-note">${t('All time, from inside every run')}</p></div>
      <div class="table-scroll"><table>
        <thead><tr><th>${t('Distance')}</th><th class="num">${t('Best')}</th><th class="num">${t('Pace')}</th><th class="num">${t('Set')}</th></tr></thead>
        <tbody>${prs.map(([dist, secs, when]) => html`<tr><td>${(dist / 1000).toFixed(2)} km</td>
          <td class="num actual">${fmtTime(secs)}</td><td class="num dim">${fmtPace(secs, dist)}</td><td class="num dim">${when}</td></tr>`)}</tbody>
      </table></div></section></div>`;
}

// ---------- prescriptions ----------
function prescriptionPanels(s) {
  if (!s.paces.length && !s.zones.length) return '';
  return html`<div class="grid-half">
    ${s.paces.length ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('Your training paces')}</p><p class="panel-note">${t("From today's fitness")}</p></div>
      <div class="table-scroll"><table><thead><tr><th>${t('Type')}</th><th class="num">${t('Pace range')}</th></tr></thead>
        <tbody>${s.paces.map(([name, purpose, fast, slow]) => html`<tr><td>${t(name)}<span class="dim"><br>${t(purpose)}</span></td>
          <td class="num actual">${fmtTime(fast)}–${fmtPace(slow, 1000)}</td></tr>`)}</tbody></table></div>
      ${s.threshold_pace ? html`<p class="stat-hint" style="margin-top:12px">${t('Anchored on {pace}, the pace your curve says you could hold for an hour.', { pace: fmtPace(s.threshold_pace, 1000) })}</p>` : ''}
    </section>` : ''}
    ${s.zones.length ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('Heart rate zones')}</p><p class="panel-note">${t('On threshold {n} bpm', { n: s.threshold_hr.toFixed(0) })}</p></div>
      <div class="table-scroll"><table><thead><tr><th>${t('Zone')}</th><th class="num">${t('Range')}</th></tr></thead>
        <tbody>${s.zones.map(([name, lo, hi]) => html`<tr><td>${t(name)}</td><td class="num">${lo ? `${lo}–${hi}` : t('under {n}', { n: hi })} bpm</td></tr>`)}</tbody>
      </table></div></section>` : ''}
  </div>`;
}

// ---------- AI review ----------
// With the athlete's own key the review is written here and now; without one it is
// the cowork coach channel's standing weekly job.
// When the review was written: the reader's own date and clock where font.js is there.
function reviewWhen(at) {
  const f = globalThis.appFont?.fmt, d = new Date(at);
  return f && f.dateTime && !isNaN(d) ? f.dateTime(d) : String(at).slice(0, 16).replace('T', ' ');
}
// The no-key note, with the link to Sync & cowork placed inside the translated sentence.
function noKeyNote() {
  const link = `<a class="quiet-link" href="#/sync">${esc(t('Sync & cowork'))}</a>`;
  return raw(esc(t("No API key on this device: reviews arrive through the cowork folder's coach channel. Add a key on {link} to write one here.", { link: '\u0001' }))
    .replace('\u0001', link));
}
function reviewPanel() {
  const r = latestReview();
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('Coach review')}</p>
      ${r ? html`<p class="panel-note">${reviewWhen(r.created_at)}${r.source ? ' · ' + r.source : ''}</p>` : ''}</div>
    ${r ? html`<div class="review">${md(r.markdown)}</div>`
      : html`<div class="empty"><p>${t('Have Claude read your load, your best efforts and your race calendar, then say what to change over the next four weeks.')}</p></div>`}
    <div style="margin-top:16px"><button class="btn${r ? ' btn-ghost' : ''}" type="button" data-act="review">
      ${r ? t('Run a new review') : t('Write my review')}</button></div>
    ${ai.apiKey() ? '' : html`<p class="panel-note" style="margin-top:8px">${noKeyNote()}</p>`}
  </section>`;
}

// ---------- training calendar ----------
function calendarPanel(s, now) {
  const cal = D.trainingCalendar(s.daily, now);
  const top = Math.max(1, ...cal.flatMap(([, days]) => days.map(([, l]) => l)));
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('Training log')}</p><p class="panel-note">${t('Last 26 weeks · darker is a harder day')}</p></div>
    <div class="heat-scroll"><div class="heat">
      ${cal.map(([, days]) => html`<div class="heat-col">${days.map(([d, load]) => html`<span class="heat-cell${load ? '' : ' heat-empty'}"
        ${load ? raw(`style="opacity:${(0.2 + 0.8 * load / top).toFixed(2)}"`) : ''} title="${t('{day} · load {n}', { day: d, n: Math.round(load) })}"></span>`)}</div>`)}
    </div></div></section>`;
}

function recentPanel(acts) {
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('Recent activity')}</p><p class="panel-note"><a class="quiet-link" href="#/activities">${t('All activities')}</a></p></div>
    <div class="table-scroll"><table>
      <thead><tr><th>${t('Date')}</th><th>${t('Activity')}</th><th class="num">${t('Distance')}</th><th class="num">${t('Time')}</th><th class="num">${t('Pace / speed')}</th><th class="num">${t('HR')}</th></tr></thead>
      <tbody>${acts.map(a => html`<tr>
        <td class="dim">${day(dayKey(a.start))}</td>
        <td><a class="quiet-link" href="#/activity/${a.id}">${a.name}</a><span class="dim"> · ${typeLabel(a.type)}</span></td>
        <td class="num">${((a.distance_m || 0) / 1000).toFixed(2)} km</td>
        <td class="num">${fmtTime(a.moving_s)}</td>
        <td class="num dim">${F.fmtEffort(a)}</td>
        <td class="num dim">${a.avg_hr ? Math.round(a.avg_hr) : '--'}</td>
      </tr>`)}</tbody></table></div></section>`;
}

// ---------- since you last looked ----------
// What is new on this device since the dashboard was last on screen for a few
// seconds: the events that arrived, what the cowork sweeps brought in, and what is
// still missing. lastSeen is device-local on purpose -- having looked on the phone is
// no reason for the desktop to skip the news.
const SEEN_AFTER_MS = 4000;
function digestPanel(c) {
  const d = E.digest(c.events, { lastSeen: state.local.lastSeen || null, now: c.now, coworkRuns: cowork.runs(), gaps: D.gaps(state, c.now) });
  // The latest note per channel: an inbox polled every five minutes is not five pieces of news.
  const byChannel = new Map();
  for (const r of d.cowork) if (!byChannel.has(r.channel)) byChannel.set(r.channel, r);
  const nothing = !d.events.length && !byChannel.size;
  return html`<section class="panel digest-panel">
    <div class="panel-head"><p class="eyebrow">${t('Since you last looked')}</p>
      <p class="panel-note">${d.first ? t('First look on this device: the last two weeks') : t('Last looked {when}', { when: ago(d.since) })}</p></div>
    ${nothing ? html`<p class="stat-hint">${d.first ? t('Nothing new in the last two weeks.') : t('Nothing new since then.')}</p>` : ''}
    ${d.events.length ? eventList(d.events.slice(0, 8)) : ''}
    ${d.events.length > 8 ? html`<p class="stat-hint"><a class="quiet-link" href="#/achievements">${t('{n} more', { n: d.events.length - 8 })}</a></p>` : ''}
    ${byChannel.size ? html`<p class="eyebrow" style="margin-top:14px">${t('From the cowork folder')}</p>
      <ul class="ev-plain">${[...byChannel.values()].map(r => html`<li><b>${r.channel}</b> · ${r.note} <span class="dim">· ${ago(r.at)}</span></li>`)}</ul>` : ''}
    ${d.gaps.length ? html`<p class="eyebrow" style="margin-top:14px">${t('Still missing')}</p>
      <ul class="ev-plain">${d.gaps.map(g => html`<li>${g}</li>`)}</ul>` : ''}
  </section>`;
}
function mountDigest(el) {
  setTimeout(() => {
    if (!el.isConnected || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    state.local.lastSeen = new Date().toISOString();
    save('local');
  }, SEEN_AFTER_MS);
}

// i18n-keys: Best effort | Long run | Streak | Career | Territory | Trails | Race | Readiness
const KIND = { best: 'Best effort', longest: 'Long run', streak: 'Streak', career: 'Career', tiles: 'Territory', square: 'Territory',
  trail: 'Trails', race: 'Race', trend: 'Readiness' };
export function eventList(evs) {
  return html`<ul class="ev-list">${evs.map(e => html`<li class="ev ev-${e.kind}">
    <span class="ev-kind">${KIND[e.kind] ? t(KIND[e.kind]) : e.kind}</span><span class="ev-when">${day(String(e.at).slice(0, 10))}</span>
    <a class="ev-title" href="${e.link || '#/achievements'}">${e.title}</a>
    ${e.detail ? html`<span class="ev-detail">${e.detail}</span>` : ''}</li>`)}</ul>`;
}
function achievementsPanel(c) {
  if (!c.events.length) return '';
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('Achievements')}</p>
      <p class="panel-note"><a class="quiet-link" href="#/achievements">${t('All {n}', { n: c.events.length })}</a></p></div>
    ${eventList(c.events.slice(0, 6))}
  </section>`;
}

// ---------- the dashboard as panels ----------
// Every section is a panel {id, title, render(ctx), mount?(el, ctx)}; the athlete hides
// and reorders them, and the layout syncs as profile.layout = {order, hidden}. A panel
// that renders '' (no data yet, or another module's hook still a stub) simply is not there.
function hook(fn) {
  try { const s = String(fn() ?? ''); return s.trim() ? raw(s) : ''; } catch (e) { console.warn('hook', e); return ''; }
}
const needS = f => c => (c.s ? f(c) : '');
// journal.js's day widget is bare markup; it gets its panel here.
function dayPanel(c) {
  const w = hook(() => dayTagsWidget(c.today));
  return w ? html`<section class="panel"><div class="panel-head"><p class="eyebrow">${t('Today')}</p>
    <p class="panel-note">${t('Tag the day: illness, travel, sleep…')} <a class="quiet-link" href="#/calendar">${t('Calendar')}</a></p></div>${w}</section>` : '';
}
// Panel titles are translated where they are shown (the layout editor).
// i18n-keys: Since you last looked | Start list | Plan of the day | Today’s tags | This week | This morning | Heat
// i18n-keys: How hard you train | Territory | Strength (GymTracker) | Fitness and freshness | If you raced today
// i18n-keys: Pace curve and records | Training paces and zones | Achievements | Coach review | Training log
// i18n-keys: Recent activity | Data
export const PANELS = [
  { id: 'digest', title: 'Since you last looked', render: digestPanel, mount: mountDigest },
  { id: 'start', title: 'Start list', render: c => startList(c.now) },
  { id: 'pod', title: 'Plan of the day', render: () => hook(() => podPanel()), mount: el => mountPodPanel(el) },
  { id: 'daytags', title: 'Today’s tags', render: dayPanel, mount: (el, c) => mountDayTags(el, c.today) },
  { id: 'week', title: 'This week', render: needS(c => weekPanel(c.digest)) },
  { id: 'ready', title: 'This morning', render: needS(c => readyPanel(D.readinessToday(state, c.s.tsb))) },
  { id: 'heat', title: 'Heat', render: needS(c => heatPanel(D.heatState(state, c.now))) },
  { id: 'zones', title: 'How hard you train', render: needS(c => zonePanel(D.zoneSummary(state, c.s.threshold_hr, 12, c.now))) },
  { id: 'territory', title: 'Territory', render: needS(c => territoryPanel(D.tileSummary(state, c.now))) },
  { id: 'strength', title: 'Strength (GymTracker)', render: () => hook(() => strengthPanel()) },
  { id: 'fitness', title: 'Fitness and freshness', render: needS(c => fitnessPanel(c.s)) },
  { id: 'model', title: 'If you raced today', render: needS(c => modelPanels(c.s)) },
  { id: 'records', title: 'Pace curve and records', render: needS(() => recordPanels(D.personalRecords(state))) },
  { id: 'paces', title: 'Training paces and zones', render: needS(c => prescriptionPanels(c.s)) },
  { id: 'achievements', title: 'Achievements', render: achievementsPanel },
  { id: 'review', title: 'Coach review', render: needS(() => reviewPanel()) },
  { id: 'log', title: 'Training log', render: needS(c => calendarPanel(c.s, c.now)) },
  { id: 'recent', title: 'Recent activity', render: c => recentPanel(c.acts.slice(0, 15)) },
  { id: 'data', title: 'Data', render: () => dataStatus() },
];

// The saved order, with panels added since it was saved slotted in after the panel that
// precedes them by default (so a new panel appears where it was designed to, not last).
export function arrange(ids, layout) {
  const out = (layout && Array.isArray(layout.order) ? layout.order : []).filter((id, i, a) => ids.includes(id) && a.indexOf(id) === i);
  ids.forEach((id, k) => {
    if (out.includes(id)) return;
    const prev = ids.slice(0, k).reverse().find(p => out.includes(p));
    out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, id);
  });
  return out;
}
const layoutOf = () => (state.profile && state.profile.layout) || { order: [], hidden: [] };
function saveLayout(layout) {
  state.profile = { ...state.profile, layout: { order: layout.order, hidden: [...new Set(layout.hidden)] }, u: new Date().toISOString() };
  save('edit');
}

let _edit = false, _ctx = null;
function renderPanel(p, c) {
  try { return String(p.render(c) || ''); } catch (e) { console.error('panel ' + p.id, e); return ''; }
}

export function render() {
  useCss('today', CSS);
  const now = new Date(), acts = D.activities(state);
  if (!acts.length) return html`${pageHead(t('Today'))}
    ${emptyState(t('No data yet'), t('Bring in Garmin and Strava through the cowork folder (up to a year of history on the first pass), or load the demo athlete to look around.'),
      html`<div class="today-actions"><button class="btn" type="button" data-act="demo">${t('Load demo athlete')}</button>
        <a class="btn btn-ghost" href="#/sync">${t('Set up sync')}</a></div>`)}
    ${startList(now)}`;
  const s = D.summary(state, now);
  const c = _ctx = { now, today: dayKey(now), acts, s, digest: s ? F.weekDigest(acts, now, s.threshold_hr, F.thresholds(acts)[1]) : null,
    events: E.cachedEvents(state, D, rev) };
  const layout = layoutOf(), hidden = new Set(layout.hidden || []);
  const byId = new Map(PANELS.map(p => [p.id, p]));
  const order = arrange(PANELS.map(p => p.id), layout);
  const head = pageHead(t('Today'), t.n('{n} activity · last import {when}', '{n} activities · last import {when}', acts.length, { when: ago(lastImport()) }),
    html`<button class="btn btn-ghost" type="button" data-act="layout">${_edit ? t('Done') : t('Edit layout')}</button>`);
  if (_edit) {
    return html`${head}<section class="panel layout-edit">
      <div class="panel-head"><p class="eyebrow">${t('Layout')}</p><p class="panel-note">${t('Synced to your other devices')}</p></div>
      <ol class="layout-list">${order.map((id, i) => {
        const p = byId.get(id), off = hidden.has(id), empty = !off && !renderPanel(p, c).trim(), name = t(p.title);
        return html`<li class="${off ? 'off' : ''}" data-id="${id}"><span class="layout-name">${name}</span>
          <span class="dim">${off ? t('hidden') : empty ? t('nothing to show right now') : ''}</span>
          <span class="layout-btns">
            <button class="btn btn-quiet" type="button" data-move="-1" ${i === 0 ? raw('disabled') : ''} aria-label="${t('Move {name} up', { name })}">↑</button>
            <button class="btn btn-quiet" type="button" data-move="1" ${i === order.length - 1 ? raw('disabled') : ''} aria-label="${t('Move {name} down', { name })}">↓</button>
            <button class="btn btn-quiet" type="button" data-toggle aria-pressed="${String(!off)}">${off ? t('Show') : t('Hide')}</button></span></li>`;
      })}</ol>
      <p style="margin-top:12px"><button class="btn btn-quiet" type="button" data-act="layout-reset">${t('Back to the default layout')}</button></p>
    </section>`;
  }
  return html`${head}${order.filter(id => !hidden.has(id)).map(id => {
    const body = renderPanel(byId.get(id), c);
    return body.trim() ? html`<div class="dash" data-panel="${id}">${raw(body)}</div>` : '';
  })}`;
}

// Report finished runs to the maker's app portal (same-origin localStorage, this
// browser only). Each activity counts once ever -- the ids already reported are
// remembered -- and the demo athlete is excluded, because a synthetic athlete's
// runs are not yours.
function reportToPortal() {
  // House standard 25: one row per finished session in the hub's ledger, deduplicated by id.
  if (!globalThis.appFont || !appFont.logSession) return;
  try {
    // Sessions the older hand-written log already counted (it kept no ids): never count them twice.
    const before = new Set(JSON.parse(localStorage.getItem('run315-portal-seen') || '[]'));
    for (const a of D.activities(state).slice(0, 15)) {
      if (before.has(a.id) || String(a.garmin_id || '').startsWith('demo-') || a.source === 'gymtracker') continue;
      appFont.logSession({ kind: /ride|cycl|bik/i.test(a.type || '') ? 'ride' : 'cardio', minutes: (a.moving_s || a.elapsed_s || 0) / 60,
        id: a.id, at: +a.start + (a.elapsed_s || a.moving_s || 0) * 1000 });
    }
  } catch (e) { /* storage blocked - the ledger is a nicety */ }
}

export function mount(el) {
  const redraw = () => { el.innerHTML = String(render()); mount(el); };
  const lay = el.querySelector('[data-act="layout"]');
  if (lay) lay.onclick = () => { _edit = !_edit; redraw(); };
  if (_edit) { wireLayout(el, redraw); return; }
  for (const p of PANELS) {
    const box = p.mount && el.querySelector(`[data-panel="${p.id}"]`);
    if (box) { try { p.mount(box, _ctx); } catch (e) { console.warn('panel mount ' + p.id, e); } }
  }
  wireRaceForms(el, redraw);
  reportToPortal();
  const demo = el.querySelector('[data-act="demo"]');
  if (demo) demo.onclick = async () => {
    demo.disabled = true;
    try { const { loadDemo } = await import('./sync.js'); const r = await loadDemo(); toast(t('Demo athlete loaded: {n} activities', { n: r.activities })); }
    catch (e) { toast('⚠ ' + (e.message || e)); console.error(e); }
    redraw();
  };
  const rev = el.querySelector('[data-act="review"]');
  if (rev) rev.onclick = async () => {
    if (!ai.apiKey()) {
      // No key: the coach channel writes the review on its next pass.
      if ((state.local.cowork || {}).enabled) cowork.exportNow(false).catch(() => {});
      toast(t('Queued for the cowork coach channel: the review lands here when the agent replies.'));
      return;
    }
    rev.disabled = true; rev.textContent = t('Writing…');
    try {
      const markdown = await ai.coachReview();
      const id = 'r' + Date.now();
      put(state, 'reviews', id, { id, created_at: new Date().toISOString(), markdown, source: 'api' });
      save('edit');
      toast(t('New review ready.'));
    } catch (e) { toast(t('The AI review failed: {error}', { error: e.message || e })); console.error(e); }
    redraw();
  };
}

function wireLayout(el, redraw) {
  const ids = PANELS.map(p => p.id);
  el.querySelectorAll('.layout-list li').forEach(li => {
    const id = li.dataset.id;
    li.querySelectorAll('[data-move]').forEach(bt => { bt.onclick = () => {
      const l = layoutOf(), order = arrange(ids, l), i = order.indexOf(id), j = i + Number(bt.dataset.move);
      if (i < 0 || j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      saveLayout({ order, hidden: l.hidden || [] });
      redraw();
      const again = el.querySelector(`.layout-list li[data-id="${id}"] [data-move="${bt.dataset.move}"]`);
      if (again && !again.disabled) again.focus();
    }; });
    const tg = li.querySelector('[data-toggle]');
    if (tg) tg.onclick = () => {
      const l = layoutOf(), hidden = new Set(l.hidden || []);
      if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
      saveLayout({ order: arrange(ids, l), hidden: [...hidden] });
      redraw();
    };
  });
  const rs = el.querySelector('[data-act="layout-reset"]');
  if (rs) rs.onclick = () => { saveLayout({ order: [], hidden: [] }); toast(t('Back to the default layout.')); redraw(); };
}
