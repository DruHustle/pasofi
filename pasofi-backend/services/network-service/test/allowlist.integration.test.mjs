import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import {SignJWT} from 'jose';
import {registerDeviceAllowlist} from '../dist/allowlist-routes.js';
import {buildApp} from '../dist/app.js';

const database=process.env.PAMOFI_TEST_NETWORK_DATABASE_URL;
function memoryRouter(initial=[]){
 let next=0x100;const state={bindings:initial.map(b=>({...b})),reachable:true,writes:0};
 const check=()=>{if(!state.reachable)throw Error('router_unavailable');};
 return {state,
  async bindings(){check();return state.bindings.map(b=>({...b}));},
  async addBypassBinding(macAddress,comment){check();state.writes++;state.bindings.push({id:`*${(next++).toString(16).toUpperCase()}`,macAddress,type:'bypassed',server:'all',comment,disabled:false});},
  async removeBinding(id){check();state.writes++;state.bindings=state.bindings.filter(b=>b.id!==id);},
 };
}

test('approved devices are admin-authorized, audited and reconciled to every configured router',{skip:!database,timeout:90000},async()=>{
 const saved={...process.env},secret=randomBytes(32).toString('hex'),actor=randomUUID(),other=randomUUID(),bulkActor=randomUUID();
 const g0=randomUUID(),k0=randomUUID(),site=randomUUID(),created=[];
 Object.assign(process.env,{INTERNAL_NETWORK_SECRET:secret,DEVICE_ALLOWLIST_ENABLED:'true',DEVICE_ALLOWLIST_WRITES_ENABLED:'true',APP_ENV:'production',NODE_ENV:'production'});
 const pool=new pg.Pool({connectionString:database,max:4});
 const uplink={id:'*1',macAddress:'D4:01:C3:AA:BB:01',type:'bypassed',server:'all',comment:'K1 management uplink',disabled:false};
 const routerG0=memoryRouter([uplink]),routerK0=memoryRouter();routerK0.state.reachable=false;
 let registry=()=>new Map([[g0,routerG0],[k0,routerK0]]);
 const app=Fastify({logger:false,bodyLimit:16384});registerDeviceAllowlist(app,pool,()=>registry());
 const token=(scope,who=actor,extra={})=>new SignJWT({scope,actorId:who,actorVersion:'3',...extra}).setProtectedHeader({alg:'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('network').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(secret));
 const list=async()=>{const response=await app.inject({url:'/internal/v1/device-allowlist',headers:{authorization:'Bearer '+await token('device-allowlist:read')}});assert.equal(response.statusCode,200,response.body);return response.json();};
 const post=async(path,payload,who=actor)=>app.inject({method:'POST',url:`/internal/v1/device-allowlist${path}`,payload,headers:{authorization:'Bearer '+await token('device-allowlist:write',who)}});
 const mac=()=>['02',...randomBytes(5).toString('hex').match(/../g)].join(':').toUpperCase();
 try {
  for(const [id,name] of [[g0,'G0 Goromonzi'],[k0,'K0 Kuwadzana']])await pool.query('INSERT INTO radius_nas(id,site_id,client_name,enabled,site_name) VALUES($1,$2,$3,false,$4)',[id,site,`allowlist_${id.replaceAll('-','')}`,name]);
  // Service authorization: a signed short-lived prepaid-access token with the exact scope and actor.
  assert.equal((await app.inject({url:'/internal/v1/device-allowlist'})).statusCode,401);
  assert.equal((await app.inject({url:'/internal/v1/device-allowlist',headers:{cookie:'__Host-pamofi_staff_session=x'}})).statusCode,401);
  assert.equal((await app.inject({url:'/internal/v1/device-allowlist',headers:{authorization:'Bearer '+await token('router-fleet:read')}})).statusCode,403);
  assert.equal((await app.inject({url:'/internal/v1/device-allowlist',headers:{authorization:'Bearer '+await token('device-allowlist:read',actor,{actorId:'spoofed'})}})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/internal/v1/device-allowlist/devices',payload:{macAddress:mac(),label:'Kiosk',reason:'Read token cannot write',requestKey:randomUUID()},headers:{authorization:'Bearer '+await token('device-allowlist:read')}})).statusCode,403);
  const long=await new SignJWT({scope:'device-allowlist:read',actorId:actor,actorVersion:'3'}).setProtectedHeader({alg:'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('network').setIssuedAt().setExpirationTime('60s').sign(new TextEncoder().encode(secret));
  assert.equal((await app.inject({url:'/internal/v1/device-allowlist',headers:{authorization:'Bearer '+long}})).statusCode,401);
  process.env.INTERNAL_NETWORK_SECRET='DEMO_ONLY_'+secret;
  assert.equal((await app.inject({url:'/internal/v1/device-allowlist',headers:{authorization:'Bearer '+await token('device-allowlist:read')}})).statusCode,503);
  process.env.INTERNAL_NETWORK_SECRET=secret;
  process.env.DEVICE_ALLOWLIST_ENABLED='false';assert.equal((await app.inject({url:'/internal/v1/device-allowlist',headers:{authorization:'Bearer '+await token('device-allowlist:read')}})).statusCode,404);
  process.env.DEVICE_ALLOWLIST_ENABLED='true';

  // Writes have their own switch; reading and audit stay available.
  process.env.DEVICE_ALLOWLIST_WRITES_ENABLED='false';
  const paused=await post('/devices',{macAddress:mac(),label:'Kiosk',reason:'Writes are paused for review',requestKey:randomUUID()});
  assert.equal(paused.statusCode,403);assert.equal(paused.json().error,'allowlist_writes_disabled');
  assert.equal((await post('/sync',{})).statusCode,403);
  assert.equal((await list()).writesEnabled,false);
  process.env.DEVICE_ALLOWLIST_WRITES_ENABLED='true';
  assert.equal(routerG0.state.writes,0);

  // Validation happens before any database or router write.
  for(const [payload,error] of [
   [{macAddress:'FF:FF:FF:FF:FF:FF',label:'All',reason:'Broadcast is never one device'},'broadcast_mac_address'],
   [{macAddress:'01:00:5E:00:00:FB',label:'mDNS',reason:'Multicast is never one device'},'multicast_mac_address'],
   [{macAddress:'not-a-mac',label:'Bad',reason:'Malformed address rejected'},'invalid_mac_address'],
   [{macAddress:mac(),label:'x'.repeat(81),reason:'Label is far too long here'},'invalid_label'],
   [{macAddress:mac(),label:'Printer',reason:'short'},'invalid_reason'],
   [{macAddress:mac(),label:'Printer',reason:'Includes an injected actor',actorId:other},'invalid_request'],
  ]){
   const response=await post('/devices',{...payload,requestKey:randomUUID()});
   assert.equal(response.statusCode,400,JSON.stringify(payload));assert.equal(response.json().error,error);
  }
  assert.equal((await post('/devices',{macAddress:mac(),label:'Printer',reason:'Request key must be a UUID',requestKey:'x'})).json().error,'invalid_request');

  // Add: normalized, audited, synced to the reachable router, reported for the unreachable one.
  const phone=mac(),requestKey=randomUUID();
  const addBody={macAddress:phone.toLowerCase().replaceAll(':','-'),label:'  Owner   phone ',reason:'Owner approved portal-free access',requestKey};
  const added=await post('/devices',addBody);
  assert.equal(added.statusCode,201,added.body);
  const device=added.json().device;created.push(device.id);
  assert.equal(device.macAddress,phone);assert.equal(device.label,'Owner phone');assert.equal(device.createdBy,actor);assert.equal(added.json().syncing,false);
  assert.deepEqual(routerG0.state.bindings.map(b=>b.comment),['K1 management uplink',`pasofi-allowlist:${device.id} Owner phone`]);
  assert.deepEqual(routerG0.state.bindings[0],uplink);
  let state=await list();
  const listed=state.devices.find(d=>d.id===device.id);
  assert.deepEqual(listed.routers.filter(r=>[g0,k0].includes(r.nasId)).map(r=>[r.nasId,r.state]),[[g0,'applied'],[k0,'pending']]);
  const statusOf=id=>state.routers.find(r=>r.id===id);
  assert.equal(statusOf(g0).status,'synced');assert.equal(statusOf(g0).siteName,'G0 Goromonzi');assert.ok(statusOf(g0).syncedAt);
  assert.equal(statusOf(k0).status,'unreachable');assert.equal(statusOf(k0).errorCode,'router_unavailable');assert.equal(statusOf(k0).syncedAt,null);
  assert.equal(state.maxDevices,200);assert.equal(state.registryAvailable,true);
  const addedEvent=state.events.find(e=>e.entryId===device.id&&e.type==='added');
  assert.deepEqual({actorId:addedEvent.actorId,macAddress:addedEvent.macAddress,label:addedEvent.label,reason:addedEvent.reason,nasId:addedEvent.nasId},
   {actorId:actor,macAddress:phone,label:'Owner phone',reason:'Owner approved portal-free access',nasId:null});
  assert.ok(state.events.some(e=>e.entryId===device.id&&e.type==='router_binding_added'&&e.nasId===g0&&e.actorId===actor));
  assert.ok(!state.events.some(e=>e.entryId===device.id&&e.nasId===k0));

  // Idempotent replay, payload conflicts and duplicate active MACs.
  const writes=routerG0.state.writes;
  const replay=await post('/devices',addBody);assert.equal(replay.statusCode,200);assert.equal(replay.json().device.id,device.id);
  assert.equal(routerG0.state.writes,writes,'a replay re-checks routers but does not write again');
  assert.equal((await post('/devices',{...addBody,label:'Different'})).json().error,'idempotency_conflict');
  const duplicate=await post('/devices',{...addBody,requestKey:randomUUID()});assert.equal(duplicate.statusCode,409);assert.equal(duplicate.json().error,'device_exists');
  await assert.rejects(pool.query("UPDATE device_allowlist_entries SET label='rewritten' WHERE id=$1",[device.id]),/device_allowlist_entry_immutable/);

  // An untagged router binding for the same MAC is reported, never replaced.
  const conflicted=await post('/devices',{macAddress:uplink.macAddress,label:'K1 uplink',reason:'Exercise the untagged conflict path',requestKey:randomUUID()});
  assert.equal(conflicted.statusCode,201,conflicted.body);created.push(conflicted.json().device.id);
  state=await list();
  assert.equal(state.devices.find(d=>d.id===conflicted.json().device.id).routers.find(r=>r.nasId===g0).state,'conflict');
  assert.equal(statusOf(g0).status,'attention');assert.equal(statusOf(g0).errorCode,'untagged_conflict');assert.equal(statusOf(g0).conflicts,1);
  assert.deepEqual(routerG0.state.bindings[0],uplink);
  assert.equal(routerG0.state.bindings.filter(b=>b.macAddress===uplink.macAddress).length,1);

  // K0 becomes reachable: an explicit sync converges it.
  routerK0.state.reachable=true;
  const synced=await post('/sync',{});assert.equal(synced.statusCode,200,synced.body);
  assert.deepEqual(routerK0.state.bindings.map(b=>b.comment),[`pasofi-allowlist:${device.id} Owner phone`,`pasofi-allowlist:${conflicted.json().device.id} K1 uplink`]);
  state=await list();
  assert.equal(statusOf(k0).status,'synced');
  assert.equal(state.devices.find(d=>d.id===device.id).routers.find(r=>r.nasId===k0).state,'applied');

  // Remove: audited, removed from every router, operator binding untouched.
  const removeKey=randomUUID();
  const removed=await post(`/devices/${device.id}/remove`,{reason:'Phone was replaced by the owner',requestKey:removeKey});
  assert.equal(removed.statusCode,200,removed.body);assert.ok(removed.json().device.removedAt);
  assert.ok(!routerG0.state.bindings.some(b=>b.comment?.includes(device.id)));
  assert.ok(!routerK0.state.bindings.some(b=>b.comment?.includes(device.id)));
  assert.deepEqual(routerG0.state.bindings[0],uplink);
  assert.equal((await post(`/devices/${device.id}/remove`,{reason:'Phone was replaced by the owner',requestKey:removeKey})).statusCode,200);
  assert.equal((await post(`/devices/${device.id}/remove`,{reason:'Different reason for the replay',requestKey:removeKey})).json().error,'idempotency_conflict');
  assert.equal((await post(`/devices/${device.id}/remove`,{reason:'Second removal attempt here',requestKey:randomUUID()})).json().error,'device_not_active');
  assert.equal((await post(`/devices/${randomUUID()}/remove`,{reason:'Unknown device removal',requestKey:randomUUID()})).statusCode,404);
  assert.equal((await post('/devices/not-a-uuid/remove',{reason:'Malformed device removal',requestKey:randomUUID()})).statusCode,404);
  assert.equal((await post(`/devices/${device.id}/remove`,{reason:'Removing with extra fields',requestKey:randomUUID(),nasId:g0})).statusCode,400);
  state=await list();
  assert.ok(!state.devices.some(d=>d.id===device.id));
  const removedEvent=state.events.find(e=>e.entryId===device.id&&e.type==='removed');
  assert.equal(removedEvent.reason,'Phone was replaced by the owner');assert.equal(removedEvent.actorId,actor);assert.equal(removedEvent.macAddress,phone);
  assert.deepEqual(state.events.filter(e=>e.entryId===device.id&&e.type==='router_binding_removed').map(e=>e.nasId).sort(),[g0,k0].sort());
  await assert.rejects(pool.query("UPDATE device_allowlist_entries SET removed_at=now() WHERE id=$1",[device.id]),/device_allowlist_entry_immutable/);

  // A missing router registry is reported without breaking the list.
  registry=()=>{throw Error('router_unavailable');};
  state=await list();assert.equal(state.registryAvailable,false);assert.equal(statusOf(g0).status,'not_configured');
  assert.equal(state.devices.find(d=>d.id===conflicted.json().device.id).routers.find(r=>r.nasId===g0).state,'not_configured');
  registry=()=>new Map([[g0,routerG0],[k0,routerK0]]);

  // The list has a bounded size.
  const active=(await pool.query('SELECT count(*)::int AS count FROM device_allowlist_entries WHERE removed_at IS NULL')).rows[0].count;
  await pool.query(`INSERT INTO device_allowlist_entries(id,mac_address,label,created_by,created_by_version)
   SELECT gen_random_uuid(),'06:'||upper(substr(md5($1||n::text),1,2))||':'||upper(substr(md5($1||n::text),3,2))||':'||upper(substr(md5($1||n::text),5,2))||':'||lpad(upper(to_hex(n/256)),2,'0')||':'||lpad(upper(to_hex(n%256)),2,'0'),'Bulk '||n,$2,'1'
   FROM generate_series(1,$3::int) AS n`,[bulkActor,bulkActor,Math.max(0,200-active)]);
  const full=await post('/devices',{macAddress:mac(),label:'One too many',reason:'The approved list is already full',requestKey:randomUUID()});
  assert.equal(full.statusCode,409);assert.equal(full.json().error,'allowlist_full');
 } finally {
  await app.close();
  const ids=(await pool.query('SELECT id FROM device_allowlist_entries WHERE created_by=ANY($1::uuid[])',[[actor,bulkActor]])).rows.map(r=>r.id);
  await pool.query('DELETE FROM device_allowlist_router_devices WHERE entry_id=ANY($1::uuid[]) OR nas_id=ANY($2::uuid[])',[ids,[g0,k0]]);
  await pool.query('DELETE FROM device_allowlist_entries WHERE id=ANY($1::uuid[])',[ids]);
  await pool.query('DELETE FROM device_allowlist_router_status WHERE nas_id=ANY($1::uuid[])',[[g0,k0]]);
  await pool.end();
  for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);
 }
});

test('the network app exposes approved devices only behind their switch',{skip:!database},async()=>{
 const saved={...process.env};
 Object.assign(process.env,{DATABASE_URL:database,INTERNAL_NETWORK_SECRET:randomBytes(32).toString('hex'),DEVICE_ALLOWLIST_ENABLED:'false',NETWORK_RECONCILER_ENABLED:'false',PAMOFI_CUSTOMER_NETWORK_ENABLED:'false'});
 const app=buildApp();
 try {
  assert.equal((await app.inject({url:'/internal/v1/device-allowlist'})).statusCode,404);
  process.env.DEVICE_ALLOWLIST_ENABLED='true';
  assert.equal((await app.inject({url:'/internal/v1/device-allowlist'})).statusCode,401);
 } finally {await app.close();for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);}
});
