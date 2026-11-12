import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as httpsServer, request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createProxyHandler } from './oracle-proxy.mjs';

// Exercise the public handler over HTTP and its verified HTTPS upstream. These
// fixtures contain only synthetic credentials and never use a deployment.
const baseEnv = {
  VERCEL: '1', NODEJS_HELPERS: '0', PAMOFI_PUBLIC_ORIGIN: 'https://native.pasofi.test',
  PAMOFI_ORACLE_API_ORIGIN: 'https://oracle.pasofi.test', PAMOFI_VERCEL_PROXY_TOKEN: randomBytes(32).toString('hex'),
};
const qualified = { ...baseEnv, PAMOFI_NATIVE_CUSTOMER_ENABLED: 'true', PAMOFI_NATIVE_CUSTOMER_QUALIFIED: 'true' };
const id = '17c4d8af-3950-44e1-84a0-f8b4d38c0862';
const sessionValue = 'S'.repeat(43);
const customerCookie = `__Host-pamofi_session=${sessionValue}; Path=/; Secure; HttpOnly; SameSite=Lax`;
const clearingCookie = '__Host-pamofi_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0';
const capabilityBody = { demo: false, mobileCookies: false, paymentMode: 'production', paymentCheckout: false, vouchers: true, networkAccess: false, receiptPairing: true };
let directory, cert, oracle, oraclePort, events = [], behavior;

function listen(server) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
}
async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function transport(url, options, callback) {
  assert.equal(url.origin, baseEnv.PAMOFI_ORACLE_API_ORIGIN);
  assert.equal(options.rejectUnauthorized, true);
  return httpsRequest(url, { ...options, hostname: '127.0.0.1', port: oraclePort, servername: 'oracle.pasofi.test', ca: cert }, callback);
}
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pasofi-native-proxy-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'),
    '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=oracle.pasofi.test', '-addext', 'subjectAltName=DNS:oracle.pasofi.test'], { stdio: 'ignore' });
  cert = await readFile(join(directory, 'cert.pem'));
  oracle = httpsServer({ cert, key: await readFile(join(directory, 'key.pem')) }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const event = { method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
    events.push(event);
    if (behavior) return behavior(req, res, event);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(event.path === '/api/capabilities' ? capabilityBody : { ok: true }));
  });
  oraclePort = await listen(oracle);
});
after(async () => { await close(oracle); if (directory) await rm(directory, { recursive: true, force: true }); });

