// Everything the watch records off the run: which daily signals move with training,
// how the nights are built, what is drifting, and the days the body was elsewhere.
import { state, streamIds, getStream } from '../store.js';
import * as D from '../derive.js';
import { html, pageHead, useCss } from '../ui.js';
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
const sgn = (v, d) => (v >= 0 ? '+' : '') + Number(v || 0).toFixed(d);
const LAG = { 0: 'same day', 1: 'next day', 2: 'two days later' };

function correlations(report) {
  const co = report.correlations || {}, findings = co.findings || [], tested = co.tested || 0;
  const crit = co.critical_r != null ? co.critical_r.toFixed(2) : '--';
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">What actually responds to your training</p>
      <p class="panel-note">${report.metrics} metrics · ${report.days} days · ${tested} correlations tested</p>
    </div>
    <div class="empty">
      <p>Your watch records two dozen things a day. For any given person about
        three of them genuinely move with training, and which three is
        individual. These are yours.</p>
    </div>
    ${findings.length ? html`<div class="table-scroll"><table>
      <thead><tr><th>Signal</th><th>When</th><th class="num">r</th><th></th></tr></thead>
      <tbody>${findings.map(f => html`
        <tr>
          <td><b>${cap(f.label)}</b></td>
          <td class="dim">${LAG[f.lag] || 'a week later'}</td>
          <td class="num rnum ${f.r > 0 ? 'ahead' : 'behind'}">${sgn(f.r, 2)}</td>
          <td><span class="rbar ${f.r > 0 ? 'pos' : 'neg'}" style="width:${Math.round(Math.abs(f.r) * 120)}px"></span></td>
        </tr>
        <tr><td colspan="4" class="stat-hint" style="padding-top:0">${f.note || ''}</td></tr>`)}
      </tbody></table></div>`
    : html`<p class="verdict">Nothing clears the bar. With ${tested} tests run,
        a correlation has to reach ${crit} before it
        is worth believing, and none of yours does.</p>`}

    <p class="stat-hint" style="margin-top:14px">
      Testing ${tested} correlations at the usual 5% threshold would throw up
      about ${Math.round(tested * 0.05)} false positives from noise alone
      — and in fact ${co.uncorrected || 0} of yours would have cleared that bar.
      Everything above is corrected for the number of tests, so the threshold is
      <strong>r &gt; ${crit}</strong> instead.
    </p>
    <p class="stat-hint">
      Two honest caveats. Hard days cluster and bad nights cluster, so your days
      are not independent and the real evidence is weaker than the arithmetic
      suggests. And correlation is not causation: a daily record cannot tell you
      which way the arrow points. Read these as dials worth glancing at, not as
      findings.
    </p>
    ${co.mechanical && co.mechanical.length ? html`<p class="stat-hint" style="margin-top:12px">
        Left out as arithmetic rather than insight:
        ${co.mechanical.map(m => html`<span class="chip">${m.label} ${sgn(m.r, 2)}</span>`)}
        — calories and step counts rise on days you run further because
        that is what they measure.
      </p>` : ''}
  </section>`;
}

function sleep(s) {
  const pct = (v, d) => ((v || 0) * 100).toFixed(d);
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">How your nights are built</p>
      <p class="panel-note">${s.nights} nights · ${((s.asleep_s || 0) / 3600).toFixed(1)} h asleep on average</p>
    </div>
    <div class="stages">
      <i class="st-deep" style="width:${pct(s.deep_share, 1)}%"></i>
      <i class="st-light" style="width:${pct(s.light_share, 1)}%"></i>
      <i class="st-rem" style="width:${pct(s.rem_share, 1)}%"></i>
    </div>
    <div class="polar-key">
      <span><i class="st-deep"></i>Deep ${pct(s.deep_share, 0)}%</span>
      <span><i class="st-light"></i>Light ${pct(s.light_share, 0)}%</span>
      <span><i class="st-rem"></i>REM ${pct(s.rem_share, 0)}%</span>
    </div>
    <p class="verdict" style="margin-top:12px">${s.note || ''}</p>
    <p class="stat-hint">Adults typically run 13–23% deep and 20–25% REM.
      Yours are ${s.deep_typical && s.rem_typical ? 'both inside' : 'not both inside'} those ranges.</p>
  </section>`;
}

