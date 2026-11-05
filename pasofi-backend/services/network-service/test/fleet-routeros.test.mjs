import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,symlinkSync,writeFileSync} from 'node:fs';
import {FleetRouter,configuredFleet,normalizeValues,validateFleetRows} from '../dist/fleet-routeros.js';
import {fleetFixture} from './fleet-fixture.mjs';

test('fleet adapter verifies the enrolled serial and writes only exact allowlisted settings over trusted HTTPS',{timeout:30000},async()=>{
 const fixture=await fleetFixture(),{state,config}=fixture;
 try {
  const router=new FleetRouter(config),before=await router.snapshot();
  assert.equal(before.device.serial,config.expectedSerial);assert.equal(before.targets.length,5);
  for(const target of before.targets){assert.match(target.target.revision,/^[a-f0-9]{64}$/);assert.equal(target.target.fields.length,Object.keys(target.target.values).length);}
  const identity=before.targets.find(t=>t.target.key==='identity');
  await router.write(identity,{name:'PasoFi branch'});
  assert.equal(state.identity,'PasoFi branch');
  assert.equal(state.requests.at(-1).method,'POST');assert.equal(state.requests.at(-1).path,'/rest/system/identity/set');
  const comment=before.targets.find(t=>t.target.key==='ap-comment');
  await router.write(comment,{comment:'Reviewed customer access point'});
  assert.equal(state.requests.at(-1).method,'PATCH');assert.equal(state.requests.at(-1).path,'/rest/interface/*A');
  assert.deepEqual(state.requests.at(-1).body,{comment:'Reviewed customer access point'});
  for(const kind of ['wireless','wifi','hotspot-profile']){
   const snapshot=before.targets.find(t=>t.target.kind===kind);
   await router.write(snapshot,snapshot.target.values);
   assert.equal(state.requests.at(-1).method,'PATCH');
  }
  const after=await router.snapshot(['identity']);assert.equal(after.targets[0].target.values.name,'PasoFi branch');assert.notEqual(after.targets[0].target.revision,identity.target.revision);
  for(const request of state.requests)assert.equal(request.authorization,'Basic '+Buffer.from(`${config.username}:${config.password}`).toString('base64'));
  state.serial='FOREIGN-DEVICE';const writes=state.writes;
  await assert.rejects(router.snapshot(),{message:'device_mismatch'});assert.equal(state.writes,writes);
 }finally{await fixture.close();}
});

test('fleet adapter rejects redirects, untrusted certificates, unsafe target responses and oversized data',{timeout:30000},async()=>{
 const fixture=await fleetFixture();
 try {
  const router=new FleetRouter(fixture.config);
  for(const mode of ['redirect','oversize']){fixture.state.mode=mode;await assert.rejects(router.snapshot(),{message:'router_unavailable'});}
  for(const mode of ['foreign','bad-id']){fixture.state.mode=mode;await assert.rejects(router.snapshot(['ap-comment']),{message:'target_unavailable'});}
  fixture.state.mode='normal';
  const other=await fleetFixture('22222222-2222-4222-8222-222222222222');
  try {await assert.rejects(new FleetRouter({...fixture.config,caFile:other.config.caFile}).snapshot(),{message:'router_unavailable'});}finally{await other.close();}
  assert.equal(fixture.state.writes,0);
 }finally{await fixture.close();}
});

test('fleet registry and values reject arbitrary endpoints, targets, scripts, extra fields and unsafe files',async()=>{
 const fixture=await fleetFixture(),saved={ROUTEROS_FLEET_FILE:process.env.ROUTEROS_FLEET_FILE,APP_ENV:process.env.APP_ENV,NODE_ENV:process.env.NODE_ENV};
 try {
  const {row}=fixture;
  assert.throws(()=>validateFleetRows([row]),{message:'unavailable'});
  const production={...row,url:'https://10.20.0.2/rest/'};
  assert.equal(validateFleetRows([production]).length,1);
  for(const patch of [{url:'http://10.20.0.2/rest/'},{url:'https://8.8.8.8/rest/'},{url:'https://10.20.0.2/rest/?command=reset'},{url:'https://user:pass@10.20.0.2/rest/'},{expectedSerial:''},{username:'user:other'},{extra:'anything'},{targets:[{key:'system',kind:'script',name:'reboot'}]}])assert.throws(()=>validateFleetRows([{...production,...patch}]),{message:'unavailable'});
  assert.throws(()=>validateFleetRows([production,{...production,nasId:production.nasId.toUpperCase()}]),{message:'unavailable'});
  const anotherNas='22222222-2222-4222-8222-222222222222';
  assert.throws(()=>validateFleetRows([production,{...production,nasId:anotherNas,expectedSerial:'ANOTHER-SERIAL'}]),{message:'unavailable'});
  assert.throws(()=>validateFleetRows([production,{...production,nasId:anotherNas,url:'https://10.20.0.3/rest/'}]),{message:'unavailable'});
  assert.throws(()=>validateFleetRows([production,{...production,nasId:anotherNas,url:'https://10.20.0.3/rest/',expectedSerial:production.expectedSerial.toLowerCase()}]),{message:'unavailable'});
  assert.throws(()=>normalizeValues({key:'identity',kind:'identity'},{name:'a\n/system/reset'}),{message:'invalid_values'});
  assert.throws(()=>normalizeValues({key:'identity',kind:'identity'},{name:'good',url:'https://evil.example'}),{message:'invalid_values'});
  assert.throws(()=>normalizeValues({key:'ap',kind:'wireless',name:'wlan1'},{ssid:'🛜'.repeat(9),disabled:false}),{message:'invalid_values'});
  assert.throws(()=>normalizeValues({key:'ap',kind:'wireless',name:'wlan1'},{ssid:'PasoFi',disabled:'false'}),{message:'invalid_values'});
  assert.throws(()=>normalizeValues({key:'profile',kind:'hotspot-profile',name:'customer'},{'rate-limit':'5M; /system/reset','idle-timeout':'5m','keepalive-timeout':'2m'}),{message:'invalid_values'});
  assert.deepEqual(normalizeValues({key:'profile',kind:'hotspot-profile',name:'customer'},{'rate-limit':'5M/10M 6M/12M 4M/8M 10/10 8 1M/2M','idle-timeout':'00:05:00','keepalive-timeout':'none'}),{'rate-limit':'5M/10M 6M/12M 4M/8M 10/10 8 1M/2M','idle-timeout':'00:05:00','keepalive-timeout':'none'});
  Object.assign(process.env,{ROUTEROS_FLEET_FILE:fixture.registry,APP_ENV:'demo',NODE_ENV:'development'});
  assert.equal(configuredFleet().size,1);
  chmodSync(fixture.registry,0o666);assert.throws(()=>configuredFleet(),{message:'unavailable'});chmodSync(fixture.registry,0o600);
  const link=fixture.file('link.json');symlinkSync(fixture.registry,link);process.env.ROUTEROS_FLEET_FILE=link;assert.throws(()=>configuredFleet(),{message:'unavailable'});
  process.env.ROUTEROS_FLEET_FILE=fixture.registry;writeFileSync(fixture.registry,'not-json');assert.throws(()=>configuredFleet(),{message:'unavailable'});
 }finally{for(const [name,value] of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}await fixture.close();}
});
