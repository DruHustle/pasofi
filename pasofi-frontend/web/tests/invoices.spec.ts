import { test, expect, type Page, type Route } from '@playwright/test';
import { defaultInvoiceDelivery, invoiceDeliveryError, invoiceDeliveryPayload, invoiceFilename, invoiceStatusText, parseInvoicePage } from '../src/invoice-delivery';
import { usageSnapshot } from './usage-fixture';

const customerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', staffId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const siteId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', saleId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const orderId = 'ffffffff-ffff-4fff-8fff-ffffffffffff', invoiceId = '11111111-1111-4111-8111-111111111111';
const future = () => new Date(Date.now() + 900_000).toISOString();
const product = { id: 'flex', price_minor: 100, currency: 'USD', byte_limit: '10000000000', validity_seconds: 604800 };
const staff = { staffId, email: 'agent@example.invalid', displayName: 'Example agent', status: 'approved', role: 'agent', siteIds: [siteId], version: 1, mfaEnrolled: true, mfaVerified: true };
const capabilities = { demo: true, paymentMode: 'mock', paymentCheckout: true, vouchers: true, receiptPairing: true, staffSales: true, deliverySms: true, networkAccess: false, mobileCookies: false, invoices: true, invoiceEmail: true, invoiceSms: true };
const invoice = { id: invoiceId, number: 'PF-000001', issuedAt: '2026-11-05T12:00:00Z', paidAt: '2026-11-05T12:00:00Z', currency: 'USD', totalMinor: 100, sourceType: 'cash', saleId, orderId: null, simulation: true, requestedChannel: 'email' };
const invoicePage = { invoices: [invoice], hasMore: false, nextOffset: null };
const sale = () => ({ id: saleId, agentId: staffId, siteId, siteName: 'Example site', bundleId: product.id, priceMinor: 100, commissionMinor: 10, commissionBps: 1000, currency: 'USD', byteLimit: product.byte_limit, validitySeconds: product.validity_seconds, soldAt: new Date().toISOString(), startBy: future(), delivery: 'receipt', simulation: true });
const order = () => ({ id: orderId, bundle_id: product.id, purchase_mode: 'checkout', price_minor: 100, currency: 'USD', status: 'awaiting_payment', quote_expires_at: future() });
const pdf = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF';
const json = (route: Route, data: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
async function mock(page: Page, caps = capabilities, handle?: (route: Route, path: string, method: string) => Promise<boolean>) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname, method = route.request().method();
    if (await handle?.(route, path, method)) return;
    if (path === '/api/capabilities') return json(route, caps);
    if (path === '/api/bundles') return json(route, { products: [product], candidate: false });
    if (path === '/api/sites' || path === '/api/staff/sites') return json(route, { sites: [{ id: siteId, name: 'Example site' }] });
    if (path === '/api/help') return json(route, { articles: [] });
    if (path === '/api/session') return json(route, { customerId });
    if (path === '/api/usage') return json(route, usageSnapshot('0', { allowanceBytes: '0' }));
    if (path === '/api/access') return json(route, { customerId, entitlements: [], hasMore: false, nextOffset: null });
    if (path === '/api/staff/session') return json(route, staff);
    if (path === '/api/staff/inventory') return json(route, { inventory: [{ agentId: staffId, siteId, siteName: 'Example site', bundleId: product.id, quantity: 1 }] });
    if (path === '/api/staff/sales') return json(route, { sales: [], hasMore: false, nextOffset: null });
    if (path === '/api/staff/cash-shifts') return json(route, { shifts: [], currencies: ['USD'] });
    if (path === '/api/staff/cash-refunds') return json(route, { refunds: [] });
    if (path === '/api/staff/cash-references/lookup') return json(route, { status: 'pending', expiresAt: future(), quote: { bundleId: product.id, siteId, siteName: 'Example site', priceMinor: product.price_minor, currency: product.currency, byteLimit: product.byte_limit, validitySeconds: product.validity_seconds } });
    if (path === '/api/payments/methods') return json(route, { enabled: true, simulation: true, methods: [{ code: 'mock', name: 'Mock provider', currency: 'USD', minMinor: 1, maxMinor: 100000 }] });
    if (path === '/api/customer/invoices' || path === '/api/staff/invoices') return json(route, invoicePage);
    if (path === `/api/customer/invoices/${invoiceId}/pdf` || path === `/api/staff/invoices/${invoiceId}/pdf`) return route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf });
    return json(route, { error: 'not_available' }, 404);
  });
}
async function customer(page: Page, tab: 'History' | 'Online payment') {
  await page.goto('/'); await page.getByRole('button', { name: 'Customer tools' }).click();
  await page.getByRole('button', { name: tab, exact: true }).click();
}

