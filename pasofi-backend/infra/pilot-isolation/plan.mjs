#!/usr/bin/env node
// A disabled, fail-closed scaffold for the inspected hAP lite. No credentials.
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const bridge='pfi-pilot-br', wifi='pfi-pilot-wifi', profile='pfi-pilot-open';
const tag='PamoFi pilot:';
function guard(menu,chain,direction) {
  const match=`[${menu} find where chain="${chain}"]`;
  const rule=`chain=${chain} action=drop ${direction}-interface="${bridge}" comment="${tag} ${chain} ${direction}"`;
  return `:if ([:len ${match}] > 0) do={ ${menu} add ${rule} place-before=(${match}->0) } else={ ${menu} add ${rule} }`;
}
export function buildPlan() {
  return [
    '{',
    '# REVIEW ONLY: disabled isolated pilot scaffold, no hotspot or customer access.',
    ':if ([:len [/interface wireless find where name="wlan1" and mode="ap-bridge" and disabled=no]] != 1) do={ :error "Expected active wlan1 access point is missing" }',
    ...[bridge,wifi].map(name=>`:if ([:len [/interface find where name="${name}"]] > 0) do={ :error "Pilot interface name already exists" }`),
    `:if ([:len [/interface wireless security-profiles find where name="${profile}"]] > 0) do={ :error "Pilot security profile already exists" }`,
    `:if ([:len [/interface bridge port find where comment~"^${tag}"]] > 0) do={ :error "Prior pilot bridge port exists; inspect and recover before applying" }`,
    ...['/ip firewall filter','/ipv6 firewall filter'].map(menu=>`:if ([:len [${menu} find where comment~"^${tag}"]] > 0) do={ :error "Pilot firewall state already exists" }`),
    `/interface bridge add name="${bridge}" disabled=yes comment="${tag} isolated bridge"`,
    ...['/ip firewall filter','/ipv6 firewall filter'].flatMap(menu=>[
      guard(menu,'input','in'),guard(menu,'output','out'),guard(menu,'forward','in'),guard(menu,'forward','out'),
    ]),
    `/interface wireless security-profiles add name="${profile}" mode=none`,
    `/interface wireless add name="${wifi}" master-interface=wlan1 mode=ap-bridge ssid="PasoFi Pilot" security-profile="${profile}" default-forwarding=no wps-mode=disabled disabled=yes comment="${tag} disabled test radio"`,
    `:if ([:len [/interface bridge port find where interface="${wifi}"]] > 0) do={ :error "Pilot radio already has bridge membership; inspect and roll back" }`,
    `/interface bridge port add bridge="${bridge}" interface="${wifi}" comment="${tag} disabled test port"`,
    `:if ([:len [/interface bridge port find where interface="${wifi}" and bridge="${bridge}" and comment="${tag} disabled test port"]] != 1) do={ :error "Pilot bridge membership differs from plan" }`,
    '# Both interfaces remain disabled. No IP address, DHCP, NAT, HotSpot or RADIUS is created.',
    '}', '',
  ].join('\n');
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [target,extra]=process.argv.slice(2);
  if(!target||extra){console.error('Usage: node plan.mjs /absolute/new-review.rsc');process.exitCode=1;}
  else writeFile(resolve(target),buildPlan(),{flag:'wx',mode:0o600}).then(()=>console.log('Prepared disabled pilot scaffold; no router settings changed.')).catch(()=>{console.error('Could not write a new review file.');process.exitCode=1;});
}
