import {cleanupInvoiceEvidence} from './fixtures/invoices.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import pg from 'pg';
import { buildApp } from '../dist/app.js';
const url=process.env.PAMOFI_TEST_DATABASE_URL;
const secret='DEMO_ONLY_network_test_key_0123456789abcdef';
async function token(scope,issuer='network',expiry='15s') {
 return new SignJWT({scope}).setProtectedHeader({alg:'HS256'}).setIssuer(issuer).setSubject('network').setAudience('prepaid-access').setIssuedAt().setExpirationTime(expiry).sign(new TextEncoder().encode(secret));
}
test('lab authority requires a scoped network token and durably binds accounting', {skip:!url}, async()=>{
 const env={...process.env};Object.assign(process.env,{DATABASE_URL:url,APP_ENV:'demo',NODE_ENV:'development',INTERNAL_RADIUS_ENABLED:'true',INTERNAL_NETWORK_SECRET:secret});
 const app=buildApp(),pool=new pg.Pool({connectionString:url});
 const customer=randomUUID(),order=randomUUID(),entitlement=randomUUID(),site=randomUUID(),nas=randomUUID(),requestKey=randomUUID(),sessionId='LAB-SESSION-1';
 const grantBody={customerId:customer,siteId:site,nasId:nas,requestKey,sessionId};
 const grantToken=await token('radius:grant'),accountToken=await token('radius:account');
 const post=(url,payload,authorization)=>app.inject({method:'POST',url,payload,headers:authorization?{authorization:`Bearer ${authorization}`}:{}});
 try {
  await pool.query(`INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at) VALUES($1,$2,$3,'flex',100,'USD',5000000000,604800,'payment_confirmed',now()+interval '15 minutes')`,[order,customer,randomUUID()]);
  await pool.query(`INSERT INTO purchase_entitlements(id,order_id,customer_id,bundle_id,byte_limit,validity_seconds,start_by) VALUES($1,$2,$3,'flex',5000000000,604800,now()+interval '30 days')`,[entitlement,order,customer]);
  assert.equal((await post('/internal/v1/radius/grants',grantBody)).statusCode,401);
  assert.equal((await post('/internal/v1/radius/grants',grantBody,await token('radius:grant','forged'))).statusCode,401);
  assert.equal((await post('/internal/v1/radius/grants',grantBody,await token('radius:grant','network','-1s'))).statusCode,401);
  assert.equal((await post('/internal/v1/radius/grants',grantBody,accountToken)).statusCode,403);
  const created=await post('/internal/v1/radius/grants',grantBody,grantToken);assert.equal(created.statusCode,200);
  const grant=created.json();assert.equal(grant.reservedBytes,'5000000000');
  const replay=await post('/internal/v1/radius/grants',grantBody,grantToken);assert.equal(replay.json().grantId,grant.grantId);assert.equal(replay.json().deadline,grant.deadline);
  assert.equal((await post('/internal/v1/radius/grants',{...grantBody,sessionId:'OTHER'},grantToken)).statusCode,409);
  const event={grantId:grant.grantId,siteId:site,nasId:nas,generation:grant.generation,sessionId,kind:'start',upload:'4294967296',download:'10'};
  assert.equal((await post('/internal/v1/radius/accounting',event,grantToken)).statusCode,403);
  assert.equal((await post('/internal/v1/radius/accounting',{...event,kind:'interim'},accountToken)).statusCode,409);
  assert.equal((await post('/internal/v1/radius/accounting',{...event,sessionId:'OTHER'},accountToken)).statusCode,409);
  assert.equal((await post('/internal/v1/radius/accounting',{...event,upload:'18446744073709551616'},accountToken)).statusCode,409);
  const first=await post('/internal/v1/radius/accounting',event,accountToken);assert.equal(first.statusCode,200);assert.equal(first.json().chargedBytes,'4294967306');
  const duplicate=await post('/internal/v1/radius/accounting',event,accountToken);assert.equal(duplicate.json().chargedBytes,'4294967306');
  assert.equal((await pool.query('SELECT consumed_bytes::text FROM purchase_entitlements WHERE id=$1',[entitlement])).rows[0].consumed_bytes,'4294967306');
  process.env.APP_ENV='production';const production=buildApp();try{assert.equal((await production.inject({method:'POST',url:'/internal/v1/radius/grants',payload:grantBody,headers:{authorization:`Bearer ${grantToken}`}})).statusCode,404);}finally{await production.close();}
 }finally{
  await app.close();await pool.query('DELETE FROM access_grants WHERE customer_id=$1',[customer]);await pool.query('DELETE FROM purchase_entitlements WHERE id=$1',[entitlement]);await cleanupInvoiceEvidence(pool,{orderIds:[order]});await pool.query('DELETE FROM purchase_orders WHERE id=$1',[order]);await pool.end();
  for(const key of ['DATABASE_URL','APP_ENV','NODE_ENV','INTERNAL_RADIUS_ENABLED','INTERNAL_NETWORK_SECRET']) {if(env[key]===undefined) delete process.env[key];else process.env[key]=env[key];}
 }
});
