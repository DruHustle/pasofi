import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import type {FastifyRequest} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import {loadDeliveryKeys,seal,unseal,type DeliveryKeys} from './delivery-crypto.js';
import {eligibleMethod} from './payment-provider.js';
import {STRIPE_METHOD,stripeConfiguration,type StripeConfiguration} from './stripe.js';
import {identityStaff} from './staff-identity.js';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
const hash=(value:string)=>createHash('sha256').update(value).digest();
type Queryable=Pick<PoolClient,'query'>;
export type AgentCheckoutSource={id:string;code:string};
export type AgentCheckoutRow=Record<string,any>;
export type AgentCheckoutConfiguration={keys:DeliveryKeys;commission:number;stripe:StripeConfiguration;simulation:boolean};
export class AgentCheckoutError extends Error {
 constructor(public readonly code:string,public readonly status=409){super(code);}
}

export const agentCheckoutSourceSchema={
 type:'object',additionalProperties:false,required:['id','code'],
 properties:{id:{type:'string',pattern:uuid.source},code:{type:'string',pattern:tokenPattern.source}},
} as const;

export function agentCheckoutConfiguration(demo:boolean,paymentsEnabled:boolean):AgentCheckoutConfiguration|null {
 const keys=loadDeliveryKeys(),commission=Number(process.env.PAMOFI_AGENT_COMMISSION_BPS??0),stripe=stripeConfiguration(demo);
 if(!paymentsEnabled||process.env.PAMOFI_COMMERCE_ENABLED!=='true'||!keys||!stripe||!Number.isInteger(commission)||commission<0||commission>10000)return null;
 return {keys,commission,stripe,simulation:demo};
}

export function parseAgentCheckoutSource(input:unknown):AgentCheckoutSource|undefined {
 if(input===undefined)return undefined;
 if(!input||typeof input!=='object'||Array.isArray(input))throw new AgentCheckoutError('invalid_agent_checkout',400);
 const value=input as Record<string,unknown>;
 if(Object.keys(value).some(k=>!['id','code'].includes(k))||typeof value.id!=='string'||!uuid.test(value.id)||typeof value.code!=='string'||!tokenPattern.test(value.code))throw new AgentCheckoutError('invalid_agent_checkout',400);
 return {id:value.id.toLowerCase(),code:value.code};
}

function validCode(row:AgentCheckoutRow|undefined,source:AgentCheckoutSource){
 return !!row&&row.id===source.id&&Buffer.isBuffer(row.token_hash)&&row.token_hash.length===32&&timingSafeEqual(row.token_hash,hash(source.code));
}

export function agentCheckoutQuote(row:AgentCheckoutRow){
 return {bundleId:row.bundle_id,siteId:row.site_id,siteName:row.site_name,priceMinor:row.price_minor,currency:row.currency,byteLimit:String(row.byte_limit),validitySeconds:row.validity_seconds};
}

export function agentCheckoutOrderSource(row:AgentCheckoutRow){
 return {id:row.id,siteId:row.site_id,siteName:row.site_name};
}

export async function withAgentCheckoutSources<T extends {id:string}>(db:Queryable,orders:T[]):Promise<(T&{agentCheckout?:ReturnType<typeof agentCheckoutOrderSource>})[]> {
 if(!orders.length)return [];
 const rows=(await db.query('SELECT id,order_id,site_id,site_name FROM agent_checkouts WHERE order_id=ANY($1::uuid[])',[orders.map(order=>order.id)])).rows;
 const sources=new Map(rows.map(row=>[row.order_id,agentCheckoutOrderSource(row)]));
 return orders.map(order=>({...order,...(sources.has(order.id)?{agentCheckout:sources.get(order.id)!}:{})}));
}

export async function assertAgentOrderReplay(client:PoolClient,orderId:string,source:AgentCheckoutSource|undefined){
 const row=(await client.query('SELECT id,token_hash FROM agent_checkouts WHERE order_id=$1',[orderId])).rows[0];
 if(source?!validCode(row,source):!!row)throw new AgentCheckoutError('idempotency_conflict');
}

