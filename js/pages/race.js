// One race: the projection and the goal, race-day form, the course and a gradient-aware
// pace plan, the training block (and whether it is being run), fuelling, and once it
// is over the result and a kilometre-by-kilometre postmortem. app.py's race_detail and
// the course / result / ran handlers live here.
import { responsePanel } from './response.js';
import { dprimePanel } from '../physio.js';
import { state, save } from '../store.js';
import { put, remove } from '../merge.js';
import * as D from '../derive.js';
import * as F from '../lib/fitness.js';
import * as RC from '../lib/racecraft.js';
import * as PL from '../lib/plan.js';
import * as AD from '../lib/adherence.js';
import * as FU from '../lib/fuelling.js';
import { pyRound } from '../lib/py.js';
import { dayKey, addDays, addDayKey, daysBetween } from '../lib/dt.js';
import { fetchStream } from '../drive.js';
import { cachedForecast, forecastFor, shouldFetch, defaultLocation } from '../forecast.js';
import { penalty } from '../lib/weather.js';
import { html, raw, esc, pageHead, emptyState, fmtTime, fmtPace, signed, toast, useCss, day, t } from '../ui.js';
import { fmt } from '../i18n.js';
import { LANES, parseGoal } from './races.js';

export const title = p => state.races[p && p.id]?.name || 'Race';

const CSS = `
.race-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
.race-headline { flex-wrap: wrap; }
`;

const plus = (v, d = 0) => (v >= 0 ? '+' : '') + v.toFixed(d);
const plusInt = v => { const n = Math.round(v); return (n >= 0 ? '+' : '') + n; };
const cap = s => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
const minus = v => (v > 0 ? '+' : '−');
// A start hour in the reader's clock (14:00, or 2 PM).
const hourLabel = h => (fmt() ? fmt().time(new Date(2026, 0, 1, h)) : String(h).padStart(2, '0') + ':00');
// A translated sentence with one link in it: the link goes in after the sentence is escaped.
const withLink = (sentence, params, linkHtml) => raw(esc(t(sentence, { ...params, link: '\u0001' })).replace('\u0001', linkHtml));
// The phase key is data; the page shows it through t():
// i18n-keys: Base | Build | Peak | Taper
// The forecast's location source is data too:
// i18n-keys: home | most-run tile | latest activity

// ---------- the course ----------
// Points out of a GPX file -> [[lat, lon, ele_or_null], ...]. A track or a route,
// whichever the organiser published. Regex rather than DOMParser, so it runs anywhere.
export function parseGpx(text) {
  text = String(text || '');
  if (!/<gpx[\s>]/i.test(text)) throw new Error(t('That file is not valid GPX.'));
  const out = [], re = /<(?:[\w-]+:)?(trkpt|rtept)\b([^>]*?)(\/>|>([\s\S]*?)<\/(?:[\w-]+:)?\1\s*>)/g;
  let m;
  while ((m = re.exec(text))) {
    const lat = parseFloat((/\blat\s*=\s*["']([^"']*)["']/.exec(m[2]) || [])[1]);
    const lon = parseFloat((/\blon\s*=\s*["']([^"']*)["']/.exec(m[2]) || [])[1]);
    if (isNaN(lat) || isNaN(lon)) continue;
    const e = m[4] ? /<(?:[\w-]+:)?ele\s*>([^<]*)</.exec(m[4]) : null;
    const ele = e ? parseFloat(e[1].trim()) : NaN;
    out.push([lat, lon, isNaN(ele) ? null : ele]);
  }
  if (out.length < 2) throw new Error(t('No track points found in that GPX.'));
  return out;
}

// save_course: the course and its headline numbers, on the race record. -> stats
export function saveCourse(race, points, source) {
  const stats = RC.courseStats(points);
  if (!stats) throw new Error(t('That course has too few usable points.'));
  // ponytail: thinned to ~2000 points. Plenty for gradients at 1 km grain, and
  // it keeps a marathon GPX from becoming a megabyte of JSON per race.
  const step = Math.max(Math.floor(points.length / 2000), 1), thinned = [];
  for (let i = 0; i < points.length; i += step) {
    const p = points[i];
    thinned.push([pyRound(p[0], 6), pyRound(p[1], 6), p.length > 2 && p[2] != null ? pyRound(p[2], 1) : null]);
  }
  put(state, 'races', race.id, { ...race, course: { source, points: thinned, length_m: stats.length_m,
    climb_m: stats.climb_m, drop_m: stats.drop_m, added_at: new Date().toISOString() } });
  save('edit');
  return stats;
}

// A run's track as course points: the stream (with elevation) if this device can get
// it, else the thinned track the analysis kept (flat, then).
async function trackOf(id) {
  const rec = await fetchStream(id).catch(() => null);
  const pts = D.samplesOf(rec).filter(s => s[3] != null && s[4] != null).map(s => [s[3], s[4], s[5] ?? null]);
  if (pts.length >= 2) return pts;
  const thin = (await D.getDetail(id))?.points;
  if (thin && thin.length >= 2) return thin.map(([la, lo]) => [la, lo, null]);
  throw new Error(t('That activity has no GPS track stored yet.'));
}

