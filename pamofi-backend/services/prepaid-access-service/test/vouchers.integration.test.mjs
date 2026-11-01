import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { sellVoucher, redeemVoucher, replaceVoucher } from '../dist/vouchers.js';
const url=process.env.PAMOFI_TEST_DATABASE_URL;
test('agent stock, issuance, redemption and replacement races preserve value', {skip:!url}, async () => {
 const pool=new pg.Pool({connectionString:url,max:10});
 const agent=randomUUID(), site=randomUUID(), request=randomUUID(), customer=randomUUID(), other=randomUUID(), key=randomBytes(32);
 let saleId, extraSaleId;
 try {
  await pool.query("INSERT INTO agent_inventory(agent_id,bundle_id,quantity) VALUES ($1,'mini',2)",[agent]);
  const attempts=await Promise.all(Array.from({length:6},()=>sellVoucher(pool,agent,site,'mini',request,key)));
  assert.equal(new Set(attempts.map(a=>a.saleId)).size,1);
  assert.equal(new Set(attempts.map(a=>a.code)).size,1);
  saleId=attempts[0].saleId;
  const inventory=await pool.query("SELECT quantity FROM agent_inventory WHERE agent_id=$1 AND bundle_id='mini'",[agent]);
  assert.equal(inventory.rows[0].quantity,1);
  const stockRace=await Promise.allSettled([sellVoucher(pool,agent,site,'mini',randomUUID(),key),sellVoucher(pool,agent,site,'mini',randomUUID(),key)]);
  assert.equal(stockRace.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(stockRace.filter(r=>r.status==='rejected' && r.reason.code==='out_of_stock').length,1);
  extraSaleId=stockRace.find(r=>r.status==='fulfilled').value.saleId;
  await assert.rejects(sellVoucher(pool,agent,randomUUID(),'mini',request,key),{code:'idempotency_conflict'});
  const outbox=await pool.query('SELECT payload FROM event_outbox WHERE aggregate_id=$1',[saleId]);
  assert.equal(outbox.rowCount,1);
  assert.ok(!JSON.stringify(outbox.rows).includes(attempts[0].code));
  const race=await Promise.allSettled([redeemVoucher(pool,customer,attempts[0].code),replaceVoucher(pool,saleId,key)]);
  const states=await pool.query("SELECT state,count(*)::int AS n FROM issued_vouchers WHERE sale_id=$1 GROUP BY state",[saleId]);
  assert.equal(states.rows.filter(r=>['valid','redeemed'].includes(r.state)).reduce((n,r)=>n+r.n,0),1);
  const fulfilled=race.filter(r=>r.status==='fulfilled');
  assert.equal(fulfilled.length,1);
  if(race[0].status==='fulfilled') {
    const repeated=await redeemVoucher(pool,customer,attempts[0].code);
    assert.equal(repeated.entitlementId,race[0].value.entitlementId);
    await assert.rejects(redeemVoucher(pool,other,attempts[0].code),{code:'invalid_or_used'});
  } else {
    assert.equal(race[0].reason.code,'invalid_or_used');
    const replacement=race[1].value;
    const redeemed=await redeemVoucher(pool,customer,replacement.code);
    const repeated=await redeemVoucher(pool,customer,replacement.code);
    assert.equal(redeemed.entitlementId,repeated.entitlementId);
    await assert.rejects(redeemVoucher(pool,other,replacement.code),{code:'invalid_or_used'});
  }
  const entitlements=await pool.query('SELECT * FROM purchase_entitlements WHERE customer_id IN ($1,$2)',[customer,other]);
  assert.equal(entitlements.rowCount,1);
  assert.equal(entitlements.rows[0].activated_at,null);
  assert.equal(entitlements.rows[0].byte_limit,'2000000000');
  const sold=await pool.query('SELECT price_minor,start_by FROM agent_sales WHERE id=$1',[saleId]);
  assert.equal(sold.rows[0].price_minor,50);
  assert.equal(entitlements.rows[0].start_by.getTime(),sold.rows[0].start_by.getTime());
 } finally {
  await pool.query('DELETE FROM purchase_entitlements WHERE customer_id IN ($1,$2)',[customer,other]);
  for(const id of [saleId,extraSaleId].filter(Boolean)){await pool.query('DELETE FROM event_outbox WHERE aggregate_id=$1',[id]);await pool.query('UPDATE issued_vouchers SET parent_id=NULL WHERE sale_id=$1',[id]);await pool.query('DELETE FROM issued_vouchers WHERE sale_id=$1',[id]);await pool.query('DELETE FROM agent_sales WHERE id=$1',[id]);}
  await pool.query('DELETE FROM agent_inventory WHERE agent_id=$1',[agent]);
  await pool.end();
 }
});
