import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decodeJwt, SignJWT } from 'jose';
import { buildEmailRelayApp } from '../dist/email-relay-app.js';
import { RenderInvoiceEmailAdapter, invoiceEmailAdapter } from '../dist/invoice-email-relay.js';
import { invoiceRelayPath, invoiceRelaySender, relayAuthorization } from '../dist/email-relay-protocol.js';
import { invoiceDeliveryConfiguration } from '../dist/invoice-worker.js';

const secret = 'synthetic_render_relay_secret_at_least_32_bytes';
const origin = 'https://pasofi-email-relay.onrender.com';
const providerId = '4d50e6cd-6f71-47d0-ae2e-0c5a23e23536';
const input = { id: randomUUID(), to: 'customer@example.test', from: invoiceRelaySender, number: 'PFI-000001', filename: 'PFI-000001.pdf', pdf: Buffer.from('%PDF-1.7\nSynthetic invoice only\n%%EOF') };
const body = (patch = {}) => ({ id: input.id, to: input.to, number: input.number, filename: input.filename, pdf: input.pdf.toString('base64'), ...patch });
const config = (patch = {}) => ({ APP_ENV: 'production', NODE_ENV: 'production', INVOICE_EMAIL_RELAY_ENABLED: 'true', INVOICE_EMAIL_RELAY_QUALIFIED: 'true', INVOICE_EMAIL_RELAY_SECRET: secret, RESEND_API_KEY: 'synthetic_provider_key', ...patch });
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const envelope = { product: 'pasofi', provider: 'resend', sender: invoiceRelaySender };
function relayFetch(app, calls = []) {
  return async (url, options) => {
    const parsed = new URL(url); assert.equal(parsed.origin, origin); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    calls.push({ method: options.method, path: parsed.pathname });
    const response = await app.inject({ method: options.method, url: parsed.pathname + parsed.search, headers: options.headers, ...(options.body === undefined ? {} : { payload: options.body }) });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
}
async function send(app, payload = body(), token) {
  return app.inject({ method: 'POST', url: invoiceRelayPath, payload, headers: { authorization: `Bearer ${token ?? await relayAuthorization(secret, 'POST', invoiceRelayPath, payload)}` } });
}

test('the standalone candidate stays disabled and has no Oracle or provider dependency', async () => {
  let calls = 0;
  for (const settings of [{}, config({ INVOICE_EMAIL_RELAY_ENABLED: 'false' }), config({ INVOICE_EMAIL_RELAY_QUALIFIED: 'false' }), config({ NODE_ENV: 'development' }), config({ RESEND_API_KEY: '' }), config({ INVOICE_EMAIL_RELAY_SECRET: 'short' })]) {
    const app = buildEmailRelayApp({ ...settings, DATABASE_URL: 'unusable-and-must-not-be-opened', PREPAID_URL: 'https://must-not-be-contacted.invalid', RENDER_GIT_COMMIT: 'a'.repeat(40) }, async () => { calls++; throw Error('provider must remain unused'); });
    try {
      const live = await app.inject({ url: '/health/live' });
      assert.equal(live.statusCode, 200); assert.equal(live.json().source, 'a'.repeat(40));
      const readiness = await app.inject({ url: '/health/ready' });
      assert.equal(readiness.json().deliveryEnabled, false);
      assert.equal(readiness.statusCode, settings.INVOICE_EMAIL_RELAY_ENABLED === 'true' ? 503 : 200);
      assert.equal((await send(app)).statusCode, 503);
      assert.equal((await app.inject({ url: '/internal/v1/events' })).statusCode, 404);
    } finally { await app.close(); }
  }
  assert.equal(calls, 0);
});

test('client and authenticated relay send the exact PDF with the existing Resend key and confirm delivery only by retrieval', async () => {
  const providerCalls = [], clientCalls = [];
  const app = buildEmailRelayApp(config(), async (url, options) => {
    providerCalls.push({ url, options });
    assert.equal(options.redirect, 'error');
    return options.method === 'POST' ? json({ id: providerId }) : json({ id: providerId, last_event: 'delivered' });
  });
  try {
    const adapter = new RenderInvoiceEmailAdapter(origin, secret, relayFetch(app, clientCalls));
    await adapter.prepare(); assert.equal(providerCalls.length, 0);
    assert.deepEqual(await adapter.send(input), { state: 'submitted', providerId, error: null });
    assert.equal(providerCalls.length, 1);
    const sent = providerCalls[0];
    assert.equal(sent.url, 'https://api.resend.com/emails');
    assert.equal(sent.options.headers['idempotency-key'], `pasofi-invoice/${input.id}`);
    const message = JSON.parse(sent.options.body);
    assert.equal(message.from, invoiceRelaySender); assert.deepEqual(message.to, [input.to]);
    assert.equal(message.subject, `PasoFi paid invoice ${input.number}`);
    assert.equal(message.attachments[0].filename, input.filename);
    assert.deepEqual(Buffer.from(message.attachments[0].content, 'base64'), input.pdf);
    assert.deepEqual(await adapter.retrieve(providerId), { state: 'delivered', providerId, error: null });
    assert.equal(providerCalls[1].url, `https://api.resend.com/emails/${providerId}`);
    assert.deepEqual(clientCalls.map(c => c.method), ['GET', 'POST', 'GET']);
  } finally { await app.close(); }
});

test('short-lived authorization binds product, caller, audience, method, exact route and private body', async () => {
  let calls = 0;
  const app = buildEmailRelayApp(config(), async () => { calls++; return json({ id: providerId }); });
  try {
    const token = await relayAuthorization(secret, 'POST', invoiceRelayPath, body()), claims = decodeJwt(token);
    const badClaims = [
      { product: 'portal' }, { iss: 'other-notification' }, { sub: 'other-product' }, { aud: 'onesa-email-relay:portal' },
      { scope: 'email:read' }, { method: 'GET' }, { path: `${invoiceRelayPath}/other` },
      { exp: claims.iat + 3600 }, { iat: claims.iat - 60, exp: claims.iat - 45 }, { jti: 'unbounded-token' },
    ];
    for (const patch of badClaims) {
      const invalid = await new SignJWT({ ...claims, ...patch }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(secret));
      assert.equal((await send(app, body(), invalid)).statusCode, 401);
    }
    assert.equal((await send(app, body({ to: 'different@example.test' }), token)).statusCode, 401);
    assert.equal((await send(app, body(), await relayAuthorization('different_synthetic_secret_at_least_32_bytes', 'POST', invoiceRelayPath, body()))).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: invoiceRelayPath, payload: body() })).statusCode, 401);
    const readToken = await relayAuthorization(secret, 'GET', `${invoiceRelayPath}/${providerId}`);
    assert.equal((await app.inject({ url: `${invoiceRelayPath}/${randomUUID()}`, headers: { authorization: `Bearer ${readToken}` } })).statusCode, 401);
    assert.equal((await app.inject({ url: `${invoiceRelayPath}/${providerId}?source=other`, headers: { authorization: `Bearer ${readToken}` } })).statusCode, 404);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/products/portal/invoice-email', payload: body(), headers: { authorization: `Bearer ${token}` } })).statusCode, 404);
    assert.equal(calls, 0);
  } finally { await app.close(); }
});

