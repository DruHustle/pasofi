import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {beginProviderPayment} from '../dist/payments.js';
import {StripeAdapter,stripePresentation} from '../dist/stripe.js';

// Exercise the actual coordinator and Stripe adapter. Persistence and the Stripe
// transport are isolated fixtures; no account, credential, network or charge is used.
function fixture({reference=null,ageSeconds=60}={}){
 const customerId=randomUUID(),orderId=randomUUID(),requestKey=randomUUID(),siteId=randomUUID(),attemptId=randomUUID();
 const order={id:orderId,customer_id:customerId,price_minor:500,currency:'USD',status:'awaiting_payment',quote_valid:true,expired_unused_at:null};
 const attempt={id:attemptId,order_id:orderId,customer_id:customerId,request_key:requestKey,site_id:siteId,method_code:'STRIPE_CARD',provider:'stripe_test',
  state:reference?'pending':'unknown',provider_reference:reference,redirect_url:null,created_at:new Date(Date.now()-ageSeconds*1000).toISOString()};
 const events=[],writes=[];
 const query=async(sql,args=[])=>{
  if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK'||sql.startsWith('SELECT pg_advisory'))return {rows:[],rowCount:0};
  if(sql.startsWith('SELECT *,quote_expires_at'))return args[0]===orderId&&args[1]===customerId?{rows:[{...order}],rowCount:1}:{rows:[],rowCount:0};
  if(sql.startsWith('SELECT * FROM provider_payment_attempts WHERE customer_id'))return {rows:[{...attempt}],rowCount:1};
  if(sql.startsWith('WITH updated AS')){writes.push(args);return {rows:[{state:args[1],redirect_url:args[3]}],rowCount:1};}
  if(sql.startsWith('SELECT a.*,o.price_minor,o.currency'))return args[0]===attemptId&&args[1]===customerId?{rows:[{...attempt,price_minor:500,currency:'USD'}],rowCount:1}:{rows:[],rowCount:0};
  throw Error('Unexpected fixture query: '+sql.slice(0,90));
 };
 const pool={query,connect:async()=>({query,release(){}})};
 const config={secretKey:'synthetic',publishableKey:'synthetic-publishable',webhookSecret:'synthetic-webhook',accountId:'acct_SyntheticMerchant123',country:'GB',live:false,
  siteIds:new Set([siteId]),applePayMerchantId:'merchant.com.example.synthetic',googlePay:true};
 const intent={id:reference??'pi_SyntheticReplay123',amount:500,currency:'usd',capture_method:'automatic',payment_method_types:['card'],livemode:false,status:'requires_payment_method',
  amount_received:0,latest_charge:null,client_secret:`${reference??'pi_SyntheticReplay123'}_secret_SYNTHETIC`,
  metadata:{pasofi_attempt_id:attemptId,pasofi_order_id:orderId,pasofi_customer_id:customerId,pasofi_site_id:siteId,pasofi_method_code:'STRIPE_CARD'}};
 const client={accounts:{retrieve:async()=>{events.push({operation:'account'});return {id:config.accountId,country:'GB',charges_enabled:true};}},
  paymentIntents:{create:async(body,options)=>{events.push({operation:'create',body,options});return intent;},retrieve:async id=>{events.push({operation:'retrieve',id});return intent;}}};
 const adapter=new StripeAdapter(config,client);
 const eligibility={method:{active:true,code:'STRIPE_CARD',currencies:['USD'],minimumAmount:'0.50',maximumAmount:'999999.99'},
  merchantEnabledCodes:new Set(['STRIPE_CARD']),siteQualifiedCodes:new Set(['STRIPE_CARD'])};
 const start=()=>beginProviderPayment(pool,customerId,orderId,requestKey,siteId,'STRIPE_CARD',eligibility,adapter);
 const terms={referenceNumber:intent.id,attemptId,orderId,customerId,siteId,methodCode:'STRIPE_CARD',amountMinor:500,currency:'USD'};
 return {pool,order,attempt,adapter,config,eligibility,events,writes,intent,terms,start};
}

