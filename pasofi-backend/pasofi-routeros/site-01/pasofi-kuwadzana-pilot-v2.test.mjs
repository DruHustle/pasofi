import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('PasoFi pilot requires the reviewed certificate and isolates guests before activation', async () => {
  const script = await readFile(new URL('./pasofi-kuwadzana-pilot-v2.rsc', import.meta.url), 'utf8');
  const bind = script.indexOf('/ip hotspot profile set');
  const enable = script.indexOf('/interface wireless enable');
  for (const guard of ['Wrong router', 'Import the reviewed PasoFi certificate', 'Review existing PasoFi hotspot DNS entry', 'Review existing walled-garden entries', 'Pilot must not belong to a trusted interface list', 'PasoFi test: deny forward in', 'PasoFi test: deny forward out']) {
    assert.ok(script.indexOf(guard) >= 0 && script.indexOf(guard) < bind, guard);
  }
  assert.ok(bind > 0 && bind < enable);
  assert.match(script, /ssl-certificate=\$pasofiCert dns-name="hotspot\.pasofi\.onesa\.eu"/);
  assert.match(script, /dst-port=64873,64874,64875/);
  assert.doesNotMatch(script, /\/ip firewall nat add|\/ip hotspot walled-garden (?:add|set)|secret\s*=|private-key\s*=/i);
});
