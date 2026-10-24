// Plan of the Day: the pod cowork channel's request and import, and what the page reads.
// CONTRACT (cowork.js depends on these two):
//   podContext(st, now) -> plain object written as pod/context.json's payload
//   importPod(st, payload) -> {handled: true, note} after storing state.pod[date]
//
// GymTracker's Plan of the Day, for endurance: the agent gets this morning's readiness,
// the week so far, the athlete's own paces and zones, the training-block week if a race
// has a plan, the forecast, the athlete's options -- and, the part that makes it learn,
// what happened to every plan it wrote in the last fortnight. Without recentOutcomes
// it would write every plan blind: never knowing the tempo it keeps prescribing keeps
// getting skipped, or that "45 minutes easy" keeps turning into 70.
import { put } from './merge.js';
import { state, save } from './store.js';
import * as D from './derive.js';
import * as F from './lib/fitness.js';
import * as PL from './lib/plan.js';
import * as AD from './lib/adherence.js';
import { dayKey, addDays, addDayKey, daysBetween, weekStart, isoLocal } from './lib/dt.js';
import { cachedForecast, defaultLocation, bestWindow, daySummary, normHours, heatBand, forecastFor, shouldFetch } from './forecast.js';
import { html, fmtPace, useCss } from './ui.js';

export const OUTCOME_DAYS = 14;
export const MAX_PLANS = 5;

// ---- sports: the agent writes free text, activities carry Garmin's type keys ----
export function normSport(s) {
  const t = String(s || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (!t) return 'other';
  if (F.RUN_TYPES.has(t) || /run|jog/.test(t)) return 'running';
  if (/cycl|bik|ride/.test(t)) return 'cycling';
  if (/swim/.test(t)) return 'swimming';
  if (/strength|gym|weight|lift/.test(t)) return 'strength';
  if (/walk|hik/.test(t)) return 'walking';
  if (/row/.test(t)) return 'rowing';
  return t;
}
const minutesOf = a => ((a.moving_s || a.elapsed_s || 0) / 60);
const r1 = v => (v == null ? null : Math.round(v * 10) / 10);

// 1-5, the scale the plans use. RPE (1-10) is the athlete's own word on it and wins;
// average HR against threshold is the fallback, and it under-reads interval sessions
// (the recoveries pull the average down), so it is labelled as an estimate.
export function intensityOf(a, rpe, thrHr) {
  if (rpe != null && isFinite(rpe)) return { intensity: Math.max(1, Math.min(5, Math.round(rpe / 2))), from: 'rpe' };
  if (a.avg_hr && thrHr) {
    const f = a.avg_hr / thrHr;
    return { intensity: f < 0.81 ? 1 : f < 0.90 ? 2 : f < 0.94 ? 3 : f < 1.0 ? 4 : 5, from: 'avg hr' };
  }
  return { intensity: null, from: null };
}

// What happened to each plan of the last `days` days. Pure: `acts` are activities with a
// day key in `start` (Date or ISO), `journal` is state.journal. -> rows, newest first.
//   done     the chosen plan's sport was trained that day (or, nothing chosen, a plan's sport was)
//   swapped  something else was trained instead
//   skipped  the day passed with nothing
//   pending  today, nothing yet
// An `outcome.status` the athlete set by hand overrides the inference.
export function outcomes(pods, acts, journal = {}, thrHr = null, today = dayKey(new Date()), days = OUTCOME_DAYS) {
  const from = addDayKey(today, -(days - 1)), out = [];
  const byDay = {};
  for (const a of acts) { const d = dayKey(a.start); if (d >= from && d <= today) (byDay[d] = byDay[d] || []).push(a); }
  for (const date of Object.keys(pods || {}).filter(d => d >= from && d <= today).sort().reverse()) {
    const rec = pods[date], plans = (rec && rec.plans) || [];
    const chosen = rec.chosen != null ? plans.find(p => p.name === rec.chosen) || null : null;
    const dayActs = byDay[date] || [];
    const closest = plan => {
      const want = normSport(plan.sport), mins = plan.minutes || 0;
      return dayActs.filter(a => normSport(a.type) === want)
        .sort((x, y) => Math.abs(minutesOf(x) - mins) - Math.abs(minutesOf(y) - mins))[0] || null;
    };
    let plan = chosen, match = chosen ? closest(chosen) : null, inferred = false;
    if (!chosen) for (const p of plans) { const m = closest(p); if (m) { plan = p; match = m; inferred = true; break; } }
    let status = match ? 'done' : dayActs.length ? 'swapped' : date < today ? 'skipped' : 'pending';
    const manual = rec.outcome && ['done', 'skipped', 'swapped'].includes(rec.outcome.status) ? rec.outcome : null;
    if (manual) status = manual.status;
    const p = plan || plans[0] || {};
    const actual = match ? (() => {
      const rpe = journal[match.id]?.rpe ?? null, it = intensityOf(match, rpe, thrHr);
      return { id: match.id, name: match.name || null, sport: normSport(match.type), minutes: Math.round(minutesOf(match)),
        km: match.distance_m ? r1(match.distance_m / 1000) : null, avg_hr: match.avg_hr ? Math.round(match.avg_hr) : null,
        rpe, intensity: it.intensity, intensityFrom: it.from };
    })() : null;
    out.push({
      date, chosen: !!chosen, inferred, status, byHand: !!manual, note: manual?.note || null,
      plan: p.name || null, sport: p.sport ? normSport(p.sport) : null,
      planned: { minutes: p.minutes ?? null, intensity: p.intensity ?? null },
      actual,
      minutesRatio: actual && p.minutes ? r1(actual.minutes / p.minutes) : null,
      didInstead: !match && dayActs.length ? dayActs.map(a => ({ name: a.name || null, sport: normSport(a.type), minutes: Math.round(minutesOf(a)) })) : null,
    });
  }
  return out;
}
// Counts, and how long the done ones ran against plan. n is small by construction (a
// fortnight at most), so this is a nudge for the agent, not a statistic.
export function outcomeSummary(rows) {
  const n = s => rows.filter(r => r.status === s).length;
  const ratios = rows.map(r => r.minutesRatio).filter(v => v != null);
  return { plans: rows.length, done: n('done'), skipped: n('skipped'), swapped: n('swapped'), pending: n('pending'),
    medianMinutesRatio: ratios.length ? [...ratios].sort((a, b) => a - b)[Math.floor(ratios.length / 2)] : null,
    note: rows.length < 5 ? 'Fewer than five plans so far: read these as anecdotes, not a pattern.' : null };
}

// ---- options ----
const strs = v => (Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean).slice(0, 20) : []);
export function normOptions(o = {}) {
  const am = o.availableMinutes || {};
  let min = +am.min || 30, max = +am.max || 60;
  if (min > max) [min, max] = [max, min];
  return { availableMinutes: { min: Math.max(5, Math.round(min)), max: Math.min(600, Math.round(max)) },
    sports: strs(o.sports).length ? strs(o.sports) : ['running'], surfaces: strs(o.surfaces), niggles: strs(o.niggles),
    notes: String(o.notes || '').slice(0, 1000), hours: normHours(o.hours) };
}

