// The run-review cowork channel (house standard 18, GymTracker's workout-review pattern): the
// app grades every session by algorithm (load, drift, efficiency, zones, reps, durability...);
// this channel asks an AI to grade the same sessions more deeply, with the app's numbers and the
// raw detail in hand. The AI's review is stored BESIDE the app's numbers, never instead of them.
//
//   request  context.json -> { sessions: [digest...], history: [compact...], form }
//   reply    run-review-output -> { reviews: [{ sessionId, grade, summary, strengths, fixes, next }] }
//   stored   state.runReviews[activity id] (synced), shown on the activity page; undo removes it
import { put } from './merge.js';
import { hasStream } from './store.js';
import * as D from './derive.js';
import * as F from './lib/fitness.js';
import { dayKey } from './lib/dt.js';
import { html } from './ui.js';

const WINDOW_DAYS = 14, MAX_SESSIONS = 5, HISTORY = 12, MIN_MOVING_S = 10 * 60;

// Text a clipped review keeps: an agent cannot fill the synced state with an essay.
const clip = (s, n) => String(s ?? '').trim().slice(0, n);
const list = (xs, n = 4) => (Array.isArray(xs) ? xs : xs ? [xs] : []).map(x => clip(x, 300)).filter(Boolean).slice(0, n);

// What a review is of: when any of these change, the review is "for an earlier version".
function djb2(t) { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0; return h.toString(36); }
export function sessionHash(st, act) {
  const a = st.activities[act.id] || act, j = st.journal?.[a.id] || {};   // the stored record: its start is a string
  return djb2(JSON.stringify([String(a.start).slice(0, 19), a.type, a.distance_m, a.moving_s, a.avg_hr, a.max_hr, a.elev_gain_m, j.rpe, j.feel, j.note]));
}

const gradeable = a => a && a.source !== 'gymtracker' && (a.moving_s || 0) >= MIN_MOVING_S && !/strength|yoga|pilates|breath/i.test(a.type || '');
const r1 = v => (v == null || !isFinite(v) ? null : Math.round(v * 10) / 10);
const paceOf = a => (a.distance_m && a.moving_s ? Math.round(a.moving_s / (a.distance_m / 1000)) : null);

async function digest(st, a, ctx) {
  const d = st.derived[a.id] || {}, w = st.weather[a.id] || null, j = st.journal[a.id] || null;
  const night = st.wellness[dayKey(a.start)] || null;
  const eff = ctx.eff.find(r => r.id === a.id);
  let splits = null;
  try { const full = await D.getDetail(a.id); splits = full && full.splits && full.splits.length ? full.splits : null; } catch { /* no detail here */ }
  return {
    sessionId: a.id, date: dayKey(a.start), start: String(a.start).slice(0, 19), name: a.name, type: a.type,
    distance_km: a.distance_m ? r1(a.distance_m / 1000) : null, moving_min: a.moving_s ? r1(a.moving_s / 60) : null,
    elapsed_min: a.elapsed_s ? r1(a.elapsed_s / 60) : null, pace_s_per_km: paceOf(a),
    avg_hr: a.avg_hr ?? null, max_hr: a.max_hr ?? null, elev_gain_m: a.elev_gain_m ?? null,
    weather: w, journal: j, night: night && { sleep_hours: night.sleep_hours ?? null, sleep_score: night.sleep_score ?? null, hrv_ms: night.hrv_ms ?? null, rhr: night.rhr ?? null },
    // The app's own grading, as it shows it: these are the numbers the AI grades beside.
    app: {
      load: r1(F.activityLoad(a, ctx.thrHr, ctx.thrSpd)),
      hr_load_factor: d.hrf ?? null,
      kind: F.classifyRun(a, ctx.thrHr, ctx.thrPace) || null,   // the app's reading of what the run was
      aerobic_drift_pct: d.drift != null && isFinite(d.drift) ? r1(d.drift) : null,
      efficiency: eff ? { ef: +eff.ef.toFixed(3), vs_90d_median_pct: ctx.efMedian ? r1((eff.ef / ctx.efMedian - 1) * 100) : null, corrected: eff.corrected } : null,
      zones_seconds: d.zones ? d.zones.secs : null, threshold_hr: ctx.thrHr ?? null,
      intervals: d.session || null, durability: d.durability || null, stops: d.stops ? { ...d.stops, at: undefined } : null,
      climb: d.climb || null, hr_recovery: d.hrr || null, power: d.power || null,
      best_efforts_s: d.efforts && Object.keys(d.efforts).length ? d.efforts : null,
      strava: a.strava || null,
    },
    splits,
    stream: (await hasStream(a.id)) ? `../data/streams/${a.id}.json` : null,
  };
}

