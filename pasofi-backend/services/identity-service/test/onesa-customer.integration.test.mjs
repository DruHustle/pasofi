import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { SignJWT, exportJWK } from 'jose';
import { buildApp } from '../dist/app.js';
import { customerAssertion, customerReturnTo } from '../dist/onesa-customer.js';
import pg from 'pg';

const issuer = 'https://portal.example.invalid/api/v1/identity', origin = 'https://pasofi.example.invalid';
const clientId = 'synthetic_pasofi_staff', clientSecret = randomBytes(48).toString('hex');
const now = Math.floor(Date.now() / 1000);
function active() {
  return { active: true, iss: issuer, aud: clientId, sub: randomUUID(), email_verified: true,
    email: 'admin@example.invalid', name: 'Test administrator', exp: now + 600, auth_time: now,
    amr: ['pwd'], onesa_roles: ['member'], onesa_product_roles: { pasofi: 'customer' }, onesa_applications: ['pasofi'] };
}

test('customer assertions require an approved PasoFi grant without elevating it to staff', () => {
  const input = active();
  assert.equal(customerAssertion(input, { issuer, clientId }, now).subject, input.sub);
  for (const changed of [{ active: false }, { email_verified: false }, { onesa_product_roles: { pasofi: 'admin' } },
    { aud: 'another-client' }, { iss: 'https://elsewhere.invalid' }, { onesa_product_roles: { pasofi: 'viewer' } },
    { onesa_applications: ['mobile'] }, { exp: now }, { auth_time: now - 28800 }]) {
    assert.throws(() => customerAssertion({ ...input, ...changed }, { issuer, clientId }, now));
  }
});