test('invoice delivery values normalize only new requests and reject invalid invoice evidence', () => {
  expect(defaultInvoiceDelivery(capabilities)).toEqual({ channel: 'email' });
  expect(defaultInvoiceDelivery({ invoices: true, invoiceEmail: false, invoiceSms: true })).toEqual({ channel: 'sms' });
  expect(defaultInvoiceDelivery({ invoices: true, invoiceEmail: false, invoiceSms: false })).toEqual({ channel: 'download' });
  expect(defaultInvoiceDelivery(null)).toEqual({ channel: 'download' });
  const input = { channel: 'email' as const, recipient: ' Customer@EXAMPLE.COM ' };
  expect(invoiceDeliveryPayload(input)).toEqual({ channel: 'email', recipient: 'Customer@example.com' });
  expect(input.recipient).toBe(' Customer@EXAMPLE.COM ');
  expect(invoiceDeliveryPayload({ channel: 'sms', recipient: '077 123 4567' })).toEqual({ channel: 'sms', recipient: '263771234567' });
  expect(invoiceDeliveryPayload({ channel: 'download', recipient: 'discarded@example.com' })).toEqual({ channel: 'download' });
  expect(invoiceDeliveryError({ channel: 'sms', recipient: '+1 555 123 4567' })).not.toBeNull();
  expect(invoiceDeliveryError({ channel: 'email', recipient: 'not-an-address' })).not.toBeNull();
  expect(invoiceDeliveryError({ channel: 'email', recipient: 'a..b@example.com' })).not.toBeNull();
  expect(invoiceDeliveryError({ channel: 'email', recipient: 'a@-example.com' })).not.toBeNull();
  expect(parseInvoicePage(invoicePage).invoices[0].number).toBe('PF-000001');
  expect(() => parseInvoicePage({ ...invoicePage, invoices: [{ ...invoice, id: '../../private' }] })).toThrow();
  expect(() => parseInvoicePage({ ...invoicePage, invoices: [{ ...invoice, totalMinor: 1.1 }] })).toThrow();
  expect(() => parseInvoicePage({ ...invoicePage, hasMore: true, nextOffset: null })).toThrow();
  expect(invoiceFilename('../../private?token=secret')).not.toContain('/');
  expect(invoiceStatusText('email', { state: 'submitted' })).toBe('Email submitted. Delivery is not confirmed.');
  expect(invoiceStatusText('email', { state: 'delivered' })).toContain('unavailable');
  expect(invoiceStatusText('email', { state: 'delivered', deliveredAt: '2026-11-05T12:00:00Z' })).toBe('Mail server confirmed delivery.');
  expect(invoiceStatusText('sms', { state: 'delivered', deliveredAt: '2026-11-05T12:00:00Z', channel: 'email' })).toContain('unavailable');
});

test('a customer with fresh browser storage can redeem an outstanding paid voucher from invoice history', async ({page}) => {
  const pairingId = '22222222-2222-4222-8222-222222222222';
  const code = 'PRIVATEVOUCHER234567';
  let redemptionCount = 0;
  await mock(page, capabilities, async (route, path) => {
    if (path === '/api/customer/invoices') {
      await json(route, {...invoicePage, invoices: [{...invoice, pairingId}]}); return true;
    }
    if (path === `/api/receipt-pairings/${pairingId}`) {
      await json(route, {status: 'ready', receipt: {sale: sale(), voucher: {id: saleId, code, state: 'valid'}}}); return true;
    }
    if (path === '/api/vouchers/redeem') {
      expect(route.request().postDataJSON()).toEqual({code});
      redemptionCount++;
      await json(route, {entitlementId: saleId, replayed: false}); return true;
    }
    return false;
  });
  await customer(page, 'History');
  await page.locator('.invoice-history summary').click();
  await page.getByRole('button', {name: 'Redeem paid voucher'}).click();
  await expect(page.getByText('Voucher redeemed.', {exact:false})).toBeVisible();
  expect(redemptionCount).toBe(1);
  expect(await page.evaluate(() => JSON.stringify({...sessionStorage}))).not.toContain(code);
});

