import { test, expect, type Route } from '@playwright/test';
import { usageSnapshot, usageCustomerId } from './usage-fixture';

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

for (const width of [320, 390, 1280]) {
  test(`public policies stay readable without the API at ${width}px`, async ({ page }, testInfo) => {
    const mutations: string[] = [];
    await page.route('**/api/**', route => {
      if (route.request().method() !== 'GET') mutations.push(route.request().url());
      return json(route, { error: 'unavailable' }, 503);
    });
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/connect#terms');
    const policy = page.locator('.pasofi-policy-page');
    await expect(policy.getByRole('heading', { name: 'Service terms', exact: true })).toBeVisible();
    await expect(policy.getByText('Operated by Onesa', { exact: true })).toBeVisible();
    await expect(policy.getByText('3964 98th Crescent Kuwadzana 5', { exact: true })).toBeVisible();
    await expect(policy.getByText('Version 1.0 · Updated 5 November 2026', { exact: true })).toBeVisible();
    const refund = policy.locator('summary').filter({ hasText: 'Refunds, failed connections and complaints' });
    await refund.focus(); await page.keyboard.press('Enter');
    await expect(policy.getByText('A request is not automatic approval', { exact: false })).toBeVisible();
    await expect(policy.getByRole('link', { name: 'Submit a POTRAZ complaint (opens a new tab)', exact: true })).toHaveAttribute('href', 'https://www.potraz.gov.zw/?page_id=987');
    await expect(policy).not.toContainText('finalized before service launch');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`terms-${width}.png`), fullPage: true });
    await page.getByRole('link', { name: 'Privacy', exact: true }).click();
    await expect(policy.getByRole('heading', { name: 'Privacy information', exact: true })).toBeVisible();
    await policy.getByText('Who receives information and where', { exact: true }).click();
    await expect(policy.getByText('Frankfurt, Germany', { exact: false })).toBeVisible();
    await expect(policy.getByText('Amsterdam, Netherlands', { exact: false })).toBeVisible();
    await page.reload();
    await expect(policy.getByRole('heading', { name: 'Privacy information', exact: true })).toBeVisible();
    expect(mutations).toEqual([]);
  });
}

test('reading inline policies preserves a saved cash request and its safe retry', async ({ page }) => {
  const siteId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', pairingId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const attempts: { key: string; payload: unknown }[] = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/capabilities') return json(route, { demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: true, receiptPairing: true, staffSales: true, deliverySms: false, networkAccess: false, mobileCookies: false });
    if (path === '/api/bundles') return json(route, { products: [{ id: 'flex', price_minor: 100, currency: 'USD', byte_limit: '10000000000', validity_seconds: 604800 }], candidate: false });
    if (path === '/api/sites') return json(route, { sites: [{ id: siteId, name: 'Test location' }] });
    if (path === '/api/session') return json(route, { customerId: usageCustomerId });
    if (path === '/api/usage') return json(route, usageSnapshot());
    if (path === '/api/access') return json(route, { customerId: usageCustomerId, entitlements: [], hasMore: false, nextOffset: null });
    if (path === '/api/help') return json(route, { articles: [] });
    if (path === '/api/receipt-pairings' && route.request().method() === 'POST') {
      attempts.push({ key: route.request().headers()['idempotency-key'], payload: route.request().postDataJSON() });
      if (attempts.length === 1) return route.abort('failed');
      return json(route, { pairing: { id: pairingId, code: 'ABCD234567', expiresAt: new Date(Date.now() + 600_000).toISOString(), status: 'pending' } });
    }
    if (path === `/api/receipt-pairings/${pairingId}`) return json(route, { status: 'pending' });
    return json(route, { error: 'unexpected_request' }, 500);
  });
  await page.goto('/#receipt?bundle=flex');
  await page.getByRole('button', { name: 'Create private pairing code', exact: false }).click();
  await expect(page.getByText('Your cash reference request is saved.', { exact: false })).toBeVisible();
  const saved = await page.evaluate(() => JSON.stringify(sessionStorage));
  const notice = page.locator('.pasofi-policy-notice');
  await notice.locator(':scope > summary').click();
  await notice.getByText('Read service terms and refunds', { exact: true }).click();
  await notice.getByText('Refunds, failed connections and complaints', { exact: true }).click();
  await expect(notice.getByText('Approval is not proof of payout.', { exact: false })).toBeVisible();
  expect(attempts).toHaveLength(1);
  expect(await page.evaluate(() => JSON.stringify(sessionStorage))).toBe(saved);
  await expect(page).toHaveURL(/#receipt\?bundle=flex$/);
  await notice.locator(':scope > summary').click();
  await page.getByRole('button', { name: 'Create private pairing code', exact: false }).click();
  await expect(page.getByText('ABCD234567', { exact: true })).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
});

test('help retains a local policy and complaint route when help articles fail', async ({ page }) => {
  await page.route('**/api/**', route => json(route, { error: 'unavailable' }, 503));
  await page.goto('/#help');
  await expect(page.getByText('Help is temporarily unavailable.', { exact: true })).toBeVisible();
  await page.locator('.pf-faq').getByText('How do I request access, correction or deletion of my information?', { exact: true }).click();
  await expect(page.locator('.pf-faq').getByText('Requests are handled manually', { exact: false })).toBeVisible();
  const notice = page.locator('.pasofi-policy-notice');
  await notice.locator(':scope > summary').click();
  await notice.getByText('Read privacy information', { exact: true }).click();
  await notice.getByText('Your requests and complaints', { exact: true }).click();
  await expect(notice.getByText('Requests are reviewed manually', { exact: false })).toBeVisible();
  await expect(notice.getByRole('link', { name: '+263 715 092 221', exact: true })).toHaveAttribute('href', 'tel:+263715092221');
});

test('frontend policy answers supersede older API copy and searches stay local', async ({ page }) => {
  const requests: string[] = [];
  await page.route('**/api/**', route => {
    requests.push(route.request().url());
    if (new URL(route.request().url()).pathname === '/api/help') return json(route, { articles: [
      { id: 'bundle-start', question: 'An older start question', answer: 'Outdated policy text must not be shown.' },
      { question: 'Will my bundle renew automatically?', answer: 'An older answer must not be shown.' },
      { question: 'How do I recover?', answer: 'Use your account reference and recovery key.' },
    ] });
    return json(route, { error: 'unavailable' }, 503);
  });
  await page.goto('/#help');
  await expect(page.locator('.pf-faq').getByText('How do I recover?', { exact: true })).toBeVisible();
  await expect(page.locator('.pf-faq')).not.toContainText('An older');
  await page.getByLabel('Find a quick answer').fill('refund');
  await expect(page.locator('.pf-faq').getByText('How do I request a cash refund or report a connection problem?', { exact: true })).toBeVisible();
  await expect(page.locator('.pf-faq').getByText('How do I recover?', { exact: true })).toHaveCount(0);
  expect(requests.some(url => url.includes('refund'))).toBe(false);
});
