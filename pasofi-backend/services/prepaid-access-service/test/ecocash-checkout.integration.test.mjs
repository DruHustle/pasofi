import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {EcoCashCheckoutAdapter,ECOCASH_METHOD,persistEcoCashContext,ecocashPresentation,payerNumber} from '../dist/ecocash-checkout.js';
import {beginProviderPayment,reconcileProviderPayment} from '../dist/payments.js';
import {processPaymentReconciliation} from '../dist/payment-reconciliation.js';
import {cleanupInvoiceEvidence} from './fixtures/invoices.mjs';

const url=process.env.PAMOFI_TEST_DATABASE_URL;
const merchant={environment:'sandbox',username:'synthetic-user',password:'synthetic-password',merchantCode:'001535',merchantPin:'0000',merchantNumber:'263788732685',terminalID:'UAT00003',location:'Synthetic site',superMerchantName:'ECOCASH',merchantName:'Pasofi sandbox fixture'};
const eligibility={method:ECOCASH_METHOD,merchantEnabledCodes:new Set(['ECOCASH']),siteQualifiedCodes:new Set(['ECOCASH'])};
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

// A synthetic EcoCash sandbox: records POSTs and answers lookups from `state`.
async function fixture(){
 const pool=new pg.Pool({connectionString:url,max:10}),customer=randomUUID(),site=randomUUID(),order=randomUUID(),key=randomUUID();
 await pool.query("INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at,purchase_mode) VALUES($1,$2,$3,'flex',125,'USD',5000000000,604800,'awaiting_payment',now()+interval '15 minutes','checkout')",[order,customer,randomUUID()]);
 const config={client:merchant,live:false,siteIds:new Set([site]),newCheckout:true,keys:{activeId:'k1',keys:{k1:randomBytes(32)}}};
 const state={posts:[],gets:0,charged:false,lookup:{},loseResponse:false,contextAtPost:null};
 const fetcher=async(target,init)=>{
  const body=init.body?JSON.parse(init.body):null;
  if(init.method==='POST'){
   // Record what a separate connection can see at the moment of the POST.
   state.contextAtPost=(await pool.query('SELECT count(*)::int AS n FROM ecocash_checkout_contexts WHERE attempt_id=$1',[body.clientCorrelator])).rows[0].n;
   state.posts.push(body);
   if(state.loseResponse)throw Error('synthetic connection lost after EcoCash accepted the charge');
   return json({clientCorrelator:body.clientCorrelator,referenceCode:body.referenceCode,endUserId:body.endUserId,ecocashReference:'MP261123.0001.SYNTH01',transactionOperationStatus:'PENDING SUBSCRIBER VALIDATION'});
  }
  state.gets++;
  const [,endUserId,correlator]=/\/payment\/v1\/([0-9]+)\/transactions\/amount\/([0-9a-f-]+)$/.exec(String(target))??[];
  const posted=state.posts.find(p=>p.clientCorrelator===correlator);
  if(!posted||posted.endUserId!==endUserId)return json({error:'not found'},404);
  if(!state.charged)return json({clientCorrelator:correlator,referenceCode:correlator,endUserId,ecocashReference:'MP261123.0001.SYNTH01',transactionOperationStatus:'PENDING SUBSCRIBER VALIDATION',responseCode:'00'});
  return json({clientCorrelator:correlator,referenceCode:correlator,endUserId,ecocashReference:'MP261123.0001.SYNTH01',transactionOperationStatus:'Charged',responseCode:'00',merchantCode:merchant.merchantCode,
   paymentAmount:{totalAmountCharged:'1.25',charginginformation:{amount:1.25,currency:'USD',description:posted.paymentAmount.charginginformation.description}},...state.lookup});
 };
 const adapter=new EcoCashCheckoutAdapter(config,pool,fetcher);
 const start=(msisdn='0773047653')=>beginProviderPayment(pool,customer,order,key,site,'ECOCASH',eligibility,adapter,(client,attemptId)=>persistEcoCashContext(client,config,attemptId,payerNumber(msisdn)));
 const count=async(table,column='order_id')=>(await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`,[order])).rows[0].n;
 async function cleanup(){
  const attempts=(await pool.query('SELECT id FROM provider_payment_attempts WHERE order_id=$1',[order])).rows.map(r=>r.id);
  await pool.query('DELETE FROM payment_reconciliation_jobs WHERE attempt_id=ANY($1::uuid[])',[attempts]);
  await pool.query('DELETE FROM ecocash_checkout_contexts WHERE attempt_id=ANY($1::uuid[])',[attempts]);
  await pool.query('DELETE FROM payment_reviews WHERE order_id=$1',[order]);await pool.query('DELETE FROM verified_charges WHERE order_id=$1',[order]);
  await pool.query('DELETE FROM purchase_entitlements WHERE order_id=$1',[order]);await pool.query('DELETE FROM provider_payment_attempts WHERE order_id=$1',[order]);
  await cleanupInvoiceEvidence(pool,{orderIds:[order]});await pool.query('DELETE FROM purchase_orders WHERE id=$1',[order]);await pool.end();
 }
 return {pool,customer,order,key,adapter,state,start,count,cleanup};
}

test('ECO-003/004 payer context is committed before the single POST; a lost response is recovered by lookup and fulfils once',{skip:!url},async()=>{
 const f=await fixture();try{
  f.state.loseResponse=true;
  const first=await f.start();
  assert.equal(f.state.posts.length,1);assert.equal(f.state.contextAtPost,1,'the sealed payer context was committed before the provider POST');
  assert.equal(first.state,'pending','a lost initiation response proceeds to read-only lookup, never to failure');
  const sealed=(await f.pool.query('SELECT payer_cipher,payer_hint,environment,merchant_code FROM ecocash_checkout_contexts WHERE attempt_id=$1',[first.attemptId])).rows[0];
  assert.equal(sealed.payer_hint,'653');assert.equal(sealed.environment,'sandbox');assert.equal(sealed.merchant_code,'001535');
  assert.ok(!sealed.payer_cipher.toString('utf8').includes('773047653'),'the payer number is not stored in clear');
  const retries=await Promise.all(Array.from({length:4},()=>f.start()));
  assert.ok(retries.every(r=>r.attemptId===first.attemptId));assert.equal(f.state.posts.length,1,'an ambiguous charge is never POSTed again');
  assert.deepEqual(await ecocashPresentation(f.pool,f.customer,first.attemptId),{provider:'ecocash',payerHint:'653',awaitingApproval:true});
  assert.equal(await ecocashPresentation(f.pool,randomUUID(),first.attemptId),null,'another customer cannot read the payment state');
  assert.equal((await reconcileProviderPayment(f.pool,first.attemptId,f.adapter)).state,'unable_to_verify','awaiting phone approval grants nothing');
  assert.equal(await f.count('purchase_entitlements'),0);
  f.state.charged=true;
  const outcomes=await Promise.all(Array.from({length:5},()=>reconcileProviderPayment(f.pool,first.attemptId,f.adapter)));
  assert.ok(outcomes.every(o=>['fulfilled','previously_verified'].includes(o.state)),JSON.stringify(outcomes));
  assert.equal(await f.count('purchase_entitlements'),1);assert.equal(await f.count('verified_charges'),1);
  const attempt=(await f.pool.query('SELECT provider,state FROM provider_payment_attempts WHERE id=$1',[first.attemptId])).rows[0];
  assert.deepEqual(attempt,{provider:'ecocash_test',state:'succeeded'});
  assert.equal((await f.pool.query('SELECT ecocash_reference FROM ecocash_checkout_contexts WHERE attempt_id=$1',[first.attemptId])).rows[0].ecocash_reference,'MP261123.0001.SYNTH01');
  assert.equal(f.state.posts.length,1);
 }finally{await f.cleanup();}
});

test('ECO-006 a Charged lookup without matching provider amount, currency, merchant or reference never fulfils',{skip:!url},async()=>{
 for(const lookup of [{paymentAmount:{totalAmountCharged:'1.20',charginginformation:{amount:1.2,currency:'USD'}}},{paymentAmount:{charginginformation:{amount:1.25,currency:'ZWG'}}},
  {paymentAmount:undefined},{merchantCode:'999999'},{merchantCode:undefined},{ecocashReference:'MP261123.9999.OTHER'}]){
  const f=await fixture();try{
   const started=await f.start();f.state.charged=true;f.state.lookup=lookup;
   assert.equal((await reconcileProviderPayment(f.pool,started.attemptId,f.adapter)).state,'unable_to_verify',JSON.stringify(lookup));
   assert.equal(await f.count('purchase_entitlements'),0);assert.equal(await f.count('verified_charges'),0);
  }finally{await f.cleanup();}
 }
});

test('ECO-007 the EcoCash worker claims only EcoCash jobs and duplicate processing issues one bundle',{skip:!url},async()=>{
 const f=await fixture();try{
  const started=await f.start();f.state.charged=true;
  assert.ok((await f.pool.query('SELECT 1 FROM payment_reconciliation_jobs WHERE attempt_id=$1',[started.attemptId])).rowCount,'initiation schedules lookup reconciliation');
  await f.pool.query("UPDATE payment_reconciliation_jobs SET due_at=now()-interval '1 second' WHERE attempt_id=$1",[started.attemptId]);
  let claimed=false;for(let i=0;i<20&&!claimed;i++){await processPaymentReconciliation(f.pool,f.adapter);claimed=(await f.count('purchase_entitlements'))===1;}
  assert.ok(claimed,'the EcoCash reconciliation worker fulfilled the verified charge');
  await Promise.all(Array.from({length:3},()=>reconcileProviderPayment(f.pool,started.attemptId,f.adapter)));
  assert.equal(await f.count('purchase_entitlements'),1);
  const invoice=(await f.pool.query('SELECT simulation FROM paid_invoices WHERE order_id=$1',[f.order])).rows[0];
  assert.equal(invoice?.simulation,true,'sandbox EcoCash invoices are marked simulated');
 }finally{await f.cleanup();}
});

test('a context from another merchant or environment is refused before any provider call',{skip:!url},async()=>{
 const f=await fixture();try{
  const started=await f.start();const gets=f.state.gets;
  await f.pool.query("UPDATE ecocash_checkout_contexts SET merchant_code='OTHER' WHERE attempt_id=$1",[started.attemptId]);
  assert.equal((await reconcileProviderPayment(f.pool,started.attemptId,f.adapter)).state,'unable_to_verify');
  assert.equal(f.state.gets,gets,'no lookup is sent with a mismatched context');
 }finally{await f.cleanup();}
});
