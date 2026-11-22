// Insights: seven small analyses, each its own panel with its own caveats. The logic is in
// js/lib/insights.js; this page gathers the inputs and draws.
//
// Four panels come from the synced state and render at once (HRV, seasons, predictors, time
// of day). Three need the per-second streams -- heart-rate recovery, form at matched pace,
// climbs -- which live only on the device that imported them. mount() reads them one at a
// time and caches each activity's compact result in IndexedDB ('hrr-<id>', 'form-<id>',
// 'climbs-<id>'), so the first visit is slow once and every later one is a cache read.
import { state, streamIds, getStream, idbGet, idbSet } from '../store.js';
import * as D from '../derive.js';
import * as I from '../lib/insights.js';
import { samplesFromChannels } from '../ingest.js';
import { renderChart } from '../charts.js';
import { RUN_TYPES, STANDARD_RACES } from '../lib/fitness.js';
import { dayKey } from '../lib/dt.js';
import { html, raw, esc, pageHead, emptyState, day, useCss, link, fmtTime, t } from '../ui.js';
import { fmt } from '../i18n.js';

export const title = 'Insights';

const CSS = `
.ins .verdict { font-size: 16px; max-width: 72ch; }
.ins .multi { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.ins .multi > * { min-width: 0; }
@media (max-width: 860px) { .ins .multi { grid-template-columns: 1fr; } }
.ins .tod { border-collapse: separate; border-spacing: 2px; font-size: 11px; }
.ins .tod td { width: 14px; height: 14px; padding: 0; border-radius: 2px; background: var(--track); }
.ins .tod th { font-weight: 400; color: var(--faint); padding: 0 4px 0 0; text-align: right; }
.ins .tod thead th { text-align: center; padding: 0; }
.ins .flag-low { color: var(--behind); }
.ins .flag-high { color: var(--ahead); }
.ins .progress { color: var(--muted); font-size: 14px; }
`;

const paceS = s => (s == null ? '--' : fmtTime(s) + ' /km');
const pct = v => (v == null ? '--' : v.toFixed(1) + '%');
const f1 = v => (v == null ? '--' : v.toFixed(1));
const distLabel = d => ({ 400: '400 m', 800: '800 m', 1000: '1 km', 1609: t('1 mile'), 3000: '3 km', 5000: '5K', 10000: '10K',
  15000: '15K', 16093: t('10 mi'), 21097: t('Half marathon'), 42195: t('Marathon'), 50000: '50K' }[d] || (d / 1000).toFixed(1) + ' km');
const chart = spec => { try { return raw(renderChart(spec)); } catch { return ''; } };
const head = (eyebrow, note) => html`<div class="panel-head"><p class="eyebrow">${eyebrow}</p>${note ? html`<p class="panel-note">${note}</p>` : ''}</div>`;
const today = () => dayKey(new Date());
// A translated sentence with markup placed inside it where '\u0001' stands.
const withMarkup = (text, markup) => raw(esc(text).replace('\u0001', () => String(markup)));
// Weekday i (Monday 0) in the reader's language; the lib's English short names without font.js.
const weekdayName = i => (fmt() ? fmt().custom(new Date(2026, 0, 5 + i), { weekday: 'short' }) : I.WEEKDAYS[i]);

// ---------------------------------------------------------------- 1. heart-rate recovery
const hrrIntro = () => html`<p class="panel-note">${t('How far your heart rate falls in the first one and two minutes after a hard effort ends. Within one person a faster fall goes with fitness, and a slower one than usual with fatigue. It depends on how high HR was at the end and on what you did in the minute after (stand, walk, jog), so only efforts ending at ≥ 85% of your max HR count, one median per session, and the comparison is you against yourself.')}</p>`;

