#!/usr/bin/env node
import {readFile,mkdir,writeFile,rm,realpath,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname,basename,join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validatePlan,ownerManifest} from './schema.mjs';

const json = value => `${JSON.stringify(value,null,2)}\n`;
const serviceNames = {22:'ssh',80:'www',443:'www-ssl',8291:'winbox'};
const tag = (p,g) => `PasoFi owner ${p.planId} ${g.id}:`;
function first(menu,chain,rule) {
  const found=`[${menu} find where chain="${chain}"]`,add=`${menu} add chain=${chain} ${rule}`;
  return `:if ([:len ${found}] > 0) do={ ${add} place-before=(${found}->0) } else={ ${add} }`;
}
function routerRules(p,g) {
  const rules=[],prefix=tag(p,g),own=`in-interface="${g.interface}" src-address=${p.hub.tunnelIp}/32 dst-address=${g.tunnelIp}/32`;
  const back=`out-interface="${g.interface}" src-address=${g.tunnelIp}/32 dst-address=${p.hub.tunnelIp}/32`;
  const add=(family,chain,match,label)=>rules.push({menu:`/${family===4?'ip':'ipv6'} firewall filter`,chain,match,comment:`${prefix} ${label}`});
  for(const chain of ['input','forward']) add(4,chain,`action=drop in-interface=!${g.interface} src-address=${p.hub.tunnelIp}/32`,`${chain} hub source spoof`);
  add(4,'input',`action=accept ${own} protocol=tcp dst-port=${g.management.tcpPorts.join(',')} connection-state=new,established`,'gateway TCP');
  add(4,'output',`action=accept ${back} protocol=tcp src-port=${g.management.tcpPorts.join(',')} connection-state=established`,'gateway TCP replies');
  if(g.management.icmp) {
    add(4,'input',`action=accept ${own} protocol=icmp icmp-options=8:0 connection-state=new,established`,'gateway echo');
    add(4,'output',`action=accept ${back} protocol=icmp icmp-options=0:0 connection-state=established`,'gateway echo replies');
  }
  add(4,'input',`action=accept ${own} protocol=icmp connection-state=related`,'gateway related errors');
  add(4,'output',`action=accept ${back} protocol=icmp connection-state=related`,'gateway related error replies');
  for(const t of g.targets) {
    const incoming=`in-interface="${g.interface}" out-interface="${t.path.egressInterface}" src-address=${p.hub.tunnelIp}/32 dst-address=${t.address}/32`;
    // Reverse source NAT has already restored the hub destination in prerouting.
    const outgoing=`in-interface="${t.path.egressInterface}" out-interface="${g.interface}" src-address=${t.address}/32 dst-address=${p.hub.tunnelIp}/32`;
    add(4,'forward',`action=accept ${incoming} protocol=tcp dst-port=${t.management.tcpPorts.join(',')} connection-state=new,established`,`target ${t.id} TCP`);
    add(4,'forward',`action=accept ${outgoing} protocol=tcp src-port=${t.management.tcpPorts.join(',')} connection-state=established`,`target ${t.id} TCP replies`);
    if(t.management.icmp) {
      add(4,'forward',`action=accept ${incoming} protocol=icmp icmp-options=8:0 connection-state=new,established`,`target ${t.id} echo`);
      add(4,'forward',`action=accept ${outgoing} protocol=icmp icmp-options=0:0 connection-state=established`,`target ${t.id} echo replies`);
    }
    add(4,'forward',`action=accept ${incoming} protocol=icmp connection-state=related`,`target ${t.id} related errors`);
    add(4,'forward',`action=accept ${outgoing} protocol=icmp connection-state=related`,`target ${t.id} related error replies`);
  }
  for(const family of [4,6]) {
    add(family,'input',`action=drop in-interface="${g.interface}"`,`IPv${family} other input`);
    add(family,'output',`action=drop out-interface="${g.interface}"`,`IPv${family} other output`);
    add(family,'forward',`action=drop in-interface="${g.interface}"`,`IPv${family} other forwarding from owner`);
    add(family,'forward',`action=drop out-interface="${g.interface}"`,`IPv${family} other forwarding to owner`);
  }
  return rules;
}
function natRules(p,g) {
  return g.targets.filter(t=>t.path.returnPath==='source-nat').flatMap(t=>{
    // The full source/destination/egress tuple is explicit: no LAN-wide masquerade.
    const common=`src-address=${p.hub.tunnelIp}/32 dst-address=${t.address}/32 out-interface="${t.path.egressInterface}"`;
    const rules=[{menu:'/ip firewall nat',chain:'srcnat',match:`action=src-nat ${common} protocol=tcp dst-port=${t.management.tcpPorts.join(',')} to-addresses=${t.path.gatewayLanIp}`,comment:`${tag(p,g)} ${t.id} TCP source NAT`}];
    if(t.management.icmp) rules.push({menu:'/ip firewall nat',chain:'srcnat',match:`action=src-nat ${common} protocol=icmp icmp-options=8:0 to-addresses=${t.path.gatewayLanIp}`,comment:`${tag(p,g)} ${t.id} echo source NAT`});
    return rules;
  });
}
function pin(g) {return `:if ([/system routerboard get serial-number] != "${g.expectedSerial}") do={ :error "Gateway serial differs from the inspected plan" }`;}
function router(p,g) {
  const own=`[/interface wireguard find where name="${g.interface}"]`,prefix=tag(p,g);
  const lines=['{','# REVIEW ONLY. Import this complete block in Safe Mode after dry-run, with independent local recovery.',
    '# Use a FRESH Safe Mode session with no concurrent configuration edits; the action budget is bounded offline.',
    '# A failed or partial apply is inspected; this file never adopts or overwrites existing state.',pin(g),
    `:if ([:len ${own}] != 1) do={ :error "Prepare exactly one fresh disabled owner WireGuard interface first" }`,
    `:if ([/interface wireguard get ${own} disabled] != true) do={ :error "Owner interface must remain disabled during preparation" }`,
    `:if ([/interface wireguard get ${own} public-key] != "${g.publicKey}") do={ :error "Gateway public key differs from the reviewed plan" }`,
    `:if ([/interface wireguard get ${own} listen-port] != ${g.listenPort}) do={ :error "Gateway listen port differs from the reviewed plan" }`,
    `:if ([:len [/interface wireguard find where listen-port=${g.listenPort}]] != 1) do={ :error "WireGuard listen port is already used" }`,
    `:if ([:len [/interface find where name="${g.wanInterface}"]] != 1) do={ :error "Inspected WAN interface is absent" }`,
    ...['/interface wireguard peers','/ip address','/interface list member','/interface bridge port'].map(menu=>`:if ([:len [${menu} find where interface="${g.interface}"]] > 0) do={ :error "Owner interface contains prior state" }`),
    `:if ([:len [/ipv6 address find where interface="${g.interface}" and (dynamic=no or link-local=no)]] > 0) do={ :error "Owner interface has unexpected IPv6 addresses" }`,
    ...['/ip route','/ipv6 route'].map(menu=>`:if ([:len [${menu} find where gateway="${g.interface}"]] > 0) do={ :error "Owner interface already has routes" }`),
    `:if ([:len [/interface wireguard peers find where public-key="${p.hub.publicKey}"]] > 0) do={ :error "Hub peer key already exists on this router; use a dedicated owner-plane key" }`,
    ...['/ip address','/ip route','/ipv6 route','/ip firewall filter','/ipv6 firewall filter','/ip firewall nat'].map(menu=>`:if ([:len [${menu} find where comment~"^${prefix}"]] > 0) do={ :error "Prior or partial owner plan requires inspection" }`),
    ':if ([:len [/routing rule find where disabled=no]] > 0) do={ :error "Policy routing needs a separately reviewed management path" }',
    ':if ([:len [/ip firewall mangle find where action=mark-routing and disabled=no]] > 0) do={ :error "Routing marks need a separately reviewed management path" }',
    `:if ([:len [/ip route find where dst-address!="0.0.0.0/0"${g.ipv4Routes.map(route=>` and dst-address!="${route}"`).join('')}]] > 0) do={ :error "IPv4 route inventory changed; inspect and regenerate" }`,
    ...g.ipv4Routes.map(route=>`:if ([:len [/ip route find where dst-address="${route}"]] = 0) do={ :error "An inspected IPv4 route disappeared; inspect and regenerate" }`),
  ];
  for(const port of g.management.tcpPorts) lines.push(`:if ([:len [/ip service find where name="${serviceNames[port]}" and port=${port} and disabled=no and dynamic=no and invalid=no]] != 1) do={ :error "A selected native management service is not enabled and valid at its inspected port" }`);
  const lans=new Set();
  for(const t of g.targets) {
    const lan=`${t.path.egressInterface}:${t.path.gatewayLanIp}/${t.path.connectedCidr.split('/')[1]}`;
    if(lans.has(lan)) continue; lans.add(lan);
    lines.push(`:if ([:len [/interface find where name="${t.path.egressInterface}"]] != 1) do={ :error "Inspected target egress interface is absent" }`,
      `:if ([:len [/ip address find where interface="${t.path.egressInterface}" and address="${t.path.gatewayLanIp}/${t.path.connectedCidr.split('/')[1]}" and disabled=no]] != 1) do={ :error "Inspected target LAN gateway address changed" }`);
  }
  lines.push('# All preflight reads end here. Insert allowlists AND blanket drops before existing accepts/FastTrack.');
  for(const rule of [...routerRules(p,g)].reverse()) lines.push(first(rule.menu,rule.chain,`${rule.match} comment="${rule.comment}"`));
  for(const rule of [...natRules(p,g)].reverse()) lines.push(first(rule.menu,rule.chain,`${rule.match} comment="${rule.comment}"`));
  lines.push(`/ip address add address=${g.tunnelIp}/32 interface="${g.interface}" comment="${prefix} gateway address"`,
    `/interface wireguard peers add interface="${g.interface}" public-key="${p.hub.publicKey}" allowed-address=${p.hub.tunnelIp}/32 endpoint-address="${p.hub.endpoint}" endpoint-port=${p.hub.listenPort} persistent-keepalive=25s comment="${prefix} owner hub"`,
    `/ip route add dst-address=${p.hub.tunnelIp}/32 gateway="${g.interface}" comment="${prefix} owner hub route"`,
    '# Enable last. Existing service tunnels, WAN rules, native accounts, LAN/DHCP and customer routes stay unchanged.',
    `/interface wireguard set ${own} disabled=no`,'}','');
  return lines.join('\n');
}
function rollback(p,g) {
  const own=`[/interface wireguard find where name="${g.interface}"]`,prefix=tag(p,g);
  const exact=[
    {menu:'/interface wireguard peers',comment:`${prefix} owner hub`},
    {menu:'/ip route',comment:`${prefix} owner hub route`},
    {menu:'/ip address',comment:`${prefix} gateway address`},
    ...natRules(p,g),...routerRules(p,g),
  ];
  return ['{','# REVIEW ONLY. Use independent local recovery; this closes this owner-management path.',
    '# Use a FRESH Safe Mode session with no concurrent configuration edits.',
    '# Inspect each exact tagged record first. Partial applies require inspection before using this rollback.',pin(g),
    `:if ([:len ${own}] != 1) do={ :error "Dedicated owner interface is absent or ambiguous" }`,
    `:if ([/interface wireguard get ${own} public-key] != "${g.publicKey}") do={ :error "Owner interface key changed" }`,
    ...exact.map(r=>`:if ([:len [${r.menu} find where comment="${r.comment}"]] != 1) do={ :error "A tagged owner record is missing or ambiguous; inspect instead of broad cleanup" }`),
    `/interface wireguard set ${own} disabled=yes`,
    ...exact.map(r=>`${r.menu} remove [find where comment="${r.comment}"]`),
    '# Retain the disabled interface and its private key. No shared settings or unrelated connection records are removed.',
    '}',''].join('\n');
}
function firewall(p,manifest) {
  const table=p.hub.interface.replaceAll('-','_'),wg=`"${p.hub.interface}"`,source='100.64.0.0/10';
  const lines=['# REVIEW ONLY: new dedicated table; integrate with the actual host firewall manager.',
    '# Accepts here do not override later drops. Do not flush or replace shared rules.',
    '# Forward filtering sees owner Tailscale IPs BEFORE SNAT and restored owner destinations on replies.',
    '# Existing default Tailscale subnet SNAT must translate outbound source to the hub WG /32.',
    `create table inet ${table}`,
    ...['input','output','forward'].map(chain=>`add chain inet ${table} ${chain} { type filter hook ${chain} priority -50; policy accept; }`),
    `add chain inet ${table} after_snat { type filter hook postrouting priority 110; policy accept; }`,
  ];
  const add=(chain,match)=>lines.push(`add rule inet ${table} ${chain} ${match}`);
  for(const t of manifest.targets) {
    const dst=`iifname "tailscale0" oifname ${wg} ip saddr ${source} ip daddr ${t.address}`;
    const back=`iifname ${wg} oifname "tailscale0" ip saddr ${t.address} ip daddr ${source}`;
    add('forward',`${dst} tcp dport { ${t.tcpPorts.join(', ')} } ct state { new, established } accept`);
    add('forward',`${back} tcp sport { ${t.tcpPorts.join(', ')} } ct state established accept`);
    if(t.icmp) {
      add('forward',`${dst} icmp type echo-request ct state { new, established } accept`);
      add('forward',`${back} icmp type echo-reply ct state established accept`);
      // Explicit hub diagnostic echo is useful before route advertisement; no host-originated TCP is allowed.
      add('output',`oifname ${wg} ip saddr ${p.hub.tunnelIp} ip daddr ${t.address} icmp type echo-request ct state { new, established } accept`);
      add('input',`iifname ${wg} ip saddr ${t.address} ip daddr ${p.hub.tunnelIp} icmp type echo-reply ct state established accept`);
    }
    add('forward',`${dst} ip protocol icmp ct state related accept`);
    add('forward',`${back} ip protocol icmp ct state related accept`);
    add('input',`iifname ${wg} ip saddr ${t.address} ip daddr ${p.hub.tunnelIp} ip protocol icmp ct state related accept`);
  }
  add('input',`iifname ${wg} drop`); add('output',`oifname ${wg} drop`);
  add('forward',`iifname ${wg} drop`); add('forward',`oifname ${wg} drop`);
  add('after_snat',`oifname ${wg} ip saddr ${p.hub.tunnelIp} accept`);
  add('after_snat',`oifname ${wg} drop`);
  lines.push('# Inner IPv6 matches no IPv4 allow above and is denied in both directions.',
    '# Permit the selected outer UDP listener through the inspected host/cloud policy separately.',
    '# Revoke route grants and stop this dedicated WG interface before removing only this table.','');
  return lines.join('\n');
}

