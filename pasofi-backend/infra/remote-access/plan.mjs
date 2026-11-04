#!/usr/bin/env node
import {readFile, mkdir, writeFile, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isIP} from 'node:net';
import {fileURLToPath} from 'node:url';
import {object, choice, hostname, endpoint, publicKeys, listenPort, managementPorts, ipv4Networks, tunnelAddresses} from './validation.mjs';

const interfaceName = 'pamofi-management';
const tag = 'PamoFi remote:';
const sharedFields = ['mode', 'routerPublicKey', 'port', 'routerTunnelIp', 'managementPorts', 'routerNetworks'];
const hubFields = ['serverPublicKey', 'serverHost', 'serverTunnelIp', 'adminIdentity', 'serverNetworks'];
const directFields = ['clientPublicKey', 'routerEndpoint', 'clientTunnelIp', 'directRoute', 'wanInterface', 'clientNetworks'];

export function validatePlan(p) {
  object(p, [...sharedFields, ...hubFields, ...directFields], 'Remote plan');
  // Existing public-plan.json files remain the hub mode. A direct plan is always explicit.
  const mode = choice(p.mode === undefined ? 'hub' : p.mode, ['hub', 'direct'], 'mode');
  object(p, [...sharedFields, ...(mode === 'hub' ? hubFields : directFields)], `${mode} plan`);
  listenPort(p.port);
  const ports = managementPorts(p.managementPorts);
  const peerIp = mode === 'direct' ? p.clientTunnelIp : p.serverTunnelIp;
  const peerPublicKey = mode === 'direct' ? p.clientPublicKey : p.serverPublicKey;
  publicKeys(p.routerPublicKey, peerPublicKey);
  const networks = [
    ...ipv4Networks(p.routerNetworks, 'routerNetworks', mode === 'direct'),
    ...ipv4Networks(mode === 'direct' ? p.clientNetworks : p.serverNetworks, mode === 'direct' ? 'clientNetworks' : 'serverNetworks', mode === 'direct', mode === 'direct'),
  ];
  tunnelAddresses(p.routerTunnelIp, peerIp, networks);
  let family = 4;
  if (mode === 'direct') {
    choice(p.directRoute, ['public-ipv4', 'upstream-forwarded-ipv4', 'global-ipv6'], 'directRoute');
    family = p.directRoute === 'global-ipv6' ? 6 : 4;
    endpoint(p.routerEndpoint, family, 'routerEndpoint');
    if (typeof p.wanInterface !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(p.wanInterface) || [interfaceName, 'all', 'all-ethernet', 'dynamic'].includes(p.wanInterface)) {
      throw Error('wanInterface must name the inspected router uplink interface');
    }
  } else {
    endpoint(p.serverHost, 4, 'serverHost');
    if (typeof p.adminIdentity !== 'string' || p.adminIdentity.length > 160 || !/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(p.adminIdentity) || !hostname(p.adminIdentity.split('@')[1])) {
      throw Error('Use the verified Tailscale admin identity');
    }
  }
  return {...p, mode, ports, family, peerIp, peerPublicKey};
}

// Insert before the first rule in the specific chain, including established and
// FastTrack accepts. Empty chains are valid. Reversed insertion below preserves
// the intended allow-then-deny order without relying on rule numbers or comments.
function firstRule(family, chain, rule) {
  const menu = family === 6 ? '/ipv6 firewall filter' : '/ip firewall filter';
  const find = `[${menu} find where chain="${chain}"]`;
  const add = `${menu} add chain=${chain} ${rule}`;
  return `:if ([:len ${find}] > 0) do={ ${add} place-before=(${find}->0) } else={ ${add} }`;
}

