// The athlete's own impulse-response model: fitness and fatigue time constants fitted to the
// whole load history against their races and hard best efforts (js/lib/banister.js), what
// that says about how long a block takes to land and how long to taper, and a forward
// projection to every race still ahead. responsePanel(raceId) is the short version for the
// race page.
import { state, rev } from '../store.js';
import * as D from '../derive.js';
import * as B from '../lib/banister.js';
import { dayKey, addDayKey, daysBetween } from '../lib/dt.js';
import { renderChart } from '../charts.js';
import { html, raw, esc, pageHead, emptyState, day, fmtTime, useCss, link } from '../ui.js';

export const title = 'Response model';

const CSS = `
.resp .digest { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; }
.resp .digest .stat { border-top: none; padding-top: 0; }
.resp .warns { margin: 10px 0 0; padding-left: 18px; color: var(--muted); font-size: 14px; }
.resp .warns li { margin: 3px 0; }
.resp .warns li::marker { color: var(--warn); }
.resp .taper-pick { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 10px; }
.resp .taper-pick label { display: flex; gap: 6px; align-items: center; font-size: 14px; }
.resp .taper-pick input { width: 5em; }
.resp .band { color: var(--muted); font-size: 12px; white-space: nowrap; }
.resp .method { max-width: 75ch; }
.resp .curve .model { stroke: var(--projected); }
.resp .curve .eff { fill: var(--measured); fill-opacity: .55; }
.resp .curve .race { fill: var(--measured); stroke: var(--ink); stroke-width: 1.5; }
.resp-panel .resp-line { margin: 4px 0; }
`;

// Taper choice: the load fraction for the last n days, and n (null: each race's own best).
let taperFrac = 0.5, taperDays = null;

// ---- the fit, once per data revision ----
let _cache = null;
export function responseFit(now = new Date()) {
  const today = dayKey(now), key = rev + ':' + Object.keys(state.derived).length + ':' + today;
  if (_cache && _cache.key === key) return _cache.value;
  const value = compute(today, now);
  _cache = { key, value };
  return value;
}
function compute(today, now) {
  const s = D.summary(state, now);
  if (!s) return null;
  const acts = {};
  for (const a of D.runs(state)) acts[a.id] = { avg_hr: a.avg_hr, virtual: D.isVirtual(a) };
  const perfs = B.performances({ races: D.races(state), efforts: D.prRows(state), acts,
    thrHr: s.threshold_hr, exponent: s.fit ? s.fit[1] : null, today });
  const fit = B.fitModel(s.daily, perfs, today);
  // The race projection is built from the bucket bests of the last 180 days, weighted to the
  // recent (fitness.fitPowerLaw): the form it stands on is p averaged over those days.
  const ref = s.fit ? s.fit[2].map(([, , age]) => [addDayKey(today, -age), 0.5 ** (age / 90)]) : null;
  return { s, fit, perfs, today, refP: fit.ok ? B.referenceP(fit, ref) : null };
}

// ---- formatting ----
const f0 = v => (v == null || !isFinite(v) ? '--' : Math.round(v).toString());
const f1 = v => (v == null || !isFinite(v) ? '--' : v.toFixed(1));
const iv = (a, d = 0) => (a && a[0] != null ? (d ? a[0].toFixed(d) : Math.round(a[0])) + '–' + (d ? a[1].toFixed(d) : Math.round(a[1])) : '--');
const pctOff = p => { const d = p - 100; return (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1) + '%'; };
// p back to a 10 km time: p is % of the athlete's median 10 km-equivalent speed.
const tenK = (fit, p) => fmtTime(B.REF_M / (fit.perfs[0].ref_v * p / 100));

// Upcoming races: ahead (or today) and not yet run.
const upcoming = today => D.races(state).filter(r => r.date >= today && !r.actual_s && r.distance_m);

// One race: projection, both plans, the band. -> null when nothing can be said.
function outlook(m, race, n = taperDays, frac = taperFrac) {
  const daysOut = daysBetween(m.today, race.date);
  if (!m.fit.ok || daysOut < 1) return null;
  const nDays = n == null ? B.bestRaceTaper(m.fit, daysOut, frac) : Math.min(n, daysOut - 1);
  const o = B.raceOutlook(m.fit, m.refP, daysOut, nDays, frac);
  const proj = D.projection(state, race);
  // Undo the projection's own CTL-trend factor: the model replaces it (not on top of it).
  const base = proj && proj.seconds ? proj.seconds / (proj.trend_factor || 1) : null;
  return { race, o, proj, base, nDays };
}
const timeBand = (base, b) => (base ? { t: base * b.ratio, lo: base * b.lo, hi: base * b.hi } : null);