// SVG polygon points for a course profile, rebuilt from per-segment climb and drop.
function elevationProfile(stats, width = 680, height = 110) {
  const segs = (stats && stats.segments) || [];
  if (!segs.length || !stats.has_elevation) return '';
  let ele = 0;
  const marks = [[0, 0]];
  for (const s of segs) { ele += s.climb_m - s.drop_m; marks.push([s.to_m, ele]); }
  const lo = Math.min(...marks.map(m => m[1])), hi = Math.max(...marks.map(m => m[1]));
  const span = Math.max(hi - lo, 1), total = marks[marks.length - 1][0] || 1;
  return marks.map(([d, e]) => (d / total * width).toFixed(1) + ',' + (height - (e - lo) / span * (height - 12) - 6).toFixed(1)).join(' ');
}

// The race's garmin_id may be an activity key ('g123') or a bare Garmin id ('123').
const resolve = gid => (!gid ? null : state.activities[gid] ? gid : state.activities['g' + gid] ? 'g' + gid : null);

// match_race_to_activity: the run that was probably this race -- same day, within 15%
// of the distance, or it was a different run that day.
function matchRun(race) {
  let best = null;
  for (const a of D.runs(state)) {
    if (dayKey(a.start) !== race.date || !a.distance_m) continue;
    if (!best || Math.abs(a.distance_m - race.distance_m) < Math.abs(best.distance_m - race.distance_m)) best = a;
  }
  if (!best || Math.abs(best.distance_m - race.distance_m) / race.distance_m > 0.15) return null;
  return best.id;
}

// Everything race_detail worked out, minus the stream-reading postmortem.
function model(race, now) {
  const today = dayKey(now), s = D.summary(state, now);
  const projection = D.projection(state, race, now);
  const cal = D.calibration(state, now);
  const form = s ? F.projectForm(s.daily, today, race.date) : null;
  const splits = projection ? F.splitTargets(race.distance_m, projection.seconds) : [];
  const goalSplits = race.goal_s ? F.splitTargets(race.distance_m, race.goal_s) : [];

  // --- the course, if one has been attached ---
  const course = race.course && race.course.points ? race.course : null;
  let courseStats = null, plan = null, hard = null, mismatch = null;
  const target = race.goal_s || (projection ? projection.seconds : null);
  if (course) {
    courseStats = RC.courseStats(course.points);
    if (courseStats && race.distance_m) {
      // A GPX for the wrong event would silently spread the goal time over
      // the wrong distance, so say so rather than quietly pacing a fiction.
      const off = (courseStats.length_m - race.distance_m) / race.distance_m;
      if (Math.abs(off) > 0.05) mismatch = off;
    }
    if (courseStats && target) { plan = RC.pacePlan(courseStats.segments, target); hard = RC.hardSections(courseStats.segments); }
  }

  // A plan only makes sense for a race still ahead, and only off a real base.
  let trainingPlan = null, planStats = null, planNotes = [], planReview = null;
  const weeksOut = Math.floor(daysBetween(today, race.date) / 7);
  if (s && weeksOut >= 2) {
    // Running volume only. summary.weekly counts every cardio activity, and
    // building a running plan off a total that includes bike rides asks for
    // twice the mileage the athlete has ever run.
    const since = addDays(now, -42), runs = D.runs(state);
    const currentWeekM = runs.filter(a => a.start >= since).reduce((t, a) => t + (a.distance_m || 0), 0) / 6;
    if (currentWeekM > 5000) {
      trainingPlan = PL.build(currentWeekM, race.distance_m, Math.min(weeksOut, 24), s.paces);
      planStats = PL.summarise(trainingPlan, race.distance_m);
      planNotes = PL.sanity(trainingPlan, currentWeekM);
      // Did the athlete actually do the plan? A plan nobody checks is a horoscope.
      if (trainingPlan.length)
        planReview = AD.review(trainingPlan, runs, dayKey(addDays(now, -7 * trainingPlan.length)), today);
    }
  }

  // Inside a week the forecast reaches race day, so the goal pace can be read in the
  // conditions it will actually be run in.
  const wx = raceWeather(race, today, target);

  // Fuelling hangs off the projected finish time; the fluid and sodium ranges also take
  // the race-morning temperature once the forecast has it (temperate default before).
  const fuel = projection && projection.seconds ? FU.plan(projection.seconds, wx && wx.morningTemp != null ? wx.morningTemp : null) : null;

  // Runs around race day: the candidates for "this was the race".
  const pastRuns = race.date <= today ? D.runs(state)
    .filter(a => { const d = dayKey(a.start); return d >= addDayKey(race.date, -1) && d <= addDayKey(race.date, 1); }).slice(0, 12) : [];
  return { today, s, projection, cal, form, splits, goalSplits, course, courseStats, plan, hard, mismatch,
    trainingPlan, planStats, planNotes, planReview, fuel, pastRuns, wx };
}

