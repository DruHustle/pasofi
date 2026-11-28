import { test, expect, type Page } from '@playwright/test';

// UI contract tests use synthetic staff/API evidence. Only server verification
// may mark a payment paid or a commission earned; these tests never contact Stripe.
const staffId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', otherStaff = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const siteId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', checkoutId = '11111111-1111-4111-8111-111111111111';
const orderId = 'ffffffff-ffff-4fff-8fff-ffffffffffff', token = 'S'.repeat(43);
const handoff = { code: token, url: `https://pasofi.mobile.onesa.eu/#checkout?agentCheckout=${checkoutId}.${token}` };
const product = { id: 'flex', price_minor: 500, currency: 'USD', byte_limit: '5000000000', validity_seconds: 604800 };
const staff = { staffId, email: 'synthetic-agent@example.invalid', displayName: 'Synthetic agent', status: 'approved', role: 'agent', siteIds: [siteId], version: 1, mfaEnrolled: true, mfaVerified: true };
const capabilities = { demo: false, paymentMode: 'sandbox', paymentCheckout: true, staffSales: false, agentDigitalSales: true, agentCheckoutRecovery: true,
  vouchers: false, receiptPairing: false, cashReceiptRecovery: false, deliverySms: false, networkAccess: false, mobileCookies: false };
const newCheckout = () => ({
  id: checkoutId, orderId: null as string | null, quote: { bundleId: 'flex', siteId, siteName: 'Synthetic agent site', priceMinor: 500, currency: 'USD', byteLimit: product.byte_limit, validitySeconds: product.validity_seconds },
  createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(), paidAt: null as string | null,
  simulation: true, stockState: 'none', status: 'unclaimed', commission: { basisPoints: 1000, amountMinor: 50, currency: 'USD', state: 'unearned' },
});
async function fixture(page: Page) {
  const state = { staff: { ...staff }, created: false, loseReply: false, selling: true, checkout: newCheckout() };
  const calls = { creates: [] as { key: string; body: unknown }[], details: [] as string[], mutations: [] as string[], inventory: 0 };
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() !== 'GET') calls.mutations.push(path);
    if (path === '/api/capabilities') return json({ ...capabilities, agentDigitalSales: state.selling });
    if (path === '/api/help') return json({ articles: [] });
    if (path === '/api/session') return json({ error: 'not_authenticated' }, 401);
    if (path === '/api/staff/session') return json(state.staff);
    if (path === '/api/staff/onesa/availability') return json({ origin: null });
    if (path === '/api/staff/password-reset/availability') return json({ enabled: false });
    if (path === '/api/bundles') return json({ products: [product], candidate: false });
    if (path === '/api/sites' || path === '/api/staff/sites') return json({ sites: [{ id: siteId, name: 'Synthetic agent site' }] });
    if (path === '/api/staff/inventory') { calls.inventory++; return json({ inventory: [{ agentId: staffId, siteId, siteName: 'Synthetic agent site', bundleId: 'flex', quantity: state.checkout.stockState === 'none' ? 5 : 4 }] }); }
    if (path === '/api/staff/sales') return json({ sales: [], hasMore: false, nextOffset: null });
    if (path === '/api/staff/cash-shifts') return json({ shifts: [], currencies: ['USD'] });
    if (path === '/api/staff/cash-refunds') return json({ refunds: [] });
    if (path === '/api/staff/agent-checkouts') {
      if (request.method() === 'GET') return json({ checkouts: state.created ? [state.checkout] : [], hasMore: false, nextOffset: null });
      expect(request.method()).toBe('POST');
      calls.creates.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() });
      const replayed = state.created; state.created = true;
      if (state.loseReply) { state.loseReply = false; return route.abort('failed'); }
      return json({ checkout: state.checkout, handoff: state.checkout.status === 'unclaimed' ? handoff : null, replayed });
    }
    if (path === `/api/staff/agent-checkouts/${checkoutId}`) {
      expect(request.method()).toBe('GET'); calls.details.push(checkoutId);
      return json({ checkout: state.checkout, handoff: state.checkout.status === 'unclaimed' ? handoff : null });
    }
    return json({ error: 'unexpected_request' }, 500);
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Card and wallet sales', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create customer payment link', exact: true })).toBeEnabled();
  return { state, calls };
}
const selected = (page: Page) => page.locator('[aria-label="Selected card or wallet sale"]');
async function create(page: Page) {
  await page.getByRole('button', { name: 'Create customer payment link', exact: true }).click();
  await expect(page.getByLabel('Customer payment link', { exact: true })).toHaveValue(handoff.url);
}

