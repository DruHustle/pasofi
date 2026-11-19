import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const canonical = 'https://pasofi.mobile.onesa.eu/:path*';
const alternateHosts = ['pasofi.onesa.eu', 'pamofi.onesa.eu', 'pamofi.vercel.app'];

test('alternate and retired PasoFi domains redirect to the sole accepted customer origin', () => {
  const redirects = config.redirects ?? [];
  for (const host of alternateHosts) {
    const matches = redirects.filter(rule =>
      rule.source === '/:path*' &&
      rule.has?.length === 1 &&
      rule.has[0].type === 'host' &&
      rule.has[0].value === host);
    assert.equal(matches.length, 1, `${host} must have one redirect`);
    assert.equal(matches[0].destination, canonical);
    assert.equal(matches[0].permanent, true);
  }
  assert.ok(!redirects.some(rule => rule.has?.some(condition =>
    condition.type === 'host' && condition.value === 'pasofi.mobile.onesa.eu')),
    'the canonical customer domain must never redirect to itself');
  assert.ok(config.rewrites?.some(rule => rule.source === '/api/:path*'),
    'canonical API proxy remains configured');
});
