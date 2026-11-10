import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import pg from 'pg';
import { buildApp } from '../dist/app.js';
import { processInvoiceDelivery } from '../dist/invoice-worker.js';

const database = process.env.PAMOFI_TEST_DATABASE_URL;
const secret = 'synthetic_invoice_delivery_secret_at_least_32_bytes';
const eventSecret = 'synthetic_invoice_event_secret_at_least_32_bytes';
const origin = 'https://pasofi.example.test';
const pdf = Buffer.from('%PDF-1.7\nSynthetic invoice bytes\n%%EOF');
const baseEnv = { DATABASE_URL: database ?? '', APP_ENV: 'demo', NODE_ENV: 'development', DELIVERY_WORKER_ENABLED: 'false', INVOICE_DELIVERY_WORKER_ENABLED: 'true', INVOICE_DELIVERY_WORKER_AUTOSTART: 'false', INVOICE_EMAIL_MODE: 'mock', INVOICE_SMS_MODE: 'mock', PREPAID_URL: 'http://prepaid.example.test', PUBLIC_ORIGIN: origin, INTERNAL_DELIVERY_SECRET: secret, INTERNAL_EVENTS_SECRET: eventSecret };
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json; charset=utf-8' } });
function environment(patch = {}) {
  const values = { ...baseEnv, ...patch }, saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  return () => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}
async function jwt(scope) { return new SignJWT({ scope }).setProtectedHeader({ alg: 'HS256' }).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('notification').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(scope === 'event:deliver' ? eventSecret : secret)); }
function envelope(reference = randomUUID()) { return { id: randomUUID(), type: 'invoice.issued', version: 1, producer: 'prepaid-access', aggregateId: reference, aggregateVersion: 1, occurredAt: new Date().toISOString(), correlationId: randomUUID(), payload: { invoiceId: reference } }; }
async function fixture(pool) {
  const invoice = randomUUID(), event = randomUUID(), job = randomUUID();
  await pool.query("INSERT INTO event_inbox(id,producer,event_type,aggregate_id,aggregate_version,payload_hash) VALUES($1,'test','invoice.issued',$2,1,$3)", [event, invoice, randomBytes(32)]);
  await pool.query('INSERT INTO invoice_jobs(id,event_id,invoice_id) VALUES($1,$2,$3)', [job, event, invoice]);
  return { invoice, event, job };
}
async function cleanup(pool, reference) {
  const jobs = (await pool.query('SELECT id,event_id FROM invoice_jobs WHERE invoice_id=$1', [reference])).rows;
  for (const row of jobs) { await pool.query('DELETE FROM invoice_jobs WHERE id=$1', [row.id]); await pool.query('DELETE FROM event_inbox WHERE id=$1', [row.event_id]); }
}
function details(invoice, channel = 'email', simulation = true) {
  return { invoiceId: invoice, invoiceNumber: 'PFI-000001', channel, simulation, to: channel === 'email' ? 'customer@example.test' : '263771000000', filename: 'PFI-000001.pdf', contentType: 'application/pdf', ...(channel === 'sms' ? { link: `${origin}/#invoice=${'a'.repeat(43)}`, expiresAt: new Date(Date.now() + 86400000).toISOString() } : {}) };
}

test('both event schemas survive validation and invoice events reject extra private recipient fields', async () => {
  const restore = environment({ DATABASE_URL: '' }); const app = buildApp();
  try {
    const event = envelope();
    assert.equal((await app.inject({ method: 'POST', url: '/internal/v1/events', payload: event })).statusCode, 503);
    assert.equal((await app.inject({ method: 'POST', url: '/internal/v1/events', payload: { ...event, type: 'agent.sale.created', payload: { deliveryReference: event.aggregateId } } })).statusCode, 503);
    assert.equal((await app.inject({ method: 'POST', url: '/internal/v1/events', payload: { ...event, payload: { ...event.payload, recipient: 'private@example.test' } } })).statusCode, 400);
  } finally { await app.close(); restore(); }
});

