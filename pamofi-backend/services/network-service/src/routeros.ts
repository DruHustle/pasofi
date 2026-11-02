import {request as httpsRequest} from 'node:https';
import {readFileSync} from 'node:fs';

export type RouterConfig={nasId:string;url:string;username:string;password:string;caFile?:string};
export class RouterUnavailable extends Error {constructor(){super('router_unavailable');}}
export class RouterOS {
 private base:URL;
 private ca?:Buffer;
 constructor(private config:RouterConfig){
  this.base=new URL(config.url);
  if(this.base.protocol!=='https:'||this.base.username||this.base.password||this.base.pathname!=='/rest/'||this.base.search||this.base.hash||!config.username||!config.password)throw new RouterUnavailable();
  if(config.caFile)this.ca=readFileSync(config.caFile);
 }
 private call(path:string,method:'GET'|'DELETE',signal?:AbortSignal):Promise<unknown> {
  return new Promise((resolve,reject)=>{
   const deadline=AbortSignal.timeout(5000);
   const req=httpsRequest(new URL(path,this.base),{method,ca:this.ca,rejectUnauthorized:true,auth:`${this.config.username}:${this.config.password}`,headers:{accept:'application/json'},timeout:5000,signal:signal?AbortSignal.any([signal,deadline]):deadline},response=>{
    if(!response.statusCode||response.statusCode<200||response.statusCode>=300){response.resume();reject(new RouterUnavailable());return;}
    let length=0;const chunks:Buffer[]=[];
    response.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>1024*1024){response.destroy();reject(new RouterUnavailable());}else chunks.push(chunk);});
    response.on('error',()=>reject(new RouterUnavailable()));
    response.on('end',()=>{try {const raw=Buffer.concat(chunks).toString('utf8');resolve(raw?JSON.parse(raw):null);}catch{reject(new RouterUnavailable());}});
   });
   req.on('timeout',()=>req.destroy(new RouterUnavailable()));req.on('error',()=>reject(new RouterUnavailable()));req.end();
  });
 }
 async active(username:string,signal?:AbortSignal):Promise<Array<{id:string}>> {
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(username))throw new RouterUnavailable();
  const response=await this.call(`ip/hotspot/active?user=${encodeURIComponent(username)}&.proplist=.id,user`,'GET',signal);
  if(!Array.isArray(response)||response.length>10)throw new RouterUnavailable();
  return response.map(row=>{
   if(!row||typeof row!=='object'||row.user!==username||typeof row['.id']!=='string'||!/^\*[0-9A-Fa-f]{1,16}$/.test(row['.id']))throw new RouterUnavailable();
   return {id:row['.id']};
  });
 }
 async disconnect(username:string,signal?:AbortSignal) {
  const sessions=await this.active(username,signal);
  for(const session of sessions)await this.call(`ip/hotspot/active/${encodeURIComponent(session.id)}`,'DELETE',signal);
  // A successful DELETE response alone does not prove termination.
  return {absent:(await this.active(username,signal)).length===0,observedAt:new Date().toISOString()};
 }
}
export function configuredRouters():Map<string,RouterOS> {
 const path=process.env.ROUTEROS_ROUTERS_FILE;if(!path)throw new RouterUnavailable();
 const rows=JSON.parse(readFileSync(path,'utf8')) as RouterConfig[];
 if(!Array.isArray(rows)||!rows.length||rows.length>100)throw new RouterUnavailable();
 const result=new Map<string,RouterOS>();
 for(const row of rows){
  if(!row||typeof row.nasId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.nasId))throw new RouterUnavailable();
  const nasId=row.nasId.toLowerCase();if(result.has(nasId))throw new RouterUnavailable();
  result.set(nasId,new RouterOS({...row,nasId}));
 }
 return result;
}
