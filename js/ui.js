// The small UI kit every page uses: escape-first templating, formatting, a markdown
// renderer for agent replies, and the SVG plumbing the charts share. No framework --
// pages are functions that return HTML strings, and the router swaps them in.
import { fmtTime, fmtPace } from './lib/fitness.js';
import { renderChart } from './charts.js';
export { fmtTime, fmtPace };

// ---- templating: html`...` escapes every interpolation unless it is raw() or another html`` ----
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = s => new Raw(String(s ?? ''));
export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const part = v => (v == null || v === false ? '' : v instanceof Raw ? v.s : Array.isArray(v) ? v.map(part).join('') : esc(v));
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += part(vals[i]) + strings[i + 1];
  return new Raw(out);
}

// ---- formatting ----
export const km = (m, d = 1) => (m == null ? '--' : (m / 1000).toFixed(d));
export const pace = (s, m) => (s && m ? fmtPace(s, m) : '--');
export const signed = v => { const n = Math.round(v || 0); return (n > 0 ? '+' : n < 0 ? '−' : '+') + Math.abs(n); };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// '2026-08-18…' or a Date -> '18 Aug' (or '18 Aug 2025' when not this year)
export function day(v, withYear) {
  const s = typeof v === 'string' ? v : v.toISOString();
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  return d + ' ' + MONTHS[m - 1] + (withYear || y !== new Date().getFullYear() ? ' ' + y : '');
}
export const typeLabel = t => String(t || 'other').replace(/_/g, ' ');
export function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 90) return 'just now';
  if (s < 5400) return Math.round(s / 60) + ' min ago';
  if (s < 129600) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' days ago';
}

// ---- markdown: escape-first, for agent and coach replies (headings, bullets, bold, code, tables) ----
// Fenced blocks first: ```chart {spec} ``` becomes a drawn chart (js/charts.js), any other
// fence a <pre>; the prose between them goes through mdText.
export function md(text) {
  const parts = String(text ?? '').split(/```(\w*)[ \t]*\n([\s\S]*?)```/);
  let out = '';
  for (let i = 0; i < parts.length; i += 3) {
    out += mdText(parts[i]).s;
    if (i + 2 >= parts.length) break;
    const lang = parts[i + 1], body = parts[i + 2];
    if (lang === 'chart') {
      try { out += renderChart(JSON.parse(body)); continue; } catch (e) { out += `<p class="chart-note">A chart that could not be drawn (${esc(e.message)}):</p>`; }
    }
    out += `<pre class="review">${esc(body)}</pre>`;
  }
  return raw('<div class="md">' + out + '</div>');
}
function mdText(text) {
  const out = []; let list = false, table = null;
  const inline = l => l.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  const flushTable = () => {
    if (!table) return;
    const rows = table.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r)).map(r => r.replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim())));
    out.push('<div class="table-scroll"><table><thead><tr>' + rows[0].map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>'
      + rows.slice(1).map(r => '<tr>' + r.map(c => `<td>${c}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>');
    table = null;
  };
  for (const rawLine of esc(text).split('\n')) {
    const line = rawLine.trim(), bullet = /^[-*] /.test(line), isRow = line.startsWith('|');
    if (isRow) { (table = table || []).push(line); continue; } else flushTable();
    if (bullet && !list) { out.push('<ul>'); list = true; } else if (!bullet && list) { out.push('</ul>'); list = false; }
    if (!line) continue;
    const l = inline(line);
    if (line.startsWith('### ')) out.push(`<h4>${l.slice(4)}</h4>`);
    else if (line.startsWith('## ')) out.push(`<h3>${l.slice(3)}</h3>`);
    else if (line.startsWith('# ')) out.push(`<h3>${l.slice(2)}</h3>`);
    else if (bullet) out.push(`<li>${l.slice(2)}</li>`);
    else out.push(`<p>${l}</p>`);
  }
  flushTable();
  if (list) out.push('</ul>');
  return raw(out.join(''));
}

// ---- charts ----
// "x,y x,y" for a series of values, scaled into width x height; `top` shared across series.
export function polyline(vals, top, width = 680, height = 140, pad = 8) {
  if (!vals.length) return '';
  const step = width / Math.max(vals.length - 1, 1);
  return vals.map((v, i) => (i * step).toFixed(1) + ',' + (height - ((v || 0) / (top || 1)) * (height - pad)).toFixed(1)).join(' ');
}

// ---- page furniture ----
export function pageHead(title, sub, actions) {
  return html`<header class="page-head"><div><h1>${title}</h1>${sub ? html`<p class="sub">${sub}</p>` : ''}</div>
    ${actions ? html`<div class="actions">${actions}</div>` : ''}</header>`;
}
export function emptyState(title, body, actions) {
  return html`<section class="panel empty-state"><h2>${title}</h2><p>${body}</p>${actions || ''}</section>`;
}
let _toastTimer;
export function toast(msg, ms = 3200) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = msg; el.hidden = false;
  clearTimeout(_toastTimer); _toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
// Inject a page's own CSS once.
const _css = new Set();
export function useCss(id, css) {
  if (_css.has(id) || !css || typeof document === 'undefined') return;
  _css.add(id);
  const s = document.createElement('style'); s.dataset.page = id; s.textContent = css; document.head.appendChild(s);
}
export const link = (route, text, cls = 'quiet-link') => html`<a class="${cls}" href="#/${route}">${text}</a>`;
