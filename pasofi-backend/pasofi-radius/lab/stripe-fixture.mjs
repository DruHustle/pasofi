import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { jwtVerify } from 'jose';
import pg from 'pg';
import Stripe from 'stripe';
import { buildApp } from './dist/app.js';
import { processPaymentReconciliation } from './dist/payment-reconciliation.js';
import { StripeAdapter, stripeConfiguration } from './dist/stripe.js';

const database = new URL(process.env.DATABASE_URL);
assert.equal(process.env.PAMOFI_TEST_CONFIRM_ISOLATED, '1');
assert(['postgres', '127.0.0.1'].includes(database.hostname));
assert.equal(database.pathname, '/pamofi_prepaid_access');
assert.equal(database.username, 'pamofi_prepaid_access');
assert.equal(database.password, 'demo_only_change_me');
assert(!database.search && !database.hash);
assert.equal(process.env.APP_ENV, 'demo');
assert.equal(process.env.NODE_ENV, 'development');

const [customerId, siteId, settledOrderId] = process.argv.slice(2);
for (const id of [customerId, siteId, ...(settledOrderId ? [settledOrderId] : [])]) {
  assert.match(id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
}
const foreignId = randomUUID();
const origin = 'http://localhost:5173';
const identitySecret = randomBytes(48).toString('hex');
const merchantId = 'acct_SyntheticRadiusLab';
const country = 'DE';
const syntheticKey = (...prefix) => [...prefix, randomBytes(24).toString('hex')].join('_');
const secretKey = syntheticKey('sk', 'test');
const webhookSecret = syntheticKey('whsec');
const identity = createServer(async (req, res) => {
  try {
    assert.equal(req.url, '/internal/v1/session');
    const { payload } = await jwtVerify(req.headers.authorization?.replace(/^Bearer /, ''), new TextEncoder().encode(identitySecret), {
      issuer: 'prepaid-access', subject: 'prepaid-access', audience: 'identity', algorithms: ['HS256'],
    });
    assert.equal(payload.scope, 'identity:resolve');
    const account = new Map([['customer=owner', customerId], ['customer=other', foreignId]]).get(req.headers.cookie);
    assert(account);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ customerId: account }));
  } catch {
    res.writeHead(401);
    res.end('{}');
  }
});
await new Promise((resolve) => identity.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, {
  IDENTITY_URL: 'http://127.0.0.1:' + identity.address().port,
  INTERNAL_IDENTITY_SECRET: identitySecret,
  PUBLIC_ORIGIN: origin,
  PAMOFI_PAYMENTS_ENABLED: 'true',
  PAMOFI_PAYMENT_MODE: 'sandbox',
  PAMOFI_PAYMENT_PROVIDER: 'stripe',
  STRIPE_SECRET_KEY: secretKey,
  STRIPE_PUBLISHABLE_KEY: syntheticKey('pk', 'test'),
  STRIPE_WEBHOOK_SECRET: webhookSecret,
  STRIPE_ACCOUNT_ID: merchantId,
  STRIPE_MERCHANT_COUNTRY: country,
  STRIPE_QUALIFIED_SITE_IDS_JSON: JSON.stringify([siteId]),
  STRIPE_APPLE_PAY_ENABLED: 'false',
  STRIPE_GOOGLE_PAY_ENABLED: 'false',
  PAYMENT_RECONCILIATION_WORKER_ENABLED: 'false',
});

let intent;
function makeIntent(id, amount, currency, metadata, captured) {
  return {
    id, object: 'payment_intent', amount, currency, metadata, livemode: false,
    capture_method: 'automatic', payment_method_types: ['card'], client_secret: id + '_secret_SYNTHETIC',
    status: captured ? 'succeeded' : 'requires_payment_method',
    amount_received: captured ? amount : 0,
    latest_charge: captured ? {
      id: 'ch_SyntheticRadiusLab', object: 'charge', payment_intent: id, amount, currency,
      livemode: false, paid: true, captured: true, refunded: false, amount_refunded: 0, disputed: false,
    } : null,
  };
}

