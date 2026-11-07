// D′ balance and DFA alpha1, the browser half: panels the activity page and the race
// postmortem embed. The maths is js/lib/dprime.js and js/lib/dfa.js.
//
// Both panels are async (they need the stream, via fetchStream: local first, then Drive) and
// take an optional already-fetched stream record so a page that has one does not fetch twice.
// Each returns html (a Raw), or '' when the activity is not a run.
import { state } from './store.js';
import { fetchStream } from './drive.js';
import * as D from './derive.js';
import * as F from './lib/fitness.js';
import * as P from './lib/dprime.js';
import * as A from './lib/dfa.js';
import { CS_MIN_S, CS_MAX_S, CS_MIN_POINTS } from './lib/durability.js';
import { renderChart } from './charts.js';
import { html, raw } from './ui.js';

const kmS = m => (m / 1000).toFixed(1) + ' km';
const paceOf = v => (v > 0 ? F.fmtPace(1000 / v, 1000) : '--');
const mins = s => Math.round(s / 60);
const clock = s => F.fmtTime(Math.max(0, Math.round(s)));
const chart = spec => { try { return raw(renderChart(spec)); } catch { return ''; } };

async function streamOf(id, rec) {
  if (rec !== undefined) return rec;
  try { return await fetchStream(id); } catch (e) { console.warn('stream', id, e); return null; }
}
const isRun = a => !!a && F.RUN_TYPES.has(a.type);

// ---------------------------------------------------------------------------
// D′ balance
// ---------------------------------------------------------------------------
// -> { result, limits, samples } or { why } (a plain reason there is no balance).
export async function dprimeFor(id, rec, st = state) {
  const a = st.activities[id];
  if (!isRun(a)) return { why: 'not a run' };
  const lim = D.limits(st);
  if (!lim.cs || !lim.d_prime) return { why: 'no-cs', limits: lim };
  const samples = D.samplesOf(await streamOf(id, rec));
  if (samples.length < 2) return { why: 'no-stream', limits: lim };
  const result = P.analyse(samples, lim.cs, lim.d_prime);
  return result ? { result, limits: lim } : { why: 'no-stream', limits: lim };
}

export async function dprimePanel(id, rec, st = state) {
  const a = st.activities[id];
  if (!isRun(a)) return '';
  const r = await dprimeFor(id, rec, st);
  const head = html`<div class="panel-head"><p class="eyebrow">D′ balance</p><p class="panel-note">Your reserve above critical speed</p></div>`;
  if (r.why === 'no-cs') return html`<section class="panel" data-hook="dprime">${head}
    <p class="dim" style="margin:0">No critical speed yet, so no D′ balance. It needs at least ${CS_MIN_POINTS} hard best efforts lasting ${CS_MIN_S / 60}–${CS_MAX_S / 60} minutes at different distances (say an all-out 800 m, 1 mile and 3 km, or a parkrun) so a line can be fitted through distance against time: its slope is the speed you can hold (CS), its intercept the distance you can run faster than that (D′).</p></section>`;
  if (r.why === 'no-stream') return html`<section class="panel" data-hook="dprime">${head}
    <p class="dim" style="margin:0">This device has no second-by-second stream for this run (sync it from Drive or re-import the FIT file), so the reserve cannot be followed through it.</p></section>`;
  const x = r.result, cs = x.cs, dp = x.d_prime;
  const pts = P.thin(x.points, 400);
  const spec = { type: 'line', title: 'D′ balance', note: `Starts full at ${Math.round(dp)} m; falls whenever grade-adjusted speed is above CS (${paceOf(cs)}).`,
    x: { label: 'km', type: 'linear' }, y: { label: 'D′ left', unit: 'm', zero: true },
    series: [{ name: 'D′ balance', points: pts.map(p => [+(p[1] / 1000).toFixed(2), Math.round(p[2])]) },
      { name: '25% of D′', points: [[0, Math.round(dp * P.LOW_FRACTION)], [+(pts[pts.length - 1][1] / 1000).toFixed(2), Math.round(dp * P.LOW_FRACTION)]] }] };
  const virtual = D.isVirtual(a);
  return html`<section class="panel" data-hook="dprime">${head}
    <p style="margin:0 0 10px"><b>${P.verdict(x)}</b></p>
    <div class="digest">
      <div class="stat"><div class="stat-value ${x.empty ? 'risk' : ''}">${Math.round(Math.max(0, x.min_frac) * 100)}%</div><div class="stat-label">Lowest D′ left</div><div class="stat-hint">${Math.round(x.min)} m at ${kmS(x.min_d)} (${clock(x.min_t - x.points[0][0])})</div></div>
      <div class="stat"><div class="stat-value">${mins(x.low_s)} min</div><div class="stat-label">Below 25%</div></div>
      <div class="stat"><div class="stat-value">${x.empty ? kmS(x.empty_d) : 'no'}</div><div class="stat-label">Ran dry</div></div>
      <div class="stat"><div class="stat-value">${paceOf(cs)}</div><div class="stat-label">CS · D′ ${Math.round(dp)} m</div></div>
    </div>
    ${chart(spec)}
    <p class="stat-hint">Skiba's W′ balance carried over to running (the 2015 differential form: below CS the reserve refills at (D′ − balance) × (CS − speed) / D′, all in metres and m/s, so no cycling constant is borrowed). Speed is grade-adjusted over ${P.SPEED_WINDOW_S} s, so climbs spend the reserve; stops refill it. CS and D′ are today's fit from your best 2–15 min efforts, not your fitness on the day of this run${virtual ? "; on a treadmill the distance is the belt's (or footpod's) estimate and there is no grade" : ''}. GPS noise on twisty or tree-covered routes spends a little reserve that was never spent. A fade after the reserve runs dry is what the model predicts.</p>
  </section>`;
}

