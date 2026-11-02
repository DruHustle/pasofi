import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';

const [tlsPort, plainPort, secrets] = process.argv.slice(2), origin = 'https://pamofi.test';
const ca = await readFile(join(secrets, 'internal_ca'));
const password = (await readFile(join(secrets, 'first_staff_password'), 'utf8')).trim();
let checks = 0;
function check(actual, expected) { assert.equal(actual, expected); checks++; }
function request(path, { method = 'GET', body, cookie, requestOrigin = origin, forwarded, retrySecret, plain = false, untrustedCa = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = (plain ? http : https).request({ hostname: '127.0.0.1', port: Number(plain ? plainPort : tlsPort), servername: 'pamofi.test', path, method,
      ...(plain ? {} : { ca: untrustedCa ? [] : ca, rejectUnauthorized: true }),
      headers: { host: 'pamofi.test', origin: requestOrigin, ...(cookie ? { cookie } : {}), ...(forwarded ? { 'x-forwarded-for': forwarded } : {}), ...(retrySecret ? { 'idempotency-key': retrySecret } : {}), ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) }, timeout: 7000
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', part => { size += part.length; if (size > 1024 * 1024) response.destroy(Error('Unexpected large gateway response')); else chunks.push(part); });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(Error('Gateway request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}
function token(response, name) { return response.headers['set-cookie']?.find(value => value.startsWith(`${name}=`) && !value.startsWith(`${name}=;`))?.split(';')[0]; }
function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bytes = []; let bits = 0, buffer = 0;
  for (const letter of secret) { buffer = (buffer << 5) | alphabet.indexOf(letter); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); } }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(), offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

// Gateways have no dependency on a provider and can take a brief moment to bind
// after Compose reports their containers running. Keep that readiness bounded.
const readyBy = Date.now() + 15000;
while (true) {
  try { if ((await request('/health/live')).status === 200) break; } catch { /* retry a starting local listener */ }
  if (Date.now() >= readyBy) throw Error('Public TLS gateway did not become ready.');
  await setTimeout(200);
}
let result = await request('/handoff', { plain: true }); check(result.status, 308); check(result.headers.location, `${origin}/handoff`);
await assert.rejects(request('/health/live', { untrustedCa: true })); checks++;
result = await request('/health/live'); check(result.status, 200);
result = await request('/'); check(result.status, 200); assert.match(result.headers['strict-transport-security'], /max-age=/); checks++;
for (const path of ['/internal/v1/session', '/v1/session', '/api/internal/v1/session', '/api/unknown']) check((await request(path)).status, 404);
check((await request('/api/session')).status, 401);
result = await request('/api/bundles'); check(result.status, 200); check(JSON.parse(result.text).candidate, false); check(JSON.parse(result.text).products.length, 0);
result = await request('/api/capabilities'); check(result.status, 200);
const capabilities = JSON.parse(result.text);
for (const name of ['demo', 'paymentCheckout', 'deliverySms', 'networkAccess', 'mobileCookies']) check(capabilities[name], false);

// Public TLS reaches the genuine role-separated identity service. Customer
// credentials remain solely in cookie/header/body values, never URL parameters.
const retrySecret = randomBytes(32).toString('base64url');
const customerResponse = await request('/api/session', { method: 'POST', body: {}, retrySecret });
check(customerResponse.status, 201);
const customerCookie = token(customerResponse, '__Host-pamofi_session'), customerId = JSON.parse(customerResponse.text).customerId;
assert.ok(customerCookie); assert.match(customerResponse.headers['set-cookie'][0], /Secure/); assert.match(customerResponse.headers['set-cookie'][0], /HttpOnly/); checks += 3;
check((await request('/api/handoff', { method: 'POST', body: {}, cookie: customerCookie, requestOrigin: 'https://evil.test' })).status, 403);
result = await request('/api/handoff', { method: 'POST', body: {}, cookie: customerCookie }); check(result.status, 201);
const handoff = JSON.parse(result.text); check(handoff.continueUrl, `${origin}/handoff`); check(handoff.continueUrl.includes(handoff.handoffCode), false);
result = await request('/api/handoff/redeem', { method: 'POST', body: { handoffCode: handoff.handoffCode } }); check(result.status, 200); check(JSON.parse(result.text).customerId, customerId);
check((await request('/api/handoff/redeem', { method: 'POST', body: { handoffCode: handoff.handoffCode } })).status, 401);

result = await request('/api/staff/login', { method: 'POST', body: { email: 'operator@pamofi.invalid', password } }); check(result.status, 200);
const challenge = token(result, '__Host-pamofi_staff_challenge'); assert.ok(challenge); checks++;
check(JSON.parse(result.text).next, 'mfa_setup');
check((await request('/api/staff/users', { cookie: challenge })).status, 401);
result = await request('/api/staff/mfa/setup', { method: 'POST', body: {}, cookie: challenge }); check(result.status, 200);
const enrollment = JSON.parse(result.text);
result = await request('/api/staff/mfa/confirm', { method: 'POST', body: { code: totp(enrollment.secret) }, cookie: challenge }); check(result.status, 200);
const adminCookie = token(result, '__Host-pamofi_staff_session'); check(JSON.parse(result.text).role, 'admin'); check(JSON.parse(result.text).mfaVerified, true);
result = await request('/api/staff/users', { cookie: adminCookie }); check(result.status, 200); check(JSON.parse(result.text).users.length, 1);
result = await request('/api/staff/audit', { cookie: adminCookie }); check(result.status, 200); check(JSON.parse(result.text).events[0].action, 'bootstrap');
result = await request('/api/staff/users/' + enrollment.staffId + '/recover-mfa', { method: 'POST', cookie: adminCookie, body: { expectedVersion: 1, reason: 'Verify self recovery remains forbidden' } }); check(result.status, 409); check(JSON.parse(result.text).error, 'self_recovery_rejected');
check((await request('/api/admin/bundles', { cookie: adminCookie })).status, 200); // prepaid -> identity over verified private TLS
check((await request('/api/staff/session', { method: 'DELETE', cookie: adminCookie })).status, 204);
check((await request('/api/staff/session', { cookie: adminCookie })).status, 401);

// The edge must overwrite a forged client chain; all these requests originate
// from one actual peer and must share the real registration route limit.
for (let attempt = 0; attempt < 9; attempt++) {
  result = await request('/api/staff/register', { method: 'POST', body: { email: 'csrf@pamofi.invalid', password, displayName: 'Denied applicant' }, requestOrigin: 'https://evil.test', forwarded: `198.51.100.${attempt + 1}` });
  check(result.status, attempt < 8 ? 403 : 429);
}
console.log(`Public TLS smoke passed ${checks} checks: certificate trust, route boundaries, secure customer handoff, real first-admin MFA, private staff resolution and forged-proxy rate limits.`);
