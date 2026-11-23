import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followOnesaLogout } from '../src/onesa-browser-logout.ts';

test('browser follows only the exact Onesa end-session URL with its own fixed return', () => {
  const origin = 'https://pasofi.example.test', navigated = [];
  const browser = { origin, replace: value => navigated.push(value) };
  const trusted = new URL('https://auth.onesa.eu/v2/logout');
  trusted.searchParams.set('client_id', 'pasofi_fixture_client');
  trusted.searchParams.set('returnTo', origin + '/');
  for (const value of [
    undefined,
    { endSessionUrl: trusted.href.replace('auth.onesa.eu', 'auth.onesa.eu.example.test') },
    { endSessionUrl: trusted.href.replace('/v2/logout', '/authorize') },
    { endSessionUrl: trusted.href.replace(encodeURIComponent(origin + '/'), encodeURIComponent(origin + '/other')) },
    { endSessionUrl: trusted.href + '&client_id=pasofi_fixture_client' },
    { endSessionUrl: trusted.href + '&federated=1' },
  ]) followOnesaLogout(value, browser);
  assert.deepEqual(navigated, []);
  followOnesaLogout({ endSessionUrl: trusted.href }, browser);
  assert.deepEqual(navigated, [trusted.href]);
});
