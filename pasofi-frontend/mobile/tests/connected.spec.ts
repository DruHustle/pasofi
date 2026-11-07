import { test as base, expect, type Page, type Route } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { usageSnapshot } from './usage-fixture';

const apiOrigin = 'https://api.pamofi.test';
const customerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const entitlementId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const capabilities = { demo: true, paymentMode: 'disabled', paymentCheckout: false, vouchers: true, receiptPairing: true, staffSales: false, deliverySms: false, networkAccess: false, mobileCookies: true };
const test = base.extend<{}, { configuredBaseURL: string }>({
  configuredBaseURL: [async ({}, use) => {
    const port = await new Promise<number>((resolve, reject) => { const socket = createServer(); socket.once('error', reject); socket.listen(0, '127.0.0.1', () => { const address = socket.address(); if (!address || typeof address === 'string') return reject(Error('No loopback address')); const port = address.port; socket.close(error => error ? reject(error) : resolve(port)); }); });
    const directory = fileURLToPath(new URL('../', import.meta.url));
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: directory, env: { ...process.env, VITE_PAMOFI_API_BASE_URL: apiOrigin }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; server.stdout.on('data', data => { output = (output + data).slice(-4000); }); server.stderr.on('data', data => { output = (output + data).slice(-4000); });
    const origin = `http://127.0.0.1:${port}`;
    try {
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) { if (server.exitCode !== null) throw Error(`Configured mobile preview exited: ${output}`); try { const response = await fetch(origin); if (response.ok) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
      if (!ready) throw Error(`Configured mobile preview was not ready: ${output}`);
      await use(origin);
    } finally { server.kill('SIGTERM'); await new Promise<void>(resolve => { if (server.exitCode !== null) return resolve(); const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000); server.once('exit', () => { clearTimeout(timer); resolve(); }); }); }
  }, { scope: 'worker' }],
});
async function mock(page: Page, handle?: (route: Route, path: string, method: string, reply: (body: unknown, status?: number) => Promise<void>) => Promise<boolean>) {
  await page.route(`${apiOrigin}/api/**`, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const headers = { 'Access-Control-Allow-Origin': request.headers().origin || '*', 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Content-Type,Idempotency-Key', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' };
    const reply = (body: unknown, status = 200) => route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body && typeof body === 'object' && 'entitlements' in body ? { customerId, ...body } : body) });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (await handle?.(route, path, request.method(), reply)) return;
    if (path === '/api/capabilities') return reply(capabilities);
    if (path === '/api/sites') return reply({ sites: [] });
    if (path === '/api/bundles') return reply({ products: [{ id: 'flex', price_minor: 100, currency: 'USD', byte_limit: '5000000000', validity_seconds: 604800 }] });
    if (path === '/api/session') return reply({ customerId });
    if (path === '/api/usage') return reply(usageSnapshot('0', { allowanceBytes: '0' }));
    if (path === '/api/access') return reply({ entitlements: [], hasMore: false, nextOffset: null });
    return reply({ error: 'unexpected_request' }, 500);
  });
}
async function open(page: Page, origin: string) { await page.goto(origin); await page.getByRole('button', { name: 'My PasoFi', exact: true }).click(); }

test('a configured HTTPS gateway still fails closed until native cookie access is qualified', async ({ page, configuredBaseURL }) => {
  const requested: string[] = [];
  await mock(page, async (_route, path, _method, reply) => { requested.push(path); if (path === '/api/capabilities') { await reply({ ...capabilities, mobileCookies: false }); return true; } return false; });
  await open(page, configuredBaseURL); await expect(page.getByText('Mobile account access is not enabled', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: 'Use a voucher' })).toHaveCount(0); expect(requested.length).toBeGreaterThan(0); expect(new Set(requested)).toEqual(new Set(['/api/capabilities'])); await page.getByRole('button', { name: '← Offline preview' }).click(); await expect(page.getByRole('button', { name: /Explore bundles/ })).toBeVisible();
});

