import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { createServer as httpsServer, request as httpsRequest } from 'node:https';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createProxyHandler, canonicalClientIp, publicRoute } from './oracle-proxy.mjs';

const env = {
  VERCEL: '1', NODEJS_HELPERS: '0', PAMOFI_PUBLIC_ORIGIN: 'https://web.pamofi.test',
  PAMOFI_ORACLE_API_ORIGIN: 'https://oracle.pamofi.test', PAMOFI_VERCEL_PROXY_TOKEN: randomBytes(32).toString('hex'),
};
const id = '17c4d8af-3950-44e1-84a0-f8b4d38c0862';
let directory, oracle, port, cert, events = [], behavior;

function listen(server) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve(server.address().port)); });
}
async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
function transport(url, options, callback) {
  assert.equal(url.origin, env.PAMOFI_ORACLE_API_ORIGIN);
  assert.equal(options.rejectUnauthorized, true);
  return httpsRequest(url, { ...options, hostname: '127.0.0.1', port, servername: 'oracle.pamofi.test', ca: cert }, callback);
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pamofi-vercel-proxy-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'),
    '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=oracle.pamofi.test', '-addext', 'subjectAltName=DNS:oracle.pamofi.test'], { stdio: 'ignore' });
  cert = await readFile(join(directory, 'cert.pem'));
  oracle = httpsServer({ cert, key: await readFile(join(directory, 'key.pem')) }, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const event = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
    events.push(event);
    if (behavior) return behavior(req, res, event);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  port = await listen(oracle);
});
after(async () => { await close(oracle); if (directory) await rm(directory, { recursive: true, force: true }); });

async function withProxy(options, run) {
  events = []; behavior = undefined;
  const server = httpServer(createProxyHandler({ env, request: transport, ...options }));
  const proxyPort = await listen(server);
  const call = (path, { method = 'GET', headers = {}, body, chunks, closeEarly = false } = {}) => new Promise((resolve, reject) => {
    const outgoing = { host: 'web.pamofi.test', 'x-vercel-forwarded-for': '192.0.2.10', ...headers };
    if (body !== undefined && outgoing['content-length'] === undefined) outgoing['content-length'] = Buffer.byteLength(body);
    const request = httpRequest({ hostname: '127.0.0.1', port: proxyPort, path, method, headers: outgoing }, response => {
      const parts = [];
      response.on('data', chunk => parts.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(parts).toString() }));
    });
    request.on('error', reject);
    if (chunks) { for (const chunk of chunks) request.write(chunk); }
    if (closeEarly) request.destroy(); else request.end(body);
  });
  try { await run(call); } finally { await close(server); }
}
function privateResponse(result) {
  assert.match(result.headers['cache-control'], /no-store/);
  assert.equal(result.headers['cdn-cache-control'], 'no-store');
  assert.equal(result.headers['vercel-cdn-cache-control'], 'no-store');
  assert.equal(result.headers['access-control-allow-origin'], undefined);
  assert(!result.body.includes(env.PAMOFI_VERCEL_PROXY_TOKEN));
}

test('actual HTTPS forwarding preserves public path, exact query, JSON bytes and idempotency while stripping spoofed trust headers', async () => {
  await withProxy({}, async call => {
    const body = '{ "name": "Private receipt", "amount": 123 }';
    const response = await call('/api/gateway?__pamofi_path=staff/sales&limit=2&opaque=a%2Bb+z&repeat=1&repeat=2', {
      method: 'POST', body, headers: { origin: env.PAMOFI_PUBLIC_ORIGIN, 'content-type': 'application/json', 'idempotency-key': id,
        cookie: '__Host-pamofi_staff_session=staff-cookie; __Host-pamofi_session=customer-cookie; _vercel_jwt=do-not-forward',
        authorization: 'Bearer do-not-forward', 'x-internal-secret': 'do-not-forward', 'x-pamofi-proxy-token': 'attacker',
        'x-pamofi-client-ip': '203.0.113.99', 'x-forwarded-for': '203.0.113.98', 'x-real-ip': '203.0.113.97', 'x-forwarded-host': 'evil.test' },
    });
    assert.equal(response.status, 200); privateResponse(response);
    assert.equal(events.length, 1);
    assert.equal(events[0].method, 'POST'); assert.equal(events[0].url, '/api/staff/sales?limit=2&opaque=a%2Bb+z&repeat=1&repeat=2');
    assert.equal(events[0].body, body); assert.equal(events[0].headers.origin, env.PAMOFI_PUBLIC_ORIGIN);
    assert.equal(events[0].headers.cookie, '__Host-pamofi_staff_session=staff-cookie; __Host-pamofi_session=customer-cookie');
    assert.equal(events[0].headers['idempotency-key'], id);
    assert.equal(events[0].headers['x-pamofi-proxy-token'], env.PAMOFI_VERCEL_PROXY_TOKEN);
    assert.equal(events[0].headers['x-pamofi-client-ip'], '192.0.2.10');
    for (const name of ['authorization', 'x-internal-secret', 'x-forwarded-for', 'x-real-ip', 'x-forwarded-host']) assert.equal(events[0].headers[name], undefined);
  });
});

