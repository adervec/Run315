// Track and interval sessions, found by reading the pace inside each run (not lap
// presses): the interval band right now, progression at each rep distance, every
// session, and the interruptions the same pass classified.
import { state, save, streamIds } from '../store.js';
import * as D from '../derive.js';
import { html, pageHead, fmtTime, fmtPace, toast, useCss } from '../ui.js';

export const title = 'Track & intervals';

const CSS = `
.rep-spark { display: flex; gap: 2px; align-items: flex-end; height: 26px; }
.rep-spark i { display: block; width: 5px; background: var(--measured); border-radius: 1px; min-height: 3px; }
.rep-spark i.slow { background: var(--behind); }
.prog-row { border-top: 1px solid var(--line); padding: 16px 0; }
.prog-row:first-child { border-top: none; }
.prog-head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
.prog-dist { font-family: var(--display); font-size: 24px; font-weight: 800; letter-spacing: -0.03em; }
.prog-bars { display: flex; gap: 4px; align-items: flex-end; height: 54px; margin-top: 10px; overflow-x: auto; }
.prog-bars span { display: block; flex: 0 0 22px; background: var(--measured-soft);
  border-bottom: 3px solid var(--measured); position: relative; border-radius: 2px 2px 0 0; }
.prog-bars span.best { border-bottom-color: var(--ahead); background: color-mix(in srgb, var(--ahead) 18%, var(--surface)); }
`;

const sgn = (v, d = 0) => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(d);

// Every stored session, newest first -- load_sessions, from state.derived. `snapped_m`
// is set only for a uniform set, as the track_sessions column was.
function loadSessions(limit = 200) {
  const out = [];
  for (const a of D.runs(state)) {
    const s = state.derived[a.id]?.session;
    const paces = s && (s.paces || (s.reps || []).map(r => r.pace));
    if (!paces || !paces.length) continue;
    out.push({ ...s, id: a.id, start: a.start.toISOString(), day: state.activities[a.id].start.slice(0, 10),
      paces, snapped_m: s.snapped_m ?? (s.uniform && s.reps ? s.reps[0].snapped_m : null) });
    if (out.length >= limit) break;
  }
  return out;
}

// Group uniform sessions by rep distance so progress is visible.
// -> [{distance_m, sessions oldest first, ...}], most-run distance first.
function sessionProgression(sessions) {
  const byDist = new Map();
  for (const s of sessions) if (s.snapped_m) {
    const k = Math.trunc(s.snapped_m);
    if (!byDist.has(k)) byDist.set(k, []);
    byDist.get(k).push(s);
  }
  const out = [];
  for (const [dist, g] of byDist) {
    const group = [...g].sort((a, b) => a.start.localeCompare(b.start));
    const best = group.reduce((m, s) => ((s.avg_pace || 1e9) < (m.avg_pace || 1e9) ? s : m));
    out.push({ distance_m: dist, sessions: group, count: group.length, best_pace: best.avg_pace, best_on: best.day,
      latest_pace: group[group.length - 1].avg_pace,
      trend: group.length > 1 && group[0].avg_pace ? group[group.length - 1].avg_pace - group[0].avg_pace : null });
  }
  return out.sort((a, b) => b.count - a.count || a.distance_m - b.distance_m);
}

