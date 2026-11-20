// Everything the watch records off the run: which daily signals move with training,
// how the nights are built, what is drifting, and the days the body was elsewhere.
import { state, streamIds, getStream } from '../store.js';
import * as D from '../derive.js';
import { html, raw, esc, t, day, pageHead, useCss } from '../ui.js';
import { fmt } from '../i18n.js';
import * as J from '../journal.js';
import { HIGHER_IS_WORSE, MIN_POINTS } from '../lib/vitals.js';

export const title = 'Vitals';

const CSS = `
.rbar { display: inline-block; height: 10px; border-radius: 5px; vertical-align: 1px; max-width: 120px; }
.rbar.pos { background: var(--measured); }
.rbar.neg { background: var(--behind); }
.rnum { font-family: var(--mono); font-size: 13px; }
.stages { display: flex; height: 26px; border-radius: 4px; overflow: hidden; margin: 10px 0 6px; }
.stages i { display: block; height: 100%; }
.st-deep { background: var(--ink); } .st-light { background: var(--measured); }
.st-rem { background: var(--projected); }
.chip { display: inline-block; font-family: var(--mono); font-size: 11px; padding: 2px 7px; border-radius: 10px;
  background: var(--track); color: var(--muted); margin: 2px 3px 2px 0; }
.odd-day { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px solid var(--line); }
.odd-day b { font-family: var(--mono); }
.odd-day .chips { margin-left: auto; }
`;

const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : '');
// Numbers in the reader's own format where font.js is there.
const nf = (v, d) => (fmt() ? fmt().number(Number(v || 0), { min: d, max: d }) : Number(v || 0).toFixed(d));
const sgn = (v, d) => (v >= 0 ? '+' : '') + nf(v, d);
const pctOf = (v, d) => (fmt() ? fmt().percent(v || 0, d) : ((v || 0) * 100).toFixed(d) + '%');
const list = xs => (fmt() ? fmt().list(xs) : xs.join(', '));
// A metric's English label (kept on the finding) in the reader's language.
const metricText = l => t(l || '');
// A whole translated sentence with one piece of markup put in where {mark} is.
// The sentence comes from t() with {mark: MARK}; the markup goes in after escaping.
const MARK = '\u0001';
const withMark = (text, markup) => raw(esc(text).replace(MARK, markup));
const LAG = () => ({ 0: t('same day'), 1: t('next day'), 2: t('two days later') });