test('qualified mobile API session and voucher redemption use credentialed HTTPS and remain disconnected', async ({ page, configuredBaseURL }, testInfo) => {
  let hasSession = false, redeemed = false;
  const networkRequests: string[] = [];
  await page.addInitScript(() => { const original = window.fetch; (window as any).apiTransport = []; window.fetch = (input, init) => { if (String(input).startsWith('https://api.pamofi.test')) (window as any).apiTransport.push({ credentials: init?.credentials, mode: init?.mode, redirect: init?.redirect }); return original(input, init); }; });
  await mock(page, async (route, path, method, reply) => {
    if (path.startsWith('/api/network/')) networkRequests.push(`${method} ${path}`);
    if (path === '/api/session') { if (method === 'POST') { expect(route.request().headers()['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{43}$/); hasSession = true; } await reply(hasSession ? { customerId } : { error: 'not_authenticated' }, hasSession ? 200 : 401); return true; }
    if (path === '/api/vouchers/redeem') { expect(route.request().postDataJSON()).toEqual({ code: 'DEMOVOUCHER234567' }); redeemed = true; await reply({ entitlementId, replayed: false }); return true; }
    if (path === '/api/usage') { await reply(usageSnapshot('0', { allowanceBytes: redeemed ? '5000000000' : '0', queuedBytes: redeemed ? '5000000000' : '0', entitlementId })); return true; }
    if (path === '/api/access') { await reply({ entitlements: redeemed ? [{ id: entitlementId, bundle_id: 'flex', byte_limit: '5000000000', consumed_bytes: '0', validity_seconds: 604800, activated_at: null, revoked_at: null, start_by: new Date(Date.now() + 86400000).toISOString() }] : [], hasMore: false, nextOffset: null }); return true; }
    return false;
  });
  await page.setViewportSize({ width: 360, height: 850 }); await open(page, configuredBaseURL); await page.getByRole('button', { name: 'Use a voucher', exact: true }).click(); await page.getByLabel('Voucher code', { exact: true }).fill('DEMO-VOUCHER-234567'); await page.getByRole('button', { name: 'Redeem voucher', exact: true }).click(); await expect(page.getByText('Queued · not connected', { exact: true })).toBeVisible();
  await expect(page.getByText('New hotspot connections are paused.', { exact: false })).toContainText('Ask your PasoFi agent when service is available.');
  await expect(page.getByText('No active hotspot session', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check connection', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: /^(Connect to Wi-Fi|Connect now →|Retry connection)$/ })).toHaveCount(0);
  await expect(page.getByLabel(/^Hotspot (username|password)$/)).toHaveCount(0);
  expect(networkRequests).toEqual([]);
  await expect(page.getByTestId('usage-remaining')).toHaveText('5.000 GB'); await expect(page.getByTestId('usage-queued')).toHaveText('5.000 GB');
  const transports = await page.evaluate(() => (window as any).apiTransport); expect(transports.length).toBeGreaterThan(4); expect(transports.every((request: { credentials: string; mode: string; redirect: string }) => request.credentials === 'include' && request.mode === 'cors' && request.redirect === 'error')).toBe(true); expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('DEMOVOUCHER'); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath('mobile-api-queued-360.png'), fullPage: true });
});

test('a gateway that cannot retain the mobile cookie never redeems a voucher', async ({ page, configuredBaseURL }) => {
  let redemptions = 0;
  await mock(page, async (_route, path, method, reply) => {
    if (path === '/api/session') { await reply(method === 'POST' ? { customerId } : { error: 'not_authenticated' }, method === 'POST' ? 201 : 401); return true; }
    if (path === '/api/vouchers/redeem') { redemptions++; await reply({ entitlementId, replayed: false }); return true; }
    return false;
  });
  await open(page, configuredBaseURL); await page.getByRole('button', { name: 'Use a voucher', exact: true }).click(); await page.getByLabel('Voucher code', { exact: true }).fill('DEMOVOUCHER234567'); await page.getByRole('button', { name: 'Redeem voucher', exact: true }).click(); await expect(page.getByRole('button', { name: 'Redeem voucher', exact: true })).toBeEnabled(); await expect(page.getByText('This browser did not keep the account cookie.', { exact: false })).toBeVisible(); expect(redemptions).toBe(0); await expect(page.getByText('Queued · not connected', { exact: true })).toHaveCount(0);
});

for (const initial of ['hidden details', 'lost response'] as const) {
  test(`expired mobile hotspot credentials recover after ${initial} only after authoritative rejection`, async ({ page, configuredBaseURL }) => {
    const siteId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', nasId = '11111111-1111-4111-8111-111111111111', keys: string[] = [];
    await mock(page, async (route, path, _method, reply) => {
      if (path === '/api/capabilities') { await reply({ ...capabilities, networkAccess: true }); return true; }
      if (path === '/api/network/sites') { await reply({ accessPoints: [{ siteId, nasId, siteName: 'Test site', name: 'Test hotspot', loginUrl: 'https://hotspot.example.test/login' }] }); return true; }
      if (path === '/api/usage') { await reply(usageSnapshot('0', { queuedBytes: '5000000000', entitlementId })); return true; }
      if (path === '/api/network/credentials') {
        keys.push(route.request().postDataJSON().requestKey);
        if (keys.length === 1 && initial === 'lost response') await reply({ error: 'network_unavailable' }, 503);
        else if (keys.length === 2) await reply({ error: 'credential_expired' }, 409);
        else await reply({ siteId, nasId, username: 'private-hotspot-user', password: 'private-hotspot-password', expiresAt: new Date(Date.now() + 120_000).toISOString(), loginUrl: 'https://hotspot.example.test/login' });
        return true;
      }
      return false;
    });
    await open(page, configuredBaseURL);
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

test('gateway failure preserves the useful offline preview and offers retry', async ({ page, configuredBaseURL }) => {
  await page.route(`${apiOrigin}/api/**`, route => route.abort('failed')); await open(page, configuredBaseURL); await expect(page.getByRole('button', { name: 'Retry service connection' })).toBeVisible(); await page.getByRole('button', { name: '← Offline preview' }).click(); await page.getByRole('button', { name: /Explore bundles/ }).click(); await expect(page.getByRole('button', { name: 'View Flex example bundle' })).toBeVisible();
});

test('mobile refuses to discard a saved quote when a provider payment attempt exists', async ({ page, configuredBaseURL }) => {
  const siteId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', orderId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const orderKeys: string[] = []; let closures = 0;
  await mock(page, async (route, path, method, reply) => {
    if (path === '/api/capabilities') { await reply({ ...capabilities, paymentMode: 'mock', paymentCheckout: true }); return true; }
    if (path === '/api/sites') { await reply({ sites: [{ id: siteId, name: 'Configured test site' }] }); return true; }
    if (path === '/api/payments/methods') { await reply({ enabled: true, methods: [{ code: 'mock', name: 'Mock provider', currency: 'USD', minMinor: 1, maxMinor: 100000 }] }); return true; }
    if (path === '/api/orders' && method === 'POST') { orderKeys.push(route.request().headers()['idempotency-key']); await reply({ order: { id: orderId, bundle_id: 'flex', price_minor: 100, currency: 'USD', status: 'awaiting_payment', quote_expires_at: new Date(Date.now() - 60_000).toISOString() } }); return true; }
    if (path === `/api/orders/${orderId}/checkout`) { await reply({ attemptId: entitlementId, state: 'unknown', redirectUrl: null, simulation: true }); return true; }
    if (path === `/api/orders/${orderId}/expire-unused`) { closures++; expect(method).toBe('POST'); expect(route.request().postDataJSON()).toEqual({}); await reply({ error: 'payment_attempt_exists' }, 409); return true; }
    return false;
  });
  await open(page, configuredBaseURL); await page.getByRole('button', { name: 'Online payment', exact: true }).click(); await page.getByRole('checkbox', { name: /reviewed the price/ }).check(); await page.getByRole('button', { name: 'Prepare checkout' }).click(); await expect(page.getByText('Simulation checkout prepared.', { exact: false })).toBeVisible(); await page.getByRole('button', { name: 'Close an expired unused quote' }).click(); await expect(page.getByText('A payment attempt already exists for this order.', { exact: false })).toBeVisible(); expect(closures).toBe(1); expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.endsWith(':purchase-details')).length)).toBe(1); await expect(page.getByRole('combobox', { name: 'Purchase site', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Review a fresh quote' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Retry this checkout safely' }).click(); await expect(page.getByText('Simulation checkout prepared.', { exact: false })).toBeVisible(); expect(orderKeys).toHaveLength(2); expect(new Set(orderKeys).size).toBe(1);
});

test('native bottom navigation preserves an unresolved checkout and its safe retry', async ({ page, configuredBaseURL }) => {
  const siteId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', orderId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const orderKeys: string[] = [];
  await mock(page, async (route, path, method, reply) => {
    if (path === '/api/capabilities') { await reply({ ...capabilities, paymentMode: 'mock', paymentCheckout: true }); return true; }
    if (path === '/api/sites') { await reply({ sites: [{ id: siteId, name: 'Configured test site' }] }); return true; }
    if (path === '/api/payments/methods') { await reply({ enabled: true, methods: [{ code: 'mock', name: 'Mock provider', currency: 'USD', minMinor: 1, maxMinor: 100000 }] }); return true; }
    if (path === '/api/recovery/status') { await reply({ configured: false }); return true; }
    if (path === '/api/orders' && method === 'POST') { orderKeys.push(route.request().headers()['idempotency-key']); await reply({ order: { id: orderId, bundle_id: 'flex', price_minor: 100, currency: 'USD', status: 'awaiting_payment', quote_expires_at: new Date(Date.now() + 60_000).toISOString() } }); return true; }
    if (path === `/api/orders/${orderId}/checkout`) { await reply({ attemptId: entitlementId, state: 'unknown', redirectUrl: null, simulation: true }); return true; }
    return false;
  });
  await page.setViewportSize({ width: 360, height: 780 });
  await open(page, configuredBaseURL);
  const nav = page.getByRole('navigation', { name: 'Account navigation' });
  await nav.getByRole('button', { name: 'Bundles', exact: true }).click();
  await page.getByRole('checkbox', { name: /reviewed the price/ }).check();
  await page.getByRole('button', { name: 'Prepare checkout' }).click();
  await expect(page.getByText('Simulation checkout prepared.', { exact: false })).toBeVisible();
  await nav.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your activity', exact: true })).toBeVisible();
  await nav.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
  await nav.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your internet', exact: true })).toBeVisible();
  await nav.getByRole('button', { name: 'Bundles', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Checkout', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Purchase site', exact: true })).toHaveValue(siteId);
  await expect(page.getByRole('combobox', { name: 'Purchase site', exact: true })).toBeDisabled();
  expect(orderKeys).toHaveLength(1);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.endsWith(':purchase-details')).length)).toBe(1);
  await page.getByRole('button', { name: 'Retry this checkout safely' }).click();
  await expect(page.getByText('Simulation checkout prepared.', { exact: false })).toBeVisible();
  expect(orderKeys).toHaveLength(2);
  expect(new Set(orderKeys).size).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('qualified mobile balance refreshes automatically, pauses offline, and clears when its owner changes', async ({ page, context, configuredBaseURL }, testInfo) => {
  let used = '1000000000', reads = 0, changed = false;
  await page.clock.install(); await mock(page, async (_route, path, _method, reply) => {
    if (path !== '/api/usage') return false; reads++; await reply(usageSnapshot(used, { entitlementId, customerId: changed ? entitlementId : customerId })); return true;
  });
  await page.setViewportSize({ width: 320, height: 900 }); await open(page, configuredBaseURL); await expect(page.getByTestId('usage-remaining')).toHaveText('4.000 GB'); used = '2000000000'; await page.clock.runFor(5_000); await expect(page.getByTestId('usage-remaining')).toHaveText('3.000 GB'); await expect(page.getByTestId('usage-used')).toHaveText('2.000 GB');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); await page.getByTestId('live-usage').screenshot({ path: testInfo.outputPath('mobile-live-usage-320.png') });
  await context.setOffline(true); await expect(page.getByText('Offline · showing the last confirmed balance')).toBeVisible(); const before = reads; used = '3000000000'; await page.clock.runFor(15_000); expect(reads).toBe(before); await expect(page.getByTestId('usage-remaining')).toHaveText('3.000 GB'); await context.setOffline(false); await expect(page.getByTestId('usage-remaining')).toHaveText('2.000 GB');
  changed = true; await page.clock.runFor(5_000); await expect(page.getByTestId('live-usage')).toHaveCount(0); await expect(page.getByText('Your customer session changed or expired.', { exact: false })).toBeVisible(); const stopped = reads; await page.clock.runFor(15_000); expect(reads).toBe(stopped);
});

test('mobile paid invoices stay compact and download over the configured credentialed gateway', async ({ page, configuredBaseURL }, testInfo) => {
  const invoiceId = '11111111-1111-4111-8111-111111111111', saleId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const invoice = { id: invoiceId, number: 'PF-000001', issuedAt: '2026-11-05T12:00:00Z', paidAt: '2026-11-05T12:00:00Z', currency: 'USD', totalMinor: 100, sourceType: 'cash', saleId, orderId: null, simulation: true, requestedChannel: 'email' };
  const transports: { method: string; path: string }[] = [];
  await mock(page, async (route, path, method, reply) => {
    transports.push({ method, path });
    if (path === '/api/capabilities') { await reply({ ...capabilities, invoices: true, invoiceEmail: false, invoiceSms: false }); return true; }
    if (path === '/api/customer/invoices') { await reply({ invoices: [invoice], hasMore: false, nextOffset: null }); return true; }
    if (path === `/api/customer/invoices/${invoiceId}/pdf`) {
      await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': configuredBaseURL, 'Access-Control-Allow-Credentials': 'true' }, contentType: 'application/pdf', body: '%PDF-1.4\n%%EOF' }); return true;
    }
    return false;
  });
  await page.setViewportSize({ width: 320, height: 844 }); await open(page, configuredBaseURL);
  await page.getByRole('navigation', { name: 'Account navigation' }).getByRole('button', { name: 'History', exact: true }).click();
  const history = page.locator('details.invoice-history'); await expect(history).not.toHaveAttribute('open');
  expect((await history.boundingBox())!.height).toBeLessThan(55);
  expect(transports.filter(item => item.path === '/api/customer/invoices')).toHaveLength(0);
  await history.locator('summary').click(); await expect(history).toContainText('Email requested');
  await expect(history).not.toContainText('Email sent');
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await history.screenshot({ path: testInfo.outputPath(`mobile-invoices-${width}.png`) });
    await page.screenshot({ path: testInfo.outputPath(`mobile-invoices-page-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 320, height: 844 });
  const file = page.waitForEvent('download'); await history.getByRole('button', { name: 'Download invoice PF-000001' }).click();
  expect((await file).suggestedFilename()).toBe('PasoFi-PF-000001.pdf');
  expect(transports.filter(item => item.path.endsWith('/pdf'))).toEqual([{ method: 'GET', path: `/api/customer/invoices/${invoiceId}/pdf` }]);
});

test('native invoice export uses a cache file and system share only on click, then cleans its temporary files', async ({ page, configuredBaseURL }) => {
  const token = 'C'.repeat(43);
  await page.clock.install();
  await page.addInitScript(() => {
    const state = window as any;
    state.androidBridge = {};
    state.invoiceNativeCalls = [];
    const expired = `${Date.now() - 700_000}-11111111-1111-4111-8111-111111111111-PasoFi-old.pdf`;
    const files = new Set([expired, 'unrelated-cache-file.txt']);
    state.Capacitor = {
      PluginHeaders: [
        { name: 'Filesystem', methods: ['readdir', 'writeFile', 'getUri', 'deleteFile'].map(name => ({ name, rtype: 'promise' })) },
        { name: 'Share', methods: ['canShare', 'share'].map(name => ({ name, rtype: 'promise' })) },
      ],
      nativePromise: async (plugin: string, method: string, options: any) => {
        state.invoiceNativeCalls.push({ plugin, method, options });
        if (plugin === 'Filesystem') {
          if (method === 'readdir') return { files: [...files].map(name => ({ name, type: 'file', size: 100, mtime: 0 })) };
          if (method === 'writeFile') { files.add(options.path.split('/').pop()); return { uri: `file:///cache/${options.path}` }; }
          if (method === 'getUri') return { uri: `file:///cache/${options.path}` };
          if (method === 'deleteFile') { files.delete(options.path.split('/').pop()); return {}; }
        }
        if (plugin === 'Share' && method === 'canShare') return { value: true };
        if (plugin === 'Share' && method === 'share') return { activityType: 'example.save' };
        throw new Error('Unexpected native call');
      },
    };
  });
  await mock(page, async (route, path, method) => {
    if (path === '/api/invoice-downloads') {
      expect(method).toBe('POST'); expect(route.request().postDataJSON()).toEqual({ token });
      await route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': configuredBaseURL, 'Access-Control-Allow-Credentials': 'true' }, contentType: 'application/pdf', body: '%PDF-1.4\n%%EOF' }); return true;
    }
    return false;
  });
  await page.goto(`${configuredBaseURL}/#invoice=${token}`);
  const link = page.getByRole('region', { name: 'Private invoice link' }); await expect(link).toBeVisible();
  await expect(page).not.toHaveURL(/invoice=/);
  expect(await page.evaluate(() => (window as any).invoiceNativeCalls.filter((call: any) => call.method === 'writeFile' || call.method === 'share'))).toEqual([]);
  await link.getByRole('button', { name: 'Save or share PDF', exact: true }).click();
  await expect(link).toContainText('PDF opened in your device’s share controls.');
  const calls = await page.evaluate(() => (window as any).invoiceNativeCalls);
  const write = calls.find((call: any) => call.method === 'writeFile');
  expect(write.options.directory).toBe('CACHE'); expect(write.options.path).toMatch(/^pasofi-invoice-exports\/\d+-[0-9a-f-]+-PasoFi-paid-invoice\.pdf$/);
  expect(write.options.data).toMatch(/^JVBERi0/); expect(write.options.encoding).toBeUndefined();
  const share = calls.find((call: any) => call.method === 'share'); expect(share.options.files).toEqual([`file:///cache/${write.options.path}`]);
  expect(JSON.stringify(share.options)).not.toContain(token);
  expect(calls.filter((call: any) => call.method === 'deleteFile').every((call: any) => !call.options.path.includes('unrelated-cache-file'))).toBe(true);
  expect(calls.filter((call: any) => call.method === 'deleteFile' && call.options.path === write.options.path)).toHaveLength(0);
  await page.clock.fastForward(600_001);
  await expect.poll(() => page.evaluate(path => (window as any).invoiceNativeCalls.filter((call: any) => call.method === 'deleteFile' && call.options.path === path).length, write.options.path)).toBe(1);
});