const revocations=[
 ['site qualification',f=>{f.config.siteIds.delete(f.attempt.site_id);f.config.siteIds.add(randomUUID());f.eligibility.siteQualifiedCodes.clear();}],
 ['merchant card and wallet method',f=>f.eligibility.merchantEnabledCodes.clear()],
 ['active card and wallet method',f=>{f.eligibility.method.active=false;}],
 ['method identity',f=>{f.eligibility.method.code='OTHER_METHOD';}],
 ['currency eligibility',f=>{f.eligibility.method.currencies=['EUR'];}],
 ['amount eligibility',f=>{f.eligibility.method.maximumAmount='4.99';}],
];
for(const [name,revoke]of revocations)test(`ambiguous Stripe retry refuses removed ${name} before any provider request`,async()=>{
 const f=fixture();revoke(f);
 await assert.rejects(f.start(),{code:'method_not_qualified'});
 assert.equal(f.events.length,0,'an unknown original outcome is not authorization for a new provider request');
 assert.equal(f.writes.length,0,'retain the unresolved attempt for recovery');
});

test('still-qualified ambiguous retry preserves the original intent key and server-bound purchase terms',async()=>{
 const f=fixture(),result=await f.start(),creates=f.events.filter(e=>e.operation==='create');
 assert.equal(result.attemptId,f.attempt.id);assert.equal(result.state,'pending');assert.equal(creates.length,1);
 assert.equal(creates[0].options.idempotencyKey,`pasofi-payment-${f.attempt.id}`);
 assert.equal(creates[0].body.amount,500);assert.equal(creates[0].body.currency,'usd');
 assert.deepEqual(creates[0].body.metadata,f.intent.metadata);assert.deepEqual(creates[0].body.allowed_payment_method_types,['card']);
});

test('expired ambiguous retry cannot create a replacement even when all eligibility remains enabled',async()=>{
 const f=fixture({ageSeconds:24*60*60}),result=await f.start();
 assert.equal(result.state,'unknown');assert.equal(f.events.length,0);assert.equal(f.writes.length,0);
});

for(const [name,revoke]of revocations)test(`known Stripe reference remains recoverable after removed ${name}`,async()=>{
 const f=fixture({reference:'pi_ExistingPayment123'});revoke(f);
 const saved=await f.start();assert.equal(saved.attemptId,f.attempt.id);assert.equal(saved.state,'pending');assert.equal(f.events.length,0);
 const shown=await stripePresentation(f.pool,f.attempt.customer_id,f.attempt.id,f.adapter);
 assert.equal(shown.clientSecret,f.intent.client_secret);assert.equal(f.events.some(e=>e.operation==='create'),false);
 f.intent.status='succeeded';f.intent.amount_received=500;
 f.intent.latest_charge={payment_intent:f.intent.id,amount:500,currency:'usd',livemode:false,paid:true,captured:true,refunded:false,amount_refunded:0,disputed:false};
 assert.equal((await f.adapter.check(f.terms)).state,'verified_success','withdrawn sales eligibility cannot hide captured money');
 f.intent.latest_charge.amount_refunded=500;
 assert.equal((await f.adapter.check(f.terms)).state,'reversed','withdrawn sales eligibility cannot hide a refund');
 assert.equal(f.events.some(e=>e.operation==='create'),false);
});

test('changing provider mode or the original site cannot reuse an existing attempt to create a new payment',async()=>{
 const provider=fixture();provider.adapter.provider='stripe';await assert.rejects(provider.start(),{code:'idempotency_conflict'});assert.equal(provider.events.length,0);
 const site=fixture();await assert.rejects(beginProviderPayment(site.pool,site.attempt.customer_id,site.attempt.order_id,site.attempt.request_key,randomUUID(),'STRIPE_CARD',site.eligibility,site.adapter),{code:'idempotency_conflict'});assert.equal(site.events.length,0);
});