function hrrPanel(rows, source) {
  const hrMax = D.limits(state).hr_max;
  const tr = I.hrrTrend(rows, { hrMax });
  const ends = rows.flatMap(r => r.e.filter(e => e[0] === 'e'));
  const kinds = { r: 0, p: 0 };
  rows.forEach(r => r.e.forEach(e => { if (e[0] in kinds) kinds[e[0]]++; }));
  if (!tr.length) return html`${head(t('Heart-rate recovery'), source)}${hrrIntro()}
    <p class="verdict">${t('No efforts to measure yet: it needs an interval rep, or a hard stretch, followed by at least a minute of easier running or walking with the watch still recording heart rate.')}</p>`;
  const last = tr[tr.length - 1], first = tr[0];
  const pts = k => tr.filter(q => q[k] != null).map(q => [q.period, +q[k].toFixed(1)]);
  const latest = last.d120 != null
    ? t.n('Latest quarter ({period}): HR fell a median {d60} bpm in 60 s and {d120} bpm in 120 s over {n} session.',
      'Latest quarter ({period}): HR fell a median {d60} bpm in 60 s and {d120} bpm in 120 s over {n} sessions.', last.sessions,
      { period: last.period, d60: f1(last.d60), d120: f1(last.d120) })
    : t.n('Latest quarter ({period}): HR fell a median {d60} bpm in 60 s over {n} session.',
      'Latest quarter ({period}): HR fell a median {d60} bpm in 60 s over {n} sessions.', last.sessions, { period: last.period, d60: f1(last.d60) });
  return html`${head(t('Heart-rate recovery'), source)}${hrrIntro()}
    <p class="verdict">${latest}
      ${tr.length > 1 ? t('In {period} it was {d60} bpm in 60 s.', { period: first.period, d60: f1(first.d60) }) : ''}
      ${last.d60_ci ? '' : t('Few sessions in that quarter: no interval can be put on it.')}</p>
    ${chart({ type: 'line', title: t('HR drop after hard efforts, median per quarter'), x: { label: t('quarter'), type: 'category' },
      y: { label: t('drop'), unit: 'bpm' }, series: [{ name: '60 s', points: pts('d60') }, { name: '120 s', points: pts('d120') }],
      note: t('Bigger is a faster recovery. One median per session, then the median across sessions.') })}
    <div class="table-scroll"><table><thead><tr><th>${t('Quarter')}</th><th class="num">${t('Sessions')}</th><th class="num">${t('Efforts')}</th>
      <th class="num">${t('HR at end')}</th><th class="num">${t('Drop 60 s')}</th><th class="num">${t('95% interval')}</th><th class="num">${t('Drop 120 s')}</th></tr></thead>
      <tbody>${[...tr].reverse().map(q => html`<tr><td>${q.period}</td><td class="num">${q.sessions}</td><td class="num">${q.events}</td>
        <td class="num">${Math.round(q.hr0)}</td><td class="num">${f1(q.d60)}</td>
        <td class="num dim">${q.d60_ci ? q.d60_ci[0].toFixed(0) + '–' + q.d60_ci[1].toFixed(0) : t('few sessions')}</td>
        <td class="num">${f1(q.d120)}</td></tr>`)}</tbody></table></div>
    <p class="panel-note">${t('{reps} efforts were the end of an interval rep, {peaks} a heart-rate peak in the top 10% of its run followed by a minute of easing.', { reps: kinds.r, peaks: kinds.p })}
      ${ends.length ? t.n('{n} run ended with the watch still recording a cool-down: median drop {d} bpm in 60 s (kept apart — standing still after a run is not the same minute as jogging between reps).',
        '{n} runs ended with the watch still recording a cool-down: median drop {d} bpm in 60 s (kept apart — standing still after a run is not the same minute as jogging between reps).',
        ends.length, { d: f1(I.median(ends.map(e => e[2]))) }) : t('Most runs end on the stop button, so there is no end-of-run recovery to read.')}
      ${hrMax ? t('Max HR used: {n} bpm (your highest recorded).', { n: hrMax }) : t('No max HR known yet, so every effort counts.')}
      ${t('Optical wrist HR lags and smooths fast changes; a chest strap gives the cleaner number.')}</p>`;
}

