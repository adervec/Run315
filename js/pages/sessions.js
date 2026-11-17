// Track and interval sessions, found by reading the pace inside each run (not lap
// presses): the interval band right now, progression at each rep distance, every
// session, and the interruptions the same pass classified.
import { state, save, streamIds } from '../store.js';
import * as D from '../derive.js';
import { html, raw, esc, t, pageHead, fmtTime, fmtPace, day, toast, useCss } from '../ui.js';

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
  const head = pageHead(t('Track & intervals'), t.n('Track & interval sessions · {n} found', 'Track & interval sessions · {n} found', sessions.length),
    html`<button class="btn btn-ghost" data-rescan="sessions">${t('Re-read every run')}</button>`);

  if (!sessions.length) return html`${head}
    <section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('No sessions yet')}</p></div>
      <div class="empty">
        <p>${t('Run315 finds interval work by reading the pace inside each run — it does not need you to have pressed the lap button. A run counts as a session when its pace is genuinely two-gear: hard bits at least 25 s/km quicker than the jog between them.')}</p>
        <p>${t('Sync and analyse some runs, then come back.')}</p>
      </div>
      <a class="btn" href="#/sync">${t('Go and sync')}</a>
    </section>
    ${stops ? stopsPanel(stops) : ''}`;

  return html`${head}
    ${prescribed ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('Your interval pace right now')}</p>
        <p class="panel-note">${t('From the fitted curve, not a lookup table')}</p></div>
      <div class="empty"><p>${raw(esc(t('Reps should be landing between {fast} and {slow}. Sessions below are marked against that.', { fast: '\u0001', slow: '\u0002' }))
        .replace('\u0001', '<b>' + esc(fmtTime(prescribed[0])) + '</b>').replace('\u0002', '<b>' + esc(fmtPace(prescribed[1], 1000)) + '</b>'))}</p></div>
    </section>` : ''}

    ${progression.length ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('Progression')}</p><p class="panel-note">${t('Same rep distance, over time')}</p></div>
      ${progression.map(g => {
        const paces = g.sessions.map(s => s.avg_pace), slowest = Math.max(...paces), fastest = Math.min(...paces), span = slowest - fastest;
        return html`<div class="prog-row">
          <div class="prog-head">
            <span class="prog-dist">${g.distance_m} m</span>
            <span class="stat-label" style="margin:0">${t.n('{n} session', '{n} sessions', g.count)}</span>
            <span class="stat-hint" style="margin:0">${t('best {pace} on {day}', { pace: fmtPace(g.best_pace, 1000), day: day(g.best_on, true) })}${g.trend
              ? html` · <span class="${g.trend < 0 ? 'ahead' : 'behind'}">${t('{n} s/km since the first', { n: sgn(g.trend) })}</span>` : ''}</span>
          </div>
          <div class="prog-bars">${g.sessions.map(s => html`<span class="${s.avg_pace === fastest ? 'best' : ''}"
            style="height:${(18 + 34 * (span > 0.5 ? (slowest - s.avg_pace) / span : 0.5)).toFixed(0)}px"
            title="${t('{day} — {name} at {pace}', { day: day(s.day, true), name: s.name, pace: fmtPace(s.avg_pace, 1000) })}"></span>`)}</div>
        </div>`;
      })}
    </section>` : ''}

    <section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('Every session')}</p><p class="panel-note">${t('Newest first')}</p></div>
      <div class="table-scroll"><table>
        <thead><tr><th>${t('Date')}</th><th>${t('Session')}</th><th class="num">${t('Avg rep')}</th><th class="num">${t('Spread')}</th>
          <th class="num">${t('Fade')}</th><th class="num">${t('Recovery')}</th><th>${t('Reps')}</th></tr></thead>
        <tbody>${sessions.map(s => {
          const paces = s.paces, slow = Math.max(...paces), fast = Math.min(...paces), span = slow - fast;
          return html`<tr>
            <td class="dim">${day(s.day, true)}</td>
            <td><a class="quiet-link" href="#/activity/${s.id}">${s.name}</a>${s.on_track ? html` <span class="badge-track">${t('TRACK')}</span>` : ''}</td>
            <td class="num actual">${fmtPace(s.avg_pace, 1000)}</td>
            <td class="num dim">${s.consistency != null ? '±' + (s.consistency * 100).toFixed(1) + '%' : '—'}</td>
            <td class="num">${s.fade != null
              ? html`<span class="${s.fade > 0.02 ? 'behind' : s.fade < -0.02 ? 'ahead' : 'dim'}">${sgn(s.fade * 100, 1)}%</span>`
              : html`<span class="dim">—</span>`}</td>
            <td class="num dim">${s.avg_recovery_s ? fmtTime(s.avg_recovery_s) : '—'}</td>
            <td><span class="rep-spark">${s.paces.map((pace, i) => html`<i class="${span > 1 && pace > fast + span * 0.75 ? 'slow' : ''}"
              style="height:${(8 + 18 * (span > 1 ? (slow - pace) / span : 0.5)).toFixed(0)}px"
              title="${t('Rep {n}: {pace}', { n: i + 1, pace: fmtPace(pace, 1000) })}"></i>`)}</span></td>
          </tr>`;
        })}</tbody>
      </table></div>
      <p class="stat-hint" style="margin-top:12px">${t('Spread is how even the reps were — 0% is metronomic. Fade compares the second half of the set with the first; negative means you finished faster than you started.')}</p>
    </section>

    ${stops ? stopsPanel(stops) : ''}`;
}