test('customer/staff cookies, comma-containing expiry and clearing survive separately; API responses never become cacheable', async () => {
  await withProxy({}, async call => {
    const cookies = ['__Host-pamofi_session=customer; Path=/; HttpOnly; Secure; SameSite=Lax',
      '__Host-pamofi_staff_challenge=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax'];
    behavior = (_req, res) => {
      res.statusCode = 201; res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('set-cookie', cookies);
      res.setHeader('cache-control', 'public, max-age=3600'); res.setHeader('vercel-cdn-cache-control', 's-maxage=3600');
      res.setHeader('access-control-allow-origin', '*'); res.setHeader('x-pamofi-proxy-token', env.PAMOFI_VERCEL_PROXY_TOKEN); res.end('{"created":true}');
    };
    const response = await call('/api/session', { method: 'POST', headers: { origin: env.PAMOFI_PUBLIC_ORIGIN } });
    assert.equal(response.status, 201); assert.deepEqual(response.headers['set-cookie'], cookies);
    assert.equal(response.headers['x-pamofi-proxy-token'], undefined); privateResponse(response);
    behavior = (_req, res) => { res.statusCode = 204; res.setHeader('set-cookie', cookies[1]); res.end(); };
    const cleared = await call('/api/staff/session', { method: 'DELETE', headers: { origin: env.PAMOFI_PUBLIC_ORIGIN } });
    assert.equal(cleared.status, 204); assert.equal(cleared.body, ''); assert.deepEqual(cleared.headers['set-cookie'], [cookies[1]]); privateResponse(cleared);
  });
});

test('invalid deployment configuration and non-Vercel runtime make no outbound call', async () => {
  for (const patch of [
    { VERCEL: undefined }, { NODEJS_HELPERS: undefined }, { PAMOFI_VERCEL_PROXY_TOKEN: '' }, { PAMOFI_VERCEL_PROXY_TOKEN: 'A'.repeat(64) },
    { PAMOFI_ORACLE_API_ORIGIN: 'http://oracle.pamofi.test' }, { PAMOFI_ORACLE_API_ORIGIN: 'https://oracle.pamofi.test/path' },
    { PAMOFI_ORACLE_API_ORIGIN: 'https://user:secret@oracle.pamofi.test' }, { PAMOFI_ORACLE_API_ORIGIN: env.PAMOFI_PUBLIC_ORIGIN },
    { PAMOFI_ORACLE_API_ORIGIN: 'https://127.0.0.1' }, { PAMOFI_PUBLIC_ORIGIN: undefined }, { PAMOFI_PUBLIC_ORIGIN: 'https://web.pamofi.test/' },
  ]) await withProxy({ env: { ...env, ...patch } }, async call => {
    const response = await call('/api/capabilities'); assert.equal(response.status, 503); privateResponse(response); assert.equal(events.length, 0);
  });
});

test('wrong frontend host, foreign/missing mutation origin, invalid client identity and duplicate authority headers fail closed', async () => {
  await withProxy({}, async call => {
    for (const headers of [
      { host: 'preview.vercel.app' }, { host: 'web.pamofi.test:443' }, { origin: 'https://evil.test' },
      { 'x-vercel-forwarded-for': '' }, { 'x-vercel-forwarded-for': '192.0.2.1, 192.0.2.2' },
      { 'x-vercel-forwarded-for': '[2001:db8::1]:443' }, { 'x-vercel-forwarded-for': 'fe80::1%en0' },
      { 'x-vercel-forwarded-for': ['192.0.2.1', '192.0.2.2'] }, { cookie: '__Host-pamofi_session=a; __Host-pamofi_session=b' },
    ]) { const response = await call('/api/usage', { headers }); assert([400, 403].includes(response.status)); privateResponse(response); }
    const mutation = await call('/api/receipt-pairings', { method: 'POST' }); assert.equal(mutation.status, 403);
    for (const path of ['/api/session', '/api/session?__pamofi_path=session', '/api/gateway?__pamofi_path=session']) {
      const wrongHost = await call(path, { method: 'POST', headers: { host: 'oracle.pamofi.test', origin: env.PAMOFI_PUBLIC_ORIGIN } });
      const wrongOrigin = await call(path, { method: 'POST', headers: { origin: env.PAMOFI_ORACLE_API_ORIGIN } });
      const missingOrigin = await call(path, { method: 'POST' });
      for (const rejected of [wrongHost, wrongOrigin, missingOrigin]) { assert.equal(rejected.status, 403); privateResponse(rejected); }
    }
    assert.equal(events.length, 0);
  });
});

