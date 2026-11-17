import { randomBytes, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { applySimulatedEcoCashCredit } from '../dist/ecocash-credits.js';
import { readEcoCashDelivery, redeemVoucher } from '../dist/vouchers.js';

const url = process.env.PAMOFI_TEST_DATABASE_URL;
const iso = ms => new Date(ms).toISOString();
const day = 86400000;

async function fixture(t) {
  const pool = new pg.Pool({connectionString: url, max: 8});
  const key = randomBytes(32);
  const merchant = 'TEST-' + randomUUID().slice(0, 8);
  const now = Date.now();
  const offer = {
    bundleId: 'eco-fixture-' + randomUUID(), amountMinor: 125, byteLimit: '2000000000', validitySeconds: 86400,
    validFrom: iso(now - 10 * day), validUntil: iso(now + day)
  };
  const config = {merchantCode: merchant, currency: 'USD', offers: [offer]};
  const observation = {
    kind: 'credit', transactionId: randomUUID(), merchantCode: merchant, currency: 'USD',
    amountMinor: 125, payerPhone: '0770000001', paidAt: iso(now - 1000)
  };
  await pool.query(`INSERT INTO bundle_versions(id,price_minor,currency,byte_limit,validity_seconds,published)
    VALUES($1,$2,'USD',$3,$4,true)`, [offer.bundleId, offer.amountMinor, offer.byteLimit, offer.validitySeconds]);
  t.after(async () => {
    try {
      const credits = (await pool.query('SELECT id FROM ecocash_credits WHERE merchant_code=$1', [merchant])).rows.map(r => r.id);
      const vouchers = (await pool.query('SELECT id FROM issued_vouchers WHERE ecocash_credit_id=ANY($1::uuid[])', [credits])).rows.map(r => r.id);
      const entitlements = (await pool.query('SELECT id FROM purchase_entitlements WHERE source_voucher_id=ANY($1::uuid[])', [vouchers])).rows.map(r => r.id);
      await pool.query('DELETE FROM network_account_holds WHERE grant_id IN (SELECT id FROM access_grants WHERE entitlement_id=ANY($1::uuid[]))', [entitlements]);
      await pool.query('DELETE FROM access_grants WHERE entitlement_id=ANY($1::uuid[])', [entitlements]);
      await pool.query('DELETE FROM purchase_entitlements WHERE id=ANY($1::uuid[])', [entitlements]);
      await pool.query('DELETE FROM event_outbox WHERE aggregate_id=ANY($1::uuid[])', [credits]);
      await pool.query('DELETE FROM issued_vouchers WHERE id=ANY($1::uuid[])', [vouchers]);
      await pool.query('DELETE FROM ecocash_credits WHERE id=ANY($1::uuid[])', [credits]);
      await pool.query('DELETE FROM bundle_versions WHERE id=$1', [offer.bundleId]);
    } finally { await pool.end(); }
  });
  const apply = (changes = {}, settings = config) => applySimulatedEcoCashCredit(pool, key, settings, {...observation, ...changes});
  return {pool, key, offer, config, observation, apply};
}

test('EcoCash credit simulation refuses production before any database access', async () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = 'production';
    await assert.rejects(applySimulatedEcoCashCredit(null, null, null, null), /isolated_demo_required/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('concurrent retries, including alternate phone formats, create one credit, code and delivery event', {skip: !url}, async t => {
  const {apply, pool, observation, key} = await fixture(t);
  const outcomes = await Promise.all(Array.from({length: 12}, (_, i) => apply(i % 2 ? {payerPhone: '+263770000001'} : {})));
  const result = outcomes[0];
  assert.equal(result.state, 'issued');
  for (const outcome of outcomes) assert.deepEqual(outcome, result);
  const stored = (await pool.query('SELECT * FROM ecocash_credits WHERE transaction_id=$1', [observation.transactionId])).rows;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].environment, 'simulation');
  assert.equal(stored[0].start_by.getTime(), Date.parse(observation.paidAt) + 30 * day);
  const vouchers = (await pool.query('SELECT id,sale_id FROM issued_vouchers WHERE ecocash_credit_id=$1', [result.creditId])).rows;
  assert.equal(vouchers.length, 1);
  assert.equal(vouchers[0].sale_id, null);
  assert.equal((await pool.query('SELECT id FROM purchase_entitlements WHERE source_voucher_id=$1', [vouchers[0].id])).rowCount, 0);
  const events = (await pool.query('SELECT event_type,payload FROM event_outbox WHERE aggregate_id=$1', [result.creditId])).rows;
  assert.deepEqual(events, [{event_type: 'ecocash.voucher.issued', payload: {deliveryReference: result.creditId}}]);
  assert.equal((await readEcoCashDelivery(pool, result.creditId, key, true)).to, '263770000001');
});

test('failure after voucher generation rolls the receipt back and a retry issues it once', {skip: !url}, async t => {
  const {pool, key, config, observation, apply} = await fixture(t);
  const failingPool = {
    async connect() {
      const client = await pool.connect();
      return {
        query(sql, ...args) {
          if (sql.includes('INSERT INTO event_outbox')) throw Error('synthetic_outbox_failure');
          return client.query(sql, ...args);
        },
        release: () => client.release()
      };
    }
  };
  await assert.rejects(applySimulatedEcoCashCredit(failingPool, key, config, observation), /synthetic_outbox_failure/);
  assert.equal((await pool.query('SELECT id FROM ecocash_credits WHERE merchant_code=$1', [config.merchantCode])).rowCount, 0);
  const retry = await apply();
  assert.equal(retry.state, 'issued');
  assert.deepEqual(await apply(), retry);
  assert.equal((await pool.query('SELECT id FROM issued_vouchers WHERE ecocash_credit_id=$1', [retry.creditId])).rowCount, 1);
  assert.equal((await pool.query('SELECT id FROM event_outbox WHERE aggregate_id=$1', [retry.creditId])).rowCount, 1);
});

test('equal provider references on two configured merchants stay independent', {skip: !url}, async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const transactionId = randomUUID();
  const results = await Promise.all([first.apply({transactionId}), second.apply({transactionId})]);
  assert.equal(results[0].state, 'issued');
  assert.equal(results[1].state, 'issued');
  assert.notEqual(results[0].creditId, results[1].creditId);
  await second.apply({transactionId, kind: 'reversal'});
  assert.deepEqual(await first.apply({transactionId}), results[0]);
});

