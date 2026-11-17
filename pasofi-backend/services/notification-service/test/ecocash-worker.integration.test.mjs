import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import pg from 'pg';
import { buildApp } from '../dist/app.js';
import { processDelivery } from '../dist/worker.js';

const database = process.env.PAMOFI_TEST_DATABASE_URL;
const secret = 'synthetic_ecocash_delivery_key_for_tests_only';

function envelope() {
  const credit = randomUUID();
  return {
    id: randomUUID(), type: 'ecocash.voucher.issued', version: 1, producer: 'prepaid-access',
    aggregateId: credit, aggregateVersion: 1, occurredAt: new Date().toISOString(),
    correlationId: randomUUID(), payload: { deliveryReference: credit }
  };
}

async function auth(scope) {
  const token = await new SignJWT({ scope }).setProtectedHeader({ alg: 'HS256' })
    .setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('notification')
    .setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(secret));
  return { authorization: 'Bearer ' + token };
}

test('the production inbox rejects an authenticated EcoCash demo event before touching storage', async t => {
  const environment = {
    APP_ENV: 'production', NODE_ENV: 'production', INTERNAL_EVENTS_SECRET: secret,
    DATABASE_URL: 'postgresql://invalid@127.0.0.1:1/unreachable',
    DELIVERY_WORKER_ENABLED: 'false', INVOICE_DELIVERY_WORKER_ENABLED: 'false'
  };
  const saved = { ...process.env };
  Object.assign(process.env, environment);
  const app = buildApp();
  t.after(async () => {
    await app.close();
    for (const key of Object.keys(environment)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
  const reply = await app.inject({ method: 'POST', url: '/internal/v1/events',
    headers: await auth('event:deliver'), payload: envelope() });
  assert.equal(reply.statusCode, 403);
  assert.equal(reply.json().error, 'ecocash_demo_only');
});

test('one credited voucher queues one private mock SMS, including after retry and restart', { skip: !database }, async t => {
  const environment = {
    DATABASE_URL: database, APP_ENV: 'demo', NODE_ENV: 'development',
    INTERNAL_EVENTS_SECRET: secret, INTERNAL_DELIVERY_SECRET: secret,
    PREPAID_URL: 'http://prepaid.example.test', DELIVERY_WORKER_ENABLED: 'true',
    DELIVERY_WORKER_AUTOSTART: 'false', NOTIFICATION_DELIVERY_MODE: 'mock',
    INVOICE_DELIVERY_WORKER_ENABLED: 'false'
  };
  const saved = { ...process.env };
  Object.assign(process.env, environment);
  const pool = new pg.Pool({ connectionString: database });
  const app = buildApp(), event = envelope(), credit = event.aggregateId;
  t.after(async () => {
    try {
      await app.close();
      const jobs = (await pool.query('SELECT id,event_id FROM delivery_jobs WHERE delivery_reference=$1', [credit])).rows;
      await pool.query('DELETE FROM delivery_resend_requests WHERE delivery_reference=$1', [credit]);
      for (const job of jobs) {
        await pool.query('DELETE FROM delivery_attempts WHERE job_id=$1', [job.id]);
        await pool.query('DELETE FROM delivery_jobs WHERE id=$1', [job.id]);
        await pool.query('DELETE FROM event_inbox WHERE id=$1', [job.event_id]);
      }
    } finally {
      await pool.end();
      for (const key of Object.keys(environment)) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      }
    }
  });
  const headers = await auth('event:deliver');
  const post = body => app.inject({ method: 'POST', url: '/internal/v1/events', headers, payload: body });
  assert.equal((await post({ ...event, payload: { deliveryReference: randomUUID() } })).statusCode, 400);
  assert.equal((await post({ ...event, payload: { ...event.payload, phone: '263771000000' } })).statusCode, 400);
  const replies = await Promise.all(Array.from({ length: 4 }, () => post(event)));
  assert.ok(replies.every(reply => reply.statusCode === 200));
  assert.equal((await post({ ...event, correlationId: randomUUID() })).statusCode, 409);
  const jobs = (await pool.query('SELECT id,source_kind FROM delivery_jobs WHERE delivery_reference=$1', [credit])).rows;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].source_kind, 'ecocash_demo_credit');

  const message = { to: '263771000000', from: 'PasoFi', message: 'Synthetic PasoFi demo voucher.' };
  let patch = { creditId: randomUUID() }, closed = false;
  const lookup = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), environment.PREPAID_URL + '/internal/v1/deliveries/' + credit);
    const { payload } = await jwtVerify(options.headers.authorization.slice(7), new TextEncoder().encode(secret),
      { issuer: 'notification', subject: 'notification', audience: 'prepaid-access', algorithms: ['HS256'] });
    assert.equal(payload.scope, 'delivery:read');
    if (closed) return Response.json({ error: 'ecocash_delivery_closed' }, { status: 410 });
    return Response.json({ deliveryReference: credit, creditId: credit, channel: 'sms', simulation: true, ...message, ...patch });
  });
  const countSends = async () => (await pool.query(
    'SELECT count(*)::int AS n FROM mock_sms_sink s JOIN delivery_jobs j ON j.id=s.job_id WHERE j.delivery_reference=$1', [credit]
  )).rows[0].n;
  for (const invalid of [{ creditId: randomUUID() }, { simulation: false }]) {
    patch = invalid;
    assert.equal(await processDelivery(pool, true), true);
    assert.equal(await countSends(), 0);
    await pool.query('UPDATE delivery_jobs SET next_at=now() WHERE id=$1', [jobs[0].id]);
  }
  // Simulate a production worker restarted with a previously queued demo database.
  assert.equal(await processDelivery(pool, false, { mode: 'sendai', enabled: true }), false);
  assert.equal(lookup.mock.callCount(), 2);
  patch = {};
  await Promise.all(Array.from({ length: 4 }, () => processDelivery(pool, true)));
  assert.equal(await countSends(), 1);
  const expectedHash = createHash('sha256').update(JSON.stringify(message)).digest();
  const sink = (await pool.query('SELECT * FROM mock_sms_sink WHERE job_id=$1', [jobs[0].id])).rows[0];
  assert.deepEqual(sink.message_hash, expectedHash);

  const resendHeaders = await auth('delivery:resend'), actorId = randomUUID();
  const requestResend = requestId => app.inject({ method: 'POST', url: '/internal/v1/deliveries/' + credit + '/resend',
    headers: resendHeaders, payload: { requestId, actorId, reason: 'Repeated mock delivery on request' } });
  const requestId = randomUUID(), resend = await requestResend(requestId);
  assert.equal(resend.statusCode, 201);
  const replay = await requestResend(requestId);
  assert.equal(replay.json().jobId, resend.json().jobId);
  assert.equal(await processDelivery(pool, false, { mode: 'sendai', enabled: true }), false);
  assert.equal(await processDelivery(pool, true), true);
  assert.equal(await countSends(), 2);
  const resent = (await pool.query('SELECT message_hash FROM mock_sms_sink WHERE job_id=$1', [resend.json().jobId])).rows[0];
  assert.deepEqual(resent.message_hash, expectedHash);

  const response = await app.inject({ url: '/internal/v1/deliveries/' + credit + '/status', headers: await auth('delivery:status') });
  assert.equal(response.json().simulation, true);
  assert.equal(response.json().state, 'delivered');
  assert.ok(!response.body.includes(message.to));
  assert.ok(!response.body.includes(message.message));

  const pending = await requestResend(randomUUID());
  assert.equal(pending.statusCode, 201);
  closed = true; // The credit was reversed while this copy was queued.
  assert.equal(await processDelivery(pool, true), true);
  assert.equal(await countSends(), 2);
  const canceled = (await pool.query('SELECT state,last_error FROM delivery_jobs WHERE id=$1', [pending.json().jobId])).rows[0];
  assert.deepEqual(canceled, { state: 'canceled', last_error: 'voucher_unavailable' });
  assert.equal((await requestResend(randomUUID())).json().error, 'voucher_unavailable');
});
