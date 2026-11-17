import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { SignJWT } from 'jose';
import pg from 'pg';
import { dispatchOnce } from '../dist/outbox.js';

const { PAMOFI_TEST_DATABASE_URL: prepaidDb, PAMOFI_TEST_NOTIFICATION_DATABASE_URL: notificationDb,
  PAMOFI_TEST_PREPAID_URL: prepaid, PAMOFI_TEST_NOTIFICATION_URL: notification,
  IDENTITY_URL: identity, PUBLIC_ORIGIN: origin } = process.env;

async function simulate(config, observation) {
  const path = fileURLToPath(new URL('./fixtures/ecocash-credit.mjs', import.meta.url));
  const child = spawn(process.execPath, [path], { env: { ...process.env,
    PAMOFI_TEST_CONFIRM_ISOLATED: '1', PAMOFI_TEST_PREPAID_DATABASE_URL: prepaidDb } });
  const exited = once(child, 'close');
  child.stdin.end(JSON.stringify({ config, observation }));
  let output = '';
  for await (const chunk of child.stdout) output += chunk;
  assert.equal((await exited)[0], 0, 'isolated incoming-credit fixture');
  return JSON.parse(output);
}

test('incoming transfer reaches one mock SMS and the customer redeems that voucher through the public API',
  { skip: !(prepaidDb && notificationDb && prepaid && notification && identity && origin), timeout: 30_000 }, async () => {
  const ledger = new pg.Pool({ connectionString: prepaidDb });
  const messages = new pg.Pool({ connectionString: notificationDb });
  const transactionId = randomUUID();
  const rows = async (sql, args) => (await ledger.query(sql, args)).rows;
  let worker, stopped;
  try {
    const now = Date.now();
    const iso = offset => new Date(now + offset).toISOString();
    const config = { merchantCode: 'PASOFI_DEMO', currency: 'USD', offers: [{ bundleId: 'flex',
      amountMinor: 100, byteLimit: '5000000000', validitySeconds: 604800, validFrom: iso(-60_000), validUntil: iso(60_000) }] };
    const observation = { kind: 'credit', transactionId, merchantCode: config.merchantCode,
      currency: 'USD', amountMinor: 100, payerPhone: '0770000001', paidAt: iso(0) };
    const first = await simulate(config, observation);
    assert.equal(first.state, 'issued');
    assert.equal(first.simulation, true);
    assert.deepEqual(await simulate(config, observation), first);
    const { creditId } = first;
    const deliveryPath = prepaid + '/internal/v1/deliveries/' + creditId;
    assert.equal((await fetch(deliveryPath)).status, 401);
    const token = await new SignJWT({ scope: 'delivery:read' }).setProtectedHeader({ alg: 'HS256' })
      .setIssuer('notification').setSubject('notification').setAudience('prepaid-access')
      .setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(process.env.INTERNAL_DELIVERY_SECRET));
    const details = await fetch(deliveryPath, { headers: { authorization: 'Bearer ' + token } });
    assert.equal(details.status, 200);
    const { to, from, message, simulation } = await details.json();
    assert.equal(simulation, true);
    assert.equal(to, '263770000001');
    const code = message.match(/[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}/)?.[0];
    assert.ok(code);
    const events = await rows('SELECT id,payload FROM event_outbox WHERE aggregate_id=$1', [creditId]);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].payload, { deliveryReference: creditId });
    assert.equal(await dispatchOnce(ledger, { endpoint: notification, secret: process.env.INTERNAL_EVENTS_SECRET, demo: true }), 'delivered');

    // The shared integration server leaves the SMS worker paused. Start its normal
    // executable on an ephemeral port, with the disposable mock sink only.
    const server = fileURLToPath(new URL('../../notification-service/dist/server.js', import.meta.url));
    worker = spawn(process.execPath, [server], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0',
      DATABASE_URL: notificationDb, DELIVERY_WORKER_ENABLED: 'true', DELIVERY_WORKER_AUTOSTART: 'true',
      INVOICE_DELIVERY_WORKER_ENABLED: 'false', NOTIFICATION_DELIVERY_MODE: 'mock' }, stdio: 'ignore' });
    stopped = once(worker, 'close');
    const expectedHash = createHash('sha256').update(JSON.stringify({ to, from, message })).digest('hex');
    let delivered;
    const deadline = Date.now() + 10_000;
    do {
      const result = await messages.query(`SELECT encode(m.message_hash,'hex') AS hash FROM mock_sms_sink m
        JOIN delivery_jobs j ON j.id=m.job_id WHERE j.delivery_reference=$1 AND j.state='delivered'`, [creditId]);
      delivered = result.rows;
      if (delivered.length || worker.exitCode !== null) break;
      await pause(100);
    } while (Date.now() < deadline);
    assert.deepEqual(delivered, [{ hash: expectedHash }], 'one mock SMS reached the intended payer with the issued code');

    const account = await fetch(identity + '/v1/session', { method: 'POST',
      headers: { origin, 'idempotency-key': randomBytes(32).toString('base64url') } });
    assert.equal(account.status, 201);
    const cookie = account.headers.get('set-cookie').split(';')[0];
    const redeem = async () => {
      const response = await fetch(prepaid + '/v1/vouchers/redeem', { method: 'POST',
        headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const receipt = await redeem();
    assert.equal(receipt.replayed, false);
    assert.deepEqual(await redeem(), { entitlementId: receipt.entitlementId, replayed: true });
    const access = await fetch(prepaid + '/v1/access', { headers: { cookie } });
    assert.equal(access.status, 200);
    const { entitlements } = await access.json();
    assert.equal(entitlements.length, 1);
    assert.equal(entitlements[0].bundle_id, 'flex');
    assert.equal(entitlements[0].byte_limit, '5000000000');
  } finally {
    if (worker) { worker.kill('SIGTERM'); await stopped; }
    try {
      const credit = (await rows('SELECT id FROM ecocash_credits WHERE transaction_id=$1', [transactionId]))[0];
      if (credit) {
        await messages.query('DELETE FROM delivery_attempts WHERE job_id IN (SELECT id FROM delivery_jobs WHERE delivery_reference=$1)', [credit.id]);
        await messages.query('DELETE FROM delivery_jobs WHERE delivery_reference=$1', [credit.id]);
        await messages.query('DELETE FROM event_inbox WHERE aggregate_id=$1', [credit.id]);
        await ledger.query('DELETE FROM purchase_entitlements WHERE source_voucher_id IN (SELECT id FROM issued_vouchers WHERE ecocash_credit_id=$1)', [credit.id]);
        await ledger.query('DELETE FROM event_outbox WHERE aggregate_id=$1', [credit.id]);
        await ledger.query('DELETE FROM issued_vouchers WHERE ecocash_credit_id=$1', [credit.id]);
        await ledger.query('DELETE FROM ecocash_credits WHERE id=$1', [credit.id]);
      }
    } finally {
      await Promise.all([ledger.end(), messages.end()]);
    }
  }
});