export function render() {
  useCss('sessions', CSS);
  const sessions = loadSessions();
  const summary = D.summary(state);
  let prescribed = null;
  if (summary) for (const [name, , fast, slow] of summary.paces) if (name === 'Interval') prescribed = [fast, slow];
  const progression = sessionProgression(sessions);
  const stops = D.stopTotals(state);
  const head = pageHead('Track & intervals', `Track & interval sessions · ${sessions.length} found`,
    html`<button class="btn btn-ghost" data-rescan="sessions">Re-read every run</button>`);

  if (!sessions.length) return html`${head}
    <section class="panel">
      <div class="panel-head"><p class="eyebrow">No sessions yet</p></div>
      <div class="empty">
        <p>Run315 finds interval work by reading the pace inside each run — it does
          not need you to have pressed the lap button. A run counts as a session when
          its pace is genuinely two-gear: hard bits at least 25 s/km quicker than the
          jog between them.</p>
        <p>Sync and analyse some runs, then come back.</p>
      </div>
      <a class="btn" href="#/sync">Go and sync</a>
    </section>
    ${stops ? stopsPanel(stops) : ''}`;

  return html`${head}
    ${prescribed ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">Your interval pace right now</p>
        <p class="panel-note">From the fitted curve, not a lookup table</p></div>
      <div class="empty"><p>Reps should be landing between
        <b>${fmtTime(prescribed[0])}</b> and <b>${fmtPace(prescribed[1], 1000)}</b>.
        Sessions below are marked against that.</p></div>
    </section>` : ''}

    ${progression.length ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">Progression</p><p class="panel-note">Same rep distance, over time</p></div>
      ${progression.map(g => {
        const paces = g.sessions.map(s => s.avg_pace), slowest = Math.max(...paces), fastest = Math.min(...paces), span = slowest - fastest;
        return html`<div class="prog-row">
          <div class="prog-head">
            <span class="prog-dist">${g.distance_m} m</span>
            <span class="stat-label" style="margin:0">${g.count} session${g.count !== 1 ? 's' : ''}</span>
            <span class="stat-hint" style="margin:0">best ${fmtPace(g.best_pace, 1000)} on ${g.best_on}${g.trend
              ? html` · <span class="${g.trend < 0 ? 'ahead' : 'behind'}">${sgn(g.trend)} s/km since the first</span>` : ''}</span>
          </div>
          <div class="prog-bars">${g.sessions.map(s => html`<span class="${s.avg_pace === fastest ? 'best' : ''}"
            style="height:${(18 + 34 * (span > 0.5 ? (slowest - s.avg_pace) / span : 0.5)).toFixed(0)}px"
            title="${s.day} — ${s.name} at ${fmtPace(s.avg_pace, 1000)}"></span>`)}</div>
        </div>`;
      })}
    </section>` : ''}

    <section class="panel">
      <div class="panel-head"><p class="eyebrow">Every session</p><p class="panel-note">Newest first</p></div>
      <div class="table-scroll"><table>
        <thead><tr><th>Date</th><th>Session</th><th class="num">Avg rep</th><th class="num">Spread</th>
          <th class="num">Fade</th><th class="num">Recovery</th><th>Reps</th></tr></thead>
        <tbody>${sessions.map(s => {
          const paces = s.paces, slow = Math.max(...paces), fast = Math.min(...paces), span = slow - fast;
          return html`<tr>
            <td class="dim">${s.day}</td>
            <td><a class="quiet-link" href="#/activity/${s.id}">${s.name}</a>${s.on_track ? html` <span class="badge-track">TRACK</span>` : ''}</td>
            <td class="num actual">${fmtPace(s.avg_pace, 1000)}</td>
            <td class="num dim">${s.consistency != null ? '±' + (s.consistency * 100).toFixed(1) + '%' : '—'}</td>
            <td class="num">${s.fade != null
              ? html`<span class="${s.fade > 0.02 ? 'behind' : s.fade < -0.02 ? 'ahead' : 'dim'}">${sgn(s.fade * 100, 1)}%</span>`
              : html`<span class="dim">—</span>`}</td>
            <td class="num dim">${s.avg_recovery_s ? fmtTime(s.avg_recovery_s) : '—'}</td>
            <td><span class="rep-spark">${s.paces.map((pace, i) => html`<i class="${span > 1 && pace > fast + span * 0.75 ? 'slow' : ''}"
              style="height:${(8 + 18 * (span > 1 ? (slow - pace) / span : 0.5)).toFixed(0)}px"
              title="Rep ${i + 1}: ${fmtPace(pace, 1000)}"></i>`)}</span></td>
          </tr>`;
        })}</tbody>
      </table></div>
      <p class="stat-hint" style="margin-top:12px">
        Spread is how even the reps were — 0% is metronomic. Fade compares the
        second half of the set with the first; negative means you finished faster
        than you started.
      </p>
    </section>

    ${stops ? stopsPanel(stops) : ''}`;
}

// stop_totals: the same pass that finds reps classifies every interruption.
function stopsPanel(t) {
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Why you stopped</p>
      <p class="panel-note">last ${t.days} days · ${t.runs} run${t.runs !== 1 ? 's' : ''} with interruptions</p></div>
    <div class="break-counts">
      ${[['crossings', 'Crossings', 'k-crossing'], ['rests', 'Rest stops', 'k-rest'], ['climbs', 'Climbs', 'k-climb'],
        ['exhaustion', 'Fatigue', 'k-exhaustion'], ['eased', 'Eased off', 'k-eased']]
        .filter(([k]) => t[k]).map(([k, label, cls]) => html`<span class="break-chip ${cls}">${t[k]} ${label}</span>`)}
    </div>
    <p class="stat-hint" style="margin-top:12px">${fmtTime(t.lost_s)} not running, ${fmtTime(t.stopped_s)} of it standing still.
      ${t.fatigue_runs ? html`<span class="behind">${t.fatigue_runs} run${t.fatigue_runs !== 1 ? 's' : ''}</span> had a fatigue break.` : 'No fatigue breaks.'}
      A place you stop on three separate runs is read as a crossing, not as you.</p>
    <p><button class="btn btn-ghost" data-rescan="stops">Re-read stops</button></p>
  </section>`;
}

// Re-read every stream on this device: sessions, stops and the rest of the derived
// results, in deriveAll's two passes (crossings need every run read first).
async function rescan(btn, what) {
  const ids = await streamIds();
  if (!ids.length) { toast('No streams on this device. Re-read on the computer that imports from Garmin and Strava.'); return; }
  const label = btn.textContent;
  document.querySelectorAll('[data-rescan]').forEach(b => { b.disabled = true; });
  try {
    await D.deriveAll(state, ids, (n, total) => { btn.textContent = `Reading ${Math.round(100 * n / total)}%`; });
    save('derive');
    if (what === 'stops') {
      const found = Object.values(state.derived).filter(d => d.stops).length, j = D.junctions(state).length;
      toast(`Re-read every run: ${found} had interruptions, ${j} recurring stop point${j === 1 ? '' : 's'} recognised as junctions.`, 5000);
    } else {
      const found = Object.values(state.derived).filter(d => d.session).length;
      toast(`Re-read every run: ${found} interval session${found === 1 ? '' : 's'} found.`, 5000);
    }
  } catch (e) {
    console.error(e); toast('Re-reading failed: ' + (e.message || e));
  } finally {
    btn.textContent = label;
    document.querySelectorAll('[data-rescan]').forEach(b => { b.disabled = false; });
  }
}

export function mount(el) {
  el.querySelectorAll('[data-rescan]').forEach(b => { b.onclick = () => rescan(b, b.dataset.rescan); });
}
