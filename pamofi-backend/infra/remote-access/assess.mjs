#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isIP} from 'node:net';
import {object, choice, publicIpv4, privateIpv4, globalIpv6, inIpv4} from './validation.mjs';

const reachabilityStates = ['untested', 'blocked', 'reported-working'];
const result = (status, reason, nextChecks = []) => ({status, reason, nextChecks});

function addressKind(address) {
  if (address === null) return 'unknown';
  if (publicIpv4(address)) return 'public-address';
  if (privateIpv4(address)) return 'private-address';
  if (inIpv4(address, '100.64.0.0', 10)) return 'shared-address-space';
  return 'other-nonpublic-address';
}

export function assess(p) {
  object(p, ['routerArchitecture', 'routerOsVersion', 'alwaysOnSiteDevice', 'ipv4', 'ipv6'], 'Network observations');
  choice(p.routerArchitecture, ['smips', 'mipsbe', 'mmips', 'arm', 'arm64', 'tile', 'x86', 'unknown'], 'routerArchitecture');
  if (typeof p.routerOsVersion !== 'string' || !/^7\.\d+(?:\.\d+)?$/.test(p.routerOsVersion)) throw Error('This WireGuard assessment requires an observed stable RouterOS 7 version; qualify other firmware separately');
  if (typeof p.alwaysOnSiteDevice !== 'boolean') throw Error('alwaysOnSiteDevice must be an observed boolean');
  object(p.ipv4, ['routerAddress', 'upstreamAddress', 'portForwarding', 'udpReachability'], 'ipv4');
  for (const field of ['routerAddress', 'upstreamAddress']) {
    if (p.ipv4[field] !== null && (typeof p.ipv4[field] !== 'string' || isIP(p.ipv4[field]) !== 4)) throw Error(`ipv4.${field} must be an observed IPv4 address or null when unknown`);
  }
  choice(p.ipv4.portForwarding, ['unknown', 'available', 'unavailable'], 'ipv4.portForwarding');
  choice(p.ipv4.udpReachability, reachabilityStates, 'ipv4.udpReachability');
  object(p.ipv6, ['routerAddress', 'routerAvailability', 'clientConnectivity', 'udpReachability'], 'ipv6');
  choice(p.ipv6.routerAvailability, ['unknown', 'present', 'unavailable'], 'ipv6.routerAvailability');
  choice(p.ipv6.clientConnectivity, ['unknown', 'available', 'unavailable'], 'ipv6.clientConnectivity');
  choice(p.ipv6.udpReachability, reachabilityStates, 'ipv6.udpReachability');
  if (p.ipv6.routerAvailability === 'present' ? !globalIpv6(p.ipv6.routerAddress) : p.ipv6.routerAddress !== null) {
    throw Error('Present IPv6 requires an observed native global unicast address; unknown/unavailable IPv6 uses null');
  }
  if (p.ipv6.udpReachability === 'reported-working' && (p.ipv6.routerAvailability !== 'present' || p.ipv6.clientConnectivity !== 'available')) {
    throw Error('A reported working IPv6 path requires router global IPv6 and remote-client IPv6 connectivity');
  }
  const routerKind = addressKind(p.ipv4.routerAddress), upstreamKind = addressKind(p.ipv4.upstreamAddress);
  const forwardedPath = ['private-address', 'shared-address-space'].includes(routerKind) && upstreamKind === 'public-address' && p.ipv4.portForwarding === 'available';
  if (p.ipv4.udpReachability === 'reported-working' && routerKind !== 'public-address' && !forwardedPath) {
    throw Error('A reported working IPv4 path requires the public router endpoint or an inspected public upstream with available forwarding');
  }
  let ipv4;
  if (p.ipv4.udpReachability === 'blocked') {
    ipv4 = result('blocked', 'Inbound IPv4 UDP is reported blocked on the current path.', ['Reassess if the ISP or upstream firewall/forwarding configuration changes.']);
  } else if (routerKind === 'public-address') {
    ipv4 = result(p.ipv4.udpReachability === 'reported-working' ? 'reported-working' : 'candidate', 'The router has a public IPv4 candidate; no separate server is needed if inbound WireGuard UDP works.', ['Confirm address ownership and firewall scope, then test the exact endpoint from another network.']);
  } else if (forwardedPath) {
    ipv4 = result(p.ipv4.udpReachability === 'reported-working' ? 'reported-working' : 'candidate', 'The upstream router has a public IPv4 candidate and port forwarding is available.', ['Reserve the MikroTik uplink address and forward only the selected UDP port through every NAT layer.', 'Test a WireGuard handshake from another network; a public-looking address is not a reachability test.']);
  } else if (routerKind !== 'public-address' && routerKind !== 'unknown' && p.ipv4.portForwarding === 'unavailable') {
    ipv4 = result('blocked', 'The current nonpublic IPv4 path has no available upstream port forwarding.', ['Ask the upstream owner/ISP whether a reachable IPv4 path can be provided, or evaluate IPv6.']);
  } else {
    ipv4 = result('needs-inspection', 'The observed addresses do not establish a usable inbound IPv4 path or prove carrier-grade NAT.', ['Inspect the upstream WAN address and forwarding controls, and compare with the connection public address.', 'Confirm any carrier-grade NAT with the ISP; a private upstream gateway alone is insufficient evidence.', 'Test the selected UDP endpoint from a separate network after preparing a reviewed configuration.']);
  }
  let ipv6;
  if (p.ipv6.routerAvailability === 'unavailable' || p.ipv6.clientConnectivity === 'unavailable' || p.ipv6.udpReachability === 'blocked') {
    ipv6 = result('blocked', 'A required part of the current IPv6 path is reported unavailable or blocked.', ['Reassess if routed IPv6, the remote network or upstream IPv6 firewall changes.']);
  } else if (p.ipv6.routerAvailability === 'present' && p.ipv6.clientConnectivity === 'available') {
    ipv6 = result(p.ipv6.udpReachability === 'reported-working' ? 'reported-working' : 'candidate', 'Router global IPv6 and remote-client IPv6 are reported available.', ['Permit only the selected UDP transport through all upstream IPv6 firewalls and test from another network.', 'Keep the decrypted management route restricted to the router IPv4 /32; global IPv6 is only the outer transport.']);
  } else {
    ipv6 = result('needs-inspection', 'Global IPv6 on the router and IPv6 connectivity on the remote client have not both been established.', ['Inspect IPv6 addresses, delegated prefix/routes and upstream firewall controls.', 'Check IPv6 from the actual remote phone/laptop network, not only from the router LAN.']);
  }
  const [major, minor] = p.routerOsVersion.split('.').map(Number);
  const backToHomeSupported = ['arm', 'arm64', 'tile'].includes(p.routerArchitecture) && (major > 7 || major === 7 && minor >= 12);
  const preferred = [ipv4, ipv6].findIndex(option => option.status === 'reported-working');
  const candidate = [ipv4, ipv6].findIndex(option => option.status === 'candidate');
  const recommendation = preferred >= 0 ? `direct-ipv${preferred === 0 ? 4 : 6}-reported-working`
    : candidate >= 0 ? `qualify-direct-ipv${candidate === 0 ? 4 : 6}`
      : [ipv4, ipv6].some(option => option.status === 'needs-inspection') ? 'inspect-direct-paths-first'
        : p.alwaysOnSiteDevice ? 'consider-local-tailscale-subnet-router'
          : backToHomeSupported ? 'consider-back-to-home-managed-relay'
            : 'hub-or-other-external-relay-needed-for-current-paths';
  return {
    status: 'assessment-only',
    evidence: 'Operator-reported observations only. No router, DNS service or network endpoint was contacted.',
    recommendation,
    ipv4AddressObservation: {router: routerKind, upstream: upstreamKind},
    directIpv4: ipv4,
    directIpv6: ipv6,
    alternatives: {
      localTailscaleSubnetRouter: p.alwaysOnSiteDevice ? 'An always-on device is reported; verify a supported OS, Tailscale support and network reachability.' : 'No always-on site device is reported.',
      backToHome: backToHomeSupported ? 'Architecture/version meet published requirements; relay configuration still needs qualification.' : 'The reported architecture/version does not establish Back To Home support; SMIPS hAP lite is unsupported.',
      publicHub: 'Router-initiated WireGuard to a selected public hub remains a fallback; no server or tailnet has been selected by this assessment.',
    },
    managementOnly: 'An owner management tunnel does not supply the separate backend/RADIUS/payment service connectivity required by PamoFi.',
  };
}

async function main() {
  const [input, extra] = process.argv.slice(2);
  if (!input || extra) throw Error('Usage: node assess.mjs observations.json');
  const source = await readFile(input, 'utf8');
  if (Buffer.byteLength(source) > 65536) throw Error('Network observations exceed the 64 KiB limit');
  console.log(JSON.stringify(assess(JSON.parse(source)), null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof SyntaxError ? 'Invalid observations JSON' : error.message); process.exitCode = 1; });
}
