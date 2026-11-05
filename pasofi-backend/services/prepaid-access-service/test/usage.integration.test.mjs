import {cleanupInvoiceEvidence} from './fixtures/invoices.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildApp} from '../dist/app.js';
import {readUsageSnapshot} from '../dist/usage.js';
import {issueGrant,recordAccounting,reconcileGrant} from '../dist/grants.js';

const url=process.env.PAMOFI_TEST_DATABASE_URL;
async function fixture(t,{http=false}={}){
 const pool=new pg.Pool({connectionString:url,max:6}),customer=randomUUID(),other=randomUUID(),ids=[];
 let app,saved;
 if(http){
  const env={DATABASE_URL:url,APP_ENV:'demo',NODE_ENV:'development',IDENTITY_URL:'http://identity.test',INTERNAL_IDENTITY_SECRET:'test_only_usage_identity_secret_at_least_32_bytes',PAMOFI_PAYMENTS_ENABLED:'false',PAMOFI_PESEPAY_SANDBOX_ENABLED:'false'};
  saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
   const cookie=options.headers.cookie??'';
   if(cookie==='customer=broken')return new Response('{}',{status:503});
   if(!['customer=main','customer=other'].includes(cookie))return new Response('{}',{status:401});
   return new Response(JSON.stringify({customerId:cookie==='customer=other'?other:customer}),{headers:{'content-type':'application/json'}});
  });
  app=buildApp();
 }
 async function bundles(count,byteLimit,{owner=customer,consumed=0n,activated=false,expired=false,revoked=false}={}){
  const created=Array.from({length:count},()=>randomUUID());ids.push(...created);
  await pool.query(`INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at)
   SELECT id,$2,id::text,'flex',100,'USD',$3,3600,'payment_confirmed',now()+interval '15 minutes' FROM unnest($1::uuid[]) AS id`,[created,owner,byteLimit.toString()]);
  await pool.query(`INSERT INTO purchase_entitlements(id,order_id,customer_id,bundle_id,byte_limit,consumed_bytes,validity_seconds,start_by,activated_at,revoked_at)
   SELECT id,id,$2,'flex',$3,$4,3600,
    CASE WHEN $6 THEN now()-interval '1 day' ELSE now()+interval '30 days' END,
    CASE WHEN $5 THEN CASE WHEN $6 THEN now()-interval '2 hours' ELSE now()-interval '1 minute' END ELSE NULL END,
    CASE WHEN $7 THEN now() ELSE NULL END
   FROM unnest($1::uuid[]) AS id`,[created,owner,byteLimit.toString(),consumed.toString(),activated,expired,revoked]);
  return created;
 }
 return {pool,customer,other,app,bundles,snapshot:(selected=[])=>readUsageSnapshot(pool,customer,selected),cleanup:async()=>{
  if(app)await app.close();
  await pool.query('DELETE FROM network_account_holds WHERE customer_id=ANY($1::uuid[])',[[customer,other]]);
  await pool.query('DELETE FROM access_grants WHERE customer_id=ANY($1::uuid[])',[[customer,other]]);
  await pool.query('DELETE FROM purchase_entitlements WHERE id=ANY($1::uuid[])',[ids]);
  await cleanupInvoiceEvidence(pool,{orderIds:ids});await pool.query('DELETE FROM purchase_orders WHERE id=ANY($1::uuid[])',[ids]);
  await pool.end();
  if(saved)for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }};
}