// ---------------------------------------------------------------- 2. HRV
function hrvPanel() {
  const rows = I.hrvTrend(state.wellness);
  const intro = html`<p class="panel-note">${t("The 7-day rolling mean of ln(rMSSD), against your baseline (the 60 days before that week) ± the smallest worthwhile change, half its standard deviation — the method of Plews et al. (2013). The week's coefficient of variation says how unsettled it is.")}
    ${t("Garmin's figure is an overnight average, not the waking reading those studies used: the method carries over, published thresholds do not.")}</p>`;
  if (!rows.length) return html`<section class="panel">${head(t('HRV trend'))}${intro}
    <p class="verdict">${t("No nightly HRV in the data yet (it arrives with Garmin's wellness sweep).")}</p></section>`;
  const s = I.hrvSummary(rows), last = s.last;
  const shown = rows.slice(-180);
  const ser = (name, k) => ({ name, points: shown.filter(r => r[k] != null).map(r => [r.day, +r[k].toFixed(3)]) });
  const flagged = rows.filter(r => r.flag).slice(-12).reverse();
  const p = { ms: Math.exp(last.roll).toFixed(0), ln: last.roll.toFixed(2) };
  const week = last.base == null ? t('This week: {ms} ms (ln {ln}). There are not yet 30 nights of baseline before this week to compare against.', p)
    : last.flag === 'low' ? t('This week: {ms} ms (ln {ln}), below your baseline by more than the smallest worthwhile change — the direction that goes with accumulated fatigue, illness or poor sleep, if it persists.', p)
      : last.flag === 'high' ? t('This week: {ms} ms (ln {ln}), above your baseline by more than the smallest worthwhile change.', p)
        : t('This week: {ms} ms (ln {ln}), inside your normal range.', p);
  return html`<section class="panel">${head(t('HRV trend'), t.n('{n} day with a 7-day mean', '{n} days with a 7-day mean', rows.length))}${intro}
    <p class="verdict">${week}
      ${last.cv != null ? t('Its CV is {cv}% (your median {median}%).', { cv: last.cv.toFixed(1), median: f1(s.cv_median) }) : ''}
      ${s.judged ? t('In the last {days} days: {low} below, {high} above, of {judged} days judged.', { days: s.days, low: s.low, high: s.high, judged: s.judged }) : ''}</p>
    ${chart({ type: 'line', title: t('7-day ln(rMSSD) against the baseline band'), x: { label: t('day'), type: 'time' }, y: { label: 'ln rMSSD' },
      series: [ser(t('7-day mean'), 'roll'), ser(t('baseline'), 'base'), ser(t('baseline − SWC'), 'lo'), ser(t('baseline + SWC'), 'hi')] })}
    ${chart({ type: 'line', title: t('7-day coefficient of variation'), x: { label: t('day'), type: 'time' }, y: { label: 'CV', unit: '%' },
      series: [{ name: 'CV', points: shown.filter(r => r.cv != null).map(r => [r.day, +r.cv.toFixed(2)]) }] })}
    ${flagged.length ? html`<div class="table-scroll"><table><thead><tr><th>${t('Day')}</th><th class="num">${t('7-day mean')}</th><th class="num">${t('Baseline')}</th><th>${t('Outside')}</th></tr></thead>
      <tbody>${flagged.map(r => html`<tr><td>${day(r.day, true)}</td><td class="num">${Math.exp(r.roll).toFixed(0)} ms</td>
        <td class="num dim">${Math.exp(r.base).toFixed(0)} ms</td><td class="flag-${r.flag}">${r.flag === 'low' ? t('below') : t('above')}</td></tr>`)}</tbody></table></div>
      <p class="panel-note">${t('The most recent days outside the band. One day outside means little; several in a row, with the CV rising, is the signal.')}</p>` : ''}
  </section>`;
}

// ---------------------------------------------------------------- 3. form
// The metric labels live in I.FORM_METRICS (English) and are shown through t().
// i18n-keys: Cadence | Ground contact time | Vertical ratio | Vertical oscillation | Stride length | GCT balance (left)
function formPanel(rows) {
  const f = I.formByYear(rows);
  const intro = html`<p class="panel-note">${t('Cadence, ground contact and bounce change with speed, so year-on-year averages mostly measure how fast the runs were. Here every second is binned by its pace (15 s/km bands) on level ground (under 3%), and each line follows one band across the years.')}
    ${t('Running dynamics need a chest strap, a running pod or a watch that measures them.')}</p>`;
  if (!f.bands.length) return html`${head(t('Running form at matched pace'))}${intro}
    <p class="verdict">${t('Not enough yet: a pace band needs five minutes of level running with cadence or dynamics in at least two different years.')}</p>`;
  const charts = I.FORM_METRICS.filter(([k]) => f.series[k]).map(([k, label, unit]) => chart({
    type: 'line', title: t(label), x: { label: t('year'), type: 'category' }, y: { label: t(label), unit },
    series: Object.entries(f.series[k]).map(([band, pts]) => ({ name: I.bandLabel(band) + ' /km', points: pts.map(([y, v]) => [y, +v.toFixed(k === 'stride' ? 3 : 1)]) })) }));
  const balance = f.balance.map(([y, v], i) => `${i ? ' · ' : ''}${y} ${v.toFixed(1)}%`).join('');
  return html`${head(t('Running form at matched pace'), t.n('{n} run · {from}–{to}', '{n} runs · {from}–{to}', rows.length, { from: f.years[0], to: f.years[f.years.length - 1] }))}${intro}
    <div class="multi">${charts}</div>
    ${f.balance.length ? html`<p class="panel-note">${withMarkup(t("{label} (left foot's share of contact time), per year: {years}.", { label: '\u0001', years: balance }), html`<b>${t('GCT balance')}</b>`)}
      ${f.flag ? html`<b class="flag-low">${t('Worth a look: {flag}.', { flag: f.flag })}</b> ${t('A lasting shift in balance can come from a niggle, a compensation or a change of shoe; it can also come from a new sensor.')}`
        : t('No drift worth flagging (the flag is ≥ 1.5 points off 50/50, or ≥ 1 point moved since the first year — cut-offs chosen here, not clinical ones).')}</p>`
    : html`<p class="panel-note">${t('No ground-contact balance in these streams (it needs a chest strap or pod that records it).')}</p>`}`;
}

