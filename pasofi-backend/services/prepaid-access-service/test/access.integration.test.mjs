import {cleanupInvoiceEvidence} from './fixtures/invoices.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../dist/app.js';

const url=process.env.PAMOFI_TEST_DATABASE_URL;

test('access pagination shows active access and the FIFO queue ahead of old history',{skip:!url},async(t)=>{
 const pool=new pg.Pool({connectionString:url,max:4}),customer=randomUUID(),other=randomUUID();
 const oldIds=Array.from({length:102},()=>randomUUID()),active=randomUUID(),queuedFirst=randomUUID(),queuedSecond=randomUUID(),foreign=randomUUID();
 const ids=[...oldIds,active,queuedFirst,queuedSecond,foreign];
 const env={DATABASE_URL:url,APP_ENV:'demo',NODE_ENV:'development',IDENTITY_URL:'http://identity.test',INTERNAL_IDENTITY_SECRET:'test_only_identity_secret_of_at_least_32_bytes',PAMOFI_PAYMENTS_ENABLED:'false',PAMOFI_PESEPAY_SANDBOX_ENABLED:'false'};
 const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
 Object.assign(process.env,env);
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({customerId:customer}),{headers:{'content-type':'application/json'}}));
 let app;
 try {
  await pool.query(`INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at)
    SELECT id,$2,id::text,'flex',100,'USD',5000000000,604800,'payment_confirmed',now()+interval '15 minutes' FROM unnest($1::uuid[]) AS id`,[ids,customer]);
  await pool.query('UPDATE purchase_orders SET customer_id=$2 WHERE id=$1',[foreign,other]);
  await pool.query(`INSERT INTO purchase_entitlements(id,order_id,customer_id,bundle_id,byte_limit,validity_seconds,purchased_at,start_by,activated_at)
    SELECT id,id,$2,'flex',5000000000,604800,now()-interval '60 days',now()-interval '30 days',now()-interval '60 days' FROM unnest($1::uuid[]) AS id`,[oldIds,customer]);
  for(const [id,age,activated,owner] of [[active,3,true,customer],[queuedFirst,2,false,customer],[queuedSecond,1,false,customer],[foreign,0,false,other]]) {
   await pool.query(`INSERT INTO purchase_entitlements(id,order_id,customer_id,bundle_id,byte_limit,validity_seconds,purchased_at,start_by,activated_at)
    VALUES($1,$1,$2,'flex',5000000000,604800,now()-make_interval(days=>$3),now()+interval '30 days',CASE WHEN $4 THEN now()-interval '1 hour' ELSE NULL END)`,[id,owner,age,activated]);
  }
  app=buildApp();
  const first=await app.inject({url:'/v1/access'});
  assert.equal(first.statusCode,200);
  assert.deepEqual(first.json().entitlements.slice(0,3).map(e=>e.id),[active,queuedFirst,queuedSecond]);
  assert.equal(first.headers['cache-control'],'no-store');
  assert.equal(first.json().entitlements.length,100);
  assert.equal(first.json().hasMore,true);
  assert.equal(first.json().nextOffset,100);
  assert.ok(first.json().entitlements.every(e=>e.id!==foreign));
  const last=await app.inject({url:'/v1/access?offset=100&limit=100'});
  assert.equal(last.statusCode,200);
  assert.equal(last.json().entitlements.length,5);
  assert.equal(last.json().hasMore,false);
  assert.equal(last.json().nextOffset,null);
  assert.equal(new Set([...first.json().entitlements,...last.json().entitlements].map(e=>e.id)).size,105);
  const short=await app.inject({url:'/v1/access?limit=2'});
  assert.deepEqual(short.json().entitlements.map(e=>e.id),[active,queuedFirst]);
  assert.equal(short.json().nextOffset,2);
  for(const query of ['limit=0','limit=101','offset=-1','offset=1000001','limit=no','offset=1.5']) {
   assert.equal((await app.inject({url:`/v1/access?${query}`})).statusCode,400,query);
  }
 } finally {
  if(app)await app.close();
  for(const [key,value] of Object.entries(saved)) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await pool.query('DELETE FROM purchase_entitlements WHERE id=ANY($1::uuid[])',[ids]);
  await cleanupInvoiceEvidence(pool,{orderIds:ids});await pool.query('DELETE FROM purchase_orders WHERE id=ANY($1::uuid[])',[ids]);
  await pool.end();
 }
});


test('a terminated idle database connection does not crash the service',{skip:!url},async()=>{
 const control=new pg.Pool({connectionString:url,max:1});
 const keys=['DATABASE_URL','PAMOFI_PAYMENTS_ENABLED','PAMOFI_PESEPAY_SANDBOX_ENABLED'],saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 const applicationName=`pamofi-prepaid-recovery-${randomUUID()}`,connection=new URL(url);
 connection.searchParams.set('application_name',applicationName);
 process.env.DATABASE_URL=connection.toString();
 // This case measures one idle health connection, independently of an outer
 // browser/demo environment that may enable provider reconciliation workers.
 process.env.PAMOFI_PAYMENTS_ENABLED='false';
 process.env.PAMOFI_PESEPAY_SANDBOX_ENABLED='false';
 const app=buildApp();
 try {
  assert.equal((await app.inject({url:'/health/ready'})).statusCode,200);
  const terminated=await control.query(`SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity
    WHERE datname=current_database() AND application_name=$1 AND pid<>pg_backend_pid()`,[applicationName]);
  assert.equal(terminated.rowCount,1);
  assert.equal(terminated.rows[0].stopped,true);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal((await app.inject({url:'/health/live'})).statusCode,200);
  assert.equal((await app.inject({url:'/health/ready'})).statusCode,200);
 } finally {
  await app.close();await control.end();
  for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
});
