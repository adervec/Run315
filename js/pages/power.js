// Cycling power: eFTP, critical power and W' from the rides' best efforts, the power-duration
// curve season by season, and every ride's NP / IF / TSS. The maths is in js/lib/power.js;
// each ride's summary is state.derived[id].power, made from its stream when it was derived.
import { state } from '../store.js';
import * as D from '../derive.js';
import * as P from '../lib/power.js';
import { dayKey } from '../lib/dt.js';
import { renderChart } from '../charts.js';
import { fetchStream } from '../drive.js';
import { html, raw, esc, pageHead, emptyState, day, fmtTime, useCss, link, t } from '../ui.js';

export const title = 'Power';

const CSS = `
.pwr .digest { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; }
.pwr .fit-note { max-width: 75ch; }
.pwr .wbal-pick { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 10px; }
.pwr .wbal-pick select { max-width: 100%; }
.pwr .tag { font-family: var(--mono); font-size: 11px; color: var(--muted); }
`;
const durLabel = d => (d < 60 ? d + 's' : d % 3600 === 0 ? d / 3600 + 'h' : d / 60 + 'm');
const fmt1 = v => (v == null ? '--' : v.toFixed(1));
const chart = spec => { try { return renderChart(spec); } catch { return ''; } };
// A translated sentence with markup placed inside it at {key}.
const withMarkup = (text, markup) => raw(esc(text).replace('\u0001', () => String(markup)));

// Rides with a power summary, newest first, as the lib's entries.
function rideEntries() {
  return D.activities(state).filter(a => P.isRide(a) && state.derived[a.id]?.power?.mmp)
    .map(a => ({ id: a.id, date: dayKey(a.start), a, power: state.derived[a.id].power, mmp: state.derived[a.id].power.mmp }));
}

// The fit people see as "current": the 90 days to today, or -- after a winter off the bike --
// the 90 days to the last ride with power, said so.
function currentFit(entries) {
  const today = dayKey(new Date());
  const now = P.windowFit(entries, today);
  return now.n ? { ...now, stale: false } : { ...P.windowFit(entries, entries[0].date), stale: true };
}

function fitPanel(cur, byId) {
  const f = cur.fit, e = cur.eftp;
  const rideLinks = cur.rides.map((id, i) => html`${i ? ', ' : ''}${link('activity/' + id, (byId[id]?.a.name || t('ride')) + ' (' + day(byId[id]?.date) + ')')}`);
  const check = e.check == null ? ''
    : e.diffPct != null ? t('95% of it: {w} W (CP is {diff}%)', { w: e.check, diff: (e.diffPct >= 0 ? '+' : '−') + Math.abs(e.diffPct).toFixed(1) })
      : t('95% of it: {w} W', { w: e.check });
  return html`<section class="panel">
    <div class="panel-head"><p class="eyebrow">${cur.stale ? t('Last known, the 90 days to {day}', { day: day(cur.end, true) }) : t('Now: the last 90 days')}</p></div>
    <div class="digest">
      <div class="stat"><div class="stat-value">${e.value != null ? e.value + ' W' : '--'}</div><div class="stat-label">eFTP</div>
        <div class="stat-hint">${e.source === 'cp' ? t('Critical power from the fit.') : e.source === '20min' ? t('95% of the best 20 minutes (no CP fit).') : t('Needs a 20-minute effort or a CP fit.')}</div></div>
      <div class="stat"><div class="stat-value">${f.ok ? f.cp + ' W' : '--'}</div><div class="stat-label">${t('Critical power')}</div>
        <div class="stat-hint">${f.ok ? t('± {se} W (standard error)', { se: fmt1(f.seCp) }) : t('No fit')}</div></div>
      <div class="stat"><div class="stat-value">${f.ok ? (f.wPrime / 1000).toFixed(1) + ' kJ' : '--'}</div><div class="stat-label">W′</div>
        <div class="stat-hint">${f.ok ? '± ' + (f.seW / 1000).toFixed(1) + ' kJ' : t('No fit')}</div></div>
      <div class="stat"><div class="stat-value">${e.p20 != null ? e.p20 + ' W' : '--'}</div><div class="stat-label">${t('Best 20 min')}</div>
        <div class="stat-hint">${check}</div></div>
    </div>
    <p class="panel-note fit-note">${f.ok
      ? html`${t('Fitted to the best {durations} of {n} rides: work = CP × time + W′, least squares.', { durations: f.points.map(q => durLabel(q.t)).join(', '), n: cur.n })}
        ${t('The curve it implies misses the worst point by {pct}%.', { pct: fmt1(f.maxErrPct) })}${f.n < 5 ? ' ' + t('Only {n} points: treat it as rough.', { n: f.n }) : ''}`
      : t('No critical-power fit: {reason}.', { reason: f.reason })}
      ${t('These are the best efforts in the window, not tests: if none of the rides was ridden all-out at 3–20 minutes, CP and eFTP come out low, and every IF and TSS on this page comes out high.')}
      ${withMarkup(t('Points from: {rides}.', { rides: '\u0001' }), rideLinks.length ? html`${rideLinks}` : esc(t('none')))}</p>
  </section>`;
}

