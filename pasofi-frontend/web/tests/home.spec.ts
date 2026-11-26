import { test, expect, type Page, type Route } from '@playwright/test';

const product = { id: 'current-month', price_minor: 1000, currency: 'USD', byte_limit: '75000000000', validity_seconds: 2592000 };
const siteId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const caps = { demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: false, receiptPairing: false, staffSales: false, deliverySms: false, networkAccess: false, mobileCookies: false };
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
async function fixture(page: Page) {
  const state = { products: [product], locations: [{ id: siteId, name: 'Kuwadzana' }], locationsFail: false, locationReads: 0, mutations: [] as string[] };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') { state.mutations.push(path); return json(route, { error: 'unexpected_mutation' }, 405); }
    if (path === '/api/capabilities') return json(route, caps);
    if (path === '/api/bundles') return json(route, { products: state.products, candidate: false });
    if (path === '/api/onesa/availability') return json(route, { origin: new URL(route.request().url()).origin });
    if (path === '/api/help') return json(route, { articles: [] });
    if (path === '/api/sites') { state.locationReads++; return json(route, state.locationsFail ? { error: 'unavailable' } : { sites: state.locations }, state.locationsFail ? 503 : 200); }
    if (['/api/session', '/api/access', '/api/usage', '/api/recovery/status', '/api/orders'].includes(path)) return json(route, { error: 'not_authenticated' }, 401);
    return json(route, { error: 'unexpected_request' }, 500);
  });
  return state;
}

for (const width of [320, 390, 768, 1280]) test(`photo-led Home stays compact, readable and actionable at ${width}px`, async ({ page }, testInfo) => {
  const state = await fixture(page); await page.setViewportSize({ width, height: 900 }); await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your internet. Your everyday.', exact: true })).toBeVisible();
  const hero = page.getByRole('img', { name: 'Three friends sharing a happy moment around a smartphone' });
  await expect(hero).toBeVisible(); await expect.poll(() => hero.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1536);
  expect(await hero.getAttribute('fetchpriority')).toBe('high');
  await expect(page.locator('.pf-bundle-card h3')).toHaveText('75GB');
  await expect(page.locator('.pf-bundle-price strong')).toHaveText('$10.00');
  for (const button of await page.locator('.pasofi-home-actions button').all()) {
    const box = await button.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.width).toBeGreaterThanOrEqual(44);
  }
  const heroBox = await page.locator('.pasofi-home-hero').boundingBox(); expect(heroBox!.height).toBeLessThan(width < 600 ? 360 : 380);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Explore help', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Help & FAQs', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign up', exact: true })).toHaveCount(0);
  await expect(page.locator('#home-study-heading, #home-account-heading')).toHaveCount(0);
  await expect(page.getByAltText('Two adults working together on a laptop at a shared table')).toHaveCount(0);
  if (width < 600) {
    const imageBox = await hero.boundingBox();
    expect(imageBox!.width).toBeGreaterThan(width - 60);
    expect(imageBox!.height).toBeGreaterThanOrEqual(160);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(state.locationReads).toBe(0); expect(state.mutations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath(`home-photos-${width}.png`), fullPage: true });
  await page.getByRole('button', { name: 'Browse bundles', exact: true }).click();
  await expect(page).toHaveURL(/#bundles$/); await expect(page.getByRole('heading', { name: 'Find your fit.' })).toBeFocused();
  await expect(page.locator('.pasofi-home-hero')).toHaveCount(0);
});

