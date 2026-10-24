// Every achievement the data holds, newest first: best efforts with the record they
// beat, long runs, week streaks, career distance, territory, finished trails, races
// that beat their projection, and readiness trends. Read out of the state by
// js/events.js -- nothing is recorded when it happens, so a run synced from another
// device, or a trail finished by a re-match, appears here the same way.
import { state, rev } from '../store.js';
import * as D from '../derive.js';
import * as E from '../events.js';
import { html, pageHead, emptyState, useCss } from '../ui.js';
import { eventList } from './today.js';

export const title = 'Achievements';

const CSS = `
.ach-kinds { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 14px; }
.ach-kinds button { font: 12px var(--body); padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface); color: var(--muted); cursor: pointer; }
.ach-kinds button[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); border-color: var(--ink); }
.ach-month { margin-top: 18px; }
`;

const GROUPS = [['', 'All'], ['best', 'Best efforts'], ['longest', 'Long runs'], ['streak', 'Streaks'], ['career', 'Career'],
  ['tiles square', 'Territory'], ['trail', 'Trails'], ['race', 'Races'], ['trend', 'Readiness']];
let _kind = '';

function feed(events) {
  const want = _kind ? new Set(_kind.split(' ')) : null, shown = want ? events.filter(e => want.has(e.kind)) : events;
  if (!shown.length) return html`<p class="stat-hint">Nothing of that kind yet.</p>`;
  const months = new Map();
  for (const e of shown) { const m = String(e.at).slice(0, 7); if (!months.has(m)) months.set(m, []); months.get(m).push(e); }
  return html`${[...months].map(([m, evs]) => {
    const [y, mo] = m.split('-').map(Number);
    return html`<div class="ach-month"><p class="eyebrow">${new Date(y, mo - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })} · ${evs.length}</p>${eventList(evs)}</div>`;
  })}`;
}

export function render() {
  useCss('achievements', CSS);
  const events = E.cachedEvents(state, D, rev);
  if (!events.length) return html`${pageHead('Achievements')}
    ${emptyState('Nothing yet', 'Records, long runs, streaks and milestones show up here as your history builds. A best effort only counts once there are three earlier efforts at that distance to beat, so the first weeks are quiet on purpose.',
      html`<a class="btn btn-ghost" href="#/">Today</a>`)}`;
  return html`${pageHead('Achievements', `${events.length} from your own history`)}
    <section class="panel ach-page">
      <div class="ach-kinds" role="group" aria-label="Kind">${GROUPS.map(([k, l]) => html`<button type="button" data-kind="${k}" aria-pressed="${String(k === _kind)}">${l}</button>`)}</div>
      <div class="ach-feed">${feed(events)}</div>
      <p class="stat-hint" style="margin-top:16px">Deliberately stingy: a best needs three earlier efforts at that distance to beat,
        a long run six weeks since anything as long, and a readiness trend a week of nights (the median, so one bad night moves
        nothing) a standard deviation away from three or more weeks before it, holding for three days. Trends describe the
        numbers; they do not say why.</p>
    </section>`;
}

export function mount(el) {
  const root = el.querySelector('.ach-page');
  if (!root) return;
  root.querySelectorAll('[data-kind]').forEach(b => {
    b.onclick = () => {
      _kind = b.dataset.kind;
      root.querySelectorAll('[data-kind]').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.kind === _kind)));
      root.querySelector('.ach-feed').innerHTML = String(feed(E.cachedEvents(state, D, rev)));
    };
  });
}
