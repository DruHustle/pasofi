import { expect, test } from '@playwright/test';

const paused = { demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: false, receiptPairing: false, staffSales: false, deliverySms: false, networkAccess: false, mobileCookies: false };
const bundle = { id: 'flex', price_minor: 100, currency: 'USD', byte_limit: '5000000000', validity_seconds: 86400 };

for (const width of [320, 390, 1280]) test(`Onesa customer entry is discoverable and recovers focus at ${width}px`, async ({ page }, info) => {
  let starts = 0;
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const body = url.pathname === '/api/onesa/availability' ? { origin: url.origin }
      : url.pathname === '/api/capabilities' ? paused
      : url.pathname === '/api/bundles' ? { products: [bundle], candidate: false }
      : url.pathname === '/api/help' ? { articles: [] } : { error: 'unavailable' };
    if (url.pathname === '/api/onesa/start') starts++;
    return route.fulfill({ status: url.pathname === '/api/onesa/start' ? 503 : url.pathname === '/api/session' ? 401 : 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.setViewportSize({ width, height: 900 }); await page.goto('/');
  const entry = page.getByRole('button', { name: 'Sign in with Onesa', exact: true });
  await expect(entry).toHaveCount(1); await expect(entry).toBeInViewport();
  await entry.click();
  await expect(page.getByRole('heading', { name: 'Continue to your Onesa account' })).toBeFocused();
  await expect(page.getByText(/Guest purchases stay with your guest account/)).toBeVisible();
  expect(starts).toBe(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(entry).toBeFocused(); await expect(entry).toHaveAttribute('aria-expanded', 'false');
  await entry.click(); await page.getByRole('button', { name: 'Continue with Onesa', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Onesa sign-in is temporarily unavailable');
  await expect(page.getByRole('button', { name: 'Continue with Onesa', exact: true })).toBeEnabled();
  expect(starts).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`customer-entry-${width}.png`), fullPage: true });
});

test('unverified availability cannot enable a published bundle and an explicit refresh recovers', async ({ page }) => {
  let available = false;
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const body = path === '/api/onesa/availability' ? { origin: null }
      : path === '/api/capabilities' ? { ...paused, staffSales: available }
      : path === '/api/bundles' ? { products: [bundle], candidate: false }
      : path === '/api/help' ? { articles: [] } : { error: 'not_authenticated' };
    return route.fulfill({ status: path === '/api/capabilities' && !available ? 503 : path === '/api/session' ? 401 : 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/#bundles');
  await expect(page.getByText('Purchase availability is not confirmed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'flex purchasing is not available' })).toBeDisabled();
  available = true;
  await page.getByRole('button', { name: 'Refresh availability', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Buy flex from an agent', exact: true })).toBeEnabled();
  await expect(page.getByText('Purchase availability is not confirmed', { exact: true })).toHaveCount(0);
});

test('staff sign-in clears the purpose of an abandoned customer flow before starting', async ({ page, baseURL }) => {
  // Preserve production's HTTPS requirement while serving this test's local UI.
  // No request reaches the reserved example hostname.
  await page.route('https://pasofi-entry.example.invalid/**', async route => {
    const target = new URL(route.request().url()), local = new URL(baseURL!);
    target.protocol = local.protocol; target.host = local.host;
    await route.fulfill({ response: await page.request.get(target.href) });
  });
  await page.addInitScript(() => sessionStorage.setItem('pasofi-onesa-customer', '1'));
  let starts = 0;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/staff/onesa/start') {
      expect(await page.evaluate(() => sessionStorage.getItem('pasofi-onesa-customer'))).toBeNull();
      starts++;
      return route.fulfill({ status: 503, json: { error: 'onesa_unavailable' } });
    }
    const body = url.pathname === '/api/staff/onesa/availability' ? { origin: url.origin }
      : url.pathname === '/api/onesa/availability' ? { origin: null }
      : url.pathname === '/api/capabilities' ? paused
      : url.pathname === '/api/bundles' ? { products: [], candidate: false }
      : url.pathname === '/api/help' ? { articles: [] } : { error: 'not_authenticated' };
    return route.fulfill({ status: url.pathname === '/api/staff/session' ? 401 : 200, json: body });
  });
  await page.goto('https://pasofi-entry.example.invalid/#staff');
  await page.getByRole('button', { name: 'Sign in with Onesa', exact: true }).click();
  await expect.poll(() => starts).toBe(1);
  await expect(page.getByRole('button', { name: 'Sign in with Onesa', exact: true })).toBeEnabled();
});
