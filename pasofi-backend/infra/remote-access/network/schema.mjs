import {isIP} from 'node:net';
import {object, endpoint, publicKeys, listenPort, privateIpv4, ipv4Networks, ipv4Number, inIpv4} from '../validation.mjs';

export const SCHEMA_VERSION = 1;
const ID = /^[a-z][a-z0-9-]{0,31}$/;
const SERIAL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const noControl = value => typeof value === 'string' && !/[\u0000-\u001f\u007f-\u009f]/.test(value) && Buffer.from(value,'utf8').toString('utf8') === value;
function fail(message) { throw Error(message); }
function id(value) { if (typeof value !== 'string' || !ID.test(value)) fail('Use a lowercase stable identifier of at most 32 characters'); return value; }
function name(value) { if (!noControl(value) || !value.trim() || Buffer.byteLength(value) > 80) fail('Device names require 1–80 UTF-8 bytes without controls'); return value; }
function serial(value) { if (typeof value !== 'string' || !SERIAL.test(value)) fail('An independently observed router serial is required'); return value; }
function address(value) { if (!privateIpv4(value)) fail('Management addresses must be canonical private IPv4 literals'); return value; }
function time(value) {
  if (typeof value !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== (value.includes('.') ? value : value.replace(/Z$/,'.000Z'))) fail('Use a calendar-valid UTC observation timestamp');
  return value;
}
function ports(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4 || new Set(value).size !== value.length || value.some(port => ![22,80,443,8291].includes(port))) fail('Explicit management TCP ports must be a unique nonempty subset of 22, 80, 443 and 8291');
  return [...value].sort((a,b) => a-b);
}
function permissions(value) {
  object(value, ['tcpPorts','icmp'], 'Management permissions');
  if (typeof value.icmp !== 'boolean') fail('ICMP echo permission must be explicit');
  return {tcpPorts:ports(value.tcpPorts),icmp:value.icmp};
}
function iface(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/.test(value) || ['all','all-ethernet','dynamic','none'].includes(value)) fail('Use the exact inspected interface name');
  return value;
}
function managementInterface(value, linux=false) {
  if (typeof value !== 'string' || !/^pfi-owner(?:-[a-z0-9]+)?$/.test(value) || value.length > (linux ? 15 : 31)) fail('Use a fresh dedicated pfi-owner interface name');
  return value;
}
function networks(value, label, allowEmpty=true) {
  const parsed = ipv4Networks(value, label, true, allowEmpty);
  if (new Set(value).size !== value.length) fail('Observed IPv4 route inventories must not contain duplicates');
  return parsed;
}
const contains = (network, ip) => inIpv4(ip, network.address, network.bits);
const overlap = (a,b) => contains(a,b.address) || contains(b,a.address);
const cidr = n => `${n.address}/${n.bits}`;
function identity(value) {
  object(value, ['kind','value'], 'Expected identity');
  if (value.kind === 'serial') serial(value.value);
  else if (value.kind !== 'mac' || typeof value.value !== 'string' || !/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(value.value) || value.value === '00:00:00:00:00:00' || (parseInt(value.value.slice(0,2),16) & 1)) fail('Use an observed serial or canonical unicast management MAC address');
  return {...value};
}

