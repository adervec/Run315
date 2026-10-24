// Boot, the router and the shell. Pages are lazy modules in js/pages/: each exports
// `render(params)` returning html`` (sync or async) and optionally `mount(el, params)`
// for wiring events, maps and charts once the markup is in the document.
import { loadState, state, save, onChange } from './store.js';
import { html, esc } from './ui.js';
import * as drive from './drive.js';
import * as cowork from './cowork.js';

// The nav, grouped by what you came to do. `tab` marks the five the phone's tab bar shows.
export const NAV = [
  { group: 'Train', items: [
    { route: '', page: 'today', label: 'Today', tab: 'Today' },
    { route: 'activities', page: 'activities', label: 'Activities', tab: 'Log' },
    { route: 'sessions', page: 'sessions', label: 'Track & intervals' },
    { route: 'races', page: 'races', label: 'Races', tab: 'Races' },
  ] },
  { group: 'Analyse', items: [
    { route: 'ask', page: 'ask', label: 'Ask & coach', tab: 'Ask' },
    { route: 'experiments', page: 'experiments', label: 'Experiments' },
    { route: 'vitals', page: 'vitals', label: 'Vitals' },
    { route: 'durability', page: 'durability', label: 'Durability' },
    { route: 'climbing', page: 'climbing', label: 'Climbing' },
    { route: 'second-opinion', page: 'secondopinion', label: 'Second opinion' },
    { route: 'career', page: 'career', label: 'Career' },
  ] },
  { group: 'Explore', items: [
    { route: 'routes', page: 'routes', label: 'Route maker' },
    { route: 'repeats', page: 'repeats', label: 'My routes' },
    { route: 'trails', page: 'trails', label: 'Trails' },
    { route: 'territory', page: 'territory', label: 'Territory' },
  ] },
  { group: 'Kit & data', items: [
    { route: 'gear', page: 'gear', label: 'Gear' },
    { route: 'sync', page: 'sync', label: 'Sync & cowork' },
  ] },
];
// Detail routes that are not in the nav: prefix -> page.
const DETAIL = { activity: 'activity', race: 'race' };

const ICONS = {
  Today: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  Log: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  Races: '<path d="M5 21V4h11l-2 4 2 4H5"/>',
  Ask: '<path d="M4 5h16v11H9l-5 4z"/>',
  More: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
};
const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;

function parseHash() {
  const path = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('?')[0];
  const [head, ...rest] = path.split('/');
  if (DETAIL[head] && rest.length) return { page: DETAIL[head], route: head, params: { id: rest.join('/') } };
  for (const g of NAV) for (const it of g.items) if (it.route === head) return { page: it.page, route: it.route, params: {} };
  return { page: 'today', route: '', params: {} };
}

function syncDot() {
  const c = state.local.cloud || {};
  if (!c.enabled) return html`<span class="dot"></span>Not syncing`;
  return c.lastError ? html`<span class="dot err"></span>Sync error` : html`<span class="dot ok"></span>Drive synced`;
}
function renderNav(current) {
  const nav = document.getElementById('nav');
  nav.innerHTML = String(html`
    <a class="brand" href="#/">Run<span>315</span></a>
    ${NAV.map(g => html`<div class="nav-group"><p>${g.group}</p>
      ${g.items.map(it => html`<a href="#/${it.route}" ${it.route === current ? html`aria-current="page"` : ''}>${it.label}</a>`)}</div>`)}
    <div class="nav-foot">${syncDot()}</div>`);
  const tabs = NAV.flatMap(g => g.items).filter(it => it.tab);
  document.getElementById('tabbar').innerHTML = tabs.map(it =>
    `<a href="#/${it.route}"${it.route === current ? ' aria-current="page"' : ''}>${icon(it.tab)}${esc(it.tab)}</a>`).join('')
    + `<button type="button" id="more">${icon('More')}More</button>`;
  document.getElementById('more').onclick = () => nav.classList.toggle('open');
}

let _seq = 0;
async function route() {
  const seq = ++_seq, { page, route: r, params } = parseHash();
  document.getElementById('nav').classList.remove('open');
  renderNav(DETAIL[r] ? (r === 'race' ? 'races' : 'activities') : r);
  const main = document.getElementById('page');
  let mod;
  try { mod = await import(`./pages/${page}.js`); }
  catch (e) { main.innerHTML = `<section class="panel"><p>That page did not load: ${esc(e.message)}</p></section>`; console.error(e); return; }
  let out;
  try { out = await mod.render(params); }
  catch (e) { console.error(e); out = html`<section class="panel"><p class="eyebrow">Something broke</p><pre>${e.stack || e}</pre></section>`; }
  if (seq !== _seq) return;   // a newer navigation won
  main.innerHTML = String(out);
  document.title = (mod.title ? (typeof mod.title === 'function' ? mod.title(params) : mod.title) + ' · ' : '') + 'Run315';
  if (mod.mount) { try { await mod.mount(main, params); } catch (e) { console.error(e); } }
  if (!location.hash.includes('#keep')) window.scrollTo(0, 0);
}
export const rerender = () => route();

function applyTheme() {
  const t = state.local.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

async function boot() {
  await loadState();
  applyTheme();
  // Re-render on data that came from elsewhere (Drive, the cowork inbox); a page's own edits re-render themselves.
  let pending = null;
  onChange(why => {
    if (why === 'theme') applyTheme();
    if (['cloud', 'cowork-import', 'demo', 'theme', 'derive'].includes(why)) { clearTimeout(pending); pending = setTimeout(route, 150); }
    else if (why === 'cloud-meta') renderNav(parseHash().route);
  });
  addEventListener('hashchange', route);
  await route();
  drive.startAutoSync();
  cowork.startScheduler();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
}
boot();
