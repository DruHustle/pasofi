import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { jwtVerify } from 'jose';
import { GrantError, issueGrant, recordAccounting, reconcileGrant, markNasRestart, type AbsenceEvidence } from './grants.js';

// Private service boundary. Production enablement requires explicit recorded
// router qualification; the public gateway must never route internal paths.
const uuid='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const id={type:'string',pattern:uuid};
const session={type:'string',pattern:'^[A-Za-z0-9._:-]{1,128}$'};
const counter={type:'string',pattern:'^(0|[1-9][0-9]{0,19})$'};
type GrantBody={customerId:string;siteId:string;nasId:string;requestKey:string;sessionId:string};
type AccountingBody={grantId:string;siteId:string;nasId:string;generation:string;sessionId:string;kind:'start'|'interim'|'stop';upload:string;download:string};

export function registerRadiusInternal(app:FastifyInstance,pool:Pool|null,demo:boolean) {
 async function authorize(request:FastifyRequest,reply:FastifyReply,scope:string) {
  if (demo?process.env.INTERNAL_RADIUS_ENABLED!=='true':process.env.PAMOFI_RADIUS_QUALIFIED!=='true') { await reply.code(404).send({error:'not_found'}); return false; }
  const secret=process.env.INTERNAL_NETWORK_SECRET;
  if (!pool || !secret || Buffer.byteLength(secret)<32) { await reply.code(503).send({error:'unavailable'}); return false; }
  const header=request.headers.authorization;
  if(!header?.startsWith('Bearer ')) { await reply.code(401).send({error:'unauthorized'});return false; }
  try {
   const {payload}=await jwtVerify(header.slice(7),new TextEncoder().encode(secret),{algorithms:['HS256'],issuer:'network',subject:'network',audience:'prepaid-access',requiredClaims:['exp','iat','sub'],maxTokenAge:'30s'});
   if(payload.scope!==scope) { await reply.code(403).send({error:'forbidden'});return false; }
  } catch { await reply.code(401).send({error:'unauthorized'});return false; }
  return true;
 }
 app.post<{Body:GrantBody}>('/internal/v1/radius/grants',{schema:{body:{type:'object',additionalProperties:false,required:['customerId','siteId','nasId','requestKey','sessionId'],properties:{customerId:id,siteId:id,nasId:id,requestKey:id,sessionId:session}}}},async(request,reply)=>{
  if(!await authorize(request,reply,'radius:grant'))return;
  const b=request.body;
  try {
   const g=await issueGrant(pool!,b.customerId,b.siteId,b.nasId,b.requestKey,b.sessionId);
   return {grantId:g.id,generation:g.generation,reservedBytes:g.reserved_bytes,issuedAt:g.issued_at.toISOString(),deadline:g.deadline.toISOString()};
  } catch(error) {
   if(error instanceof GrantError) return reply.code(409).send({error:error.code});
   return reply.code(503).send({error:'unavailable'});
  }
 });
 app.post<{Body:AccountingBody}>('/internal/v1/radius/accounting',{schema:{body:{type:'object',additionalProperties:false,required:['grantId','siteId','nasId','generation','sessionId','kind','upload','download'],properties:{grantId:id,siteId:id,nasId:id,generation:id,sessionId:session,kind:{type:'string',enum:['start','interim','stop']},upload:counter,download:counter}}}},async(request,reply)=>{
  if(!await authorize(request,reply,'radius:account'))return;
  const b=request.body;
  try { return await recordAccounting(pool!,{...b,upload:BigInt(b.upload),download:BigInt(b.download)}); }
  catch(error) {
   if(error instanceof GrantError) return reply.code(409).send({error:error.code});
   return reply.code(503).send({error:'unavailable'});
  }
 });
 app.post('/internal/v1/radius/reconcile/pending',async(request,reply)=>{
  if(!await authorize(request,reply,'radius:reconcile'))return;
  try {
   const rows=await pool!.query(`UPDATE access_grants SET reconcile_attempted_at=now() WHERE id IN (
     SELECT id FROM access_grants WHERE (state<>'closed' AND (disconnect_requested_at IS NOT NULL OR stop_received_at IS NOT NULL OR
       accounting_anomaly OR deadline<=now() OR COALESCE(last_accounting_at,issued_at)<now()-interval '3 minutes')) OR id IN (SELECT grant_id FROM network_account_holds)
     ORDER BY reconcile_attempted_at NULLS FIRST,issued_at LIMIT 50 FOR UPDATE SKIP LOCKED)
     RETURNING id AS "grantId",site_id AS "siteId",nas_id AS "nasId",generation,accounting_session_id AS "sessionId",request_key AS "credentialId"`);
   return {grants:rows.rows};
  }catch{return reply.code(503).send({error:'unavailable'});}
 });
 app.post<{Body:AbsenceEvidence}>('/internal/v1/radius/reconcile',{schema:{body:{type:'object',additionalProperties:false,
  required:['grantId','siteId','nasId','generation','sessionId','observationId','observedAt','credentialRevokedAt','absent'],
  properties:{grantId:id,siteId:id,nasId:id,generation:id,sessionId:session,observationId:id,observedAt:{type:'string',format:'date-time'},credentialRevokedAt:{type:'string',format:'date-time'},absent:{type:'boolean'}}}}},async(request,reply)=>{
  if(!await authorize(request,reply,'radius:reconcile'))return;
  try{return await reconcileGrant(pool!,request.body);}catch(error){return reply.code(error instanceof GrantError?409:503).send({error:error instanceof GrantError?error.code:'unavailable'});}
 });
 app.post<{Body:{siteId:string;nasId:string}}>('/internal/v1/radius/restart',{schema:{body:{type:'object',additionalProperties:false,required:['siteId','nasId'],properties:{siteId:id,nasId:id}}}},async(request,reply)=>{
  if(!await authorize(request,reply,'radius:account'))return;
  try{return await markNasRestart(pool!,request.body.siteId,request.body.nasId);}catch{return reply.code(503).send({error:'unavailable'});}
 });
}
