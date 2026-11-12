import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
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
    APP_ENV: 'production', NODE_ENV: 'production', STAFF_MFA_ENCRYPTION_KEY: randomBytes(32).toString('hex'), PASOFI_ONESA_CLIENT_ID: clientId,
    PASOFI_ONESA_CLIENT_SECRET: clientSecret, PASOFI_ONESA_ISSUER: issuer, PASOFI_ONESA_REDIRECT_URI: origin + '/onesa-callback.html' });
  const app = buildApp();
  t.after(() => app.close());
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let assertion = active(), authQuery, tokenCalls = 0, issuerUnavailable = false;
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
    return issuerUnavailable ? Response.json({}, {status:503}) : Response.json(assertion);
  });
  const availability = await request('GET','onesa/availability');
  assert.deepEqual(availability.json(), { origin });
  const start = await request('POST','onesa/start',{});
  assert.equal(start.statusCode,200);
  authQuery = new URL(start.json().authorizationUrl).searchParams;
  assert.equal(authQuery.get('acr_values'), 'urn:onesa:mfa');
  assert.equal(authQuery.get('code_challenge_method'), 'S256');
  const flow = getCookie(start, '__Host-pasofi_onesa_flow'), flowCookie = flow.name + '=' + flow.value;
  const params = { state: authQuery.get('state'), code: 'synthetic-code', iss: issuer };
  assert.equal((await request('POST','onesa/complete',params)).statusCode,401);
  assert.equal(tokenCalls,0);
  const verified = await request('POST','onesa/complete',params,flowCookie);
  assert.equal(verified.statusCode,200,verified.body);
  assert.equal((await request('POST','onesa/complete',params,flowCookie)).statusCode,401);
  assert.equal(tokenCalls,1);
  const session = getCookie(verified,'__Host-pamofi_staff_session'), cookie = session.name + '=' + session.value;
  const loggedIn = await request('GET','session',undefined,cookie);
  assert.equal(loggedIn.json().staffId,assertion.sub);
  assert.equal(loggedIn.json().mfaVerified,true);
  assert.equal((await request('GET','users',undefined,cookie)).statusCode,200);
  const fixture = new URL(process.env.PAMOFI_TEST_STAFF_FIXTURE_URL || process.env.PAMOFI_TEST_DATABASE_URL);
  const runtime = new URL(process.env.PAMOFI_TEST_DATABASE_URL);
  assert.equal(fixture.host, runtime.host);
  assert.equal(fixture.pathname, runtime.pathname);
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(fixture.hostname));
  const db = new pg.Pool({ connectionString: fixture.href });
  t.after(() => db.end());
  const initial = assertion;
  const staffId = randomUUID(), siteId = randomUUID();
  assertion = { ...active(), onesa_roles: ['member'], onesa_product_roles: { pasofi: 'customer' } };
  const operatorSignIn = async () => {
    const started = await request('POST','onesa/start',{});
    authQuery = new URL(started.json().authorizationUrl).searchParams;
    const browser = getCookie(started, '__Host-pasofi_onesa_flow');
    return request('POST','onesa/complete',{state:authQuery.get('state'),code:'fixture',iss:issuer}, browser.name + '=' + browser.value);
  };
  await db.query("INSERT INTO staff_users(id,email,display_name,password_hash,status,role,site_ids) VALUES($1,$2,'Site operator','unused','approved','agent',$3)",[staffId, staffId+'@example.invalid', [siteId]]);
  try {
    assert.equal((await operatorSignIn()).statusCode,401);
    await db.query('INSERT INTO staff_onesa_bindings(issuer,subject,staff_id) VALUES($1,$2,$3)',[issuer,assertion.sub,staffId]);
    assertion.amr = ['pwd'];
    assert.equal((await operatorSignIn()).statusCode,401);
    assertion.amr = ['pwd','otp'];
    const signed = await operatorSignIn();
    assert.equal(signed.statusCode,200,signed.body);
    const value = getCookie(signed,'__Host-pamofi_staff_session');
    const operatorCookie = value.name + '=' + value.value;
    const operator = (await request('GET','session',undefined,operatorCookie)).json();
    await assert.rejects(db.query('UPDATE staff_onesa_bindings SET staff_id=$1 WHERE staff_id=$2',[randomUUID(),staffId]),{code:'23514'});
    assert.equal((await request('GET','session',undefined,operatorCookie)).json().staffId,staffId);
    assert.equal(operator.staffId,staffId);
    assert.equal(operator.role,'agent');
    assert.deepEqual(operator.siteIds,[siteId]);
    assert.equal((await request('GET','users',undefined,operatorCookie)).statusCode,403);
    await db.query("UPDATE staff_users SET role='support',version=version+1 WHERE id=$1",[staffId]);
    assert.equal((await request('GET','session',undefined,operatorCookie)).statusCode,401);
    const support = getCookie(await operatorSignIn(),'__Host-pamofi_staff_session');
    const supportCookie = support.name+'='+support.value;
    assert.equal((await request('GET','session',undefined,supportCookie)).json().role,'support');
    await db.query('DELETE FROM staff_onesa_bindings WHERE staff_id=$1',[staffId]);
    assert.equal((await request('GET','session',undefined,supportCookie)).statusCode,401);
    await db.query('INSERT INTO staff_onesa_bindings(issuer,subject,staff_id) VALUES($1,$2,$3)',[issuer,assertion.sub,staffId]);
    assert.equal((await request('GET','session',undefined,supportCookie)).statusCode,401);
  } finally {
    await db.query('DELETE FROM staff_users WHERE id=$1',[staffId]);
    assertion = initial;
  }
  issuerUnavailable = true;
  assert.equal((await request('GET','users',undefined,cookie)).statusCode,503);
  issuerUnavailable = false;
  assert.equal((await request('GET','users',undefined,cookie)).statusCode,200);
  assertion = { ...assertion, active: false };
  assert.equal((await request('GET','users',undefined,cookie)).statusCode,401);
  assertion.active = true;
  assert.equal((await request('GET','session',undefined,cookie)).statusCode,401,'Restoring a revoked Portal grant requires a fresh staff sign-in');
  assert.equal((await request('DELETE','session',undefined,cookie)).statusCode,204);
  assert.equal((await request('GET','users',undefined,cookie)).statusCode,401);
});

test('production direct staff credentials cannot establish or recover a local staff session', async t => {
  Object.assign(process.env, { APP_ENV:'production', NODE_ENV:'production', PUBLIC_ORIGIN:origin });
  const app = buildApp(); t.after(() => app.close());
  for (const [path, body] of [
    ['login',{email:'operator@example.invalid',password:'synthetic-secret-credential'}],
    ['register',{email:'operator@example.invalid',password:'synthetic-secret-credential',displayName:'Site Operator'}],
    ['password-reset/request',{email:'operator@example.invalid'}],
    ['mfa/setup',{}],
  ]) {
    const res=await app.inject({method:'POST',url:'/v1/staff/'+path,headers:{origin},payload:body});
    assert.equal(res.statusCode,403,res.body);
    assert.equal(res.json().error,'portal_sign_in_required');
    assert.equal(res.cookies.length,0);
  }
});