// ---------------------------------------------------------------- 4. seasons
function seasonsPanel() {
  const c = I.seasonCurves(D.prRows(state));
  if (!c.years.length) return '';
  const cs = I.seasonCS(c);
  const series = c.years.map(y => ({ name: y, points: c.dists.filter(d => c.best[y][d]).map(d => [distLabel(d), Math.round(c.best[y][d][0] / (d / 1000))]) }));
  const csPts = cs.filter(r => r.cs).map(r => [r.year, Math.round(1000 / r.cs)]);
  return html`<section class="panel">${head(t('Seasons'), t.n('{n} year overlaid', '{n} years overlaid', c.years.length))}
    <p class="panel-note">${t('Your best pace at each distance, year by year — the fastest stretch of that length inside any run, so a fast 5K inside a long run counts. A year with fewer races simply has fewer hard efforts in it, which reads as a slower curve.')}</p>
    ${chart({ type: 'line', title: t('Best pace per distance, each year'), x: { label: t('distance'), type: 'category' },
      y: { label: t('pace'), unit: 's/km' }, series, note: t('Seconds per km: lower is faster.') })}
    <div class="table-scroll"><table><thead><tr><th>${t('Year')}</th><th class="num">${t('Critical speed')}</th><th class="num">D′</th><th class="num">${t('Efforts 2–15 min')}</th></tr></thead>
      <tbody>${[...cs].reverse().map(r => html`<tr><td>${r.year}</td><td class="num">${r.cs ? paceS(1000 / r.cs) : '--'}</td>
        <td class="num">${r.d_prime != null ? Math.round(r.d_prime) + ' m' : '--'}</td><td class="num dim">${r.points}</td></tr>`)}</tbody></table></div>
    ${csPts.length > 1 ? chart({ type: 'line', title: t('Critical speed per year'), x: { label: t('year'), type: 'category' }, y: { label: t('CS pace'), unit: 's/km' },
      series: [{ name: 'CS', points: csPts }], note: t("distance = CS × time + D′, fitted to that year's bests of 2–15 minutes. Lower is faster.") }) : ''}
    <p class="panel-note">${t('Critical speed needs three best efforts between 2 and 15 minutes in the year; with only three the fit always looks perfect, so the D′ in particular is soft.')}</p></section>`;
}

