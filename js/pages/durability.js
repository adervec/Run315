// Does the engine hold up: heart-rate/pace decoupling on every long run, against the
// athlete's own critical speed and maximum heart rate (Smyth & Muniz-Pumares).
import { state } from '../store.js';
import * as D from '../derive.js';
import * as DU from '../lib/durability.js';
import { dayKey } from '../lib/dt.js';
import { html, pageHead, fmtPace, useCss } from '../ui.js';

export const title = 'Durability';

// --warn is not a theme token yet; the amber the old stylesheet used is the fallback.
const CSS = `
.dec-value { font-family: var(--display); font-size: 22px; font-weight: 800; letter-spacing: -0.03em; }
.b-low { color: var(--ahead); }
.b-moderate { color: var(--measured); }
.b-high { color: var(--behind); }
.drift-bar { display: block; height: 8px; border-radius: 4px; background: var(--track);
  position: relative; overflow: hidden; min-width: 90px; }
.drift-bar i { display: block; height: 100%; border-radius: 4px; }
.drift-bar i.b-low { background: var(--ahead); }
.drift-bar i.b-moderate { background: var(--measured); }
.drift-bar i.b-high { background: var(--behind); }
.hot-tag { font-family: var(--mono); font-size: 11px; color: var(--warn); }
.route-sub { font-family: var(--mono); font-size: 12px; }
`;

