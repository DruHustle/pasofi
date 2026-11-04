import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('captive detection fix only extends the isolated login rule after safety checks', async () => {
  const s = await readFile(new URL('./pasofi-kuwadzana-captive-fix.rsc', import.meta.url), 'utf8');
  const change = s.indexOf('/ip firewall filter set $pfiRule');
  for (const guard of ['Wrong router', 'Review walled-garden entries', 'IPv4 pilot forwarding isolation missing', 'IPv6 pilot forwarding isolation missing', 'Local login rule differs']) {
    assert.ok(s.indexOf(guard) >= 0 && s.indexOf(guard) < change, guard);
  }
  assert.match(s, /dst-port=64873,64874,64875/);
  assert.doesNotMatch(s, /\/ip firewall nat add|\/ip hotspot walled-garden (?:add|set)|secret\s*=|private-key\s*=/i);
  assert.doesNotMatch(s, /\/ip firewall filter (?:remove|disable)|\/ipv6 firewall filter (?:remove|disable)/);
});