export async function assertCurrentCheckoutAgent(request:Pick<FastifyRequest,'headers'>,demo:boolean,row:AgentCheckoutRow){
 const response=await identityStaff(request,demo,'/internal/v1/staff/users/'+row.agent_id,'staff:read');
 if(response.status===404)throw new AgentCheckoutError('agent_checkout_unavailable');
 const agent=response.data;
 // An internal authentication error or malformed answer is an outage, not proof
 // of a revoked agent. Never proceed with an earlier eligibility snapshot.
 if(response.status!==200||!agent||typeof agent.staffId!=='string'||!uuid.test(agent.staffId)||agent.staffId.toLowerCase()!==row.agent_id
  ||typeof agent.status!=='string'||!['pending','approved','rejected','disabled'].includes(agent.status)
  ||!Array.isArray(agent.siteIds)||agent.siteIds.some(id=>typeof id!=='string'||!uuid.test(id))
  ||!Number.isSafeInteger(agent.version)||Number(agent.version)<1)throw Error('identity_unavailable');
 if(agent.status!=='approved'||agent.role!=='agent'||Number(agent.version)!==Number(row.agent_version)||!agent.siteIds.includes(row.site_id))throw new AgentCheckoutError('agent_checkout_unavailable');
}

function methodQualified(config:AgentCheckoutConfiguration,row:AgentCheckoutRow){
 return row.simulation===config.simulation&&eligibleMethod(STRIPE_METHOD,row.currency,row.price_minor,new Set(['STRIPE_CARD']),config.stripe.siteIds.has(row.site_id)?new Set(['STRIPE_CARD']):new Set());
}

async function currentTerms(client:Queryable,row:AgentCheckoutRow,lock=false){
 const site=(await client.query('SELECT name,enabled FROM sales_locations WHERE id=$1'+(lock?' FOR SHARE':''),[row.site_id])).rows[0];
 const bundle=(await client.query('SELECT * FROM bundle_versions WHERE id=$1'+(lock?' FOR SHARE':''),[row.bundle_id])).rows[0];
 return !!site?.enabled&&!!bundle?.published&&bundle.price_minor===row.price_minor&&bundle.currency===row.currency
  &&String(bundle.byte_limit)===String(row.byte_limit)&&bundle.validity_seconds===row.validity_seconds;
}

export async function createAgentCheckout(pool:Pool,agent:{staffId:string;version:number},requestKey:string,input:{siteId:string;bundleId:string},config:AgentCheckoutConfiguration|null){
 const fingerprint=hash(JSON.stringify(input)),client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['agent-checkout:'+agent.staffId+':'+requestKey]);
  const previous=(await client.query('SELECT * FROM agent_checkouts WHERE agent_id=$1 AND request_key=$2',[agent.staffId,requestKey])).rows[0];
  if(previous){
   if(!previous.request_hash.equals(fingerprint))throw new AgentCheckoutError('idempotency_conflict');
   await client.query('COMMIT');return {row:previous,replayed:true};
  }
  if(!config)throw new AgentCheckoutError('agent_checkout_unavailable');
  const site=(await client.query('SELECT name,enabled FROM sales_locations WHERE id=$1 FOR SHARE',[input.siteId])).rows[0];
  const product=(await client.query('SELECT * FROM bundle_versions WHERE id=$1 FOR SHARE',[input.bundleId])).rows[0];
  if(!site?.enabled||!product?.published)throw new AgentCheckoutError('site_or_bundle_unavailable');
  if(!methodQualified(config,{...product,site_id:input.siteId,simulation:config.simulation}))throw new AgentCheckoutError('method_not_qualified');
  const stock=(await client.query('SELECT quantity FROM agent_site_inventory WHERE agent_id=$1 AND site_id=$2 AND bundle_id=$3',[agent.staffId,input.siteId,input.bundleId])).rows[0];
  if(!stock?.quantity)throw new AgentCheckoutError('out_of_stock');
  const id=randomUUID(),code=randomBytes(32).toString('base64url'),encrypted=seal(code,config.keys,'agent-checkout:'+id);
  const row=(await client.query(
   "INSERT INTO agent_checkouts(id,agent_id,agent_version,site_id,bundle_id,request_key,request_hash,token_hash,key_id,token_cipher,token_iv,token_tag,site_name,price_minor,currency,byte_limit,validity_seconds,commission_bps,commission_minor,simulation,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now()+interval '15 minutes') RETURNING *",
   [id,agent.staffId,agent.version,input.siteId,input.bundleId,requestKey,fingerprint,hash(code),encrypted.keyId,encrypted.cipher,encrypted.iv,encrypted.tag,site.name,product.price_minor,product.currency,product.byte_limit,product.validity_seconds,config.commission,Math.floor(product.price_minor*config.commission/10000),config.simulation],
  )).rows[0];
  await client.query("INSERT INTO commerce_audit(id,actor_id,action,target_id,reason,details) VALUES($1,$2,'agent.checkout.create',$3,'Customer-owned digital checkout',$4)",[randomUUID(),agent.staffId,id,JSON.stringify(input)]);
  await client.query('COMMIT');return {row,replayed:false};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

