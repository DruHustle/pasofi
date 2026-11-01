import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

// Internal domain functions only. They are deliberately not exposed through HTTP:
// the network service must first authenticate a trusted NAS and credential.
const maxSessionSeconds = 86400;
export class GrantError extends Error { constructor(public readonly code: string) { super(code); } }
async function transaction<T>(pool:Pool, work:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function issueGrant(pool:Pool, customerId:string, siteId:string, nasId:string, requestKey:string) {
  return transaction(pool, async client => {
    // Serialize even when there is no entitlement row yet; row locks alone cannot
    // protect against two first grants for the same customer.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',[customerId]);
    const replay=await client.query(`SELECT id,generation,site_id,nas_id,reserved_bytes::text,issued_at,deadline,state,deadline > now() AS safe
      FROM access_grants WHERE customer_id=$1 AND request_key=$2`,[customerId,requestKey]);
    if(replay.rowCount) {
      const grant=replay.rows[0];
      if(grant.site_id!==siteId || grant.nas_id!==nasId) throw new GrantError('idempotency_conflict');
      if(grant.state==='closed' || grant.state==='uncertain' || !grant.safe) throw new GrantError('grant_not_replayable');
      return {id:grant.id,generation:grant.generation,site_id:grant.site_id,nas_id:grant.nas_id,reserved_bytes:grant.reserved_bytes,issued_at:grant.issued_at,deadline:grant.deadline};
    }
    const existing=await client.query("SELECT id FROM access_grants WHERE customer_id=$1 AND state <> 'closed'",[customerId]);
    if(existing.rowCount) throw new GrantError('session_pending_or_active');
    const chosen=await client.query(`SELECT id, byte_limit::text, consumed_bytes::text, validity_seconds, activated_at,
      CASE WHEN activated_at IS NULL THEN now()+make_interval(secs=>LEAST(validity_seconds,$2))
           ELSE LEAST(activated_at+make_interval(secs=>validity_seconds),now()+make_interval(secs=>$2)) END AS deadline
      FROM purchase_entitlements
      WHERE customer_id=$1 AND consumed_bytes<byte_limit AND
      ((activated_at IS NOT NULL AND activated_at+make_interval(secs=>validity_seconds)>now()) OR (activated_at IS NULL AND start_by>=now()))
      ORDER BY (activated_at IS NULL), purchased_at, id FOR UPDATE LIMIT 1`,[customerId,maxSessionSeconds]);
    if(!chosen.rowCount) throw new GrantError('no_usable_entitlement');
    const entitlement=chosen.rows[0];
    const reserved=BigInt(entitlement.byte_limit)-BigInt(entitlement.consumed_bytes);
    if(reserved<=0n) throw new GrantError('no_usable_entitlement');
    const id=randomUUID(), generation=randomUUID();
    const result=await client.query(`INSERT INTO access_grants (id,customer_id,entitlement_id,site_id,nas_id,request_key,generation,state,reserved_bytes,deadline)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9) RETURNING id,generation,site_id,nas_id,reserved_bytes::text,issued_at,deadline`,
      [id,customerId,entitlement.id,siteId,nasId,requestKey,generation,reserved.toString(),entitlement.deadline]);
    return result.rows[0];
  });
}
export type TrustedAccounting = { grantId:string; siteId:string; nasId:string; generation:string; upload:bigint; download:bigint; kind:'start'|'interim'|'stop' };
export async function recordAccounting(pool:Pool, event:TrustedAccounting) {
  const maximum=(1n<<64n)-1n;
  if(event.upload<0n || event.download<0n || event.upload>maximum || event.download>maximum) throw new GrantError('invalid_counters');
  return transaction(pool, async client => {
    const rows=await client.query('SELECT *,reserved_bytes::text AS reserved,charged_bytes::text AS charged,upload_high::text AS upload,download_high::text AS download FROM access_grants WHERE id=$1 FOR UPDATE',[event.grantId]);
    if(!rows.rowCount) throw new GrantError('unknown_grant');
    const grant=rows.rows[0];
    if(grant.site_id!==event.siteId || grant.nas_id!==event.nasId || grant.generation!==event.generation) throw new GrantError('grant_context_mismatch');
    if(grant.state==='closed') return {state:'closed',chargedBytes:grant.charged};
    const oldUp=BigInt(grant.upload), oldDown=BigInt(grant.download);
    const up=event.upload>oldUp?event.upload:oldUp, down=event.download>oldDown?event.download:oldDown;
    const delta=(up-oldUp)+(down-oldDown), available=BigInt(grant.reserved)-BigInt(grant.charged);
    const toCharge=delta>available?available:delta;
    const uncertain=grant.state==='uncertain' || event.upload<oldUp || event.download<oldDown || delta>available;
    if(event.kind==='start') {
      // Conservative if Accounting-Start arrives late: a successful connection
      // starts validity no later than the original grant issue time.
      await client.query('UPDATE purchase_entitlements SET activated_at=COALESCE(activated_at,$2) WHERE id=$1',[grant.entitlement_id,grant.issued_at]);
    }
    if(toCharge>0n) await client.query('UPDATE purchase_entitlements SET consumed_bytes=consumed_bytes+$2 WHERE id=$1',[grant.entitlement_id,toCharge.toString()]);
    // A Stop packet alone is not yet independently qualified as complete final
    // usage. Keep the reservation and block transfer pending reconciliation.
    const state=uncertain || event.kind==='stop'?'uncertain':event.kind==='start'?'active':grant.state;
    const updated=await client.query(`UPDATE access_grants SET upload_high=$2,download_high=$3,charged_bytes=charged_bytes+$4,state=$5,
      closed_at=CASE WHEN $5='closed' THEN now() ELSE NULL END WHERE id=$1 RETURNING state,charged_bytes::text AS "chargedBytes"`,
      [grant.id,up.toString(),down.toString(),toCharge.toString(),state]);
    return updated.rows[0];
  });
}