test('customer login binds browser and persistent subject; revocation, expiry and sign-out fence access', { skip: !process.env.PAMOFI_TEST_DATABASE_URL }, async (t) => {
  Object.assign(process.env, { DATABASE_URL: process.env.PAMOFI_TEST_DATABASE_URL, PUBLIC_ORIGIN: origin,
    APP_ENV: 'demo', NODE_ENV: 'development', STAFF_MFA_ENCRYPTION_KEY: 'cd'.repeat(32), PASOFI_ONESA_CLIENT_ID: clientId,
    PASOFI_ONESA_CLIENT_SECRET: clientSecret, PASOFI_ONESA_ISSUER: issuer, PASOFI_ONESA_REDIRECT_URI: origin + '/onesa-callback.html' });
  const app = buildApp();
  t.after(() => app.close());
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let assertion = active(), authQuery, tokenCalls = 0, providerOutage = false;
  const token = randomBytes(32).toString('hex');
  const request = (method, path, payload, cookie) => app.inject({ method, url: '/v1/' + path,
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
    return providerOutage ? new Response('unavailable',{status:503}) : Response.json(assertion);
  });
  const availability = await request('GET','onesa/availability');
  assert.deepEqual(availability.json(), { origin, handoff: true });
  const start = await request('POST','onesa/start',{returnTo:'/#wifi'});
  assert.equal(start.statusCode,200);
  authQuery = new URL(start.json().authorizationUrl).searchParams;
  assert.equal(authQuery.has('acr_values'), false);
  assert.equal(authQuery.get('code_challenge_method'), 'S256');
  const flow = getCookie(start, 'pasofi_demo_onesa_customer_flow'), flowCookie = flow.name + '=' + flow.value;
  const params = { state: authQuery.get('state'), code: 'synthetic-code', iss: issuer };
  assert.equal((await request('POST','onesa/complete',params)).statusCode,401);
  assert.equal(tokenCalls,0);
  const verified = await request('POST','onesa/complete',params,flowCookie);
  assert.equal(verified.statusCode,200,verified.body);
  assert.equal((await request('POST','onesa/complete',params,flowCookie)).statusCode,401);
  assert.equal(tokenCalls,1);
  const session = getCookie(verified,'pamofi_demo_session'), cookie = session.name + '=' + session.value;
  const loggedIn = await request('GET','session',undefined,cookie);
  assert.equal(loggedIn.statusCode,200,loggedIn.body);
  const customerId = loggedIn.json().customerId;
  assert.equal(verified.json().customerId,customerId);
  assert.equal(verified.json().returnTo,'/#wifi');
  assert.equal((await request('GET','staff/users',undefined,cookie)).statusCode,401);
  assert.equal((await request('POST','recovery/setup',{},cookie)).statusCode,409);
  assert.deepEqual((await request('GET','recovery/status',undefined,cookie)).json(),{configured:false,authentication:'onesa'});
  const pool = new pg.Pool({connectionString:process.env.PAMOFI_TEST_DATABASE_URL});
  t.after(()=>pool.end());
  const issue = async () => {
    const result=await request('POST','handoff',{},cookie);
    assert.equal(result.statusCode,201,result.body);
    assert.equal(result.json().continueUrl,origin+'/handoff');
    assert.ok(result.json().expiresIn>0&&result.json().expiresIn<=120);
    return result.json().handoffCode;
  };
  const redeem = code => request('POST','handoff/redeem',{handoffCode:code});
  const transfer=await issue();
  const raced=await Promise.all([redeem(transfer),redeem(transfer)]);
  assert.deepEqual(raced.map(r=>r.statusCode).sort(),[200,401],'exactly one concurrent transfer wins');
  const winner=raced.find(r=>r.statusCode===200), native=getCookie(winner,'pamofi_demo_session');
  const nativeCookie=native.name+'='+native.value;
  assert.notEqual(native.value,session.value,'native receives an independent cookie');
  assert.deepEqual(winner.json(),{customerId});
  assert.equal((await request('GET','session',undefined,nativeCookie)).json().customerId,customerId);
  assert.equal((await pool.query('SELECT 1 FROM customer_sessions WHERE customer_id=$1',[customerId])).rowCount,0);
  const another=await issue();
  assert.equal((await request('POST','handoff/redeem',{handoffCode:another},nativeCookie)).statusCode,409,'cannot replace an existing native identity');
  assert.equal((await redeem(another)).statusCode,200,'conflict leaves the code usable');
  const retry=await issue();
  providerOutage=true;
  assert.equal((await redeem(retry)).statusCode,503,'outage never mints a session');
  providerOutage=false;
  assert.equal((await redeem(retry)).statusCode,200,'outage does not consume a valid code');
  const expired=await issue();
  await pool.query("UPDATE customer_onesa_handoffs SET expires_at=now()-interval '1 second' WHERE code_hash=$1",[createHash('sha256').update(expired).digest()]);
  assert.equal((await redeem(expired)).statusCode,401);
  const revoked=await issue();
  assertion.active=false;
  assert.equal((await redeem(revoked)).statusCode,401,'provider revocation fences native transfer');
  assertion.active=true;
  assert.equal((await request('GET','session',undefined,cookie)).statusCode,401,'observed invalid transfer permanently revokes its source');
  const originalSubject=assertion.sub;
  assertion.sub=randomUUID();
  assert.equal((await request('GET','session',undefined,nativeCookie)).statusCode,401,'subject substitution revokes native session');
  assertion.sub=originalSubject;
  assert.equal((await request('GET','session',undefined,nativeCookie)).statusCode,401,'restored subject cannot revive observed invalid native session');
  assertion = { ...assertion, active: false };
  assert.equal((await request('GET','session',undefined,cookie)).statusCode,401);
  assert.equal((await request('POST','session',{},cookie)).statusCode,401,'revocation cannot downgrade to a newly created guest');
  assertion.active = true;
  assert.equal((await request('GET','session',undefined,cookie)).statusCode,401,'restored grants cannot revive a locally rejected session');
  const originalExpiry = assertion.exp;
  assertion.exp = now;
  assert.equal((await request('GET','session',undefined,cookie)).statusCode,401);
  assertion.exp = originalExpiry;
  assert.equal((await request('DELETE','session',undefined,cookie)).statusCode,204);
  assert.equal((await request('GET','session',undefined,cookie)).statusCode,401);
  const again = await request('POST','onesa/start',{returnTo:'https://attacker.invalid'});
  authQuery = new URL(again.json().authorizationUrl).searchParams;
  const flow2 = getCookie(again,'pasofi_demo_onesa_customer_flow');
  const second = await request('POST','onesa/complete',{state:authQuery.get('state'),code:'second-code',iss:issuer},flow2.name+'='+flow2.value);
  assert.equal(second.statusCode,200,second.body);
  assert.equal(second.json().customerId,customerId);
  assert.equal(second.json().returnTo,'/#account');
  const secondSession=getCookie(second,'pamofi_demo_session'), secondCookie=secondSession.name+'='+secondSession.value;
  const cancelled=await request('POST','handoff',{},secondCookie);
  assert.equal(cancelled.statusCode,201,cancelled.body);
  assert.equal((await request('DELETE','session',undefined,secondCookie)).statusCode,204);
  assert.equal((await request('POST','handoff/redeem',{handoffCode:cancelled.json().handoffCode})).statusCode,401,'source logout invalidates an outstanding native transfer');
  {
    const mapping=await pool.query('SELECT customer_id FROM customer_onesa_identities WHERE issuer=$1 AND subject=$2',[issuer,assertion.sub]);
    assert.equal(mapping.rowCount,1);assert.equal(mapping.rows[0].customer_id,customerId);
    assert.equal((await pool.query('SELECT 1 FROM customer_sessions WHERE customer_id=$1',[customerId])).rowCount,0,'legacy runtime cannot resolve a federated cookie after rollback');
    // Recovery/handoff must never mint a session which bypasses the Portal check.
    const fallback=randomBytes(32).toString('base64url');
    await pool.query("INSERT INTO customer_sessions(token_hash,customer_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[createHash('sha256').update(fallback).digest(),customerId]);
    assert.equal((await request('GET','session',undefined,'pamofi_demo_session='+fallback)).statusCode,401);
  }
});

test('customer destinations cannot redirect outside PasoFi',()=>{
 for(const value of ['https://attacker.invalid','//attacker.invalid','/#staff','/#wifi%0a','/#wifi?private=token',null])assert.equal(customerReturnTo(value),'/#account');
 assert.equal(customerReturnTo('/#checkout?bundle=week'),'/#checkout?bundle=week');
});
