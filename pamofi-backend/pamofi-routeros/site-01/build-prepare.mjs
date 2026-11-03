#!/usr/bin/env node
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildHotspotPlan} from '../../infra/pilot-isolation/hotspot-plan.mjs';
import {buildTorrentPlan} from '../../infra/pilot-isolation/torrent-plan.mjs';

// One preparation file for the already-inspected Kuwadzana router. It never
// creates a production sale or enables the guest network or RADIUS client.
export function buildKuwadzanaScript(){
  const cert='pamofi-hotspot-onesaeu.p12_0', nas='PamoFi site: radius site01';
  const hotspotAdds=buildHotspotPlan().split('\n').filter(line=>line.startsWith('/ip hotspot profile add ')||line.startsWith('/ip hotspot add '));
  const torrentAdds=buildTorrentPlan().split('\n').filter(line=>line.includes('PamoFi torrent: common ') && line.startsWith(':if '));
  if(hotspotAdds.length!==2||torrentAdds.length!==2)throw Error('Preparation components changed; review before rebuilding the combined file');
  return ['{',
    '# KUWADZANA PREPARATION ONLY: use Safe Mode and keep an off-device backup.',
    '# This is not a service activation or a physical acceptance test.',
    ':if ([:len [/interface wireguard find where name="pamofi-service"]] != 1 || [/interface wireguard get [find where name="pamofi-service"] disabled] != false) do={ :error "Expected enabled site service tunnel" }',
    ':if ([/interface wireguard get [find where name="pamofi-service"] public-key] != "AMJXVTVrpj0512Eoj5A6DWNAnjySBPF3VmzODGeN/FE=") do={ :error "This is not the reviewed Kuwadzana router" }',
    ':if ([:len [/ip address find where interface="pamofi-service" and address="10.77.254.2/32"]] != 1) do={ :error "Site tunnel address differs" }',
    ':if ([:len [/interface bridge find where name="pfi-pilot-br"]] != 1 || [/interface bridge get [find where name="pfi-pilot-br"] disabled] != true) do={ :error "Pilot bridge must be disabled" }',
    ':if ([:len [/interface wireless find where name="pfi-pilot-wifi"]] != 1 || [/interface wireless get [find where name="pfi-pilot-wifi"] disabled] != true) do={ :error "Pilot Wi-Fi must be disabled" }',
    ':if ([:len [/interface bridge port find where bridge="pfi-pilot-br"]] != 1 || [:len [/interface bridge port find where bridge="pfi-pilot-br" and interface="pfi-pilot-wifi"]] != 1) do={ :error "Pilot bridge membership differs" }',
    ':if ([/interface wireless get [find where name="pfi-pilot-wifi"] default-forwarding] != false || [/interface wireless get [find where name="pfi-pilot-wifi"] wps-mode] != "disabled") do={ :error "Pilot wireless isolation settings differ" }',
    ':if ([:len [/ip address find where interface="pfi-pilot-br" and address="10.77.10.1/24"]] != 1) do={ :error "Expected prepared pilot gateway missing" }',
    ':if ([:len [/ip dhcp-server find where name="pfi-pilot-dhcp"]] != 1 || [/ip dhcp-server get [find where name="pfi-pilot-dhcp"] disabled] != true) do={ :error "Pilot DHCP must be disabled" }',
    ':if ([:tostr [/ip dhcp-server get [find where name="pfi-pilot-dhcp"] interface]] != "pfi-pilot-br" || [:tostr [/ip dhcp-server get [find where name="pfi-pilot-dhcp"] address-pool]] != "pfi-pilot-pool") do={ :error "Pilot DHCP interface or pool differs" }',
    ':if ([:len [/ip pool find where name="pfi-pilot-pool"]] != 1 || [:tostr [/ip pool get [find where name="pfi-pilot-pool"] ranges]] != "10.77.10.10-10.77.10.200") do={ :error "Pilot address pool differs" }',
    `:if ([:len [/radius find]] != 1 || [:len [/radius find where comment="${nas}"]] != 1 || [/radius get [find where comment="${nas}"] disabled] != true) do={ :error "Site RADIUS client must be the only client and disabled" }`,
    `:if ([/radius get [find where comment="${nas}"] address] != 10.77.254.1 || [/radius get [find where comment="${nas}"] src-address] != 10.77.254.2 || [/radius get [find where comment="${nas}"] require-message-auth] != "yes-for-request-resp") do={ :error "Site RADIUS settings differ" }`,
    `:if ([:tostr [/radius get [find where comment="${nas}"] service]] != "hotspot" || [/radius get [find where comment="${nas}"] authentication-port] != 1812 || [/radius get [find where comment="${nas}"] accounting-port] != 1813) do={ :error "Site RADIUS service or ports differ" }`,
    `:if ([:len [/certificate find where name="${cert}"]] != 1 || [/certificate get [find where name="${cert}"] trusted] != true || [/certificate get [find where name="${cert}"] fingerprint] != "985a06a8afa387bdad5b174bc88dbe592902f0b7fb01e1a1897a18fe46ef1551") do={ :error "Expected reviewed hotspot certificate missing or changed" }`,
    ':if ([:len [/ip hotspot user find where name!="default-trial"]] != 0) do={ :error "Existing local hotspot users require review" }',
    ':foreach pfiUser in=[/ip hotspot user find] do={ :if ([/ip hotspot user get $pfiUser default] != true) do={ :error "Unexpected non-default hotspot user" } }',
    ...['/ip firewall filter','/ipv6 firewall filter'].flatMap(menu=>[
      `:if ([:len [${menu} find where comment~"PamoFi pilot:" and action=drop]] != 4) do={ :error "Expected four pilot deny rules per IP family" }`,
      ...[['input','in'],['output','out'],['forward','in'],['forward','out']].map(([chain,direction])=>`:if ([:len [${menu} find where chain="${chain}" and ${direction}-interface="pfi-pilot-br" and action=drop and comment~"PamoFi pilot: ${chain} ${direction}\\$"]] != 1) do={ :error "Unexpected pilot deny rule" }`),
      `:foreach pfiRule in=[${menu} find where comment~"PamoFi pilot:" and action=drop] do={ :if ([${menu} get $pfiRule disabled] = true) do={ :error "Pilot deny rule is disabled" } }`,
    ]),
    ':local pfiHotspotCount [:len [/ip hotspot find where name="pfi-pilot-hotspot"]]',
    ':local pfiProfileCount [:len [/ip hotspot profile find where name="pfi-pilot-https"]]',
    ':if ($pfiHotspotCount != $pfiProfileCount || $pfiHotspotCount > 1) do={ :error "Partial hotspot state requires review" }',
    ':if ($pfiHotspotCount = 0 && ([:len [/ip hotspot find]] != 0 || [:len [/ip dns static find where name="hotspot.pamofi.onesa.eu"]] != 0)) do={ :error "Existing hotspot or DNS state requires review" }',
    ':if ($pfiHotspotCount = 1) do={',
    '  :if ([:len [/ip hotspot find]] != 1 || [/ip hotspot get [find where name="pfi-pilot-hotspot"] disabled] != true || [:tostr [/ip hotspot get [find where name="pfi-pilot-hotspot"] interface]] != "pfi-pilot-br" || [:tostr [/ip hotspot get [find where name="pfi-pilot-hotspot"] profile]] != "pfi-pilot-https") do={ :error "Existing hotspot state differs" }',
    `  :if ([:tostr [/ip hotspot profile get [find where name="pfi-pilot-https"] login-by]] != "https" || [/ip hotspot profile get [find where name="pfi-pilot-https"] use-radius] != true || [/ip hotspot profile get [find where name="pfi-pilot-https"] radius-accounting] != true || [:tostr [/ip hotspot profile get [find where name="pfi-pilot-https"] ssl-certificate]] != "${cert}" || [/ip hotspot profile get [find where name="pfi-pilot-https"] dns-name] != "hotspot.pamofi.onesa.eu") do={ :error "Existing HTTPS hotspot profile differs" }`,
    '}',
    ':local pfiTorrentCount [:len [/ip firewall filter find where comment~"PamoFi torrent:"]]',
    ':if ($pfiTorrentCount != 0 && $pfiTorrentCount != 2) do={ :error "Partial torrent policy requires review" }',
    ':if ($pfiTorrentCount = 2) do={',
    ...['tcp','udp'].flatMap(protocol=>[
      `  :local pfi${protocol.toUpperCase()} [/ip firewall filter find where comment~"PamoFi torrent: common ${protocol} ports\\$"]`,
      `  :if ([:len $pfi${protocol.toUpperCase()}] != 1) do={ :error "Torrent ${protocol} rule differs" }`,
      `  :set pfi${protocol.toUpperCase()} ($pfi${protocol.toUpperCase()}->0)`,
      `  :if ([/ip firewall filter get $pfi${protocol.toUpperCase()} disabled] = true || [:tostr [/ip firewall filter get $pfi${protocol.toUpperCase()} action]] != "drop" || [:tostr [/ip firewall filter get $pfi${protocol.toUpperCase()} chain]] != "forward" || [:tostr [/ip firewall filter get $pfi${protocol.toUpperCase()} in-interface]] != "pfi-pilot-br" || [:tostr [/ip firewall filter get $pfi${protocol.toUpperCase()} protocol]] != "${protocol}") do={ :error "Torrent ${protocol} rule settings differ" }`,
      `  :local pfi${protocol.toUpperCase()}Ports [:tostr [/ip firewall filter get $pfi${protocol.toUpperCase()} dst-port]]`,
      `  :if ($pfi${protocol.toUpperCase()}Ports != "6881-6999,51413" && $pfi${protocol.toUpperCase()}Ports != "51413,6881-6999") do={ :error "Torrent ${protocol} ports differ" }`,
    ]),
    '}',
    ':if ($pfiHotspotCount = 0) do={', ...hotspotAdds, '}',
    ':if ($pfiTorrentCount = 0) do={', ...torrentAdds, '}',
    ':put ("Kuwadzana hotspot disabled: " . [/ip hotspot get [find where name="pfi-pilot-hotspot"] disabled])',
    ':put ("Kuwadzana Wi-Fi disabled: " . [/interface wireless get [find where name="pfi-pilot-wifi"] disabled])',
    ':put ("Kuwadzana DHCP disabled: " . [/ip dhcp-server get [find where name="pfi-pilot-dhcp"] disabled])',
    `:put ("Kuwadzana RADIUS disabled: " . [/radius get [find where comment="${nas}"] disabled])`,
    ':put ("Kuwadzana torrent rules: " . [:len [/ip firewall filter find where comment~"PamoFi torrent:"]])',
    ':put "Customer service is not enabled: complete controlled physical acceptance and operations first."',
    '}', '',
  ].join('\n');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [target,extra]=process.argv.slice(2);
  if(!target||extra){console.error('Usage: node build-prepare.mjs /absolute/new-file.rsc');process.exitCode=1;}
  else writeFile(resolve(target),buildKuwadzanaScript(),{mode:0o600,flag:'wx'}).then(()=>console.log('Prepared Kuwadzana router file; no router settings changed.')).catch(()=>{console.error('Could not write a new router file.');process.exitCode=1;});
}
