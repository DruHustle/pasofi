import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { beginProviderPayment, reconcileProviderPayment, markStaleInitiationsUnknown } from '../dist/payments.js';
import { PesepayAdapter, encryptPesepay } from '../dist/pesepay.js';
import { issueGrant, recordAccounting } from '../dist/grants.js';
const url=process.env.PAMOFI_TEST_DATABASE_URL;
const method={active:true,code:'PZW211',currencies:['USD'],minimumAmount:1,maximumAmount:500};
const eligibility={method,merchantEnabledCodes:new Set(['PZW211']),siteQualifiedCodes:new Set(['PZW211'])};
test('provider reconciliation fulfills once, isolates duplicate charges and reverses only its source',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:10}), customer=randomUUID(), site=randomUUID(), order=randomUUID(), key=randomUUID();let calls=0,status='verified_success';
 const adapter={provider:'pesepay',initiate:async()=>{calls++;await new Promise(r=>setTimeout(r,20));return {state:'initiated',referenceNumber:`PP-${order}`,redirectUrl:'https://checkout.pesepay.com/demo'};},check:async()=>({state:status,providerStatus:status})};
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
  const repeatedDuplicate=await Promise.all(Array.from({length:5},()=>reconcileProviderPayment(pool,duplicate,adapter)));
  assert.ok(repeatedDuplicate.every(result=>result.state==='pending_review'));
  assert.equal((await pool.query("SELECT id FROM payment_reviews WHERE order_id=$1 AND reason='duplicate_charge'",[order])).rowCount,1);
  status='reversed';
  assert.equal((await reconcileProviderPayment(pool,duplicate,adapter)).state,'reversed');
  assert.equal((await pool.query('SELECT revoked_at FROM purchase_entitlements WHERE order_id=$1',[order])).rows[0].revoked_at,null);
  assert.equal((await reconcileProviderPayment(pool,attempt,adapter)).state,'reversed');
  assert.ok((await pool.query('SELECT revoked_at FROM purchase_entitlements WHERE order_id=$1',[order])).rows[0].revoked_at);
  await assert.rejects(issueGrant(pool,customer,site,randomUUID(),randomUUID(),'lab-session-1'),{code:'no_usable_entitlement'});
 }finally{await pool.query('DELETE FROM payment_reviews WHERE order_id=$1',[order]);await pool.query('DELETE FROM verified_charges WHERE order_id=$1',[order]);await pool.query('DELETE FROM purchase_entitlements WHERE order_id=$1',[order]);await pool.query('DELETE FROM provider_payment_attempts WHERE order_id=$1',[order]);await pool.query('DELETE FROM purchase_orders WHERE id=$1',[order]);await pool.end();}
});
test('ambiguous initiation blocks re-initiation and used access reversal is reviewed',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:6}), customer=randomUUID(), site=randomUUID(), order=randomUUID(), uncertainOrder=randomUUID();let calls=0,status='verified_success';
 const adapter={provider:'pesepay',initiate:async()=>{calls++;return {state:'initiated',referenceNumber:`PP-${randomUUID()}`,redirectUrl:'https://checkout.pesepay.com/demo'};},check:async()=>({state:status,providerStatus:status})};
 try{
  for(const id of [order,uncertainOrder])await pool.query("INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at) VALUES($1,$2,$3,'flex',100,'USD',5000000000,604800,'awaiting_payment',now()+interval '15 minutes')",[id,customer,randomUUID()]);
  const unknownAdapter={...adapter,initiate:async()=>{calls++;return {state:'unknown'};}};
  const unknown=await beginProviderPayment(pool,customer,uncertainOrder,randomUUID(),site,'PZW211',eligibility,unknownAdapter);
  assert.equal(unknown.state,'unknown');await assert.rejects(beginProviderPayment(pool,customer,uncertainOrder,randomUUID(),site,'PZW211',eligibility,unknownAdapter),{code:'payment_pending'});assert.equal(calls,1);
  const started=await beginProviderPayment(pool,customer,order,randomUUID(),site,'PZW211',eligibility,adapter);
  assert.equal((await reconcileProviderPayment(pool,started.attemptId,adapter)).state,'fulfilled');
  const nas=randomUUID(),grant=await issueGrant(pool,customer,site,nas,randomUUID(),'lab-session-1');
  await recordAccounting(pool,{grantId:grant.id,siteId:site,nasId:nas,generation:grant.generation,sessionId:'lab-session-1',upload:1n,download:2n,kind:'start'});
  status='reversed';assert.equal((await reconcileProviderPayment(pool,started.attemptId,adapter)).state,'pending_review');
  assert.equal((await reconcileProviderPayment(pool,started.attemptId,adapter)).state,'pending_review');
  status='verified_success';assert.equal((await reconcileProviderPayment(pool,started.attemptId,adapter)).state,'pending_review');
  const ent=(await pool.query('SELECT revoked_at,consumed_bytes::text FROM purchase_entitlements WHERE order_id=$1',[order])).rows[0];assert.equal(ent.revoked_at,null);assert.equal(ent.consumed_bytes,'3');
  assert.equal((await pool.query("SELECT id FROM payment_reviews WHERE order_id=$1 AND reason='consumed_reversal'",[order])).rowCount,1);
 }finally{await pool.query('DELETE FROM access_grants WHERE customer_id=$1',[customer]);for(const id of [order,uncertainOrder]){await pool.query('DELETE FROM payment_reviews WHERE order_id=$1',[id]);await pool.query('DELETE FROM verified_charges WHERE order_id=$1',[id]);await pool.query('DELETE FROM purchase_entitlements WHERE order_id=$1',[id]);await pool.query('DELETE FROM provider_payment_attempts WHERE order_id=$1',[id]);await pool.query('DELETE FROM purchase_orders WHERE id=$1',[id]);}await pool.end();}
});

