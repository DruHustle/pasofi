#!/usr/bin/env node
import {readFile, mkdir, writeFile, rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {object, endpoint, publicKeys, listenPort, ipv4Networks, tunnelAddresses} from '../remote-access/validation.mjs';

const routerInterface = 'pamofi-service';
const tag = 'PamoFi site:';
export function validatePlan(input) {
  object(input, ['serverEndpoint','port','serverPublicKey','routerPublicKey','serverTunnelIp','routerTunnelIp','serverInterface','routerNetworks','serverNetworks'], 'Site link');
  endpoint(input.serverEndpoint, 4, 'serverEndpoint');
  listenPort(input.port);
  publicKeys(input.routerPublicKey, input.serverPublicKey);
  if (typeof input.serverInterface !== 'string' || !/^pfi-[a-z0-9][a-z0-9-]{0,10}$/.test(input.serverInterface)) throw Error('Use a fresh pfi- prefixed Linux interface of at most 15 characters');
  const networks = [...ipv4Networks(input.routerNetworks, 'routerNetworks'), ...ipv4Networks(input.serverNetworks, 'serverNetworks')];
  tunnelAddresses(input.routerTunnelIp, input.serverTunnelIp, networks);
  return {...input};
}
function first(family, chain, rule) {
  const menu = family === 4 ? '/ip firewall filter' : '/ipv6 firewall filter';
  const found = `[${menu} find where chain="${chain}"]`;
  return `:if ([:len ${found}] > 0) do={ ${menu} add chain=${chain} ${rule} place-before=(${found}->0) } else={ ${menu} add chain=${chain} ${rule} }`;
}
function router(p) {
  const own = `[/interface wireguard find where name="${routerInterface}"]`;
  const incoming = `in-interface="${routerInterface}" src-address=${p.serverTunnelIp}/32 dst-address=${p.routerTunnelIp}/32`;
  const outgoing = `out-interface="${routerInterface}" src-address=${p.routerTunnelIp}/32 dst-address=${p.serverTunnelIp}/32`;
  return ['{',
    '# REVIEW ONLY. A fresh disabled interface and independent local recovery are required.',
    `:if ([:len ${own}] != 1) do={ :error "Create one disabled pamofi-service interface first and retain its private key on the router" }`,
    `:if ([/interface wireguard get ${own} disabled] != true) do={ :error "Service interface must be disabled" }`,
    `:if ([/interface wireguard get ${own} public-key] != "${p.routerPublicKey}") do={ :error "Router public key differs from the reviewed plan" }`,
    `:if ([/interface wireguard get ${own} listen-port] != ${p.port}) do={ :error "Service interface listen port differs from the reviewed plan" }`,
    `:if ([:len [/interface wireguard find where listen-port=${p.port}]] != 1) do={ :error "WireGuard listen port is already used" }`,
    ...['/interface wireguard peers','/ip address','/interface list member','/interface bridge port'].map(menu => `:if ([:len [${menu} find where interface="${routerInterface}"]] > 0) do={ :error "Service interface contains prior state; inspect and recover before applying" }`),
    `:if ([:len [/ipv6 address find where interface="${routerInterface}" and (dynamic=no or link-local=no)]] > 0) do={ :error "Service interface contains unexpected IPv6 addresses" }`,
    ...['/ip route','/ipv6 route'].map(menu => `:if ([:len [${menu} find where gateway="${routerInterface}"]] > 0) do={ :error "Service interface already has routes" }`),
    `:if ([:len [/interface wireguard peers find where public-key="${p.serverPublicKey}"]] > 0) do={ :error "Server peer already exists" }`,
    ...['/ip address','/ip route','/ipv6 route','/ip firewall filter','/ipv6 firewall filter'].map(menu => `:if ([:len [${menu} find where comment~"^${tag}"]] > 0) do={ :error "Prior site-link configuration exists" }`),
    '# Insert guards before existing accepts and FastTrack. Reverse insertion preserves the allow/drop order.',
    first(4, 'input', `action=drop in-interface="${routerInterface}" comment="${tag} deny other service input"`),
    first(4, 'input', `action=accept ${incoming} protocol=udp src-port=1812,1813 connection-state=established,related comment="${tag} RADIUS replies"`),
    first(4, 'input', `action=accept ${incoming} protocol=tcp dst-port=443 comment="${tag} Oracle HTTPS management"`),
    first(4, 'input', `action=accept ${incoming} protocol=icmp icmp-options=8:0 comment="${tag} service echo request"`),
    first(4, 'input', `action=accept ${incoming} protocol=icmp icmp-options=0:0 connection-state=established,related comment="${tag} service echo reply"`),
    first(4, 'output', `action=drop out-interface="${routerInterface}" comment="${tag} deny other service output"`),
    first(4, 'output', `action=accept ${outgoing} protocol=udp dst-port=1812,1813 comment="${tag} RADIUS requests"`),
    first(4, 'output', `action=accept ${outgoing} protocol=tcp src-port=443 connection-state=established,related comment="${tag} HTTPS management replies"`),
    first(4, 'output', `action=accept ${outgoing} protocol=icmp icmp-options=8:0 comment="${tag} service echo request"`),
    first(4, 'output', `action=accept ${outgoing} protocol=icmp icmp-options=0:0 connection-state=established,related comment="${tag} service echo reply"`),
    ...['in','out'].map(direction => first(4, 'forward', `action=drop ${direction}-interface="${routerInterface}" comment="${tag} no customer forwarding ${direction}"`)),
    first(6, 'input', `action=drop in-interface="${routerInterface}" comment="${tag} no inner IPv6 input"`),
    first(6, 'output', `action=drop out-interface="${routerInterface}" comment="${tag} no inner IPv6 output"`),
    ...['in','out'].map(direction => first(6, 'forward', `action=drop ${direction}-interface="${routerInterface}" comment="${tag} no inner IPv6 forwarding ${direction}"`)),
    `/ip address add address=${p.routerTunnelIp}/32 interface="${routerInterface}" comment="${tag} router address"`,
    `/interface wireguard peers add interface="${routerInterface}" public-key="${p.serverPublicKey}" allowed-address=${p.serverTunnelIp}/32 endpoint-address="${p.serverEndpoint}" endpoint-port=${p.port} persistent-keepalive=25s comment="${tag} Oracle service endpoint"`,
    `/ip route add dst-address=${p.serverTunnelIp}/32 gateway="${routerInterface}" comment="${tag} Oracle service route"`,
    '# Enable last. No public input rule, LAN membership, default route, NAT or service credentials are created.',
    `/interface wireguard set ${own} disabled=no`, '}', '',
  ].join('\n');
}
function firewall(p) {
  const table = p.serverInterface.replaceAll('-', '_');
  return `# REVIEW ONLY. Integrate with the inspected host firewall; do not flush existing rules.\n# This new table denies other inner traffic before Docker DNAT and after SNAT.\n# An accept here does not override a later host/firewall-manager drop.\n# Permit outer UDP ${p.port} separately in the Oracle NSG and the host's existing input policy.\n# Never publish UDP1812/1813 on public/0.0.0.0 addresses.\ncreate table inet ${table}\nadd chain inet ${table} incoming { type filter hook prerouting priority -150; policy accept; }\nadd rule inet ${table} incoming iifname != "${p.serverInterface}" ip daddr ${p.serverTunnelIp} udp dport { 1812, 1813 } drop\nadd rule inet ${table} incoming iifname "${p.serverInterface}" ip saddr ${p.routerTunnelIp} ip daddr ${p.serverTunnelIp} udp dport { 1812, 1813 } accept\nadd rule inet ${table} incoming iifname "${p.serverInterface}" ip saddr ${p.routerTunnelIp} ip daddr ${p.serverTunnelIp} tcp sport 443 ct state established,related accept\nadd rule inet ${table} incoming iifname "${p.serverInterface}" ip saddr ${p.routerTunnelIp} ip daddr ${p.serverTunnelIp} icmp type { echo-request, echo-reply } accept\nadd rule inet ${table} incoming iifname "${p.serverInterface}" drop\nadd chain inet ${table} outgoing { type filter hook postrouting priority 110; policy accept; }\nadd rule inet ${table} outgoing oifname "${p.serverInterface}" ip saddr ${p.serverTunnelIp} ip daddr ${p.routerTunnelIp} tcp dport 443 accept\nadd rule inet ${table} outgoing oifname "${p.serverInterface}" ip saddr ${p.serverTunnelIp} ip daddr ${p.routerTunnelIp} udp sport { 1812, 1813 } ct state established,related accept\nadd rule inet ${table} outgoing oifname "${p.serverInterface}" ip saddr ${p.serverTunnelIp} ip daddr ${p.routerTunnelIp} icmp type { echo-request, echo-reply } accept\nadd rule inet ${table} outgoing oifname "${p.serverInterface}" drop\n`;
}
export function buildPlan(input) {
  const p = validatePlan(input);
  return {
    'router-service.rsc.review': router(p),
    'oracle-wireguard.conf.review': `[Interface]\nAddress = ${p.serverTunnelIp}/32\nListenPort = ${p.port}\nPrivateKey = REPLACE_ON_ORACLE_ONLY\n\n[Peer]\nPublicKey = ${p.routerPublicKey}\nAllowedIPs = ${p.routerTunnelIp}/32\n`,
    'oracle-firewall.nft.review': firewall(p),
    'review.json': JSON.stringify({status:'prepared-only',routerInterface,serverInterface:p.serverInterface,serverEndpoint:p.serverEndpoint,wireguardPort:p.port,serverTunnelIp:p.serverTunnelIp,routerTunnelIp:p.routerTunnelIp,customerDefaultRouteIncluded:false,privateKeysIncluded:false,checks:[
      'This plan targets one fresh site interface. Inspect current routes, interface names, existing peers, host firewall manager and OCI NSG before activation.',
      'Resolve the Oracle endpoint and verify its public IPv4 and UDP reachability. The router initiates outbound traffic; Starlink port forwarding and a static Starlink address are not required.',
      'Retain the router private key on RouterOS and server private key on Oracle. Inspect file ownership/modes before using wg-quick.',
      'The selected router port must be unused and existing WAN rules must permit established replies to its outbound WireGuard packets.',
      'Check the nftables file in an isolated network namespace first and merge its exact scope with the actual firewall manager. It does not flush existing rules or independently override other policy drops.',
      'Bind production RADIUS UDP ports only to the Oracle tunnel IP, preserve each NAS source IP through Docker, and match its registry/client entry to the router tunnel /32.',
      'Configure the actual RouterOS HTTPS certificate and restricted service account separately. This plan does not enable www-ssl, add credentials, configure RADIUS or enable HotSpot.',
      'Before activation, verify site/NAS registration, RADIUS shared-secret custody, mTLS pins and network service qualification.',
      'Physical acceptance: fresh handshake, RADIUS replies, trusted HTTPS lookup, accounting, deny other ports/LAN/site forwarding, Starlink reconnection, router reboot and unchanged local recovery.',
    ]},null,2)+'\n',
  };
}
async function main() {
  const [source,target,extra] = process.argv.slice(2);
  if (!source || !target || extra) throw Error('Usage: node plan.mjs public-site-plan.json new-private-output-directory');
  const raw = await readFile(source,'utf8');
  if (Buffer.byteLength(raw)>65536) throw Error('Public plan exceeds 64 KiB');
  const files=buildPlan(JSON.parse(raw)), directory=resolve(target);
  await mkdir(directory,{mode:0o700});
  try {for(const [name,content] of Object.entries(files)) await writeFile(resolve(directory,name),content,{mode:0o600,flag:'wx'});}
  catch(error){await rm(directory,{recursive:true,force:true});throw error;}
  console.log('Prepared site-link review files; no router, firewall or cloud resource was changed.');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error instanceof SyntaxError?'Invalid public plan JSON':error.message);process.exitCode=1;});
