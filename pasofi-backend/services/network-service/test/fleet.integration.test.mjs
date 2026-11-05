import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import pg from 'pg';
import {SignJWT} from 'jose';
import {buildApp} from '../dist/app.js';
import {fleetFixture} from './fleet-fixture.mjs';

const database=process.env.PAMOFI_TEST_NETWORK_DATABASE_URL;
test('fleet preview/apply/rollback has durable authorization, idempotency, drift and unknown-outcome fences',{skip:!database,timeout:90000},async()=>{
 const saved={...process.env},nas=randomUUID(),unconfigured=randomUUID(),site=randomUUID(),actor=randomUUID(),otherActor=randomUUID(),secret=randomBytes(32).toString('hex');
 const fixture=await fleetFixture(nas),pool=new pg.Pool({connectionString:database,max:3});
 Object.assign(process.env,{DATABASE_URL:database,APP_ENV:'demo',NODE_ENV:'development',INTERNAL_NETWORK_SECRET:secret,ROUTEROS_FLEET_FILE:fixture.registry,ROUTER_FLEET_ENABLED:'true',ROUTER_FLEET_WRITES_ENABLED:'true',PAMOFI_CUSTOMER_NETWORK_ENABLED:'false',INTERNAL_RADIUS_ENABLED:'false',NETWORK_RECONCILER_ENABLED:'false'});
 const app=buildApp(),base=`/internal/v1/router-fleet/routers/${nas}`;
 const token=(scope,who=actor,extra={})=>new SignJWT({scope,actorId:who,actorVersion:'1',...extra}).setProtectedHeader({alg:'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('network').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(secret));
 const read=async(path=base,who=actor)=>app.inject({url:path,headers:{authorization:'Bearer '+await token('router-fleet:read',who)}});
 const post=async(path,payload={},who=actor)=>app.inject({method:'POST',url:path,payload,headers:{authorization:'Bearer '+await token('router-fleet:write',who)}});
 const detail=async()=>{const response=await read();assert.equal(response.statusCode,200,response.body);return response.json();};
 const preview=async(name,requestKey=randomUUID())=>{
  const snapshot=await detail(),target=snapshot.targets.find(t=>t.key==='identity');
  const payload={targetKey:target.key,expectedRevision:target.revision,values:{name},reason:'Test reviewed configuration',requestKey};
  const response=await post(`${base}/changes`,payload);assert.equal(response.statusCode,200,response.body);return {change:response.json().change,payload};
 };
 const apply=async(id,who=actor)=>{const response=await post(`${base}/changes/${id}/apply`,{},who);assert.equal(response.statusCode,200,response.body);return response.json().change;};
 const mature=async id=>pool.query("UPDATE router_fleet_changes SET reconcile_after=now()-interval '1 second' WHERE id=$1",[id]);
 try {
  for(const id of [nas,unconfigured])await pool.query('INSERT INTO radius_nas(id,site_id,client_name,enabled,site_name) VALUES($1,$2,$3,false,$4)',[id,site,`fleet_${id.replaceAll('-','')}`,'Fleet test site']);
  assert.equal((await app.inject({url:base})).statusCode,401);
  assert.equal((await app.inject({url:base,headers:{cookie:'staff=pretend'}})).statusCode,401);
  assert.equal((await app.inject({url:base,headers:{authorization:'Bearer '+await token('network:sites')}})).statusCode,403);
  assert.equal((await app.inject({url:base,headers:{authorization:'Bearer '+await token('router-fleet:read',actor,{actorId:'spoofed'})}})).statusCode,401);
  const tooLong=await new SignJWT({scope:'router-fleet:read',actorId:actor,actorVersion:'1'}).setProtectedHeader({alg:'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('network').setIssuedAt().setExpirationTime('60s').sign(new TextEncoder().encode(secret));
  assert.equal((await app.inject({url:base,headers:{authorization:'Bearer '+tooLong}})).statusCode,401);
  const demoSecret='DEMO_ONLY_'+randomBytes(32).toString('hex');
  const demoToken=scope=>new SignJWT({scope,actorId:actor,actorVersion:'1'}).setProtectedHeader({alg:'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('network').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(demoSecret));
  process.env.INTERNAL_NETWORK_SECRET=demoSecret;
  for(const [appEnv,nodeEnv] of [['production','production'],['demo','production'],['production','development']]){
   Object.assign(process.env,{APP_ENV:appEnv,NODE_ENV:nodeEnv});
   assert.equal((await app.inject({url:base,headers:{authorization:'Bearer '+await demoToken('router-fleet:read')}})).statusCode,503);
   assert.equal((await app.inject({method:'POST',url:`${base}/changes`,payload:{},headers:{authorization:'Bearer '+await demoToken('router-fleet:write')}})).statusCode,503);
  }
  Object.assign(process.env,{APP_ENV:'demo',NODE_ENV:'development'});
  assert.equal((await app.inject({url:'/internal/v1/router-fleet/routers',headers:{authorization:'Bearer '+await demoToken('router-fleet:read')}})).statusCode,200);
  process.env.INTERNAL_NETWORK_SECRET=secret;
  process.env.ROUTER_FLEET_ENABLED='false';assert.equal((await read()).statusCode,404);process.env.ROUTER_FLEET_ENABLED='true';
  const list=await read('/internal/v1/router-fleet/routers');assert.equal(list.statusCode,200,list.body);
  assert.deepEqual(list.json().routers.find(r=>r.id===nas),{id:nas,siteId:site,siteName:'Fleet test site',clientName:`fleet_${nas.replaceAll('-','')}`,customerNetworkEnabled:false,configured:true,writesEnabled:true});
  assert.equal(list.json().routers.find(r=>r.id===unconfigured).configured,false);
  assert.equal((await read(`/internal/v1/router-fleet/routers/${unconfigured}`)).json().error,'router_not_configured');
  const calls=fixture.state.requests.length;
  assert.equal((await read(`/internal/v1/router-fleet/routers/${randomUUID()}`)).statusCode,404);assert.equal(fixture.state.requests.length,calls);
  const first=await preview('PasoFi changed');assert.equal(first.change.status,'prepared');assert.equal(fixture.state.writes,0);
  assert.equal(first.change.before.name,'PasoFi test');assert.equal(first.change.after.name,'PasoFi changed');
  assert.ok(Date.parse(first.change.expiresAt)-Date.parse(first.change.createdAt)>=599000);
  assert.equal((await read()).headers['cache-control'],'no-store');
  const retry=await post(`${base}/changes`,first.payload);assert.deepEqual(retry.json().change,first.change);
  assert.equal((await post(`${base}/changes`,{...first.payload,reason:'Different payload'})).json().error,'idempotency_conflict');
  assert.equal((await post(`${base}/changes`,{...first.payload,requestKey:randomUUID(),actorId:otherActor})).statusCode,400);
  assert.equal((await post(`${base}/changes`,{...first.payload,requestKey:randomUUID(),values:{name:'safe',url:'https://evil.example'}})).statusCode,400);
  assert.equal((await post(`${base}/changes/${first.change.id}/apply`,{},otherActor)).json().error,'actor_mismatch');
  assert.equal((await app.inject({method:'POST',url:`${base}/changes/${first.change.id}/apply`,payload:{},headers:{authorization:'Bearer '+await token('router-fleet:write',actor,{actorVersion:'2'})}})).json().error,'actor_mismatch');
  process.env.ROUTER_FLEET_WRITES_ENABLED='false';
  assert.equal((await post(`${base}/changes/${first.change.id}/apply`)).json().error,'fleet_writes_disabled');
  assert.equal((await detail()).router.writesEnabled,false);process.env.ROUTER_FLEET_WRITES_ENABLED='true';
  assert.equal((await post(`${base}/changes/${first.change.id}/apply`,{path:'/system/reset'})).statusCode,400);
  const concurrent=await Promise.all([apply(first.change.id),apply(first.change.id)]);
  assert.ok(concurrent.some(c=>c.status==='applied'));assert.equal(fixture.state.writes,1);
  assert.equal((await apply(first.change.id)).status,'applied');assert.equal(fixture.state.writes,1);
  assert.equal(fixture.state.identity,'PasoFi changed');
  const immutable=await pool.connect();try{await assert.rejects(immutable.query("UPDATE router_fleet_changes SET reason='replaced audit reason' WHERE id=$1",[first.change.id]),/router_fleet_plan_immutable/);}finally{immutable.release();}
  const rollbackPayload={reason:'Restore reviewed original name',requestKey:randomUUID()};
  const inverseResponse=await post(`${base}/changes/${first.change.id}/rollback`,rollbackPayload);assert.equal(inverseResponse.statusCode,200,inverseResponse.body);
  const inverse=inverseResponse.json().change;assert.equal(inverse.status,'prepared');assert.equal(inverse.parentChangeId,first.change.id);assert.equal(inverse.before.name,'PasoFi changed');assert.equal(inverse.after.name,'PasoFi test');assert.equal(fixture.state.writes,1);
  assert.equal((await post(`${base}/changes/${first.change.id}/rollback`,rollbackPayload)).json().change.id,inverse.id);
  assert.equal((await apply(inverse.id)).status,'applied');assert.equal(fixture.state.identity,'PasoFi test');assert.equal(fixture.state.writes,2);
  assert.equal((await post(`${base}/changes/${first.change.id}/rollback`,{...rollbackPayload,requestKey:randomUUID()})).json().error,'revision_conflict');
  const stale=await preview('Should never be written');fixture.state.identity='Independent operator change';
  assert.equal((await apply(stale.change.id)).status,'diverged');assert.equal(fixture.state.writes,2);
  const mismatch=await preview('Wrong device must not change');fixture.state.serial='DIFFERENT-SERIAL';
  const mismatchResult=await apply(mismatch.change.id);assert.equal(mismatchResult.status,'failed');assert.equal(mismatchResult.errorCode,'device_mismatch');assert.equal(fixture.state.writes,2);fixture.state.serial=fixture.row.expectedSerial;
  // A lost response after the hardware applied the operation remains fenced.
  const lost=await preview('Applied without response');fixture.state.mode='drop-after';
  const uncertain=await apply(lost.change.id);assert.equal(uncertain.status,'uncertain');assert.ok(Date.parse(uncertain.reconcileAfter)>Date.now()+80000);assert.equal(fixture.state.identity,'Applied without response');
  const attempts=fixture.state.writes;assert.equal((await apply(lost.change.id)).status,'uncertain');assert.equal(fixture.state.writes,attempts);
  fixture.state.mode='normal';
  const activeTarget=(await detail()).targets.find(t=>t.key==='identity');
  assert.equal((await post(`${base}/changes`,{...lost.payload,requestKey:randomUUID(),expectedRevision:activeTarget.revision})).json().error,'router_busy');
  assert.equal((await post(`${base}/changes/${lost.change.id}/reconcile`)).json().error,'reconciliation_pending');
  // Read-only reconciliation survives both global and per-device write fences.
  process.env.ROUTER_FLEET_WRITES_ENABLED='false';writeFileSync(fixture.registry,JSON.stringify([{...fixture.row,allowWrites:false}]));
  await mature(lost.change.id);
  const recovered=await post(`${base}/changes/${lost.change.id}/reconcile`,{},otherActor);assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().change.status,'applied');assert.equal(fixture.state.writes,attempts);
  process.env.ROUTER_FLEET_WRITES_ENABLED='true';writeFileSync(fixture.registry,JSON.stringify([fixture.row]));
  // Even an immediate before-value observation cannot settle a late command.
  const late=await preview('Late RouterOS completion');const beforeLate=fixture.state.identity;fixture.state.mode='late';
  assert.equal((await apply(late.change.id)).status,'uncertain');assert.equal(fixture.state.identity,beforeLate);
  fixture.state.mode='normal';assert.equal((await post(`${base}/changes/${late.change.id}/reconcile`)).json().error,'reconciliation_pending');
  fixture.state.pending();fixture.state.pending=null;await mature(late.change.id);
  assert.equal((await post(`${base}/changes/${late.change.id}/reconcile`)).json().change.status,'applied');
  const dropped=await preview('Never executed');fixture.state.mode='drop-before';assert.equal((await apply(dropped.change.id)).status,'uncertain');
  fixture.state.mode='normal';await mature(dropped.change.id);
  assert.equal((await post(`${base}/changes/${dropped.change.id}/reconcile`)).json().change.status,'unchanged');
  const diverged=await preview('Unknown then diverged');fixture.state.mode='drop-before';assert.equal((await apply(diverged.change.id)).status,'uncertain');
  fixture.state.mode='normal';fixture.state.identity='Later independent configuration';await mature(diverged.change.id);
  assert.equal((await post(`${base}/changes/${diverged.change.id}/reconcile`)).json().change.status,'diverged');
  // Model a crash after the durable fence but before hardware I/O. The replay
  // does not execute, and only a settled observation releases the NAS.
  const crashed=await preview('Crash cannot trigger replay');
  await pool.query("UPDATE router_fleet_changes SET status='applying',attempt_id=$2,reconcile_after=now()+interval '90 seconds' WHERE id=$1",[crashed.change.id,randomUUID()]);
  const beforeCrashWrites=fixture.state.writes;assert.equal((await apply(crashed.change.id)).status,'applying');assert.equal(fixture.state.writes,beforeCrashWrites);
  assert.equal((await post(`${base}/changes/${crashed.change.id}/reconcile`)).json().error,'reconciliation_pending');await mature(crashed.change.id);
  assert.equal((await post(`${base}/changes/${crashed.change.id}/reconcile`)).json().change.status,'unchanged');assert.equal(fixture.state.writes,beforeCrashWrites);
  const ignored=await preview('Successful response without change');fixture.state.mode='ignore';assert.equal((await apply(ignored.change.id)).status,'unchanged');fixture.state.mode='normal';
  // Seed a historically prepared plan with an elapsed expiry, without
  // weakening the immutable-plan trigger or waiting ten wall-clock minutes.
  const expiration=await preview('Expired cannot start'),expiredId=randomUUID();
  await pool.query(`INSERT INTO router_fleet_changes SELECT
    (jsonb_populate_record(NULL::router_fleet_changes,to_jsonb(c)||jsonb_build_object('id',$2::text,'request_key',$3::text,'expires_at',now()-interval '1 second'))).*
    FROM router_fleet_changes c WHERE id=$1`,[expiration.change.id,expiredId,randomUUID()]);
  const beforeExpiryWrites=fixture.state.writes;
  const expired=await read(`${base}/changes/${expiredId}`);assert.equal(expired.statusCode,200,expired.body);assert.equal(expired.json().change.status,'expired');
  assert.equal((await apply(expiredId)).status,'expired');assert.equal(fixture.state.writes,beforeExpiryWrites);
  const history=await read(`${base}/changes`);assert.equal(history.statusCode,200);
  for(const id of [first.change.id,inverse.id,stale.change.id,mismatch.change.id,lost.change.id,late.change.id,dropped.change.id,diverged.change.id,crashed.change.id,ignored.change.id,expiration.change.id,expiredId])assert.ok(history.json().changes.some(c=>c.id===id));
  const events=await pool.query('SELECT event_type,actor_id FROM router_fleet_events WHERE nas_id=$1',[nas]);
  assert.ok(events.rows.some(e=>e.event_type==='rollback_prepared'));assert.ok(events.rows.some(e=>e.event_type==='reconciled'&&e.actor_id===otherActor));assert.ok(events.rows.some(e=>e.event_type==='expired'));
  const exposed=JSON.stringify([list.json(),(await detail()),history.json()]);assert.equal(exposed.includes(fixture.row.password),false);assert.equal(exposed.includes(fixture.row.url),false);assert.equal(exposed.includes(fixture.row.caFile),false);
 }finally{
  fixture.state.pending=null;await app.close();
  await pool.query('DELETE FROM router_fleet_events WHERE nas_id=$1',[nas]);await pool.query('DELETE FROM router_fleet_changes WHERE nas_id=$1',[nas]);
  await pool.query('DELETE FROM radius_nas WHERE id=ANY($1::uuid[])',[[nas,unconfigured]]);await pool.end();await fixture.close();
  for(const name of ['DATABASE_URL','APP_ENV','NODE_ENV','INTERNAL_NETWORK_SECRET','ROUTEROS_FLEET_FILE','ROUTER_FLEET_ENABLED','ROUTER_FLEET_WRITES_ENABLED','PAMOFI_CUSTOMER_NETWORK_ENABLED','INTERNAL_RADIUS_ENABLED','NETWORK_RECONCILER_ENABLED']){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}
 }
});
