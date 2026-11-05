import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';

export type SalesLocation = {id:string;name:string;enabled:boolean;version:string};
export type SalesLocationStatusInput = {siteId:string;enabled:boolean;expectedVersion:string;reason:string};
type StatusResult = {site:SalesLocation;changed:boolean};
type StatusEvidence = {requestId:string;input:SalesLocationStatusInput;before:SalesLocation;result:StatusResult};
export class SalesLocationError extends Error {
 constructor(public readonly code:'not_found'|'version_conflict'|'idempotency_conflict'){super(code);}
}

// The route has already resolved the current approved, MFA-verified admin.
// Read the prior event before checking current state: an old successful retry
// recovers its own result and must never undo a newer administrator's decision.
export async function setSalesLocationStatus(pool:Pool,actorId:string,requestId:string,input:SalesLocationStatusInput):Promise<StatusResult&{replayed:boolean}> {
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${actorId}:site-status:${requestId}`]);
  const prior=await client.query<{details:StatusEvidence}>("SELECT details FROM commerce_audit WHERE actor_id=$1 AND action='site.status' AND details->>'requestId'=$2",[actorId,requestId]);
  if(prior.rowCount){
   const saved=prior.rows[0].details,original=saved.input;
   if(original.siteId!==input.siteId||original.enabled!==input.enabled||original.expectedVersion!==input.expectedVersion||original.reason!==input.reason)throw new SalesLocationError('idempotency_conflict');
   await client.query('COMMIT');
   return {...saved.result,replayed:true};
  }
  const row=await client.query<SalesLocation>('SELECT id,name,enabled,status_version::text AS version FROM sales_locations WHERE id=$1 FOR UPDATE',[input.siteId]);
  const before=row.rows[0];
  if(!before)throw new SalesLocationError('not_found');
  if(before.version!==input.expectedVersion)throw new SalesLocationError('version_conflict');
  const changed=before.enabled!==input.enabled;
  const site=changed?(await client.query<SalesLocation>('UPDATE sales_locations SET enabled=$2 WHERE id=$1 RETURNING id,name,enabled,status_version::text AS version',[input.siteId,input.enabled])).rows[0]:before;
  const result={site,changed},details:StatusEvidence={requestId,input,before,result};
  await client.query("INSERT INTO commerce_audit(id,actor_id,action,target_id,reason,details) VALUES($1,$2,'site.status',$3,$4,$5)",[randomUUID(),actorId,input.siteId,input.reason,JSON.stringify(details)]);
  await client.query('COMMIT');
  return {...result,replayed:false};
 } catch(error){await client.query('ROLLBACK');throw error;}
 finally{client.release();}
}
