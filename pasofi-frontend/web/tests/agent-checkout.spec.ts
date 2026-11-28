import { test as base, expect, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { usageSnapshot } from './usage-fixture';

const mobile = false;
const apiOrigin = 'https://api.pamofi.test';
const customerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', otherCustomer = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const siteId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', orderId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const offerId = '11111111-1111-4111-8111-111111111111', otherOffer = '22222222-2222-4222-8222-222222222222';
const code = 'A'.repeat(43), otherCode = 'B'.repeat(43);
const source = { id: offerId, siteId, siteName: 'Synthetic agent location' };
const quote = { bundleId: 'flex', siteId, siteName: source.siteName, priceMinor: 500, currency: 'USD', byteLimit: '5000000000', validitySeconds: 604800 };
const capabilities = { demo: false, paymentMode: 'sandbox', paymentCheckout: true, vouchers: false, receiptPairing: false,
  staffSales: false, agentDigitalSales: true, agentCheckoutRecovery: true, deliverySms: false, networkAccess: false, mobileCookies: mobile, nativeCustomerApiVersion: 1 };

// Each worker owns a loopback preview. Provider, API and wallet replies below are
// synthetic; these tests do not qualify a Stripe account or an installed wallet.
const test = base.extend<{}, { checkoutBaseURL: string }>({
  checkoutBaseURL: [async ({}, use) => {
    const port = await new Promise<number>((resolve, reject) => {
      const socket = createServer(); socket.once('error', reject); socket.listen(0, '127.0.0.1', () => {
        const address = socket.address(); if (!address || typeof address === 'string') return reject(Error('No loopback address'));
        socket.close(error => error ? reject(error) : resolve(address.port));
      });
    });
    const directory = fileURLToPath(new URL('../', import.meta.url));
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: directory, env: { ...process.env, VITE_PAMOFI_API_BASE_URL: mobile ? apiOrigin : '', VITE_PASOFI_HOTSPOT_PORTAL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; server.stdout.on('data', data => { output = (output + data).slice(-3000); }); server.stderr.on('data', data => { output = (output + data).slice(-3000); });
    const origin = `http://127.0.0.1:${port}`;
    try {
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        if (server.exitCode !== null) throw Error(`Agent checkout preview exited: ${output}`);
        try { if ((await fetch(origin)).ok) { ready = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!ready) throw Error(`Agent checkout preview unavailable: ${output}`);
      await use(origin);
    } finally {
      server.kill('SIGTERM');
      await new Promise<void>(resolve => { if (server.exitCode !== null) return resolve(); const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000); server.once('exit', () => { clearTimeout(timer); resolve(); }); });
    }
  }, { scope: 'worker' }],
});

type Source = typeof source;
type Order = { id: string; bundle_id: string; price_minor: number; currency: string; status: string; quote_expires_at: string; purchase_mode: string; agentCheckout?: Source | null };
type Call = { key: string; body: Record<string, any> };
async function fixture(page: Page, baseURL: string) {
  const state = { owner: customerId as string | null, status: 'unclaimed', available: true, expired: false, created: false, verified: false,
    createSource: undefined as Source | null | undefined, lookupSource: undefined as Source | null | undefined, statusSource: undefined as Source | null | undefined,
    loseOrderReply: false, loseCheckoutReply: false, stripe: false, replayOrderId: null as string | null };
  const calls = { previews: [] as Record<string, any>[], orders: [] as Call[], checkouts: [] as Call[], lookups: [] as string[], signIns: [] as Record<string, any>[] };
  let order: Order | null = null;
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const headers = { 'Access-Control-Allow-Origin': request.headers().origin || baseURL, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type,Idempotency-Key', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' };
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (path === '/api/capabilities') return json(capabilities);
    if (path === '/api/session') return state.owner ? json({ customerId: state.owner }) : json({ error: 'onesa_sign_in_required' }, 401);
    if (path === '/api/onesa/availability') return json({ origin: baseURL, signup: true });
    if (path === '/api/onesa/start') { calls.signIns.push(request.postDataJSON()); return json({ authorizationUrl: 'https://auth.onesa.eu/authorize?state=' + 'S'.repeat(43), expiresIn: 900 }); }
    if (path === '/api/bundles') return json({ products: [{ id: 'flex', price_minor: 500, currency: 'USD', byte_limit: '5000000000', validity_seconds: 604800 }, { id: 'week', price_minor: 900, currency: 'USD', byte_limit: '20000000000', validity_seconds: 604800 }], candidate: false });
    if (path === '/api/sites') return json({ sites: [{ id: siteId, name: source.siteName }, { id: otherCustomer, name: 'Another synthetic location' }] });
    if (path === '/api/help') return json({ articles: [] });
    if (path === '/api/recovery/status') return json({ configured: false });
    if (path === '/api/usage') return json(usageSnapshot('0', { allowanceBytes: '0' }));
    if (path === '/api/access') return json({ customerId: state.owner, entitlements: [], hasMore: false, nextOffset: null });
    if (path === '/api/payments/methods') return json({ enabled: true, methods: [
      { code: 'ECOCASH', name: 'EcoCash', currency: 'USD', minMinor: 50, maxMinor: 50000 },
      { code: 'STRIPE_CARD', name: 'Card or mobile wallet', currency: 'USD', minMinor: 50, maxMinor: 99999999 },
    ] });
    if (path === '/api/agent-checkouts/preview') {
      expect(request.method()).toBe('POST'); expect(url.search).toBe('');
      const payload = request.postDataJSON(); calls.previews.push(payload);
      return json({ checkout: { id: payload.id, status: state.created ? 'claimed' : state.status,
        quote: { ...quote, siteName: payload.id === otherOffer ? 'Other agent offer' : quote.siteName }, expiresAt: new Date(Date.now() + (state.expired ? -1000 : 600000)).toISOString(), simulation: true }, available: !state.created && state.available && state.status === 'unclaimed' && !state.expired });
    }
    if (path === '/api/orders' && request.method() === 'POST') {
      const body = request.postDataJSON(); calls.orders.push({ key: request.headers()['idempotency-key'], body });
      if (!order) order = { id: orderId, bundle_id: body.bundleId, price_minor: 500, currency: 'USD', status: 'awaiting_payment', quote_expires_at: new Date(Date.now() + 600000).toISOString(), purchase_mode: 'checkout', ...(body.agentCheckout ? { agentCheckout: source } : {}) };
      state.created = true;
      if (state.loseOrderReply) { state.loseOrderReply = false; return route.abort('failed'); }
      return json({ order: { ...order, ...(state.replayOrderId ? { id: state.replayOrderId } : {}), ...(state.createSource !== undefined ? { agentCheckout: state.createSource } : {}) } });
    }
    if (path === '/api/orders') {
      const key = url.searchParams.get('requestKey'); if (key) calls.lookups.push(key);
      return json({ customerId: state.owner, lookupKey: key, orders: order ? [{ ...order, ...(state.lookupSource !== undefined ? { agentCheckout: state.lookupSource } : {}) }] : [] });
    }
    if (path === `/api/orders/${orderId}/checkout`) {
      calls.checkouts.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() });
      if (state.loseCheckoutReply) { state.loseCheckoutReply = false; return route.abort('failed'); }
      return json({ attemptId: orderId, state: 'pending', redirectUrl: null, simulation: true, ...(state.stripe ? { stripe: { provider: 'stripe', clientSecret: 'pi_SyntheticAgent123_secret_SYNTHETIC', publishableKey: ['pk', 'test', 'SYNTHETIC'].join('_'), testMode: true, merchantCountryCode: 'GB', merchantDisplayName: 'PasoFi', applePayMerchantId: 'merchant.invalid.synthetic', googlePay: true } } : {}) });
    }
    if (path === `/api/orders/${orderId}/status`) return json({ order: { ...order, ...(state.statusSource !== undefined ? { agentCheckout: state.statusSource } : {}) }, attempts: [{ id: orderId, state: state.verified ? 'succeeded' : 'pending' }], entitlementId: state.verified ? otherOffer : null, entitlementRevokedAt: null, fulfillmentState: state.verified ? 'fulfilled' : 'unconfirmed', simulation: true });
    return json({ error: 'unexpected_request' }, 500);
  });
  return { state, calls };
}
const link = (id = offerId, token = code) => `#checkout?agentCheckout=${id}.${token}`;
async function openOffer(page: Page, origin: string) {
  await page.goto(origin + '/' + link());
  await expect(page.getByRole('heading', { name: 'Agent checkout', exact: true })).toBeVisible();
  await expect(page.locator('.customer-agent-offer').getByText(source.siteName, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Purchase site')).toHaveValue(siteId);
}
async function prepare(page: Page) {
  await page.getByRole('checkbox', { name: /reviewed the price/ }).check();
  await page.getByRole('button', { name: 'Prepare checkout', exact: true }).click();
}

test('agent offer is read-only on entry, private in the address, and fixes the Stripe purchase source', async ({ page, checkoutBaseURL }, info) => {
  const f = await fixture(page, checkoutBaseURL);
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
  await openOffer(page, checkoutBaseURL);
  expect(page.url()).not.toContain(code); expect(f.calls.orders).toHaveLength(0); expect(f.calls.checkouts).toHaveLength(0);
  await expect(page.getByLabel('Purchase site')).toBeDisabled(); await expect(page.getByRole('combobox', { name: 'Bundle', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Payment method')).toHaveValue('STRIPE_CARD');
  await expect(page.getByLabel('Payment method').locator('option[value="ECOCASH"]')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(code);
  await page.screenshot({ path: info.outputPath('agent-offer.png'), fullPage: true });
  await prepare(page);
  await expect(page.getByRole('button', { name: 'Check verified payment status' })).toBeVisible();
  expect(f.calls.orders).toHaveLength(1); expect(f.calls.orders[0].body).toEqual({ bundleId: 'flex', mode: 'checkout', agentCheckout: { id: offerId, code } });
  expect(f.calls.checkouts).toHaveLength(1); expect(f.calls.checkouts[0].body).toEqual({ siteId, methodCode: 'STRIPE_CARD' });
  await expect(page.getByText('Agent checkout · ' + source.siteName, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check verified payment status' }).click();
  await expect(page.getByText('Bundle queued', { exact: true })).toHaveCount(0);
  f.state.verified = true;
  await page.getByRole('button', { name: 'Check verified payment status' }).click();
  await expect(page.getByText('Bundle queued', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(code);
  expect(f.calls.checkouts).toHaveLength(1);
});

for (const lost of ['order', 'checkout']) test(`lost ${lost} reply survives reload and reuses the original owner-bound keys`, async ({ page, checkoutBaseURL }) => {
  const f = await fixture(page, checkoutBaseURL);
  f.state.loseOrderReply = lost === 'order'; f.state.loseCheckoutReply = lost === 'checkout';
  await openOffer(page, checkoutBaseURL); await prepare(page);
  await expect(page.getByText('Checkout could not be confirmed.', { exact: false })).toBeVisible();
  const orderKey = f.calls.orders[0].key, checkoutKey = f.calls.checkouts[0]?.key;
  await page.reload();
  await expect(page.getByText('Your saved order was found.', { exact: false })).toBeVisible();
  expect(f.calls.orders).toHaveLength(1); expect(f.calls.lookups).toContain(orderKey);
  expect(f.calls.checkouts).toHaveLength(lost === 'order' ? 0 : 1);
  await page.getByRole('checkbox', { name: /reviewed the price/ }).check();
  await page.getByRole('button', { name: 'Retry this checkout safely' }).click();
  await expect(page.getByText('Simulation checkout prepared.', { exact: false })).toBeVisible();
  expect(f.calls.orders).toHaveLength(2); expect(new Set(f.calls.orders.map(call => call.key)).size).toBe(1);
  expect(f.calls.orders[1].body).toEqual(f.calls.orders[0].body);
  if (checkoutKey) expect(f.calls.checkouts[1].key).toBe(checkoutKey);
  expect(f.calls.checkouts.at(-1)!.body).toEqual({ siteId, methodCode: 'STRIPE_CARD' });
});

for (const kind of ['create', 'lookup', 'status']) test(`a mismatching ${kind} source cannot replace the saved offer or confirm payment`, async ({ page, checkoutBaseURL }) => {
  const f = await fixture(page, checkoutBaseURL), wrong = { ...source, id: otherOffer };
  if (kind === 'create') f.state.createSource = wrong;
  if (kind === 'lookup') { f.state.loseOrderReply = true; f.state.lookupSource = wrong; }
  await openOffer(page, checkoutBaseURL); await prepare(page);
  if (kind === 'create') {
    await expect(page.getByText('The order does not match the saved agent checkout.', { exact: false })).toBeVisible();
    expect(f.calls.checkouts).toHaveLength(0);
  } else if (kind === 'lookup') {
    await expect(page.getByText('Checkout could not be confirmed.', { exact: false })).toBeVisible(); await page.reload();
    await expect(page.getByText('Your checkout is still saved. Its order could not be loaded.', { exact: false })).toBeVisible();
    expect(f.calls.checkouts).toHaveLength(0); expect(f.calls.orders).toHaveLength(1);
  } else {
    await expect(page.getByRole('button', { name: 'Check verified payment status' })).toBeVisible();
    f.state.statusSource = wrong; f.state.verified = true;
    await page.getByRole('button', { name: 'Check verified payment status' }).click();
    await expect(page.getByText('The order does not match the saved agent checkout.', { exact: false })).toBeVisible();
    await expect(page.getByText('Bundle queued', { exact: true })).toHaveCount(0);
  }
  const saved = await page.evaluate(id => sessionStorage.getItem(`pamofi.operation:customer:${id}:purchase-details`), customerId);
  expect(saved).toContain(offerId); expect(saved).not.toContain(otherOffer);
});

for (const previous of ['agent', 'direct']) test(`a new agent link cannot overwrite an unfinished ${previous} purchase`, async ({ page, checkoutBaseURL }) => {
  const f = await fixture(page, checkoutBaseURL);
  if (previous === 'agent') await openOffer(page, checkoutBaseURL);
  else { await page.goto(checkoutBaseURL + '/#checkout?bundle=flex'); await page.getByLabel('Payment method').selectOption('STRIPE_CARD'); }
  await prepare(page); await expect(page.getByRole('button', { name: 'Check verified payment status' })).toBeVisible();
  await page.evaluate(hash => { location.hash = hash; }, link(otherOffer, otherCode));
  await expect(page.getByText('Your earlier purchase is still saved.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Retry this checkout safely' }).click();
  await expect.poll(() => f.calls.orders.length).toBe(2);
  expect(f.calls.orders[1]).toEqual(f.calls.orders[0]);
  expect(f.calls.previews.some(call => call.id === otherOffer)).toBe(false);
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(otherCode);
});

for (const status of ['claimed', 'expired', 'disabled']) test(`${status} agent offers do not start payment`, async ({ page, checkoutBaseURL }) => {
  const f = await fixture(page, checkoutBaseURL); f.state.status = status === 'disabled' ? 'unclaimed' : status; f.state.available = false; f.state.expired = status === 'expired';
  await openOffer(page, checkoutBaseURL); await page.getByRole('checkbox', { name: /reviewed the price/ }).check();
  await expect(page.getByRole('button', { name: 'Prepare checkout', exact: true })).toBeDisabled();
  expect(f.calls.orders).toHaveLength(0); expect(f.calls.checkouts).toHaveLength(0);
});

test('malformed fragments and foreign pasted links fail closed without exposing their token in a request', async ({ page, checkoutBaseURL }) => {
  const f = await fixture(page, checkoutBaseURL);
  await page.goto(checkoutBaseURL + '/' + link() + '&agentCheckout=' + otherOffer + '.' + otherCode);
  await expect(page.getByText('This agent checkout link is invalid.', { exact: false })).toBeVisible();
  expect(page.url()).not.toContain(code); expect(f.calls.previews).toHaveLength(0);
  await page.getByRole('checkbox', { name: /reviewed the price/ }).check();
  await expect(page.getByRole('button', { name: 'Prepare checkout', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Remove agent link', exact: true }).click();
  const details = page.locator('details').filter({ has: page.getByText('Have an agent checkout link?', { exact: true }) });
  if (!(await page.getByLabel('Paste agent checkout link').isVisible())) await details.locator('summary').click();
  await page.getByLabel('Paste agent checkout link').fill('https://untrusted.example/' + link());
  await page.getByRole('button', { name: 'Review agent checkout', exact: true }).click();
  await expect(page.getByText('This agent checkout link is invalid.', { exact: false })).toBeVisible();
  expect(f.calls.previews).toHaveLength(0); expect(f.calls.orders).toHaveLength(0);
});

test('changing customer ownership clears the private offer before any order or payment', async ({ page, checkoutBaseURL }) => {
  const f = await fixture(page, checkoutBaseURL); await openOffer(page, checkoutBaseURL);
  f.state.owner = otherCustomer; await prepare(page);
  await expect(page.getByText('Your customer session changed or expired.', { exact: false })).toBeVisible();
  expect(f.calls.orders).toHaveLength(0); expect(f.calls.checkouts).toHaveLength(0);
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toContain(code);
});

test('an approved pasted link opens the same locked offer without navigating to the pasted URL', async ({ page, checkoutBaseURL }) => {
  const f = await fixture(page, checkoutBaseURL); await page.goto(checkoutBaseURL + '/#checkout');
  await page.getByText('Have an agent checkout link?', { exact: true }).click();
  await page.getByLabel('Paste agent checkout link').fill('https://pasofi.mobile.onesa.eu/' + link());
  await page.getByRole('button', { name: 'Review agent checkout', exact: true }).click();
  await expect(page.getByLabel('Purchase site')).toBeDisabled(); await expect(page.getByLabel('Payment method')).toHaveValue('STRIPE_CARD');
  expect(new URL(page.url()).origin).toBe(checkoutBaseURL);
  await prepare(page); await expect.poll(() => f.calls.orders.length).toBe(1);
  expect(f.calls.orders[0].body.agentCheckout).toEqual({ id: offerId, code });
});

if (!mobile) test('Onesa sign-in receives only the bare checkout return and restores the unclaimed offer', async ({ page, checkoutBaseURL }) => {
  const f = await fixture(page, checkoutBaseURL); f.state.owner = null;
  await page.route('https://auth.onesa.eu/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Synthetic sign-in</h1>' }));
  await openOffer(page, checkoutBaseURL);
  await page.getByRole('button', { name: 'Sign in', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Synthetic sign-in' })).toBeVisible();
  expect(f.calls.signIns).toEqual([{ returnTo: '/#checkout' }]);
  f.state.owner = customerId; await page.goto(checkoutBaseURL + '/#checkout');
  await expect(page.getByRole('heading', { name: 'Agent checkout', exact: true })).toBeVisible();
  await expect(page.getByLabel('Payment method')).toHaveValue('STRIPE_CARD');
  await prepare(page); await expect.poll(() => f.calls.orders.length).toBe(1);
  expect(f.calls.orders[0].body.agentCheckout).toEqual({ id: offerId, code });
});


test('a retry cannot accept another order even with the same agent attribution', async ({ page, checkoutBaseURL }) => {
  const f = await fixture(page, checkoutBaseURL); await openOffer(page, checkoutBaseURL); await prepare(page);
  await expect(page.getByRole('button', { name: 'Check verified payment status' })).toBeVisible();
  f.state.replayOrderId = otherOffer;
  await page.getByRole('button', { name: 'Retry this checkout safely' }).click();
  await expect(page.getByText('The order does not match the saved agent checkout.', { exact: false })).toBeVisible();
  expect(f.calls.orders).toHaveLength(2); expect(f.calls.orders[1].key).toBe(f.calls.orders[0].key);
  expect(f.calls.checkouts).toHaveLength(1);
});
