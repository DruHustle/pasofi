import Fastify from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { TLSSocket } from 'node:tls';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
import type { SecureContextOptions } from 'node:tls';

type Attr={value?:unknown};
type RadiusInput=Record<string,Attr>;
type Options={pool:Pool;tls:SecureContextOptions;clientFingerprint:string;prepaidUrl:string;networkSecret:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const session=/^[A-Za-z0-9._:-]{1,128}$/;
const maximum=(1n<<64n)-1n;
class RadiusInvalid extends Error {}
function value(body:RadiusInput,name:string):string {
 const attr=body?.[name];
 if(!attr || !Array.isArray(attr.value) || attr.value.length!==1 || (typeof attr.value[0]!=='string' && typeof attr.value[0]!=='number')) throw new RadiusInvalid();
 return String(attr.value[0]);
}
function counter(body:RadiusInput,name:string):bigint {
 const v=value(body,name);
 if(!/^(0|[1-9][0-9]{0,9})$/.test(v) || BigInt(v)>0xffffffffn) throw new RadiusInvalid();
 return BigInt(v);
}
function parseClass(body:RadiusInput) {
 const v=value(body,'Class');
 // rlm_rest renders printable octets as text and non-printable octets as hex.
 let decoded=v;
 if(v.startsWith('0x')) {
  if(!/^0x[0-9a-f]+$/i.test(v) || (v.length-2)%2) throw new RadiusInvalid();
  decoded=Buffer.from(v.slice(2),'hex').toString('utf8');
 }
 const parts=decoded.split(':');
 if(parts.length!==3 || parts[0]!=='pamofi' || !uuid.test(parts[1]) || !uuid.test(parts[2])) throw new RadiusInvalid();
 return {grantId:parts[1],generation:parts[2]};
}
export function buildRadiusApp(options:Options) {
 const demo=process.env.APP_ENV==='demo'&&process.env.NODE_ENV==='development';
 if(demo?process.env.INTERNAL_RADIUS_ENABLED!=='true':process.env.PAMOFI_RADIUS_QUALIFIED!=='true') throw new Error('radius_not_qualified');
 const upstream=new URL(options.prepaidUrl);
 if((upstream.protocol!=='https:'&&!(demo&&upstream.protocol==='http:')) || upstream.username || upstream.password || upstream.pathname!=='/' || upstream.search || upstream.hash || Buffer.byteLength(options.networkSecret)<32 || (!demo&&options.networkSecret.startsWith('DEMO_ONLY'))) throw new Error('invalid_radius_configuration');
 const normalized=options.clientFingerprint.replaceAll(':','').toLowerCase();
 if(!/^[a-f0-9]{64}$/.test(normalized)) throw new Error('invalid_radius_client_fingerprint');
 const expectedFingerprint=Buffer.from(normalized,'hex');
 const app=Fastify({logger:false,bodyLimit:16384,https:{...options.tls,requestCert:true,rejectUnauthorized:true}});
 async function registeredNas(request:import('fastify').FastifyRequest) {
  const socket=request.raw.socket;
  if(!(socket instanceof TLSSocket) || !socket.authorized) throw new RadiusInvalid();
  const peer=socket.getPeerCertificate();
  const fingerprint=peer.fingerprint256?.replaceAll(':','').toLowerCase();
  if(!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint) || !timingSafeEqual(expectedFingerprint,Buffer.from(fingerprint,'hex'))) throw new RadiusInvalid();
  const name=request.headers['x-pamofi-nas'];
  if(typeof name!=='string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new RadiusInvalid();
  const result=await options.pool.query('SELECT id,site_id,client_name FROM radius_nas WHERE client_name=$1 AND enabled=true',[name]);
  if(result.rowCount!==1) throw new RadiusInvalid();
  return result.rows[0] as {id:string;site_id:string;client_name:string};
 }
 async function ledger(path:string,scope:string,payload:unknown) {
  const token=await new SignJWT({scope}).setProtectedHeader({alg:'HS256'}).setIssuer('network').setSubject('network').setAudience('prepaid-access').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(options.networkSecret));
  const res=await fetch(new URL(path,upstream),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(2000)});
  if(res.status===409) throw new RadiusInvalid();
  if(!res.ok) throw new Error('ledger_unavailable');
  return await res.json() as Record<string,unknown>;
 }
 app.post<{Body:RadiusInput}>('/radius/authorize',async(request,reply)=>{
  try {
   const nas=await registeredNas(request),body=request.body;
   const name=value(body,'User-Name'),password=value(body,'User-Password'),sessionId=value(body,'Acct-Session-Id');
   if(!/^[A-Za-z0-9_-]{16,128}$/.test(name) || !/^[A-Za-z0-9_-]{32,128}$/.test(password) || !session.test(sessionId)) throw new RadiusInvalid();
   const rows=await options.pool.query('SELECT id,customer_id,secret_hash FROM radius_credentials WHERE username=$1 AND nas_id=$2 AND revoked_at IS NULL AND expires_at>now()',[name,nas.id]);
   const actual=createHash('sha256').update(password,'utf8').digest();
   const stored=rows.rowCount===1?rows.rows[0].secret_hash:Buffer.alloc(32);
   if(!Buffer.isBuffer(stored) || stored.length!==32 || !timingSafeEqual(actual,stored) || rows.rowCount!==1) throw new RadiusInvalid();
   const credential=rows.rows[0];
   const grant=await ledger('/internal/v1/radius/grants','radius:grant',{customerId:credential.customer_id,siteId:nas.site_id,nasId:nas.id,requestKey:credential.id,sessionId});
   // Revocation, expiry or a NAS registry change can occur while the ledger
   // request is in flight. Recheck the live local authority before emitting
   // Access-Accept; a stale successful grant response is not sufficient.
   const live=await options.pool.query(`SELECT 1 FROM radius_credentials c JOIN radius_nas n ON n.id=c.nas_id
     WHERE c.id=$1 AND c.customer_id=$2 AND c.nas_id=$3 AND c.username=$4 AND c.secret_hash=$5
       AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND n.enabled=true AND n.site_id=$6 AND n.client_name=$7`,
     [credential.id,credential.customer_id,nas.id,name,actual,nas.site_id,nas.client_name]);
   if(live.rowCount!==1)throw new RadiusInvalid();
   if(typeof grant.grantId!=='string' || !uuid.test(grant.grantId) || typeof grant.generation!=='string' || !uuid.test(grant.generation) || typeof grant.reservedBytes!=='string' || !/^[1-9][0-9]{0,19}$/.test(grant.reservedBytes) || typeof grant.deadline!=='string') throw new Error('invalid_grant');
   const bytes=BigInt(grant.reservedBytes),deadline=Date.parse(grant.deadline),remaining=Math.floor((deadline-Date.now())/1000)-30;
   if(bytes>maximum || !Number.isFinite(deadline) || !Number.isSafeInteger(remaining) || remaining<=0 || remaining>86400) throw new RadiusInvalid();
   const correlation=Buffer.from(`pamofi:${grant.grantId}:${grant.generation}`,'utf8').toString('hex');
   return {'reply:Class':{value:[`0x${correlation}`],do_xlat:false},'reply:Session-Timeout':remaining,'reply:Acct-Interim-Interval':60,'reply:Mikrotik-Total-Limit':Number(bytes&0xffffffffn),'reply:Mikrotik-Total-Limit-Gigawords':Number(bytes>>32n),'reply:Mikrotik-Rate-Limit':'1M/3M'};
  } catch(error){return reply.code(error instanceof RadiusInvalid?401:503).send({error:error instanceof RadiusInvalid?'rejected':'unavailable'});}
 });
 app.post<{Body:RadiusInput}>('/radius/accounting',async(request,reply)=>{
  try {
   const nas=await registeredNas(request),body=request.body,status=value(body,'Acct-Status-Type');
   if(status==='Accounting-On'||status==='Accounting-Off') {
    await ledger('/internal/v1/radius/restart','radius:account',{siteId:nas.site_id,nasId:nas.id});
    await options.pool.query('UPDATE radius_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE nas_id=$1',[nas.id]);
    return reply.code(204).send();
   }
   const sessionId=value(body,'Acct-Session-Id'),grant=parseClass(body);
   if(!session.test(sessionId) || !['Start','Interim-Update','Stop'].includes(status)) throw new RadiusInvalid();
   // RouterOS describes output as client upload. Gigawords are required on
   // interim/stop so a missing high word cannot silently create free traffic.
   const upload=status==='Start'?0n:(counter(body,'Acct-Output-Gigawords')<<32n)+counter(body,'Acct-Output-Octets');
   const download=status==='Start'?0n:(counter(body,'Acct-Input-Gigawords')<<32n)+counter(body,'Acct-Input-Octets');
   await ledger('/internal/v1/radius/accounting','radius:account',{...grant,siteId:nas.site_id,nasId:nas.id,sessionId,kind:status==='Start'?'start':status==='Stop'?'stop':'interim',upload:upload.toString(),download:download.toString()});
   // rlm_rest treats a successful JSON body as RADIUS attributes. Accounting
   // has no reply attributes, so acknowledge the durable commit with 204.
   return reply.code(204).send();
  } catch(error){return reply.code(error instanceof RadiusInvalid?401:503).send({error:error instanceof RadiusInvalid?'rejected':'unavailable'});}
 });
 return app;
}
