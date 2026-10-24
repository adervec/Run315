// Gear & conditions: mileage per pair counted from your own runs (Garmin- and
// Strava-tagged alike), a replace-at distance you can set per item, and pace against
// the weather, raw and heat-corrected.
import { state, save } from '../store.js';
import { put } from '../merge.js';
import * as D from '../derive.js';
import { html, pageHead, fmtPace, toast, useCss } from '../ui.js';

export const title = 'Gear';

const CSS = `
.wear { display: block; height: 8px; background: var(--track); border-radius: 4px; overflow: hidden; margin-top: 6px; }
.wear i { display: block; height: 100%; background: var(--measured); }
.wear i.warn { background: #b07d2b; }
.wear i.gone { background: var(--behind); }
.shoe-name { font-weight: 600; font-size: 16px; }
.shoe-sub { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.retired td { opacity: 0.55; }
.gear-src { font-family: var(--mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); margin-left: 6px; }
.gear-src.strava { color: #fc4c02; }
.limit-edit { display: inline-flex; align-items: center; gap: 4px; margin-top: 4px; }
.limit-edit input { width: 76px; padding: 3px 6px; font-size: 12px; }
`;

// Strava gear is keyed `strava:<id>` by the importer; everything else is Garmin's uuid.
const sourceOf = g => (g.source === 'strava' || String(g.uuid).startsWith('strava:') ? 'strava' : 'garmin');

function gearPanel(gear) {
  const defaultKm = Math.round(D.DEFAULT_SHOE_LIFE_M / 1000);
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">Shoes</p>
      <p class="panel-note">Mileage counted from your own runs</p>
    </div>
    ${gear.length ? html`<div class="table-scroll"><table>
      <thead><tr><th>Pair</th><th class="num">Distance</th><th class="num">Runs</th><th class="num">Left</th><th>Life</th></tr></thead>
      <tbody>${gear.map(g => {
        const src = sourceOf(g), own = state.gear[g.uuid]?.limit_m;
        return html`<tr class="${g.retired ? 'retired' : ''}">
        <td>
          <span class="shoe-name">${g.name || g.model || 'Unnamed'}</span>
          <span class="gear-src ${src}" title="Comes from ${src === 'strava' ? 'Strava' : 'Garmin'}">${src === 'strava' ? 'Strava' : 'Garmin'}</span>
          ${g.worn_out ? html` <span class="break-chip k-exhaustion">replace</span>`
            : g.getting_on ? html` <span class="break-chip k-climb">getting on</span>` : ''}
          ${g.retired ? html` <span class="dim">retired</span>` : ''}
          ${g.first_used ? html`<br><span class="shoe-sub">${String(g.first_used).slice(0, 10)} → ${String(g.last_used).slice(0, 10)}</span>` : ''}
        </td>
        <td class="num actual">${Math.round(g.distance_m / 1000)} km</td>
        <td class="num dim">${g.runs}</td>
        <td class="num ${g.worn_out ? 'behind' : ''}">${g.worn_out ? '0 km' : Math.round(g.remaining_m / 1000) + ' km'}</td>
        <td style="width:32%;min-width:130px">
          <span class="wear"><i class="${g.worn_out ? 'gone' : g.getting_on ? 'warn' : ''}" style="width:${Math.round(Math.min(g.share, 1) * 100)}%"></i></span>
          <label class="limit-edit shoe-sub">replace at
            <input type="number" min="0" step="10" inputmode="numeric" data-limit="${g.uuid}"
              value="${own ? Math.round(own / 1000) : ''}" placeholder="${defaultKm}" aria-label="Replace-at distance in km for ${g.name || 'this item'}"> km</label>
        </td>
      </tr>`; })}</tbody>
    </table></div>
    <p class="stat-hint" style="margin-top:12px">
      Shoes come from Garmin and Strava; the replace-at figure is Garmin's where it
      has one, or whatever you set here. Where there is none,
      ${defaultKm} km is assumed — it is a rule of thumb, not a rule.
    </p>`
    : html`<div class="empty">
      <p>No gear found. Add your shoes in Garmin Connect or Strava and tag your runs with
        them; the mileage shows up here once the next import arrives.</p>
      <a class="btn" href="#/sync">Set up sync</a>
    </div>`}
  </section>`;
}

function seasonsPanel(seasons) {
  return html`<section class="panel">
    <div class="panel-head">
      <p class="eyebrow">Pace against the weather</p>
      <p class="panel-note">Last 400 days</p>
    </div>
    <div class="empty"><p>The same effort is simply slower in the heat. The corrected
      column is what your summer runs are actually worth, so a July slump stops
      looking like lost fitness.</p></div>
    <div class="table-scroll"><table>
      <thead><tr><th>Conditions</th><th class="num">Runs</th><th class="num">Average</th>
        <th class="num">Raw pace</th><th class="num">Corrected</th><th class="num">Worth</th></tr></thead>
      <tbody>${seasons.map(b => {
        const gain = b.mean_pace - b.mean_adjusted;
        return html`<tr>
        <td>${b.label}</td>
        <td class="num dim">${b.runs}</td>
        <td class="num dim">${Math.round(b.mean_temp)} C</td>
        <td class="num">${fmtPace(b.mean_pace, 1000)}</td>
        <td class="num actual">${fmtPace(b.mean_adjusted, 1000)}</td>
        <td class="num ${gain > 1 ? 'ahead' : 'dim'}">${gain > 1 ? '−' + Math.round(gain) + 's' : '—'}</td>
      </tr>`; })}</tbody>
    </table></div>
  </section>`;
}

export function render() {
  useCss('gear', CSS);
  const gear = D.gearTable(state), seasons = D.weatherSeasons(state) || [];
  return html`${pageHead('Gear', 'Gear & conditions')}
    ${gearPanel(gear)}
    ${seasons.length ? seasonsPanel(seasons) : ''}`;
}

export function mount(el) {
  el.querySelectorAll('[data-limit]').forEach(inp => inp.onchange = () => {
    const uuid = inp.dataset.limit, rec = state.gear[uuid];
    if (!rec) return;
    const km = parseFloat(inp.value);
    if (inp.value.trim() && !(km > 0)) { toast('Enter a distance in km, or leave it blank for the default.'); return; }
    // Blank clears it back to the default life.
    put(state, 'gear', uuid, { ...rec, limit_m: inp.value.trim() ? km * 1000 : null });
    save('edit');
    toast(inp.value.trim() ? `${rec.name || 'Item'}: replace at ${Math.round(km)} km.` : `${rec.name || 'Item'}: back to the default.`);
    el.innerHTML = String(render()); mount(el);
  });
}