// ---------------------------------------------------------------- 5. predictors
function predictorPanel() {
  const prs = D.prRows(state), td = today(), s = D.summary(state);
  const ref = I.referenceEffort(prs, td), cs = I.recentCS(prs, td), garmin = D.latestMetrics(state)?.races || null;
  const fit = s ? s.fit : null;
  if (!fit && !ref && !cs && !garmin) return '';
  const rows = I.predictorSpread({ fit, cs, ref, garmin }, STANDARD_RACES.filter(([, d]) => d <= 42195));
  const goals = I.goalRequirements(D.races(state), td, { ref, cs });
  const cell = (v, out) => html`<td class="num${out ? ' dim' : ''}">${v != null ? fmtTime(v) + (out ? '*' : '') : '--'}</td>`;
  const b = name => html`<b>${name}</b>`;
  const models = [
    withMarkup(t('Each model answers a slightly different question; where they disagree, nobody knows better than the spread.'), ''),
    withMarkup(fit ? t('{name}: your own fitted fatigue exponent ({exp}), current form, no race-day calibration (the Races page adds that).', { name: '\u0001', exp: fit[1].toFixed(3) })
      : t('{name}: your own fitted fatigue exponent, current form, no race-day calibration (the Races page adds that).', { name: '\u0001' }), b('Riegel')),
    withMarkup(t("{name}: distance = CS × t + D′ from the last 12 months' bests; optimistic past an hour (marked *, left out of the spread).", { name: '\u0001' }), b('CS')),
    raw(esc(ref ? t('{vdot} (Daniels) and {cameron}: scaled from your best recent effort — {dist} in {time} on {day}, VDOT {v}.',
      { vdot: '\u0001', cameron: '\u0002', dist: distLabel(ref.d), time: fmtTime(ref.t), day: day(ref.day, true), v: ref.vdot.toFixed(1) })
      : t('{vdot} (Daniels) and {cameron}: scaled from your best recent effort.', { vdot: '\u0001', cameron: '\u0002' }))
      .replace('\u0001', () => String(b('VDOT'))).replace('\u0002', () => String(b('Cameron')))),
    withMarkup(t("{name}: the watch's own.", { name: '\u0001' }), b('Garmin')),
  ];
  return html`<section class="panel">${head(t('Race predictors side by side'), t('five models, one athlete'))}
    <p class="panel-note">${models.map((m, i) => html`${i ? ' ' : ''}${m}`)}</p>
    <div class="table-scroll"><table><thead><tr><th>${t('Distance')}</th><th class="num">Riegel</th><th class="num">CS</th><th class="num">VDOT</th>
      <th class="num">Cameron</th><th class="num">Garmin</th><th class="num">${t('Spread')}</th></tr></thead>
      <tbody>${rows.map(r => html`<tr><td>${t(r.label)}</td>${cell(r.riegel)}${cell(r.cs, r.cs_out)}${cell(r.vdot)}${cell(r.cameron)}${cell(r.garmin)}
        <td class="num">${r.spread_pct != null ? html`${fmtTime(r.hi - r.lo)} <span class="dim">(${pct(r.spread_pct)})</span>` : '--'}</td></tr>`)}</tbody></table></div>
    ${goals.length ? html`<p class="eyebrow" style="margin-top:16px">${t('What your goals ask for')}</p>
      <div class="table-scroll"><table><thead><tr><th>${t('Race')}</th><th class="num">${t('Goal')}</th><th class="num">${t('VDOT needed')}</th><th class="num">${t('now')}</th>
        <th class="num">${t('CS needed')}</th><th class="num">${t('now')}</th></tr></thead>
        <tbody>${goals.map(g => html`<tr><td>${link('race/' + g.id, g.name || distLabel(g.d))} <span class="dim">${day(g.date, true)}</span></td>
          <td class="num">${fmtTime(g.goal)}</td>
          <td class="num ${g.cur_vdot != null ? (g.req_vdot <= g.cur_vdot ? 'ahead' : 'behind') : ''}">${f1(g.req_vdot)}</td><td class="num dim">${f1(g.cur_vdot)}</td>
          <td class="num ${g.req_cs && g.cur_cs ? (g.req_cs <= g.cur_cs ? 'ahead' : 'behind') : ''}">${g.req_cs ? paceS(1000 / g.req_cs) : '--'}</td>
          <td class="num dim">${g.cur_cs ? paceS(1000 / g.cur_cs) : '--'}</td></tr>`)}</tbody></table></div>
      <p class="panel-note">${t('Critical speed is shown as a pace. Races over an hour have no CS requirement from the model; for a marathon it uses the ~85% of CS recreational marathoners ran at in Smyth & Muniz-Pumares (2020) — a population average, not your ratio.')}
        ${t("“Now” is the best recent effort's VDOT and the last 12 months' CS.")}</p>` : ''}
  </section>`;
}