function correlations(report) {
  const co = report.correlations || {}, findings = co.findings || [], tested = co.tested || 0;
  const crit = co.critical_r != null ? nf(co.critical_r, 2) : '--';
  const lags = LAG();
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">${t('What actually responds to your training')}</p>
      <p class="panel-note">${t.n('{n} metric', '{n} metrics', report.metrics)} · ${t.n('{n} day', '{n} days', report.days)} · ${t.n('{n} correlation tested', '{n} correlations tested', tested)}</p>
    </div>
    <div class="empty">
      <p>${t('Your watch records two dozen things a day. For any given person about three of them genuinely move with training, and which three is individual. These are yours.')}</p>
    </div>
    ${findings.length ? html`<div class="table-scroll"><table>
      <thead><tr><th>${t('Signal')}</th><th>${t('When')}</th><th class="num">r</th><th></th></tr></thead>
      <tbody>${findings.map(f => html`
        <tr>
          <td><b>${cap(metricText(f.label))}</b></td>
          <td class="dim">${lags[f.lag] || t('a week later')}</td>
          <td class="num rnum ${f.r > 0 ? 'ahead' : 'behind'}">${sgn(f.r, 2)}</td>
          <td><span class="rbar ${f.r > 0 ? 'pos' : 'neg'}" style="width:${Math.round(Math.abs(f.r) * 120)}px"></span></td>
        </tr>
        <tr><td colspan="4" class="stat-hint" style="padding-top:0">${f.note || ''}</td></tr>`)}
      </tbody></table></div>`
    : html`<p class="verdict">${t('Nothing clears the bar. With {n} tests run, a correlation has to reach {r} before it is worth believing, and none of yours does.', { n: tested, r: crit })}</p>`}

    <p class="stat-hint" style="margin-top:14px">
      ${withMark(t('Testing {n} correlations at the usual 5% threshold would throw up about {expected} false positives from noise alone — and in fact {hits} of yours would have cleared that bar. Everything above is corrected for the number of tests, so the threshold is {mark} instead.',
        { n: tested, expected: Math.round(tested * 0.05), hits: co.uncorrected || 0, mark: MARK }), `<strong>r &gt; ${esc(crit)}</strong>`)}
    </p>
    <p class="stat-hint">
      ${t('Two honest caveats. Hard days cluster and bad nights cluster, so your days are not independent and the real evidence is weaker than the arithmetic suggests. And correlation is not causation: a daily record cannot tell you which way the arrow points. Read these as dials worth glancing at, not as findings.')}
    </p>
    ${co.mechanical && co.mechanical.length ? html`<p class="stat-hint" style="margin-top:12px">
        ${t('Left out as arithmetic rather than insight:')}
        ${co.mechanical.map(m => html`<span class="chip">${metricText(m.label)} ${sgn(m.r, 2)}</span>`)}
        ${t('Calories and step counts rise on days you run further because that is what they measure.')}
      </p>` : ''}
  </section>`;
}

function sleep(s) {
  const pct = (v, d) => ((v || 0) * 100).toFixed(d);
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">${t('How your nights are built')}</p>
      <p class="panel-note">${t.n('{n} night', '{n} nights', s.nights)} · ${t('{h} h asleep on average', { h: nf((s.asleep_s || 0) / 3600, 1) })}</p>
    </div>
    <div class="stages">
      <i class="st-deep" style="width:${pct(s.deep_share, 1)}%"></i>
      <i class="st-light" style="width:${pct(s.light_share, 1)}%"></i>
      <i class="st-rem" style="width:${pct(s.rem_share, 1)}%"></i>
    </div>
    <div class="polar-key">
      <span><i class="st-deep"></i>${t('Deep {pct}', { pct: pctOf(s.deep_share, 0) })}</span>
      <span><i class="st-light"></i>${t('Light {pct}', { pct: pctOf(s.light_share, 0) })}</span>
      <span><i class="st-rem"></i>${t('REM {pct}', { pct: pctOf(s.rem_share, 0) })}</span>
    </div>
    <p class="verdict" style="margin-top:12px">${s.note || ''}</p>
    <p class="stat-hint">${s.deep_typical && s.rem_typical
      ? t('Adults typically run 13–23% deep and 20–25% REM. Yours are both inside those ranges.')
      : t('Adults typically run 13–23% deep and 20–25% REM. Yours are not both inside those ranges.')}</p>
  </section>`;
}

function trends(rows) {
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">${t('Which way things are heading')}</p>
      <p class="panel-note">${t('last fortnight against the one before')}</p>
    </div>
    <div class="table-scroll"><table>
      <thead><tr><th>${t('Metric')}</th><th class="num">${t('Before')}</th><th class="num">${t('Recent')}</th><th class="num">${t('Change')}</th><th></th></tr></thead>
      <tbody>${rows.map(row => html`<tr>
        <td>${cap(metricText(row.label))}</td>
        <td class="num dim">${nf(row.before, 1)}</td>
        <td class="num actual">${nf(row.recent, 1)}</td>
        <td class="num ${row.better === true ? 'ahead' : row.better === false ? 'behind' : 'dim'}">${sgn(row.change, 1)}</td>
        <td class="dim">${row.notable ? t('notable') : ''}</td>
      </tr>`)}</tbody>
    </table></div>
    <p class="stat-hint" style="margin-top:10px">
      ${t('“Notable” means the change is more than half the metric’s own spread — a blunt filter, but it stops a number wobbling by its usual amount from looking like a development.')}
    </p>
  </section>`;
}

function oddDays(rows) {
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">${t('Days your body was somewhere else')}</p>
      <p class="panel-note">${t('unusual across several signals at once')}</p>
    </div>
    <div class="empty"><p>${t('One metric out of range is noise. Three or four at once, on the same day, is the day you were coming down with something — and no single chart can show you that.')}</p></div>
    ${rows.map(o => html`<div class="odd-day">
      <b>${day(o.day, true)}</b><span class="dim">${t.n('{n} signal', '{n} signals', o.count)}</span>
      <span class="chips">${(o.metrics || []).map(m => html`<span class="chip">${metricText(m.label)} ${sgn(m.z, 1)}σ</span>`)}</span>
    </div>`)}
    <p class="stat-hint" style="margin-top:12px">
      ${t('Days when you simply ran further are excluded — calories and step counts spiking on a long run is not your body being unusual.')}
    </p>
  </section>`;
}

