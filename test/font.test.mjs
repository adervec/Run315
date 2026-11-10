// The house font: font.js loads before the styles, body text follows --app-font (falling back
// to the old stack when the script is unreachable), and the reader's picker is in settings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('house font wiring', () => {
  const index = readFileSync('index.html', 'utf8'), css = readFileSync('css/app.css', 'utf8');
  const script = index.indexOf('<script src="https://adervec.github.io/font.js"></script>');
  assert.ok(script > 0 && script < index.indexOf('css/app.css'), 'font.js in <head>, before the styles, not deferred');
  assert.match(css, /--body: var\(--app-font, "IBM Plex Sans"/);
  assert.match(readFileSync('js/pages/sync.js', 'utf8'), /<app-font-picker><\/app-font-picker>/);
});
