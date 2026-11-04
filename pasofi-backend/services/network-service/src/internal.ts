import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {jwtVerify} from 'jose';
import {CredentialError,issueRadiusCredential} from './credentials.js';

const id={type:'string',pattern:'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'};
export function safeLoginUrl(raw:unknown):string|null {
 if(typeof raw!=='string')return null;
 try {const url=new URL(raw);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/login'?url.toString():null;}catch{return null;}
}
function deliveryKeys() {
 const version=Number(process.env.RADIUS_CREDENTIAL_KEY_VERSION);
 const raw=JSON.parse(process.env.RADIUS_CREDENTIAL_KEYS||'{}') as Record<string,unknown>;
 const keys=new Map<number,Buffer>();
 for(const [v,key] of Object.entries(raw))if(/^[1-9][0-9]{0,8}$/.test(v)&&typeof key==='string'&&/^[a-f0-9]{64}$/i.test(key))keys.set(Number(v),Buffer.from(key,'hex'));else throw new Error('invalid_credential_keys');
 if(!Number.isInteger(version)||!keys.has(version))throw new Error('credential_keys_unavailable');
 return {version,keys};
}
export function registerNetworkInternal(app:FastifyInstance,pool:Pool|null) {
 async function authorize(request:FastifyRequest,reply:FastifyReply,scope:string) {
  const demo=process.env.APP_ENV==='demo'&&process.env.NODE_ENV==='development';
  if(process.env.PAMOFI_CUSTOMER_NETWORK_ENABLED!=='true'||(demo?process.env.INTERNAL_RADIUS_ENABLED!=='true':process.env.PAMOFI_RADIUS_QUALIFIED!=='true')){await reply.code(404).send({error:'not_found'});return false;}
  const secret=process.env.INTERNAL_NETWORK_SECRET;
  if(!pool||!secret||Buffer.byteLength(secret)<32){await reply.code(503).send({error:'unavailable'});return false;}
  try {
   const header=request.headers.authorization;if(!header?.startsWith('Bearer '))throw new Error();
   const {payload}=await jwtVerify(header.slice(7),new TextEncoder().encode(secret),{algorithms:['HS256'],issuer:'prepaid-access',subject:'prepaid-access',audience:'network',requiredClaims:['exp','iat','sub'],maxTokenAge:'30s'});
   if(payload.scope!==scope){await reply.code(403).send({error:'forbidden'});return false;}
   if(typeof payload.exp!=='number'||typeof payload.iat!=='number'||payload.exp-payload.iat>30)throw new Error();
   return true;
  }catch{await reply.code(401).send({error:'unauthorized'});return false;}
 }
 app.get('/internal/v1/network/sites',async(request,reply)=>{
  if(!await authorize(request,reply,'network:sites'))return;
  try {
   const rows=await pool!.query('SELECT site_id,site_name,login_url FROM radius_nas WHERE enabled=true ORDER BY site_name,id');
   const sites=new Map<string,{id:string;name:string;loginUrl:string}>();
   for(const row of rows.rows){const loginUrl=safeLoginUrl(row.login_url);if(loginUrl&&!sites.has(row.site_id))sites.set(row.site_id,{id:row.site_id,name:row.site_name,loginUrl});}
   return {sites:[...sites.values()]};
  }catch{return reply.code(503).send({error:'unavailable'});}
 });
 app.post<{Body:{customerId:string;siteId:string;requestKey:string}}>('/internal/v1/network/credentials',{schema:{body:{type:'object',additionalProperties:false,required:['customerId','siteId','requestKey'],properties:{customerId:id,siteId:id,requestKey:id}}}},async(request,reply)=>{
  if(!await authorize(request,reply,'network:credentials'))return;
  try {
   const nas=await pool!.query('SELECT id,login_url FROM radius_nas WHERE site_id=$1 AND enabled=true ORDER BY id LIMIT 1',[request.body.siteId]);
   if(!nas.rowCount)return reply.code(409).send({error:'site_unavailable'});
   const loginUrl=safeLoginUrl(nas.rows[0].login_url);if(!loginUrl)return reply.code(409).send({error:'site_unavailable'});
   const ring=deliveryKeys(),prior=await pool!.query('SELECT secret_key_version FROM radius_credentials WHERE customer_id=$1 AND request_key=$2',[request.body.customerId,request.body.requestKey]);
   const version=prior.rows[0]?.secret_key_version??ring.version,key=ring.keys.get(version);if(!key)throw new Error('credential_key_unavailable');
   const credential=await issueRadiusCredential(pool!,{customerId:request.body.customerId,nasId:nas.rows[0].id,requestKey:request.body.requestKey},{version,key});
   return {...credential,loginUrl};
  }catch(error){return reply.code(error instanceof CredentialError?409:503).send({error:error instanceof CredentialError?error.code:'unavailable'});}
 });
}
