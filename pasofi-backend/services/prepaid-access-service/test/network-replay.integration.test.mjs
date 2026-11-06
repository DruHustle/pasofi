import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import Fastify from 'fastify';
import pg from 'pg';
import {registerCustomerNetwork} from '../dist/network-lifecycle.js';
import {issueGrant} from '../dist/grants.js';
import {cleanupInvoiceEvidence} from './fixtures/invoices.mjs';

const prepaidUrl=process.env.PAMOFI_TEST_DATABASE_URL,networkUrl=process.env.PAMOFI_TEST_NETWORK_DATABASE_URL;
const options={skip:!prepaidUrl||!networkUrl,timeout:30000};

async function fixture(t){
 const {registerNetworkInternal}=await import('../../network-service/dist/internal.js');
 const customerId=randomUUID(),otherCustomer=randomUUID(),siteId=randomUUID(),nasId=randomUUID(),otherNas=randomUUID(),requestKey=randomUUID(),otherRequest=randomUUID();
 const orders=[randomUUID(),randomUUID()],entitlements=[randomUUID(),randomUUID()],applicationName=`credential-replay-${randomUUID()}`;
 const ledger=new pg.Pool({connectionString:prepaidUrl,max:8,application_name:applicationName}),network=new pg.Pool({connectionString:networkUrl,max:6});
 const env={APP_ENV:'demo',NODE_ENV:'development',PAMOFI_CUSTOMER_NETWORK_ENABLED:'true',INTERNAL_RADIUS_ENABLED:'true',INTERNAL_NETWORK_SECRET:randomBytes(32).toString('hex'),NETWORK_URL:'http://network.example.test',RADIUS_CREDENTIAL_KEY_VERSION:'1',RADIUS_CREDENTIAL_KEYS:JSON.stringify({'1':randomBytes(32).toString('hex')})};
 const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
 const publicApp=Fastify(),privateApp=Fastify(),state={calls:[],afterReply:null};
 registerNetworkInternal(privateApp,network);
 registerCustomerNetwork(publicApp,ledger,true,async request=>request.headers.authorization==='owner'?customerId:request.headers.authorization==='other'?otherCustomer:null,request=>request.headers.origin==='https://customer.example.test');
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  assert.equal(String(url),'http://network.example.test/internal/v1/network/credentials');
  assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.ok(init.signal);
  const body=JSON.parse(init.body);state.calls.push(body);
  const response=await privateApp.inject({method:'POST',url:'/internal/v1/network/credentials',headers:init.headers,payload:body});
  if(state.afterReply)await state.afterReply(body,response);
  return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
 });
 const send=(selection={},authorization='owner')=>publicApp.inject({method:'POST',url:'/v1/network/credentials',headers:{authorization,origin:'https://customer.example.test'},payload:{siteId,nasId,requestKey,...selection}});
 t.after(async()=>{
  try{
   await publicApp.close();await privateApp.close();
   await ledger.query('DELETE FROM network_account_holds WHERE customer_id=ANY($1::uuid[])',[[customerId,otherCustomer]]);
   await ledger.query('DELETE FROM access_grants WHERE customer_id=ANY($1::uuid[])',[[customerId,otherCustomer]]);
   await ledger.query('DELETE FROM purchase_entitlements WHERE id=ANY($1::uuid[])',[entitlements]);
   await cleanupInvoiceEvidence(ledger,{orderIds:orders});await ledger.query('DELETE FROM purchase_orders WHERE id=ANY($1::uuid[])',[orders]);
   await network.query('DELETE FROM radius_credentials WHERE customer_id=ANY($1::uuid[])',[[customerId,otherCustomer]]);
   await network.query('DELETE FROM radius_nas WHERE id=ANY($1::uuid[])',[[nasId,otherNas]]);
  }finally{
   await Promise.all([ledger.end(),network.end()]);
   for(const[key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
 });
 for(let i=0;i<orders.length;i++){
  await ledger.query(`INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at)
    VALUES($1,$2,$3,'flex',100,'USD',5000000000,3600,'payment_confirmed',now()+interval '15 minutes')`,[orders[i],customerId,randomUUID()]);
  await ledger.query(`INSERT INTO purchase_entitlements(id,order_id,customer_id,bundle_id,byte_limit,validity_seconds,start_by,purchased_at)
    VALUES($1,$2,$3,'flex',5000000000,3600,now()+interval '30 days',now()-make_interval(secs=>$4))`,[entitlements[i],orders[i],customerId,i===0?60:0]);
 }
 await network.query(`INSERT INTO radius_nas(id,site_id,client_name,enabled,site_name,login_url) VALUES
   ($1,$3,$4,true,'Shared test site','https://first.example.test/login'),
   ($2,$3,$5,true,'Shared test site','https://second.example.test/login')`,[nasId,otherNas,siteId,`replay_${nasId.replaceAll('-','')}`,`replay_${otherNas.replaceAll('-','')}`]);
 const first=await send();assert.equal(first.statusCode,200);
 const second=await send({requestKey:otherRequest});assert.equal(second.statusCode,200);
 const credential=(await network.query('SELECT id,expires_at FROM radius_credentials WHERE customer_id=$1 AND request_key=$2',[customerId,requestKey])).rows[0];
 const grant=await issueGrant(ledger,customerId,siteId,nasId,credential.id,`session-${randomUUID()}`);
 assert.equal((await ledger.query('SELECT entitlement_id FROM access_grants WHERE id=$1',[grant.id])).rows[0].entitlement_id,entitlements[0]);
 const grantSnapshot=async()=>(await ledger.query('SELECT state,site_id,nas_id,accounting_session_id,generation,deadline,reserved_bytes::text,charged_bytes::text FROM access_grants WHERE id=$1',[grant.id])).rows[0];
 const originalGrant=await grantSnapshot();
 const counts=async()=>({credentials:(await network.query('SELECT count(*)::int AS n FROM radius_credentials WHERE customer_id=$1',[customerId])).rows[0].n,grants:(await ledger.query('SELECT count(*)::int AS n FROM access_grants WHERE customer_id=$1',[customerId])).rows[0].n});
 return {customerId,otherCustomer,siteId,nasId,otherNas,requestKey,otherRequest,entitlements,ledger,network,applicationName,publicApp,state,send,credential,grant,first:first.json(),counts,grantSnapshot,originalGrant};
}

test('a pending grant replays only its original owned credential without creating or extending access',options,async t=>{
 const f=await fixture(t),before=await f.counts();
 assert.deepEqual(before,{credentials:2,grants:1});
 const replay=await f.send();assert.equal(replay.statusCode,200);assert.deepEqual(replay.json(),f.first);
 assert.deepEqual(f.state.calls.at(-1),{customerId:f.customerId,siteId:f.siteId,nasId:f.nasId,requestKey:f.requestKey,replayCredentialId:f.credential.id});
 assert.notEqual(f.requestKey,f.credential.id);
 const legacy=await f.send({nasId:undefined});assert.equal(legacy.statusCode,200);assert.deepEqual(legacy.json(),f.first);
 for(const selection of [{requestKey:randomUUID()},{requestKey:f.otherRequest}]){
  const rejected=await f.send(selection);assert.equal(rejected.statusCode,503);assert.deepEqual(rejected.json(),{error:'network_unavailable'});
 }
 const calls=f.state.calls.length;
 for(const selection of [{siteId:randomUUID()},{nasId:f.otherNas}])assert.equal((await f.send(selection)).json().error,'session_pending_or_active');
 assert.equal((await f.send({},'other')).json().error,'no_usable_entitlement');
 assert.equal((await f.send({},'anonymous')).statusCode,401);
 assert.equal((await f.send({replayCredentialId:f.credential.id})).statusCode,400);
 assert.equal((await f.send({customerId:f.otherCustomer})).statusCode,400);
 assert.equal(f.state.calls.length,calls);assert.deepEqual(await f.counts(),before);
 assert.deepEqual(await f.grantSnapshot(),f.originalGrant);
 await assert.rejects(issueGrant(f.ledger,f.customerId,f.siteId,f.nasId,f.credential.id,'different-session'),{code:'idempotency_conflict'});
});

test('pending replay preserves state, hold and the exact reserved entitlement fences',options,async t=>{
 const f=await fixture(t),calls=f.state.calls.length;
 const reset=()=>f.ledger.query(`UPDATE access_grants SET state='pending',issued_at=clock_timestamp()-interval '1 minute',deadline=clock_timestamp()+interval '1 hour',
   disconnect_requested_at=NULL,stop_received_at=NULL,credential_fenced_at=NULL,absent_verified_at=NULL,accounting_started_at=NULL,last_accounting_at=NULL,accounting_anomaly=false WHERE id=$1`,[f.grant.id]);
 for(const change of ["state='active'","state='uncertain'","disconnect_requested_at=clock_timestamp()","stop_received_at=clock_timestamp()","credential_fenced_at=clock_timestamp()","absent_verified_at=clock_timestamp()","accounting_started_at=clock_timestamp()","last_accounting_at=clock_timestamp()","accounting_anomaly=true","issued_at=clock_timestamp()-interval '2 hours',deadline=clock_timestamp()-interval '1 minute'"]){
  await reset();await f.ledger.query(`UPDATE access_grants SET ${change} WHERE id=$1`,[f.grant.id]);
  const rejected=await f.send();assert.equal(rejected.statusCode,409,change);assert.deepEqual(rejected.json(),{error:'session_pending_or_active'},change);
 }
 await reset();await f.ledger.query("INSERT INTO network_account_holds(customer_id,grant_id,reason) VALUES($1,$2,'fixture_hold')",[f.customerId,f.grant.id]);
 assert.equal((await f.send()).json().error,'accounting_review_required');
 await f.ledger.query('DELETE FROM network_account_holds WHERE customer_id=$1',[f.customerId]);
 for(const change of ["revoked_at=clock_timestamp()","consumed_bytes=byte_limit","start_by=clock_timestamp()-interval '1 minute'","activated_at=clock_timestamp()-interval '2 hours'"]){
  await f.ledger.query(`UPDATE purchase_entitlements SET revoked_at=NULL,consumed_bytes=0,start_by=clock_timestamp()+interval '1 day',activated_at=NULL WHERE id=$1`,[f.entitlements[0]]);
  await f.ledger.query(`UPDATE purchase_entitlements SET ${change} WHERE id=$1`,[f.entitlements[0]]);
  const rejected=await f.send();assert.equal(rejected.statusCode,409,change);assert.deepEqual(rejected.json(),{error:'session_pending_or_active'},change);
 }
 assert.equal(f.state.calls.length,calls);assert.deepEqual(await f.counts(),{credentials:2,grants:1});
 assert.equal((await f.ledger.query('SELECT revoked_at IS NULL AND consumed_bytes<byte_limit AS usable FROM purchase_entitlements WHERE id=$1',[f.entitlements[1]])).rows[0].usable,true);
});

test('expired or revoked pending credentials never authorize a fresh key and a late response is withheld',options,async t=>{
 const f=await fixture(t);
 await f.network.query("UPDATE radius_credentials SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[f.credential.id]);
 let rejected=await f.send();assert.equal(rejected.statusCode,409);assert.deepEqual(rejected.json(),{error:'session_pending_or_active'});
 await f.network.query("UPDATE radius_credentials SET expires_at=clock_timestamp()+interval '2 minutes',revoked_at=clock_timestamp() WHERE id=$1",[f.credential.id]);
 rejected=await f.send();assert.equal(rejected.statusCode,409);assert.deepEqual(rejected.json(),{error:'session_pending_or_active'});
 await f.network.query('UPDATE radius_credentials SET revoked_at=NULL WHERE id=$1',[f.credential.id]);
 await f.ledger.query("UPDATE access_grants SET deadline=clock_timestamp()+interval '2 seconds' WHERE id=$1",[f.grant.id]);
 let delayed=false;f.state.afterReply=async(_body,response)=>{assert.equal(response.statusCode,200);delayed=true;await delay(2100);};
 rejected=await f.send();assert.equal(delayed,true);assert.equal(rejected.statusCode,409);assert.deepEqual(rejected.json(),{error:'session_pending_or_active'});
 assert.deepEqual(await f.counts(),{credentials:2,grants:1});
});

test('a real disconnect waits for an in-flight credential replay and fences every later retry',options,async t=>{
 const f=await fixture(t);
 let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 f.state.afterReply=async()=>{entered();await gate;};
 const replay=f.send();let disconnect;
 try{
  await Promise.race([started,replay.then(()=>{throw Error('replay completed before reaching the controlled network response');})]);
  disconnect=f.publicApp.inject({method:'POST',url:'/v1/network/disconnect',headers:{authorization:'owner',origin:'https://customer.example.test'},payload:{grantId:f.grant.id}});
  let blocked=false;
  for(let attempt=0;attempt<80;attempt++){
   const row=await f.ledger.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'UPDATE access_grants SET state=%') AS blocked",[f.applicationName]);
   if(row.rows[0].blocked){blocked=true;break;}await delay(25);
  }
  assert.equal(blocked,true,'disconnect must wait on the replay-held grant row');
  release();const [delivered,stopped]=await Promise.all([replay,disconnect]);assert.equal(delivered.statusCode,200);assert.deepEqual(delivered.json(),f.first);assert.equal(stopped.statusCode,202);
  f.state.afterReply=null;const calls=f.state.calls.length,rejected=await f.send();assert.equal(rejected.statusCode,409);assert.deepEqual(rejected.json(),{error:'session_pending_or_active'});assert.equal(f.state.calls.length,calls);
  assert.deepEqual(await f.counts(),{credentials:2,grants:1});
 }finally{release();await Promise.allSettled([replay,...(disconnect?[disconnect]:[])]);}
});
