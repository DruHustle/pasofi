import {randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {PesepayAdapter,eligibleMethod} from './pesepay.js';
import {beginProviderPayment,reconcileProviderPayment,expireUnusedOrder,PaymentError} from './payments.js';
import {processPaymentReconciliation,registerPesepayCallback} from './payment-reconciliation.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Configuration={enabled:boolean;mode:'disabled'|'mock'|'sandbox'|'production'};
type Customer=(request:FastifyRequest)=>Promise<string|null>;
const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
export function paymentConfiguration(demo:boolean):Configuration {
 const raw=process.env.PAMOFI_PAYMENT_MODE;
 if(process.env.PAMOFI_PAYMENTS_ENABLED!=='true')return {enabled:false,mode:'disabled'};
 if(raw==='mock'&&demo)return {enabled:true,mode:'mock'};
 if((raw==='sandbox'&&demo&&process.env.PESEPAY_SANDBOX_QUALIFIED==='true')||(raw==='production'&&!demo&&process.env.APP_ENV==='production'&&process.env.NODE_ENV==='production'&&process.env.PESEPAY_PRODUCTION_QUALIFIED==='true')){
  try{provider(raw);const methods=JSON.parse(process.env.PESEPAY_METHODS_JSON??'[]'),sites=JSON.parse(process.env.PESEPAY_SITE_METHOD_CODES_JSON??'{}');if(Array.isArray(methods)&&methods.length>0&&methods.length<=100&&sites&&typeof sites==='object'&&!Array.isArray(sites)&&process.env.PESEPAY_MERCHANT_METHOD_CODES)return {enabled:true,mode:raw};}catch{}
 }
 return {enabled:false,mode:'disabled'};
}
function provider(environment:'sandbox'|'production'){return new PesepayAdapter({environment,integrationKey:process.env.PESEPAY_INTEGRATION_KEY??'',encryptionKey:process.env.PESEPAY_ENCRYPTION_KEY??'',applicationId:Number(process.env.PESEPAY_APPLICATION_ID),resultUrl:process.env.PESEPAY_RESULT_URL??'',returnUrl:process.env.PESEPAY_RETURN_URL??'',allowedCheckoutOrigins:(process.env.PESEPAY_CHECKOUT_ORIGINS??'').split(',').filter(Boolean)});}
function methods(config:Configuration,siteId:string){
 if(config.mode==='mock')return {items:[{active:true,code:'MOCKPAY',name:'Simulated payment',currencies:['USD'],minimumAmount:'0.01',maximumAmount:'10000000.00'}],merchant:new Set(['MOCKPAY']),site:new Set(['MOCKPAY'])};
 const items=JSON.parse(process.env.PESEPAY_METHODS_JSON??'[]') as Array<Record<string,any>>,mapping=object(JSON.parse(process.env.PESEPAY_SITE_METHOD_CODES_JSON??'{}'));
 return {items,merchant:new Set((process.env.PESEPAY_MERCHANT_METHOD_CODES??'').split(',').filter(Boolean)),site:new Set<string>(Array.isArray(mapping[siteId])?mapping[siteId].filter((v:unknown)=>typeof v==='string'):[])};
}
function mockAdapter(pool:Pool){return {
 initiate:async(input:Parameters<PesepayAdapter['initiate']>[0])=>{const ref=`MOCK-${randomUUID()}`;await pool.query('INSERT INTO mock_provider_payments(reference,order_id) VALUES($1,$2)',[ref,input.orderId]);return {state:'initiated' as const,referenceNumber:ref,redirectUrl:''};},
 check:async(terms:Parameters<PesepayAdapter['check']>[0])=>{const r=await pool.query('SELECT m.state,o.price_minor,o.currency FROM mock_provider_payments m JOIN purchase_orders o ON o.id=m.order_id WHERE m.reference=$1',[terms.referenceNumber]);if(!r.rowCount||r.rows[0].price_minor!==terms.amountMinor||r.rows[0].currency!==terms.currency)return {state:'unknown' as const,providerStatus:null};return {state:r.rows[0].state as 'pending'|'verified_success'|'failed'|'reversed',providerStatus:`MOCK_${r.rows[0].state}`};}
};}
export function registerCheckout(app:FastifyInstance,pool:Pool|null,demo:boolean,customer:Customer,originAllowed:(request:FastifyRequest)=>boolean):()=>Promise<void>{
 const config=paymentConfiguration(demo);if(!config.enabled||!pool)return async()=>{};
 const adapter=config.mode==='mock'?mockAdapter(pool):provider(config.mode as 'sandbox'|'production');
 if(adapter instanceof PesepayAdapter)registerPesepayCallback(app,pool,adapter);
 async function account(request:FastifyRequest,reply:FastifyReply){if(request.method!=='GET'&&!originAllowed(request)){reply.code(403).send({error:'origin_rejected'});return null;}try{const id=await customer(request);if(!id)reply.code(401).send({error:'not_authenticated'});return id;}catch{reply.code(503).send({error:'identity_unavailable'});return null;}}
 app.get('/v1/payments/methods',async(request,reply)=>{const q=object(request.query);if(typeof q.siteId!=='string'||!uuid.test(q.siteId)||typeof q.bundleId!=='string')return reply.code(400).send({error:'site_and_bundle_required'});try{const product=(await pool.query('SELECT b.* FROM bundle_versions b,sales_locations s WHERE b.id=$1 AND b.published AND s.id=$2 AND s.enabled',[q.bundleId,q.siteId])).rows[0];if(!product)return reply.code(404).send({error:'site_or_bundle_unavailable'});const list=methods(config,q.siteId);return {enabled:true,mode:config.mode,simulation:config.mode==='mock',methods:list.items.filter(m=>eligibleMethod(m,product.currency,product.price_minor,list.merchant,list.site)).map(m=>({code:m.code,name:typeof m.name==='string'?m.name:m.code,currency:product.currency,minMinor:Math.round(Number(m.minimumAmount)*100),maxMinor:Math.round(Number(m.maximumAmount)*100)}))};}catch{return reply.code(503).send({error:'payment_methods_unavailable'});}});
 app.post<{Params:{id:string}}>('/v1/orders/:id/checkout',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(request,reply)=>{const id=await account(request,reply);if(!id)return;const b=object(request.body),key=request.headers['idempotency-key'];if(!uuid.test(request.params.id)||typeof key!=='string'||!uuid.test(key)||typeof b.siteId!=='string'||!uuid.test(b.siteId)||typeof b.methodCode!=='string')return reply.code(400).send({error:'invalid_checkout'});try{const order=(await pool.query('SELECT purchase_mode FROM purchase_orders WHERE id=$1 AND customer_id=$2',[request.params.id,id])).rows[0];if(!order)return reply.code(404).send({error:'order_not_found'});if(order.purchase_mode!=='checkout')return reply.code(409).send({error:'wrong_order_mode'});const location=await pool.query('SELECT 1 FROM sales_locations WHERE id=$1 AND enabled',[b.siteId]);if(!location.rowCount)return reply.code(409).send({error:'site_unavailable'});const list=methods(config,b.siteId),method=list.items.find(m=>m.code===b.methodCode);const result=await beginProviderPayment(pool,id,request.params.id,key,b.siteId,b.methodCode,{method,merchantEnabledCodes:list.merchant,siteQualifiedCodes:list.site},adapter);return {...result,redirectUrl:config.mode==='mock'?null:result.redirectUrl,simulation:config.mode==='mock'};}catch(error){return reply.code(error instanceof PaymentError?409:503).send({error:error instanceof PaymentError?error.code:'payment_unavailable'});}});
 app.get<{Params:{id:string}}>('/v1/orders/:id/status',async(request,reply)=>{
  const id=await account(request,reply);if(!id)return;
  if(!uuid.test(request.params.id))return reply.code(404).send({error:'order_not_found'});
  try {
   const order=(await pool.query('SELECT id,bundle_id,price_minor,currency,byte_limit::text,validity_seconds,status,created_at,quote_expires_at,purchase_mode,expired_unused_at FROM purchase_orders WHERE id=$1 AND customer_id=$2',[request.params.id,id])).rows[0];
   if(!order)return reply.code(404).send({error:'order_not_found'});
   const attempts=(await pool.query('SELECT id,state,created_at AS "createdAt",updated_at AS "updatedAt" FROM provider_payment_attempts WHERE order_id=$1 AND customer_id=$2 ORDER BY created_at DESC LIMIT 10',[order.id,id])).rows;
   const e=(await pool.query('SELECT id,revoked_at FROM purchase_entitlements WHERE order_id=$1 AND customer_id=$2',[order.id,id])).rows[0];
   const review=(await pool.query('SELECT 1 FROM payment_reviews WHERE order_id=$1 LIMIT 1',[order.id])).rowCount;
   const charges=(await pool.query('SELECT state,fulfilled_entitlement_id FROM verified_charges WHERE order_id=$1',[order.id])).rows;
   const fulfillmentState=review?'pending_review':e?.revoked_at?'reversed':charges.some(c=>c.state==='succeeded'&&c.fulfilled_entitlement_id===e?.id)?'fulfilled':charges.some(c=>c.state==='reversed')?'reversed':'unconfirmed';
   return {order,attempts,entitlementId:e&&!e.revoked_at?e.id:null,entitlementRevokedAt:e?.revoked_at??null,fulfillmentState,safeToRequote:!!order.expired_unused_at,simulation:config.mode==='mock'};
  }catch{return reply.code(503).send({error:'payment_unavailable'});}
 });
 app.post<{Params:{id:string}}>('/v1/orders/:id/expire-unused',{config:{rateLimit:{max:10,timeWindow:'1 minute'}},schema:{body:{type:'object',additionalProperties:false}}},async(request,reply)=>{
  const id=await account(request,reply);if(!id)return;
  if(!uuid.test(request.params.id))return reply.code(404).send({error:'order_not_found'});
  try{return await expireUnusedOrder(pool,id,request.params.id);}
  catch(error){return reply.code(error instanceof PaymentError?(error.code==='order_not_found'?404:409):503).send({error:error instanceof PaymentError?error.code:'payment_unavailable'});}
 });
 if(config.mode==='mock')app.post<{Params:{id:string}}>('/v1/orders/:id/mock-payment',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(request,reply)=>{const id=await account(request,reply);if(!id)return;const b=object(request.body);if(!uuid.test(request.params.id)||!['success','failed','reversed'].includes(b.outcome))return reply.code(400).send({error:'invalid_mock_outcome'});try{const target=(await pool.query('SELECT m.reference,m.state,a.id AS attempt_id FROM mock_provider_payments m JOIN provider_payment_attempts a ON a.provider_reference=m.reference JOIN purchase_orders o ON o.id=m.order_id WHERE o.id=$1 AND o.customer_id=$2 AND o.purchase_mode=\'checkout\' ORDER BY a.created_at DESC LIMIT 1',[request.params.id,id])).rows[0];if(!target)return reply.code(404).send({error:'order_not_found'});const next=b.outcome==='success'?'verified_success':b.outcome;if(target.state==='reversed'&&next!=='reversed')return reply.code(409).send({error:'reversal_is_final'});await pool.query("UPDATE mock_provider_payments SET state=$2 WHERE reference=$1 AND (state<>'reversed' OR $2='reversed')",[target.reference,next]);return {...await reconcileProviderPayment(pool,target.attempt_id,adapter),simulation:true};}catch{return reply.code(503).send({error:'payment_unavailable'});}});
 let running:Promise<void>|undefined,timer:ReturnType<typeof setInterval>|undefined;
 const tick=()=>{if(running)return;running=processPaymentReconciliation(pool,adapter).then(()=>{}).catch(()=>{console.error('Payment reconciliation unavailable');}).finally(()=>{running=undefined;});};
 if(process.env.PAYMENT_RECONCILIATION_WORKER_ENABLED!=='false')app.addHook('onReady',async()=>{tick();timer=setInterval(tick,2000);timer.unref();});
 return async()=>{if(timer)clearInterval(timer);await running;};
}
