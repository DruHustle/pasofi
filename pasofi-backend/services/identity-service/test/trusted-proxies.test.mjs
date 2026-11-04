import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trustedProxies } from '../dist/trusted-proxies.js';
import { buildApp } from '../dist/app.js';

test('proxy trust is absent by default and refuses universal ranges, wildcards and DNS names', () => {
  assert.equal(trustedProxies(''), false);
  for (const invalid of ['*', '0.0.0.0/0', '::/0', '0.0.0.0/00', 'trusted.example/24', '127.0.0.1', '127.0.0.1/33', '::1/129']) assert.throws(() => trustedProxies(invalid));
  assert.deepEqual(trustedProxies('127.0.0.1/32, ::1/128'), ['127.0.0.1/32', '::1/128']);
});

test('only a configured proxy can select the client address used by IP rate limits', async () => {
  delete process.env.DATABASE_URL;
  process.env.PAMOFI_TRUST_PROXY_CIDRS = '127.0.0.1/32';
  const app = buildApp();
  app.after(() => { app.get('/test/address', { config: { rateLimit: { max: 1, timeWindow: '1 minute' } } }, request => ({ ip: request.ip })); });
  try {
    let response = await app.inject({ url: '/test/address', remoteAddress: '203.0.113.8', headers: { 'x-forwarded-for': '198.51.100.1' } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().ip, '203.0.113.8');
    response = await app.inject({ url: '/test/address', remoteAddress: '203.0.113.8', headers: { 'x-forwarded-for': '198.51.100.2' } });
    assert.equal(response.statusCode, 429);
    for (const ip of ['198.51.100.1', '198.51.100.2']) {
      response = await app.inject({ url: '/test/address', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': ip } });
      assert.equal(response.statusCode, 200); assert.equal(response.json().ip, ip);
    }
  } finally { await app.close(); delete process.env.PAMOFI_TRUST_PROXY_CIDRS; }
});

test('real identity registration route installs its configured limiter after plugin initialization', async () => {
  delete process.env.DATABASE_URL;
  delete process.env.PAMOFI_TRUST_PROXY_CIDRS;
  const app = buildApp();
  try {
    for (let attempt = 0; attempt < 9; attempt++) {
      const response = await app.inject({ method: 'POST', url: '/v1/staff/register', payload: { email: 'limit@example.test', password: 'Synthetic long password', displayName: 'Limit fixture' }, headers: { origin: 'http://localhost:5173' } });
      assert.equal(response.statusCode, attempt < 8 ? 503 : 429);
    }
  } finally { await app.close(); }
});
