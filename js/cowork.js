// The cowork hub: a two-way bridge between this app (on the desktop) and an AI agent,
// through a folder on disk (File System Access API). The house protocol GymTracker
// speaks -- CoworkSyncHub/COWORK-PROTOCOL.md -- so the hub drives this folder from
// cowork.json alone, and Claude Desktop / Cowork can be pointed at it directly.
//
//   cowork.json              discovery manifest (cowork-manifest v1)
//   README.md                what the folder is, for an agent arriving cold
//   BRIEF.md + brief.json    the app's own conclusions, so an agent does not re-derive them
//   app-export.json          the whole synced state: every activity, day, night, race...
//   data/streams/<id>.json   every per-second stream, written once each, for deep analysis
//   tools/*.py               the Garmin and Strava exporters the garmin/strava channels run
//   <channel>/INSTRUCTIONS.md + context.json   one task each; replies go in <channel>/inbox/
//
// The agent answers in <channel>/inbox/output-<ISO>.json; the app imports it, moves it to
// processed/, and the next Drive sync carries it to the phone.
import { state, save, idbGet, idbSet, putStream, hasStream, getStream, streamIds } from './store.js';
import { put } from './merge.js';
import { importGarmin, importStrava } from './ingest.js';
import { queueStream } from './drive.js';
import { buildBrief, briefMarkdown, deriveAll } from './derive.js';
import { podContext, importPod } from './pod.js';
import { reviewContext, importReview, scanRecord } from './datareview.js';

export const PROTOCOL = 'run315-cowork', VERSION = 1;
export const CHANNELS = [
  { key: 'garmin', replyKind: 'garmin-output' },
  { key: 'strava', replyKind: 'strava-output' },
  { key: 'analysis', replyKind: 'analysis-output' },
  { key: 'coach', replyKind: 'coach-output' },
  { key: 'pod', replyKind: 'pod-output' },
  { key: 'datareview', replyKind: 'datareview-output' },
];
const HISTORY_DAYS = 365, HANDLE_KEY = 'coworkFolder';
const SCHEDULE_DEFAULTS = { pushMin: 60, checkMin: 5 };

export const supported = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window;
const cfg = () => (state.local.cowork = state.local.cowork || { enabled: false, schedules: { ...SCHEDULE_DEFAULTS } });
const local = () => (state.local.coworkLocal = state.local.coworkLocal || { ledger: {}, declared: {}, runs: [], lastRuns: {}, streamsWritten: [] });