async function withProxy(options, run) {
  events = []; behavior = undefined;
  const server = httpServer(createProxyHandler({ env: qualified, request: transport, ...options }));
  const port = await listen(server);
  const call = (path, { method = 'GET', headers = {}, body, rawHeaders } = {}) => new Promise((resolve, reject) => {
    const outgoing = { host: 'native.pasofi.test', origin: baseEnv.PAMOFI_PUBLIC_ORIGIN,
      'x-vercel-forwarded-for': '192.0.2.10', 'x-pasofi-native-customer': '1', ...headers };
    if (body !== undefined) outgoing['content-length'] = String(Buffer.byteLength(body));
    for (const key of Object.keys(outgoing)) if (outgoing[key] === undefined) delete outgoing[key];
    const request = httpRequest({ hostname: '127.0.0.1', port, path, method,
      headers: rawHeaders ? [...Object.entries(outgoing).flat(), ...rawHeaders] : outgoing }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks), body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject); request.end(body);
  });
  try { await run(call); } finally { await close(server); }
}
function privateResponse(response) {
  assert.match(response.headers['cache-control'], /no-store/);
  assert.equal(response.headers['cdn-cache-control'], 'no-store');
  assert.equal(response.headers['vercel-cdn-cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['access-control-allow-credentials'], undefined);
  assert.equal(response.headers['x-pamofi-proxy-token'], undefined);
  assert(!response.body.includes(baseEnv.PAMOFI_VERCEL_PROXY_TOKEN));
}
function json(res, body, status = 200, headers = {}) { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); }

test('native customer protocol is closed unless both deployment gates are exactly true', async () => {
  for (const patch of [{}, { PAMOFI_NATIVE_CUSTOMER_ENABLED: 'true' }, { PAMOFI_NATIVE_CUSTOMER_QUALIFIED: 'true' },
    { PAMOFI_NATIVE_CUSTOMER_ENABLED: 'TRUE', PAMOFI_NATIVE_CUSTOMER_QUALIFIED: 'true' },
    { PAMOFI_NATIVE_CUSTOMER_ENABLED: 'true', PAMOFI_NATIVE_CUSTOMER_QUALIFIED: '1' }]) {
    await withProxy({ env: { ...baseEnv, ...patch } }, async call => {
      for (const method of ['GET', 'POST', 'DELETE']) {
        const result = await call('/api/session', { method });
        assert.equal(result.status, 503); assert.equal(JSON.parse(result.body).error, 'native_customer_disabled'); privateResponse(result);
      }
      assert.equal(events.length, 0);
      const result = await call('/api/capabilities');
      assert.equal(result.status, 200); assert.deepEqual(JSON.parse(result.body), { ...capabilityBody, mobileCookies: false, nativeCustomerApiVersion: 1 });
      assert.equal(events.length, 1); privateResponse(result);
    });
  }
});

test('native qualification changes only cookie protocol fields and leaves browser and commerce authority untouched', async () => {
  await withProxy({}, async call => {
    behavior = (_req, res) => json(res, { ...capabilityBody, nativeCustomerApiVersion: 99, extra: { retained: true } });
    const result = await call('/api/capabilities');
    assert.deepEqual(JSON.parse(result.body), { ...capabilityBody, mobileCookies: true, nativeCustomerApiVersion: 1, extra: { retained: true } });
    privateResponse(result);
    const browser = await call('/api/capabilities', { headers: { 'x-pasofi-native-customer': undefined, origin: undefined } });
    assert.deepEqual(JSON.parse(browser.body), { ...capabilityBody, nativeCustomerApiVersion: 99, extra: { retained: true } }); privateResponse(browser);
    for (const invalid of [null, [], 'yes', {}, { mobileCookies: 'true' }]) {
      behavior = (_req, res) => json(res, invalid);
      const malformed = await call('/api/capabilities'); assert.equal(malformed.status, 502); privateResponse(malformed);
    }
  });
});

test('every native request including capability reads requires exact origin, host and one marker', async () => {
  await withProxy({}, async call => {
    for (const headers of [{ origin: undefined }, { origin: 'https://wrong.pasofi.test' }, { origin: `${baseEnv.PAMOFI_PUBLIC_ORIGIN}/` },
      { host: 'oracle.pasofi.test' }, { host: 'native.pasofi.test:443' }]) {
      const result = await call('/api/capabilities', { headers }); assert.equal(result.status, 403); privateResponse(result);
    }
    for (const marker of ['', 'true', '01', '1, 1']) {
      const result = await call('/api/capabilities', { headers: { 'x-pasofi-native-customer': marker } }); assert.equal(result.status, 400); privateResponse(result);
    }
    for (const [name, value] of [['X-PasoFi-Native-Customer', '1'], ['Origin', baseEnv.PAMOFI_PUBLIC_ORIGIN], ['Host', 'native.pasofi.test'], ['X-Vercel-Forwarded-For', '192.0.2.11']]) {
      const result = await call('/api/capabilities', { rawHeaders: [name, value] }); assert.equal(result.status, 400); privateResponse(result);
    }
    assert.equal(events.length, 0);
  });
});

test('native marker cannot authorize staff, admin, internal, callback, demo-confirm or HEAD operations', async () => {
  await withProxy({}, async call => {
    const denied = [['GET', '/api/staff/session'], ['POST', '/api/staff/login'], ['GET', '/api/staff/invoices'],
      ['GET', `/api/staff/invoices/${id}/pdf`], ['GET', '/api/admin/routers'], ['POST', `/api/admin/routers/${id}/changes`],
      ['GET', '/api/internal/v1/session'], ['POST', '/api/callbacks/stripe'], ['POST', `/api/orders/${id}/demo-confirm`], ['HEAD', '/api/capabilities']];
    for (const [method, path] of denied) {
      for (const target of [path, `/api/gateway?__pamofi_path=${path.slice(5)}`]) {
        const result = await call(target, { method }); assert.equal(result.status, 404, `${method} ${target}`); privateResponse(result);
      }
    }
    assert.equal(events.length, 0);
    const browser = await call('/api/staff/session', { headers: { 'x-pasofi-native-customer': undefined } });
    assert.equal(browser.status, 200); assert.equal(events.length, 1);
  });
});

test('customer session, recovery, purchases, vouchers, network and invoices retain their allowed methods', async () => {
  await withProxy({}, async call => {
    const allowed = [['GET', '/api/session'], ['POST', '/api/session'], ['DELETE', '/api/session'], ['GET', '/api/recovery/status'],
      ['POST', '/api/recovery'], ['POST', '/api/recovery/setup'], ['POST', '/api/recovery/rotate'], ['POST', '/api/handoff'], ['POST', '/api/handoff/redeem'],
      ['GET', '/api/orders'], ['POST', '/api/orders'], ['GET', `/api/orders/${id}/status`], ['POST', `/api/orders/${id}/checkout`],
      ['POST', `/api/orders/${id}/expire-unused`], ['POST', '/api/vouchers/redeem'], ['POST', '/api/receipt-pairings'],
      ['GET', `/api/receipt-pairings/${id}`], ['POST', `/api/receipt-pairings/${id}/cancel`], ['GET', '/api/network/sites'],
      ['GET', '/api/network/session'], ['POST', '/api/network/credentials'], ['POST', '/api/network/disconnect'],
      ['GET', '/api/customer/invoices'], ['GET', `/api/customer/invoices/${id}`], ['POST', '/api/invoice-downloads']];
    for (const [method, path] of allowed) {
      const result = await call(`/api/gateway?__pamofi_path=${path.slice(5)}&path=${path.slice(5)}`, { method });
      assert.equal(result.status, 200, `${method} ${path}`); assert.equal(events.at(-1).path, path); assert.equal(events.at(-1).method, method);
    }
    const beforeCount = events.length;
    for (const [method, path] of [['PUT', '/api/session'], ['POST', '/api/bundles'], ['DELETE', '/api/orders'], ['GET', '/api/recovery']]) {
      assert.equal((await call(path, { method })).status, 405);
    }
    assert.equal(events.length, beforeCount);
  });
});

test('native queries are bounded per customer route after the real Vercel rewrite is removed', async () => {
  await withProxy({}, async call => {
    const accepted = ['/api/access?limit=100&offset=1000000', `/api/usage?entitlementIds=${id}%2C${id}`,
      `/api/orders?requestKey=${'R'.repeat(43)}`, `/api/payments/methods?siteId=${id}&bundleId=flex`,
      `/api/customer/invoices?limit=25&offset=0&saleId=${id}&orderId=${id}`, '/api/help?q=How+do+I+connect%3F'];
    for (const path of accepted) {
      const queryAt = path.indexOf('?'), name = path.slice(5, queryAt), query = path.slice(queryAt + 1);
      const result = await call(`/api/gateway?__pamofi_path=${name}&path=${name}&${query}`);
      assert.equal(result.status, 200, path); assert.equal(events.at(-1).path, path);
    }
    const count = events.length;
    for (const path of ['/api/session?customerId=other', '/api/access?limit=0', '/api/access?limit=101', '/api/access?offset=-1',
      '/api/access?offset=1000001', '/api/access?limit=2&limit=3', '/api/access?limit=2&%6cimit=3',
      '/api/access?unknown=1', '/api/usage?entitlementIds=not-a-uuid', `/api/usage?entitlementIds=${Array(101).fill(id).join(',')}`,
      '/api/orders?requestKey=short', '/api/payments/methods?siteId=wrong', `/api/customer/invoices/${id}?limit=2`,
      '/api/help?q=bad%00value', `/api/help?q=${'x'.repeat(201)}`, '/api/capabilities?nativeCustomerApiVersion=1']) {
      const result = await call(path); assert.equal(result.status, 400, path); privateResponse(result);
    }
    assert.equal((await call('/api/orders?requestKey=' + 'R'.repeat(43), { method: 'POST' })).status, 400);
    assert.equal(events.length, count);
    // The native restriction does not narrow the existing browser protocol.
    const browser = await call('/api/access?opaque=retained&repeat=1&repeat=2', { headers: { 'x-pasofi-native-customer': undefined } });
    assert.equal(browser.status, 200); assert.equal(events.at(-1).path, '/api/access?opaque=retained&repeat=1&repeat=2');
  });
});

test('native forwards only customer cookie and the platform client IP, with no marker or spoofed trust headers upstream', async () => {
  await withProxy({}, async call => {
    const body = '{"code":"SYNTHETICVOUCHER"}';
    const result = await call('/api/vouchers/redeem', { method: 'POST', body, headers: {
      'content-type': 'application/json', 'idempotency-key': 'R'.repeat(43),
      cookie: `__Host-pamofi_staff_session=staff; __Host-pamofi_session=${sessionValue}; __Host-pamofi_staff_challenge=challenge; unrelated=value`,
      authorization: 'Bearer synthetic', 'x-internal-secret': 'synthetic', 'x-pamofi-proxy-token': 'synthetic',
      'x-pamofi-client-ip': '203.0.113.99', 'x-forwarded-for': '203.0.113.98', 'x-real-ip': '203.0.113.97',
    } });
    assert.equal(result.status, 200); privateResponse(result); assert.equal(events.length, 1);
    const event = events[0]; assert.equal(event.body, body); assert.equal(event.headers.cookie, `__Host-pamofi_session=${sessionValue}`);
    assert.equal(event.headers['x-pamofi-client-ip'], '192.0.2.10'); assert.equal(event.headers['idempotency-key'], 'R'.repeat(43));
    assert.equal(event.headers.origin, baseEnv.PAMOFI_PUBLIC_ORIGIN);
    for (const name of ['authorization', 'x-internal-secret', 'x-forwarded-for', 'x-real-ip', 'x-pasofi-native-customer']) assert.equal(event.headers[name], undefined);
    for (const options of [{ headers: { cookie: '__Host-pamofi_session=a; __Host-pamofi_session=b' } },
      { headers: { cookie: `__Host-pamofi_session=${sessionValue}` }, rawHeaders: ['Cookie', '__Host-pamofi_session=other'] },
      { headers: { 'x-vercel-forwarded-for': '192.0.2.10, 203.0.113.1' } },
      { headers: { 'x-vercel-forwarded-for': undefined, 'x-pamofi-client-ip': '192.0.2.10' } }]) {
      const rejected = await call('/api/session', options); assert.equal(rejected.status, 400); privateResponse(rejected);
    }
    assert.equal(events.length, 1);
  });
});

test('native idempotency preserves durable account retry and order keys but rejects malformed or duplicate keys', async () => {
  await withProxy({}, async call => {
    for (const key of ['a'.repeat(16), 'R'.repeat(43), id, 'z'.repeat(128)]) {
      const result = await call('/api/session', { method: 'POST', headers: { 'idempotency-key': key } });
      assert.equal(result.status, 200); assert.equal(events.at(-1).headers['idempotency-key'], key);
    }
    const count = events.length;
    for (const key of ['short', 'x'.repeat(129), 'key with spaces and punctuation!', 'a'.repeat(16) + '=']) {
      assert.equal((await call('/api/session', { method: 'POST', headers: { 'idempotency-key': key } })).status, 400);
    }
    assert.equal((await call('/api/session', { method: 'POST', headers: { 'idempotency-key': id }, rawHeaders: ['Idempotency-Key', id] })).status, 400);
    assert.equal(events.length, count);
  });
});

test('only successful account transitions can set one strict native customer cookie', async () => {
  await withProxy({}, async call => {
    for (const [method, path, status, cookie] of [['POST', '/api/session', 201, customerCookie], ['POST', '/api/session', 200, customerCookie],
      ['POST', '/api/recovery', 200, customerCookie], ['POST', '/api/handoff/redeem', 200, customerCookie], ['DELETE', '/api/session', 204, clearingCookie]]) {
      behavior = (_req, res) => { res.writeHead(status, { 'content-type': 'application/json', 'set-cookie': cookie }); res.end(status === 204 ? undefined : '{}'); };
      const result = await call(path, { method }); assert.equal(result.status, status); assert.deepEqual(result.headers['set-cookie'], [cookie]); privateResponse(result);
    }
    for (const [method, path, status, cookie] of [['GET', '/api/session', 200, customerCookie], ['GET', '/api/capabilities', 200, customerCookie],
      ['POST', '/api/recovery', 401, customerCookie], ['POST', '/api/handoff', 200, customerCookie],
      ['DELETE', '/api/session', 204, customerCookie], ['POST', '/api/session', 201, clearingCookie]]) {
      behavior = (_req, res) => { res.writeHead(status, { 'content-type': 'application/json', 'set-cookie': cookie }); res.end(status === 204 ? undefined : '{}'); };
      const result = await call(path, { method }); assert.equal(result.status, 502); assert.equal(result.headers['set-cookie'], undefined); privateResponse(result);
    }
  });
});

test('native refuses staff, duplicate, cross-domain, insecure and malformed upstream cookies without leaking any cookie', async () => {
  await withProxy({}, async call => {
    for (const cookies of [[customerCookie, customerCookie], [customerCookie, '__Host-pamofi_staff_session=staff; Path=/; Secure; HttpOnly; SameSite=Lax'],
      ['__Host-pamofi_staff_session=staff; Path=/; Secure; HttpOnly; SameSite=Lax'], [customerCookie + '; Domain=native.pasofi.test'],
      [customerCookie.replace('Secure;', '')], [customerCookie.replace('HttpOnly;', '')], [customerCookie.replace('Path=/', 'Path=/api')],
      [customerCookie.replace('SameSite=Lax', 'SameSite=None')], [customerCookie + '; Path=/'], [customerCookie.replace(sessionValue, 'invalid')]]) {
      behavior = (_req, res) => json(res, { customerId: id }, 201, { 'set-cookie': cookies });
      const result = await call('/api/session', { method: 'POST' }); assert.equal(result.status, 502); assert.equal(result.headers['set-cookie'], undefined); privateResponse(result);
    }
    for (const cookie of [clearingCookie.replace('__Host-pamofi_session=', '__Host-pamofi_session'),
      clearingCookie.replace('Max-Age=0', 'Max-Age=3600'),
      clearingCookie.replace('Max-Age=0', 'Expires=Thu, 01 Jan 2099 00:00:00 GMT')]) {
      behavior = (_req, res) => { res.writeHead(204, { 'set-cookie': cookie }); res.end(); };
      const result = await call('/api/session', { method: 'DELETE' }); assert.equal(result.status, 502); assert.equal(result.headers['set-cookie'], undefined); privateResponse(result);
    }
  });
});

test('native redirects never forward credentials to a second destination or expose redirect cookies', async () => {
  await withProxy({}, async call => {
    behavior = (_req, res) => { res.writeHead(307, { location: 'https://elsewhere.test/api/session', 'set-cookie': customerCookie, 'content-type': 'application/json' }); res.end('{}'); };
    const result = await call('/api/session', { method: 'POST', headers: { cookie: `__Host-pamofi_session=${sessionValue}` } });
    assert.equal(result.status, 502); assert.equal(events.length, 1); assert.equal(result.headers.location, undefined); assert.equal(result.headers['set-cookie'], undefined); privateResponse(result);
  });
});

test('native invoice PDFs preserve bytes and private response policy while staff PDFs and malformed bytes fail closed', async () => {
  await withProxy({}, async call => {
    const pdf = Buffer.from('%PDF-1.4\nsynthetic invoice\n%%EOF');
    behavior = (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="PasoFi-Invoice.pdf"' }); res.end(pdf); };
    const result = await call(`/api/customer/invoices/${id}/pdf`);
    assert.equal(result.status, 200); assert.deepEqual(result.bytes, pdf); assert.equal(result.headers['content-type'], 'application/pdf');
    assert.match(result.headers['content-security-policy'], /sandbox/); privateResponse(result);
    assert.equal((await call(`/api/staff/invoices/${id}/pdf`)).status, 404); assert.equal(events.length, 1);
    behavior = (_req, res) => { res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="PasoFi-Invoice.pdf"' }); res.end('<html>not a PDF</html>'); };
    assert.equal((await call(`/api/customer/invoices/${id}/pdf`)).status, 502);
  });
});

test('native transport retains bounded requests, sanitized deadlines, Retry-After and verified TLS', async () => {
  await withProxy({ timeoutMs: 120 }, async call => {
    assert.equal((await call('/api/session', { method: 'POST', body: 'x'.repeat(32769), headers: { 'content-type': 'application/json' } })).status, 413);
    assert.equal(events.length, 0);
    behavior = () => {};
    const timeout = await call('/api/session'); assert.equal(timeout.status, 504); assert.equal(events.length, 1); privateResponse(timeout);
    behavior = (_req, res) => json(res, { error: 'rate_limited' }, 429, { 'retry-after': '20' });
    const limited = await call('/api/session'); assert.equal(limited.status, 429); assert.equal(limited.headers['retry-after'], '20'); privateResponse(limited);
  });
  await withProxy({ request: (url, options, callback) => httpsRequest(url, { ...options, hostname: '127.0.0.1', port: oraclePort, servername: 'wrong.pasofi.test', ca: cert }, callback) }, async call => {
    const result = await call('/api/session'); assert.equal(result.status, 502); assert.equal(events.length, 0); privateResponse(result);
  });
});


test('native Onesa availability stays read-only, qualified and outside browser OIDC credentials', async () => {
  await withProxy({env:baseEnv},async call=>{
    assert.equal((await call('/api/onesa/availability')).status,503);
    assert.equal(events.length,0);
  });
  await withProxy({},async call=>{
    behavior=(_req,res)=>json(res,{origin:baseEnv.PAMOFI_PUBLIC_ORIGIN,handoff:true});
    const response=await call('/api/onesa/availability');
    assert.equal(response.status,200);
    assert.deepEqual(JSON.parse(response.body),{origin:baseEnv.PAMOFI_PUBLIC_ORIGIN,handoff:true});
    assert.equal(response.headers['set-cookie'],undefined);privateResponse(response);
    const forwarded=events.length;
    assert.equal((await call('/api/onesa/availability?redirect=https%3A%2F%2Fforeign.invalid')).status,400);
    for(const path of ['/api/onesa/start','/api/onesa/complete'])assert.equal((await call(path,{method:'POST',body:'{}',headers:{'content-type':'application/json'}})).status,404);
    assert.equal(events.length,forwarded,'native bridge cannot initiate or complete browser-bound OIDC');
  });
});
