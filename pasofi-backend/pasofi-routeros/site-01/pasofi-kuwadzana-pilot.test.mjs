import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('isolated pilot identifies its router and installs IPv4 and IPv6 drops before enabling guests', async () => {
  const script = await readFile(new URL('./pasofi-kuwadzana-pilot.rsc', import.meta.url), 'utf8');
  const enable = script.indexOf('/interface wireless enable');
  for (const required of [
    'Wrong router', 'Pilot must not belong to a trusted interface list',
    'Review MAC management access', 'Review existing walled-garden entries',
    '/ip firewall filter add chain=forward action=drop in-interface="pfi-pilot-br"',
    '/ip firewall filter add chain=forward action=drop out-interface="pfi-pilot-br"',
    '/ipv6 firewall filter add chain=forward action=drop in-interface="pfi-pilot-br"',
    '/ipv6 firewall filter add chain=forward action=drop out-interface="pfi-pilot-br"',
    'PasoFi test: deny input', 'PasoFi test: deny output',
    '/radius enable', '/ip hotspot enable', '/ip dhcp-server enable',
  ]) assert.ok(script.indexOf(required) >= 0 && script.indexOf(required) < enable, required);
  assert.match(script, /dst-port=64873,64874,64875/);
  assert.doesNotMatch(script, /\/ip firewall nat add|\/ip hotspot walled-garden (?:add|set)|secret\s*=|private-key\s*=/i);
  assert.doesNotMatch(script, /\/ip firewall filter (?:remove|disable)|\/ipv6 firewall filter (?:remove|disable)/);
});
