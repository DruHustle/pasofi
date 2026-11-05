import {cleanupInvoiceEvidence} from './fixtures/invoices.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
import {issueGrant,recordAccounting,reconcileGrant,markNasRestart} from '../dist/grants.js';
import {registerCustomerNetwork} from '../dist/network-lifecycle.js';
const url=process.env.PAMOFI_TEST_DATABASE_URL;
async function fixture(work){
 const pool=new pg.Pool({connectionString:url,max:8}),customer=randomUUID(),order=randomUUID(),entitlement=randomUUID(),site=randomUUID(),nas=randomUUID();
 try {
  await pool.query(`INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at) VALUES($1,$2,$3,'flex',100,'USD',10000,604800,'payment_confirmed',now()+interval '1 hour')`,[order,customer,randomUUID()]);
  await pool.query(`INSERT INTO purchase_entitlements(id,order_id,customer_id,bundle_id,byte_limit,validity_seconds,start_by) VALUES($1,$2,$3,'flex',10000,604800,now()+interval '30 days')`,[entitlement,order,customer]);
  const grant=await issueGrant(pool,customer,site,nas,randomUUID(),'session-'+randomUUID());
  const row=(await pool.query('SELECT accounting_session_id FROM access_grants WHERE id=$1',[grant.id])).rows[0];
  const event={grantId:grant.id,siteId:site,nasId:nas,generation:grant.generation,sessionId:row.accounting_session_id,upload:0n,download:0n,kind:'start'};
  const evidence=()=>{const time=new Date().toISOString();return ({grantId:grant.id,siteId:site,nasId:nas,generation:grant.generation,sessionId:row.accounting_session_id,observationId:randomUUID(),observedAt:time,credentialRevokedAt:time,absent:true});};
  await work({pool,customer,site,nas,grant,event,evidence,entitlement});
 } finally {
  await pool.query('DELETE FROM network_account_holds WHERE customer_id=$1',[customer]);
  await pool.query('DELETE FROM access_grants WHERE customer_id=$1',[customer]);
  await pool.query('DELETE FROM purchase_entitlements WHERE id=$1',[entitlement]);
  await cleanupInvoiceEvidence(pool,{orderIds:[order]});await pool.query('DELETE FROM purchase_orders WHERE id=$1',[order]);await pool.end();
 }
}
test('verified final Stop plus independently fenced router absence releases exactly the remaining allowance',{skip:!url},async()=>fixture(async({pool,customer,event,evidence,grant})=>{
 await recordAccounting(pool,event);
 await recordAccounting(pool,{...event,kind:'interim',upload:123n,download:456n});
 await recordAccounting(pool,{...event,kind:'stop',upload:150n,download:500n});
 await assert.rejects(issueGrant(pool,customer,randomUUID(),randomUUID(),randomUUID(),'second'),{code:'session_pending_or_active'});
 const proof=evidence();
 assert.equal((await reconcileGrant(pool,{...proof,absent:false})).closed,false);
 const final={...evidence(),observationId:randomUUID()};
 const outcomes=await Promise.all(Array.from({length:5},()=>reconcileGrant(pool,final)));
 assert.ok(outcomes.every(x=>x.closed));
 const next=await issueGrant(pool,customer,randomUUID(),randomUUID(),randomUUID(),'second');
 assert.equal(next.reserved_bytes,'9350');
 assert.notEqual(next.id,grant.id);
 assert.equal((await recordAccounting(pool,{...event,kind:'stop',upload:150n,download:500n})).state,'closed');
}));
test('missing Stop after NAS restart and regressing counters retain the reservation',{skip:!url},async()=>fixture(async({pool,customer,site,nas,event,evidence})=>{
 await recordAccounting(pool,event);await recordAccounting(pool,{...event,kind:'interim',upload:500n,download:200n});
 assert.equal((await markNasRestart(pool,site,nas)).affected,1);
 assert.equal((await reconcileGrant(pool,evidence())).closed,false);
 await recordAccounting(pool,{...event,kind:'stop',upload:400n,download:200n});
 assert.equal((await reconcileGrant(pool,evidence())).closed,false);
 await assert.rejects(issueGrant(pool,customer,randomUUID(),randomUUID(),randomUUID(),'new'),{code:'session_pending_or_active'});
}));
test('reconciliation rejects wrong contexts and stale or future observations',{skip:!url},async()=>fixture(async({pool,event,evidence})=>{
 await recordAccounting(pool,event);await recordAccounting(pool,{...event,kind:'stop'});
 await assert.rejects(reconcileGrant(pool,{...evidence(),nasId:randomUUID()}),{code:'grant_context_mismatch'});
 await assert.rejects(reconcileGrant(pool,{...evidence(),generation:randomUUID()}),{code:'grant_context_mismatch'});
 await assert.rejects(reconcileGrant(pool,{...evidence(),observedAt:new Date(Date.now()-120000).toISOString()}),{code:'invalid_evidence_time'});
 await assert.rejects(reconcileGrant(pool,{...evidence(),observedAt:new Date(Date.now()+120000).toISOString()}),{code:'invalid_evidence_time'});
 await assert.rejects(reconcileGrant(pool,{...evidence(),credentialRevokedAt:new Date(0).toISOString()}),{code:'invalid_evidence_time'});
}));
test('contradictory traffic after closure fences a newer grant and blocks further access',{skip:!url},async()=>fixture(async({pool,customer,event,evidence})=>{
 await recordAccounting(pool,event);await recordAccounting(pool,{...event,kind:'stop',upload:100n,download:0n});
 assert.equal((await reconcileGrant(pool,evidence())).closed,true);
 const next=await issueGrant(pool,customer,randomUUID(),randomUUID(),randomUUID(),'next');
 assert.equal((await recordAccounting(pool,{...event,kind:'interim',upload:200n,download:0n})).state,'uncertain');
 assert.equal((await pool.query('SELECT state FROM access_grants WHERE id=$1',[next.id])).rows[0].state,'uncertain');
 assert.equal((await pool.query('SELECT count(*)::int n FROM network_account_holds WHERE customer_id=$1',[customer])).rows[0].n,1);
 await assert.rejects(issueGrant(pool,customer,randomUUID(),randomUUID(),randomUUID(),'another'),{code:'accounting_review_required'});
}));