test('usage aggregates every owned current bundle exactly, including exhausted access and totals above bigint range',{skip:!url},async t=>{
 const f=await fixture(t),large=900719925474099321n;
 try{
  const queued=await f.bundles(103,large),[active]=await f.bundles(1,1000n,{consumed:250n,activated:true});
  const [exhausted]=await f.bundles(1,500n,{consumed:500n,activated:true});
  const [expired]=await f.bundles(1,2000n,{consumed:123n,activated:true,expired:true});
  await f.bundles(1,3000n,{expired:true});
  const [revoked]=await f.bundles(1,1000n,{consumed:456n,revoked:true});
  const [foreign]=await f.bundles(1,large,{owner:f.other,consumed:999n});
  const snapshot=await f.snapshot([active,exhausted,expired,revoked,foreign,randomUUID()]);
  assert.equal(snapshot.customerId,f.customer);assert.ok(Number.isFinite(Date.parse(snapshot.asOf)));
  assert.deepEqual(snapshot.totals,{bundleCount:105,allowanceBytes:(103n*large+1500n).toString(),usedBytes:'750',remainingBytes:(103n*large+750n).toString()});
  assert.deepEqual(snapshot.active,{bundleCount:2,allowanceBytes:'1500',usedBytes:'750',remainingBytes:'750'});
  assert.deepEqual(snapshot.queued,{bundleCount:103,allowanceBytes:(103n*large).toString(),usedBytes:'0',remainingBytes:(103n*large).toString()});
  assert.equal(snapshot.lifetimeAccountedBytes,'1329');assert.equal(snapshot.reservationOutstandingBytes,'0');
  assert.equal(snapshot.session,null);assert.equal(snapshot.lastAccountingAt,null);assert.equal(snapshot.connectivity,'none');
  assert.deepEqual(snapshot.hold,{active:false,reason:null,since:null});
  assert.deepEqual(snapshot.accounting,{expectedIntervalSeconds:60,staleAfterSeconds:90,pollAfterSeconds:5});
  assert.equal(snapshot.entitlementUpdates.length,4);assert.ok(snapshot.entitlementUpdates.every(e=>e.id!==foreign));
  assert.equal(snapshot.entitlementUpdates.find(e=>e.id===exhausted).consumed_bytes,'500');
  assert.ok(snapshot.entitlementUpdates.find(e=>e.id===revoked).revoked_at);
  // Re-evaluate validity using each new database snapshot, even when no traffic
  // event occurred. Exhausted current access must remain in its denominator.
  await f.pool.query("UPDATE purchase_entitlements SET activated_at=now()-interval '2 hours' WHERE id=$1",[active]);
  await f.pool.query("UPDATE purchase_entitlements SET start_by=now()-interval '1 minute' WHERE id=$1",[queued[0]]);
  await f.pool.query('UPDATE purchase_entitlements SET revoked_at=now() WHERE id=$1',[queued[1]]);
  const changed=await f.snapshot();
  assert.equal(changed.totals.bundleCount,102);assert.equal(changed.totals.remainingBytes,(101n*large).toString());
  assert.deepEqual(changed.active,{bundleCount:1,allowanceBytes:'500',usedBytes:'500',remainingBytes:'0'});
  assert.equal(changed.lifetimeAccountedBytes,'1329');
 }finally{await f.cleanup();}
});

test('usage follows verified accounting once and preserves reservations through stale, Stop and held states',{skip:!url},async t=>{
 const f=await fixture(t),site=randomUUID(),nas=randomUUID();
 try{
  const [entitlement]=await f.bundles(1,10000n);await f.bundles(1,20000n);
  // Give the first purchase an unambiguous FIFO position.
  await f.pool.query("UPDATE purchase_entitlements SET purchased_at=now()-interval '1 minute' WHERE id=$1",[entitlement]);
  const grant=await issueGrant(f.pool,f.customer,site,nas,randomUUID(),'usage-session');
  const event={grantId:grant.id,siteId:site,nasId:nas,generation:grant.generation,sessionId:'usage-session',kind:'start',upload:100n,download:200n};
  let snapshot=await f.snapshot();
  assert.equal(snapshot.connectivity,'pending');assert.equal(snapshot.session.connected,false);assert.equal(snapshot.session.lastAccountingAt,null);
  assert.equal(snapshot.reservationOutstandingBytes,'10000');assert.equal(snapshot.totals.remainingBytes,'30000');
  assert.deepEqual(snapshot.entitlementUpdates.map(e=>e.id),[entitlement]);
  await recordAccounting(f.pool,event);await recordAccounting(f.pool,event);
  snapshot=await f.snapshot();
  assert.equal(snapshot.totals.usedBytes,'300');assert.equal(snapshot.totals.remainingBytes,'29700');
  assert.equal(snapshot.reservationOutstandingBytes,'9700');assert.equal(snapshot.session.chargedBytes,'300');
  assert.equal(snapshot.active.remainingBytes,'9700');assert.equal(snapshot.queued.remainingBytes,'20000');
  assert.equal(snapshot.entitlementUpdates[0].consumed_bytes,'300');assert.ok(snapshot.entitlementUpdates[0].activated_at);
  assert.equal(snapshot.connectivity,'recent_accounting');assert.equal(snapshot.session.connected,true);assert.equal(snapshot.session.accountingStale,false);
  assert.equal(snapshot.lastAccountingAt,snapshot.session.lastAccountingAt);
  await f.pool.query("UPDATE access_grants SET last_accounting_at=now()-interval '2 minutes' WHERE id=$1",[grant.id]);
  snapshot=await f.snapshot();assert.equal(snapshot.connectivity,'stale');assert.equal(snapshot.session.connected,false);assert.equal(snapshot.session.accountingStale,true);
  assert.equal(snapshot.totals.remainingBytes,'29700');
  await recordAccounting(f.pool,{...event,kind:'interim',upload:200n,download:300n});
  snapshot=await f.snapshot();assert.equal(snapshot.totals.usedBytes,'500');assert.equal(snapshot.session.connected,true);
  await recordAccounting(f.pool,{...event,kind:'stop',upload:600n,download:400n});
  snapshot=await f.snapshot();assert.equal(snapshot.connectivity,'uncertain');assert.equal(snapshot.session.connected,false);
  assert.equal(snapshot.reservationOutstandingBytes,'9000');assert.equal(snapshot.totals.remainingBytes,'29000');
  const observedAt=new Date().toISOString();
  await reconcileGrant(f.pool,{grantId:grant.id,siteId:site,nasId:nas,generation:grant.generation,sessionId:'usage-session',observationId:randomUUID(),observedAt,credentialRevokedAt:observedAt,absent:true});
  snapshot=await f.snapshot();assert.equal(snapshot.session,null);assert.equal(snapshot.connectivity,'none');assert.equal(snapshot.reservationOutstandingBytes,'0');assert.ok(snapshot.lastAccountingAt);
  const next=await issueGrant(f.pool,f.customer,site,nas,randomUUID(),'usage-next-session');
  await recordAccounting(f.pool,{...event,kind:'interim',upload:700n,download:400n});
  snapshot=await f.snapshot();assert.equal(snapshot.hold.active,true);assert.equal(snapshot.hold.reason,'usage_after_final_stop');
  assert.equal(snapshot.connectivity,'held');assert.equal(snapshot.session.grantId,next.id);assert.equal(snapshot.session.state,'uncertain');assert.equal(snapshot.session.connected,false);
  assert.equal(snapshot.reservationOutstandingBytes,'9000');assert.equal(snapshot.totals.usedBytes,'1000');assert.equal(snapshot.totals.remainingBytes,'29000');
 }finally{await f.cleanup();}
});

