// Called only by the disposable production lab; never point this at production.
import assert from 'node:assert/strict';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
const [port, secrets] = process.argv.slice(2);
assert.ok(/^\d+$/.test(port) && secrets?.includes('pamofi-production-lab-'));
const host = 'api.pamofi.test', origin = `https://${host}`;
const ca = await readFile(join(secrets, 'internal_ca'));
const key = randomBytes(32).toString('base64url');
let checks = 0;
function check(actual, expected, message) { assert.equal(actual, expected, message); checks++; }
function request(path, { method = 'GET', body, cookie, requestOrigin = origin, extraHeaders = {}, trust = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request({ hostname: '127.0.0.1', port: Number(port), servername: host,
      path, method, ca: trust ? ca : [], rejectUnauthorized: true, timeout: 10000,
      headers: { host, origin: requestOrigin, ...(cookie ? { cookie } : {}), ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'idempotency-key': key }), ...extraHeaders },
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', data => { size += data.length; if (size > 4_000_000) response.destroy(Error('Unexpected response size')); else chunks.push(data); });
      response.on('error', reject);
      response.on('end', () => { const bytes = Buffer.concat(chunks); resolve({ status: response.statusCode, headers: response.headers, text: bytes.toString('utf8'), bytes }); });
    });
    req.on('timeout', () => req.destroy(Error('Portal qualification timed out'))); req.on('error', reject); req.end(payload);
  });
}
await assert.rejects(request('/connect', { trust: false })); checks++;
const page = await request('/connect'); check(page.status, 200); assert.match(page.headers['content-type'], /text\/html/);
assert.match(page.headers['content-security-policy'], /form-action 'self' https:\/\/hotspot\.pasofi\.onesa\.eu/);
for (const asset of page.text.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)) {
  const response = await request(asset[1]); check(response.status, 200, `portal asset ${asset[1]}`);
  if (asset[1].endsWith('.js')) { assert.ok(response.text.includes('/portal-api/'), 'frontend must use its matching public prefix'); checks++; }
}
for (const [path, type, signature] of [
  ['/favicon.svg', /^image\/svg\+xml/, Buffer.from('<svg')],
  ['/favicon.ico', /^image\/(?:x-icon|vnd\.microsoft\.icon)/, Buffer.from([0, 0, 1, 0, 3, 0])],
  ['/apple-touch-icon.png', /^image\/png/, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])],
]) {
  assert.ok(page.text.includes(`href="${path}"`), `portal declares ${path}`); checks++;
  const icon = await request(path); check(icon.status, 200, `anonymous portal icon ${path}`);
  assert.match(icon.headers['content-type'], type); checks++;
  assert.deepEqual(icon.bytes.subarray(0, signature.length), signature); checks++;
  check(icon.headers['set-cookie'], undefined, 'static icon never creates a customer account');
}
for (const path of ['/favicon.svg/private', '/favicon.ico/private', '/apple-touch-icon.png/private', '/favicon-secret.svg']) check((await request(path)).status, 404, 'icon allowlist is exact');
for (const path of ['/internal/v1/session', '/v1/session', '/portal-api/internal/v1/session', '/portal-api/no-such-route', '/hotspot-build.json', '/run/secrets/vercel_proxy_token']) check((await request(path)).status, 404, path);
for (const path of ['/api/session', '/api/capabilities']) check((await request(path)).status, 403, 'Vercel boundary remains credential-protected');
check((await request('/portal-api/session')).status, 401);
for (const path of ['/portal-api/bundles', '/portal-api/capabilities', '/portal-api/help']) check((await request(path)).status, 200, path);
assert.deepEqual(JSON.parse((await request('/portal-api/help?q=unfindable%20qualification%2Bquery')).text).articles, []); checks++;
check((await request('/portal-api/session', { method: 'POST', body: {}, requestOrigin: 'https://attacker.invalid' })).status, 403, 'cross-origin creation denied');
check((await request('/portal-api/session', { method: 'POST', body: { padding: 'x'.repeat(40000) } })).status, 413, 'bounded request body');
let response = await request('/portal-api/session', { method: 'POST', body: {} }); check(response.status, 201);
const customer = JSON.parse(response.text).customerId;
const setCookie = response.headers['set-cookie'].find(value => value.startsWith('__Host-pamofi_session='));
assert.match(setCookie, /;\s*Secure/); assert.match(setCookie, /;\s*HttpOnly/); assert.match(setCookie, /;\s*SameSite=Lax/); assert.doesNotMatch(setCookie, /;\s*Domain=/); checks += 4;
const cookie = setCookie.split(';')[0];
response = await request('/portal-api/session', { method: 'POST', body: {} }); check(response.status, 200); check(JSON.parse(response.text).customerId, customer, 'lost response replays the same customer');
check((await request('/portal-api/session', { cookie })).status, 200);
check((await request('/portal-api/access', { cookie })).status, 200, 'prepaid accepts the explicit portal origin and identity');
check((await request('/portal-api/staff/session', { cookie })).status, 401, 'customer cookie grants no staff authority');
// Forging every proxy header cannot produce independent public caller limits.
let limited = false;
for (let i = 1; i <= 21; i++) {
  response = await request('/portal-api/session', { method: 'POST', body: {}, extraHeaders: {
    'x-pamofi-client-ip': `203.0.113.${i}`, 'x-forwarded-for': `198.51.100.${i}`, 'x-real-ip': `192.0.2.${i}`,
    'x-vercel-forwarded-for': `203.0.113.${i}`, forwarded: `for=203.0.113.${i}`, 'x-pamofi-proxy-token': 'a'.repeat(64),
  } });
  if (response.status === 429) { limited = true; break; }
  check(response.status, 200); check(JSON.parse(response.text).customerId, customer);
}
check(limited, true, 'forged headers must not bypass the original-peer rate limit');
response = await request('/portal-api/session', { method: 'DELETE', cookie }); check(response.status, 204);
check((await request('/portal-api/session', { cookie })).status, 401);
console.log(`Dedicated hotspot portal passed ${checks} checks: trusted TLS, actual built assets, exact API routing, real idempotent account/cookies, CSRF, staff isolation, original-peer rate limits and logout.`);
