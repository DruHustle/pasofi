import type {FastifyInstance,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {SignJWT} from 'jose';

const uuid={type:'string',pattern:'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'};
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
    if(!response.ok)throw new Error('network_unavailable');
    return response.json();
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
      const rows=await pool.query(`SELECT id,site_id AS "siteId",state,last_accounting_at AS "accountedAt",deadline,charged_bytes::text AS "chargedBytes",
        disconnect_requested_at IS NOT NULL AS "disconnectRequested",state='active' AND last_accounting_at>now()-interval '90 seconds' AND deadline>now() AS connected
        FROM access_grants WHERE customer_id=$1 AND state<>'closed'`,[customerId]);
      return {session:rows.rows[0]??null};
    } catch{return reply.code(503).send({error:'network_unavailable'});}
  });
  app.post<{Body:{siteId:string;requestKey:string}}>('/v1/network/credentials',{schema:{body:{type:'object',additionalProperties:false,required:['siteId','requestKey'],properties:{siteId:uuid,requestKey:uuid}}}},async(request,reply)=>{
    if(!customerNetworkEnabled(demo)||!pool)return reply.code(404).send({error:'network_disabled'});
    if(!originAllowed(request))return reply.code(403).send({error:'origin_forbidden'});
    try {
      const customerId=await customer(request);if(!customerId)return reply.code(401).send({error:'unauthorized'});
      if((await pool.query('SELECT 1 FROM network_account_holds WHERE customer_id=$1',[customerId])).rowCount)return reply.code(409).send({error:'accounting_review_required'});
      if((await pool.query("SELECT 1 FROM access_grants WHERE customer_id=$1 AND state<>'closed'",[customerId])).rowCount)return reply.code(409).send({error:'session_pending_or_active'});
      const usable=await pool.query(`SELECT 1 FROM purchase_entitlements WHERE customer_id=$1 AND revoked_at IS NULL AND consumed_bytes<byte_limit AND
        ((activated_at IS NULL AND start_by>=now()) OR activated_at+make_interval(secs=>validity_seconds)>now()) LIMIT 1`,[customerId]);
      if(!usable.rowCount)return reply.code(409).send({error:'no_usable_entitlement'});
      return await network('/internal/v1/network/credentials','network:credentials',{customerId,...request.body});
    }catch{return reply.code(503).send({error:'network_unavailable'});}
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
