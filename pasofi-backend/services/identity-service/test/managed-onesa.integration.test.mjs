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
    PASOFI_ONESA_SESSION_RENEWAL:'true',
  });
  const db = new pg.Pool({ connectionString:process.env.PAMOFI_TEST_DATABASE_URL });
  t.after(()=>db.end());
  await db.query('INSERT INTO customers(id) VALUES($1)',[customer]);
  await db.query('INSERT INTO customer_onesa_identities(issuer,subject,customer_id) VALUES($1,$2,$3)',[legacy,stable,customer]);
  await db.query("INSERT INTO staff_users(id,email,display_name,password_hash,status,role,site_ids) VALUES($1,$2,'Operator','disabled','approved','agent',$3)",
    [operator,operator+'@example.invalid',[site]]);
  await db.query('INSERT INTO staff_onesa_bindings(issuer,subject,staff_id) VALUES($1,$2,$3)',[legacy,stable,operator]);
  let app = buildApp(), outage = false, role = 'customer', extraRoles = [], globalRoles = [], products = ['pasofi'], aud = audience, factor = now(), query, lifetime = 300;
  let accessSubject = providerSubject, accountId=stable;
  let offerRefresh=false, refreshCalls=0, rejectRefresh=false;
  const refreshTokens=new Map();
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
    const sign=(claims,target,subject,ttl)=>new SignJWT(claims).setIssuer(issuer).setAudience(target).setSubject(subject)
      .setProtectedHeader({alg:'RS256',kid:'one'}).setIssuedAt(now()).setExpirationTime(now()+ttl).sign(privateKey);
    if(form.get('grant_type')==='refresh_token'){
      refreshCalls++;
      const used=form.get('refresh_token'), saved=refreshTokens.get(used);
      if(!saved||rejectRefresh)return Response.json({error:'invalid_grant'},{status:400});
      refreshTokens.delete(used);
      const rotated=randomUUID();refreshTokens.set(rotated,saved);
      return Response.json({token_type:'Bearer',access_token:await sign(saved,audience,providerSubject,300),refresh_token:rotated});
    }
    assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),query.get('code_challenge'));
    const claims={azp:clientId,[ns+'user_id']:accountId,[ns+'products']:products,[ns+'roles']:[role,...extraRoles],onesa_roles:globalRoles};
    const refresh = offerRefresh ? randomUUID() : undefined;
    if(refresh)refreshTokens.set(refresh,claims);
    return Response.json({token_type:'Bearer',access_token:await sign({
      ...claims,[ns+'mfa_time']:factor,
    },aud,accessSubject,lifetime),id_token:await sign({nonce:query.get('nonce'),auth_time:now()},clientId,providerSubject,300),refresh_token:refresh});
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
  const nativeToken = (azp) => new SignJWT({azp,[ns+'user_id']:accountId,[ns+'products']:products,[ns+'roles']:[role,...extraRoles],onesa_roles:globalRoles,[ns+'mfa_time']:factor})
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
  role='agent'; assert.equal((await login()).statusCode,401,'a site-operator grant cannot create a customer session');
  role='support'; assert.equal((await login()).statusCode,401,'a support grant cannot create a customer session');
  role='agent'; extraRoles=['admin']; globalRoles=[]; factor=now();
  assert.equal((await login(true)).statusCode,401,'an admin grant cannot fall through to an agent binding when roles are ordered agent first');
  extraRoles=['support'];
  assert.equal((await login(true)).statusCode,401,'multiple local staff roles are rejected as ambiguous');
  extraRoles=[];
  role='customer';
  role='agent';
  const agentNative=await nativeToken('pasofi_synthetic_ios');
  assert.equal((await request('POST','onesa/native-session',{platform:'ios',accessToken:agentNative})).statusCode,401,'a site-operator grant cannot create a native customer session');
  role='customer';
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
  role='admin';globalRoles=[];assert.equal((await login(true)).statusCode,401,'product-admin cannot use an agent binding');
  globalRoles=['global_admin'];factor=now();
  assert.equal((await login(true)).statusCode,401,'legacy global-admin cannot bypass the local product role approval');
  const personal=await login();
  assert.equal(personal.statusCode,200,'approved administrator can open the same personal customer account');
  assert.equal((await request('GET','session',undefined,cookie(personal,'demo_session'))).json().customerId,customer);
  accountId=randomUUID();
  const entry=await login(true);
  assert.equal(entry.statusCode,200,entry.body);
  const unbound=cookie(entry,'staff_session');
  const pending=await request('GET','staff/session',undefined,unbound);
  assert.equal(pending.json().status,'pending');
  assert.equal(pending.json().role,'admin');
  assert.deepEqual(pending.json().siteIds,[]);
  assert.equal((await request('GET','staff/users',undefined,unbound)).statusCode,403,'staff administration requires the separate resource approval');
  const firstCustomer=await login();
  assert.equal(firstCustomer.statusCode,200,firstCustomer.body);
  const separate=(await request('GET','session',undefined,cookie(firstCustomer,'demo_session'))).json().customerId;
  assert.ok(separate && separate!==customer);
  for(const platform of ['ios','android']){
    const token=await nativeToken(platform==='ios'?'pasofi_synthetic_ios':'pasofi_synthetic_android');
    const own=await request('POST','onesa/native-session',{platform,accessToken:token});
    assert.equal(own.statusCode,200,own.body);
    assert.equal(own.json().customerId,separate);
  }
  factor=now()-301;assert.equal((await login()).statusCode,401);
  factor=now();accountId=stable;
  globalRoles=[];
  await db.query("UPDATE staff_users SET role='admin',site_ids='{}',version=version+1 WHERE id=$1",[operator]);
  const approvedAdmin=await login(true);assert.equal(approvedAdmin.statusCode,200,approvedAdmin.body);
  const adminCookie=cookie(approvedAdmin,'staff_session');
  const adminSession=await request('GET','staff/session',undefined,adminCookie);
  assert.equal(adminSession.json().staffId,operator);
  assert.equal(adminSession.json().role,'admin');assert.deepEqual(adminSession.json().siteIds,[]);
  await db.query("UPDATE staff_users SET role='agent',site_ids=$2,version=version+1 WHERE id=$1",[operator,[site]]);
  assert.equal((await request('GET','staff/session',undefined,adminCookie)).statusCode,401,'a changed local approval retires the managed administrator session');
  role='customer';products=['pasofi','smart-farmer'];
  assert.equal((await login()).statusCode,401,'roles cannot be interpreted across multiple product namespaces');
  products=['pasofi'];
  role='agent';globalRoles=[];factor=now()-301;assert.equal((await login(true)).statusCode,401);
  factor=now();const staff=await login(true);assert.equal(staff.statusCode,200,staff.body);
  const staffCookie=cookie(staff,'staff_session');
  const me=await request('GET','staff/session',undefined,staffCookie);assert.equal(me.json().staffId,operator);assert.deepEqual(me.json().siteIds,[site]);
  assert.equal((await request('GET','staff/users',undefined,staffCookie)).statusCode,403);
  aud='https://other.example.invalid';assert.equal((await login()).statusCode,401);aud=audience;
  accessSubject='auth0|different';assert.equal((await login()).statusCode,401);accessSubject=providerSubject;
  role='customer';lifetime=1200;
  assert.equal((await login()).statusCode,200,'a longer provider TTL still gets a five-minute local authorization window');
  lifetime=300;offerRefresh=true;
  const member=await login();
  assert.equal(member.statusCode,200,member.body);
  assert.match(query.get('scope'),/\boffline_access\b/);
  const memberCookie=cookie(member,'demo_session');
  const freshHandoff=await request('POST','handoff',{},memberCookie);
  const secondBrowser=await request('POST','handoff/redeem',{handoffCode:freshHandoff.json().handoffCode});
  assert.equal(secondBrowser.statusCode,200,secondBrowser.body);
  const secondCookie=cookie(secondBrowser,'demo_session');
  const hash = browserCookie => createHash('sha256').update(browserCookie.split('=')[1]).digest();
  await db.query("UPDATE onesa_session_renewals SET access_expires_at=now()-interval '1 second' WHERE id=(SELECT renewal_id FROM customer_onesa_sessions WHERE token_hash=$1)",[hash(memberCookie)]);
  const concurrent=await Promise.all([memberCookie,secondCookie,memberCookie].map(proof=>request('GET','session',undefined,proof)));
  assert.ok(concurrent.every(result=>result.statusCode===200&&result.json().customerId===customer));
  assert.equal(refreshCalls,1,'a handoff and a browser share one rotating token');
  await db.query("UPDATE onesa_session_renewals SET access_expires_at=now()-interval '1 second' WHERE id=(SELECT renewal_id FROM customer_onesa_sessions WHERE token_hash=$1)",[hash(memberCookie)]);
  rejectRefresh=true;
  const expired=await request('GET','session',undefined,memberCookie);
  assert.equal(expired.json().error,'onesa_sign_in_required');
  assert.equal((await request('POST','session',undefined,memberCookie)).json().error,'onesa_sign_in_required');
  rejectRefresh=false;role='agent';factor=now();
  const operatorLogin=await login(true);
  assert.equal(operatorLogin.statusCode,200,operatorLogin.body);
  const operatorCookie=cookie(operatorLogin,'staff_session');
  await db.query("UPDATE onesa_session_renewals SET access_expires_at=now()-interval '1 second',staff_mfa_at=now()-interval '6 minutes' WHERE id=(SELECT renewal_id FROM staff_onesa_sessions WHERE token_hash=$1)",[hash(operatorCookie)]);
  const operationCredential=await new SignJWT({scope:'staff:resolve'}).setProtectedHeader({alg:'HS256'})
    .setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('identity').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(process.env.INTERNAL_IDENTITY_SECRET || 'fixture-secret-identity-scope-123456789'));
  process.env.INTERNAL_IDENTITY_SECRET ??= 'fixture-secret-identity-scope-123456789';
  const currentStaff=await app.inject({url:'/internal/v1/staff/session',headers:{cookie:operatorCookie,authorization:'Bearer '+operationCredential}});
  assert.equal(currentStaff.statusCode,200,currentStaff.body);
  assert.ok(Date.now()-Date.parse(currentStaff.json().mfaVerifiedAt)>300000,'token renewal does not make the operator MFA fresh again');
  offerRefresh=false;
  process.env.SESSION_CREATION_SECRET='DEMO_ONLY_isolated_guest_claim_secret_123456789';
  const guestRequest=await app.inject({method:'POST',url:'/v1/session',headers:{origin,'idempotency-key':randomBytes(32).toString('base64url')}});
  assert.equal(guestRequest.statusCode,201,guestRequest.body);
  const guestCookie=cookie(guestRequest,'demo_session'), guestId=guestRequest.json().customerId;
  const claimGuest = async () => {
    const started=await request('POST','onesa/start',{claimGuest:true,returnTo:'/#history'},guestCookie);
    assert.equal(started.statusCode,200,started.body);
    query=new URL(started.json().authorizationUrl).searchParams;
    assert.equal(query.get('prompt'),'login');
    assert.equal(query.get('max_age'),'0');
    return request('POST','onesa/complete',{code:'claim',state:query.get('state')},
      [guestCookie,cookie(started,'onesa_customer_flow')].join('; '));
  };
  role='customer';accountId=stable;
  assert.equal((await claimGuest()).json().error,'guest_transfer_requires_review');
  assert.equal((await request('GET','session',undefined,guestCookie)).json().customerId,guestId);
  accountId=randomUUID();
  const mergedGuest=await claimGuest();
  assert.equal(mergedGuest.statusCode,200,mergedGuest.body);
  assert.equal(mergedGuest.json().customerId,guestId);
  assert.equal((await request('GET','session',undefined,guestCookie)).statusCode,401);
  assert.equal((await request('GET','session',undefined,cookie(mergedGuest,'demo_session'))).json().guest,false);
  accountId=stable;
  await app.close();app=buildApp();outage=true;
  assert.equal((await request('GET','session',undefined,browser)).json().customerId,customer);
  assert.equal((await request('GET','staff/session',undefined,staffCookie)).json().staffId,operator);
  assert.equal((await request('POST','onesa/start',{})).statusCode,503);
  await db.query("UPDATE customer_onesa_sessions SET expires_at=now()-interval '1 second' WHERE customer_id=$1",[customer]);
  assert.equal((await request('GET','session',undefined,browser)).statusCode,401);
  assert.equal((await db.query('SELECT customer_id FROM customer_onesa_identities WHERE issuer=$1 AND subject=$2',[legacy,stable])).rows[0].customer_id,customer);
});
