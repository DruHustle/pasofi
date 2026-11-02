import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, stat, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildPlan} from './plan.mjs';

const script = fileURLToPath(new URL('./plan.mjs', import.meta.url));
// Synthetic public identifiers only. No generated test plan is applied or contacted.
const routerPublicKey = Buffer.alloc(32, 2).toString('base64');
const peerPublicKey = Buffer.alloc(32, 1).toString('base64');
const hub = {serverHost: 'hub.example.com', port: 51871, serverPublicKey: peerPublicKey, routerPublicKey, serverTunnelIp: '10.77.255.1', routerTunnelIp: '10.77.255.2', adminIdentity: 'owner@example.com'};
const direct = {mode: 'direct', directRoute: 'upstream-forwarded-ipv4', routerEndpoint: 'vpn.example.com', port: 51871, wanInterface: 'ether1', clientPublicKey: peerPublicKey, routerPublicKey, clientTunnelIp: '10.77.255.1', routerTunnelIp: '10.77.255.2', routerNetworks: ['192.168.88.0/24', '192.168.0.0/24'], clientNetworks: ['192.168.1.0/24']};

// Inspect rendered rule semantics, including insertion ahead of an existing
// permissive/established chain. This is not a RouterOS interpreter or live test.
function firewallModel(script) {
  const chains = new Map();
  for (const family of ['ip', 'ipv6']) for (const chain of ['input', 'forward']) chains.set(`${family}:${chain}`, [{action: chain === 'forward' ? 'fasttrack-connection' : 'accept'}]);
  for (const line of script.split('\n')) {
    if (!line.includes(' firewall filter add ')) continue;
    const match = line.match(/do=\{ \/(ip|ipv6) firewall filter add (.*?) place-before=\(/);
    assert.ok(match, `Filter mutation must use checked first-chain placement: ${line}`);
    assert.match(line, /find where chain="(?:input|forward)"\]\-?>0|find where chain="(?:input|forward)"\]->0/);
    assert.match(line, /else=\{ \/(?:ip|ipv6) firewall filter add /);
    const rule = Object.fromEntries([...match[2].matchAll(/([a-z-]+)=(?:"([^"]*)"|([^ ]+))/g)].map(item => [item[1], item[2] ?? item[3]]));
    chains.get(`${match[1]}:${rule.chain}`).unshift(rule);
  }
  return (family, chain, packet) => {
    for (const rule of chains.get(`${family}:${chain}`)) {
      if (['in-interface', 'out-interface', 'protocol'].some(field => rule[field] !== undefined && rule[field] !== packet[field])) continue;
      if (['src-address', 'dst-address'].some(field => rule[field] !== undefined && rule[field].replace(/\/32$/, '') !== packet[field])) continue;
      if (rule['dst-port'] && !rule['dst-port'].split(',').includes(String(packet['dst-port']))) continue;
      if (rule['icmp-options'] && rule['icmp-options'] !== packet['icmp-options']) continue;
      return rule.action === 'fasttrack-connection' ? 'accept' : rule.action;
    }
    return 'accept';
  };
}

function ownerPacket(overrides = {}) {
  return {'in-interface': 'pamofi-management', 'out-interface': 'bridge', 'src-address': direct.clientTunnelIp, 'dst-address': direct.routerTunnelIp, protocol: 'tcp', 'dst-port': 443, ...overrides};
}

test('legacy and explicit hub plans retain owner-only policy and warn before replacing advertised routes', () => {
  for (const input of [hub, {...hub, mode: 'hub', routerNetworks: direct.routerNetworks, serverNetworks: ['172.31.0.0/16'] }]) {
    const files = buildPlan(input);
    const policy = JSON.parse(files['tailscale-policy-fragment.json']);
    assert.deepEqual(policy.grants, [{src: ['owner@example.com'], dst: ['10.77.255.2/32'], ip: ['tcp:80', 'tcp:443', 'tcp:8291']}]);
    assert.match(files['route-command.txt'], /--advertise-routes replaces the list/);
    assert.match(files['route-command.txt'], /sudo tailscale set --advertise-routes=10\.77\.255\.2\/32\n$/);
    assert.match(files['server-wireguard.conf.review'], /PrivateKey = REPLACE_ON_SERVER_ONLY/);
    assert.match(files['server-wireguard.conf.review'], /AllowedIPs = 10\.77\.255\.2\/32/);
    assert.equal(files['client-wireguard.conf.review'], undefined);
    const router = files['router-management.rsc.review'];
    assert.match(router, /endpoint-address="hub.example.com" endpoint-port=51871 persistent-keepalive=25s/);
    assert.doesNotMatch(router, /direct WireGuard transport/);
    assert.equal(JSON.parse(files['review.json']).status, 'prepared-only');
    const decide = firewallModel(router);
    assert.equal(decide('ip', 'input', ownerPacket()), 'accept');
    assert.equal(decide('ip', 'input', ownerPacket({'dst-port': 8728})), 'drop');
    assert.equal(decide('ip', 'forward', ownerPacket({'dst-address': '192.168.88.10'})), 'drop');
  }
});

test('direct IPv4 produces one owner peer, router-only route, and no Tailscale or server configuration', () => {
  for (const directRoute of ['public-ipv4', 'upstream-forwarded-ipv4']) {
    const files = buildPlan({...direct, directRoute});
    assert.deepEqual(Object.keys(files).sort(), ['client-wireguard.conf.review', 'review.json', 'router-management.rsc.review']);
    const client = files['client-wireguard.conf.review'];
    assert.match(client, /PrivateKey = REPLACE_ON_OWNER_DEVICE_ONLY/);
    assert.match(client, /Endpoint = vpn.example.com:51871/);
    assert.match(client, /Address = 10\.77\.255\.1\/32/);
    assert.match(client, /AllowedIPs = 10\.77\.255\.2\/32/);
    assert.doesNotMatch(client, /0\.0\.0\.0\/0|::\/0|^DNS\s*=/m);
    const router = files['router-management.rsc.review'];
    assert.match(router, /allowed-address=10\.77\.255\.1\/32 comment="PamoFi remote: owner device"/);
    assert.doesNotMatch(router, /endpoint-address=|private-key=|masquerade|\/ip service set|interface list member add/);
    assert.match(router, /dst-address=10\.77\.255\.1\/32 gateway="pamofi-management"/);
    const review = JSON.parse(files['review.json']);
    assert.equal(review.status, 'prepared-only');
    assert.ok(review.checks.some(check => check.includes('A/AAAA')));
    assert.equal(review.checks.some(check => check.includes('forward UDP 51871')), directRoute === 'upstream-forwarded-ipv4');
  }
});

test('direct IPv6 brackets the endpoint and permits only IPv6 UDP transport with IPv4 inner management', () => {
  const files = buildPlan({...direct, directRoute: 'global-ipv6', routerEndpoint: '2a01:4f8:abcd::2'});
  assert.match(files['client-wireguard.conf.review'], /Endpoint = \[2a01:4f8:abcd::2\]:51871/);
  assert.match(files['client-wireguard.conf.review'], /AllowedIPs = 10\.77\.255\.2\/32/);
  const script = files['router-management.rsc.review'];
  const transport = script.split('\n').filter(line => line.includes('direct WireGuard transport'));
  assert.equal(transport.length, 1);
  assert.match(transport[0], /\/ipv6 firewall filter add chain=input action=accept in-interface="ether1" protocol=udp dst-port=51871/);
  assert.doesNotMatch(transport[0], /\/ip firewall filter add|protocol=tcp/);
  const decide = firewallModel(script);
  assert.equal(decide('ip', 'input', ownerPacket()), 'accept');
  assert.equal(decide('ipv6', 'input', ownerPacket()), 'drop');
  assert.equal(decide('ipv6', 'forward', ownerPacket()), 'drop');
});

test('an explicitly empty IPv4 inventory supports an IPv6-only owner network without treating omitted inventory as complete', () => {
  const p = {...direct, directRoute: 'global-ipv6', routerEndpoint: '2a01:4f8:abcd::2', clientNetworks: []};
  const files = buildPlan(p);
  assert.match(files['client-wireguard.conf.review'], /AllowedIPs = 10\.77\.255\.2\/32/);
  assert.ok(JSON.parse(files['review.json']).checks.some(check => check.includes('explicitly reports no existing non-default IPv4')));
  assert.throws(() => buildPlan({...p, clientNetworks: undefined}), /clientNetworks/);
});

test('management guards deny other router addresses, ports, spoofed sources and both LAN forwarding directions before existing accepts', () => {
  const script = buildPlan({...direct, managementPorts: [443]})['router-management.rsc.review'];
  const decide = firewallModel(script);
  assert.equal(decide('ip', 'input', ownerPacket()), 'accept');
  for (const packet of [
    ownerPacket({'dst-port': 80}), ownerPacket({'dst-port': 22}), ownerPacket({'dst-port': 8291}), ownerPacket({'dst-port': 8729}),
    ownerPacket({'dst-address': '192.168.88.1'}), ownerPacket({'dst-address': '192.168.0.2'}),
    ownerPacket({'src-address': '10.77.255.9'}), ownerPacket({protocol: 'udp'}),
    ownerPacket({protocol: 'icmp', 'icmp-options': '0:0'}),
  ]) assert.equal(decide('ip', 'input', packet), 'drop', JSON.stringify(packet));
  assert.equal(decide('ip', 'input', ownerPacket({protocol: 'icmp', 'icmp-options': '8:0'})), 'accept');
  assert.equal(decide('ip', 'forward', ownerPacket({'dst-address': '192.168.88.20', 'connection-state': 'established'})), 'drop');
  assert.equal(decide('ip', 'forward', ownerPacket({'in-interface': 'bridge', 'out-interface': 'pamofi-management'})), 'drop');
  assert.equal(decide('ip', 'forward', ownerPacket({'in-interface': 'bridge', 'out-interface': 'ether1'})), 'accept');
  assert.equal(decide('ip', 'input', ownerPacket({'in-interface': 'bridge'})), 'accept');
});

test('all dedicated-interface checks precede changes and interface enablement is last', () => {
  const router = buildPlan(direct)['router-management.rsc.review'];
  const firstMutation = router.indexOf('/ip firewall filter add');
  for (const message of ['Router public key does not match', 'interface must be disabled', 'already has peers', 'already has IPv4', 'already has IPv6', 'must not belong to LAN', 'must not be a bridge port', 'peer public key already exists', 'already has routes', 'already has IPv6 routes', 'configuration already exists', 'WAN interface is absent', 'listen port must match', 'Another WireGuard interface']) {
    assert.ok(router.indexOf(message) >= 0 && router.indexOf(message) < firstMutation, message);
  }
  assert.ok(router.startsWith('{\n'));
  assert.match(router.trimEnd(), /\/interface wireguard set .* disabled=no\n\}$/);
  assert.doesNotMatch(router, /show-client-config|client-allowed-address|responder=/);
});

test('plans reject scope expansion, nonpublic endpoints, overlap, injection and noncanonical keys before writing files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pamofi-remote-reject-'));
  try {
    const invalid = [
      {...hub, privateKey: 'never-accepted'}, {...hub, serverHost: '127.0.0.1'}, {...hub, serverHost: '100.64.0.1'}, {...hub, serverHost: '192.168.88.1'}, {...hub, serverHost: '224.0.0.1'}, {...hub, serverHost: '203.0.113.1'},
      {...hub, serverHost: 'host.invalid'}, {...hub, serverHost: 'hub..example.com'}, {...hub, serverHost: '999.1.1.1'}, {...hub, serverHost: '127.000.0.1'}, {...hub, serverHost: 'hub.example.com;echo unsafe'},
      {...hub, routerTunnelIp: '0.0.0.0/0'}, {...hub, routerTunnelIp: hub.serverTunnelIp}, {...hub, port: 0}, {...hub, adminIdentity: 'owner@example.com\n*'}, {...hub, routerPublicKey: peerPublicKey},
      {...direct, directRoute: 'unknown'}, {...direct, mode: 'auto'}, {...hub, mode: null}, {...direct, serverHost: 'hub.example.com'}, {...direct, wanInterface: 'ether1";:error x'}, {...direct, wanInterface: 'pamofi-management'},
      {...direct, routerNetworks: []}, {...direct, clientNetworks: undefined}, {...direct, clientNetworks: ['10.77.255.0/24']}, {...direct, routerNetworks: ['10.0.0.0/8']}, {...direct, clientNetworks: ['0.0.0.0/0']}, {...direct, clientNetworks: ['192.168.1.9/24']},
      {...direct, managementPorts: []}, {...direct, managementPorts: [443, 443]}, {...direct, managementPorts: [22]}, {...direct, managementPorts: ['443']},
      {...direct, routerPublicKey: Buffer.alloc(32).toString('base64')}, {...direct, clientPublicKey: `${peerPublicKey.slice(0, 42)}F=`},
      {...direct, routerEndpoint: '2a01:4f8::2'}, {...direct, directRoute: 'global-ipv6', routerEndpoint: '8.8.8.8'},
      ...['::1', '::', 'fc00::1', 'fd01::2', 'fe80::1', 'fe80::1%ether1', 'ff02::1', '2001:db8::1', '3fff::1', '2002:0808:0808::1', '2001::1', '::ffff:8.8.8.8', '[2a01:4f8::2]'].map(routerEndpoint => ({...direct, directRoute: 'global-ipv6', routerEndpoint})),
    ];
    for (let index = 0; index < invalid.length; index++) {
      const input = join(root, `input-${index}.json`), output = join(root, `output-${index}`);
      await writeFile(input, JSON.stringify(invalid[index]));
      const result = spawnSync(process.execPath, [script, input, output], {encoding: 'utf8'});
      assert.equal(result.error, undefined, 'The test process must actually execute');
      assert.notEqual(result.status, 0, `Unsafe case ${index} accepted`);
      await assert.rejects(stat(output), {code: 'ENOENT'});
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('CLI outputs are private and exclusive, and a repeat invocation preserves all prior review files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pamofi-remote-plan-'));
  try {
    for (const [name, sample] of [['hub', hub], ['direct', direct]]) {
      const input = join(root, `${name}.json`), output = join(root, name);
      await writeFile(input, JSON.stringify(sample));
      const first = spawnSync(process.execPath, [script, input, output], {encoding: 'utf8'});
      assert.equal(first.error, undefined, 'The test process must actually execute');
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /No remote access has been enabled/);
      assert.equal((await stat(output)).mode & 0o777, 0o700);
      const before = new Map();
      for (const file of await readdir(output)) {
        assert.equal((await stat(join(output, file))).mode & 0o777, 0o600);
        before.set(file, await readFile(join(output, file), 'utf8'));
      }
      const again = spawnSync(process.execPath, [script, input, output], {encoding: 'utf8'});
      assert.equal(again.error, undefined, 'The test process must actually execute');
      assert.notEqual(again.status, 0);
      for (const [file, content] of before) assert.equal(await readFile(join(output, file), 'utf8'), content);
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});
