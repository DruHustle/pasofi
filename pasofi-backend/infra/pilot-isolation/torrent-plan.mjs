#!/usr/bin/env node
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// A small, guest-scoped best-effort policy. It is not traffic identification.
export function buildTorrentPlan(){
  const menu='/ip firewall filter';
  const forwards=`[${menu} find where chain="forward"]`;
  const drop=protocol=>{
    const add=`${menu} add chain=forward action=drop in-interface="pfi-pilot-br" protocol=${protocol} dst-port=6881-6999,51413 comment="PamoFi torrent: common ${protocol} ports"`;
    return `:if ([:len ${forwards}] > 0) do={ ${add} place-before=(${forwards}->0) } else={ ${add} }`;
  };
  return ['{',
    '# REVIEW ONLY: best-effort common BitTorrent ports, scoped to the disabled guest bridge.',
    '# Other ports, encryption, VPNs and DNS bypass can evade these rules.',
    ':if ([:len [/interface bridge find where name="pfi-pilot-br"]] != 1 || [/interface bridge get [find where name="pfi-pilot-br"] disabled] != true) do={ :error "Pilot bridge must be disabled" }',
    ':if ([:len [/interface wireless find where name="pfi-pilot-wifi"]] != 1 || [/interface wireless get [find where name="pfi-pilot-wifi"] disabled] != true) do={ :error "Pilot Wi-Fi must be disabled" }',
    ':if ([:len [/ip firewall filter find where comment~"PamoFi torrent:"]] != 0) do={ :error "Existing torrent policy requires review" }',
    ...['/ip firewall filter','/ipv6 firewall filter'].map(f=>`:if ([:len [${f} find where chain="forward" and in-interface="pfi-pilot-br" and action=drop and comment~"PamoFi pilot: forward in\\$"]] != 1) do={ :error "Expected pilot isolation rule missing" }`),
    ...['/ip firewall filter','/ipv6 firewall filter'].map(f=>`:foreach pfiRule in=[${f} find where chain="forward" and in-interface="pfi-pilot-br" and action=drop and comment~"PamoFi pilot: forward in\\$"] do={ :if ([${f} get $pfiRule disabled] = true) do={ :error "Pilot isolation rule is disabled" } }`),
    drop('tcp'),drop('udp'),
    ':put ("PamoFi torrent rules: " . [:len [/ip firewall filter find where comment~"PamoFi torrent:" and action=drop]])',
    ':put ("PamoFi pilot Wi-Fi disabled: " . [/interface wireless get [find where name="pfi-pilot-wifi"] disabled])',
    '# No radio, hotspot, customer access or global DNS configuration is enabled.',
    '}', '',
  ].join('\n');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [target,extra]=process.argv.slice(2);
  if(!target||extra){console.error('Usage: node torrent-plan.mjs /absolute/new-review.rsc');process.exitCode=1;}
  else writeFile(resolve(target),buildTorrentPlan(),{mode:0o600,flag:'wx'}).then(()=>console.log('Prepared guest torrent-port review; no router settings changed.')).catch(()=>{console.error('Could not write a new review file.');process.exitCode=1;});
}
