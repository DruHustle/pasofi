import { test, expect, type Page, type Route } from '@playwright/test';
import type { Capabilities, Product } from '../src/business';
import { usageSnapshot, usageCustomerId as customerId } from './usage-fixture';

const disabledCapabilities: Capabilities = {
  demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: false,
  receiptPairing: false, staffSales: false, deliverySms: false, networkAccess: false, mobileCookies: false,
};
const cashCapabilities: Capabilities = { ...disabledCapabilities, vouchers: true, receiptPairing: true, staffSales: true };
const flex: Product = { id: 'flex', price_minor: 100, currency: 'USD', byte_limit: '5000000000', validity_seconds: 604800 };
const emptyMessage = 'No bundles are published yet. Check back when PasoFi launches.';
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Production-shaped guest responses, isolated from all real accounts and services. */
async function guestAvailability(page: Page) {
  const state = {
    capabilities: { ...disabledCapabilities }, products: [] as Product[],
    reads: { capabilities: 0, bundles: 0 }, mutations: [] as string[], unexpected: [] as string[],
    holdNext: new Set<string>(), held: [] as { route: Route; body: unknown }[],
  };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      state.mutations.push(`${request.method()} ${path}`);
      return json(route, { error: 'unexpected_test_mutation' }, 405);
    }
    if (path === '/api/onesa/availability') return json(route, { origin: null });
    if (path === '/api/capabilities' || path === '/api/bundles') {
      state.reads[path === '/api/capabilities' ? 'capabilities' : 'bundles']++;
      // Capture the response at request time so a delayed older request really
      // carries the old catalogue and capability state after publication.
      const body = path === '/api/capabilities'
        ? { ...state.capabilities }
        : { products: state.products.map(product => ({ ...product })), candidate: false };
      if (state.holdNext.delete(path)) { state.held.push({ route, body }); return; }
      return json(route, body);
    }
    if (path === '/api/help') return json(route, { articles: [{ question: 'How can I check availability?', answer: 'Browse the currently published bundles.' }] });
    if (path === '/api/sites') return json(route, { sites: [] });
    if (path === '/api/network/sites') return json(route, { accessPoints: [] });
    if (['/api/session', '/api/access', '/api/usage', '/api/orders', '/api/recovery/status'].includes(path)) {
      return json(route, { error: 'not_authenticated' }, 401);
    }
    state.unexpected.push(`${request.method()} ${path}`);
    return json(route, { error: 'unexpected_test_request' }, 500);
  });
  return state;
}