// ---------------------------------------------------------------- 6. climbs
function climbsPanel(rows) {
  const intro = html`<p class="panel-note">${t("Hills found in each run's elevation, smoothed over 100 m: at least 300 m long at 3% or more, with small dips inside forgiven. Category is the cycling length × grade score (Cat 4 from 8000 m·%, HC from 80000), so most running hills are honestly uncategorised; FIETS is height² ÷ (10 × length), plus the altitude bonus above 1000 m.")}
    ${t('The same climb is recognised again by a start within 50 m and a top within 100 m.')}</p>`;
  const all = rows.flatMap(r => r.c);
  if (!all.length) return html`${head(t('Climbs'))}${intro}<p class="verdict">${t('No climbs found in the streams on this device.')}</p>`;
  const cat = I.climbCatalogue(rows), byId = id => state.activities[id];
  const repeated = cat.filter(c => c.n >= 2).sort((a, b) => b.n - a.n).slice(0, 10);
  const steep = [...cat].sort((a, b) => b.grade - a.grade).slice(0, 8);
  const ge = I.gradeEfficiencyByYear(rows);
  const name = c => {
    const e = c.efforts[0], a = byId(e.id);
    const p = { len: Math.round(c.len), grade: c.grade.toFixed(1), run: a ? a.name || t('a run') : '', day: day(e.date, true) };
    if (!a) return t('{len} m at {grade}%', p);
    return e.km != null ? t('{len} m at {grade}% · km {km} of {run}, {day}', { ...p, km: e.km.toFixed(1) }) : t('{len} m at {grade}% · {run}, {day}', p);
  };
  const climbRow = c => html`<tr><td>${name(c)}</td><td class="num">${c.n}</td><td class="num">${Math.round(c.gain)} m</td>
    <td class="num">${f1(c.max_grade)}%</td><td>${c.cat || html`<span class="dim">—</span>`}</td><td class="num">${c.fiets != null ? c.fiets.toFixed(2) : '--'}</td>
    <td class="num">${c.best ? html`${link('activity/' + c.best.id, fmtTime(c.best.secs))} <span class="dim">${c.best.vam ? c.best.vam + ' m/h' : ''}</span>` : '--'}</td>
    <td class="dim">${c.by_year.map(([y, s]) => `${y} ${fmtTime(s)}`).join(' · ')}</td></tr>`;
  const thead = html`<thead><tr><th>${t('Climb')}</th><th class="num">${t('Runs')}</th><th class="num">${t('Gain')}</th><th class="num">${t('Max')}</th><th>${t('Cat')}</th><th class="num">FIETS</th>
    <th class="num">${t('Best (VAM)')}</th><th>${t('Best per year')}</th></tr></thead>`;
  const runsWith = rows.filter(r => r.c.length).length;
  return html`${head(t('Climbs'), t('{climbs} climbs in {runs} runs · {distinct} distinct', { climbs: all.length, runs: runsWith, distinct: cat.length }))}${intro}
    ${repeated.length ? html`<p class="eyebrow">${t('Most repeated')}</p><div class="table-scroll"><table>${thead}<tbody>${repeated.map(climbRow)}</tbody></table></div>` : ''}
    <p class="eyebrow" style="margin-top:14px">${t('Steepest')}</p><div class="table-scroll"><table>${thead}<tbody>${steep.map(climbRow)}</tbody></table></div>
    ${ge.length ? html`<p class="eyebrow" style="margin-top:14px">${t('Uphill and downhill against the flat')}</p>
      <div class="table-scroll"><table><thead><tr><th>${t('Year')}</th><th class="num">${t('Runs')}</th><th class="num">${t('Uphill')}</th><th class="num">${t('Downhill')}</th></tr></thead>
        <tbody>${[...ge].reverse().map(g => html`<tr><td>${g.year}</td><td class="num">${g.n}</td><td class="num">${g.up.toFixed(2)}</td><td class="num">${g.down.toFixed(2)}</td></tr>`)}</tbody></table></div>
      <p class="panel-note">${t("Grade-adjusted speed per heartbeat on climbs (and descents) over 3%, divided by the same on the flat in that run; median per year. Over 1 means you make more of that ground than Minetti's energy-cost model expects for your heart rate.")}
        ${t('HR lags the gradient by 20–30 s, which flatters short climbs and penalises the descent after them: a trend over many runs, not a verdict on one.')}</p>` : ''}
    <p class="panel-note">${t('Times run from the foot to the top of the smoothed profile and include any pause on the way. VAM is metres climbed per hour.')}</p>`;
}

