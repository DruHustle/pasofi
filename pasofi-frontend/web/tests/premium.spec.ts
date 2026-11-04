import { test, expect, type Page, type Route } from '@playwright/test';
import { usageSnapshot, usageCustomerId as customerId, usageEntitlementId as entitlementId } from './usage-fixture';

const siteId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const pairingId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const products = [
  { id: 'day', price_minor: 25, currency: 'USD', byte_limit: '1000000000', validity_seconds: 86400 },
  { id: 'mini', price_minor: 50, currency: 'USD', byte_limit: '2000000000', validity_seconds: 259200 },
  { id: 'flex', price_minor: 100, currency: 'USD', byte_limit: '5000000000', validity_seconds: 604800 },
  { id: 'fortnight', price_minor: 500, currency: 'USD', byte_limit: '35000000000', validity_seconds: 1209600 },
  { id: 'month', price_minor: 1000, currency: 'USD', byte_limit: '75000000000', validity_seconds: 2592000 },
];
const capabilities = { demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: true, receiptPairing: true, staffSales: true, deliverySms: false, networkAccess: true, mobileCookies: false };
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Isolated API responses. No paid provider, public account, or router is contacted. */
async function fixture(page: Page, options: { guest?: boolean; queued?: boolean; pending?: boolean; products?: typeof products } = {}) {
  const state = { signedIn: !options.guest, queued: !!options.queued, sessionCreates: 0, pairings: 0, redemptions: 0, mutations: [] as string[] };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') state.mutations.push(`${request.method()} ${path}`);
    if (path === '/api/capabilities') return json(route, capabilities);
    if (path === '/api/bundles') return json(route, { products: options.products ?? products, candidate: false });
    if (path === '/api/help') return json(route, { articles: [{ question: 'When does bundle time start?', answer: 'Bundle validity starts after a successful hotspot connection.' }] });
    if (path === '/api/sites') return json(route, { sites: [{ id: siteId, name: 'Kuwadzana test hotspot' }] });
    if (path === '/api/network/sites') return json(route, { sites: [{ id: siteId, name: 'Kuwadzana test hotspot', loginUrl: 'https://hotspot.example.test/login' }] });
    if (path === '/api/session') {
      if (request.method() === 'POST') { state.sessionCreates++; state.signedIn = true; }
      return json(route, state.signedIn ? { customerId } : { error: 'not_authenticated' }, state.signedIn ? 200 : 401);
    }
    if (path === '/api/access') return json(route, { customerId, entitlements: [{ id: entitlementId, bundle_id: 'flex', byte_limit: '5000000000', consumed_bytes: state.queued ? '0' : '1000000000', validity_seconds: 604800, activated_at: state.queued ? null : new Date(Date.now() - (7 * 24 - 18) * 3600000).toISOString(), revoked_at: null, start_by: new Date(Date.now() + 86400000).toISOString() }], hasMore: false, nextOffset: null });
    if (path === '/api/usage') {
      const snapshot = usageSnapshot(state.queued ? '0' : '1000000000', { queuedBytes: state.queued ? '5000000000' : '0' });
      if (!state.queued) snapshot.entitlementUpdates[0].expires_at = new Date(Date.now() + 18 * 3600000).toISOString();
      if (options.pending) {
        snapshot.connectivity = 'pending';
        snapshot.session = { grantId: entitlementId, entitlementId, siteId, state: 'pending', connected: false, issuedAt: new Date().toISOString(), deadline: new Date(Date.now() + 900000).toISOString(), lastAccountingAt: null, reservedBytes: '4000000000', chargedBytes: '0', reservationOutstandingBytes: '4000000000', disconnectRequested: false, accountingStale: false, accountingAnomaly: false };
      }
      return json(route, snapshot);
    }
    if (path === '/api/recovery/status') return json(route, { configured: false });
    if (path === '/api/orders') return json(route, { customerId, orders: [] });
    if (path === '/api/receipt-pairings' && request.method() === 'POST') {
      state.pairings++;
      const selection = request.postDataJSON(); expect(selection.siteId).toBe(siteId); expect(products.some(item => item.id === selection.bundleId)).toBe(true);
      return json(route, { pairing: { id: pairingId, code: 'ABCD234567', expiresAt: new Date(Date.now() + 600000).toISOString() } }, 201);
    }
    if (path === `/api/receipt-pairings/${pairingId}`) return json(route, { status: 'pending' });
    if (path === '/api/vouchers/redeem') {
      expect(request.postDataJSON()).toEqual({ code: 'TESTVOUCHER234567' });
      state.queued = true; state.redemptions++;
      return json(route, { entitlementId, replayed: false });
    }
    return json(route, { error: 'unexpected_test_request' }, 500);
  });
  return state;
}

function navigation(page: Page) { return page.getByRole('navigation', { name: 'Main navigation' }); }
async function noOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); }

