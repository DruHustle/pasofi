import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../dist/app.js';
import { managedBrowserLogoutUrl } from '../dist/onesa-browser-logout.js';

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

test('only canonical managed browser logout builds an exact Onesa URL and fixed return', () => {
  const publicOrigin = 'https://pasofi.example.test';
  const config = {
    issuer: 'https://auth.onesa.eu/', clientId: 'pasofi_fixture_client',
    callback: new URL('/onesa-callback.html', publicOrigin), managed: {},
  };
  const request = { publicOrigin, requestOrigin: publicOrigin, preference: 'onesa', revokedManagedSession: true };
  const location = new URL(managedBrowserLogoutUrl(config, request));
  assert.equal(location.origin + location.pathname, 'https://auth.onesa.eu/v2/logout');
  assert.deepEqual([...location.searchParams], [['client_id', config.clientId], ['returnTo', publicOrigin + '/']]);
  for (const override of [
    { preference: undefined }, { revokedManagedSession: false },
    { requestOrigin: 'https://alias.example.test' }, { publicOrigin: undefined },
  ]) assert.equal(managedBrowserLogoutUrl(config, { ...request, ...override }), undefined);
  assert.equal(managedBrowserLogoutUrl({ ...config, managed: undefined }, request), undefined);
  assert.equal(managedBrowserLogoutUrl({ ...config, issuer: 'https://other.example.test/' }, request), undefined);
  assert.equal(managedBrowserLogoutUrl({ ...config, callback: new URL('https://alias.example.test/onesa-callback.html') }, request), undefined);
});

test('managed browser logout hands off to Onesa only after revoking the requested database session', { skip: !url }, async () => {
  const origin = 'https://pasofi.example.test', alias = 'https://alias.example.test';
  const clientId = 'pasofi_fixture_client', issuer = 'https://auth.onesa.eu/';
  const recordIssuer = 'https://portal.example.test/api/v1/identity';
  const customer = randomUUID(), staffSubject = randomUUID();
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(process.env, {
    APP_ENV: 'production', NODE_ENV: 'production', DATABASE_URL: url, PUBLIC_ORIGIN: origin,
    PUBLIC_ORIGIN_ALIASES: JSON.stringify([alias]), STAFF_MFA_ENCRYPTION_KEY: 'ab'.repeat(32),
    PASOFI_ONESA_MODE: 'managed', PASOFI_ONESA_ISSUER: issuer, PASOFI_ONESA_CLIENT_ID: clientId,
    PASOFI_ONESA_CLIENT_SECRET: randomBytes(48).toString('hex'),
    PASOFI_ONESA_REDIRECT_URI: origin + '/onesa-callback.html',
    PASOFI_ONESA_AUDIENCE: 'https://api.pasofi.example.test', PASOFI_ONESA_RECORD_ISSUER: recordIssuer,
    PASOFI_ONESA_PUBLIC_JWKS: JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'fixture' }] }),
  });
  const app = buildApp(), pool = new pg.Pool({ connectionString: url });
  try {
    await pool.query('INSERT INTO customers(id) VALUES($1)', [customer]);
    for (const mode of ['customer', 'staff']) {
      const path = mode === 'customer' ? '/v1/session' : '/v1/staff/session';
      const cookieName = mode === 'customer' ? '__Host-pamofi_session' : '__Host-pamofi_staff_session';
      const candidate = async (managed = true) => {
        const token = randomBytes(32).toString('base64url');
        const hash = createHash('sha256').update(token).digest();
        const envelope = managed ? 'managed.fixture' : 'legacy.fixture';
        if (mode === 'customer') {
          await pool.query("INSERT INTO customer_onesa_sessions(token_hash,customer_id,access_ciphertext,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
            [hash, customer, envelope]);
        } else {
          await pool.query("INSERT INTO staff_onesa_sessions(token_hash,issuer,subject,access_ciphertext,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')",
            [hash, recordIssuer, staffSubject, envelope]);
        }
        return {
          cookie: cookieName + '=' + token,
          async active() {
            const sql = mode === 'customer' ? 'SELECT 1 FROM customer_onesa_sessions WHERE token_hash=$1 AND revoked_at IS NULL'
              : 'SELECT 1 FROM staff_onesa_sessions WHERE token_hash=$1';
            return (await pool.query(sql, [hash])).rowCount === 1;
          },
        };
      };
      const request = (session, requestOrigin, optIn = true) => app.inject({
        method: 'DELETE', url: path, headers: {
          origin: requestOrigin, cookie: session.cookie, ...(optIn ? { 'x-pasofi-end-session': 'onesa' } : {}),
        },
      });
      const current = await candidate(), unrelated = await candidate(), old = await candidate(false), aliasSession = await candidate();
      const rejected = await request(current, 'https://foreign.example');
      assert.equal(rejected.statusCode, 403);
      assert.equal(await current.active(), true);

      const result = await request(current, origin);
      assert.equal(result.statusCode, 200);
      assert.equal(result.headers['cache-control'], 'no-store');
      assert.match([result.headers['set-cookie']].flat()[0], new RegExp('^' + cookieName + '=;'));
      const target = new URL(result.json().endSessionUrl);
      assert.equal(target.origin + target.pathname, 'https://auth.onesa.eu/v2/logout');
      assert.equal(target.searchParams.get('returnTo'), origin + '/');
      assert.equal(target.searchParams.get('client_id'), clientId);
      assert.equal(await current.active(), false);
      assert.equal(await unrelated.active(), true);
      assert.equal((await request(current, origin)).statusCode, 204);
      assert.equal((await request(unrelated, origin, false)).statusCode, 204);
      assert.equal((await request(old, origin)).statusCode, 204);
      assert.equal((await request(aliasSession, alias)).statusCode, 204);
      assert.equal(await aliasSession.active(), false);
    }
  } finally {
    await pool.query('DELETE FROM staff_onesa_sessions WHERE subject=$1', [staffSubject]);
    await pool.query('DELETE FROM customer_onesa_sessions WHERE customer_id=$1', [customer]);
    await pool.query('DELETE FROM customers WHERE id=$1', [customer]);
    await pool.end();
    await app.close();
  }
});
