import { requiresHotspotPackage, validateBaseline } from './baseline.mjs';

// Explicit field selection: never emit on-event/lease scripts, raw exports,
// credential-bearing DoH URLs, secrets, customer sessions or private keys.
const each = (menu, fields) => [
  `:foreach pfi in=[${menu} find] do={`,
  '    :local pfiRow ""',
  '    :foreach pfiField in={' + fields.map(field => `"${field}"`).join(';') + '} do={',
  '        :local pfiValue "unavailable"',
  `        :do { :set pfiValue [:tostr [${menu} get $pfi $pfiField]] } on-error={ :set pfiValue "unavailable" }`,
  '        :set pfiRow ($pfiRow . $pfiField . "=" . $pfiValue . " ")',
  '    }',
  '    :put $pfiRow',
  '}',
];
export function buildCollector(input) {
  const baseline = validateBaseline(input), r = baseline.router;
  // Do not emit commands for an unavailable menu: RouterOS may reject the whole
  // block before executing an in-script guard. Recollect after installation.
  const collectHotspot = !requiresHotspotPackage(r) || baseline.packages.includes('hotspot');
  return ['{',
    '# READ ONLY. Generated from a private inspected baseline; do not publish this inventory.',
    `:if ([/system routerboard get serial-number] != "${r.serial}") do={ :error "Wrong hardware serial for this private baseline" }`,
    ':put "=== Identity, resource, packages and device mode ==="',
    '/system identity print', '/system routerboard print', '/system resource print',
    '/system package print without-paging', '/system device-mode print',
    ':put "=== Interfaces and bridge membership ==="',
    ...each('/interface ethernet', ['name', 'mac-address', 'running', 'disabled']),
    ...each('/interface bridge', ['name', 'disabled', 'vlan-filtering']),
    ...each('/interface bridge port', ['interface', 'bridge', 'disabled', 'pvid']),
    ...each('/interface list member', ['interface', 'list']),
    ...(baseline.packages.includes('wireless') ? each('/interface wireless', ['name', 'mode', 'ssid', 'disabled']) : []),
    ':put "=== Addressing, DHCP and routes ==="',
    ...each('/ip address', ['address', 'network', 'interface', 'disabled', 'dynamic']),
    ...each('/ip pool', ['name', 'ranges']),
    ...each('/ip dhcp-client', ['interface', 'status', 'address', 'gateway', 'use-peer-dns', 'add-default-route']),
    ...each('/ip dhcp-server', ['name', 'interface', 'address-pool', 'lease-time', 'disabled']),
    ...each('/ip dhcp-server network', ['address', 'gateway', 'dns-server']),
    ...each('/ip route', ['dst-address', 'gateway', 'distance', 'active', 'dynamic', 'disabled']),
    ':put "=== Selected DNS and management service fields ==="',
    ':put ("DNS servers=" . [/ip dns get servers] . " dynamic-servers=" . [/ip dns get dynamic-servers] . " allow-remote-requests=" . [/ip dns get allow-remote-requests])',
    ...each('/ip dns static', ['name', 'type', 'address', 'disabled']),
    ...each('/ip service', ['name', 'port', 'address', 'certificate', 'disabled']),
    ':put "=== Service interface public metadata only ==="',
    ...each('/interface wireguard', ['name', 'disabled', 'listen-port', 'public-key']),
    ':put "=== RADIUS endpoint metadata only ==="',
    ...each('/radius', ['service', 'address', 'src-address', 'disabled', 'require-message-auth']),
    ':put "=== HotSpot server and profile metadata only ==="',
    ...(collectHotspot ? [
      ...each('/ip hotspot', ['name', 'interface', 'profile', 'disabled']),
      ...each('/ip hotspot profile', ['name', 'dns-name', 'login-by', 'ssl-certificate', 'use-radius', 'radius-accounting', 'radius-interim-update', 'html-directory']),
    ] : [
      ':put "HotSpot metadata skipped: SMIPS RouterOS 7.20+ requires the separate hotspot package, missing from this baseline."',
      ':put "Inspect the current package list and refresh the baseline after installation; HotSpot objects remain unverified."',
    ]),
    ':put "=== Certificate public metadata only ==="',
    ...each('/certificate', ['name', 'fingerprint', 'trusted']),
    ':put "=== IPv4 and IPv6 policy fields ==="',
    ...each('/ip firewall filter', ['chain', 'action', 'in-interface', 'out-interface', 'src-address', 'dst-address', 'protocol', 'src-port', 'dst-port', 'disabled', 'dynamic']),
    ...each('/ip firewall nat', ['chain', 'action', 'in-interface', 'out-interface', 'src-address', 'dst-address', 'protocol', 'src-port', 'dst-port', 'disabled', 'dynamic']),
    ':put ("IPv6 disable-ipv6=" . [/ipv6 settings get disable-ipv6] . " forward=" . [/ipv6 settings get forward])',
    ...each('/ipv6 address', ['address', 'interface', 'disabled', 'dynamic']),
    ...each('/ipv6 firewall filter', ['chain', 'action', 'in-interface', 'out-interface', 'src-address', 'dst-address', 'protocol', 'src-port', 'dst-port', 'disabled', 'dynamic']),
    ':put "Read-only collection finished. Customer readiness is not established."',
    '}', '',
  ].join('\n');
}
