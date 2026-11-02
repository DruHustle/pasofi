import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

// Domain primitive only. A caller must authenticate the customer and determine
// NAS context from trusted server-side registration before invoking it.
export class CredentialError extends Error {constructor(public readonly code:string){super(code);}}
type DeliveryKey={version:number;key:Buffer};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function aad(id:string,customerId:string,nasId:string,version:number) {return Buffer.from(`pamofi-radius-credential:${id}:${customerId}:${nasId}:${version}`,'utf8');}
function encrypt(secret:string,key:DeliveryKey,associated:Buffer):Buffer {
 const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key.key,nonce);cipher.setAAD(associated);
 const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]);
}
function decrypt(data:Buffer,key:DeliveryKey,associated:Buffer):string {
 if(!Buffer.isBuffer(data)||data.length<29)throw new CredentialError('credential_unavailable');
 try {const decipher=createDecipheriv('aes-256-gcm',key.key,data.subarray(0,12));decipher.setAAD(associated);decipher.setAuthTag(data.subarray(12,28));return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8');}
 catch {throw new CredentialError('credential_unavailable');}
}
async function transaction<T>(pool:Pool,fn:(client:PoolClient)=>Promise<T>):Promise<T>{const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export async function issueRadiusCredential(pool:Pool,input:{customerId:string;nasId:string;requestKey:string},key:DeliveryKey) {
 if(!input || typeof input.customerId!=='string' || typeof input.nasId!=='string' || typeof input.requestKey!=='string' || !uuid.test(input.customerId) || !uuid.test(input.nasId) || !uuid.test(input.requestKey))throw new CredentialError('invalid_request');
 if(!key || !Number.isSafeInteger(key.version) || key.version<1 || key.version>2147483647 || !Buffer.isBuffer(key.key) || key.key.length!==32)throw new CredentialError('invalid_key');
 const customerId=input.customerId.toLowerCase(),nasId=input.nasId.toLowerCase(),requestKey=input.requestKey.toLowerCase();
 return transaction(pool,async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`radius-credential:${customerId}`]);
  const previous=await client.query(`SELECT c.id,c.username,c.nas_id,c.encrypted_secret,c.secret_key_version,c.revoked_at,c.expires_at,c.expires_at>now() AS current,n.enabled
    FROM radius_credentials c JOIN radius_nas n ON n.id=c.nas_id WHERE c.customer_id=$1 AND c.request_key=$2 FOR UPDATE OF c,n`,[customerId,requestKey]);
  if(previous.rowCount){
   const row=previous.rows[0];
   if(row.nas_id!==nasId)throw new CredentialError('idempotency_conflict');
   if(row.revoked_at || !row.current || !row.enabled)throw new CredentialError('credential_expired');
   if(row.secret_key_version!==key.version)throw new CredentialError('credential_key_unavailable');
   return {username:row.username,password:decrypt(row.encrypted_secret,key,aad(row.id,customerId,nasId,key.version)),expiresAt:row.expires_at as Date};
  }
  const nas=await client.query('SELECT id FROM radius_nas WHERE id=$1 AND enabled=true FOR SHARE',[nasId]);
  if(!nas.rowCount)throw new CredentialError('nas_unavailable');
  const recent=await client.query("SELECT count(*)::int AS total FROM radius_credentials WHERE customer_id=$1 AND created_at>now()-interval '1 minute'",[customerId]);
  if(recent.rows[0].total>=10)throw new CredentialError('credential_rate_limited');
  const id=randomUUID(),username=randomBytes(24).toString('base64url'),password=randomBytes(32).toString('base64url');
  const encrypted=encrypt(password,key,aad(id,customerId,nasId,key.version));
  const row=await client.query(`INSERT INTO radius_credentials(id,username,secret_hash,customer_id,nas_id,request_key,encrypted_secret,secret_key_version,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '2 minutes') RETURNING expires_at`,
    [id,username,createHash('sha256').update(password,'utf8').digest(),customerId,nasId,requestKey,encrypted,key.version]);
  return {username,password,expiresAt:row.rows[0].expires_at as Date};
 });
}
