import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';

type Customer=(request:FastifyRequest)=>Promise<string|null>;
const uuidPattern='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}';

// Every number and timestamp below comes from one PostgreSQL statement snapshot.
// In particular, a committed accounting debit and its grant counters cannot be
// read from different moments. Summing bigint as numeric preserves exact totals.
export async function readUsageSnapshot(pool:Pool,customerId:string,entitlementIds:string[]=[]){
 const client=await pool.connect();let discard=false;
 try{
 await client.query('BEGIN READ ONLY');
 // Aborting a browser fetch does not cancel a PostgreSQL statement. Bound this
 // polling read on the server and reset the local timeout on commit/rollback.
 await client.query("SET LOCAL statement_timeout='2s'");
 const result=await client.query(`WITH
  snapshot_clock AS MATERIALIZED (SELECT statement_timestamp() AS as_of),
  owned AS MATERIALIZED (
   SELECT e.id,e.byte_limit,e.consumed_bytes,e.validity_seconds,e.purchased_at,e.start_by,e.activated_at,e.revoked_at,
    e.revoked_at IS NULL AND
     ((e.activated_at IS NULL AND e.start_by>=c.as_of) OR
      (e.activated_at IS NOT NULL AND e.activated_at+make_interval(secs=>e.validity_seconds)>c.as_of)) AS is_current
   FROM purchase_entitlements e CROSS JOIN snapshot_clock c WHERE e.customer_id=$1
  ),
  account_hold AS MATERIALIZED (SELECT reason,created_at FROM network_account_holds WHERE customer_id=$1),
  live AS MATERIALIZED (
   SELECT g.id,g.entitlement_id,g.site_id,g.state,g.issued_at,g.deadline,g.last_accounting_at,
    g.reserved_bytes,g.charged_bytes,g.accounting_anomaly,g.disconnect_requested_at,
    COALESCE(g.last_accounting_at,g.issued_at)<=c.as_of-interval '90 seconds' AS accounting_stale,
    g.state='active' AND g.last_accounting_at>c.as_of-interval '90 seconds' AND g.deadline>c.as_of
     AND NOT g.accounting_anomaly AND g.disconnect_requested_at IS NULL
     AND NOT EXISTS(SELECT 1 FROM account_hold) AS recently_connected
   FROM access_grants g CROSS JOIN snapshot_clock c WHERE g.customer_id=$1 AND g.state<>'closed'
  ),
  totals AS (
   SELECT jsonb_build_object(
    'bundleCount',(count(*) FILTER(WHERE is_current))::integer,
    'allowanceBytes',COALESCE(sum(byte_limit) FILTER(WHERE is_current),0)::text,
    'usedBytes',COALESCE(sum(consumed_bytes) FILTER(WHERE is_current),0)::text,
    'remainingBytes',COALESCE(sum(byte_limit-consumed_bytes) FILTER(WHERE is_current),0)::text
   ) AS all_current,
   jsonb_build_object(
    'bundleCount',(count(*) FILTER(WHERE is_current AND activated_at IS NOT NULL))::integer,
    'allowanceBytes',COALESCE(sum(byte_limit) FILTER(WHERE is_current AND activated_at IS NOT NULL),0)::text,
    'usedBytes',COALESCE(sum(consumed_bytes) FILTER(WHERE is_current AND activated_at IS NOT NULL),0)::text,
    'remainingBytes',COALESCE(sum(byte_limit-consumed_bytes) FILTER(WHERE is_current AND activated_at IS NOT NULL),0)::text
   ) AS active,
   jsonb_build_object(
    'bundleCount',(count(*) FILTER(WHERE is_current AND activated_at IS NULL))::integer,
    'allowanceBytes',COALESCE(sum(byte_limit) FILTER(WHERE is_current AND activated_at IS NULL),0)::text,
    'usedBytes',COALESCE(sum(consumed_bytes) FILTER(WHERE is_current AND activated_at IS NULL),0)::text,
    'remainingBytes',COALESCE(sum(byte_limit-consumed_bytes) FILTER(WHERE is_current AND activated_at IS NULL),0)::text
   ) AS queued,
   COALESCE(sum(consumed_bytes),0)::text AS lifetime_accounted
   FROM owned
  )
  SELECT jsonb_build_object(
   'customerId',$1::text,'asOf',c.as_of,
   'totals',t.all_current,'active',t.active,'queued',t.queued,
   'lifetimeAccountedBytes',t.lifetime_accounted,
   'reservationOutstandingBytes',(SELECT COALESCE(sum(reserved_bytes-charged_bytes),0)::text FROM live),
   'lastAccountingAt',(SELECT last_accounting_at FROM access_grants WHERE customer_id=$1 ORDER BY last_accounting_at DESC NULLS LAST LIMIT 1),
   'session',(SELECT jsonb_build_object(
    'grantId',g.id,'entitlementId',g.entitlement_id,'siteId',g.site_id,'state',g.state,
    'issuedAt',g.issued_at,'deadline',g.deadline,'lastAccountingAt',g.last_accounting_at,
    'reservedBytes',g.reserved_bytes::text,'chargedBytes',g.charged_bytes::text,
    'reservationOutstandingBytes',(g.reserved_bytes-g.charged_bytes)::text,
    'disconnectRequested',g.disconnect_requested_at IS NOT NULL,'accountingAnomaly',g.accounting_anomaly,
    'accountingStale',g.accounting_stale,'connected',COALESCE(g.recently_connected,false)
   ) FROM live g),
   'hold',jsonb_build_object('active',EXISTS(SELECT 1 FROM account_hold),
    'reason',(SELECT reason FROM account_hold),'since',(SELECT created_at FROM account_hold)),
   'connectivity',CASE
    WHEN EXISTS(SELECT 1 FROM account_hold) THEN 'held'
    WHEN NOT EXISTS(SELECT 1 FROM live) THEN 'none'
    WHEN EXISTS(SELECT 1 FROM live WHERE state='uncertain' OR accounting_anomaly OR disconnect_requested_at IS NOT NULL) THEN 'uncertain'
    WHEN EXISTS(SELECT 1 FROM live WHERE accounting_stale OR deadline<=c.as_of OR (state='active' AND last_accounting_at IS NULL)) THEN 'stale'
    WHEN EXISTS(SELECT 1 FROM live WHERE recently_connected) THEN 'recent_accounting'
    ELSE 'pending' END,
   'accounting',jsonb_build_object('expectedIntervalSeconds',60,'staleAfterSeconds',90,'pollAfterSeconds',5),
   'entitlementUpdates',COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id',e.id,'consumed_bytes',e.consumed_bytes::text,'activated_at',e.activated_at,
    'revoked_at',e.revoked_at,'start_by',e.start_by,
    'expires_at',CASE WHEN e.activated_at IS NULL THEN NULL ELSE e.activated_at+make_interval(secs=>e.validity_seconds) END
   ) ORDER BY e.purchased_at,e.id) FROM owned e WHERE e.id=ANY($2::uuid[]) OR e.id IN(SELECT entitlement_id FROM live)),'[]'::jsonb)
  ) AS snapshot FROM snapshot_clock c CROSS JOIN totals t`,[customerId,entitlementIds]);
 await client.query('COMMIT');
 return result.rows[0].snapshot;
 }catch(error){try{await client.query('ROLLBACK');}catch{discard=true;}throw error;}
 finally{client.release(discard);}
}

