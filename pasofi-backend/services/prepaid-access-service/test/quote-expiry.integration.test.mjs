import {cleanupInvoiceEvidence} from './fixtures/invoices.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {beginProviderPayment,expireUnusedOrder} from '../dist/payments.js';

const url=process.env.PAMOFI_TEST_DATABASE_URL;
const eligibility={method:{active:true,code:'PZW211',currencies:['USD'],minimumAmount:1,maximumAmount:500},merchantEnabledCodes:new Set(['PZW211']),siteQualifiedCodes:new Set(['PZW211'])};
async function fixture(){
 const applicationName=`quote-expiry-${randomUUID()}`,pool=new pg.Pool({connectionString:url,max:10,application_name:applicationName});
 const order=randomUUID(),customer=randomUUID(),site=randomUUID();
 await pool.query("INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at,purchase_mode) VALUES($1,$2,$3,'flex',100,'USD',5000000000,604800,'awaiting_payment',now()+interval '15 minutes','checkout')",[order,customer,randomUUID()]);
 return {pool,order,customer,site,applicationName,cleanup:async()=>{
  await pool.query('DELETE FROM provider_payment_attempts WHERE order_id=$1',[order]);
  await cleanupInvoiceEvidence(pool,{orderIds:[order]});await pool.query('DELETE FROM purchase_orders WHERE id=$1',[order]);
  await pool.end();
 }};
}
test('unused quote expiry is owned, server-timed, durable and idempotent under concurrent retries',{skip:!url},async()=>{
 const f=await fixture();let calls=0;
 const adapter={provider:'pesepay',initiate:async()=>{calls++;return {state:'unknown'};},check:async()=>({state:'unknown'})};
 try{
  await assert.rejects(expireUnusedOrder(f.pool,randomUUID(),f.order),{code:'order_not_found'});
  await assert.rejects(expireUnusedOrder(f.pool,f.customer,f.order),{code:'quote_still_valid'});
  await f.pool.query("UPDATE purchase_orders SET quote_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[f.order]);
  const results=await Promise.all(Array.from({length:8},()=>expireUnusedOrder(f.pool,f.customer,f.order)));
  assert.equal(results.filter(r=>!r.replayed).length,1);
  assert.ok(results.every(r=>r.orderId===f.order&&r.state==='expired_unused'&&r.safeToRequote));
  assert.ok((await f.pool.query('SELECT expired_unused_at FROM purchase_orders WHERE id=$1',[f.order])).rows[0].expired_unused_at);
  // The fence survives changes to wall-clock eligibility, and also protects
  // older initiators which do not know about the new application-level guard.
  await f.pool.query("UPDATE purchase_orders SET quote_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",[f.order]);
  await assert.rejects(beginProviderPayment(f.pool,f.customer,f.order,randomUUID(),f.site,'PZW211',eligibility,adapter),{code:'order_not_payable'});
  await assert.rejects(f.pool.query("INSERT INTO provider_payment_attempts(id,order_id,customer_id,request_key,site_id,method_code,provider,state) VALUES($1,$2,$3,$4,$5,'PZW211','pesepay','initiating')",[randomUUID(),f.order,f.customer,randomUUID(),f.site]),{code:'23514',constraint:'no_payment_attempt_for_expired_unused_order'});
  assert.equal(calls,0);
  assert.equal((await f.pool.query('SELECT id FROM provider_payment_attempts WHERE order_id=$1',[f.order])).rowCount,0);
 }finally{await f.cleanup();}
});

test('initiation which commits first prevents quote disposal while its provider outcome is unknown',{skip:!url},async()=>{
 const f=await fixture();let enter,release,pending,calls=0;
 const entered=new Promise(resolve=>{enter=resolve;}),gate=new Promise(resolve=>{release=resolve;});
 const adapter={provider:'pesepay',initiate:async()=>{calls++;enter();await gate;return {state:'unknown'};},check:async()=>({state:'unknown'})};
 try{
  pending=beginProviderPayment(f.pool,f.customer,f.order,randomUUID(),f.site,'PZW211',eligibility,adapter);
  await entered;
  await f.pool.query("UPDATE purchase_orders SET quote_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[f.order]);
  await assert.rejects(expireUnusedOrder(f.pool,f.customer,f.order),{code:'payment_attempt_exists'});
  release();assert.equal((await pending).state,'unknown');
  await assert.rejects(expireUnusedOrder(f.pool,f.customer,f.order),{code:'payment_attempt_exists'});
  await f.pool.query("UPDATE provider_payment_attempts SET state='failed' WHERE order_id=$1",[f.order]);
  await assert.rejects(expireUnusedOrder(f.pool,f.customer,f.order),{code:'payment_attempt_exists'});
  assert.equal((await f.pool.query('SELECT expired_unused_at FROM purchase_orders WHERE id=$1',[f.order])).rows[0].expired_unused_at,null);
  assert.equal(calls,1);
 }finally{release();if(pending)await pending.catch(()=>{});await f.cleanup();}
});

test('an initiation begun before expiry cannot charge after concurrent unused-quote closure',{skip:!url},async()=>{
 const f=await fixture(),blocker=await f.pool.connect(),key=randomUUID();let pending,calls=0;
 const adapter={provider:'pesepay',initiate:async()=>{calls++;return {state:'unknown'};},check:async()=>({state:'unknown'})};
 try{
  await blocker.query('BEGIN');
  await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${f.customer}:${key}`]);
  pending=beginProviderPayment(f.pool,f.customer,f.order,key,f.site,'PZW211',eligibility,adapter).then(value=>({value}),error=>({error}));
  let waiter;
  const deadline=Date.now()+3000;
  while(!waiter&&Date.now()<deadline){
   waiter=(await f.pool.query("SELECT pid FROM pg_stat_activity WHERE application_name=$1 AND state='active' AND wait_event_type='Lock' AND wait_event='advisory'",[f.applicationName])).rows[0];
   if(!waiter)await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.ok(waiter,'the old initiation transaction must already be waiting');
  // PostgreSQL now() is transaction-start time. Make the quote expired in real
  // time but still valid to that waiting transaction, without timing sleeps.
  const changed=await f.pool.query("UPDATE purchase_orders SET quote_expires_at=(SELECT xact_start+interval '1 microsecond' FROM pg_stat_activity WHERE pid=$2) WHERE id=$1 RETURNING quote_expires_at<=clock_timestamp() AS expired",[f.order,waiter.pid]);
  assert.equal(changed.rows[0].expired,true);
  assert.equal((await expireUnusedOrder(f.pool,f.customer,f.order)).safeToRequote,true);
  await blocker.query('COMMIT');
  const outcome=await pending;
  assert.equal(outcome.error?.code,'order_not_payable');
  assert.equal(calls,0);
  assert.equal((await f.pool.query('SELECT id FROM provider_payment_attempts WHERE order_id=$1',[f.order])).rowCount,0);
 }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;await f.cleanup();}
});
