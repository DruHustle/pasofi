import { test, expect, type Page, type Route } from '@playwright/test';
import { usageSnapshot, usageCustomerId as customerId, usageEntitlementId as entitlementId } from './usage-fixture';

const siteId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const otherCustomer = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const future = () => new Date(Date.now() + 86400_000).toISOString();
const entitlement = () => ({ id: entitlementId, bundle_id: 'flex', byte_limit: '5000000000', consumed_bytes: '0', validity_seconds: 604800, activated_at: new Date().toISOString(), revoked_at: null, start_by: future() });
const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
async function mock(page: Page, handle: (route: Route, path: string) => Promise<boolean>) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (await handle(route, path)) return;
    if (path === '/api/capabilities') return json(route, { demo: true, paymentMode: 'disabled', paymentCheckout: false, vouchers: true, receiptPairing: true, staffSales: true, deliverySms: false, networkAccess: false, mobileCookies: false });
    if (path === '/api/bundles') return json(route, { products: [{ id: 'flex', price_minor: 100, currency: 'USD', byte_limit: '5000000000', validity_seconds: 604800 }], candidate: true });
    if (path === '/api/sites') return json(route, { sites: [] });
    if (path === '/api/help') return json(route, { articles: [] });
    if (path === '/api/session') return json(route, { customerId });
    if (path === '/api/access') return json(route, { customerId, entitlements: [entitlement()], hasMore: false, nextOffset: null });
    return json(route, { error: 'unexpected_request' }, 500);
  });
}
async function open(page: Page) { await page.goto('/'); await page.getByRole('button', { name: 'Customer tools' }).click(); await expect(page.getByTestId('live-usage')).toBeVisible(); }

test('remaining data updates automatically from the whole-account ledger and synchronizes visible bundle cards', async ({ page }, testInfo) => {
  let used = '1000000000', historyReads = 0, networkReads = 0; const requestedIds: string[] = [];
  await page.clock.install();
  await mock(page, async (route, path) => {
    if (path === '/api/usage') {
      requestedIds.push(new URL(route.request().url()).searchParams.get('entitlementIds') ?? '');
      const snapshot = usageSnapshot(used, { allowanceBytes: '600000000000', queuedBytes: '595000000000' }); snapshot.queued.bundleCount = 119; snapshot.totals.bundleCount = 120;
      await json(route, snapshot); return true;
    }
    if (path === '/api/access') { historyReads++; return false; }
    if (path === '/api/network/session') { networkReads++; return false; }
    return false;
  });
  await open(page); await expect(page.getByTestId('usage-remaining')).toHaveText('599.000 GB'); await expect(page.getByTestId('usage-queued')).toHaveText('595.000 GB');
  const initialReads = historyReads; used = '2000000000'; await page.clock.runFor(5_000);
  await expect(page.getByTestId('usage-remaining')).toHaveText('598.000 GB'); await expect(page.getByTestId('usage-used')).toHaveText('2.000 GB'); await expect(page.getByTestId('usage-active')).toHaveText('3.000 GB');
  await expect(page.locator(`[data-entitlement-id="${entitlementId}"]`)).toContainText('2.000 GB accounted'); expect(historyReads).toBe(initialReads); expect(networkReads).toBe(0); expect(requestedIds.some(ids => ids.includes(entitlementId))).toBe(true);
  await expect(page.getByRole('progressbar', { name: 'Data allowance used' })).toHaveAttribute('aria-valuetext', /2\.000 GB used of 600\.000 GB/);
  await expect(page.getByTestId('live-usage')).not.toHaveAttribute('aria-live');
  for (const width of [320, 360, 1280]) {
    await page.setViewportSize({ width, height: 1000 }); await page.getByTestId('live-usage').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByTestId('live-usage').screenshot({ path: testInfo.outputPath(`live-usage-${width}.png`) });
  }
});

