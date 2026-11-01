import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { SendaiAdapter, SmsResult } from './sendai.js';
type Adapter=Pick<SendaiAdapter,'send'|'retrieve'>;
type Message={to:string;from:string;message:string};
export class DeliveryError extends Error { constructor(public readonly code:string){super(code);} }
// Internal functions only: staff authorization, secure payload retrieval and a
// provider-enabled policy must be enforced by the caller before use.
export async function sendOnce(pool:Pool,jobId:string,adapter:Adapter,message:Message) {
 const client=await pool.connect();let attemptId:string;
 try {
  await client.query('BEGIN');
  const job=await client.query('SELECT state FROM delivery_jobs WHERE id=$1 FOR UPDATE',[jobId]);
  if(!job.rowCount || job.rows[0].state!=='ready') throw new DeliveryError('not_ready');
  const seq=await client.query('SELECT COALESCE(MAX(attempt_number),0)+1 AS next FROM delivery_attempts WHERE job_id=$1',[jobId]);
  attemptId=randomUUID();
  await client.query("INSERT INTO delivery_attempts(id,job_id,attempt_number,state) VALUES ($1,$2,$3,'submitting')",[attemptId,jobId,seq.rows[0].next]);
  await client.query("UPDATE delivery_jobs SET state='submitting' WHERE id=$1",[jobId]);
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 let result:SmsResult;
 try { result=await adapter.send(message); }
 catch {result={state:'unknown',providerId:null,providerStatus:null,deliveredAt:null,cost:null};}
 const writer=await pool.connect();
 try {
  await writer.query('BEGIN');
  // Preserve a late provider response even if the stale monitor already marked
  // this attempt unknown; it may supply the only usable provider message ID.
  const attempt=await writer.query("UPDATE delivery_attempts SET state=$2,provider_id=$3,provider_status=$4,charge_amount=$5,charge_scale=$6,charge_currency=$7,delivered_at=$8,updated_at=now() WHERE id=$1 AND state IN ('submitting','unknown') RETURNING job_id,attempt_number",[attemptId,result.state,result.providerId,result.providerStatus,result.cost?.amount??null,result.cost?.scale??null,result.cost?.currency??null,result.deliveredAt]);
  if(attempt.rowCount) await writer.query("UPDATE delivery_jobs SET state=$2 WHERE id=$1 AND state IN ('submitting','unknown') AND NOT EXISTS (SELECT 1 FROM delivery_attempts WHERE job_id=$1 AND attempt_number>$3)",[jobId,result.state,attempt.rows[0].attempt_number]);
  await writer.query('COMMIT');
  return {attemptId,state:attempt.rowCount?result.state:'unknown'};
 }catch(error){await writer.query('ROLLBACK');throw error;}finally{writer.release();}
}
export async function markStaleSubmissionsUnknown(pool:Pool,minimumAgeSeconds:number,jobId?:string) {
 if(!Number.isInteger(minimumAgeSeconds)||minimumAgeSeconds<60) throw new DeliveryError('invalid_stale_age');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const rows=await client.query("UPDATE delivery_attempts SET state='unknown',updated_at=now() WHERE state='submitting' AND updated_at < now()-make_interval(secs=>$1) AND ($2::uuid IS NULL OR job_id=$2) RETURNING job_id",[minimumAgeSeconds,jobId??null]);
  if(rows.rowCount) await client.query("UPDATE delivery_jobs SET state='unknown' WHERE id=ANY($1::uuid[]) AND state='submitting'",[rows.rows.map(r=>r.job_id)]);
  await client.query('COMMIT');return rows.rowCount??0;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function pollAttempt(pool:Pool,attemptId:string,adapter:Adapter) {
 const found=await pool.query("SELECT id,job_id,provider_id FROM delivery_attempts WHERE id=$1 AND state='submitted'",[attemptId]);
 if(!found.rowCount || !found.rows[0].provider_id) throw new DeliveryError('not_pollable');
 const row=found.rows[0], result=await adapter.retrieve(row.provider_id);
 if(result.providerId!==row.provider_id || result.state==='unknown') return {state:'submitted'};
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const updated=await client.query("UPDATE delivery_attempts SET state=$2,provider_status=$3,charge_amount=COALESCE($4,charge_amount),charge_scale=COALESCE($5,charge_scale),charge_currency=COALESCE($6,charge_currency),delivered_at=$7,updated_at=now() WHERE id=$1 AND state='submitted' RETURNING job_id",[attemptId,result.state,result.providerStatus,result.cost?.amount??null,result.cost?.scale??null,result.cost?.currency??null,result.deliveredAt]);
  if(updated.rowCount) await client.query("UPDATE delivery_jobs SET state=$2 WHERE id=$1 AND state='submitted'",[row.job_id,result.state]);
  const current=updated.rowCount ? result.state : (await client.query('SELECT state FROM delivery_attempts WHERE id=$1',[attemptId])).rows[0]?.state ?? 'unknown';
  await client.query('COMMIT');return {state:current};
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
