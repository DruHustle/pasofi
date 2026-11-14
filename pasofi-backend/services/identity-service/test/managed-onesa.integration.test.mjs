import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { SignJWT, exportJWK } from 'jose';
import pg from 'pg';
import { buildApp } from '../dist/app.js';

test('managed PasoFi preserves customer and operator bindings, audience, MFA and outage expiry', {
  skip: !process.env.PAMOFI_TEST_DATABASE_URL,
}, async t => {
  const issuer = 'https://auth.example.invalid/', legacy = 'https://portal.example.invalid/api/v1/identity';
  const audience = 'https://api.pasofi.example.invalid', origin = 'https://pasofi.example.invalid';
  const clientId = 'pasofi_isolated_client';
  const stable = randomUUID(), customer = randomUUID(), operator = randomUUID(), providerSubject = 'auth0|' + randomUUID();
  const site = randomUUID(), now = () => Math.floor(Date.now() / 1000);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwks = { keys: [{ ...await exportJWK(publicKey), alg: 'RS256', use: 'sig', kid: 'one' }] };
  Object.assign(process.env, {
    APP_ENV:'demo',NODE_ENV:'development',PUBLIC_ORIGIN:origin,DATABASE_URL:process.env.PAMOFI_TEST_DATABASE_URL,
    STAFF_MFA_ENCRYPTION_KEY:'ab'.repeat(32),PASOFI_ONESA_MODE:'managed',PASOFI_ONESA_ISSUER:issuer,
    PASOFI_ONESA_RECORD_ISSUER:legacy,PASOFI_ONESA_CLIENT_ID:clientId,PASOFI_ONESA_CLIENT_SECRET:randomBytes(48).toString('hex'),
    PASOFI_ONESA_IOS_CLIENT_ID:'pasofi_synthetic_ios',PASOFI_ONESA_ANDROID_CLIENT_ID:'pasofi_synthetic_android',
    PASOFI_ONESA_REDIRECT_URI:origin+'/onesa-callback.html',PASOFI_ONESA_AUDIENCE:audience,PASOFI_ONESA_PUBLIC_JWKS:JSON.stringify(jwks),
  });
  const db = new pg.Pool({ connectionString:process.env.PAMOFI_TEST_DATABASE_URL });
  t.after(()=>db.end());
  await db.query('INSERT INTO customers(id) VALUES($1)',[customer]);
  await db.query('INSERT INTO customer_onesa_identities(issuer,subject,customer_id) VALUES($1,$2,$3)',[legacy,stable,customer]);
  await db.query("INSERT INTO staff_users(id,email,display_name,password_hash,status,role,site_ids) VALUES($1,$2,'Operator','disabled','approved','agent',$3)",
    [operator,operator+'@example.invalid',[site]]);
  await db.query('INSERT INTO staff_onesa_bindings(issuer,subject,staff_id) VALUES($1,$2,$3)',[legacy,stable,operator]);
  let app = buildApp(), outage = false, role = 'customer', aud = audience, factor = now(), query, lifetime = 300;
  let accessSubject = providerSubject;
  t.after(()=>app.close());
  const ns = 'https://onesa.eu/claims/';
  const order = randomUUID();
  let prepaid;
  if (process.env.PAMOFI_TEST_PREPAID_DATABASE_URL) {
    const ledger = new pg.Pool({connectionString:process.env.PAMOFI_TEST_PREPAID_DATABASE_URL});
    await ledger.query(`INSERT INTO purchase_orders (id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at)
      VALUES ($1,$2,$3,'flex',100,'USD',1048576,86400,'payment_confirmed',now()-interval '1 day')`, [order,customer,randomUUID()]);
    await ledger.end();
    const {buildApp:buildPrepaid} = await import('../../prepaid-access-service/dist/app.js');
    const identityDatabase = process.env.DATABASE_URL;
    process.env.DATABASE_URL = process.env.PAMOFI_TEST_PREPAID_DATABASE_URL;
    prepaid = buildPrepaid();
    await prepaid.ready();
    process.env.DATABASE_URL = identityDatabase;
    process.env.IDENTITY_URL = 'http://127.0.0.1:19090';
    process.env.INTERNAL_IDENTITY_SECRET = randomBytes(32).toString('hex');
    t.after(()=>prepaid.close());
  }
  t.mock.method(globalThis,'fetch', async (url,init)=>{
    if (String(url) === 'http://127.0.0.1:19090/internal/v1/session') {
      const response = await app.inject({method:'GET',url:'/internal/v1/session',headers:init.headers});
      return new Response(response.body,{status:response.statusCode,headers:{'content-type':'application/json'}});
    }
    if(outage) throw Error('isolated issuer unavailable');
    if(String(url)===issuer+'.well-known/openid-configuration') return Response.json({
      issuer,authorization_endpoint:issuer+'authorize',token_endpoint:issuer+'oauth/token',jwks_uri:issuer+'keys',
      response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],
    });
    if(String(url)===issuer+'keys') return Response.json(jwks);
    assert.equal(String(url),issuer+'oauth/token');
    const form=new URLSearchParams(init.body);
    assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),query.get('code_challenge'));
    const sign=(claims,target,subject,ttl)=>new SignJWT(claims).setIssuer(issuer).setAudience(target).setSubject(subject)
      .setProtectedHeader({alg:'RS256',kid:'one'}).setIssuedAt(now()).setExpirationTime(now()+ttl).sign(privateKey);
    return Response.json({token_type:'Bearer',access_token:await sign({
      [ns+'user_id']:stable,[ns+'products']:['pasofi'],[ns+'roles']:[role],[ns+'mfa_time']:factor,
    },aud,accessSubject,lifetime),id_token:await sign({nonce:query.get('nonce'),auth_time:now()},clientId,providerSubject,300)});
  });
  const request=(method,path,payload,cookie)=>app.inject({method,url:'/v1/'+path,headers:{origin,...(cookie?{cookie}:{})},...(payload?{payload}:{})});
  const cookie=(response,part)=>{ const c=response.cookies.find(c=>c.name.endsWith(part)); return c.name+'='+c.value; };
  async function login(staff=false) {
    const prefix=staff?'staff/onesa/':'onesa/';
    const start=await request('POST',prefix+'start',staff?{}:{returnTo:'/#history'});
    assert.equal(start.statusCode,200,start.body);
    query=new URL(start.json().authorizationUrl).searchParams;
    assert.equal(query.get('audience'),audience); assert.equal(query.get('code_challenge_method'),'S256');
    if(staff) assert.equal(query.get('acr_values'),'http://schemas.openid.net/pape/policies/2007/06/multi-factor');
    return request('POST',prefix+'complete',{code:'synthetic',state:query.get('state')},cookie(start,staff?'onesa_flow':'onesa_customer_flow'));
  }
  const nativeToken = (azp) => new SignJWT({azp,[ns+'user_id']:stable,[ns+'products']:['pasofi'],[ns+'roles']:['customer']})
    .setIssuer(issuer).setAudience(audience).setSubject(providerSubject).setProtectedHeader({alg:'RS256',kid:'one'}).setIssuedAt(now()).setExpirationTime(now()+300).sign(privateKey);
  for(const platform of ['ios','android']) {
    const token=await nativeToken(platform==='ios'?'pasofi_synthetic_ios':'pasofi_synthetic_android');
    const native=await request('POST','onesa/native-session',{platform,accessToken:token});
    assert.equal(native.statusCode,200,native.body); assert.equal(native.json().customerId,customer);
    const saved=cookie(native,'demo_session');
    assert.equal((await request('GET','session',undefined,saved)).json().customerId,customer);
    assert.equal((await request('GET','staff/session',undefined,saved)).statusCode,401);
    if (prepaid) {
      const history = await prepaid.inject({method:'GET',url:'/v1/orders',headers:{cookie:saved}});
      assert.equal(history.statusCode,200,history.body);
      assert.equal(history.json().customerId,customer);
      assert.deepEqual(history.json().orders.map(item=>[item.id,item.status]),[[order,'payment_confirmed']]);
    }
    assert.equal((await request('POST','onesa/native-session',{platform,accessToken:token},saved)).statusCode,409);
    assert.equal((await request('POST','onesa/native-session',{platform:platform==='ios'?'android':'ios',accessToken:token})).statusCode,401);
  }
  const good=await login();
  assert.equal(good.statusCode,200,good.body);
  assert.equal(good.json().customerId,customer); assert.equal(good.json().returnTo,'/#history');
  assert.equal((await login()).json().customerId,customer);
  const browser=cookie(good,'demo_session');
  const handoff=await request('POST','handoff',{},browser);
  assert.equal(handoff.statusCode,201,handoff.body);
  const redeemed=await request('POST','handoff/redeem',{handoffCode:handoff.json().handoffCode});
  assert.equal(redeemed.json().customerId,customer);assert.equal((await request('POST','handoff/redeem',{handoffCode:handoff.json().handoffCode})).statusCode,401);
  assert.equal((await login(true)).statusCode,401);
  role='admin';assert.equal((await login(true)).statusCode,401);
  role='agent';factor=now()-301;assert.equal((await login(true)).statusCode,401);
  factor=now();const staff=await login(true);assert.equal(staff.statusCode,200,staff.body);
  const staffCookie=cookie(staff,'staff_session');
  const me=await request('GET','staff/session',undefined,staffCookie);assert.equal(me.json().staffId,operator);assert.deepEqual(me.json().siteIds,[site]);
  assert.equal((await request('GET','staff/users',undefined,staffCookie)).statusCode,403);
  aud='https://other.example.invalid';assert.equal((await login()).statusCode,401);aud=audience;
  accessSubject='auth0|different';assert.equal((await login()).statusCode,401);accessSubject=providerSubject;
  lifetime=301;assert.equal((await login()).statusCode,401);lifetime=300;
  await app.close();app=buildApp();outage=true;
  assert.equal((await request('GET','session',undefined,browser)).json().customerId,customer);
  assert.equal((await request('GET','staff/session',undefined,staffCookie)).json().staffId,operator);
  assert.equal((await request('POST','onesa/start',{})).statusCode,503);
  await db.query("UPDATE customer_onesa_sessions SET expires_at=now()-interval '1 second' WHERE customer_id=$1",[customer]);
  assert.equal((await request('GET','session',undefined,browser)).statusCode,401);
  assert.equal((await db.query('SELECT customer_id FROM customer_onesa_identities WHERE issuer=$1 AND subject=$2',[legacy,stable])).rows[0].customer_id,customer);
});