test('cash invoice delivery remains exact across a lost response and a paused email provider', async ({ page }, testInfo) => {
  const writes: { key: string; body: unknown }[] = [];
  await mock(page, capabilities, async (route, path, method) => {
    if (path === '/api/capabilities') { await json(route, { ...capabilities, invoiceEmail: writes.length === 0 }); return true; }
    if (path === '/api/staff/sales') {
      if (method === 'POST') {
        writes.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
        if (writes.length === 1) await route.abort('failed'); else await json(route, { sale: sale(), replayed: true });
      } else await json(route, { sales: writes.length ? [sale()] : [], hasMore: false, nextOffset: null });
      return true;
    }
    return false;
  });
  await page.setViewportSize({ width: 320, height: 844 }); await page.goto('/');
  await page.getByRole('button', { name: 'Staff', exact: true }).click();
  await page.getByLabel('Customer pairing code').fill('ABCD234567');
  await page.getByRole('button', { name: 'Look up cash reference' }).click();
  await expect(page.getByRole('combobox', { name: 'Invoice copy', exact: true })).toHaveValue('email');
  await page.getByLabel('Invoice email', { exact: true }).fill('buyer@EXAMPLE.COM');
  await expect(page.getByText('Reference verified.', { exact: false })).toBeVisible();
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('.invoice-preference').screenshot({ path: testInfo.outputPath(`invoice-preference-${width}.png`) });
    await page.screenshot({ path: testInfo.outputPath(`invoice-sale-page-${width}.png`), fullPage: true });
    expect((await page.locator('.invoice-preference').boundingBox())!.height).toBeLessThan(205);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole('checkbox', { name: /simulated sale/ }).check();
  await page.getByRole('button', { name: 'Confirm demo sale' }).click();
  await expect(page.getByRole('button', { name: 'Retry saved sale safely' })).toBeVisible();
  await expect(page.getByLabel('Invoice email', { exact: true })).toBeDisabled();
  await page.reload(); await page.getByRole('button', { name: 'Staff', exact: true }).click();
  await expect(page.getByLabel('Invoice email', { exact: true })).toHaveValue('buyer@example.com');
  await expect(page.getByRole('combobox', { name: 'Invoice copy', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: /saved sale|simulated sale/ }).check();
  await page.getByRole('button', { name: 'Retry saved sale safely' }).click();
  await expect(page.getByText('The original receipt was recovered', { exact: false })).toBeVisible();
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  expect(writes[0].body).toMatchObject({ invoiceDelivery: { channel: 'email', recipient: 'buyer@example.com' } });
  const file = page.waitForEvent('download');
  await page.getByRole('row').filter({ hasText: saleId }).getByRole('button', { name: 'Invoice PDF', exact: true }).click();
  expect((await file).suggestedFilename()).toBe('Pasofi-PF-000001.pdf');
});

test('checkout preserves the chosen invoice recipient through an unresolved order retry', async ({ page }) => {
  const writes: { key: string; body: unknown }[] = [];
  await mock(page, { ...capabilities, staffSales: false }, async (route, path, method) => {
    if (path === '/api/orders') {
      if (method === 'POST') {
        writes.push({ key: route.request().headers()['idempotency-key'], body: route.request().postDataJSON() });
        if (writes.length === 1) await route.abort('failed'); else await json(route, { order: order() });
      } else await json(route, { customerId, lookupKey: new URL(route.request().url()).searchParams.get('requestKey'), orders: [{ ...order(), purchase_mode: 'checkout' }] });
      return true;
    }
    if (path === `/api/orders/${orderId}/checkout`) { await json(route, { attemptId: saleId, state: 'submitted', redirectUrl: null, simulation: true }); return true; }
    return false;
  });
  await customer(page, 'Online payment');
  await page.getByRole('combobox', { name: 'Invoice copy', exact: true }).selectOption('sms');
  await page.getByLabel('Invoice mobile number', { exact: true }).fill('+263 77 123 4567');
  await page.getByRole('checkbox', { name: /I have reviewed the price/ }).check();
  await page.getByRole('button', { name: 'Prepare checkout', exact: true }).click();
  await expect(page.getByText('Checkout could not be confirmed.', { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Invoice mobile number', { exact: true })).toHaveValue('263771234567');
  await expect(page.getByRole('combobox', { name: 'Invoice copy', exact: true })).toBeDisabled();
  await page.getByRole('checkbox', { name: /I have reviewed the price/ }).check();
  await page.getByRole('button', { name: 'Retry this checkout safely' }).click();
  await expect(page.getByText('Simulation checkout prepared.', { exact: false })).toBeVisible();
  expect(writes).toHaveLength(2); expect(writes[1]).toEqual(writes[0]);
  expect(writes[0].body).toEqual({ bundleId: product.id, mode: 'checkout', invoiceDelivery: { channel: 'sms', recipient: '263771234567' } });
});

test('paid invoice history stays compact and usable while purchase and delivery gates are paused', async ({ page }, testInfo) => {
  let reads = 0, statusReads = 0, delivered = false;
  await mock(page, { ...capabilities, staffSales: false, paymentCheckout: false, deliverySms: false, invoiceEmail: false, invoiceSms: false }, async (route, path) => {
    if (path === '/api/customer/invoices') { reads++; await json(route, invoicePage); return true; }
    if (path === `/api/customer/invoices/${invoiceId}`) { statusReads++; await json(route, { invoice: { ...invoice, delivery: { state: delivered ? 'delivered' : 'submitted', channel: 'email', ...(delivered ? { deliveredAt: '2026-11-05T12:01:00Z' } : {}) } } }); return true; }
    return false;
  });
  await page.setViewportSize({ width: 320, height: 844 }); await customer(page, 'History');
  const history = page.locator('details.invoice-history');
  await expect(history).not.toHaveAttribute('open'); expect(reads).toBe(0);
  expect((await history.boundingBox())!.height).toBeLessThan(55);
  await history.locator('summary').click();
  await expect(history).toContainText('Email requested'); await expect(history).not.toContainText('Email sent');
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    expect((await history.locator('.invoice-list > li').boundingBox())!.height).toBeLessThan(130);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await history.screenshot({ path: testInfo.outputPath(`invoice-history-${width}.png`) });
    await page.screenshot({ path: testInfo.outputPath(`invoice-history-page-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 320, height: 844 });
  expect(statusReads).toBe(0);
  await history.getByRole('button', { name: 'Delivery status for invoice PF-000001' }).click();
  await expect(history).toContainText('Email submitted. Delivery is not confirmed.');
  delivered = true; await history.getByRole('button', { name: 'Delivery status for invoice PF-000001' }).click();
  await expect(history).toContainText('Mail server confirmed delivery.'); await expect(history).toContainText('Confirmed at'); expect(statusReads).toBe(2);
  const file = page.waitForEvent('download'); await history.getByRole('button', { name: 'Download invoice PF-000001' }).click();
  expect((await file).suggestedFilename()).toBe('Pasofi-PF-000001.pdf');
});

test('older deployments hide invoice preferences and missing invoice routes degrade without blocking history', async ({ page }) => {
  let supported = false;
  await mock(page, capabilities, async (route, path) => {
    if (path === '/api/capabilities') { const { invoices, invoiceEmail, invoiceSms, ...legacy } = capabilities; await json(route, supported ? capabilities : legacy); return true; }
    if (path === '/api/customer/invoices') { await json(route, { error: 'not_found' }, 404); return true; }
    return false;
  });
  await customer(page, 'Online payment'); await expect(page.getByRole('combobox', { name: 'Invoice copy', exact: true })).toHaveCount(0);
  supported = true; await customer(page, 'History');
  await page.locator('.invoice-history > summary').click();
  await expect(page.getByText('Invoice PDFs are not available here yet.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bundle history', exact: true })).toBeVisible();
});

test('private SMS links remove the fragment and download only through an explicit token POST', async ({ page }) => {
  const token = 'A'.repeat(43); let requests = 0;
  await mock(page, capabilities, async (route, path, method) => {
    expect(route.request().url()).not.toContain(token);
    if (path === '/api/invoice-downloads') {
      requests++; expect(method).toBe('POST'); expect(route.request().postDataJSON()).toEqual({ token });
      await route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf }); return true;
    }
    return false;
  });
  await page.setViewportSize({ width: 320, height: 844 }); await page.goto(`/#invoice=${token}`);
  const link = page.getByRole('region', { name: 'Private invoice link' }); await expect(link).toBeVisible();
  await expect(page).not.toHaveURL(/invoice=/); expect(requests).toBe(0);
  expect(await page.evaluate(() => [...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes('A'.repeat(43))))).toBe(false);
  const file = page.waitForEvent('download'); await link.getByRole('button', { name: 'Download PDF', exact: true }).click();
  expect((await file).suggestedFilename()).toBe('Pasofi-paid-invoice.pdf'); expect(requests).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('expired invoice links and invalid PDF responses never report a successful download', async ({ page }) => {
  let expired = true;
  await mock(page, capabilities, async (route, path) => {
    if (path === '/api/invoice-downloads') { await json(route, { error: expired ? 'invoice_link_expired' : 'invalid_pdf' }, expired ? 410 : 200); return true; }
    return false;
  });
  await page.goto(`/#invoice=${'B'.repeat(43)}`);
  const link = page.getByRole('region', { name: 'Private invoice link' });
  await link.getByRole('button', { name: 'Download PDF', exact: true }).click();
  await expect(link).toContainText('expired or is unavailable'); await expect(link).not.toContainText('download started');
  expired = false; await link.getByRole('button', { name: 'Download PDF', exact: true }).click();
  await expect(link).toContainText('service is temporarily unavailable'); await expect(link).not.toContainText('download started');
});
