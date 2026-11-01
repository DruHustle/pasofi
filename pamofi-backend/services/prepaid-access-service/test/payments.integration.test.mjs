import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beginProviderPayment, reconcileProviderPayment, markStaleInitiationsUnknown } from '../dist/payments.js';
import { issueGrant, recordAccounting } from '../dist/grants.js';
const url=process.env.PAMOFI_TEST_DATABASE_URL;
const method={active:true,code:'PZW211',currencies:['USD'],minimumAmount:1,maximumAmount:500};
const eligibility={method,merchantEnabledCodes:new Set(['PZW211']),siteQualifiedCodes:new Set(['PZW211'])};
test('provider reconciliation fulfills once, isolates duplicate charges and reverses only its source',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:10}), customer=randomUUID(), site=randomUUID(), order=randomUUID(), key=randomUUID();let calls=0,status='verified_success';
 const adapter={initiate:async()=>{calls++;await new Promise(r=>setTimeout(r,20));return {state:'initiated',referenceNumber:`PP-${order}`,redirectUrl:'https://checkout.pesepay.com/demo'};},check:async()=>({state:status,providerStatus:status})};
 try{
  await pool.query("INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at) VALUES($1,$2,$3,'flex',100,'USD',5000000000,604800,'awaiting_payment',now()+interval '15 minutes')",[order,customer,randomUUID()]);
  const starts=await Promise.all(Array.from({length:5},()=>beginProviderPayment(pool,customer,order,key,site,'PZW211',eligibility,adapter)));
  assert.equal(calls,1);assert.equal(new Set(starts.map(x=>x.attemptId)).size,1);
  await assert.rejects(beginProviderPayment(pool,customer,order,key,randomUUID(),'PZW211',eligibility,adapter),{code:'idempotency_conflict'});
  const attempt=starts[0].attemptId;
  const settled=await Promise.all(Array.from({length:8},()=>reconcileProviderPayment(pool,attempt,adapter)));
  assert.ok(settled.every(x=>x.state==='fulfilled'));
  assert.equal((await pool.query('SELECT id FROM purchase_entitlements WHERE order_id=$1',[order])).rowCount,1);
  const duplicate=randomUUID();
  await pool.query("INSERT INTO provider_payment_attempts(id,order_id,customer_id,request_key,site_id,method_code,provider,state,provider_reference) VALUES($1,$2,$3,$4,$5,'PZW211','pesepay','pending',$6)",[duplicate,order,customer,randomUUID(),site,`PP-${randomUUID()}`]);
  assert.equal((await reconcileProviderPayment(pool,duplicate,adapter)).state,'pending_review');
  assert.equal((await pool.query("SELECT id FROM payment_reviews WHERE order_id=$1 AND reason='duplicate_charge'",[order])).rowCount,1);
  status='reversed';
  assert.equal((await reconcileProviderPayment(pool,duplicate,adapter)).state,'reversed');
  assert.equal((await pool.query('SELECT revoked_at FROM purchase_entitlements WHERE order_id=$1',[order])).rows[0].revoked_at,null);
  assert.equal((await reconcileProviderPayment(pool,attempt,adapter)).state,'reversed');
  assert.ok((await pool.query('SELECT revoked_at FROM purchase_entitlements WHERE order_id=$1',[order])).rows[0].revoked_at);
  await assert.rejects(issueGrant(pool,customer,site,randomUUID(),randomUUID()),{code:'no_usable_entitlement'});
 }finally{await pool.query('DELETE FROM payment_reviews WHERE order_id=$1',[order]);await pool.query('DELETE FROM verified_charges WHERE order_id=$1',[order]);await pool.query('DELETE FROM purchase_entitlements WHERE order_id=$1',[order]);await pool.query('DELETE FROM provider_payment_attempts WHERE order_id=$1',[order]);await pool.query('DELETE FROM purchase_orders WHERE id=$1',[order]);await pool.end();}
});
test('ambiguous initiation blocks re-initiation and used access reversal is reviewed',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:6}), customer=randomUUID(), site=randomUUID(), order=randomUUID(), uncertainOrder=randomUUID();let calls=0,status='verified_success';
 const adapter={initiate:async()=>{calls++;return {state:'initiated',referenceNumber:`PP-${randomUUID()}`,redirectUrl:'https://checkout.pesepay.com/demo'};},check:async()=>({state:status,providerStatus:status})};
 try{
  for(const id of [order,uncertainOrder])await pool.query("INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at) VALUES($1,$2,$3,'flex',100,'USD',5000000000,604800,'awaiting_payment',now()+interval '15 minutes')",[id,customer,randomUUID()]);
  const unknownAdapter={...adapter,initiate:async()=>{calls++;return {state:'unknown'};}};
  const unknown=await beginProviderPayment(pool,customer,uncertainOrder,randomUUID(),site,'PZW211',eligibility,unknownAdapter);
  assert.equal(unknown.state,'unknown');await assert.rejects(beginProviderPayment(pool,customer,uncertainOrder,randomUUID(),site,'PZW211',eligibility,unknownAdapter),{code:'payment_pending'});assert.equal(calls,1);
  const started=await beginProviderPayment(pool,customer,order,randomUUID(),site,'PZW211',eligibility,adapter);
  assert.equal((await reconcileProviderPayment(pool,started.attemptId,adapter)).state,'fulfilled');
  const nas=randomUUID(),grant=await issueGrant(pool,customer,site,nas,randomUUID());
  await recordAccounting(pool,{grantId:grant.id,siteId:site,nasId:nas,generation:grant.generation,sessionId:'lab-session-1',upload:1n,download:2n,kind:'start'});
  status='reversed';assert.equal((await reconcileProviderPayment(pool,started.attemptId,adapter)).state,'pending_review');
  const ent=(await pool.query('SELECT revoked_at,consumed_bytes::text FROM purchase_entitlements WHERE order_id=$1',[order])).rows[0];assert.equal(ent.revoked_at,null);assert.equal(ent.consumed_bytes,'3');
  assert.equal((await pool.query("SELECT id FROM payment_reviews WHERE order_id=$1 AND reason='consumed_reversal'",[order])).rowCount,1);
 }finally{await pool.query('DELETE FROM access_grants WHERE customer_id=$1',[customer]);for(const id of [order,uncertainOrder]){await pool.query('DELETE FROM payment_reviews WHERE order_id=$1',[id]);await pool.query('DELETE FROM verified_charges WHERE order_id=$1',[id]);await pool.query('DELETE FROM purchase_entitlements WHERE order_id=$1',[id]);await pool.query('DELETE FROM provider_payment_attempts WHERE order_id=$1',[id]);await pool.query('DELETE FROM purchase_orders WHERE id=$1',[id]);}await pool.end();}
});

