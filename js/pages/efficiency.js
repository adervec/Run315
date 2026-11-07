// Aerobic efficiency over the whole record: the honest "am I fitter than I was?" chart.
// Steady runs only, corrected for hills and heat; see js/lib/efficiency.js for the rules.
import { state } from '../store.js';
import * as D from '../derive.js';
import { renderChart } from '../charts.js';
import { html, raw, pageHead, emptyState, day, useCss, link } from '../ui.js';

export const title = 'Efficiency';
let period = 'quarter';

const CSS = `
.eff .verdict { font-size: 17px; max-width: 70ch; }
.eff .periods { display: flex; gap: 6px; margin-bottom: 10px; }
.eff .periods button[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); }
`;
const pct = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '%';

function verdict(sl) {
  if (!sl) return 'Too few steady runs yet to call a trend (it takes 12).';
  const [lo, hi] = sl.ci_pct;
  if (lo > 0) return `Getting more efficient: about ${pct(sl.per_year_pct)} a year (95% interval ${pct(lo)} to ${pct(hi)}), over ${sl.years.toFixed(1)} years and ${sl.n} steady runs.`;
  if (hi < 0) return `Getting less efficient: about ${pct(sl.per_year_pct)} a year (95% interval ${pct(lo)} to ${pct(hi)}), over ${sl.years.toFixed(1)} years and ${sl.n} steady runs.`;
  return `No clear trend: ${pct(sl.per_year_pct)} a year, but the 95% interval (${pct(lo)} to ${pct(hi)}) includes no change. ${sl.n} steady runs over ${sl.years.toFixed(1)} years.`;
}

export function render() {
  useCss('efficiency', CSS);
  const rows = D.efficiencyRows(state);
  if (!rows.length) return html`${pageHead('Efficiency')}${emptyState('No steady runs yet',
    'Efficiency needs runs of 5 km or more at an aerobic heart rate (65–90% of threshold), with no intervals in them.', '')}`;
  const tr = D.efficiencyTrend(state, period), sl = D.efficiencySlope(state, 'ef'), slR = D.efficiencySlope(state, 'rre');
  const efChart = renderChart({ type: 'line', title: 'Efficiency factor, median per ' + period,
    x: { label: period, type: 'category' }, y: { label: 'EF', unit: 'm/min per bpm' },
    series: [{ name: 'EF', points: tr.map(t => [t.period, +t.ef.toFixed(3)]) }],
    note: 'Flat-equivalent, heat-corrected speed per heartbeat. Higher is fitter.' });
  const rre = tr.filter(t => t.rre != null);
  const rreChart = rre.length ? renderChart({ type: 'line', title: 'Relative running economy, median per ' + period,
    x: { label: period, type: 'category' }, y: { label: 'RRE' },
    series: [{ name: 'RRE', points: rre.map(t => [t.period, +t.rre.toFixed(1)]) }],
    note: '100000 ÷ heartbeats above that morning\'s resting HR per km (Runalyze). Takes a high-RHR day out of the comparison.' }) : '';
  const scatter = renderChart({ type: 'scatter', title: 'Every steady run', x: { label: 'date', type: 'time' }, y: { label: 'EF' },
    series: [{ name: 'run', points: rows.map(r => [r.date, +r.ef.toFixed(3)]) }] });
  return html`<div class="eff">${pageHead('Efficiency', 'Speed per heartbeat on steady runs, corrected for hills and heat')}
    <section class="panel"><p class="verdict">${verdict(sl)}</p>
      ${slR ? html`<p class="panel-note" style="margin:0">Relative running economy: ${verdict(slR).replace('steady runs', 'steady runs with a resting HR that morning')}</p>` : ''}</section>
    <section class="panel"><div class="periods" role="group" aria-label="Period">
      ${['month', 'quarter', 'year'].map(p => html`<button class="btn btn-ghost" data-period="${p}" aria-pressed="${p === period}">${p}</button>`)}</div>
      ${raw(efChart)}${raw(rreChart)}</section>
    <section class="panel"><div class="table-scroll"><table>
      <thead><tr><th>${period}</th><th class="num">Runs</th><th class="num">EF</th><th class="num">95% interval</th><th class="num">RRE</th></tr></thead>
      <tbody>${[...tr].reverse().map(t => html`<tr><td>${t.period}</td><td class="num">${t.n}</td><td class="num">${t.ef.toFixed(3)}</td>
        <td class="num dim">${t.ef_ci ? t.ef_ci[0].toFixed(3) + '–' + t.ef_ci[1].toFixed(3) : 'few runs'}</td>
        <td class="num">${t.rre != null ? t.rre.toFixed(1) : '--'}</td></tr>`)}</tbody></table></div></section>
    <section class="panel">${raw(scatter)}
      <p class="panel-note">Most efficient lately: ${rows.slice(-60).sort((a, b) => b.ef - a.ef).slice(0, 3).map((r, i) =>
        html`${i ? ', ' : ''}${link('activity/' + r.id, day(r.date) + ' (' + r.ef.toFixed(3) + ')')}`)}.
      What counts as steady: running, ≥ 5 km and 20 min, average HR 65–90% of threshold, no interval session found in it.
      Hills are taken out with book time for the climb; heat with the same pace penalty the weather correction uses.</p></section></div>`;
}

export function mount(el) {
  el.querySelectorAll('[data-period]').forEach(b => b.onclick = () => { period = b.dataset.period; el.innerHTML = String(render()); mount(el); });
}
