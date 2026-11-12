// Disposable HTTPS issuer for the Compose labs. Only the fixture container can
// select a simulated MFA identity; production service images never load it.
import assert from 'node:assert/strict';
import https from 'node:https';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const issuer = 'https://portal.pamofi.test:8443/api/v1/identity';
export const clientId = 'synthetic_pasofi_production_lab';
export const callback = 'https://pamofi.test/onesa-callback.html';
export const agentSubject = '546af9ce-4491-4c60-97cf-32b117efc47a';
const subjects = { admin:'31a7df94-a5a9-41d1-99a5-3a9dab083a2c', agent:agentSubject };
const opaque = () => randomBytes(32).toString('base64url');

export async function signIn(request, profile, expectedStatus = 200) {
  const start = await request('/api/staff/onesa/start', {method:'POST',body:{}});
  assert.equal(start.status,200,start.text);
  const authorization = new URL(JSON.parse(start.text).authorizationUrl);
  assert.equal(authorization.origin + authorization.pathname,issuer + '/auth');
  assert.equal(authorization.searchParams.get('redirect_uri'),callback);
  assert.equal(authorization.searchParams.get('acr_values'),'urn:onesa:mfa');
  assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');
  const browser = start.headers['set-cookie'].find(value => value.startsWith('__Host-pasofi_onesa_flow='));
  assert.match(browser,/; Secure/i);
  assert.match(browser,/; HttpOnly/i);
  const raw = execFileSync('docker', ['compose','-p',process.env.PASOFI_LAB_PROJECT,'-f',process.env.PASOFI_LAB_COMPOSE,
    'exec','-T','lab-portal','node','/opt/lab-portal.mjs','authorize',profile], {
    input:authorization.href, encoding:'utf8', timeout:10000,
  });
  const returned = new URL(raw.trim());
  assert.equal(returned.origin + returned.pathname,callback);
  assert.equal(returned.searchParams.get('state'),authorization.searchParams.get('state'));
  const payload = Object.fromEntries(returned.searchParams);
  const complete = {method:'POST', body:payload, cookie:browser.split(';')[0]};
  assert.equal((await request('/api/staff/onesa/complete',{method:'POST',body:payload})).status,401);
  const response = await request('/api/staff/onesa/complete',complete);
  assert.equal(response.status,expectedStatus,response.text);
  assert.equal((await request('/api/staff/onesa/complete',complete)).status,401);
  if (expectedStatus !== 200) return;
  const session = response.headers['set-cookie'].find(value => value.startsWith('__Host-pamofi_staff_session='));
  assert.match(session,/; Secure/i);
  assert.match(session,/; HttpOnly/i);
  const cookie = session.split(';')[0];
  const current = await request('/api/staff/session',{cookie});
  assert.equal(current.status,200,current.text);
  return { cookie, data:JSON.parse(current.text), response };
}

export function portalServer({ key, cert, secret, selection, issuerUrl = issuer }) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk = {...publicKey.export({format:'jwk'}),alg:'RS256',use:'sig',kid:'fixture'};
  const codes = new Map(), tokens = new Map();
  return https.createServer({key,cert}, async (request, response) => {
    function json(status, data) { response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(data)); }
    try {
      const url = new URL(request.url, issuerUrl);
      const endpoint = url.origin + url.pathname;
      const now = Math.floor(Date.now()/1000);
      if (request.method === 'GET' && endpoint === issuerUrl + '/jwks') return json(200,{keys:[jwk]});
      if (request.method === 'GET' && endpoint === issuerUrl + '/auth') {
        const q = url.searchParams, profile = request.headers['x-lab-profile'];
        assert.equal(request.headers.authorization,'Bearer ' + selection);
        assert.ok(Object.hasOwn(subjects,profile));
        assert.equal(q.get('client_id'),clientId);
        assert.equal(q.get('redirect_uri'),callback);
        assert.equal(q.get('acr_values'),'urn:onesa:mfa');
        assert.equal(q.get('code_challenge_method'),'S256');
        const code = opaque();
        codes.set(code,{profile,nonce:q.get('nonce'),challenge:q.get('code_challenge'),exp:now+120});
        const redirect = new URL(callback);
        for (const [name,value] of Object.entries({code,state:q.get('state'),iss:issuerUrl})) redirect.searchParams.set(name,value);
        response.writeHead(302,{location:redirect.href,'cache-control':'no-store'}).end();
        return;
      }
      assert.equal(request.method,'POST');
      const authentication = request.headers.authorization || '';
      assert.ok(authentication.startsWith('Basic '));
      assert.deepEqual(Buffer.from(authentication.slice(6),'base64').toString().split(':').map(decodeURIComponent),[clientId,secret]);
      let body = '';
      for await (const chunk of request) { body += chunk; assert.ok(body.length <= 8192); }
      if (endpoint === issuerUrl + '/token') {
        const form = new URLSearchParams(body), code = form.get('code'), flow = codes.get(code);
        codes.delete(code);
        assert.ok(flow && flow.exp > now);
        assert.equal(form.get('redirect_uri'),callback);
        assert.equal(form.get('grant_type'),'authorization_code');
        assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'),flow.challenge);
        const admin = flow.profile === 'admin';
        const claims = {sub:subjects[flow.profile],iss:issuerUrl,aud:clientId,auth_time:now,iat:now,exp:now+600};
        const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
        const input = part({alg:'RS256',kid:'fixture'}) + '.' + part({...claims,nonce:flow.nonce});
        const token = opaque();
        tokens.set(token,{...claims,active:true,email_verified:true,email:flow.profile+'@pamofi.invalid',name:'Lab '+flow.profile,
          amr:['pwd','otp'],onesa_applications:['pasofi'],onesa_roles:[admin?'global_admin':'member'],onesa_product_roles:{pasofi:admin?'admin':'customer'}});
        return json(200,{access_token:token,token_type:'Bearer',expires_in:600,id_token:input+'.'+sign('sha256',Buffer.from(input),privateKey).toString('base64url')});
      }
      assert.equal(endpoint,issuerUrl + '/session');
      const claims = tokens.get(JSON.parse(body).token);
      return json(200,claims?.exp > now ? claims : {active:false});
    } catch { if (!response.headersSent) json(400,{error:'invalid_request'}); else response.end(); }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  assert.equal(process.env.PASOFI_LAB_ISSUER,'disposable-compose-only');
  const selection = (await readFile('/run/secrets/lab_portal_selection','utf8')).trim();
  if (process.argv[2] === 'authorize') {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const target = new URL(input);
    assert.equal(target.origin + target.pathname,issuer + '/auth');
    const profile = process.argv[3];
    assert.ok(Object.hasOwn(subjects,profile));
    const res = await fetch(target,{redirect:'manual',headers:{authorization:'Bearer '+selection,'x-lab-profile':profile},signal:AbortSignal.timeout(5000)});
    assert.equal(res.status,302);
    console.log(res.headers.get('location'));
  } else {
    assert.equal(process.argv[2],'serve');
    const server = portalServer({key:await readFile('/run/secrets/public_tls_key'),cert:await readFile('/run/secrets/public_tls_cert'),
      secret:(await readFile('/run/secrets/pasofi_onesa_client_secret','utf8')).trim(),selection});
    server.listen(8443,'0.0.0.0');
  }
}
