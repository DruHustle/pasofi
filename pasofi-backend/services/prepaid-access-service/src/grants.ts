import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

// Only the authenticated network boundary may invoke these domain functions.
const maxSessionSeconds = 86400;
// The RADIUS authority subtracts 30 seconds before sending Session-Timeout.
// A new reservation needs at least one whole usable second after this margin.
const canStartSession = `e.revoked_at IS NULL AND e.consumed_bytes<e.byte_limit AND
  ((e.activated_at IS NULL AND e.start_by>=statement_timestamp() AND e.validity_seconds>=31)
    OR e.activated_at+make_interval(secs=>e.validity_seconds)>=statement_timestamp()+interval '31 seconds')`;

export function selectNetworkEntitlement(client:PoolClient, customerId:string) {
  return client.query(`SELECT id FROM purchase_entitlements e WHERE e.customer_id=$1 AND ${canStartSession}
    ORDER BY (e.activated_at IS NULL),e.purchased_at,e.id LIMIT 1 FOR SHARE`,[customerId]);
}
export class GrantError extends Error { constructor(public readonly code: string) { super(code); } }
async function transaction<T>(pool:Pool, work:(client:PoolClient)=>Promise<T>):Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
// Callers lock the customer, entitlement and any pending grant before checking.
// Use the current clock so waiting on a lock cannot extend an expiring bundle.
export async function networkAccessEligible(client:PoolClient, customerId:string, entitlementId:string, grantId:string|null, credentialExpiresAt:string|null = null) {
  const result = await client.query(`SELECT 1 FROM purchase_entitlements e
    WHERE e.id=$1 AND e.customer_id=$2 AND e.revoked_at IS NULL AND e.consumed_bytes<e.byte_limit
      AND ((e.activated_at IS NULL AND e.start_by>=clock_timestamp())
        OR e.activated_at+make_interval(secs=>e.validity_seconds)>clock_timestamp())
      AND ($3::uuid IS NOT NULL OR (${canStartSession}))
      AND NOT EXISTS (SELECT 1 FROM network_account_holds WHERE customer_id=$2)
      AND ($3::uuid IS NULL OR EXISTS (
        SELECT 1 FROM access_grants g WHERE g.id=$3 AND g.customer_id=$2 AND g.entitlement_id=e.id
          AND g.state='pending' AND g.deadline>clock_timestamp()
          AND g.disconnect_requested_at IS NULL AND g.stop_received_at IS NULL
          AND g.credential_fenced_at IS NULL AND g.absent_verified_at IS NULL
          AND g.accounting_started_at IS NULL AND g.last_accounting_at IS NULL AND NOT g.accounting_anomaly
          AND g.charged_bytes=0 AND g.reserved_bytes<=e.byte_limit-e.consumed_bytes))
      AND ($4::timestamptz IS NULL OR $4::timestamptz>clock_timestamp())`,
    [entitlementId,customerId,grantId,credentialExpiresAt]);
  return result.rowCount===1;
}
export async function issueGrant(pool:Pool, customerId:string, siteId:string, nasId:string, requestKey:string, sessionId:string) {
  if(typeof sessionId!=='string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(sessionId)) throw new GrantError('invalid_session');
  try { return await transaction(pool, async client => {
    // Serialize even when there is no entitlement row yet; row locks alone cannot
    // protect against two first grants for the same customer.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',[customerId]);
    if((await client.query('SELECT 1 FROM network_account_holds WHERE customer_id=$1',[customerId])).rowCount) throw new GrantError('accounting_review_required');
    const replay=await client.query(`SELECT g.id,g.generation,g.site_id,g.nas_id,g.accounting_session_id,g.reserved_bytes::text,g.issued_at,g.deadline,g.entitlement_id
      FROM access_grants g JOIN purchase_entitlements e ON e.id=g.entitlement_id
      WHERE g.customer_id=$1 AND g.request_key=$2 FOR UPDATE OF g FOR SHARE OF e`,[customerId,requestKey]);
    if(replay.rowCount) {
      const grant=replay.rows[0];
      if(grant.site_id!==siteId || grant.nas_id!==nasId || grant.accounting_session_id!==sessionId) throw new GrantError('idempotency_conflict');
      // An Access-Request retry can recover a lost initial reply. Once accounting
      // starts, sending the original byte limit again could reset the NAS quota.
      if(!await networkAccessEligible(client,customerId,grant.entitlement_id,grant.id)) throw new GrantError('grant_not_replayable');
      return {id:grant.id,generation:grant.generation,site_id:grant.site_id,nas_id:grant.nas_id,reserved_bytes:grant.reserved_bytes,issued_at:grant.issued_at,deadline:grant.deadline};
    }
    const existing=await client.query("SELECT id FROM access_grants WHERE customer_id=$1 AND state <> 'closed'",[customerId]);
    if(existing.rowCount) throw new GrantError('session_pending_or_active');
    const chosen=await selectNetworkEntitlement(client,customerId);
    if(!chosen.rowCount) throw new GrantError('no_usable_entitlement');
    // Recheck on a fresh statement clock after acquiring the entitlement lock.
    // An expiring bundle must not leave a reservation the router cannot accept.
    const result=await client.query(`INSERT INTO access_grants
      (id,customer_id,entitlement_id,site_id,nas_id,request_key,generation,state,reserved_bytes,issued_at,deadline,accounting_session_id)
      SELECT $1,e.customer_id,e.id,$3,$4,$5,$6,'pending',e.byte_limit-e.consumed_bytes,statement_timestamp(),
        LEAST(COALESCE(e.activated_at,statement_timestamp())+make_interval(secs=>e.validity_seconds),
          statement_timestamp()+make_interval(secs=>$8)), $7
      FROM purchase_entitlements e WHERE e.id=$2 AND ${canStartSession}
      RETURNING id,generation,site_id,nas_id,reserved_bytes::text,issued_at,deadline`,
      [randomUUID(),chosen.rows[0].id,siteId,nasId,requestKey,randomUUID(),sessionId,maxSessionSeconds]);
    if(!result.rowCount) throw new GrantError('no_usable_entitlement');
    return result.rows[0];
  }); } catch(error) {
    if(typeof error==='object' && error!==null && 'constraint' in error && error.constraint==='one_live_grant_per_nas_session') throw new GrantError('nas_session_in_use');
    throw error;
  }
}
export type TrustedAccounting = { grantId:string; siteId:string; nasId:string; generation:string; sessionId:string; upload:bigint; download:bigint; kind:'start'|'interim'|'stop' };
export async function recordAccounting(pool:Pool, event:TrustedAccounting) {
  const maximum=(1n<<64n)-1n;
  if(typeof event.sessionId!=='string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(event.sessionId)) throw new GrantError('invalid_session');
  if(!['start','interim','stop'].includes(event.kind)) throw new GrantError('invalid_kind');
  if(typeof event.upload!=='bigint' || typeof event.download!=='bigint') throw new GrantError('invalid_counters');
  if(event.upload<0n || event.download<0n || event.upload>maximum || event.download>maximum) throw new GrantError('invalid_counters');
  return transaction(pool, async client => {
    const owner=await client.query('SELECT customer_id FROM access_grants WHERE id=$1',[event.grantId]);
    if(!owner.rowCount) throw new GrantError('unknown_grant');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[owner.rows[0].customer_id]);
    const rows=await client.query('SELECT *,reserved_bytes::text AS reserved,charged_bytes::text AS charged,upload_high::text AS upload,download_high::text AS download FROM access_grants WHERE id=$1 FOR UPDATE',[event.grantId]);
    if(!rows.rowCount) throw new GrantError('unknown_grant');
    const grant=rows.rows[0];
    if(grant.site_id!==event.siteId || grant.nas_id!==event.nasId || grant.generation!==event.generation) throw new GrantError('grant_context_mismatch');
    if(!grant.accounting_session_id || grant.accounting_session_id!==event.sessionId) throw new GrantError('session_mismatch');
    if(!grant.accounting_started_at && event.kind!=='start') throw new GrantError('start_required');
    const oldUp=BigInt(grant.upload), oldDown=BigInt(grant.download);
    if(grant.state==='closed') {
      if(event.upload>oldUp || event.download>oldDown) {
        // Contradictory traffic after final settlement is an incident, never an
        // ignored packet or a second debit against a newly reserved allowance.
        await client.query(`INSERT INTO network_account_holds(customer_id,grant_id,reason) VALUES($1,$2,'usage_after_final_stop') ON CONFLICT(customer_id) DO NOTHING`,[grant.customer_id,grant.id]);
        await client.query("UPDATE access_grants SET state='uncertain',accounting_anomaly=true,disconnect_requested_at=COALESCE(disconnect_requested_at,now()) WHERE customer_id=$1 AND state<>'closed'",[grant.customer_id]);
        await client.query('UPDATE access_grants SET accounting_anomaly=true,last_accounting_at=now() WHERE id=$1',[grant.id]);
        await client.query("INSERT INTO grant_reconciliation_events(id,grant_id,kind,observed_at,detail) VALUES($1,$2,'late_usage',now(),$3)",[randomUUID(),grant.id,JSON.stringify({upload:event.upload.toString(),download:event.download.toString()})]);
        return {state:'uncertain',chargedBytes:grant.charged};
      }
      return {state:'closed',chargedBytes:grant.charged};
    }
    const up=event.upload>oldUp?event.upload:oldUp, down=event.download>oldDown?event.download:oldDown;
    const delta=(up-oldUp)+(down-oldDown), available=BigInt(grant.reserved)-BigInt(grant.charged);
    const toCharge=delta>available?available:delta;
    const anomaly=event.upload<oldUp || event.download<oldDown || delta>available || (grant.stop_received_at && (event.upload>BigInt(grant.stop_upload) || event.download>BigInt(grant.stop_download)));
    const uncertain=grant.state==='uncertain' || anomaly;
    if(event.kind==='start') {
      if(!grant.accounting_started_at) await client.query('UPDATE access_grants SET accounting_started_at=now() WHERE id=$1',[grant.id]);
      // Conservative if Accounting-Start arrives late: a successful connection
      // starts validity no later than the original grant issue time.
      await client.query('UPDATE purchase_entitlements SET activated_at=COALESCE(activated_at,$2) WHERE id=$1',[grant.entitlement_id,grant.issued_at]);
    }
    if(toCharge>0n) await client.query('UPDATE purchase_entitlements SET consumed_bytes=consumed_bytes+$2 WHERE id=$1',[grant.entitlement_id,toCharge.toString()]);
    // A Stop remains reserved until independent router absence is recorded.
    const state=uncertain || event.kind==='stop'?'uncertain':event.kind==='start'?'active':grant.state;
    const updated=await client.query(`UPDATE access_grants SET upload_high=$2,download_high=$3,charged_bytes=charged_bytes+$4,state=$5,
      last_accounting_at=now(),accounting_anomaly=accounting_anomaly OR $6,
      stop_received_at=CASE WHEN $7 THEN COALESCE(stop_received_at,now()) ELSE stop_received_at END,
      stop_upload=CASE WHEN $7 AND stop_received_at IS NULL THEN $2 ELSE stop_upload END,
      stop_download=CASE WHEN $7 AND stop_received_at IS NULL THEN $3 ELSE stop_download END
      WHERE id=$1 RETURNING state,charged_bytes::text AS "chargedBytes"`,
      [grant.id,up.toString(),down.toString(),toCharge.toString(),state,Boolean(anomaly),event.kind==='stop']);
    return updated.rows[0];
  });
}

export type AbsenceEvidence={grantId:string;siteId:string;nasId:string;generation:string;sessionId:string;observationId:string;observedAt:string;credentialRevokedAt:string;absent:boolean};
export async function reconcileGrant(pool:Pool,evidence:AbsenceEvidence) {
  const observed=Date.parse(evidence.observedAt),revoked=Date.parse(evidence.credentialRevokedAt);
  if(!Number.isFinite(observed)||!Number.isFinite(revoked)||revoked>observed||observed>Date.now()+5000||observed<Date.now()-60000) throw new GrantError('invalid_evidence_time');
  return transaction(pool,async client=>{
    const owner=await client.query('SELECT customer_id FROM access_grants WHERE id=$1',[evidence.grantId]);
    if(!owner.rowCount)throw new GrantError('unknown_grant');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[owner.rows[0].customer_id]);
    const result=await client.query('SELECT * FROM access_grants WHERE id=$1 FOR UPDATE',[evidence.grantId]);
    const g=result.rows[0];
    if(g.site_id!==evidence.siteId||g.nas_id!==evidence.nasId||g.generation!==evidence.generation||g.accounting_session_id!==evidence.sessionId)throw new GrantError('grant_context_mismatch');
    if(observed<g.issued_at.getTime()||revoked<g.issued_at.getTime())throw new GrantError('invalid_evidence_time');
    const previous=await client.query('SELECT grant_id,kind,observed_at,detail FROM grant_reconciliation_events WHERE id=$1',[evidence.observationId]);
    if(previous.rowCount) {
      const p=previous.rows[0];
      if(p.grant_id!==g.id||p.kind!==(evidence.absent?'absent':'present')||p.observed_at.getTime()!==observed||Date.parse(p.detail.credentialRevokedAt)!==revoked)throw new GrantError('evidence_conflict');
      return {state:g.state,closed:g.state==='closed'};
    }
    await client.query('INSERT INTO grant_reconciliation_events(id,grant_id,kind,observed_at,detail) VALUES($1,$2,$3,$4,$5)',[evidence.observationId,g.id,evidence.absent?'absent':'present',evidence.observedAt,JSON.stringify({credentialRevokedAt:evidence.credentialRevokedAt})]);
    if(g.state==='closed') {
      // A later contradictory usage report can put a settled grant on hold.
      // Refresh only termination evidence for an audited operator resolution.
      await client.query('UPDATE access_grants SET credential_fenced_at=$2,absent_verified_at=CASE WHEN $3 THEN $4::timestamptz ELSE NULL END WHERE id=$1',[g.id,evidence.credentialRevokedAt,evidence.absent,evidence.observedAt]);
      return {state:'closed',closed:true};
    }
    const complete=evidence.absent && g.accounting_started_at && g.stop_received_at && !g.accounting_anomaly &&
      observed>=g.stop_received_at.getTime() && BigInt(g.stop_upload)===BigInt(g.upload_high) && BigInt(g.stop_download)===BigInt(g.download_high);
    await client.query(`UPDATE access_grants SET credential_fenced_at=$2,absent_verified_at=CASE WHEN $3 THEN $4::timestamptz ELSE NULL END,
      state=CASE WHEN $5 THEN 'closed' ELSE 'uncertain' END,closed_at=CASE WHEN $5 THEN now() ELSE NULL END WHERE id=$1`,
      [g.id,evidence.credentialRevokedAt,evidence.absent,evidence.observedAt,Boolean(complete)]);
    if(complete)await client.query("INSERT INTO grant_reconciliation_events(id,grant_id,kind,observed_at) VALUES($1,$2,'closed',$3)",[randomUUID(),g.id,evidence.observedAt]);
    return {state:complete?'closed':'uncertain',closed:Boolean(complete),reviewRequired:!complete};
  });
}

export async function markNasRestart(pool:Pool,siteId:string,nasId:string) {
  return transaction(pool,async client=>{
    const rows=await client.query("UPDATE access_grants SET state='uncertain',disconnect_requested_at=COALESCE(disconnect_requested_at,now()) WHERE site_id=$1 AND nas_id=$2 AND state<>'closed' RETURNING id",[siteId,nasId]);
    for(const row of rows.rows)await client.query("INSERT INTO grant_reconciliation_events(id,grant_id,kind,observed_at) VALUES($1,$2,'nas_restart',now())",[randomUUID(),row.id]);
    return {affected:rows.rowCount};
  });
}