test('one usage snapshot never mixes an uncommitted entitlement debit with committed grant counters',{skip:!url},async t=>{
 const f=await fixture(t);let writer;
 try{
  const [entitlement]=await f.bundles(1,1000n);
  const grant=await issueGrant(f.pool,f.customer,randomUUID(),randomUUID(),randomUUID(),'usage-snapshot');
  writer=await f.pool.connect();await writer.query('BEGIN');
  await writer.query('UPDATE purchase_entitlements SET consumed_bytes=100 WHERE id=$1',[entitlement]);
  const during=await f.snapshot();assert.equal(during.totals.usedBytes,'0');assert.equal(during.session.chargedBytes,'0');assert.equal(during.reservationOutstandingBytes,'1000');
  await writer.query('UPDATE access_grants SET charged_bytes=100,upload_high=100 WHERE id=$1',[grant.id]);
  await writer.query('COMMIT');
  const after=await f.snapshot();assert.equal(after.totals.usedBytes,'100');assert.equal(after.session.chargedBytes,'100');assert.equal(after.reservationOutstandingBytes,'900');assert.equal(after.totals.remainingBytes,'900');
 }finally{if(writer){await writer.query('ROLLBACK');writer.release();}await f.cleanup();}
});
test('an expired or revoked grant entitlement stays reserved without inflating current remaining allowance',{skip:!url},async t=>{
 const f=await fixture(t),site=randomUUID(),nas=randomUUID();
 try{
  const [entitlement]=await f.bundles(1,1000n),grant=await issueGrant(f.pool,f.customer,site,nas,randomUUID(),'usage-expiry');
  await recordAccounting(f.pool,{grantId:grant.id,siteId:site,nasId:nas,generation:grant.generation,sessionId:'usage-expiry',kind:'start',upload:100n,download:0n});
  await f.pool.query("UPDATE purchase_entitlements SET activated_at=now()-interval '2 hours' WHERE id=$1",[entitlement]);
  await f.pool.query("UPDATE access_grants SET issued_at=now()-interval '2 hours',deadline=now()-interval '1 hour' WHERE id=$1",[grant.id]);
  const expired=await f.snapshot();assert.equal(expired.totals.remainingBytes,'0');assert.equal(expired.totals.bundleCount,0);
  assert.equal(expired.reservationOutstandingBytes,'900');assert.equal(expired.lifetimeAccountedBytes,'100');assert.equal(expired.connectivity,'stale');assert.equal(expired.session.connected,false);
  await f.pool.query("UPDATE purchase_entitlements SET activated_at=now()-interval '1 minute',revoked_at=now() WHERE id=$1",[entitlement]);
  const revoked=await f.snapshot();assert.equal(revoked.totals.remainingBytes,'0');assert.equal(revoked.reservationOutstandingBytes,'900');assert.ok(revoked.entitlementUpdates[0].revoked_at);
 }finally{await f.cleanup();}
});

