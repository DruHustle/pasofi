import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../dist/app.js';
import { opaqueHash } from '../dist/staff-crypto.js';

const url = process.env.PAMOFI_TEST_DATABASE_URL, origin = 'http://localhost:5173';
async function fixture(run) {
  Object.assign(process.env, { DATABASE_URL: url, APP_ENV: 'demo', NODE_ENV: 'development', PUBLIC_ORIGIN: origin, SESSION_CREATION_SECRET: 'DEMO_ONLY_insecure_local_session_creation_secret_123456789' });
  const app = buildApp(), pool = new pg.Pool({ connectionString: url }), ids = [];
  const post = (route, payload = {}, cookie, suppliedOrigin = origin) => app.inject({ method: 'POST', url: route, payload, headers: { ...(suppliedOrigin ? { origin: suppliedOrigin } : {}), ...(cookie ? { cookie } : {}) } });
  async function customer() {
    const response = await app.inject({ method: 'POST', url: '/v1/session', headers: { origin, 'idempotency-key': randomBytes(32).toString('base64url') } });
    assert.equal(response.statusCode, 201);
    ids.push(response.json().customerId);
    return { id: response.json().customerId, cookie: response.headers['set-cookie'].split(';')[0] };
  }
  try { await run({ app, pool, post, customer }); }
  finally {
    if (ids.length) {
      await pool.query('DELETE FROM customer_sessions WHERE customer_id=ANY($1::uuid[])', [ids]);
      await pool.query('DELETE FROM customers WHERE id=ANY($1::uuid[])', [ids]);
    }
    await pool.end(); await app.close();
  }
}

test('browser handoff transfers the current account exactly once under concurrent redemption without a credential URL', { skip: !url }, async () => fixture(async ({ app, pool, post, customer }) => {
  const source = await customer();
  const created = await post('/v1/handoff', {}, source.cookie);
  assert.equal(created.statusCode, 201);
  assert.equal(created.headers['cache-control'], 'no-store');
  const { handoffCode, continueUrl, expiresIn } = created.json();
  assert.equal(continueUrl, `${origin}/handoff`);
  assert.equal(expiresIn, 120);
  assert.equal(continueUrl.includes(handoffCode), false);
  const stored = (await pool.query('SELECT * FROM customer_handoffs WHERE customer_id=$1', [source.id])).rows[0];
  assert.notEqual(stored.code_hash.toString('utf8'), handoffCode);
  const attempts = await Promise.all([post('/v1/handoff/redeem', { handoffCode }), post('/v1/handoff/redeem', { handoffCode })]);
  assert.deepEqual(attempts.map(result => result.statusCode).sort(), [200, 401]);
  const winner = attempts.find(result => result.statusCode === 200);
  assert.equal(winner.json().customerId, source.id);
  const targetCookie = winner.headers['set-cookie'].split(';')[0];
  assert.notEqual(targetCookie, source.cookie);
  for (const cookie of [targetCookie, source.cookie]) {
    const response = await app.inject({ method: 'GET', url: '/v1/session', headers: { cookie } });
    assert.equal(response.json().customerId, source.id);
  }
  assert.equal((await post('/v1/handoff/redeem', { handoffCode })).statusCode, 401);
}));

test('handoff refuses stale, expired and revoked-source codes and cannot replace an existing customer account', { skip: !url }, async () => fixture(async ({ app, pool, post, customer }) => {
  const source = await customer(), existing = await customer();
  const first = (await post('/v1/handoff', {}, source.cookie)).json().handoffCode;
  const second = (await post('/v1/handoff', {}, source.cookie)).json().handoffCode;
  assert.equal((await post('/v1/handoff/redeem', { handoffCode: first })).statusCode, 401);
  assert.equal((await post('/v1/handoff/redeem', { handoffCode: second }, existing.cookie)).statusCode, 409);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/session', headers: { cookie: existing.cookie } })).json().customerId, existing.id);
  assert.equal((await post('/v1/handoff/redeem', { handoffCode: second })).statusCode, 200);
  const expiring = (await post('/v1/handoff', {}, source.cookie)).json().handoffCode;
  await pool.query("UPDATE customer_handoffs SET expires_at=now()-interval '1 second' WHERE code_hash=$1", [opaqueHash(expiring)]);
  assert.equal((await post('/v1/handoff/redeem', { handoffCode: expiring })).statusCode, 401);
  const revoked = (await post('/v1/handoff', {}, source.cookie)).json().handoffCode;
  assert.equal((await app.inject({ method: 'DELETE', url: '/v1/session', headers: { origin, cookie: source.cookie } })).statusCode, 204);
  assert.equal((await post('/v1/handoff/redeem', { handoffCode: revoked })).statusCode, 401);
}));

test('handoff creation and redemption require the configured origin and never accept caller-selected customer IDs', { skip: !url }, async () => fixture(async ({ post, customer }) => {
  const source = await customer();
  assert.equal((await post('/v1/handoff', {}, source.cookie, null)).statusCode, 403);
  assert.equal((await post('/v1/handoff', {}, source.cookie, 'https://evil.test')).statusCode, 403);
  assert.equal((await post('/v1/handoff', { customerId: source.id }, source.cookie)).statusCode, 400);
  const handoffCode = (await post('/v1/handoff', {}, source.cookie)).json().handoffCode;
  assert.equal((await post('/v1/handoff/redeem', { handoffCode }, undefined, 'https://evil.test')).statusCode, 403);
  assert.equal((await post('/v1/handoff/redeem', { handoffCode }, undefined, null)).statusCode, 403);
  assert.equal((await post('/v1/handoff/redeem', { handoffCode })).statusCode, 200);
}));
