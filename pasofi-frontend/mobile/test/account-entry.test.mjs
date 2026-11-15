import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const component = readFileSync(
  new URL('../src/MobileCustomer.tsx', import.meta.url),
  'utf8',
);

test('unconfigured native customers are not sent to Portal administration', () => {
  assert.doesNotMatch(component, /portal\.onesa\.eu\/admin/);
  assert.match(component, /https:\/\/pasofi\.mobile\.onesa\.eu\/#account/);
  assert.match(component, /https:\/\/auth\.onesa\.eu\/register/);
});

test('unreachable account gateway has a bounded offline fallback', () => {
  assert.match(component, /setTimeout\(\(\) => \{/);
  assert.match(component, /12000\)/);
  assert.match(component, /did not respond in time/);
  assert.match(component, /clearTimeout\(timeout\)/);
  assert.match(component, /onSessionChange\(\(\) => \{ clearTimeout\(timeout\); controller\.abort\(\); setCapabilities\(null\); setLoading\(false\)/);
});
