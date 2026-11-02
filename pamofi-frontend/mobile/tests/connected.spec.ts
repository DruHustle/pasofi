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
async function open(page: Page, origin: string) { await page.goto(origin); await page.getByRole('button', { name: 'My PamoFi', exact: true }).click(); }

test('a configured HTTPS gateway still fails closed until native cookie access is qualified', async ({ page, configuredBaseURL }) => {
  const requested: string[] = [];
  await mock(page, async (_route, path, _method, reply) => { requested.push(path); if (path === '/api/capabilities') { await reply({ ...capabilities, mobileCookies: false }); return true; } return false; });
  await open(page, configuredBaseURL); await expect(page.getByText('Mobile account access is not enabled', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: 'Use a voucher' })).toHaveCount(0); expect(requested.length).toBeGreaterThan(0); expect(new Set(requested)).toEqual(new Set(['/api/capabilities'])); await page.getByRole('button', { name: '← Offline preview' }).click(); await expect(page.getByRole('button', { name: /Explore bundles/ })).toBeVisible();
});

test('qualified mobile API session and voucher redemption use credentialed HTTPS and remain disconnected', async ({ page, configuredBaseURL }, testInfo) => {
  let hasSession = false, redeemed = false;
  await page.addInitScript(() => { const original = window.fetch; (window as any).apiTransport = []; window.fetch = (input, init) => { if (String(input).startsWith('https://api.pamofi.test')) (window as any).apiTransport.push({ credentials: init?.credentials, mode: init?.mode, redirect: init?.redirect }); return original(input, init); }; });
  await mock(page, async (route, path, method, reply) => {
    if (path === '/api/session') { if (method === 'POST') { expect(route.request().headers()['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{43}$/); hasSession = true; } await reply(hasSession ? { customerId } : { error: 'not_authenticated' }, hasSession ? 200 : 401); return true; }
    if (path === '/api/vouchers/redeem') { expect(route.request().postDataJSON()).toEqual({ code: 'DEMOVOUCHER234567' }); redeemed = true; await reply({ entitlementId, replayed: false }); return true; }
    if (path === '/api/usage') { await reply(usageSnapshot('0', { allowanceBytes: redeemed ? '5000000000' : '0', queuedBytes: redeemed ? '5000000000' : '0', entitlementId })); return true; }
    if (path === '/api/access') { await reply({ entitlements: redeemed ? [{ id: entitlementId, bundle_id: 'flex', byte_limit: '5000000000', consumed_bytes: '0', validity_seconds: 604800, activated_at: null, revoked_at: null, start_by: new Date(Date.now() + 86400000).toISOString() }] : [], hasMore: false, nextOffset: null }); return true; }
    return false;
  });
  await page.setViewportSize({ width: 360, height: 850 }); await open(page, configuredBaseURL); await page.getByRole('button', { name: 'Use a voucher', exact: true }).click(); await page.getByLabel('Voucher code', { exact: true }).fill('DEMO-VOUCHER-234567'); await page.getByRole('button', { name: 'Redeem voucher', exact: true }).click(); await expect(page.getByText('Queued · not connected', { exact: true })).toBeVisible(); await expect(page.getByText('Hotspot sign-in is not enabled', { exact: false })).toBeVisible();
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
  await open(page, configuredBaseURL); await page.getByRole('button', { name: 'Buy a bundle', exact: true }).click(); await page.getByRole('checkbox', { name: /reviewed the price/ }).check(); await page.getByRole('button', { name: 'Prepare checkout' }).click(); await expect(page.getByText('Simulation checkout prepared.', { exact: false })).toBeVisible(); await page.getByRole('button', { name: 'Close an expired unused quote' }).click(); await expect(page.getByText('A payment attempt already exists for this order.', { exact: false })).toBeVisible(); expect(closures).toBe(1); expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.endsWith(':purchase-details')).length)).toBe(1); await expect(page.getByRole('combobox', { name: 'Purchase site', exact: true })).toBeDisabled(); await expect(page.getByRole('button', { name: 'Review a fresh quote' })).toHaveCount(0);
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