export function buildPlan(input) {
  const p=validatePlan(input),manifest=ownerManifest(p),files={};
  const mutationCounts=Object.fromEntries(p.gateways.map(g=>{
    const count=routerRules(p,g).length+natRules(p,g).length+4;
    if(count>80) throw Error('A gateway exceeds the 80-action fresh Safe Mode budget; reduce its reviewed targets or design a separate qualified change');
    return [g.id,{apply:count,rollback:count}];
  }));
  for(const g of p.gateways) {
    files[`router-${g.id}.rsc.review`]=router(p,g);
    files[`router-${g.id}.rollback.rsc.review`]=rollback(p,g);
  }
  files['hub-wireguard.conf.review']=[
    '# REVIEW ONLY: a new dedicated interface. Preserve existing WireGuard/service interfaces.',
    '# Generate and retain the private key on the hub; verify its public key against the plan.',
    `[Interface]\nAddress = ${p.hub.tunnelIp}/32\nListenPort = ${p.hub.listenPort}\nPrivateKey = REPLACE_ON_HUB_ONLY`,
    ...p.gateways.map(g=>`\n# Gateway ${g.id}; no other peer may own these destinations.\n[Peer]\nPublicKey = ${g.publicKey}\nAllowedIPs = ${[g.tunnelIp,...g.targets.map(t=>t.address)].map(ip=>`${ip}/32`).join(', ')}`),'',
  ].join('\n');
  files['hub-firewall.nft.review']=firewall(p,manifest);
  files['tailscale-policy-fragment.json']=json({grants:manifest.targets.map(t=>({src:[p.owner.tailscaleLogin],dst:[`${t.address}/32`],ip:[...t.tcpPorts.map(port=>`tcp:${port}`),...(t.icmp?['icmp:*']:[])]})),
    tests:manifest.targets.map(t=>({src:p.owner.tailscaleLogin,proto:'tcp',accept:t.tcpPorts.map(port=>`${t.address}:${port}`),deny:[22,53,80,443,8291,8728,8729].filter(port=>!t.tcpPorts.includes(port)).map(port=>`${t.address}:${port}`)}))});
  const union=[...p.hub.existingAdvertisedRoutes,...manifest.requiredRoutes];
  files['tailscale-route-command.txt.review']=[
    '# REVIEW ONLY. Verify this exact StableNodeID and the full existing advertisement snapshot first.',
    `# Expected StableNodeID: ${p.hub.tailscaleNodeId}`,
    `# Previous advertised routes: ${p.hub.existingAdvertisedRoutes.length?p.hub.existingAdvertisedRoutes.join(','):'(explicitly empty)'}`,
    '# --advertise-routes REPLACES the list. The command below preserves every listed prior IPv4/IPv6 route.',
    '# If live routes differ, stop and regenerate. Merge policy first; approve only the new management /32s.',
    '# Keep existing subnet SNAT enabled. Do not change DNS, exit-node, SSH, account or other Tailscale settings.',
    `sudo tailscale set --advertise-routes=${union.join(',')}`,''].join('\n');
  files['owner-targets.json']=json(manifest);
  files['review.json']=json({schemaVersion:1,status:'prepared-only',planId:p.planId,gatewayCount:p.gateways.length,targetCount:manifest.targets.length,
    sourceSha256:createHash('sha256').update(JSON.stringify(input)).digest('hex'),privateKeysIncluded:false,liveChangesPerformed:false,
    safeModeActionLimit:80,mutationCounts,
    freshHubInterface:p.hub.interface,expectedHubPublicKey:p.hub.publicKey,existingAdvertisedRoutes:p.hub.existingAdvertisedRoutes,requiredRoutes:manifest.requiredRoutes,preservedAdvertisedRoutes:union,
    observedIpv4Routes:{hub:p.hub.ipv4Routes,owner:p.owner.ipv4Routes,gateways:Object.fromEntries(p.gateways.map(g=>[g.id,g.ipv4Routes]))},
    qualification:{routerosSyntax:false,hostFirewallIntegration:false,tailnetPolicy:false,externalNetworkAccess:false,authenticatedDeviceIdentity:false,reconnectAfterRestart:false,firmwareUpgrade:false},
    checks:[
      'Operator-supplied inventory is not independent observation. Recheck identities, management addresses, enabled services, default return paths and all route inventories immediately before applying.',
      'Require the expected existing Tailscale hub StableNodeID/account, a fresh unused Linux interface/listener, exact locally derived hub public key, IPv4 forwarding, normal TUN networking and default subnet SNAT. Inspect firewall/NAT/raw/flow-offload/VRF/policy routing before integration.',
      'Use a distinct owner-plane hub key and one fresh disabled dedicated interface/key per gateway. Do not reuse, reset or widen the working RADIUS/service tunnel.',
      'The RouterOS block pins serial, key, disabled interface, listener, inspected routes, selected native services and downstream LAN addresses. It does not enable services or change credentials/address restrictions. Run import verbose=yes dry-run on the exact file, then apply the complete block in a fresh Safe Mode session with independent local recovery and no concurrent configuration changes. Each apply/rollback is limited to 80 mutations below the 100-action history ceiling.',
      'Merge the host guards with the actual firewall manager and cloud outer-UDP policy; accepts in a new table do not override later drops. Do not flush shared rules or expose TCP management publicly. Confirm source translation on the WG interface equals the hub /32.',
      'Merge the Tailscale policy fragment with the full existing policy; grants are additive. Existing broad grants can admit other identities. Preserve unrelated policy, prove a real unapproved-user denial and approve routes separately from granting access.',
      'The advertised-route command is valid only if the full existing snapshot still matches. Preserve existing IPv4 and IPv6 advertisements. No default or new customer subnet route is generated.',
      'For each device, test from another WiFi/mobile network: correct Tailscale identity/hub/route, selected TCP/echo, denied other destinations/ports, authenticated physical identity, native login and permitted troubleshooting. A socket or HTTP response does not prove device identity.',
      'Qualify downstream LAN-only UI behavior and redirects, SNAT/return traffic, full-size transfers, unrelated customer networking, radio/gateway/hub restart and recovery. WinBox MAC discovery is not provided across this routed path; use the verified IP.',
      'Firmware upgrades use the qualified native vendor interface with the matching hardware/version, backup and independent recovery. No firmware upload, reboot, automatic update or promise of recovery after tunnel failure is included.',
      'For revocation, remove only these new tailnet route approvals/grants, stop this dedicated hub interface, and use the exact router rollback from independent local recovery. Restore the previous advertisement list only after checking for later unrelated additions; never replay a stale snapshot.',
    ]});
  return files;
}

