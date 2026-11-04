import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../dist/app.js';

const url = process.env.PAMOFI_TEST_DATABASE_URL;
const origin = 'http://localhost:5173';
function configure(databaseUrl = url) {
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    APP_ENV: 'demo', NODE_ENV: 'development', PUBLIC_ORIGIN: origin,
    SESSION_CREATION_SECRET: 'DEMO_ONLY_insecure_local_session_creation_secret_123456789'
  });
}

test('logout revokes only the current session and a first-response retry cannot revive it', { skip: !url }, async () => {
  configure();
  const app = buildApp(), pool = new pg.Pool({ connectionString: url });
  const retryKey = randomBytes(32).toString('base64url');
  let customerId;
  try {
    const created = await app.inject({ method: 'POST', url: '/v1/session', headers: { origin, 'idempotency-key': retryKey } });
    assert.equal(created.statusCode, 201);
    customerId = created.json().customerId;
    const cookie = created.headers['set-cookie'].split(';')[0];
    const setup = await app.inject({ method: 'POST', url: '/v1/recovery/setup', headers: { origin, cookie } });
    assert.equal(setup.statusCode, 201);
    const restored = await app.inject({ method: 'POST', url: '/v1/recovery', headers: { origin }, payload: setup.json() });
    assert.equal(restored.statusCode, 200);
    const otherCookie = restored.headers['set-cookie'].split(';')[0];

    for (const requestOrigin of [undefined, 'http://evil.example']) {
      const denied = await app.inject({ method: 'DELETE', url: '/v1/session', headers: { cookie, ...(requestOrigin ? { origin: requestOrigin } : {}) } });
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.headers['set-cookie'], undefined);
      assert.equal((await app.inject({ method: 'GET', url: '/v1/session', headers: { cookie } })).statusCode, 200);
    }

    const logout = await app.inject({ method: 'DELETE', url: '/v1/session', headers: { origin, cookie } });
    assert.equal(logout.statusCode, 204);
    assert.equal(logout.body, '');
    assert.equal(logout.headers['cache-control'], 'no-store');
    assert.match(logout.headers['set-cookie'], /^pamofi_demo_session=;/);
    assert.match(logout.headers['set-cookie'], /HttpOnly/);
    assert.match(logout.headers['set-cookie'], /SameSite=Lax/);
    assert.match(logout.headers['set-cookie'], /Max-Age=0/);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/session', headers: { cookie } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/session', headers: { origin, 'idempotency-key': retryKey } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/session', headers: { cookie: otherCookie } })).json().customerId, customerId);
    assert.equal((await app.inject({ method: 'DELETE', url: '/v1/session', headers: { origin, cookie } })).statusCode, 204);
    assert.equal((await app.inject({ method: 'DELETE', url: '/v1/session', headers: { origin } })).statusCode, 204);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/recovery', headers: { origin }, payload: setup.json() })).json().customerId, customerId);
  } finally {
    if (customerId) {
      await pool.query('DELETE FROM customer_sessions WHERE customer_id=$1', [customerId]);
      await pool.query('DELETE FROM customer_recovery WHERE customer_id=$1', [customerId]);
      await pool.query('DELETE FROM customers WHERE id=$1', [customerId]);
    }
    await pool.end();
    await app.close();
  }
});

test('logout does not pretend success or clear the cookie when revocation cannot be stored', async () => {
  configure('postgresql://unused:unused@127.0.0.1:1/unused');
  const app = buildApp();
  try {
    const response = await app.inject({ method: 'DELETE', url: '/v1/session', headers: { origin, cookie: `pamofi_demo_session=${randomBytes(32).toString('base64url')}` } });
    assert.equal(response.statusCode, 503);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['set-cookie'], undefined);
  } finally { await app.close(); }
});

test('production logout clears the secure host-only cookie with matching attributes', async () => {
  configure('postgresql://unused:unused@127.0.0.1:1/unused');
  Object.assign(process.env, { APP_ENV: 'production', NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://example.test' });
  const app = buildApp();
  try {
    const response = await app.inject({ method: 'DELETE', url: '/v1/session', headers: { origin: 'https://example.test' } });
    assert.equal(response.statusCode, 204);
    assert.match(response.headers['set-cookie'], /^__Host-pamofi_session=;/);
    assert.match(response.headers['set-cookie'], /Path=\//);
    assert.match(response.headers['set-cookie'], /Secure/);
    assert.match(response.headers['set-cookie'], /HttpOnly/);
    assert.doesNotMatch(response.headers['set-cookie'], /Domain=/);
  } finally { await app.close(); }
});