// ---------- race-day weather ----------
export const FORECAST_DAYS_OUT = 7;
let _wxError = null;
export const RACE_HOURS = [6, 14];   // start times worth showing: nobody's start time is stored, so the morning
// Where the race is: the course start if one is attached, else the athlete's usual
// start point. -> {lat, lon, source} | null
export function raceLocation(race, st) {
  const p = race.course && race.course.points && race.course.points[0];
  if (p && isFinite(p[0]) && isFinite(p[1])) return { lat: p[0], lon: p[1], source: 'course start' };
  return defaultLocation(st);
}
// Race-day hours with what each start time would cost the target pace. Pure apart from the
// sync forecast cache. -> null (race not this week) | {loc, rows: [...] | null, morningTemp}
export function raceWeather(race, today, targetS, st = state) {
  const days = daysBetween(today, race.date);
  if (days < 0 || days > FORECAST_DAYS_OUT) return null;
  const loc = raceLocation(race, st);
  if (!loc) return { loc: null, rows: null, morningTemp: null, days };
  const f = cachedForecast(loc.lat, loc.lon);
  if (!f) return { loc, rows: null, morningTemp: null, days };
  const goalPace = targetS && race.distance_m ? targetS / (race.distance_m / 1000) : null;
  const rows = f.hours.filter(r => r.day === race.date && r.hour >= RACE_HOURS[0] && r.hour <= RACE_HOURS[1]).map(r => {
    const p = penalty(r.temp, r.rh, r.dew);
    return { ...r, penalty: p, pace: goalPace ? goalPace * (1 + p) : null, finish: targetS ? targetS * (1 + p) : null };
  });
  const morning = rows.filter(r => r.hour >= 7 && r.hour <= 11).map(r => r.temp).sort((a, b) => a - b);
  return { loc, rows: rows.length ? rows : null, fetchedAt: f.fetchedAt, goalPace, targetS, days,
    morningTemp: morning.length ? morning[Math.floor(morning.length / 2)] : null };
}

// ---------- sections ----------
function headline(race, m) {
  const p = m.projection, past = race.date < m.today;
  const diff = p && race.goal_s ? p.seconds - race.goal_s : null;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${day(race.date, true)} · ${(race.distance_m / 1000).toFixed(2)} km</p>
      <p class="panel-note"><a class="quiet-link" href="#/races">${t('All races')}</a></p></div>
    <h2 class="race-title">${race.name}</h2>
    ${past ? html`<p class="stat-hint">${t.n('Run {n} day ago.', 'Run {n} days ago.', daysBetween(race.date, m.today))}</p>`
    : p ? html`<div class="race-headline">
        <div><div class="projected">${fmtTime(p.seconds)}<small>${fmtPace(p.seconds, race.distance_m)}</small></div>
          <div class="stat-label" style="margin-top:8px">${t('Projected finish')}</div>
          <div class="lanes" title="${t('Confidence: {level}', { level: t(p.confidence) })}">${[0, 1, 2].map(i => html`<span class="lane ${i < LANES[p.confidence] ? 'on' : ''}"></span>`)}</div></div>
        ${diff != null ? html`<div><div class="projected ${diff > 0 ? 'behind' : 'ahead'}">${minus(diff)}${fmtTime(Math.abs(diff))}
            <small>${t('goal {time}', { time: fmtTime(race.goal_s) })}</small></div>
          <div class="stat-label" style="margin-top:8px">${diff > 0 ? t('Short of your goal') : t('Ahead of your goal')}</div></div>` : ''}
        <div><div class="projected measured">${p.days_to_race}<small>${t('days to go')}</small></div>
          <div class="stat-label" style="margin-top:8px">${t('Trend {pct}%', { pct: plus((p.trend_factor - 1) * 100, 1) })}${m.cal ? ' · ' + t('your bias {pct}%', { pct: plus((m.cal.factor - 1) * 100, 1) }) : ''}</div></div>
      </div>`
    : html`<div class="empty"><p>${t('Not enough running data to project this one yet. Bring in your history, then run something hard.')}</p></div>`}
  </section>`;
}

function resultPanel(race) {
  const gap = race.actual_s && race.predicted_s ? race.actual_s - race.predicted_s : null;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('Result')}</p></div>
    ${race.actual_s ? html`<div class="race-headline">
        <div><div class="projected measured">${fmtTime(race.actual_s)}<small>${fmtPace(race.actual_s, race.distance_m)}</small></div>
          <div class="stat-label" style="margin-top:8px">${t('Finish time')}</div></div>
        ${gap != null ? html`<div><div class="projected ${gap > 0 ? 'behind' : 'ahead'}">${minus(gap)}${fmtTime(Math.abs(gap))}
            <small>${t('projected {time}', { time: fmtTime(race.predicted_s) })}</small></div>
          <div class="stat-label" style="margin-top:8px">${gap > 0 ? t('Slower than projected') : t('Faster than projected')}</div></div>` : ''}
      </div>`
    : html`<div class="empty"><p>${t('This race is in the past. Enter your finish time and every future projection learns from how this one went.')}</p></div>`}
    <form class="form-row" data-form="result" style="margin-top:14px">
      <div class="field"><label for="actual">${race.actual_s ? t('Correct the finish time') : t('Finish time')}</label>
        <input type="text" id="actual" name="actual" placeholder="1:29:30" pattern="[0-9:.]*" required></div>
      <button class="btn" type="submit">${t('Save result')}</button>
    </form>
  </section>`;
}