for (const pendingContext of ['different', 'unknown'] as const) {
  test('mobile retries the chosen same-site router and blocks a pending ' + pendingContext + ' router', async ({ page, configuredBaseURL }) => {
    const siteId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', firstNas = '11111111-1111-4111-8111-111111111111', secondNas = '22222222-2222-4222-8222-222222222222';
    const points = [{ siteId, nasId: firstNas, siteName: 'Test site', name: 'Router A', loginUrl: 'https://first.example.test/login' }, { siteId, nasId: secondNas, siteName: 'Test site', name: 'Router B', loginUrl: 'https://second.example.test/login' }];
    const requests: { siteId: string; nasId: string; requestKey: string }[] = [];
    let pendingElsewhere = false;
    await mock(page, async (route, path, _method, reply) => {
      if (path === '/api/capabilities') { await reply({ ...capabilities, networkAccess: true }); return true; }
      if (path === '/api/network/sites') { await reply({ sites: [], accessPoints: points }); return true; }
      if (path === '/api/usage') {
        const snapshot = usageSnapshot('0', { queuedBytes: '5000000000', entitlementId });
        if (pendingElsewhere) { snapshot.connectivity = 'pending'; snapshot.session = { grantId: entitlementId, entitlementId, siteId, nasId: pendingContext === 'unknown' ? null : firstNas, state: 'pending', connected: false, issuedAt: new Date().toISOString(), deadline: new Date(Date.now() + 120_000).toISOString(), lastAccountingAt: null, reservedBytes: '5000000000', chargedBytes: '0', reservationOutstandingBytes: '5000000000', disconnectRequested: false, accountingStale: false, accountingAnomaly: false }; }
        await reply(snapshot); return true;
      }
      if (path === '/api/network/credentials') {
        requests.push(route.request().postDataJSON());
        await reply(requests.length === 1 ? { error: 'network_unavailable' } : { siteId, nasId: secondNas, username: 'mobile-router-b-user', password: 'mobile-router-b-password', expiresAt: new Date(Date.now() + 120_000).toISOString(), loginUrl: points[1].loginUrl }, requests.length === 1 ? 503 : 200); return true;
      }
      return false;
    });
    await open(page, configuredBaseURL);
    const choice = page.getByRole('combobox', { name: 'Choose your PasoFi hotspot' });
    const connect = page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true });
    await expect(choice).toHaveValue(''); await expect(connect).toBeDisabled();
    await choice.selectOption(secondNas); await connect.click(); await expect(page.getByText('The service is temporarily unavailable.', { exact: false })).toBeVisible();
    await expect(choice).toHaveValue(secondNas); await connect.click(); await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveValue('mobile-router-b-password');
    expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]); expect(requests[0]).toEqual({ siteId, nasId: secondNas, requestKey: expect.any(String) });
    await page.getByRole('button', { name: 'Hide connection details' }).click(); pendingElsewhere = true;
    await page.getByRole('button', { name: 'Check connection', exact: true }).click(); await expect(page.getByText('Sign-in pending · not confirmed connected', { exact: true })).toBeVisible();
    await expect(choice).toBeDisabled(); await expect(connect).toBeDisabled(); await expect(page.getByRole('button', { name: 'Retry connection' })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Disconnect this hotspot session' })).toBeEnabled(); expect(requests).toHaveLength(2);
  });
}

