import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const apiSource = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');

const component = readFileSync(
  new URL('../src/MobileCustomer.tsx', import.meta.url),
  'utf8',
);

test('unconfigured native customers are not sent to Portal administration', () => {
  assert.doesNotMatch(component, /portal\.onesa\.eu\/admin/);
  assert.match(component, /https:\/\/pasofi\.mobile\.onesa\.eu\/#account/);
  assert.match(component, /https:\/\/auth\.onesa\.eu\/register/);
  assert.doesNotMatch(component, /Continue with Company Portal on the PasoFi website/);
});

test('unreachable account gateway has a bounded offline fallback', () => {
  assert.match(component, /setTimeout\(\(\) => \{/);
  assert.match(component, /12000\)/);
  assert.match(component, /did not respond in time/);
  assert.match(component, /clearTimeout\(timeout\)/);
  assert.match(component, /onSessionChange\(\(\) => \{ clearTimeout\(timeout\); controller\.abort\(\); setCapabilities\(null\); setLoading\(false\)/);
});

test('invalid API origin does not advertise configured customer account access', () => {
  assert.match(apiSource, /export const mobileApiConfigured = mobileApiOrigin !== null/);
  assert.doesNotMatch(apiSource, /mobileApiConfigured = !!import\.meta\.env/);
});
