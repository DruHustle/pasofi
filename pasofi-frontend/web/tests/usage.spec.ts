import { test, expect, type Page, type Route } from '@playwright/test';
import { usageSnapshot, usageCustomerId as customerId, usageEntitlementId as entitlementId } from './usage-fixture';

const siteId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const nasId = '11111111-1111-4111-8111-111111111111';
const secondNasId = '22222222-2222-4222-8222-222222222222';
const accessPoint = (id = nasId, name = 'Test hotspot', host = 'hotspot.example.test') => ({ nasId: id, siteId, siteName: 'Test site', name, loginUrl: `https://${host}/login` });
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

test('hotspot preparation respects exhausted data and explains server-side eligibility changes', async ({ page }) => {
  let used = '5000000000', attempts = 0;
  await mock(page, async (route, path) => {
    if (path === '/api/capabilities') { await json(route, { demo: true, networkAccess: true }); return true; }
    if (path === '/api/network/sites') { await json(route, { accessPoints: [accessPoint()] }); return true; }
    if (path === '/api/usage') { await json(route, usageSnapshot(used)); return true; }
    if (path === '/api/network/credentials') { attempts++; await json(route, { error: 'no_usable_entitlement' }, 409); return true; }
    return false;
  });
  await open(page);
  const connect = page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true });
  await expect(page.getByText('Your account has no remaining data for a new hotspot connection.', { exact: false })).toBeVisible();
  await expect(connect).toBeDisabled();
  expect(attempts).toBe(0);
  used = '0';
  await page.getByRole('button', { name: 'Refresh data balance' }).click();
  await expect(connect).toBeEnabled();
  await connect.click();
  await expect(page.getByText('Your account has no bundle eligible for a new hotspot session.', { exact: false })).toBeVisible();
  expect(attempts).toBe(1);
});

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
  await expect(page.getByRole('heading', { name: 'Your internet', exact: true })).toHaveCount(0); await page.getByRole('button', { name: 'Customer tools' }).click(); await expect(page.getByTestId('usage-remaining')).toHaveText('2.000 GB'); release(); await done; await expect(page.getByTestId('usage-remaining')).toHaveText('2.000 GB'); await expect(page.getByTestId('usage-used')).toHaveText('3.000 GB');
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
    if (path === '/api/network/sites') { await json(route, { accessPoints: [accessPoint()] }); return true; }
    if (path === '/api/usage') { const snapshot = usageSnapshot('0', { queuedBytes: '5000000000' }); if (prepared) { snapshot.connectivity = 'pending'; snapshot.session = { grantId: entitlementId, entitlementId, siteId, nasId, state: 'pending', connected: false, issuedAt: new Date().toISOString(), deadline: future(), lastAccountingAt: null, reservedBytes: '5000000000', chargedBytes: '0', reservationOutstandingBytes: '5000000000', disconnectRequested: false, accountingStale: false, accountingAnomaly: false }; } await json(route, unavailable ? { error: 'usage_unavailable' } : snapshot, unavailable ? 503 : 200); return true; }
    if (path === '/api/network/credentials') { keys.push(route.request().postDataJSON().requestKey); calls++; prepared = true; if (calls === 1) { held(); await gate; } await json(route, { siteId, nasId, username: 'private-hotspot-user', password: 'private-hotspot-password', expiresAt: future(), loginUrl: 'https://hotspot.example.test/login' }); return true; }
    return false;
  });
  await open(page); await page.getByRole('button', { name: 'Connect to Wi-Fi' }).click(); await waiting; unavailable = true; await page.clock.runFor(5_000); await expect(page.getByText('Connection status not verified', { exact: true })).toBeVisible(); release(); await expect(page.getByText('Account status changed while preparing sign-in.', { exact: false })).toBeVisible(); await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveCount(0);
  unavailable = false; await page.getByRole('button', { name: 'Check connection', exact: true }).click(); await expect(page.getByRole('button', { name: 'Retry connection' })).toBeEnabled(); await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveCount(0); await page.getByRole('button', { name: 'Retry connection' }).click(); await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveValue('private-hotspot-password'); expect(new Set(keys).size).toBe(1);
});