test('mobile hides credentials returned for another router and keeps the selected request intact', async ({ page, configuredBaseURL }) => {
  const siteId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', firstNas = '11111111-1111-4111-8111-111111111111', secondNas = '22222222-2222-4222-8222-222222222222';
  const points = [{ siteId, nasId: firstNas, siteName: 'Test site', name: 'Router A', loginUrl: 'https://first.example.test/login' }, { siteId, nasId: secondNas, siteName: 'Test site', name: 'Router B', loginUrl: 'https://second.example.test/login' }];
  const requests: { siteId: string; nasId: string; requestKey: string }[] = [];
  await mock(page, async (route, path, _method, reply) => {
    if (path === '/api/capabilities') { await reply({ ...capabilities, networkAccess: true }); return true; }
    if (path === '/api/network/sites') { await reply({ accessPoints: points }); return true; }
    if (path === '/api/usage') { await reply(usageSnapshot('0', { queuedBytes: '5000000000', entitlementId })); return true; }
    if (path === '/api/network/credentials') { requests.push(route.request().postDataJSON()); await reply({ siteId, nasId: firstNas, username: 'wrong-user', password: 'wrong-password', expiresAt: new Date(Date.now() + 120_000).toISOString(), loginUrl: points[1].loginUrl }); return true; }
    return false;
  });
  await open(page, configuredBaseURL); await page.getByRole('combobox', { name: 'Choose your PasoFi hotspot' }).selectOption(secondNas);
  const connect = page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true }); await connect.click();
  await expect(page.getByText('Connection details could not be verified.', { exact: false })).toBeVisible(); await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveCount(0);
  await connect.click(); await expect(connect).toBeEnabled(); expect(requests).toHaveLength(2); expect(requests[0]).toEqual(requests[1]);
  await expect(page.getByRole('link', { name: /registered hotspot sign-in/ })).toHaveCount(0);
});

