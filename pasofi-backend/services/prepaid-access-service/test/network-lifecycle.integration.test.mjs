import {cleanupInvoiceEvidence} from './fixtures/invoices.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import Fastify from 'fastify';
import {issueGrant,recordAccounting,reconcileGrant,markNasRestart} from '../dist/grants.js';
import {resolveNetworkReview} from '../dist/network-admin.js';
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
  await pool.query('DELETE FROM network_operator_resolutions WHERE grant_id IN (SELECT id FROM access_grants WHERE customer_id=$1)',[customer]);
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
 const final={...evidence(),observationId:randomUUID(),observedAt:new Date(Date.now()+1).toISOString()};
 const outcomes=await Promise.all(Array.from({length:5},()=>reconcileGrant(pool,final)));
 assert.ok(outcomes.every(x=>x.closed));
 const next=await issueGrant(pool,customer,randomUUID(),randomUUID(),randomUUID(),'second');
 assert.equal(next.reserved_bytes,'9350');
 assert.notEqual(next.id,grant.id);
 assert.equal((await recordAccounting(pool,{...event,kind:'stop',upload:150n,download:500n})).state,'closed');
}));
test('a delayed Accounting-Start retry leaves metered usage intact and permits reconnection at another site',{skip:!url},async()=>fixture(async({pool,customer,event,evidence})=>{
 await recordAccounting(pool,event);
 const usage={...event,upload:300n,download:700n};
 await recordAccounting(pool,{...usage,kind:'interim'});
 const snapshot=async()=>(await pool.query(`SELECT state,accounting_anomaly,last_accounting_at::text,review_version::text
   FROM access_grants WHERE id=$1`,[event.grantId])).rows[0];
 const active=await snapshot();
 assert.deepEqual(await recordAccounting(pool,event),{state:'active',chargedBytes:'1000'});
 assert.deepEqual(await snapshot(),active);
 await recordAccounting(pool,{...usage,kind:'stop'});
 const stopped=await snapshot();
 assert.deepEqual(await recordAccounting(pool,event),{state:'uncertain',chargedBytes:'1000'});
 assert.deepEqual(await snapshot(),stopped);
 assert.equal((await reconcileGrant(pool,evidence())).closed,true);
 const next=await issueGrant(pool,customer,randomUUID(),randomUUID(),randomUUID(),'next-site-session');
 assert.equal(next.reserved_bytes,'9000');
}));
test('an acknowledged observation can be retried after the freshness window without applying it again',{skip:!url},async t=>fixture(async({pool,event,evidence})=>{
 await recordAccounting(pool,event);
 await recordAccounting(pool,{...event,kind:'stop'});
 const proof=evidence();
 assert.equal((await reconcileGrant(pool,proof)).closed,true);
 const future=Date.parse(proof.observedAt)+120000;
 t.mock.method(Date,'now',()=>future);
 assert.deepEqual(await reconcileGrant(pool,proof),{state:'closed',closed:true});
 await assert.rejects(reconcileGrant(pool,{...proof,absent:false}),{code:'evidence_conflict'});
 await assert.rejects(reconcileGrant(pool,{...proof,observationId:randomUUID()}),{code:'invalid_evidence_time'});
 const rows=await pool.query("SELECT count(*)::int AS count FROM grant_reconciliation_events WHERE grant_id=$1 AND kind IN ('absent','closed')",[event.grantId]);
 assert.equal(rows.rows[0].count,2);
}));
test('a delayed absence cannot close a grant after a newer positive router sighting',{skip:!url},async()=>fixture(async({pool,event,evidence,customer})=>{
 await recordAccounting(pool,event);
 await recordAccounting(pool,{...event,kind:'stop'});
 const seen=evidence();
 const base=Date.now();
 const stamp=offset=>new Date(base+offset).toISOString();
 assert.equal((await reconcileGrant(pool,{...seen,absent:false,observedAt:stamp(1000)})).closed,false);
 for(const offset of [0,1000]) {
  await assert.rejects(reconcileGrant(pool,{...seen,observationId:randomUUID(),observedAt:stamp(offset)}),{code:'superseded_observation'});
 }
 await assert.rejects(issueGrant(pool,customer,randomUUID(),randomUUID(),randomUUID(),'overlapping'),{code:'session_pending_or_active'});
 assert.equal((await reconcileGrant(pool,{...seen,observationId:randomUUID(),observedAt:stamp(2000)})).closed,true);
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
test('closed grant rejects later router presence while preserving older absence evidence',{skip:!url},async()=>fixture(async({pool,customer,event,evidence,grant})=>{
 await recordAccounting(pool,event);
 await recordAccounting(pool,{...event,kind:'stop'});
 const original=evidence(),time=Date.parse(original.observedAt);
 const final={...original,observedAt:new Date(time+2000).toISOString()};
 assert.equal((await reconcileGrant(pool,final)).closed,true);
 const next=await issueGrant(pool,customer,randomUUID(),randomUUID(),randomUUID(),'next');
 // A delayed older absence or presence must not erase the final proof or
 // unnecessarily hold a customer whose router was already known to be absent.
 assert.equal((await reconcileGrant(pool,{...original,observationId:randomUUID()})).closed,true);
 assert.equal((await reconcileGrant(pool,{...original,observationId:randomUUID(),absent:false})).closed,true);
 const saved=(await pool.query('SELECT absent_verified_at,accounting_anomaly FROM access_grants WHERE id=$1',[grant.id])).rows[0];
 assert.equal(saved.absent_verified_at.getTime(),time+2000);
 assert.equal(saved.accounting_anomaly,false);
 // A *newer* sighting of that same fenced session contradicts closure,
 // even with zero new bytes, so the customer and newer grant are frozen.
 const sighting={...original,observationId:randomUUID(),absent:false,observedAt:new Date(time+3000).toISOString()};
 assert.deepEqual(await reconcileGrant(pool,sighting),{state:'uncertain',closed:false,reviewRequired:true});
 assert.deepEqual(await reconcileGrant(pool,sighting),{state:'uncertain',closed:false,reviewRequired:true});
 const hold=await pool.query('SELECT reason FROM network_account_holds WHERE customer_id=$1',[customer]);
 assert.equal(hold.rows[0].reason,'session_present_after_closure');
 assert.equal((await pool.query('SELECT state,accounting_anomaly FROM access_grants WHERE id=$1',[next.id])).rows[0].state,'uncertain');
 await assert.rejects(issueGrant(pool,customer,randomUUID(),randomUUID(),randomUUID(),'another'),{code:'accounting_review_required'});
}));
test('a later router sighting reopens its closed grant even when another account hold already exists',{skip:!url},async()=>fixture(async({pool,customer,event,evidence,grant})=>{
 await recordAccounting(pool,event);
 await recordAccounting(pool,{...event,kind:'stop'});
 const proof=evidence();
 assert.equal((await reconcileGrant(pool,proof)).closed,true);
 const other=await issueGrant(pool,customer,randomUUID(),randomUUID(),randomUUID(),'other-session');
 await pool.query("INSERT INTO network_account_holds(customer_id,grant_id,reason) VALUES($1,$2,'existing_operator_review')",[customer,other.id]);
 const sighting={...proof,observationId:randomUUID(),absent:false,observedAt:new Date(Date.parse(proof.observedAt)+1000).toISOString()};
 assert.deepEqual(await reconcileGrant(pool,sighting),{state:'uncertain',closed:false,reviewRequired:true});
 const reopened=(await pool.query('SELECT state,disconnect_requested_at,closed_at FROM access_grants WHERE id=$1',[grant.id])).rows[0];
 assert.equal(reopened.state,'uncertain');
 assert.ok(reopened.disconnect_requested_at,'the disconnect worker must retry this exact router session');
 assert.equal(reopened.closed_at,null);
 const hold=(await pool.query('SELECT grant_id,reason FROM network_account_holds WHERE customer_id=$1',[customer])).rows[0];
 assert.equal(hold.grant_id,other.id,'the pre-existing account hold remains intact');
 const pending=await pool.query("SELECT id FROM access_grants WHERE (state<>'closed' AND disconnect_requested_at IS NOT NULL) OR id IN (SELECT grant_id FROM network_account_holds)");
 assert.ok(pending.rows.some(row=>row.id===grant.id),'the reopened grant is visible to the reconciliation worker');
 const uncertain=await pool.query("SELECT id FROM access_grants WHERE customer_id=$1 AND state='uncertain'",[customer]);
 assert.deepEqual(new Set(uncertain.rows.map(row=>row.id)),new Set([grant.id,other.id]),'both independently observed sessions remain fenced and reconcilable');
}));
test('operator review requires a fresh absence after a closed session is seen again',{skip:!url},async()=>fixture(async({pool,grant,event,evidence})=>{
 await recordAccounting(pool,event);
 await recordAccounting(pool,{...event,kind:'stop'});
 const proof=evidence(),time=Date.parse(proof.observedAt);
 await reconcileGrant(pool,proof);
 await reconcileGrant(pool,{...proof,observationId:randomUUID(),absent:false,observedAt:new Date(time+1000).toISOString()});
 const resolve=async()=>{
  const row=(await pool.query('SELECT review_version::text AS version FROM access_grants WHERE id=$1',[grant.id])).rows[0];
  return resolveNetworkReview(pool,grant.id,randomUUID(),randomUUID(),{
   expectedVersion:row.version,finalUpload:'0',finalDownload:'0',reason:'Verify final session counters',evidenceReference:'fixture-router-observation'
  });
 };
 await assert.rejects(resolve(),{code:'fresh_independent_absence_required'});
 await reconcileGrant(pool,{...proof,observationId:randomUUID(),observedAt:new Date(time+2000).toISOString()});
 assert.equal((await resolve()).state,'closed');
}));
test('late accounting reopens its exact closed grant despite a pre-existing hold on another session',{skip:!url},async()=>fixture(async({pool,customer,event,evidence,grant})=>{
 await recordAccounting(pool,event);
 await recordAccounting(pool,{...event,kind:'stop',upload:100n,download:0n});
 assert.equal((await reconcileGrant(pool,evidence())).closed,true);
 const other=await issueGrant(pool,customer,randomUUID(),randomUUID(),randomUUID(),'second-session');
 await pool.query("UPDATE access_grants SET state='uncertain',disconnect_requested_at=now() WHERE id=$1",[other.id]);
 await pool.query("INSERT INTO network_account_holds(customer_id,grant_id,reason) VALUES($1,$2,'existing_operator_review')",[customer,other.id]);
 assert.equal((await recordAccounting(pool,{...event,kind:'interim',upload:200n,download:0n})).state,'uncertain');
 const reopened=(await pool.query('SELECT state,disconnect_requested_at,closed_at,absent_verified_at FROM access_grants WHERE id=$1',[grant.id])).rows[0];
 assert.equal(reopened.state,'uncertain');
 assert.ok(reopened.disconnect_requested_at);
 assert.equal(reopened.closed_at,null);
 assert.equal(reopened.absent_verified_at,null);
 const hold=(await pool.query('SELECT grant_id FROM network_account_holds WHERE customer_id=$1',[customer])).rows[0];
 assert.equal(hold.grant_id,other.id,'the original account hold remains attached to its first incident');
 const pending=await pool.query("SELECT id FROM access_grants WHERE (state<>'closed' AND disconnect_requested_at IS NOT NULL) OR id IN (SELECT grant_id FROM network_account_holds)");
 assert.ok(pending.rows.some(row=>row.id===grant.id),'the late-usage grant is visible to the router disconnect worker');
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
