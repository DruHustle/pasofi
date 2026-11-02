#!/usr/bin/env node
// Disposable production transport qualification. No remote Docker daemon,
// real host interface/firewall mutation, or connection to a real NAS.
import {mkdtemp,mkdir,readFile,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomInt,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {prepare} from './prepare.mjs';
import {ipv4Number} from '../remote-access/validation.mjs';

if(process.argv.length!==2)throw Error('Use run-lab.mjs without arguments');
const here=dirname(fileURLToPath(import.meta.url)),production=resolve(here,'../production');
const radiusImage='freeradius/freeradius-server:3.2.9-alpine@sha256:9e860a6d14ecbccc97448da1d0c5dd15b5e7e6b64777cea21b57e832187a2057';
const nodeImage='node:24.22.1-alpine',project='pamo-rad-'+randomUUID().slice(0,12);
const dockerEnvironment={...process.env,COMPOSE_DISABLE_ENV_FILE:'1'};
for(const name of ['COMPOSE_FILE','COMPOSE_PROFILES','COMPOSE_PROJECT_NAME','COMPOSE_ENV_FILES'])delete dockerEnvironment[name];
const ownedProcesses=new Set();
let directory,file,created=false,stage='local Docker validation',redactions=[],stopped=false,cleaning=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{stopped=true;for(const child of ownedProcesses)child.kill('SIGTERM');});
function run(command,args,{cwd=here,env=process.env,input='',timeout=120000,allowFailure=false}={}){
  if(stopped&&!cleaning)throw Error('Transport laboratory interrupted');
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe']});ownedProcesses.add(child);
    let stdout='',stderr='',bytes=0,error;
    const timer=setTimeout(()=>child.kill('SIGKILL'),timeout);
    for(const [name,stream]of [['stdout',child.stdout],['stderr',child.stderr]])stream.on('data',data=>{bytes+=data.length;if(bytes>4*1024*1024){child.kill('SIGKILL');return;}if(name==='stdout')stdout+=data;else stderr+=data;});
    child.once('error',value=>{error=value;});
    child.once('close',code=>{clearTimeout(timer);ownedProcesses.delete(child);if(!allowFailure&&(error||code!==0))reject(Error(`${command} failed (status ${error?.code||code}). ${stderr.slice(-1500)}`));else resolve({code,stdout,stderr});});
    child.stdin.on('error',()=>{});child.stdin.end(input);
  });
}
const docker=(args,options={})=>run('docker',args,{env:dockerEnvironment,...options});
const compose=(args,options={})=>docker(['compose','-p',project,'-f',file,...args],options);
async function requireRadiusRunning(){
  const names=['radius','radius-wrong-client','radius-wrong-ca'];
  const ids=(await compose(['ps','--all','--quiet',...names])).stdout.trim().split(/\s+/).filter(Boolean);
  if(ids.length!==names.length)throw Error('A RADIUS fixture container was not created');
  for(const state of JSON.parse((await docker(['inspect',...ids])).stdout)){
    if(state.State.Status!=='running'||state.State.Running!==true||state.RestartCount!==0){
      const name=state.Config.Labels['com.docker.compose.service'];
      throw Error(`${name} failed startup: status=${state.State.Status}, exit=${state.State.ExitCode}, restarts=${state.RestartCount}`);
    }
  }
}
async function unusedPrefixes(count){
  const ids=(await docker(['network','ls','-q'])).stdout.trim().split(/\s+/).filter(Boolean);
  const networks=ids.length?JSON.parse((await docker(['network','inspect',...ids])).stdout):[];
  const ranges=networks.flatMap(network=>(network.IPAM?.Config||[]).flatMap(config=>{
    const [address,bits]=String(config.Subnet||'').split('/');if(!/^\d+\.\d+\.\d+\.\d+$/.test(address)||!/^(?:[0-9]|[12][0-9]|3[0-2])$/.test(bits||''))return [];
    const size=2**(32-Number(bits)),lower=Math.floor(ipv4Number(address)/size)*size;return [[lower,lower+size-1]];
  }));
  const start=randomInt(15*256),selected=[];
  for(let offset=0;offset<15*256;offset++){
    const index=(start+offset)%(15*256),prefix=`10.${240+Math.floor(index/256)}.${index%256}`,lower=ipv4Number(prefix+'.0');
    if(ranges.every(([a,b])=>lower+255<a||lower>b)){selected.push(prefix);ranges.push([lower,lower+255]);if(selected.length===count)return selected;}
  }
  throw Error('No unused Docker lab networks found');
}
try{
  const endpoint=!process.env.DOCKER_CONTEXT&&process.env.DOCKER_HOST||JSON.parse((await docker(['context','inspect'])).stdout)[0]?.Endpoints?.docker?.Host;
  if(typeof endpoint!=='string'||!endpoint.startsWith('unix://'))throw Error('This disposable lab requires a local Unix-socket Docker daemon');
  const info=JSON.parse((await docker(['info','--format','{{json .}}'],{timeout:15000})).stdout);
  const engineMajor=Number(String(info.ServerVersion).split('.')[0]);
  if(info.OSType!=='linux'||!Number.isInteger(engineMajor)||engineMajor<28||(info.SecurityOptions||[]).some(value=>value.includes('rootless')))throw Error('The routing lab requires Linux Docker Engine 28+ in rootful mode (routed bridge and preserved NAS source)');
  directory=await mkdtemp(join(tmpdir(),project+'-'));file=join(directory,'compose.json');
  const [nasPrefix,ingressPrefix,transportPrefix,controlPrefix,servicesPrefix,databasePrefix]=await unusedPrefixes(6);
  const serverIp=nasPrefix+'.1',nasIp=nasPrefix+'.10',materials=join(directory,'material');
  stage='offline material preparation';
  await prepare({serverTunnelIp:serverIp,nases:[
    {nasId:randomUUID(),siteId:randomUUID(),clientName:'nas_a',siteName:'Disposable transport A',routerTunnelIp:nasIp,loginUrl:'https://login.example.com/login'},
    {nasId:randomUUID(),siteId:randomUUID(),clientName:'nas_b',siteName:'Disposable transport B',routerTunnelIp:nasPrefix+'.11',loginUrl:'https://login.example.com/login'},
  ]},materials);
  const secretA=(await readFile(join(materials,'nas-nas_a.secret'),'utf8')).trim(),secretB=(await readFile(join(materials,'nas-nas_b.secret'),'utf8')).trim();redactions=[secretA,secretB];
  await run('openssl',['req','-newkey','rsa:2048','-nodes','-keyout',join(materials,'wrong_client_key'),'-out',join(materials,'wrong_client.csr'),'-subj','/CN=wrong-lab-client']);
  await run('openssl',['x509','-req','-in',join(materials,'wrong_client.csr'),'-CA',join(materials,'radius_ca'),'-CAkey',join(materials,'radius_ca_key'),'-CAcreateserial','-out',join(materials,'wrong_client_cert'),'-days','1','-extfile',join(materials,'client.ext')]);
  await run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(materials,'wrong_ca_key'),'-out',join(materials,'wrong_ca'),'-days','1','-subj','/CN=wrong-lab-authority']);
  await writeFile(join(materials,'nas.ext'),`subjectAltName=IP:${nasIp}\nextendedKeyUsage=serverAuth\n`,{mode:0o600});
  await run('openssl',['req','-newkey','rsa:2048','-nodes','-keyout',join(materials,'nas_server_key'),'-out',join(materials,'nas_server.csr'),'-subj','/CN=disposable-nas']);
  await run('openssl',['x509','-req','-in',join(materials,'nas_server.csr'),'-CA',join(materials,'radius_ca'),'-CAkey',join(materials,'radius_ca_key'),'-CAcreateserial','-out',join(materials,'nas_server_cert'),'-days','1','-extfile',join(materials,'nas.ext')]);
  for(const name of ['wrong_client_key','wrong_client_cert','wrong_ca','nas_server_key','nas_server_cert'])await chmod(join(materials,name),0o444);
  const environment={...dockerEnvironment,PAMOFI_ROLE_PREFIX:'pamo_lab',PAMOFI_RADIUS_QUALIFIED:'true',PAMOFI_CUSTOMER_NETWORK_ENABLED:'false',PAMOFI_RADIUS_TUNNEL_IP:serverIp,PAMOFI_RADIUS_SECRETS_DIR:materials,PAMOFI_SECRETS_DIR:materials,PAMOFI_DATABASE_VOLUME:project+'-unused',PAMOFI_PUBLIC_HOST:'pamofi.test',PAMOFI_SERVICES_SUBNET:servicesPrefix+'.0/24',PAMOFI_COMMERCE_ENABLED:'false',PAMOFI_AGENT_COMMISSION_BPS:'0',VOUCHER_DELIVERY_ACTIVE_KEY_ID:'initial',RADIUS_CREDENTIAL_KEY_VERSION:'1'};
  for(const name of ['IDENTITY','PREPAID','NETWORK','NOTIFICATION','ASSISTANT','WEB'])environment[`PAMOFI_${name}_IMAGE`]=nodeImage;
  stage='actual production Compose rendering';
  const rendered=JSON.parse((await docker(['compose','-p',project,'-f',join(production,'compose.yaml'),'-f',join(here,'compose.yaml'),'--profile','radius-qualified','config','--format','json'],{env:environment})).stdout);
  const radius=rendered.services.radius;
  assert.equal(radius.image,radiusImage);assert.equal(rendered.services['radius-api'].ports?.length||0,0);
  assert.equal(rendered.services['radius-api'].environment.PAMOFI_ROLE_PREFIX,'pamo_lab');
  assert.deepEqual(radius.ports.map(port=>({ip:port.host_ip,target:port.target,published:port.published,protocol:port.protocol})).sort((a,b)=>a.target-b.target),[{ip:serverIp,target:1812,published:'1812',protocol:'udp'},{ip:serverIp,target:1813,published:'1813',protocol:'udp'}]);
  assert.equal(radius.environment.PAMOFI_RADIUS_QUALIFIED,'true');
  for(const svc of ['network','prepaid-access'])assert.equal(rendered.services[svc].environment.PAMOFI_CUSTOMER_NETWORK_ENABLED,'false');
  assert.equal(rendered.services.network.environment.NETWORK_RECONCILER_ENABLED,'false');
  assert.equal(rendered.networks.radius_transport.internal,true);
  assert.notEqual(rendered.networks.radius_ingress.internal,true);assert.notEqual(rendered.networks.router_control.internal,true);
  assert.deepEqual(Object.keys(radius.networks).sort(),['radius_ingress','radius_transport']);
  assert.deepEqual(Object.keys(rendered.services.network.networks).sort(),['database','router_control','services']);
  const secrets={};for(const name of ['radius_ca','radius_server_cert','radius_server_key','radius_client_fingerprint','radius_client_cert','radius_client_key','radius_bind_ip','wrong_client_cert','wrong_client_key','wrong_ca','nas_server_key','nas_server_cert'])secrets[name]={file:join(materials,name)};
  await mkdir(join(directory,'events'),{mode:0o700});
  const fixtureUser=`${process.getuid()}:${process.getgid()}`;
  const authority={image:nodeImage,user:fixtureUser,entrypoint:['node','/lab/authority.mjs'],read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],mem_limit:'96m',pids_limit:50,volumes:[`${join(here,'lab-authority.mjs')}:/lab/authority.mjs:ro`,`${join(directory,'events')}:/lab-events`],environment:{PAMOFI_RADIUS_TRANSPORT_LAB:'disposable-fixture'},secrets:['radius_ca','radius_server_cert','radius_server_key','radius_client_fingerprint'],networks:{radius_transport:{ipv4_address:transportPrefix+'.3'}},healthcheck:{test:['CMD','node','-e',"const s=require('node:net').connect(3443,'127.0.0.1');s.setTimeout(1000);s.once('connect',()=>process.exit(0));s.once('error',()=>process.exit(1));s.once('timeout',()=>process.exit(1))"],interval:'1s',timeout:'2s',retries:20}};
  const cloneRadius=(suffix,authPort,replacements={})=>{
    const value=structuredClone(radius);delete value.profiles;
    value.networks={radius_transport:{ipv4_address:transportPrefix+suffix},radius_ingress:{ipv4_address:ingressPrefix+suffix}};
    value.ports=value.ports.map(port=>({...port,published:String(authPort+port.target-1812)}));
    value.secrets=value.secrets.map(secret=>({...secret,source:replacements[secret.source]||secret.source}));
    value.depends_on={'radius-api':{condition:'service_healthy'}};return value;
  };
  const nas=ip=>({image:radiusImage,entrypoint:['/bin/sh','-c','sleep 36000'],cap_drop:['ALL'],security_opt:['no-new-privileges:true'],networks:{nas:{ipv4_address:ip}}});
  const router={image:nodeImage,entrypoint:['node','/lab/nas.mjs'],read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],mem_limit:'64m',pids_limit:30,volumes:[`${join(here,'lab-nas.mjs')}:/lab/nas.mjs:ro`],environment:{PAMOFI_RADIUS_TRANSPORT_LAB:'disposable-fixture',EXPECTED_CONTROL_SOURCE:serverIp},secrets:['nas_server_key','nas_server_cert'],networks:{nas:{ipv4_address:nasIp}},ports:[{target:443,protocol:'tcp',host_ip:'0.0.0.0'}]};
  const control={image:nodeImage,user:fixtureUser,entrypoint:['node','-e','setInterval(()=>{},10000)'],read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],secrets:['radius_ca','wrong_ca'],networks:{services:{},database:{},router_control:{}}};
  const bridge=(prefix,options={})=>({driver:'bridge',ipam:{config:[{subnet:prefix+'.0/24',gateway:prefix+'.1'}]},...options});
  const config={services:{'radius-api':authority,radius:cloneRadius('.2',1812),'radius-wrong-client':cloneRadius('.4',1814,{radius_client_cert:'wrong_client_cert',radius_client_key:'wrong_client_key'}),'radius-wrong-ca':cloneRadius('.5',1816,{radius_ca:'wrong_ca'}),'nas-a':router,'nas-a-packets':{...nas(nasIp),networks:undefined,network_mode:'service:nas-a'},'nas-b':nas(nasPrefix+'.11'),'nas-unknown':nas(nasPrefix+'.12'),control},networks:{
    // Routed NAS network preserves source /32 at host DNAT. Its published
    // TCP443 uses direct container routing, without a host TCP binding.
    nas:bridge(nasPrefix,{driver_opts:{'com.docker.network.bridge.gateway_mode_ipv4':'routed','com.docker.network.bridge.enable_ip_masquerade':'false'}}),
    radius_ingress:bridge(ingressPrefix),radius_transport:bridge(transportPrefix,{internal:true}),
    router_control:bridge(controlPrefix),services:bridge(servicesPrefix,{internal:true}),database:bridge(databasePrefix,{internal:true}),
  },secrets};
  await writeFile(file,JSON.stringify(config),{mode:0o600});
  stage='container startup';created=true;await compose(['up','-d'],{timeout:180000});
  await requireRadiusRunning();
  const containers=(await compose(['ps','-q'])).stdout.trim().split(/\s+/).filter(Boolean);
  for(const state of JSON.parse((await docker(['inspect',...containers])).stdout)){
    const name=state.Config.Labels['com.docker.compose.service'],bindings=state.HostConfig.PortBindings||{};
    for(const ports of Object.values(bindings))for(const port of ports||[]){
      if(name.startsWith('radius')&&name!=='radius-api')assert.equal(port.HostIp,serverIp);
      else assert.equal(port.HostPort,'',`${name} must not publish a host port`);
    }
  }
  const auth='User-Name = "fixture_user_123456"\nUser-Password = "fixture_password_32_characters_safe"\nAcct-Session-Id = "TRANSPORT-LAB"\nMessage-Authenticator = 0x00000000000000000000000000000000\n';
  const packet=(nasName,authPort,kind,secret,input)=>compose(['exec','-T',nasName==='nas-a'?'nas-a-packets':nasName,'/opt/bin/radclient','-x','-t','2','-r','1',`${serverIp}:${authPort+(kind==='auth'?0:1)}`,kind,secret],{input,timeout:10000,allowFailure:true});
  stage='published UDP authentication from off-bridge NAS';let accepted;
  for(let attempt=0;attempt<20;attempt++){
    await requireRadiusRunning();
    accepted=await packet('nas-a',1812,'auth',secretA,auth);
    if(accepted.stdout.includes('Received Access-Accept'))break;
    await new Promise(done=>setTimeout(done,500));
  }
  assert.match(accepted.stdout,/Received Access-Accept/);assert.match(accepted.stdout,/Mikrotik-Total-Limit = 1000000/);
  stage='source identity, PAP and shared-secret denials';
  const chap='User-Name = "fixture_user_123456"\nCHAP-Password = 0x000000000000000000000000000000000000\nAcct-Session-Id = "TRANSPORT-LAB"\nMessage-Authenticator = 0x00000000000000000000000000000000\n';
  for(const [nasName,secret,input]of [['nas-b',secretB,auth+'NAS-Identifier = "nas_a"\n'],['nas-unknown',secretA,auth],['nas-a','c'.repeat(64),auth],['nas-a',secretA,chap]])assert.doesNotMatch((await packet(nasName,1812,'auth',secret,input)).stdout,/Received Access-Accept/);
  stage='mTLS pin and CA denials';
  await requireRadiusRunning();
  for(const port of [1814,1816])assert.doesNotMatch((await packet('nas-a',port,'auth',secretA,auth)).stdout,/Received Access-Accept/);
  const withoutCertificate=await compose(['exec','-T','radius-api','node','--input-type=module','-e',"import https from 'node:https';import fs from 'node:fs';const r=https.get('https://radius-api:3443/',{ca:fs.readFileSync('/run/secrets/radius_ca'),minVersion:'TLSv1.3',timeout:2000},()=>process.exit(1));r.on('error',e=>{console.log(e.code);process.exit(e.code==='ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED'?0:1)});r.on('timeout',()=>process.exit(1));"],{allowFailure:true});assert.equal(withoutCertificate.code,0,withoutCertificate.stdout+withoutCertificate.stderr);
  stage='published UDP accounting response and denial';
  const accounting='Acct-Status-Type = Start\nAcct-Session-Id = "TRANSPORT-LAB"\n';
  assert.match((await packet('nas-a',1812,'acct',secretA,accounting)).stdout,/Received Accounting-Response/);
  assert.doesNotMatch((await packet('nas-b',1812,'acct',secretB,accounting)).stdout,/Received Accounting-Response/);
  const events=(await readFile(join(directory,'events/events.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(events.some(e=>e.result==='pin-rejected'));assert.ok(events.some(e=>e.result==='received'&&e.nas==='nas_b'));assert.ok(events.some(e=>e.result==='received'&&e.nas==='nas_a'&&e.path==='/radius/accounting'));
  stage='HTTPS control routing and observed source NAT';
  const controlProbe=`import https from 'node:https';import fs from 'node:fs';const r=https.get('https://${nasIp}/rest/system/resource',{ca:fs.readFileSync('/run/secrets/'+process.argv[1]),headers:{'x-pamofi-lab':'disposable-fixture'},timeout:3000},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>{console.log(body);process.exit(res.statusCode===200?0:1)});});r.on('error',()=>process.exit(1));r.on('timeout',()=>{r.destroy();process.exit(1)});`;
  const routed=await compose(['exec','-T','control','node','--input-type=module','-e',controlProbe,'radius_ca']);
  assert.equal(JSON.parse(routed.stdout).source,serverIp);
  assert.notEqual((await compose(['exec','-T','control','node','--input-type=module','-e',controlProbe,'wrong_ca'],{allowFailure:true})).code,0);
  stage='qualification and authority outage denials';
  const gate=await compose(['exec','-T','-e','PAMOFI_RADIUS_QUALIFIED=false','radius','/bin/sh','/opt/pamofi-radius/entrypoint.sh'],{allowFailure:true});assert.notEqual(gate.code,0);assert.match(gate.stderr+gate.stdout,/qualification/i);
  const bind=await compose(['exec','-T','-e','PAMOFI_RADIUS_TUNNEL_IP=0.0.0.0','radius','/bin/sh','/opt/pamofi-radius/entrypoint.sh'],{allowFailure:true});assert.notEqual(bind.code,0);assert.match(bind.stderr+bind.stdout,/bind/i);
  await compose(['stop','radius-api']);
  assert.doesNotMatch((await packet('nas-a',1812,'auth',secretA,auth)).stdout,/Received Access-Accept/);
  assert.doesNotMatch((await packet('nas-a',1812,'acct',secretA,accounting)).stdout,/Received Accounting-Response/);
  console.log('Production RADIUS transport lab passed: actual overlay, private published UDP across bridges with NAS source preserved, HTTPS egress and observed host-source NAT, closed gates, source/secret/PAP isolation, mTLS CA/client-pin/no-certificate rejection, accounting and authority outage. This is synthetic transport evidence; real ledger behavior is covered separately by pamofi-radius/lab.');
}catch(error){
  let detail=error.message;for(const secret of redactions)detail=detail.replaceAll(secret,'[redacted]');console.error(`Production RADIUS transport lab failed during ${stage}: ${detail}`);
  if(created&&!stopped){const logs=await compose(['logs','--tail','12','radius','radius-wrong-client','radius-wrong-ca','radius-api','nas-a'],{allowFailure:true});let output=logs.stdout+logs.stderr;for(const secret of redactions)output=output.replaceAll(secret,'[redacted]');console.error(output.slice(-7000));}
  process.exitCode=1;
}finally{
  cleaning=true;
  if(created)await compose(['down','--volumes','--remove-orphans'],{allowFailure:true,timeout:60000});
  if(directory)await rm(directory,{recursive:true,force:true});
}
