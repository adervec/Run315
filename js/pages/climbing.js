// Hills, and what they cost: total ascent against landmarks, and whether you climb
// better or worse than Minetti's energy-cost model says you should.
import { state } from '../store.js';
import * as D from '../derive.js';
import { dayKey } from '../lib/dt.js';
import { html, pageHead, useCss } from '../ui.js';

export const title = 'Climbing';

const CSS = `
.landmark { font-family: var(--display); font-size: 34px; font-weight: 800;
  letter-spacing: -0.035em; line-height: 1.1; color: var(--measured); }
.rung { display: flex; align-items: baseline; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--line); }
.rung:last-child { border-bottom: 0; }
.rung b { font-weight: 600; }
.rung .h { font-family: var(--mono); font-size: 12px; color: var(--muted); margin-left: auto; }
.factor { font-family: var(--display); font-size: 30px; font-weight: 800; letter-spacing: -0.03em; }
.up { color: var(--ahead); } .down { color: var(--behind); }
@media (max-width: 520px) { .landmark { font-size: 26px; } }
`;

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const pct = f => { const v = (f - 1) * 100; return (v < 0 ? '−' : '+') + Math.abs(v).toFixed(0); };

export function render() {
  useCss('climbing', CSS);
  const climb = D.climbing(state);
  const p = climb.profile;
  return html`
    ${pageHead('Climbing', 'Hills, and what they cost you', html`<a class="btn btn-ghost" href="#/durability">Durability</a>`)}

    <section class="panel">
      <div class="panel-head"><p class="eyebrow">What you have climbed</p>
        <p class="panel-note">${climb.runs} runs · last ${climb.days} days</p></div>
      <div class="grid-2">
        <div>
          <div class="stat">
            <div class="stat-value">${Math.round(climb.ascent_m)}<small class="unit">m</small></div>
            <div class="stat-label">Total ascent</div>
          </div>
          ${climb.landmark ? html`<p class="landmark" style="margin-top:14px">${climb.landmark.phrase}</p>
            <p class="stat-hint">${cap(climb.landmark.name)} is ${climb.landmark.height_m} m, in ${climb.landmark.where}.</p>` : ''}
        </div>
        <div>
          ${climb.ladder.length ? html`<p class="eyebrow" style="margin-bottom:8px">Cleared</p>
            ${climb.ladder.map(r => html`<div class="rung"><b>${cap(r.name)}</b>
              <span class="dim">×${r.repeats.toFixed(1)}</span><span class="h">${r.height_m} m</span></div>`)}` : ''}
          ${climb.next_up ? html`<p class="stat-hint" style="margin-top:12px">
            ${Math.round(climb.next_up.to_go_m)} m more and you have climbed ${climb.next_up.name}.</p>` : ''}
        </div>
      </div>
    </section>

    ${p ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">How you climb</p>
        <p class="panel-note">${p.runs} hilly runs · ${p.climb_segments} climbing segments</p></div>
      <div class="grid-2">
        <div><div class="stat">
          <div class="stat-value factor ${p.factor > 1.05 ? 'up' : p.factor < 0.95 ? 'down' : ''}">${pct(p.factor)}<small class="unit">%</small></div>
          <div class="stat-label">Against the energy model</div>
        </div></div>
        <div><p class="verdict">${p.verdict}</p></div>
      </div>
      <p class="stat-hint" style="margin-top:12px">
        Measured inside each run: your speed on the flat sets the reference, and
        every climbing segment is compared against the speed Minetti's energy-cost
        model says the same effort should buy on that gradient. Because both halves
        come from the same run, fitness, weather and how hard you were trying all
        cancel — only the gradient is left.
      </p>
      <p class="stat-hint">
        This is the part grade-adjusted pace cannot tell you. GAP <em>applies</em>
        the model to flatten your splits; this <em>tests</em> it, which is why it can
        say whether hills are a strength.
      </p>
    </section>` : ''}

    ${climb.hilliest.length ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">Your hilliest runs</p><p class="panel-note">most climbing first</p></div>
      <div class="table-scroll"><table>
        <thead><tr><th>Run</th><th class="num">Distance</th><th class="num">Ascent</th>
          <th class="num">Per km</th><th>Ground</th><th class="num">On the climbs</th></tr></thead>
        <tbody>${climb.hilliest.map(h => html`<tr>
          <td><a class="quiet-link" href="#/activity/${h.id}">${h.name}</a>
            <br><span class="dim" style="font-family:var(--mono);font-size:12px">${dayKey(h.start)}</span></td>
          <td class="num dim">${((h.distance_m || 0) / 1000).toFixed(1)} km</td>
          <td class="num actual">${Math.round(h.ascent_m || 0)} m</td>
          <td class="num dim">${h.terrain ? Math.round(h.terrain.ascent_per_km) + ' m' : ''}</td>
          <td>${h.terrain ? cap(String(h.terrain.difficulty).toLowerCase()) : ''}</td>
          <td class="num"><span class="${h.factor > 1.05 ? 'ahead' : h.factor < 0.95 ? 'behind' : 'dim'}">${pct(h.factor)}%</span></td>
        </tr>`)}</tbody>
      </table></div>
      <p class="stat-hint" style="margin-top:12px">
        “Ground” is ascent per kilometre, the same scale hiking guides
        use. The last column is that run alone against the energy model, so it moves
        about far more than the average above — one run is a mood.
      </p>
    </section>` : ''}

    ${p ? '' : html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">Not enough hills yet</p></div>
      <div class="empty">
        <p>Judging how you climb needs runs with both flat and climbing in them, so
          there is something to compare against. A few rolling runs will do it
          — it does not need mountains.</p>
      </div>
    </section>`}`;
}