test('invoice inbox deduplicates concurrent payment events, conflicts on changed content and enforces private status scope', { skip: !database }, async () => {
  const restore = environment(), pool = new pg.Pool({ connectionString: database, max: 6 }), event = envelope(), app = buildApp();
  try {
    const headers = { authorization: `Bearer ${await jwt('event:deliver')}` };
    const results = await Promise.all(Array.from({ length: 6 }, () => app.inject({ method: 'POST', url: '/internal/v1/events', headers, payload: event })));
    assert.ok(results.every(result => result.statusCode === 200), results.map(r => r.body).join('\n'));
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM invoice_jobs WHERE invoice_id=$1', [event.aggregateId])).rows[0].n, 1);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM delivery_jobs WHERE delivery_reference=$1', [event.aggregateId])).rows[0].n, 0);
    assert.equal((await app.inject({ method: 'POST', url: '/internal/v1/events', headers, payload: { ...event, correlationId: randomUUID() } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: '/internal/v1/events', headers, payload: { ...event, type: 'agent.sale.created' } })).statusCode, 400);
    const path = `/internal/v1/invoices/${event.aggregateId}/status`;
    assert.equal((await app.inject({ url: path })).statusCode, 401);
    assert.equal((await app.inject({ url: path, headers: { authorization: `Bearer ${await jwt('delivery:status')}` } })).statusCode, 403);
    const status = await app.inject({ url: path, headers: { authorization: `Bearer ${await jwt('invoice:status')}` } });
    assert.equal(status.statusCode, 200); assert.equal(status.json().state, 'queued'); assert.equal(status.headers['cache-control'], 'no-store');
    assert.equal(status.json().to, undefined); assert.equal(status.json().link, undefined);
    const capability = await app.inject({ url: '/internal/v1/invoice-delivery/capabilities', headers: { authorization: `Bearer ${await jwt('invoice:status')}` } });
    assert.deepEqual(capability.json(), { email: true, sms: true, simulation: true });
  } finally { await app.close(); await cleanup(pool, event.aggregateId); await pool.end(); restore(); }
});

test('concurrent workers deliver one exact PDF or invoice link to the mock sink without persisting private content', { skip: !database }, async () => {
  const restore = environment(), pool = new pg.Pool({ connectionString: database, max: 8 }), originalFetch = globalThis.fetch;
  const fixtures = [];
  try {
    for (const channel of ['email', 'sms']) {
      const f = await fixture(pool); fixtures.push(f); const data = details(f.invoice, channel); let lookups = 0;
      globalThis.fetch = async (url, options) => {
        const parsed = new URL(url); assert.equal(parsed.origin, 'http://prepaid.example.test'); assert.equal(options.redirect, 'error');
        const { payload } = await jwtVerify(options.headers.authorization.slice(7), new TextEncoder().encode(secret), { issuer: 'notification', subject: 'notification', audience: 'prepaid-access', algorithms: ['HS256'] });
        assert.equal(payload.scope, 'invoice:read'); lookups++;
        return parsed.pathname.endsWith('/pdf') ? new Response(pdf, { headers: { 'content-type': 'application/pdf' } }) : json(data);
      };
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => processInvoiceDelivery(pool, true)));
      assert.equal(outcomes.filter(Boolean).length, 1);
      assert.equal(lookups, channel === 'email' ? 2 : 1);
      const sink = (await pool.query('SELECT * FROM mock_invoice_sink WHERE job_id=$1', [f.job])).rows[0];
      assert.equal(sink.channel, channel); assert.equal(sink.recipient_hash.length, 32);
      assert.equal(sink.to, undefined); assert.equal(sink.link, undefined); assert.equal(sink.pdf, undefined);
      if (channel === 'email') assert.deepEqual(sink.content_hash, createHash('sha256').update(pdf).digest());
      assert.equal((await pool.query('SELECT state FROM invoice_jobs WHERE id=$1', [f.job])).rows[0].state, 'delivered');
      assert.equal(await processInvoiceDelivery(pool, true), false);
    }
  } finally { globalThis.fetch = originalFetch; for (const f of fixtures) await cleanup(pool, f.invoice); await pool.end(); restore(); }
});

