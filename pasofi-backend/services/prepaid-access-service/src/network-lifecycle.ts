import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {SignJWT} from 'jose';

const uuid={type:'string',pattern:'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'};
class CredentialBoundaryError extends Error {constructor(readonly code:'credential_expired'|'nas_selection_required'|'accounting_review_required'|'session_pending_or_active'|'no_usable_entitlement'){super(code);}}
type Selection={siteId:string;nasId?:string;requestKey:string};
export function customerNetworkEnabled(demo:boolean) {
  if(process.env.PAMOFI_CUSTOMER_NETWORK_ENABLED!=='true'||Buffer.byteLength(process.env.INTERNAL_NETWORK_SECRET||'')<32)return false;
  if(demo?process.env.INTERNAL_RADIUS_ENABLED!=='true':process.env.PAMOFI_RADIUS_QUALIFIED!=='true')return false;
  try { const url=new URL(process.env.NETWORK_URL||''); return (url.protocol==='https:'||(demo&&url.protocol==='http:'))&&!url.username&&!url.password&&url.pathname==='/'&&!url.search&&!url.hash; }
  catch{return false;}
}

export function registerCustomerNetwork(app:FastifyInstance,pool:Pool|null,demo:boolean,
  customer:(request:FastifyRequest)=>Promise<string|null>,originAllowed:(request:FastifyRequest)=>boolean) {
  async function network(path:string,scope:string,body?:unknown) {
    const token=await new SignJWT({scope}).setProtectedHeader({alg:'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('network').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(process.env.INTERNAL_NETWORK_SECRET!));
    const response=await fetch(new URL(path,process.env.NETWORK_URL),{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok){
      // Expose only definite expiry and ambiguous-site selection conflicts.
      // Only expiry permits a new retry key; uncertain failures stay generic.
      if(scope==='network:credentials'&&response.status===409){
        const failure:unknown=await response.json().catch(()=>null);
        if(failure&&typeof failure==='object'&&!Array.isArray(failure)&&'error' in failure&&(failure.error==='credential_expired'||failure.error==='nas_selection_required'))throw new CredentialBoundaryError(failure.error);
      }
      throw new Error('network_unavailable');
    }
    return response.json();
  }
  async function prepareCredential(customerId:string,selection:Selection) {
    customerId=customerId.toLowerCase();
    const client=await pool!.connect();
    try {
      await client.query('BEGIN');
      // The grant/hold/refund paths use this same per-customer lock. Keep it
      // through the bounded network call so issuance cannot race an open grant.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[customerId]);
      if((await client.query('SELECT 1 FROM network_account_holds WHERE customer_id=$1',[customerId])).rowCount)throw new CredentialBoundaryError('accounting_review_required');
      const open=await client.query("SELECT id,site_id,nas_id,request_key,entitlement_id,state FROM access_grants WHERE customer_id=$1 AND state<>'closed' FOR UPDATE",[customerId]);
      const grant=open.rows[0];
      if(open.rowCount&&(!grant||open.rowCount!==1||grant.state!=='pending'||grant.site_id!==selection.siteId.toLowerCase()||(selection.nasId!==undefined&&grant.nas_id!==selection.nasId.toLowerCase())||!grant.nas_id||!grant.request_key))throw new CredentialBoundaryError('session_pending_or_active');
      const entitlement=grant
        ?await client.query('SELECT id FROM purchase_entitlements WHERE id=$1 AND customer_id=$2 FOR SHARE',[grant.entitlement_id,customerId])
        :await client.query(`SELECT id FROM purchase_entitlements WHERE customer_id=$1 AND revoked_at IS NULL AND consumed_bytes<byte_limit AND
          ((activated_at IS NULL AND start_by>=clock_timestamp()) OR activated_at+make_interval(secs=>validity_seconds)>clock_timestamp()) ORDER BY purchased_at,id LIMIT 1 FOR SHARE`,[customerId]);
      const eligibilityError=grant?'session_pending_or_active':'no_usable_entitlement';
      if(!entitlement.rowCount)throw new CredentialBoundaryError(eligibilityError);
      async function assertEligible(expiresAt?:string) {
        // Evaluate time only after the row locks are held, and again after the
        // private response; transaction now() would freeze before a lock wait.
        const usable=await client.query(`SELECT 1 FROM purchase_entitlements e WHERE e.id=$1 AND e.customer_id=$2 AND e.revoked_at IS NULL AND e.consumed_bytes<e.byte_limit AND
          ((e.activated_at IS NULL AND e.start_by>=clock_timestamp()) OR e.activated_at+make_interval(secs=>e.validity_seconds)>clock_timestamp())
          AND NOT EXISTS(SELECT 1 FROM network_account_holds WHERE customer_id=$2)
          AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM access_grants g WHERE g.id=$3 AND g.customer_id=$2 AND g.entitlement_id=e.id AND
            g.state='pending' AND g.deadline>clock_timestamp() AND g.disconnect_requested_at IS NULL AND g.stop_received_at IS NULL AND
            g.credential_fenced_at IS NULL AND g.absent_verified_at IS NULL AND g.accounting_started_at IS NULL AND g.last_accounting_at IS NULL AND g.accounting_anomaly=false))
          AND ($4::timestamptz IS NULL OR $4::timestamptz>clock_timestamp())`,[entitlement.rows[0].id,customerId,grant?.id??null,expiresAt??null]);
        if(!usable.rowCount)throw new CredentialBoundaryError(eligibilityError);
      }
      await assertEligible();
      let result;
      try {
        result=await network('/internal/v1/network/credentials','network:credentials',{customerId,...selection,...(grant?{nasId:grant.nas_id,replayCredentialId:grant.request_key}:{})});
      } catch(error) {
        // Expiry while a reservation is pending must not offer a fresh key or
        // credential; its original reservation still needs verified closure.
        if(grant&&error instanceof CredentialBoundaryError&&error.code==='credential_expired')throw new CredentialBoundaryError('session_pending_or_active');
        throw error;
      }
      if(grant&&(!result||typeof result!=='object'||result.siteId!==grant.site_id||result.nasId!==grant.nas_id||typeof result.expiresAt!=='string'||!Number.isFinite(Date.parse(result.expiresAt))))throw new Error('network_unavailable');
      await assertEligible(grant?result.expiresAt:undefined);
      await client.query('COMMIT');
      return result;
    }catch(error){await client.query('ROLLBACK');throw error;}
    finally{client.release();}
  }
  app.get('/v1/network/sites',async(request,reply)=>{
    if(!customerNetworkEnabled(demo)||!pool)return reply.code(404).send({error:'network_disabled'});
    try {if(!await customer(request))return reply.code(401).send({error:'unauthorized'});return await network('/internal/v1/network/sites','network:sites');}
    catch{return reply.code(503).send({error:'network_unavailable'});}
  });
  app.get('/v1/network/session',async(request,reply)=>{
    // Pausing new connections must not hide an existing customer's session.
    // This read needs only the ledger and the customer's authenticated identity.
    if(!pool)return reply.code(503).send({error:'network_unavailable'});
    try {
      const customerId=await customer(request);if(!customerId)return reply.code(401).send({error:'unauthorized'});
      const rows=await pool.query(`SELECT id,site_id AS "siteId",nas_id AS "nasId",state,last_accounting_at AS "accountedAt",deadline,charged_bytes::text AS "chargedBytes",
        disconnect_requested_at IS NOT NULL AS "disconnectRequested",state='active' AND last_accounting_at>now()-interval '90 seconds' AND deadline>now() AS connected
        FROM access_grants WHERE customer_id=$1 AND state<>'closed'`,[customerId]);
      return {session:rows.rows[0]??null};
    } catch{return reply.code(503).send({error:'network_unavailable'});}
  });
  app.post<{Body:Selection}>('/v1/network/credentials',{
    // Fastify's default validator removes extra fields. Reject them before
    // validation so a caller cannot even submit the private replay authority.
    preValidation:async(request,reply)=>{if(request.body&&typeof request.body==='object'&&!Array.isArray(request.body)&&Object.keys(request.body).some(key=>!['siteId','nasId','requestKey'].includes(key)))return reply.code(400).send({error:'invalid_request'});},
    schema:{body:{type:'object',additionalProperties:false,required:['siteId','requestKey'],properties:{siteId:uuid,nasId:uuid,requestKey:uuid}}}
  },async(request,reply)=>{
    if(!customerNetworkEnabled(demo)||!pool)return reply.code(404).send({error:'network_disabled'});
    if(!originAllowed(request))return reply.code(403).send({error:'origin_forbidden'});
    try {
      const customerId=await customer(request);if(!customerId)return reply.code(401).send({error:'unauthorized'});
      return await prepareCredential(customerId,request.body);
    }catch(error){return error instanceof CredentialBoundaryError?reply.code(409).send({error:error.code}):reply.code(503).send({error:'network_unavailable'});}
  });
  app.post<{Body:{grantId:string}}>('/v1/network/disconnect',{schema:{body:{type:'object',additionalProperties:false,required:['grantId'],properties:{grantId:uuid}}}},async(request,reply)=>{
    // Always allow an authenticated customer to request termination of their
    // own grant, including while issuance is paused or its upstream is down.
    // The response remains pending until independent router reconciliation.
    if(!pool)return reply.code(503).send({error:'network_unavailable'});
    if(!originAllowed(request))return reply.code(403).send({error:'origin_forbidden'});
    try {
      const customerId=await customer(request);if(!customerId)return reply.code(401).send({error:'unauthorized'});
      const rows=await pool.query(`UPDATE access_grants SET state=CASE WHEN state='closed' THEN 'closed' ELSE 'uncertain' END,
        disconnect_requested_at=COALESCE(disconnect_requested_at,now()) WHERE id=$1 AND customer_id=$2 RETURNING state`,[request.body.grantId,customerId]);
      if(!rows.rowCount)return reply.code(404).send({error:'not_found'});
      return reply.code(rows.rows[0].state==='closed'?200:202).send({state:rows.rows[0].state==='closed'?'closed':'disconnect_pending'});
    }catch{return reply.code(503).send({error:'network_unavailable'});}
  });
}