// ---------------------------------------------------------------------------
// DFA alpha1
// ---------------------------------------------------------------------------
const rrOf = rec => (rec && Array.isArray(rec.hrv_rr) && rec.hrv_rr.length ? rec.hrv_rr : null);

// A stream record -> A.summarise(...) (small: beats, artefact %, windows, alpha1 mean/min,
// HRVT1 HR and speed, r², quality) or null without RR.
export function dfaSummary(rec) {
  const rr = rrOf(rec);
  if (!rr) return null;
  const samples = D.samplesOf(rec);
  return A.summarise(rr, samples, samples.length ? samples[0][0] : 0);
}

export async function dfaPanel(id, rec, st = state) {
  const a = st.activities[id];
  if (!isRun(a)) return '';
  rec = await streamOf(id, rec);
  const head = html`<div class="panel-head"><p class="eyebrow">DFA alpha1</p><p class="panel-note">Aerobic threshold from beat-to-beat intervals</p></div>`;
  const rr = rrOf(rec);
  if (!rr) return html`<section class="panel" data-hook="dfa">${head}
    <p class="dim" style="margin:0">This run has no beat-to-beat (RR) data, so no DFA alpha1. Two things are needed: a chest strap (wrist optical sensors do not record individual beats) and HRV logging switched on in the watch. On a Garmin: <b>Settings → Physiological Metrics → Log HRV</b>; on some models it sits under <i>System → Data Recording</i>. The FIT file then carries the intervals and the next import picks them up.</p></section>`;
  const samples = D.samplesOf(rec);
  const t0 = samples.length ? samples[0][0] : 0;
  const clean = A.cleanRR(rr);
  const rows = A.withSpeed(A.series(rr, { offset: t0 }), samples);
  if (!rows.length) return html`<section class="panel" data-hook="dfa">${head}
    <p class="dim" style="margin:0">RR data is there (${rr.length.toLocaleString('en-US')} beats) but no 2-minute window was clean enough: ${(clean.fraction * 100).toFixed(1)}% of beats needed correcting, and windows with more than ${A.MAX_ARTEFACT * 100}% are skipped. A wet strap (or a loose one) usually fixes this.</p></section>`;
  const th = A.threshold(rows);
  const a1 = rows.map(r => r.a1), mean = a1.reduce((s, v) => s + v, 0) / a1.length;
  const verdict = th && th.hr != null
    ? `Alpha1 crossed 0.75 at about ${Math.round(th.hr)} bpm${th.speed ? ` (${paceOf(th.speed)})` : ''}: an estimate of your first aerobic threshold, fit ${th.quality} (r² ${th.r2.toFixed(2)}, ${th.n} windows).`
    : th ? `No threshold from this run: ${th.reason}.` : 'Too few windows after the warm-up to fit a threshold.';
  const series = [{ name: 'alpha1', points: rows.map(r => [+((r.t - t0) / 60).toFixed(2), +r.a1.toFixed(3)]) },
    { name: '0.75', points: [[+((rows[0].t - t0) / 60).toFixed(2), 0.75], [+((rows[rows.length - 1].t - t0) / 60).toFixed(2), 0.75]] }];
  const scatter = th ? [{ name: 'windows', points: rows.filter(r => r.t >= rows[0].t + 300).map(r => [+r.hr.toFixed(1), +r.a1.toFixed(3)]) },
    { name: 'fit', points: [th.hr_range[0], th.hr_range[1]].map(h => [+h.toFixed(1), +(th.intercept + th.slope * h).toFixed(3)]) }] : null;
  return html`<section class="panel" data-hook="dfa">${head}
    <p style="margin:0 0 10px"><b>${verdict}</b></p>
    <div class="digest">
      <div class="stat"><div class="stat-value">${th && th.hr != null ? Math.round(th.hr) : '—'}</div><div class="stat-label">HRVT1 bpm</div><div class="stat-hint">${th && th.speed ? paceOf(th.speed) : ''}</div></div>
      <div class="stat"><div class="stat-value">${mean.toFixed(2)}</div><div class="stat-label">Mean alpha1</div></div>
      <div class="stat"><div class="stat-value">${Math.min(...a1).toFixed(2)}</div><div class="stat-label">Lowest alpha1</div></div>
      <div class="stat"><div class="stat-value ${clean.fraction > 0.03 ? 'risk' : ''}">${(clean.fraction * 100).toFixed(1)}%</div><div class="stat-label">Beats corrected</div></div>
    </div>
    ${chart({ type: 'line', title: 'DFA alpha1 over the run', note: '2-minute windows every 5 s; 1.0 easy, 0.75 the first threshold, 0.5 hard.',
      x: { label: 'minutes', type: 'linear' }, y: { label: 'alpha1' }, series })}
    ${scatter && scatter[0].points.length ? chart({ type: 'scatter', title: 'Alpha1 against heart rate', note: 'Where the fitted line crosses 0.75 is the estimate.',
      x: { label: 'bpm', type: 'linear' }, y: { label: 'alpha1' }, series: scatter }) : ''}
    <p class="stat-hint">Rogers &amp; Gronwald's method: RR intervals outside 300–2000 ms or more than 20% from the local median are interpolated; alpha1 is the DFA slope over 4–16 beats in 2-minute windows; the first 5 minutes are left out. The estimate is only meaningful on a run that ramps from easy to hard (this one ${th && th.ramp ? 'did' : 'did not'}); a steady run sits at one point of the line. Artefacts pull alpha1 down, so a few percent of corrected beats can fake a threshold. Beats are aligned assuming they start with the recording; pausing the watch can shift them.</p>
  </section>`;
}
