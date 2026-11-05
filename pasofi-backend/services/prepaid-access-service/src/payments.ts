import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {eligibleMethod,type PaymentAdapter as Adapter,type MethodEligibility as Eligibility} from './payment-provider.js';
import {issueDigitalInvoice} from './invoices.js';
export class PaymentError extends Error {constructor(public readonly code:string){super(code);}}
async function tx<T>(pool:Pool,fn:(client:PoolClient)=>Promise<T>):Promise<T>{const client=await pool.connect();try{await client.query('BEGIN');const r=await fn(client);await client.query('COMMIT');return r;}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}}
// The checkout boundary authenticates ownership and supplies the server's
// merchant-enabled, site-qualified method and immutable order terms.
export async function beginProviderPayment(pool:Pool,customerId:string,orderId:string,requestKey:string,siteId:string,methodCode:string,eligibility:Eligibility,adapter:Adapter){
 if(!['mock','pesepay'].includes(adapter.provider))throw new PaymentError('provider_unavailable');
 const attempt=await tx(pool,async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${customerId}:${requestKey}`]);
  const order=await client.query('SELECT *,quote_expires_at>now() AS quote_valid FROM purchase_orders WHERE id=$1 AND customer_id=$2 FOR UPDATE',[orderId,customerId]);
  if(!order.rowCount)throw new PaymentError('order_not_found');
  const previous=await client.query('SELECT * FROM provider_payment_attempts WHERE customer_id=$1 AND request_key=$2',[customerId,requestKey]);
  if(previous.rowCount){if(previous.rows[0].order_id!==orderId || previous.rows[0].site_id!==siteId || previous.rows[0].method_code!==methodCode || previous.rows[0].provider!==adapter.provider)throw new PaymentError('idempotency_conflict');return {created:false,row:previous.rows[0],order:order.rows[0]};}
  if(order.rows[0].status!=='awaiting_payment'||order.rows[0].expired_unused_at||!order.rows[0].quote_valid)throw new PaymentError('order_not_payable');
  const method=eligibility?.method as {code?:unknown}|undefined;
  if(method?.code!==methodCode || !eligibleMethod(method,order.rows[0].currency,order.rows[0].price_minor,eligibility.merchantEnabledCodes,eligibility.siteQualifiedCodes))throw new PaymentError('method_not_qualified');
  const unresolved=await client.query("SELECT id FROM provider_payment_attempts WHERE order_id=$1 AND state IN ('initiating','unknown','pending','review')",[orderId]);
  if(unresolved.rowCount)throw new PaymentError('payment_pending');
  const id=randomUUID();
  const created=await client.query("INSERT INTO provider_payment_attempts(id,order_id,customer_id,request_key,site_id,method_code,provider,state) VALUES ($1,$2,$3,$4,$5,$6,$7,'initiating') RETURNING *",[id,orderId,customerId,requestKey,siteId,methodCode,adapter.provider]);
  return {created:true,row:created.rows[0],order:order.rows[0]};
 });
 if(!attempt.created)return {attemptId:attempt.row.id,state:attempt.row.state,redirectUrl:attempt.row.redirect_url as string|null};
 let initiated:Awaited<ReturnType<Adapter['initiate']>>;
 try{initiated=await adapter.initiate({orderId,amountMinor:attempt.order.price_minor,currency:attempt.order.currency,methodCode,eligibility});}
 catch{initiated={state:'unknown'};}
 try {
  const row=await pool.query(`WITH updated AS (
    UPDATE provider_payment_attempts SET state=$2,provider_reference=$3,redirect_url=$4,updated_at=now()
    WHERE id=$1 AND state IN ('initiating','unknown') RETURNING id,state,redirect_url,provider_reference
   ), scheduled AS (
    INSERT INTO payment_reconciliation_jobs(attempt_id) SELECT id FROM updated WHERE provider_reference IS NOT NULL
    ON CONFLICT (attempt_id) DO NOTHING
   ) SELECT state,redirect_url FROM updated`,[attempt.row.id,initiated.state==='initiated'?'pending':'unknown',initiated.referenceNumber??null,initiated.state==='initiated'?initiated.redirectUrl:null]);
  return {attemptId:attempt.row.id,state:row.rows[0]?.state??'unknown',redirectUrl:row.rows[0]?.redirect_url??null};
 }catch(error){
  // The remote call may already have created a charge. Never initiate again.
  const pgError=error as {code?:string;constraint?:string};
  if(pgError.code==='23505' && pgError.constraint==='provider_payment_attempts_provider_reference_key') {
   await tx(pool,async client=>{
    await client.query("UPDATE provider_payment_attempts SET state='review',updated_at=now() WHERE id=$1 AND state IN ('initiating','unknown')",[attempt.row.id]);
    await client.query("INSERT INTO payment_reviews(id,order_id,reason) VALUES ($1,$2,'provider_reference_conflict')",[randomUUID(),orderId]);
   });
   return {attemptId:attempt.row.id,state:'review',redirectUrl:null};
  }
  await pool.query("UPDATE provider_payment_attempts SET state='unknown',updated_at=now() WHERE id=$1 AND state='initiating'",[attempt.row.id]);
  return {attemptId:attempt.row.id,state:'unknown',redirectUrl:null};
 }
}
export async function expireUnusedOrder(pool:Pool,customerId:string,orderId:string){
 return tx(pool,async client=>{
  const found=await client.query(`SELECT purchase_mode,status,expired_unused_at,quote_expires_at<=clock_timestamp() AS expired
   FROM purchase_orders WHERE id=$1 AND customer_id=$2 FOR UPDATE`,[orderId,customerId]);
  if(!found.rowCount)throw new PaymentError('order_not_found');
  const order=found.rows[0];
  if(order.purchase_mode!=='checkout')throw new PaymentError('wrong_order_mode');
  if(order.expired_unused_at)return {orderId,state:'expired_unused',safeToRequote:true,replayed:true};
  if(order.status!=='awaiting_payment')throw new PaymentError('order_not_expirable');
  if(!order.expired)throw new PaymentError('quote_still_valid');
  const used=await client.query(`SELECT EXISTS(SELECT 1 FROM provider_payment_attempts WHERE order_id=$1)
    OR EXISTS(SELECT 1 FROM verified_charges WHERE order_id=$1)
    OR EXISTS(SELECT 1 FROM purchase_entitlements WHERE order_id=$1) AS present`,[orderId]);
  if(used.rows[0].present)throw new PaymentError('payment_attempt_exists');
  await client.query('UPDATE purchase_orders SET expired_unused_at=clock_timestamp() WHERE id=$1',[orderId]);
  return {orderId,state:'expired_unused',safeToRequote:true,replayed:false};
 });
}
export async function markStaleInitiationsUnknown(pool:Pool,minimumAgeSeconds:number,attemptId?:string){
 if(!Number.isInteger(minimumAgeSeconds)||minimumAgeSeconds<60)throw new PaymentError('invalid_stale_age');
 const rows=await pool.query("UPDATE provider_payment_attempts SET state='unknown',updated_at=now() WHERE state='initiating' AND updated_at<now()-make_interval(secs=>$1) AND ($2::uuid IS NULL OR id=$2) RETURNING id",[minimumAgeSeconds,attemptId??null]);return rows.rowCount??0;
}
// Only a direct server-to-server status check may reach the fulfillment transaction.
// Callback and browser payloads must never be passed as payment evidence.
export async function reconcileProviderPayment(pool:Pool,attemptId:string,adapter:Adapter){
 const known=await pool.query(`SELECT a.provider,a.provider_reference,a.order_id,o.price_minor,o.currency FROM provider_payment_attempts a JOIN purchase_orders o ON o.id=a.order_id WHERE a.id=$1`,[attemptId]);
 if(!known.rowCount||!known.rows[0].provider_reference)throw new PaymentError('reference_unavailable');
 const initial=known.rows[0];
 if(initial.provider!==adapter.provider)throw new PaymentError('provider_mismatch');
 const status=await adapter.check({referenceNumber:initial.provider_reference,amountMinor:initial.price_minor,currency:initial.currency});
 if(status.state==='unknown')return {state:'unable_to_verify'};
 if(status.state==='pending')return {state:'pending'};
 if(!['verified_success','failed','reversed'].includes(status.state))return {state:'unable_to_verify'};
 return tx(pool,async client=>{
  const rows=await client.query(`SELECT a.*,o.price_minor,o.currency,o.bundle_id,o.byte_limit::text,o.validity_seconds,o.status AS order_status
    FROM provider_payment_attempts a JOIN purchase_orders o ON o.id=a.order_id WHERE a.id=$1 FOR UPDATE OF a,o`,[attemptId]);
  if(!rows.rowCount)throw new PaymentError('reference_unavailable');
  const a=rows.rows[0];
  if(a.provider!==adapter.provider||a.provider_reference!==initial.provider_reference||a.price_minor!==initial.price_minor||a.currency!==initial.currency)throw new PaymentError('payment_changed');
  const previous=await client.query('SELECT * FROM verified_charges WHERE attempt_id=$1 FOR UPDATE',[attemptId]);
  // The fulfillment belongs to this exact charge, not merely to its order.
  // Preserve a review or reversal on retries and out-of-order provider replies.
  async function previousOutcome():Promise<'fulfilled'|'pending_review'|'reversed'> {
   const charge=previous.rows[0];
   if(charge.state==='reversed') {
    const review=await client.query("SELECT 1 FROM payment_reviews WHERE charge_id=$1 AND reason='consumed_reversal' LIMIT 1",[charge.id]);
    return review.rowCount?'pending_review':'reversed';
   }
   return charge.fulfilled_entitlement_id?'fulfilled':'pending_review';
  }
  if(status.state==='failed'){
   if(!previous.rowCount)await client.query("UPDATE provider_payment_attempts SET state='failed',updated_at=now() WHERE id=$1",[attemptId]);
   const prior=previous.rowCount?await previousOutcome():null;
   return {state:prior==='fulfilled'?'previously_verified':prior??'failed'};
  }
  if(status.state==='reversed'){
   if(!previous.rowCount) {
    // A reversal can arrive before the first successful status check. Persist it
    // so a delayed SUCCESS response cannot subsequently create free access.
    await client.query("INSERT INTO verified_charges(id,order_id,attempt_id,provider_reference,amount_minor,currency,state) VALUES ($1,$2,$3,$4,$5,$6,'reversed')",[randomUUID(),a.order_id,attemptId,a.provider_reference,a.price_minor,a.currency]);
    await client.query("UPDATE provider_payment_attempts SET state='reversed',updated_at=now() WHERE id=$1",[attemptId]);
    return {state:'reversed'};
   }
   const charge=previous.rows[0];
   if(charge.state==='reversed')return {state:await previousOutcome()};
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[a.customer_id]);
   const entitlement=charge.fulfilled_entitlement_id?await client.query('SELECT * FROM purchase_entitlements WHERE id=$1 FOR UPDATE',[charge.fulfilled_entitlement_id]):{rowCount:0,rows:[]};
   const grants=entitlement.rowCount?await client.query("SELECT id FROM access_grants WHERE entitlement_id=$1 AND state <> 'closed'",[entitlement.rows[0].id]):{rowCount:0};
   const safe=entitlement.rowCount && !entitlement.rows[0].activated_at && BigInt(entitlement.rows[0].consumed_bytes)===0n && !grants.rowCount;
   if(safe)await client.query('UPDATE purchase_entitlements SET revoked_at=now() WHERE id=$1',[entitlement.rows[0].id]);
   else if(entitlement.rowCount)await client.query("INSERT INTO payment_reviews(id,order_id,charge_id,reason) VALUES ($1,$2,$3,'consumed_reversal') ON CONFLICT DO NOTHING",[randomUUID(),a.order_id,charge.id]);
   await client.query("UPDATE verified_charges SET state='reversed',updated_at=now() WHERE id=$1",[charge.id]);
   await client.query("UPDATE provider_payment_attempts SET state='reversed',updated_at=now() WHERE id=$1",[attemptId]);
   return {state:safe||!entitlement.rowCount?'reversed':'pending_review'};
  }
  if(previous.rowCount)return {state:await previousOutcome()};
  const chargeId=randomUUID();
  await client.query("INSERT INTO verified_charges(id,order_id,attempt_id,provider_reference,amount_minor,currency,state) VALUES ($1,$2,$3,$4,$5,$6,'succeeded')",[chargeId,a.order_id,attemptId,a.provider_reference,a.price_minor,a.currency]);
  if(a.order_status==='payment_confirmed'){
   await client.query("INSERT INTO payment_reviews(id,order_id,charge_id,reason) VALUES ($1,$2,$3,'duplicate_charge') ON CONFLICT DO NOTHING",[randomUUID(),a.order_id,chargeId]);
   await client.query("UPDATE provider_payment_attempts SET state='review',updated_at=now() WHERE id=$1",[attemptId]);return {state:'pending_review'};
  }
  const entitlementId=randomUUID();
  await client.query("INSERT INTO purchase_entitlements(id,order_id,customer_id,bundle_id,byte_limit,validity_seconds,start_by) VALUES ($1,$2,$3,$4,$5,$6,now()+interval '30 days')",[entitlementId,a.order_id,a.customer_id,a.bundle_id,a.byte_limit,a.validity_seconds]);
  await client.query('UPDATE verified_charges SET fulfilled_entitlement_id=$2 WHERE id=$1',[chargeId,entitlementId]);
  await client.query("UPDATE purchase_orders SET status='payment_confirmed' WHERE id=$1",[a.order_id]);
  await client.query("UPDATE provider_payment_attempts SET state='succeeded',updated_at=now() WHERE id=$1",[attemptId]);
  await issueDigitalInvoice(client,chargeId);
  return {state:'fulfilled'};
 });
}
