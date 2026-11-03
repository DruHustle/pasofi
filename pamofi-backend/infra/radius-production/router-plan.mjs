#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {lstat,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {privateIpv4} from '../remote-access/validation.mjs';

export function buildRouterPlan({site,serverIp,routerIp,secretHash}) {
  if(typeof site!=='string'||!/^[a-z0-9-]{1,20}$/.test(site))throw Error('Invalid site identifier');
  if(!privateIpv4(serverIp)||!privateIpv4(routerIp)||serverIp===routerIp)throw Error('Distinct private tunnel addresses are required');
  if(typeof secretHash!=='string'||!/^[a-f0-9]{128}$/.test(secretHash))throw Error('A SHA-512 digest is required');
  const file=`pfi-radius-${site}.secret`, comment=`PamoFi site: radius ${site}`;
  return ['{',
    '# REVIEW ONLY: creates one disabled RADIUS client; no hotspot or customer access.',
    ':if ([:len [/interface wireguard find where name="pamofi-service" and disabled=no]] != 1) do={ :error "Expected enabled PamoFi service interface" }',
    `:if ([:len [/ip address find where interface="pamofi-service" and address="${routerIp}/32"]] != 1) do={ :error "Unexpected router tunnel address" }`,
    ':if ([:len [/radius find]] != 0) do={ :error "Existing RADIUS configuration requires review" }',
    `:if ([:len [/file find where name="${file}"]] != 1) do={ :error "Expected protected RADIUS secret file" }`,
    `:local radiusSecret [/file get "${file}" contents]`,
    ':if (([:len $radiusSecret] = 65) && ([:pick $radiusSecret 64 65] = "\\n")) do={ :set radiusSecret [:pick $radiusSecret 0 64] }',
    ':if ([:len $radiusSecret] != 64) do={ :error "Invalid RADIUS secret length" }',
    `:if ([:convert $radiusSecret transform=sha512 to=hex] != "${secretHash}") do={ :error "RADIUS secret checksum mismatch" }`,
    `/radius add service=hotspot protocol=udp address=${serverIp} src-address=${routerIp} authentication-port=1812 accounting-port=1813 require-message-auth=yes-for-request-resp timeout=3s secret=$radiusSecret disabled=yes comment="${comment}"`,
    '# Keep disabled until the controlled test and remove the uploaded secret file after verification.',
    '}', '',
  ].join('\n');
}
async function main(){
  const [site,serverIp,routerIp,secretFile,target,extra]=process.argv.slice(2);
  if(!site||!serverIp||!routerIp||!secretFile||!target||extra)throw Error('Usage: node router-plan.mjs site server-ip router-ip protected-secret-file new-review.rsc');
  const st=await lstat(secretFile);
  if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0)throw Error('Secret must be a private regular file');
  let secret=await readFile(secretFile);
  if(secret.length===65&&secret[64]===10)secret=secret.subarray(0,64);
  if(!/^[a-f0-9]{64}$/.test(secret.toString('ascii'))||secret.length!==64)throw Error('Secret must be 64 lowercase hexadecimal bytes with an optional final newline');
  const secretHash=createHash('sha512').update(secret).digest('hex');
  await writeFile(resolve(target),buildRouterPlan({site,serverIp,routerIp,secretHash}),{mode:0o600,flag:'wx'});
  console.log('Prepared disabled router RADIUS review; no router settings changed.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