// The coverage panel: which per-sample channels the watches record. The server
//    read it from SQLite; here it comes from the streams on THIS device, so it is
//    filled in after render (reading every stream is slow) and simply absent on a
//    phone that never downloaded one.
function coverageMarkup(cov) {
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">${t('What your watches actually record')}</p>
      <p class="panel-note">${t('per-sample channels, and how many runs carry them')}</p>
    </div>
    <div class="empty"><p>${t('Every channel the device reports is stored, named or not. This is what makes the analysis above possible, and it changes the day you buy a new watch or put on a chest strap.')}</p></div>
    ${cov.map(([name, count]) => html`<span class="chip">${name} · ${count}</span>`)}
  </section>`;
}

let _cov = null;   // {n, rows}: recomputed when the number of streams changes
async function channelCoverage() {
  const ids = await streamIds();
  if (!ids || !ids.length) return [];
  if (_cov && _cov.n === ids.length) return _cov.rows;
  const counts = {};
  for (const id of ids) {
    const rec = await getStream(id);
    for (const [name, vals] of Object.entries(rec?.channels || {})) {
      if (name === 'seconds' || name === 'metres' || !Array.isArray(vals)) continue;
      if (vals.some(v => v != null)) counts[name] = (counts[name] || 0) + 1;
    }
  }
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  _cov = { n: ids.length, rows };
  return rows;
}

// ---- the journal against the watch ----
// The section above asks what the body does after training. This one asks what it does
// after the things only the athlete can report -- a late coffee, a long flight, a bad
// week at work -- and whether the felt effort of a run lines up with the night around it.
// Same machinery (vitals.js pearson/criticalR, Bonferroni over every test actually run),
// and the same caution, more so: tags are sparse, chosen after the fact, and cluster.
const JLAG = () => ({ 0: t('same day'), 1: t('next day') });
const fmtV = v => (v == null ? '--' : Math.abs(v) >= 10 ? nf(v, 0) : nf(v, 1));

function journalFindingNote(f) {
  const worse = (f.r > 0) === HIGHER_IS_WORSE.has(f.metric);
  const p = { metric: metricText(f.metricLabel), signal: J.signalText(f.signal), r: sgn(f.r, 2) };
  if (f.diff) {
    const q = { ...p, on: fmtV(f.diff.on), off: fmtV(f.diff.off), nOn: f.diff.n_on, nOff: f.diff.n_off };
    const first = f.lag === 0
      ? t('Your {metric} averages {on} on the same day as a day tagged {signal} ({nOn} days) against {off} otherwise ({nOff} days).', q)
      : t('Your {metric} averages {on} the day after a day tagged {signal} ({nOn} days) against {off} otherwise ({nOff} days).', q);
    return `${first} ${worse ? t('That is the direction that costs you.') : t('That is the direction you would hope for.')}`;
  }
  const q = { ...p, n: f.days };
  if (f.lag === 0) return f.r > 0
    ? t('Your {metric} rises on the same day as a day with higher {signal} (r = {r}, {n} days).', q)
    : t('Your {metric} falls on the same day as a day with higher {signal} (r = {r}, {n} days).', q);
  return f.r > 0
    ? t('Your {metric} rises the day after a day with higher {signal} (r = {r}, {n} days).', q)
    : t('Your {metric} falls the day after a day with higher {signal} (r = {r}, {n} days).', q);
}

function journalCorrelationsPanel(jc) {
  const crit = jc.critical_r != null ? nf(jc.critical_r, 2) : '--';
  const tagNames = Object.keys(jc.tags).map(k => k.slice(4));
  const rare = Object.entries(jc.tagCounts).filter(([k]) => !jc.tags[k]).map(([k, n]) => `${J.tagText(k.slice(4))} (${n})`);
  const lags = JLAG();
  const rateLink = `<a class="quiet-link" href="#/journal">${esc(t('Rate a few more runs'))}</a>`;
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">${t('What your journal lines up with')}</p>
      <p class="panel-note">${t.n('{n} journaled day', '{n} journaled days', jc.journaledDays)} · ${t.n('{n} correlation tested', '{n} correlations tested', jc.tested)} · ${t('exploratory')}</p>
    </div>
    <div class="empty"><p>${t('Your own entries — effort, feel and the tags on runs and days — against what the watch measured that day and the next: HRV, resting heart rate, sleep score, body battery and stress.')}</p></div>
    ${!jc.tested ? html`<p class="verdict">${withMark(t('Not enough overlap yet. Each pairing needs {n} days with both a journal entry and a watch reading, and none has that many. {mark}, and tag the days that were unusual.',
        { n: MIN_POINTS, mark: MARK }), rateLink)}</p>`
    : jc.findings.length ? html`<div class="table-scroll"><table>
      <thead><tr><th>${t('Journal')}</th><th>${t('Watch')}</th><th>${t('When')}</th><th class="num">r</th><th></th></tr></thead>
      <tbody>${jc.findings.map(f => html`
        <tr>
          <td><b>${cap(J.signalText(f.signal))}</b></td>
          <td>${metricText(f.metricLabel)}</td>
          <td class="dim">${lags[f.lag]}</td>
          <td class="num rnum ${f.r > 0 ? 'ahead' : 'behind'}">${sgn(f.r, 2)}</td>
          <td><span class="rbar ${f.r > 0 ? 'pos' : 'neg'}" style="width:${Math.round(Math.abs(f.r) * 120)}px"></span></td>
        </tr>
        <tr><td colspan="5" class="stat-hint" style="padding-top:0">${journalFindingNote(f)}</td></tr>`)}
      </tbody></table></div>`
    : html`<p class="verdict">${t("Nothing clears the bar. With {n} tests run, a correlation has to reach {r} before it is worth believing, and none of your journal's does.", { n: jc.tested, r: crit })}</p>`}
    ${jc.tested ? html`<p class="stat-hint" style="margin-top:14px">
      ${withMark(t('Corrected for all {n} tests, so the threshold is {mark}; uncorrected, {hits} would have looked significant, against about {expected} expected from noise alone.',
        { n: jc.tested, hits: jc.uncorrected, expected: Math.round(jc.tested * 0.05), mark: MARK }), `<strong>r &gt; ${esc(crit)}</strong>`)}</p>` : ''}
    <p class="stat-hint">${withMark(t('Exploratory, and weaker than it looks: days are not independent (bad nights and hard weeks cluster), tags are things you chose to write down — often {mark} the day felt off — and a tag only counts as absent on days you journaled something. None of this says which way the arrow points.', { mark: MARK }), `<em>${esc(t('because'))}</em>`)}</p>
    <p class="stat-hint">${tagNames.length ? html`${t('Tags tested:')} ${tagNames.map(x => html`<span class="chip">${J.tagText(x)}</span>`)}` : t('No tag is common enough to test yet.')}
      ${rare.length ? html` ${t('Too rare to test (need {n} days with and without): {tags}.', { n: J.MIN_TAG_DAYS, tags: list(rare) })}` : ''}</p>
  </section>`;
}

