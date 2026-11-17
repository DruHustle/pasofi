import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { validateTargetTopology } from './topology.mjs';

const script = readFileSync(new URL('./K0_FIRST_CONTACT.rsc', import.meta.url), 'utf8');
const target = JSON.parse(readFileSync(new URL('./topology.target.json', import.meta.url), 'utf8'));
const readOnlyMenus = new Set([
  '/system identity', '/system routerboard', '/system resource',
  '/system package', '/system device-mode', '/interface ethernet',
  '/interface bridge', '/interface bridge port', '/interface list member',
  '/ip address', '/ip route', '/ip dhcp-client', '/ip dhcp-server',
  '/ip service', '/ip hotspot', '/ipv6 settings'
]);

test('K0 first contact only reads public RouterOS state and emits private output locally', () => {
  const lines = script.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
  assert.ok(lines.length >= 15);
  for (const line of lines) {
    if (line.startsWith(':put ')) {
      assert.match(line, /^:put "[^"]*"$/);
      continue;
    }
    const match = /^:do \{ (\/[\w-]+(?: [\w-]+){0,2}) print \} on-error=\{ :put "[^"]+" \}$/.exec(line);
    assert.ok(match, 'only explicit read-only print operations may run: ' + line);
    assert.ok(readOnlyMenus.has(match[1]), 'disallowed RouterOS menu: ' + match[1]);
  }
  assert.ok(script.includes('Do NOT paste full output'));
  assert.ok(script.includes('legacy hAP lite site-01'));
  assert.ok(!script.includes('/radius print') && !script.includes('/interface wireguard print'));
  assert.ok(!script.includes('/system backup') && !script.includes('/export'));
});

test('K0 OS3 is owner-reported connected but not yet accepted', () => {
  const result = validateTargetTopology(target);
  assert.equal(result.physicalAcceptance, false);
  assert.equal(result.routersChanged, false);
  assert.equal(result.commerceEnabled, false);
  const site = target.sites.find(site => site.slug === 'kuwadzana');
  assert.equal(site.gateway.label, 'K0');
  assert.equal(site.gateway.device, 'MikroTik hEX');
  for (const label of ['K2', 'K3']) {
    const node = site.nodes.find(node => node.label === label);
    assert.equal(node.targetDevice, 'Tenda OS3 5GHz 12dBi outdoor CPE');
    assert.equal(node.migrationStatus, 'owner-reported-connected-config-unverified');
    assert.equal(node.physicalVerified, false);
  }
  assert.equal(target.radioReassignment.status, 'Kuwadzana-OS3-owner-reported; Goromonzi-O1-5G-proposed-not-installed');
  assert.equal(site.ports[3].present,false);
  assert.equal(site.ports[3].target,null);
});
