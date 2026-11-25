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

test('router forms allow both qualified PasoFi origins and exclude retired names', () => {
  const loginOrigins = ['https://login.pasofi.mobile.onesa.eu', 'https://wifi.pasofi.mobile.onesa.eu'];
  const deniedHosts = ['hotspot.pamofi.onesa.eu', 'hotspot.pasofi.onesa.eu'];
  const web = readFileSync(new URL('../src/NetworkAccess.tsx', import.meta.url), 'utf8');
  const mobile = readFileSync(new URL('../../mobile/src/NetworkAccess.tsx', import.meta.url), 'utf8');
  const mobileBuild = readFileSync(new URL('../../mobile/vite.config.ts', import.meta.url), 'utf8');
  for (const source of [web, mobile, mobileBuild]) {
    for (const origin of loginOrigins) assert.ok(source.includes(origin), origin + ' must be a default RouterOS form origin');
    for (const host of deniedHosts) {
      assert.ok(source.includes(host), host + ' must remain explicitly denied, including env overrides');
    }
  }
  assert.equal(mobileBuild.includes("name: 'pasofi-mobile-build-policy'"), true);
  const policy = config.headers?.flatMap(h => h.headers || []).find(h => h.key === 'Content-Security-Policy')?.value;
  const webGateway = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8');
  const captiveGateway = readFileSync(new URL('../../../pasofi-backend/infra/production/gateway/vercel.conf.template', import.meta.url), 'utf8');
  for (const source of [policy ?? '', webGateway, captiveGateway]) {
    assert.equal(source.match(/\bform-action ([^";]+)/)?.[1], "'self' " + loginOrigins.join(' '));
  }
});
