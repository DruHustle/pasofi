import {request as httpsRequest} from 'node:https';
import {lookup as dnsLookup} from 'node:dns/promises';
import {closeSync,constants,fstatSync,openSync,readSync} from 'node:fs';
import {isIP,type LookupFunction} from 'node:net';
import {isAbsolute,join} from 'node:path';

type ResolvedAddress={address:string;family:number};
type RouterResolution={resolveHost?:(hostname:string)=>Promise<ResolvedAddress[]>;isPrivateAddress?:(address:string)=>boolean;allowNonstandardPort?:boolean};
const privateIpv4=(address:string)=>{
 if(isIP(address)!==4)return false;
 const [a,b]=address.split('.').map(Number);
 return a===10||(a===172&&b>=16&&b<=31)||(a===192&&b===168);
};

function readProtectedFile(path:string,maxBytes:number,forbiddenModeBits:number,requiredMode?:number):Buffer {
 let fd:number|undefined;
 try {
  // O_NOFOLLOW is required: lstat(path) followed by readFile(path) is
  // vulnerable to a symlink swap between validation and opening the file.
  if(!isAbsolute(path)||typeof constants.O_NOFOLLOW!=='number')throw new Error();
  fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|(constants.O_NONBLOCK||0));
  const before=fstatSync(fd);
  if(!before.isFile()||before.size>maxBytes||(before.mode&forbiddenModeBits)!==0||
     (requiredMode!==undefined&&(before.mode&0o777)!==requiredMode))throw new Error();
  const chunks:Buffer[]=[];let total=0;
  while(total<=maxBytes){
   const chunk=Buffer.alloc(Math.min(8192,maxBytes+1-total));
   const count=readSync(fd,chunk,0,chunk.length,total);
   if(count===0)break;
   chunks.push(chunk.subarray(0,count));total+=count;
  }
  if(total>maxBytes)throw new Error();
  const after=fstatSync(fd);
  if(!after.isFile()||after.dev!==before.dev||after.ino!==before.ino||after.size!==before.size||total!==before.size||
     (after.mode&forbiddenModeBits)!==0||(requiredMode!==undefined&&(after.mode&0o777)!==requiredMode))throw new Error();
  return Buffer.concat(chunks,total);
 }finally{if(fd!==undefined)closeSync(fd);}
}

export type RouterConfig={nasId:string;url:string;username:string;password:string;caFile:string};
export class RouterUnavailable extends Error {constructor(){super('router_unavailable');}}
export class RouterOS {
 private base:URL;
 private ca?:Buffer;
 private resolveHost:(hostname:string)=>Promise<ResolvedAddress[]>;
 private isPrivateAddress:(address:string)=>boolean;
 constructor(private config:RouterConfig,resolution:RouterResolution={}){
  this.resolveHost=resolution.resolveHost??(async hostname=>dnsLookup(hostname,{all:true,verbatim:true}));
  this.isPrivateAddress=resolution.isPrivateAddress??privateIpv4;
  try {
   if(typeof config.url!=='string'||config.url.length>512||typeof config.username!=='string'||!config.username||config.username.length>128||/[:\\x00-\\x20\\x7f]/.test(config.username)||
      typeof config.password!=='string'||!config.password||config.password.length>4096||/[\\x00\\r\\n]/.test(config.password)||
      typeof config.caFile!=='string'||!config.caFile||!isAbsolute(config.caFile))throw new Error();
   this.base=new URL(config.url);
   if(config.url!==this.base.toString()||this.base.protocol!=='https:'||this.base.username||this.base.password||this.base.port&&!resolution.allowNonstandardPort||
      this.base.pathname!=='/rest/'||this.base.search||this.base.hash||this.base.hostname.endsWith('.local')||this.base.hostname.endsWith('.localhost')||
      (isIP(this.base.hostname)!==0&&(isIP(this.base.hostname)!==4||!this.isPrivateAddress(this.base.hostname))))throw new Error();
   this.ca=readProtectedFile(config.caFile,65536,0,0o444);
   if(!this.ca.includes('-----BEGIN CERTIFICATE-----')||this.ca.includes('PRIVATE KEY'))throw new Error();
  }catch{throw new RouterUnavailable();}
 }
 private async call(path:string,method:'GET'|'DELETE',signal?:AbortSignal):Promise<unknown> {
  let addresses:ResolvedAddress[];
  try{
   addresses=isIP(this.base.hostname)===4?[{address:this.base.hostname,family:4}]:await this.resolveHost(this.base.hostname);
  }catch{throw new RouterUnavailable();}
  // Router credentials must never be sent to a public or ambiguous DNS answer.
  // Pin the single reviewed private IPv4 result for this request to prevent a
  // second resolver lookup from rebinding the connection after validation.
  if(addresses.length!==1||addresses[0].family!==4||!this.isPrivateAddress(addresses[0].address))throw new RouterUnavailable();
  const pinnedLookup:LookupFunction=(_hostname,options,callback)=>{
   if(options.all)callback(null,addresses);
   else callback(null,addresses[0].address,4);
  };
  return new Promise((resolve,reject)=>{
   const deadline=AbortSignal.timeout(5000);
   const req=httpsRequest(new URL(path,this.base),{method,ca:this.ca,rejectUnauthorized:true,auth:`${this.config.username}:${this.config.password}`,headers:{accept:'application/json'},lookup:pinnedLookup,timeout:5000,signal:signal?AbortSignal.any([signal,deadline]):deadline},response=>{
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
export function configuredRouters(options:{caDirectory?:string}={}):Map<string,RouterOS> {
 const path=process.env.ROUTEROS_ROUTERS_FILE;
 const caDirectory=options.caDirectory??'/run/pamofi/routeros-ca';
 if(!isAbsolute(caDirectory))throw new RouterUnavailable();
 if(!path||!isAbsolute(path))throw new RouterUnavailable();
 let rows:unknown;
 try{rows=JSON.parse(readProtectedFile(path,512*1024,0,0o444).toString('utf8'));}catch{throw new RouterUnavailable();}
 if(!Array.isArray(rows)||!rows.length||rows.length>100)throw new RouterUnavailable();
 const result=new Map<string,RouterOS>();
 for(const row of rows){
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(key=>!['nasId','url','username','password','caFile'].includes(key))||
    typeof row.nasId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.nasId)||
    typeof row.url!=='string'||typeof row.username!=='string'||typeof row.password!=='string'||
    typeof row.caFile!=='string')throw new RouterUnavailable();
  const nasId=row.nasId;if(result.has(nasId)||row.caFile!==join(caDirectory,`${nasId}.pem`))throw new RouterUnavailable();
  result.set(nasId,new RouterOS({...row,nasId} as RouterConfig));
 }
 return result;
}
