// Aerobic efficiency over the whole record: the honest "am I fitter than I was?" chart.
// Steady runs only, corrected for hills and heat; see js/lib/efficiency.js for the rules.
import { state } from '../store.js';
import * as D from '../derive.js';
import { renderChart } from '../charts.js';
import { html, raw, esc, pageHead, emptyState, day, useCss, link, t } from '../ui.js';

export const title = 'Efficiency';
let period = 'quarter';

const CSS = `
.eff .verdict { font-size: 17px; max-width: 70ch; }
.eff .periods { display: flex; gap: 6px; margin-bottom: 10px; }
.eff .periods button[aria-pressed="true"] { background: var(--ink); color: var(--on-ink); }
`;
const pct = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '%';

// rre: the relative-running-economy line, which counts only runs with a resting HR that morning.
function verdict(sl, rre = false) {
  if (!sl) return t('Too few steady runs yet to call a trend (it takes 12).');
  const [lo, hi] = sl.ci_pct;
  const p = { rate: pct(sl.per_year_pct), lo: pct(lo), hi: pct(hi), years: sl.years.toFixed(1), n: sl.n };
  if (rre) {
    if (lo > 0) return t('Getting more efficient: about {rate} a year (95% interval {lo} to {hi}), over {years} years and {n} steady runs with a resting HR that morning.', p);
    if (hi < 0) return t('Getting less efficient: about {rate} a year (95% interval {lo} to {hi}), over {years} years and {n} steady runs with a resting HR that morning.', p);
    return t('No clear trend: {rate} a year, but the 95% interval ({lo} to {hi}) includes no change. {n} steady runs with a resting HR that morning over {years} years.', p);
  }
  if (lo > 0) return t('Getting more efficient: about {rate} a year (95% interval {lo} to {hi}), over {years} years and {n} steady runs.', p);
  if (hi < 0) return t('Getting less efficient: about {rate} a year (95% interval {lo} to {hi}), over {years} years and {n} steady runs.', p);
  return t('No clear trend: {rate} a year, but the 95% interval ({lo} to {hi}) includes no change. {n} steady runs over {years} years.', p);
}
// The period is also the state key ('month', 'quarter', 'year'); its label goes through t().
// i18n-keys: month | quarter | year
const efTitle = p => ({ month: t('Efficiency factor, median per month'), quarter: t('Efficiency factor, median per quarter'),
  year: t('Efficiency factor, median per year') }[p]);
const rreTitle = p => ({ month: t('Relative running economy, median per month'), quarter: t('Relative running economy, median per quarter'),
  year: t('Relative running economy, median per year') }[p]);

export function render() {
  useCss('efficiency', CSS);
  const rows = D.efficiencyRows(state);
  if (!rows.length) return html`${pageHead(t('Efficiency'))}${emptyState(t('No steady runs yet'),
    t('Efficiency needs runs of 5 km or more at an aerobic heart rate (65–90% of threshold), with no intervals in them.'), '')}`;
  const tr = D.efficiencyTrend(state, period), sl = D.efficiencySlope(state, 'ef'), slR = D.efficiencySlope(state, 'rre');
  const efChart = renderChart({ type: 'line', title: efTitle(period),
    x: { label: t(period), type: 'category' }, y: { label: 'EF', unit: t('m/min per bpm') },
    series: [{ name: 'EF', points: tr.map(x => [x.period, +x.ef.toFixed(3)]) }],
    note: t('Flat-equivalent, heat-corrected speed per heartbeat. Higher is fitter.') });
  const rre = tr.filter(x => x.rre != null);
  const rreChart = rre.length ? renderChart({ type: 'line', title: rreTitle(period),
    x: { label: t(period), type: 'category' }, y: { label: 'RRE' },
    series: [{ name: 'RRE', points: rre.map(x => [x.period, +x.rre.toFixed(1)]) }],
    note: t("100000 ÷ heartbeats above that morning's resting HR per km (Runalyze). Takes a high-RHR day out of the comparison.") }) : '';
  const scatter = renderChart({ type: 'scatter', title: t('Every steady run'), x: { label: t('date'), type: 'time' }, y: { label: 'EF' },
    series: [{ name: t('run'), points: rows.map(r => [r.date, +r.ef.toFixed(3)]) }] });
  const best = html`${rows.slice(-60).sort((a, b) => b.ef - a.ef).slice(0, 3).map((r, i) =>
    html`${i ? ', ' : ''}${link('activity/' + r.id, day(r.date) + ' (' + r.ef.toFixed(3) + ')')}`)}`;
  const lately = raw(esc(t('Most efficient lately: {runs}.', { runs: '\u0001' })).replace('\u0001', () => String(best)));
  return html`<div class="eff">${pageHead(t('Efficiency'), t('Speed per heartbeat on steady runs, corrected for hills and heat'))}
    <section class="panel"><p class="verdict">${verdict(sl)}</p>
      ${slR ? html`<p class="panel-note" style="margin:0">${t('Relative running economy: {verdict}', { verdict: verdict(slR, true) })}</p>` : ''}</section>
    <section class="panel"><div class="periods" role="group" aria-label="${t('Period')}">
      ${['month', 'quarter', 'year'].map(p => html`<button class="btn btn-ghost" data-period="${p}" aria-pressed="${p === period}">${t(p)}</button>`)}</div>
      ${raw(efChart)}${raw(rreChart)}</section>
    <section class="panel"><div class="table-scroll"><table>
      <thead><tr><th>${t(period)}</th><th class="num">${t('Runs')}</th><th class="num">EF</th><th class="num">${t('95% interval')}</th><th class="num">RRE</th></tr></thead>
      <tbody>${[...tr].reverse().map(x => html`<tr><td>${x.period}</td><td class="num">${x.n}</td><td class="num">${x.ef.toFixed(3)}</td>
        <td class="num dim">${x.ef_ci ? x.ef_ci[0].toFixed(3) + '–' + x.ef_ci[1].toFixed(3) : t('few runs')}</td>
        <td class="num">${x.rre != null ? x.rre.toFixed(1) : '--'}</td></tr>`)}</tbody></table></div></section>
    <section class="panel">${raw(scatter)}
      <p class="panel-note">${lately}
      ${t('What counts as steady: running, ≥ 5 km and 20 min, average HR 65–90% of threshold, no interval session found in it.')}
      ${t('Hills are taken out with book time for the climb; heat with the same pace penalty the weather correction uses.')}</p></section></div>`;
}

export function mount(el) {
  el.querySelectorAll('[data-period]').forEach(b => b.onclick = () => { period = b.dataset.period; el.innerHTML = String(render()); mount(el); });
}
