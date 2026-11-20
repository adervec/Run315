// Hills, and what they cost: total ascent against landmarks, and whether you climb
// better or worse than Minetti's energy-cost model says you should.
import { state } from '../store.js';
import * as D from '../derive.js';
import { dayKey } from '../lib/dt.js';
import * as TE from '../lib/terrain.js';
import * as LM from '../lib/landmarks.js';
import { html, pageHead, day, useCss, t } from '../ui.js';
import { fmt } from '../i18n.js';

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
const num = (v, dp) => (fmt() ? fmt().number(v, { min: dp, max: dp }) : v.toFixed(dp));
// The landmark phrase, worded on the page: lib/landmarks.js builds an English one for the brief.
// The landmark's own name stays English (catalogue content); the sentence around it is t().
// How hilly the ground is: terrain.js's word is a key.
// i18n-keys: Flat | Rolling | Hilly | Steep | Mountainous
const GROUND = { flat: 'Flat', rolling: 'Rolling', hilly: 'Hilly', steep: 'Steep', mountainous: 'Mountainous' };
const ground = d => { const k = String(d).toLowerCase(); return GROUND[k] ? t(GROUND[k]) : cap(k); };
function phrase(l) {
  const r = l.repeats, names = LM._plural(l.name);
  if (r < 1.1) return l.name.startsWith('the ') ? l.name : cap(l.name);
  if (r < 1.6) return t('one and a half {names}', { names });
  if (r < 2.0) return t('nearly two {names}', { names });
  return t('{n} {names}', { n: r < LM.MAX_REPEATS ? num(r, 1) : num(r, 0), names });
}

export function render() {
  useCss('climbing', CSS);
  const climb = D.climbing(state);
  const p = climb.profile;
  return html`
    ${pageHead(t('Climbing'), t('Hills, and what they cost you'), html`<a class="btn btn-ghost" href="#/durability">${t('Durability')}</a>`)}

    <section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('What you have climbed')}</p>
        <p class="panel-note">${t.n('{n} run · last {days} days', '{n} runs · last {days} days', climb.runs, { days: climb.days })}</p></div>
      <div class="grid-2">
        <div>
          <div class="stat">
            <div class="stat-value">${Math.round(climb.ascent_m)}<small class="unit">m</small></div>
            <div class="stat-label">${t('Total ascent')}</div>
          </div>
          ${climb.landmark ? html`<p class="landmark" style="margin-top:14px">${phrase(climb.landmark)}</p>
            <p class="stat-hint">${t('{name} is {height} m, in {where}.', { name: cap(climb.landmark.name), height: climb.landmark.height_m, where: climb.landmark.where })}</p>` : ''}
        </div>
        <div>
          ${climb.ladder.length ? html`<p class="eyebrow" style="margin-bottom:8px">${t('Cleared')}</p>
            ${climb.ladder.map(r => html`<div class="rung"><b>${cap(r.name)}</b>
              <span class="dim">×${num(r.repeats, 1)}</span><span class="h">${t('{n} m', { n: r.height_m })}</span></div>`)}` : ''}
          ${climb.next_up ? html`<p class="stat-hint" style="margin-top:12px">${t('{m} m more and you have climbed {name}.', { m: Math.round(climb.next_up.to_go_m), name: climb.next_up.name })}</p>` : ''}
        </div>
      </div>
    </section>

    ${p ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('How you climb')}</p>
        <p class="panel-note">${t.n('{n} hilly run', '{n} hilly runs', p.runs)} · ${t.n('{n} climbing segment', '{n} climbing segments', p.climb_segments)}</p></div>
      <div class="grid-2">
        <div><div class="stat">
          <div class="stat-value factor ${p.factor > 1.05 ? 'up' : p.factor < 0.95 ? 'down' : ''}">${pct(p.factor)}<small class="unit">%</small></div>
          <div class="stat-label">${t('Against the energy model')}</div>
        </div></div>
        <div><p class="verdict">${TE.climbVerdictText(p)}</p></div>
      </div>
      <p class="stat-hint" style="margin-top:12px">${t("Measured inside each run: your speed on the flat sets the reference, and every climbing segment is compared against the speed Minetti's energy-cost model says the same effort should buy on that gradient. Because both halves come from the same run, fitness, weather and how hard you were trying all cancel — only the gradient is left.")}</p>
      <p class="stat-hint">${t('This is the part grade-adjusted pace cannot tell you. GAP applies the model to flatten your splits; this tests it, which is why it can say whether hills are a strength.')}</p>
    </section>` : ''}

    ${climb.hilliest.length ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('Your hilliest runs')}</p><p class="panel-note">${t('most climbing first')}</p></div>
      <div class="table-scroll"><table>
        <thead><tr><th>${t('Run')}</th><th class="num">${t('Distance')}</th><th class="num">${t('Ascent')}</th>
          <th class="num">${t('Per km')}</th><th>${t('Ground')}</th><th class="num">${t('On the climbs')}</th></tr></thead>
        <tbody>${climb.hilliest.map(h => html`<tr>
          <td><a class="quiet-link" href="#/activity/${h.id}">${h.name}</a>
            <br><span class="dim" style="font-family:var(--mono);font-size:12px">${day(dayKey(h.start))}</span></td>
          <td class="num dim">${t('{n} km', { n: num((h.distance_m || 0) / 1000, 1) })}</td>
          <td class="num actual">${t('{n} m', { n: Math.round(h.ascent_m || 0) })}</td>
          <td class="num dim">${h.terrain ? t('{n} m', { n: Math.round(h.terrain.ascent_per_km) }) : ''}</td>
          <td>${h.terrain ? ground(h.terrain.difficulty) : ''}</td>
          <td class="num"><span class="${h.factor > 1.05 ? 'ahead' : h.factor < 0.95 ? 'behind' : 'dim'}">${pct(h.factor)}%</span></td>
        </tr>`)}</tbody>
      </table></div>
      <p class="stat-hint" style="margin-top:12px">${t('“Ground” is ascent per kilometre, the same scale hiking guides use. The last column is that run alone against the energy model, so it moves about far more than the average above — one run is a mood.')}</p>
    </section>` : ''}

    ${p ? '' : html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('Not enough hills yet')}</p></div>
      <div class="empty">
        <p>${t('Judging how you climb needs runs with both flat and climbing in them, so there is something to compare against. A few rolling runs will do it — it does not need mountains.')}</p>
      </div>
    </section>`}`;
}