// ---- the training-block week (race.js's approach: a plan built from today) ----
function blockWeek(st, s, now, today) {
  // The nearest race not yet run defines the block (a result entered today means it is done).
  const ahead = D.races(st).filter(r => r.date >= today && r.distance_m && !r.actual_s);
  const race = ahead[0];
  if (!race) return null;
  const days = daysBetween(today, race.date), weeksOut = Math.floor(days / 7);
  const out = { race: { name: race.name, date: race.date, distance_m: race.distance_m, days_to_race: days, goal_s: race.goal_s ?? null }, week: null, adherence: null,
    later: ahead.slice(1, 4).map(r => ({ name: r.name, date: r.date, distance_m: r.distance_m })) };
  if (!s || weeksOut < 2) { out.note = days <= 14 ? 'Inside the last fortnight: taper, keep it short and sharp.' : null; return out; }
  // Running volume only, as race.js: summary.weekly counts every cardio activity.
  const since = addDays(now, -42), runs = D.runs(st);
  const currentWeekM = runs.filter(a => a.start >= since).reduce((t, a) => t + (a.distance_m || 0), 0) / 6;
  if (currentWeekM <= 5000) { out.note = 'Too little running in the last six weeks to build a block from.'; return out; }
  const plan = PL.build(currentWeekM, race.distance_m, Math.min(weeksOut, 24), s.paces);
  // The plan is rebuilt from today, so the week the athlete is in is its first.
  const wk = AD.nextSession(plan, today, today);
  if (wk) {
    const mon = weekStart(now);
    const doneM = runs.filter(a => dayKey(a.start) >= mon && dayKey(a.start) <= today).reduce((t, a) => t + (a.distance_m || 0), 0);
    out.week = { phase: wk.phase, weeks_to_go: wk.to_go, distance_m: Math.round(wk.distance_m), long_run_m: Math.round(wk.long_run_m),
      easy_week: wk.easy_week, run_this_week_m: Math.round(doneM),
      sessions: (wk.sessions || []).map(([name, description, band]) => ({ name, description, pace_s_per_km: band ? band.map(Math.round) : null })) };
  }
  const rv = plan.length ? AD.review(plan, runs, dayKey(addDays(now, -7 * plan.length)), today) : null;
  if (rv) out.adherence = { share: rv.share != null ? r1(rv.share) : null, on_target: rv.on_target, weeks: rv.weeks, note: rv.note };
  return out;
}

