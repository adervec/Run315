// Does the engine hold up: heart-rate/pace decoupling on every long run, against the
// athlete's own critical speed and maximum heart rate (Smyth & Muniz-Pumares).
import { state } from '../store.js';
import * as D from '../derive.js';
import * as DU from '../lib/durability.js';
import { dayKey } from '../lib/dt.js';
import { html, pageHead, fmtPace, day, useCss, t } from '../ui.js';
import { fmt } from '../i18n.js';

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

// Decimals in the reader's number format where font.js is there.
const num = (v, dp) => (fmt() ? fmt().number(v, { min: dp, max: dp }) : v.toFixed(dp));

export function render() {
  useCss('durability', CSS);
  const [all, limits] = D.durabilityRuns(state);
  // durability_runs returned nothing at all without both ceilings.
  const runs = limits.cs && limits.hr_max ? all : [];
  const trend = DU.trend([...runs].reverse().map(r => [r.start, r]));
  const head = pageHead(t('Durability'), t('Does the engine hold up'));

  if (!limits.cs || !limits.hr_max) return html`${head}
    <section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('Not enough to measure against')}</p></div>
      <div class="empty">
        <p>${t('Durability is expressed as a fraction of two ceilings: your maximum heart rate, and your critical speed. Critical speed is fitted to your best efforts of two to fifteen minutes, so it needs a few honest hard runs — a mile, a 3K, a 5K — before it means anything.')}</p>
      </div>
      <a class="btn" href="#/">${t('Back to today')}</a>
    </section>`;

  return html`${head}
    <section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('What this is measured against')}</p></div>
      <div class="digest">
        <div class="stat">
          <div class="stat-value">${fmtPace(1000 / limits.cs, 1000)}</div>
          <div class="stat-label">${t('Critical speed')}</div>
          <div class="stat-hint">${t('The pace you could hold for roughly half an hour to an hour.')}</div>
        </div>
        ${limits.d_prime != null ? html`<div class="stat">
          <div class="stat-value">${Math.round(limits.d_prime)}<small class="unit">m</small></div>
          <div class="stat-label">${t('Reserve above it')}</div>
          <div class="stat-hint">${t('The finite distance available faster than critical speed.')}</div>
        </div>` : ''}
        <div class="stat">
          <div class="stat-value">${Math.round(limits.hr_max)}<small class="unit">bpm</small></div>
          <div class="stat-label">${t('Highest heart rate seen')}</div>
          <div class="stat-hint">${t('Taken from your training, so it is a floor on the real one.')}</div>
        </div>
      </div>
      <p class="stat-hint" style="margin-top:12px">${t('Critical speed is fitted to your own best efforts of two to fifteen minutes (Smyth and Muniz-Pumares, MSSE 2020). It is not a race predictor — extrapolated to a half marathon it reads far too fast, because critical speed is only sustainable for half an hour or so. The race projections use a different model, and should.')}</p>
    </section>

    ${trend ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('Over this block')}</p><p class="panel-note">${t.n('{n} comparable long run', '{n} comparable long runs', trend.runs)}</p></div>
      <p class="verdict">${trend.note}</p>
      <div class="digest">
        <div class="stat"><div class="stat-value">${num(trend.early, 2)}</div><div class="stat-label">${t('Earlier half')}</div></div>
        <div class="stat"><div class="stat-value">${num(trend.late, 2)}</div><div class="stat-label">${t('Recent half')}</div></div>
        <div class="stat"><div class="stat-value ahead">${num(trend.best, 2)}</div><div class="stat-label">${t('Best')}</div></div>
      </div>
      <p class="stat-hint" style="margin-top:10px">${t('Only runs within a fifth of your longest are compared. Durability over eighty minutes and over three hours are not the same measurement, and the literature has not settled how to make them one.')}</p>
    </section>` : ''}

    <section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('Long runs')}</p><p class="panel-note">${t.n('{n} with enough distance to measure', '{n} with enough distance to measure', runs.length)}</p></div>
      <div class="empty"><p>${t('How far your heart rate drifted away from your pace between the early part of the run and the late part, with both sides expressed as a fraction of your own ceiling. 1.00 means the same pace cost the same effort at the end as at the start.')}</p></div>
      ${runs.length ? html`<div class="table-scroll"><table>
        <thead><tr><th>${t('Run')}</th><th class="num">${t('Distance')}</th><th class="num">${t('Drift')}</th>
          <th>${t('How much')}</th><th class="num">${t('Fade began')}</th><th class="num">${t('Effort')}</th></tr></thead>
        <tbody>${runs.map(r => html`<tr>
          <td><a class="quiet-link" href="#/activity/${r.id}">${r.name}</a>
            <br><span class="route-sub dim">${day(dayKey(r.start))}${r.hot && r.temperature_c != null
              ? html` <span class="hot-tag">· ${Math.round(r.temperature_c)}°C</span>` : ''}</span></td>
          <td class="num dim">${t('{n} km', { n: num(r.distance_m / 1000, 1) })}</td>
          <td class="num"><span class="dec-value b-${r.band}">${num(r.decoupling, 2)}</span></td>
          <td><span class="drift-bar"><i class="b-${r.band}" style="width:${Math.min(100, Math.max(0, (r.decoupling - 1) * 300)).toFixed(0)}%"></i></span></td>
          <td class="num dim">${r.onset_m ? t('{n} km', { n: num(r.onset_m / 1000, 1) }) : '—'}</td>
          <td class="num dim">${r.intensity ? (r.intensity * 100).toFixed(0) + '%' : '—'}</td>
        </tr>`)}</tbody>
      </table></div>` : html`<p class="stat-hint">${t('None yet: a run counts once it is at least {km} km and {min} minutes, with heart rate and a per-second stream.', { km: DU.MIN_DISTANCE_M / 1000, min: DU.MIN_DURATION_S / 60 })}</p>`}
      <p class="stat-hint" style="margin-top:12px">${t('Effort is your average speed as a share of critical speed. “Fade began” is the first point where the drift passed 2.5% and stayed there. A blank means it never did.')}</p>
    </section>

    ${runs.length ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">${runs[0].name}</p><p class="panel-note">${t('most recent measurable long run')}</p></div>
      <p class="verdict">${DU.verdictText(runs[0])}</p>
      ${runs[0].hot && runs[0].temperature_c != null ? html`<p class="stat-hint">${t('It was {temp}°C. Heat inflates this number and it has not been corrected for — the paper this follows did not correct for it either, and said so.', { temp: Math.round(runs[0].temperature_c) })}</p>` : ''}
    </section>` : ''}

    <section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('What this number is not')}</p></div>
      <div class="empty">
        <p>${t('It is not comparable with anyone else’s. Fast runners race at around 96% of critical speed from the gun and have no room to drift, so their fade shows up as slowing rather than as a climbing heart rate. Men decouple more than women, and earlier. The bands here come from a study of 82,303 recreational marathon runners, and the thresholds in it are described by its own authors as arbitrary.')}</p>
        <p>${t('It is also not a health measurement, and a single run says little. What is worth reading is the direction across a block of similar long runs.')}</p>
      </div>
    </section>`;
}