for (const initial of ['hidden details', 'lost response'] as const) {
  test(`expired hotspot credentials recover after ${initial} without repeating an uncertain request under a new key`, async ({ page }) => {
    const keys: string[] = [];
    await mock(page, async (route, path) => {
      if (path === '/api/capabilities') { await json(route, { demo: true, paymentMode: 'disabled', paymentCheckout: false, vouchers: true, receiptPairing: true, staffSales: true, deliverySms: false, networkAccess: true, mobileCookies: false }); return true; }
      if (path === '/api/network/sites') { await json(route, { accessPoints: [accessPoint()] }); return true; }
      if (path === '/api/usage') { await json(route, usageSnapshot('0', { queuedBytes: '5000000000' })); return true; }
      if (path === '/api/network/credentials') {
        keys.push(route.request().postDataJSON().requestKey);
        if (keys.length === 1 && initial === 'lost response') await json(route, { error: 'network_unavailable' }, 503);
        else if (keys.length === 2) await json(route, { error: 'credential_expired' }, 409);
        else await json(route, { siteId, nasId, username: 'private-hotspot-user', password: 'private-hotspot-password', expiresAt: future(), loginUrl: 'https://hotspot.example.test/login' });
        return true;
      }
      return false;
    });
    await open(page);
    const connect = page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true });
    await connect.click();
    if (initial === 'hidden details') {
      await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveValue('private-hotspot-password');
      await page.getByRole('button', { name: 'Hide connection details' }).click();
    } else await expect(page.getByText('The service is temporarily unavailable.', { exact: false })).toBeVisible();
    await expect(connect).toBeEnabled();
    await connect.click();
    await expect(page.getByText('Your prepared hotspot sign-in expired.', { exact: false })).toBeVisible();
    await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveCount(0);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    await expect(connect).toBeEnabled();
    await connect.click();
    await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveValue('private-hotspot-password');
    expect(keys).toHaveLength(3);
    expect(keys[2]).not.toBe(keys[0]);
  });
}

