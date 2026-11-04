import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicOrigins } from '../dist/public-origins.js';

test('origin migration accepts only explicit secure origins and fails closed on invalid aliases', () => {
  const original = 'https://pamofi.onesa.eu', next = 'https://pasofi.onesa.eu';
  const origins = publicOrigins(original, JSON.stringify([next]), false);
  assert.equal(origins.has(original), true);
  assert.equal(origins.has(next), true);
  assert.equal(origins.has('https://evil.onesa.eu'), false);
  for (const invalid of ['["http://pasofi.onesa.eu"]', '["https://pasofi.onesa.eu/"]', '[null]', '{}', '["https://a.test","https://b.test","https://c.test","https://d.test"]']) {
    assert.equal(publicOrigins(original, invalid, false), null);
  }
});