// ---- the forecast, as the context and the page read it ----
export function forecastToday(st, now = new Date(), opts = normOptions(st.profile?.podOptions)) {
  const loc = defaultLocation(st);
  if (!loc) return { location: null };
  const f = cachedForecast(loc.lat, loc.lon, now.getTime());
  if (!f) return { location: loc, forecast: null };
  const today = dayKey(now);
  const inHours = f.hours.filter(r => r.day === today && r.hour >= opts.hours.from && r.hour < opts.hours.to);
  return { location: loc, forecast: f, fetchedAt: f.fetchedAt, today: daySummary(f.hours, today),
    hours: inHours,
    best: bestWindow(f.hours, { day: today, ...opts.hours, minutes: opts.availableMinutes.min, notBefore: isoLocal(now) }),
    bestLong: bestWindow(f.hours, { day: today, ...opts.hours, minutes: opts.availableMinutes.max, notBefore: isoLocal(now) }) };
}

const actRow = a => ({ date: dayKey(a.start), name: a.name || null, sport: normSport(a.type), minutes: Math.round(minutesOf(a)),
  km: a.distance_m ? r1(a.distance_m / 1000) : null, avg_hr: a.avg_hr ? Math.round(a.avg_hr) : null });

export function podContext(st, now = new Date()) {
  const today = dayKey(now), s = D.summary(st, now), acts = D.activities(st);
  const opts = normOptions(st.profile && st.profile.podOptions);
  const rd = D.readinessToday(st, s ? s.tsb : null);
  const mon = weekStart(now);
  const fc = forecastToday(st, now, opts);
  const rows = outcomes(st.pod, acts, st.journal, s?.threshold_hr ?? null, today);
  const pick = w => w && { start: w.start, end: w.end, temp_c: r1(w.temp), dew_point_c: r1(w.dew), wind_kph: r1(w.wind),
    rain_pct: w.rain, heat_cost_pct: r1(w.penalty * 100), choice_matters: w.matters };
  return {
    date: today, generatedAt: now.toISOString(),
    readiness: rd ? { day: rd.day || null, stale: !!rd.day && rd.day < addDayKey(today, -1), band: rd.band, verdict: rd.verdict,
      score: Math.round(rd.score), confidence: rd.confidence, used: rd.used, advice: rd.advice || null,
      hrv_ms: rd.latest?.hrv_ms ?? null, rhr: rd.latest?.rhr ?? null, sleep_hours: rd.latest?.sleep_hours ?? null,
      sleep_score: rd.latest?.sleep_score ?? null, tsb: s ? r1(s.tsb) : null } : null,
    fitness: s ? { ctl: r1(s.ctl), atl: r1(s.atl), tsb: r1(s.tsb), threshold_hr: s.threshold_hr ? Math.round(s.threshold_hr) : null,
      threshold_pace_s_per_km: s.threshold_pace ? Math.round(s.threshold_pace) : null } : null,
    week: {
      start: mon,
      activities: acts.filter(a => dayKey(a.start) >= mon && dayKey(a.start) <= today).map(actRow).reverse(),
      last4: s ? s.weekly.slice(-4).map(([w, km, h, l]) => ({ week: w, km: r1(km), hours: r1(h), load: Math.round(l) })) : [],
      yesterday: acts.filter(a => dayKey(a.start) === addDayKey(today, -1)).map(actRow),
    },
    paces: s ? s.paces.map(([name, purpose, fast, slow]) => ({ name, purpose, fast_s_per_km: Math.round(fast), slow_s_per_km: Math.round(slow) })) : [],
    hrZones: s ? s.zones.map(([name, low, high]) => ({ name, low, high })) : [],
    block: blockWeek(st, s, now, today),
    forecast: fc.forecast ? { location: { lat: +fc.location.lat.toFixed(2), lon: +fc.location.lon.toFixed(2), source: fc.location.source },
      fetchedAt: fc.fetchedAt, today: fc.today, bestWindow: pick(fc.best), bestWindowForMax: pick(fc.bestLong),
      hours: fc.hours.map(r => ({ hour: r.hour, temp_c: r.temp, feels_c: r.feels, dew_point_c: r.dew, humidity: r.rh, wind_kph: r.wind, rain_pct: r.rain })) }
      : { unavailable: fc.location ? 'not fetched on this device in the last 12 hours' : 'no location set' },
    options: opts,
    strength: acts.filter(a => a.source === 'gymtracker' && dayKey(a.start) >= addDayKey(today, -13))
      .map(a => ({ date: dayKey(a.start), name: a.name || 'Strength', minutes: Math.round(minutesOf(a)), avg_hr: a.avg_hr ? Math.round(a.avg_hr) : null })),
    recentOutcomes: rows,
    outcomeSummary: outcomeSummary(rows),
  };
}

