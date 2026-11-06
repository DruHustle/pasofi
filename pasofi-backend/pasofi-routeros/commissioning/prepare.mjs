#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { object, hostname, inIpv4, ipv4Networks, ipv4Number, privateIpv4 } from '../../infra/remote-access/validation.mjs';
import { validatePlan as validateServiceLink } from '../../infra/site-link/plan.mjs';
import { registrationSql, validateRegistry } from '../../infra/radius-production/prepare.mjs';
import { buildPages } from '../portal/welcome/build-install.mjs';
import { requiresHotspotPackage, routerName as name, validateBaseline } from './baseline.mjs';
import { buildCollector } from './collect.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../..');
const schema = {
  schemaVersion: null,
  site: { siteId: null, nasId: null, clientName: null, displayName: null },
  customer: { bridge: null, interfaces: null, network: null, gateway: null, poolStart: null, poolEnd: null, dhcpServer: null, ipv6Policy: null },
  serviceLink: { serverEndpoint: null, port: null, serverPublicKey: null, routerPublicKey: null, serverTunnelIp: null, routerTunnelIp: null, serverInterface: null, routerInterface: null, routerListenPort: null, routerNetworks: null, serverNetworks: null },
  hotspot: { name: null, profile: null, origin: null, appOrigin: null, certificateName: null, certificateSha256: null, sourceDirectory: null, targetDirectory: null },
  routerControl: { url: null, username: null, certificateName: null, certificateSha256: null },
};
const gates = [
  'hotspot-package-availability', 'physical-device-mode-confirmation', 'management-and-uplink-recovery',
  'separate-customer-topology', 'private-service-transport', 'incremental-nas-enrollment',
  'trusted-hotspot-https', 'private-https-disconnect-control', 'guest-isolation-and-ipv6',
  'cash-sale-and-redemption', 'paid-auth-and-accounting', 'disconnect-absence-and-reconnect',
  'quota-expiry-outage-and-load', 'site-launch-decision',
];

// Return field paths only: never echo malformed user values or possible secrets.
export function missingInputs(input) {
  const missing = [];
  function visit(value, shape, path) {
    object(value, Object.keys(shape), path || 'Commissioning plan');
    for (const [key, nested] of Object.entries(shape)) {
      const field = path ? `${path}.${key}` : key;
      if (value[key] === null || value[key] === undefined || value[key] === '' || Array.isArray(value[key]) && value[key].length === 0) missing.push(field);
      else if (nested) visit(value[key], nested, field);
    }
  }
  visit(input, schema, '');
  return missing;
}
function fingerprint(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value) || /^([a-f0-9])\1+$/.test(value)) throw Error(`${label} requires the actual lowercase SHA-256 certificate fingerprint`);
}
function httpsOrigin(value, label) {
  let url;
  try { url = new URL(value); } catch { throw Error(`${label} requires the selected HTTPS DNS origin`); }
  if (typeof value !== 'string' || value !== url.origin || url.protocol !== 'https:' || !hostname(url.hostname) ||
      url.hostname !== url.hostname.toLowerCase() || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw Error(`${label} requires an exact HTTPS DNS origin without port, path or credentials`);
  }
  return value;
}
function directory(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_./-]{1,100}$/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) throw Error(`${label} requires an exact router directory without traversal`);
}
const overlap = (a, b) => inIpv4(a.address, b.address, b.bits) || inIpv4(b.address, a.address, a.bits);

