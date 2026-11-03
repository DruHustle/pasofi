import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildPlan,validatePlan} from './plan.mjs';

export const fixture=()=>({serverEndpoint:'1.1.1.1',port:51821,serverPublicKey:Buffer.alloc(32,1).toString('base64'),routerPublicKey:Buffer.alloc(32,2).toString('base64'),serverTunnelIp:'10.77.254.1',routerTunnelIp:'10.77.254.2',serverInterface:'pfi-site01',routerNetworks:['192.168.0.0/24','192.168.88.0/24'],serverNetworks:['172.20.0.0/16']});
test('outbound site plan confines routes and preserves RADIUS responses behind NAT',()=>{
  const p=fixture(),files=buildPlan(p),router=files['router-service.rsc.review'];
  assert.match(router,/endpoint-address="1\.1\.1\.1" endpoint-port=51821 persistent-keepalive=25s/);
  assert.match(router,/allowed-address=10\.77\.254\.1\/32/);
  assert.match(router,/src-port=1812,1813 connection-state=established,related/);
  assert.match(router,/protocol=tcp dst-port=443/);
  assert.doesNotMatch(router,/dst-port=(?:80,|8291|22)|dst-address=0\.0\.0\.0\/0|masquerade|service set|radius add/);
  assert.equal((router.match(/\/ip route add /g)||[]).length,1);
  assert.match(files['oracle-wireguard.conf.review'],/AllowedIPs = 10\.77\.254\.2\/32/);
  const report=JSON.parse(files['review.json']);assert.equal(report.status,'prepared-only');assert.equal(report.customerDefaultRouteIncluded,false);
});
test('fresh interface preflight and final enablement precede no unguarded forwarding',()=>{
  const text=buildPlan(fixture())['router-service.rsc.review'];
  assert.ok(text.startsWith('{\n')&&text.endsWith('}\n'));
  for(const state of ['peers','/ip address','/ipv6 address','/interface list member','/interface bridge port','/ipv6 route'])assert.ok(text.includes(state));
  assert.match(text, /\/ipv6 address find where interface="pamofi-service" and \(dynamic=no or link-local=no\)/);
  assert.match(text,/disabled\] != true/);assert.match(text,/public-key\] !=/);
  assert.equal((text.match(/action=drop (?:in|out)-interface="pamofi-service" comment="PamoFi site: no customer/g)||[]).length,4); // Each branch renders its own add.
  const additions=text.indexOf('/ip address add');
  assert.ok(text.indexOf('PamoFi site: deny other service input')<additions);
  assert.ok(text.indexOf('PamoFi site: RADIUS replies')<additions);
  assert.ok(text.indexOf('PamoFi site: no inner IPv6 output')<additions);
  assert.ok(text.lastIndexOf('/interface wireguard set')>text.indexOf('/ip route add'));
});
test('Oracle firewall limits traffic before Docker DNAT and after source NAT',()=>{
  const text=buildPlan(fixture())['oracle-firewall.nft.review'];
  assert.match(text,/hook prerouting priority -150/);assert.match(text,/hook postrouting priority 110/);
  assert.match(text,/^create table inet pfi_site01$/m);
  assert.match(text,/incoming iifname != "pfi-site01" ip daddr 10\.77\.254\.1 udp dport \{ 1812, 1813 \} drop/);
  assert.match(text,/ip saddr 10\.77\.254\.2 ip daddr 10\.77\.254\.1 udp dport \{ 1812, 1813 \} accept/);
  assert.match(text,/tcp sport 443 ct state established,related accept/);
  assert.match(text,/udp sport \{ 1812, 1813 \} ct state established,related accept/);
  assert.match(text,/incoming iifname "pfi-site01" drop/);assert.match(text,/outgoing oifname "pfi-site01" drop/);
  assert.doesNotMatch(text,/^flush\b|0\.0\.0\.0\/0|masquerade/m);
});
test('unsafe keys endpoints networks and injection are rejected before output',()=>{
  for(const update of [
    {privateKey:'secret'},{serverEndpoint:'192.168.0.1'},{serverEndpoint:'100.64.0.1'},{serverEndpoint:'example.test'},
    {serverEndpoint:'x"; /system reset-configuration'},{serverEndpoint:'https://example.com'},
    {serverPublicKey:Buffer.alloc(32).toString('base64')},{routerPublicKey:fixture().serverPublicKey},
    {serverTunnelIp:'10.77.254.2'},{routerTunnelIp:'192.168.88.2'},{serverNetworks:['10.0.0.0/8']},
    {routerNetworks:[]},{serverNetworks:[]},{serverInterface:'eth0'},{serverInterface:'pfi-x;reboot'},
    {serverInterface:'pfi-name-too-long-12'},{port:443},{port:65536},
  ])assert.throws(()=>validatePlan({...fixture(),...update}),JSON.stringify(update));
});
test('CLI writes private exclusive outputs and refuses overwriting',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pamofi-site-plan-'));
  try{
    const source=join(dir,'plan.json'),target=join(dir,'out');await writeFile(source,JSON.stringify(fixture()));
    const script=fileURLToPath(new URL('./plan.mjs',import.meta.url));
    const first=spawnSync(process.execPath,[script,source,target],{encoding:'utf8'});assert.equal(first.status,0,first.stderr);
    assert.equal((await stat(target)).mode&0o777,0o700);
    for(const name of Object.keys(buildPlan(fixture())))assert.equal((await stat(join(target,name))).mode&0o777,0o600);
    const before=await readFile(join(target,'review.json'),'utf8');
    assert.notEqual(spawnSync(process.execPath,[script,source,target],{encoding:'utf8'}).status,0);
    assert.equal(await readFile(join(target,'review.json'),'utf8'),before);
  }finally{await rm(dir,{recursive:true,force:true});}
});
