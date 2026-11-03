#!/usr/bin/env node
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Fixed to the inspected first router. This is a disabled scaffold, not a hotspot.
export function buildNetworkPlan(){
  return ['{',
    '# REVIEW ONLY: disabled pilot address and DHCP; no DNS override or customer access.',
    ':if ([:len [/interface bridge find where name="pfi-pilot-br" and disabled=yes]] != 1) do={ :error "Expected disabled pilot bridge" }',
    ':if ([:len [/interface wireless find where name="pfi-pilot-wifi" and disabled=yes]] != 1) do={ :error "Expected disabled pilot radio" }',
    ':if ([:len [/interface bridge port find where interface="pfi-pilot-wifi" and bridge="pfi-pilot-br" and comment="PamoFi pilot: disabled test port"]] != 1) do={ :error "Unexpected pilot bridge membership" }',
    // RouterOS can prefix the stored comment with interface-not-ready messages
    // when the bridge is disabled. Match the intended suffix, while still
    // requiring the exact chain, interface, drop action and enabled setting.
    ...['/ip firewall filter','/ipv6 firewall filter'].map(menu=>`:if ([:len [${menu} find where comment~"PamoFi pilot:" and action=drop]] != 4) do={ :error "Expected four pilot deny rules per IP family" }`),
    ...['/ip firewall filter','/ipv6 firewall filter'].flatMap(menu=>[
      ...[['input','in'],['output','out'],['forward','in'],['forward','out']].map(([chain,direction])=>`:if ([:len [${menu} find where chain="${chain}" and ${direction}-interface="pfi-pilot-br" and action=drop and comment~"PamoFi pilot: ${chain} ${direction}\\$"]] != 1) do={ :error "Unexpected pilot deny rule" }`),
      `:foreach pfiRule in=[${menu} find where comment~"PamoFi pilot:" and action=drop] do={ :if ([${menu} get $pfiRule disabled] = true) do={ :error "Pilot deny rule is disabled" } }`,
    ]),
    ':if ([:len [/ip address find where interface="pfi-pilot-br"]] != 0) do={ :error "Pilot bridge already has an IPv4 address" }',
    ':if ([:len [/ip route find where dst-address="10.77.10.0/24"]] != 0) do={ :error "Pilot subnet already has a route" }',
    ':if ([:len [/ip pool find where name="pfi-pilot-pool"]] != 0) do={ :error "Pilot pool already exists" }',
    ':if ([:len [/ip dhcp-server network find where address="10.77.10.0/24"]] != 0) do={ :error "Pilot DHCP network already exists" }',
    ':if ([:len [/ip dhcp-server find where name="pfi-pilot-dhcp" or interface="pfi-pilot-br"]] != 0) do={ :error "Pilot DHCP server already exists" }',
    '/ip address add address=10.77.10.1/24 interface="pfi-pilot-br" comment="PamoFi pilot: gateway"',
    '/ip pool add name="pfi-pilot-pool" ranges=10.77.10.10-10.77.10.200',
    '/ip dhcp-server network add address=10.77.10.0/24 gateway=10.77.10.1 dns-server=10.77.10.1 comment="PamoFi pilot: DHCP network"',
    '/ip dhcp-server add name="pfi-pilot-dhcp" interface="pfi-pilot-br" address-pool="pfi-pilot-pool" lease-time=30m disabled=yes',
    ':put ("PamoFi pilot bridge disabled: " . [/interface bridge get [find where name="pfi-pilot-br"] disabled])',
    ':put ("PamoFi pilot Wi-Fi disabled: " . [/interface wireless get [find where name="pfi-pilot-wifi"] disabled])',
    ':put ("PamoFi pilot DHCP disabled: " . [/ip dhcp-server get [find where name="pfi-pilot-dhcp"] disabled])',
    ':put ("PamoFi pilot gateway count: " . [:len [/ip address find where interface="pfi-pilot-br" and address="10.77.10.1/24"]])',
    '# Bridge, radio and DHCP remain disabled. No DNS override, NAT, RADIUS or hotspot is added.',
    '}', '',
  ].join('\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [target,extra]=process.argv.slice(2);
  if(!target||extra){console.error('Usage: node network-plan.mjs /absolute/new-review.rsc');process.exitCode=1;}
  else writeFile(resolve(target),buildNetworkPlan(),{mode:0o600,flag:'wx'}).then(()=>console.log('Prepared disabled pilot network review; no router settings changed.')).catch(()=>{console.error('Could not write a new review file.');process.exitCode=1;});
}