test('wrong merchant, currency, payer, amount, offer window and changed catalogue cannot issue vouchers', {skip: !url}, async t => {
  const {apply, pool, observation, offer, config} = await fixture(t);
  assert.deepEqual(await apply({merchantCode: 'OTHER'}), {state: 'ignored', reason: 'merchant_mismatch', creditId: null});
  assert.equal((await pool.query('SELECT id FROM ecocash_credits WHERE transaction_id=$1', [observation.transactionId])).rowCount, 0);
  for (const [changes, offers, reason] of [
    [{currency: 'ZWG'}, [offer], 'unsupported_currency'],
    [{payerPhone: null}, [offer], 'payer_unavailable'],
    [{payerPhone: 'bad'}, [offer], 'payer_unavailable'],
    [{amountMinor: 127}, [offer], 'unmatched_amount'],
    [{}, [offer, offer], 'ambiguous_amount'],
    [{}, [{...offer, validUntil: observation.paidAt}], 'unmatched_amount'],
    [{}, [{...offer, byteLimit: '100'}], 'bundle_terms_unavailable'],
    [{}, [{...offer, validitySeconds: 450}], 'bundle_terms_unavailable'],
    [{paidAt: iso(Date.now() + day)}, [offer], 'payment_time_outside_window'],
    [{paidAt: iso(Date.now() - 31 * day)}, [offer], 'payment_time_outside_window']
  ]) {
    const input = {...changes, transactionId: randomUUID()};
    const result = await apply(input, {...config, offers});
    assert.equal(result.state, 'review');
    assert.equal(result.reason, reason);
    assert.equal((await pool.query('SELECT id FROM issued_vouchers WHERE ecocash_credit_id=$1', [result.creditId])).rowCount, 0);
    assert.equal((await pool.query('SELECT id FROM event_outbox WHERE aggregate_id=$1', [result.creditId])).rowCount, 0);
    assert.deepEqual(await apply(input), result, 'retry cannot reprice existing money');
  }
  const first = await apply({}, {...config, offers: [{...offer, validFrom: observation.paidAt}]});
  assert.equal(first.state, 'issued', 'effective start is inclusive');
  await assert.rejects(apply({amountMinor: 1.5}), /invalid_ecocash_observation/);
  await assert.rejects(apply({paidAt: '2025-02-30T01:00:00Z'}), /invalid_ecocash_timestamp/);
});