test('usage HTTP authentication and selected-row updates never expose another customer',{skip:!url},async t=>{
 const f=await fixture(t,{http:true});
 try{
  const [own]=await f.bundles(1,1000n),[foreign]=await f.bundles(1,9000n,{owner:f.other});
  assert.equal((await f.app.inject({url:'/v1/usage'})).statusCode,401);
  assert.equal((await f.app.inject({url:'/v1/usage',headers:{cookie:'customer=broken'}})).statusCode,503);
  const response=await f.app.inject({url:`/v1/usage?entitlementIds=${own},${foreign}`,headers:{cookie:'customer=main'}});
  assert.equal(response.statusCode,200);assert.equal(response.headers['cache-control'],'no-store');
  assert.equal(response.json().customerId,f.customer);assert.equal(response.json().totals.remainingBytes,'1000');assert.deepEqual(response.json().entitlementUpdates.map(e=>e.id),[own]);
  const absent=await f.app.inject({url:`/v1/usage?entitlementIds=${randomUUID()}`,headers:{cookie:'customer=main'}});
  const other=await f.app.inject({url:`/v1/usage?entitlementIds=${foreign}`,headers:{cookie:'customer=main'}});
  assert.deepEqual(other.json().entitlementUpdates,absent.json().entitlementUpdates);
  const second=await f.app.inject({url:`/v1/usage?entitlementIds=${own}`,headers:{cookie:'customer=other'}});
  assert.equal(second.json().customerId,f.other);assert.equal(second.json().totals.remainingBytes,'9000');assert.deepEqual(second.json().entitlementUpdates,[]);
  for(const path of ['/v1/access','/v1/orders']){
   assert.equal((await f.app.inject({url:path,headers:{cookie:'customer=main'}})).json().customerId,f.customer);
   assert.equal((await f.app.inject({url:path,headers:{cookie:'customer=other'}})).json().customerId,f.other);
  }
  for(const ids of ['not-a-uuid',`${own},`,Array(101).fill(own).join(',')]){
   assert.equal((await f.app.inject({url:`/v1/usage?entitlementIds=${ids}`,headers:{cookie:'customer=main'}})).statusCode,400);
  }
  const maximum=await f.app.inject({url:`/v1/usage?entitlementIds=${Array(100).fill(own).join(',')}`,headers:{cookie:'customer=main'}});
  assert.equal(maximum.statusCode,200);assert.equal(maximum.json().entitlementUpdates.length,1);
 }finally{await f.cleanup();}
});

test('usage polling has independent authenticated-customer quotas behind a shared hotspot IP',{skip:!url},async t=>{
 const f=await fixture(t,{http:true});
 try{
  for(let i=0;i<60;i++)assert.equal((await f.app.inject({url:'/v1/usage',headers:{cookie:'customer=main'}})).statusCode,200);
  const limited=await f.app.inject({url:'/v1/usage',headers:{cookie:'customer=main','x-forwarded-for':'203.0.113.41'}});
  assert.equal(limited.statusCode,429);assert.ok(limited.headers['retry-after']);
  const other=await f.app.inject({url:'/v1/usage',headers:{cookie:'customer=other'}});
  assert.equal(other.statusCode,200);assert.equal(other.json().customerId,f.other);
  assert.deepEqual(other.json().totals,{bundleCount:0,allowanceBytes:'0',usedBytes:'0',remainingBytes:'0'});
 }finally{await f.cleanup();}
});
test('a blocked usage read times out on PostgreSQL and releases its only pooled connection',{skip:!url},async t=>{
 const f=await fixture(t),usagePool=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:1000});let blocker;
 try{
  await f.bundles(1,1000n);
  const original=(await usagePool.query('SHOW statement_timeout')).rows[0].statement_timeout;
  blocker=await f.pool.connect();await blocker.query('BEGIN');
  await blocker.query('LOCK TABLE purchase_entitlements IN ACCESS EXCLUSIVE MODE');
  const started=Date.now();
  await assert.rejects(readUsageSnapshot(usagePool,f.customer),{code:'57014'});
  assert.ok(Date.now()-started<6000,'polling SQL must not wait indefinitely for a database lock');
  assert.equal(usagePool.totalCount,1);assert.equal(usagePool.idleCount,1);
  await blocker.query('ROLLBACK');blocker.release();blocker=undefined;
  assert.equal((await usagePool.query('SHOW statement_timeout')).rows[0].statement_timeout,original);
  const recovered=await readUsageSnapshot(usagePool,f.customer);
  assert.equal(recovered.totals.remainingBytes,'1000');assert.equal(usagePool.idleCount,1);
 }finally{if(blocker){await blocker.query('ROLLBACK');blocker.release();}await usagePool.end();await f.cleanup();}
});
