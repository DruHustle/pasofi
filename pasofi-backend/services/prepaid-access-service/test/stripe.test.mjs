import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Stripe from 'stripe';
import Fastify from 'fastify';
import {StripeAdapter,stripeConfiguration,registerStripeWebhook} from '../dist/stripe.js';
import {paymentConfiguration} from '../dist/checkout.js';

const synthetic=(kind,mode='test')=>[kind,mode,'SYNTHETIC'.repeat(4)].join('_');
const terms=()=>({referenceNumber:'pi_SyntheticPayment123',attemptId:randomUUID(),orderId:randomUUID(),customerId:randomUUID(),siteId:randomUUID(),methodCode:'STRIPE_CARD',amountMinor:500,currency:'USD'});
const config=()=>({secretKey:synthetic('sk'),publishableKey:synthetic('pk'),webhookSecret:['whsec','SYNTHETIC'.repeat(4)].join('_'),accountId:'acct_SyntheticMerchant123',country:'GB',live:false,siteIds:new Set(),applePayMerchantId:null,googlePay:false});
function intent(t,changes={}){return {id:t.referenceNumber,object:'payment_intent',amount:t.amountMinor,amount_received:t.amountMinor,currency:t.currency.toLowerCase(),livemode:false,capture_method:'automatic',payment_method_types:['card'],status:'succeeded',client_secret:`${t.referenceNumber}_secret_SYNTHETIC`,metadata:{pasofi_attempt_id:t.attemptId,pasofi_order_id:t.orderId,pasofi_customer_id:t.customerId,pasofi_site_id:t.siteId,pasofi_method_code:t.methodCode},latest_charge:{id:'ch_SyntheticCharge123',object:'charge',payment_intent:t.referenceNumber,amount:t.amountMinor,currency:t.currency.toLowerCase(),livemode:false,paid:true,captured:true,refunded:false,amount_refunded:0,disputed:false},...changes};}
function clientFor(c,t,change=()=>({}),requests=[]){
 return new Stripe(c.secretKey,{apiVersion:'2026-10-28.endive',maxNetworkRetries:0,httpClient:Stripe.createFetchHttpClient(async(url,options)=>{
  const u=new URL(url);assert.equal(u.origin,'https://api.stripe.com');
  requests.push({url:u,options});
  const body=u.pathname==='/v1/account'?{object:'account',id:c.accountId,country:c.country,charges_enabled:true}:intent(t,change());
  return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json','request-id':'req_SYNTHETIC'}});
 })});
}

