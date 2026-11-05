import {createHash} from 'node:crypto';
import {lookup as dnsLookup} from 'node:dns';
import {lstatSync,readFileSync} from 'node:fs';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
import {isAbsolute} from 'node:path';

export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REVISION=/^[0-9a-f]{64}$/;
export const TARGET_KEY=/^[a-z][a-z0-9_-]{0,47}$/;
export type TargetKind='identity'|'interface'|'wireless'|'wifi'|'hotspot-profile';
export type Values=Record<string,string|boolean>;
export type FleetTarget={key:string;kind:TargetKind;name?:string};
export type FleetConfig={nasId:string;url:string;username:string;password:string;caFile:string;expectedSerial:string;allowWrites:boolean;targets:FleetTarget[];demo?:boolean};
export type Field={key:string;label:string;type:'text'|'boolean';maxLength?:number;help?:string};
export type TargetSnapshot=FleetTarget&{values:Values;revision:string;fields:Field[]};
export type InternalSnapshot={target:TargetSnapshot;recordId:string|null;configRevision:string};
export type Device={identity:string;model:string;version:string;serial:string};
export class FleetError extends Error {
 constructor(public code:string,public status=409){super(code);}
}
const noControl=(value:string)=>!/[\u0000-\u001f\u007f]/.test(value);
const plain=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export function exactObject(value:unknown,keys:string[]):value is Record<string,unknown>{return plain(value)&&Object.keys(value).every(key=>keys.includes(key));}
function textValue(value:unknown,min:number,max:number):value is string {return typeof value==='string'&&Buffer.byteLength(value)>=min&&Buffer.byteLength(value)<=max&&noControl(value);}
function privateAddress(address:string,demo=false){
 if(isIP(address)!==4)return false;
 const [a,b]=address.split('.').map(Number);
 return a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(demo&&a===127);
}
function safeEndpoint(value:unknown,demo:boolean):value is string {
 if(typeof value!=='string')return false;
 try {
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/rest/'||u.search||u.hash||(!demo&&u.port)||u.toString()!==value)return false;
  if(isIP(u.hostname))return privateAddress(u.hostname,demo);
  return u.hostname.length<=253&&u.hostname.includes('.')&&u.hostname!=='localhost'&&/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(u.hostname)&&!u.hostname.endsWith('.localhost');
 }catch{return false;}
}
const kinds:TargetKind[]=['identity','interface','wireless','wifi','hotspot-profile'];
export function validateFleetRows(input:unknown,demo=false):FleetConfig[] {
 if(!Array.isArray(input)||input.length<1||input.length>100)throw new FleetError('unavailable',503);
 const ids=new Set<string>(),serials=new Set<string>(),endpoints=new Set<string>();
 return input.map(row=>{
  if(!exactObject(row,['nasId','url','username','password','caFile','expectedSerial','allowWrites','targets'])||typeof row.nasId!=='string'||!UUID.test(row.nasId)||!safeEndpoint(row.url,demo)||!textValue(row.username,1,128)||/[:\s]/.test(row.username)||!textValue(row.password,1,4096)||!textValue(row.caFile,1,1024)||!isAbsolute(row.caFile)||!textValue(row.expectedSerial,1,64)||typeof row.allowWrites!=='boolean'||!Array.isArray(row.targets)||row.targets.length<1||row.targets.length>16)throw new FleetError('unavailable',503);
  const nasId=row.nasId.toLowerCase(),serialKey=row.expectedSerial.toLowerCase();
  if(ids.has(nasId)||serials.has(serialKey)||endpoints.has(row.url))throw new FleetError('unavailable',503);
  ids.add(nasId);serials.add(serialKey);endpoints.add(row.url);
  const keys=new Set<string>(),resources=new Set<string>();
  const targets=row.targets.map(target=>{
   if(!exactObject(target,['key','kind','name'])||typeof target.key!=='string'||!TARGET_KEY.test(target.key)||typeof target.kind!=='string'||!kinds.includes(target.kind as TargetKind)||(target.kind==='identity'?target.name!==undefined:!textValue(target.name,1,64)))throw new FleetError('unavailable',503);
   const resource=`${target.kind}:${target.name??''}`;
   if(keys.has(target.key)||resources.has(resource))throw new FleetError('unavailable',503);keys.add(target.key);resources.add(resource);
   return {key:target.key,kind:target.kind as TargetKind,...(target.name===undefined?{}:{name:target.name as string})};
  });
  return {nasId,url:row.url,username:row.username,password:row.password,caFile:row.caFile,expectedSerial:row.expectedSerial,allowWrites:row.allowWrites,targets,demo};
 });
}
export function configuredFleet():Map<string,FleetConfig> {
 try {
  const path=process.env.ROUTEROS_FLEET_FILE;
  if(!path||!isAbsolute(path))throw new Error();
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>512*1024||(stat.mode&0o022))throw new Error();
  const demo=process.env.APP_ENV==='demo'&&process.env.NODE_ENV==='development';
  return new Map(validateFleetRows(JSON.parse(readFileSync(path,'utf8')),demo).map(row=>[row.nasId,row]));
 }catch{throw new FleetError('unavailable',503);}
}
export function fieldsFor(kind:TargetKind):Field[] {
 switch(kind){
  case 'identity':return [{key:'name',label:'Router name',type:'text',maxLength:64,help:'1–64 UTF-8 bytes. This does not change router addressing.'}];
  case 'interface':return [{key:'comment',label:'Interface comment',type:'text',maxLength:160,help:'Up to 160 UTF-8 bytes. Interface name and networking stay unchanged.'}];
  case 'wireless':return [{key:'ssid',label:'Customer Wi-Fi name',type:'text',maxLength:32,help:'1–32 UTF-8 bytes. Connected customers may need to reconnect.'},{key:'disabled',label:'Disable customer radio',type:'boolean'}];
  case 'wifi':return [{key:'configuration.ssid',label:'Customer Wi-Fi name',type:'text',maxLength:32,help:'1–32 UTF-8 bytes. Connected customers may need to reconnect.'},{key:'disabled',label:'Disable customer radio',type:'boolean'}];
  case 'hotspot-profile':return [{key:'rate-limit',label:'HotSpot rate limit',type:'text',maxLength:160,help:'RouterOS rates, optional burst rates/thresholds/times, priority and minimum rates. Empty removes the profile limit.'},{key:'idle-timeout',label:'Idle timeout',type:'text',maxLength:32,help:'none, 0s, or a duration such as 5m or 1h30m.'},{key:'keepalive-timeout',label:'Keepalive timeout',type:'text',maxLength:32,help:'none, 0s, or a duration such as 2m.'}];
 }
}
function duration(value:string){return value==='none'||/^(?=.{1,32}$)(?:(?:[0-9]+w)?(?:[0-9]+d)?(?:[0-9]+h)?(?:[0-9]+m)?(?:[0-9]+s)?(?:[0-9]+ms)?)$/.test(value)&&/[0-9]/.test(value)||/^[0-9]{1,3}:[0-5][0-9]:[0-5][0-9]$/.test(value);}
function rateLimit(value:string){
 if(value==='')return true;
 const parts=value.split(' '),rate=/^[0-9]{1,12}(?:[kKmMgG])?(?:\/[0-9]{1,12}(?:[kKmMgG])?)?$/;
 if(parts.length<1||parts.length>6||parts.slice(0,3).some(p=>!rate.test(p)))return false;
 if(parts[3]&&!/^[0-9]{1,6}(?:\/[0-9]{1,6})?$/.test(parts[3]))return false;
 if(parts[4]&&!/^[1-8]$/.test(parts[4]))return false;
 return !parts[5]||rate.test(parts[5]);
}
export function normalizeValues(target:FleetTarget,input:unknown,partial=false):Values {
 const fields=fieldsFor(target.kind);
 if(!exactObject(input,fields.map(f=>f.key))||!Object.keys(input).length||(!partial&&Object.keys(input).length!==fields.length))throw new FleetError('invalid_values',400);
 const result:Values={};
 for(const field of fields){
  if(!Object.hasOwn(input,field.key))continue;
  const value=input[field.key];
  if(field.type==='boolean'){
   if(typeof value!=='boolean')throw new FleetError('invalid_values',400);result[field.key]=value;continue;
  }
  const min=field.key==='comment'||field.key==='rate-limit'?0:1;
  if(!textValue(value,min,field.maxLength!))throw new FleetError('invalid_values',400);
  if((field.key==='idle-timeout'||field.key==='keepalive-timeout')&&!duration(value))throw new FleetError('invalid_values',400);
  if(field.key==='rate-limit'&&!rateLimit(value))throw new FleetError('invalid_values',400);
  result[field.key]=value;
 }
 return result;
}
export function fingerprint(value:unknown){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
export function sameValues(a:Values,b:Values){const keys=Object.keys(a).sort();return keys.length===Object.keys(b).length&&keys.every(key=>a[key]===b[key]);}
function menu(target:FleetTarget){switch(target.kind){case 'identity':return 'system/identity';case 'interface':return 'interface';case 'wireless':return 'interface/wireless';case 'wifi':return 'interface/wifi';case 'hotspot-profile':return 'ip/hotspot/user/profile';}}
function singleton(value:unknown):Record<string,unknown>{
 const row=Array.isArray(value)&&value.length===1?value[0]:value;
 if(!plain(row))throw new FleetError('router_unavailable',503);return row;
}
export class FleetRouter {
 private base:URL;
 private ca:Buffer;
 readonly configRevision:string;
 constructor(readonly config:FleetConfig){
  try {
   this.base=new URL(config.url);
   if(!safeEndpoint(config.url,config.demo===true))throw new Error();
   const stat=lstatSync(config.caFile);
   if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536||(stat.mode&0o022))throw new Error();
   this.ca=readFileSync(config.caFile);
   if(!this.ca.includes('-----BEGIN CERTIFICATE-----')||this.ca.includes('PRIVATE KEY'))throw new Error();
   this.configRevision=fingerprint({nasId:config.nasId,url:config.url,username:config.username,expectedSerial:config.expectedSerial,targets:config.targets,ca:fingerprint(this.ca.toString('utf8'))});
  }catch{throw new FleetError('unavailable',503);}
 }
 private call(path:string,method:'GET'|'POST'|'PATCH',signal:AbortSignal,body?:Values):Promise<unknown>{
  return new Promise((resolve,reject)=>{
   const fail=()=>new FleetError('router_unavailable',503),data=body===undefined?undefined:JSON.stringify(body);
   const req=httpsRequest(new URL(path,this.base),{method,ca:this.ca,rejectUnauthorized:true,auth:`${this.config.username}:${this.config.password}`,headers:{accept:'application/json',...(data===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(data)})},timeout:5000,signal:AbortSignal.any([signal,AbortSignal.timeout(5000)]),lookup:(hostname,options,callback)=>{
    dnsLookup(hostname,{all:true},(error,addresses)=>{
     if(error||!addresses.length||addresses.some(address=>!privateAddress(address.address,this.config.demo)))return callback(fail(),[],undefined);
     const selected=addresses[0];
     if(typeof options==='object'&&options.all)callback(null,addresses,undefined);else callback(null,selected.address,selected.family);
    });
   }},response=>{
    if(!response.statusCode||response.statusCode<200||response.statusCode>=300){response.resume();reject(fail());return;}
    let length=0;const chunks:Buffer[]=[];
    response.on('data',(chunk:Buffer)=>{length+=chunk.length;if(length>256*1024){response.destroy();reject(fail());}else chunks.push(chunk);});
    response.on('error',()=>reject(fail()));
    response.on('aborted',()=>reject(fail()));
    response.on('end',()=>{try{const raw=Buffer.concat(chunks).toString('utf8');resolve(raw?JSON.parse(raw):null);}catch{reject(fail());}});
   });
   req.on('error',()=>reject(fail()));req.on('timeout',()=>req.destroy(fail()));req.end(data);
  });
 }
 async device(signal=AbortSignal.timeout(7000)):Promise<Device>{
  const board=singleton(await this.call('system/routerboard?.proplist=serial-number,model','GET',signal));
  if(typeof board['serial-number']!=='string'||board['serial-number']!==this.config.expectedSerial)throw new FleetError('device_mismatch',409);
  const identity=singleton(await this.call('system/identity?.proplist=name','GET',signal));
  const resource=singleton(await this.call('system/resource?.proplist=version,board-name','GET',signal));
  if(!textValue(identity.name,1,64)||!textValue(resource.version,1,128)||!textValue(board.model??resource['board-name'],1,128))throw new FleetError('router_unavailable',503);
  return {identity:identity.name,model:(board.model??resource['board-name']) as string,version:resource.version,serial:board['serial-number']};
 }
 private revision(target:FleetTarget,recordId:string|null,values:Values){return fingerprint({nasId:this.config.nasId,serial:this.config.expectedSerial,target,recordId,values});}
 withValues(snapshot:InternalSnapshot,values:Values):InternalSnapshot{
  const normalized=normalizeValues(snapshot.target,values);
  return {...snapshot,target:{...snapshot.target,values:normalized,revision:this.revision(this.config.targets.find(t=>t.key===snapshot.target.key)!,snapshot.recordId,normalized)}};
 }
 async readTarget(target:FleetTarget,signal=AbortSignal.timeout(7000)):Promise<InternalSnapshot>{
  const fields=fieldsFor(target.kind),params=new URLSearchParams({'.proplist':[...(target.kind==='identity'?[]:['.id','name']),...fields.map(f=>f.key)].join(',')});
  if(target.name)params.set('name',target.name);
  const response=await this.call(`${menu(target)}?${params}`,'GET',signal);
  let row:Record<string,unknown>,recordId:string|null=null;
  if(target.kind==='identity')row=singleton(response);
  else {
   if(!Array.isArray(response)||response.length!==1||!plain(response[0]))throw new FleetError('target_unavailable',409);
   row=response[0];
   if(row.name!==target.name||typeof row['.id']!=='string'||!/^\*[0-9A-Fa-f]{1,16}$/.test(row['.id']))throw new FleetError('target_unavailable',409);
   recordId=row['.id'];
  }
  const raw:Record<string,unknown>={};
  for(const field of fields){
   const value=row[field.key];
   if(field.type==='boolean'){
    if(value!==true&&value!==false&&value!=='true'&&value!=='false')throw new FleetError('target_unavailable',409);
    raw[field.key]=value===true||value==='true';
   }else raw[field.key]=value??(field.key==='comment'||field.key==='rate-limit'?'':undefined);
  }
  let values:Values;try{values=normalizeValues(target,raw);}catch{throw new FleetError('target_unavailable',409);}
  return {target:{...target,fields,values,revision:this.revision(target,recordId,values)},recordId,configRevision:this.configRevision};
 }
 async snapshot(targetKeys?:string[]){
  const signal=AbortSignal.timeout(7000),device=await this.device(signal),targets:InternalSnapshot[]=[];
  for(const target of this.config.targets){if(!targetKeys||targetKeys.includes(target.key))targets.push(await this.readTarget(target,signal));}
  return {device,targets,observedAt:new Date().toISOString()};
 }
 async write(snapshot:InternalSnapshot,values:Values){
  const target=this.config.targets.find(t=>t.key===snapshot.target.key);
  if(!target||this.configRevision!==snapshot.configRevision||!this.config.allowWrites)throw new FleetError('fleet_writes_disabled',403);
  const normalized=normalizeValues(target,values),record=snapshot.recordId;
  if(target.kind!=='identity'&&(!record||!/^\*[0-9A-Fa-f]{1,16}$/.test(record)))throw new FleetError('target_unavailable',409);
  // Settings menus have no record ID; RouterOS requires POST .../set. Keep
  // the leading * in record IDs literal: RouterOS does not decode %2A here.
  return this.call(target.kind==='identity'?`${menu(target)}/set`:`${menu(target)}/${record}`,target.kind==='identity'?'POST':'PATCH',AbortSignal.timeout(5000),normalized);
 }
}