// Predictor labels are English in journal.js PREDICTORS (its i18n-keys list them).
function predictorsPanel(p) {
  const t0 = p.results.find(x => x.threshold != null);
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">${t('What predicts a good run')}</p>
      <p class="panel-note">${t.n('{n} run with a feel rating', '{n} runs with a feel rating', p.n)}</p>
    </div>
    ${p.needed ? html`<div class="empty"><p>${p.n
        ? t('How a run felt (1–5 in the journal) against the night before, the weather and the week behind it. That needs at least {min} rated runs; you have {n}, so {more} more.', { min: J.MIN_FEEL_RUNS, n: p.n, more: p.needed })
        : t('How a run felt (1–5 in the journal) against the night before, the weather and the week behind it. That needs at least {min} rated runs; you have none yet.', { min: J.MIN_FEEL_RUNS })}</p></div>
        <a class="btn btn-ghost" href="#/journal">${t('Rate your runs')}</a>`
    : !p.results.length ? html`<p class="verdict">${t.n("{n} rated run, but too few of them have the night before, the weather or the week's load recorded to test anything yet.",
        "{n} rated runs, but too few of them have the night before, the weather or the week's load recorded to test anything yet.", p.n)}</p>`
    : html`<div class="table-scroll"><table>
        <thead><tr><th>${t('Before the run')}</th><th class="num">${t('Runs')}</th><th class="num">${t('r with feel')}</th><th class="num">${t('95% interval')}</th><th></th></tr></thead>
        <tbody>${p.results.map(x => html`<tr>
          <td>${cap(t(x.label))}</td>
          <td class="num dim">${x.n}</td>
          <td class="num rnum ${x.clears ? (x.r > 0 ? 'ahead' : 'behind') : 'dim'}">${x.r == null ? '--' : sgn(x.r, 2)}</td>
          <td class="num dim">${x.ci ? t('{lo} to {hi}', { lo: sgn(x.ci[0], 2), hi: sgn(x.ci[1], 2) }) : '--'}</td>
          <td class="dim">${x.clears ? t('clears the bar') : ''}</td>
        </tr>`)}</tbody></table></div>
      <p class="stat-hint" style="margin-top:10px">${t0
        ? t('“Clears the bar” means past the threshold corrected for the {n} predictors tested (about r = {r} at {runs} runs).', { n: p.tested, r: nf(t0.threshold, 2), runs: t0.n })
        : t('“Clears the bar” means past the threshold corrected for the {n} predictors tested.', { n: p.tested })}
        ${t('The interval is uncorrected and shows how wide the uncertainty still is: an interval that spans zero is a shrug, whatever the r.')}</p>
      <p class="stat-hint">${t("Feel is a five-point rating, so this is a rough fit. The night before is the one Garmin files under the run's morning; load is the model's, summed over the seven days before. These predictors move together (a hard week costs sleep and HRV at once), so two of them lighting up may be one effect. Association only.")}</p>`}
  </section>`;
}

export function render() {
  useCss('vitals', CSS);
  const report = D.vitalsReport(state);
  const journal = html`${journalCorrelationsPanel(J.journalCorrelations(D.dailyRows(state), J.journalDaily(state)))}
    ${predictorsPanel(J.runPredictors(J.feelRuns(state)))}`;
  const head = pageHead(t('Vitals'), t('Everything the watch records off the run'),
    html`<a class="btn btn-ghost" href="#/journal">${t('Journal')}</a> <a class="btn btn-ghost" href="#/durability">${t('Durability')}</a>`);
  if (!report) return html`${head}
    <section class="panel">
      <div class="panel-head"><p class="eyebrow">${t('Not enough days yet')}</p></div>
      <div class="empty">
        <p>${t('This page needs a few weeks of daily data — stress, sleep stages, body battery, blood oxygen, body mass — before any of it can be told apart from noise. Sync once the watch has been worn a while.')}</p>
      </div>
      <a class="btn" href="#/sync">${t('Set up sync')}</a>
    </section>
    ${journal}
    <div id="vitals-coverage"></div>`;
  return html`${head}
    ${correlations(report)}
    ${journal}
    ${report.sleep ? sleep(report.sleep) : ''}
    ${report.trends && report.trends.length ? trends(report.trends) : ''}
    ${report.odd_days && report.odd_days.length ? oddDays(report.odd_days) : ''}
    <div id="vitals-coverage"></div>`;
}

export async function mount(el) {
  const host = el.querySelector('#vitals-coverage');
  if (!host) return;
  try {
    const cov = await channelCoverage();
    if (cov.length && host.isConnected) host.innerHTML = String(coverageMarkup(cov));
  } catch (e) { console.warn('channel coverage failed', e); }
}