test('late initiation response recovers a reference after timeout monitoring',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:4}), customer=randomUUID(), site=randomUUID(), order=randomUUID();let release,started;
 const gate=new Promise(r=>{release=r;}), ready=new Promise(r=>{started=r;});
 const adapter={provider:'pesepay',initiate:async()=>{started();await gate;return {state:'initiated',referenceNumber:`PP-${order}`,redirectUrl:'https://checkout.pesepay.com/demo'};},check:async()=>({state:'unknown',providerStatus:null})};
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


test('a reversal observed first survives an older success reply without fulfilling access',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:6}),customer=randomUUID(),site=randomUUID(),order=randomUUID();
 let releaseSuccess,checkStarted,oldSuccess;
 const gate=new Promise(resolve=>{releaseSuccess=resolve;}),ready=new Promise(resolve=>{checkStarted=resolve;});
 const adapter={provider:'pesepay',initiate:async()=>({state:'initiated',referenceNumber:`PP-${order}`,redirectUrl:'https://checkout.pesepay.com/demo'}),check:async()=>({state:'reversed',providerStatus:'REVERSED'})};
 try {
  await pool.query("INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at) VALUES($1,$2,$3,'flex',100,'USD',5000000000,604800,'awaiting_payment',now()+interval '15 minutes')",[order,customer,randomUUID()]);
  const payment=await beginProviderPayment(pool,customer,order,randomUUID(),site,'PZW211',eligibility,adapter);
  oldSuccess=reconcileProviderPayment(pool,payment.attemptId,{...adapter,check:async()=>{checkStarted();await gate;return {state:'verified_success',providerStatus:'SUCCESS'};}});
  await ready;
  assert.equal((await reconcileProviderPayment(pool,payment.attemptId,adapter)).state,'reversed');
  releaseSuccess();
  assert.equal((await oldSuccess).state,'reversed');
  assert.equal((await reconcileProviderPayment(pool,payment.attemptId,adapter)).state,'reversed');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM purchase_entitlements WHERE order_id=$1',[order])).rows[0].n,0);
  assert.equal((await pool.query('SELECT state FROM verified_charges WHERE attempt_id=$1',[payment.attemptId])).rows[0].state,'reversed');
  assert.equal((await pool.query('SELECT state FROM provider_payment_attempts WHERE id=$1',[payment.attemptId])).rows[0].state,'reversed');
  assert.equal((await pool.query('SELECT status FROM purchase_orders WHERE id=$1',[order])).rows[0].status,'awaiting_payment');
 } finally {
  releaseSuccess();
  if(oldSuccess)await oldSuccess.catch(()=>{});
  await pool.query('DELETE FROM payment_reviews WHERE order_id=$1',[order]);
  await pool.query('DELETE FROM verified_charges WHERE order_id=$1',[order]);
  await pool.query('DELETE FROM purchase_entitlements WHERE order_id=$1',[order]);
  await pool.query('DELETE FROM provider_payment_attempts WHERE order_id=$1',[order]);
  await pool.query('DELETE FROM purchase_orders WHERE id=$1',[order]);
  await pool.end();
 }
});

test('a provider reference conflict blocks another charge until investigation',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:6}),customer=randomUUID(),site=randomUUID(),orders=[randomUUID(),randomUUID()],reference=`PP-${randomUUID()}`;
 let calls=0;
 const adapter={provider:'pesepay',initiate:async()=>{calls++;return {state:'initiated',referenceNumber:reference,redirectUrl:'https://checkout.pesepay.com/demo'};},check:async()=>({state:'unknown',providerStatus:null})};
 try {
  for(const order of orders)await pool.query("INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at) VALUES($1,$2,$3,'flex',100,'USD',5000000000,604800,'awaiting_payment',now()+interval '15 minutes')",[order,customer,randomUUID()]);
  assert.equal((await beginProviderPayment(pool,customer,orders[0],randomUUID(),site,'PZW211',eligibility,adapter)).state,'pending');
  const key=randomUUID(),conflict=await beginProviderPayment(pool,customer,orders[1],key,site,'PZW211',eligibility,adapter);
  assert.equal(conflict.state,'review');
  assert.equal((await beginProviderPayment(pool,customer,orders[1],key,site,'PZW211',eligibility,adapter)).state,'review');
  await assert.rejects(beginProviderPayment(pool,customer,orders[1],randomUUID(),site,'PZW211',eligibility,adapter),{code:'payment_pending'});
  assert.equal(calls,2);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM payment_reviews WHERE order_id=$1 AND reason='provider_reference_conflict'",[orders[1]])).rows[0].n,1);
 } finally {
  await pool.query('DELETE FROM payment_reviews WHERE order_id=ANY($1::uuid[])',[orders]);
  await pool.query('DELETE FROM provider_payment_attempts WHERE order_id=ANY($1::uuid[])',[orders]);
  await pool.query('DELETE FROM purchase_orders WHERE id=ANY($1::uuid[])',[orders]);
  await pool.end();
 }
});