export async function writePlan(input,output) {
  const files=buildPlan(input);
  if(typeof output!=='string'||!isAbsolute(output)) throw Error('Use a new absolute private output directory outside Git');
  const parent=await realpath(dirname(output)),directory=join(parent,basename(output));
  for(let current=parent;;current=dirname(current)) {
    try {await lstat(join(current,'.git'));throw Error('Keep private owner-management output outside every Git worktree');}
    catch(error) {if(error.code!=='ENOENT') throw error;}
    if(dirname(current)===current) break;
  }
  await mkdir(directory,{mode:0o700});
  try {for(const [name,body] of Object.entries(files)) await writeFile(resolve(directory,name),body,{mode:0o600,flag:'wx'});}
  catch(error) {await rm(directory,{recursive:true,force:true});throw error;}
  return Object.keys(files);
}
async function main() {
  const [source,output,extra]=process.argv.slice(2);
  if(!source||!output||extra) throw Error('Usage: node network/plan.mjs private-plan.json new-private-review-directory');
  const raw=await readFile(source,'utf8');
  if(Buffer.byteLength(raw)>256*1024) throw Error('Owner network plan exceeds 256 KiB');
  await writePlan(JSON.parse(raw),output);
  console.log('Prepared private owner-management review files. No VPN, router, server or client was changed.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{console.error(error instanceof SyntaxError?'Invalid owner network JSON':error.message);process.exitCode=1;});
