import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { jwtVerify } from 'jose';
import { GrantError, issueGrant, recordAccounting } from './grants.js';

// This boundary is for an isolated lab only until the network service and
// production transport are qualified. It is never a public customer API.
const uuid='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const id={type:'string',pattern:uuid};
const session={type:'string',pattern:'^[A-Za-z0-9._:-]{1,128}$'};
const counter={type:'string',pattern:'^(0|[1-9][0-9]{0,19})$'};
type GrantBody={customerId:string;siteId:string;nasId:string;requestKey:string;sessionId:string};
type AccountingBody={grantId:string;siteId:string;nasId:string;generation:string;sessionId:string;kind:'start'|'interim'|'stop';upload:string;download:string};

export function registerRadiusInternal(app:FastifyInstance,pool:Pool|null,demo:boolean) {
 async function authorize(request:FastifyRequest,reply:FastifyReply,scope:string) {
  if (!demo || process.env.INTERNAL_RADIUS_ENABLED!=='true') { await reply.code(404).send({error:'not_found'}); return false; }
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
}
