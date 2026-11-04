import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('offline captive page uses HTTPS for credentials and has no external assets', async () => {
  const html = await readFile(new URL('../portal/pilot-login.html', import.meta.url), 'utf8');
  assert.match(html, /<form action="https:\/\/hotspot\.pasofi\.onesa\.eu\/login" method="post">/);
  assert.match(html, /name="username"/);
  assert.match(html, /name="password" type="password"/);
  assert.match(html, /Pilot testing is in progress/);
  assert.doesNotMatch(html, /<(?:script|link|img|iframe)\b/i);
  assert.ok(Buffer.byteLength(html) < 3500);
});

test('router installer preserves original files and requires isolation and HTTPS', async () => {
  const script = await readFile(new URL('./pasofi-kuwadzana-branded-login.rsc', import.meta.url), 'utf8');
  const bind = script.indexOf('html-directory=$target');
  for (const required of ['Wrong router', 'Expected secure PasoFi profile', 'Expected trusted PasoFi certificate', 'IPv4 pilot isolation missing', 'IPv6 pilot isolation missing', 'Cannot find the current HotSpot HTML folder', 'PasoFi portal folder already exists', '/file copy $source name=$target', 'Login file verification failed']) {
    assert.ok(script.indexOf(required) >= 0 && script.indexOf(required) < bind, required);
  }
  assert.match(script, /method=\\"post\\"/);
  assert.doesNotMatch(script, /\/ip firewall (?:nat|filter) (?:add|set|remove)|\/ip hotspot walled-garden (?:add|set)|\/file remove|private-key\s*=|secret\s*=/i);
});