function formPanel(f) {
  if (!f) return '';
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('Race-day readiness')}</p>
      <p class="panel-note">${t('If you hold your current {n} load per day', { n: f.avg_daily_load.toFixed(0) })}</p></div>
    <div class="grid-half">
      <div>
        <div class="stat"><div class="stat-value">${signed(f.tsb_no_taper)}</div><div class="stat-label">${t('Form on race day · no taper')}</div></div>
        <div class="stat"><div class="stat-value">${signed(f.tsb_with_taper)}</div><div class="stat-label">${t('Form with a {n}-day taper', { n: f.taper_days })}</div>
          <div class="stat-hint">${t('Fitness would still be {n}.', { n: f.ctl_race_day.toFixed(0) })}</div></div>
      </div>
      <div class="empty">
        <p>${t('Form above about +10 on the day is where most people race well. Cutting volume to roughly 55% for the last {n} days moves you from {from} to {to} without losing meaningful fitness.', { n: f.taper_days, from: signed(f.tsb_no_taper), to: signed(f.tsb_with_taper) })}</p>
        ${f.tsb_with_taper < 5 ? html`<p>${t('You are carrying a lot of fatigue for a race this close. Either back off harder than the standard taper, or treat this one as a training day.')}</p>` : ''}
      </div>
    </div></section>`;
}

function coursePanel(race, m) {
  const cs = m.courseStats, prof = cs ? elevationProfile(cs) : '';
  // Candidate tracks: the runs around race day, else recent runs with a GPS line.
  const picks = m.pastRuns.length ? m.pastRuns : D.runs(state).filter(a => state.derived[a.id]?.p0 || state.derived[a.id]?.points).slice(0, 20);
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('The course')}</p>
      ${cs ? html`<p class="panel-note">${t('{km} km · {up} m up · {down} m down', { km: (cs.length_m / 1000).toFixed(2), up: Math.round(cs.climb_m), down: Math.round(cs.drop_m) })}</p>` : ''}</div>
    ${cs ? html`
      ${m.mismatch != null ? html`<div class="flash flash-error" style="margin-bottom:14px">
        ${t(m.mismatch > 0
    ? 'This course is {pct}% longer than the race distance ({course} km against {race} km). The plan below spreads your target over the course as attached, so check you uploaded the right one.'
    : 'This course is {pct}% shorter than the race distance ({course} km against {race} km). The plan below spreads your target over the course as attached, so check you uploaded the right one.',
  { pct: (Math.abs(m.mismatch) * 100).toFixed(0), course: (cs.length_m / 1000).toFixed(2), race: (race.distance_m / 1000).toFixed(2) })}</div>` : ''}
      ${prof ? html`<svg class="chart profile" viewBox="0 0 680 110" preserveAspectRatio="none" role="img" aria-label="${t('Course elevation profile')}">
          <polygon points="0,110 ${prof} 680,110" style="fill:var(--measured)" fill-opacity="0.12"/>
          <polyline points="${prof}" fill="none" style="stroke:var(--measured)" stroke-width="2" vector-effect="non-scaling-stroke"/>
        </svg>
        <div class="chart-legend"><span>${t('Start')}</span>
          <span style="margin:0 auto">${t('{pct}% harder than flat', { pct: ((cs.difficulty - 1) * 100).toFixed(0) })}</span><span>${t('Finish')}</span></div>`
      : html`<div class="empty"><p>${t('This course has no elevation data, so the pacing below is even rather than gradient-aware.')}</p></div>`}
      ${m.hard && m.hard.length ? html`<p class="stat-hint" style="margin-top:14px"><b>${t('Where it bites:')}</b></p>
        <ul class="climb-list">${m.hard.slice(0, 4).map(h => html`<li><b>${(h.from_m / 1000).toFixed(1)}–${(h.to_m / 1000).toFixed(1)} km</b>
          · ${t('{m} m at {pct}%', { m: Math.round(h.climb_m), pct: (h.grade * 100).toFixed(1) })}</li>`)}</ul>` : ''}
      <div style="margin-top:12px"><button class="btn-quiet" type="button" data-act="course-delete">${t('Remove this course')}</button></div>`
    : html`
      <div class="empty"><p>${t('Attach the course and the pacing below stops being a guess about a flat road. Upload the organiser GPX, or point at a run where you covered the same ground.')}</p></div>
      <form class="form-row" data-form="gpx">
        <div class="field field-grow"><label for="gpx">${t('Course GPX')}</label>
          <input type="file" id="gpx" name="gpx" accept=".gpx,application/gpx+xml" required></div>
        <button class="btn" type="submit">${t('Attach course')}</button>
      </form>
      ${picks.length ? html`<form class="form-row" data-form="course-run" style="margin-top:10px">
        <div class="field field-grow"><label for="fromact">${t('Or use a run')}</label>
          <select id="fromact" name="id">${picks.map(a => html`<option value="${a.id}">${day(dayKey(a.start), true)} · ${((a.distance_m || 0) / 1000).toFixed(2)} km · ${a.name}</option>`)}</select></div>
        <button class="btn btn-ghost" type="submit">${t('Use that track')}</button>
      </form>` : ''}`}
  </section>`;
}