test('Stripe configuration fails closed across environment, key mode, merchant and site qualification',()=>{
 const c=config(),env={PAMOFI_PAYMENTS_ENABLED:'true',PAMOFI_PAYMENT_PROVIDER:'stripe',PAMOFI_PAYMENT_MODE:'sandbox',APP_ENV:'demo',NODE_ENV:'development',
  STRIPE_SECRET_KEY:c.secretKey,STRIPE_PUBLISHABLE_KEY:c.publishableKey,STRIPE_WEBHOOK_SECRET:c.webhookSecret,STRIPE_ACCOUNT_ID:c.accountId,
  STRIPE_MERCHANT_COUNTRY:c.country,STRIPE_QUALIFIED_SITE_IDS_JSON:JSON.stringify([randomUUID()]),STRIPE_PRODUCTION_QUALIFIED:'false',STRIPE_APPLE_PAY_ENABLED:'false',STRIPE_APPLE_PAY_MERCHANT_ID:'',STRIPE_GOOGLE_PAY_ENABLED:'false'};
 const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
 try{
  Object.assign(process.env,env);assert.deepEqual(paymentConfiguration(true),{enabled:true,mode:'sandbox'});
  for(const [name,value]of [['STRIPE_SECRET_KEY',synthetic('sk','live')],['STRIPE_PUBLISHABLE_KEY',synthetic('pk','live')],['STRIPE_WEBHOOK_SECRET',''],['STRIPE_ACCOUNT_ID',''],['STRIPE_MERCHANT_COUNTRY',''],['STRIPE_QUALIFIED_SITE_IDS_JSON','[]'],['STRIPE_QUALIFIED_SITE_IDS_JSON','["not-a-site"]'],['STRIPE_APPLE_PAY_ENABLED','true']]){
   Object.assign(process.env,env,{[name]:value});assert.equal(stripeConfiguration(true),null,`${name} must fail closed`);
  }
  Object.assign(process.env,env);assert.equal(stripeConfiguration(false),null,'test mode cannot issue production access');
  Object.assign(process.env,env,{PAMOFI_PAYMENTS_ENABLED:'false'});
  assert.deepEqual(paymentConfiguration(true),{enabled:false,mode:'disabled'});
  assert.ok(stripeConfiguration(true),'pausing new payments retains verification of existing attempts');
  Object.assign(process.env,env,{PAMOFI_PAYMENT_MODE:'production',APP_ENV:'production',NODE_ENV:'production',STRIPE_SECRET_KEY:synthetic('sk','live'),STRIPE_PUBLISHABLE_KEY:synthetic('pk','live')});
  assert.equal(stripeConfiguration(false),null,'credentials alone cannot qualify live checkout');
  process.env.STRIPE_PRODUCTION_QUALIFIED='true';assert.deepEqual(paymentConfiguration(false),{enabled:true,mode:'production'});
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('official Stripe SDK sends one bound card intent with a stable server attempt idempotency key',async()=>{
 const c=config(),t=terms(),requests=[],adapter=new StripeAdapter(c,clientFor(c,t,()=>({status:'requires_payment_method',latest_charge:null,amount_received:0}),requests));
 const input={...t,eligibility:{method:{},merchantEnabledCodes:new Set(),siteQualifiedCodes:new Set()}};
 assert.equal((await adapter.initiate(input)).referenceNumber,t.referenceNumber);
 await adapter.initiate(input);
 const created=requests.filter(r=>r.options.method==='POST');assert.equal(created.length,2);
 for(const request of created){
  const body=new URLSearchParams(request.options.body),headers=new Headers(request.options.headers);
  assert.equal(request.url.pathname,'/v1/payment_intents');assert.equal(body.get('amount'),'500');assert.equal(body.get('currency'),'usd');
  assert.equal(body.get('allowed_payment_method_types[0]'),'card');assert.equal(body.get('capture_method'),'automatic');
  assert.equal(body.get('automatic_payment_methods[allow_redirects]'),'never');
  assert.equal(body.get('metadata[pasofi_attempt_id]'),t.attemptId);assert.equal(body.get('metadata[pasofi_order_id]'),t.orderId);
  assert.equal(body.get('metadata[pasofi_customer_id]'),t.customerId);assert.equal(body.get('metadata[pasofi_site_id]'),t.siteId);
  assert.equal(headers.get('idempotency-key'),`pasofi-payment-${t.attemptId}`);assert.equal(headers.get('stripe-version'),'2026-10-28.endive');
  assert.equal(body.has('confirm'),false);assert.equal(body.has('payment_method'),false);
 }
 assert.equal(adapter.initiationReplaySeconds,23*60*60);assert.equal(requests.filter(r=>r.url.pathname==='/v1/account').length,1);
});

test('wrong merchant identity prevents any PaymentIntent creation',async()=>{
 const c=config(),t=terms(),requests=[],client=clientFor({...c,accountId:'acct_DifferentMerchant123'},t,()=>({}),requests);
 const adapter=new StripeAdapter(c,client);await assert.rejects(adapter.initiate({...t,eligibility:{}}),/stripe_account_not_qualified/);
 assert.equal(requests.some(r=>r.options.method==='POST'),false);
});

test('merchant charge restrictions preserve captured-payment and refund reconciliation while blocking new intents',async()=>{
 const c={...config(),live:true},t=terms();let enabled=false,refunded=false,created=0;
 const account={id:c.accountId,country:c.country};
 const value=()=>intent(t,{livemode:true,latest_charge:{...intent(t).latest_charge,livemode:true,refunded,amount_refunded:refunded?500:0}});
 const client={accounts:{retrieve:async()=>({...account,charges_enabled:enabled})},paymentIntents:{
  retrieve:async()=>value(),create:async()=>{created++;return value();}
 }};
 const adapter=new StripeAdapter(c,client);
 assert.equal((await adapter.check(t)).state,'verified_success','a restriction after restart cannot hide already captured money');
 refunded=true;assert.equal((await adapter.check(t)).state,'reversed');
 await assert.rejects(adapter.initiate({...t,eligibility:{}}),/stripe_account_not_qualified/);assert.equal(created,0);
 enabled=true;refunded=false;
 assert.equal((await adapter.initiate({...t,eligibility:{}})).referenceNumber,t.referenceNumber,'lifting the restriction is not trapped by a cached denial');
 assert.equal(created,1);
});

test('only fully captured exact bound terms count as verified money; declines remain safely retryable',async t=>{
 const c=config(),termsValue=terms();
 const cases=[
  ['captured',{},'verified_success'],['still authenticating',{status:'requires_action',amount_received:0,latest_charge:null},'pending'],
  ['declined but reusable',{status:'requires_payment_method',amount_received:0,latest_charge:null},'pending'],
  ['cancelled',{status:'canceled',latest_charge:null,amount_received:0},'failed'],['wrong currency',{currency:'eur'},'unknown'],
  ['wrong amount',{amount:499},'unknown'],['short receipt',{amount_received:499},'unknown'],['wrong mode',{livemode:true},'unknown'],
  ['wrong customer',{metadata:{...intent(termsValue).metadata,pasofi_customer_id:randomUUID()}},'unknown'],
  ['wrong order',{metadata:{...intent(termsValue).metadata,pasofi_order_id:randomUUID()}},'unknown'],
  ['uncaptured',{latest_charge:{...intent(termsValue).latest_charge,captured:false}},'unknown'],
  ['refund',{latest_charge:{...intent(termsValue).latest_charge,amount_refunded:100}},'reversed'],
  ['disputed',{latest_charge:{...intent(termsValue).latest_charge,disputed:true}},'reversed'],
 ];
 for(const [name,changes,state]of cases)await t.test(name,async()=>{
  const adapter=new StripeAdapter(c,clientFor(c,termsValue,()=>changes));assert.equal((await adapter.check(termsValue)).state,state);
 });
});

test('presentation returns only publishable configuration and an ephemeral client secret for the original intent',async()=>{
 const c=config(),t=terms();let state='requires_payment_method';
 const adapter=new StripeAdapter(c,clientFor(c,t,()=>({status:state})));
 const result=await adapter.presentation(t);assert.equal(result.clientSecret,`${t.referenceNumber}_secret_SYNTHETIC`);assert.equal(result.publishableKey,c.publishableKey);
 assert.equal(JSON.stringify(result).includes(c.secretKey),false);assert.equal(JSON.stringify(result).includes(c.webhookSecret),false);
 assert.deepEqual(Object.keys(result).sort(),['applePayMerchantId','clientSecret','googlePay','merchantCountryCode','merchantDisplayName','provider','publishableKey','testMode'].sort());
 state='succeeded';assert.equal(await adapter.presentation(t),null);
 await assert.rejects(adapter.presentation({...t,customerId:randomUUID()}),/stripe_intent_mismatch/);
});

test('webhook uses original raw bytes, rejects invalid/stale signatures and leaves other JSON routes intact',async()=>{
 const c=config(),t=terms(),adapter=new StripeAdapter(c,clientFor(c,t)),app=Fastify();
 const pool={connect:()=>{throw Error('unrelated events cannot access the ledger');}};
 registerStripeWebhook(app,pool,adapter);app.post('/ordinary',async request=>({parsed:request.body.value}));
 try{
  const raw='{ "id": "evt_SyntheticEvent123", "type":"customer.created", "livemode":false, "data":{"object":{}} }';
  const sign=payload=>adapter.client.webhooks.generateTestHeaderString({payload,secret:c.webhookSecret});
  assert.equal((await app.inject({method:'POST',url:'/callbacks/stripe',headers:{'content-type':'application/json','stripe-signature':sign(raw)},payload:raw})).statusCode,204);
  for(const [body,signature]of [[raw,undefined],[raw,'invalid'],[raw+' ',sign(raw)],[raw,adapter.client.webhooks.generateTestHeaderString({payload:raw,secret:c.webhookSecret,timestamp:Math.floor(Date.now()/1000)-600})]]){
   assert.equal((await app.inject({method:'POST',url:'/callbacks/stripe',headers:{'content-type':'application/json',...(signature?{'stripe-signature':signature}:{})},payload:body})).statusCode,400);
  }
  assert.deepEqual((await app.inject({method:'POST',url:'/ordinary',payload:{value:'json parser preserved'}})).json(),{parsed:'json parser preserved'});
 }finally{await app.close();}
});