// Power-duration curve, one line per year (the newest 8).
function curveChart(entries) {
  const years = [...new Set(entries.map(e => e.date.slice(0, 4)))].sort().slice(-8);
  const series = years.map(y => {
    const env = P.envelope(entries.filter(e => e.date.startsWith(y)));
    return { name: y, points: P.DURATIONS.map(d => [durLabel(d), env[d] ? env[d].w : NaN]) };
  }).filter(s => s.points.some(p => isFinite(p[1])));
  return chart({ type: 'line', title: t('Power-duration curve by year'), x: { label: t('duration'), type: 'category' },
    y: { label: t('best power'), unit: 'W' }, series,
    note: t('The best average power held for each duration in each year, across every ride with power.') });
}

function trendChart(roll) {
  const cp = roll.filter(r => r.cp != null).map(r => [r.date, r.cp]), ef = roll.filter(r => r.eftp != null).map(r => [r.date, r.eftp]);
  const series = [{ name: 'eFTP', points: ef }, { name: 'CP', points: cp }].filter(s => s.points.length);
  return series.length ? chart({ type: 'line', title: t('eFTP and CP, rolling 90 days'), x: { label: t('month end'), type: 'time' },
    y: { label: t('power'), unit: 'W' }, series,
    note: t('Refitted at each month end from the 90 days before it. A dip can be fitness or simply no hard rides that quarter.') }) : '';
}

