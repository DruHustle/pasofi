#!/usr/bin/env node
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isIP} from 'node:net';

// Offline, public-configuration-only generator. It does not create keys, contact
// a router/provider, change firewall rules, or enable remote access.
const [input,output]=process.argv.slice(2);
if(!input||!output)throw Error('Usage: node plan.mjs public-plan.json output-directory');
const p=JSON.parse(await readFile(input,'utf8'));
const fields=['serverPublicKey','routerPublicKey','serverHost','port','serverTunnelIp','routerTunnelIp','adminIdentity'];
if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(name=>!fields.includes(name)))throw Error('Only the documented public configuration fields are accepted; never provide private keys');
const privateIp=value=>{const bytes=value.split('.').map(Number);return bytes[0]===10||(bytes[0]===172&&bytes[1]>=16&&bytes[1]<=31)||(bytes[0]===192&&bytes[1]===168);};
const key=value=>typeof value==='string'&&/^[A-Za-z0-9+/]{43}=$/.test(value)&&Buffer.from(value,'base64').length===32;
if(!key(p.serverPublicKey)||!key(p.routerPublicKey)||p.serverPublicKey===p.routerPublicKey)throw Error('Distinct real server/router WireGuard public keys are required');
const validHostname=value=>typeof value==='string'&&value.length<=253&&value.includes('.')&&value.split('.').every(label=>/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))&&!/\.(invalid|local|localhost|internal)$/i.test(value);
if(typeof p.serverHost!=='string'||(!isIP(p.serverHost)&&!validHostname(p.serverHost)))throw Error('A selected public server hostname/IP is required');
if(isIP(p.serverHost)) {
 const [a,b,c]=p.serverHost.split('.').map(Number);
 if(isIP(p.serverHost)!==4||privateIp(p.serverHost)||a===0||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===192&&b===0&&(c===0||c===2))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113))throw Error('The selected hub must be publicly reachable');
}
if(!Number.isInteger(p.port)||p.port<1024||p.port>65535)throw Error('Choose a nonprivileged UDP listen port');
for(const field of ['serverTunnelIp','routerTunnelIp'])if(isIP(p[field])!==4||!privateIp(p[field]))throw Error('Explicit non-overlapping private IPv4 tunnel addresses are required');
if(p.serverTunnelIp===p.routerTunnelIp)throw Error('Tunnel addresses must be distinct');
if(typeof p.adminIdentity!=='string'||p.adminIdentity.length>160||!/^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/.test(p.adminIdentity)||!validHostname(p.adminIdentity.split('@')[1]))throw Error('Use the verified Tailscale admin identity');
const target=resolve(output);await mkdir(target,{mode:0o700});
const server=`[Interface]\nAddress = ${p.serverTunnelIp}/32\nListenPort = ${p.port}\n# The private key is generated and retained on the selected server.\nPrivateKey = REPLACE_ON_SERVER_ONLY\n\n[Peer]\nPublicKey = ${p.routerPublicKey}\nAllowedIPs = ${p.routerTunnelIp}/32\n`;
const router=`# Review existing routes/firewall and save an off-device backup before applying.\n# No private key is imported: RouterOS creates and retains its own key.\n# The public key must equal the inspected routerPublicKey in public-plan.json.\n:if ([:len [/interface wireguard find where name="pamofi-management"]] = 0) do={ :error "Create the approved WireGuard interface first, then regenerate this plan with its public key" }\n:if ([/interface wireguard get [find where name="pamofi-management"] public-key] != "${p.routerPublicKey}") do={ :error "Router public key does not match this reviewed plan" }\n/ip address add address=${p.routerTunnelIp}/32 interface=pamofi-management comment="PamoFi private remote management"\n/interface wireguard peers add interface=pamofi-management public-key="${p.serverPublicKey}" endpoint-address="${p.serverHost}" endpoint-port=${p.port} allowed-address=${p.serverTunnelIp}/32 persistent-keepalive=25s comment="PamoFi management hub"\n/ip route add dst-address=${p.serverTunnelIp}/32 gateway=pamofi-management comment="PamoFi management hub route"\n# Place the following exact rules before the default non-LAN input drop.\n# Do not paste without confirming the actual rule ordering on this router.\n/ip firewall filter add chain=input action=accept in-interface=pamofi-management src-address=${p.serverTunnelIp}/32 dst-address=${p.routerTunnelIp}/32 protocol=tcp dst-port=80,443,8291 comment="PamoFi management only"\n/ip firewall filter add chain=input action=accept in-interface=pamofi-management src-address=${p.serverTunnelIp}/32 dst-address=${p.routerTunnelIp}/32 protocol=icmp comment="PamoFi management diagnostics"\n/ip firewall filter add chain=forward action=drop in-interface=pamofi-management comment="PamoFi no remote LAN forwarding"\n`;
const policy={grants:[{src:[p.adminIdentity],dst:[`${p.routerTunnelIp}/32`],ip:['tcp:80','tcp:443','tcp:8291']}],tests:[{src:p.adminIdentity,accept:[`${p.routerTunnelIp}:80`,`${p.routerTunnelIp}:443`,`${p.routerTunnelIp}:8291`],deny:[`${p.routerTunnelIp}:22`,`${p.routerTunnelIp}:8728`]}]};
await writeFile(resolve(target,'server-wireguard.conf.review'),server,{mode:0o600,flag:'wx'});
await writeFile(resolve(target,'router-management.rsc.review'),router,{mode:0o600,flag:'wx'});
await writeFile(resolve(target,'tailscale-policy-fragment.json'),JSON.stringify(policy,null,2)+'\n',{mode:0o600,flag:'wx'});
await writeFile(resolve(target,'route-command.txt'),`sudo tailscale set --advertise-routes=${p.routerTunnelIp}/32\n`,{mode:0o600,flag:'wx'});
console.log('Prepared public configuration for review. No remote access has been enabled.');
