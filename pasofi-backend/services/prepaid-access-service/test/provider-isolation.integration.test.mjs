import {cleanupInvoiceEvidence} from './fixtures/invoices.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {buildApp} from '../dist/app.js';
import {beginProviderPayment,reconcileProviderPayment} from '../dist/payments.js';
import {processPaymentReconciliation} from '../dist/payment-reconciliation.js';

const url=process.env.PAMOFI_TEST_DATABASE_URL;
async function fixture(){
 const pool=new pg.Pool({connectionString:url,max:4}),customer=randomUUID(),site=randomUUID(),orders=[randomUUID(),randomUUID(),randomUUID()];
 for(const id of orders)await pool.query("INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at,purchase_mode) VALUES($1,$2,$3,'flex',100,'USD',5000000000,604800,'awaiting_payment',now()+interval '15 minutes','checkout')",[id,customer,randomUUID()]);
 const attempts=[];
 for(const [index,provider]of ['pesepay','mock','pesepay'].entries()){
  const id=randomUUID(),key=randomUUID(),reference=`${provider==='mock'?'MOCK':'PP'}-${randomUUID()}`;
  await pool.query("INSERT INTO provider_payment_attempts(id,order_id,customer_id,request_key,site_id,method_code,provider,state,provider_reference) VALUES($1,$2,$3,$4,$5,'TESTPAY',$6,'pending',$7)",[id,orders[index],customer,key,site,provider,reference]);
  attempts.push({id,key,reference,provider,order:orders[index]});
 }
 return {pool,customer,site,orders,attempts,cleanup:async()=>{
  await pool.query('DELETE FROM payment_reviews WHERE order_id=ANY($1::uuid[])',[orders]);
  await pool.query('DELETE FROM verified_charges WHERE order_id=ANY($1::uuid[])',[orders]);
  await pool.query('DELETE FROM purchase_entitlements WHERE order_id=ANY($1::uuid[])',[orders]);
  await pool.query('DELETE FROM provider_payment_attempts WHERE order_id=ANY($1::uuid[])',[orders]);
  await cleanupInvoiceEvidence(pool,{orderIds:orders});await pool.query('DELETE FROM purchase_orders WHERE id=ANY($1::uuid[])',[orders]);await pool.end();
 }};
}
test('mock reconciliation cannot claim, query or fulfill historical Pesepay attempts',{skip:!url},async()=>{
 const f=await fixture();let checks=0,initiations=0;
 const adapter={provider:'mock',initiate:async()=>{initiations++;return {state:'unknown'};},check:async terms=>{checks++;assert.equal(terms.referenceNumber,f.attempts[1].reference);return {state:'pending',providerStatus:'MOCK_pending'};}};
 try{
  for(const a of f.attempts)await f.pool.query('INSERT INTO payment_reconciliation_jobs(attempt_id) VALUES($1)',[a.id]);
  const historical=f.attempts[0],eligibility={method:{active:true,code:'TESTPAY',currencies:['USD'],minimumAmount:1,maximumAmount:500},merchantEnabledCodes:new Set(['TESTPAY']),siteQualifiedCodes:new Set(['TESTPAY'])};
  await assert.rejects(beginProviderPayment(f.pool,f.customer,historical.order,historical.key,f.site,'TESTPAY',eligibility,adapter),{code:'idempotency_conflict'});
  await assert.rejects(reconcileProviderPayment(f.pool,historical.id,adapter),{code:'provider_mismatch'});
  assert.equal(checks,0);assert.equal(initiations,0);
  assert.equal(await processPaymentReconciliation(f.pool,adapter),true);assert.equal(checks,1);
  assert.equal(await processPaymentReconciliation(f.pool,adapter),false);assert.equal(checks,1);
  const legacy=await f.pool.query('SELECT j.state,j.attempt_count,j.last_result FROM payment_reconciliation_jobs j JOIN provider_payment_attempts a ON a.id=j.attempt_id WHERE a.customer_id=$1 AND a.provider=\'pesepay\'',[f.customer]);
  assert.equal(legacy.rowCount,2);assert.ok(legacy.rows.every(j=>j.state==='pending'&&j.attempt_count===0&&j.last_result===null));
  assert.equal((await f.pool.query('SELECT id FROM purchase_entitlements WHERE customer_id=$1',[f.customer])).rowCount,0);
 }finally{await f.cleanup();}
});
test('authenticated historical payment status remains available while all digital checkout is disabled',{skip:!url},async t=>{
 const f=await fixture(),env={DATABASE_URL:url,APP_ENV:'demo',NODE_ENV:'development',PAMOFI_PAYMENTS_ENABLED:'false',IDENTITY_URL:'http://identity.test',INTERNAL_IDENTITY_SECRET:'test_only_history_identity_secret_at_least_32_bytes',PAMOFI_COMMERCE_ENABLED:'false',OUTBOX_DISPATCH_ENABLED:'false',PAMOFI_SMS_DELIVERY_ENABLED:'false'};
 const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
 const other=randomUUID();
 t.mock.method(globalThis,'fetch',async(_url,options)=>['customer=owner','customer=other'].includes(options.headers.cookie)?new Response(JSON.stringify({customerId:options.headers.cookie==='customer=owner'?f.customer:other}),{headers:{'content-type':'application/json'}}):new Response('{}',{status:401}));
 const app=buildApp();try{
  assert.equal((await app.inject({url:'/v1/capabilities'})).json().paymentCheckout,false);
  assert.equal((await app.inject({url:`/v1/orders/${f.orders[0]}/status`})).statusCode,401);
  assert.equal((await app.inject({url:`/v1/orders/${f.orders[0]}/status`,headers:{cookie:'customer=other'}})).statusCode,404);
  for(const [index,simulation]of [[0,false],[1,true]]){
   const r=await app.inject({url:`/v1/orders/${f.orders[index]}/status`,headers:{cookie:'customer=owner'}});
   assert.equal(r.statusCode,200);assert.equal(r.json().simulation,simulation);assert.equal(r.json().attempts[0].provider,f.attempts[index].provider);assert.equal(r.json().fulfillmentState,'unconfirmed');assert.equal(r.json().entitlementId,null);
  }
  const mutation=await app.inject({method:'POST',url:`/v1/orders/${f.orders[0]}/checkout`,headers:{cookie:'customer=owner'},payload:{}});assert.equal(mutation.statusCode,404);
 }finally{await app.close();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await f.cleanup();}
});
test('provider migration relabels only positively identified historical simulator records',{skip:!url},async()=>{
 const f=await fixture(),client=await f.pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("UPDATE provider_payment_attempts SET provider='pesepay' WHERE id=$1",[f.attempts[1].id]);
  await client.query('INSERT INTO mock_provider_payments(reference,order_id) VALUES($1,$2),($3,$4)',[f.attempts[1].reference,f.orders[1],f.attempts[2].reference,f.orders[0]]);
  await client.query(await readFile(new URL('../migrations/026_provider_identity.sql',import.meta.url),'utf8'));
  const rows=await client.query('SELECT id,provider FROM provider_payment_attempts WHERE customer_id=$1',[f.customer]);
  for(const a of f.attempts)assert.equal(rows.rows.find(r=>r.id===a.id).provider,a.provider);
  await client.query('ROLLBACK');
 }finally{await client.query('ROLLBACK');client.release();await f.cleanup();}
});