function rideTable(entries, ftp) {
  const rows = entries.slice(0, 80);
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">${t('Rides with power')}</p></div>
    <div class="table-scroll"><table>
    <thead><tr><th>${t('Date')}</th><th>${t('Ride')}</th><th class="num">${t('Time')}</th><th class="num">${t('Avg')}</th><th class="num">NP</th><th class="num">IF</th>
      <th class="num">TSS</th><th class="num">VI</th><th class="num">kJ</th><th class="num">Pw:HR</th></tr></thead>
    <tbody>${rows.map(e => {
      const s = e.power, f = ftp[e.id], i = P.intensityFactor(s, f), tss = P.powerTss(s, f);
      return html`<tr><td>${day(e.date, true)}</td><td>${link('activity/' + e.id, e.a.name || t('Ride'))}${D.isVirtual(e.a) ? html` <span class="tag">${t('virtual')}</span>` : ''}</td>
        <td class="num">${fmtTime(s.s)}</td><td class="num">${s.avg} W</td><td class="num">${s.np} W</td>
        <td class="num">${i != null ? i.toFixed(2) : '--'}</td><td class="num">${tss != null ? Math.round(tss) : '--'}</td>
        <td class="num">${s.vi != null ? s.vi.toFixed(2) : '--'}</td><td class="num">${s.kj}</td>
        <td class="num">${s.decoupling != null ? s.decoupling.toFixed(1) + '%' : '--'}</td></tr>`;
    })}</tbody></table></div>
    <p class="panel-note">${t('IF = NP ÷ the eFTP of the 90 days up to that ride (carried forward up to a year when a window has no hard effort).')}
      ${t('TSS = hours × IF² × 100. VI = NP ÷ average: 1.0 is a steady ride, above 1.1 a surging one.')}
      ${t('Pw:HR: how much less power each heartbeat bought in the second half; under 5% is well-coupled (needs 20 minutes and heart rate).')}
      ${entries.length > rows.length ? t('Newest {shown} of {n} shown.', { shown: rows.length, n: entries.length }) : ''}</p></section>`;
}

function wbalPanel(entries) {
  const rows = entries.slice(0, 80);
  return html`<section class="panel"><div class="panel-head"><p class="eyebrow">${t('W′ balance through a ride')}</p></div>
    <div class="wbal-pick"><label for="wbal-ride">${t('Ride')}</label>
      <select id="wbal-ride">${rows.map(e => html`<option value="${e.id}">${day(e.date, true)} · ${e.a.name || t('Ride')} · ${e.power.np} W NP</option>`)}</select></div>
    <div id="wbal-out"><p class="dim">${t('Loading the stream…')}</p></div>
    <p class="panel-note">${t("How much of the anaerobic reserve was left, second by second: above CP it drains one joule per watt over; below CP it refills, faster the emptier it is (Skiba's differential model), against the CP and W′ of the 90 days to that ride.")}
      ${t('Near zero means the effort was at its limit.')}</p></section>`;
}

export function render() {
  useCss('power', CSS);
  const entries = rideEntries();
  const head = pageHead(t('Power'), t('Cycling power: eFTP, critical power, the power-duration curve'));
  if (!entries.length) return html`${head}${emptyState(t('No rides with power yet'),
    t('Power comes from a power meter on the bike, a smart trainer, or Zwift. Once a ride with a power stream is synced, its best efforts, NP, TSS and W′ balance appear here, and its training load is scored from power rather than heart rate.'),
    html`<a class="btn" href="#/sync">${t('Sync & cowork')}</a>`)}`;
  const byId = Object.fromEntries(entries.map(e => [e.id, e]));
  const cur = currentFit(entries), ftp = P.ftpByRide(entries), roll = P.rollingFits(entries);
  return html`<div class="pwr">${head}
    ${fitPanel(cur, byId)}
    <section class="panel">${raw(curveChart(entries))}</section>
    ${roll.length > 1 ? html`<section class="panel">${raw(trendChart(roll))}</section>` : ''}
    ${wbalPanel(entries)}
    ${rideTable(entries, ftp)}</div>`;
}

async function drawWbal(el, entries, id) {
  const out = el.querySelector('#wbal-out'), e = entries.find(x => x.id === id);
  if (!out || !e) return;
  out.innerHTML = String(html`<p class="dim">${t('Loading the stream…')}</p>`);
  const fit = P.windowFit(entries, e.date).fit;
  if (!fit.ok) { out.innerHTML = String(html`<p class="dim">${t('No CP / W′ fit for the 90 days to this ride ({reason}), so no W′ balance.', { reason: fit.reason })}</p>`); return; }
  let rec = null;
  try { rec = await fetchStream(id); } catch { rec = null; }
  if (el.querySelector('#wbal-ride')?.value !== id) return;            // the choice changed meanwhile
  const wb = rec && rec.channels ? P.wPrimeBalance(rec.channels, fit.cp, fit.wPrime) : null;
  if (!wb) { out.innerHTML = String(html`<p class="dim">${t("This ride's stream is not on this device (or Drive), so W′ balance cannot be drawn.")}</p>`); return; }
  const step = Math.max(1, Math.ceil(wb.bal.length / 600)), pts = [];
  for (let i = 0; i < wb.bal.length; i += step) pts.push([+(i / 60).toFixed(2), +(wb.bal[i] / 1000).toFixed(2)]);
  out.innerHTML = chart({ type: 'line', title: t('W′ balance'), x: { label: t('moving minutes'), type: 'linear' }, y: { label: t('W′ left'), unit: 'kJ', zero: true },
    series: [{ name: t('W′ balance'), points: pts }],
    note: t('CP {cp} W, W′ {w} kJ. Lowest: {min} kJ at {at} moving.', { cp: fit.cp, w: (fit.wPrime / 1000).toFixed(1), min: (wb.min / 1000).toFixed(1), at: fmtTime(wb.minAt) }) })
    || String(html`<p class="dim">${t('Nothing to draw.')}</p>`);
}

export function mount(el) {
  const sel = el.querySelector('#wbal-ride');
  if (!sel) return;
  const entries = rideEntries();
  sel.onchange = () => drawWbal(el, entries, sel.value);
  if (sel.value) drawWbal(el, entries, sel.value);
}
