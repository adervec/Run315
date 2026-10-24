// Charts from a small JSON spec, so an agent's answer (or any page) can say "draw this"
// without shipping code. The spec is the contract in the analysis channel's instructions:
//
//   { "type": "line" | "bar" | "scatter", "title": "...", "note": "...",
//     "x": { "label": "...", "type": "time" | "linear" | "category" },
//     "y": { "label": "...", "unit": "...", "zero": true },
//     "series": [ { "name": "...", "points": [[x, y], ...] } ] }
//
// One y-axis, always (two measures of different scale are two charts). One series wears
// the app's measured teal; several take the categorical --series-N slots in fixed order,
// get a legend, and are capped at 8 (scatter at 3, where every pair must stay apart).
// Every mark names its value on hover, and a table view sits under each chart.
import { esc } from './ui.js';

const W = 680, H = 240, M = { l: 48, r: 14, t: 10, b: 30 };
const colour = (i, n) => (n === 1 ? 'var(--measured)' : `var(--series-${i + 1})`);

function ticks(lo, hi, n = 5) {
  if (!(hi > lo)) return [lo];
  const step0 = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(s => s >= step0);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}
const fmtNum = v => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString() : Math.abs(v) >= 10 ? (+v.toFixed(1)).toString() : (+v.toFixed(2)).toString());

// spec -> SVG/HTML string. Throws on a spec it cannot draw (the caller shows the JSON instead).
export function renderChart(spec) {
  const type = spec.type || 'line', xt = (spec.x && spec.x.type) || 'linear';
  const cap = type === 'scatter' ? 3 : 8;
  let series = (spec.series || []).filter(s => s && Array.isArray(s.points) && s.points.length);
  if (!series.length) throw new Error('no series');
  const folded = series.length > cap ? series.length - cap : 0;
  series = series.slice(0, cap);
  const n = series.length;

  // x as numbers: time -> ms, category -> index
  const cats = xt === 'category' ? [...new Set(series.flatMap(s => s.points.map(p => String(p[0]))))] : null;
  const xv = x => (xt === 'time' ? Date.parse(x) : xt === 'category' ? cats.indexOf(String(x)) : +x);
  const pts = series.map(s => s.points.map(p => [xv(p[0]), +p[1], p[0]]).filter(p => isFinite(p[0]) && isFinite(p[1])));
  const xs = pts.flat().map(p => p[0]), ys = pts.flat().map(p => p[1]);
  if (!xs.length) throw new Error('no finite points');
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  if (type === 'bar' || (spec.y && spec.y.zero)) { y0 = Math.min(0, y0); y1 = Math.max(0, y1); }
  if (y1 === y0) { y1 += 1; y0 -= 1; }
  const pad = (y1 - y0) * 0.06; if (!(type === 'bar' && y0 === 0)) y0 -= pad; y1 += pad;
  if (cats) { x0 = -0.5; x1 = cats.length - 0.5; } else if (x1 === x0) { x0 -= 1; x1 += 1; }
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const X = v => M.l + ((v - x0) / (x1 - x0)) * iw, Y = v => M.t + ih - ((v - y0) / (y1 - y0)) * ih;

  const yt = ticks(y0, y1);
  const fmtX = v => (xt === 'time' ? new Date(v).toISOString().slice(0, 10) : cats ? cats[Math.round(v)] : fmtNum(v));
  const xtv = cats ? cats.map((_, i) => i).filter((_, i, a) => a.length <= 12 || i % Math.ceil(a.length / 12) === 0)
    : xt === 'time' ? Array.from({ length: 5 }, (_, i) => x0 + (i * (x1 - x0)) / 4) : ticks(x0, x1);
  const unit = (spec.y && spec.y.unit) ? ' ' + spec.y.unit : '';
  let svg = `<g class="grid">${yt.map(v => `<line x1="${M.l}" x2="${W - M.r}" y1="${Y(v)}" y2="${Y(v)}"/>`).join('')}</g>`;
  svg += `<g class="axis">${yt.map(v => `<text x="${M.l - 6}" y="${Y(v) + 4}" text-anchor="end">${esc(fmtNum(v))}</text>`).join('')}`;
  svg += xtv.map(v => `<text x="${X(v)}" y="${H - 10}" text-anchor="middle">${esc(fmtX(v))}</text>`).join('') + '</g>';

  pts.forEach((sp, i) => {
    const c = colour(i, n), name = esc(series[i].name || '');
    const tip = p => `<title>${name ? name + ': ' : ''}${esc(String(p[2]))} → ${esc(fmtNum(p[1]))}${esc(unit)}</title>`;
    if (type === 'bar') {
      const bw = Math.max(2, (iw / (cats ? cats.length : sp.length)) / n - 2);
      sp.forEach(p => {
        const x = X(p[0]) - (bw * n) / 2 + i * bw, yA = Y(Math.max(0, p[1])), yB = Y(Math.min(0, p[1]));
        svg += `<rect class="bar" x="${x.toFixed(1)}" y="${yA.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${Math.max(1, yB - yA).toFixed(1)}" rx="2" fill="${c}">${tip(p)}</rect>`;
      });
    } else {
      const sorted = type === 'line' ? [...sp].sort((a, b) => a[0] - b[0]) : sp;
      if (type === 'line') svg += `<polyline fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" points="${sorted.map(p => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ')}"/>`;
      // Markers double as hover targets; on a long line they stay invisible until hovered.
      const r = type === 'scatter' ? 4 : 3, dense = type === 'line' && sorted.length > 40;
      svg += sorted.map(p => `<circle class="pt" cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="${dense ? 6 : r}" fill="${c}" ${dense ? 'fill-opacity="0"' : 'stroke="var(--surface)" stroke-width="2"'}>${tip(p)}</circle>`).join('');
    }
  });
  if (type === 'bar' && y0 < 0) svg += `<line x1="${M.l}" x2="${W - M.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="var(--muted)"/>`;

  const legend = n > 1 ? `<div class="chart-legend-row">${series.map((s, i) => `<span><i style="background:${colour(i, n)}"></i>${esc(s.name || 'series ' + (i + 1))}</span>`).join('')}</div>` : '';
  const yl = spec.y && spec.y.label ? `<text class="lbl" x="${M.l}" y="${M.t - 1}" dy="-2">${esc(spec.y.label)}${esc(unit && !spec.y.label.includes(spec.y.unit) ? ' (' + spec.y.unit + ')' : '')}</text>` : '';
  const table = `<details><summary>Table</summary><div class="table-scroll"><table><thead><tr><th>${esc((spec.x && spec.x.label) || 'x')}</th>${series.map(s => `<th class="num">${esc(s.name || (spec.y && spec.y.label) || 'y')}</th>`).join('')}</tr></thead><tbody>${
    [...new Set(pts.flat().map(p => p[0]))].sort((a, b) => a - b).slice(0, 500).map(x => `<tr><td>${esc(fmtX(x))}</td>${pts.map(sp => { const p = sp.find(q => q[0] === x); return `<td class="num">${p ? esc(fmtNum(p[1])) : ''}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div></details>`;
  return `<figure class="chart-fig">${spec.title ? `<figcaption>${esc(spec.title)}</figcaption>` : ''}<svg viewBox="0 ${-14} ${W} ${H + 14}" role="img" aria-label="${esc(spec.title || 'chart')}">${yl}${svg}</svg>${legend}`
    + `${spec.note || folded ? `<p class="chart-note">${esc(spec.note || '')}${folded ? ` (${folded} more series not drawn)` : ''}</p>` : ''}${table}</figure>`;
}
