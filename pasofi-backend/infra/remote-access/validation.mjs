import {isIP} from 'node:net';

export function object(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(field => !fields.includes(field))) {
    throw Error(`${label} accepts only its documented public fields; never provide private keys or credentials`);
  }
}

export function choice(value, choices, label) {
  if (!choices.includes(value)) throw Error(`${label} must be one of: ${choices.join(', ')}`);
  return value;
}

export const ipv4Number = value => value.split('.').reduce((total, byte) => total * 256 + Number(byte), 0);
export const inIpv4 = (value, base, bits) => Math.floor(ipv4Number(value) / 2 ** (32 - bits)) === Math.floor(ipv4Number(base) / 2 ** (32 - bits));
export const privateIpv4 = value => typeof value === 'string' && isIP(value) === 4 && [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]].some(([base, bits]) => inIpv4(value, base, bits));

export function publicIpv4(value) {
  if (typeof value !== 'string' || isIP(value) !== 4) return false;
  // Conservative endpoint validation: exclude private, shared, loopback, link-local,
  // documentation, benchmark, transition and reserved/multicast address space.
  return ![
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 3],
  ].some(([base, bits]) => inIpv4(value, base, bits));
}

function ipv6Number(value) {
  let text = value.toLowerCase();
  if (text.includes('.')) {
    const index = text.lastIndexOf(':');
    const ipv4 = ipv4Number(text.slice(index + 1));
    text = `${text.slice(0, index)}:${Math.floor(ipv4 / 65536).toString(16)}:${(ipv4 % 65536).toString(16)}`;
  }
  const [left, right] = text.split('::');
  const first = left ? left.split(':') : [];
  const last = right ? right.split(':') : [];
  const groups = right !== undefined ? [...first, ...Array(8 - first.length - last.length).fill('0'), ...last] : first;
  return groups.reduce((total, group) => (total << 16n) + BigInt(`0x${group}`), 0n);
}

export function globalIpv6(value) {
  if (typeof value !== 'string' || value.includes('%') || isIP(value) !== 6) return false;
  const address = ipv6Number(value);
  const within = (base, bits) => address >> BigInt(128 - bits) === ipv6Number(base) >> BigInt(128 - bits);
  // Native global unicast only. In particular, ULA, link-local, IPv4-mapped,
  // documentation (including 3fff::/20), Teredo/ORCHID and 6to4 are not endpoints.
  return within('2000::', 3) && ![['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]].some(([base, bits]) => within(base, bits));
}

export function hostname(value) {
  return typeof value === 'string' && value.length <= 253 && value.includes('.') && !/^[\d.]+$/.test(value)
    && value.split('.').every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))
    && !/\.(invalid|local|localhost|internal|lan|home|test|example|onion)$/i.test(value);
}

export function endpoint(value, family, label) {
  if (typeof value !== 'string' || !(family === 4 ? publicIpv4(value) : globalIpv6(value)) && !hostname(value)) {
    throw Error(`${label} requires a public IPv${family} literal or a selected DNS hostname; DNS reachability still needs verification`);
  }
  if (isIP(value) && isIP(value) !== family) throw Error(`${label} does not match the selected IP family`);
  return value;
}

export function publicKeys(first, second) {
  const valid = value => typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value)
    && Buffer.from(value, 'base64').length === 32 && Buffer.from(value, 'base64').toString('base64') === value
    && Buffer.from(value, 'base64').some(byte => byte !== 0);
  if (!valid(first) || !valid(second) || first === second) throw Error('Distinct canonical, nonzero WireGuard public keys are required');
}

export function listenPort(value) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw Error('Choose a nonprivileged UDP listen port');
}

export function managementPorts(value = [80, 443, 8291]) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || new Set(value).size !== value.length || value.some(port => ![80, 443, 8291].includes(port))) {
    throw Error('managementPorts must be a nonempty unique subset of 80, 443 and 8291');
  }
  return [...value].sort((a, b) => a - b);
}

export function ipv4Networks(value, label, required = true, allowEmpty = false) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || value.length > 256 || (required && !allowEmpty && value.length === 0)) throw Error(`${label} requires the observed non-default IPv4 networks`);
  return value.map(cidr => {
    if (typeof cidr !== 'string') throw Error(`${label} contains an invalid IPv4 network`);
    const [address, prefix, extra] = cidr.split('/');
    const bits = Number(prefix);
    if (extra !== undefined || isIP(address) !== 4 || !/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(prefix ?? '') || ipv4Number(address) % 2 ** (32 - bits) !== 0) {
      throw Error(`${label} requires canonical IPv4 network CIDRs with prefixes 1–32; omit the default route`);
    }
    return {address, bits};
  });
}

export function tunnelAddresses(first, second, networks) {
  if (!privateIpv4(first) || !privateIpv4(second) || first === second) throw Error('Distinct private IPv4 tunnel addresses are required');
  if ([first, second].some(address => networks.some(network => inIpv4(address, network.address, network.bits)))) {
    throw Error('A management tunnel address overlaps an observed router/client/server network');
  }
}