test('late initiation response recovers a reference after timeout monitoring',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:4}), customer=randomUUID(), site=randomUUID(), order=randomUUID();let release,started;
 const gate=new Promise(r=>{release=r;}), ready=new Promise(r=>{started=r;});
 const adapter={initiate:async()=>{started();await gate;return {state:'initiated',referenceNumber:`PP-${order}`,redirectUrl:'https://checkout.pesepay.com/demo'};},check:async()=>({state:'unknown',providerStatus:null})};
 try{
  await pool.query("INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at) VALUES($1,$2,$3,'flex',100,'USD',5000000000,604800,'awaiting_payment',now()+interval '15 minutes')",[order,customer,randomUUID()]);
  const pending=beginProviderPayment(pool,customer,order,randomUUID(),site,'PZW211',eligibility,adapter);await ready;
  const attempt=(await pool.query('SELECT id FROM provider_payment_attempts WHERE order_id=$1',[order])).rows[0].id;
  await pool.query("UPDATE provider_payment_attempts SET updated_at=now()-interval '2 minutes' WHERE id=$1",[attempt]);
  assert.equal(await markStaleInitiationsUnknown(pool,60,attempt),1);
  release();const result=await pending;assert.equal(result.state,'pending');
  assert.equal((await pool.query('SELECT provider_reference FROM provider_payment_attempts WHERE id=$1',[attempt])).rows[0].provider_reference,`PP-${order}`);
  assert.equal((await reconcileProviderPayment(pool,attempt,adapter)).state,'unable_to_verify');
 }finally{release();await pool.query('DELETE FROM provider_payment_attempts WHERE order_id=$1',[order]);await pool.query('DELETE FROM purchase_orders WHERE id=$1',[order]);await pool.end();}
});