test('route allowlist rejects internal endpoints, encoded traversal, ambiguous rewrite values and unsupported methods without contacting Oracle', async () => {
  await withProxy({}, async call => {
    for (const path of ['/api/internal/v1/session', '/internal/v1/session', '/v1/session', '/api/callbacks/ecocash', '/api/gateway',
      '/api/gateway?__pamofi_path=../v1/session', '/api/gateway?__pamofi_path=%2F%2Fevil.test', '/api/gateway?__pamofi_path=usage&__pamofi_path=session',
      '/api/gateway?__pamofi_path=usage&%5f%5fpamofi_path=session', '/api/gateway?%5F%5Fpamofi_path=usage&__pamofi_path=session',
      '/api/usage?__pamofi_path=usage&%5f%5fpamofi_path=usage', '/api/gateway?__pamofi_path=internal/v1/session',
      '/api/gateway?__pamofi_path=https%3A%2F%2Fevil.test%2Fapi%2Fusage', '/api/gateway?__pamofi_path=usage%3Ftarget%3Dinternal',
      '/api/gateway?__pamofi_path=%252e%252e/session', '/api/%2e%2e/session', '/api/usage?__pamofi_path=session',
      '/api/orders/bad-id/status', '/api/usage%3Fopaque=x', '/api/usage?bad=%q1', '/api//usage']) {
      const response = await call(path); assert([400, 404].includes(response.status), `${path}: ${response.status}`); privateResponse(response);
    }
    for (const method of ['POST', 'PUT', 'OPTIONS']) {
      const response = await call('/api/usage', { method, headers: { origin: env.PAMOFI_PUBLIC_ORIGIN } }); assert.equal(response.status, 405); privateResponse(response);
    }
    assert.equal(events.length, 0);
  });
});

test('anonymous session creation keeps an idempotency key with an empty body through either Vercel URL form', async () => {
  await withProxy({}, async call => {
    for (const path of ['/api/session', '/api/gateway?__pamofi_path=session']) {
      const response = await call(path, { method: 'POST', headers: { origin: env.PAMOFI_PUBLIC_ORIGIN, 'idempotency-key': id } });
      assert.equal(response.status, 200); privateResponse(response);
      assert.equal(events.at(-1).url, '/api/session'); assert.equal(events.at(-1).body, '');
      assert.equal(events.at(-1).headers['idempotency-key'], id); assert.equal(events.at(-1).headers['content-type'], undefined);
      assert.equal(events.at(-1).headers['content-length'], '0');
    }
  });
});

test('byte bounds and JSON-only bodies reject oversized declared and streamed requests before Oracle sees them', async () => {
  await withProxy({}, async call => {
    for (const options of [
      { body: 'x'.repeat(32769), headers: { 'content-type': 'application/json' } },
      { chunks: ['x'.repeat(18000), 'x'.repeat(18000)], headers: { 'content-type': 'application/json' } },
      { body: '{}', headers: { 'content-type': 'text/plain' } },
      { body: '{}', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } },
      { body: '{}', headers: {} },
    ]) {
      const response = await call('/api/session', { ...options, method: 'POST', headers: { origin: env.PAMOFI_PUBLIC_ORIGIN, ...options.headers } });
      assert([413, 415].includes(response.status), String(response.status)); privateResponse(response);
    }
    const readBody = await call('/api/usage', { body: '{}', headers: { 'content-type': 'application/json' } }); assert.equal(readBody.status, 400);
    assert.equal(events.length, 0);
  });
});