// Existing advertisements can contain IPv6. Preserve every explicitly inventoried
// route, rather than silently deleting IPv6 routes when adding new IPv4 /32s.
function advertised(value) {
  if (!Array.isArray(value) || value.length > 256) fail('Supply the full existing advertised-route list, including an explicit empty list');
  const ipv4 = [];
  for (const route of value) {
    if (typeof route !== 'string') fail('Existing advertisements must be canonical non-default IP network CIDRs');
    const [ip,prefix,extra] = route.split('/');
    if (extra !== undefined) fail('Existing advertisements must be canonical non-default IP network CIDRs');
    if (isIP(ip) === 4) ipv4.push(...ipv4Networks([route], 'Existing advertisements'));
    else {
      if (isIP(ip) !== 6 || ip.includes('.') || !/^(?:[1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$/.test(prefix ?? '')) fail('Existing advertisements require canonical IPv4/IPv6 networks; default routes are outside this planner');
      const [left,right] = ip.split('::'), first = left ? left.split(':') : [], last = right ? right.split(':') : [];
      const groups = right === undefined ? first : [...first,...Array(8-first.length-last.length).fill('0'),...last];
      const numbers = groups.map(group => parseInt(group,16));
      const number = numbers.reduce((total,group) => (total << 16n) + BigInt(group),0n);
      if (number & ((1n << BigInt(128-Number(prefix))) - 1n)) fail('Existing IPv6 advertisements must be network addresses');
      let bestStart=-1,bestLength=1;
      for (let start=0;start<8;) {
        if (numbers[start] !== 0) { start++; continue; }
        let end=start; while(end<8 && numbers[end]===0) end++;
        if (end-start>bestLength) {bestStart=start;bestLength=end-start;}
        start=end;
      }
      const hex=numbers.map(group=>group.toString(16));
      const canonical=bestStart<0 ? hex.join(':') : `${hex.slice(0,bestStart).join(':')}::${hex.slice(bestStart+bestLength).join(':')}`;
      if (ip !== canonical) fail('Existing IPv6 advertisements must use canonical lowercase compression');
    }
  }
  if (new Set(value).size !== value.length) fail('Existing advertisements contain duplicate routes');
  return {routes:[...value],ipv4};
}

export function validatePlan(input) {
  object(input,['schemaVersion','planId','owner','hub','gateways'],'Owner network plan');
  if (input.schemaVersion !== SCHEMA_VERSION) fail('Unsupported owner network schema version');
  const planId=id(input.planId);
  object(input.owner,['tailscaleLogin','ipv4Routes'],'Owner');
  const login=input.owner.tailscaleLogin;
  if (typeof login !== 'string' || login.length>160 || !/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(login)) fail('Use the exact existing owner Tailscale login');
  const domain=login.split('@')[1];
  if(!['github','passkey'].includes(domain) && (!domain.includes('.') || /^[\d.]+$/.test(domain) || !domain.split('.').every(label=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))) fail('Use an exact email-style, GitHub or passkey Tailscale login');
  const clientNetworks=networks(input.owner.ipv4Routes,'Owner IPv4 routes');
  object(input.hub,['endpoint','listenPort','interface','publicKey','tunnelIp','tailscaleNodeId','ipv4Routes','existingAdvertisedRoutes'],'Hub');
  endpoint(input.hub.endpoint,4,'Hub endpoint'); listenPort(input.hub.listenPort);
  managementInterface(input.hub.interface,true); address(input.hub.tunnelIp);
  if (typeof input.hub.tailscaleNodeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.hub.tailscaleNodeId)) fail('The inspected hub Tailscale StableNodeID is required');
  const hubNetworks=networks(input.hub.ipv4Routes,'Hub IPv4 routes');
  const previous=advertised(input.hub.existingAdvertisedRoutes);
  if (!Array.isArray(input.gateways) || input.gateways.length<1 || input.gateways.length>16) fail('Supply 1–16 independently inspected MikroTik gateways');
  const ids=new Set(),addresses=new Set([input.hub.tunnelIp]),keys=new Set([input.hub.publicKey]),identities=new Set(),lanOwners=[];
  function unique(set,value,message) {if(set.has(value)) fail(message);set.add(value);}
  function claimIdentity(value) {unique(identities,`${value.kind}:${value.value.toLowerCase()}`,'A physical device identity has more than one owner');}
  const gateways=input.gateways.map(g=>{
    object(g,['id','name','expectedSerial','verifiedAt','interface','listenPort','publicKey','tunnelIp','wanInterface','ipv4Routes','management','targets'],'Gateway');
    id(g.id); name(g.name); serial(g.expectedSerial); time(g.verifiedAt);
    unique(ids,g.id,'Device identifiers must be globally unique'); claimIdentity({kind:'serial',value:g.expectedSerial});
    managementInterface(g.interface); iface(g.wanInterface); listenPort(g.listenPort); address(g.tunnelIp);
    if(g.interface===g.wanInterface) fail('The dedicated management interface must differ from the WAN');
    publicKeys(input.hub.publicKey,g.publicKey); unique(keys,g.publicKey,'Each gateway requires its own distinct public key');
    unique(addresses,g.tunnelIp,'Management addresses and tunnel allocations must be unique');
    const routes=networks(g.ipv4Routes,'Gateway IPv4 routes',false),management=permissions(g.management);
    if(!Array.isArray(g.targets)||g.targets.length>32) fail('Each gateway requires an explicit target list of at most 32 devices');
    const targets=g.targets.map(t=>{
      object(t,['id','name','vendor','address','management','expectedIdentity','verifiedAt','path'],'Downstream target');
      id(t.id); name(t.name); address(t.address); time(t.verifiedAt);
      if(!['mikrotik','tenda','mercusys','other'].includes(t.vendor)) fail('Use a documented device vendor category');
      unique(ids,t.id,'Device identifiers must be globally unique'); unique(addresses,t.address,'A management address has more than one owner');
      const expectedIdentity=identity(t.expectedIdentity); claimIdentity(expectedIdentity);
      object(t.path,['egressInterface','connectedCidr','gatewayLanIp','returnPath'],'Target path');
      iface(t.path.egressInterface); address(t.path.gatewayLanIp);
      if([g.interface,g.wanInterface,'pamofi-service','pasofi-service'].includes(t.path.egressInterface) || t.path.egressInterface.startsWith('pfi-owner')) fail('Targets must use an inspected local management interface, not WAN or a service/owner tunnel');
      const [network]=networks([t.path.connectedCidr],'Target connected network',false);
      const end=ipv4Number(network.address)+2**(32-network.bits)-1;
      const endIp=[24,16,8,0].map(shift=>Math.floor(end/2**shift)%256).join('.');
      if(network.bits>30 || !privateIpv4(network.address) || !privateIpv4(endIp) || !g.ipv4Routes.includes(cidr(network))) fail('Each target needs an inspected private connected LAN prefix, present in its gateway route inventory');
      for(const ip of [t.address,t.path.gatewayLanIp]) if(!contains(network,ip)||[ipv4Number(network.address),end].includes(ipv4Number(ip))) fail('Target and LAN gateway must be usable addresses in the inspected connected prefix');
      if(routes.some(route=>route.bits>network.bits && contains(route,t.address))) fail('A more-specific inspected route overrides the claimed local target path');
      if(t.address===t.path.gatewayLanIp) fail('Enroll the gateway by its overlay address, not as a downstream target');
      if(!['source-nat','verified-gateway-route'].includes(t.path.returnPath)) fail('Select narrow source NAT or an independently verified return route via this LAN gateway');
      for(const owned of lanOwners) if(overlap(network,owned.network) && (owned.gatewayId!==g.id || cidr(owned.network)!==cidr(network) || owned.interface!==t.path.egressInterface || owned.gatewayIp!==t.path.gatewayLanIp)) fail('Management LAN ownership or egress is ambiguous across targets');
      lanOwners.push({network,gatewayId:g.id,interface:t.path.egressInterface,gatewayIp:t.path.gatewayLanIp});
      return {...t,management:permissions(t.management),expectedIdentity,path:{...t.path}};
    });
    return {...g,management,targets,_networks:routes};
  });
  if(ids.size>128) fail('The plan exceeds 128 total device targets');
  const allNetworks=[...clientNetworks,...hubNetworks,...previous.ipv4,...gateways.flatMap(g=>g._networks)];
  for(const ip of [input.hub.tunnelIp,...gateways.map(g=>g.tunnelIp)]) if(allNetworks.some(network=>contains(network,ip))) fail('A fresh tunnel allocation overlaps an inspected route or existing advertisement');
  for(const g of gateways) for(const t of g.targets) {
    if([...clientNetworks,...hubNetworks,...previous.ipv4].some(network=>contains(network,t.address))) fail('A downstream management destination conflicts with an owner/hub route or existing advertisement');
    if(lanOwners.some(owned=>owned.gatewayIp===t.address)) fail('A downstream target is an inspected gateway LAN address');
  }
  return {schemaVersion:SCHEMA_VERSION,planId,owner:{...input.owner},hub:{...input.hub,existingAdvertisedRoutes:previous.routes},gateways};
}

export function ownerManifest(plan) {
  const targets=plan.gateways.flatMap(g=>[
    {id:g.id,name:g.name,role:'gateway',gatewayId:g.id,vendor:'mikrotik',address:g.tunnelIp,...g.management,expectedIdentity:{kind:'serial',value:g.expectedSerial},verifiedAt:g.verifiedAt},
    ...g.targets.map(t=>({id:t.id,name:t.name,role:'downstream',gatewayId:g.id,vendor:t.vendor,address:t.address,...t.management,expectedIdentity:t.expectedIdentity,verifiedAt:t.verifiedAt})),
  ]);
  return {schemaVersion:SCHEMA_VERSION,kind:'pasofi-owner-management',status:'prepared-only',planId:plan.planId,expectedTailscaleLogin:plan.owner.tailscaleLogin,expectedHubNodeId:plan.hub.tailscaleNodeId,requiredRoutes:targets.map(t=>`${t.address}/32`),targets};
}
