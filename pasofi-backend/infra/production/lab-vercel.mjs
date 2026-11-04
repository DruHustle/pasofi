// Real split-host qualification: Node's production Vercel handler -> strict
// HTTPS -> actual Oracle nginx/web -> the five migrated production services.
// The local wrapper supplies synthetic Vercel edge metadata, not a claim about
// a live Vercel deployment. No transport disables certificate verification.
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { createProxyHandler } from '../../../pasofi-frontend/web/server/oracle-proxy.mjs';
import { checkHttpsOrigins } from '../operations/check.mjs';

const [tlsPort, plainPort, secrets] = process.argv.slice(2);
assert.ok(/^\d+$/.test(tlsPort) && /^\d+$/.test(plainPort) && secrets, 'Use the disposable split-host lab runner.');
const frontendHost = 'pamofi.test', oracleHost = 'api.pamofi.test';
const frontendOrigin = 'https://' + frontendHost, oracleOrigin = 'https://' + oracleHost;
const ca = await readFile(join(secrets, 'internal_ca'));
const proxyToken = (await readFile(join(secrets, 'vercel_proxy_token'), 'utf8')).trim();
const password = (await readFile(join(secrets, 'first_staff_password'), 'utf8')).trim();
const forwarded = [];
let checks = 0, frontendPort;
function check(actual, expected, message) { assert.equal(actual, expected, message); checks++; }
const handler = createProxyHandler({
  env: { VERCEL: '1', NODEJS_HELPERS: '0', PAMOFI_PUBLIC_ORIGIN: frontendOrigin, PAMOFI_ORACLE_API_ORIGIN: oracleOrigin, PAMOFI_VERCEL_PROXY_TOKEN: proxyToken },
  request(url, options, callback) {
    assert.equal(url.origin, oracleOrigin);
    assert.equal(options.rejectUnauthorized, true);
    forwarded.push({ target: url.pathname + url.search, method: options.method, headers: { ...options.headers } });
    return https.request({ ...options, headers: { ...options.headers, host: oracleHost }, hostname: '127.0.0.1', port: Number(tlsPort), servername: oracleHost, path: url.pathname + url.search, ca, rejectUnauthorized: true }, callback);
  },
});
const frontend = https.createServer({
  key: await readFile(join(secrets, 'public_tls_key')),
  cert: await readFile(join(secrets, 'public_tls_cert')),
}, (req, res) => handler(req, res));

function request(path, {
  method = 'GET', body, rawBody, cookie, requestOrigin = frontendOrigin,
  retrySecret, direct = false, authorized = false, plain = false,
  untrustedCa = false, ip = '203.0.113.10', extraHeaders = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody === undefined ? body === undefined ? undefined : JSON.stringify(body) : rawBody;
    const host = direct || plain ? oracleHost : frontendHost;
    const headers = {
      host, ...(requestOrigin ? { origin: requestOrigin } : {}), ...(cookie ? { cookie } : {}),
      ...(retrySecret ? { 'idempotency-key': retrySecret } : {}),
      ...(direct ? { 'x-pamofi-client-ip': ip, ...(authorized ? { 'x-pamofi-proxy-token': proxyToken } : {}) } : { 'x-vercel-forwarded-for': ip }),
      ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      ...extraHeaders,
    };
    const req = (plain ? http : https).request({
      hostname: '127.0.0.1', port: Number(plain ? plainPort : direct ? tlsPort : frontendPort),
      servername: host, path, method, headers, timeout: 10000,
      ...(plain ? {} : { ca: untrustedCa ? [] : ca, rejectUnauthorized: true }),
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', part => { size += part.length; if (size > 1024 * 1024) response.destroy(Error('Unexpected large qualification response')); else chunks.push(part); });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(Error('Split-host request timed out')));
    req.on('error', reject); req.end(payload);
  });
}
function cookie(response, name) {
  return response.headers['set-cookie']?.find(value => value.startsWith(name + '=') && !value.startsWith(name + '=;'))?.split(';')[0];
}
function secureCookies(response) {
  assert.ok(response.headers['set-cookie']?.length);
  for (const value of response.headers['set-cookie']) {
    assert.match(value, /;\s*Secure(?:;|$)/i); assert.match(value, /;\s*HttpOnly(?:;|$)/i);
    assert.match(value, /;\s*SameSite=Lax(?:;|$)/i); assert.match(value, /;\s*Path=\/(?:;|$)/i);
    assert.doesNotMatch(value, /;\s*Domain=/i); checks += 5;
  }
}
function privateResponse(response) {
  assert.match(response.headers['cache-control'], /no-store/);
  check(response.headers['x-pamofi-proxy-token'], undefined); check(response.headers['x-pamofi-client-ip'], undefined);
  check(response.text.includes(proxyToken), false); checks++;
}
function totp(secret, offsetSteps = 0) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bytes = []; let bits = 0, buffer = 0;
  for (const letter of secret) { buffer = (buffer << 5) | alphabet.indexOf(letter); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); } }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offsetSteps));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(), offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