test('a legacy deduplicated site list cannot silently choose a physical router', async ({ page }) => {
  let credentialCalls = 0;
  await mock(page, async (route, path) => {
    if (path === '/api/capabilities') { await json(route, { demo: true, paymentMode: 'disabled', paymentCheckout: false, vouchers: true, receiptPairing: true, staffSales: true, deliverySms: false, networkAccess: true, mobileCookies: false }); return true; }
    if (path === '/api/network/sites') { await json(route, { sites: [{ id: siteId, name: 'Ambiguous legacy site', loginUrl: 'https://hotspot.example.test/login' }] }); return true; }
    if (path === '/api/usage') { await json(route, usageSnapshot('0', { queuedBytes: '5000000000' })); return true; }
    if (path === '/api/network/credentials') { credentialCalls++; await json(route, { error: 'unexpected_request' }, 500); return true; }
    return false;
  });
  await open(page); await expect(page.getByRole('alert')).toHaveText('Hotspot locations could not be loaded. Try again to choose where to connect.');
  await expect(page.getByRole('button', { name: 'Retry locations' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Connect to Wi-Fi' })).toHaveCount(0); expect(credentialCalls).toBe(0);
});

for (const pendingNas of [nasId, null] as const) {
  test('same-site hotspots retry the chosen router and block a pending ' + (pendingNas === null ? 'unknown' : 'different') + ' router', async ({ page }) => {
    const points = [accessPoint(nasId, 'Router A'), accessPoint(secondNasId, 'Router B', 'second.example.test')];
    const requests: { siteId: string; nasId: string; requestKey: string }[] = [];
    let pendingElsewhere = false;
    await mock(page, async (route, path) => {
      if (path === '/api/capabilities') { await json(route, { demo: true, paymentMode: 'disabled', paymentCheckout: false, vouchers: true, receiptPairing: true, staffSales: true, deliverySms: false, networkAccess: true, mobileCookies: false }); return true; }
      if (path === '/api/network/sites') { await json(route, { sites: [], accessPoints: points }); return true; }
      if (path === '/api/usage') {
        const snapshot = usageSnapshot('0', { queuedBytes: '5000000000' });
        if (pendingElsewhere) { snapshot.connectivity = 'pending'; snapshot.session = { grantId: entitlementId, entitlementId, siteId, nasId: pendingNas, state: 'pending', connected: false, issuedAt: new Date().toISOString(), deadline: future(), lastAccountingAt: null, reservedBytes: '5000000000', chargedBytes: '0', reservationOutstandingBytes: '5000000000', disconnectRequested: false, accountingStale: false, accountingAnomaly: false }; }
        await json(route, snapshot); return true;
      }
      if (path === '/api/network/credentials') {
        requests.push(route.request().postDataJSON());
        await json(route, requests.length === 1 ? { error: 'network_unavailable' } : { siteId, nasId: secondNasId, username: 'router-b-user', password: 'router-b-password', expiresAt: future(), loginUrl: points[1].loginUrl }, requests.length === 1 ? 503 : 200); return true;
      }
      return false;
    });
    await open(page);
    const choice = page.getByRole('combobox', { name: 'Choose your PasoFi hotspot' });
    const connect = page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true });
    await expect(choice).toHaveValue(''); await expect(connect).toBeDisabled();
    await choice.selectOption(secondNasId); await connect.click();
    await expect(page.getByText('The service is temporarily unavailable.', { exact: false })).toBeVisible();
    await expect(choice).toHaveValue(secondNasId); await connect.click();
    await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveValue('router-b-password');
    expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]); expect(requests[0]).toEqual({ siteId, nasId: secondNasId, requestKey: expect.any(String) });
    pendingElsewhere = true; await page.getByRole('button', { name: 'Check connection', exact: true }).click();
    await expect(page.getByText('Sign-in pending · not confirmed connected', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveCount(0);
    await expect(choice).toBeDisabled(); await expect(connect).toBeDisabled(); await expect(page.getByRole('button', { name: 'Retry connection' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Disconnect this hotspot session' })).toBeEnabled(); expect(requests).toHaveLength(2);
  });
}

for (const mismatch of ['router', 'login URL'] as const) {
  test('credentials for a different ' + mismatch + ' stay hidden and keep the original retry key', async ({ page }) => {
    const points = [accessPoint(nasId, 'Router A'), accessPoint(secondNasId, 'Router B', 'second.example.test')];
    const requests: { siteId: string; nasId: string; requestKey: string }[] = [];
    await mock(page, async (route, path) => {
      if (path === '/api/capabilities') { await json(route, { demo: true, paymentMode: 'disabled', paymentCheckout: false, vouchers: true, receiptPairing: true, staffSales: true, deliverySms: false, networkAccess: true, mobileCookies: false }); return true; }
      if (path === '/api/network/sites') { await json(route, { accessPoints: points }); return true; }
      if (path === '/api/usage') { await json(route, usageSnapshot('0', { queuedBytes: '5000000000' })); return true; }
      if (path === '/api/network/credentials') {
        requests.push(route.request().postDataJSON());
        await json(route, { siteId, nasId: mismatch === 'router' ? nasId : secondNasId, username: 'wrong-user', password: 'wrong-password', expiresAt: future(), loginUrl: mismatch === 'login URL' ? points[0].loginUrl : points[1].loginUrl }); return true;
      }
      return false;
    });
    await open(page); await page.getByRole('combobox', { name: 'Choose your PasoFi hotspot' }).selectOption(secondNasId);
    const connect = page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true }); await connect.click();
    await expect(page.getByText('Connection details could not be verified.', { exact: false })).toBeVisible(); await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveCount(0);
    await connect.click(); await expect(connect).toBeEnabled(); expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
    await expect(page.getByRole('link', { name: /registered hotspot sign-in/ })).toHaveCount(0);
  });
}

const preparedRequestStorage = 'pamofi.networkRequest.v1';
type RecoveryRequest = { siteId: string; nasId: string; requestKey: string };
async function mockNetworkRecovery(page: Page) {
  const points = [accessPoint(nasId, 'Router A'), accessPoint(secondNasId, 'Router B', 'second.example.test')];
  const state = { owner: customerId, pending: false, networkEnabled: true, points, requests: [] as RecoveryRequest[], expiresAt: new Date(Date.now() + 120_000).toISOString() };
  await mock(page, async (route, path) => {
    if (path === '/api/capabilities') { await json(route, { demo: true, paymentMode: 'disabled', paymentCheckout: false, vouchers: true, receiptPairing: true, staffSales: true, deliverySms: false, networkAccess: state.networkEnabled, mobileCookies: false }); return true; }
    if (path === '/api/session') { await json(route, { customerId: state.owner }); return true; }
    if (path === '/api/access') { await json(route, { customerId: state.owner, entitlements: [entitlement()], hasMore: false, nextOffset: null }); return true; }
    if (path === '/api/network/sites') { await json(route, { accessPoints: state.points }); return true; }
    if (path === '/api/usage') {
      const snapshot = usageSnapshot('0', { customerId: state.owner, queuedBytes: '5000000000' });
      if (state.pending) {
        snapshot.connectivity = 'pending';
        snapshot.session = { grantId: entitlementId, entitlementId, siteId, nasId: secondNasId, state: 'pending', connected: false, issuedAt: new Date().toISOString(), deadline: future(), lastAccountingAt: null, reservedBytes: '5000000000', chargedBytes: '0', reservationOutstandingBytes: '5000000000', disconnectRequested: false, accountingStale: false, accountingAnomaly: false };
      }
      await json(route, snapshot); return true;
    }
    if (path === '/api/network/credentials') {
      const input = route.request().postDataJSON() as RecoveryRequest; state.requests.push(input);
      // A pending server reservation allows only its original browser key/NAS.
      if (state.pending && JSON.stringify(input) !== JSON.stringify(state.requests[0])) { await json(route, { error: 'network_unavailable' }, 503); return true; }
      const point = state.points.find(item => item.nasId === input.nasId);
      await json(route, { ...input, username: 'test-only-hotspot-user', password: 'test-only-hotspot-password', expiresAt: state.expiresAt, loginUrl: point!.loginUrl });
      return true;
    }
    return false;
  });
  return state;
}
async function prepareRecoveryRequest(page: Page) {
  await page.getByRole('combobox', { name: 'Choose your PasoFi hotspot' }).selectOption(secondNasId);
  await page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true }).click();
  await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveValue('test-only-hotspot-password');
}
for (const transition of ['page reload', 'workspace remount'] as const) {
  test('pending hotspot preparation survives ' + transition + ' with its original router request', async ({ page }) => {
    const state = await mockNetworkRecovery(page); await open(page); await prepareRecoveryRequest(page);
    state.pending = true; await page.getByRole('button', { name: 'Check connection', exact: true }).click();
    await expect(page.getByText('Sign-in pending · not confirmed connected', { exact: true })).toBeVisible();
    if (transition === 'page reload') await page.reload();
    else await page.getByRole('button', { name: 'Close customer workspace' }).click();
    await page.getByRole('button', { name: 'Customer tools' }).click();
    await expect(page.getByRole('combobox', { name: 'Choose your PasoFi hotspot' })).toHaveValue(secondNasId);
    const retry = page.getByRole('button', { name: 'Retry connection', exact: true }); await expect(retry).toBeEnabled(); await retry.click();
    await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveValue('test-only-hotspot-password');
    expect(state.requests).toHaveLength(2); expect(state.requests[1]).toEqual(state.requests[0]);
    const stored = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), preparedRequestStorage);
    expect(stored).toEqual({ customerId, siteId, nasId: secondNasId, key: state.requests[0].requestKey, expiresAt: expect.any(Number) });
    expect(stored.expiresAt).toBeLessThanOrEqual(Date.parse(state.expiresAt));
    expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toMatch(/test-only-hotspot-(user|password)/);
  });
}