export function agentCheckoutHandoff(row:AgentCheckoutRow,creatorId:string,keys:DeliveryKeys|null,demo:boolean){
 if(!keys||row.agent_id!==creatorId||row.order_id||row.closed_at||row.expires_at.getTime()<=Date.now())return null;
 const code=unseal({keyId:row.key_id,iv:row.token_iv,cipher:row.token_cipher,tag:row.token_tag},keys,'agent-checkout:'+row.id);
 if(!tokenPattern.test(code))throw Error('agent_checkout_unavailable');
 const origin=new URL(process.env.PUBLIC_ORIGIN??'');
 if(origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/'||(demo?!['http:','https:'].includes(origin.protocol):origin.protocol!=='https:'))throw Error('agent_checkout_unavailable');
 origin.hash='checkout?agentCheckout='+row.id+'.'+code;
 return {code,url:origin.href};
}

export async function previewAgentCheckout(pool:Pool,source:AgentCheckoutSource,config:AgentCheckoutConfiguration|null,request:Pick<FastifyRequest,'headers'>,demo:boolean){
 const row=(await pool.query('SELECT * FROM agent_checkouts WHERE id=$1',[source.id])).rows[0];
 if(!validCode(row,source))throw new AgentCheckoutError('agent_checkout_not_found',404);
 const status=row.order_id?'claimed':row.closed_at||row.expires_at.getTime()<=Date.now()?'expired':'unclaimed';
 let available=false;
 if(status==='unclaimed'&&config&&methodQualified(config,row)&&await currentTerms(pool,row)){
  try{await assertCurrentCheckoutAgent(request,demo,row);available=true;}
  catch(error){if(!(error instanceof AgentCheckoutError))throw error;}
 }
 return {checkout:{id:row.id,status,quote:agentCheckoutQuote(row),expiresAt:row.expires_at,simulation:row.simulation},available};
}

// Called only for a NEW customer order inside its request-key transaction.
// Existing owner retries use assertAgentOrderReplay before mutable sale gates.
export async function prepareAgentOrder(client:PoolClient,source:AgentCheckoutSource,bundleId:string,config:AgentCheckoutConfiguration|null,request:Pick<FastifyRequest,'headers'>,demo:boolean){
 const row=(await client.query('SELECT * FROM agent_checkouts WHERE id=$1 FOR UPDATE',[source.id])).rows[0];
 if(!validCode(row,source))throw new AgentCheckoutError('agent_checkout_not_found',404);
 if(row.order_id)throw new AgentCheckoutError('agent_checkout_claimed');
 const fresh=(await client.query('SELECT expires_at>clock_timestamp() AND closed_at IS NULL AS usable FROM agent_checkouts WHERE id=$1',[row.id])).rows[0];
 if(!fresh.usable)throw new AgentCheckoutError('agent_checkout_expired');
 if(row.bundle_id!==bundleId)throw new AgentCheckoutError('agent_checkout_terms_mismatch');
 if(!config||!methodQualified(config,row))throw new AgentCheckoutError('agent_checkout_unavailable');
 await assertCurrentCheckoutAgent(request,demo,row);
 if(!await currentTerms(client,row,true))throw new AgentCheckoutError('site_or_bundle_unavailable');
 return row as AgentCheckoutRow;
}

export async function claimAgentOrder(client:PoolClient,id:string,orderId:string){
 await client.query('UPDATE agent_checkouts SET order_id=$2,claimed_at=clock_timestamp() WHERE id=$1 AND order_id IS NULL',[id,orderId]);
}

export async function lockAgentCheckoutForOrder(client:PoolClient,orderId:string):Promise<AgentCheckoutRow|null>{
 return (await client.query('SELECT * FROM agent_checkouts WHERE order_id=$1 FOR UPDATE',[orderId])).rows[0]??null;
}

function assertPaymentBinding(row:AgentCheckoutRow,order:AgentCheckoutRow,siteId:string,methodCode:string,provider:string){
 if(row.site_id!==siteId||methodCode!=='STRIPE_CARD'||provider!==(row.simulation?'stripe_test':'stripe')
  ||row.order_id!==order.id||row.bundle_id!==order.bundle_id||row.price_minor!==order.price_minor||row.currency!==order.currency
  ||String(row.byte_limit)!==String(order.byte_limit)||row.validity_seconds!==order.validity_seconds)throw new AgentCheckoutError('agent_checkout_terms_mismatch');
}

export async function reserveAgentCheckout(client:PoolClient,row:AgentCheckoutRow,order:AgentCheckoutRow,siteId:string,methodCode:string,provider:string){
 assertPaymentBinding(row,order,siteId,methodCode,provider);
 if(row.closed_at||row.stock_state==='released')throw new AgentCheckoutError('agent_checkout_closed');
 if(row.stock_state==='reserved')return;
 if(row.stock_state!=='none')throw new AgentCheckoutError('order_not_payable');
 if(!await currentTerms(client,row,true))throw new AgentCheckoutError('site_or_bundle_unavailable');
 const stock=(await client.query('SELECT quantity FROM agent_site_inventory WHERE agent_id=$1 AND site_id=$2 AND bundle_id=$3 FOR UPDATE',[row.agent_id,row.site_id,row.bundle_id])).rows[0];
 if(!stock?.quantity)throw new AgentCheckoutError('out_of_stock');
 await client.query('UPDATE agent_site_inventory SET quantity=quantity-1 WHERE agent_id=$1 AND site_id=$2 AND bundle_id=$3',[row.agent_id,row.site_id,row.bundle_id]);
 await client.query("UPDATE agent_checkouts SET stock_state='reserved',reserved_at=clock_timestamp() WHERE id=$1",[row.id]);
}

export function assertAgentAttemptReplay(row:AgentCheckoutRow,order:AgentCheckoutRow,siteId:string,methodCode:string,provider:string){
 assertPaymentBinding(row,order,siteId,methodCode,provider);
 // Reading an already-closed original attempt is safe. No new remote creation
 // is permitted from a released reservation.
 return row.stock_state==='reserved'&&!row.closed_at;
}

// The order and attempt are already locked by the existing payment coordinator.
export async function fulfillAgentCheckout(client:PoolClient,orderId:string,chargeId:string,entitlementId:string,partialRefund=false){
 const row=await lockAgentCheckoutForOrder(client,orderId);if(!row)return;
 const verified=(await client.query(
  "SELECT c.id FROM verified_charges c JOIN provider_payment_attempts a ON a.id=c.attempt_id JOIN purchase_orders o ON o.id=c.order_id JOIN purchase_entitlements e ON e.id=c.fulfilled_entitlement_id WHERE c.id=$1 AND c.order_id=$2 AND c.state='succeeded' AND c.fulfilled_entitlement_id=$3 AND e.order_id=o.id AND e.customer_id=o.customer_id AND a.customer_id=o.customer_id AND a.site_id=$4 AND a.method_code='STRIPE_CARD' AND a.provider=$5 AND c.amount_minor=o.price_minor AND c.currency=o.currency AND o.bundle_id=$6 AND o.price_minor=$7 AND o.currency=$8 AND o.byte_limit=$9 AND o.validity_seconds=$10",
  [chargeId,orderId,entitlementId,row.site_id,row.simulation?'stripe_test':'stripe',row.bundle_id,row.price_minor,row.currency,row.byte_limit,row.validity_seconds],
 )).rowCount;
 if(!verified||row.closed_at||!['reserved','consumed'].includes(row.stock_state)||(row.fulfilled_charge_id&&row.fulfilled_charge_id!==chargeId))throw new AgentCheckoutError('agent_checkout_settlement_mismatch');
 if(row.stock_state==='reserved')await client.query("UPDATE agent_checkouts SET stock_state='consumed',consumed_at=clock_timestamp(),fulfilled_charge_id=$2,commission_review=commission_review OR $3 WHERE id=$1",[row.id,chargeId,partialRefund]);
 else if(partialRefund)await client.query('UPDATE agent_checkouts SET commission_review=true WHERE id=$1',[row.id]);
}

// Only a freshly retrieved, fully bound Stripe canceled intent may close and
// release a reservation. A sheet close, decline, timeout or dispute cannot.
export async function releaseCanceledAgentCheckout(client:PoolClient,orderId:string){
 const row=await lockAgentCheckoutForOrder(client,orderId);if(!row||row.stock_state!=='reserved'||row.closed_at)return;
 const unsafe=(await client.query(
  "SELECT EXISTS(SELECT 1 FROM purchase_orders WHERE id=$1 AND status<>'awaiting_payment') OR EXISTS(SELECT 1 FROM verified_charges WHERE order_id=$1) OR EXISTS(SELECT 1 FROM purchase_entitlements WHERE order_id=$1) OR EXISTS(SELECT 1 FROM payment_reviews WHERE order_id=$1 AND resolved_at IS NULL) OR EXISTS(SELECT 1 FROM provider_payment_attempts WHERE order_id=$1 AND (state<>'failed' OR provider_reference IS NULL OR provider<>$2 OR method_code<>'STRIPE_CARD' OR site_id<>$3)) AS unsafe",
  [orderId,row.simulation?'stripe_test':'stripe',row.site_id],
 )).rows[0].unsafe;
 if(unsafe)return;
 await client.query("UPDATE agent_checkouts SET stock_state='released',released_at=clock_timestamp(),closed_at=clock_timestamp() WHERE id=$1",[row.id]);
 const restored=await client.query('UPDATE agent_site_inventory SET quantity=quantity+1 WHERE agent_id=$1 AND site_id=$2 AND bundle_id=$3',[row.agent_id,row.site_id,row.bundle_id]);
 if(restored.rowCount!==1)throw new AgentCheckoutError('agent_checkout_stock_unavailable');
}

export const agentCheckoutStatusColumns=
 "a.*,o.quote_expires_at,c.state AS charge_state,EXISTS(SELECT 1 FROM payment_reviews r WHERE r.charge_id=a.fulfilled_charge_id AND r.resolved_at IS NULL) AS charge_review,EXISTS(SELECT 1 FROM payment_reviews r WHERE r.order_id=a.order_id AND r.resolved_at IS NULL) AS order_review,EXISTS(SELECT 1 FROM verified_charges r WHERE r.order_id=a.order_id AND r.state='reversed' AND r.fulfilled_entitlement_id IS NULL) AS unfulfilled_reversal,EXISTS(SELECT 1 FROM provider_payment_attempts p WHERE p.order_id=a.order_id AND p.state IN ('initiating','unknown','pending','review')) AS payment_pending";
export const agentCheckoutStatusJoins=' FROM agent_checkouts a LEFT JOIN purchase_orders o ON o.id=a.order_id LEFT JOIN verified_charges c ON c.id=a.fulfilled_charge_id ';

export function agentCheckoutStatus(row:AgentCheckoutRow){
 const commissionState=row.fulfilled_charge_id?(row.charge_state==='reversed'?'reversed':row.commission_review||row.charge_review?'review':'earned'):'unearned';
 const status=row.fulfilled_charge_id?(row.charge_state==='reversed'?(row.charge_review?'review':'reversed'):'paid')
  :row.closed_at?'cancelled':row.order_id?(row.order_review||row.unfulfilled_reversal?'review':row.payment_pending||row.stock_state==='reserved'?'payment_pending':row.quote_expires_at?.getTime()<=Date.now()?'expired':'awaiting_payment')
  :row.expires_at.getTime()<=Date.now()?'expired':'unclaimed';
 return {id:row.id,orderId:row.order_id,agentId:row.agent_id,quote:agentCheckoutQuote(row),status,stockState:row.stock_state,
  commission:{basisPoints:row.commission_bps,amountMinor:row.commission_minor,currency:row.currency,state:commissionState},
  createdAt:row.created_at,expiresAt:row.expires_at,paidAt:row.consumed_at,simulation:row.simulation};
}