const preparedRequestStorage = 'pamofi.networkRequest.v1';
const recoverySiteId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const recoveryNasId = '22222222-2222-4222-8222-222222222222';
type RecoveryRequest = { siteId: string; nasId: string; requestKey: string };
async function mockNetworkRecovery(page: Page) {
  const points = [{ siteId: recoverySiteId, nasId: '11111111-1111-4111-8111-111111111111', siteName: 'Test site', name: 'Router A', loginUrl: 'https://first.example.test/login' }, { siteId: recoverySiteId, nasId: recoveryNasId, siteName: 'Test site', name: 'Router B', loginUrl: 'https://second.example.test/login' }];
  const state = { owner: customerId, pending: false, networkEnabled: true, points, requests: [] as RecoveryRequest[], expiresAt: new Date(Date.now() + 120_000).toISOString() };
  await mock(page, async (route, path, _method, reply) => {
    if (path === '/api/capabilities') { await reply({ ...capabilities, networkAccess: state.networkEnabled }); return true; }
    if (path === '/api/session') { await reply({ customerId: state.owner }); return true; }
    if (path === '/api/access') { await reply({ customerId: state.owner, entitlements: [], hasMore: false, nextOffset: null }); return true; }
    if (path === '/api/network/sites') { await reply({ accessPoints: state.points }); return true; }
    if (path === '/api/usage') {
      const snapshot = usageSnapshot('0', { customerId: state.owner, queuedBytes: '5000000000', entitlementId });
      if (state.pending) {
        snapshot.connectivity = 'pending';
        snapshot.session = { grantId: entitlementId, entitlementId, siteId: recoverySiteId, nasId: recoveryNasId, state: 'pending', connected: false, issuedAt: new Date().toISOString(), deadline: new Date(Date.now() + 86400_000).toISOString(), lastAccountingAt: null, reservedBytes: '5000000000', chargedBytes: '0', reservationOutstandingBytes: '5000000000', disconnectRequested: false, accountingStale: false, accountingAnomaly: false };
      }
      await reply(snapshot); return true;
    }
    if (path === '/api/network/credentials') {
      const input = route.request().postDataJSON() as RecoveryRequest; state.requests.push(input);
      // A pending server reservation allows only its original browser key/NAS.
      if (state.pending && JSON.stringify(input) !== JSON.stringify(state.requests[0])) { await reply({ error: 'network_unavailable' }, 503); return true; }
      const point = state.points.find(item => item.nasId === input.nasId);
      await reply({ ...input, username: 'test-only-hotspot-user', password: 'test-only-hotspot-password', expiresAt: state.expiresAt, loginUrl: point!.loginUrl });
      return true;
    }
    return false;
  });
  return state;
}
async function prepareRecoveryRequest(page: Page) {
  await page.getByRole('combobox', { name: 'Choose your PasoFi hotspot' }).selectOption(recoveryNasId);
  await page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true }).click();
  await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveValue('test-only-hotspot-password');
}
for (const transition of ['page reload', 'workspace remount'] as const) {
  test('mobile pending hotspot preparation survives ' + transition + ' with its original router request', async ({ page, configuredBaseURL }) => {
    const state = await mockNetworkRecovery(page); await open(page, configuredBaseURL); await prepareRecoveryRequest(page);
    state.pending = true; await page.getByRole('button', { name: 'Check connection', exact: true }).click();
    await expect(page.getByText('Sign-in pending · not confirmed connected', { exact: true })).toBeVisible();
    if (transition === 'page reload') await page.reload();
    else await page.getByRole('button', { name: 'Close customer workspace' }).click();
    await page.getByRole('button', { name: 'My PasoFi', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Choose your PasoFi hotspot' })).toHaveValue(recoveryNasId);
    const retry = page.getByRole('button', { name: 'Retry connection', exact: true }); await expect(retry).toBeEnabled(); await retry.click();
    await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveValue('test-only-hotspot-password');
    expect(state.requests).toHaveLength(2); expect(state.requests[1]).toEqual(state.requests[0]);
    const stored = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), preparedRequestStorage);
    expect(stored).toEqual({ customerId, siteId: recoverySiteId, nasId: recoveryNasId, key: state.requests[0].requestKey, expiresAt: expect.any(Number) });
    expect(stored.expiresAt).toBeLessThanOrEqual(Date.parse(state.expiresAt));
    expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toMatch(/test-only-hotspot-(user|password)/);
  });
}

