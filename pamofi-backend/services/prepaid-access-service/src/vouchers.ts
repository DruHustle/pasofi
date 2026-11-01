import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export class VoucherError extends Error { constructor(public readonly code:string){ super(code); } }
async function tx<T>(pool:Pool, fn:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try { await client.query('BEGIN'); const result=await fn(client); await client.query('COMMIT'); return result; }
  catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
}
function normalized(value:string):string { return value.toUpperCase().replace(/[-\s]/g,''); }
function digest(value:string):Buffer { return createHash('sha256').update(value).digest(); }
function encrypt(code:string,key:Buffer,aad:string) {
  if(key.length!==32) throw new VoucherError('invalid_delivery_key');
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext=Buffer.concat([cipher.update(code,'utf8'),cipher.final()]);
  return {iv,ciphertext,tag:cipher.getAuthTag()};
}
function decrypt(row:{id:string;sale_id:string;code_iv:Buffer;code_cipher:Buffer;code_tag:Buffer},key:Buffer):string {
  if(key.length!==32) throw new VoucherError('invalid_delivery_key');
  const cipher=createDecipheriv('aes-256-gcm',key,row.code_iv);cipher.setAAD(Buffer.from(`${row.sale_id}:${row.id}`));cipher.setAuthTag(row.code_tag);
  return Buffer.concat([cipher.update(row.code_cipher),cipher.final()]).toString('utf8');
}
function newCode(){return Array.from({length:16},()=>alphabet[randomInt(alphabet.length)]).join('');}
function format(code:string){return code.match(/.{4}/g)!.join('-');}
async function makeVoucher(client:PoolClient,saleId:string,parentId:string|null,key:Buffer){
  const code=newCode(), id=randomUUID(), encrypted=encrypt(code,key,`${saleId}:${id}`);
  await client.query(`INSERT INTO issued_vouchers (id,sale_id,parent_id,code_hash,code_cipher,code_iv,code_tag,state)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'valid')`,[id,saleId,parentId,digest(code),encrypted.ciphertext,encrypted.iv,encrypted.tag]);
  return {id,code:format(code)};
}
// These are internal domain functions, not exposed to agents until staff identity,
// authorization, pairing and delivery-reference access are implemented.
export async function sellVoucher(pool:Pool, agentId:string, siteId:string, bundleId:string, requestKey:string, deliveryKey:Buffer) {
 return tx(pool,async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${agentId}:${requestKey}`]);
  const previous=await client.query('SELECT * FROM agent_sales WHERE agent_id=$1 AND idempotency_key=$2',[agentId,requestKey]);
  if(previous.rowCount){
    const sale=previous.rows[0];if(sale.site_id!==siteId || sale.bundle_id!==bundleId) throw new VoucherError('idempotency_conflict');
    const voucher=await client.query("SELECT * FROM issued_vouchers WHERE sale_id=$1 AND state IN ('valid','redeemed')",[sale.id]);
    if(!voucher.rowCount) throw new VoucherError('delivery_unavailable');
    return {saleId:sale.id,voucherId:voucher.rows[0].id,code:format(decrypt(voucher.rows[0],deliveryKey)),replayed:true};
  }
  const stock=await client.query('SELECT quantity FROM agent_inventory WHERE agent_id=$1 AND bundle_id=$2 FOR UPDATE',[agentId,bundleId]);
  if(!stock.rowCount || stock.rows[0].quantity<1) throw new VoucherError('out_of_stock');
  const product=await client.query('SELECT price_minor,currency,byte_limit::text,validity_seconds FROM bundle_versions WHERE id=$1 AND published=true',[bundleId]);
  if(!product.rowCount) throw new VoucherError('bundle_unavailable');
  const item=product.rows[0], saleId=randomUUID();
  await client.query(`INSERT INTO agent_sales (id,agent_id,site_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,start_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '30 days')`,[saleId,agentId,siteId,requestKey,bundleId,item.price_minor,item.currency,item.byte_limit,item.validity_seconds]);
  await client.query('UPDATE agent_inventory SET quantity=quantity-1 WHERE agent_id=$1 AND bundle_id=$2',[agentId,bundleId]);
  const voucher=await makeVoucher(client,saleId,null,deliveryKey);
  await client.query("INSERT INTO event_outbox (id,event_type,event_version,aggregate_id,aggregate_version,correlation_id,payload) VALUES ($1,'agent.sale.created',1,$2,1,$3,$4)",[randomUUID(),saleId,randomUUID(),JSON.stringify({deliveryReference:saleId})]);
  return {saleId,voucherId:voucher.id,code:voucher.code,replayed:false};
 });
}
export async function redeemVoucher(pool:Pool, customerId:string, raw:string) {
 const code=normalized(raw);
 if(code.length!==16 || [...code].some(c=>!alphabet.includes(c))) throw new VoucherError('invalid_or_used');
 return tx(pool,async client=>{
  const result=await client.query(`SELECT v.*,s.bundle_id,s.byte_limit::text AS allowance,s.validity_seconds,s.sold_at,s.start_by,s.start_by>=now() AS usable
    FROM issued_vouchers v JOIN agent_sales s ON s.id=v.sale_id WHERE v.code_hash=$1 FOR UPDATE OF v`,[digest(code)]);
  if(!result.rowCount) throw new VoucherError('invalid_or_used');
  const v=result.rows[0];
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
export async function replaceVoucher(pool:Pool, saleId:string, key:Buffer){
 return tx(pool,async client=>{
  const sale=await client.query('SELECT id,start_by>=now() AS usable FROM agent_sales WHERE id=$1 FOR UPDATE',[saleId]);
  if(!sale.rowCount || !sale.rows[0].usable) throw new VoucherError('replacement_unavailable');
  const current=await client.query("SELECT id,state FROM issued_vouchers WHERE sale_id=$1 AND state IN ('valid','redeemed') FOR UPDATE",[saleId]);
  if(!current.rowCount || current.rows[0].state!=='valid') throw new VoucherError('replacement_unavailable');
  await client.query("UPDATE issued_vouchers SET state='revoked' WHERE id=$1",[current.rows[0].id]);
  return makeVoucher(client,saleId,current.rows[0].id,key);
 });
}
