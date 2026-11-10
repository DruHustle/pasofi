import { test, expect, type Page } from '@playwright/test';
import { usageSnapshot, usageCustomerId, usageEntitlementId } from './usage-fixture';

const products = [
  ['mini-v2', 50, '5000000000', 3], ['flex-v2', 100, '10000000000', 7],
  ['week-v2', 300, '30000000000', 7], ['fortnight-v2', 500, '50000000000', 14],
  ['month-v2', 1000, '100000000000', 30],
].map(([id, price_minor, byte_limit, days]) => ({ id, price_minor, byte_limit, currency: 'USD', validity_seconds: Number(days) * 86400 }));

// Synthetic records only: this review cannot publish offers or touch customer accounts.
async function fixture(page: Page, signedIn = false) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/capabilities') return reply({ demo: signedIn, paymentMode: 'disabled', paymentCheckout: false, vouchers: true, receiptPairing: true, staffSales: true, deliverySms: false, networkAccess: false, mobileCookies: false });
    if (path === '/api/bundles') return reply({ products, candidate: false });
    if (path === '/api/help') return reply({ articles: [] });
    if (path === '/api/sites') return reply({ sites: [] });
    if (path === '/api/network/sites') return reply({ accessPoints: [] });
    if (path === '/api/session') return reply(signedIn ? { customerId: usageCustomerId } : { error: 'not_authenticated' }, signedIn ? 200 : 401);
    if (path === '/api/usage') return reply(usageSnapshot('1000000000'));
    if (path === '/api/recovery/status') return reply({ configured: false });
    if (path === '/api/access') return reply({ customerId: usageCustomerId, entitlements: [{ id: usageEntitlementId, bundle_id: 'flex-v2', byte_limit: '5000000000', consumed_bytes: '1000000000', validity_seconds: 604800, activated_at: new Date().toISOString(), revoked_at: null, start_by: new Date(Date.now() + 86400000).toISOString() }], hasMore: false, nextOffset: null });
    return reply({ error: 'unexpected_review_request' }, 404);
  });
}

for (const width of [320, 390, 1280]) {
  test(`connection entry keeps five offers compact and voucher access visible at ${width}px`, async ({ page }, testInfo) => {
    await fixture(page); await page.setViewportSize({ width, height: 900 }); await page.goto('/connect');
    await expect(page.getByRole('heading', { name: 'Connect to Pasofi', exact: true })).toBeVisible();
    await expect(page.locator('.pf-bundle-card')).toHaveCount(5);
    await expect(page.getByText('Made for Zimbabwe', { exact: true })).toHaveCount(0);
    await expect(page.locator('.pf-connection-card')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Redeem voucher', exact: true })).toBeVisible();
    await expect(page.getByText('Filter & sort bundles', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const last = await page.locator('.pf-bundle-card').last().boundingBox();
    expect(last!.y + last!.height).toBeLessThan(width >= 1000 ? 900 : 1100);
    for (const button of await page.locator('.pf-bundle-card button, .pf-quick-actions button').all()) {
      const box = await button.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    await page.screenshot({ path: testInfo.outputPath(`connect-${width}.png`), fullPage: true });
  });
}

test('customer usage metadata remains readable on the vivid blue surface, including offline state', async ({ page, context }, testInfo) => {
  await fixture(page, true); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.getByRole('button', { name: 'Customer tools', exact: true }).click();
  await expect(page.getByTestId('usage-remaining')).toHaveText('4.000 GB');
  const selectors = ['.usage-card-top .eyebrow', '.usage-freshness', '.usage-meter-label', '.usage-validity dt', '.usage-validity small', '.usage-allowances dt', '.usage-allowances small', '.usage-ring span', '.usage-explanation summary', '.usage-refresh', '.usage-connection-pill'];
  async function checkContrast(selector: string) {
    const element = page.locator(`.premium-usage ${selector}`).first(); await expect(element).toBeVisible();
    const ratio = await element.evaluate(node => {
      const rgb = (text: string) => (text.match(/[\d.]+/g) ?? []).map(Number);
      const luminance = (color: number[]) => color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
      let ancestor: Element | null = node, background = [255, 255, 255];
      while (ancestor) {
        const value = rgb(getComputedStyle(ancestor).backgroundColor);
        if (value.length === 3 || value[3] === 1) { background = value; break; }
        ancestor = ancestor.parentElement;
      }
      const values = [luminance(rgb(getComputedStyle(node).color)), luminance(background)].sort((a, b) => a - b);
      return (values[1] + .05) / (values[0] + .05);
    });
    expect(ratio, `${selector} normal-text contrast`).toBeGreaterThanOrEqual(4.5);
  }
  for (const selector of selectors) await checkContrast(selector);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('dashboard-390.png'), fullPage: true });
  await context.setOffline(true);
  await expect(page.getByText('Offline · showing the last confirmed balance')).toBeVisible();
  await checkContrast('.usage-freshness');
});
