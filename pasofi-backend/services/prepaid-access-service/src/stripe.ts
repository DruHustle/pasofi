import Stripe from 'stripe';
import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import type {PaymentAdapter,PaymentInput,PaymentTerms,VerifiedStatus} from './payment-provider.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const intentId=/^pi_[A-Za-z0-9]{8,128}$/;
export type StripeConfiguration={secretKey:string;publishableKey:string;webhookSecret:string;accountId:string;
 country:string;live:boolean;siteIds:Set<string>;applePayMerchantId:string|null;googlePay:boolean};
export type StripePresentation={provider:'stripe';clientSecret:string;publishableKey:string;testMode:boolean;
 merchantCountryCode:string;merchantDisplayName:'PasoFi';applePayMerchantId:string|null;googlePay:boolean};

export function stripeConfiguration(demo:boolean):StripeConfiguration|null {
 const env=process.env,mode=env.PAMOFI_PAYMENT_MODE;
 if(env.PAMOFI_PAYMENT_PROVIDER!=='stripe')return null;
 const live=mode==='production';
 // Sandbox fulfillment belongs only to the existing isolated demo environment.
 // A test Stripe key must never issue a bundle into a production ledger.
 if(live ? demo||env.APP_ENV!=='production'||env.NODE_ENV!=='production'||env.STRIPE_PRODUCTION_QUALIFIED!=='true'
  : mode!=='sandbox'||!demo)return null;
 const secretKey=env.STRIPE_SECRET_KEY??'',publishableKey=env.STRIPE_PUBLISHABLE_KEY??'',webhookSecret=env.STRIPE_WEBHOOK_SECRET??'';
 const prefix=live?'live':'test';
 if(!new RegExp(`^sk_${prefix}_[A-Za-z0-9]{16,256}$`).test(secretKey)
  ||!new RegExp(`^pk_${prefix}_[A-Za-z0-9]{16,256}$`).test(publishableKey)
  ||!/^whsec_[A-Za-z0-9]{16,256}$/.test(webhookSecret))return null;
 const accountId=env.STRIPE_ACCOUNT_ID??'',country=env.STRIPE_MERCHANT_COUNTRY??'';
 if(!/^acct_[A-Za-z0-9]{8,128}$/.test(accountId)||!/^[A-Z]{2}$/.test(country))return null;
 let sites:unknown;try{sites=JSON.parse(env.STRIPE_QUALIFIED_SITE_IDS_JSON??'null');}catch{return null;}
 if(!Array.isArray(sites)||!sites.length||sites.length>1000||!sites.every(id=>typeof id==='string'&&uuid.test(id))||new Set(sites).size!==sites.length)return null;
 const apple=env.STRIPE_APPLE_PAY_ENABLED==='true',merchant=env.STRIPE_APPLE_PAY_MERCHANT_ID??'';
 if(apple&&!/^merchant\.[A-Za-z0-9.-]{3,180}$/.test(merchant))return null;
 return {secretKey,publishableKey,webhookSecret,accountId,country,live,siteIds:new Set(sites),
  applePayMerchantId:apple?merchant:null,googlePay:env.STRIPE_GOOGLE_PAY_ENABLED==='true'};
}

function metadata(terms:PaymentTerms|PaymentInput) {
 if(![terms.attemptId,terms.orderId,terms.customerId,terms.siteId].every(value=>typeof value==='string'&&uuid.test(value))
  ||terms.methodCode!=='STRIPE_CARD')throw Error('invalid_stripe_binding');
 return {pasofi_attempt_id:terms.attemptId!,pasofi_order_id:terms.orderId!,pasofi_customer_id:terms.customerId!,
  pasofi_site_id:terms.siteId!,pasofi_method_code:terms.methodCode};
}