// The sessions to review: the last 14 days, unreviewed or changed since their review, newest first.
export async function runReviewContext(st, now = new Date()) {
  const from = dayKey(new Date(now - WINDOW_DAYS * 864e5));
  const acts = D.activities(st).filter(gradeable).slice().sort((x, y) => y.start - x.start);
  const reviews = st.runReviews || {};
  const due = acts.filter(a => dayKey(a.start) >= from && (!reviews[a.id] || reviews[a.id].sessionHash !== sessionHash(st, a))).slice(0, MAX_SESSIONS);
  const s = D.summary(st, now), eff = D.efficiencyRows(st);
  const cut = dayKey(new Date(now - 90 * 864e5)), recent = eff.filter(r => r.date >= cut).map(r => r.ef).sort((p, q) => p - q);
  const ctx = { thrHr: s?.threshold_hr ?? null, thrPace: s?.threshold_pace ?? null, thrSpd: F.thresholds(D.activities(st))[1], eff,
    efMedian: recent.length ? recent[recent.length >> 1] : null };
  const sessions = [];
  for (const a of due) sessions.push({ ...(await digest(st, a, ctx)), sessionHash: sessionHash(st, a), reviewedBefore: !!reviews[a.id] });
  return {
    sessions,
    history: acts.slice(0, HISTORY).map(a => ({ sessionId: a.id, date: dayKey(a.start), name: a.name, type: a.type,
      distance_km: a.distance_m ? r1(a.distance_m / 1000) : null, moving_min: a.moving_s ? r1(a.moving_s / 60) : null,
      pace_s_per_km: paceOf(a), avg_hr: a.avg_hr ?? null, load: r1(F.activityLoad(a, ctx.thrHr, ctx.thrSpd)),
      drift_pct: st.derived[a.id]?.drift != null ? r1(st.derived[a.id].drift) : null,
      ai_grade: reviews[a.id]?.grade ?? null })),
    form: s ? { ctl: r1(s.ctl), atl: r1(s.atl), tsb: r1(s.tsb), ctl_6w_ago: r1(s.ctl_6w_ago), threshold_hr: s.threshold_hr ?? null, threshold_pace_s_per_km: s.threshold_pace ?? null } : null,
  };
}

// Store the accepted reviews beside the app's numbers. Unknown sessions are skipped, not invented.
export function importRunReview(st, p) {
  let n = 0, skipped = 0;
  for (const r of (p && p.reviews) || []) {
    const a = r && st.activities[r.sessionId];
    if (!a || !r.grade) { skipped++; continue; }
    put(st, 'runReviews', a.id, { id: a.id, grade: clip(r.grade, 12), summary: clip(r.summary, 1500), strengths: list(r.strengths),
      fixes: list(r.fixes), next: list(r.next, 3), sessionHash: sessionHash(st, a), at: new Date().toISOString() });
    n++;
  }
  return { handled: true, note: `${n} session review${n === 1 ? '' : 's'}` + (skipped ? `, ${skipped} skipped (unknown session or no grade)` : '') };
}

// On the activity page, under the app's own numbers.
export function runReviewPanel(st, id) {
  const r = st.runReviews && st.runReviews[id], a = st.activities[id];
  if (!r || !a) return '';
  const changed = r.sessionHash !== sessionHash(st, a);
  const ul = (title, xs) => (xs && xs.length ? html`<p class="eyebrow" style="margin:10px 0 2px">${title}</p><ul style="margin:0;padding-left:18px">${xs.map(x => html`<li>${x}</li>`)}</ul>` : '');
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">AI review · cowork</p>
      <p class="panel-note">Graded ${r.grade}${changed ? ' · this activity changed since' : ''}</p></div>
    <p style="margin:0">${r.summary}</p>${ul('Went well', r.strengths)}${ul('To fix', r.fixes)}${ul('Next time', r.next)}
    <p class="stat-hint" style="margin-top:10px">An AI's reading of the same run, beside the app's own numbers above; it replaces none of them.</p></section>`;
}

export const INSTRUCTIONS = `## kind: \`run-review-output\` — grade each session in depth

\`\`\`json
{ "reviews": [ { "sessionId": "<from context.json>", "grade": "B+",
    "summary": "2-4 sentences: what this session was for and how well it did that",
    "strengths": ["up to 4, each citing a number"], "fixes": ["up to 4, each citing a number"],
    "next": ["one or two concrete things for the next session like it"] } ] }
\`\`\`

**Run this channel last**, after \`garmin\` and \`strava\` have been answered and imported, so the sessions are complete.

- \`context.json\` → \`sessions\`: each finished run or ride the app has not had reviewed (or that changed since). Each carries the app's own grading under \`app\` (load, aerobic drift, efficiency against the 90-day median, time in heart-rate zones, intervals, durability, stops, climb, HR recovery, power, best efforts, Strava's numbers), the km \`splits\`, the night before (\`night\`), the weather, the athlete's own \`journal\` (RPE 1–10, feel 1–5, note) and, when there is one, \`stream\`: the per-second file to compute from. \`history\` is the last 12 sessions for trend; \`form\` is fitness / fatigue / form today.
- **Rubric.** First decide what the session was for (easy, long, tempo or threshold, intervals, race, recovery, commute) from its shape, the name and the journal. Then grade it **A+ to F against that purpose**, weighing: (1) execution: intensity where the purpose wants it (zones, pace, power; an easy run that drifted into tempo is a B at best); (2) pacing: splits and how the second half compared with the first; (3) aerobic control: drift under 5% is good on steady running, over 10% is a flag unless heat or hills explain it; (4) durability late in long runs; (5) intervals: rep-to-rep consistency and recoveries; (6) load against the history and today's form, and against the night before; (7) conditions: credit heat, wind and climbing honestly.
- Cite the numbers. Agree or disagree with the app's numbers explicitly when it matters, and say why. One review per session in \`sessions\`; never invent a \`sessionId\`.
- The athlete reviews every grade before it is stored, and it is shown beside the app's numbers, never instead of them. No medical advice.
`;
