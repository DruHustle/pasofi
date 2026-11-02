import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('./plan.mjs',import.meta.url));
// Synthetic public identifiers only. The generator never contacts this host.
const sample={serverHost:'hub.example.com',port:51871,serverPublicKey:Buffer.alloc(32,1).toString('base64'),routerPublicKey:Buffer.alloc(32,2).toString('base64'),serverTunnelIp:'10.77.255.1',routerTunnelIp:'10.77.255.2',adminIdentity:'owner@example.com'};

test('remote plan is private, owner-scoped, single-host-only, and refuses overwrite',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pamofi-remote-plan-'));
 try {
  const input=join(root,'public.json'),output=join(root,'review');await writeFile(input,JSON.stringify(sample));
  const first=spawnSync(process.execPath,[script,input,output],{encoding:'utf8'});
  assert.equal(first.status,0,first.stderr);assert.equal((await stat(output)).mode&0o777,0o700);
  const policy=JSON.parse(await readFile(join(output,'tailscale-policy-fragment.json'),'utf8'));
  assert.deepEqual(policy.grants,[{src:['owner@example.com'],dst:['10.77.255.2/32'],ip:['tcp:80','tcp:443','tcp:8291']}]);
  const route=await readFile(join(output,'route-command.txt'),'utf8');assert.equal(route,'sudo tailscale set --advertise-routes=10.77.255.2/32\n');
  const server=await readFile(join(output,'server-wireguard.conf.review'),'utf8');assert.match(server,/PrivateKey = REPLACE_ON_SERVER_ONLY/);assert.match(server,/AllowedIPs = 10\.77\.255\.2\/32/);
  const router=await readFile(join(output,'router-management.rsc.review'),'utf8');assert.match(router,/Router public key does not match/);assert.match(router,/chain=forward action=drop/);assert.doesNotMatch(router,/private-key=/);
  for(const name of ['server-wireguard.conf.review','router-management.rsc.review','tailscale-policy-fragment.json','route-command.txt'])assert.equal((await stat(join(output,name))).mode&0o777,0o600);
  const again=spawnSync(process.execPath,[script,input,output],{encoding:'utf8'});assert.notEqual(again.status,0);assert.equal(await readFile(join(output,'route-command.txt'),'utf8'),route);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('remote plan rejects private keys, broad/invalid addresses and command injection before creating output',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pamofi-remote-reject-'));
 try {
  const variants=[{privateKey:'never-accepted'},{serverHost:'127.0.0.1'},{serverHost:'100.64.0.1'},{serverHost:'192.168.88.1'},{serverHost:'224.0.0.1'},{serverHost:'203.0.113.1'},{serverHost:'host.invalid'},{serverHost:'hub..example.com'},{serverHost:'hub.example.com;echo unsafe'},{routerTunnelIp:'0.0.0.0/0'},{routerTunnelIp:sample.serverTunnelIp},{port:0},{adminIdentity:'owner@example.com\n*'},{routerPublicKey:sample.serverPublicKey}];
  for(let index=0;index<variants.length;index++){
   const input=join(root,`input-${index}.json`),output=join(root,`output-${index}`);await writeFile(input,JSON.stringify({...sample,...variants[index]}));
   const result=spawnSync(process.execPath,[script,input,output],{encoding:'utf8'});assert.notEqual(result.status,0,`Unsafe case ${index} accepted`);
   await assert.rejects(stat(output),{code:'ENOENT'});
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
