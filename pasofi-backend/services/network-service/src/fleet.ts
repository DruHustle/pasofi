import {randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {Pool,PoolClient,QueryResultRow} from 'pg';
import {jwtVerify} from 'jose';
import {configuredFleet,exactObject,FleetError,FleetRouter,fingerprint,normalizeValues,REVISION,sameValues,TARGET_KEY,UUID,type FleetConfig,type FleetTarget,type InternalSnapshot,type Values} from './fleet-routeros.js';

type Actor={id:string;version:string;expiresAt:number};
type Params={id:string;changeId?:string};
type Plan={targetKey:string;expectedRevision:string;values:Values;reason:string;requestKey:string};
type Status='prepared'|'applying'|'applied'|'unchanged'|'diverged'|'uncertain'|'expired'|'failed';
type ChangeRow=QueryResultRow&{
 id:string;nas_id:string;actor_id:string;actor_version:string;request_key:string;request_hash:string;
 target_key:string;target_kind:FleetTarget['kind'];target_name:string|null;target_record_id:string|null;
 before_values:Values;after_values:Values;before_revision:string;after_revision:string;config_revision:string;
 status:Status;reason:string;parent_change_id:string|null;attempt_id:string|null;reconcile_after:Date|null;
 created_at:Date;updated_at:Date;expires_at:Date;applied_at:Date|null;error_code:string|null;
};
const route='/internal/v1/router-fleet/routers';
const version=/^[1-9][0-9]{0,18}$/;
const iso=(value:Date|string|null)=>value===null?null:new Date(value).toISOString();
export function publicChange(row:ChangeRow){return {
 id:row.id,nasId:row.nas_id,actorId:row.actor_id,actorVersion:row.actor_version,
 targetKey:row.target_key,targetKind:row.target_kind,...(row.target_name===null?{}:{targetName:row.target_name}),
 before:row.before_values,after:row.after_values,beforeRevision:row.before_revision,afterRevision:row.after_revision,
 status:row.status,reason:row.reason,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),expiresAt:iso(row.expires_at),
 appliedAt:iso(row.applied_at),reconcileAfter:iso(row.reconcile_after),parentChangeId:row.parent_change_id,errorCode:row.error_code
};}
function reason(value:unknown):string {
 if(typeof value!=='string'||!value.trim()||value.trim().length>500||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw new FleetError('invalid_request',400);
 return value.trim();
}
function key(value:unknown):string {if(typeof value!=='string'||!UUID.test(value))throw new FleetError('invalid_request',400);return value.toLowerCase();}
function emptyBody(value:unknown){if(value!==undefined&&(!exactObject(value,[])||Object.keys(value).length))throw new FleetError('invalid_request',400);}
function readPlan(body:unknown,config:FleetConfig):Plan {
 if(!exactObject(body,['targetKey','expectedRevision','values','reason','requestKey'])||typeof body.targetKey!=='string'||!TARGET_KEY.test(body.targetKey)||typeof body.expectedRevision!=='string'||!REVISION.test(body.expectedRevision))throw new FleetError('invalid_request',400);
 const target=config.targets.find(t=>t.key===body.targetKey);if(!target)throw new FleetError('target_unavailable',409);
 return {targetKey:body.targetKey,expectedRevision:body.expectedRevision,values:normalizeValues(target,body.values,true),reason:reason(body.reason),requestKey:key(body.requestKey)};
}
function writesEnabled(config:FleetConfig){return process.env.ROUTER_FLEET_ENABLED==='true'&&process.env.ROUTER_FLEET_WRITES_ENABLED==='true'&&config.allowWrites;}
function requireWrites(config:FleetConfig){if(!writesEnabled(config))throw new FleetError('fleet_writes_disabled',403);}
function selectedConfig(nasId:string){const config=configuredFleet().get(nasId);if(!config)throw new FleetError('router_not_configured',409);return config;}
function routerInfo(row:QueryResultRow,config?:FleetConfig){return {id:row.id,siteId:row.site_id,siteName:row.site_name,clientName:row.client_name,customerNetworkEnabled:row.enabled,configured:!!config,writesEnabled:!!config&&writesEnabled(config)};}
function errorCode(error:unknown){return error instanceof FleetError?error.code:'router_unavailable';}

export function registerRouterFleet(app:FastifyInstance,pool:Pool|null){
 async function authorize(request:FastifyRequest,reply:FastifyReply,scope:'router-fleet:read'|'router-fleet:write'):Promise<Actor|null>{
  if(process.env.ROUTER_FLEET_ENABLED!=='true'){await reply.code(404).send({error:'not_found'});return null;}
  const secret=process.env.INTERNAL_NETWORK_SECRET;
  const demo=process.env.APP_ENV==='demo'&&process.env.NODE_ENV==='development';
  if(!pool||!secret||Buffer.byteLength(secret)<32||(!demo&&secret.startsWith('DEMO_ONLY_'))){await reply.code(503).send({error:'unavailable'});return null;}
  try {
   const header=request.headers.authorization;if(!header?.startsWith('Bearer '))throw new Error();
   const {payload}=await jwtVerify(header.slice(7),new TextEncoder().encode(secret),{algorithms:['HS256'],issuer:'prepaid-access',subject:'prepaid-access',audience:'network',requiredClaims:['exp','iat','sub'],maxTokenAge:'30s'});
   if(payload.scope!==scope){await reply.code(403).send({error:'forbidden'});return null;}
   if(typeof payload.exp!=='number'||typeof payload.iat!=='number'||payload.exp<=payload.iat||payload.exp-payload.iat>30||typeof payload.actorId!=='string'||!UUID.test(payload.actorId)||typeof payload.actorVersion!=='string'||!version.test(payload.actorVersion))throw new Error();
   return {id:payload.actorId.toLowerCase(),version:payload.actorVersion,expiresAt:payload.exp};
  }catch{await reply.code(401).send({error:'unauthorized'});return null;}
 }
 async function tx<T>(operation:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await pool!.connect();
  try {await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='2s'");await client.query("SET LOCAL statement_timeout='5s'");const result=await operation(client);await client.query('COMMIT');return result;}
  catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 }
 async function nas(client:Pool|PoolClient,id:string,lock=false){
  if(!UUID.test(id))throw new FleetError('not_found',404);
  const result=await client.query('SELECT id,site_id,site_name,client_name,enabled FROM radius_nas WHERE id=$1'+(lock?' FOR UPDATE':''),[id]);
  if(!result.rowCount)throw new FleetError('not_found',404);return result.rows[0];
 }
 async function change(client:Pool|PoolClient,nasId:string,id:string,lock=false):Promise<ChangeRow>{
  if(!UUID.test(id))throw new FleetError('not_found',404);
  const result=await client.query<ChangeRow>('SELECT * FROM router_fleet_changes WHERE id=$1 AND nas_id=$2'+(lock?' FOR UPDATE':''),[id,nasId]);
  if(!result.rowCount)throw new FleetError('not_found',404);return result.rows[0];
 }
 async function event(client:PoolClient,row:ChangeRow,actor:Actor,type:string){
  await client.query('INSERT INTO router_fleet_events(id,change_id,nas_id,actor_id,actor_version,event_type,status,error_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[randomUUID(),row.id,row.nas_id,actor.id,actor.version,type,row.status,row.error_code]);
 }
 async function noActive(client:PoolClient,nasId:string){
  const result=await client.query("SELECT id FROM router_fleet_changes WHERE nas_id=$1 AND status IN ('applying','uncertain') LIMIT 1",[nasId]);
  if(result.rowCount)throw new FleetError('router_busy',409);
 }
 async function prior(client:PoolClient,actor:Actor,requestKey:string,hash:string,nasId:string){
  const result=await client.query<ChangeRow>('SELECT * FROM router_fleet_changes WHERE actor_id=$1 AND request_key=$2',[actor.id,requestKey]);
  if(!result.rowCount)return null;
  if(result.rows[0].request_hash!==hash||result.rows[0].nas_id!==nasId)throw new FleetError('idempotency_conflict',409);
  return result.rows[0];
 }
 async function prepare(client:PoolClient,actor:Actor,config:FleetConfig,input:{reason:string;requestKey:string;hash:string;parentId?:string},before:InternalSnapshot,after:InternalSnapshot){
  const result=await client.query<ChangeRow>(`INSERT INTO router_fleet_changes
   (id,nas_id,actor_id,actor_version,request_key,request_hash,target_key,target_kind,target_name,target_record_id,before_values,after_values,before_revision,after_revision,config_revision,status,reason,parent_change_id,expires_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'prepared',$16,$17,now()+interval '10 minutes') ON CONFLICT(actor_id,request_key) DO NOTHING RETURNING *`,
   [randomUUID(),config.nasId,actor.id,actor.version,input.requestKey,input.hash,before.target.key,before.target.kind,before.target.name??null,before.recordId,before.target.values,after.target.values,before.target.revision,after.target.revision,before.configRevision,input.reason,input.parentId??null]);
  if(!result.rowCount){const existing=await prior(client,actor,input.requestKey,input.hash,config.nasId);if(!existing)throw new FleetError('unavailable',503);return existing;}
  await event(client,result.rows[0],actor,input.parentId?'rollback_prepared':'prepared');return result.rows[0];
 }
 async function snapshot(config:FleetConfig,targetKey:string){
  const router=new FleetRouter(config),result=await router.snapshot([targetKey]),target=result.targets[0];
  if(!target)throw new FleetError('target_unavailable',409);return {router,snapshot:target};
 }
 async function finish(nasId:string,id:string,attempt:string,actor:Actor,status:Status,code:string|null){
  return tx(async client=>{
   await nas(client,nasId,true);const row=await change(client,nasId,id,true);
   if(row.status!=='applying'||row.attempt_id!==attempt)return row;
   const updated=await client.query<ChangeRow>(`UPDATE router_fleet_changes SET status=$2,error_code=$3,updated_at=now(),applied_at=CASE WHEN $2='applied' THEN now() ELSE applied_at END WHERE id=$1 RETURNING *`,[id,status,code]);
   await event(client,updated.rows[0],actor,status);return updated.rows[0];
  });
 }
 const guarded=(scope:'router-fleet:read'|'router-fleet:write',operation:(request:FastifyRequest<{Params:Params}>,actor:Actor)=>Promise<unknown>)=>async(request:FastifyRequest<{Params:Params}>,reply:FastifyReply)=>{
  const actor=await authorize(request,reply,scope);if(!actor)return;
  try{return await operation(request,actor);}catch(error){return reply.code(error instanceof FleetError?error.status:503).send({error:error instanceof FleetError?error.code:'unavailable'});}
 };
 app.get(route,guarded('router-fleet:read',async()=>{
  const registry=configuredFleet(),result=await pool!.query('SELECT id,site_id,site_name,client_name,enabled FROM radius_nas ORDER BY site_name,id LIMIT 501');
  if(result.rows.length>500)throw new FleetError('unavailable',503);
  return {routers:result.rows.map(row=>routerInfo(row,registry.get(row.id)))};
 }));
 app.get<{Params:Params}>(`${route}/:id`,guarded('router-fleet:read',async request=>{
  const row=await nas(pool!,request.params.id),config=selectedConfig(row.id),result=await new FleetRouter(config).snapshot();
  return {router:routerInfo(row,config),device:result.device,targets:result.targets.map(t=>t.target),observedAt:result.observedAt};
 }));
 app.get<{Params:Params}>(`${route}/:id/changes`,guarded('router-fleet:read',async request=>{
  const row=await nas(pool!,request.params.id),result=await pool!.query<ChangeRow>('SELECT * FROM router_fleet_changes WHERE nas_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50',[row.id]);
  return {changes:result.rows.map(publicChange)};
 }));
 app.get<{Params:Params}>(`${route}/:id/changes/:changeId`,guarded('router-fleet:read',async(request,actor)=>{
  const registered=await nas(pool!,request.params.id);let row=await change(pool!,registered.id,request.params.changeId!);
  if(row.status==='prepared'&&new Date(row.expires_at).getTime()<=Date.now())row=await tx(async client=>{
   await nas(client,registered.id,true);const locked=await change(client,registered.id,request.params.changeId!,true);
   if(locked.status!=='prepared'||new Date(locked.expires_at).getTime()>Date.now())return locked;
   const result=await client.query<ChangeRow>("UPDATE router_fleet_changes SET status='expired',error_code='change_expired',updated_at=now() WHERE id=$1 RETURNING *",[locked.id]);
   await event(client,result.rows[0],actor,'expired');return result.rows[0];
  });
  return {change:publicChange(row)};
 }));
 app.post<{Params:Params}>(`${route}/:id/changes`,guarded('router-fleet:write',async(request,actor)=>{
  const row=await nas(pool!,request.params.id),config=selectedConfig(row.id);requireWrites(config);
  const plan=readPlan(request.body,config),hash=fingerprint({operation:'preview',nasId:row.id,...plan});
  const result=await tx(async client=>{
   await nas(client,row.id,true);const existing=await prior(client,actor,plan.requestKey,hash,row.id);if(existing)return existing;
   await noActive(client,row.id);
   const current=await snapshot(config,plan.targetKey);
   if(current.snapshot.target.revision!==plan.expectedRevision)throw new FleetError('revision_conflict',409);
   const after=current.router.withValues(current.snapshot,{...current.snapshot.target.values,...plan.values});
   if(sameValues(current.snapshot.target.values,after.target.values))throw new FleetError('invalid_values',400);
   return prepare(client,actor,config,{reason:plan.reason,requestKey:plan.requestKey,hash},current.snapshot,after);
  });
  return {change:publicChange(result)};
 }));
 app.post<{Params:Params}>(`${route}/:id/changes/:changeId/apply`,guarded('router-fleet:write',async(request,actor)=>{
  emptyBody(request.body);
  const initial=await nas(pool!,request.params.id),config=selectedConfig(initial.id);requireWrites(config);
  const started=await tx(async client=>{
   await nas(client,initial.id,true);const row=await change(client,initial.id,request.params.changeId!,true);
   if(row.actor_id!==actor.id||row.actor_version!==actor.version)throw new FleetError('actor_mismatch',403);
   if(row.status!=='prepared')return {row,execute:false};
   if(new Date(row.expires_at).getTime()<=Date.now()){
    const expired=await client.query<ChangeRow>("UPDATE router_fleet_changes SET status='expired',error_code='change_expired',updated_at=now() WHERE id=$1 RETURNING *",[row.id]);
    await event(client,expired.rows[0],actor,'expired');return {row:expired.rows[0],execute:false};
   }
   await noActive(client,initial.id);
   // This commit precedes every possible remote mutation. It survives a
   // process crash, lost HTTP response, or database outage after the write.
   const pending=await client.query<ChangeRow>("UPDATE router_fleet_changes SET status='applying',attempt_id=$2,reconcile_after=now()+interval '90 seconds',error_code=NULL,updated_at=now() WHERE id=$1 RETURNING *",[row.id,randomUUID()]);
   await event(client,pending.rows[0],actor,'apply_started');return {row:pending.rows[0],execute:true};
  });
  if(!started.execute)return {change:publicChange(started.row)};
  const row=started.row,attempt=row.attempt_id!;
  let current:{router:FleetRouter;snapshot:InternalSnapshot};
  try {
   current=await snapshot(config,row.target_key);
   if(current.router.configRevision!==row.config_revision)throw new FleetError('configuration_changed',409);
   if(current.snapshot.target.revision!==row.before_revision)return {change:publicChange(await finish(row.nas_id,row.id,attempt,actor,'diverged','revision_conflict'))};
   // Honour a locally revoked qualification/configuration before sending.
   const fresh=selectedConfig(row.nas_id);requireWrites(fresh);
   const freshRouter=new FleetRouter(fresh);
   if(freshRouter.configRevision!==row.config_revision)throw new FleetError('configuration_changed',409);
   current.router=freshRouter;
   // Reserve 5s for the HTTPS request, RouterOS's documented 60s command
   // lifetime and a 5s margin before the durable 90s settlement boundary.
   // A delayed handler must not start a setter near that boundary.
   if(actor.expiresAt*1000<=Date.now()||!row.reconcile_after||Date.now()>=new Date(row.reconcile_after).getTime()-70000)throw new FleetError('stale_authorization',401);
  }catch(error){return {change:publicChange(await finish(row.nas_id,row.id,attempt,actor,'failed',errorCode(error)))};}
  try {await current.router.write(current.snapshot,row.after_values);}
  catch(error){
   // An abandoned HTTP request can still execute on RouterOS. Even a read
   // that still matches "before" cannot prove the write will not land later.
   return {change:publicChange(await finish(row.nas_id,row.id,attempt,actor,'uncertain',errorCode(error)))};
  }
  try {
   const observed=await snapshot(config,row.target_key),revision=observed.snapshot.target.revision;
   const status:Status=revision===row.after_revision?'applied':revision===row.before_revision?'unchanged':'diverged';
   return {change:publicChange(await finish(row.nas_id,row.id,attempt,actor,status,status==='applied'?null:status==='unchanged'?'write_unchanged':'configuration_diverged'))};
  }catch(error){return {change:publicChange(await finish(row.nas_id,row.id,attempt,actor,'uncertain',errorCode(error)))};}
 }));
 app.post<{Params:Params}>(`${route}/:id/changes/:changeId/reconcile`,guarded('router-fleet:write',async(request,actor)=>{
  emptyBody(request.body);
  const result=await tx(async client=>{
   const registered=await nas(client,request.params.id,true),row=await change(client,registered.id,request.params.changeId!,true);
   if(row.status!=='applying'&&row.status!=='uncertain')return row;
   if(!row.reconcile_after||new Date(row.reconcile_after).getTime()>Date.now())throw new FleetError('reconciliation_pending',409);
   let status:Status='uncertain',code:string|null=null;
   try {
    const observed=await snapshot(selectedConfig(registered.id),row.target_key);
    // Revision includes the enrolled serial, exact target and record identity.
    // A repaired TLS trust file or disabled write qualification must not stop
    // read-only recovery of an ambiguous outcome on that same device.
    const revision=observed.snapshot.target.revision;
    status=revision===row.after_revision?'applied':revision===row.before_revision?'unchanged':'diverged';
    code=status==='applied'?null:status==='unchanged'?'write_unchanged':'configuration_diverged';
   }catch(error){code=errorCode(error);}
   const updated=await client.query<ChangeRow>(`UPDATE router_fleet_changes SET status=$2,error_code=$3,updated_at=now(),applied_at=CASE WHEN $2='applied' THEN now() ELSE applied_at END WHERE id=$1 RETURNING *`,[row.id,status,code]);
   await event(client,updated.rows[0],actor,'reconciled');return updated.rows[0];
  });
  return {change:publicChange(result)};
 }));
 app.post<{Params:Params}>(`${route}/:id/changes/:changeId/rollback`,guarded('router-fleet:write',async(request,actor)=>{
  if(!exactObject(request.body,['reason','requestKey']))throw new FleetError('invalid_request',400);
  const input={reason:reason(request.body.reason),requestKey:key(request.body.requestKey)},registered=await nas(pool!,request.params.id),config=selectedConfig(registered.id);requireWrites(config);
  if(!UUID.test(request.params.changeId!))throw new FleetError('not_found',404);
  const hash=fingerprint({operation:'rollback',nasId:registered.id,parentId:request.params.changeId!.toLowerCase(),...input});
  const result=await tx(async client=>{
   await nas(client,registered.id,true);const existing=await prior(client,actor,input.requestKey,hash,registered.id);if(existing)return existing;
   const parent=await change(client,registered.id,request.params.changeId!,true);
   if(parent.status!=='applied')throw new FleetError('change_not_ready',409);
   await noActive(client,registered.id);
   const current=await snapshot(config,parent.target_key);
   if(current.router.configRevision!==parent.config_revision||current.snapshot.target.revision!==parent.after_revision)throw new FleetError('revision_conflict',409);
   const inverse=current.router.withValues(current.snapshot,parent.before_values);
   return prepare(client,actor,config,{...input,hash,parentId:parent.id},current.snapshot,inverse);
  });
  return {change:publicChange(result)};
 }));
}