// The real SDK serializes requests and validates webhook bytes. Its injected
// transport handles only the synthetic account and intent, with no network call.
const stripe = new Stripe(secretKey, {
  apiVersion: '2026-10-28.endive',
  maxNetworkRetries: 0,
  httpClient: Stripe.createFetchHttpClient(async (url, options) => {
    const target = new URL(url);
    assert.equal(target.origin, 'https://api.stripe.com');
    let body;
    if (options.method === 'GET' && target.pathname === '/v1/account') {
      body = { object: 'account', id: merchantId, country, charges_enabled: true };
    } else if (options.method === 'POST' && target.pathname === '/v1/payment_intents') {
      assert(!intent, 'checkout must not create another payment intent');
      const form = new URLSearchParams(options.body);
      const metadata = Object.fromEntries([...form].flatMap(([key, value]) => {
        const match = /^metadata\[([^\]]+)\]$/.exec(key);
        return match ? [[match[1], value]] : [];
      }));
      assert.equal(metadata.pasofi_customer_id, customerId);
      assert.equal(metadata.pasofi_site_id, siteId);
      intent = makeIntent('pi_' + randomBytes(16).toString('hex'), Number(form.get('amount')), form.get('currency'), metadata, false);
      body = intent;
    } else {
      assert(intent && options.method === 'GET' && target.pathname === '/v1/payment_intents/' + intent.id);
      body = intent;
    }
    return Response.json(body, { headers: { 'request-id': 'req_SyntheticRadiusLab' } });
  }),
});
const db = new pg.Pool({ connectionString: database.toString(), max: 2 });
const app = buildApp(stripe);
async function call(method, url, payload, status = 200, owner = 'owner') {
  const result = await app.inject({
    method, url, payload,
    headers: { origin, cookie: 'customer=' + owner, 'idempotency-key': randomUUID() },
  });
  assert.equal(result.statusCode, status, method + ' ' + url);
  return result.json();
}

try {
  if (!settledOrderId) {
    await db.query('INSERT INTO sales_locations(id,name) VALUES($1,$2)', [siteId, 'Isolated card test NAS']);
    const { order } = await call('POST', '/v1/orders', { bundleId: 'flex', mode: 'checkout' }, 201);
    const checkout = await call('POST', '/v1/orders/' + order.id + '/checkout', { siteId, methodCode: 'STRIPE_CARD' });
    assert.equal(checkout.state, 'pending');
    assert.equal(checkout.stripe.testMode, true);
    assert.equal(checkout.stripe.clientSecret, intent.client_secret);
    assert.equal((await call('GET', '/v1/orders/' + order.id + '/status')).entitlementId, null);
    process.stdout.write(order.id + '\n');
  } else {
    const result = await db.query(`SELECT a.id,a.provider_reference,o.price_minor,o.currency FROM provider_payment_attempts a
      JOIN purchase_orders o ON o.id=a.order_id
      WHERE o.id=$1 AND o.customer_id=$2 AND a.customer_id=$2 AND a.site_id=$3 AND a.provider='stripe_test'`,
      [settledOrderId, customerId, siteId]);
    assert.equal(result.rowCount, 1);
    const attempt = result.rows[0];
    intent = makeIntent(attempt.provider_reference, attempt.price_minor, attempt.currency.toLowerCase(), {
      pasofi_attempt_id: attempt.id, pasofi_order_id: settledOrderId, pasofi_customer_id: customerId,
      pasofi_site_id: siteId, pasofi_method_code: 'STRIPE_CARD',
    }, true);
    const eventId = 'evt_' + randomBytes(16).toString('hex');
    const payload = JSON.stringify({
      id: eventId, type: 'payment_intent.succeeded', livemode: false, data: { object: { id: intent.id } },
    });
    const notify = (signature) => app.inject({
      method: 'POST', url: '/callbacks/stripe', payload,
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    });
    const statusPath = '/v1/orders/' + settledOrderId + '/status';
    assert.equal((await notify('invalid')).statusCode, 400);
    assert.equal((await call('GET', statusPath)).entitlementId, null);

    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: webhookSecret });
    assert.equal((await notify(signature)).statusCode, 204);
    assert.equal((await notify(signature)).statusCode, 204);
    const adapter = new StripeAdapter(stripeConfiguration(true), stripe);
    assert.equal(await processPaymentReconciliation(db, adapter), true);
    assert.equal(await processPaymentReconciliation(db, adapter), false);

    const settled = await call('GET', statusPath);
    assert.equal(settled.fulfillmentState, 'fulfilled');
    assert.equal(settled.simulation, true);
    assert(settled.entitlementId);
    await call('GET', statusPath, undefined, 404, 'other');
    const proof = await db.query(`SELECT e.id FROM purchase_entitlements e
      JOIN verified_charges c ON c.fulfilled_entitlement_id=e.id AND c.order_id=e.order_id
      JOIN paid_invoices i ON i.order_id=e.order_id AND i.customer_id=e.customer_id
      WHERE e.order_id=$1 AND e.customer_id=$2 AND i.simulation AND i.total_minor=c.amount_minor AND i.currency=c.currency`,
      [settledOrderId, customerId]);
    assert.deepEqual(proof.rows, [{ id: settled.entitlementId }]);
    process.stdout.write(settled.entitlementId + '\n');
  }
} finally {
  await app.close();
  await db.end();
  await new Promise((resolve) => identity.close(resolve));
}
