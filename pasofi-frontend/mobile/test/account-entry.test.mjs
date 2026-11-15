import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const apiSource = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');

const signInComponent = readFileSync(new URL('../src/OnesaSignIn.tsx', import.meta.url), 'utf8');
const homeComponent = readFileSync(new URL('../src/MobileApp.tsx', import.meta.url), 'utf8');

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
  const sessionChange = component.match(/onSessionChange\\(\\(\\) => \\{([^}]*)\\}\\)/)?.[1] ?? "";
  assert.match(sessionChange, /clearTimeout\\(timeout\\)/);
  assert.match(sessionChange, /controller\\.abort\\(\\)/);
  assert.match(sessionChange, /setCapabilities\\(null\\)/);
  assert.match(sessionChange, /setLoading\\(true\\)/);
  assert.match(sessionChange, /setAttempt\\(value => value \\+ 1\\)/);
});

test('invalid API origin does not advertise configured customer account access', () => {
  assert.match(apiSource, /export const mobileApiConfigured = mobileApiOrigin !== null/);
  assert.doesNotMatch(apiSource, /mobileApiConfigured = !!import\.meta\.env/);
});

test('offline home account tab never links customers to Portal administration', () => {
  assert.doesNotMatch(homeComponent, /portal\.onesa\.eu\/admin/);
  assert.match(homeComponent, /https:\/\/pasofi\.mobile\.onesa\.eu\/#account/);
  assert.match(homeComponent, /https:\/\/auth\.onesa\.eu\/register/);
  assert.doesNotMatch(homeComponent, /create an account with Company Portal/);
});

test('native Onesa sign-in fallback uses customer destinations, not admin UI', () => {
  assert.doesNotMatch(signInComponent, /portal\.onesa\.eu\/admin/);
  assert.match(signInComponent, /https:\/\/pasofi\.mobile\.onesa\.eu\/#account/);
  assert.match(signInComponent, /https:\/\/auth\.onesa\.eu\/register/);
  assert.match(signInComponent, /register through Onesa Identity/);
});
