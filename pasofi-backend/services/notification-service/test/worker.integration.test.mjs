import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {SignJWT,jwtVerify} from 'jose';
import pg from 'pg';
import {buildApp} from '../dist/app.js';
import {processDelivery,deliveryConfiguration} from '../dist/worker.js';
const url=process.env.PAMOFI_TEST_DATABASE_URL;
const secret='test_delivery_secret_at_least_32_bytes';
async function token(scope){return new SignJWT({scope}).setProtectedHeader({alg:'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('notification').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(secret));}
async function fixture(pool,reference){const event=randomUUID(),job=randomUUID();await pool.query("INSERT INTO event_inbox(id,producer,event_type,aggregate_id,aggregate_version,payload_hash) VALUES($1,'test','test',$2,1,$3)",[event,reference,randomBytes(32)]);await pool.query("INSERT INTO delivery_jobs(id,event_id,delivery_reference,state) VALUES($1,$2,$3,'awaiting_delivery_details')",[job,event,reference]);return {event,job};}
async function cleanup(pool,reference){const jobs=(await pool.query('SELECT id,event_id FROM delivery_jobs WHERE delivery_reference=$1',[reference])).rows;await pool.query('DELETE FROM delivery_resend_requests WHERE delivery_reference=$1',[reference]);for(const j of jobs){await pool.query('DELETE FROM delivery_attempts WHERE job_id=$1',[j.id]);await pool.query('DELETE FROM delivery_jobs WHERE id=$1',[j.id]);await pool.query('DELETE FROM event_inbox WHERE id=$1',[j.event_id]);}}
test('secure delivery lookup sends one mock SMS and authorized idempotent resends preserve its voucher',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:8}),reference=randomUUID(),message={to:'263771000000',from:'Pasofi',message:'Pasofi voucher ABCD-EFGH-JKLM-NPQR. Keep private.'};let lookups=0;
 const source=createServer(async(req,res)=>{try{const {payload}=await jwtVerify((req.headers.authorization??'').replace(/^Bearer /,''),new TextEncoder().encode(secret),{issuer:'notification',subject:'notification',audience:'prepaid-access',algorithms:['HS256']});assert.equal(payload.scope,'delivery:read');assert.equal(req.url,`/internal/v1/deliveries/${reference}`);lookups++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({deliveryReference:reference,saleId:reference,channel:'sms',simulation:true,...message}));}catch{res.writeHead(401);res.end('{}');}});await new Promise(resolve=>source.listen(0,'127.0.0.1',resolve));
 const env={DATABASE_URL:url,APP_ENV:'demo',NODE_ENV:'development',DELIVERY_WORKER_ENABLED:'true',DELIVERY_WORKER_AUTOSTART:'false',NOTIFICATION_DELIVERY_MODE:'mock',INTERNAL_DELIVERY_SECRET:secret,PREPAID_URL:`http://127.0.0.1:${source.address().port}`},saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);const app=buildApp();
 try{
  const f=await fixture(pool,reference);const runs=await Promise.all(Array.from({length:6},()=>processDelivery(pool,true)));assert.equal(runs.filter(Boolean).length,1);assert.equal(lookups,1);
  assert.equal((await pool.query('SELECT state FROM delivery_jobs WHERE id=$1',[f.job])).rows[0].state,'delivered');
  const mock=(await pool.query('SELECT message_hash,recipient_last4 FROM mock_sms_sink WHERE job_id=$1',[f.job])).rows[0];assert.ok(mock.message_hash.equals(createHash('sha256').update(JSON.stringify(message)).digest()));assert.equal(mock.recipient_last4,'0000');
  assert.equal((await app.inject({url:`/internal/v1/deliveries/${reference}/status`})).statusCode,401);
  const wrong=await token('delivery:read');assert.equal((await app.inject({url:`/internal/v1/deliveries/${reference}/status`,headers:{authorization:`Bearer ${wrong}`}})).statusCode,403);
  const status=await app.inject({url:`/internal/v1/deliveries/${reference}/status`,headers:{authorization:`Bearer ${await token('delivery:status')}`}});assert.equal(status.json().state,'delivered');assert.equal(status.json().simulation,true);assert.ok(!status.body.includes(message.message));assert.equal(status.headers['cache-control'],'no-store');
  const request={requestId:randomUUID(),actorId:randomUUID(),reason:'Customer requested another copy'},headers={authorization:`Bearer ${await token('delivery:resend')}`};
  const replies=await Promise.all(Array.from({length:5},()=>app.inject({method:'POST',url:`/internal/v1/deliveries/${reference}/resend`,headers,payload:request})));assert.ok(replies.every(r=>[200,201].includes(r.statusCode)));const job=replies[0].json().jobId;assert.equal(new Set(replies.map(r=>r.json().jobId)).size,1);
  assert.equal((await app.inject({method:'POST',url:`/internal/v1/deliveries/${reference}/resend`,headers,payload:{...request,requestId:randomUUID()}})).statusCode,409);
  assert.equal(await processDelivery(pool,true),true);assert.equal(lookups,2);const second=(await pool.query('SELECT message_hash FROM mock_sms_sink WHERE job_id=$1',[job])).rows[0];assert.ok(second.message_hash.equals(mock.message_hash));
  await pool.query("UPDATE delivery_jobs SET state='unknown',next_at=now() WHERE id=$1",[job]);await pool.query("UPDATE delivery_attempts SET state='unknown',provider_id=NULL WHERE job_id=$1",[job]);
  assert.equal(await processDelivery(pool,true),true);assert.equal(lookups,2);assert.equal((await pool.query('SELECT last_error FROM delivery_jobs WHERE id=$1',[job])).rows[0].last_error,'manual_review_required');
  assert.equal((await app.inject({method:'POST',url:`/internal/v1/deliveries/${reference}/resend`,headers,payload:{...request,requestId:randomUUID()}})).json().error,'delivery_unresolved');
 }finally{await app.close();await new Promise(resolve=>source.close(resolve));await cleanup(pool,reference);await pool.end();for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
test('provider delivery is disabled by default and demo settings cannot activate live Sendai',()=>{const keys=['DELIVERY_WORKER_ENABLED','NOTIFICATION_DELIVERY_MODE','SENDAI_LIVE_ENABLED','SENDAI_QUALIFIED','SENDAI_API_KEY','APP_ENV','NODE_ENV'],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));try{for(const k of keys)delete process.env[k];assert.equal(deliveryConfiguration(true).enabled,false);Object.assign(process.env,{DELIVERY_WORKER_ENABLED:'true',NOTIFICATION_DELIVERY_MODE:'sendai',SENDAI_LIVE_ENABLED:'true',SENDAI_QUALIFIED:'true',SENDAI_API_KEY:'synthetic',APP_ENV:'demo',NODE_ENV:'development'});assert.equal(deliveryConfiguration(true).enabled,false);}finally{for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}});