test('overlapping operators or contradictory transaction details cannot create or reroute a second voucher', {skip: !url}, async t => {
  const {apply, pool, key} = await fixture(t);
  const results = await Promise.all([apply(), apply({payerPhone: '0770000009'})]);
  assert.deepEqual(results.map(r => r.state).sort(), ['issued', 'review']);
  const creditId = results[0].creditId;
  assert.equal(results[1].creditId, creditId);
  const held = {creditId, state: 'review', reason: 'conflicting_observation'};
  assert.deepEqual(await apply(), held);
  assert.deepEqual(await apply({payerPhone: '0770000009'}), held);
  assert.deepEqual((await pool.query('SELECT state FROM issued_vouchers WHERE ecocash_credit_id=$1', [creditId])).rows, [{state: 'revoked'}]);
  await assert.rejects(readEcoCashDelivery(pool, creditId, key, true), {code: 'ecocash_delivery_closed'});
});

test('reversal before credit, after issue, or after redemption remains final across late notifications', {skip: !url}, async t => {
  const {apply, pool, key} = await fixture(t);
  const early = await apply({kind: 'reversal'});
  assert.equal(early.state, 'reversed');
  assert.deepEqual(await apply(), early);
  assert.equal((await pool.query('SELECT id FROM issued_vouchers WHERE ecocash_credit_id=$1', [early.creditId])).rowCount, 0);

  for (const mode of ['valid', 'redeemed', 'consumed']) {
    const transactionId = randomUUID();
    const {creditId} = await apply({transactionId});
    const {message} = await readEcoCashDelivery(pool, creditId, key, true);
    const code = /voucher: ([A-Z2-9-]+)\./.exec(message)[1];
    const customer = randomUUID();
    let entitlement;
    if (mode !== 'valid') {
      entitlement = (await redeemVoucher(pool, customer, code, true)).entitlementId;
      if (mode === 'consumed') {
        // Simulate a legacy live reservation on a reversed entitlement to
        // verify recovery logic even though current issuance excludes demo EcoCash.
        await pool.query('UPDATE purchase_entitlements SET activated_at=now(),consumed_bytes=1 WHERE id=$1', [entitlement]);
        await pool.query(`INSERT INTO access_grants(id,customer_id,entitlement_id,site_id,generation,state,reserved_bytes,deadline)
          VALUES($1,$2,$3,$4,$5,'active',100,now()+interval '1 hour')`,
        [randomUUID(), customer, entitlement, randomUUID(), randomUUID()]);
      }
    }
    const reversed = await apply({kind: 'reversal', transactionId});
    assert.equal(reversed.state, mode === 'consumed' ? 'review' : 'reversed');
    assert.equal(reversed.reason, mode === 'consumed' ? 'consumed_reversal' : null);
    assert.deepEqual(await apply({transactionId}), reversed);
    assert.deepEqual(await apply({transactionId, kind: 'reversal'}), reversed);
    await assert.rejects(readEcoCashDelivery(pool, creditId, key, true), {code: 'ecocash_delivery_closed'});
    await assert.rejects(redeemVoucher(pool, customer, code, true), {code: 'invalid_or_used'});
    if (entitlement) assert.ok((await pool.query('SELECT revoked_at FROM purchase_entitlements WHERE id=$1', [entitlement])).rows[0].revoked_at);
    if (mode === 'consumed') {
      const grant = (await pool.query('SELECT id,state,disconnect_requested_at FROM access_grants WHERE entitlement_id=$1', [entitlement])).rows[0];
      assert.equal(grant.state, 'uncertain');
      assert.ok(grant.disconnect_requested_at);
      assert.equal((await pool.query('SELECT grant_id FROM network_account_holds WHERE customer_id=$1', [customer])).rows[0].grant_id, grant.id);
    }
  }
});