export class StripeAdapter implements PaymentAdapter {
 readonly provider:'stripe'|'stripe_test';
 // Stripe retains API v1 idempotency keys for at least 24 hours. Stop one hour
 // early, measured from our committed attempt, and never create on a later retry.
 readonly initiationReplaySeconds=23*60*60;
 readonly client:Stripe;
 private accountCheck:Promise<void>|null=null;
 constructor(readonly config:StripeConfiguration,client?:Stripe) {
  this.provider=config.live?'stripe':'stripe_test';
  this.client=client??new Stripe(config.secretKey,{apiVersion:'2026-10-28.endive',timeout:4000,maxNetworkRetries:0});
 }
 private async account() {
  const account=await this.client.accounts.retrieve(null);
  if(account.id!==this.config.accountId||account.country!==this.config.country)throw Error('stripe_account_not_qualified');
  return account;
 }
 async verifyAccount() {
  if(!this.accountCheck)this.accountCheck=this.account().then(()=>undefined).catch(error=>{this.accountCheck=null;throw error;});
  await this.accountCheck;
 }
 matches(intent:Stripe.PaymentIntent,terms:PaymentTerms|PaymentInput):boolean {
  const expected=metadata(terms);
  return intentId.test(intent.id)&&intent.livemode===this.config.live&&intent.amount===terms.amountMinor
   &&intent.currency===terms.currency.toLowerCase()&&intent.capture_method==='automatic'
   &&intent.payment_method_types.length===1&&intent.payment_method_types[0]==='card'
   &&Object.entries(expected).every(([key,value])=>intent.metadata[key]===value);
 }
 async initiate(input:PaymentInput) {
  // Charge acceptance can change independently of account identity. Always
  // recheck it for a live creation, while preserving read-only settlement and
  // refund verification when Stripe temporarily restricts new charges.
  if(this.config.live){if((await this.account()).charges_enabled!==true)throw Error('stripe_account_not_qualified');}
  else await this.verifyAccount();
  const intent=await this.client.paymentIntents.create({amount:input.amountMinor,currency:input.currency.toLowerCase(),
   allowed_payment_method_types:['card'],automatic_payment_methods:{enabled:true,allow_redirects:'never'},capture_method:'automatic',metadata:metadata(input),description:'Pasofi internet bundle'},
   {idempotencyKey:`pasofi-payment-${input.attemptId}`});
  if(!this.matches(intent,input))throw Error('stripe_intent_mismatch');
  return {state:'initiated' as const,referenceNumber:intent.id,redirectUrl:''};
 }
 async retrieve(reference:string) {
  if(!intentId.test(reference))throw Error('invalid_stripe_reference');
  await this.verifyAccount();
  return this.client.paymentIntents.retrieve(reference,{expand:['latest_charge']});
 }
 async check(terms:PaymentTerms):Promise<VerifiedStatus> {
  const intent=await this.retrieve(terms.referenceNumber);
  if(intent.id!==terms.referenceNumber||!this.matches(intent,terms))return {state:'unknown',providerStatus:null};
  const charge=intent.latest_charge;
  if(charge&&typeof charge==='object'&&(charge.refunded||charge.amount_refunded>0||charge.disputed))return {state:'reversed',providerStatus:'reversed'};
  if(intent.status==='canceled')return {state:'failed',providerStatus:'canceled'};
  if(intent.status!=='succeeded')return {state:'pending',providerStatus:intent.status};
  if(intent.amount_received!==terms.amountMinor||!charge||typeof charge==='string'||charge.payment_intent!==intent.id
   ||charge.livemode!==this.config.live||!charge.paid||!charge.captured||charge.amount!==terms.amountMinor
   ||charge.currency!==terms.currency.toLowerCase())return {state:'unknown',providerStatus:null};
  return {state:'verified_success',providerStatus:'succeeded'};
 }
 async presentation(terms:PaymentTerms):Promise<StripePresentation|null> {
  const intent=await this.retrieve(terms.referenceNumber);
  if(intent.id!==terms.referenceNumber||!this.matches(intent,terms))throw Error('stripe_intent_mismatch');
  if(!['requires_payment_method','requires_confirmation','requires_action'].includes(intent.status))return null;
  if(!intent.client_secret?.startsWith(`${intent.id}_secret_`))throw Error('stripe_secret_unavailable');
  return {provider:'stripe',clientSecret:intent.client_secret,publishableKey:this.config.publishableKey,testMode:!this.config.live,
   merchantCountryCode:this.config.country,merchantDisplayName:'PasoFi',applePayMerchantId:this.config.applePayMerchantId,googlePay:this.config.googlePay};
 }
}

export async function stripePresentation(pool:Pool,customerId:string,attemptId:string,adapter:StripeAdapter) {
 const row=(await pool.query(`SELECT a.*,o.price_minor,o.currency FROM provider_payment_attempts a
  JOIN purchase_orders o ON o.id=a.order_id WHERE a.id=$1 AND a.customer_id=$2 AND o.customer_id=$2`,[attemptId,customerId])).rows[0];
 if(!row||row.provider!==adapter.provider||!row.provider_reference||!['pending','unknown'].includes(row.state))return null;
 return adapter.presentation({referenceNumber:row.provider_reference,attemptId:row.id,orderId:row.order_id,
  customerId:row.customer_id,siteId:row.site_id,methodCode:row.method_code,amountMinor:row.price_minor,currency:row.currency});
}