test('exhausted valid data stays at 100 percent and malformed updates retain the last good balance', async ({ page }) => {
  let malformed = false; const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.clock.install(); await mock(page, async (route, path) => { if (path !== '/api/usage') return false; const snapshot = usageSnapshot('5000000000'); await json(route, malformed ? { ...snapshot, totals: { ...snapshot.totals, usedBytes: 'broken' } } : snapshot); return true; });
  await open(page); await expect(page.getByTestId('usage-remaining')).toHaveText('0.000 GB'); await expect(page.getByRole('progressbar')).toHaveAttribute('value', '100');
  malformed = true; await page.clock.runFor(5_000); await expect(page.getByText('Update delayed · showing the last confirmed balance')).toBeVisible(); await expect(page.getByTestId('usage-used')).toHaveText('5.000 GB'); await expect(page.getByRole('progressbar')).toHaveAttribute('value', '100'); expect(errors).toEqual([]);
});

test('offline and hidden views pause polls; reconnect refreshes immediately and rate limits back off', async ({ page, context }) => {
  let used = '1000000000', reads = 0, limited = false;
  await page.clock.install(); await mock(page, async (route, path) => { if (path !== '/api/usage') return false; reads++; await json(route, limited ? { error: 'rate_limited' } : usageSnapshot(used), limited ? 429 : 200, limited ? { 'Retry-After': '30' } : {}); return true; });
  await open(page); await expect(page.getByTestId('usage-remaining')).toHaveText('4.000 GB');
  await context.setOffline(true); await expect(page.getByText('Offline · showing the last confirmed balance')).toBeVisible(); const beforeOffline = reads; used = '2000000000'; await page.clock.runFor(20_000); expect(reads).toBe(beforeOffline); await expect(page.getByTestId('usage-remaining')).toHaveText('4.000 GB');
  await context.setOffline(false); await expect(page.getByTestId('usage-remaining')).toHaveText('3.000 GB');
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); }); const beforeHidden = reads; await page.clock.runFor(15_000); expect(reads).toBe(beforeHidden); await expect(page.getByText('Updates paused while this view is inactive')).toBeVisible();
  await page.evaluate(() => { delete (document as unknown as { hidden?: boolean }).hidden; document.dispatchEvent(new Event('visibilitychange')); }); await expect(page.getByText('Updates automatically every 5 seconds')).toBeVisible();
  limited = true; await page.clock.runFor(5_000); await expect(page.getByText('Update delayed · showing the last confirmed balance')).toBeVisible(); const atLimit = reads; await page.clock.runFor(20_000); expect(reads).toBe(atLimit);
  limited = false; used = '3000000000'; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect(page.getByTestId('usage-remaining')).toHaveText('2.000 GB');
});