export async function validatePlan(baselineInput, input) {
  const baseline = validateBaseline(baselineInput), r = baseline.router;
  const missing = missingInputs(input);
  if (missing.length) throw Error(`Required commissioning inputs: ${missing.join(', ')}`);
  if (requiresHotspotPackage(r) && !baseline.packages.includes('hotspot')) {
    throw Error('SMIPS RouterOS 7.20+ requires the installed hotspot package in baseline.packages; verify its matching enabled version after installation before preparing HotSpot. Read-only --collect remains available.');
  }
  if (input.schemaVersion !== 1) throw Error('Unsupported commissioning schema');
  if (baseline.protectedSiteIds.includes(input.site.siteId)) throw Error('This router requires its verified site mapping; do not reuse another protected site');
  if (typeof input.site.displayName !== 'string' || !/^[\p{L}\p{N}][\p{L}\p{N} .,'()-]{0,79}$/u.test(input.site.displayName) || input.site.displayName !== input.site.displayName.trim()) throw Error('site.displayName requires the actual plain-text site name');

  const serviceLink = validateServiceLink(input.serviceLink);
  const routerNetworks = ipv4Networks(serviceLink.routerNetworks, 'serviceLink.routerNetworks');
  for (const required of baseline.requiredRouterNetworks) if (!serviceLink.routerNetworks.includes(required)) throw Error('serviceLink.routerNetworks must retain the inspected baseline networks and include all other current routes');
  const networks = [...routerNetworks, ...ipv4Networks(serviceLink.serverNetworks, 'serviceLink.serverNetworks')];
  const customer = input.customer;
  name(customer.bridge, 'customer.bridge');
  name(customer.dhcpServer, 'customer.dhcpServer');
  const protectedInterfaces = new Set([r.managementBridge, r.wanPort, r.cpeTransitPort, r.recoveryPort, 'pamofi-service', 'pasofi-service']);
  if (protectedInterfaces.has(customer.bridge)) throw Error('Customer bridge must be separate from management, WAN, recovery, CPE transit and service interfaces');
  if (!Array.isArray(customer.interfaces) || customer.interfaces.length > 8 || new Set(customer.interfaces).size !== customer.interfaces.length) throw Error('customer.interfaces requires 1–8 distinct inspected customer interfaces');
  for (const iface of customer.interfaces) {
    name(iface, 'customer.interfaces');
    if (protectedInterfaces.has(iface) || iface === customer.bridge) throw Error('Customer interfaces cannot consume the current management, WAN, recovery, CPE transit or service path');
  }
  const [network] = ipv4Networks([customer.network], 'customer.network');
  const start = ipv4Number(network.address), size = 2 ** (32 - network.bits);
  const last = start + size - 1;
  const toIp = number => [24, 16, 8, 0].map(shift => Math.floor(number / 2 ** shift) % 256).join('.');
  if (network.bits > 29 || !privateIpv4(network.address) || !privateIpv4(toIp(last))) throw Error('customer.network must be an RFC1918 subnet with room for gateway and customer leases');
  if (networks.some(existing => overlap(network, existing))) throw Error('Customer subnet overlaps an observed router/server network');
  const hosts = [customer.gateway, customer.poolStart, customer.poolEnd];
  if (hosts.some(host => !privateIpv4(host) || ipv4Number(host) <= start || ipv4Number(host) >= last)) throw Error('Customer gateway and pool must be usable addresses inside the selected subnet');
  const [gateway, first, end] = hosts.map(ipv4Number);
  if (first > end || gateway >= first && gateway <= end) throw Error('Customer lease range must be ordered and exclude its gateway');
  if ([serviceLink.serverTunnelIp, serviceLink.routerTunnelIp].some(host => inIpv4(host, network.address, network.bits))) throw Error('Customer subnet overlaps a selected private service address');
  if (!['disabled-on-customer-path', 'explicitly-blocked-on-customer-path'].includes(customer.ipv6Policy)) throw Error('Choose an explicit customer IPv6 policy for separate live verification');

  const hotspot = input.hotspot;
  for (const key of ['name', 'profile', 'certificateName']) name(hotspot[key], `hotspot.${key}`);
  fingerprint(hotspot.certificateSha256, 'hotspot.certificateSha256');
  httpsOrigin(hotspot.origin, 'hotspot.origin');
  httpsOrigin(hotspot.appOrigin, 'hotspot.appOrigin');
  for (const key of ['sourceDirectory', 'targetDirectory']) directory(hotspot[key], `hotspot.${key}`);
  if (hotspot.sourceDirectory === hotspot.targetDirectory || hotspot.sourceDirectory.startsWith(`${hotspot.targetDirectory}/`) || hotspot.targetDirectory.startsWith(`${hotspot.sourceDirectory}/`)) throw Error('Welcome portal source and new target must be distinct, non-overlapping directories');
  const welcome = { siteLabel: input.site.displayName, hotspotOrigin: hotspot.origin, appOrigin: hotspot.appOrigin };
  await buildPages(welcome); // Reuse the actual page generator's contract without installing anything.
  const registry = validateRegistry({ serverTunnelIp: serviceLink.serverTunnelIp, nases: [{
    nasId: input.site.nasId, siteId: input.site.siteId, clientName: input.site.clientName,
    siteName: input.site.displayName, routerTunnelIp: serviceLink.routerTunnelIp, loginUrl: `${hotspot.origin}/login`,
  }] });
  for (const key of ['siteId', 'nasId']) if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(input.site[key])) throw Error(`site.${key} requires an actual nonzero registered or allocated identifier`);

  const control = input.routerControl;
  name(control.username, 'routerControl.username');
  name(control.certificateName, 'routerControl.certificateName');
  fingerprint(control.certificateSha256, 'routerControl.certificateSha256');
  let url;
  try { url = new URL(control.url); } catch { throw Error('routerControl.url requires the selected private HTTPS REST endpoint'); }
  if (typeof control.url !== 'string' || control.url !== url.toString() || url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/rest/' || url.search || url.hash ||
      (isIP(url.hostname) ? url.hostname !== serviceLink.routerTunnelIp : !hostname(url.hostname))) throw Error('Use the reviewed private router HTTPS /rest/ endpoint on TCP443; an IP literal must match the selected service address');
  return { baseline, plan: structuredClone(input), serviceLink, registry, welcome, customerNetwork: network };
}

function targetGuards(baseline) {
  const r = baseline.router;
  return [
    `:if ([/system routerboard get serial-number] != "${r.serial}") do={ :error "Wrong hardware serial for this private baseline" }`,
    `:if ([/system routerboard get model] != "${r.model}" || [/system resource get architecture-name] != "${r.architecture}") do={ :error "Hardware baseline changed" }`,
    `:if ([/system identity get name] != "${r.identity}") do={ :error "Router identity changed" }`,
    ...baseline.packages.map(pkg => {
      const separateHotspot = pkg === 'hotspot' && requiresHotspotPackage(r);
      const installed = separateHotspot ? ' and available=no and scheduled=""' : '';
      const error = separateHotspot ? 'Expected installed enabled HotSpot package at the exact RouterOS version with no pending changes' : 'Expected package/version missing';
      return `:if ([:len [/system package find where name="${pkg}" and version="${r.version}" and disabled=no${installed}]] != 1) do={ :error "${error}" }`;
    }),
    `:if ([/system device-mode get mode] != "${r.deviceMode}" || [/system device-mode get flagged] != false || [/system device-mode get hotspot] != true) do={ :error "Device-mode requires inspected mode, flagged=no and hotspot=yes after physical confirmation" }`,
    `:if ([:len [/interface bridge find where name="${r.managementBridge}" and disabled=no]] != 1 || [:len [/ip address find where interface="${r.managementBridge}" and address="${r.managementAddress}" and disabled=no]] != 1) do={ :error "Management path changed" }`,
    ...baseline.retiredManagementAddresses.map(address => `:if ([:len [/ip address find where interface="${r.managementBridge}" and address="${address}" and disabled=no]] != 0) do={ :error "Retired management address is enabled" }`),
    ...[r.cpeTransitPort, r.recoveryPort].map(iface => `:if ([:len [/interface bridge port find where bridge="${r.managementBridge}" and interface="${iface}" and disabled=no]] != 1) do={ :error "Preserve inspected management/recovery membership" }`),
    `:if ([:len [/interface bridge port find where interface="${r.wanPort}"]] != 0) do={ :error "WAN port must remain outside all bridges" }`,
  ];
}
export function stagingCheck({ baseline, plan: p, customerNetwork }) {
  const c = p.customer, h = p.hotspot, s = p.serviceLink, r = p.routerControl;
  const profile = `[/ip hotspot profile find where name="${h.profile}"]`;
  const radius = `[/radius find where address=${s.serverTunnelIp} and src-address=${s.routerTunnelIp} and service=hotspot]`;
  return ['{', '# READ ONLY. Verify disabled staging only; this is not a cash-service acceptance result.', ...targetGuards(baseline),
    `:if ([:len [/interface bridge find where name="${c.bridge}" and disabled=yes]] != 1) do={ :error "Expected separate disabled customer bridge" }`,
    `:if ([:len [/interface bridge port find where bridge="${c.bridge}"]] != ${c.interfaces.length}) do={ :error "Customer bridge membership changed" }`,
    ...c.interfaces.map(iface => `:if ([:len [/interface bridge port find where bridge="${c.bridge}" and interface="${iface}"]] != 1) do={ :error "Expected customer interface missing" }`),
    `:if ([:len [/ip address find where interface="${c.bridge}" and address="${c.gateway}/${customerNetwork.bits}" and disabled=no]] != 1) do={ :error "Customer gateway differs" }`,
    `:if ([:len [/ip dhcp-server find where name="${c.dhcpServer}" and interface="${c.bridge}" and disabled=yes]] != 1) do={ :error "Expected disabled customer DHCP" }`,
    `:if ([:len [/interface wireguard find where name="${s.routerInterface}" and disabled=no]] != 1 || [:len [/ip address find where interface="${s.routerInterface}" and address="${s.routerTunnelIp}/32" and disabled=no]] != 1) do={ :error "Expected private service path missing" }`,
    `:if ([:len ${radius}] != 1) do={ :error "Expected source-bound HotSpot RADIUS client" }`,
    `:if ([/radius get ${radius} disabled] != true || [/radius get ${radius} require-message-auth] != "yes-for-request-resp") do={ :error "RADIUS must remain disabled with Message-Authenticator required" }`,
    ...[[h.certificateName, h.certificateSha256], [r.certificateName, r.certificateSha256]].flatMap(([cert, digest]) => [
      `:if ([:len [/certificate find where name="${cert}"]] != 1) do={ :error "Expected certificate missing" }`,
      `:if ([/certificate get [find where name="${cert}"] fingerprint] != "${digest}" || [/certificate get [find where name="${cert}"] trusted] != true) do={ :error "Certificate fingerprint/trust differs" }`,
    ]),
    `:if ([:len ${profile}] != 1) do={ :error "Expected customer HotSpot profile" }`,
    `:if ([/ip hotspot profile get ${profile} dns-name] != "${new URL(h.origin).hostname}" || [/ip hotspot profile get ${profile} ssl-certificate] != "${h.certificateName}") do={ :error "HotSpot HTTPS hostname/certificate differs" }`,
    `:local pfiLogin [:tostr [/ip hotspot profile get ${profile} login-by]]`,
    ':if (($pfiLogin != "https") && ($pfiLogin != "https,trial") && ($pfiLogin != "trial,https")) do={ :error "Only HTTPS and an independently qualified optional trial are allowed" }',
    `:if ([/ip hotspot profile get ${profile} use-radius] != true || [/ip hotspot profile get ${profile} radius-accounting] != true || [/ip hotspot profile get ${profile} radius-interim-update] != 1m) do={ :error "HotSpot RADIUS/accounting contract differs" }`,
    `:if ([/ip hotspot profile get ${profile} html-directory] != "${h.targetDirectory}") do={ :error "Selected welcome portal is not installed" }`,
    `:if ([:len [/ip hotspot find]] != 1 || [:len [/ip hotspot find where name="${h.name}" and interface="${c.bridge}" and profile="${h.profile}" and disabled=yes]] != 1) do={ :error "Expected one disabled customer HotSpot" }`,
    ':put "Disabled staging matches selected metadata. TLS, firewall, live accounting and cash acceptance remain pending."',
    '}', '',
  ].join('\n');
}

export async function buildPackage(baselineInput, input) {
  const validated = await validatePlan(baselineInput, input), { baseline, plan, registry, serviceLink, welcome } = validated;
  const files = {
    'private-baseline.json': JSON.stringify(baseline, null, 2) + '\n',
    'commissioning-plan.json': JSON.stringify(plan, null, 2) + '\n',
    'site-link.public.json': JSON.stringify(serviceLink, null, 2) + '\n',
    'welcome-site.json': JSON.stringify(welcome, null, 2) + '\n',
    'nas-enrollment.json': JSON.stringify({ ...registry, purpose: 'incremental-owner-reviewed-enrollment', enabled: false, replaceExistingAuthority: false }, null, 2) + '\n',
    'nas-registration.sql.review': registrationSql(registry),
    'collect-readiness.rsc': buildCollector(baseline),
    'check-disabled-staging.rsc': stagingCheck(validated),
    'ACCEPTANCE.md': await readFile(join(here, 'ACCEPTANCE.md'), 'utf8'),
    'README.md': await readFile(join(here, 'README.md'), 'utf8'),
  };
  files['review.json'] = JSON.stringify({
    status: 'prepared-only', expectedSerial: baseline.router.serial, siteId: plan.site.siteId, nasId: plan.site.nasId,
    liveChangesPerformed: false, customerServiceQualified: false, credentialsIncluded: false,
    gates: Object.fromEntries(gates.map(gate => [gate, 'pending-live-evidence'])),
    sha256: Object.fromEntries(Object.entries(files).map(([file, body]) => [file, createHash('sha256').update(body).digest('hex')])),
  }, null, 2) + '\n';
  return files;
}

async function main() {
  const [baselineFile, source, target, extra] = process.argv.slice(2);
  if (!baselineFile || !source || !target || extra) throw Error('Usage: node prepare.mjs BASELINE.json PLAN.json --check|NEW_ABSOLUTE_PRIVATE_DIRECTORY; or BASELINE.json --collect NEW_ABSOLUTE_PRIVATE_FILE.rsc');
  const baselineRaw = await readFile(baselineFile, 'utf8');
  if (Buffer.byteLength(baselineRaw) > 65536) throw Error('Private baseline exceeds 64 KiB');
  const baseline = validateBaseline(JSON.parse(baselineRaw));
  const privateTarget = async () => {
    if (!isAbsolute(target)) throw Error('Use a new absolute private target outside the repository');
    const parent = await realpath(dirname(target)), repo = await realpath(repository), output = join(parent, basename(target));
    if (output === repo || output.startsWith(repo + sep)) throw Error('Keep private commissioning output outside the repository');
    return output;
  };
  if (source === '--collect') {
    const output = await privateTarget();
    if (!output.endsWith('.rsc') || output.endsWith('.auto.rsc')) throw Error('Use an ordinary .rsc collector filename, never .auto.rsc');
    await writeFile(output, buildCollector(baseline), { mode: 0o600, flag: 'wx' });
    console.log('Prepared private read-only collector; no router was contacted.');
    return;
  }
  const raw = await readFile(source, 'utf8');
  if (Buffer.byteLength(raw) > 65536) throw Error('Commissioning plan exceeds 64 KiB');
  const input = JSON.parse(raw), missing = missingInputs(input);
  if (target === '--check') {
    if (missing.length) { console.log(JSON.stringify({ status: 'needs-input', missing }, null, 2)); process.exitCode = 2; return; }
    await validatePlan(baseline, input);
    console.log(JSON.stringify({ status: 'prepared-only', liveChangesPerformed: false, customerServiceQualified: false }, null, 2));
    return;
  }
  const files = await buildPackage(baseline, input), output = await privateTarget();
  await mkdir(output, { mode: 0o700 });
  try { for (const [file, body] of Object.entries(files)) await writeFile(join(output, file), body, { mode: 0o600, flag: 'wx' }); }
  catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
  console.log('Prepared commissioning review. No router/server changes or sales activation performed.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  console.error(error instanceof SyntaxError ? 'Invalid commissioning JSON' : error.message);
  process.exitCode = 1;
});
