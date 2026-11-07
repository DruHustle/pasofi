import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {StripeAdapter,enqueueStripeEvent,stripePresentation} from '../dist/stripe.js';
import {beginProviderPayment,reconcileProviderPayment} from '../dist/payments.js';
import {processPaymentReconciliation} from '../dist/payment-reconciliation.js';
import {cleanupInvoiceEvidence} from './fixtures/invoices.mjs';

const url=process.env.PAMOFI_TEST_DATABASE_URL;
const eligibility={method:{active:true,code:'STRIPE_CARD',currencies:['USD'],minimumAmount:'0.50',maximumAmount:'999999.99'},merchantEnabledCodes:new Set(['STRIPE_CARD']),siteQualifiedCodes:new Set(['STRIPE_CARD'])};
async function fixture(){
 const pool=new pg.Pool({connectionString:url,max:10}),customer=randomUUID(),site=randomUUID(),order=randomUUID(),key=randomUUID();
 await pool.query("INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at,purchase_mode) VALUES($1,$2,$3,'flex',500,'USD',5000000000,604800,'awaiting_payment',now()+interval '15 minutes','checkout')",[order,customer,randomUUID()]);
 const config={secretKey:'synthetic',publishableKey:'synthetic-publishable',webhookSecret:'synthetic-webhook',accountId:'acct_SyntheticMerchant123',country:'GB',live:false,siteIds:new Set([site]),applePayMerchantId:null,googlePay:false};
 const intents=new Map(),calls=[];let lostResponse=false;
 const client={accounts:{retrieve:async()=>({id:config.accountId,country:'GB',charges_enabled:true})},paymentIntents:{
  create:async(body,options)=>{
   calls.push(options.idempotencyKey);
   if(!intents.has(options.idempotencyKey))intents.set(options.idempotencyKey,{id:`pi_${randomUUID().replaceAll('-','')}`,object:'payment_intent',amount:body.amount,amount_received:0,currency:body.currency,livemode:false,capture_method:'automatic',payment_method_types:['card'],status:'requires_payment_method',metadata:body.metadata,latest_charge:null});
   const value=intents.get(options.idempotencyKey);value.client_secret=`${value.id}_secret_SYNTHETIC`;
   if(lostResponse)throw Error('synthetic connection lost after Stripe accepted creation');
   return value;
  },retrieve:async(reference)=>{const found=[...intents.values()].find(i=>i.id===reference);if(!found)throw Error('not found');return found;}
 }};
 const adapter=new StripeAdapter(config,client);
 function succeed(){const value=[...intents.values()][0];value.status='succeeded';value.amount_received=500;value.latest_charge={id:'ch_SyntheticCharge123',payment_intent:value.id,amount:500,currency:'usd',livemode:false,paid:true,captured:true,refunded:false,amount_refunded:0,disputed:false};return value;}
 function event(type='payment_intent.succeeded'){const value=[...intents.values()][0];return {id:`evt_${randomUUID().replaceAll('-','')}`,type,livemode:false,data:{object:{id:value.id}}};}
 async function start(){return beginProviderPayment(pool,customer,order,key,site,'STRIPE_CARD',eligibility,adapter);}
 async function cleanup(){
  const references=[...intents.values()].map(i=>i.id);await pool.query('DELETE FROM stripe_webhook_events WHERE provider_reference=ANY($1::text[])',[references]);
  await pool.query('DELETE FROM payment_reviews WHERE order_id=$1',[order]);await pool.query('DELETE FROM verified_charges WHERE order_id=$1',[order]);
  await pool.query('DELETE FROM purchase_entitlements WHERE order_id=$1',[order]);await pool.query('DELETE FROM provider_payment_attempts WHERE order_id=$1',[order]);
  await cleanupInvoiceEvidence(pool,{orderIds:[order]});await pool.query('DELETE FROM purchase_orders WHERE id=$1',[order]);await pool.end();
 }
 return {pool,customer,site,order,key,adapter,intents,calls,start,succeed,event,cleanup,loseResponse:value=>{lostResponse=value;}};
}

test('Stripe concurrent retry, duplicate webhook and reordered delivery fulfill one original purchase',{skip:!url},async()=>{
 const f=await fixture();try{
  const starts=await Promise.all(Array.from({length:5},()=>f.start()));const attempt=starts[0].attemptId;
  assert.equal(new Set(starts.map(r=>r.attemptId)).size,1);assert.equal(f.intents.size,1);assert.equal(new Set(f.calls).size,1);
  const own=await stripePresentation(f.pool,f.customer,attempt,f.adapter);assert.ok(own?.clientSecret);
  assert.equal(await stripePresentation(f.pool,randomUUID(),attempt,f.adapter),null,'another customer cannot obtain the client secret');
  f.succeed();const event=f.event();await Promise.all(Array.from({length:5},()=>enqueueStripeEvent(f.pool,f.adapter,event)));
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM stripe_webhook_events WHERE event_id=$1',[event.id])).rows[0].n,1);
  assert.equal((await f.pool.query('SELECT requested_version::text AS n FROM payment_reconciliation_jobs WHERE attempt_id=$1',[attempt])).rows[0].n,'2');
  const outcomes=await Promise.all(Array.from({length:5},()=>reconcileProviderPayment(f.pool,attempt,f.adapter)));assert.ok(outcomes.every(r=>r.state==='fulfilled'));
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM purchase_entitlements WHERE order_id=$1',[f.order])).rows[0].n,1);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM verified_charges WHERE order_id=$1',[f.order])).rows[0].n,1);
  await enqueueStripeEvent(f.pool,f.adapter,f.event('payment_intent.payment_failed'));
  assert.equal((await reconcileProviderPayment(f.pool,attempt,f.adapter)).state,'fulfilled','an older failure event cannot reverse current verified success');
  assert.equal(await stripePresentation(f.pool,f.customer,attempt,f.adapter),null,'a paid intent cannot be presented for a second payment');
 }finally{await f.cleanup();}
});

