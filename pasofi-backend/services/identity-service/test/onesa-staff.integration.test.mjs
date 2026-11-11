import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT, exportJWK } from 'jose';
import { buildApp } from '../dist/app.js';
import { adminAssertion } from '../dist/onesa-staff.js';

const issuer = 'https://portal.example.invalid/api/v1/identity', origin = 'https://pasofi.example.invalid';
const clientId = 'synthetic_pasofi_staff', clientSecret = randomBytes(48).toString('hex');
const now = Math.floor(Date.now() / 1000);
function active() {
  return { active: true, iss: issuer, aud: clientId, sub: randomUUID(), email_verified: true,
    email: 'admin@example.invalid', name: 'Test administrator', exp: now + 600, auth_time: now,
    amr: ['pwd','otp'], onesa_roles: ['global_admin'], onesa_product_roles: { pasofi: 'admin' }, onesa_applications: ['pasofi'] };
}

test('an active, verified, MFA-authenticated PasoFi platform administrator is required', () => {
  const input = active();
  assert.equal(adminAssertion(input, { issuer, clientId }, now).subject, input.sub);
  for (const changed of [{ active: false }, { email_verified: false }, { amr: ['pwd'] }, { onesa_roles: ['member'] },
    { aud: 'another-client' }, { iss: 'https://elsewhere.invalid' }, { onesa_product_roles: { pasofi: 'viewer' } },
    { onesa_applications: ['mobile'] }, { exp: now }, { auth_time: now - 28800 }]) {
    assert.throws(() => adminAssertion({ ...input, ...changed }, { issuer, clientId }, now));
  }
});

test('staff entry, callback and administrative route require the same browser and live Portal grant', { skip: !process.env.PAMOFI_TEST_DATABASE_URL }, async (t) => {
  Object.assign(process.env, { DATABASE_URL: process.env.PAMOFI_TEST_DATABASE_URL, PUBLIC_ORIGIN: origin,
    APP_ENV: 'demo', NODE_ENV: 'development', STAFF_MFA_ENCRYPTION_KEY: 'cd'.repeat(32), PASOFI_ONESA_CLIENT_ID: clientId,
    PASOFI_ONESA_CLIENT_SECRET: clientSecret, PASOFI_ONESA_ISSUER: issuer, PASOFI_ONESA_REDIRECT_URI: origin + '/onesa-callback.html' });
  const app = buildApp();
  t.after(() => app.close());
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let assertion = active(), authQuery, tokenCalls = 0;
  const token = randomBytes(32).toString('hex');
  const request = (method, path, payload, cookie) => app.inject({ method, url: '/v1/staff/' + path,
    headers: { origin, ...(cookie ? { cookie } : {}) }, ...(payload ? { payload } : {}) });
  const getCookie = (reply, name) => reply.cookies.find(c => c.name === name);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(init.redirect, 'error');
    if (String(url) === issuer + '/jwks') return Response.json({ keys: [{ ...await exportJWK(publicKey), alg: 'RS256', use: 'sig', kid: 'test' }] });
    const basic = new Headers(init.headers).get('Authorization');
    assert.ok(basic.startsWith('Basic '));
    assert.deepEqual(Buffer.from(basic.slice(6), 'base64').toString().split(':').map(decodeURIComponent), [clientId, clientSecret]);
    if (String(url) === issuer + '/token') {
      tokenCalls++;
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('redirect_uri'), origin + '/onesa-callback.html');
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), authQuery.get('code_challenge'));
      const id = await new SignJWT({ nonce: authQuery.get('nonce'), auth_time: now }).setProtectedHeader({ alg: 'RS256', kid: 'test' })
        .setIssuedAt(now).setExpirationTime(now + 600).setIssuer(issuer).setAudience(clientId).setSubject(assertion.sub).sign(privateKey);
      return Response.json({ token_type: 'Bearer', access_token: token, id_token: id });
    }
    assert.equal(String(url), issuer + '/session');
    assert.deepEqual(JSON.parse(init.body), { token });
    return Response.json(assertion);
  });
  const availability = await request('GET','onesa/availability');
  assert.deepEqual(availability.json(), { origin });
  const start = await request('POST','onesa/start',{});
  assert.equal(start.statusCode,200);
  authQuery = new URL(start.json().authorizationUrl).searchParams;
  assert.equal(authQuery.get('acr_values'), 'urn:onesa:mfa');
  assert.equal(authQuery.get('code_challenge_method'), 'S256');
  const flow = getCookie(start, 'pasofi_demo_onesa_flow'), flowCookie = flow.name + '=' + flow.value;
  const params = { state: authQuery.get('state'), code: 'synthetic-code', iss: issuer };
  assert.equal((await request('POST','onesa/complete',params)).statusCode,401);
  assert.equal(tokenCalls,0);
  const verified = await request('POST','onesa/complete',params,flowCookie);
  assert.equal(verified.statusCode,200,verified.body);
  assert.equal((await request('POST','onesa/complete',params,flowCookie)).statusCode,401);
  assert.equal(tokenCalls,1);
  const session = getCookie(verified,'pamofi_demo_staff_session'), cookie = session.name + '=' + session.value;
  const loggedIn = await request('GET','session',undefined,cookie);
  assert.equal(loggedIn.json().staffId,assertion.sub);
  assert.equal(loggedIn.json().mfaVerified,true);
  assert.equal((await request('GET','users',undefined,cookie)).statusCode,200);
  assertion = { ...assertion, active: false };
  assert.equal((await request('GET','users',undefined,cookie)).statusCode,401);
  assert.equal((await request('DELETE','session',undefined,cookie)).statusCode,204);
  assertion.active = true;
  assert.equal((await request('GET','users',undefined,cookie)).statusCode,401);
});