function planPanel(race, m) {
  if (!m.plan || !m.plan.length || race.date < m.today) return '';
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('Race plan')}</p>
      <p class="panel-note">${t('Even effort, not even pace · for {target}', { target: race.goal_s ? fmtTime(race.goal_s) : t('the projection') })}</p></div>
    <div class="empty"><p>${t('Each kilometre is scaled by what its gradient actually costs, then the whole plan is normalised to land on the target. Running the hills at your flat pace is how a race gets away from you.')}</p></div>
    <div class="table-scroll"><table>
      <thead><tr><th>${t('Km')}</th><th class="num">${t('Grade')}</th><th class="num">${t('Target')}</th><th class="num">${t('Split')}</th><th class="num">${t('Elapsed')}</th></tr></thead>
      <tbody>${m.plan.map(p => html`<tr>
        <td>${p.n}${p.distance_m < 900 ? html`<span class="dim"> (${Math.round(p.distance_m)} m)</span>` : ''}</td>
        <td class="num ${p.grade != null && p.grade > 0.02 ? 'behind' : p.grade != null && p.grade < -0.02 ? 'ahead' : 'dim'}">${p.grade != null ? plus(p.grade * 100, 1) + '%' : '—'}</td>
        <td class="num time">${fmtPace(p.target_pace, 1000)}</td>
        <td class="num dim">${fmtTime(p.target_s)}</td>
        <td class="num actual">${fmtTime(p.cumulative_s)}</td>
      </tr>`)}</tbody></table></div>
  </section>`;
}

function blockPanel(m) {
  const tp = m.trainingPlan, st = m.planStats, rv = m.planReview;
  if (!tp || !tp.length || !st) return '';
  const top = st.peak_week_m || 1;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('Training block')}</p>
      <p class="panel-note">${t.n('{n} week · peaks at {km} km in week {week}', '{n} weeks · peaks at {km} km in week {week}', st.weeks, { km: (st.peak_week_m / 1000).toFixed(0), week: st.peak_week_n })}</p></div>
    <div class="empty"><p>${t('Built from what you are running now, not from a template. Volume rises across the block, backs off every fourth week, and the heaviest week lands just before the taper. Every session is a band off your own curve, so it stays right as you get fitter.')}</p></div>
    ${m.planNotes.map(n => html`<div class="flash flash-error" style="margin-bottom:10px">${n}</div>`)}
    ${rv ? html`<div class="grid-2" style="margin:14px 0 4px">
      <div><div class="stat">
        <div class="stat-value ${rv.drift === 'under' ? 'behind' : rv.on_target >= rv.weeks * 0.6 ? 'ahead' : ''}">${rv.share != null ? (rv.share * 100).toFixed(0) : '--'}<small class="unit">%</small></div>
        <div class="stat-label">${t('Of the plan, actually run')}</div>
        <div class="stat-hint">${t('{on} of {weeks} finished weeks on target · {done}/{planned} long runs done.', { on: rv.on_target, weeks: rv.weeks, done: rv.long_runs_done, planned: rv.long_runs_planned })}</div></div></div>
      <div><p class="stat-hint">${AD.noteText(rv)}</p></div></div>` : ''}
    <div class="plan-strip">${tp.map(w => html`<span class="plan-week ph-${w.phase}" style="height:${(14 + 46 * (w.distance_m / top)).toFixed(0)}px"
      title="${t('Week {week} ({phase}): {km} km, long run {long} km', { week: w.week, phase: t(cap(w.phase)), km: (w.distance_m / 1000).toFixed(0), long: (w.long_run_m / 1000).toFixed(1) })}"></span>`)}</div>
    <div class="polar-key" style="margin-top:8px">
      <span><i class="ph-base"></i>${t('Base')}</span><span><i class="ph-build"></i>${t('Build')}</span>
      <span><i class="ph-peak"></i>${t('Peak')}</span><span><i class="ph-taper"></i>${t('Taper')}</span></div>
    <div class="table-scroll" style="margin-top:16px"><table>
      <thead><tr><th>${t('Week')}</th><th>${t('Phase')}</th><th class="num">${t('Volume')}</th><th class="num">${t('Long run')}</th><th>${t('Key sessions')}</th></tr></thead>
      <tbody>${tp.map(w => html`<tr>
        <td>${w.week}<span class="dim"> · ${t('{n} to go', { n: w.to_go })}</span></td>
        <td><span class="phase-dot ph-${w.phase}"></span>${t(cap(w.phase))}${w.easy_week ? html` <span class="dim">${t('easy')}</span>` : ''}</td>
        <td class="num actual">${(w.distance_m / 1000).toFixed(0)} km</td>
        <td class="num dim">${(w.long_run_m / 1000).toFixed(1)} km</td>
        <td>${(w.sessions || []).map(([name, desc, band]) => html`<div class="session"><b>${PL.sessionName(name)}</b>${band ? html` <span class="time">${fmtTime(band[0])}–${fmtPace(band[1], 1000)}</span>` : ''}
          <br><span class="dim">${PL.sessionText(desc)}</span></div>`)}</td>
      </tr>`)}</tbody></table></div>
    <p class="stat-hint" style="margin-top:10px">${withLink('A schedule, not a prescription. It has no idea whether you slept, and the readiness read on {link} is the thing that should override it.', {}, `<a class="quiet-link" href="#/">${esc(t('Today'))}</a>`)}</p>
  </section>`;
}

