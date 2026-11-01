import { randomInt, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { Pool } from 'pg';
type Config = { endpoint:string; secret:string; demo:boolean };
export async function dispatchOnce(pool:Pool, config:Config):Promise<'idle'|'delivered'|'retry'|'dead'|'lease_lost'> {
 const target=new URL(config.endpoint);
 if(target.username || target.password || target.search || target.hash || target.pathname!=='/' ||
   (config.demo ? !['http:','https:'].includes(target.protocol) : target.protocol!=='https:') ||
   Buffer.byteLength(config.secret)<32 || (!config.demo && config.secret.startsWith('DEMO_ONLY_'))) throw new Error('invalid_event_configuration');
 const lease=randomUUID();
 // One statement claims an event and releases the row lock before HTTP begins.
 const claimed=await pool.query(`UPDATE event_outbox SET lease_token=$1,lease_until=now()+interval '15 seconds',attempts=attempts+1
   WHERE id=(SELECT id FROM event_outbox WHERE status='pending' AND next_at<=now() AND (lease_until IS NULL OR lease_until<now())
             ORDER BY occurred_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
   RETURNING id,event_type,event_version,aggregate_id,aggregate_version,occurred_at,correlation_id,payload,attempts`,[lease]);
 if(!claimed.rowCount) return 'idle';
 const row=claimed.rows[0];
 let delivered=false;
 try {
  const token=await new SignJWT({scope:'event:deliver'}).setProtectedHeader({alg:'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('notification').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(config.secret));
  const event={id:row.id,type:row.event_type,version:row.event_version,producer:'prepaid-access',aggregateId:row.aggregate_id,aggregateVersion:row.aggregate_version,occurredAt:row.occurred_at.toISOString(),correlationId:row.correlation_id,payload:row.payload};
  const response=await fetch(new URL('/internal/v1/events',target),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(event),signal:AbortSignal.timeout(3000),redirect:'error'});
  if(response.ok && response.headers.get('content-type')?.toLowerCase().startsWith('application/json') && response.body) {
    const reader=response.body.getReader(); let size=0; const chunks:Uint8Array[]=[];
    while(true) { const part=await reader.read(); if(part.done) break; size+=part.value.length; if(size>1024){await reader.cancel();throw new Error('response_too_large');} chunks.push(part.value); }
    const result:unknown=JSON.parse(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk))).toString('utf8'));
    delivered=typeof result==='object' && result!==null && 'accepted' in result && result.accepted===true;
  }
 } catch { delivered=false; }
 if(delivered){
  const updated=await pool.query("UPDATE event_outbox SET status='delivered',dispatched_at=now(),lease_until=NULL,lease_token=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2 RETURNING id",[row.id,lease]);
  return updated.rowCount?'delivered':'lease_lost';
 }
 const dead=row.attempts>=10;
 const delay=Math.min(300,2**Math.min(row.attempts,8))+randomInt(0,4);
 const updated=await pool.query("UPDATE event_outbox SET status=$3,next_at=now()+make_interval(secs=>$4),lease_until=NULL,lease_token=NULL,last_error='delivery_failed' WHERE id=$1 AND lease_token=$2 RETURNING id",[row.id,lease,dead?'dead':'pending',delay]);
 return updated.rowCount?(dead?'dead':'retry'):'lease_lost';
}
// Caller must authorize the staff member and reason. No public replay endpoint is exposed.
export async function replayDeadLetter(pool:Pool,id:string,actorId:string,reason:string):Promise<boolean> {
 if(reason.trim().length<10 || reason.length>500) throw new Error('reason_required');
 const client=await pool.connect();
 try {
  await client.query('BEGIN');
  const row=await client.query("UPDATE event_outbox SET status='pending',attempts=0,next_at=now(),lease_until=NULL,lease_token=NULL,last_error=NULL WHERE id=$1 AND status='dead' RETURNING id",[id]);
  if(row.rowCount) await client.query('INSERT INTO outbox_replay_audit (id,event_id,actor_id,reason) VALUES ($1,$2,$3,$4)',[randomUUID(),id,actorId,reason.trim()]);
  await client.query('COMMIT');return !!row.rowCount;
 } catch(error){await client.query('ROLLBACK');throw error;} finally{client.release();}
}
