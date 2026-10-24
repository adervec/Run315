// This app against the watch: our threshold and race projections next to Garmin's own
// estimates, made by a different method from the same runs.
import { state } from '../store.js';
import * as D from '../derive.js';
import { html, pageHead, fmtTime, fmtPace, useCss } from '../ui.js';

export const title = 'Second opinion';

const CSS = `
.versus { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.versus .ours { font-family: var(--display); font-size: 28px; font-weight: 800; letter-spacing: -0.03em; color: var(--measured); }
.versus .theirs { font-family: var(--display); font-size: 28px; font-weight: 800; letter-spacing: -0.03em; color: var(--muted); }
.versus .vs { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.band-agree { color: var(--ahead); }
.band-near { color: var(--warn); }
.band-differ { color: var(--behind); }
.keyline { font-family: var(--mono); font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
`;

const sgn = (v, d = 0) => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(d);

export function render() {
  useCss('secondopinion', CSS);
  const review = D.secondOpinion(state, D.summary(state));
  const head = pageHead('Second opinion', 'This app against your watch');
  if (!review) return html`${head}
    <section class="panel">
      <div class="panel-head"><p class="eyebrow">Nothing to compare yet</p></div>
      <div class="empty">
        <p>Garmin computes its own threshold, VO2max and race predictions by a
          different method from this app, on the same runs. Once a sync has
          picked them up they appear here side by side.</p>
        <p>Not every watch reports all of them, and several need a chest strap
          or a few weeks of running before Garmin will commit to a number.</p>
      </div>
      <a class="btn" href="#/sync">Sync &amp; cowork</a>
    </section>`;

  const t = review.threshold_hr, p = review.threshold_pace, g = review.garmin;
  return html`${head}
    <section class="panel">
      <div class="panel-head"><p class="eyebrow">Where the two methods land</p>
        <p class="panel-note">${review.comparisons} compared · ${review.disagreements} genuinely apart</p></div>
      <div class="empty">
        <p>Two estimates agreeing is worth more than either alone. Two disagreeing
          tells you which question to ask. Neither of them is ground truth —
          this app infers your threshold from the top of your hard running, Garmin
          infers it from the shape of your heart rate against your speed, and both
          are guesses about the same underlying thing.</p>
      </div>
      ${t ? html`<div class="grid-2" style="margin-top:6px">
        <div>
          <p class="keyline">Threshold heart rate</p>
          <div class="versus"><span class="ours">${Math.round(t.ours)}</span><span class="vs">this app</span>
            <span class="theirs">${Math.round(t.theirs)}</span><span class="vs">Garmin</span></div>
          <p class="stat-hint band-${t.band}">${sgn(t.difference)} bpm apart · ${t.band}</p>
        </div>
        <div><p class="stat-hint">${t.note}</p></div>
      </div>` : ''}
      ${p ? html`<div class="grid-2" style="margin-top:18px">
        <div>
          <p class="keyline">Threshold pace</p>
          <div class="versus"><span class="ours">${fmtPace(p.ours, 1000)}</span><span class="vs">this app</span>
            <span class="theirs">${fmtPace(p.theirs, 1000)}</span><span class="vs">Garmin</span></div>
          <p class="stat-hint band-${p.band}">${sgn(p.relative * 100, 1)}% · ${p.band}</p>
        </div>
        <div><p class="stat-hint">Garmin's threshold pace detection moved from a
          chest-strap protocol to automatic detection from wrist heart rate in
          late 2024. Independent validation of the wrist-based version is thin,
          and one study measured it reading nearly 12% slow.</p></div>
      </div>` : ''}
    </section>

    ${review.races.length ? html`<section class="panel">
      <div class="panel-head"><p class="eyebrow">Race projections</p><p class="panel-note">two models, same runs</p></div>
      <div class="table-scroll"><table>
        <thead><tr><th>Distance</th><th class="num">This app</th><th class="num">Garmin</th><th class="num">Apart</th><th></th></tr></thead>
        <tbody>${review.races.map(r => html`<tr>
          <td>${(r.distance_m / 1000).toFixed(1)} km</td>
          <td class="num actual">${fmtTime(r.ours)}</td>
          <td class="num dim">${fmtTime(r.theirs)}</td>
          <td class="num band-${r.band}">${sgn(r.relative * 100, 1)}%</td>
          <td><span class="band-${r.band}">${r.band}</span></td>
        </tr>`)}</tbody>
      </table></div>
      ${review.race_summary ? html`<p class="verdict" style="margin-top:14px">${review.race_summary}</p>` : ''}
    </section>` : ''}

    <section class="panel">
      <div class="panel-head"><p class="eyebrow">Garmin's own, with no equivalent here</p></div>
      <div class="digest">
        ${g.vo2max ? html`<div class="stat"><div class="stat-value">${g.vo2max.toFixed(1)}</div>
          <div class="stat-label">VO2max · Garmin</div><div class="stat-hint">This app computes none on purpose.</div></div>` : ''}
        ${g.endurance_score ? html`<div class="stat"><div class="stat-value">${Math.round(g.endurance_score)}</div>
          <div class="stat-label">Endurance score</div></div>` : ''}
        ${g.hill_score ? html`<div class="stat"><div class="stat-value">${Math.round(g.hill_score)}</div>
          <div class="stat-label">Hill score</div>
          <div class="stat-hint"><a class="quiet-link" href="#/climbing">Our version</a> tests the energy model instead.</div></div>` : ''}
      </div>
      <p class="stat-hint" style="margin-top:12px">
        No VO2max is computed here, and that is deliberate. A VO2max derived from
        heart rate and pace is a lossy compression of the heart-rate/pace
        relationship into one number using a population economy curve — it
        adds a familiar unit and a false precision, not information. Garmin's
        carries a mean error around 5–8% with a chest strap, and worse at both
        ends of the fitness range.
      </p>
    </section>`;
}