function fuelPanel(fuel) {
  if (!fuel || !fuel.carbs || !fuel.carbs.per_hour_high) return '';
  const c = fuel.carbs;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('Fuelling')}</p><p class="panel-note">${t('for {time} of running', { time: fmtTime(fuel.duration_s) })}</p></div>
    <div class="digest">
      <div class="stat"><div class="stat-value">${c.per_hour_low}–${c.per_hour_high}<small class="unit">g/h</small></div>
        <div class="stat-label">${t('Carbohydrate')}</div><div class="stat-hint">${t('{low}–{high} g over the race.', { low: Math.round(c.total_low), high: Math.round(c.total_high) })}</div></div>
      ${fuel.fluid ? html`<div class="stat"><div class="stat-value">${fuel.fluid.per_hour_low}–${fuel.fluid.per_hour_high}<small class="unit">ml/h</small></div>
        <div class="stat-label">${t('Fluid')}</div><div class="stat-hint">${t('To thirst, inside that range.')}</div></div>` : ''}
      ${fuel.sodium ? html`<div class="stat"><div class="stat-value">${fuel.sodium.per_litre_low}–${fuel.sodium.per_litre_high}<small class="unit">mg/l</small></div>
        <div class="stat-label">${t('Sodium')}</div></div>` : ''}
    </div>
    <p class="stat-hint" style="margin-top:12px">${c.note}</p>
    ${fuel.fluid ? html`<p class="stat-hint">${fuel.fluid.note}</p>` : ''}
    ${fuel.schedule && fuel.schedule.length ? html`<p class="eyebrow" style="margin-top:16px">${t('Roughly when')}</p>
      <div class="table-scroll"><table><thead><tr><th>${t('At')}</th><th class="num">${t('Take')}</th><th class="num">${t('Running total')}</th></tr></thead>
        <tbody>${fuel.schedule.map(it => html`<tr><td>${fmtTime(it.at_s)}</td><td class="num dim">${it.grams} g</td><td class="num actual">${it.cumulative_g} g</td></tr>`)}</tbody></table></div>
      <p class="stat-hint" style="margin-top:10px">${t('Spaced evenly rather than crammed late: the gut empties at a rate, and a backlog does not clear once you are working hard. Nothing in the last ten minutes, because it would not be absorbed in time to matter.')}</p>` : ''}
    ${fuel.loading ? html`<p class="stat-hint" style="margin-top:14px">${fuel.loading.note}
      ${fuel.loading.g_per_kg_low ? ' ' + t('Aim for {low}–{high} g of carbohydrate per kilo of body weight per day, for the two days before.', { low: fuel.loading.g_per_kg_low, high: fuel.loading.g_per_kg_high }) : ''}</p>` : ''}
    <p class="stat-hint" style="margin-top:12px">${t('These are the published consensus ranges (Jeukendrup 2014; the joint position stand of the Academy of Nutrition and Dietetics, Dietitians of Canada and the ACSM, 2016), not personal advice. Gut tolerance is individual and 90 g/h is a trained capacity rather than a starting point — practise it in training, never first on race day.')}</p>
  </section>`;
}

function postmortemPanel(race, m, review, ranId, missing) {
  if (race.date > m.today) return '';
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('Postmortem')}</p>
      ${review ? html`<p class="panel-note"><a class="quiet-link" href="#/activity/${review.id}">${t('the run')}</a>${review.auto ? ' · ' + t('matched automatically') : ''}</p>` : ''}</div>
    ${review ? html`<p class="verdict">${review.verdict}</p>
      <div class="digest">
        <div class="stat"><div class="stat-value">${fmtTime(review.total_s)}</div><div class="stat-label">${t('Ran')}</div>
          ${review.vs_target_s != null ? html`<div class="stat-hint"><span class="${review.vs_target_s > 0 ? 'behind' : 'ahead'}">${t('{s}s vs goal', { s: plusInt(review.vs_target_s) })}</span></div>` : ''}</div>
        ${review.fade != null ? html`<div class="stat"><div class="stat-value ${review.fade > 0.04 ? 'risk' : ''}">${plus(review.fade * 100, 1)}<small class="unit">%</small></div>
          <div class="stat-label">${t('Second half vs first')}</div>
          ${review.gap_fade != null ? html`<div class="stat-hint">${t('{pct}% on effort', { pct: plus(review.gap_fade * 100, 1) })}</div>` : ''}</div>` : ''}
        ${review.lost_s ? html`<div class="stat"><div class="stat-value">${Math.round(review.lost_s)}<small class="unit">s</small></div>
          <div class="stat-label">${t('Lost against plan')}</div>
          ${review.uphill_loss_s ? html`<div class="stat-hint">${t('{s}s of it on climbs', { s: Math.round(review.uphill_loss_s) })}</div>` : ''}</div>` : ''}
        ${review.hr_drift != null ? html`<div class="stat"><div class="stat-value">${plus(review.hr_drift, 0)}</div><div class="stat-label">${t('HR drift, bpm')}</div></div>` : ''}
      </div>
      <div class="table-scroll" style="margin-top:18px"><table>
        <thead><tr><th>${t('Km')}</th><th class="num">${t('Plan')}</th><th class="num">${t('Ran')}</th><th class="num">${t('Delta')}</th><th class="num">${t('Grade')}</th><th class="num">${t('Effort')}</th><th class="num">${t('HR')}</th></tr></thead>
        <tbody>${review.rows.map(r => html`<tr>
          <td>${r.n}</td>
          <td class="num dim">${r.target_pace ? fmtPace(r.target_pace, 1000) : '—'}</td>
          <td class="num actual">${fmtPace(r.pace, 1000)}</td>
          <td class="num">${r.delta_s != null ? html`<span class="${r.delta_s > 1 ? 'behind' : r.delta_s < -1 ? 'ahead' : 'dim'}">${plusInt(r.delta_s)}s</span>` : html`<span class="dim">—</span>`}</td>
          <td class="num dim">${r.grade != null ? plus(r.grade * 100, 1) + '%' : '—'}</td>
          <td class="num dim">${r.gap ? fmtPace(r.gap, 1000) : '—'}</td>
          <td class="num dim">${r.avg_hr ? Math.round(r.avg_hr) : '—'}</td>
        </tr>`)}</tbody></table></div>
      <p class="stat-hint" style="margin-top:10px">${t('“Effort” is the pace adjusted for gradient, so a slow kilometre uphill can be a better effort than a quick one on the flat.')}</p>`
    : ranId && missing ? html`<div class="empty"><p>${withLink('The run linked to this race has no per-second stream on this device, so its splits cannot be read. Open it on the desktop that imported it, or connect Drive on {link}.', {}, `<a class="quiet-link" href="#/sync">${esc(t('Sync & cowork'))}</a>`)}</p></div>`
    : html`<div class="empty"><p>${t('No run linked to this race yet. Pick the one you ran and the splits get compared against the plan, kilometre by kilometre.')}</p></div>`}
    ${m.pastRuns.length ? html`<form class="form-row" data-form="ran" style="margin-top:14px">
      <div class="field field-grow"><label for="ranact">${t('The run that was this race')}</label>
        <select id="ranact" name="id"><option value="">${t('— none —')}</option>
          ${m.pastRuns.map(a => html`<option value="${a.id}" ${ranId === a.id ? 'selected' : ''}>${day(dayKey(a.start), true)} · ${((a.distance_m || 0) / 1000).toFixed(2)} km · ${a.name}</option>`)}
        </select></div>
      <button class="btn btn-ghost" type="submit">${t('Link')}</button>
    </form>` : ''}
  </section>`;
}