test('a finished hotspot grant clears its prepared password and request key', async ({ page }) => {
  const state = await mockNetworkRecovery(page);
  await open(page);
  await prepareRecoveryRequest(page);
  state.pending = true;
  const refresh = page.getByRole('button', { name: 'Check connection', exact: true });
  await refresh.click();
  await expect(page.getByText('Sign-in pending · not confirmed connected', { exact: true })).toBeVisible();
  state.pending = false;
  await refresh.click();
  await expect(page.getByText('No active hotspot session', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(key => sessionStorage.getItem(key), preparedRequestStorage)).toBeNull();
  expect(state.requests).toHaveLength(1);
});

for (const invalid of ['malformed', 'expired', 'future expiry', 'different owner', 'invalid key', 'extra credential'] as const) {
  test('invalid saved hotspot preparation: ' + invalid, async ({ page }) => {
    const state = await mockNetworkRecovery(page); state.pending = true;
    const saved: Record<string, unknown> = { customerId, siteId: siteId, nasId: secondNasId, key: '44444444-4444-4444-8444-444444444444', expiresAt: Date.now() + 120_000 };
    if (invalid === 'expired') saved.expiresAt = Date.now() - 1;
    if (invalid === 'future expiry') saved.expiresAt = Date.now() + 300_000;
    if (invalid === 'different owner') saved.customerId = '99999999-9999-4999-8999-999999999999';
    if (invalid === 'invalid key') saved.key = 'invalid';
    if (invalid === 'extra credential') saved.password = 'test-only-forbidden-field';
    await page.addInitScript(({ key, value }) => sessionStorage.setItem(key, value), { key: preparedRequestStorage, value: invalid === 'malformed' ? '{invalid-json' : JSON.stringify(saved) });
    await open(page);
    await expect(page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), preparedRequestStorage)).toBeNull();
    expect(state.requests).toHaveLength(0);
  });
}
for (const change of ['removed router', 'changed site', 'paused network'] as const) {
  test('restored hotspot preparation respects a ' + change, async ({ page }) => {
    const state = await mockNetworkRecovery(page); await open(page); await prepareRecoveryRequest(page);
    state.pending = true;
    if (change === 'removed router') state.points = state.points.filter(point => point.nasId !== secondNasId);
    if (change === 'changed site') state.points = state.points.map(point => point.nasId === secondNasId ? { ...point, siteId: '99999999-9999-4999-8999-999999999999' } : point);
    if (change === 'paused network') state.networkEnabled = false;
    await page.reload(); await page.getByRole('button', { name: 'Customer tools' }).click();
    await expect(page.getByText('Sign-in pending · not confirmed connected', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);
    if (change === 'paused network') await expect(page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true })).toHaveCount(0);
    else await expect(page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), preparedRequestStorage)).toBeNull();
    expect(state.requests).toHaveLength(1);
  });
}
for (const change of ['signed_out', 'recovered'] as const) {
  test('saved hotspot preparation is cleared after ' + change + ' and cannot follow another customer', async ({ page }) => {
    const state = await mockNetworkRecovery(page); await open(page); await prepareRecoveryRequest(page);
    const firstKey = state.requests[0].requestKey;
    state.owner = '99999999-9999-4999-8999-999999999999';
    await page.evaluate(change => { const channel = new BroadcastChannel('pamofi.session'); channel.postMessage(change); channel.close(); }, change);
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), preparedRequestStorage)).toBeNull();
    await page.getByRole('button', { name: 'Customer tools' }).click();
    await expect(page.getByRole('combobox', { name: 'Choose your PasoFi hotspot' })).toHaveValue('');
    await prepareRecoveryRequest(page);
    expect(state.requests).toHaveLength(2); expect(state.requests[1].requestKey).not.toBe(firstKey);
    expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!).customerId, preparedRequestStorage)).toBe(state.owner);
  });
}
test('hotspot preparation handles unavailable tab storage without issuing a replacement for a pending session', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new DOMException('Storage unavailable', 'SecurityError'); } }); });
  const state = await mockNetworkRecovery(page); await open(page); await prepareRecoveryRequest(page);
  await page.getByRole('button', { name: 'Hide connection details' }).click();
  state.pending = true; await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveValue('test-only-hotspot-password');
  expect(state.requests).toHaveLength(2); expect(state.requests[1]).toEqual(state.requests[0]);
  await page.reload(); await page.getByRole('button', { name: 'Customer tools' }).click();
  await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true })).toBeDisabled();
  expect(state.requests).toHaveLength(2);
});
