#!/usr/bin/env node
import {mkdir, readFile, writeFile, chmod, realpath, lstat} from 'node:fs/promises';
import {randomBytes, X509Certificate} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {dirname, basename, isAbsolute, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {object, privateIpv4, hostname} from '../remote-access/validation.mjs';

const run=promisify(execFile), here=dirname(fileURLToPath(import.meta.url));
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validateRegistry(value) {
  object(value,['serverTunnelIp','nases'],'RADIUS registry');
  if(!privateIpv4(value.serverTunnelIp))throw Error('A private Oracle WireGuard IPv4 address is required');
  if(!Array.isArray(value.nases)||value.nases.length<1||value.nases.length>100)throw Error('Provide 1–100 explicitly identified NASes');
  const names=new Set(),ids=new Set(),ips=new Set();
  for(const nas of value.nases){
    object(nas,['nasId','siteId','clientName','siteName','routerTunnelIp','loginUrl'],'NAS registration');
    if(typeof nas.nasId!=='string'||typeof nas.siteId!=='string'||!uuid.test(nas.nasId)||!uuid.test(nas.siteId))throw Error('NAS and site identifiers must be canonical lowercase UUIDs');
    if(typeof nas.clientName!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(nas.clientName))throw Error('Invalid RADIUS client shortname');
    if(!privateIpv4(nas.routerTunnelIp)||nas.routerTunnelIp===value.serverTunnelIp)throw Error('Each NAS needs its own private WireGuard IPv4 address');
    if(typeof nas.siteName!=='string'||nas.siteName.length<1||nas.siteName.length>100||/[\x00-\x1f\x7f]/.test(nas.siteName))throw Error('Invalid site display name');
    let url;try{url=new URL(nas.loginUrl);}catch{throw Error('Invalid HotSpot HTTPS login URL');}
    if(typeof nas.loginUrl!=='string'||url.protocol!=='https:'||!hostname(url.hostname)||url.username||url.password||url.port||url.pathname!=='/login'||url.search||url.hash||url.toString()!==nas.loginUrl)throw Error('Use the exact selected HTTPS HotSpot hostname and /login path');
    if(names.has(nas.clientName)||ids.has(nas.nasId)||ips.has(nas.routerTunnelIp))throw Error('NAS names, identifiers and tunnel addresses must be distinct');
    names.add(nas.clientName);ids.add(nas.nasId);ips.add(nas.routerTunnelIp);
  }
  return value;
}
export function renderClients(registry,secrets) {
  validateRegistry(registry);
  return registry.nases.map(nas=>{
    const secret=secrets[nas.clientName];if(typeof secret!=='string'||!/^[a-f0-9]{64}$/.test(secret))throw Error('Each NAS needs an independent 32-byte hexadecimal secret');
    return `client ${nas.clientName} {\n ipaddr = ${nas.routerTunnelIp}/32\n secret = ${secret}\n shortname = ${nas.clientName}\n require_message_authenticator = yes\n limit_proxy_state = yes\n}\n`;
  }).join('\n');
}
function sqlString(value){return `'${value.replaceAll("'","''")}'`;}
export function registrationSql(registry){
  validateRegistry(registry);
  return ['-- REVIEW ONLY. Run using the NETWORK migration owner, never a runtime role.',
    '-- NASes remain disabled. A controlled physical acceptance and matching prepaid site are required before enabling.',
    'BEGIN;',...registry.nases.map(n=>`INSERT INTO radius_nas (id,site_id,client_name,site_name,login_url,enabled) VALUES (${[n.nasId,n.siteId,n.clientName,n.siteName,n.loginUrl].map(sqlString).join(',')},false);`),'COMMIT;',''].join('\n');
}
export async function prepare(registry,target){
  validateRegistry(registry);
  if(!isAbsolute(target))throw Error('Use an absolute new protected directory');
  const repo=await realpath(join(here,'../../..'));
  const directory=join(await realpath(dirname(resolve(target))),basename(resolve(target)));
  if(directory===repo||directory.startsWith(repo+'/'))throw Error('Keep RADIUS private material outside the repository');
  await mkdir(directory,{mode:0o700});
  if((await lstat(directory)).mode&0o077)throw Error('The material directory must be private');
  const put=async(name,value,mode=0o444)=>{const file=join(directory,name);await writeFile(file,value,{mode,flag:'wx'});await chmod(file,mode);};
  const secrets=Object.create(null);
  for(const nas of registry.nases){secrets[nas.clientName]=randomBytes(32).toString('hex');await put(`nas-${nas.clientName}.secret`,secrets[nas.clientName]+'\n',0o600);}
  await put('clients.conf',renderClients(registry,secrets));
  await put('radius_bind_ip',registry.serverTunnelIp+'\n');
  await put('nas-registration.sql.review',registrationSql(registry),0o600);
  await put('registry.json',JSON.stringify(registry,null,2)+'\n',0o600);
  // Signing keys stay in this private host directory. Containers mount only
  // the individual files they need, never the directory or CA private key.
  const openssl=async args=>{await run('openssl',args,{cwd:directory,timeout:30000,maxBuffer:65536});};
  await openssl(['req','-x509','-newkey','rsa:2048','-nodes','-keyout','radius_ca_key','-out','radius_ca','-days','90','-subj','/CN=PamoFi private RADIUS transport']);
  await chmod(join(directory,'radius_ca_key'),0o600);
  for(const kind of ['server','client']){
    await openssl(['req','-newkey','rsa:2048','-nodes','-keyout',`radius_${kind}_key`,'-out',`${kind}.csr`,'-subj',`/CN=${kind==='server'?'radius-api':'pamofi-freeradius'}`]);
    await put(`${kind}.ext`,kind==='server'?'subjectAltName=DNS:radius-api\nextendedKeyUsage=serverAuth\n':'extendedKeyUsage=clientAuth\n',0o600);
    await openssl(['x509','-req','-in',`${kind}.csr`,'-CA','radius_ca','-CAkey','radius_ca_key','-CAcreateserial','-out',`radius_${kind}_cert`,'-days','90','-extfile',`${kind}.ext`]);
    await chmod(join(directory,`radius_${kind}_key`),0o444);await chmod(join(directory,`radius_${kind}_cert`),0o444);
  }
  await chmod(join(directory,'radius_ca'),0o444);
  const certificate=new X509Certificate(await readFile(join(directory,'radius_client_cert')));
  await put('radius_client_fingerprint',certificate.fingerprint256.replaceAll(':','').toLowerCase()+'\n');
  await put('review.json',JSON.stringify({status:'prepared-only',nases:registry.nases.map(n=>({nasId:n.nasId,clientName:n.clientName,tunnelAddress:n.routerTunnelIp})),bindAddress:registry.serverTunnelIp,certificateValidTo:certificate.validTo,privateSigningKeyMounted:false,checks:['Keep this host directory mode0700; mount each listed runtime file individually. NAS secrets and the CA signing key stay0600.','Internal certificates expire in90days. Arrange monitored expiry and an explicit certificate/fingerprint rotation before activation.','Inspect the actual Oracle WG interface/address and Docker DNAT source preservation. Never publish RADIUS on a public or wildcard host address.','Review NAS/site identities and HTTPS login hosts; apply the SQL through the network owner only. Registry entries remain disabled.','Provide the existing production network_runtime_url, internal_network_secret and internal_ca. No database or live NAS was changed.','Do not set PAMOFI_RADIUS_QUALIFIED or enable customer network until the controlled acceptance plan and runtime material have been reviewed.']},null,2)+'\n',0o600);
  return directory;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [source,target,confirmation,extra]=process.argv.slice(2);
  Promise.resolve().then(async()=>{if(!source||!target||confirmation!=='--new-install-only'||extra)throw Error('Use registry.json /absolute/new/private-directory --new-install-only');const raw=await readFile(source,'utf8');if(Buffer.byteLength(raw)>65536)throw Error('Registry exceeds64KiB');await prepare(JSON.parse(raw),target);console.log('Prepared protected RADIUS material and disabled NAS registration for review. No live service was enabled; no secret values were printed.');}).catch(()=>{console.error('RADIUS preparation failed or refused. Use a new absolute private directory outside the repository; retain any partial output for inspection and never overwrite live material.');process.exitCode=1;});
}