function weatherPanel(race, m) {
  const w = m.wx;
  if (!w) return '';
  const head = html`<div class="panel-head"><p class="eyebrow">${t('Race-day forecast')}</p>
    <p class="panel-note">${w.loc ? (w.loc.source === 'course start' ? t('at the course start') : t('near your {place}', { place: t(w.loc.source) })) : ''}${w.rows ? ' · Open-Meteo' : ''}</p></div>`;
  if (!w.loc) return html`<section class="panel">${head}<div class="empty"><p>${withLink('No location to forecast: attach the course, or set where you run from on {link}.', {}, `<a class="quiet-link" href="#/pod">${esc(t('Plan of the day'))}</a>`)}</p></div></section>`;
  if (!w.rows) return html`<section class="panel">${head}<div class="empty"><p>${_wxError ? t('Forecast unavailable: {error}', { error: _wxError }) : t('Fetching the forecast for {day}…', { day: day(race.date) })}</p></div></section>`;
  const worst = Math.max(...w.rows.map(r => r.penalty));
  const heat = D.heatState(state);
  return html`<section class="panel">${head}
    <div class="table-scroll"><table>
      <thead><tr><th>${t('Start')}</th><th class="num">${t('Temp')}</th><th class="num">${t('Dew pt')}</th><th class="num">${t('Rain')}</th><th class="num">${t('Wind')}</th>
        <th class="num">${t('Heat cost')}</th>${w.goalPace ? html`<th class="num">${t('Pace')}</th><th class="num">${t('Finish')}</th>` : ''}</tr></thead>
      <tbody>${w.rows.map(r => html`<tr>
        <td>${hourLabel(r.hour)}${race.start_time && +race.start_time.slice(0, 2) === r.hour ? html` <b>${t('your start')}</b>` : ''}</td>
        <td class="num">${Math.round(r.temp)}°</td><td class="num dim">${r.dew != null ? Math.round(r.dew) + '°' : '—'}</td>
        <td class="num dim">${r.rain != null ? r.rain + '%' : '—'}</td><td class="num dim">${r.wind != null ? Math.round(r.wind) : '—'}</td>
        <td class="num ${r.penalty >= 0.02 ? 'behind' : 'dim'}">${r.penalty >= 0.005 ? '+' + (r.penalty * 100).toFixed(1) + '%' : '—'}</td>
        ${w.goalPace ? html`<td class="num time">${fmtPace(r.pace, 1000)}</td><td class="num dim">${fmtTime(r.finish)}</td>` : ''}
      </tr>`)}</tbody></table></div>
    <p class="stat-hint" style="margin-top:10px">${w.goalPace ? t(race.goal_s
      ? "The goal pace of {pace} in neutral conditions, slowed by what each start hour's temperature, humidity and dew point cost."
      : "The projected pace of {pace} in neutral conditions, slowed by what each start hour's temperature, humidity and dew point cost.", { pace: fmtPace(w.goalPace, 1000) }) + ' ' : ''}${worst < 0.005 ? t('Cool all morning: no correction worth making.')
      : t('From a population heat curve, not one fitted to you: run the early kilometres by effort and heart rate, and let the pace come to you.')}
      ${worst >= 0.02 && heat && heat.band === 'none' ? ' ' + t('Nothing hot in your recent training, so expect the heat to cost at least this much.') : ''}
      ${t.n('A forecast {n} day out moves; it is refreshed hourly while this page is open.', 'A forecast {n} days out moves; it is refreshed hourly while this page is open.', w.days)}</p>
  </section>`;
}