// ---- the curve with the performances on it ----
// Custom SVG rather than renderChart: a model line with measured points on top is two marks.
function curveSvg(fit) {
  const W = 680, H = 240, M = { l: 44, r: 12, t: 12, b: 28 };
  const ser = fit.series, start = Math.min(ser.n - 1, B.WARMUP_DAYS);
  const pts = [];
  for (let i = start; i <= ser.n; i += 7) pts.push([i, fit.curve[i]]);
  pts.push([ser.n - 1, fit.curve[ser.n - 1]]);
  const obs = fit.perfs.map(q => [ser.index(q.day), q.p, q]);
  const ys = [...pts.map(p => p[1]), ...obs.map(p => p[1])].sort((a, b) => a - b);
  let y0 = ys[Math.floor(ys.length * 0.01)], y1 = ys[Math.ceil(ys.length * 0.99) - 1];
  if (!(y1 > y0)) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * 0.08; y0 -= pad; y1 += pad;
  const x0 = start, x1 = ser.n, iw = W - M.l - M.r, ih = H - M.t - M.b;
  const X = i => M.l + ((i - x0) / (x1 - x0)) * iw, Y = v => M.t + ih - ((Math.max(y0, Math.min(y1, v)) - y0) / (y1 - y0)) * ih;
  const step = [1, 2, 2.5, 5, 10].find(s => (y1 - y0) / s <= 6) || 10;
  let g = '<g class="grid">', ax = '<g class="axis">';
  for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) {
    g += `<line x1="${M.l}" x2="${W - M.r}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>`;
    ax += `<text x="${M.l - 6}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`;
  }
  const years = [];
  for (let y = +ser.start.slice(0, 4) + 1; y <= +ser.today.slice(0, 4); y++) years.push(y);
  const yearStep = Math.ceil(years.length / 8);
  years.forEach((y, k) => {
    const i = ser.index(y + '-01-01');
    if (i > x0 && k % yearStep === 0) ax += `<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${y}</text>`;
  });
  g += '</g>'; ax += '</g>';
  const line = `<polyline class="model" fill="none" stroke-width="2" stroke-linejoin="round" points="${pts.map(p => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ')}"/>`;
  const dots = obs.map(([i, v, q]) => `<circle class="${q.kind === 'race' ? 'race' : 'eff'}" cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="${q.kind === 'race' ? 4.5 : 3}"><title>${esc(day(q.day, true))} · ${esc(q.kind === 'race' ? (q.name || 'race') : 'best ' + (q.d / 1000).toFixed(1) + ' km')} ${esc(fmtTime(q.s))} → ${q.p.toFixed(1)}</title></circle>`).join('');
  return `<figure class="chart-fig curve"><figcaption>Fitted performance vs what you ran</figcaption>
    <svg viewBox="0 -14 ${W} ${H + 14}" role="img" aria-label="Fitted performance curve and observed performances"><text class="lbl" x="${M.l}" y="${M.t - 3}">performance (% of your median)</text>${g}${ax}${line}${dots}</svg>
    <div class="chart-legend-row"><span><i style="background:var(--projected)"></i>model</span><span><i style="background:var(--measured);opacity:.55"></i>hard best effort</span><span><i style="background:var(--measured);outline:1.5px solid var(--ink)"></i>race</span></div>
    <p class="chart-note">Weekly points of the fitted curve; dots are the performances it was fitted to. The axis is clipped to the middle 98%.</p></figure>`;
}

function boutChart(m) {
  const pts = [];
  for (let t = 0; t <= 70; t++) pts.push([t, +(100 * (m.k1 * Math.exp(-t / m.tau1) - m.k2 * Math.exp(-t / m.tau2))).toFixed(3)]);
  return renderChart({ type: 'line', title: 'What one session of 100 load does, day by day', x: { label: 'days after', type: 'linear' },
    y: { label: 'change in performance', unit: '%' }, series: [{ name: 'effect', points: pts }],
    note: 'Below zero it is costing you; it crosses into gain and peaks at the time to peak. A 100-load session is roughly an hour at threshold.' });
}

