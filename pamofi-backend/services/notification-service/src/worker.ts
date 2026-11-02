import {createHash,randomUUID} from 'node:crypto';
import {SignJWT,jwtVerify} from 'jose';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {sendOnce,pollAttempt,markStaleSubmissionsUnknown} from './delivery.js';
import {SendaiAdapter,type SmsResult} from './sendai.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Config={mode:'disabled'|'mock'|'sendai';enabled:boolean};
export function deliveryConfiguration(demo:boolean):Config {
 if(process.env.DELIVERY_WORKER_ENABLED!=='true')return {mode:'disabled',enabled:false};
 const secret=process.env.INTERNAL_DELIVERY_SECRET??'';
 if(Buffer.byteLength(secret)<32||(!demo&&secret.startsWith('DEMO_ONLY_')))return {mode:'disabled',enabled:false};
 try{const source=new URL(process.env.PREPAID_URL??'');if(source.username||source.password||source.pathname!=='/'||source.search||source.hash||(!demo&&source.protocol!=='https:')||(demo&&!['http:','https:'].includes(source.protocol)))return {mode:'disabled',enabled:false};}catch{return {mode:'disabled',enabled:false};}
 if(demo&&process.env.NOTIFICATION_DELIVERY_MODE==='mock')return {mode:'mock',enabled:true};
 if(!demo&&process.env.APP_ENV==='production'&&process.env.NODE_ENV==='production'&&process.env.NOTIFICATION_DELIVERY_MODE==='sendai'&&process.env.SENDAI_LIVE_ENABLED==='true'&&process.env.SENDAI_QUALIFIED==='true'&&!!process.env.SENDAI_API_KEY)return {mode:'sendai',enabled:true};
 return {mode:'disabled',enabled:false};
}
function mockAdapter(pool:Pool,jobId:string){const delivered=(id:string,when:Date):SmsResult=>({state:'delivered',providerId:id,providerStatus:'mock_delivered',deliveredAt:when.toISOString(),cost:{amount:'0',scale:4,currency:'USD'}});return {
 send:async(message:{to:string;from:string;message:string})=>{const row=await pool.query('INSERT INTO mock_sms_sink(id,job_id,message_hash,recipient_last4) VALUES($1,$2,$3,$4) ON CONFLICT(job_id) DO UPDATE SET job_id=EXCLUDED.job_id RETURNING id,created_at',[randomUUID(),jobId,createHash('sha256').update(JSON.stringify(message)).digest(),message.to.slice(-4)]);return delivered(row.rows[0].id,row.rows[0].created_at);},
 retrieve:async(id:string)=>{const row=await pool.query('SELECT id,created_at FROM mock_sms_sink WHERE id=$1 AND job_id=$2',[id,jobId]);return row.rowCount?delivered(row.rows[0].id,row.rows[0].created_at):{state:'unknown' as const,providerId:id,providerStatus:null,deliveredAt:null,cost:null};}
};}
async function details(reference:string,demo:boolean){
 const base=process.env.PREPAID_URL,secret=process.env.INTERNAL_DELIVERY_SECRET;if(!base||!secret||Buffer.byteLength(secret)<32||(!demo&&secret.startsWith('DEMO_ONLY_')))throw Error('delivery_source_unavailable');
 const target=new URL(base);if(target.username||target.password||target.search||target.hash||target.pathname!=='/'||(!demo&&target.protocol!=='https:')||(demo&&!['http:','https:'].includes(target.protocol)))throw Error('invalid_source');
 const token=await new SignJWT({scope:'delivery:read'}).setProtectedHeader({alg:'HS256'}).setIssuer('notification').setSubject('notification').setAudience('prepaid-access').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(secret));
 const response=await fetch(new URL(`/internal/v1/deliveries/${reference}`,target),{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(3000),redirect:'error'});if(!response.ok||!response.body)throw Error('delivery_source_unavailable');
 const reader=response.body.getReader(),chunks:Buffer[]=[];let size=0;while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8192){await reader.cancel();throw Error('invalid_details');}chunks.push(Buffer.from(part.value));}
 const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||data.deliveryReference!==reference||data.saleId!==reference||!['none','sms'].includes(data.channel)||typeof data.simulation!=='boolean')throw Error('invalid_details');
 if(data.channel==='sms'&&(typeof data.to!=='string'||!/^263[0-9]{9}$/.test(data.to)||typeof data.from!=='string'||data.from.length<1||data.from.length>32||typeof data.message!=='string'||data.message.length<1||data.message.length>1000))throw Error('invalid_details');return data as {channel:'none'|'sms';to:string;from:string;message:string;simulation:boolean};
}
export async function processDelivery(pool:Pool,demo:boolean,config=deliveryConfiguration(demo)):Promise<boolean>{
 if(!config.enabled)return false;
 await markStaleSubmissionsUnknown(pool,60);
 const lease=randomUUID();const claimed=await pool.query(`UPDATE delivery_jobs SET lease_token=$1,lease_until=now()+interval '20 seconds'
  WHERE id=(SELECT id FROM delivery_jobs WHERE state IN ('awaiting_delivery_details','ready','submitted','unknown') AND next_at<=now() AND (lease_until IS NULL OR lease_until<now()) ORDER BY next_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
  RETURNING id,delivery_reference,state,lookup_attempts`,[lease]);if(!claimed.rowCount)return false;const job=claimed.rows[0];
 const adapter=config.mode==='mock'?mockAdapter(pool,job.id):new SendaiAdapter(process.env.SENDAI_API_KEY??'');
 try{
  if(job.state==='submitted'||job.state==='unknown'){
   const attempt=(await pool.query("SELECT id,provider_id FROM delivery_attempts WHERE job_id=$1 AND state IN ('submitted','unknown') ORDER BY attempt_number DESC LIMIT 1",[job.id])).rows[0];
   if(attempt?.provider_id)await pollAttempt(pool,attempt.id,adapter);
   await pool.query("UPDATE delivery_jobs SET lease_token=NULL,lease_until=NULL,next_at=now()+make_interval(secs=>$3),last_error=$4 WHERE id=$1 AND lease_token=$2",[job.id,lease,attempt?.provider_id?30:3600,attempt?.provider_id?null:'manual_review_required']);return true;
  }
  const payload=await details(job.delivery_reference,demo);
  if(payload.channel==='none'){await pool.query("UPDATE delivery_jobs SET state='canceled',lease_token=NULL,lease_until=NULL,last_error='receipt_only' WHERE id=$1 AND lease_token=$2",[job.id,lease]);return true;}
  if(payload.simulation!==(config.mode==='mock'))throw Error('simulation_mismatch');
  const ready=await pool.query("UPDATE delivery_jobs SET state='ready',lookup_attempts=0,last_error=NULL WHERE id=$1 AND lease_token=$2 AND lease_until>now() AND state IN ('awaiting_delivery_details','ready') RETURNING id",[job.id,lease]);
  if(ready.rowCount)await sendOnce(pool,job.id,adapter,{to:payload.to,from:payload.from,message:payload.message});
  await pool.query("UPDATE delivery_jobs SET lease_token=NULL,lease_until=NULL,next_at=now()+interval '30 seconds' WHERE id=$1 AND lease_token=$2",[job.id,lease]);return true;
 }catch{
  await pool.query("UPDATE delivery_jobs SET lookup_attempts=lookup_attempts+1,state=CASE WHEN state IN ('awaiting_delivery_details','ready') AND lookup_attempts>=9 THEN 'failed' ELSE state END,last_error='delivery_lookup_or_submission_unavailable',lease_token=NULL,lease_until=NULL,next_at=now()+make_interval(secs=>$3) WHERE id=$1 AND lease_token=$2",[job.id,lease,Math.min(300,5*2**Math.min(job.lookup_attempts,6))]);return true;
 }
}
export function registerDelivery(app:FastifyInstance,pool:Pool|null,demo:boolean):()=>Promise<void>{
 const config=deliveryConfiguration(demo);
 async function authorize(request:FastifyRequest,reply:FastifyReply,scope:string){const secret=process.env.INTERNAL_DELIVERY_SECRET;if(!pool||!secret||Buffer.byteLength(secret)<32||(!demo&&secret.startsWith('DEMO_ONLY_'))){reply.code(503).send({error:'unavailable'});return false;}try{const header=request.headers.authorization;if(!header?.startsWith('Bearer '))throw Error();const {payload}=await jwtVerify(header.slice(7),new TextEncoder().encode(secret),{algorithms:['HS256'],issuer:'prepaid-access',subject:'prepaid-access',audience:'notification',requiredClaims:['iat','exp','sub'],maxTokenAge:'30s'});if(payload.scope!==scope){reply.code(403).send({error:'forbidden'});return false;}return true;}catch{reply.code(401).send({error:'unauthorized'});return false;}}
 app.get('/internal/v1/delivery/capabilities',async(request,reply)=>{if(!await authorize(request,reply,'delivery:status'))return;return {enabled:config.enabled,mode:config.mode,simulation:config.mode==='mock'};});
 app.get<{Params:{id:string}}>('/internal/v1/deliveries/:id/status',async(request,reply)=>{if(!await authorize(request,reply,'delivery:status'))return;if(!uuid.test(request.params.id))return reply.code(404).send({error:'not_found'});try{const row=(await pool!.query('SELECT id,state,created_at AS "createdAt",last_error AS "lastError" FROM delivery_jobs WHERE delivery_reference=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[request.params.id])).rows[0];if(!row)return {state:'queued',simulation:config.mode==='mock',attempts:[]};const attempts=(await pool!.query('SELECT id,state,created_at AS "createdAt",delivered_at AS "deliveredAt",charge_amount::text AS "chargeAmount",charge_scale AS "chargeScale",charge_currency AS "chargeCurrency" FROM delivery_attempts WHERE job_id=$1 ORDER BY attempt_number',[row.id])).rows;return {...row,simulation:config.mode==='mock',attempts};}catch{return reply.code(503).send({error:'unavailable'});}});
 app.post<{Params:{id:string};Body:{requestId:string;actorId:string;reason:string}}>('/internal/v1/deliveries/:id/resend',async(request,reply)=>{if(!await authorize(request,reply,'delivery:resend'))return;if(!config.enabled)return reply.code(409).send({error:'delivery_disabled'});const b=request.body;if(!uuid.test(request.params.id)||!b||!uuid.test(b.requestId??'')||!uuid.test(b.actorId??'')||typeof b.reason!=='string'||b.reason.trim().length<10||b.reason.length>500)return reply.code(400).send({error:'invalid_resend'});const client=await pool!.connect();try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`resend:${request.params.id}`]);const prior=(await client.query('SELECT * FROM delivery_resend_requests WHERE id=$1',[b.requestId])).rows[0];if(prior){await client.query('ROLLBACK');if(prior.actor_id!==b.actorId||prior.delivery_reference!==request.params.id||prior.reason!==b.reason.trim())return reply.code(409).send({error:'idempotency_conflict'});return {jobId:prior.job_id,replayed:true};}
   const jobs=await client.query('SELECT state FROM delivery_jobs WHERE delivery_reference=$1 FOR UPDATE',[request.params.id]);if(!jobs.rowCount){await client.query('ROLLBACK');return reply.code(409).send({error:'delivery_not_ready'});}if(jobs.rows.some(j=>!['failed','delivered','canceled'].includes(j.state))){await client.query('ROLLBACK');return reply.code(409).send({error:'delivery_unresolved'});}
   const event=randomUUID(),job=randomUUID();await client.query("INSERT INTO event_inbox(id,producer,event_type,aggregate_id,aggregate_version,payload_hash) VALUES($1,'prepaid-access','voucher.delivery.resend',$2,1,$3)",[event,b.requestId,createHash('sha256').update(JSON.stringify({reference:request.params.id,...b})).digest()]);await client.query("INSERT INTO delivery_jobs(id,event_id,delivery_reference,state) VALUES($1,$2,$3,'awaiting_delivery_details')",[job,event,request.params.id]);await client.query('INSERT INTO delivery_resend_requests(id,delivery_reference,actor_id,reason,job_id) VALUES($1,$2,$3,$4,$5)',[b.requestId,request.params.id,b.actorId,b.reason.trim(),job]);await client.query('COMMIT');return reply.code(201).send({jobId:job,replayed:false});
  }catch{await client.query('ROLLBACK');return reply.code(503).send({error:'unavailable'});}finally{client.release();}});
 let timer:ReturnType<typeof setInterval>|undefined,running:Promise<void>|undefined;
 const tick=()=>{if(running||!pool)return;running=processDelivery(pool,demo,config).then(()=>{}).catch(()=>{console.error('Delivery worker unavailable');}).finally(()=>{running=undefined;});};
 if(config.enabled&&pool&&process.env.DELIVERY_WORKER_AUTOSTART!=='false')app.addHook('onReady',async()=>{tick();timer=setInterval(tick,1000);timer.unref();});
 return async()=>{if(timer)clearInterval(timer);await running;};
}
