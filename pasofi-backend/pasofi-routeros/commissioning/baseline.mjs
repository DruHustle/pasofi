import { isIP } from 'node:net';
import { object, ipv4Networks, ipv4Number, privateIpv4 } from '../../infra/remote-access/validation.mjs';

export function routerName(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,63}$/.test(value)) throw Error(`${label} requires an explicit safe RouterOS name`);
  return value;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The SMIPS HotSpot feature moved out of routeros starting with RouterOS 7.20.
// Call only after validateBaseline has checked the stable RouterOS 7 version.
// https://download.mikrotik.com/routeros/7.20/CHANGELOG
export function requiresHotspotPackage(router) {
  return router.architecture.toLowerCase() === 'smips' && Number(router.version.split('.')[1]) >= 20;
}

export function canonicalNetwork(cidr) {
  if (typeof cidr !== 'string') throw Error('Baseline addresses require an IPv4 CIDR');
  const [address, prefix, extra] = cidr.split('/'), bits = Number(prefix);
  if (extra !== undefined || isIP(address) !== 4 || !privateIpv4(address) || !/^(?:[89]|[12][0-9]|30)$/.test(prefix ?? '')) throw Error('Baseline addresses require a private host CIDR with prefix 8–30');
  const size = 2 ** (32 - bits), number = ipv4Number(address), network = Math.floor(number / size) * size;
  if (number === network || number === network + size - 1) throw Error('Baseline management address must be a usable host');
  const toIp = number => [24, 16, 8, 0].map(shift => Math.floor(number / 2 ** shift) % 256).join('.');
  if (!privateIpv4(toIp(network)) || !privateIpv4(toIp(network + size - 1))) throw Error('Baseline management subnet must be wholly private');
  return toIp(network) + '/' + bits;
}
export function validateBaseline(input) {
  object(input, ['schemaVersion', 'router', 'packages', 'requiredRouterNetworks', 'retiredManagementAddresses', 'protectedSiteIds'], 'Baseline');
  if (input.schemaVersion !== 1) throw Error('Unsupported baseline schema');
  const fields = ['serial', 'identity', 'model', 'version', 'architecture', 'deviceMode', 'managementBridge', 'managementAddress', 'recoveryPort', 'cpeTransitPort', 'wanPort'];
  object(input.router, fields, 'Baseline router');
  const router = input.router;
  for (const field of fields.filter(field => field !== 'managementAddress')) routerName(router[field], `baseline.router.${field}`);
  if (!/^[A-Z0-9]{5,32}$/.test(router.serial)) throw Error('Baseline requires the actual uppercase alphanumeric hardware serial');
  if (!/^7\.[0-9]{1,2}(?:\.[0-9]{1,2})?$/.test(router.version)) throw Error('Baseline requires the inspected stable RouterOS 7 package version');
  if (!['home', 'basic', 'advanced', 'rose'].includes(router.deviceMode)) throw Error('Baseline requires the actual device-mode');
  if (new Set([router.managementBridge, router.wanPort, router.recoveryPort, router.cpeTransitPort]).size !== 4) throw Error('Baseline management bridge, WAN, recovery and CPE transit names must be distinct');
  const managementNetwork = canonicalNetwork(router.managementAddress);
  const array = (value, label, allowEmpty = false) => {
    if (!Array.isArray(value) || value.length > 64 || (!allowEmpty && !value.length) || new Set(value).size !== value.length) throw Error(`${label} requires an explicit unique list`);
  };
  array(input.packages, 'baseline.packages');
  input.packages.forEach(pkg => routerName(pkg, 'baseline.packages'));
  if (!input.packages.includes('routeros')) throw Error('Baseline packages must include routeros');
  ipv4Networks(input.requiredRouterNetworks, 'baseline.requiredRouterNetworks');
  if (!input.requiredRouterNetworks.includes(managementNetwork)) throw Error('Baseline networks must contain the management subnet');
  array(input.retiredManagementAddresses, 'baseline.retiredManagementAddresses', true);
  input.retiredManagementAddresses.forEach(address => canonicalNetwork(address));
  if (input.retiredManagementAddresses.includes(router.managementAddress)) throw Error('Active management address cannot also be retired');
  array(input.protectedSiteIds, 'baseline.protectedSiteIds', true);
  if (input.protectedSiteIds.some(id => typeof id !== 'string' || !uuid.test(id))) throw Error('Protected site identifiers must be canonical lowercase UUIDs');
  return structuredClone(input);
}
