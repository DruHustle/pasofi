import {randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import type {Pool} from 'pg';
import {configuredRouters} from './routeros.js';

export function startReconciler(pool:Pool) {
 const routers=configuredRouters(),secret=process.env.INTERNAL_NETWORK_SECRET||'',base=new URL(process.env.PREPAID_URL||'');
 const demo=process.env.APP_ENV==='demo'&&process.env.NODE_ENV==='development';
 if(Buffer.byteLength(secret)<32||(base.protocol!=='https:'&&!(demo&&base.protocol==='http:'))||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw new Error('invalid_network_reconciler_configuration');
 const controller=new AbortController();let stopping=false,timer:NodeJS.Timeout|undefined,running:Promise<void>|undefined;
 async function ledger(path:string,body:unknown){
  const token=await new SignJWT({scope:'radius:reconcile'}).setProtectedHeader({alg:'HS256'}).setIssuer('network').setSubject('network').setAudience('prepaid-access').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(secret));
  const result=await fetch(new URL(path,base),{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(5000)])});
  if(!result.ok)throw new Error('ledger_unavailable');return result.json() as Promise<Record<string,unknown>>;
 }
 async function tick(){
  try {
   const result=await ledger('/internal/v1/radius/reconcile/pending',{});
   if(!Array.isArray(result.grants)||result.grants.length>50)throw new Error('invalid_reconciliation_batch');
   for(const grant of result.grants){
    if(stopping)break;
    const router=routers.get(grant.nasId);if(!router)continue;
    try {
     // Fence reauthentication before removing an existing router session.
     const rows=await pool.query(`UPDATE radius_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND nas_id=$2 RETURNING username,revoked_at`,[grant.credentialId,grant.nasId]);
     if(rows.rowCount!==1)continue;
     const evidence=await router.disconnect(rows.rows[0].username,controller.signal);
     await ledger('/internal/v1/radius/reconcile',{grantId:grant.grantId,siteId:grant.siteId,nasId:grant.nasId,generation:grant.generation,sessionId:grant.sessionId,observationId:randomUUID(),credentialRevokedAt:rows.rows[0].revoked_at.toISOString(),...evidence});
     await pool.query(`INSERT INTO router_reconciliation_status(grant_id,nas_id,generation,session_id,result) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(grant_id) DO UPDATE SET result=EXCLUDED.result,observed_at=now()`,[grant.grantId,grant.nasId,grant.generation,grant.sessionId,evidence.absent?'absent':'present']);
    }catch{
     // Never log router credentials, raw provider responses or customer secrets.
     await pool.query(`INSERT INTO router_reconciliation_status(grant_id,nas_id,generation,session_id,result) VALUES($1,$2,$3,$4,'unavailable')
      ON CONFLICT(grant_id) DO UPDATE SET result='unavailable',observed_at=now()`,[grant.grantId,grant.nasId,grant.generation,grant.sessionId]).catch(()=>{});
    }
   }
  }catch{if(!stopping)console.error('network reconciliation temporarily unavailable');}
 }
 function schedule(){if(stopping)return;running=tick().finally(()=>{if(!stopping){timer=setTimeout(schedule,10000);timer.unref();}});}
 schedule();
 return async()=>{stopping=true;clearTimeout(timer);controller.abort();await running;};
}