test('live email uses one provider send, reconciles by ID, and never resends an ambiguous or crashed submission', { skip: !database }, async () => {
  const restore = environment({ APP_ENV: 'production', NODE_ENV: 'production', PREPAID_URL: 'https://prepaid.example.test', INVOICE_EMAIL_MODE: 'resend', INVOICE_EMAIL_QUALIFIED: 'true', INVOICE_EMAIL_FROM: 'Pasofi <invoice@example.test>', RESEND_API_KEY: 'synthetic-test-key', INVOICE_SMS_MODE: 'disabled' });
  const pool = new pg.Pool({ connectionString: database, max: 5 }), originalFetch = globalThis.fetch, fixtures = []; let sends = 0, polls = 0, selected, ambiguous = false;
  try {
    globalThis.fetch = async (url, options) => {
      const parsed = new URL(url);
      if (parsed.origin === 'https://prepaid.example.test') return parsed.pathname.endsWith('/pdf') ? new Response(pdf, { headers: { 'content-type': 'application/pdf' } }) : json(details(selected.invoice, 'email', false));
      assert.equal(parsed.origin, 'https://api.resend.com');
      if (options.method === 'POST') { sends++; if (ambiguous) throw Error('synthetic ambiguous timeout'); assert.deepEqual(Buffer.from(JSON.parse(options.body).attachments[0].content, 'base64'), pdf); return json({ id: selected.job }); }
      polls++; return json({ id: selected.job, last_event: 'delivered' });
    };
    selected = await fixture(pool); fixtures.push(selected);
    await processInvoiceDelivery(pool, false);
    assert.equal((await pool.query('SELECT state FROM invoice_jobs WHERE id=$1', [selected.job])).rows[0].state, 'submitted');
    await pool.query('UPDATE invoice_jobs SET next_at=now() WHERE id=$1', [selected.job]);
    await processInvoiceDelivery(pool, false);
    assert.equal((await pool.query('SELECT state FROM invoice_jobs WHERE id=$1', [selected.job])).rows[0].state, 'delivered'); assert.equal(sends, 1); assert.equal(polls, 1);
    selected = await fixture(pool); fixtures.push(selected); ambiguous = true;
    await processInvoiceDelivery(pool, false);
    await pool.query('UPDATE invoice_jobs SET next_at=now() WHERE id=$1', [selected.job]); await processInvoiceDelivery(pool, false);
    const unknown = (await pool.query('SELECT state,last_error FROM invoice_jobs WHERE id=$1', [selected.job])).rows[0];
    assert.deepEqual(unknown, { state: 'unknown', last_error: 'manual_review_required' }); assert.equal(sends, 2); assert.equal(polls, 1);
    const crashed = await fixture(pool); fixtures.push(crashed);
    await pool.query("UPDATE invoice_jobs SET state='submitting',attempted_at=now()-interval '2 minutes',lease_until=now()-interval '1 minute' WHERE id=$1", [crashed.job]);
    await processInvoiceDelivery(pool, false);
    assert.equal((await pool.query('SELECT state FROM invoice_jobs WHERE id=$1', [crashed.job])).rows[0].state, 'unknown'); assert.equal(sends, 2);
    // Historical mock evidence cannot be relabelled live by a runtime change.
    await pool.query("UPDATE invoice_jobs SET provider='mock',state='delivered',delivered_at=now() WHERE id=$1", [crashed.job]);
    const app = buildApp();
    try {
      const result = await app.inject({ url: `/internal/v1/invoices/${crashed.invoice}/status`, headers: { authorization: `Bearer ${await jwt('invoice:status')}` } });
      assert.equal(result.statusCode, 200); assert.equal(result.json().simulation, true); assert.equal(result.json().provider, undefined);
    } finally { await app.close(); }
  } finally { globalThis.fetch = originalFetch; for (const f of fixtures) await cleanup(pool, f.invoice); await pool.end(); restore(); }
});

test('foreign or expired SMS links and simulation mismatch cannot reach a delivery sink', { skip: !database }, async () => {
  const restore = environment(), pool = new pg.Pool({ connectionString: database }), originalFetch = globalThis.fetch, fixtures = [];
  try {
    for (const patch of [{ link: `https://foreign.example.test/#invoice=${'a'.repeat(43)}` }, { expiresAt: '2020-01-01T00:00:00.000Z' }, { simulation: false }]) {
      const f = await fixture(pool); fixtures.push(f);
      globalThis.fetch = async () => json({ ...details(f.invoice, 'sms'), ...patch });
      await processInvoiceDelivery(pool, true);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM mock_invoice_sink WHERE job_id=$1', [f.job])).rows[0].n, 0);
      const job = (await pool.query('SELECT state,attempted_at FROM invoice_jobs WHERE id=$1', [f.job])).rows[0];
      assert.equal(job.state, 'queued'); assert.equal(job.attempted_at, null);
    }
  } finally { globalThis.fetch = originalFetch; for (const f of fixtures) await cleanup(pool, f.invoice); await pool.end(); restore(); }
});
