import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatar } from '../js/ui.js';

test('Drive account picture: round img with no referrer, nothing without one', () => {
  const out = String(avatar({ name: 'A', picture: 'https://lh3.googleusercontent.com/a/x=s96-c' }));
  assert.match(out, /<img class="avatar" src="https:\/\/lh3\.googleusercontent\.com\/a\/x=s96-c" alt="" referrerpolicy="no-referrer"/);
  assert.equal(String(avatar({ name: 'A' })), '');
  assert.equal(String(avatar(null)), '');
  assert.doesNotMatch(String(avatar({ picture: '"><script>' })), /<script>/);
});