function routerPlan(p) {
  const own = `[/interface wireguard find where name="${interfaceName}"]`;
  const prefix = [
    '# REVIEW ONLY. Apply in Safe Mode with an off-device backup and local recovery.',
    '# Create the dedicated interface DISABLED first; retain its private key on RouterOS.',
    '# Preflight runs before any mutation. A previous/partial configuration must be reviewed, not overwritten.',
    `:if ([:len ${own}] != 1) do={ :error "Create exactly one disabled pamofi-management interface first and regenerate with its public key" }`,
    `:if ([/interface wireguard get ${own} public-key] != "${p.routerPublicKey}") do={ :error "Router public key does not match this reviewed plan" }`,
    `:if ([/interface wireguard get ${own} disabled] != true) do={ :error "The dedicated management interface must be disabled during preparation" }`,
    `:if ([:len [/interface wireguard peers find where interface="${interfaceName}"]] > 0) do={ :error "Management interface already has peers; inspect before continuing" }`,
    `:if ([:len [/ip address find where interface="${interfaceName}"]] > 0) do={ :error "Management interface already has IPv4 addresses" }`,
    `:if ([:len [/ipv6 address find where interface="${interfaceName}"]] > 0) do={ :error "Management interface already has IPv6 addresses" }`,
    `:if ([:len [/interface list member find where interface="${interfaceName}"]] > 0) do={ :error "Management interface must not belong to LAN or another interface list" }`,
    `:if ([:len [/interface bridge port find where interface="${interfaceName}"]] > 0) do={ :error "Management interface must not be a bridge port" }`,
    `:if ([:len [/interface wireguard peers find where public-key="${p.peerPublicKey}"]] > 0) do={ :error "The peer public key already exists; use a separately reviewed device key" }`,
    `:if ([:len [/ip route find where gateway="${interfaceName}"]] > 0) do={ :error "Management interface already has routes" }`,
    `:if ([:len [/ipv6 route find where gateway="${interfaceName}"]] > 0) do={ :error "Management interface already has IPv6 routes" }`,
    ...['/ip address', '/ip route', '/ipv6 route', '/ip firewall filter', '/ipv6 firewall filter'].map(menu => `:if ([:len [${menu} find where comment~"^${tag}"]] > 0) do={ :error "PamoFi remote configuration already exists; inspect and recover the prior plan" }`),
  ];
  if (p.mode === 'direct') prefix.push(
    `:if ([:len [/interface find where name="${p.wanInterface}"]] != 1) do={ :error "The reviewed WAN interface is absent" }`,
    `:if ([/interface wireguard get ${own} listen-port] != ${p.port}) do={ :error "The dedicated interface listen port must match the reviewed direct endpoint" }`,
    `:if ([:len [/interface wireguard find where listen-port=${p.port}]] != 1) do={ :error "Another WireGuard interface uses the reviewed listen port" }`,
  );
  const inputAllow = `action=accept in-interface="${interfaceName}" src-address=${p.peerIp}/32 dst-address=${p.routerTunnelIp}/32`;
  const rules = [
    '# Install guards ahead of all pre-existing accepts/FastTrack before enabling the interface.',
    firstRule(4, 'input', `action=drop in-interface="${interfaceName}" comment="${tag} deny other router access"`),
    firstRule(4, 'input', `${inputAllow} protocol=icmp icmp-options=8:0 comment="${tag} management echo only"`),
    firstRule(4, 'input', `${inputAllow} protocol=tcp dst-port=${p.ports.join(',')} comment="${tag} selected management services"`),
    firstRule(4, 'forward', `action=drop out-interface="${interfaceName}" comment="${tag} deny forwarding to peer"`),
    firstRule(4, 'forward', `action=drop in-interface="${interfaceName}" comment="${tag} deny forwarding from peer"`),
    firstRule(6, 'input', `action=drop in-interface="${interfaceName}" comment="${tag} deny inner IPv6 router access"`),
    firstRule(6, 'forward', `action=drop out-interface="${interfaceName}" comment="${tag} deny inner IPv6 to peer"`),
    firstRule(6, 'forward', `action=drop in-interface="${interfaceName}" comment="${tag} deny inner IPv6 from peer"`),
  ];
  if (p.mode === 'direct') rules.push(
    '# This permits only the encrypted UDP transport on the inspected uplink.',
    firstRule(p.family, 'input', `action=accept in-interface="${p.wanInterface}" protocol=udp dst-port=${p.port} comment="${tag} direct WireGuard transport"`),
  );
  const peer = p.mode === 'hub'
    ? ` endpoint-address="${p.serverHost}" endpoint-port=${p.port} persistent-keepalive=25s`
    : '';
  // One enclosing RouterOS block makes a preflight :error abort the remaining
  // configuration even when the complete block is pasted into a terminal.
  return ['{', ...prefix, ...rules,
    `/ip address add address=${p.routerTunnelIp}/32 interface="${interfaceName}" comment="${tag} router management address"`,
    `/interface wireguard peers add interface="${interfaceName}" public-key="${p.peerPublicKey}" allowed-address=${p.peerIp}/32${peer} comment="${tag} ${p.mode === 'direct' ? 'owner device' : 'management hub'}"`,
    `/ip route add dst-address=${p.peerIp}/32 gateway="${interfaceName}" comment="${tag} peer management route"`,
    '# Enable only after the guarded configuration has completed; no LAN membership or NAT is added.',
    `/interface wireguard set ${own} disabled=no`,
    '}',
    '',
  ].join('\n');
}

