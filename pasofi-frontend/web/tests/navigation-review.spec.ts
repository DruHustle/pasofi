import { test, expect, type Page, type Route } from '@playwright/test';
import type { Capabilities, Product } from '../src/business';

const capabilities: Capabilities = { demo: false, paymentMode: 'disabled', paymentCheckout: false,
  vouchers: false, receiptPairing: false, staffSales: false, deliverySms: false, networkAccess: false, mobileCookies: false };
const products: Product[] = [
  { id: 'daily', price_minor: 50, currency: 'USD', byte_limit: '1000000000', validity_seconds: 86400 },
  { id: 'weekly', price_minor: 200, currency: 'USD', byte_limit: '8000000000', validity_seconds: 604800 },
];
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function guest(page: Page, overrides: Partial<Capabilities> = {}, catalogue: Product[] = products) {
  const mutations: string[] = [];
  await page.route('**/api/**', route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') { mutations.push(`${request.method()} ${path}`); return json(route, { error: 'unexpected_mutation' }, 405); }
    if (path === '/api/capabilities') return json(route, { ...capabilities, ...overrides });
    if (path === '/api/bundles') return json(route, { products: catalogue, candidate: false });
    if (path === '/api/sites') return json(route, { sites: [{ id: 'test-site', name: 'Isolated test site' }] });
    if (path === '/api/help') return json(route, { articles: [] });
    if (path === '/api/payments/methods') return json(route, { enabled: false, methods: [] });
    return json(route, { error: 'not_authenticated' }, 401);
  });
  return mutations;
}

