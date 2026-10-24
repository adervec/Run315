// The route maker: Leaflet over OSM tiles, BRouter for the line, Overpass for what is
// along it, saved routes in the synced state. The markup is here; the behaviour lives in
// js/routemaker.js, which mount() points at this page's container.
import { state } from '../store.js';
import { html, pageHead, useCss } from '../ui.js';
import { loadLeaflet, routeMaker, whenGone } from '../routemaker.js';

export const title = 'Route maker';

// Everything below is map furniture the design system does not have yet.
// Colours, type and spacing all come from the tokens in app.css.
const CSS = `
.rm .map-panel { padding: 0; overflow: hidden; }
.rm #map { height: 620px; width: 100%; background: var(--ground); }

/* Leaflet ships its own type stack; pull it back onto ours. */
.rm .leaflet-container { font-family: var(--body); font-size: 13px; }
.rm .leaflet-control-attribution { font-family: var(--mono); font-size: 10px; }

.rm select { width: 100%; }
.rm select:focus { border-color: var(--projected); }
.rm .field-full { width: 100%; }
.rm-grid { grid-template-columns: minmax(260px, 340px) 1fr; }

.rm .btn-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.rm .btn-row .btn { flex: 1 1 auto; text-align: center; }
.rm .btn-sm { font-size: 12px; padding: 6px 10px; }

/* status lines: one per concern, so a slow POI search cannot wipe a routing error */
.rm .status {
  font-family: var(--mono); font-size: 11px; line-height: 1.4;
  color: var(--muted); margin: 8px 0 0; min-height: 15px;
}
.rm .status.is-error { color: var(--behind); }

/* waypoint list */
.rm .wp-list { max-height: 210px; overflow-y: auto; margin: 4px 0 0; }
.rm .wp-row {
  display: flex; align-items: center; gap: 5px;
  padding: 4px 0; border-top: 1px solid var(--line);
}
.rm .wp-row:first-child { border-top: none; }
.rm .wp-badge {
  width: 20px; height: 20px; border-radius: 50%; color: #fff;
  font-family: var(--mono); font-size: 11px; font-weight: 500;
  display: flex; align-items: center; justify-content: center; flex: 0 0 auto;
}
.rm .wp-co {
  flex: 1; min-width: 0; font-family: var(--mono); font-size: 11px;
  color: var(--muted); font-variant-numeric: tabular-nums;
}
.rm .wp-btn {
  font-family: var(--body); font-size: 12px; line-height: 1;
  padding: 4px 6px; border: 1.5px solid var(--line); border-radius: 2px;
  background: var(--surface); color: var(--ink); cursor: pointer;
}
.rm .wp-btn:hover { border-color: var(--ink); }

/* map pins are rendered by Leaflet divIcons, so they are styled here not inline.
   White on the categorical palette, in either theme: the pins sit on OSM tiles. */
.wp-pin {
  width: 26px; height: 26px; border-radius: 50% 50% 50% 0; transform: rotate(-45deg);
  color: #fff; font-family: var(--mono); font-size: 12px; font-weight: 500;
  display: flex; align-items: center; justify-content: center;
  border: 2px solid #fff; box-shadow: 0 1px 3px rgba(16, 24, 40, .45);
}
.wp-pin span { transform: rotate(45deg); }
.wp-arrow { font-size: 15px; line-height: 16px; text-align: center; }
.poi-pin { font-size: 18px; line-height: 22px; text-align: center; }

/* POI toggles */
.rm .chips { display: flex; flex-wrap: wrap; gap: 6px; }
.rm .layer-group {
  font-family: var(--mono); font-size: 10px; letter-spacing: 0.12em;
  text-transform: uppercase; color: var(--muted); margin: 14px 0 6px;
}
.rm .layer-group:first-child { margin-top: 0; }
.rm .free-toggle {
  display: flex; align-items: center; gap: 7px; margin-top: 14px;
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--muted); cursor: pointer;
}
.poi-tag {
  display: inline-block; font-family: var(--mono); font-size: 10px;
  padding: 1px 5px; border-radius: 2px; margin-left: 6px; vertical-align: 1px;
}
.poi-free { background: color-mix(in srgb, var(--ahead) 16%, transparent); color: var(--ahead); }
.poi-paid { background: color-mix(in srgb, var(--behind) 14%, transparent); color: var(--behind); }
.poi-unknown { background: var(--track); color: var(--muted); }
.poi-meta { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 4px; }
.rm .chip {
  flex: 1 0 45%; padding: 6px 4px; border: 1.5px solid var(--line); border-radius: 2px;
  background: transparent; text-align: center; cursor: pointer; user-select: none;
  font-family: var(--mono); font-size: 11px; letter-spacing: 0.04em; color: var(--muted);
}
.rm .chip:hover { border-color: var(--ink); }
.rm .chip.on { background: var(--measured); border-color: var(--measured); color: var(--on-ink); }

.rm .elev-chart { height: 120px; }
.rm .route-stats { display: flex; gap: 28px; }
.rm .route-stats .stat { border-top: none; padding: 0; }

@media (max-width: 820px) {
  .rm-grid { grid-template-columns: 1fr; }
  .rm #map { height: 420px; }
  /* On a phone the map comes first: it is what you tap on. */
  .rm-grid > .rm-map { order: -1; }
}
`;