// A signed event wakes the existing reconciliation worker. Only a fresh Stripe
// retrieval matching immutable order terms can reach transactional fulfillment.
export async function enqueueStripeEvent(pool:Pool,adapter:StripeAdapter,event:Stripe.Event):Promise<void> {
 const supported=new Set(['payment_intent.succeeded','payment_intent.payment_failed','payment_intent.processing','payment_intent.canceled',
  'charge.refunded','charge.dispute.created','charge.dispute.updated','charge.dispute.closed']);
 if(!supported.has(event.type))return;
 if(event.livemode!==adapter.config.live||event.account!==undefined||!/^evt_[A-Za-z0-9]{1,128}$/.test(event.id))throw Error('stripe_event_scope_mismatch');
 const object=event.data.object as unknown as {id?:string;payment_intent?:string|null;charge?:string};
 let reference=event.type.startsWith('payment_intent.')?object.id:object.payment_intent;
 if(event.type.startsWith('charge.dispute.')&&!reference&&typeof object.charge==='string'){
  await adapter.verifyAccount();
  const charge=await adapter.client.charges.retrieve(object.charge);
  reference=typeof charge.payment_intent==='string'?charge.payment_intent:charge.payment_intent?.id;
 }
 if(typeof reference!=='string'||!intentId.test(reference))return;
 const intent=await adapter.retrieve(reference),attemptId=intent.metadata.pasofi_attempt_id;
 if(!uuid.test(attemptId??''))return; // This account may also sell unrelated products.
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  const row=(await client.query(`SELECT a.*,o.price_minor,o.currency FROM provider_payment_attempts a
   JOIN purchase_orders o ON o.id=a.order_id WHERE a.id=$1 FOR UPDATE OF a,o`,[attemptId])).rows[0];
  if(!row||row.provider!==adapter.provider){await client.query('ROLLBACK');return;}
  if(intent.id!==reference||!adapter.matches(intent,{referenceNumber:reference,attemptId:row.id,orderId:row.order_id,customerId:row.customer_id,
   siteId:row.site_id,methodCode:row.method_code,amountMinor:row.price_minor,currency:row.currency})
   ||(row.provider_reference&&row.provider_reference!==reference))throw Error('stripe_event_terms_mismatch');
  const inserted=await client.query(`INSERT INTO stripe_webhook_events(provider,event_id,event_type,provider_reference)
   VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING event_id`,[adapter.provider,event.id,event.type,reference]);
  if(inserted.rowCount){
   // Recover the original intent after an ambiguous create response. Never create
   // a replacement or bind a webhook to a different customer/order/attempt.
   await client.query(`UPDATE provider_payment_attempts SET provider_reference=$2,state='pending',updated_at=now()
    WHERE id=$1 AND provider_reference IS NULL AND state IN ('initiating','unknown')`,[attemptId,reference]);
   await client.query(`INSERT INTO payment_reconciliation_jobs(attempt_id) VALUES($1)
    ON CONFLICT(attempt_id) DO UPDATE SET requested_version=payment_reconciliation_jobs.requested_version+1,
     state=CASE WHEN payment_reconciliation_jobs.state='leased' THEN 'leased' ELSE 'pending' END,
     attempt_count=CASE WHEN payment_reconciliation_jobs.state IN ('idle','dead') THEN 0 ELSE payment_reconciliation_jobs.attempt_count END,
     due_at=CASE WHEN payment_reconciliation_jobs.state='leased' THEN payment_reconciliation_jobs.due_at ELSE now() END,updated_at=now()`,[attemptId]);
  }else{
   // An accepted event may outlive an outage that exhausts the worker. A fresh,
   // fully bound resend can revive only a dead job; it cannot steal a lease or
   // repeatedly re-arm an already completed or pending event.
   await client.query(`UPDATE payment_reconciliation_jobs SET requested_version=requested_version+1,
    state='pending',attempt_count=0,due_at=now(),updated_at=now()
    WHERE attempt_id=$1 AND state='dead'`,[attemptId]);
  }
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export function registerStripeWebhook(app:FastifyInstance,pool:Pool,adapter:StripeAdapter) {
 app.register(async scope=>{
  scope.removeContentTypeParser('application/json');
  scope.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:262144},(_request,body,done)=>done(null,body));
  scope.post('/callbacks/stripe',{bodyLimit:262144,config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async(request,reply)=>{
   const signature=request.headers['stripe-signature'];
   if(typeof signature!=='string'||signature.length>4096||!Buffer.isBuffer(request.body))return reply.code(400).send({error:'invalid_webhook'});
   let event:Stripe.Event;
   try{event=adapter.client.webhooks.constructEvent(request.body,signature,adapter.config.webhookSecret,300);}
   catch{return reply.code(400).send({error:'invalid_webhook'});}
   try{await enqueueStripeEvent(pool,adapter,event);return reply.code(204).send();}
   catch{return reply.code(503).send({error:'webhook_unavailable'});}
  });
 });
}
