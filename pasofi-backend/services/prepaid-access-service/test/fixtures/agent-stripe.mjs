// Test-only Stripe SDK transport. It never sends a network request or uses a
// real credential. The application still verifies actual signed webhook bytes,
// retrieves bound provider terms, and commits through its real PostgreSQL code.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Stripe from 'stripe';

export function createAgentStripeFixture(){
 const secret='sk_test_'+ 'SYNTHETIC'.repeat(4),publishable='pk_test_'+ 'SYNTHETIC'.repeat(4);
 const webhookSecret='whsec_'+ 'SYNTHETIC'.repeat(4),accountId='acct_SyntheticAgentMerchant123',country='GB';
 const intents=new Map(),byKey=new Map(),disputes=new Map(),createCalls=[];
 let loseResponse=false;
 const response=body=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json','request-id':'req_SYNTHETIC'}});
 const client=new Stripe(secret,{apiVersion:'2026-10-28.endive',maxNetworkRetries:0,httpClient:Stripe.createFetchHttpClient(async(url,options)=>{
  const target=new URL(url);assert.equal(target.origin,'https://api.stripe.com','the synthetic SDK transport never forwards a request');
  if(target.pathname==='/v1/account')return response({object:'account',id:accountId,country,charges_enabled:true});
  if(target.pathname==='/v1/payment_intents'&&options.method==='POST'){
   const body=new URLSearchParams(options.body),key=new Headers(options.headers).get('idempotency-key');
   assert.ok(key?.startsWith('pasofi-payment-'));createCalls.push(key);
   assert.equal(body.get('allowed_payment_method_types[0]'),'card');assert.equal(body.get('capture_method'),'automatic');
   assert.equal(body.has('confirm'),false,'only the customer confirms payment');
   if(!byKey.has(key)){
    const id='pi_'+randomUUID().replaceAll('-',''),metadata={};
    for(const [name,value]of body)if(name.startsWith('metadata[')&&name.endsWith(']'))metadata[name.slice(9,-1)]=value;
    const intent={id,object:'payment_intent',amount:Number(body.get('amount')),amount_received:0,currency:body.get('currency'),
     livemode:false,capture_method:'automatic',payment_method_types:['card'],status:'requires_payment_method',metadata,latest_charge:null,client_secret:id+'_secret_SYNTHETIC'};
    intents.set(id,intent);byKey.set(key,id);
   }
   if(loseResponse)throw Error('Synthetic response lost after the provider saved the intent');
   return response(intents.get(byKey.get(key)));
  }
  if(target.pathname.startsWith('/v1/payment_intents/')){
   const found=intents.get(decodeURIComponent(target.pathname.split('/').at(-1)));
   if(!found)throw Error('Unknown synthetic intent');return response(found);
  }
  if(target.pathname==='/v1/disputes')return response({object:'list',has_more:false,data:disputes.get(target.searchParams.get('charge'))??[]});
  if(target.pathname.startsWith('/v1/charges/')){
   const id=target.pathname.split('/').at(-1),charge=[...intents.values()].map(i=>i.latest_charge).find(c=>c?.id===id);
   if(!charge)throw Error('Unknown synthetic charge');return response(charge);
  }
  throw Error('Unexpected synthetic Stripe endpoint');
 })});
 const get=reference=>{const value=intents.get(reference);if(!value)throw Error('Unknown synthetic intent');return value;};
 function succeed(reference,{wallet}={}){
  const value=get(reference);assert.notEqual(value.status,'canceled','a canceled intent cannot later charge');
  value.status='succeeded';value.amount_received=value.amount;
  value.latest_charge={id:'ch_'+randomUUID().replaceAll('-',''),object:'charge',payment_intent:value.id,amount:value.amount,currency:value.currency,
   livemode:false,paid:true,captured:true,refunded:false,amount_refunded:0,disputed:false,
   payment_method_details:{type:'card',card:{wallet:wallet?{type:wallet}:null}}};
  return value;
 }
 function cancel(reference){const value=get(reference);assert.notEqual(value.status,'succeeded');value.status='canceled';return value;}
 function refund(reference,amount){const value=get(reference);assert.equal(value.status,'succeeded');const charge=value.latest_charge;
  charge.amount_refunded=amount??charge.amount;charge.refunded=charge.amount_refunded===charge.amount;return value;}
 function dispute(reference,status){const value=get(reference),charge=value.latest_charge;assert.ok(charge);
  charge.disputed=!['won','warning_closed','prevented'].includes(status);
  disputes.set(charge.id,[{id:'dp_SYNTHETIC',object:'dispute',charge:charge.id,payment_intent:value.id,livemode:false,status}]);return value;}
 function event(reference,type='payment_intent.succeeded'){
  const value=get(reference);
  return {id:'evt_'+randomUUID().replaceAll('-',''),object:'event',type,livemode:false,
   data:{object:type.startsWith('payment_intent.')?{id:value.id,object:'payment_intent'}:{id:value.latest_charge?.id??'ch_SYNTHETIC',object:'charge',payment_intent:value.id}}};
 }
 function webhook(reference,type){const value=event(reference,type),raw=JSON.stringify(value);return {event:value,raw,signature:client.webhooks.generateTestHeaderString({payload:raw,secret:webhookSecret})};}
 return {client,intents,createCalls,get,succeed,cancel,refund,dispute,event,webhook,loseResponse:value=>{loseResponse=value;},
  environment:siteIds=>({PAMOFI_PAYMENTS_ENABLED:'true',PAMOFI_PAYMENT_PROVIDER:'stripe',PAMOFI_PAYMENT_MODE:'sandbox',
   STRIPE_SECRET_KEY:secret,STRIPE_PUBLISHABLE_KEY:publishable,STRIPE_WEBHOOK_SECRET:webhookSecret,STRIPE_ACCOUNT_ID:accountId,
   STRIPE_MERCHANT_COUNTRY:country,STRIPE_QUALIFIED_SITE_IDS_JSON:JSON.stringify(siteIds),STRIPE_PRODUCTION_QUALIFIED:'false',
   STRIPE_APPLE_PAY_ENABLED:'false',STRIPE_GOOGLE_PAY_ENABLED:'false',STRIPE_APPLE_PAY_MERCHANT_ID:''}),
 };
}