for (const [route, title] of [['checkout', 'Checkout'], ['receipt', 'Buy with an agent']] as const) {
  test(`${route} direct entry and reload preserve the screen without submitting anything`, async ({ page }) => {
    const mutations = await guest(page);
    await page.goto(`/#${route}`);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Bundles', exact: true })).toHaveAttribute('aria-current', 'page');
    await page.reload();
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close customer workspace', exact: true }).click();
    await expect(page).toHaveURL(/#home$/);
    expect(mutations).toEqual([]);
  });
}

test('a selected agent bundle survives reload and uses the published price', async ({ page }) => {
  const mutations = await guest(page, { staffSales: true, receiptPairing: true });
  await page.goto('/#bundles');
  await page.getByRole('button', { name: 'Buy weekly from an agent', exact: true }).click();
  await expect(page).toHaveURL(/#receipt\?bundle=weekly$/);
  await expect(page.locator('.customer-order-summary')).toContainText('WEEKLY');
  await expect(page.locator('.customer-summary-price')).toContainText('$2.00');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Buy with an agent', exact: true })).toBeVisible();
  await expect(page.locator('.customer-order-summary')).toContainText('WEEKLY');
  await expect(page.locator('.customer-summary-price')).toContainText('$2.00');
  expect(mutations).toEqual([]);
});

test('an unpublished checkout link never silently selects another bundle', async ({ page }) => {
  const mutations = await guest(page, { paymentCheckout: true });
  await page.goto('/#checkout?bundle=retired');
  await expect(page.getByText('The selected bundle is no longer published. Choose an available bundle before continuing.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare checkout', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Bundle', exact: true }).selectOption('weekly');
  await expect(page.getByText('The selected bundle is no longer published.', { exact: false })).toHaveCount(0);
  await expect(page).toHaveURL(/#checkout\?bundle=weekly$/);
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Bundle', exact: true })).toHaveValue('weekly');
  expect(mutations).toEqual([]);
});

test('customer tools keep distinct routes through back and forward navigation', async ({ page }) => {
  const mutations = await guest(page);
  await page.goto('/#account');
  const sections = page.getByRole('navigation', { name: 'Customer sections' });
  await sections.getByRole('button', { name: 'Private receipt', exact: true }).click();
  await expect(page).toHaveURL(/#receipt\?bundle=daily$/);
  await sections.getByRole('button', { name: 'Online payment', exact: true }).click();
  await expect(page).toHaveURL(/#checkout\?bundle=daily$/);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Buy with an agent', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Checkout', exact: true })).toBeVisible();
  expect(mutations).toEqual([]);
});

test('handoff and staff entry routes reopen correctly and close to home', async ({ page }) => {
  const mutations = await guest(page);
  await page.goto('/handoff');
  await expect(page.getByRole('heading', { name: 'Accept a browser handoff', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close handoff', exact: true }).click();
  await expect(page).toHaveURL(/\/#home$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your internet. Your everyday.', exact: true })).toBeVisible();
  await page.locator('footer').getByRole('button', { name: 'Staff', exact: true }).click();
  await expect(page).toHaveURL(/#staff$/);
  await page.reload();
  const staff = page.getByRole('region', { name: 'Staff workspace' });
  await expect(staff.getByRole('link', { name: 'Sign in to Company Portal' })).toHaveAttribute('href', 'https://portal.onesa.eu/admin');
  await expect(staff.locator('input[type="password"]')).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test('a failed deferred workspace keeps navigation and offers safe recovery', async ({ page }) => {
  const mutations = await guest(page);
  await page.route('**/src/CustomerAccess.tsx*', route => route.abort('failed'));
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Let’s get you back on track.', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload this page', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Return to bundles', exact: true }).click();
  await expect(page).toHaveURL(/#bundles$/);
  await expect(page.getByRole('heading', { name: 'Find your fit.', exact: true, level: 1 })).toBeVisible();
  expect(mutations).toEqual([]);
});

test('history changes preserve explicit checkout when cash purchases are also available', async ({ page }) => {
  const mutations = await guest(page, { staffSales: true, receiptPairing: true, paymentCheckout: true });
  await page.goto('/#receipt?bundle=daily');
  const sections = page.getByRole('navigation', { name: 'Customer sections' });
  await sections.getByRole('button', { name: 'Online payment', exact: true }).click();
  await page.getByRole('combobox', { name: 'Bundle', exact: true }).selectOption('weekly');
  await expect(page).toHaveURL(/#checkout\?bundle=weekly$/);
  await page.goBack();
  await expect(page).toHaveURL(/#receipt\?bundle=daily$/);
  await expect(page.getByRole('heading', { name: 'Buy with an agent', exact: true })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/#checkout\?bundle=weekly$/);
  await expect(page.getByRole('heading', { name: 'Checkout', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Bundle', exact: true })).toHaveValue('weekly');
  expect(mutations).toEqual([]);
});

test('a catalogue render failure can recover on the same route', async ({ page }) => {
  const catalogue = [{ ...products[0], id: 'render-failure' }];
  const mutations = await guest(page, {}, catalogue);
  await page.route('**/src/BundleCatalogue.tsx*', async route => {
    const response = await route.fetch(), source = await response.text();
    // Inject one deterministic render failure into this isolated module only.
    // The next catalogue response is valid, so retry must reset the same route.
    expect(source).toContain('const selected =');
    await route.fulfill({ response, body: source.replace('const selected =', 'if (bundles?.[0]?.id === "render-failure") throw new Error("isolated render failure");\nconst selected =') });
  });
  await page.goto('/#bundles');
  await expect(page.getByRole('heading', { name: 'Let’s get you back on track.', exact: true })).toBeVisible();
  catalogue.splice(0, catalogue.length, ...products);
  await page.getByRole('button', { name: 'Return to bundles', exact: true }).click();
  await expect(page).toHaveURL(/#bundles$/);
  await expect(page.getByRole('heading', { name: 'Find your fit.', level: 1, exact: true })).toBeVisible();
  await expect(page.locator('.pf-bundle-card')).toHaveCount(2);
  expect(mutations).toEqual([]);
});

const owner = '31111111-1111-4111-8111-111111111111';
const orderId = '41111111-1111-4111-8111-111111111111';
const requestKey = '51111111-1111-4111-8111-111111111111';
const savedOrder = { id: orderId, bundle_id: 'retired', price_minor: 100, currency: 'USD', status: 'awaiting_payment',
  quote_expires_at: '2020-01-01T00:00:00.000Z', purchase_mode: 'checkout' };
async function savedCheckout(page: Page, checkoutEnabled: boolean, exactLookup = true) {
  const mutations = await guest(page, { paymentCheckout: checkoutEnabled });
  await page.addInitScript(({ customerId, key }) => {
    sessionStorage.setItem(`pamofi.operation:customer:${customerId}:purchase-details`, JSON.stringify({ key: '61111111-1111-4111-8111-111111111111', payload: JSON.stringify({ bundleId: 'retired', siteId: 'test-site', methodCode: 'mock' }) }));
    sessionStorage.setItem(`pamofi.operation:customer:${customerId}:order:retired`, JSON.stringify({ key, payload: JSON.stringify({ bundleId: 'retired', mode: 'checkout' }) }));
  }, { customerId: owner, key: requestKey });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET') return route.fallback();
    if (url.pathname === '/api/session') return json(route, { customerId: owner });
    if (url.pathname === '/api/access') return json(route, { customerId: owner, entitlements: [], hasMore: false, nextOffset: null });
    if (url.pathname === '/api/orders') {
      expect(url.searchParams.get('requestKey')).toBe(requestKey);
      return json(route, { customerId: owner, ...(exactLookup ? { lookupKey: requestKey } : {}), orders: [savedOrder] });
    }
    if (url.pathname === `/api/orders/${orderId}/status`) return json(route, {
      order: savedOrder, attempts: [{ id: requestKey, state: 'pending' }], entitlementId: null,
      fulfillmentState: 'unconfirmed', entitlementRevokedAt: null, simulation: true,
    });
    return route.fallback();
  });
  return mutations;
}

for (const checkoutEnabled of [true, false]) {
  test(`an unpublished saved order remains checkable with checkout ${checkoutEnabled ? 'enabled' : 'paused'}`, async ({ page }) => {
    const mutations = await savedCheckout(page, checkoutEnabled);
    await page.goto('/#checkout?bundle=weekly');
    await expect(page).toHaveURL(/#checkout\?bundle=retired$/);
    await expect(page.getByText('This bundle is no longer published. Your saved purchase is preserved; check its verified status before paying again.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Check verified payment status', exact: true }).click();
    await expect(page.getByText('Payment not confirmed. pending', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.endsWith(':purchase-details')).length)).toBe(1);
    expect(mutations).toEqual([]);
  });
}

test('a legacy or mismatched order-list response cannot restore an unrelated purchase', async ({ page }) => {
  const mutations = await savedCheckout(page, false, false);
  await page.goto('/#checkout');
  await expect(page.getByRole('button', { name: 'Check saved checkout status', exact: true })).toBeEnabled();
  await expect(page.getByText('Your checkout is still saved. Its order could not be loaded.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check verified payment status', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.endsWith(':purchase-details')).length)).toBe(1);
  expect(mutations).toEqual([]);
});

for (const delayedOperation of ['lookup', 'quote closure'] as const) {
  test(`a delayed ${delayedOperation} cannot replace or clear a newer checkout`, async ({ page }) => {
    const unexpected = await savedCheckout(page, true);
    const nextBundle = delayedOperation === 'lookup' ? 'weekly' : 'retired';
    const nextOrder = { ...savedOrder, id: '81111111-1111-4111-8111-111111111111', bundle_id: nextBundle, quote_expires_at: '2099-01-01T00:00:00.000Z' };
    let release!: () => void, lookupCount = 0, delayedStarted = false;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const submitted: string[] = [];
    await page.route('**/api/**', async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.method() === 'GET' && url.pathname === '/api/bundles') return json(route, { products: [...products, { ...products[0], id: 'retired' }] });
      if (request.method() === 'GET' && url.pathname === '/api/payments/methods') return json(route, { enabled: true, methods: [{ code: 'mock', name: 'Isolated test provider', currency: 'USD', minMinor: 1, maxMinor: 100000 }] });
      if (request.method() === 'GET' && url.pathname === '/api/orders' && delayedOperation === 'lookup' && ++lookupCount === 1) {
        delayedStarted = true; await delayed;
        return json(route, { customerId: owner, lookupKey: requestKey, orders: [savedOrder] });
      }
      if (request.method() === 'GET' && url.pathname === `/api/orders/${orderId}/status`) return json(route, {
        order: { ...savedOrder, status: 'expired_unused' }, attempts: [], entitlementId: null,
        fulfillmentState: 'unconfirmed', entitlementRevokedAt: null, safeToRequote: true, simulation: true,
      });
      if (request.method() === 'POST' && url.pathname === `/api/orders/${orderId}/expire-unused`) {
        delayedStarted = true; await delayed;
        return json(route, { orderId, state: 'expired_unused', safeToRequote: true, replayed: false });
      }
      if (request.method() === 'POST' && url.pathname === '/api/orders') { submitted.push(url.pathname); return json(route, { order: nextOrder }, 201); }
      if (request.method() === 'POST' && url.pathname === `/api/orders/${nextOrder.id}/checkout`) { submitted.push(url.pathname); return json(route, { attemptId: requestKey, state: 'pending', redirectUrl: null, simulation: true }); }
      if (request.method() === 'GET' && url.pathname === `/api/orders/${nextOrder.id}/status`) return json(route, {
        order: nextOrder, attempts: [{ id: requestKey, state: 'pending' }], entitlementId: null,
        fulfillmentState: 'unconfirmed', entitlementRevokedAt: null, simulation: true,
      });
      return route.fallback();
    });
    await page.goto('/#checkout');
    if (delayedOperation === 'lookup') {
      await expect.poll(() => delayedStarted).toBe(true);
      await page.getByRole('button', { name: 'Check saved checkout status', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Close an expired unused quote', exact: true }).click();
      await expect.poll(() => delayedStarted).toBe(true);
      const navigation = page.getByRole('navigation', { name: 'Main navigation' });
      await navigation.getByRole('button', { name: 'Bundles', exact: true }).click();
      await navigation.getByRole('button', { name: 'Account', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Check verified payment status', exact: true }).click();
    await page.getByRole('button', { name: 'Review a fresh quote', exact: true }).click();
    await page.getByRole('combobox', { name: 'Bundle', exact: true }).selectOption(nextBundle);
    await page.getByRole('checkbox', { name: /reviewed the price/ }).check();
    await page.getByRole('button', { name: 'Prepare checkout', exact: true }).click();
    await expect(page.getByRole('heading', { name: `Order ${nextOrder.id.slice(0, 8)}`, exact: true })).toBeVisible();
    const oldResponse = page.waitForResponse(response => delayedOperation === 'lookup'
      ? new URL(response.url()).pathname === '/api/orders' && response.request().method() === 'GET'
      : response.url().endsWith(`/api/orders/${orderId}/expire-unused`));
    release(); await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('heading', { name: `Order ${nextOrder.id.slice(0, 8)}`, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Check verified payment status', exact: true }).click();
    await expect(page.getByText('Payment not confirmed. pending', { exact: true })).toBeVisible();
    const saved = await page.evaluate(({ customerId, bundle }) => ({
      details: sessionStorage.getItem(`pamofi.operation:customer:${customerId}:purchase-details`),
      order: sessionStorage.getItem(`pamofi.operation:customer:${customerId}:order:${bundle}`),
    }), { customerId: owner, bundle: nextBundle });
    expect(saved.details).not.toBeNull(); expect(saved.order).not.toBeNull();
    expect(JSON.parse(JSON.parse(saved.details!).payload).bundleId).toBe(nextBundle);
    expect(submitted).toEqual(['/api/orders', `/api/orders/${nextOrder.id}/checkout`]);
    expect(unexpected).toEqual([]);
  });
}