test('verified webhook recovers the original Stripe reference after a lost create response without creating another intent',{skip:!url},async()=>{
 const f=await fixture();try{
  f.loseResponse(true);const started=await f.start();assert.equal(started.state,'unknown');assert.equal(f.intents.size,1);
  assert.equal((await f.pool.query('SELECT provider_reference FROM provider_payment_attempts WHERE id=$1',[started.attemptId])).rows[0].provider_reference,null);
  f.succeed();await enqueueStripeEvent(f.pool,f.adapter,f.event());
  assert.equal((await reconcileProviderPayment(f.pool,started.attemptId,f.adapter)).state,'fulfilled');assert.equal(f.calls.length,1);
  const retry=await f.start();assert.equal(retry.attemptId,started.attemptId);assert.equal(retry.state,'succeeded');assert.equal(f.calls.length,1);
 }finally{await f.cleanup();}
});

test('resending an accepted Stripe event recovers an exhausted job without disturbing an active lease',{skip:!url},async()=>{
 const f=await fixture();try{
  const {attemptId}=await f.start();f.succeed();const event=f.event();await enqueueStripeEvent(f.pool,f.adapter,event);
  // The accepted event may outlive an outage that exhausts all worker retries.
  await f.pool.query("UPDATE payment_reconciliation_jobs SET state='dead',attempt_count=10,last_result='error' WHERE attempt_id=$1",[attemptId]);
  await Promise.all(Array.from({length:5},()=>enqueueStripeEvent(f.pool,f.adapter,event)));
  const job=(await f.pool.query('SELECT state,attempt_count,requested_version::text FROM payment_reconciliation_jobs WHERE attempt_id=$1',[attemptId])).rows[0];
  assert.deepEqual(job,{state:'pending',attempt_count:0,requested_version:'3'});
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM stripe_webhook_events WHERE event_id=$1',[event.id])).rows[0].n,1);
  const token=randomUUID();await f.pool.query("UPDATE payment_reconciliation_jobs SET state='leased',lease_token=$2,lease_version=requested_version,lease_until=now()+interval '30 seconds',attempt_count=1 WHERE attempt_id=$1",[attemptId,token]);
  await enqueueStripeEvent(f.pool,f.adapter,event);
  const leased=(await f.pool.query('SELECT state,lease_token,requested_version::text,attempt_count FROM payment_reconciliation_jobs WHERE attempt_id=$1',[attemptId])).rows[0];
  assert.deepEqual(leased,{state:'leased',lease_token:token,requested_version:'3',attempt_count:1});
  await f.pool.query("UPDATE payment_reconciliation_jobs SET state='pending',lease_token=NULL,lease_version=NULL,lease_until=NULL WHERE attempt_id=$1",[attemptId]);
  assert.equal(await processPaymentReconciliation(f.pool,f.adapter),true);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM purchase_entitlements WHERE order_id=$1',[f.order])).rows[0].n,1);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM paid_invoices WHERE order_id=$1 AND simulation=true',[f.order])).rows[0].n,1);
  await enqueueStripeEvent(f.pool,f.adapter,event);
  assert.equal(await processPaymentReconciliation(f.pool,f.adapter),false,'a completed duplicate does not re-arm an idle job');
 }finally{await f.cleanup();}
});

test('Stripe lost-response retries use the original key only inside its documented retention window',{skip:!url},async()=>{
 const f=await fixture();try{
  f.loseResponse(true);const started=await f.start();await f.start();assert.equal(f.intents.size,1);assert.equal(f.calls.length,2);assert.equal(new Set(f.calls).size,1);
  await f.pool.query("UPDATE provider_payment_attempts SET created_at=now()-interval '24 hours' WHERE id=$1",[started.attemptId]);
  await f.start();assert.equal(f.calls.length,2,'an expired provider idempotency key must never create a replacement');
  await assert.rejects(beginProviderPayment(f.pool,f.customer,f.order,randomUUID(),f.site,'STRIPE_CARD',eligibility,f.adapter),{code:'payment_pending'});
 }finally{await f.cleanup();}
});

test('Stripe webhook term mismatch cannot bind, enqueue or fulfill an unknown attempt',{skip:!url},async()=>{
 const f=await fixture();try{
  f.loseResponse(true);const started=await f.start();const intent=f.succeed();intent.metadata.pasofi_customer_id=randomUUID();
  await assert.rejects(enqueueStripeEvent(f.pool,f.adapter,f.event()),/stripe_event_terms_mismatch/);
  assert.equal((await f.pool.query('SELECT provider_reference FROM provider_payment_attempts WHERE id=$1',[started.attemptId])).rows[0].provider_reference,null);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM stripe_webhook_events WHERE provider_reference=$1',[intent.id])).rows[0].n,0);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM purchase_entitlements WHERE order_id=$1',[f.order])).rows[0].n,0);
 }finally{await f.cleanup();}
});