// ---------------------------------------------------------------- 7. time of day, sleep timing
function timePanel() {
  const rows = D.runs(state).filter(a => !D.isVirtual(a) && RUN_TYPES.has(a.type)).map(a => {
    const raw0 = state.activities[a.id], w = state.weather[a.id] || {};
    return { start: String(raw0?.start || ''), pace: a.distance_m && a.moving_s ? a.moving_s / (a.distance_m / 1000) : null, hr: a.avg_hr,
      temp_c: w.temp_c ?? null, humidity: w.humidity ?? null, dew_point_c: w.dew_point_c ?? null,
      steady: (a.distance_m || 0) >= 3000 && !state.derived[a.id]?.session };
  });
  const sleepPart = sleepPanel();
  if (!rows.length) return html`<section class="panel">${head(t('When you run'))}<p class="verdict">${t('No runs yet.')}</p>${sleepPart}</section>`;
  const tod = I.timeOfDay(rows), maxC = Math.max(1, ...tod.grid.flat());
  const days = tod.grid.map((_, w) => weekdayName(w));
  const cellBg = n => (n ? `background: color-mix(in srgb, var(--measured) ${Math.round(15 + 85 * n / maxC)}%, transparent)` : '');
  const grp = (list, label) => {
    const shown = list.filter(x => x.pace != null);
    if (shown.length < 2) return '';
    const best = Math.min(...shown.map(x => x.pace));
    return html`<div class="table-scroll"><table><thead><tr><th>${label}</th><th class="num">${t('Steady runs')}</th><th class="num">${t('Pace, heat-corrected')}</th>
      <th class="num">${t('95% interval')}</th><th class="num">${t('vs best')}</th><th class="num">${t('Avg HR')}</th></tr></thead>
      <tbody>${shown.map(x => html`<tr><td>${x.label}</td><td class="num">${x.n}</td><td class="num">${paceS(x.pace)}</td>
        <td class="num dim">${x.pace_ci ? fmtTime(x.pace_ci[0]) + '–' + fmtTime(x.pace_ci[1]) : t('few runs')}</td>
        <td class="num">${x.pace === best ? '—' : '+' + Math.round(x.pace - best) + ' s'}</td><td class="num">${x.hr != null ? Math.round(x.hr) : '--'}</td></tr>`)}</tbody></table></div>`;
  };
  return html`<section class="panel">${head(t('When you run'), t.n('{n} run by start hour and weekday', '{n} runs by start hour and weekday', tod.total))}
    <div class="table-scroll"><table class="tod" aria-label="${t('Runs by weekday and start hour')}">
      <thead><tr><th></th>${Array.from({ length: 24 }, (_, h) => html`<th>${h % 3 === 0 ? h : ''}</th>`)}</tr></thead>
      <tbody>${tod.grid.map((row, w) => html`<tr><th>${days[w]}</th>${row.map((n, h) => html`<td style="${cellBg(n)}" title="${t.n('{day} {hour}:00 — {n} run', '{day} {hour}:00 — {n} runs', n, { day: days[w], hour: h })}"></td>`)}</tr>`)}</tbody>
    </table></div>
    <p class="panel-note">${t('Below: median pace corrected to neutral weather (the same heat penalty the weather pages use) and median HR, by start hour and by weekday — steady runs only (3 km and up, no interval session found), and only where there are five or more.')}
      ${t('The comparison is confounded by what you do when: long runs at the weekend, easy runs before work. A difference here says when your runs are quicker, not that the hour makes them so.')}</p>
    ${grp(tod.hours, t('Start hour'))}${grp(tod.weekdays.map((x, w) => ({ ...x, label: days[w] })), t('Weekday'))}
    ${sleepPart}</section>`;
}
function sleepPanel() {
  const s = I.sleepTiming(state.daily);
  if (!s.present) return html`<p class="eyebrow" style="margin-top:16px">${t('Sleep timing')}</p>
    <p class="panel-note">${t('Not in the data.')} ${s.fields.length
      ? t("Garmin's daily rows here carry how much and how well you slept ({fields}), and the nightly hours and score, but no bedtime or wake time, so bedtime regularity cannot be worked out.", { fields: s.fields.join(', ') })
      : t('There is no sleep data yet, and the rows Garmin sends carry sleep amounts and scores, but no bedtime or wake time, so bedtime regularity cannot be worked out.')}
      ${t('It will appear here once the import keeps them.')}</p>`;
  if (!s.bed_sd) return html`<p class="panel-note">${t('Sleep timing: only {n} nights with a bedtime and a wake time so far; it takes a week.', { n: s.n })}</p>`;
  const hm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m % 60)).padStart(2, '0')}`;
  const jl = s.jetlag == null ? ''
    : s.jetlag >= 0 ? t('Mid-sleep is {n} min later at weekends ("social jet lag").', { n: Math.abs(Math.round(s.jetlag)) })
      : t('Mid-sleep is {n} min earlier at weekends ("social jet lag").', { n: Math.abs(Math.round(s.jetlag)) });
  return html`<p class="eyebrow" style="margin-top:16px">${t('Sleep timing')}</p>
    <p class="verdict">${t('Usual bedtime {bed} (± {bed_sd} min), wake {wake} (± {wake_sd} min) over {n} nights.',
      { bed: hm(s.bed), bed_sd: Math.round(s.bed_sd), wake: hm(s.wake), wake_sd: Math.round(s.wake_sd), n: s.n })}
      ${jl}</p>`;
}

// ---------------------------------------------------------------- the stream pass
let _scan = null;     // {key, streams, res}: this session's result, so a revisit renders at once
// New activities or a re-derive (sessions feed the HRR reps) invalidate it.
const scanKey = () => `${Object.keys(state.activities).length}:${Object.values(state.derived).filter(d => d.session).length}`;
const hostIds = ['ins-hrr', 'ins-form', 'ins-climbs'];
function streamPanels(res, source = t('from the streams on this device')) {
  return [hrrPanel(res.hrr, source), formPanel(res.form), climbsPanel(res.climbs)];
}
// A phone has no streams. If derive.js keeps the compact HRR core (state.derived[id].hrr =
// [n, d60, d120, hr0]), the HRR panel can still draw from it; form and climbs cannot.
function coreHrrRows() {
  const out = [];
  for (const a of D.runs(state)) {
    const h = state.derived[a.id]?.hrr;
    if (Array.isArray(h) && h[1] != null) out.push({ id: a.id, date: dayKey(a.start), e: [['r', h[3], h[1], h[2]]] });
  }
  return out;
}

export function render() {
  useCss('insights', CSS);
  const hasAny = Object.keys(state.activities).length || Object.keys(state.wellness).length;
  if (!hasAny) return html`${pageHead(t('Insights'))}${emptyState(t('Nothing to analyse yet'),
    t("Insights reads your runs, their streams and Garmin's nightly data. Bring some in from the Sync page."), link('sync', t('Sync & cowork'), 'btn'))}`;
  const ready = _scan && _scan.key === scanKey() ? _scan.res : null;
  const panels = ready ? streamPanels(ready) : null;
  const pending = html`<p class="progress">${t('Reading the streams on this device…')}</p>`;
  const placeholder = (id, eyebrow) => html`<section class="panel" id="${id}">${panels ? panels[hostIds.indexOf(id)] : html`${head(eyebrow)}${pending}`}</section>`;
  return html`<div class="ins">${pageHead(t('Insights'), t('Recovery, HRV, form, seasons, predictors, climbs and timing — each with its caveats'))}
    ${placeholder('ins-hrr', t('Heart-rate recovery'))}
    ${hrvPanel()}
    ${placeholder('ins-form', t('Running form at matched pace'))}
    ${seasonsPanel()}
    ${predictorPanel()}
    ${placeholder('ins-climbs', t('Climbs'))}
    ${timePanel()}</div>`;
}

export function mount(el) {
  let cancelled = false;
  (async () => {
    const hosts = hostIds.map(id => el.querySelector('#' + id));
    if (!hosts[0]) return;
    let ids = [];
    try { ids = (await streamIds()) || []; } catch { ids = []; }
    if (_scan && _scan.key === scanKey() && _scan.streams === ids.length) return;   // drawn by render() already
    const have = new Set(ids);
    const items = D.runs(state).filter(a => have.has(a.id)).map(a => ({ id: a.id, date: dayKey(a.start), virtual: D.isVirtual(a), hasSession: !!state.derived[a.id]?.session }));
    if (!items.length) {
      const core = coreHrrRows();
      const none = html`<p class="verdict">${t('No streams on this device. These panels read the per-second data, which stays on the computer that imported it — open Insights there.')}</p>`;
      hosts[0].innerHTML = String(html`${core.length ? hrrPanel(core, t('from the synced per-run summary')) : html`${head(t('Heart-rate recovery'))}${none}`}`);
      hosts[1].innerHTML = String(html`${head(t('Running form at matched pace'))}${none}`);
      hosts[2].innerHTML = String(html`${head(t('Climbs'))}${none}`);
      return;
    }
    const prog = hosts.map(h => h.querySelector('.progress'));
    const io = {
      getCache: k => idbGet('cache', k), setCache: (k, v) => idbSet('cache', k, v), getStream,
      samples: rec => [samplesFromChannels(rec.channels), rec.channels || {}],
      getReps: async id => (await D.getDetail(id).catch(() => null))?.session?.reps || null,
      yield: () => new Promise(r => setTimeout(r, 0)),
      stop: () => cancelled || !el.isConnected,
    };
    const res = await I.scanActivities(items, io, (n, of) => {
      if (n % 10 === 0 || n === of) prog.forEach(p => { if (p) p.textContent = t('Reading the streams on this device… {n} / {of}', { n, of }); });
    });
    if (cancelled || !el.isConnected) return;
    _scan = { key: scanKey(), streams: ids.length, res };
    streamPanels(res).forEach((p, i) => { if (hosts[i].isConnected) hosts[i].innerHTML = String(p); });
  })().catch(e => console.warn('insights scan failed', e));
  return () => { cancelled = true; };
}
