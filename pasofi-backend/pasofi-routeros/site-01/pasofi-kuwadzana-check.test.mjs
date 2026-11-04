import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('Kuwadzana check identifies the router and does not modify it or disclose secrets', async () => {
  const script = await readFile(new URL('./pasofi-kuwadzana-check.rsc', import.meta.url), 'utf8');
  assert.match(script, /AMJXVTVrpj0512Eoj5A6DWNAnjySBPF3VmzODGeN\/FE=/);
  assert.match(script, /Pilot bridge and Wi-Fi must be disabled/);
  assert.match(script, /Pilot IPv4 isolation rules/);
  assert.match(script, /Pilot IPv6 isolation rules/);
  assert.doesNotMatch(script, /\/(?:interface|ip|ipv6|radius|certificate)[^\n]*(?:\s(?:add|set|enable|disable|remove|import)\s)/);
  assert.doesNotMatch(script, /private-key|secret\s*=|password\s*=/i);
});
