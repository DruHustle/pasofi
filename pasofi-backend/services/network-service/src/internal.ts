import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {Pool} from 'pg';
import {jwtVerify} from 'jose';
import {CredentialError,issueRadiusCredential,safeLoginUrl} from './credentials.js';
export {safeLoginUrl} from './credentials.js';

const id={type:'string',pattern:'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'};
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
   const rows=await pool!.query('SELECT id,site_id,site_name,client_name,login_url FROM radius_nas WHERE enabled=true ORDER BY site_name,client_name,id');
   const counts=new Map<string,number>();
   for(const row of rows.rows)counts.set(row.site_id,(counts.get(row.site_id)??0)+1);
   const sites:{id:string;name:string;loginUrl:string}[]=[],accessPoints:{nasId:string;siteId:string;siteName:string;name:string;loginUrl:string}[]=[];
   for(const row of rows.rows){
    const loginUrl=safeLoginUrl(row.login_url);if(!loginUrl)continue;
    accessPoints.push({nasId:row.id,siteId:row.site_id,siteName:row.site_name,name:row.client_name,loginUrl});
    // Older clients can select a site only when it identifies one gateway.
    if(counts.get(row.site_id)===1)sites.push({id:row.site_id,name:row.site_name,loginUrl});
   }
   return {sites,accessPoints};
  }catch{return reply.code(503).send({error:'unavailable'});}
 });
 app.post<{Body:{customerId:string;siteId:string;nasId?:string;requestKey:string;replayCredentialId?:string}}>('/internal/v1/network/credentials',{schema:{body:{type:'object',additionalProperties:false,required:['customerId','siteId','requestKey'],properties:{customerId:id,siteId:id,nasId:id,requestKey:id,replayCredentialId:id}}}},async(request,reply)=>{
  // A distinct scope is also a version gate: older network servers reject it
  // before issuance even if their validator strips the new replay-only field.
  const scope=request.body.replayCredentialId===undefined?'network:credentials':'network:credentials:replay';
  if(!await authorize(request,reply,scope))return;
  try {
   const {customerId,siteId,requestKey}=request.body;
   const prior=await pool!.query('SELECT c.nas_id,c.secret_key_version,n.site_id FROM radius_credentials c JOIN radius_nas n ON n.id=c.nas_id WHERE c.customer_id=$1 AND c.request_key=$2',[customerId,requestKey]);
   let nasId=request.body.nasId;
   if(!nasId&&prior.rowCount){
    // Recover the original owned request even if another gateway was enrolled
    // later. Never retarget a lost response to the first current registry row.
    if(prior.rows[0].site_id!==siteId.toLowerCase())throw new CredentialError('idempotency_conflict');
    nasId=prior.rows[0].nas_id;
   }
   if(!nasId){
    const candidates=await pool!.query('SELECT id FROM radius_nas WHERE site_id=$1 AND enabled=true ORDER BY id LIMIT 2',[siteId]);
    if(!candidates.rowCount)return reply.code(409).send({error:'site_unavailable'});
    if(candidates.rowCount!==1)return reply.code(409).send({error:'nas_selection_required'});
    nasId=candidates.rows[0].id;
   }
   const ring=deliveryKeys(),version=prior.rows[0]?.secret_key_version??ring.version,key=ring.keys.get(version);if(!key)throw new Error('credential_key_unavailable');
   return await issueRadiusCredential(pool!,{customerId,siteId,nasId:nasId!,requestKey,replayCredentialId:request.body.replayCredentialId},{version,key});
  }catch(error){return reply.code(error instanceof CredentialError?409:503).send({error:error instanceof CredentialError?error.code:'unavailable'});}
 });
}