for (const changed of ['expired', 'different owner'] as const) {
  test(`a ${changed} usage session clears private state and fences a held history response`, async ({ page }) => {
    let invalidate = false, reads = 0, release!: () => void, held!: () => void;
    const waiting = new Promise<void>(resolve => { held = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    await page.clock.install(); await mock(page, async (route, path) => {
      if (path === '/api/usage') { reads++; await json(route, invalidate ? changed === 'expired' ? { error: 'not_authenticated' } : usageSnapshot('0', { customerId: otherCustomer }) : usageSnapshot('1000000000'), invalidate && changed === 'expired' ? 401 : 200); return true; }
      if (path === '/api/access') { held(); await gate; await json(route, { customerId, entitlements: [entitlement()], hasMore: false, nextOffset: null }); return true; }
      return false;
    });
    await open(page); await waiting; await expect(page.getByTestId('usage-remaining')).toHaveText('4.000 GB'); invalidate = true; await page.clock.runFor(5_000);
    await expect(page.getByText('Your customer session changed or expired.', { exact: false })).toBeVisible(); await expect(page.getByTestId('live-usage')).toHaveCount(0);
    const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/access'); release(); await (await response).finished(); await page.clock.runFor(20_000); const stoppedAt = reads; await page.clock.runFor(10_000); expect(reads).toBe(stoppedAt); await expect(page.locator('[data-entitlement-id]')).toHaveCount(0);
  });
}

test('a held old-account usage read cannot replace the account reopened after cross-tab logout', async ({ page }) => {
  let owner = customerId, release!: () => void, held!: () => void, finished!: () => void;
  const waiting = new Promise<void>(resolve => { held = resolve; }), gate = new Promise<void>(resolve => { release = resolve; }), done = new Promise<void>(resolve => { finished = resolve; });
  await mock(page, async (route, path) => {
    if (path === '/api/session') { await json(route, { customerId: owner }); return true; }
    if (path === '/api/access') { await json(route, { customerId: owner, entitlements: [], hasMore: false, nextOffset: null }); return true; }
    if (path === '/api/usage') { const captured = owner; if (captured === customerId) { held(); await gate; } await json(route, usageSnapshot(captured === customerId ? '1000000000' : '3000000000', { customerId: captured })).catch(() => {}); if (captured === customerId) finished(); return true; }
    return false;
  });
  await open(page); await waiting; owner = otherCustomer; await page.evaluate(() => { const channel = new BroadcastChannel('pamofi.session'); channel.postMessage('signed_out'); channel.close(); });
  await expect(page.getByRole('heading', { name: 'Your connection, in one place' })).toHaveCount(0); await page.getByRole('button', { name: 'Customer tools' }).click(); await expect(page.getByTestId('usage-remaining')).toHaveText('2.000 GB'); release(); await done; await expect(page.getByTestId('usage-remaining')).toHaveText('2.000 GB'); await expect(page.getByTestId('usage-used')).toHaveText('3.000 GB');
});

test('a slow history response cannot roll back newer verified usage counters', async ({ page }) => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await mock(page, async (route, path) => {
    if (path === '/api/usage') { await json(route, usageSnapshot('2000000000')); return true; }
    if (path === '/api/access') { await gate; await json(route, { customerId, entitlements: [entitlement()], hasMore: false, nextOffset: null }); return true; }
    return false;
  });
  await open(page); await expect(page.getByTestId('usage-used')).toHaveText('2.000 GB'); release(); await expect(page.locator(`[data-entitlement-id="${entitlementId}"]`)).toContainText('2.000 GB accounted');
});

test('credentials arriving after a failed usage check stay hidden until a new verified preparation', async ({ page }) => {
  let unavailable = false, prepared = false, calls = 0, release!: () => void, held!: () => void;
  const keys: string[] = [], gate = new Promise<void>(resolve => { release = resolve; }), waiting = new Promise<void>(resolve => { held = resolve; });
  await page.clock.install(); await mock(page, async (route, path) => {
    if (path === '/api/capabilities') { await json(route, { demo: true, paymentMode: 'disabled', paymentCheckout: false, vouchers: true, receiptPairing: true, staffSales: true, deliverySms: false, networkAccess: true, mobileCookies: false }); return true; }
    if (path === '/api/network/sites') { await json(route, { sites: [{ id: siteId, name: 'Test hotspot', loginUrl: 'https://hotspot.example.test/login' }] }); return true; }
    if (path === '/api/usage') { const snapshot = usageSnapshot('0', { queuedBytes: '5000000000' }); if (prepared) { snapshot.connectivity = 'pending'; snapshot.session = { grantId: entitlementId, entitlementId, siteId, state: 'pending', connected: false, issuedAt: new Date().toISOString(), deadline: future(), lastAccountingAt: null, reservedBytes: '5000000000', chargedBytes: '0', reservationOutstandingBytes: '5000000000', disconnectRequested: false, accountingStale: false, accountingAnomaly: false }; } await json(route, unavailable ? { error: 'usage_unavailable' } : snapshot, unavailable ? 503 : 200); return true; }
    if (path === '/api/network/credentials') { keys.push(route.request().postDataJSON().requestKey); calls++; prepared = true; if (calls === 1) { held(); await gate; } await json(route, { username: 'private-hotspot-user', password: 'private-hotspot-password', expiresAt: future(), loginUrl: 'https://hotspot.example.test/login' }); return true; }
    return false;
  });
  await open(page); await page.getByRole('button', { name: 'Prepare hotspot sign-in' }).click(); await waiting; unavailable = true; await page.clock.runFor(5_000); await expect(page.getByText('Connection status not verified', { exact: true })).toBeVisible(); release(); await expect(page.getByText('Account status changed while preparing sign-in.', { exact: false })).toBeVisible(); await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveCount(0);
  unavailable = false; await page.getByRole('button', { name: 'Check connection', exact: true }).click(); await expect(page.getByRole('button', { name: 'Retry prepared sign-in safely' })).toBeEnabled(); await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveCount(0); await page.getByRole('button', { name: 'Retry prepared sign-in safely' }).click(); await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveValue('private-hotspot-password'); expect(new Set(keys).size).toBe(1);
});