// ---- the reply ----
const num = (v, lo, hi) => (typeof v === 'number' && isFinite(v) && v >= lo && v <= hi ? v : null);
const pair = (v, lo, hi) => {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const a = num(+v[0], lo, hi), b = num(+v[1], lo, hi);
  return a != null && b != null ? [Math.min(a, b), Math.max(a, b)] : null;
};
export function validatePlan(raw) {
  if (!raw || typeof raw !== 'object' || !String(raw.name || '').trim()) return null;
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).map(s => {
    if (!s || typeof s !== 'object') return null;
    const st = { minutes: num(+s.minutes, 0.05, 600), reps: s.reps != null ? num(Math.round(+s.reps), 1, 100) : null,
      target: String(s.target || '').slice(0, 60), pace_s_per_km: pair(s.pace_s_per_km, 90, 1500), hr: pair(s.hr, 40, 230),
      note: String(s.note || '').slice(0, 300) };
    return st.minutes != null || st.target || st.note ? st : null;
  }).filter(Boolean).slice(0, 20);
  const minutes = num(+raw.minutes, 1, 600) ?? (steps.length ? Math.round(steps.reduce((t, s) => t + (s.minutes || 0) * (s.reps || 1), 0)) || null : null);
  return { name: String(raw.name).trim().slice(0, 80), sport: normSport(raw.sport || 'running'), minutes,
    intensity: Math.max(1, Math.min(5, Math.round(+raw.intensity) || 3)), description: String(raw.description || '').slice(0, 4000),
    steps, why: String(raw.why || '').slice(0, 400) };
}
export function importPod(st, p) {
  if (!p || !Array.isArray(p.plans)) return { handled: false, note: 'no plans' };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) ? p.date : dayKey(new Date());
  const plans = p.plans.map(validatePlan).filter(Boolean).slice(0, MAX_PLANS);
  const dropped = p.plans.length - plans.length;
  if (!plans.length) return { handled: false, note: 'no valid plans (' + dropped + ' dropped)' };
  // Re-import keeps what the athlete did with the earlier version: the pick and the outcome.
  const prev = st.pod[date] || {};
  put(st, 'pod', date, { date, rationale: String(p.rationale || '').slice(0, 2000), plans, generatedAt: new Date().toISOString(),
    via: p.via || 'cowork', chosen: prev.chosen ?? null, chosenAt: prev.chosenAt ?? null, outcome: prev.outcome ?? null });
  // ponytail: no pruning -- a plan day is ~2 KB, a year of them is under a megabyte.
  return { handled: true, note: plans.length + ' plans for ' + date + (dropped ? ', ' + dropped + ' dropped' : '') };
}

