import {randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {eligibleMethod,type PaymentAdapter,type PaymentInput,type PaymentTerms} from './payment-provider.js';
import {beginProviderPayment,reconcileProviderPayment,expireUnusedOrder,PaymentError} from './payments.js';
import {processPaymentReconciliation} from './payment-reconciliation.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Configuration={enabled:boolean;mode:'disabled'|'mock'};
type Customer=(request:FastifyRequest)=>Promise<string|null>;
const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
export function paymentConfiguration(demo:boolean):Configuration {
 const raw=process.env.PAMOFI_PAYMENT_MODE;
 if(process.env.PAMOFI_PAYMENTS_ENABLED!=='true')return {enabled:false,mode:'disabled'};
 if(raw==='mock'&&demo)return {enabled:true,mode:'mock'};
 // Direct provider settlement is not yet independently verifiable from the
 // published contract. Neither legacy flags nor new credentials can enable it.
 return {enabled:false,mode:'disabled'};
}
function methods(){return {items:[{active:true,code:'MOCKPAY',name:'Simulated payment',currencies:['USD'],minimumAmount:'0.01',maximumAmount:'10000000.00'}],merchant:new Set(['MOCKPAY']),site:new Set(['MOCKPAY'])};}
function mockAdapter(pool:Pool):PaymentAdapter{return {
 provider:'mock',
 initiate:async(input:PaymentInput)=>{const ref=`MOCK-${randomUUID()}`;await pool.query('INSERT INTO mock_provider_payments(reference,order_id) VALUES($1,$2)',[ref,input.orderId]);return {state:'initiated' as const,referenceNumber:ref,redirectUrl:''};},
 check:async(terms:PaymentTerms)=>{const r=await pool.query('SELECT m.state,o.price_minor,o.currency FROM mock_provider_payments m JOIN purchase_orders o ON o.id=m.order_id WHERE m.reference=$1',[terms.referenceNumber]);if(!r.rowCount||r.rows[0].price_minor!==terms.amountMinor||r.rows[0].currency!==terms.currency)return {state:'unknown' as const,providerStatus:null};return {state:r.rows[0].state as 'pending'|'verified_success'|'failed'|'reversed',providerStatus:`MOCK_${r.rows[0].state}`};}
};}
export function registerCheckout(app:FastifyInstance,pool:Pool|null,demo:boolean,customer:Customer,originAllowed:(request:FastifyRequest)=>boolean):()=>Promise<void>{
 const config=paymentConfiguration(demo);if(!pool)return async()=>{};
 const adapter=config.enabled?mockAdapter(pool):null;
 async function account(request:FastifyRequest,reply:FastifyReply){if(request.method!=='GET'&&!originAllowed(request)){reply.code(403).send({error:'origin_rejected'});return null;}try{const id=await customer(request);if(!id)reply.code(401).send({error:'not_authenticated'});return id;}catch{reply.code(503).send({error:'identity_unavailable'});return null;}}
 app.get('/v1/payments/methods',async(request,reply)=>{if(!adapter)return reply.code(404).send({error:'payments_disabled'});const q=object(request.query);if(typeof q.siteId!=='string'||!uuid.test(q.siteId)||typeof q.bundleId!=='string')return reply.code(400).send({error:'site_and_bundle_required'});try{const product=(await pool.query('SELECT b.* FROM bundle_versions b,sales_locations s WHERE b.id=$1 AND b.published AND s.id=$2 AND s.enabled',[q.bundleId,q.siteId])).rows[0];if(!product)return reply.code(404).send({error:'site_or_bundle_unavailable'});const list=methods();return {enabled:true,mode:'mock',simulation:true,methods:list.items.filter(m=>eligibleMethod(m,product.currency,product.price_minor,list.merchant,list.site)).map(m=>({code:m.code,name:m.name,currency:product.currency,minMinor:Math.round(Number(m.minimumAmount)*100),maxMinor:Math.round(Number(m.maximumAmount)*100)}))};}catch{return reply.code(503).send({error:'payment_methods_unavailable'});}});
 app.post<{Params:{id:string}}>('/v1/orders/:id/checkout',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(request,reply)=>{if(!adapter)return reply.code(404).send({error:'payments_disabled'});const id=await account(request,reply);if(!id)return;const b=object(request.body),key=request.headers['idempotency-key'];if(!uuid.test(request.params.id)||typeof key!=='string'||!uuid.test(key)||typeof b.siteId!=='string'||!uuid.test(b.siteId)||typeof b.methodCode!=='string')return reply.code(400).send({error:'invalid_checkout'});try{const order=(await pool.query('SELECT purchase_mode FROM purchase_orders WHERE id=$1 AND customer_id=$2',[request.params.id,id])).rows[0];if(!order)return reply.code(404).send({error:'order_not_found'});if(order.purchase_mode!=='checkout')return reply.code(409).send({error:'wrong_order_mode'});const location=await pool.query('SELECT 1 FROM sales_locations WHERE id=$1 AND enabled',[b.siteId]);if(!location.rowCount)return reply.code(409).send({error:'site_unavailable'});const list=methods(),method=list.items.find(m=>m.code===b.methodCode);const result=await beginProviderPayment(pool,id,request.params.id,key,b.siteId,b.methodCode,{method,merchantEnabledCodes:list.merchant,siteQualifiedCodes:list.site},adapter);return {...result,redirectUrl:null,simulation:true};}catch(error){return reply.code(error instanceof PaymentError?409:503).send({error:error instanceof PaymentError?error.code:'payment_unavailable'});}});
 app.get<{Params:{id:string}}>('/v1/orders/:id/status',async(request,reply)=>{
  const id=await account(request,reply);if(!id)return;
  if(!uuid.test(request.params.id))return reply.code(404).send({error:'order_not_found'});
  try {
   const order=(await pool.query('SELECT id,bundle_id,price_minor,currency,byte_limit::text,validity_seconds,status,created_at,quote_expires_at,purchase_mode,expired_unused_at FROM purchase_orders WHERE id=$1 AND customer_id=$2',[request.params.id,id])).rows[0];
   if(!order)return reply.code(404).send({error:'order_not_found'});
   const attempts=(await pool.query('SELECT id,provider,state,created_at AS "createdAt",updated_at AS "updatedAt" FROM provider_payment_attempts WHERE order_id=$1 AND customer_id=$2 ORDER BY created_at DESC LIMIT 10',[order.id,id])).rows;
   const provenance=(await pool.query("SELECT COALESCE(bool_and(provider='mock'),false) AS simulated FROM provider_payment_attempts WHERE order_id=$1 AND customer_id=$2",[order.id,id])).rows[0];
   const e=(await pool.query('SELECT id,revoked_at FROM purchase_entitlements WHERE order_id=$1 AND customer_id=$2',[order.id,id])).rows[0];
   const review=(await pool.query('SELECT 1 FROM payment_reviews WHERE order_id=$1 LIMIT 1',[order.id])).rowCount;
   const charges=(await pool.query('SELECT state,fulfilled_entitlement_id FROM verified_charges WHERE order_id=$1',[order.id])).rows;
   const fulfillmentState=review?'pending_review':e?.revoked_at?'reversed':charges.some(c=>c.state==='succeeded'&&c.fulfilled_entitlement_id===e?.id)?'fulfilled':charges.some(c=>c.state==='reversed')?'reversed':'unconfirmed';
   return {order,attempts,entitlementId:e&&!e.revoked_at?e.id:null,entitlementRevokedAt:e?.revoked_at??null,fulfillmentState,safeToRequote:!!order.expired_unused_at,simulation:order.purchase_mode==='demo'||provenance.simulated};
  }catch{return reply.code(503).send({error:'payment_unavailable'});}
 });
 app.post<{Params:{id:string}}>('/v1/orders/:id/expire-unused',{config:{rateLimit:{max:10,timeWindow:'1 minute'}},schema:{body:{type:'object',additionalProperties:false}}},async(request,reply)=>{
  const id=await account(request,reply);if(!id)return;
  if(!uuid.test(request.params.id))return reply.code(404).send({error:'order_not_found'});
  try{return await expireUnusedOrder(pool,id,request.params.id);}
  catch(error){return reply.code(error instanceof PaymentError?(error.code==='order_not_found'?404:409):503).send({error:error instanceof PaymentError?error.code:'payment_unavailable'});}
 });
 if(adapter)app.post<{Params:{id:string}}>('/v1/orders/:id/mock-payment',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(request,reply)=>{const id=await account(request,reply);if(!id)return;const b=object(request.body);if(!uuid.test(request.params.id)||!['success','failed','reversed'].includes(b.outcome))return reply.code(400).send({error:'invalid_mock_outcome'});try{const target=(await pool.query('SELECT m.reference,m.state,a.id AS attempt_id FROM mock_provider_payments m JOIN provider_payment_attempts a ON a.provider_reference=m.reference JOIN purchase_orders o ON o.id=m.order_id WHERE o.id=$1 AND o.customer_id=$2 AND o.purchase_mode=\'checkout\' AND a.provider=\'mock\' ORDER BY a.created_at DESC LIMIT 1',[request.params.id,id])).rows[0];if(!target)return reply.code(404).send({error:'order_not_found'});const next=b.outcome==='success'?'verified_success':b.outcome;if(target.state==='reversed'&&next!=='reversed')return reply.code(409).send({error:'reversal_is_final'});await pool.query("UPDATE mock_provider_payments SET state=$2 WHERE reference=$1 AND (state<>'reversed' OR $2='reversed')",[target.reference,next]);return {...await reconcileProviderPayment(pool,target.attempt_id,adapter),simulation:true};}catch{return reply.code(503).send({error:'payment_unavailable'});}});
 let running:Promise<void>|undefined,timer:ReturnType<typeof setInterval>|undefined;
 const tick=()=>{if(running||!adapter)return;running=processPaymentReconciliation(pool,adapter).then(()=>{}).catch(()=>{console.error('Payment reconciliation unavailable');}).finally(()=>{running=undefined;});};
 if(adapter&&process.env.PAYMENT_RECONCILIATION_WORKER_ENABLED!=='false')app.addHook('onReady',async()=>{tick();timer=setInterval(tick,2000);timer.unref();});
 return async()=>{if(timer)clearInterval(timer);await running;};
}
