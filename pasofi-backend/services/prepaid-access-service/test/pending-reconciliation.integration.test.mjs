import {cleanupInvoiceEvidence} from './fixtures/invoices.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SignJWT} from 'jose';
import pg from 'pg';
import {buildApp} from '../dist/app.js';
import {issueGrant} from '../dist/grants.js';

const database=process.env.PAMOFI_TEST_DATABASE_URL;
test('a pending grant without Accounting-Start enters reconciliation after the stale interval',{skip:!database},async()=>{
  const secret='test_pending_reconcile_secret_32_bytes',env={DATABASE_URL:database,APP_ENV:'demo',NODE_ENV:'development',INTERNAL_RADIUS_ENABLED:'true',INTERNAL_NETWORK_SECRET:secret,PAMOFI_PAYMENTS_ENABLED:'false',PAMOFI_PESEPAY_SANDBOX_ENABLED:'false'},saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
  const pool=new pg.Pool({connectionString:database,max:2}),app=buildApp(),customer=randomUUID(),order=randomUUID(),entitlement=randomUUID(),credential=randomUUID();
  try {
    await pool.query("INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at) VALUES($1,$2,$3,'mini',50,'USD',5000,604800,'payment_confirmed',now()+interval '15 minutes')",[order,customer,randomUUID()]);
    await pool.query("INSERT INTO purchase_entitlements(id,order_id,customer_id,bundle_id,byte_limit,validity_seconds,start_by) VALUES($1,$2,$3,'mini',5000,604800,now()+interval '1 day')",[entitlement,order,customer]);
    const grant=await issueGrant(pool,customer,randomUUID(),randomUUID(),credential,`pending-${randomUUID()}`);
    const token=await new SignJWT({scope:'radius:reconcile'}).setProtectedHeader({alg:'HS256'}).setIssuer('network').setSubject('network').setAudience('prepaid-access').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(secret));
    const pending=()=>app.inject({method:'POST',url:'/internal/v1/radius/reconcile/pending',headers:{authorization:`Bearer ${token}`},payload:{}});
    const fresh=await pending();assert.equal(fresh.statusCode,200);assert.ok(!fresh.json().grants.some(row=>row.grantId===grant.id));
    await pool.query("UPDATE access_grants SET issued_at=now()-interval '4 minutes' WHERE id=$1",[grant.id]);
    const stale=await pending();assert.equal(stale.statusCode,200);assert.equal(stale.json().grants.find(row=>row.grantId===grant.id)?.credentialId,credential);
    const row=(await pool.query('SELECT state,last_accounting_at,reserved_bytes::text,deadline>now() AS current FROM access_grants WHERE id=$1',[grant.id])).rows[0];
    assert.equal(row.state,'pending');assert.equal(row.last_accounting_at,null);assert.equal(row.reserved_bytes,'5000');assert.equal(row.current,true);
  } finally {
    await app.close();await pool.query('DELETE FROM access_grants WHERE customer_id=$1',[customer]);await pool.query('DELETE FROM purchase_entitlements WHERE id=$1',[entitlement]);await cleanupInvoiceEvidence(pool,{orderIds:[order]});await pool.query('DELETE FROM purchase_orders WHERE id=$1',[order]);await pool.end();
    for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});
