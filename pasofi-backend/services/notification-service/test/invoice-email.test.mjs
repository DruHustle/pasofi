import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResendInvoiceAdapter, invoiceSender } from '../dist/invoice-email.js';
import { invoiceDeliveryConfiguration } from '../dist/invoice-worker.js';

const id = '0f9c1b3a-6d2e-4a1b-9c3d-7e5f2a8b4c10';
const input = { id, to: 'customer@example.test', from: 'Pasofi <invoice@example.test>', number: 'PFI-000001', filename: 'PFI-000001.pdf', pdf: Buffer.from('%PDF-1.7\nsynthetic attachment\n%%EOF') };
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('invoice email attaches the exact PDF, uses stable idempotency and awaits provider delivery evidence', async () => {
  const calls = [];
  const adapter = new ResendInvoiceAdapter('synthetic-test-key', async (url, options) => {
    calls.push({ url, options });
    return options.method === 'POST' ? response({ id: id.toUpperCase() }) : response({ id, last_event: 'delivered' });
  });
  assert.equal((await adapter.send(input)).state, 'submitted');
  const sent = calls[0];
  assert.equal(sent.url, 'https://api.resend.com/emails');
  assert.equal(sent.options.redirect, 'error');
  assert.equal(sent.options.headers['idempotency-key'], `pasofi-invoice/${id}`);
  const payload = JSON.parse(sent.options.body);
  assert.deepEqual(payload.to, [input.to]);
  assert.deepEqual(Buffer.from(payload.attachments[0].content, 'base64'), input.pdf);
  assert.equal(payload.attachments[0].filename, input.filename);
  assert.equal(payload.attachments[0].path, undefined);
  assert.equal((await adapter.retrieve(id)).state, 'delivered');
  assert.equal(calls[1].url, `https://api.resend.com/emails/${id}`);
  assert.equal(calls.length, 2);
});

test('email ambiguity is never delivery and only an explicit rate rejection permits an automatic retry', async () => {
  for (const handler of [async () => { throw Error('synthetic timeout'); }, async () => response({}, 500), async () => response({ id: 'invalid' }), async () => new Response('x'.repeat(65537))]) {
    assert.equal((await new ResendInvoiceAdapter('synthetic', handler).send(input)).state, 'unknown');
  }
  assert.equal((await new ResendInvoiceAdapter('synthetic', async () => response({}, 403)).send(input)).state, 'failed');
  const throttled = await new ResendInvoiceAdapter('synthetic', async () => response({}, 429, { 'retry-after': '120' })).send(input);
  assert.deepEqual(throttled, { state: 'retry', providerId: null, error: 'provider_rate_limited', retryAfter: 120 });
  for (const event of ['sent', 'queued', 'delivery_delayed']) assert.equal((await new ResendInvoiceAdapter('synthetic', async () => response({ id, last_event: event })).retrieve(id)).state, 'submitted');
  for (const event of ['bounced', 'complained', 'failed']) assert.equal((await new ResendInvoiceAdapter('synthetic', async () => response({ id, last_event: event })).retrieve(id)).state, 'failed');
  assert.equal((await new ResendInvoiceAdapter('synthetic', async () => response({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', last_event: 'delivered' })).retrieve(id)).state, 'unknown');
});

test('invalid recipients, header injection, remote filenames and non-PDF content never reach the provider', async () => {
  let sends = 0;
  const adapter = new ResendInvoiceAdapter('synthetic', async () => { sends++; return response({ id }); });
  for (const patch of [{ to: 'one@example.test,two@example.test' }, { to: 'one@example.test\r\nBcc: other@example.test' }, { from: 'Pasofi\r\nBcc: other@example.test' }, { filename: '../private.pdf' }, { pdf: Buffer.from('<html>') }, { pdf: Buffer.alloc(1048577) }, { number: 'PFI\n1' }]) {
    await assert.rejects(adapter.send({ ...input, ...patch }), /invalid_invoice_email/);
  }
  assert.equal(sends, 0);
  assert.equal(invoiceSender('Pasofi <invoice@example.test>'), true);
  assert.equal(invoiceSender('invoice@example.test'), true);
});

test('invoice capabilities require explicit production qualification and cannot be enabled by demo provider settings', () => {
  const settings = { INVOICE_DELIVERY_WORKER_ENABLED: 'true', INVOICE_EMAIL_MODE: 'resend', INVOICE_EMAIL_QUALIFIED: 'true', INVOICE_EMAIL_FROM: input.from, RESEND_API_KEY: 'synthetic', INVOICE_SMS_MODE: 'sendai', INVOICE_SMS_QUALIFIED: 'true', INVOICE_SMS_FROM: 'Pasofi', SENDAI_LIVE_ENABLED: 'true', SENDAI_QUALIFIED: 'true', SENDAI_API_KEY: 'synthetic', APP_ENV: 'production', NODE_ENV: 'production', PREPAID_URL: 'https://prepaid.internal', PUBLIC_ORIGIN: 'https://pasofi.example.test', INTERNAL_DELIVERY_SECRET: 'synthetic_delivery_secret_at_least_32_bytes' };
  const saved = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  try {
    for (const key of Object.keys(settings)) delete process.env[key];
    assert.equal(invoiceDeliveryConfiguration(false).enabled, false);
    Object.assign(process.env, settings);
    assert.equal(invoiceDeliveryConfiguration(false).email, 'resend');
    assert.equal(invoiceDeliveryConfiguration(false).sms, 'sendai');
    assert.equal(invoiceDeliveryConfiguration(true).enabled, false);
    process.env.INVOICE_EMAIL_QUALIFIED = 'false'; process.env.INVOICE_SMS_QUALIFIED = 'false';
    assert.equal(invoiceDeliveryConfiguration(false).enabled, false);
    Object.assign(process.env, settings, { PREPAID_URL: 'http://prepaid.internal' });
    assert.equal(invoiceDeliveryConfiguration(false).enabled, false);
    Object.assign(process.env, settings, { INVOICE_SMS_FROM: 'Unregistered sender name' });
    assert.equal(invoiceDeliveryConfiguration(false).sms, 'disabled');
  } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