export function render() {
  useCss('durability', CSS);
  const [all, limits] = D.durabilityRuns(state);
  // durability_runs returned nothing at all without both ceilings.
  const runs = limits.cs && limits.hr_max ? all : [];
  const trend = DU.trend([...runs].reverse().map(r => [r.start, r]));
  const head = pageHead('Durability', 'Does the engine hold up');

  if (!limits.cs || !limits.hr_max) return html`${head}
    <section class="panel">
      <div class="panel-head"><p class="eyebrow">Not enough to measure against</p></div>
      <div class="empty">
        <p>Durability is expressed as a fraction of two ceilings: your maximum
          heart rate, and your critical speed. Critical speed is fitted to your
          best efforts of two to fifteen minutes, so it needs a few honest hard
          runs — a mile, a 3K, a 5K — before it means anything.</p>
      </div>
      <a class="btn" href="#/">Back to today</a>
    </section>`;

  return html`${head}
    <section class="panel">
      <div class="panel-head"><p class="eyebrow">What this is measured against</p></div>
      <div class="digest">
        <div class="stat">
          <div class="stat-value">${fmtPace(1000 / limits.cs, 1000)}</div>
          <div class="stat-label">Critical speed</div>
          <div class="stat-hint">The pace you could hold for roughly half an hour to an hour.</div>
        </div>
        ${limits.d_prime != null ? html`<div class="stat">
          <div class="stat-value">${Math.round(limits.d_prime)}<small class="unit">m</small></div>
          <div class="stat-label">Reserve above it</div>
          <div class="stat-hint">The finite distance available faster than critical speed.</div>
        </div>` : ''}
        <div class="stat">
          <div class="stat-value">${Math.round(limits.hr_max)}<small class="unit">bpm</small></div>
          <div class="stat-label">Highest heart rate seen</div>
          <div class="stat-hint">Taken from your training, so it is a floor on the real one.</div>
        </div>
      </div>
      <p class="stat-hint" style="margin-top:12px">
        Critical speed is fitted to your own best efforts of two to fifteen minutes
        (Smyth and Muniz-Pumares, MSSE 2020). It is <em>not</em> a race predictor
        — extrapolated to a half marathon it reads far too fast, because
        critical speed is only sustainable for half an hour or so. The race
        projections use a different model, and should.
      </p>
    </section>

    ${trend ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">Over this block</p><p class="panel-note">${trend.runs} comparable long runs</p></div>
      <p class="verdict">${trend.note}</p>
      <div class="digest">
        <div class="stat"><div class="stat-value">${trend.early.toFixed(2)}</div><div class="stat-label">Earlier half</div></div>
        <div class="stat"><div class="stat-value">${trend.late.toFixed(2)}</div><div class="stat-label">Recent half</div></div>
        <div class="stat"><div class="stat-value ahead">${trend.best.toFixed(2)}</div><div class="stat-label">Best</div></div>
      </div>
      <p class="stat-hint" style="margin-top:10px">
        Only runs within a fifth of your longest are compared. Durability over
        eighty minutes and over three hours are not the same measurement, and the
        literature has not settled how to make them one.
      </p>
    </section>` : ''}

    <section class="panel">
      <div class="panel-head"><p class="eyebrow">Long runs</p><p class="panel-note">${runs.length} with enough distance to measure</p></div>
      <div class="empty"><p>How far your heart rate drifted away from your pace
        between the early part of the run and the late part, with both sides
        expressed as a fraction of your own ceiling. 1.00 means the same pace cost
        the same effort at the end as at the start.</p></div>
      ${runs.length ? html`<div class="table-scroll"><table>
        <thead><tr><th>Run</th><th class="num">Distance</th><th class="num">Drift</th>
          <th>How much</th><th class="num">Fade began</th><th class="num">Effort</th></tr></thead>
        <tbody>${runs.map(r => html`<tr>
          <td><a class="quiet-link" href="#/activity/${r.id}">${r.name}</a>
            <br><span class="route-sub dim">${dayKey(r.start)}${r.hot && r.temperature_c != null
              ? html` <span class="hot-tag">· ${Math.round(r.temperature_c)}°C</span>` : ''}</span></td>
          <td class="num dim">${(r.distance_m / 1000).toFixed(1)} km</td>
          <td class="num"><span class="dec-value b-${r.band}">${r.decoupling.toFixed(2)}</span></td>
          <td><span class="drift-bar"><i class="b-${r.band}" style="width:${Math.min(100, Math.max(0, (r.decoupling - 1) * 300)).toFixed(0)}%"></i></span></td>
          <td class="num dim">${r.onset_m ? (r.onset_m / 1000).toFixed(1) + ' km' : '—'}</td>
          <td class="num dim">${r.intensity ? (r.intensity * 100).toFixed(0) + '%' : '—'}</td>
        </tr>`)}</tbody>
      </table></div>` : html`<p class="stat-hint">None yet: a run counts once it is at least
        ${DU.MIN_DISTANCE_M / 1000} km and ${DU.MIN_DURATION_S / 60} minutes, with heart rate and a per-second stream.</p>`}
      <p class="stat-hint" style="margin-top:12px">
        Effort is your average speed as a share of critical speed. “Fade
        began” is the first point where the drift passed 2.5% and stayed
        there. A blank means it never did.
      </p>
    </section>

    ${runs.length ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">${runs[0].name}</p><p class="panel-note">most recent measurable long run</p></div>
      <p class="verdict">${runs[0].verdict}</p>
      ${runs[0].hot && runs[0].temperature_c != null ? html`<p class="stat-hint">It was ${Math.round(runs[0].temperature_c)}°C. Heat
        inflates this number and it has not been corrected for — the paper this
        follows did not correct for it either, and said so.</p>` : ''}
    </section>` : ''}

    <section class="panel">
      <div class="panel-head"><p class="eyebrow">What this number is not</p></div>
      <div class="empty">
        <p>It is not comparable with anyone else’s. Fast runners race at
          around 96% of critical speed from the gun and have no room to drift, so
          their fade shows up as slowing rather than as a climbing heart rate. Men
          decouple more than women, and earlier. The bands here come from a study
          of 82,303 recreational marathon runners, and the thresholds in it are
          described by its own authors as arbitrary.</p>
        <p>It is also not a health measurement, and a single run says little. What
          is worth reading is the direction across a block of similar long runs.</p>
      </div>
    </section>`;
}
