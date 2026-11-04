import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {FastifyInstance,FastifyReply} from 'fastify';
import {cashTransaction,shiftTotals,type CashStaffResolver} from './cash-shifts.js';
import {VoucherError} from './vouchers.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const validReason=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>=10&&value.length<=500;
const zeroHash='0'.repeat(64);
const hash=(previous:string,payload:string)=>createHash('sha256').update(`${previous}\n${payload}`).digest('hex');
async function event(client:PoolClient,id:string,actor:string,state:string,details:unknown) {
 const last=(await client.query('SELECT sequence,entry_hash FROM cash_refund_events WHERE refund_id=$1 ORDER BY sequence DESC LIMIT 1',[id])).rows[0];
 const previous=last?.entry_hash??zeroHash,sequence=(last?.sequence??0)+1,payload=JSON.stringify({refundId:id,sequence,actorId:actor,state,recordedAt:new Date().toISOString(),details});
 await client.query('INSERT INTO cash_refund_events(refund_id,sequence,payload,previous_hash,entry_hash) VALUES($1,$2,$3,$4,$5)',[id,sequence,payload,previous,hash(previous,payload)]);
}
async function audit(client:Pick<PoolClient,'query'>,id:string,state:string) {
 const rows=(await client.query('SELECT sequence,payload,previous_hash,entry_hash FROM cash_refund_events WHERE refund_id=$1 ORDER BY sequence',[id])).rows;
 let previous=zeroHash,index=0,lastState='';
 const events=rows.map(row=>{
  if(row.sequence!==++index||row.previous_hash!==previous||hash(previous,row.payload)!==row.entry_hash)throw Error('refund_audit_invalid');
  previous=row.entry_hash;const parsed=JSON.parse(row.payload);if(parsed.refundId!==id||parsed.sequence!==index)throw Error('refund_audit_invalid');lastState=parsed.state;
  return {...parsed,hash:row.entry_hash};
 });
 if(!events.length||lastState!==state)throw Error('refund_audit_invalid');
 return {auditHead:previous,events};
}
async function dto(client:Pick<PoolClient,'query'>,row:Record<string,any>) {
 return {id:row.id,saleId:row.sale_id,agentId:row.agent_id,siteId:row.site_id,siteName:row.site_name,bundleId:row.bundle_id,amountMinor:row.price_minor,currency:row.currency,reason:row.reason,requestedBy:row.requested_by,requestedAt:row.requested_at,state:row.state,decidedBy:row.decided_by,decisionNote:row.decision_note,decidedAt:row.decided_at,reservedAt:row.reserved_at,paidAt:row.paid_at,payoutShiftId:row.payout_shift_id,...await audit(client,row.id,row.state)};
}
const select=`SELECT r.*,s.agent_id,s.site_id,s.site_name,s.bundle_id,s.price_minor,s.currency,s.commission_minor FROM cash_refunds r JOIN agent_sales s ON s.id=r.sale_id`;
async function voidUnusedAccess(client:PoolClient,saleId:string) {
 // Match replacement's sale -> voucher order. Redemption also locks the voucher,
 // and network grant issuance serializes on the customer's advisory lock.
 await client.query('SELECT id FROM agent_sales WHERE id=$1 FOR UPDATE',[saleId]);
 const voucher=(await client.query("SELECT * FROM issued_vouchers WHERE sale_id=$1 AND state IN ('valid','redeemed') FOR UPDATE",[saleId])).rows[0];
 if(!voucher)throw new VoucherError('refund_access_unavailable');
 if(voucher.state==='valid') {
  await client.query("UPDATE issued_vouchers SET state='revoked' WHERE id=$1",[voucher.id]);return;
 }
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[voucher.redeemed_by]);
 const entitlement=(await client.query('SELECT * FROM purchase_entitlements WHERE source_voucher_id=$1 FOR UPDATE',[voucher.id])).rows[0];
 if(!entitlement||entitlement.revoked_at||entitlement.activated_at||BigInt(entitlement.consumed_bytes)!==0n)throw new VoucherError('refund_usage_review_required');
 const unresolved=await client.query("SELECT 1 FROM access_grants WHERE entitlement_id=$1 AND state<>'closed' UNION ALL SELECT 1 FROM network_account_holds WHERE customer_id=$2",[entitlement.id,voucher.redeemed_by]);
 if(unresolved.rowCount)throw new VoucherError('refund_usage_review_required');
 await client.query('UPDATE purchase_entitlements SET revoked_at=now() WHERE id=$1',[entitlement.id]);
 // Keep the original redemption evidence. The refund record prevents redemption
 // replay, replacement, delivery or another credit for this sale.
}
export function registerCashRefunds(app:FastifyInstance,pool:Pool|null,staff:CashStaffResolver) {
 const fail=(reply:FastifyReply,error:unknown)=>reply.code(error instanceof VoucherError?409:503).send({error:error instanceof VoucherError?error.code:'unavailable'});
 app.get('/v1/staff/cash-refunds',async(request,reply)=>{
  const s=await staff(request,reply,['agent','admin']);if(!s)return;
  try{const rows=(await pool!.query(`${select} WHERE ($1::boolean OR s.agent_id=$2) ORDER BY r.requested_at DESC,r.id DESC LIMIT 50`,[s.role==='admin',s.staffId])).rows;return {refunds:await Promise.all(rows.map(row=>dto(pool!,row)))};}catch(error){return fail(reply,error);}
 });
 app.post('/v1/staff/cash-refunds',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(request,reply)=>{
  const s=await staff(request,reply,['agent']);if(!s)return;const b=object(request.body),key=request.headers['idempotency-key'];
  if(typeof key!=='string'||!uuid.test(key)||typeof b.saleId!=='string'||!uuid.test(b.saleId)||!validReason(b.reason))return reply.code(400).send({error:'invalid_refund'});
  try{const result=await cashTransaction(pool!,async client=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`cash-refund:${s.staffId}`]);
   const previous=(await client.query(`${select} WHERE r.requested_by=$1 AND r.request_key=$2`,[s.staffId,key])).rows[0];
   if(previous){if(previous.sale_id!==b.saleId||previous.reason!==(b.reason as string).trim())throw new VoucherError('idempotency_conflict');return {refund:await dto(client,previous),replayed:true};}
   const sale=(await client.query("SELECT * FROM agent_sales WHERE id=$1 AND agent_id=$2 AND payment_method='cash' FOR UPDATE",[b.saleId,s.staffId])).rows[0];
   if(!sale)throw new VoucherError('refund_sale_unavailable');
   if(!s.siteIds.includes(sale.site_id))throw new VoucherError('refund_site_forbidden');
   if((await client.query('SELECT id FROM cash_refunds WHERE sale_id=$1',[sale.id])).rowCount)throw new VoucherError('refund_already_requested');
   const id=randomUUID();await client.query('INSERT INTO cash_refunds(id,sale_id,requested_by,request_key,reason) VALUES($1,$2,$3,$4,$5)',[id,sale.id,s.staffId,key,(b.reason as string).trim()]);
   await event(client,id,s.staffId,'requested',{saleId:sale.id,amountMinor:sale.price_minor,currency:sale.currency,reason:(b.reason as string).trim()});
   const row=(await client.query(`${select} WHERE r.id=$1`,[id])).rows[0];return {refund:await dto(client,row),replayed:false};
  });return reply.code(result.replayed?200:201).send(result);}catch(error){return fail(reply,error);}
 });
 app.post<{Params:{id:string}}>('/v1/admin/cash-refunds/:id/decision',async(request,reply)=>{
  const s=await staff(request,reply,['admin']);if(!s)return;const b=object(request.body),key=request.headers['idempotency-key'];
  if(!uuid.test(request.params.id)||typeof key!=='string'||!uuid.test(key)||!['approved','rejected'].includes(String(b.decision))||!validReason(b.note))return reply.code(400).send({error:'invalid_refund_decision'});
  try{return await cashTransaction(pool!,async client=>{
   const row=(await client.query(`${select} WHERE r.id=$1 FOR UPDATE OF r`,[request.params.id])).rows[0];if(!row)throw new VoucherError('refund_unavailable');
   await audit(client,row.id,row.state);
   if(row.decided_at){if(row.decided_by!==s.staffId||row.decision_key!==key||row.decision_note!==(b.note as string).trim()||(b.decision==='rejected')!==(row.state==='rejected'))throw new VoucherError('refund_already_decided');return {refund:await dto(client,row),replayed:true};}
   if(row.requested_by===s.staffId||row.agent_id===s.staffId)throw new VoucherError('independent_supervisor_required');
   if(b.decision==='approved')await voidUnusedAccess(client,row.sale_id);
   await client.query('UPDATE cash_refunds SET state=$2,decided_by=$3,decision_key=$4,decision_note=$5,decided_at=now() WHERE id=$1',[row.id,b.decision,s.staffId,key,(b.note as string).trim()]);
   await event(client,row.id,s.staffId,b.decision as string,{note:(b.note as string).trim(),amountMinor:row.price_minor,currency:row.currency});
   return {refund:await dto(client,(await client.query(`${select} WHERE r.id=$1`,[row.id])).rows[0]),replayed:false};
  });}catch(error){return fail(reply,error);}
 });
 app.post<{Params:{id:string}}>('/v1/staff/cash-refunds/:id/prepare-payout',async(request,reply)=>{
  const s=await staff(request,reply,['agent']);if(!s)return;const key=request.headers['idempotency-key'];
  if(!uuid.test(request.params.id)||typeof key!=='string'||!uuid.test(key))return reply.code(400).send({error:'invalid_idempotency_key'});
  try{return await cashTransaction(pool!,async client=>{
   const row=(await client.query(`${select} WHERE r.id=$1 AND s.agent_id=$2 FOR UPDATE OF r`,[request.params.id,s.staffId])).rows[0];if(!row)throw new VoucherError('refund_unavailable');
   await audit(client,row.id,row.state);
   if(row.reserved_at){if(row.reserve_key!==key||row.reserved_by!==s.staffId)throw new VoucherError('refund_payout_already_prepared');return {refund:await dto(client,row),replayed:true};}
   if(row.state!=='approved')throw new VoucherError('refund_not_approved');
   if(!s.siteIds.includes(row.site_id))throw new VoucherError('refund_site_forbidden');
   const shift=(await client.query('SELECT * FROM cash_shifts WHERE agent_id=$1 AND site_id=$2 AND currency=$3 AND closed_at IS NULL FOR UPDATE',[s.staffId,row.site_id,row.currency])).rows[0];if(!shift)throw new VoucherError('shift_required');
   const totals=await shiftTotals(client,shift.id),expected=BigInt(shift.opening_minor)+BigInt(totals.salesMinor)-BigInt(totals.refundsMinor)-BigInt(totals.pendingRefundsMinor);
   if(expected<BigInt(row.price_minor))throw new VoucherError('refund_insufficient_cash');
   await client.query("UPDATE cash_refunds SET state='paying',reserved_by=$2,reserve_key=$3,payout_shift_id=$4,reserved_at=now() WHERE id=$1",[row.id,s.staffId,key,shift.id]);
   await event(client,row.id,s.staffId,'paying',{amountMinor:row.price_minor,currency:row.currency,shiftId:shift.id});
   return {refund:await dto(client,(await client.query(`${select} WHERE r.id=$1`,[row.id])).rows[0]),replayed:false};
  });}catch(error){return fail(reply,error);}
 });
 app.post<{Params:{id:string}}>('/v1/staff/cash-refunds/:id/payout',async(request,reply)=>{
  const s=await staff(request,reply,['agent']);if(!s)return;const b=object(request.body),key=request.headers['idempotency-key'];
  if(!uuid.test(request.params.id)||typeof key!=='string'||!uuid.test(key)||b.confirmed!==true)return reply.code(400).send({error:'cash_return_confirmation_required'});
  try{return await cashTransaction(pool!,async client=>{
   const row=(await client.query(`${select} WHERE r.id=$1 AND s.agent_id=$2 FOR UPDATE OF r`,[request.params.id,s.staffId])).rows[0];if(!row)throw new VoucherError('refund_unavailable');
   await audit(client,row.id,row.state);
   if(row.state==='paid'){if(row.payout_key!==key||row.paid_by!==s.staffId)throw new VoucherError('refund_already_paid');return {refund:await dto(client,row),replayed:true};}
   if(row.state!=='paying'||row.reserved_by!==s.staffId)throw new VoucherError('refund_payout_not_prepared');
   // The reservation prevents closing this shift until the agent records the
   // actual cash return. Site withdrawal cannot strand an already reserved payout.
   const shift=(await client.query('SELECT id FROM cash_shifts WHERE id=$1 AND agent_id=$2 AND closed_at IS NULL FOR UPDATE',[row.payout_shift_id,s.staffId])).rows[0];if(!shift)throw new VoucherError('shift_required');
   await client.query("UPDATE cash_refunds SET state='paid',paid_by=$2,payout_key=$3,paid_at=now() WHERE id=$1",[row.id,s.staffId,key]);
   await event(client,row.id,s.staffId,'paid',{amountMinor:row.price_minor,currency:row.currency,shiftId:shift.id,evidence:'agent_cash_return_attestation'});
   return {refund:await dto(client,(await client.query(`${select} WHERE r.id=$1`,[row.id])).rows[0]),replayed:false};
  });}catch(error){return fail(reply,error);}
 });
}
