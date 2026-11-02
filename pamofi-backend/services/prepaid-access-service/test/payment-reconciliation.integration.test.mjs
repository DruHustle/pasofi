import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import pg from 'pg';
import {beginProviderPayment} from '../dist/payments.js';
import {registerPesepayCallback,enqueuePaymentReference,claimPaymentReconciliation,finishPaymentReconciliation,processPaymentReconciliation} from '../dist/payment-reconciliation.js';
const url=process.env.PAMOFI_TEST_DATABASE_URL;
const method={active:true,code:'PZW211',currencies:['USD'],minimumAmount:1,maximumAmount:500};
const eligibility={method,merchantEnabledCodes:new Set(['PZW211']),siteQualifiedCodes:new Set(['PZW211'])};

test('callback hints and durable jobs require a separate provider check', {skip:!url}, async()=>{
 const pool=new pg.Pool({connectionString:url,max:12}), app=Fastify(), customer=randomUUID(),site=randomUUID(),order=randomUUID(),reference=`PP-${randomUUID()}`;
 let status='pending';
 const adapter={provider:'pesepay',callbackAuthorized:value=>value==='integration-key',initiate:async()=>({state:'initiated',referenceNumber:reference,redirectUrl:'https://checkout.example/'}),check:async()=>({state:status,providerStatus:status})};
 app.register(rateLimit,{global:false});registerPesepayCallback(app,pool,adapter);
 try {
  await pool.query("INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at) VALUES($1,$2,$3,'flex',100,'USD',5000000000,604800,'awaiting_payment',now()+interval '15 minutes')",[order,customer,randomUUID()]);
  const started=await beginProviderPayment(pool,customer,order,randomUUID(),site,'PZW211',eligibility,adapter);
  assert.equal(started.state,'pending');
  const attempt=started.attemptId;
  assert.equal((await pool.query('SELECT state FROM payment_reconciliation_jobs WHERE attempt_id=$1',[attempt])).rows[0].state,'pending');
  const payload={referenceNumber:reference,transactionStatus:'SUCCESS'};
  assert.equal((await app.inject({method:'POST',url:'/callbacks/pesepay',headers:{authorization:'forged'},payload})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/callbacks/pesepay',headers:{authorization:'integration-key'},payload:{referenceNumber:'unknown',transactionStatus:'SUCCESS'}})).statusCode,204);
  const callbacks=await Promise.all(Array.from({length:8},()=>app.inject({method:'POST',url:'/callbacks/pesepay',headers:{authorization:'integration-key'},payload})));
  assert.ok(callbacks.every(x=>x.statusCode===204));
  assert.equal((await pool.query('SELECT requested_version::int FROM payment_reconciliation_jobs WHERE attempt_id=$1',[attempt])).rows[0].requested_version,9);
  assert.equal(await processPaymentReconciliation(pool,adapter),true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM purchase_entitlements WHERE order_id=$1',[order])).rows[0].n,0);
  const pending=(await pool.query('SELECT state,last_result FROM payment_reconciliation_jobs WHERE attempt_id=$1',[attempt])).rows[0];assert.deepEqual(pending,{state:'pending',last_result:'pending'});
  await pool.query('UPDATE payment_reconciliation_jobs SET due_at=now() WHERE attempt_id=$1',[attempt]);
  const claims=await Promise.all(Array.from({length:8},()=>claimPaymentReconciliation(pool)));
  const lease=claims.find(Boolean);assert.equal(claims.filter(Boolean).length,1);
  assert.equal(await enqueuePaymentReference(pool,reference),true);
  assert.equal(await finishPaymentReconciliation(pool,lease,'pending'),true);
  assert.equal((await pool.query('SELECT state,attempt_count FROM payment_reconciliation_jobs WHERE attempt_id=$1',[attempt])).rows[0].state,'pending');
  const old=await claimPaymentReconciliation(pool);
  await pool.query("UPDATE payment_reconciliation_jobs SET lease_until=now()-interval '1 second' WHERE attempt_id=$1",[attempt]);
  const replacement=await claimPaymentReconciliation(pool);assert.ok(replacement);assert.notEqual(old.lease_token,replacement.lease_token);
  assert.equal(await finishPaymentReconciliation(pool,old,'fulfilled'),false);
  assert.equal(await finishPaymentReconciliation(pool,replacement,'error'),true);
  let job=(await pool.query('SELECT state,last_result,due_at>now() AS delayed FROM payment_reconciliation_jobs WHERE attempt_id=$1',[attempt])).rows[0];assert.deepEqual(job,{state:'pending',last_result:'error',delayed:true});
  await pool.query('UPDATE payment_reconciliation_jobs SET due_at=now(),attempt_count=9 WHERE attempt_id=$1',[attempt]);
  assert.equal(await processPaymentReconciliation(pool,{...adapter,check:async()=>{throw Error('timeout');}}),true);
  assert.equal((await pool.query('SELECT state FROM payment_reconciliation_jobs WHERE attempt_id=$1',[attempt])).rows[0].state,'dead');
  assert.equal(await enqueuePaymentReference(pool,reference),true);
  job=(await pool.query('SELECT state,attempt_count FROM payment_reconciliation_jobs WHERE attempt_id=$1',[attempt])).rows[0];assert.deepEqual(job,{state:'pending',attempt_count:0});
  status='verified_success';assert.equal(await processPaymentReconciliation(pool,adapter),true);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM purchase_entitlements WHERE order_id=$1',[order])).rows[0].n,1);
  assert.equal((await pool.query('SELECT state FROM payment_reconciliation_jobs WHERE attempt_id=$1',[attempt])).rows[0].state,'idle');
 } finally {
  await app.close();await pool.query('DELETE FROM verified_charges WHERE order_id=$1',[order]);await pool.query('DELETE FROM purchase_entitlements WHERE order_id=$1',[order]);await pool.query('DELETE FROM provider_payment_attempts WHERE order_id=$1',[order]);await pool.query('DELETE FROM purchase_orders WHERE id=$1',[order]);await pool.end();
 }
});