function splitsPanel(race, m) {
  if (!m.splits.length || race.date < m.today) return '';
  const g = m.goalSplits;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('Split targets')}</p><p class="panel-note">${t('Slightly negative — 1% steadier out, 1% quicker back')}</p></div>
    <div class="table-scroll"><table>
      <thead><tr><th>${t('Checkpoint')}</th><th class="num">${t('Projected')}</th>${g.length ? html`<th class="num">${t('Goal')}</th>` : ''}</tr></thead>
      <tbody>${m.splits.map(([label, , cum], i) => html`<tr><td>${label}</td><td class="num time">${fmtTime(cum)}</td>
        ${g.length ? html`<td class="num dim">${g[i] ? fmtTime(g[i][2]) : '—'}</td>` : ''}</tr>`)}</tbody>
    </table></div></section>`;
}

export async function render(params = {}) {
  useCss('race', CSS);
  const race = state.races[params.id];
  if (!race) return html`${pageHead(t('Race'))}${emptyState(t('No such race'),
    t('It may have been removed on another device, or the link is out of date.'), html`<a class="btn" href="#/races">${t('All races')}</a>`)}`;
  const now = new Date(), m = model(race, now);

  // --- the postmortem, once the race has been run: needs the run's stream ---
  let review = null, missing = false;
  const linked = resolve(race.garmin_id), ranId = linked || matchRun(race);
  let dp = '';
  if (race.date <= m.today && ranId) {
    const rec = await fetchStream(ranId).catch(() => null);
    dp = await dprimePanel(ranId, rec).catch(() => '');
    const actual = RC.actualSegments(D.samplesOf(rec));
    if (actual.length) {
      review = RC.postmortem(m.plan || [], actual, race.goal_s || null);
      if (review) Object.assign(review, { id: ranId, auto: !linked });
    } else missing = true;
  }

  return html`
    ${pageHead(race.name, t('Race plan'))}
    ${headline(race, m)}
    ${race.date < m.today ? resultPanel(race) : ''}
    ${formPanel(m.form)}
    ${responsePanel(race.id)}
    ${race.date >= m.today ? weatherPanel(race, m) : ''}
    ${coursePanel(race, m)}
    ${planPanel(race, m)}
    ${blockPanel(m)}
    ${fuelPanel(m.fuel)}
    ${postmortemPanel(race, m, review, ranId, missing)}
    ${dp}
    ${splitsPanel(race, m)}
    <div class="race-actions"><button class="btn-quiet" type="button" data-act="race-delete">${t('Remove this race')}</button></div>`;
}

export function mount(el, params = {}) {
  const id = params.id, race = () => state.races[id];
  if (!race()) return;
  const redraw = async () => { el.innerHTML = String(await render(params)); mount(el, params); };
  const edit = (patch, msg) => { put(state, 'races', id, { ...race(), ...patch }); save('edit'); if (msg) toast(msg); return redraw(); };

  // Freeze the projection while the race is still ahead, so a result entered
  // afterwards is scored against what we actually said beforehand.
  const now = new Date(), p = D.projection(state, race(), now);
  if (p && race().date >= dayKey(now) && Math.abs((race().predicted_s || 0) - p.seconds) > 0.5) {
    put(state, 'races', id, { ...race(), predicted_s: p.seconds });
    save('edit');
  }

  // Race-day forecast: fetched when the race is this week and this device has none cached.
  const w = raceWeather(race(), dayKey(now), null);
  if (w && w.loc && !w.rows && shouldFetch(w.loc.lat, w.loc.lon))
    forecastFor(w.loc.lat, w.loc.lon).then(() => { _wxError = null; if (el.isConnected) return redraw(); })
      .catch(e => { _wxError = e.message || String(e); if (el.isConnected) return redraw(); });

  const on = (sel, ev, fn) => { const n = el.querySelector(sel); if (n) n[ev] = fn; };
  on('[data-form="result"]', 'onsubmit', ev => {
    ev.preventDefault();
    const actual = parseGoal(ev.target.elements.actual.value);
    if (actual == null) { toast(t('Enter the finish time as h:mm:ss or m:ss.')); return; }
    const pred = race().predicted_s;
    edit({ actual_s: actual }, pred
      ? t(actual - pred > 0
        ? 'Result saved: {time}, {gap} slower than projected. Future projections will learn from it.'
        : 'Result saved: {time}, {gap} faster than projected. Future projections will learn from it.', { time: fmtTime(actual), gap: fmtTime(Math.abs(actual - pred)) })
      : t('Result saved: {time}.', { time: fmtTime(actual) }));
  });
  const attached = st => toast(t('Course attached: {km} km, {m} m of climbing.', { km: (st.length_m / 1000).toFixed(2), m: Math.round(st.climb_m) }));
  on('[data-form="gpx"]', 'onsubmit', ev => {
    ev.preventDefault();
    const file = ev.target.elements.gpx.files[0];
    if (!file) { toast(t('Choose a GPX file first.')); return; }
    if (file.size > 8 * 1024 * 1024) { toast(t('That file is too big for a course GPX.')); return; }
    file.text().then(text => { attached(saveCourse(race(), parseGpx(text), 'gpx')); return redraw(); }).catch(e => toast(e.message || String(e)));
  });
  on('[data-form="course-run"]', 'onsubmit', ev => {
    ev.preventDefault();
    const btn = ev.target.querySelector('button'); btn.disabled = true;
    trackOf(ev.target.elements.id.value).then(pts => { attached(saveCourse(race(), pts, 'activity')); return redraw(); })
      .catch(e => { toast(e.message || String(e)); btn.disabled = false; });
  });
  on('[data-act="course-delete"]', 'onclick', () => { const { course, ...rest } = race(); put(state, 'races', id, rest); save('edit'); toast(t('Course removed.')); redraw(); });
  on('[data-form="ran"]', 'onsubmit', ev => {
    ev.preventDefault();
    const gid = ev.target.elements.id.value || null;
    if (gid && !state.activities[gid]) { toast(t('That activity is not one of yours.')); return; }
    edit({ garmin_id: gid }, gid ? t('Linked. The postmortem below now reads that run.') : t('Unlinked.'));
  });
  on('[data-act="race-delete"]', 'onclick', () => {
    if (typeof confirm === 'function' && !confirm(t('Remove {name}?', { name: race().name }))) return;
    remove(state, 'races', id); save('edit'); toast(t('Race removed')); location.hash = '#/races';
  });
}