// stop_totals: the same pass that finds reps classifies every interruption.
// i18n-keys: Crossings | Rest stops | Climbs | Fatigue | Eased off
function stopsPanel(st) {
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${t('Why you stopped')}</p>
      <p class="panel-note">${t('last {days} days', { days: st.days })} · ${t.n('{n} run with interruptions', '{n} runs with interruptions', st.runs)}</p></div>
    <div class="break-counts">
      ${[['crossings', 'Crossings', 'k-crossing'], ['rests', 'Rest stops', 'k-rest'], ['climbs', 'Climbs', 'k-climb'],
        ['exhaustion', 'Fatigue', 'k-exhaustion'], ['eased', 'Eased off', 'k-eased']]
        .filter(([k]) => st[k]).map(([k, label, cls]) => html`<span class="break-chip ${cls}">${st[k]} ${t(label)}</span>`)}
    </div>
    <p class="stat-hint" style="margin-top:12px">${t('{lost} not running, {stopped} of it standing still.', { lost: fmtTime(st.lost_s), stopped: fmtTime(st.stopped_s) })}
      ${st.fatigue_runs ? raw(esc(t('{runs} had a fatigue break.', { runs: '\u0001' }))
        .replace('\u0001', '<span class="behind">' + esc(t.n('{n} run', '{n} runs', st.fatigue_runs)) + '</span>')) : t('No fatigue breaks.')}
      ${t('A place you stop on three separate runs is read as a crossing, not as you.')}</p>
    <p><button class="btn btn-ghost" data-rescan="stops">${t('Re-read stops')}</button></p>
  </section>`;
}

// Re-read every stream on this device: sessions, stops and the rest of the derived
// results, in deriveAll's two passes (crossings need every run read first).
async function rescan(btn, what) {
  const ids = await streamIds();
  if (!ids.length) { toast(t('No streams on this device. Re-read on the computer that imports from Garmin and Strava.')); return; }
  const label = btn.textContent;
  document.querySelectorAll('[data-rescan]').forEach(b => { b.disabled = true; });
  try {
    await D.deriveAll(state, ids, (n, total) => { btn.textContent = t('Reading {pct}%', { pct: Math.round(100 * n / total) }); });
    save('derive');
    if (what === 'stops') {
      const found = Object.values(state.derived).filter(d => d.stops).length, j = D.junctions(state).length;
      toast(t.n('Re-read every run: {found} had interruptions, {n} recurring stop point recognised as a junction.',
        'Re-read every run: {found} had interruptions, {n} recurring stop points recognised as junctions.', j, { found }), 5000);
    } else {
      const found = Object.values(state.derived).filter(d => d.session).length;
      toast(t.n('Re-read every run: {n} interval session found.', 'Re-read every run: {n} interval sessions found.', found), 5000);
    }
  } catch (e) {
    console.error(e); toast(t('Re-reading failed: {error}', { error: e.message || e }));
  } finally {
    btn.textContent = label;
    document.querySelectorAll('[data-rescan]').forEach(b => { b.disabled = false; });
  }
}

export function mount(el) {
  el.querySelectorAll('[data-rescan]').forEach(b => { b.onclick = () => rescan(b, b.dataset.rescan); });
}