test('redirect, malformed upstream cookie, large response, non-JSON and accidental secret echo produce sanitized failures without retry', async () => {
  await withProxy({}, async call => {
    const failures = [
      (_req, res) => { res.writeHead(302, { location: 'https://elsewhere.test', 'content-type': 'application/json' }); res.end('{}'); },
      (_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': '__Host-pamofi_session=x; Path=/; SameSite=None' }); res.end('{}'); },
      (_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': '__Host-pamofi_session=x; Path=/; HttpOnly; Secure; SameSite=Lax; Domain=web.pamofi.test' }); res.end('{}'); },
      (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('x'.repeat(1048577)); },
      (_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>upstream error</p>'); },
      (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ secret: env.PAMOFI_VERCEL_PROXY_TOKEN })); },
      (_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'retry-after': env.PAMOFI_VERCEL_PROXY_TOKEN }); res.end('{}'); },
      (_req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `__Host-pamofi_session=${env.PAMOFI_VERCEL_PROXY_TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax` }); res.end('{}'); },
    ];
    for (const failure of failures) { behavior = failure; const beforeCount = events.length; const response = await call('/api/session'); assert.equal(response.status, 502); assert.equal(events.length, beforeCount + 1); assert.equal(response.body, '{"error":"upstream_unavailable"}'); privateResponse(response); }
  });
});

test('deadline cancels a stalled Oracle request once; service errors preserve status and Retry-After', async () => {
  await withProxy({ timeoutMs: 150 }, async call => {
    behavior = () => {};
    const response = await call('/api/usage'); assert.equal(response.status, 504); assert.equal(events.length, 1); privateResponse(response);
    behavior = (_req, res) => { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '20' }); res.end('{"error":"rate_limited"}'); };
    const limited = await call('/api/usage'); assert.equal(limited.status, 429); assert.equal(limited.headers['retry-after'], '20'); privateResponse(limited);
  });
});

test('strict TLS rejects an untrusted certificate and the wrong verified hostname', async () => {
  for (const trusted of [false, true]) await withProxy({ request: (url, options, callback) => httpsRequest(url, {
    ...options, hostname: '127.0.0.1', port, servername: trusted ? 'wrong.pamofi.test' : 'oracle.pamofi.test', ...(trusted ? { ca: cert } : {}),
  }, callback) }, async call => { const response = await call('/api/usage'); assert.equal(response.status, 502); privateResponse(response); assert.equal(events.length, 0); });
});

test('canonical IPv4/IPv6 identities stay distinct and a mapped address agrees with gateway IPv4 normalization', async () => {
  assert.equal(canonicalClientIp('2001:0DB8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
  assert.equal(canonicalClientIp('::ffff:192.0.2.15'), '192.0.2.15');
  assert.equal(canonicalClientIp('::FFFF:c000:20f'), '192.0.2.15');
  await withProxy({}, async call => {
    for (const ip of ['192.0.2.15', '2001:0db8::2']) assert.equal((await call('/api/usage', { headers: { 'x-vercel-forwarded-for': ip } })).status, 200);
    assert.deepEqual(events.map(item => item.headers['x-pamofi-client-ip']), ['192.0.2.15', '2001:db8::2']);
  });
});

test('cash workflow, recovery, staff and network routes are available through original and rewritten URL forms', async () => {
  const paths = [
    ['GET', '/api/capabilities'], ['GET', '/api/usage?entitlementIds=a%2Cb'], ['POST', '/api/session'], ['DELETE', '/api/session'],
    ['POST', '/api/staff/register'], ['POST', '/api/staff/mfa/confirm'], ['POST', `/api/staff/users/${id}/decision`],
    ['POST', '/api/admin/inventory/allocations'], ['POST', '/api/staff/sales'], ['GET', `/api/staff/sales/${id}/receipt`],
    ['POST', '/api/receipt-pairings'], ['GET', `/api/receipt-pairings/${id}`], ['POST', '/api/vouchers/redeem'],
    ['POST', '/api/recovery/rotate'], ['POST', '/api/handoff/redeem'], ['POST', '/api/network/credentials'],
    ['POST', '/api/network/disconnect'], ['PATCH', '/api/admin/bundles/day-1'], ['POST', `/api/admin/network/reviews/${id}/resolve`],
  ];
  await withProxy({}, async call => {
    for (const [method, path] of paths) {
      assert.equal(publicRoute(path, method).target, path);
      const response = await call(path, { method, headers: { origin: env.PAMOFI_PUBLIC_ORIGIN } }); assert.equal(response.status, 200, `${method} ${path}`);
    }
    const response = await call('/api/usage?__pamofi_path=usage&opaque=x%2Fy'); assert.equal(response.status, 200); assert.equal(events.at(-1).url, '/api/usage?opaque=x%2Fy');
    const head = await call('/api/capabilities', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.body, ''); privateResponse(head);
  });
});
