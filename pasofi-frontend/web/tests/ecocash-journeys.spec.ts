import { test, expect, type Route } from '@playwright/test';

// The provider has not yet issued a verified merchant identity or incoming-credit
// contract. Both journeys must be clear to customers without exposing a payable
// number or opening an unqualified payment route.
const product = { id: 'flex', price_minor: 100, currency: 'USD', byte_limit: '5000000000', validity_seconds: 604800 };
const siteId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const base = { demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: false,
  receiptPairing: false, staffSales: false, deliverySms: false, networkAccess: false, mobileCookies: false };
function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

for (const mode of ['paused', 'card_available'] as const) {
  test(`EcoCash Pay Merchant and checkout remain independent and pending when ${mode}`, async ({ page }) => {
    const mutations: string[] = [];
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== 'GET') {
        mutations.push(path);
        return json(route, { error: 'no_mutation_allowed' }, 405);
      }
      if (path === '/api/capabilities') return json(route, { ...base,
        paymentCheckout: mode === 'card_available', paymentMode: mode === 'card_available' ? 'sandbox' : 'disabled' });
      if (path === '/api/bundles') return json(route, { products: [product], candidate: false });
      if (path === '/api/sites') return json(route, { sites: [{ id: siteId, name: 'Kuwadzana' }] });
      if (path === '/api/payments/methods') return json(route, { methods: [{code: 'STRIPE_CARD', name: 'Card',currency: 'USD', minMinor: 50,maxMinor: 50000}] });
      if (path === '/api/help') return json(route, { articles: [] });
      if (['/api/session', '/api/access', '/api/usage', '/api/orders'].includes(path))
        return json(route, { error: 'not_authenticated' }, 401);
      return json(route, { error: 'unavailable' }, 404);
    });
    await page.goto('/#checkout');
    await expect(page.getByRole('heading', { name: 'Two ways to pay with EcoCash' })).toBeVisible();
    const journeys = page.getByRole('region', { name: 'Two ways to pay with EcoCash' });
    await expect(journeys.getByText('Pay in PasoFi')).toBeVisible();
    await expect(journeys.getByText('Pay Merchant via EcoCash')).toBeVisible();
    await expect(journeys.getByText('Pending EcoCash merchant API approval', { exact: false })).toBeVisible();
    await expect(journeys.getByText('Pending merchant notification feed', { exact: false })).toBeVisible();
    await expect(journeys.getByText('Do not send money until', { exact: false })).toBeVisible();
    await expect(journeys.getByRole('button')).toHaveCount(0);
    expect(mutations).toEqual([]);
    if (mode === 'card_available') {
      await expect(page.getByLabel('Payment method')).toBeVisible();
      await expect(page.getByLabel('Payment method')).not.toContainText('EcoCash');
    }
  });
}