export function render() {
  useCss('routes', CSS);
  const n = Object.keys(state.routes).length;
  return html`
  ${pageHead('Route maker', `Route planner · BRouter & OpenStreetMap${n ? ` · ${n} saved route${n === 1 ? '' : 's'}` : ''}`)}
  <div class="rm grid-2 rm-grid">

    <!-- controls -->
    <div>

      <section class="panel">
        <div class="panel-head"><p class="eyebrow">Route</p></div>

        <div class="field field-full" style="margin-bottom:10px">
          <label for="profile">Surface</label>
          <select id="profile">
            <option value="hiking-mountain" selected>Running · trail</option>
            <option value="trekking">Cycling · trekking</option>
            <option value="fastbike">Cycling · fast / road</option>
            <option value="mtb">Cycling · MTB</option>
            <option value="shortest">Shortest line</option>
          </select>
        </div>

        <div class="field field-full">
          <label for="rtype">Shape</label>
          <select id="rtype">
            <option value="p2p">Point to point</option>
            <option value="loop">Loop — return to start</option>
            <option value="outback">Out &amp; back</option>
          </select>
        </div>

        <div class="route-stats" style="margin-top:16px">
          <div class="stat">
            <div class="stat-value"><span id="km">0.00</span><small class="unit">km</small></div>
            <div class="stat-label">Distance</div>
          </div>
          <div class="stat">
            <div class="stat-value"><span id="climb">0</span><small class="unit">m</small></div>
            <div class="stat-label">Climb</div>
          </div>
        </div>

        <p class="status" id="mapstatus" role="status"></p>

        <div class="form-row" style="margin-top:14px">
          <div class="field field-grow">
            <label for="target">Target distance (km)</label>
            <input type="number" id="target" min="1" max="300" step="0.5" placeholder="10">
          </div>
          <button class="btn btn-ghost btn-sm" type="button" id="autoloop">Auto-loop</button>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <p class="eyebrow">Waypoints</p>
        </div>
        <p class="stat-hint" id="wpempty" style="margin-top:0">Click the map to drop your
          first waypoint. Drag a pin to nudge it; the route re-snaps to roads and paths.</p>
        <div class="wp-list" id="wplist"></div>
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm" type="button" id="reverse">Reverse</button>
          <button class="btn btn-ghost btn-sm" type="button" id="undo">Undo</button>
          <button class="btn btn-ghost btn-sm" type="button" id="clear">Clear</button>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <p class="eyebrow">Layers</p>
        </div>
        <div id="layers">
          <p class="stat-hint">Loading layers…</p>
        </div>
        <label class="free-toggle">
          <input type="checkbox" id="freeonly"> Free only
        </label>
        <p class="status" id="poistatus" role="status"></p>
        <p class="stat-hint">Found along the drawn route and updated as you edit it.
          Beaches, pools and parks are picked up from further out than a tap or a
          toilet, because they are worth a longer detour.</p>
      </section>

      <section class="panel">
        <div class="panel-head">
          <p class="eyebrow">Saved routes</p>
        </div>
        <div class="form-row">
          <div class="field field-grow">
            <label for="rname">Name</label>
            <input type="text" id="rname" placeholder="Thursday hills" maxlength="120">
          </div>
          <button class="btn btn-sm" type="button" id="save">Save</button>
        </div>
        <div class="field field-full" style="margin-top:12px">
          <label for="rlist">Your routes</label>
          <select id="rlist"></select>
        </div>
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm" type="button" id="load">Open</button>
          <button class="btn btn-ghost btn-sm" type="button" id="dup">Duplicate</button>
          <button class="btn btn-ghost btn-sm" type="button" id="ren">Rename</button>
          <button class="btn btn-ghost btn-sm" type="button" id="delr">Delete</button>
        </div>
        <p class="status" id="libstatus" role="status"></p>
        <div class="btn-row">
          <button class="btn btn-ghost btn-sm" type="button" id="import">Import GPX…</button>
          <button class="btn btn-ghost btn-sm" type="button" id="dl">Export GPX</button>
        </div>
        <input type="file" id="gpxfile" accept=".gpx,.xml" hidden>
      </section>

    </div>

    <!-- map + elevation -->
    <div class="rm-map">
      <section class="panel map-panel">
        <div id="map"></div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <p class="eyebrow">Elevation</p>
          <p class="panel-note" id="elevrange"></p>
        </div>
        <svg id="elevsvg" class="chart elev-chart" viewBox="0 0 1000 100"
             preserveAspectRatio="none" role="img" aria-label="Elevation profile"></svg>
        <div class="empty" id="elevempty"><p>Two waypoints or more and the profile appears
          here, read straight off the routed line.</p></div>
      </section>
    </div>

  </div>`;
}

export async function mount(el) {
  const box = el.querySelector('#map');
  if (!box) return;
  let L;
  try { L = await loadLeaflet(); }
  catch (e) {
    const s = el.querySelector('#mapstatus');
    if (s) { s.textContent = e.message; s.classList.add('is-error'); }
    return;
  }
  if (!box.isConnected) return;   // the user moved on while Leaflet loaded
  // Scoped to the page's own wrapper, not #page: destroy() still reads the (detached)
  // controls to keep the draft after the router has swapped another page in.
  const destroy = routeMaker(el.querySelector('.rm'), L);
  whenGone(box, destroy);
}