for (const width of [320, 390, 430, 1280]) {
  test(`primary navigation and customer screens remain usable at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 844 }); await fixture(page); await page.goto('/');
    await expect(page.getByTestId('usage-remaining')).toHaveText('4.000 GB');
    const nav = navigation(page);
    for (const name of ['Home', 'Bundles', 'History', 'Account']) {
      const button = nav.getByRole('button', { name, exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox(); expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    if (width === 390) {
      const topUp = await page.getByRole('button', { name: 'Buy more data', exact: true }).boundingBox();
      const bottomNavigation = await nav.boundingBox();
      expect(topUp).not.toBeNull(); expect(bottomNavigation).not.toBeNull();
      expect(topUp!.y).toBeGreaterThanOrEqual(0);
      expect(topUp!.y + topUp!.height, 'Top-up must be available without scrolling past the first phone viewport').toBeLessThanOrEqual(bottomNavigation!.y);
    }
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`home-${width}.png`), fullPage: width > 600 });
    await nav.getByRole('button', { name: 'Bundles', exact: true }).click();
    await expect(nav.getByRole('button', { name: 'Bundles', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Find your fit.' })).toBeVisible();
    await noOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`bundles-${width}.png`), fullPage: width > 600 });
    await nav.getByRole('button', { name: 'History', exact: true }).click();
    await expect(nav.getByRole('button', { name: 'History', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('[data-entitlement-id]')).toHaveCount(1); await noOverflow(page);
    await nav.getByRole('button', { name: 'Account', exact: true }).click();
    await expect(nav.getByRole('button', { name: 'Account', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Keep your access recoverable' })).toBeVisible(); await noOverflow(page);
    expect(errors).toEqual([]);
  });
}

test('bundle filters use published validity and never invent unlimited offers', async ({ page }) => {
  await fixture(page); await page.goto('/#bundles');
  const filters = page.getByRole('group', { name: 'Bundle duration' });
  await filters.getByRole('button', { name: 'Daily', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Buy day from an agent', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buy flex from an agent', exact: true })).toHaveCount(0);
  await filters.getByRole('button', { name: 'Weekly', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Buy flex from an agent', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Buy day from an agent', exact: true })).toHaveCount(0);
  await filters.getByRole('button', { name: 'Monthly', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Buy month from an agent', exact: true })).toBeVisible();
  await filters.getByRole('button', { name: 'All bundles', exact: true }).click();
  await expect(page.getByRole('button', { name: /^Buy (day|mini|flex|fortnight|month) from an agent$/ })).toHaveCount(5);
  await expect(filters.getByRole('button', { name: /unlimited/i })).toHaveCount(0);
  await fixture(page, { products: products.filter(product => product.id === 'flex') }); await page.reload();
  await expect(filters.getByRole('button', { name: 'Daily', exact: true })).toHaveCount(0);
  await expect(filters.getByRole('button', { name: 'Monthly', exact: true })).toHaveCount(0);
});

test('guest cash purchase creates an account only after explicit receipt pairing', async ({ page }, testInfo) => {
  const state = await fixture(page, { guest: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/#bundles');
  await page.getByRole('button', { name: 'Buy flex from an agent', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Receive a private agent receipt' })).toBeVisible();
  expect(state.sessionCreates).toBe(0); expect(state.mutations).toEqual([]);
  await expect(page.getByRole('textbox', { name: /email|password/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Create private pairing code', exact: true }).click();
  await expect(page.getByText('ABCD234567', { exact: true })).toBeVisible();
  expect(state.sessionCreates).toBe(1); expect(state.pairings).toBe(1);
  await expect(page.getByText(/Waiting for your receipt/)).toBeVisible();
  await expect(page.getByText('Connected', { exact: true })).toHaveCount(0);
  const checkoutUrl = page.url(), mutationsBeforeSkip = [...state.mutations];
  const skipLink = page.getByRole('link', { name: 'Skip to main content', exact: true });
  await skipLink.focus(); await skipLink.click();
  await expect(page.locator('#main-content')).toBeFocused();
  await expect(page).toHaveURL(checkoutUrl);
  await expect(page.getByText('ABCD234567', { exact: true })).toBeVisible();
  expect(state.mutations).toEqual(mutationsBeforeSkip);
  await noOverflow(page); await page.screenshot({ path: testInfo.outputPath('cash-checkout-390.png'), fullPage: true });
});

test('cross-tab sign-out returns private History to usable Home without silently restoring an account', async ({ page }) => {
  await page.clock.install();
  const state = await fixture(page);
  await page.goto('/#history');
  await expect(page.locator('.customer-workspace')).toBeVisible();
  await expect(page.locator(`[data-entitlement-id="${entitlementId}"]`)).toBeVisible();
  await page.evaluate(() => {
    const channel = new BroadcastChannel('pamofi.session');
    channel.postMessage('signed_out'); channel.close();
  });
  await expect(page.getByText('Signed out in another tab. Account details have been cleared from this view.', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/#home$/);
  await expect(navigation(page).getByRole('button', { name: 'Home', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Find your fit.', exact: true })).toBeVisible();
  await expect(page.locator('.customer-workspace')).toHaveCount(0);
  // The fixture deliberately still returns a valid session. A broadcast must
  // require explicit user navigation before any account is shown again.
  expect(state.signedIn).toBe(true);
  await page.clock.runFor(5000);
  await expect(page.locator('.customer-workspace')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Find your fit.', exact: true })).toBeVisible();
  expect(state.sessionCreates).toBe(0); expect(state.mutations).toEqual([]);
});

test('the captive entry is lightweight and reaches voucher redemption without registration', async ({ page }, testInfo) => {
  const state = await fixture(page, { guest: true, queued: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/connect');
  await expect(page.getByRole('heading', { name: 'Connect to PasoFi' })).toBeVisible();
  await expect(page.locator('img[src*="pamofi-everyday-connection"]')).toHaveCount(0);
  expect(state.sessionCreates).toBe(0); await noOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('captive-390.png'), fullPage: true });
  await page.getByRole('button', { name: 'Redeem voucher', exact: true }).click();
  await page.getByLabel('Voucher code', { exact: true }).fill('TESTVOUCHER234567');
  await page.getByRole('button', { name: 'Redeem voucher', exact: true }).click();
  await expect(page.getByText('Voucher redeemed. Your bundle is queued;', { exact: false })).toBeVisible();
  await expect(page.getByTestId('usage-queued')).toHaveText('5.000 GB');
  await expect(page.getByText('Queued · not connected', { exact: true })).toBeVisible();
  expect(state.sessionCreates).toBe(1); expect(state.redemptions).toBe(1);
  await expect(page.getByText('Connected', { exact: true })).toHaveCount(0); await noOverflow(page);
});

test('dashboard shows bundle validity independently of a shorter pending connection grant', async ({ page }, testInfo) => {
  await page.clock.install(); await fixture(page, { pending: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.getByRole('button', { name: 'Customer tools', exact: true }).click();
  await expect(page.getByTestId('usage-remaining')).toHaveText('4.000 GB');
  await expect(page.getByTestId('usage-bundle-time')).toContainText(/18h|18 h|18 hours/);
  await expect(page.getByTestId('usage-connection-status')).not.toHaveText(/^Connected/);
  await expect(page.getByText('Sign-in pending · not confirmed connected', { exact: true })).toBeVisible();
  await noOverflow(page); await page.screenshot({ path: testInfo.outputPath('dashboard-pending-390.png'), fullPage: true });
});

test('offline dashboard retains its confirmed balance and visibly withdraws connection certainty', async ({ page, context }) => {
  await fixture(page, { pending: true }); await page.goto('/');
  await page.getByRole('button', { name: 'Customer tools', exact: true }).click();
  await expect(page.getByTestId('usage-remaining')).toHaveText('4.000 GB');
  await context.setOffline(true);
  await expect(page.getByText('Offline · showing the last confirmed balance', { exact: true })).toBeVisible();
  await expect(page.getByTestId('usage-remaining')).toHaveText('4.000 GB');
  await expect(page.getByText('Connection status not verified', { exact: true })).toBeVisible();
  await expect(page.getByTestId('usage-connection-status')).not.toHaveText(/^Connected/);
});

test('cash reference keeps the selected terms through a lost response, reload and cancellation', async ({ page }) => {
  await fixture(page);
  const requests: { key: string; body: unknown }[] = [];
  let cancelled = false;
  await page.route('**/api/receipt-pairings**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (path.endsWith('/cancel')) { cancelled = true; return json(route, { status: 'cancelled' }); }
    if (req.method() === 'GET') return json(route, { status: cancelled ? 'cancelled' : 'pending' });
    const body = req.postDataJSON(); requests.push({ key: req.headers()['idempotency-key'], body });
    if (requests.length === 1) return route.abort();
    return json(route, { pairing: { id: pairingId, code: 'ABCD234567', expiresAt: new Date(Date.now() + 300000).toISOString(), status: 'pending', quote: { bundleId: body.bundleId, siteId, siteName: 'Kuwadzana test hotspot', priceMinor: 100, currency: 'USD', byteLimit: '5000000000', validitySeconds: 604800 } }, replayed: true });
  });
  await page.goto('/#bundles'); await page.getByRole('button', { name: 'Buy flex from an agent' }).click();
  await page.getByRole('button', { name: 'Create private pairing code' }).click();
  await expect(page.getByText('Your cash reference request is saved.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Cash bundle')).toBeDisabled();
  await page.reload();
  await expect(page.getByText('ABCD234567', { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]); expect(requests[0].body).toEqual({ bundleId: 'flex', siteId });
  await expect(page.getByText('Kuwadzana test hotspot · FLEX · $1.00')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel unpaid reference' }).click();
  await expect(page.getByLabel('Cash bundle')).toBeEnabled();
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.endsWith(':receipt-pairing')))).toEqual([]);
});
