import {createHash,randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {Pool,PoolClient,QueryResultRow} from 'pg';
import {jwtVerify} from 'jose';
import {configuredRouters} from './routeros.js';
import {AllowlistError,MAX_APPROVED_DEVICES,normalizeLabel,normalizeMac,normalizeReason,reconcileRouter,type BindingRouter,type DesiredDevice,type RouterSyncResult} from './allowlist.js';

type Actor={id:string;version:string};
type Scope='device-allowlist:read'|'device-allowlist:write';
export type RouterRegistry=()=>Map<string,BindingRouter>;
const route='/internal/v1/device-allowlist';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION=/^[1-9][0-9]{0,18}$/;
// Distinct from the migration lock. One synchronization may write to the
// routers at a time, across processes; one list change at a time per database.
const SYNC_LOCK=73204822,ENTRY_LOCK=73204823;
// Wait briefly so a reachable router's result is usually in the response. A
// slower router continues in the background; clients re-read the list.
const RESPONSE_BUDGET_MS=4000;
const iso=(value:Date|string|null)=>value===null?null:new Date(value).toISOString();
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exactObject=(value:unknown,keys:string[]):value is Record<string,unknown>=>plain(value)&&Object.keys(value).every(key=>keys.includes(key));
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function requestKey(value:unknown){if(typeof value!=='string'||!UUID.test(value))throw new AllowlistError('invalid_request');return value.toLowerCase();}
function writesEnabled(){return process.env.DEVICE_ALLOWLIST_ENABLED==='true'&&process.env.DEVICE_ALLOWLIST_WRITES_ENABLED==='true';}
function requireWrites(){if(!writesEnabled())throw new AllowlistError('allowlist_writes_disabled',403);}

function publicDevice(row:QueryResultRow){return {id:row.id,macAddress:row.mac_address,label:row.label,createdBy:row.created_by,createdAt:iso(row.created_at)};}
function publicEvent(row:QueryResultRow){return {
 id:row.id,entryId:row.entry_id,type:row.event_type,actorId:row.actor_id,nasId:row.nas_id,
 macAddress:row.mac_address,label:row.label,reason:row.reason,createdAt:iso(row.created_at),
};}

export function createAllowlistSynchronizer(pool:Pool,registry:RouterRegistry){
 const controller=new AbortController();
 let running:Promise<void>|null=null,queued:{actor:Actor;promise:Promise<void>}|null=null,closing=false;
 async function persist(client:PoolClient,actor:Actor,results:(readonly [string,RouterSyncResult])[]){
  const removedIds=[...new Set(results.flatMap(([,result])=>result.removed.map(item=>item.entryId)))];
  const labels=new Map((await client.query('SELECT id,label FROM device_allowlist_entries WHERE id=ANY($1::uuid[])',[removedIds])).rows.map(row=>[row.id,row.label]));
  await client.query('BEGIN');
  try {
   for(const [nasId,result] of results){
    const reached=result.status!=='unreachable';
    await client.query(`INSERT INTO device_allowlist_router_status(nas_id,status,error_code,attempted_at,synced_at,added,removed,conflicts,pending_removals,triggered_by)
     VALUES($1,$2,$3,now(),CASE WHEN $2='synced' THEN now() END,$4,$5,$6,$7,$8)
     ON CONFLICT(nas_id) DO UPDATE SET status=EXCLUDED.status,error_code=EXCLUDED.error_code,attempted_at=EXCLUDED.attempted_at,
      synced_at=COALESCE(EXCLUDED.synced_at,device_allowlist_router_status.synced_at),added=EXCLUDED.added,removed=EXCLUDED.removed,
      conflicts=CASE WHEN $9 THEN EXCLUDED.conflicts ELSE device_allowlist_router_status.conflicts END,
      pending_removals=CASE WHEN $9 THEN EXCLUDED.pending_removals ELSE device_allowlist_router_status.pending_removals END,
      triggered_by=EXCLUDED.triggered_by`,
     [nasId,result.status,result.errorCode,result.added.length,result.removed.length,result.conflicts,result.pendingRemovals,actor.id,reached]);
    for(const [entryId,state] of result.states){
     await client.query(`INSERT INTO device_allowlist_router_devices(entry_id,nas_id,state,observed_at) VALUES($1,$2,$3,now())
      ON CONFLICT(entry_id,nas_id) DO UPDATE SET state=EXCLUDED.state,observed_at=EXCLUDED.observed_at`,[entryId,nasId,state]);
    }
    for(const device of result.added)await client.query(`INSERT INTO device_allowlist_events(id,entry_id,event_type,actor_id,actor_version,nas_id,mac_address,label) VALUES($1,$2,'router_binding_added',$3,$4,$5,$6,$7)`,
     [randomUUID(),device.id,actor.id,actor.version,nasId,device.macAddress,device.label]);
    for(const item of result.removed)await client.query(`INSERT INTO device_allowlist_events(id,entry_id,event_type,actor_id,actor_version,nas_id,mac_address,label) VALUES($1,$2,'router_binding_removed',$3,$4,$5,$6,$7)`,
     [randomUUID(),item.entryId,actor.id,actor.version,nasId,item.macAddress,labels.get(item.entryId)??null]);
   }
   await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
 }
 async function run(actor:Actor){
  const client=await pool.connect();let locked=false;
  try {
   await client.query("SET lock_timeout='30s'");
   await client.query('SELECT pg_advisory_lock($1)',[SYNC_LOCK]);locked=true;
   await client.query('RESET lock_timeout');
   // Read the wanted list only after taking the lock so this run includes
   // every change committed before it started.
   const desired:DesiredDevice[]=(await client.query('SELECT id,mac_address,label FROM device_allowlist_entries WHERE removed_at IS NULL ORDER BY created_at,id')).rows
    .map(row=>({id:row.id,macAddress:row.mac_address,label:row.label}));
   let routers:Map<string,BindingRouter>;
   try {routers=registry();}catch{routers=new Map();}
   const results=await Promise.all([...routers].map(async([nasId,router])=>[nasId,await reconcileRouter(router,desired,controller.signal)] as const));
   await persist(client,actor,results);
  }finally{
   if(locked)await client.query('SELECT pg_advisory_unlock($1)',[SYNC_LOCK]).catch(()=>{});
   await client.query('RESET lock_timeout').catch(()=>{});
   client.release();
  }
 }
 // Single flight with one trailing run: a request made while a run is in
 // progress is served by the next run, which reads the list afresh.
 function request(actor:Actor):Promise<void>{
  if(closing)return Promise.resolve();
  if(!running){
   running=run(actor).catch(()=>{if(!closing)console.error('network: approved device synchronization unavailable');}).finally(()=>{running=null;});
   return running;
  }
  if(queued){queued.actor=actor;return queued.promise;}
  const next:{actor:Actor;promise:Promise<void>}={actor,promise:Promise.resolve()};
  next.promise=running.then(()=>{queued=null;return request(next.actor);});
  queued=next;return next.promise;
 }
 return {
  request,
  busy:()=>running!==null,
  async close(){closing=true;controller.abort();await queued?.promise;await running;},
 };
}

export function registerDeviceAllowlist(app:FastifyInstance,pool:Pool|null,registry:RouterRegistry=()=>configuredRouters()){
 const sync=pool?createAllowlistSynchronizer(pool,registry):null;
 app.addHook('onClose',async()=>{await sync?.close();});
 async function authorize(request:FastifyRequest,reply:FastifyReply,scope:Scope):Promise<Actor|null>{
  if(process.env.DEVICE_ALLOWLIST_ENABLED!=='true'){await reply.code(404).send({error:'not_found'});return null;}
  const secret=process.env.INTERNAL_NETWORK_SECRET;
  const demo=process.env.APP_ENV==='demo'&&process.env.NODE_ENV==='development';
  if(!pool||!secret||Buffer.byteLength(secret)<32||(!demo&&secret.startsWith('DEMO_ONLY_'))){await reply.code(503).send({error:'unavailable'});return null;}
  try {
   const header=request.headers.authorization;if(!header?.startsWith('Bearer '))throw new Error();
   const {payload}=await jwtVerify(header.slice(7),new TextEncoder().encode(secret),{algorithms:['HS256'],issuer:'prepaid-access',subject:'prepaid-access',audience:'network',requiredClaims:['exp','iat','sub'],maxTokenAge:'30s'});
   if(payload.scope!==scope){await reply.code(403).send({error:'forbidden'});return null;}
   if(typeof payload.exp!=='number'||typeof payload.iat!=='number'||payload.exp<=payload.iat||payload.exp-payload.iat>30||typeof payload.actorId!=='string'||!UUID.test(payload.actorId)||typeof payload.actorVersion!=='string'||!VERSION.test(payload.actorVersion))throw new Error();
   return {id:payload.actorId.toLowerCase(),version:payload.actorVersion};
  }catch{await reply.code(401).send({error:'unauthorized'});return null;}
 }
 const guarded=(scope:Scope,operation:(request:FastifyRequest<{Params:{id?:string}}>,actor:Actor,reply:FastifyReply)=>Promise<unknown>)=>async(request:FastifyRequest<{Params:{id?:string}}>,reply:FastifyReply)=>{
  const actor=await authorize(request,reply,scope);if(!actor)return;
  try {return await operation(request,actor,reply);}
  catch(error){return reply.code(error instanceof AllowlistError?error.status:503).send({error:error instanceof AllowlistError?error.code:'unavailable'});}
 };
 async function tx<T>(operation:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await pool!.connect();
  try {
   await client.query('BEGIN');await client.query("SET LOCAL lock_timeout='2s'");await client.query("SET LOCAL statement_timeout='5s'");
   await client.query('SELECT pg_advisory_xact_lock($1)',[ENTRY_LOCK]);
   const result=await operation(client);await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
 }
 async function prior(client:PoolClient,actor:Actor,key:string,type:'added'|'removed',hash:string){
  const result=await client.query('SELECT entry_id,event_type,request_hash FROM device_allowlist_events WHERE actor_id=$1 AND request_key=$2',[actor.id,key]);
  if(!result.rowCount)return null;
  if(result.rows[0].event_type!==type||result.rows[0].request_hash!==hash)throw new AllowlistError('idempotency_conflict',409);
  return (await client.query('SELECT * FROM device_allowlist_entries WHERE id=$1',[result.rows[0].entry_id])).rows[0];
 }
 async function settle(actor:Actor){
  if(!sync)return false;
  let timer:NodeJS.Timeout|undefined;
  const finished=await Promise.race([sync.request(actor).then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),RESPONSE_BUDGET_MS);timer.unref();})]);
  clearTimeout(timer);
  return !finished||sync.busy();
 }

 app.get(route,guarded('device-allowlist:read',async request=>{
  if(!exactObject(request.query,[]))throw new AllowlistError('invalid_request');
  const entries=(await pool!.query('SELECT id,mac_address,label,created_by,created_at FROM device_allowlist_entries WHERE removed_at IS NULL ORDER BY created_at,id LIMIT $1',[MAX_APPROVED_DEVICES+1])).rows;
  if(entries.length>MAX_APPROVED_DEVICES)throw new AllowlistError('unavailable',503);
  const states=(await pool!.query('SELECT entry_id,nas_id,state,observed_at FROM device_allowlist_router_devices WHERE entry_id=ANY($1::uuid[])',[entries.map(row=>row.id)])).rows;
  const nas=(await pool!.query('SELECT id,site_name,client_name FROM radius_nas ORDER BY site_name,client_name,id LIMIT 501')).rows;
  const statuses=new Map((await pool!.query('SELECT * FROM device_allowlist_router_status')).rows.map(row=>[row.nas_id,row]));
  const events=(await pool!.query('SELECT * FROM device_allowlist_events ORDER BY created_at DESC,id DESC LIMIT 30')).rows;
  if(nas.length>500)throw new AllowlistError('unavailable',503);
  let configured:Map<string,BindingRouter>,registryAvailable=true;
  try {configured=registry();}catch{configured=new Map();registryAvailable=false;}
  const known=new Map(nas.map(row=>[row.id,row]));
  const ids=[...new Set([...nas.map(row=>row.id),...[...configured.keys()].filter(id=>!known.has(id)).sort()])];
  const routers=ids.map(id=>{
   const row=known.get(id),status=statuses.get(id),isConfigured=configured.has(id);
   return {id,siteName:row?.site_name??null,clientName:row?.client_name??null,configured:isConfigured,
    status:!isConfigured?'not_configured':status?.status??'pending',errorCode:isConfigured?status?.error_code??null:null,
    attemptedAt:isConfigured?iso(status?.attempted_at??null):null,syncedAt:isConfigured?iso(status?.synced_at??null):null,
    conflicts:isConfigured?status?.conflicts??0:0,pendingRemovals:isConfigured?status?.pending_removals??0:0};
  });
  const observed=new Map(states.map(row=>[`${row.entry_id}:${row.nas_id}`,row]));
  return {
   devices:entries.map(entry=>({...publicDevice(entry),routers:routers.map(router=>{
    const row=observed.get(`${entry.id}:${router.id}`);
    // An observation older than the entry belongs to an earlier binding.
    const state=!router.configured?'not_configured':row&&new Date(row.observed_at)>=new Date(entry.created_at)?row.state:'pending';
    return {nasId:router.id,state,observedAt:row?iso(row.observed_at):null};
   })})),
   routers,events:events.map(publicEvent),
   maxDevices:MAX_APPROVED_DEVICES,writesEnabled:writesEnabled(),registryAvailable,syncing:sync?.busy()??false,
  };
 }));
 app.post(`${route}/devices`,guarded('device-allowlist:write',async(request,actor,reply)=>{
  requireWrites();
  const body=request.body;
  if(!exactObject(body,['macAddress','label','reason','requestKey']))throw new AllowlistError('invalid_request');
  const input={macAddress:normalizeMac(body.macAddress),label:normalizeLabel(body.label),reason:normalizeReason(body.reason)},key=requestKey(body.requestKey);
  const hash=fingerprint({operation:'add',...input});
  const result=await tx(async client=>{
   const existing=await prior(client,actor,key,'added',hash);if(existing)return {row:existing,created:false};
   const count=(await client.query('SELECT count(*)::int AS count FROM device_allowlist_entries WHERE removed_at IS NULL')).rows[0].count;
   if((await client.query('SELECT 1 FROM device_allowlist_entries WHERE mac_address=$1 AND removed_at IS NULL',[input.macAddress])).rowCount)throw new AllowlistError('device_exists',409);
   if(count>=MAX_APPROVED_DEVICES)throw new AllowlistError('allowlist_full',409);
   const id=randomUUID();
   const row=(await client.query('INSERT INTO device_allowlist_entries(id,mac_address,label,created_by,created_by_version) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,input.macAddress,input.label,actor.id,actor.version])).rows[0];
   await client.query(`INSERT INTO device_allowlist_events(id,entry_id,event_type,actor_id,actor_version,mac_address,label,reason,request_key,request_hash) VALUES($1,$2,'added',$3,$4,$5,$6,$7,$8,$9)`,
    [randomUUID(),id,actor.id,actor.version,input.macAddress,input.label,input.reason,key,hash]);
   return {row,created:true};
  });
  const syncing=await settle(actor);
  return reply.code(result.created?201:200).send({device:publicDevice(result.row),syncing});
 }));
 app.post<{Params:{id:string}}>(`${route}/devices/:id/remove`,guarded('device-allowlist:write',async(request,actor)=>{
  requireWrites();
  const id=request.params.id,body=request.body;
  if(typeof id!=='string'||!UUID.test(id))throw new AllowlistError('not_found',404);
  if(!exactObject(body,['reason','requestKey']))throw new AllowlistError('invalid_request');
  const reason=normalizeReason(body.reason),key=requestKey(body.requestKey),entryId=id.toLowerCase();
  const hash=fingerprint({operation:'remove',entryId,reason});
  const row=await tx(async client=>{
   const existing=await prior(client,actor,key,'removed',hash);if(existing)return existing;
   const current=await client.query('SELECT * FROM device_allowlist_entries WHERE id=$1 FOR UPDATE',[entryId]);
   if(!current.rowCount)throw new AllowlistError('not_found',404);
   if(current.rows[0].removed_at)throw new AllowlistError('device_not_active',409);
   const updated=(await client.query('UPDATE device_allowlist_entries SET removed_at=now(),removed_by=$2,removed_by_version=$3 WHERE id=$1 RETURNING *',[entryId,actor.id,actor.version])).rows[0];
   await client.query(`INSERT INTO device_allowlist_events(id,entry_id,event_type,actor_id,actor_version,mac_address,label,reason,request_key,request_hash) VALUES($1,$2,'removed',$3,$4,$5,$6,$7,$8,$9)`,
    [randomUUID(),entryId,actor.id,actor.version,updated.mac_address,updated.label,reason,key,hash]);
   return updated;
  });
  const syncing=await settle(actor);
  return {device:{...publicDevice(row),removedAt:iso(row.removed_at)},syncing};
 }));
 app.post(`${route}/sync`,guarded('device-allowlist:write',async(request,actor,reply)=>{
  requireWrites();
  if(request.body!==undefined&&(!exactObject(request.body,[])))throw new AllowlistError('invalid_request');
  const syncing=await settle(actor);
  return reply.code(syncing?202:200).send({syncing});
 }));
}