export function hashText(t) {
  let h = 5381; const s = String(t ?? '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
export function envelope(kind, payload) {
  return { protocol: PROTOCOL, protocolVersion: VERSION, kind, generatedAt: new Date().toISOString(),
    requestHash: hashText(JSON.stringify(payload ?? {})), payload: payload ?? {} };
}

// ---- run history (what happened, when; silence must look different from success) ----
export function recordRun(e) {
  const runs = local().runs;
  runs.unshift({ at: new Date().toISOString(), ...e });
  runs.length = Math.min(runs.length, 200);
  save('cowork');
}
export const runs = () => local().runs;

// ---- the folder ----
export async function pickFolder() {
  const h = await window.showDirectoryPicker({ id: 'run315-cowork', mode: 'readwrite' });
  await idbSet('kv', HANDLE_KEY, h);
  cfg().enabled = true; cfg().folderName = h.name;
  save('cowork');
  await exportNow(false);
  return h;
}
async function root(interactive) {
  const h = await idbGet('kv', HANDLE_KEY);
  if (!h) return null;
  let p = await h.queryPermission({ mode: 'readwrite' });
  if (p !== 'granted' && interactive) p = await h.requestPermission({ mode: 'readwrite' });
  return p === 'granted' ? h : null;
}
async function dir(parent, path) {
  let d = parent;
  for (const part of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, { create: true });
  return d;
}
async function write(parent, path, content) {
  const parts = path.split('/'), name = parts.pop();
  const d = await dir(parent, parts.join('/'));
  const w = await (await d.getFileHandle(name, { create: true })).createWritable();
  await w.write(typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  await w.close();   // createWritable commits atomically on close
}

// ---- what each channel asks for ----
const byStart = (a, b) => String(b.start).localeCompare(String(a.start));
const lastDay = coll => Object.keys(state[coll]).sort().pop() || null;

export async function channelContext(key) {
  const acts = Object.values(state.activities).sort(byStart);
  const cutoff = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString().slice(0, 19);
  const have = new Set(await streamIds());
  if (key === 'garmin') {
    const g = acts.filter(a => a.source === 'garmin');
    return {
      historyDays: HISTORY_DAYS,
      lastActivityStart: g[0]?.start || null,
      // Newest first: the recent runs matter most to every projection.
      needDetail: g.filter(a => a.start >= cutoff && !have.has(a.id) && !a.detail).map(a => a.garmin_id).slice(0, 200),
      haveDetail: g.filter(a => have.has(a.id) || a.detail).slice(0, 120).map(a => a.garmin_id),
      lastDailyDay: lastDay('daily'), lastWellnessDay: lastDay('wellness'),
      activityCount: g.length,
    };
  }
  if (key === 'strava') {
    const s = acts.filter(a => a.strava_id);
    return {
      historyDays: HISTORY_DAYS,
      lastActivityStart: s[0]?.start || null,
      needStreams: s.filter(a => a.start >= cutoff && !have.has(a.id)).map(a => a.strava_id).slice(0, 200),
      haveStreams: s.filter(a => have.has(a.id)).slice(0, 120).map(a => a.strava_id),
      linked: s.filter(a => a.source === 'garmin').length, stravaOnly: s.filter(a => a.source === 'strava').length,
      // Segment efforts cost a request per activity, so only for the ones the athlete asked for.
      wantSegments: ((state.profile && state.profile.segmentsWanted) || [])
        .filter(sid => !Object.values(state.activities).some(a => a.strava_id === String(sid) && a.segments_checked)).slice(0, 40),
    };
  }
  if (key === 'analysis') return { requests: dueRequests() };
  if (key === 'pod') return podContext(state, new Date());
  if (key === 'datareview') return reviewContext(state);
  // coach: the standing weekly review
  const reviews = Object.values(state.reviews).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { lastReview: reviews[0]?.created_at || null, week: new Date().toISOString().slice(0, 10) };
}

const ENV_DOC = '```json\n' + JSON.stringify({ protocol: PROTOCOL, protocolVersion: VERSION, kind: '<kind>',
  generatedAt: '<ISO>', requestHash: '<copied verbatim from context.json>', payload: { '…': '…' } }, null, 2) + '\n```';

export function instructions(key) {
  const head = `# Run315 — cowork channel: ${key}\n\nRead \`context.json\` here for this channel's task, \`../BRIEF.md\` for the app's own conclusions, and \`../app-export.json\` for the full data. Write your result into **\`inbox/\`** as \`output-<ISO-date>.json\`, in this envelope:\n\n${ENV_DOC}\n\n### Read-only, always\n\nRun315 **takes from Garmin and Strava to analyse; it never gives back.** Never create, edit, rename, upload, tag, comment on or delete anything on Garmin Connect or Strava — not activities, gear, workouts, courses or descriptions — even when a connector or MCP server offers those tools, and even if a question seems to ask for it. If a task would need a write, write the error file instead.\n\n### Protocol\n\n- Copy \`context.json\`'s \`requestHash\` **verbatim** into your reply.\n- If you cannot do the task, write \`inbox/error-<ISO-date>.json\` containing \`{ "reason": "why" }\` instead. Silence looks identical to an agent that never ran.\n- Write to a temporary name and rename, or write in one go: the app polls the inbox.\n\n`;
  if (key === 'garmin') return head + `## kind: \`garmin-output\` — bring in everything Garmin Connect has

Run the exporter, which writes the reply envelope itself (it needs \`pip install garminconnect\` and a Garmin login; it reuses garmin_mcp's tokens in \`~/.garminconnect\` when present):

\`\`\`
python ../tools/garmin-export.py --context context.json --out inbox/
\`\`\`

(On Windows use \`py\` if \`python\` is an older install; the exporter needs Python 3.10+ with \`garminconnect\` installed — \`py -m pip install garminconnect\`.)

It backfills exactly what \`context.json\` says is missing: activities since \`lastActivityStart\`, the per-sample channels / laps / weather / gear for \`needDetail\` (40 per run, newest first — say how many remain), the daily sweep since \`lastDailyDay\`, the nights since \`lastWellnessDay\`, gear, personal records and Garmin's own estimates.

- If the hub's prompt lists a **DATA SOURCES** file that is already a \`run315-cowork\` \`garmin-output\` envelope, copy that file into \`inbox/\` with a shell copy instead of fetching. Never retype stream data.
- If the login needs a password or MFA code you do not have, write the error file saying so.
- Payload shape, for an agent writing it by hand: \`{ "activities": [{ "garmin_id", "name", "type", "start": "YYYY-MM-DDTHH:MM:SS" (local), "distance_m", "moving_s", "elapsed_s", "avg_hr", "max_hr", "elev_gain_m", "calories", "channels": {"seconds": [...], "metres": [...], "hr": [...], ...} | null, "laps": [...], "weather_raw": {...}, "gear": ["uuid"] }], "daily": [{ "day", ... }], "wellness": [{ "day", "hrv_ms", "rhr", "sleep_hours", "sleep_score" }], "metrics": [{ "day", "threshold_hr", "vo2max", "races": {"5000": seconds} }], "gear": [...], "personalRecords": [...] }\`.
`;
  if (key === 'strava') return head + `## kind: \`strava-output\` — bring in Strava

\`\`\`
python ../tools/strava-export.py --context context.json --out inbox/
\`\`\`

(Stdlib only. First use needs \`python ../tools/strava-export.py --auth\` once, interactively — if it is not authorised, write the error file saying so.)

Every activity since \`lastActivityStart\` is pulled, all sports, plus streams for up to 40 activities per run (Strava rate-limits at ~100 requests / 15 min). The app links each Strava activity to the Garmin activity it duplicates (start within 10 min, distance within 15%) and inserts the rest — so you never need to dedupe yourself.

- A Strava connector (MCP) may be used instead of the script; write the same payload: \`{ "activities": [{ "id", "name", "sport_type", "start_date_local", "distance", "moving_time", "elapsed_time", "total_elevation_gain", "average_heartrate", "max_heartrate", "calories", "suffer_score", "gear_id", "trainer", "streams": { "time": [...], "distance": [...], "heartrate": [...], "latlng": [[lat, lon], ...], "altitude": [...], "cadence": [...] } }], "gear": [...] }\`.
`;
  if (key === 'analysis') return head + `## kind: \`analysis-output\` — answer the athlete's questions

\`\`\`json
{ "answers": [ { "id": "<request id from context.json>", "answer": "markdown" } ] }
\`\`\`

- Answer EVERY request in \`context.json\` → \`requests\`, matching each \`id\` exactly.
- Go as deep as the question deserves. The data is all here: \`../app-export.json\` (activities, laps, weather, gear, daily, wellness, Garmin's metrics, races, and \`derived\`: best efforts, interval reps, stops, durability per activity) and \`../data/streams/<activity id>.json\` (per-second channels: \`seconds\`, \`metres\`, \`hr\`, \`lat\`, \`lon\`, \`elevation_m\`, \`cadence_spm\`, \`power_w\`, \`stride_m\`, \`gct_ms\`, \`vertical_oscillation_cm\`, …). Compute with code rather than eyeballing JSON.
- Prefer the app's own numbers in \`../brief.json\` when a question touches them, so the answer agrees with what the athlete sees. Say when you disagree, and why.
- Cite dates, activities and numbers. Say plainly when the data cannot answer the question. No medical advice.
- The athlete's own context is in \`app-export.json\` too: \`journal\` (per activity: \`rpe\` 1–10, \`feel\` 1–5, \`note\`, \`tags\`; per day \`YYYY-MM-DD\`: \`tags\` like illness, travel, alcohol, stress, poor-sleep, and a \`note\`) and \`experiments\` (a declared change with \`start\`/\`end\`). Use them: they are the inputs a "what predicts a good run" question needs. A linked activity also carries \`strava\` (Strava's own numbers for the same session).
- **Draw what is better seen than read.** Put a chart in the answer as a fenced block the app renders (one y-axis per chart; at most 8 series, 3 for scatter; ISO dates for time):

\`\`\`\`
\`\`\`chart
{ "type": "line", "title": "Long-run decoupling", "x": { "label": "date", "type": "time" },
  "y": { "label": "drift", "unit": "%" }, "series": [ { "name": "long runs", "points": [["2026-09-01", 11.2], ["2026-09-08", 9.5]] } ],
  "note": "optional one line" }
\`\`\`
\`\`\`\`

  \`type\` is \`line\`, \`bar\` or \`scatter\`; \`x.type\` is \`time\`, \`linear\` or \`category\`. Two measures on different scales are two charts.
- **Standing questions** (\`standing: true\`) are asked again every week or so: \`previous\` holds your last answers. Say what changed since then, first, in a line; then the current answer.
`;
  if (key === 'pod') return head + `## kind: \`pod-output\` — the plan of the day

\`\`\`json
{ "date": "YYYY-MM-DD", "rationale": "why these, in two or three sentences",
  "plans": [ { "name": "Easy aerobic + strides", "sport": "running", "minutes": 50, "intensity": 2,
    "description": "markdown: the session, as you would say it to the athlete",
    "steps": [ { "minutes": 40, "target": "easy", "pace_s_per_km": [330, 370], "hr": [130, 145], "note": "conversational" },
               { "reps": 6, "minutes": 0.33, "target": "strides", "note": "20 s quick, full recovery" } ],
    "why": "one line tying it to the data" } ] }
\`\`\`

- Read \`context.json\`: today's readiness (HRV, resting HR, sleep, form), the week so far, the active training-block week if a race has a plan, the weather forecast, the athlete's options (\`availableMinutes\` {min,max}, \`sports\`, \`surfaces\`, \`niggles\`, \`notes\`), strength sessions from GymTracker if present, and \`recentOutcomes\` — what happened to the plans you wrote before (done / skipped / swapped, planned vs actual minutes and intensity).
- Offer 2–3 options spanning the available time, including one that uses most of the maximum. Adapt to the outcomes: stop prescribing what keeps being skipped, shorten what keeps running long.
- Targets come from the app's own training paces and HR zones in \`../brief.json\`. Respect niggles. Never prescribe through a readiness of "rest" without saying so plainly.
`;
  if (key === 'datareview') return head + `## kind: \`datareview-output\` — review the data the app flagged

\`\`\`json
{ "proposals": [ { "id": "<finding id>", "action": "fix" | "keep" | "ignore",
    "fix": { "...": "the corrected field(s), e.g. {\\"type\\": \\"cycling\\"} or {\\"distance_m\\": 10012}" },
    "reason": "one or two sentences, citing the evidence" } ] }
\`\`\`

- \`context.json\` → \`findings\`: each is something the app found suspicious — a GPS jump, a heart-rate dropout or a cadence lock, an activity type that does not fit its speed, an elevation spike, a Garmin/Strava near-miss pair dedup could not decide — with the evidence attached. Look at the stream (\`../data/streams/<id>.json\`) when it helps.
- A \`fix\` may set only \`type\`, \`name\`, \`distance_m\`, \`moving_s\`, \`elapsed_s\`, \`elev_gain_m\`, \`avg_hr\`, \`max_hr\` (each finding's \`fixable\` lists them); for a Garmin/Strava near-miss the fix is \`{"merge": true}\`.
- Propose \`fix\` only when the correction is clear; \`keep\` when the data is right after all; \`ignore\` when it is wrong but harmless. **Nothing is changed automatically** — the athlete approves each one, and approved fixes change Run315's copy only, never Garmin or Strava.
`;
  return head + `## kind: \`coach-output\` — the weekly review

\`\`\`json
{ "review": "markdown" }
\`\`\`

Read \`../BRIEF.md\` first. Sections: **Where the fitness is**, **What the projections mean**, **What to change in the next 4 weeks** (at most 4 actions, one line each, each with a number). Quantitative, specific, under 400 words. Say when the data is thin and what to run to fix it. No medical advice.
`;
}

const README = `# Run315 — AI cowork folder

A two-way bridge between the Run315 web app and an AI agent (any agent that can read and write files). Written by the app; do not edit by hand except to drop replies.

- \`cowork.json\` — the discovery manifest (\`cowork-manifest\` v1). CoworkSyncHub drives this folder from it.
- \`BRIEF.md\` + \`brief.json\` — **start here.** The app's own conclusions: fitness / fatigue / form, projections, best efforts, zones, durability, vitals trends, what data is missing.
- \`app-export.json\` — everything, raw: the synced state.
- \`data/streams/<id>.json\` — per-second channels for every activity that has them.
- \`tools/\` — \`garmin-export.py\`, \`strava-export.py\`: the fetchers the garmin and strava channels run.
- \`garmin/\`, \`strava/\`, \`analysis/\`, \`coach/\` — one task each: \`INSTRUCTIONS.md\` + \`context.json\`; reply into \`<channel>/inbox/\`.

## Two obligations
1. **Echo \`requestHash\`** from \`context.json\` into your reply envelope.
2. **Write a dead letter on failure**: \`<channel>/inbox/error-<ISO-date>.json\` with \`{ "reason": "why" }\`.
`;

export function manifest() {
  return { protocol: 'cowork-manifest', protocolVersion: 1, app: 'run315',
    channels: CHANNELS.map(c => ({ name: c.key, request: [c.key + '/context.json'], instructions: c.key + '/INSTRUCTIONS.md',
      replyDir: c.key + '/inbox', replyPrefix: 'output-', replyProtocol: PROTOCOL, replyKind: c.replyKind })) };
  // ponytail: no hub "sources" -- the hub's shared Garmin pull is GymTracker's biometrics-only
  // script; the garmin/strava channels run Run315's own exporters. Declare one if the hub grows
  // a full-history source.
}

// The exporters ship with the app (same origin), so the folder is self-contained.
async function toolSources() {
  const out = {};
  for (const f of ['garmin-export.py', 'garmin_fetch.py', 'strava-export.py']) {
    try { const r = await fetch(new URL('../tools/' + f, import.meta.url)); if (r.ok) out[f] = await r.text(); } catch { /* offline: keep what is there */ }
  }
  return out;
}

let _exporting = false;
export async function exportNow(auto = true) {
  if (_exporting) return false;
  _exporting = true;
  try {
    const r = await root(!auto);
    if (!r) { recordRun({ kind: 'push', ok: false, auto, note: 'skipped — no folder, or permission needs re-granting' }); return false; }
    await write(r, 'cowork.json', manifest());
    await write(r, 'README.md', README);
    const brief = buildBrief(state, new Date());
    await write(r, 'brief.json', envelope('brief', brief));
    await write(r, 'BRIEF.md', briefMarkdown(brief));
    await write(r, 'app-export.json', envelope('app-export', { ...state, local: undefined }));
    for (const [f, src] of Object.entries(await toolSources())) await write(r, 'tools/' + f, src);
    for (const c of CHANNELS) {
      const ctx = envelope(c.key + '-request', await channelContext(c.key));
      local().declared[c.key] = ctx.requestHash;
      await write(r, c.key + '/context.json', ctx);
      await write(r, c.key + '/INSTRUCTIONS.md', instructions(c.key));
      await dir(r, c.key + '/inbox');
    }
    const n = await writeStreams(r);
    recordRun({ kind: 'push', ok: true, auto, note: 'requests written' + (n ? ', ' + n + ' new streams' : '') });
    local().lastRuns.push = new Date().toISOString();
    return true;
  } catch (e) {
    recordRun({ kind: 'push', ok: false, auto, note: 'export failed: ' + (e.message || e) });
    return false;
  } finally { _exporting = false; }
}
// Each stream is written once; the ledger is how "once" survives a reload.
async function writeStreams(r) {
  const done = new Set(local().streamsWritten), ids = await streamIds();
  let n = 0;
  for (const id of ids) {
    if (done.has(id)) continue;
    const rec = await getStream(id);
    if (rec) await write(r, 'data/streams/' + id + '.json', rec.channels);
    done.add(id); n++;
  }
  local().streamsWritten = [...done];
  return n;
}

// ---- reading replies ----
export function parseEnvelope(text) {
  let o; try { o = JSON.parse(text); } catch { return { ok: false, reason: 'not JSON' }; }
  if (!o || typeof o !== 'object') return { ok: false, reason: 'not an object' };
  if (o.protocol && o.protocol !== PROTOCOL) return { ok: false, reason: 'protocol ' + o.protocol };
  if ((o.protocolVersion || 1) > VERSION) return { ok: false, reason: 'newer protocol version ' + o.protocolVersion };
  if (!o.kind || !o.payload) return { ok: false, reason: 'no kind/payload' };
  return { ok: true, kind: o.kind, payload: o.payload, requestHash: o.requestHash || null };
}

// Open questions, plus standing ones whose last answer is older than their cadence.
export function dueRequests(now = Date.now()) {
  return Object.values(state.analysisRequests).filter(r => {
    if (r.standing) return !r.answeredAt || now - Date.parse(r.answeredAt) >= (r.everyDays || 7) * 864e5;
    return r.status !== 'answered';
  }).map(r => ({ id: r.id, question: r.q, note: r.note || '', created: r.created, standing: !!r.standing,
    previous: r.standing ? (r.history || []).slice(-3) : undefined }));
}
// One answer onto its request: a standing question keeps its history and stays open.
export function applyAnswer(id, answer, via = 'cowork') {
  const rq = state.analysisRequests[id];
  if (!rq) return false;
  const at = new Date().toISOString();
  const history = rq.standing ? [...(rq.history || []), { at, answer: String(answer || '') }].slice(-52) : rq.history;
  put(state, 'analysisRequests', id, { ...rq, answer: String(answer || ''), status: rq.standing ? 'standing' : 'answered', answeredAt: at, via, history });
  return true;
}

async function applyReply(kind, p) {
  if (kind === 'garmin-output' || kind === 'strava-output') {
    const r = kind === 'garmin-output' ? await importGarmin(state, p, putStream) : await importStrava(state, p, putStream, hasStream);
    for (const id of r.streams) await queueStream(id);
    await deriveAll(state, r.streams);   // two passes: crossings need every run read first
    for (const id of r.streams) scanRecord(state, id, await getStream(id));   // data review: GPS jumps, HR dropouts...
    return { handled: true, note: kind === 'garmin-output'
      ? `${r.activities} activities, ${r.details} with detail, ${r.days} days, ${r.nights} nights` + (r.remaining ? `, ${r.remaining} still to fetch` : '')
      : `${r.activities} activities (${r.linked} linked to Garmin, ${r.inserted} new), ${r.streams.length} streams` + (r.remaining ? `, ${r.remaining} still to fetch` : '') };
  }
  if (kind === 'analysis-output') {
    let n = 0;
    for (const a of p.answers || []) if (a && applyAnswer(a.id, a.answer)) n++;
    return { handled: true, note: n + ' answered' };
  }
  if (kind === 'coach-output' && p.review) {
    const id = 'r' + Date.now();
    put(state, 'reviews', id, { id, created_at: new Date().toISOString(), markdown: String(p.review), source: 'cowork' });
    return { handled: true, note: 'review added' };
  }
  if (kind === 'pod-output') return importPod(state, p);
  if (kind === 'datareview-output') return importReview(state, p);
  return { handled: false, note: 'unknown kind ' + kind };
}

let _polling = false;
export async function pollAll(interactive = false) {
  if (_polling || !cfg().enabled) return 0;
  _polling = true;
  let imported = 0;
  try {
    const r = await root(interactive);
    if (!r) { recordRun({ kind: 'check', ok: false, auto: !interactive, note: 'skipped — no folder, or permission needs re-granting' }); return 0; }
    for (const c of CHANNELS) {
      const ch = await dir(r, c.key), inbox = await dir(ch, 'inbox');
      const files = [];
      for await (const [name, h] of inbox.entries()) if (h.kind === 'file' && /\.json$/i.test(name)) files.push([name, h]);
      files.sort((a, b) => a[0].localeCompare(b[0]));
      for (const [name, h] of files) {
        const text = await (await h.getFile()).text();
        const hash = hashText(text), led = (local().ledger[c.key] = local().ledger[c.key] || {});
        const done = async () => {
          const pd = await dir(ch, 'processed');
          const w = await (await pd.getFileHandle(name, { create: true })).createWritable(); await w.write(text); await w.close();
          await inbox.removeEntry(name);
        };
        if (led[hash]) { await done(); continue; }
        if (/^error-/i.test(name)) {
          let reason = 'no reason given'; try { reason = JSON.parse(text).reason || reason; } catch { /* keep default */ }
          recordRun({ kind: 'check', channel: c.key, ok: false, auto: !interactive, note: 'agent reported: ' + reason });
          led[hash] = { at: new Date().toISOString(), name, error: reason }; await done(); continue;
        }
        const env = parseEnvelope(text);
        if (!env.ok) {
          recordRun({ kind: 'check', channel: c.key, ok: false, auto: !interactive, note: `skipped ${name} — ${env.reason}` });
          led[hash] = { at: new Date().toISOString(), name, skipped: env.reason }; await done(); continue;
        }
        // An answer to a superseded request is still imported (usually still the answer you want) but noted.
        const stale = !!(env.requestHash && local().declared[c.key] && env.requestHash !== local().declared[c.key]);
        let res;
        try { res = await applyReply(env.kind, env.payload); } catch (e) { res = { handled: false, note: 'import failed: ' + (e.message || e) }; }
        led[hash] = { at: new Date().toISOString(), name, kind: env.kind, ok: res.handled };
        recordRun({ kind: 'check', channel: c.key, ok: res.handled, auto: !interactive, note: res.note + (stale ? ' (answered an older request)' : '') });
        await done();
        if (res.handled) imported++;
      }
    }
    local().lastRuns.check = new Date().toISOString();
    if (imported) { save('cowork-import'); await exportNow(true); }   // new data -> the next requests ask for the next gap
  } catch (e) {
    recordRun({ kind: 'check', ok: false, auto: !interactive, note: 'poll failed: ' + (e.message || e) });
  } finally { _polling = false; }
  return imported;
}

// ---- the schedule: one cheap tick a minute decides what is due ----
let _tick = null;
export function startScheduler() {
  if (!supported()) return;
  clearInterval(_tick);
  const due = (k, min) => !local().lastRuns[k] || Date.now() - new Date(local().lastRuns[k]) >= min * 60000;
  const tick = async () => {
    if (!cfg().enabled) return;
    const s = { ...SCHEDULE_DEFAULTS, ...(cfg().schedules || {}) };
    if (s.pushMin && due('push', s.pushMin)) await exportNow(true);
    if (s.checkMin && due('check', s.checkMin)) await pollAll(false);
  };
  _tick = setInterval(() => tick().catch(() => {}), 60000);
  tick().catch(() => {});
}

// ---- asking questions (the analysis channel's queue) ----
// opts.standing: re-answered every opts.everyDays (default 7) with the history kept, so a verdict can be watched move.
export function ask(q, note = '', opts = {}) {
  const id = 'q' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  put(state, 'analysisRequests', id, { id, q: String(q).trim(), note, created: new Date().toISOString(),
    status: opts.standing ? 'standing' : 'open', standing: !!opts.standing, everyDays: opts.everyDays || 7, history: [] });
  save('ask');
  return id;
}

// Status for the shared panel (cowork.js, data mode): one row per channel.
export function panelData() {
  const t = iso => (iso ? Date.parse(iso) / 1000 : 0), led = local().ledger, req = t(local().lastRuns.push);
  return {
    app: 'run315', folder: cfg().folderName || 'cowork folder',
    channels: CHANNELS.map(c => {
      const rep = Math.max(0, ...Object.values(led[c.key] || {}).map(e => t(e.at)));
      return { channel: c.key, request_mtime: req, reply_mtime: rep, pending: !!req && rep < req, answered: !!req && rep >= req };
    }),
    actions: [{ id: 'push', label: 'Send requests', primary: true }, { id: 'poll', label: 'Check for replies' }],
    channelActions: [],
  };
}
