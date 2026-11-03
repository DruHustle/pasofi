#!/usr/bin/env node
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Prepares only the inspected first router. The hotspot and guest radio stay off.
export function buildHotspotPlan(){
  const radiusComment='PamoFi site: radius site01';
  const cert='pamofi-hotspot-onesaeu.p12_0';
  return ['{',
    '# REVIEW ONLY: disabled HTTPS hotspot. The DNS name may add a router-wide static DNS entry.',
    ':if ([:len [/interface bridge find where name="pfi-pilot-br"]] != 1 || [/interface bridge get [find where name="pfi-pilot-br"] disabled] != true) do={ :error "Pilot bridge must be disabled" }',
    ':if ([:len [/interface wireless find where name="pfi-pilot-wifi"]] != 1 || [/interface wireless get [find where name="pfi-pilot-wifi"] disabled] != true) do={ :error "Pilot Wi-Fi must be disabled" }',
    ':if ([:len [/ip address find where interface="pfi-pilot-br" and address="10.77.10.1/24"]] != 1) do={ :error "Expected pilot gateway missing" }',
    ':if ([:len [/ip dhcp-server find where name="pfi-pilot-dhcp"]] != 1 || [/ip dhcp-server get [find where name="pfi-pilot-dhcp"] disabled] != true) do={ :error "Pilot DHCP must be disabled" }',
    `:if ([:len [/radius find where comment="${radiusComment}"]] != 1 || [/radius get [find where comment="${radiusComment}"] disabled] != true) do={ :error "Expected disabled site RADIUS client" }`,
    `:if ([/radius get [find where comment="${radiusComment}"] address] != 10.77.254.1 || [/radius get [find where comment="${radiusComment}"] src-address] != 10.77.254.2) do={ :error "RADIUS tunnel endpoints differ" }`,
    `:if ([:tostr [/radius get [find where comment="${radiusComment}"] service]] != "hotspot" || [/radius get [find where comment="${radiusComment}"] require-message-auth] != "yes-for-request-resp") do={ :error "RADIUS service settings differ" }`,
    `:if ([:len [/certificate find where name="${cert}"]] != 1 || [/certificate get [find where name="${cert}"] trusted] != true) do={ :error "Expected trusted hotspot certificate missing" }`,
    `:if ([/certificate get [find where name="${cert}"] fingerprint] != "985a06a8afa387bdad5b174bc88dbe592902f0b7fb01e1a1897a18fe46ef1551") do={ :error "Hotspot certificate fingerprint differs" }`,
    ':if ([:len [/ip hotspot find]] != 0) do={ :error "Existing hotspot requires review" }',
    ':if ([:len [/ip hotspot user find]] != 0) do={ :error "Existing local hotspot users require review" }',
    ':if ([:len [/ip hotspot profile find where name="pfi-pilot-https"]] != 0) do={ :error "Pilot hotspot profile already exists" }',
    ':if ([:len [/ip dns static find where name="hotspot.pamofi.onesa.eu"]] != 0) do={ :error "Existing hotspot DNS entry requires review" }',
    ...['/ip firewall filter','/ipv6 firewall filter'].flatMap(menu=>[
      `:if ([:len [${menu} find where comment~"PamoFi pilot:" and action=drop]] != 4) do={ :error "Expected four pilot deny rules per IP family" }`,
      ...[['input','in'],['output','out'],['forward','in'],['forward','out']].map(([chain,direction])=>`:if ([:len [${menu} find where chain="${chain}" and ${direction}-interface="pfi-pilot-br" and action=drop and comment~"PamoFi pilot: ${chain} ${direction}\\$"]] != 1) do={ :error "Unexpected pilot deny rule" }`),
      `:foreach pfiRule in=[${menu} find where comment~"PamoFi pilot:" and action=drop] do={ :if ([${menu} get $pfiRule disabled] = true) do={ :error "Pilot deny rule is disabled" } }`,
    ]),
    `/ip hotspot profile add name="pfi-pilot-https" hotspot-address=10.77.10.1 dns-name="hotspot.pamofi.onesa.eu" login-by=https ssl-certificate="${cert}" use-radius=yes radius-accounting=yes radius-interim-update=1m`,
    '/ip hotspot add name="pfi-pilot-hotspot" interface="pfi-pilot-br" address-pool=none profile="pfi-pilot-https" disabled=yes',
    ':put ("PamoFi hotspot disabled: " . [/ip hotspot get [find where name="pfi-pilot-hotspot"] disabled])',
    ':put ("PamoFi hotspot login: " . [/ip hotspot profile get [find where name="pfi-pilot-https"] login-by])',
    ':put ("PamoFi hotspot RADIUS: " . [/ip hotspot profile get [find where name="pfi-pilot-https"] use-radius])',
    ':put ("PamoFi pilot Wi-Fi disabled: " . [/interface wireless get [find where name="pfi-pilot-wifi"] disabled])',
    '# No guest traffic, NAT, RADIUS activation, walled garden or customer sale is enabled.',
    '}', '',
  ].join('\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [target,extra]=process.argv.slice(2);
  if(!target||extra){console.error('Usage: node hotspot-plan.mjs /absolute/new-review.rsc');process.exitCode=1;}
  else writeFile(resolve(target),buildHotspotPlan(),{mode:0o600,flag:'wx'}).then(()=>console.log('Prepared disabled HTTPS hotspot review; no router settings changed.')).catch(()=>{console.error('Could not write a new review file.');process.exitCode=1;});
}