function forwardChart(m, x) {
  const toPts = path => path.map((p, j) => [addDayKey(m.today, j + 1), +p.toFixed(2)]);
  return renderChart({ type: 'line', title: 'Predicted form to ' + x.race.name, x: { label: 'day', type: 'time' }, y: { label: 'performance', unit: '%' },
    series: [{ name: 'keep current load', points: toPts(x.o.keep_path) }, { name: `taper ${x.nDays} d at ${Math.round(taperFrac * 100)}%`, points: toPts(x.o.taper_path) }],
    note: 'The fitted model run forward from today; the last point is race morning. The uncertainty bands are in the table above; when they are wider than the gap between the lines, the gain from tapering is within the noise.' });
}

// ---- panels ----
function digest(fit) {
  const m = fit.model, c = fit.ci;
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Your constants</p><p class="panel-note">${fit.n} performances (${fit.n_races} races) over
      ${(fit.series.n / 365).toFixed(1)} years of load · intervals are 80% bootstrap ranges</p></div>
    <div class="digest">
      <div class="stat"><div class="stat-value">${f0(m.tau1)} d</div><div class="stat-label">Fitness time constant τ1</div><div class="stat-hint">${iv(c.tau1)} d · textbook 42</div></div>
      <div class="stat"><div class="stat-value">${f1(m.tau2)} d</div><div class="stat-label">Fatigue time constant τ2</div><div class="stat-hint">${iv(c.tau2, 1)} d · textbook 7</div></div>
      <div class="stat"><div class="stat-value">${fit.t_star == null ? '--' : f0(fit.t_star) + ' d'}</div><div class="stat-label">Time to peak after a session</div><div class="stat-hint">${iv(c.t_star)} d</div></div>
      <div class="stat"><div class="stat-value">${fit.optimal_taper} d</div><div class="stat-label">Best taper at 50% load</div><div class="stat-hint">${iv(c.taper)} d · after a steady block</div></div>
      <div class="stat"><div class="stat-value">${pctOff(fit.p_today)}</div><div class="stat-label">Predicted today</div><div class="stat-hint">vs your median · about ${tenK(fit, fit.p_today)} for 10 km</div></div>
      <div class="stat"><div class="stat-value">${fit.r2.toFixed(2)}</div><div class="stat-label">R² of the fit</div><div class="stat-hint">residual SD ${fit.resid_sd.toFixed(1)}%${fit.race_resid_sd != null ? ' · races ' + fit.race_resid_sd.toFixed(1) + '%' : ''}</div></div>
    </div>
    <p class="panel-note">k1 = ${m.k1.toExponential(2)} (${c.k1[0] != null ? c.k1[0].toExponential(1) + '–' + c.k1[1].toExponential(1) : '--'}),
      k2 = ${m.k2.toExponential(2)} (${c.k2[0] != null ? c.k2[0].toExponential(1) + '–' + c.k2[1].toExponential(1) : '--'}) % per unit load;
      p0 = ${m.p0.toFixed(1)}. Time to peak = τ1τ2/(τ1−τ2)·ln(k2τ1/(k1τ2)).</p>
    ${fit.warnings.length ? html`<ul class="warns">${fit.warnings.map(w => html`<li>${w}</li>`)}</ul>` : ''}
  </section>`;
}

function racesPanel(m) {
  const list = upcoming(m.today);
  const rows = list.map(r => outlook(m, r)).filter(Boolean);
  const fracSel = html`<label>Taper load <select data-frac>${[0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map(v =>
    html`<option value="${v}" ${v === taperFrac ? raw('selected') : ''}>${Math.round(v * 100)}% of usual</option>`)}</select></label>`;
  const daysIn = html`<label>for <input type="number" min="0" max="42" step="1" data-days value="${taperDays == null ? '' : taperDays}" placeholder="best"> days</label>`;
  const reset = taperDays != null ? html`<button class="btn btn-quiet" data-reset>Use my best per race</button>` : '';
  const cell = (b, base) => {
    const t = timeBand(base, b);
    return t ? html`${fmtTime(t.t)}<br><span class="band">${fmtTime(t.lo)}–${fmtTime(t.hi)}</span>` : html`<span class="dim">no projection</span>`;
  };
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">Races ahead</p>
      <p class="panel-note">Holding your last 28 days' average load (${f0(B.recentLoad(m.fit.series))} a day), or tapering the last days to a fraction of it</p></div>
    <div class="taper-pick">${fracSel}${daysIn}${reset}</div>
    ${rows.length ? html`<div class="table-scroll"><table>
      <thead><tr><th>Race</th><th class="num">Days</th><th class="num">Projection</th><th class="num">Keep load</th><th class="num">Taper</th><th class="num">Form keep → taper</th></tr></thead>
      <tbody>${rows.map(x => html`<tr>
        <td>${link('race/' + x.race.id, x.race.name)}<br><span class="dim">${day(x.race.date, true)} · ${(x.race.distance_m / 1000).toFixed(1)} km</span></td>
        <td class="num">${x.o.days_out}</td>
        <td class="num">${x.proj ? fmtTime(x.proj.seconds) : '--'}</td>
        <td class="num">${cell(x.o.keep, x.base)}</td>
        <td class="num">${cell(x.o.taper, x.base)}<br><span class="band">${x.nDays} d at ${Math.round(taperFrac * 100)}%${taperDays == null ? ' (best)' : ' · best ' + x.o.best_taper + ' d'}</span></td>
        <td class="num">${pctOff(x.o.p_keep)} → ${pctOff(x.o.p_taper)}</td></tr>`)}</tbody></table></div>
      ${raw(forwardChart(m, rows[0]))}
      <p class="panel-note">Times: the race projection with its own CTL-trend factor taken out (this model replaces it), scaled by
        how your predicted form on race day compares with your form on the days the projection's efforts were run.
        The range is an 80% band: the bootstrap spread of the model plus one day's scatter around the curve
        (${((m.fit.race_resid_sd ?? m.fit.resid_sd)).toFixed(1)}%, ${m.fit.race_resid_sd != null ? 'from your races' : 'from all performances'}) — the second is usually most of it.</p>`
      : html`<p class="panel-note">${list.length ? 'The only race ahead is today: nothing left to change.' : html`No race ahead. Add one on ${link('races', 'Races')} and its race-day form appears here.`}</p>`}
  </section>`;
}

function perfTable(fit) {
  const rows = fit.perfs.map((q, i) => ({ q, fit: fit.fitted[i], r: fit.resid[i] })).reverse();
  return html`<details><summary>All ${rows.length} performances</summary><div class="table-scroll"><table>
    <thead><tr><th>Day</th><th>What</th><th class="num">Time</th><th class="num">Performance</th><th class="num">Model</th><th class="num">Residual</th></tr></thead>
    <tbody>${rows.map(({ q, fit: mv, r }) => html`<tr><td>${day(q.day, true)}</td>
      <td>${q.kind === 'race' ? link('race/' + q.id, q.name || 'race') : link('activity/' + q.id, 'best ' + (q.d / 1000).toFixed(1) + ' km')}</td>
      <td class="num">${fmtTime(q.s)}</td><td class="num">${q.p.toFixed(1)}</td><td class="num">${mv.toFixed(1)}</td>
      <td class="num">${(r >= 0 ? '+' : '−') + Math.abs(r).toFixed(1)}</td></tr>`)}</tbody></table></div></details>`;
}

function method() {
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">How this works</p></div><div class="method">
    <p>Performance on a day is modelled as a baseline plus a fitness term minus a fatigue term, each the sum of every
      earlier day's training load decaying at its own rate (Banister's impulse-response model, 1975, in the two-component
      form Busso used). Your fitness and fatigue constants τ1 and τ2, their weights k1 and k2 and the baseline are fitted
      to your own performances by bounded least squares: τ1 between ${B.TAU1.join(' and ')} days, τ2 between ${B.TAU2.join(' and ')},
      k1 and k2 not negative. A grid search over the two time constants, refined by Nelder–Mead; the rest is linear.</p>
    <p>Performances are races (weighted ×${B.RACE_WEIGHT}) and best efforts from 1.6 km up measured inside runs that were hard
      (average heart rate at least ${Math.round(B.HARD_HR * 100)}% of threshold) and within ${Math.round((1 - B.ENVELOPE) * 100)}% of the best you ran
      in a month either side — the fastest 5 km of an easy run is not a test. Each becomes a 10 km-equivalent speed by
      Riegel's formula with your own fatigue exponent (the one your race projections use), as a percentage of your median.
      Riegel rather than critical speed because the races that matter most here are half marathons and marathons, well
      outside the 2–30 minutes critical speed describes; and because the projections use it, a 1-point change here is a
      1% change in a projected time. The first ${B.WARMUP_DAYS} days of the record are left out: the model cannot see the
      training before it.</p>
    <p>Limits: the baseline is constant across the whole record, so ageing and long breaks show up as misfit; load is
      the app's heart-rate (or power) score, which sees neither terrain nor heat on the day; and a fitted relation is not a
      controlled experiment. A taper recommendation from it is a starting point, not a rule.</p></div></section>`;
}

export function render() {
  useCss('response', CSS);
  const m = responseFit();
  if (!m) return html`${pageHead('Response model')}${emptyState('No training yet',
    'This fits your own fitness and fatigue constants to your training load and your races. It needs a history of both.', link('sync', 'Bring in your data'))}`;
  const fit = m.fit;
  if (!fit.ok) return html`<div class="resp">${pageHead('Response model', 'Your own fitness and fatigue constants')}
    ${emptyState('Not enough to fit yet', fit.reason + ' Race results count most: enter them on the race page once you have run.', link('races', 'Races'))}
    ${method()}</div>`;
  return html`<div class="resp">${pageHead('Response model', `Your fitness and fatigue constants, fitted to ${(fit.series.n / 365).toFixed(1)} years of load and ${fit.n} performances`)}
    ${digest(fit)}
    <section class="panel">${raw(curveSvg(fit))}${perfTable(fit)}</section>
    ${racesPanel(m)}
    <section class="panel">${raw(boutChart(fit.model))}</section>
    ${method()}</div>`;
}

export function mount(el) {
  const rerender = () => { el.innerHTML = String(render()); mount(el); };
  const frac = el.querySelector('[data-frac]'), days = el.querySelector('[data-days]'), reset = el.querySelector('[data-reset]');
  if (frac) frac.onchange = () => { taperFrac = +frac.value; rerender(); };
  if (days) days.onchange = () => { const v = days.value.trim(); taperDays = v === '' ? null : Math.max(0, Math.min(42, Math.round(+v) || 0)); rerender(); };
  if (reset) reset.onclick = () => { taperDays = null; rerender(); };
}

// ---- for the race page ----
// A small panel: the personal taper and predicted race-day form for an upcoming race, or for a
// past one what the model expected on the day. '' for an unknown race.
export function responsePanel(raceId) {
  const race = state.races[raceId];
  if (!race) return '';
  const m = responseFit();
  const head = html`<div class="panel-head"><p class="eyebrow">Your response model</p>${link('response', 'Details')}</div>`;
  if (!m || !m.fit.ok) return html`<section class="panel resp-panel">${head}<p class="panel-note">${m ? m.fit.reason : 'No training yet.'}</p></section>`;
  const fit = m.fit, consts = `τ1 ${Math.round(fit.model.tau1)} d, τ2 ${fit.model.tau2.toFixed(1)} d, from ${fit.n} performances`;
  if (race.actual_s || race.date < m.today) {
    const i = fit.series.index(race.date), q = fit.perfs.find(p => p.day === race.date && p.kind === 'race');
    if (!(i >= 0 && i <= fit.series.n)) return '';
    const exp = fit.curve[i];
    return html`<section class="panel resp-panel">${head}
      <p class="resp-line">On the day the model expected ${pctOff(exp)} against your median${q ? html`; you ran ${pctOff(q.p)}, ${(q.p - exp >= 0 ? 'better' : 'worse')} by ${Math.abs(q.p - exp).toFixed(1)} points` : ''}.</p>
      <p class="panel-note">${consts}. One point ≈ 1% of race time; a day's scatter around the curve is about ${fit.resid_sd.toFixed(1)}.</p></section>`;
  }
  const x = outlook(m, race, null, 0.5);
  if (!x) return html`<section class="panel resp-panel">${head}<p class="resp-line">Race day: the model puts you at ${pctOff(fit.p_today)} against your median.</p></section>`;
  const t = timeBand(x.base, x.o.taper), k = timeBand(x.base, x.o.keep);
  return html`<section class="panel resp-panel">${head}
    <p class="resp-line"><strong>Taper ${x.nDays} days at half your usual load</strong> (from ${day(addDayKey(race.date, -x.nDays), true)}):
      race-day form ${pctOff(x.o.p_taper)} against your median, vs ${pctOff(x.o.p_keep)} if you keep training as now.</p>
    ${t ? html`<p class="resp-line">Predicted ${fmtTime(t.t)} (80%: ${fmtTime(t.lo)}–${fmtTime(t.hi)}); without the taper ${fmtTime(k.t)}.</p>` : ''}
    <p class="panel-note">${consts}${fit.warnings.length ? ' · ' + fit.warnings.length + ' caveat' + (fit.warnings.length > 1 ? 's' : '') + ' on the details page' : ''}.</p></section>`;
}
