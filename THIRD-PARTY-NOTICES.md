# Third-party notices

Run315 ships these libraries unmodified in `static/vendor/` so the app makes no requests to
third-party code hosts. Each keeps its own licence; the full texts are at the sources below.

| Library | Version | Licence | Where in Run315 | Source |
|---|---|---|---|---|
| Leaflet | 1.9.4 | BSD-2-Clause | `static/vendor/leaflet/` (maps) | https://github.com/Leaflet/Leaflet |
| sql.js (SQLite compiled to WebAssembly) | 1.14.2 | MIT; SQLite itself is public domain | `static/vendor/sql.js/` (SQL console) | https://github.com/sql-js/sql.js |
| Anthropic TypeScript SDK (`@anthropic-ai/sdk`) | 0.132.1 | MIT | `static/vendor/anthropic-sdk/` (Ask and coach with your own key) | https://github.com/anthropics/anthropic-sdk-typescript |
| standardwebhooks (an SDK dependency) | 1.1.1 | MIT | `static/vendor/anthropic-sdk/` | https://github.com/standard-webhooks/standard-webhooks |
| @stablelib/base64 (an SDK dependency) | 1.0.1 | MIT | `static/vendor/anthropic-sdk/` | https://github.com/StableLib/stablelib |
| fast-sha256 (an SDK dependency) | 1.3.0 | Unlicense | `static/vendor/anthropic-sdk/` | https://github.com/dchest/fast-sha256-js |

The Anthropic SDK files are jsDelivr's `+esm` build of the npm package, with its imports
rewritten to the local file names; the code is otherwise as published.

Fonts (Atkinson Hyperlegible, Archivo, IBM Plex Sans and IBM Plex Mono, all SIL Open Font
License 1.1) are not bundled here: they are served from `adervec.github.io/fonts/`, which
carries their notices.

Map tiles are © OpenStreetMap contributors (ODbL), credited on every map.