async function enroll(email) {
  let response = await request('/api/staff/login', { method: 'POST', body: { email, password } });
  check(response.status, 200, 'staff password login'); check(JSON.parse(response.text).next, 'mfa_setup');
  secureCookies(response); assert.ok(response.headers['set-cookie'].length >= 2); checks++;
  const challenge = cookie(response, '__Host-pamofi_staff_challenge'); assert.ok(challenge);
  check((await request('/api/staff/users', { cookie: challenge })).status, 401);
  response = await request('/api/staff/mfa/setup', { method: 'POST', body: {}, cookie: challenge }); check(response.status, 200);
  const secret = JSON.parse(response.text).secret;
  response = await request('/api/staff/mfa/confirm', { method: 'POST', body: { code: totp(secret) }, cookie: challenge }); check(response.status, 200);
  secureCookies(response); assert.ok(response.headers['set-cookie'].length >= 2); checks++;
  return { cookie: cookie(response, '__Host-pamofi_staff_session'), secret, data: JSON.parse(response.text) };
}

try {
  await new Promise((resolve, reject) => { frontend.once('error', reject); frontend.listen(0, '127.0.0.1', resolve); });
  frontendPort = frontend.address().port;
  const readyBy = Date.now() + 15000;
  while (true) {
    try { if ((await request('/health/live', { direct: true })).status === 200) break; } catch { /* bounded local listener startup */ }
    if (Date.now() >= readyBy) throw Error('Oracle TLS gateway did not become ready.');
    await setTimeout(200);
  }
  await assert.rejects(request('/health/live', { direct: true, untrustedCa: true })); checks++;
  let response = await request('/api/session', { plain: true });
  check(response.status, 308); check(response.headers.location, oracleOrigin + '/api/session');
  for (const path of ['/', '/handoff', '/internal/v1/session', '/v1/session']) check((await request(path, { direct: true, authorized: true })).status, 404);
  for (const path of ['/api/session', '/api/capabilities', '/api/internal/v1/session']) check((await request(path, { direct: true })).status, 403);
  for (const token of ['f'.repeat(63), proxyToken.toUpperCase(), proxyToken + ', ' + proxyToken]) {
    check((await request('/api/capabilities', { direct: true, extraHeaders: { 'x-pamofi-proxy-token': token } })).status, 403);
  }
  for (const ip of ['', 'not-an-ip', '999.1.1.1', '203.0.113.10, 203.0.113.11', '203.0.113.10:123', '2001:DB8::1', '2001:0db8::1', 'fe80::1%eth0', '::ffff:192.0.2.1']) {
    check((await request('/api/capabilities', { direct: true, authorized: true, ip })).status, 400, 'Oracle must reject malformed or noncanonical client identity');
  }
  check((await request('/api/capabilities', { direct: true, authorized: true })).status, 200);
  for (const path of ['/api/internal/v1/session', '/api/unknown']) {
    check((await request(path, { direct: true, authorized: true })).status, 404);
    check((await request(path)).status, 404);
  }
  response = await request('/api/capabilities'); check(response.status, 200); privateResponse(response);
  const capabilities = JSON.parse(response.text);
  for (const name of ['demo', 'paymentCheckout', 'deliverySms', 'networkAccess', 'mobileCookies']) check(capabilities[name], false);
  for (const name of ['vouchers', 'receiptPairing', 'staffSales']) check(capabilities[name], true);
  check((await request('/api/capabilities', { ip: '2001:0DB8:0:0:0:0:0:22' })).status, 200);
  check((await request('/api/capabilities', { ip: '::ffff:192.0.2.22' })).status, 200);
  response = await request('/api/help'); check(response.status, 200); assert.ok(JSON.parse(response.text).articles.length); checks++;
  const query = '/api/help?q=unfindable%20qualification%2Bquery';
  response = await request(query); check(response.status, 200); check(JSON.parse(response.text).articles.length, 0);
  check(forwarded.at(-1).target, query);

  const retrySecret = randomBytes(32).toString('base64url');
  response = await request('/api/session', { method: 'POST', rawBody: '{  }', retrySecret }); check(response.status, 201);
  privateResponse(response); secureCookies(response);
  let customerCookie = cookie(response, '__Host-pamofi_session');
  const customerId = JSON.parse(response.text).customerId; assert.ok(customerCookie); checks++;
  check(forwarded.at(-1).headers['content-length'], '4');
  response = await request('/api/session', { method: 'POST', body: {}, retrySecret });
  check(response.status, 200); check(JSON.parse(response.text).customerId, customerId);
  check((await request('/api/session', { cookie: customerCookie })).status, 200);
  check((await request('/api/handoff', { method: 'POST', body: {}, cookie: customerCookie, requestOrigin: oracleOrigin })).status, 403);
  check((await request('/api/handoff', { method: 'POST', body: {}, cookie: customerCookie, requestOrigin: oracleOrigin, direct: true, authorized: true })).status, 403);
  response = await request('/api/handoff', { method: 'POST', body: {}, cookie: customerCookie }); check(response.status, 201);
  const handoff = JSON.parse(response.text); check(handoff.continueUrl, frontendOrigin + '/handoff'); check(handoff.continueUrl.includes(handoff.handoffCode), false);
  response = await request('/api/handoff/redeem', { method: 'POST', body: { handoffCode: handoff.handoffCode } }); check(response.status, 200);
  check(JSON.parse(response.text).customerId, customerId);
  customerCookie = cookie(response, '__Host-pamofi_session');
  check((await request('/api/handoff/redeem', { method: 'POST', body: { handoffCode: handoff.handoffCode } })).status, 401);

  response = await request('/api/staff/password-reset/availability'); check(response.status, 200); check(JSON.parse(response.text).enabled, false);
  response = await request('/api/staff/password-reset/request', { method: 'POST', body: { email: 'operator@pamofi.invalid' } }); check(response.status, 503);
  const admin = await enroll('operator@pamofi.invalid');
  check(admin.data.role, 'admin'); check(admin.data.mfaVerified, true);
  response = await request('/api/staff/users', { cookie: admin.cookie }); check(response.status, 200); check(JSON.parse(response.text).users.length, 1);
  response = await request('/api/gateway?__pamofi_path=staff%2Fusers&path=staff%2Fusers', { cookie: admin.cookie }); check(response.status, 200); check(JSON.parse(response.text).users.length, 1);
  check(forwarded.at(-1).target, '/api/staff/users');
  response = await request('/api/gateway?__pamofi_path=staff%2Faudit&path=staff%2Fusers', { cookie: admin.cookie }); check(response.status, 400);
  response = await request('/api/staff/audit', { cookie: admin.cookie }); check(response.status, 200); check(JSON.parse(response.text).events[0].action, 'bootstrap');
  response = await request('/api/staff/users/' + admin.data.staffId + '/recover-mfa', { method: 'POST', cookie: admin.cookie, body: { expectedVersion: admin.data.version, reason: 'Verify self recovery remains forbidden' } }); check(response.status, 409); check(JSON.parse(response.text).error, 'self_recovery_rejected');
  check((await request('/api/admin/bundles', { cookie: admin.cookie })).status, 200);
  const bundleId = 'split-lab', siteId = randomUUID();
  response = await request('/api/admin/bundles', { method: 'POST', cookie: admin.cookie, body: { id: bundleId, priceMinor: 123, currency: 'USD', byteLimit: '1000000000', validitySeconds: 3600, published: false, reason: 'Disposable split-host qualification bundle' } }); check(response.status, 201);
  response = await request('/api/admin/bundles/' + bundleId, { method: 'PATCH', cookie: admin.cookie, body: { published: true, reason: 'Disposable split-host publication qualification' } }); check(response.status, 200);
  response = await request('/api/bundles'); check(response.status, 200); check(JSON.parse(response.text).products.some(product => product.id === bundleId), true);
  response = await request('/api/admin/sites', { method: 'POST', cookie: admin.cookie, body: { id: siteId, name: 'Isolated split-host lab site' } }); check(response.status, 201);
  const agentEmail = 'agent@pamofi.invalid';
  response = await request('/api/staff/register', { method: 'POST', body: { email: agentEmail, password, displayName: 'Disposable agent' } }); check(response.status, 202);
  const pending = await enroll(agentEmail); check(pending.data.status, 'pending');
  response = await request('/api/staff/users', { cookie: admin.cookie });
  const applicant = JSON.parse(response.text).users.find(user => user.email === agentEmail); assert.ok(applicant); checks++;
  response = await request('/api/staff/users/' + applicant.staffId + '/decision', { method: 'POST', cookie: admin.cookie, body: { expectedVersion: applicant.version, status: 'approved', role: 'agent', siteIds: [siteId], reason: 'Disposable split-host agent qualification' } }); check(response.status, 200);
  check((await request('/api/staff/session', { cookie: pending.cookie })).status, 401);
  response = await request('/api/staff/login', { method: 'POST', body: { email: agentEmail, password } }); check(response.status, 200);
  const challenge = cookie(response, '__Host-pamofi_staff_challenge');
  response = await request('/api/staff/mfa/verify', { method: 'POST', cookie: challenge, body: { code: totp(pending.secret, 1) } }); check(response.status, 200);
  const agentCookie = cookie(response, '__Host-pamofi_staff_session'); check(JSON.parse(response.text).role, 'agent');
  check((await request('/api/admin/bundles', { cookie: agentCookie })).status, 403);
  response = await request('/api/admin/inventory/allocations', { method: 'POST', cookie: admin.cookie, retrySecret: randomUUID(), body: { agentId: applicant.staffId, siteId, bundleId, quantity: 2, reason: 'Disposable split-host agent stock' } }); check(response.status, 201);
  response = await request('/api/staff/cash-shifts', { method: 'POST', cookie: agentCookie, retrySecret: randomUUID(), body: {siteId,currency:'USD',openingMinor:0} }); check(response.status,201);
  response = await request('/api/receipt-pairings', { method: 'POST', cookie: customerCookie, body: {bundleId,siteId}, retrySecret: randomUUID() }); check(response.status, 201);
  const pairing = JSON.parse(response.text).pairing, saleKey = randomUUID();
  const saleBody = { siteId, bundleId, delivery: 'receipt', pairingCode: pairing.code, payment: { method: 'cash', confirmed: true, amountMinor: 123, currency: 'USD' } };
  response = await request('/api/staff/sales', { method: 'POST', cookie: agentCookie, retrySecret: saleKey, body: saleBody }); check(response.status, 201); privateResponse(response);
  const sale = JSON.parse(response.text).sale; check(sale.simulation, false); check(sale.payment.receivedMinor, 123); check(sale.payment.confirmedBy, applicant.staffId);
  response = await request('/api/staff/sales', { method: 'POST', cookie: agentCookie, retrySecret: saleKey, body: saleBody }); check(response.status, 200); check(JSON.parse(response.text).sale.id, sale.id);
  response = await request('/api/staff/inventory', { cookie: agentCookie }); check(response.status, 200); check(JSON.parse(response.text).inventory[0].quantity, 1);
  response = await request('/api/staff/sales?limit=1&offset=0', { cookie: agentCookie }); check(response.status, 200); check(JSON.parse(response.text).sales.length, 1);
  response = await request('/api/receipt-pairings/' + pairing.id, { cookie: customerCookie }); check(response.status, 200); privateResponse(response);
  const receipt = JSON.parse(response.text); check(receipt.status, 'ready');
  response = await request('/api/vouchers/redeem', { method: 'POST', cookie: customerCookie, body: { code: receipt.receipt.voucher.code } }); check(response.status, 200);
  const entitlementId = JSON.parse(response.text).entitlementId;
  response = await request('/api/usage?entitlementIds=' + entitlementId, { cookie: customerCookie }); check(response.status, 200); privateResponse(response);
  const usage = JSON.parse(response.text); check(usage.customerId, customerId); check(usage.totals.remainingBytes, '1000000000'); check(usage.totals.usedBytes, '0'); check(usage.queued.bundleCount, 1);
  check(usage.entitlementUpdates[0].id, entitlementId);

  response = await request('/api/staff/cash-refunds', {method:'POST',cookie:agentCookie,retrySecret:randomUUID(),body:{saleId:sale.id,reason:'Unused access refund in isolated production lab'}}); check(response.status,201);
  const refundId=JSON.parse(response.text).refund.id;
  check((await request(`/api/admin/cash-refunds/${refundId}/decision`, {method:'POST',cookie:agentCookie,retrySecret:randomUUID(),body:{decision:'approved',note:'Agent cannot approve own refund'}})).status,403);
  response=await request(`/api/admin/cash-refunds/${refundId}/decision`, {method:'POST',cookie:admin.cookie,retrySecret:randomUUID(),body:{decision:'approved',note:'Supervisor reviewed unused access in lab'}}); check(response.status,200);check(JSON.parse(response.text).refund.state,'approved');
  response=await request(`/api/staff/cash-refunds/${refundId}/prepare-payout`, {method:'POST',cookie:agentCookie,retrySecret:randomUUID(),body:{}});check(response.status,200);check(JSON.parse(response.text).refund.state,'paying');
  const payoutKey=randomUUID();
  response=await request(`/api/staff/cash-refunds/${refundId}/payout`, {method:'POST',cookie:agentCookie,retrySecret:payoutKey,body:{confirmed:true}});check(response.status,200);check(JSON.parse(response.text).refund.state,'paid');check(JSON.parse(response.text).refund.events.length,4);
  response=await request(`/api/staff/cash-refunds/${refundId}/payout`, {method:'POST',cookie:agentCookie,retrySecret:payoutKey,body:{confirmed:true}});check(response.status,200);check(JSON.parse(response.text).replayed,true);
  check((await request('/api/vouchers/redeem',{method:'POST',cookie:customerCookie,body:{code:receipt.receipt.voucher.code}})).status,409);
  response=await request('/api/staff/cash-shifts',{cookie:agentCookie});check(response.status,200);
  const cashShift=JSON.parse(response.text).shifts[0];check(cashShift.expectedMinor,'0');check(cashShift.refundsMinor,'123');
  response=await request(`/api/staff/cash-shifts/${cashShift.id}/close`,{method:'POST',cookie:agentCookie,retrySecret:randomUUID(),body:{countedMinor:0,note:'Counted zero after returning unused sale cash'}});check(response.status,200);check(JSON.parse(response.text).shift.differenceMinor,'0');

  for (const [path, session] of [['/api/staff/session', agentCookie], ['/api/staff/session', admin.cookie], ['/api/session', customerCookie]]) {
    response = await request(path, { method: 'DELETE', cookie: session }); check(response.status, 204); secureCookies(response);
    assert.ok(response.headers['set-cookie'].every(value => /(?:Max-Age=0|Expires=Thu, 01 Jan 1970)/i.test(value))); checks++;
    check((await request(path, { cookie: session })).status, 401);
  }
  // Two callers share this proxy listener but keep independent real API limits.
  // Ordinary forwarded headers and spoofed trust headers never select a bucket.
  for (let attempt = 0; attempt < 9; attempt++) {
    response = await request('/api/staff/register', { method: 'POST', body: { email: 'invalid', password, displayName: 'Invalid applicant' }, ip: '198.51.100.20', extraHeaders: { 'x-forwarded-for': '192.0.2.' + (attempt + 1), 'x-real-ip': '192.0.2.' + (attempt + 1), 'x-pamofi-proxy-token': 'attacker', 'x-pamofi-client-ip': '192.0.2.' + (attempt + 1) } });
    check(response.status, attempt < 8 ? 400 : 429, 'rate limit follows the Vercel-owned caller address');
  }
  assert.ok(Number(response.headers['retry-after']) > 0); checks++;
  check((await request('/api/staff/register', { method: 'POST', body: { email: 'invalid', password, displayName: 'Second applicant' }, ip: '198.51.100.21' })).status, 400);
  check((await request('/api/staff/register', { method: 'POST', body: { email: 'invalid', password, displayName: 'IPv6 applicant' }, ip: '2001:db8::99' })).status, 400);
  check(forwarded.every(item => item.headers['x-forwarded-for'] === undefined && item.headers['x-real-ip'] === undefined && item.headers.forwarded === undefined), true);
  const diagnostic = await checkHttpsOrigins({
    gatewayOrigin: oracleOrigin, frontendOrigin,
    async fetcher(url, options) {
      assert.equal(options.redirect, 'error'); assert.ok(options.signal);
      const target = new URL(url); assert.ok([oracleOrigin, frontendOrigin].includes(target.origin));
      const result = await request(target.pathname + target.search, { direct: target.origin === oracleOrigin, requestOrigin: null });
      const headers = new Headers();
      for (const [name, value] of Object.entries(result.headers)) for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, item);
      return { status: result.status, headers, body: { cancel: async () => {} } };
    },
  });
  check(diagnostic.ok, true); check(diagnostic.split, true);
  console.log('Vercel/Oracle TLS qualification passed ' + checks + ' checks: authenticated ingress, real handler and services, separate origins, cookies and logout, administrator and agent MFA, cash sale/receipt/redemption/usage, independent caller limits, and dual-origin monitoring.');
} finally {
  frontend.closeAllConnections();
  await new Promise(resolve => frontend.close(resolve));
}
