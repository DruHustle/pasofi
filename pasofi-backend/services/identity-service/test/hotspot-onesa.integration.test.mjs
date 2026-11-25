import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { SignJWT, exportJWK } from 'jose';
import { buildApp } from '../dist/app.js';

test('a configured hotspot customer flow retains its own callback and host-only session', {
  skip: !process.env.PAMOFI_TEST_DATABASE_URL,
}, async t => {
  const issuer = 'https://auth.onesa.eu/';
  const origin = 'https://pasofi.example.invalid';
  const hotspot = 'https://hotspot.pasofi.mobile.onesa.eu';
  const unboundAlias = 'https://other.pasofi.example.invalid';
  const audience = 'https://api.pasofi.example.invalid';
  const clientId = 'pasofi_isolated_web_client';
  const subject = 'auth0|' + randomUUID();
  const stable = randomUUID();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwks = { keys: [{ ...await exportJWK(publicKey), alg: 'RS256', use: 'sig', kid: 'isolated' }] };
  Object.assign(process.env, {
    APP_ENV: 'production', NODE_ENV: 'production', PUBLIC_ORIGIN: origin,
    PUBLIC_ORIGIN_ALIASES: JSON.stringify([unboundAlias, 'https://legacy.pasofi.example.invalid', 'https://api.pasofi.example.invalid', hotspot]),
    DATABASE_URL: process.env.PAMOFI_TEST_DATABASE_URL,
    STAFF_MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    PASOFI_ONESA_MODE: 'managed', PASOFI_ONESA_ISSUER: issuer,
    PASOFI_ONESA_RECORD_ISSUER: 'https://portal.example.invalid/api/v1/identity',
    PASOFI_ONESA_CLIENT_ID: clientId, PASOFI_ONESA_CLIENT_SECRET: randomBytes(48).toString('hex'),
    PASOFI_ONESA_REDIRECT_URI: origin + '/onesa-callback.html',
    PASOFI_ONESA_HOTSPOT_REDIRECT_URI: hotspot + '/onesa-callback.html',
    PASOFI_ONESA_AUDIENCE: audience, PASOFI_ONESA_PUBLIC_JWKS: JSON.stringify(jwks),
  });
  const app = buildApp();
  t.after(() => app.close());

  let authorization;
  let exchanges = 0;
  const claims = 'https://onesa.eu/claims/';
  const now = () => Math.floor(Date.now() / 1000);
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (String(url) === issuer + '.well-known/openid-configuration') return Response.json({
      issuer, authorization_endpoint: issuer + 'authorize', token_endpoint: issuer + 'oauth/token',
      jwks_uri: issuer + 'keys', response_types_supported: ['code'],
      subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
    });
    if (String(url) === issuer + 'keys') return Response.json(jwks);
    assert.equal(String(url), issuer + 'oauth/token');
    exchanges++;
    const form = new URLSearchParams(init.body);
    assert.equal(form.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
    assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),
      authorization.searchParams.get('code_challenge'));
    const sign = (payload, target) => new SignJWT(payload).setIssuer(issuer).setAudience(target)
      .setSubject(subject).setProtectedHeader({ alg: 'RS256', kid: 'isolated' })
      .setIssuedAt(now()).setExpirationTime(now() + 300).sign(privateKey);
    return Response.json({
      token_type: 'Bearer', access_token: await sign({
        azp: clientId, [claims + 'user_id']: stable, [claims + 'products']: ['pasofi'], [claims + 'roles']: ['customer'],
      }, audience),
      id_token: await sign({ nonce: authorization.searchParams.get('nonce'), auth_time: now() }, clientId),
    });
  });

  const request = (target, method, path, payload, cookie, runtime = app) =>
    runtime.inject({ method, url: '/v1/' + path, headers: { origin: target, ...(cookie ? { cookie } : {}) }, ...(payload ? { payload } : {}) });
  const cookieValue = (response, name) => {
    const cookie = response.cookies.find(value => value.name === name);
    assert.ok(cookie, name);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.path, '/');
    assert.equal(String(cookie.sameSite).toLowerCase(), 'lax');
    assert.equal(cookie.domain, undefined);
    return cookie.name + '=' + cookie.value;
  };

  const availability = await request(hotspot, 'GET', 'onesa/availability');
  assert.equal(availability.json().origin, origin);
  assert.equal(availability.json().hotspotOrigin, hotspot);
  assert.equal(availability.json().native.issuer, issuer);
  assert.equal((await request(unboundAlias, 'POST', 'onesa/start', {})).statusCode, 403);
  assert.equal((await request(hotspot, 'POST', 'staff/onesa/start', {})).statusCode, 403);

  const start = await request(hotspot, 'POST', 'onesa/start', { returnTo: '/connect' });
  assert.equal(start.statusCode, 200, start.body);
  authorization = new URL(start.json().authorizationUrl);
  assert.equal(authorization.origin + authorization.pathname, issuer + 'authorize');
  assert.equal(authorization.searchParams.get('audience'), audience);
  assert.equal(authorization.searchParams.get('redirect_uri'), hotspot + '/onesa-callback.html');
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  const flow = cookieValue(start, '__Host-pasofi_onesa_customer_flow');
  const callback = { state: authorization.searchParams.get('state'), code: 'isolated-code' };
  assert.equal((await request(origin, 'POST', 'onesa/complete', callback, flow)).statusCode, 401);
  assert.equal(exchanges, 0, 'wrong origin cannot consume the flow or contact Auth0');
  const complete = await request(hotspot, 'POST', 'onesa/complete', callback, flow);
  assert.equal(complete.statusCode, 200, complete.body);
  assert.equal(complete.json().returnTo, '/connect');
  assert.equal(exchanges, 1);
  const session = cookieValue(complete, '__Host-pamofi_session');
  assert.equal((await request(hotspot, 'GET', 'session', undefined, session)).json().customerId, complete.json().customerId);
  assert.equal((await request(hotspot, 'POST', 'onesa/complete', callback, flow)).statusCode, 401);

  let repeated = flow;
  for (let attempt = 0; attempt < 12; attempt++) {
    const retry = await request(hotspot, 'POST', 'onesa/start', { returnTo: '/connect' }, repeated);
    assert.equal(retry.statusCode, 200, retry.body);
    repeated = cookieValue(retry, '__Host-pasofi_onesa_customer_flow');
  }
  const limited = await request(hotspot, 'POST', 'onesa/start', {}, repeated);
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal((await request(hotspot, 'POST', 'onesa/start', {})).statusCode, 200);

  // Optional binding absent or invalid: the ordinary web flow keeps serving.
  for (const value of ['', origin + '/onesa-callback.html', hotspot + '/other.html',
    'https://outside.example.invalid/onesa-callback.html']) {
    process.env.PASOFI_ONESA_HOTSPOT_REDIRECT_URI = value;
    const single = buildApp();
    try {
      const available = await request(origin, 'GET', 'onesa/availability', undefined, undefined, single);
      assert.equal(available.json().origin, origin);
      assert.equal(available.json().hotspotOrigin, undefined);
      assert.equal((await request(hotspot, 'POST', 'onesa/start', {}, undefined, single)).statusCode, 403);
      const ordinary = await request(origin, 'POST', 'onesa/start', {}, undefined, single);
      assert.equal(ordinary.statusCode, 200, ordinary.body);
      assert.equal(new URL(ordinary.json().authorizationUrl).searchParams.get('redirect_uri'), origin + '/onesa-callback.html');
    } finally { await single.close(); }
  }
});