// ---- the direct transport: "Plan it now" with the athlete's own key ----
const SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.132.1/+esm';   // the version ai.js loads
export async function podSystemPrompt() {
  const { instructions } = await import('./cowork.js');
  // The channel's own contract, minus the folder mechanics (envelope, inbox) that do not apply here.
  const body = instructions('pod').split('## kind:').pop();
  return 'You are an experienced endurance coach writing today\'s plan of the day for one athlete. '
    + 'You are given the app\'s brief and the pod channel\'s context.json. Reply with ONLY the JSON payload described below '
    + '-- no envelope, no prose, no code fence.\n\n## kind:' + body;
}
export function parseReply(text) {
  const t = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('The reply held no JSON.');
  return JSON.parse(t.slice(a, b + 1));
}
export async function planNow(now = new Date()) {
  const { apiKey, MODEL } = await import('./ai.js');
  const key = apiKey();
  if (!key) throw new Error('No Anthropic API key on this device (Sync & cowork → AI).');
  const { default: Anthropic } = await import(SDK);
  const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
  const prompt = D.briefMarkdown(D.buildBrief(state, now)) + '\n\n---\ncontext.json payload:\n```json\n'
    + JSON.stringify(podContext(state, now), null, 1) + '\n```';
  // Same setup as ai.js: streamed, adaptive thinking, server-side fallback on a declined request.
  const stream = client.beta.messages.stream({
    model: MODEL, max_tokens: 64000, system: await podSystemPrompt(),
    thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    messages: [{ role: 'user', content: prompt }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined this one' + (msg.stop_details?.explanation ? ': ' + msg.stop_details.explanation : '.'));
  const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const res = importPod(state, { ...parseReply(text), via: 'api' });
  if (!res.handled) throw new Error('The plan could not be read: ' + res.note);
  save('pod');
  return res;
}

// ---- shared bits for the page and the Today panel ----
export const todayPod = (st = state, now = new Date()) => st.pod[dayKey(now)] || null;
export const chosenPlan = rec => (rec ? rec.plans.find(p => p.name === rec.chosen) || null : null);
export const INTENSITY = ['', 'very easy', 'easy', 'moderate', 'hard', 'very hard'];
const paceBand = b => fmtPace(b[0], 1000).replace(' /km', '') + '–' + fmtPace(b[1], 1000);
// One step as a line: "40 min easy · 5:30–6:10 /km (heat 5:38–6:19) · HR 130–145 · conversational".
export function stepLine(s, cond) {
  const bits = [];
  const dur = s.minutes != null ? (s.minutes < 1 ? Math.round(s.minutes * 60) + ' s' : r1(s.minutes) + ' min') : '';
  bits.push(((s.reps ? s.reps + ' × ' : '') + dur + (s.target ? ' ' + s.target : '')).trim());
  if (s.pace_s_per_km) {
    const hb = heatBand(s.pace_s_per_km, cond);
    bits.push(paceBand(s.pace_s_per_km) + (hb ? ' (in this heat ' + paceBand(hb) + ')' : ''));
  }
  if (s.hr) bits.push('HR ' + s.hr[0] + '–' + s.hr[1]);
  if (s.note) bits.push(s.note);
  return bits.filter(Boolean).join(' · ');
}

// ---- Today's panel ----
const PANEL_CSS = `.pod-panel .pod-line { margin: 4px 0 0; color: var(--muted); font-size: 14px; }
.pod-panel .pod-name { font-family: var(--display); font-size: 19px; font-weight: 600; margin: 0; }`;
const wxLine = fc => (fc && fc.best ? 'Best window ' + fc.best.start + '–' + fc.best.end + ': ' + Math.round(fc.best.temp) + ' °C'
  + (fc.best.dew != null ? ', dew point ' + Math.round(fc.best.dew) + ' °C' : '') + (fc.best.rain ? ', ' + fc.best.rain + '% rain' : '')
  + (fc.best.penalty >= 0.005 ? ' — about ' + (fc.best.penalty * 100).toFixed(1) + '% slower' : '') : '');
export function podPanel() {
  useCss('pod-panel', PANEL_CSS);
  const rec = todayPod(), now = new Date();
  if (!rec && !Object.keys(state.activities).length) return '';
  const fc = forecastToday(state, now), p = rec ? chosenPlan(rec) || rec.plans[0] : null, line = wxLine(fc);
  return html`<section class="panel pod-panel" data-pod-panel>
    <div class="panel-head"><p class="eyebrow">Plan of the day</p>
      <p class="panel-note"><a class="quiet-link" href="#/pod">${p ? (rec.chosen ? 'your pick' : rec.plans.length + ' options') : 'plan it'} →</a></p></div>
    ${p ? html`<p class="pod-name">${p.name}</p>
      <p class="pod-line">${p.minutes != null ? p.minutes + ' min · ' : ''}${INTENSITY[p.intensity] || ''}${p.why ? ' — ' + p.why : ''}</p>`
    : html`<p class="pod-line">No plan for today yet. <a class="quiet-link" href="#/pod">Ask for one</a>.</p>`}
    ${line ? html`<p class="pod-line">${line}</p>` : ''}
  </section>`;
}
// Fetch the forecast if this device has none, then redraw the panel in place.
export function mountPodPanel(el) {
  const node = el && (el.matches?.('[data-pod-panel]') ? el : el.querySelector?.('[data-pod-panel]'));
  if (!node) return;
  const fc = forecastToday(state);
  if (!fc.location || fc.forecast || !shouldFetch(fc.location.lat, fc.location.lon)) return;
  forecastFor(fc.location.lat, fc.location.lon).then(() => {
    const t = document.createElement('div'); t.innerHTML = String(podPanel());
    if (t.firstElementChild && node.isConnected) node.replaceWith(t.firstElementChild);
  }).catch(() => {});
}
