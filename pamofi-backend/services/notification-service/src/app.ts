import Fastify from 'fastify';
import pg from 'pg';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { jwtVerify } from 'jose';
import {registerDelivery} from './worker.js';
const { Pool } = pg;
type SaleEvent={id:string;type:'agent.sale.created';version:1;producer:'prepaid-access';aggregateId:string;aggregateVersion:number;occurredAt:string;correlationId:string;payload:{deliveryReference:string}};
const uuidPattern='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
export function buildApp() {
 const app=Fastify({logger:false,bodyLimit:16384});
 const pool=process.env.DATABASE_URL ? new Pool({connectionString:process.env.DATABASE_URL,max:3,connectionTimeoutMillis:2000}) : null;
  // pg discards the broken idle connection; handling its error keeps the
  // service alive so readiness and later requests can recover. Never log DSNs.
  pool?.on('error', () => console.error('notification: database idle connection lost'));
 const demo=process.env.APP_ENV==='demo' && process.env.NODE_ENV==='development';
 const stopDelivery=registerDelivery(app,pool,demo);
 app.addHook('onSend',async(_request,reply,payload)=>{reply.header('Cache-Control','no-store');return payload;});
 app.addHook('onClose',async()=>{await stopDelivery();if(pool) await pool.end();});
 app.get('/health/live',async()=>({status:'ok',service:'notification'}));
 app.get('/health/ready',async(_request,reply)=>{if(!pool)return reply.code(503).send({status:'not_ready'});try{await pool.query('SELECT 1');return {status:'ready'};}catch{return reply.code(503).send({status:'not_ready'});}});
 app.post<{Body:SaleEvent}>('/internal/v1/events',{schema:{body:{type:'object',additionalProperties:false,required:['id','type','version','producer','aggregateId','aggregateVersion','occurredAt','correlationId','payload'],properties:{
  id:{type:'string',pattern:uuidPattern},type:{const:'agent.sale.created'},version:{const:1},producer:{const:'prepaid-access'},aggregateId:{type:'string',pattern:uuidPattern},aggregateVersion:{const:1},occurredAt:{type:'string',minLength:20,maxLength:40},correlationId:{type:'string',pattern:uuidPattern},payload:{type:'object',additionalProperties:false,required:['deliveryReference'],properties:{deliveryReference:{type:'string',pattern:uuidPattern}}}
 }}}},async(request,reply)=>{
  const secret=process.env.INTERNAL_EVENTS_SECRET;
  if(!pool || !secret || Buffer.byteLength(secret)<32 || (!demo && secret.startsWith('DEMO_ONLY_'))) return reply.code(503).send({error:'unavailable'});
  const auth=request.headers.authorization;
  if(!auth?.startsWith('Bearer ')) return reply.code(401).send({error:'unauthorized'});
  try { const {payload}=await jwtVerify(auth.slice(7),new TextEncoder().encode(secret),{algorithms:['HS256'],issuer:'prepaid-access',subject:'prepaid-access',audience:'notification',requiredClaims:['exp','iat','sub'],maxTokenAge:'30s'});
   if(payload.scope!=='event:deliver')return reply.code(403).send({error:'forbidden'});
  } catch {return reply.code(401).send({error:'unauthorized'});}
  const e=request.body;
  if(e.payload.deliveryReference!==e.aggregateId || !Number.isFinite(Date.parse(e.occurredAt))) return reply.code(400).send({error:'invalid_event'});
  const canonical=JSON.stringify({id:e.id,type:e.type,version:e.version,producer:e.producer,aggregateId:e.aggregateId,aggregateVersion:e.aggregateVersion,occurredAt:e.occurredAt,correlationId:e.correlationId,payload:{deliveryReference:e.payload.deliveryReference}});
  const hash=createHash('sha256').update(canonical).digest();
  try{
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    const inserted=await client.query('INSERT INTO event_inbox(id,producer,event_type,aggregate_id,aggregate_version,payload_hash) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id',[e.id,e.producer,e.type,e.aggregateId,e.aggregateVersion,hash]);
    if(inserted.rowCount){
      await client.query("INSERT INTO delivery_jobs(id,event_id,delivery_reference,state) VALUES ($1,$2,$3,'awaiting_delivery_details')",[randomUUID(),e.id,e.payload.deliveryReference]);
    } else {
      const previous=await client.query('SELECT id,payload_hash FROM event_inbox WHERE id=$1 OR (producer=$2 AND event_type=$3 AND aggregate_id=$4 AND aggregate_version=$5)',[e.id,e.producer,e.type,e.aggregateId,e.aggregateVersion]);
      if(previous.rowCount!==1 || previous.rows[0].id!==e.id || !timingSafeEqual(previous.rows[0].payload_hash,hash)){await client.query('ROLLBACK');return reply.code(409).send({error:'event_conflict'});}
    }
    await client.query('COMMIT');return {accepted:true};
   } catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
  }catch{return reply.code(503).send({error:'unavailable'});}
 });
 return app;
}
