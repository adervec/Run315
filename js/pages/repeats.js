// Routes you run again and again: spotted by the map tiles a run covers, with your
// times on each and whether you are getting quicker on the same ground.
import { state } from '../store.js';
import * as D from '../derive.js';
import { dayKey } from '../lib/dt.js';
import { html, pageHead, fmtPace, useCss } from '../ui.js';

export const title = 'My routes';

const CSS = `
.route-name { font-weight: 600; font-size: 16px; }
.route-sub { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.run-count { font-family: var(--display); font-size: 26px; font-weight: 800; letter-spacing: -0.03em; color: var(--measured); }
.spark { display: flex; gap: 2px; align-items: flex-end; height: 30px; }
.spark i { display: block; width: 4px; background: var(--measured); border-radius: 1px; min-height: 3px; }
.spark i.best { background: var(--ahead); }
`;

const ymd = d => (d ? dayKey(d) : '');

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
  const head = pageHead('My routes', 'Routes you run again and again', html`<a class="btn btn-ghost" href="#/routes">Plan a route</a>`);
  if (!routes.length) return html`${head}
    <section class="panel">
      <div class="panel-head"><p class="eyebrow">Nothing repeated yet</p></div>
      <div class="empty">
        <p>Run315 spots a route you have run before by comparing the map tiles a
          run covers — the same machinery the territory game uses. Once the
          same ground shows up three times, it appears here with your times on it.</p>
      </div>
      <a class="btn" href="#/sync">Go and sync</a>
    </section>`;

  return html`${head}
  <section class="panel">
    <div class="panel-head">
      <p class="eyebrow">Your routes</p>
      <p class="panel-note">${routes.length} run at least three times · last 12 months</p>
    </div>
    <div class="empty"><p>Same ground, same comparison. A route you run weekly is
      the most honest fitness test you have, because nothing about it changes
      except you.</p></div>
    <div class="table-scroll"><table>
      <thead><tr><th>Route</th><th class="num">Runs</th><th class="num">Best</th>
        <th class="num">Latest</th><th class="num">Trend</th><th>Times</th></tr></thead>
      <tbody>${routes.map(r => {
        const p = r.progression || {};
        return html`<tr>
        <td>
          <span class="route-name">${r.name}</span>
          <br><span class="route-sub">${((r.distance_m || 0) / 1000).toFixed(2)} km · ${ymd(p.first)} → ${ymd(p.last)}</span>
        </td>
        <td class="num"><span class="run-count">${r.count}</span></td>
        <td class="num actual">${p.best_pace ? html`${fmtPace(p.best_pace, 1000)}<br><span class="route-sub">${ymd(p.best_at)}</span>` : '—'}</td>
        <td class="num dim">${p.latest_pace ? fmtPace(p.latest_pace, 1000) : '—'}</td>
        <td class="num">${p.change != null
          ? html`<span class="${p.change < -0.005 ? 'ahead' : p.change > 0.005 ? 'behind' : 'dim'}">${(p.change >= 0 ? '+' : '') + (p.change * 100).toFixed(1)}%</span>`
          : html`<span class="dim">—</span>`}</td>
        <td>${spark(r.runs || [])}</td>
      </tr>`; })}</tbody>
    </table></div>
    <p class="stat-hint" style="margin-top:12px">
      Taller bar is quicker; green is your best on that route. Trend compares the
      first half of your runs on it with the second, so a route you only ever jog
      will read flat — which is the honest answer.
    </p>
  </section>

  ${routes.slice(0, 6).filter(r => r.progression?.verdict).map(r => html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">${r.name}</p>
      <p class="panel-note">${r.shape} · ${r.count} runs over ${r.progression.days} days</p>
    </div>
    <p class="verdict">${r.progression.verdict}</p>
    ${r.progression.off_best ? html`<p class="stat-hint">Your most recent effort was
      ${(r.progression.off_best * 100).toFixed(1)}% off your best on it.</p>` : ''}
  </section>`)}`;
}