test('paused network issuance still permits only the owning customer to inspect and request session termination',{skip:!url},async()=>fixture(async own=>fixture(async other=>{
 const saved=process.env.PAMOFI_CUSTOMER_NETWORK_ENABLED;
 process.env.PAMOFI_CUSTOMER_NETWORK_ENABLED='false';
 const app=Fastify(),origin='https://pasofi.example.test';
 registerCustomerNetwork(app,own.pool,false,async request=>request.headers.authorization==='owner'?own.customer:null,request=>request.headers.origin===origin);
 const send=(method,path,payload,auth='owner',requestOrigin=origin)=>app.inject({method,url:path,payload,headers:{authorization:auth,origin:requestOrigin}});
 try{
  await recordAccounting(own.pool,own.event);await recordAccounting(other.pool,other.event);
  const status=await send('GET','/v1/network/session');
  assert.equal(status.statusCode,200);assert.equal(status.json().session.id,own.grant.id);assert.equal(status.json().session.connected,true);
  assert.equal((await send('POST','/v1/network/disconnect',{grantId:own.grant.id},'unknown')).statusCode,401);
  assert.equal((await send('POST','/v1/network/disconnect',{grantId:own.grant.id},'owner','https://untrusted.example.test')).statusCode,403);
  assert.equal((await send('POST','/v1/network/disconnect',{grantId:other.grant.id})).statusCode,404);
  const untouched=(await other.pool.query('SELECT state,disconnect_requested_at FROM access_grants WHERE id=$1',[other.grant.id])).rows[0];
  assert.deepEqual(untouched,{state:'active',disconnect_requested_at:null});
  const pending=await send('POST','/v1/network/disconnect',{grantId:own.grant.id});
  assert.equal(pending.statusCode,202);assert.equal(pending.json().state,'disconnect_pending');
  const stopped=(await own.pool.query('SELECT state,disconnect_requested_at FROM access_grants WHERE id=$1',[own.grant.id])).rows[0];
  assert.equal(stopped.state,'uncertain');assert.ok(stopped.disconnect_requested_at);
  assert.equal((await send('GET','/v1/network/session')).json().session.connected,false);
  const issued=await send('POST','/v1/network/credentials',{siteId:own.site,requestKey:randomUUID()});
  assert.equal(issued.statusCode,404);assert.equal(issued.json().error,'network_disabled');
 }finally{
  await app.close();if(saved===undefined)delete process.env.PAMOFI_CUSTOMER_NETWORK_ENABLED;else process.env.PAMOFI_CUSTOMER_NETWORK_ENABLED=saved;
 }
})));
