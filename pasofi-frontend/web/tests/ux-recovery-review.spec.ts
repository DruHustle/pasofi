import { test, expect, type Page, type Route } from '@playwright/test';
import { usageSnapshot, usageCustomerId as customerId, usageEntitlementId as entitlementId } from './usage-fixture';

const siteId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const grantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const product = { id: 'flex', price_minor: 100, currency: 'USD', byte_limit: '10000000000', validity_seconds: 604800 };
const site = { id: siteId, name: 'Review hotspot', loginUrl: 'https://hotspot.pasofi.onesa.eu/login' };
const accessPoint = { siteId, nasId: '11111111-1111-4111-8111-111111111111', siteName: site.name, name: 'Review router', loginUrl: site.loginUrl };
const capabilities = { demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: true, receiptPairing: true, staffSales: true, deliverySms: false, networkAccess: true, mobileCookies: false };
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function fixture(page: Page, handle: (route: Route, path: string) => Promise<boolean>) {
  const mutations: string[] = [];
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') mutations.push(path);
    if (await handle(route, path)) return;
    if (path === '/api/capabilities') return json(route, capabilities);
    if (path === '/api/session') return json(route, { customerId });
    if (path === '/api/usage') return json(route, usageSnapshot('0'));
    if (path === '/api/access') return json(route, { customerId, entitlements: [], hasMore: false, nextOffset: null });
    if (path === '/api/sites') return json(route, { sites: [site] });
    if (path === '/api/network/sites') return json(route, { accessPoints: [accessPoint] });
    if (path === '/api/bundles') return json(route, { products: [product], candidate: false });
    if (path === '/api/help') return json(route, { articles: [] });
    return json(route, { error: 'unexpected_request' }, 500);
  });
  return mutations;
}

for (const failure of ['unavailable', 'empty'] as const) {
  test(`hotspot ${failure} location read can recover without leaving the connection screen`, async ({ page }) => {
    let recover = false;
    const mutations = await fixture(page, async (route, path) => {
      if (path !== '/api/network/sites') return false;
      await json(route, recover ? { accessPoints: [accessPoint] } : failure === 'empty' ? { accessPoints: [] } : { error: 'unavailable' }, !recover && failure === 'unavailable' ? 503 : 200);
      return true;
    });
    await page.goto('/#wifi');
    const retry = page.getByRole('button', { name: failure === 'empty' ? 'Refresh locations' : 'Retry locations', exact: true });
    await expect(retry).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true })).toHaveCount(0);
    recover = true; await retry.click();
    await expect(page.getByText('Connecting at', { exact: false })).toContainText('Review hotspot');
    await expect(page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true })).toBeEnabled();
    expect(mutations).toEqual([]);
  });
}

for (const endpoint of ['/api/sites', '/api/bundles']) {
  test(`cash workflow retries failed ${endpoint} reads and preserves the selected bundle`, async ({ page }) => {
    let recover = false;
    const mutations = await fixture(page, async (route, path) => {
      if (path !== endpoint || recover) return false;
      await json(route, { error: 'unavailable' }, 503); return true;
    });
    await page.goto('/#receipt?bundle=flex');
    await expect(page.getByRole('button', { name: 'Retry purchase options', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create private pairing code', exact: false })).toBeDisabled();
    recover = true; await page.getByRole('button', { name: 'Retry purchase options', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Cash bundle', exact: true })).toHaveValue('flex');
    await expect(page.getByRole('combobox', { name: 'Cash location', exact: true })).toHaveValue(siteId);
    await expect(page.getByRole('button', { name: 'Create private pairing code', exact: false })).toBeEnabled();
    await expect(page).toHaveURL(/#receipt\?bundle=flex$/);
    expect(mutations).toEqual([]);
  });
}

test('paused issuance without a current session gives a clear status without failed location requests', async ({ page }) => {
  const mutations = await fixture(page, async (route, path) => {
    if (path === '/api/capabilities') { await json(route, { ...capabilities, networkAccess: false }); return true; }
    if (path === '/api/network/sites' || path === '/api/network/credentials') throw Error('Paused issuance must not request locations or credentials');
    return false;
  });
  await page.goto('/#wifi');
  await expect(page.getByText('New hotspot connections are paused.', { exact: false })).toContainText('Ask your PasoFi agent when service is available.');
  await expect(page.getByText('No active hotspot session', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check connection', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Retry locations|Connect to Wi-Fi|Disconnect this hotspot session/ })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(mutations).toEqual([]);
});

test('paused issuance keeps the current session visible and allows disconnect without exposing new credentials', async ({ page }) => {
  let disconnect = false;
  const mutations = await fixture(page, async (route, path) => {
    if (path === '/api/capabilities') { await json(route, { ...capabilities, networkAccess: false }); return true; }
    if (path === '/api/network/sites' || path === '/api/network/credentials') throw Error('Paused issuance must not request locations or credentials');
    if (path === '/api/network/disconnect') {
      expect(route.request().postDataJSON()).toEqual({ grantId }); disconnect = true;
      await json(route, { state: 'disconnect_pending' }, 202); return true;
    }
    if (path === '/api/usage') {
      const snapshot = usageSnapshot('1000000000');
      snapshot.session = { grantId, entitlementId, siteId, state: 'active', connected: !disconnect, issuedAt: new Date().toISOString(), lastAccountingAt: new Date().toISOString(), deadline: new Date(Date.now() + 60_000).toISOString(), reservedBytes: '5000000000', chargedBytes: '1000000000', reservationOutstandingBytes: '4000000000', disconnectRequested: disconnect, accountingAnomaly: false, accountingStale: false };
      snapshot.connectivity = 'recent_accounting'; await json(route, snapshot); return true;
    }
    return false;
  });
  await page.goto('/#wifi');
  await expect(page.getByText('New hotspot connections are paused.', { exact: false })).toBeVisible();
  await expect(page.getByText('Connected · recent router report', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect now →', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Disconnect this hotspot session', exact: true }).click();
  await expect(page.getByText('Disconnect awaiting confirmation', { exact: true })).toBeVisible();
  expect(mutations).toEqual(['/api/network/disconnect']);
});
