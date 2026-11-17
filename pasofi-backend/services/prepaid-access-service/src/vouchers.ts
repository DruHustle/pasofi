import { createHash, randomInt, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {seal,unseal,type DeliveryKeys} from './delivery-crypto.js';
import {issueCashInvoice,normalizeInvoiceDelivery} from './invoices.js';
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export class VoucherError extends Error { constructor(public readonly code:string){ super(code); } }
async function tx<T>(pool:Pool, fn:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try { await client.query('BEGIN'); const result=await fn(client); await client.query('COMMIT'); return result; }
  catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
}
function normalized(value:string):string { return value.toUpperCase().replace(/[-\s]/g,''); }
function digest(value:string):Buffer { return createHash('sha256').update(value).digest(); }
function decrypt(row:{id:string;sale_id:string|null;ecocash_credit_id:string|null;key_id:string;code_iv:Buffer;code_cipher:Buffer;code_tag:Buffer},keys:DeliveryKeys):string {
 const source=row.sale_id ?? `ecocash:${row.ecocash_credit_id}`;
 return unseal({keyId:row.key_id,iv:row.code_iv,cipher:row.code_cipher,tag:row.code_tag},keys,`${source}:${row.id}`);
}
function newCode(){return Array.from({length:16},()=>alphabet[randomInt(alphabet.length)]).join('');}
function format(code:string){return code.match(/.{4}/g)!.join('-');}
async function makeVoucher(client:PoolClient,source:{saleId:string}|{creditId:string},parentId:string|null,key:DeliveryKeys){
  const saleId='saleId' in source?source.saleId:null, creditId='creditId' in source?source.creditId:null;
  const code=newCode(), id=randomUUID(), encrypted=seal(code,key,`${saleId ?? `ecocash:${creditId}`}:${id}`);
  await client.query(`INSERT INTO issued_vouchers (id,sale_id,parent_id,code_hash,code_cipher,code_iv,code_tag,key_id,state,ecocash_credit_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'valid',$9)`,[id,saleId,parentId,digest(code),encrypted.cipher,encrypted.iv,encrypted.tag,encrypted.keyId,creditId]);
  return {id,code:format(code)};
}
// The credit writer holds the credit lock and writes its delivery event in the same transaction.
export async function createEcoCashVoucher(client:PoolClient,creditId:string,keys:DeliveryKeys):Promise<string>{
 return (await makeVoucher(client,{creditId},null,keys)).id;
}
// These domain functions are called only after the commerce boundary resolves
// the current MFA-verified staff role and enforces its approved site scope.
export type SaleOptions={replayOnly?:boolean;siteInventory?:boolean;commissionBps?:number;siteName?:string;delivery?:'receipt'|'sms'|'both';pairingCode?:string;phone?:string;simulation?:boolean;payment?:unknown;invoiceDelivery?:unknown};
export async function sellVoucher(pool:Pool, agentId:string, siteId:string, bundleId:string, requestKey:string, deliveryKey:DeliveryKeys,options:SaleOptions={}) {
 const commissionBps=options.commissionBps??0,delivery=options.delivery??'receipt';
 const payment=options.payment&&typeof options.payment==='object'&&!Array.isArray(options.payment)?options.payment as Record<string,unknown>:null;
 const intent={siteId,bundleId,delivery,pairingCode:options.pairingCode??null,phone:options.phone??null};
 const legacyFingerprint=digest(JSON.stringify(intent));
 const invoiceDelivery=normalizeInvoiceDelivery(options.invoiceDelivery);
 const fingerprint=digest(JSON.stringify({...intent,payment:payment?{method:payment.method,confirmed:payment.confirmed,amountMinor:payment.amountMinor,currency:payment.currency}:null,...(invoiceDelivery.channel==='download'?{}:{invoiceDelivery})}));
 return tx(pool,async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${agentId}:${requestKey}`]);
  const previous=await client.query('SELECT * FROM agent_sales WHERE agent_id=$1 AND idempotency_key=$2',[agentId,requestKey]);
  if(previous.rowCount){
    const sale=previous.rows[0],expectedFingerprint=sale.payment_method==='cash'?fingerprint:legacyFingerprint;
    if(sale.site_id!==siteId || sale.bundle_id!==bundleId || (sale.request_hash&&!sale.request_hash.equals(expectedFingerprint))) throw new VoucherError('idempotency_conflict');
    if((await client.query("SELECT id FROM cash_refunds WHERE sale_id=$1 AND state IN ('approved','paying','paid')",[sale.id])).rowCount)return {saleId:sale.id,voucherId:null,code:'',replayed:true};
    const voucher=await client.query("SELECT * FROM issued_vouchers WHERE sale_id=$1 AND state IN ('valid','redeemed')",[sale.id]);
    if(!voucher.rowCount) throw new VoucherError('delivery_unavailable');
    return {saleId:sale.id,voucherId:voucher.rows[0].id,code:format(decrypt(voucher.rows[0],deliveryKey)),replayed:true};
  }
  if(options.replayOnly)throw new VoucherError('sale_not_recorded');
  if(!Number.isInteger(commissionBps)||commissionBps<0||commissionBps>10000)throw new VoucherError('invalid_commission');
  // Serialize a new sale with a location pause. The boundary's earlier read
  // cannot prevent a concurrent status change. Holding a shared row lock until
  // commit means a confirmed pause blocks subsequent sales, while replay above
  // still recovers already-paid receipts, including after a location is paused.
  let siteName=options.siteName??'';
  if(options.siteInventory){
   const location=(await client.query<{name:string;enabled:boolean}>('SELECT name,enabled FROM sales_locations WHERE id=$1 FOR SHARE',[siteId])).rows[0];
   if(!location?.enabled)throw new VoucherError('cash_sale_site_unavailable');
   siteName=location.name;
  }
  // The authenticated agent attests receipt of cash; this is not evidence from
  // a payment provider. Validate only after replay so older committed requests
  // remain recoverable without inventing cash evidence for historical sales.
  if(options.siteInventory&&(!payment||payment.method!=='cash'||payment.confirmed!==true))throw new VoucherError('cash_confirmation_required');
  // A withdrawal and a new sale must agree on which committed first. Paid
  // retries above still recover the original invoice after withdrawal.
  const product=await client.query('SELECT price_minor,currency,byte_limit::text,validity_seconds FROM bundle_versions WHERE id=$1 AND published=true FOR SHARE',[bundleId]);
  if(!product.rowCount) throw new VoucherError('bundle_unavailable');
  if(options.siteInventory&&(!Number.isSafeInteger(payment!.amountMinor)||payment!.amountMinor!==product.rows[0].price_minor||payment!.currency!==product.rows[0].currency))throw new VoucherError('cash_amount_mismatch');
  let shiftId:string|null=null;
  if(options.siteInventory){
   const shift=(await client.query('SELECT id FROM cash_shifts WHERE agent_id=$1 AND site_id=$2 AND currency=$3 AND closed_at IS NULL AND NOT refund_only FOR UPDATE',[agentId,siteId,product.rows[0].currency])).rows[0];
   if(!shift)throw new VoucherError('shift_required');shiftId=shift.id;
  }
  const stock=options.siteInventory?
   await client.query('SELECT quantity FROM agent_site_inventory WHERE agent_id=$1 AND site_id=$2 AND bundle_id=$3 FOR UPDATE',[agentId,siteId,bundleId]):
   await client.query('SELECT quantity FROM agent_inventory WHERE agent_id=$1 AND bundle_id=$2 FOR UPDATE',[agentId,bundleId]);
  if(!stock.rowCount || stock.rows[0].quantity<1) throw new VoucherError('out_of_stock');
  let pairedCustomer:string|null=null,pairingId:string|null=null;
  if(options.pairingCode){
   const pairing=await client.query('SELECT * FROM receipt_pairings WHERE code_hash=$1 AND expires_at>clock_timestamp() AND sale_id IS NULL AND cancelled_at IS NULL FOR UPDATE',[digest(normalized(options.pairingCode))]);
   if(!pairing.rowCount)throw new VoucherError('pairing_unavailable');
   const reference=pairing.rows[0],terms=product.rows[0];
   if(reference.expires_at.getTime()<=Date.now())throw new VoucherError('pairing_unavailable');
   if(reference.bundle_id!==bundleId||reference.site_id!==siteId||reference.price_minor!==terms.price_minor||reference.currency!==terms.currency||String(reference.byte_limit)!==String(terms.byte_limit)||reference.validity_seconds!==terms.validity_seconds)throw new VoucherError('pairing_terms_mismatch');
   pairedCustomer=reference.customer_id;pairingId=reference.id;
  }
  if(options.siteInventory&&delivery!=='sms'&&!pairingId)throw new VoucherError('pairing_required');
  if(options.siteInventory&&delivery!=='receipt'&&(!options.phone||!/^263[0-9]{9}$/.test(options.phone)))throw new VoucherError('invalid_phone');
  const item=product.rows[0], saleId=randomUUID();
  await client.query(`INSERT INTO agent_sales (id,agent_id,site_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,start_by,site_name,commission_bps,commission_minor,delivery,simulation,request_hash,payment_method,cash_received_minor,cash_confirmed_at,shift_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '30 days',$10,$11,$12,$13,$14,$15,$16,$17,CASE WHEN $16='cash' THEN now() ELSE NULL END,$18)`,[saleId,agentId,siteId,requestKey,bundleId,item.price_minor,item.currency,item.byte_limit,item.validity_seconds,siteName,commissionBps,Math.floor(item.price_minor*commissionBps/10000),delivery,options.simulation??true,options.siteInventory?fingerprint:legacyFingerprint,options.siteInventory?'cash':null,options.siteInventory?item.price_minor:null,shiftId]);
  if(options.siteInventory)await client.query('UPDATE agent_site_inventory SET quantity=quantity-1 WHERE agent_id=$1 AND site_id=$2 AND bundle_id=$3',[agentId,siteId,bundleId]);
  else await client.query('UPDATE agent_inventory SET quantity=quantity-1 WHERE agent_id=$1 AND bundle_id=$2',[agentId,bundleId]);
  if(options.siteInventory){
   const details=seal(JSON.stringify({phone:options.phone??null}),deliveryKey,`sale:${saleId}`);
   await client.query('INSERT INTO agent_sale_deliveries(sale_id,channel,key_id,payload_cipher,payload_iv,payload_tag,paired_customer_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[saleId,delivery,details.keyId,details.cipher,details.iv,details.tag,pairedCustomer]);
   if(pairingId)await client.query('UPDATE receipt_pairings SET sale_id=$2 WHERE id=$1',[pairingId,saleId]);
  }
  const voucher=await makeVoucher(client,{saleId},null,deliveryKey);
  if(options.siteInventory)await issueCashInvoice(client,saleId,invoiceDelivery,deliveryKey);
  await client.query("INSERT INTO event_outbox (id,event_type,event_version,aggregate_id,aggregate_version,correlation_id,payload) VALUES ($1,'agent.sale.created',1,$2,1,$3,$4)",[randomUUID(),saleId,randomUUID(),JSON.stringify({deliveryReference:saleId})]);
  return {saleId,voucherId:voucher.id,code:voucher.code,replayed:false};
 });
}
export async function redeemVoucher(pool:Pool, customerId:string, raw:string, demo=false) {
 const code=normalized(raw);
 if(code.length!==16 || [...code].some(c=>!alphabet.includes(c))) throw new VoucherError('invalid_or_used');
 return tx(pool,async client=>{
  const codeHash=digest(code);
  const result=await client.query(`SELECT v.*,s.bundle_id,s.byte_limit::text AS allowance,s.validity_seconds,s.sold_at,s.start_by,s.start_by>=now() AS usable,d.paired_customer_id
    FROM issued_vouchers v JOIN agent_sales s ON s.id=v.sale_id LEFT JOIN agent_sale_deliveries d ON d.sale_id=s.id WHERE v.code_hash=$1 FOR UPDATE OF v`,[codeHash]);
  let v=result.rows[0];
  if(!v && demo) {
    // Reversal also locks the credit before the voucher. Once acquired, its state and
    // the voucher state must remain eligible until the entitlement write commits.
    const credit=(await client.query(`SELECT c.id FROM ecocash_credits c JOIN issued_vouchers v ON v.ecocash_credit_id=c.id
      WHERE v.code_hash=$1 AND c.environment='simulation' AND c.state='issued' FOR UPDATE OF c`,[codeHash])).rows[0];
    if(credit) v=(await client.query(`SELECT v.*,c.bundle_id,c.byte_limit::text AS allowance,c.validity_seconds,
      c.paid_at AS sold_at,c.start_by,c.start_by>=clock_timestamp() AS usable
      FROM issued_vouchers v JOIN ecocash_credits c ON c.id=v.ecocash_credit_id WHERE c.id=$1 AND v.code_hash=$2 FOR UPDATE OF v`,[credit.id,codeHash])).rows[0];
  }
  if(!v)throw new VoucherError('invalid_or_used');
  if(v.sale_id && (await client.query("SELECT id FROM cash_refunds WHERE sale_id=$1 AND state IN ('approved','paying','paid')",[v.sale_id])).rowCount)throw new VoucherError('voucher_refunded');
  if(v.paired_customer_id&&v.paired_customer_id!==customerId)throw new VoucherError('invalid_or_used');
  if(v.state==='redeemed' && v.redeemed_by===customerId){
    const prior=await client.query('SELECT id FROM purchase_entitlements WHERE source_voucher_id=$1',[v.id]);
    if(!prior.rowCount) throw new VoucherError('unavailable');
    return {entitlementId:prior.rows[0].id,replayed:true};
  }
  if(v.state!=='valid' || !v.usable) throw new VoucherError('invalid_or_used');
  const entitlementId=randomUUID();
  await client.query(`INSERT INTO purchase_entitlements (id,order_id,source_voucher_id,customer_id,bundle_id,byte_limit,validity_seconds,purchased_at,start_by)
    VALUES ($1,NULL,$2,$3,$4,$5,$6,$7,$8)`,[entitlementId,v.id,customerId,v.bundle_id,v.allowance,v.validity_seconds,v.sold_at,v.start_by]);
  await client.query("UPDATE issued_vouchers SET state='redeemed',redeemed_by=$2 WHERE id=$1",[v.id,customerId]);
  return {entitlementId,replayed:false};
 });
}
export async function replaceVoucher(pool:Pool, saleId:string, key:DeliveryKeys){
 return tx(pool,async client=>{
  const sale=await client.query('SELECT id,start_by>=now() AS usable FROM agent_sales WHERE id=$1 FOR UPDATE',[saleId]);
  if(!sale.rowCount || !sale.rows[0].usable) throw new VoucherError('replacement_unavailable');
  const current=await client.query("SELECT id,state FROM issued_vouchers WHERE sale_id=$1 AND state IN ('valid','redeemed') FOR UPDATE",[saleId]);
  if(!current.rowCount || current.rows[0].state!=='valid') throw new VoucherError('replacement_unavailable');
  await client.query("UPDATE issued_vouchers SET state='revoked' WHERE id=$1",[current.rows[0].id]);
  return makeVoucher(client,{saleId},current.rows[0].id,key);
 });
}

export async function readVoucher(pool:Pool,saleId:string,keys:DeliveryKeys){
 const rows=await pool.query(`SELECT v.*,r.state AS refund_state FROM issued_vouchers v LEFT JOIN cash_refunds r ON r.sale_id=v.sale_id WHERE v.sale_id=$1 ORDER BY (v.state IN ('valid','redeemed')) DESC,v.created_at DESC,v.id DESC LIMIT 1`,[saleId]);
 if(!rows.rowCount)throw new VoucherError('delivery_unavailable');const row=rows.rows[0];
 if(['approved','paying','paid'].includes(row.refund_state))return {id:row.id,code:'',state:row.refund_state==='paid'?'refunded':'voided_refund_due'};
 if(row.state==='revoked')throw new VoucherError('delivery_unavailable');
 return {id:row.id,code:format(decrypt(row,keys)),state:row.state};
}

// Only the authenticated notification worker can use this lookup. Delivery retries
// read the already-issued code and always target the payer recorded with the credit.
export async function readEcoCashDelivery(pool:Pool,creditId:string,keys:DeliveryKeys,demo:boolean){
 if(!demo)return null;
 const row=(await pool.query(`SELECT v.*,c.bundle_id,c.phone_key_id,c.phone_iv,c.phone_cipher,c.phone_tag,
     c.state AS credit_state,c.start_by>clock_timestamp() AS usable
   FROM ecocash_credits c LEFT JOIN issued_vouchers v ON v.ecocash_credit_id=c.id
   WHERE c.id=$1 AND c.environment='simulation'`,[creditId])).rows[0];
 if(!row)return null;
 if(row.credit_state!=='issued'||!row.usable||row.state!=='valid')throw new VoucherError('ecocash_delivery_closed');
 const to=unseal({keyId:row.phone_key_id,iv:row.phone_iv,cipher:row.phone_cipher,tag:row.phone_tag},keys,`ecocash:phone:${row.ecocash_credit_id}`);
 const code=format(decrypt(row,keys));
 return {deliveryReference:creditId,creditId,channel:'sms',to,from:process.env.SMS_SENDER??'PasoFi',
   message:`PasoFi demo ${row.bundle_id} voucher: ${code}. Redeem on PasoFi Wi-Fi. Keep this code private.`,simulation:true};
}
