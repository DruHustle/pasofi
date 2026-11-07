import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type {PaymentAdapter,PaymentProvider} from './payment-provider.js';
import { reconcileProviderPayment } from './payments.js';

type CallbackAdapter = {callbackAuthorized(header:unknown):boolean};
const referencePattern = /^[A-Za-z0-9_-]{1,128}$/;

// The callback is only a scheduling hint. It can neither create an attempt nor
// provide evidence of payment. A later callback re-arms an exhausted job.
export async function enqueuePaymentReference(pool: Pool, reference: string): Promise<boolean> {
 if (!referencePattern.test(reference)) return false;
 const result = await pool.query(`INSERT INTO payment_reconciliation_jobs(attempt_id)
  SELECT id FROM provider_payment_attempts WHERE provider='pesepay' AND provider_reference=$1
  ON CONFLICT (attempt_id) DO UPDATE SET
   requested_version=payment_reconciliation_jobs.requested_version+1,
   state=CASE WHEN payment_reconciliation_jobs.state='leased' THEN 'leased' ELSE 'pending' END,
   attempt_count=CASE WHEN payment_reconciliation_jobs.state IN ('idle','dead') THEN 0 ELSE payment_reconciliation_jobs.attempt_count END,
   due_at=CASE WHEN payment_reconciliation_jobs.state='leased' THEN payment_reconciliation_jobs.due_at ELSE now() END,
   updated_at=now()
  RETURNING attempt_id`, [reference]);
 return !!result.rowCount;
}

// Register only in an explicitly configured environment; callers control whether
// this route exists. Unknown references receive the same response as known ones.
export function registerPesepayCallback(app: FastifyInstance, pool: Pool, adapter: CallbackAdapter): void {
 app.post<{Body: unknown}>('/callbacks/pesepay', {config:{rateLimit:{max:120,timeWindow:'1 minute'}}}, async (request, reply) => {
  if (!adapter.callbackAuthorized(request.headers.authorization)) return reply.code(401).send({error:'unauthorized'});
  const body = request.body;
  if (body && typeof body === 'object' && !Array.isArray(body) && 'referenceNumber' in body && typeof body.referenceNumber === 'string') {
   try { await enqueuePaymentReference(pool,body.referenceNumber); }
   catch { return reply.code(503).send({error:'unavailable'}); }
  }
  return reply.code(204).send();
 });
}

type Lease = {attempt_id:string; lease_token:string; lease_version:string; attempt_count:number};
export async function claimPaymentReconciliation(pool: Pool, leaseSeconds = 30, provider?:PaymentProvider): Promise<Lease | null> {
 if (!Number.isInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 300) throw Error('invalid_lease');
 const token=randomUUID();
 const result=await pool.query(`WITH candidate AS (
   SELECT j.attempt_id FROM payment_reconciliation_jobs j JOIN provider_payment_attempts a ON a.id=j.attempt_id
   WHERE ((j.state='pending' AND j.due_at<=now()) OR (j.state='leased' AND j.lease_until<=now()))
    AND ($3::text IS NULL OR a.provider=$3)
   ORDER BY j.due_at,j.attempt_id FOR UPDATE OF j SKIP LOCKED LIMIT 1
  ) UPDATE payment_reconciliation_jobs j SET state='leased',lease_token=$1,lease_version=j.requested_version,
   lease_until=now()+make_interval(secs=>$2),attempt_count=j.attempt_count+1,updated_at=now()
  FROM candidate WHERE j.attempt_id=candidate.attempt_id
  RETURNING j.attempt_id,j.lease_token,j.lease_version::text,j.attempt_count`,[token,leaseSeconds,provider??null]);
 return result.rows[0] ?? null;
}

// A late worker cannot acknowledge a reclaimed lease. Notifications received
// during a check are processed again, even when the first check succeeded.
export async function finishPaymentReconciliation(pool: Pool, lease: Lease, result: string): Promise<boolean> {
 const valid = new Set(['fulfilled','pending','unable_to_verify','failed','reversed','pending_review','previously_verified','error']);
 if (!valid.has(result)) throw Error('invalid_result');
 const retry = ['pending','unable_to_verify','error'].includes(result);
 const delaySeconds = Math.min(300, 5 * 2 ** Math.min(lease.attempt_count - 1, 6));
 const updated=await pool.query(`UPDATE payment_reconciliation_jobs SET
   state=CASE WHEN requested_version<>lease_version THEN 'pending'
              WHEN $3::boolean AND attempt_count>=10 THEN 'dead'
              WHEN $3::boolean THEN 'pending' ELSE 'idle' END,
   attempt_count=CASE WHEN requested_version<>lease_version THEN 0 ELSE attempt_count END,
   due_at=CASE WHEN requested_version<>lease_version THEN now() ELSE now()+make_interval(secs=>$4) END,
   last_result=$5,lease_token=NULL,lease_version=NULL,lease_until=NULL,updated_at=now()
  WHERE attempt_id=$1 AND state='leased' AND lease_token=$2 AND lease_until>now() RETURNING attempt_id`,
 [lease.attempt_id,lease.lease_token,retry,delaySeconds,result]);
 return !!updated.rowCount;
}

export async function processPaymentReconciliation(pool: Pool, adapter: PaymentAdapter): Promise<boolean> {
 if(!['mock','pesepay','stripe','stripe_test'].includes(adapter.provider))throw Error('provider_unavailable');
 const lease=await claimPaymentReconciliation(pool,30,adapter.provider);
 if (!lease) return false;
 let result: string;
 try { result=(await reconcileProviderPayment(pool,lease.attempt_id,adapter)).state; }
 catch { result='error'; }
 await finishPaymentReconciliation(pool,lease,result);
 return true;
}
