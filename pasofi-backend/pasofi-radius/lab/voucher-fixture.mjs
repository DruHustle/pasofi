import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { jwtVerify } from 'jose';
import pg from 'pg';
import { buildApp } from '/app/dist/app.js';
const url = new URL(process.env.DATABASE_URL);
assert.equal(url.hostname, 'postgres');
assert.equal(url.pathname, '/pamofi_prepaid_access');
assert.equal(process.env.APP_ENV, 'demo');
assert.equal(process.env.NODE_ENV, 'development');
const [customer, site, entitlementForUsage] = process.argv.slice(2);
const otherCustomer = randomUUID(),
  admin = randomUUID(),
  agent = randomUUID();
const origin = 'http://localhost:5173',
  identitySecret = randomBytes(48).toString('hex');
const people = {
  agent: { staffId: agent, role: 'agent', siteIds: [site], version: 1, mfaVerified: true },
  admin: { staffId: admin, role: 'admin', siteIds: [], version: 1, mfaVerified: true },
};
const identity = createServer(async (req, res) => {
  try {
    const { payload } = await jwtVerify(
      req.headers.authorization?.replace(/^Bearer /, ''),
      new TextEncoder().encode(identitySecret),
      { issuer: 'prepaid-access', subject: 'prepaid-access', audience: 'identity' },
    );
    const cookie = req.headers.cookie ?? '';
    const user = /^(?:staff|customer)=([a-z]+)$/.exec(cookie)?.[1];
    let value;
    if (
      req.url === '/internal/v1/session' &&
      payload.scope === 'identity:resolve' &&
      ['guest', 'other'].includes(user)
    )
      value = { customerId: user === 'guest' ? customer : otherCustomer };
    else if (req.url === '/internal/v1/staff/session' && payload.scope === 'staff:resolve' && people[user])
      value = people[user];
    else if (req.url?.startsWith('/internal/v1/staff/users/') && payload.scope === 'staff:read') {
      const id = req.url.split('/').at(-1);
      const record = Object.values(people).find((p) => p.staffId === id);
      if (record) value = { ...record, status: 'approved' };
    }
    if (!value) {
      res.writeHead(401);
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  } catch {
    res.writeHead(401);
    res.end('{}');
  }
});
await new Promise((resolve) => identity.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, {
  IDENTITY_URL: 'http://127.0.0.1:' + identity.address().port,
  INTERNAL_IDENTITY_SECRET: identitySecret,
  INTERNAL_DELIVERY_SECRET: randomBytes(42).toString('hex'),
  PUBLIC_ORIGIN: origin,
  PAMOFI_COMMERCE_ENABLED: 'true',
  VOUCHER_DELIVERY_ACTIVE_KEY_ID: 'v1',
  VOUCHER_DELIVERY_KEYS_JSON: JSON.stringify({ v1: randomBytes(32).toString('base64') }),
  PAMOFI_AGENT_COMMISSION_BPS: '1000',
  PAMOFI_PAYMENTS_ENABLED: 'false',
  PAMOFI_PAYMENT_MODE: 'disabled',
  PAYMENT_RECONCILIATION_WORKER_ENABLED: 'false',
  PAMOFI_SMS_DELIVERY_ENABLED: 'false',
});
const app = buildApp();
const db = new pg.Pool({ connectionString: url.toString(), max: 1 });
async function call(method, path, body, who, key = randomUUID()) {
  return app.inject({
    method,
    url: path,
    headers: {
      origin,
      cookie: who === 'guest' || who === 'other' ? 'customer=' + who : 'staff=' + who,
      'idempotency-key': key,
    },
    ...(body === undefined ? {} : { payload: body }),
  });
}
function ok(r, step, allowed = [200, 201]) {
  assert(
    allowed.includes(r.statusCode),
    step + ' HTTP ' + r.statusCode + ' ' + String(r.json()?.error ?? '').slice(0, 80),
  );
  return r.json();
}
try {
  if (entitlementForUsage) {
    const usage = ok(
      await call('GET', '/v1/usage?entitlementIds=' + entitlementForUsage, undefined, 'guest'),
      'usage',
    );
    assert.equal(usage.totals.bundleCount, 1);
    assert.equal(usage.totals.usedBytes, '4294967306');
    assert.equal(usage.totals.remainingBytes, '705032694');
    assert.equal(usage.entitlementUpdates[0].id, entitlementForUsage);
    assert.equal(usage.entitlementUpdates[0].consumed_bytes, usage.totals.usedBytes);
    const foreign = ok(
      await call('GET', '/v1/usage?entitlementIds=' + entitlementForUsage, undefined, 'other'),
      'other usage',
    );
    assert.deepEqual(foreign.entitlementUpdates, []);
    assert.equal(foreign.totals.bundleCount, 0);
  } else {
    const c = ok(await call('GET', '/v1/capabilities', undefined, 'guest'), 'capability');
    assert(!c.paymentCheckout && c.vouchers && c.staffSales);
    ok(
      await call('POST', '/v1/admin/sites', { id: site, name: 'Isolated authorization site' }, 'admin'),
      'site',
    );
    ok(
      await call(
        'POST',
        '/v1/staff/cash-shifts',
        { siteId: site, currency: 'USD', openingMinor: 0 },
        'agent',
      ),
      'shift',
    );
    ok(
      await call(
        'POST',
        '/v1/admin/inventory/allocations',
        {
          agentId: agent,
          siteId: site,
          bundleId: 'flex',
          quantity: 1,
          reason: 'Isolated no-provider verification stock',
        },
        'admin',
      ),
      'inventory',
    );
    const pair = ok(
      await call('POST', '/v1/receipt-pairings', { bundleId: 'flex', siteId: site }, 'guest'),
      'pair',
    ).pairing;
    const product = ok(await call('GET', '/v1/bundles', undefined, 'guest'), 'catalogue').products.find(
      (p) => p.id === 'flex',
    );
    assert(product);
    const sale = {
      siteId: site,
      bundleId: 'flex',
      delivery: 'receipt',
      pairingCode: pair.code,
      payment: {
        method: 'cash',
        confirmed: true,
        amountMinor: Number(product.price_minor),
        currency: product.currency,
      },
    };
    const key = randomUUID();
    const order = ok(await call('POST', '/v1/staff/sales', sale, 'agent', key), 'sale').sale;
    assert.equal(
      ok(await call('POST', '/v1/staff/sales', sale, 'agent', key), 'sale replay').sale.id,
      order.id,
    );
    const receipt = ok(
      await call('GET', '/v1/receipt-pairings/' + pair.id, undefined, 'guest'),
      'receipt',
    ).receipt;
    const code = receipt.voucher.code;
    const entitlement = ok(
      await call('POST', '/v1/vouchers/redeem', { code }, 'guest'),
      'redeem',
    ).entitlementId;
    assert.equal(
      ok(await call('POST', '/v1/vouchers/redeem', { code }, 'guest'), 'redeem replay').entitlementId,
      entitlement,
    );
    assert(
      [400, 403, 404, 409].includes(
        (await call('POST', '/v1/vouchers/redeem', { code }, 'other')).statusCode,
      ),
      'foreign redemption accepted',
    );
    const proof = await db.query(
      'SELECT e.id,e.activated_at,e.byte_limit FROM purchase_entitlements e JOIN issued_vouchers v ON v.id=e.source_voucher_id WHERE e.customer_id=$1 AND v.sale_id=$2',
      [customer, order.id],
    );
    assert.equal(proof.rowCount, 1);
    assert.equal(proof.rows[0].id, entitlement);
    assert.equal(proof.rows[0].activated_at, null);
    assert.equal(proof.rows[0].byte_limit, '5000000000');
    process.stdout.write(entitlement + '\n');
  }
} finally {
  await app.close();
  await db.end();
  await new Promise((resolve) => identity.close(resolve));
}