for (const width of [390, 1280]) test(`agent creates a customer link and QR without charging or adding shift cash at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const f = await fixture(page); await create(page);
  await expect(page.locator('.agent-checkout-qr svg')).toBeVisible();
  await expect(selected(page).getByText('Waiting for customer', { exact: true })).toBeVisible();
  await expect(selected(page).getByText('Commission: $0.50 · Awaiting payment', { exact: true })).toBeVisible();
  expect(f.calls.creates).toHaveLength(1); expect(f.calls.creates[0].body).toEqual({ siteId, bundleId: 'flex' });
  expect(f.calls.creates[0].key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  expect(f.calls.mutations).toEqual(['/api/staff/agent-checkouts']);
  expect(await page.evaluate(() => JSON.stringify(sessionStorage) + JSON.stringify(localStorage))).not.toContain(token);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.locator('.agent-digital-sales').screenshot({ path: info.outputPath(`agent-digital-${width}.png`) });
});

test('reload recovers the original unclaimed QR with GET and never creates another link', async ({ page }) => {
  const f = await fixture(page); await create(page); await page.reload();
  await expect(page.getByLabel('Customer payment link', { exact: true })).toHaveValue(handoff.url);
  expect(f.calls.creates).toHaveLength(1); expect(f.calls.details).toContain(checkoutId);
  expect(f.calls.mutations).toEqual(['/api/staff/agent-checkouts']);
});

test('an ambiguous create response keeps its original owner-scoped key across reload and retry', async ({ page }) => {
  const f = await fixture(page); f.state.loseReply = true;
  await page.getByRole('button', { name: 'Create customer payment link', exact: true }).click();
  await expect(page.getByText('The link response could not be confirmed.', { exact: false })).toBeVisible();
  const original = f.calls.creates[0];
  expect(await page.evaluate(id => sessionStorage.getItem(`pamofi.operation:staff:${id}:agent-checkout`), staffId)).toContain(original.key);
  await page.reload();
  await expect(page.getByLabel('Customer payment link', { exact: true })).toHaveValue(handoff.url);
  expect(f.calls.creates).toHaveLength(1);
  await page.getByRole('button', { name: 'Retry saved payment link', exact: true }).click();
  await expect(page.getByText('The original payment link was recovered.', { exact: false })).toBeVisible();
  expect(f.calls.creates).toHaveLength(2); expect(f.calls.creates[1]).toEqual(original);
  expect(await page.evaluate(id => sessionStorage.getItem(`pamofi.operation:staff:${id}:agent-checkout`), staffId)).toBeNull();
});

test('changed staff ownership is rejected before creating or saving a sale request', async ({ page }) => {
  const f = await fixture(page); f.state.staff = { ...staff, staffId: otherStaff, version: 2 };
  await page.getByRole('button', { name: 'Create customer payment link', exact: true }).click();
  await expect(page.locator('.agent-digital-sales').getByText('Your session or verification has expired.', { exact: false })).toBeVisible();
  expect(f.calls.creates).toHaveLength(0); expect(f.calls.mutations).toHaveLength(0);
  expect(await page.evaluate(id => sessionStorage.getItem(`pamofi.operation:staff:${id}:agent-checkout`), staffId)).toBeNull();
  await expect(page.locator('.agent-checkout-qr')).toHaveCount(0);
});

test('verified status drives pending, earned, and reversed commission without an agent payment action', async ({ page }) => {
  const f = await fixture(page); await create(page);
  f.state.checkout = { ...f.state.checkout, status: 'payment_pending', stockState: 'reserved', orderId };
  await page.getByRole('button', { name: 'Check this payment', exact: true }).click();
  await expect(selected(page).getByText('Payment awaiting confirmation', { exact: true })).toBeVisible();
  await expect(selected(page).getByText('Commission: $0.50 · Awaiting payment', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Customer payment link', { exact: true })).toHaveCount(0);
  await expect(selected(page).getByText('One bundle is held while this payment is checked.', { exact: false })).toBeVisible();
  f.state.checkout = { ...f.state.checkout, status: 'paid', stockState: 'consumed', paidAt: new Date().toISOString(), commission: { ...f.state.checkout.commission, state: 'earned' } };
  await page.getByRole('button', { name: 'Check this payment', exact: true }).click();
  await expect(selected(page).getByText('Payment verified', { exact: true })).toBeVisible();
  await expect(selected(page).getByText('Commission: $0.50 · Earned', { exact: true })).toBeVisible();
  f.state.checkout = { ...f.state.checkout, status: 'reversed', commission: { ...f.state.checkout.commission, state: 'reversed' } };
  await page.getByRole('button', { name: 'Check this payment', exact: true }).click();
  await expect(selected(page).getByText('Payment reversed', { exact: true })).toBeVisible();
  await expect(selected(page).getByText('Commission: $0.50 · Reversed', { exact: true })).toBeVisible();
  expect(f.calls.creates).toHaveLength(1); expect(f.calls.mutations).toEqual(['/api/staff/agent-checkouts']);
  await expect.poll(() => f.calls.inventory).toBeGreaterThan(1);
});

test('pausing new sales retains status recovery and keeps new link creation disabled', async ({ page }) => {
  const f = await fixture(page); await create(page); f.state.selling = false; await page.reload();
  await expect(page.getByText('New card and wallet sales are paused.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create customer payment link', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Customer payment link', { exact: true })).toHaveValue(handoff.url);
  await page.getByRole('button', { name: 'Check this payment', exact: true }).click();
  expect(f.calls.creates).toHaveLength(1);
});