function trends(rows) {
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">Which way things are heading</p>
      <p class="panel-note">last fortnight against the one before</p>
    </div>
    <div class="table-scroll"><table>
      <thead><tr><th>Metric</th><th class="num">Before</th><th class="num">Recent</th><th class="num">Change</th><th></th></tr></thead>
      <tbody>${rows.map(t => html`<tr>
        <td>${cap(t.label)}</td>
        <td class="num dim">${Number(t.before || 0).toFixed(1)}</td>
        <td class="num actual">${Number(t.recent || 0).toFixed(1)}</td>
        <td class="num ${t.better === true ? 'ahead' : t.better === false ? 'behind' : 'dim'}">${sgn(t.change, 1)}</td>
        <td class="dim">${t.notable ? 'notable' : ''}</td>
      </tr>`)}</tbody>
    </table></div>
    <p class="stat-hint" style="margin-top:10px">
      “Notable” means the change is more than half the metric’s
      own spread — a blunt filter, but it stops a number wobbling by its
      usual amount from looking like a development.
    </p>
  </section>`;
}

function oddDays(rows) {
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">Days your body was somewhere else</p>
      <p class="panel-note">unusual across several signals at once</p>
    </div>
    <div class="empty"><p>One metric out of range is noise. Three or four at once,
      on the same day, is the day you were coming down with something — and
      no single chart can show you that.</p></div>
    ${rows.map(o => html`<div class="odd-day">
      <b>${o.day}</b><span class="dim">${o.count} signals</span>
      <span class="chips">${(o.metrics || []).map(m => html`<span class="chip">${m.label} ${sgn(m.z, 1)}σ</span>`)}</span>
    </div>`)}
    <p class="stat-hint" style="margin-top:12px">
      Days when you simply ran further are excluded — calories and step
      counts spiking on a long run is not your body being unusual.
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
      <p class="eyebrow">What your watches actually record</p>
      <p class="panel-note">per-sample channels, and how many runs carry them</p>
    </div>
    <div class="empty"><p>Every channel the device reports is stored, named or
      not. This is what makes the analysis above possible, and it changes the day
      you buy a new watch or put on a chest strap.</p></div>
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
const JLAG = { 0: 'same day', 1: 'next day' };
const fmtV = v => (v == null ? '--' : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1));

function journalFindingNote(f) {
  const when = f.lag === 0 ? 'on the same day as' : 'the day after';
  const worse = (f.r > 0) === HIGHER_IS_WORSE.has(f.metric);
  if (f.diff) {
    return html`Your ${f.metricLabel} averages ${fmtV(f.diff.on)} ${when} a day tagged ${f.label}
      (${f.diff.n_on} days) against ${fmtV(f.diff.off)} otherwise (${f.diff.n_off} days)
      — ${worse ? 'the direction that costs you' : 'the direction you would hope for'}.`;
  }
  return html`Your ${f.metricLabel} ${f.r > 0 ? 'rises' : 'falls'} ${when} a day with higher ${f.label}
    (r = ${sgn(f.r, 2)}, ${f.days} days).`;
}

function journalCorrelationsPanel(jc) {
  const crit = jc.critical_r != null ? jc.critical_r.toFixed(2) : '--';
  const tagNames = Object.keys(jc.tags).map(k => k.slice(4));
  const rare = Object.entries(jc.tagCounts).filter(([k]) => !jc.tags[k]).map(([k, n]) => `${k.slice(4)} (${n})`);
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">What your journal lines up with</p>
      <p class="panel-note">${jc.journaledDays} journaled days · ${jc.tested} correlations tested · exploratory</p>
    </div>
    <div class="empty"><p>Your own entries — effort, feel and the tags on runs and days —
      against what the watch measured that day and the next: HRV, resting heart rate,
      sleep score, body battery and stress.</p></div>
    ${!jc.tested ? html`<p class="verdict">Not enough overlap yet. Each pairing needs ${MIN_POINTS}
        days with both a journal entry and a watch reading, and none has that many.
        <a class="quiet-link" href="#/journal">Rate a few more runs</a>, and tag the days that were unusual.</p>`
    : jc.findings.length ? html`<div class="table-scroll"><table>
      <thead><tr><th>Journal</th><th>Watch</th><th>When</th><th class="num">r</th><th></th></tr></thead>
      <tbody>${jc.findings.map(f => html`
        <tr>
          <td><b>${cap(f.label)}</b></td>
          <td>${f.metricLabel}</td>
          <td class="dim">${JLAG[f.lag]}</td>
          <td class="num rnum ${f.r > 0 ? 'ahead' : 'behind'}">${sgn(f.r, 2)}</td>
          <td><span class="rbar ${f.r > 0 ? 'pos' : 'neg'}" style="width:${Math.round(Math.abs(f.r) * 120)}px"></span></td>
        </tr>
        <tr><td colspan="5" class="stat-hint" style="padding-top:0">${journalFindingNote(f)}</td></tr>`)}
      </tbody></table></div>`
    : html`<p class="verdict">Nothing clears the bar. With ${jc.tested} tests run, a correlation has to
        reach ${crit} before it is worth believing, and none of your journal's does.</p>`}
    ${jc.tested ? html`<p class="stat-hint" style="margin-top:14px">
      Corrected for all ${jc.tested} tests, so the threshold is <strong>r &gt; ${crit}</strong>;
      uncorrected, ${jc.uncorrected} would have looked significant, against about
      ${Math.round(jc.tested * 0.05)} expected from noise alone.</p>` : ''}
    <p class="stat-hint">Exploratory, and weaker than it looks: days are not independent (bad
      nights and hard weeks cluster), tags are things you chose to write down — often
      <em>because</em> the day felt off — and a tag only counts as absent on days you journaled
      something. None of this says which way the arrow points.</p>
    <p class="stat-hint">${tagNames.length ? html`Tags tested: ${tagNames.map(t => html`<span class="chip">${t}</span>`)}` : 'No tag is common enough to test yet.'}
      ${rare.length ? html` Too rare to test (need ${J.MIN_TAG_DAYS} days with and without): ${rare.join(', ')}.` : ''}</p>
  </section>`;
}

function predictorsPanel(p) {
  const t0 = p.results.find(x => x.threshold != null);
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">What predicts a good run</p>
      <p class="panel-note">${p.n} runs with a feel rating</p>
    </div>
    ${p.needed ? html`<div class="empty"><p>How a run felt (1–5 in the journal) against the night
        before, the weather and the week behind it. That needs at least ${J.MIN_FEEL_RUNS} rated runs;
        ${p.n ? `you have ${p.n}, so ${p.needed} more.` : 'you have none yet.'}</p></div>
        <a class="btn btn-ghost" href="#/journal">Rate your runs</a>`
    : !p.results.length ? html`<p class="verdict">${p.n} rated runs, but too few of them have the
        night before, the weather or the week's load recorded to test anything yet.</p>`
    : html`<div class="table-scroll"><table>
        <thead><tr><th>Before the run</th><th class="num">Runs</th><th class="num">r with feel</th><th class="num">95% interval</th><th></th></tr></thead>
        <tbody>${p.results.map(x => html`<tr>
          <td>${cap(x.label)}</td>
          <td class="num dim">${x.n}</td>
          <td class="num rnum ${x.clears ? (x.r > 0 ? 'ahead' : 'behind') : 'dim'}">${x.r == null ? '--' : sgn(x.r, 2)}</td>
          <td class="num dim">${x.ci ? sgn(x.ci[0], 2) + ' to ' + sgn(x.ci[1], 2) : '--'}</td>
          <td class="dim">${x.clears ? 'clears the bar' : ''}</td>
        </tr>`)}</tbody></table></div>
      <p class="stat-hint" style="margin-top:10px">“Clears the bar” means past the threshold
        corrected for the ${p.tested} predictors tested${t0 ? ` (about r = ${t0.threshold.toFixed(2)} at ${t0.n} runs)` : ''}.
        The interval is uncorrected and shows how wide the uncertainty still is: an interval
        that spans zero is a shrug, whatever the r.</p>
      <p class="stat-hint">Feel is a five-point rating, so this is a rough fit. The night before
        is the one Garmin files under the run's morning; load is the model's, summed over the
        seven days before. These predictors move together (a hard week costs sleep and HRV at
        once), so two of them lighting up may be one effect. Association only.</p>`}
  </section>`;
}

export function render() {
  useCss('vitals', CSS);
  const report = D.vitalsReport(state);
  const journal = html`${journalCorrelationsPanel(J.journalCorrelations(D.dailyRows(state), J.journalDaily(state)))}
    ${predictorsPanel(J.runPredictors(J.feelRuns(state)))}`;
  const head = pageHead('Vitals', 'Everything the watch records off the run',
    html`<a class="btn btn-ghost" href="#/journal">Journal</a> <a class="btn btn-ghost" href="#/durability">Durability</a>`);
  if (!report) return html`${head}
    <section class="panel">
      <div class="panel-head"><p class="eyebrow">Not enough days yet</p></div>
      <div class="empty">
        <p>This page needs a few weeks of daily data — stress, sleep stages,
          body battery, blood oxygen, body mass — before any of it can be
          told apart from noise. Sync once the watch has been worn a while.</p>
      </div>
      <a class="btn" href="#/sync">Set up sync</a>
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
