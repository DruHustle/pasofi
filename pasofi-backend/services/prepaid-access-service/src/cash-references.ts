import {createHash, randomInt, randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {seal, unseal, type DeliveryKeys} from './delivery-crypto.js';
import {VoucherError} from './vouchers.js';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const referenceHash = (code: string) => createHash('sha256').update(code).digest();
export function referenceStatus(row: Record<string, any>) {
 return row.sale_id ? 'ready' : row.cancelled_at ? 'cancelled' : row.expires_at.getTime() <= Date.now() ? 'expired' : 'pending';
}
export function referenceQuote(row: Record<string, any>) {
 return row.bundle_id ? {bundleId: row.bundle_id, siteId: row.site_id, siteName: row.site_name, priceMinor: row.price_minor, currency: row.currency, byteLimit: String(row.byte_limit), validitySeconds: row.validity_seconds} : null;
}
export async function lookupCashReference(pool: Pool, code: string, siteId: string, agentId: string | null) {
 // The agent uses this read to decide whether to collect cash. It does not
 // reserve stock. The sale transaction rechecks these conditions under lock.
 const {rows} = await pool.query(`
  SELECT p.sale_id, p.cancelled_at, p.expires_at, p.bundle_id, p.site_id, p.site_name,
         p.price_minor, p.currency, p.byte_limit, p.validity_seconds,
         l.enabled, b.published, s.id AS shift_id, i.quantity
    FROM receipt_pairings p
    JOIN sales_locations l ON l.id=p.site_id
    JOIN bundle_versions b ON b.id=p.bundle_id
    LEFT JOIN cash_shifts s ON s.agent_id=$3 AND s.site_id=p.site_id AND s.currency=p.currency AND s.closed_at IS NULL
    LEFT JOIN agent_site_inventory i ON i.agent_id=$3 AND i.site_id=p.site_id AND i.bundle_id=p.bundle_id
   WHERE p.code_hash=$1 AND p.site_id=$2`, [referenceHash(code),siteId,agentId]);
 const row=rows[0];
 if(!row)return null;
 const status=referenceStatus(row);
 if(agentId && status==='pending') {
  if(!row.enabled)throw new VoucherError('site_unavailable');
  if(!row.published)throw new VoucherError('bundle_unavailable');
  if(!row.shift_id)throw new VoucherError('shift_required');
  if(!row.quantity)throw new VoucherError('out_of_stock');
 }
 return {status,expiresAt:row.expires_at,quote:referenceQuote(row)};
}

export async function createCashReference(pool: Pool, customerId: string, requestKey: string, bundleId: string, siteId: string, keys: DeliveryKeys) {
 const client = await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`cash-reference:${customerId}:${requestKey}`]);
  let row = (await client.query('SELECT * FROM receipt_pairings WHERE customer_id=$1 AND request_key=$2', [customerId, requestKey])).rows[0];
  const replayed = !!row;
  if (row && (row.bundle_id !== bundleId || row.site_id !== siteId)) throw new VoucherError('idempotency_conflict');
  if (!row) {
   const item = (await client.query('SELECT b.*,l.name AS site_name FROM bundle_versions b CROSS JOIN sales_locations l WHERE b.id=$1 AND b.published AND l.id=$2 AND l.enabled', [bundleId, siteId])).rows[0];
   if (!item) throw new VoucherError('site_or_bundle_unavailable');
   const id = randomUUID(), code = Array.from({length: 10}, () => alphabet[randomInt(alphabet.length)]).join(''), encrypted = seal(code, keys, `pairing:${id}`);
   row = (await client.query(`INSERT INTO receipt_pairings(id,customer_id,request_key,code_hash,key_id,code_cipher,code_iv,code_tag,expires_at,bundle_id,site_id,site_name,price_minor,currency,byte_limit,validity_seconds)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '5 minutes',$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
    [id,customerId,requestKey,referenceHash(code),encrypted.keyId,encrypted.cipher,encrypted.iv,encrypted.tag,bundleId,siteId,item.site_name,item.price_minor,item.currency,item.byte_limit,item.validity_seconds])).rows[0];
  }
  const code = unseal({keyId:row.key_id,iv:row.code_iv,cipher:row.code_cipher,tag:row.code_tag}, keys, `pairing:${row.id}`);
  await client.query('COMMIT');
  return {pairing: {id: row.id, code, expiresAt: row.expires_at, status: referenceStatus(row), quote: referenceQuote(row)}, replayed};
 } catch (error) { await client.query('ROLLBACK'); throw error; }
 finally { client.release(); }
}

export async function cancelCashReference(pool: Pool, customerId: string, id: string) {
 const client = await pool.connect();
 try {
  await client.query('BEGIN');
  const row = (await client.query('SELECT * FROM receipt_pairings WHERE id=$1 AND customer_id=$2 FOR UPDATE', [id, customerId])).rows[0];
  if (!row) { await client.query('COMMIT'); return null; }
  if (row.sale_id) throw new VoucherError('pairing_already_paid');
  await client.query('UPDATE receipt_pairings SET cancelled_at=COALESCE(cancelled_at,now()) WHERE id=$1', [id]);
  await client.query('COMMIT');
  return {status: 'cancelled'};
 } catch (error) { await client.query('ROLLBACK'); throw error; }
 finally { client.release(); }
}