export function registerUsage(app:FastifyInstance,pool:Pool|null,customer:Customer){
 type Resolution={id:string|null;unavailable:boolean};
 const resolved=new WeakMap<FastifyRequest,Resolution>();
 app.get<{Querystring:{entitlementIds?:string}}>('/v1/usage',{
  config:{rateLimit:{max:60,timeWindow:'1 minute',keyGenerator:async(request:FastifyRequest)=>{
   let resolution:Resolution;
   try{resolution={id:await customer(request),unavailable:false};}
   catch{resolution={id:null,unavailable:true};}
   resolved.set(request,resolution);
   return resolution.id?`usage:customer:${resolution.id}`:`usage:ip:${request.ip}`;
  }}},
  schema:{querystring:{type:'object',additionalProperties:false,properties:{
   entitlementIds:{type:'string',maxLength:3699,pattern:`^${uuidPattern}(,${uuidPattern}){0,99}$`}
  }}}
 },async(request,reply)=>{
  const owner=resolved.get(request);
  if(!owner||owner.unavailable)return reply.code(503).send({error:'identity_unavailable'});
  if(!owner.id)return reply.code(401).send({error:'not_authenticated'});
  if(!pool)return reply.code(503).send({error:'usage_unavailable'});
  try{return await readUsageSnapshot(pool,owner.id,request.query.entitlementIds?.split(',')??[]);}
  catch{return reply.code(503).send({error:'usage_unavailable'});}
 });
}
