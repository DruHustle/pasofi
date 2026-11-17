import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { seal } from '../dist/delivery-crypto.js';
import { issueGrant, networkAccessEligible } from '../dist/grants.js';
import { createEcoCashVoucher, readEcoCashDelivery, redeemVoucher } from '../dist/vouchers.js';

const url = process.env.PAMOFI_TEST_DATABASE_URL;

test('a simulated EcoCash voucher can be privately delivered and redeemed once, but cannot authorize a network grant', { skip: !url }, async () => {
  const pool = new pg.Pool({ connectionString: url });
  const key = randomBytes(32);
  const creditId = randomUUID();
  const customerId = randomUUID();
  const phone = '263770000001';
  const encrypted = seal(phone, key, `ecocash:phone:${creditId}`);
  try {
    const client = await pool.connect();
    let voucherId;
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO ecocash_credits
        (id,environment,transaction_id,merchant_code,currency,amount_minor,paid_at,
         phone_key_id,phone_iv,phone_cipher,phone_tag,bundle_id,byte_limit,validity_seconds,start_by,state)
        SELECT $1,'simulation',$2,'FIXTURE',currency,price_minor,now(),
          $3,$4,$5,$6,id,byte_limit,validity_seconds,now()+interval '30 days','issued'
        FROM bundle_versions WHERE id='mini'`, [creditId, randomUUID(), encrypted.keyId, encrypted.iv, encrypted.cipher, encrypted.tag]);
      voucherId = await createEcoCashVoucher(client, creditId, key);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    assert.equal(await readEcoCashDelivery(pool, creditId, key, false), null);
    const message = await readEcoCashDelivery(pool, creditId, key, true);
    assert.equal(message.to, phone);
    assert.equal(message.simulation, true);
    assert.equal(message.deliveryReference, creditId);
    assert.equal(message.creditId, creditId);
    assert.equal(message.saleId, undefined);
    assert.deepEqual(await readEcoCashDelivery(pool, creditId, key, true), message);
    const code = message.message.match(/[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}/)?.[0];
    assert.ok(code);
    await assert.rejects(redeemVoucher(pool, customerId, code), { code: 'invalid_or_used' });
    const results = await Promise.all(Array.from({ length: 4 }, () => redeemVoucher(pool, customerId, code, true)));
    assert.equal(results.filter(result => !result.replayed).length, 1);
    const entitlementId = results[0].entitlementId;
    assert.ok(results.every(result => result.entitlementId === entitlementId));
    assert.equal((await pool.query('SELECT id FROM purchase_entitlements WHERE source_voucher_id=$1', [voucherId])).rowCount, 1);
    await assert.rejects(readEcoCashDelivery(pool, creditId, key, true), { code: 'ecocash_delivery_closed' });
    await assert.rejects(redeemVoucher(pool, randomUUID(), code, true), { code: 'invalid_or_used' });
    await assert.rejects(redeemVoucher(pool, customerId, code, false), { code: 'invalid_or_used' });

    await assert.rejects(issueGrant(pool, customerId, randomUUID(), randomUUID(), randomUUID(), 'ecocash-fixture'), { code: 'no_usable_entitlement' });
    const existing = await pool.query(`INSERT INTO access_grants(id,customer_id,entitlement_id,site_id,nas_id,request_key,generation,
      state,reserved_bytes,deadline,accounting_session_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',1,now()+interval '5 minutes','ecocash-fixture') RETURNING *`,
      [randomUUID(), customerId, entitlementId, randomUUID(), randomUUID(), randomUUID(), randomUUID()]);
    const grant = existing.rows[0];
    assert.equal(await networkAccessEligible(pool, customerId, entitlementId, grant.id), false);
    await assert.rejects(issueGrant(pool, customerId, grant.site_id, grant.nas_id, grant.request_key, grant.accounting_session_id), { code: 'grant_not_replayable' });
  } finally {
    try {
      await pool.query('DELETE FROM access_grants WHERE customer_id=$1', [customerId]);
      await pool.query('DELETE FROM purchase_entitlements WHERE customer_id=$1', [customerId]);
      await pool.query('DELETE FROM issued_vouchers WHERE ecocash_credit_id=$1', [creditId]);
      await pool.query('DELETE FROM ecocash_credits WHERE id=$1', [creditId]);
    } finally {
      await pool.end();
    }
  }
});
