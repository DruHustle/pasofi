import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {loadDeliveryKeys} from './delivery-crypto.js';
import {
 AgentCheckoutError,agentCheckoutConfiguration,agentCheckoutSourceSchema,
 createAgentCheckout,previewAgentCheckout,parseAgentCheckoutSource,
 agentCheckoutStatus,agentCheckoutHandoff,agentCheckoutStatusColumns,agentCheckoutStatusJoins,
} from './agent-checkouts.js';
import {paymentConfiguration} from './checkout.js';

type Staff={staffId:string;role:'admin'|'agent'|'support';siteIds:string[];version:number};
type StaffGuard=(request:FastifyRequest,reply:FastifyReply,roles:Staff['role'][])=>Promise<Staff|null>;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const bundle=/^[a-z][a-z0-9-]{0,39}$/;
const failure=(reply:FastifyReply,error:unknown)=>reply.code(error instanceof AgentCheckoutError?error.status:503).send({error:error instanceof AgentCheckoutError?error.code:'agent_checkout_unavailable'});

export function registerAgentCheckouts(app:FastifyInstance,pool:Pool|null,demo:boolean,staff:StaffGuard,originAllowed:(request:FastifyRequest)=>boolean){
 const config=()=>agentCheckoutConfiguration(demo,paymentConfiguration(demo).enabled);
 app.post<{Body:{siteId:string;bundleId:string}}>('/v1/staff/agent-checkouts',{
  config:{rateLimit:{max:20,timeWindow:'1 minute'}},
  preValidation:async(request,reply)=>{
   const body=request.body;
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!['siteId','bundleId'].includes(key)))return reply.code(400).send({error:'invalid_agent_checkout'});
  },
  schema:{body:{type:'object',additionalProperties:false,required:['siteId','bundleId'],properties:{siteId:{type:'string',pattern:uuid.source},bundleId:{type:'string',pattern:bundle.source}}}},
 },async(request,reply)=>{
  const actor=await staff(request,reply,['agent']);if(!actor)return;
  if(!pool)return failure(reply,null);
  const key=request.headers['idempotency-key'];
  if(typeof key!=='string'||!uuid.test(key))return reply.code(400).send({error:'invalid_idempotency_key'});
  const input={siteId:request.body.siteId.toLowerCase(),bundleId:request.body.bundleId};
  if(!actor.siteIds.includes(input.siteId))return reply.code(403).send({error:'site_forbidden'});
  try{
   const result=await createAgentCheckout(pool,actor,key.toLowerCase(),input,config());
   const row=(await pool.query('SELECT '+agentCheckoutStatusColumns+agentCheckoutStatusJoins+'WHERE a.id=$1',[result.row.id])).rows[0];
   return reply.code(result.replayed?200:201).send({checkout:agentCheckoutStatus(row),handoff:agentCheckoutHandoff(row,actor.staffId,loadDeliveryKeys(),demo),replayed:result.replayed});
  }catch(error){return failure(reply,error);}
 });
 app.get<{Querystring:{limit:number;offset:number}}>('/v1/staff/agent-checkouts',{
  schema:{querystring:{type:'object',additionalProperties:false,properties:{limit:{type:'integer',minimum:1,maximum:100,default:50},offset:{type:'integer',minimum:0,maximum:1000000,default:0}}}},
 },async(request,reply)=>{
  const actor=await staff(request,reply,['admin','agent']);if(!actor)return;
  if(!pool)return failure(reply,null);
  try{
   const {limit,offset}=request.query;
   const rows=(await pool.query('SELECT '+agentCheckoutStatusColumns+agentCheckoutStatusJoins+'WHERE ($1::boolean OR (a.agent_id=$2 AND a.site_id=ANY($3::uuid[]))) ORDER BY a.created_at DESC,a.id DESC LIMIT $4 OFFSET $5',[actor.role==='admin',actor.staffId,actor.siteIds,limit+1,offset])).rows;
   const hasMore=rows.length>limit;
   return {checkouts:rows.slice(0,limit).map(agentCheckoutStatus),hasMore,nextOffset:hasMore?offset+limit:null};
  }catch(error){return failure(reply,error);}
 });
 app.get<{Params:{id:string}}>('/v1/staff/agent-checkouts/:id',async(request,reply)=>{
  const actor=await staff(request,reply,['admin','agent']);if(!actor)return;
  if(!pool)return failure(reply,null);
  if(!uuid.test(request.params.id))return reply.code(404).send({error:'agent_checkout_not_found'});
  try{
   const row=(await pool.query('SELECT '+agentCheckoutStatusColumns+agentCheckoutStatusJoins+'WHERE a.id=$1 AND ($2::boolean OR (a.agent_id=$3 AND a.site_id=ANY($4::uuid[])))',[request.params.id,actor.role==='admin',actor.staffId,actor.siteIds])).rows[0];
   if(!row)return reply.code(404).send({error:'agent_checkout_not_found'});
   return {checkout:agentCheckoutStatus(row),handoff:agentCheckoutHandoff(row,actor.staffId,loadDeliveryKeys(),demo)};
  }catch(error){return failure(reply,error);}
 });
 app.post('/v1/agent-checkouts/preview',{
  config:{rateLimit:{max:20,timeWindow:'1 minute'}},schema:{body:agentCheckoutSourceSchema},
  preValidation:async(request,reply)=>{try{if(!parseAgentCheckoutSource(request.body))throw new AgentCheckoutError('invalid_agent_checkout',400);}catch(error){return failure(reply,error);}},
 },async(request,reply)=>{
  if(!originAllowed(request))return reply.code(403).send({error:'origin_rejected'});
  if(!pool)return failure(reply,null);
  try{return await previewAgentCheckout(pool,parseAgentCheckoutSource(request.body)!,config(),request,demo);}
  catch(error){return failure(reply,error);}
 });
}