test('relay refuses caller-selected senders, arbitrary content, malformed PDF and oversized requests without contacting Resend', async () => {
  let calls = 0;
  const app = buildEmailRelayApp(config(), async () => { calls++; return json({ id: providerId }); });
  try {
    const cases = [
      { from: 'other@example.test' }, { subject: 'arbitrary message' }, { attachments: [{ path: 'https://private.invalid' }] },
      { to: 'one@example.test,two@example.test' }, { to: 'one@example.test\r\nBcc:other@example.test' },
      { pdf: Buffer.from('not a PDF').toString('base64') }, { pdf: `${input.pdf.toString('base64')}\n` },
      { filename: '../private.pdf' }, { filename: 'DIFFERENT.pdf' }, { number: 'PFI\n123' },
      { pdf: Buffer.alloc(1048577).toString('base64') },
    ];
    for (const patch of cases) {
      const response = await send(app, body(patch));
      assert.ok([400, 413].includes(response.statusCode), String(response.statusCode));
      assert.doesNotMatch(response.body, /customer@example|synthetic_render|synthetic_provider/);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    assert.equal(calls, 0);
  } finally { await app.close(); }
});

test('lost send replies remain unknown and never trigger an automatic second provider request', async () => {
  let sends = 0;
  const app = buildEmailRelayApp(config(), async (_url, options) => { if (options.method === 'POST') sends++; return json({ id: providerId }); });
  try {
    const deliver = relayFetch(app);
    const adapter = new RenderInvoiceEmailAdapter(origin, secret, async (url, options) => {
      const response = await deliver(url, options);
      if (options.method === 'POST') throw Error('synthetic lost response after provider acceptance');
      return response;
    });
    await adapter.prepare();
    assert.deepEqual(await adapter.send(input), { state: 'unknown', providerId: null, error: 'delivery_unconfirmed' });
    assert.equal(sends, 1);
  } finally { await app.close(); }
});

test('only a definite Resend rate rejection permits retry, and malformed relay evidence is never delivery', async () => {
  const app = buildEmailRelayApp(config(), async () => json({}, 429, { 'retry-after': '180' }));
  try {
    const adapter = new RenderInvoiceEmailAdapter(origin, secret, relayFetch(app));
    assert.deepEqual(await adapter.send(input), { state: 'retry', providerId: null, error: 'provider_rate_limited', retryAfter: 180 });
  } finally { await app.close(); }
  const valid = { ...envelope, jobId: input.id, result: { state: 'submitted', providerId, error: null } };
  for (const patch of [
    { product: 'portal' }, { sender: 'Other <other@example.test>' }, { jobId: randomUUID() },
    { result: { state: 'delivered', providerId: null, error: null } },
    { result: { state: 'retry', providerId: null, error: 'provider_rate_limited', retryAfter: 1 } },
    { result: { state: 'unknown', providerId, error: null } },
  ]) {
    const adapter = new RenderInvoiceEmailAdapter(origin, secret, async () => json({ ...valid, ...patch }));
    assert.equal((await adapter.send(input)).state, 'unknown');
  }
  const adapter = new RenderInvoiceEmailAdapter(origin, secret, async () => json({ ...envelope, providerId, result: { state: 'delivered', providerId: randomUUID(), error: null } }));
  assert.deepEqual(await adapter.retrieve(providerId), { state: 'unknown', providerId, error: 'delivery_unconfirmed' });
});

test('relay selection requires qualified exact configuration and never falls back to a direct provider request', async () => {
  const env = { INVOICE_EMAIL_TRANSPORT: 'render', INVOICE_EMAIL_RELAY_QUALIFIED: 'true', INVOICE_EMAIL_FROM: invoiceRelaySender, INVOICE_EMAIL_RELAY_URL: origin, INVOICE_EMAIL_RELAY_SECRET: secret, RESEND_API_KEY: 'synthetic_direct_key_must_not_be_used' };
  assert.ok(invoiceEmailAdapter(env) instanceof RenderInvoiceEmailAdapter);
  for (const patch of [{ INVOICE_EMAIL_RELAY_QUALIFIED: 'false' }, { INVOICE_EMAIL_RELAY_SECRET: 'short' }, { INVOICE_EMAIL_FROM: 'other@example.test' }, { INVOICE_EMAIL_TRANSPORT: 'unknown' }]) assert.throws(() => invoiceEmailAdapter({ ...env, ...patch }));
  for (const value of ['http://pasofi-email-relay.onrender.com', 'https://localhost', 'https://127.0.0.1', 'https://other.example.test', `${origin}/private`, `${origin}?other=1`, 'https://user:password@pasofi-email-relay.onrender.com', `${origin}:444`]) assert.throws(() => new RenderInvoiceEmailAdapter(value, secret));
  const app = buildEmailRelayApp(config({ INVOICE_EMAIL_RELAY_ENABLED: 'false' }), async () => { throw Error('disabled provider invoked'); });
  try { await assert.rejects(new RenderInvoiceEmailAdapter(origin, secret, relayFetch(app)).prepare(), /email_relay_unavailable/); }
  finally { await app.close(); }
  const settings = { ...env, INVOICE_DELIVERY_WORKER_ENABLED: 'true', INVOICE_EMAIL_MODE: 'resend', INVOICE_EMAIL_QUALIFIED: 'true', INVOICE_SMS_MODE: 'disabled', APP_ENV: 'production', NODE_ENV: 'production', PREPAID_URL: 'https://prepaid.internal', INTERNAL_DELIVERY_SECRET: 'synthetic_internal_delivery_secret_at_least_32_bytes' };
  const saved = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, settings);
    assert.equal(invoiceDeliveryConfiguration(false).email, 'resend');
    process.env.INVOICE_EMAIL_RELAY_QUALIFIED = 'false';
    assert.equal(invoiceDeliveryConfiguration(false).email, 'disabled');
  } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