test('Home location discovery searches real records, reports paused service and retries unavailable results', async ({ page }) => {
  const state = await fixture(page); state.locationsFail = true;
  await page.goto('/'); await page.getByRole('button', { name: 'Hotspot locations', exact: true }).click();
  await expect(page.getByLabel('Search locations')).toBeFocused();
  await expect(page.getByText('Locations could not be loaded.', { exact: false })).toBeVisible();
  await expect(page.getByText('Customer connections are currently paused.', { exact: false })).toBeVisible();
  state.locationsFail = false; state.locations.push({ id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2', name: 'Market Square' });
  await page.getByRole('button', { name: 'Refresh locations', exact: true }).click();
  await expect(page.getByText('Kuwadzana', { exact: true })).toBeVisible();
  await page.getByLabel('Search locations').fill('market');
  await expect(page.getByText('Market Square', { exact: true })).toBeVisible(); await expect(page.getByText('Kuwadzana', { exact: true })).toHaveCount(0);
  await expect(page.locator('.pasofi-home-location-content')).not.toContainText('Online');
  await page.getByRole('button', { name: 'Check Wi-Fi for Market Square' }).click();
  await expect(page).toHaveURL(/#wifi$/); expect(state.mutations).toEqual([]);
});

test('Home account shortcuts and connection guidance preserve guest privacy and the compact hotspot welcome', async ({ page }) => {
  const state = await fixture(page); await page.goto('/');
  await page.getByRole('button', { name: 'Check usage', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your internet', exact: true })).toBeVisible();
  await expect(page.getByText('No account is active in this browser.', { exact: false })).toBeVisible();
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Vouchers paused', exact: true })).toHaveCount(0);
  await page.goto('/'); await page.locator('.pasofi-home-guide > summary').click();
  await expect(page.getByRole('heading', { name: 'Find your hotspot', exact: true })).toBeVisible();
  await page.locator('.pasofi-home-guide').getByRole('button', { name: 'View bundles', exact: true }).click(); await expect(page).toHaveURL(/#bundles$/);
  await page.goto('/connect'); await expect(page.getByRole('heading', { name: 'Connect to PasoFi', exact: true })).toBeVisible();
  await expect(page.locator('.pasofi-home-hero, .pasofi-home-more')).toHaveCount(0);
  const voucher = page.getByRole('region', { name: 'Have a voucher?' });
  await expect(voucher.getByText('Voucher redemption is currently paused.', { exact: true })).toBeVisible();
  await expect(voucher.getByRole('button', { name: 'Redeem voucher' })).toHaveCount(0);
  await page.goto('/connect#voucher');
  await expect(page.getByRole('heading', { name: 'Vouchers paused', exact: true })).toBeVisible();
  await expect(page.getByText('Voucher redemption is currently paused.', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Voucher code', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Use a voucher', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Browse bundles', exact: true }).click();
  await expect(page).toHaveURL(/#bundles$/);
  expect(state.mutations).toEqual([]);
});

test('Home handles an empty published catalogue without inserting promotional prices or offers', async ({ page }) => {
  const state = await fixture(page); state.products = []; await page.goto('/');
  await expect(page.getByText('No bundles are published yet. Check back when PasoFi launches.', { exact: true })).toBeVisible();
  await expect(page.locator('.pf-bundle-card')).toHaveCount(0);
  await expect(page.locator('.pasofi-home-hero')).not.toContainText('$');
  await page.getByRole('button', { name: 'View bundles', exact: true }).click(); await expect(page).toHaveURL(/#bundles$/);
  expect(state.mutations).toEqual([]);
});

test('Home stays visible for signed-in customers and usage has its own route', async ({ page }) => {
  const state = await fixture(page);
  let sessionReads = 0;
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await page.route('**/api/session', route => { sessionReads++; return json(route, { customerId: id, guest: false }); });
  await page.route('**/api/access', route => json(route, { customerId: id, entitlements: [], nextOffset: null }));
  await page.goto('/');
  const hero = page.getByRole('heading', { name: 'Your internet. Your everyday.', exact: true });
  await expect(hero).toBeVisible();
  await page.getByRole('button', { name: 'Check usage', exact: true }).click();
  await expect(page).toHaveURL(/#usage$/);
  await expect(page.getByRole('heading', { name: 'Your internet', exact: true })).toBeVisible();
  await expect.poll(() => sessionReads).toBeGreaterThan(0);
  await page.goBack();
  await expect(hero).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/#usage$/);
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Home', exact: true }).click();
  await expect(hero).toBeVisible();
  expect(state.mutations).toEqual([]);
});

test('the Account icon leaves a saved checkout and cash reference pending until selected', async ({ page }) => {
  const state = await fixture(page);
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await page.addInitScript(id => {
    const prefix = 'pamofi.operation:customer:' + id;
    sessionStorage.setItem(prefix + ':purchase-details', JSON.stringify({ payload: JSON.stringify({ bundleId: 'flex' }) }));
    sessionStorage.setItem(prefix + ':receipt-pairing', JSON.stringify({ payload: JSON.stringify({ bundleId: 'flex', siteId: 'fixture' }) }));
  }, id);
  await page.route('**/api/session', route => json(route, { customerId: id, guest: false }));
  await page.goto('/');
  await page.getByRole('banner').getByRole('button', { name: 'Your account', exact: true }).click();
  await expect(page).toHaveURL(/#account$/);
  await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume checkout', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume cash purchase', exact: true })).toBeVisible();
  expect(state.mutations).toEqual([]);
});