test('an unrecognized adapter result never becomes evidence of payment',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:4}),customer=randomUUID(),site=randomUUID(),order=randomUUID();
 const adapter={provider:'pesepay',initiate:async()=>({state:'initiated',referenceNumber:`PP-${order}`,redirectUrl:'https://checkout.pesepay.com/demo'}),check:async()=>({state:'SUCCESS',providerStatus:'SUCCESS'})};
 try {
  await pool.query("INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at) VALUES($1,$2,$3,'flex',100,'USD',5000000000,604800,'awaiting_payment',now()+interval '15 minutes')",[order,customer,randomUUID()]);
  const payment=await beginProviderPayment(pool,customer,order,randomUUID(),site,'PZW211',eligibility,adapter);
  assert.equal((await reconcileProviderPayment(pool,payment.attemptId,adapter)).state,'unable_to_verify');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM purchase_entitlements WHERE order_id=$1',[order])).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM verified_charges WHERE attempt_id=$1',[payment.attemptId])).rows[0].n,0);
 } finally {
  await pool.query('DELETE FROM verified_charges WHERE order_id=$1',[order]);
  await pool.query('DELETE FROM purchase_entitlements WHERE order_id=$1',[order]);
  await pool.query('DELETE FROM provider_payment_attempts WHERE order_id=$1',[order]);
  await pool.query('DELETE FROM purchase_orders WHERE id=$1',[order]);
  await pool.end();
 }
});


test('an untrusted checkout URL retains the provider reference and reconciles without another charge',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:4}),customer=randomUUID(),site=randomUUID(),order=randomUUID(),reference=`PP-${randomUUID()}`,key=randomUUID();
 const encryptionKey='0123456789abcdef0123456789abcdef';
 let initiations=0,checks=0;
 const adapter=new PesepayAdapter({environment:'sandbox',integrationKey:'synthetic-integration-key',encryptionKey,applicationId:1234,resultUrl:'https://pamofi.example/result',returnUrl:'https://pamofi.example/return',allowedCheckoutOrigins:['https://checkout.pesepay.com']},async(endpoint,request)=>{
  let data;
  if(request.method==='POST') {
   initiations++;
   data={referenceNumber:reference,redirectUrl:'https://untrusted-checkout.example/payment'};
  } else {
   checks++;
   assert.equal(new URL(endpoint).searchParams.get('referenceNumber'),reference);
   data={referenceNumber:reference,applicationId:1234,transactionStatus:'SUCCESS',amountDetails:{amount:1,currencyCode:'USD'}};
  }
  return new Response(JSON.stringify({payload:encryptPesepay(data,encryptionKey)}),{headers:{'content-type':'application/json'}});
 });
 try {
  await pool.query("INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at) VALUES($1,$2,$3,'flex',100,'USD',5000000000,604800,'awaiting_payment',now()+interval '15 minutes')",[order,customer,randomUUID()]);
  const payment=await beginProviderPayment(pool,customer,order,key,site,'PZW211',eligibility,adapter);
  assert.equal(payment.state,'unknown');assert.equal(payment.redirectUrl,null);
  const stored=(await pool.query('SELECT provider_reference,redirect_url FROM provider_payment_attempts WHERE id=$1',[payment.attemptId])).rows[0];
  assert.deepEqual(stored,{provider_reference:reference,redirect_url:null});
  assert.equal((await pool.query('SELECT state FROM payment_reconciliation_jobs WHERE attempt_id=$1',[payment.attemptId])).rows[0].state,'pending');
  assert.equal((await beginProviderPayment(pool,customer,order,key,site,'PZW211',eligibility,adapter)).state,'unknown');
  await assert.rejects(beginProviderPayment(pool,customer,order,randomUUID(),site,'PZW211',eligibility,adapter),{code:'payment_pending'});
  assert.equal(initiations,1);
  assert.equal((await reconcileProviderPayment(pool,payment.attemptId,adapter)).state,'fulfilled');
  assert.equal(checks,1);assert.equal(initiations,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM purchase_entitlements WHERE order_id=$1',[order])).rows[0].n,1);
 } finally {
  await pool.query('DELETE FROM verified_charges WHERE order_id=$1',[order]);
  await pool.query('DELETE FROM purchase_entitlements WHERE order_id=$1',[order]);
  await pool.query('DELETE FROM provider_payment_attempts WHERE order_id=$1',[order]);
  await pool.query('DELETE FROM purchase_orders WHERE id=$1',[order]);
  await pool.end();
 }
});
