// Routes you run again and again: spotted by the map tiles a run covers, with your
// times on each and whether you are getting quicker on the same ground.
import { state } from '../store.js';
import * as D from '../derive.js';
import { dayKey } from '../lib/dt.js';
import { IMPROVEMENT } from '../lib/repeats.js';
import { fmt } from '../i18n.js';
import { html, pageHead, fmtPace, useCss, day, t } from '../ui.js';

export const title = 'My routes';

const CSS = `
.route-name { font-weight: 600; font-size: 16px; }
.route-sub { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.run-count { font-family: var(--display); font-size: 26px; font-weight: 800; letter-spacing: -0.03em; color: var(--measured); }
.spark { display: flex; gap: 2px; align-items: flex-end; height: 30px; }
.spark i { display: block; width: 4px; background: var(--measured); border-radius: 1px; min-height: 3px; }
.spark i.best { background: var(--ahead); }
`;

const ymd = d => (d ? day(dayKey(d), true) : '');
// A one-decimal number the reader's way (12.3 / 12,3).
const n1 = v => (fmt() ? fmt().number(v, { min: 1, max: 1 }) : v.toFixed(1));

// lib/repeats.js names a route, gives its shape and its verdict in English (they are data, and
// the brief reads them); the page re-words them from the numbers it keeps beside them.
// i18n-keys: loop | out and back | route
export function routeName(r) {
  if (!r.distance_m) return t('Unnamed route');
  const km = n1(r.distance_m / 1000);
  return r.shape === 'loop' ? t('{km} km loop', { km }) : r.shape === 'out and back' ? t('{km} km out and back', { km }) : t('{km} km route', { km });
}
function verdict(p) {
  const timed = p.timed || 0, change = p.change ?? null, offBest = p.off_best ?? null;
  if (!timed) return t('Never timed this route.');
  if (change === null) return t('Only one timed run on this route -- nothing to compare it to yet.');
  if (change <= -IMPROVEMENT) return t.n('{pct}% quicker over {n} run on the same ground.', '{pct}% quicker over {n} runs on the same ground.', timed, { pct: n1(-change * 100) });
  if (change >= IMPROVEMENT) return t('{pct}% slower here than when you started running it.', { pct: n1(change * 100) });
  if (offBest !== null && offBest < 0.005) return t.n('Level across {n} run, but the last one was your best.', 'Level across {n} runs, but the last one was your best.', timed);
  return t.n('Level across {n} run -- this route is not testing you.', 'Level across {n} runs -- this route is not testing you.', timed);
}

// Taller bar is quicker; the best (within 2% of the span) is green. Last 40 runs.
function spark(runs) {
  const paces = runs.filter(r => r.moving_s && r.distance_m).map(r => r.moving_s / (r.distance_m / 1000));
  if (paces.length < 2) return '';
  const slow = Math.max(...paces), fast = Math.min(...paces), span = slow - fast;
  return html`<span class="spark">${paces.slice(-40).map(p => html`<i class="${span > 1 && p <= fast + span * 0.02 ? 'best' : ''}"
    style="height:${Math.round(6 + 22 * (span > 1 ? (slow - p) / span : 0.5))}px" title="${fmtPace(p, 1000)}"></i>`)}</span>`;
}

export function render() {
  useCss('repeats', CSS);
  const routes = D.repeatedRoutes(state) || [];
  const head = pageHead(t('My routes'), t('Routes you run again and again'), html`<a class="btn btn-ghost" href="#/routes">${t('Plan a route')}</a>`);
  if (!routes.length) return html`${head}
    <section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('Nothing repeated yet')}</p></div>
      <div class="empty">
        <p>${t('Run315 spots a route you have run before by comparing the map tiles a run covers — the same machinery the territory game uses. Once the same ground shows up three times, it appears here with your times on it.')}</p>
      </div>
      <a class="btn" href="#/sync">${t('Go and sync')}</a>
    </section>`;

  return html`${head}
  <section class="panel">
    <div class="panel-head">
      <p class="eyebrow">${t('Your routes')}</p>
      <p class="panel-note">${t.n('{n} route run at least three times · last 12 months', '{n} routes run at least three times · last 12 months', routes.length)}</p>
    </div>
    <div class="empty"><p>${t('Same ground, same comparison. A route you run weekly is the most honest fitness test you have, because nothing about it changes except you.')}</p></div>
    <div class="table-scroll"><table>
      <thead><tr><th>${t('Route')}</th><th class="num">${t('Runs')}</th><th class="num">${t('Best')}</th>
        <th class="num">${t('Latest')}</th><th class="num">${t('Trend')}</th><th>${t('Times')}</th></tr></thead>
      <tbody>${routes.map(r => {
        const p = r.progression || {};
        return html`<tr>
        <td>
          <span class="route-name">${routeName(r)}</span>
          <br><span class="route-sub">${fmt() ? fmt().number((r.distance_m || 0) / 1000, { min: 2, max: 2 }) : ((r.distance_m || 0) / 1000).toFixed(2)} km · ${ymd(p.first)} → ${ymd(p.last)}</span>
        </td>
        <td class="num"><span class="run-count">${r.count}</span></td>
        <td class="num actual">${p.best_pace ? html`${fmtPace(p.best_pace, 1000)}<br><span class="route-sub">${ymd(p.best_at)}</span>` : '—'}</td>
        <td class="num dim">${p.latest_pace ? fmtPace(p.latest_pace, 1000) : '—'}</td>
        <td class="num">${p.change != null
          ? html`<span class="${p.change < -0.005 ? 'ahead' : p.change > 0.005 ? 'behind' : 'dim'}">${(p.change >= 0 ? '+' : '−') + n1(Math.abs(p.change * 100))}%</span>`
          : html`<span class="dim">—</span>`}</td>
        <td>${spark(r.runs || [])}</td>
      </tr>`; })}</tbody>
    </table></div>
    <p class="stat-hint" style="margin-top:12px">${t('Taller bar is quicker; green is your best on that route. Trend compares the first half of your runs on it with the second, so a route you only ever jog will read flat — which is the honest answer.')}</p>
  </section>

  ${routes.slice(0, 6).filter(r => r.progression?.verdict).map(r => html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">${routeName(r)}</p>
      <p class="panel-note">${t(r.shape)} · ${t.n('{n} run over {days} days', '{n} runs over {days} days', r.count, { days: r.progression.days })}</p>
    </div>
    <p class="verdict">${verdict(r.progression)}</p>
    ${r.progression.off_best ? html`<p class="stat-hint">${t('Your most recent effort was {pct}% off your best on it.', { pct: n1(r.progression.off_best * 100) })}</p>` : ''}
  </section>`)}`;
}
