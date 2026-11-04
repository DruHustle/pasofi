import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { issueGrant, recordAccounting } from '../dist/grants.js';
const url=process.env.PAMOFI_TEST_DATABASE_URL;
test('global grant reservation, duplicate accounting and uncertain stop fail closed', {skip:!url}, async () => {
  const pool=new pg.Pool({connectionString:url,max:8});
  const customer=randomUUID(), order=randomUUID(), entitlement=randomUUID(), siteA=randomUUID(), siteB=randomUUID(), nasA=randomUUID(), nasB=randomUUID(), keyA=randomUUID(), keyB=randomUUID();
  try {
    await pool.query(`INSERT INTO purchase_orders (id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at)
      VALUES ($1,$2,$3,'flex',100,'USD',5000000000,604800,'payment_confirmed',now()+interval '15 minutes')`,[order,customer,randomUUID()]);
    await pool.query(`INSERT INTO purchase_entitlements (id,order_id,customer_id,bundle_id,byte_limit,validity_seconds,start_by)
      VALUES ($1,$2,$3,'flex',5000000000,604800,now()+interval '30 days')`,[entitlement,order,customer]);
    const results=await Promise.allSettled([issueGrant(pool,customer,siteA,nasA,keyA,'lab-session-1'),issueGrant(pool,customer,siteB,nasB,keyB,'lab-session-1')]);
    const winners=results.filter(r=>r.status==='fulfilled');
    assert.equal(winners.length,1);
    assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='session_pending_or_active').length,1);
    const grant=winners[0].value;
    assert.equal(grant.reserved_bytes,'5000000000');
    const winningKey=grant.site_id===siteA?keyA:keyB;
    const replay=await issueGrant(pool,customer,grant.site_id,grant.nas_id,winningKey,'lab-session-1');
    assert.equal(replay.id,grant.id);
    assert.equal(replay.deadline.getTime(),grant.deadline.getTime());
    const repeated=await Promise.all(Array.from({length:5},()=>issueGrant(pool,customer,grant.site_id,grant.nas_id,winningKey,'lab-session-1')));
    assert.ok(repeated.every(g=>g.id===grant.id && g.deadline.getTime()===grant.deadline.getTime()));
    await assert.rejects(issueGrant(pool,customer,siteA,randomUUID(),winningKey,'lab-session-1'),{code:'idempotency_conflict'});
    await assert.rejects(issueGrant(pool,customer,grant.site_id,grant.nas_id,winningKey,'other-session'),{code:'idempotency_conflict'});
    const event={grantId:grant.id,siteId:grant.site_id,nasId:grant.nas_id,generation:grant.generation,sessionId:'lab-session-1',upload:4294967296n,download:25n,kind:'start'};
    await assert.rejects(recordAccounting(pool,{...event,kind:'interim'}),{code:'start_required'});
    await assert.rejects(recordAccounting(pool,{...event,kind:'stop'}),{code:'start_required'});
    await assert.rejects(recordAccounting(pool,{...event,sessionId:'not a valid session'}),{code:'invalid_session'});
    const started=await recordAccounting(pool,event);
    assert.equal(started.state,'active');
    assert.equal(started.chargedBytes,'4294967321');
    const duplicates=await Promise.all(Array.from({length:6},()=>recordAccounting(pool,event)));
    assert.ok(duplicates.every(row=>row.chargedBytes==='4294967321'));
    await assert.rejects(recordAccounting(pool,{...event,siteId:randomUUID()}),{code:'grant_context_mismatch'});
    await assert.rejects(recordAccounting(pool,{...event,sessionId:'another-session'}),{code:'session_mismatch'});
    await assert.rejects(recordAccounting(pool,{...event,kind:'interim',sessionId:'another-session'}),{code:'session_mismatch'});
    const late=await recordAccounting(pool,{...event,kind:'interim',upload:1n,download:1n});
    assert.equal(late.state,'uncertain');
    const stop=await recordAccounting(pool,{...event,kind:'stop'});
    assert.equal(stop.state,'uncertain');
    await assert.rejects(issueGrant(pool,customer,grant.site_id,grant.nas_id,winningKey,'lab-session-1'),{code:'grant_not_replayable'});
    await assert.rejects(issueGrant(pool,customer,siteB,nasB,randomUUID(),'other-session'),{code:'session_pending_or_active'});
    const stored=await pool.query('SELECT consumed_bytes::text,activated_at FROM purchase_entitlements WHERE id=$1',[entitlement]);
    assert.equal(stored.rows[0].consumed_bytes,'4294967321');
    assert.ok(stored.rows[0].activated_at);
  } finally {
    await pool.query('DELETE FROM access_grants WHERE customer_id=$1',[customer]);
    await pool.query('DELETE FROM purchase_entitlements WHERE id=$1',[entitlement]);
    await pool.query('DELETE FROM purchase_orders WHERE id=$1',[order]);
    await pool.end();
  }
});

test('one NAS session cannot reserve two customers, even concurrently', {skip:!url}, async () => {
  const pool=new pg.Pool({connectionString:url,max:8});
  const site=randomUUID(), nas=randomUUID(), sessionId=`session-${randomUUID()}`;
  const customers=[randomUUID(),randomUUID()], orders=[randomUUID(),randomUUID()], entitlements=[randomUUID(),randomUUID()];
  try {
    for(let i=0;i<2;i++) {
      await pool.query(`INSERT INTO purchase_orders (id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at)
        VALUES ($1,$2,$3,'flex',100,'USD',5000000000,604800,'payment_confirmed',now()+interval '15 minutes')`,[orders[i],customers[i],randomUUID()]);
      await pool.query(`INSERT INTO purchase_entitlements (id,order_id,customer_id,bundle_id,byte_limit,validity_seconds,start_by)
        VALUES ($1,$2,$3,'flex',5000000000,604800,now()+interval '30 days')`,[entitlements[i],orders[i],customers[i]]);
    }
    const results=await Promise.allSettled(customers.map(customer=>issueGrant(pool,customer,site,nas,randomUUID(),sessionId)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(results.filter(r=>r.status==='rejected' && r.reason.code==='nas_session_in_use').length,1);
    const rows=await pool.query('SELECT accounting_session_id,accounting_started_at FROM access_grants WHERE nas_id=$1',[nas]);
    assert.equal(rows.rowCount,1);assert.equal(rows.rows[0].accounting_session_id,sessionId);assert.equal(rows.rows[0].accounting_started_at,null);
  } finally {
    await pool.query('DELETE FROM access_grants WHERE customer_id=ANY($1::uuid[])',[customers]);
    await pool.query('DELETE FROM purchase_entitlements WHERE id=ANY($1::uuid[])',[entitlements]);
    await pool.query('DELETE FROM purchase_orders WHERE id=ANY($1::uuid[])',[orders]);
    await pool.end();
  }
});