for (const invalid of ['malformed', 'expired', 'future expiry', 'different owner', 'invalid key', 'extra credential'] as const) {
  test('mobile invalid saved hotspot preparation: ' + invalid, async ({ page, configuredBaseURL }) => {
    const state = await mockNetworkRecovery(page); state.pending = true;
    const saved: Record<string, unknown> = { customerId, siteId: recoverySiteId, nasId: recoveryNasId, key: '44444444-4444-4444-8444-444444444444', expiresAt: Date.now() + 120_000 };
    if (invalid === 'expired') saved.expiresAt = Date.now() - 1;
    if (invalid === 'future expiry') saved.expiresAt = Date.now() + 300_000;
    if (invalid === 'different owner') saved.customerId = '99999999-9999-4999-8999-999999999999';
    if (invalid === 'invalid key') saved.key = 'invalid';
    if (invalid === 'extra credential') saved.password = 'test-only-forbidden-field';
    await page.addInitScript(({ key, value }) => sessionStorage.setItem(key, value), { key: preparedRequestStorage, value: invalid === 'malformed' ? '{invalid-json' : JSON.stringify(saved) });
    await open(page, configuredBaseURL);
    await expect(page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), preparedRequestStorage)).toBeNull();
    expect(state.requests).toHaveLength(0);
  });
}
for (const change of ['removed router', 'changed site', 'paused network'] as const) {
  test('mobile restored hotspot preparation respects a ' + change, async ({ page, configuredBaseURL }) => {
    const state = await mockNetworkRecovery(page); await open(page, configuredBaseURL); await prepareRecoveryRequest(page);
    state.pending = true;
    if (change === 'removed router') state.points = state.points.filter(point => point.nasId !== recoveryNasId);
    if (change === 'changed site') state.points = state.points.map(point => point.nasId === recoveryNasId ? { ...point, siteId: '99999999-9999-4999-8999-999999999999' } : point);
    if (change === 'paused network') state.networkEnabled = false;
    await page.reload(); await page.getByRole('button', { name: 'My PasoFi', exact: true }).click();
    await expect(page.getByText('Sign-in pending · not confirmed connected', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);
    if (change === 'paused network') await expect(page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true })).toHaveCount(0);
    else await expect(page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), preparedRequestStorage)).toBeNull();
    expect(state.requests).toHaveLength(1);
  });
}
for (const change of ['signed_out', 'recovered'] as const) {
  test('mobile saved hotspot preparation is cleared after ' + change + ' and cannot follow another customer', async ({ page, configuredBaseURL }) => {
    const state = await mockNetworkRecovery(page); await open(page, configuredBaseURL); await prepareRecoveryRequest(page);
    const firstKey = state.requests[0].requestKey;
    state.owner = '99999999-9999-4999-8999-999999999999';
    await page.evaluate(change => { const channel = new BroadcastChannel('pamofi.session'); channel.postMessage(change); channel.close(); }, change);
    await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), preparedRequestStorage)).toBeNull();
    await page.getByRole('button', { name: 'Retry service connection', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Choose your PasoFi hotspot' })).toHaveValue('');
    await prepareRecoveryRequest(page);
    expect(state.requests).toHaveLength(2); expect(state.requests[1].requestKey).not.toBe(firstKey);
    expect(await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!).customerId, preparedRequestStorage)).toBe(state.owner);
  });
}
test('mobile hotspot preparation handles unavailable tab storage without issuing a replacement for a pending session', async ({ page, configuredBaseURL }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'sessionStorage', { configurable: true, get() { throw new DOMException('Storage unavailable', 'SecurityError'); } }); });
  const state = await mockNetworkRecovery(page); await open(page, configuredBaseURL); await prepareRecoveryRequest(page);
  await page.getByRole('button', { name: 'Hide connection details' }).click();
  state.pending = true; await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await expect(page.getByLabel('Hotspot password', { exact: true })).toHaveValue('test-only-hotspot-password');
  expect(state.requests).toHaveLength(2); expect(state.requests[1]).toEqual(state.requests[0]);
  await page.reload(); await page.getByRole('button', { name: 'My PasoFi', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry connection', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect to Wi-Fi', exact: true })).toBeDisabled();
  expect(state.requests).toHaveLength(2);
});