export function buildPlan(input) {
  const p = validatePlan(input);
  const files = {'router-management.rsc.review': routerPlan(p)};
  const checks = [
    'This is an offline review plan, not observed reachability or active access.',
    'Recheck router and remote client/server connected/private/VPN routes for address overlap immediately before applying.',
    'Review existing management service address restrictions and certificates; this plan does not enable or reconfigure services.',
    'Apply the exact approved changes in RouterOS Safe Mode with independent local recovery; preserve credentials, LAN, DHCP and wireless.',
    'Test from a genuinely different network: recent handshake, selected management service allowed, other router ports and all LAN forwarding denied.',
    'Test a second unapproved device/key, router reboot/reconnection, and unchanged local access. Check no public TCP WebFig/WinBox/API exposure.',
    'This owner-management tunnel does not configure the separate backend/RADIUS/private service path required for paid hotspot operation.',
  ];
  if (p.mode === 'direct') {
    const host = isIP(p.routerEndpoint) === 6 ? `[${p.routerEndpoint}]` : p.routerEndpoint;
    files['client-wireguard.conf.review'] = `[Interface]\nAddress = ${p.clientTunnelIp}/32\n# Retain the private key already generated on this owner device.\nPrivateKey = REPLACE_ON_OWNER_DEVICE_ONLY\n\n[Peer]\nPublicKey = ${p.routerPublicKey}\nEndpoint = ${host}:${p.port}\nAllowedIPs = ${p.routerTunnelIp}/32\nPersistentKeepalive = 25\n`;
    checks.push('Only the router management /32 is routed through this client tunnel. It is not an exit node or a route to the home/customer LAN.');
    if (p.clientNetworks.length === 0) checks.push('The operator explicitly reports no existing non-default IPv4 networks on the owner device. Recheck this inventory when the client changes networks or enables another VPN.');
    if (p.directRoute === 'upstream-forwarded-ipv4') checks.push(`Confirm a reachable public IPv4 on the upstream router and forward UDP ${p.port} to the MikroTik uplink address on UDP ${p.port}; reserve that uplink address. Never forward TCP management ports.`);
    if (p.directRoute === 'public-ipv4') checks.push('Confirm the public IPv4 endpoint belongs to this router and inbound UDP is permitted by the ISP and firewall.');
    if (p.directRoute === 'global-ipv6') checks.push(`Confirm routed global IPv6 on the MikroTik, IPv6 connectivity on the remote client and UDP ${p.port} allowed through every upstream IPv6 firewall. IPv4 management traffic travels inside this IPv6 WireGuard transport.`);
    if (!isIP(p.routerEndpoint)) checks.push(`Resolve ${p.routerEndpoint} and inspect all A/AAAA records. The chosen client must use the verified IPv${p.family} path; mixed or stale records can select an unreachable path. This generator does not resolve DNS.`);
  } else {
    files['server-wireguard.conf.review'] = `[Interface]\nAddress = ${p.serverTunnelIp}/32\nListenPort = ${p.port}\n# The private key is generated and retained on the selected server.\nPrivateKey = REPLACE_ON_SERVER_ONLY\n\n[Peer]\nPublicKey = ${p.routerPublicKey}\nAllowedIPs = ${p.routerTunnelIp}/32\n`;
    const policy = {grants: [{src: [p.adminIdentity], dst: [`${p.routerTunnelIp}/32`], ip: p.ports.map(port => `tcp:${port}`)}], tests: [{src: p.adminIdentity, accept: p.ports.map(port => `${p.routerTunnelIp}:${port}`), deny: [`${p.routerTunnelIp}:22`, `${p.routerTunnelIp}:8728`]}]};
    files['tailscale-policy-fragment.json'] = `${JSON.stringify(policy, null, 2)}\n`;
    files['route-command.txt'] = `# For a new dedicated hub with no existing advertised routes only.\n# Inspect: tailscale get advertise-routes\n# On a shared hub, merge the approved existing routes explicitly before running; --advertise-routes replaces the list.\nsudo tailscale set --advertise-routes=${p.routerTunnelIp}/32\n`;
    checks.push('Inspect the selected public server, firewall manager, routes and existing services. Retain Tailscale subnet SNAT and allow only the chosen TCP ports from tailscale0 to the router /32; deny other forwarding.', 'Merge the narrow tailnet fragment with care: grants are additive. Remove any unintended broad grant to this router, approve only its /32 route, and test a real non-owner denial.', 'The route-command.txt file sets the advertised route list. On an existing subnet router, preserve separately approved routes explicitly after reviewing them; never blindly replace its route list.');
    if (!p.routerNetworks || !p.serverNetworks) checks.push('Legacy hub input omitted route inventories. Supply routerNetworks/serverNetworks or complete an independent overlap review before activation.');
    if (!isIP(p.serverHost)) checks.push('Resolve the server hostname and verify its public IPv4 endpoint; hostname syntax does not prove public reachability.');
  }
  files['review.json'] = `${JSON.stringify({status: 'prepared-only', mode: p.mode, directRoute: p.directRoute ?? null, endpoint: p.routerEndpoint ?? p.serverHost, endpointFamily: p.family, managementAddress: `${p.routerTunnelIp}/32`, peerAddress: `${p.peerIp}/32`, managementPorts: p.ports, privateKeysIncluded: false, checks}, null, 2)}\n`;
  return files;
}

async function main() {
  const [input, output, extra] = process.argv.slice(2);
  if (!input || !output || extra) throw Error('Usage: node plan.mjs public-plan.json new-output-directory');
  const source = await readFile(input, 'utf8');
  if (Buffer.byteLength(source) > 65536) throw Error('Public plan exceeds the 64 KiB limit');
  const files = buildPlan(JSON.parse(source));
  const target = resolve(output);
  await mkdir(target, {mode: 0o700}); // Exclusive: existing files/directories are never replaced.
  try {
    for (const [name, content] of Object.entries(files)) await writeFile(resolve(target, name), content, {mode: 0o600, flag: 'wx'});
  } catch (error) {
    await rm(target, {recursive: true, force: true});
    throw error;
  }
  console.log('Prepared public configuration for review. No remote access has been enabled.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof SyntaxError ? 'Invalid public-plan JSON' : error.message); process.exitCode = 1; });
}