function navigation(page: Page) { return page.getByRole('navigation', { name: 'Main navigation' }); }
function catalogueHeading(page: Page) { return page.getByRole('heading', { name: 'Find your fit.', exact: true }); }
async function expectEmptyBundles(page: Page) {
  await expect(page).toHaveURL(/\/#bundles$/);
  await expect(navigation(page).getByRole('button', { name: 'Bundles', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(navigation(page).locator('[aria-current="page"]')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Your internet. Your everyday.', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Connect to PasoFi', exact: true })).toHaveCount(0);
  await expect(page.locator('.pf-connection-card, .customer-workspace')).toHaveCount(0);
  await expect(catalogueHeading(page)).toBeFocused();
  await expect(catalogueHeading(page)).toBeInViewport({ ratio: 1 });
  await expect(page.getByText(emptyMessage, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh availability', exact: true })).toBeEnabled();
  await expect(page.getByText('SERVICE IN PREPARATION', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Bundle duration' }).getByRole('button')).toHaveCount(1);
  await expect(page.locator('.pf-bundle-card')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

for (const width of [320, 390]) {
  test(`disabled guest bundle entry points show a focused, usable empty catalogue at ${width}px`, async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const state = await guestAvailability(page);
    await page.setViewportSize({ width, height: 844 }); await page.goto('/');
    await expect(page.getByText(emptyMessage, { exact: true })).toBeVisible();
    await expect(page.getByText('SERVICE IN PREPARATION', { exact: true })).toBeVisible();

    await test.step('Home navigation works by keyboard', async () => {
      const bundles = navigation(page).getByRole('button', { name: 'Bundles', exact: true });
      await bundles.focus(); await bundles.press('Enter');
      await expectEmptyBundles(page);
    });
    for (const entry of ['View bundles']) {
      await test.step(`Home ${entry} opens the catalogue`, async () => {
        await navigation(page).getByRole('button', { name: 'Home', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Your internet. Your everyday.', exact: true })).toBeVisible();
        await page.getByRole('button', { name: entry, exact: true }).click();
        await expectEmptyBundles(page);
      });
    }
    for (const [entry, title] of [['History', 'Your activity'], ['Account', 'Your account']]) {
      await test.step(`${entry} can return to bundles without creating an account`, async () => {
        await navigation(page).getByRole('button', { name: entry, exact: true }).click();
        await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
        await expect(page.getByText('No account is active in this browser.', { exact: false })).toBeVisible();
        await expect(page.getByText('You can buy or redeem as a guest.', { exact: false })).toHaveCount(0);
        await navigation(page).getByRole('button', { name: 'Bundles', exact: true }).click();
        await expectEmptyBundles(page);
      });
    }
    await test.step('Captive empty-state refresh updates availability and focuses the catalogue in place', async () => {
      await page.goto('/connect');
      await expect(page.getByText(emptyMessage, { exact: true })).toBeVisible();
      await expect(page.getByText('Check bundle prices and voucher availability at this hotspot.', { exact: true })).toBeVisible();
      await expect(page.getByText('SERVICE IN PREPARATION', { exact: true })).toBeVisible();
      const before = { ...state.reads };
      await page.getByRole('button', { name: 'Refresh availability', exact: true }).click();
      await expect(page).toHaveURL(/\/connect$/);
      await expect(catalogueHeading(page)).toBeFocused();
      await expect(catalogueHeading(page)).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('heading', { name: 'Connect to PasoFi', exact: true })).toHaveCount(1);
      await expect.poll(() => state.reads).toEqual({ capabilities: before.capabilities + 1, bundles: before.bundles + 1 });
      await expect(page.getByText(emptyMessage, { exact: true })).toBeVisible();
    });
    for (const entry of ['Bundles', 'View bundles']) {
      await test.step(`Captive ${entry} opens the standalone catalogue`, async () => {
        await page.goto('/connect');
        await expect(page.getByRole('heading', { name: 'Connect to PasoFi', exact: true })).toBeVisible();
        await expect(page.getByText(emptyMessage, { exact: true })).toBeVisible();
        const button = entry === 'Bundles' ? navigation(page).getByRole('button', { name: entry, exact: true }) : page.getByRole('button', { name: entry, exact: true });
        await button.click(); await expectEmptyBundles(page);
      });
    }
    await page.locator('#explore').getByRole('button', { name: 'Explore help', exact: true }).click();
    await expect(page).toHaveURL(/\/#help$/);
    await expect(page.getByRole('heading', { name: 'Here to help.', exact: true })).toBeVisible();
    await test.step('Production footer recovery uses account wording and closes back to the public page', async () => {
      const publicUrl = page.url(), recover = page.locator('footer').getByRole('button', { name: 'Recover', exact: true });
      await recover.click();
      await expect(page.getByRole('heading', { name: 'Recover your account', exact: true })).toBeVisible();
      await expect(page.getByText(/demo access/i)).toHaveCount(0);
      await expect(page).toHaveURL(publicUrl);
      await page.getByRole('button', { name: 'Close recovery', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Recover your account', exact: true })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Here to help.', exact: true })).toBeVisible();
      await expect(page).toHaveURL(publicUrl); await expect(recover).toBeFocused();
    });
    expect(state.mutations).toEqual([]); expect(state.unexpected).toEqual([]); expect(errors).toEqual([]);
  });
}

test('refresh availability and returning to Bundles fetch both published offers and current sales capability', async ({ page }) => {
  const state = await guestAvailability(page); await page.goto('/#bundles');
  await expect(page.getByText(emptyMessage, { exact: true })).toBeVisible();
  await expect(page.getByText('SERVICE IN PREPARATION', { exact: true })).toBeVisible();
  const initialReads = { ...state.reads };

  state.products = [flex]; state.capabilities = { ...cashCapabilities };
  await page.getByRole('button', { name: 'Refresh availability', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Buy flex from an agent', exact: true })).toBeEnabled();
  await expect(page.getByText('PASOFI CUSTOMER SERVICE', { exact: true })).toBeVisible();
  await expect(catalogueHeading(page)).toBeFocused();
  expect(state.reads).toEqual({ capabilities: initialReads.capabilities + 1, bundles: initialReads.bundles + 1 });
  await expect(page.getByText(emptyMessage, { exact: true })).toHaveCount(0);

  await navigation(page).getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your internet. Your everyday.', exact: true })).toBeVisible();
  const publishedReads = { ...state.reads };
  state.products = []; state.capabilities = { ...disabledCapabilities };
  await navigation(page).getByRole('button', { name: 'Bundles', exact: true }).click();
  await expectEmptyBundles(page);
  expect(state.reads).toEqual({ capabilities: publishedReads.capabilities + 1, bundles: publishedReads.bundles + 1 });
  expect(state.mutations).toEqual([]); expect(state.unexpected).toEqual([]);
});

test('authenticated empty Home explains unavailable purchases without directing a customer to pay', async ({ page }) => {
  const state = await guestAvailability(page);
  await page.route('**/api/**', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/session') return json(route, { customerId });
    if (path === '/api/access') return json(route, { customerId, entitlements: [], hasMore: false, nextOffset: null });
    if (path === '/api/usage') {
      const snapshot = usageSnapshot('0', { allowanceBytes: '0' });
      snapshot.entitlementUpdates = [];
      return json(route, snapshot);
    }
    return route.fallback();
  });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your internet', exact: true })).toBeVisible();
  await expect(page.getByTestId('usage-remaining')).toHaveText('0.000 GB');
  await expect(page.getByTestId('usage-bundle-time')).toHaveText('No active bundle');
  await expect(page.getByText('SERVICE IN PREPARATION', { exact: true })).toBeVisible();
  await expect(page.getByText('No bundles are shown yet. Purchases and voucher redemption are not available yet. Browse bundles to check current availability.', { exact: true })).toBeVisible();
  await expect(page.getByText('Pay an authorized agent in cash', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Receive an agent receipt', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-entitlement-id]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Browse bundles', exact: true }).click();
  await expectEmptyBundles(page);
  expect(state.mutations).toEqual([]); expect(state.unexpected).toEqual([]);
});

test('late older availability responses cannot replace a newer published catalogue and sales state', async ({ page }) => {
  // Deliver old responses even after transport cancellation. This makes the
  // visible stale-response regression deterministic instead of relying on timing.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
      return originalFetch(input, url.origin === location.origin && ['/api/bundles', '/api/capabilities'].includes(url.pathname)
        ? { ...init, signal: undefined } : init);
    };
  });
  const state = await guestAvailability(page); await page.goto('/#bundles');
  await expect(page.getByText(emptyMessage, { exact: true })).toBeVisible();
  await expect(page.getByText('SERVICE IN PREPARATION', { exact: true })).toBeVisible();
  state.holdNext.add('/api/bundles'); state.holdNext.add('/api/capabilities');
  await page.getByRole('button', { name: 'Refresh availability', exact: true }).click();
  await expect.poll(() => state.held.length).toBe(2);
  state.products = [flex]; state.capabilities = { ...cashCapabilities };
  try {
    await navigation(page).getByRole('button', { name: 'Bundles', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Buy flex from an agent', exact: true })).toBeEnabled();
    await expect(page.getByText('PASOFI CUSTOMER SERVICE', { exact: true })).toBeVisible();
    const released = state.held.splice(0);
    await Promise.all(released.map(async ({ route, body }) => {
      await json(route, body);
      const response = await route.request().response(); expect(response).not.toBeNull();
      await response!.finished();
    }));
    // Two rendering opportunities let all delivered response microtasks commit.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('button', { name: 'Buy flex from an agent', exact: true })).toBeEnabled();
    await expect(page.getByText('PASOFI CUSTOMER SERVICE', { exact: true })).toBeVisible();
    await expect(page.getByText(emptyMessage, { exact: true })).toHaveCount(0);
    await expect(catalogueHeading(page)).toBeFocused();
    expect(state.mutations).toEqual([]); expect(state.unexpected).toEqual([]);
  } finally {
    await Promise.all(state.held.splice(0).map(({ route, body }) => json(route, body)));
  }
});
