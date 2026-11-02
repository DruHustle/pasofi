import { test, expect, type Page, type Route } from '@playwright/test';
import { usageSnapshot } from './usage-fixture';

const customerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const staffId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const agentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const siteId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const saleId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const orderId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const future = () => new Date(Date.now() + 900_000).toISOString();
const product = { id: 'flex', price_minor: 100, currency: 'USD', byte_limit: '5000000000', validity_seconds: 604800 };
const site = { id: siteId, name: 'Example site' };
const capabilities = { demo: true, paymentMode: 'mock', paymentCheckout: true, vouchers: true, receiptPairing: true, staffSales: true, deliverySms: true, networkAccess: false, mobileCookies: false };
const staff = (role = 'agent', status = 'approved', id = staffId) => ({ staffId: id, email: `${role}@staff.invalid`, displayName: `${role} member`, status, role: status === 'pending' ? null : role, siteIds: role === 'admin' ? [] : [siteId], version: 1, mfaVerified: true, mfaEnrolled: true });
const sale = () => ({ id: saleId, agentId: staffId, siteId, siteName: site.name, bundleId: 'flex', priceMinor: 100, commissionMinor: 10, commissionBps: 1000, currency: 'USD', byteLimit: '5000000000', validitySeconds: 604800, soldAt: new Date().toISOString(), startBy: future(), delivery: 'receipt', simulation: true });
const order = (status = 'awaiting_payment') => ({ id: orderId, bundle_id: 'flex', price_minor: 100, currency: 'USD', status, quote_expires_at: future() });
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body && typeof body === 'object' && ('entitlements' in body || 'orders' in body) ? { customerId, ...body } : body) });
async function mock(page: Page, handle?: (route: Route, path: string, method: string) => Promise<boolean>) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (await handle?.(route, path, method)) return;
    if (path === '/api/capabilities') return json(route, capabilities);
    if (path === '/api/bundles') return json(route, { products: [product], candidate: true });
    if (path === '/api/sites' || path === '/api/staff/sites') return json(route, { sites: [site] });
    if (path === '/api/help') return json(route, { articles: [] });
    if (path === '/api/session') return json(route, { customerId });
    if (path === '/api/usage') return json(route, usageSnapshot('0', { allowanceBytes: '0' }));
    if (path === '/api/access') return json(route, { entitlements: [], hasMore: false, nextOffset: null });
    if (path === '/api/recovery/status') return json(route, { configured: false });
    if (path === '/api/payments/methods') return json(route, { enabled: true, mode: 'mock', simulation: true, methods: [{ code: 'mock', name: 'Mock provider', currency: 'USD', minMinor: 1, maxMinor: 100000 }] });
    return json(route, { error: 'unexpected_request' }, 500);
  });
}
async function openStaff(page: Page) { await page.goto('/'); await page.getByRole('button', { name: 'Staff', exact: true }).click(); }
async function openCustomer(page: Page) { await page.goto('/'); await page.getByRole('button', { name: 'Customer tools' }).click(); await expect(page.getByRole('heading', { name: 'Your connection, in one place' })).toBeVisible(); }

test('staff application enrolls MFA, remains pending, and exposes no sales or administration', async ({ page }, testInfo) => {
  let authenticated = false;
  await mock(page, async (route, path) => {
    if (path === '/api/staff/session') { await json(route, authenticated ? staff('agent', 'pending') : { error: 'not_authenticated' }, authenticated ? 200 : 401); return true; }
    if (path === '/api/staff/register') { expect(route.request().postDataJSON().password.length).toBeGreaterThanOrEqual(15); await json(route, { status: 'pending', next: 'login' }, 202); return true; }
    if (path === '/api/staff/login') { await json(route, { next: 'mfa_setup', expiresIn: 300, staffId }); return true; }
    if (path === '/api/staff/mfa/setup') { await json(route, { secret: 'JBSWY3DPEHPK3PXP', expiresIn: 300, staffId }); return true; }
    if (path === '/api/staff/mfa/confirm') { authenticated = true; await json(route, staff('agent', 'pending')); return true; }
    return false;
  });
  await page.setViewportSize({ width: 320, height: 850 }); await openStaff(page);
  await page.getByRole('button', { name: 'New team member? Apply for access' }).click();
  await page.getByLabel('Your name').fill('New agent'); await page.getByLabel('Email', { exact: true }).fill('new@staff.invalid'); await page.getByLabel('Password', { exact: true }).fill('long unique password here');
  await page.getByRole('button', { name: 'Submit staff application' }).click(); await expect(page.getByText('Your application has been received.', { exact: false })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill('long unique password here'); await page.getByRole('button', { name: 'Continue to verification' }).click();
  await page.getByRole('button', { name: 'Create authenticator setup key' }).click(); await expect(page.getByTestId('mfa-setup-key')).toBeVisible();
  await page.getByLabel('Authenticator code').fill('123456'); await page.getByRole('button', { name: 'Verify authenticator' }).click();
  await expect(page.getByRole('heading', { name: 'Waiting for administrator approval' })).toBeVisible(); await expect(page.getByTestId('mfa-setup-key')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Confirm demo sale' })).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Administration', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('staff-pending-320.png'), fullPage: true });
});

test('MFA success cannot accept a different pre-existing staff cookie', async ({ page }) => {
  let afterMfa = false;
  await mock(page, async (route, path) => {
    if (path === '/api/staff/session') { await json(route, afterMfa ? staff('admin', 'approved', agentId) : { error: 'not_authenticated' }, afterMfa ? 200 : 401); return true; }
    if (path === '/api/staff/login') { await json(route, { next: 'mfa_verify', expiresIn: 300, staffId }); return true; }
    if (path === '/api/staff/mfa/verify') { afterMfa = true; await json(route, staff()); return true; }
    return false;
  });
  await openStaff(page); await page.getByLabel('Email', { exact: true }).fill('agent@staff.invalid'); await page.getByLabel('Password', { exact: true }).fill('long unique password here'); await page.getByRole('button', { name: 'Continue to verification' }).click();
  await page.getByLabel('Authenticator code').fill('123456'); await page.getByRole('button', { name: 'Verify authenticator' }).click();
  await expect(page.getByText('no staff account has been accepted', { exact: false })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Administration', exact: true })).toHaveCount(0);
});

test('a lost agent sale response restores the exact intent and cannot debit stock twice', async ({ page }) => {
  const keys: string[] = []; let sold = false;
  await mock(page, async (route, path, method) => {
    if (path === '/api/staff/session') { await json(route, staff()); return true; }
    if (path === '/api/staff/inventory') { await json(route, { inventory: [{ agentId: staffId, siteId, siteName: site.name, bundleId: 'flex', quantity: sold ? 0 : 1 }] }); return true; }
    if (path === '/api/staff/sales') {
      if (method === 'POST') { keys.push(route.request().headers()['idempotency-key']); expect(route.request().postDataJSON()).toEqual({ siteId, bundleId: 'flex', delivery: 'receipt', pairingCode: 'ABCD234567', payment: { method: 'cash', confirmed: true, amountMinor: 100, currency: 'USD' } }); if (!sold) { sold = true; await route.abort('failed'); } else await json(route, { sale: sale(), replayed: true }); }
      else await json(route, { sales: sold ? [sale()] : [], hasMore: false, nextOffset: null }); return true;
    }
    if (path === `/api/staff/sales/${saleId}/receipt`) { await json(route, { receipt: { sale: sale(), voucher: { id: saleId, code: 'PRIVATEVOUCHER234567', state: 'issued' } }, simulation: true }); return true; }
    return false;
  });
  await openStaff(page); await page.getByLabel('Customer pairing code').fill('ABCD234567'); await page.getByRole('checkbox', { name: /simulated sale/ }).check(); await page.getByRole('button', { name: 'Confirm demo sale' }).click();
  await expect(page.getByText('Retry the saved request', { exact: false })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Staff', exact: true }).click(); await expect(page.getByLabel('Customer pairing code')).toHaveValue('ABCD234567');
  await page.getByRole('checkbox', { name: /simulated sale/ }).check(); await page.getByRole('button', { name: 'Retry saved sale safely' }).click();
  await expect(page.getByText('stock was not debited twice', { exact: false })).toBeVisible(); expect(keys).toHaveLength(2); expect(new Set(keys).size).toBe(1);
  await page.getByRole('button', { name: 'View private receipt' }).click(); await expect(page.getByLabel('Voucher code', { exact: true })).toHaveValue('PRIVATEVOUCHER234567'); await page.getByRole('button', { name: 'Hide receipt' }).click(); await expect(page.getByLabel('Voucher code', { exact: true })).toHaveCount(0);
});

test('support sees scoped delivery evidence but cannot expose vouchers or resend SMS', async ({ page }) => {
  await mock(page, async (route, path) => {
    if (path === '/api/staff/session') { await json(route, staff('support')); return true; }
    if (path === '/api/staff/sales') { await json(route, { sales: [{ ...sale(), delivery: 'sms' }], hasMore: false, nextOffset: null }); return true; }
    if (path.endsWith('/delivery')) { await json(route, { state: 'unknown', simulation: true, attempts: [{ id: saleId, state: 'unknown', createdAt: new Date().toISOString(), deliveredAt: null, chargeAmount: null, chargeScale: null, chargeCurrency: null }] }); return true; }
    return false;
  });
  await openStaff(page); await page.getByRole('button', { name: 'Delivery status', exact: true }).click(); await expect(page.getByText('Simulated SMS: Delivery outcome unknown')).toBeVisible();
  await expect(page.getByRole('button', { name: 'View private receipt' })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Request SMS resend' })).toHaveCount(0);
});

test('administrator approval uses the reviewed version and allocation excludes unpublished bundles', async ({ page }) => {
  let applicant = staff('agent', 'pending', agentId); let allocation: unknown, decision: unknown;
  await mock(page, async (route, path, method) => {
    if (path === '/api/staff/session') { await json(route, staff('admin')); return true; }
    if (path === '/api/staff/users') { await json(route, { users: [staff('admin'), applicant], nextCursor: null }); return true; }
    if (path === `/api/staff/users/${agentId}/decision`) { decision = route.request().postDataJSON(); applicant = { ...staff('agent', 'approved', agentId), version: 2 }; await json(route, applicant); return true; }
    if (path === '/api/admin/bundles') { await json(route, { products: [{ ...product, published: true }, { ...product, id: 'draft', published: false }] }); return true; }
    if (path === '/api/staff/inventory') { await json(route, { inventory: [] }); return true; }
    if (path === '/api/admin/inventory/allocations' && method === 'POST') { allocation = route.request().postDataJSON(); expect(route.request().headers()['idempotency-key']).toMatch(/^[a-f0-9-]{36}$/); await json(route, { allocated: true }, 201); return true; }
    return false;
  });
  await openStaff(page); await page.getByRole('button', { name: 'Review access' }).click(); await page.getByRole('checkbox', { name: site.name, exact: true }).check(); await page.getByLabel('Reason', { exact: true }).fill('Verified staff application and assigned site'); await page.getByRole('button', { name: 'Save staff decision' }).click();
  await expect(page.getByText('Staff decision saved.', { exact: false })).toBeVisible();
  expect(decision).toEqual({ expectedVersion: 1, status: 'approved', role: 'agent', siteIds: [siteId], reason: 'Verified staff application and assigned site' });
  await page.getByRole('button', { name: 'Inventory', exact: true }).click(); await page.getByRole('combobox', { name: 'Agent', exact: true }).selectOption(agentId); await page.getByRole('combobox', { name: 'Site', exact: true }).selectOption(siteId); await page.getByRole('combobox', { name: 'Bundle', exact: true }).selectOption('flex');
  await expect(page.getByRole('combobox', { name: 'Bundle', exact: true }).locator('option')).toHaveCount(2); await expect(page.getByLabel('Reason', { exact: true })).toHaveAttribute('minlength', '10'); await page.getByLabel('Quantity').fill('3'); await page.getByLabel('Reason', { exact: true }).fill('Three bundles for the reviewed pilot'); await page.getByRole('button', { name: 'Allocate inventory' }).click(); await expect(page.getByText('Inventory allocation confirmed.', { exact: false })).toBeVisible();
  expect(allocation).toEqual({ agentId, siteId, bundleId: 'flex', quantity: 3, reason: 'Three bundles for the reviewed pilot' });
});

test('private pairing delivers a receipt and voucher redemption queues access without claiming connectivity', async ({ page }) => {
  let paired = false, redeemed = false; const receipt = { sale: sale(), voucher: { id: saleId, code: 'PRIVATEVOUCHER234567', state: 'issued' } };
  await mock(page, async (route, path, method) => {
    if (path === '/api/receipt-pairings' && method === 'POST') { paired = true; await json(route, { pairing: { id: saleId, code: 'ABCD234567', expiresAt: future() } }, 201); return true; }
    if (path === `/api/receipt-pairings/${saleId}`) { await json(route, { status: 'ready', receipt }); return true; }
    if (path === '/api/vouchers/redeem') { expect(route.request().postDataJSON()).toEqual({ code: receipt.voucher.code }); redeemed = true; await json(route, { entitlementId: saleId, replayed: false }); return true; }
    if (path === '/api/access') { await json(route, { entitlements: redeemed ? [{ id: saleId, bundle_id: 'flex', byte_limit: '5000000000', consumed_bytes: '0', validity_seconds: 604800, activated_at: null, revoked_at: null, start_by: future() }] : [], hasMore: false, nextOffset: null }); return true; }
    return false;
  });
  await openCustomer(page); await page.getByRole('button', { name: 'Private receipt', exact: true }).click(); await page.getByRole('button', { name: 'Create private pairing code' }).click(); await expect(page.getByLabel('Private voucher')).toHaveValue(receipt.voucher.code); expect(paired).toBe(true);
  await page.getByRole('button', { name: "Redeem this receipt's voucher" }).click(); await expect(page.getByText('Queued · not connected', { exact: true })).toBeVisible(); await expect(page.getByLabel('Private voucher')).toHaveCount(0); expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.endsWith(':receipt-pairing')))).toEqual([]);
});

test('checkout survives a lost response and only authoritative fulfillment unlocks a new purchase', async ({ page }) => {
  const keys: string[] = []; let paid = false, lost = true;
  await mock(page, async (route, path, method) => {
    if (path === '/api/orders' && method === 'POST') { keys.push(route.request().headers()['idempotency-key']); if (lost) { lost = false; await route.abort('failed'); } else await json(route, { order: order() }, 201); return true; }
    if (path === `/api/orders/${orderId}/checkout`) { await json(route, { attemptId: saleId, state: 'pending', redirectUrl: 'https://payments.example.test/checkout', simulation: true }); return true; }
    if (path === `/api/orders/${orderId}/status`) { await json(route, { order: order(paid ? 'payment_confirmed' : 'awaiting_payment'), attempts: [{ id: saleId, state: paid ? 'verified_success' : 'pending' }], entitlementId: paid ? saleId : null, entitlementRevokedAt: null, fulfillmentState: paid ? 'fulfilled' : 'unconfirmed', simulation: true }); return true; }
    if (path === `/api/orders/${orderId}/mock-payment`) { paid = true; await json(route, { state: 'fulfilled', simulation: true }); return true; }
    return false;
  });
  await openCustomer(page); await page.getByRole('button', { name: 'Buy a bundle', exact: true }).click(); await page.getByRole('checkbox', { name: /reviewed the price/ }).check(); await page.getByRole('button', { name: 'Prepare checkout' }).click(); await expect(page.getByText('Checkout could not be confirmed.', { exact: false })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Customer tools' }).click(); await expect(page.getByText('unfinished checkout details were restored', { exact: false })).toBeVisible(); await page.getByRole('checkbox', { name: /reviewed the price/ }).check(); await page.getByRole('button', { name: 'Retry this checkout safely' }).click(); await expect(page.getByRole('link', { name: /Continue to payment provider/ })).toHaveAttribute('href', 'https://payments.example.test/checkout');
  expect(keys).toHaveLength(2); expect(new Set(keys).size).toBe(1); await page.getByRole('button', { name: 'Check verified payment status' }).click(); await expect(page.getByText('Payment not confirmed.', { exact: false })).toBeVisible(); await expect(page.getByRole('button', { name: 'Review another bundle' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Simulate successful payment' }).click(); await expect(page.getByText('Simulated payment verified.', { exact: false })).toBeVisible(); await page.getByRole('button', { name: 'Review another bundle' }).click(); await expect(page.getByRole('button', { name: 'Prepare checkout' })).toBeVisible(); expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.includes('purchase-details') || key.includes(':checkout:') || key.includes(':order:')))).toEqual([]);
});

test('network credentials are private and prepared access stays unconnected until accounting confirms it', async ({ page }) => {
  let prepared = false, connected = false, disconnect = false;
  await mock(page, async (route, path) => {
    if (path === '/api/capabilities') { await json(route, { ...capabilities, networkAccess: true }); return true; }
    if (path === '/api/network/sites') { await json(route, { sites: [{ ...site, loginUrl: 'https://hotspot.example.test/login' }] }); return true; }
    if (path === '/api/usage') { const snapshot = usageSnapshot('0', { queuedBytes: connected ? '0' : '5000000000' }); snapshot.session = prepared ? { grantId: saleId, entitlementId: saleId, siteId, state: connected ? 'active' : 'pending', connected: connected && !disconnect, issuedAt: new Date().toISOString(), lastAccountingAt: connected ? new Date().toISOString() : null, deadline: future(), reservedBytes: '5000000000', chargedBytes: '0', reservationOutstandingBytes: '5000000000', disconnectRequested: disconnect, accountingAnomaly: false, accountingStale: false } : null; snapshot.connectivity = prepared ? connected ? 'recent_accounting' : 'pending' : 'none'; await json(route, snapshot); return true; }
    if (path === '/api/network/credentials') { prepared = true; await json(route, { username: 'short-lived-user', password: 'short-lived-password', expiresAt: future(), loginUrl: 'https://hotspot.example.test/login' }); return true; }
    if (path === '/api/network/disconnect') { disconnect = true; await json(route, { state: 'disconnect_pending' }, 202); return true; }
    return false;
  });
  await openCustomer(page); await page.getByRole('button', { name: 'Prepare hotspot sign-in' }).click(); await expect(page.getByText('Sign-in pending · not confirmed connected', { exact: true })).toBeVisible(); await expect(page.getByRole('link', { name: /Open registered hotspot sign-in/ })).toHaveAttribute('href', 'https://hotspot.example.test/login'); await expect(page.getByRole('button', { name: 'Submit to configured hotspot' })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ local: localStorage, session: sessionStorage })) ).not.toContain('short-lived-password');
  connected = true; await page.getByRole('button', { name: 'Check connection', exact: true }).click(); await expect(page.getByText('Connected · recent router report', { exact: true })).toBeVisible(); await page.getByRole('button', { name: 'Disconnect this hotspot session' }).click(); await expect(page.getByText('Disconnect awaiting confirmation', { exact: true })).toBeVisible(); await expect(page.getByText('No active hotspot session', { exact: true })).toHaveCount(0);
});

test('handoff requires explicit consent and refuses a mismatched or blocked resulting cookie', async ({ page }) => {
  const code = 'h'.repeat(43); let requests = 0;
  await mock(page, async (route, path) => { if (path === '/api/handoff/redeem') { requests++; expect(route.request().postDataJSON()).toEqual({ handoffCode: code }); await json(route, { customerId: agentId }); return true; } return false; });
  await page.goto('/handoff'); await page.getByLabel('One-time handoff code').fill(code); await expect(page.getByRole('button', { name: 'Accept account handoff' })).toBeDisabled(); expect(requests).toBe(0); await page.getByRole('checkbox', { name: /my own PamoFi account/ }).check(); await page.getByRole('button', { name: 'Accept account handoff' }).click(); await expect(page.getByRole('alert')).toContainText('did not keep the transferred session'); expect(page.url()).not.toContain(code);
});

for (const phase of ['initial session', 'MFA confirmation'] as const) {
  test(`a held ${phase} response cannot restore staff access after another tab signs out`, async ({ page }) => {
    let release!: () => void, requested!: () => void, mfaAccepted = false;
    const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { requested = resolve; });
    await mock(page, async (route, path) => {
      if (path === '/api/staff/session') {
        if (phase === 'initial session' || mfaAccepted) { requested(); await gate; await json(route, staff('agent', 'pending')); }
        else await json(route, { error: 'not_authenticated' }, 401);
        return true;
      }
      if (path === '/api/staff/login') { await json(route, { next: 'mfa_setup', expiresIn: 300, staffId }); return true; }
      if (path === '/api/staff/mfa/setup') { await json(route, { secret: 'JBSWY3DPEHPK3PXP', expiresIn: 300, staffId }); return true; }
      if (path === '/api/staff/mfa/confirm') { mfaAccepted = true; await json(route, staff('agent', 'pending')); return true; }
      return false;
    });
    await openStaff(page);
    if (phase === 'MFA confirmation') {
      await page.getByLabel('Email', { exact: true }).fill('agent@staff.invalid'); await page.getByLabel('Password', { exact: true }).fill('long unique password here'); await page.getByRole('button', { name: 'Continue to verification' }).click(); await page.getByRole('button', { name: 'Create authenticator setup key' }).click(); await expect(page.getByTestId('mfa-setup-key')).toBeVisible(); await page.getByLabel('Authenticator code').fill('123456'); await page.getByRole('button', { name: 'Verify authenticator' }).click();
    }
    await held;
    await page.evaluate(() => { const channel = new BroadcastChannel('pamofi.staff-session'); channel.postMessage({ kind: 'signed_out' }); channel.close(); });
    await expect(page.getByText('The staff account changed in another tab.', { exact: false })).toBeVisible();
    const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/staff/session' && result.status() === 200); release(); await (await response).finished();
    await page.getByLabel('Email', { exact: true }).fill('still-signed-out@staff.invalid');
    await expect(page.getByRole('button', { name: 'Continue to verification' })).toBeEnabled(); await expect(page.getByRole('button', { name: 'Sign out of staff' })).toHaveCount(0); await expect(page.getByRole('heading', { name: 'Waiting for administrator approval' })).toHaveCount(0); await expect(page.getByTestId('mfa-setup-key')).toHaveCount(0);
  });
}

test('only a serialized rolled-back sale rejection unlocks the form; ambiguous gateway errors retain its key', async ({ page }) => {
  const keys: string[] = []; let attempts = 0, sold = false;
  await mock(page, async (route, path, method) => {
    if (path === '/api/staff/session') { await json(route, staff()); return true; }
    if (path === '/api/staff/inventory') { await json(route, { inventory: [{ agentId: staffId, siteId, siteName: site.name, bundleId: 'flex', quantity: sold ? 0 : 1 }] }); return true; }
    if (path === '/api/staff/sales') {
      if (method === 'POST') {
        keys.push(route.request().headers()['idempotency-key']); attempts++;
        if (attempts === 1) await json(route, { error: 'pairing_unavailable' }, 409);
        else if (attempts === 2) await json(route, { error: 'site_unavailable' }, 409);
        else { sold = true; await json(route, { sale: sale(), replayed: true }); }
      } else await json(route, { sales: sold ? [sale()] : [], hasMore: false, nextOffset: null });
      return true;
    }
    return false;
  });
  await openStaff(page); await page.getByLabel('Customer pairing code').fill('ABCD234567'); await page.getByRole('checkbox', { name: /simulated sale/ }).check(); await page.getByRole('button', { name: 'Confirm demo sale' }).click();
  await expect(page.getByText('This request did not record a sale or debit inventory.', { exact: false })).toBeVisible(); await expect(page.getByLabel('Customer pairing code')).toBeEnabled(); expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.endsWith(':sale')))).toEqual([]);
  await page.getByLabel('Customer pairing code').fill('JKLM234567'); await page.getByRole('checkbox', { name: /simulated sale/ }).check(); await page.getByRole('button', { name: 'Confirm demo sale' }).click(); await expect(page.getByRole('button', { name: 'Retry saved sale safely' })).toBeEnabled(); await expect(page.getByLabel('Customer pairing code')).toBeDisabled();
  expect(keys).toHaveLength(2); expect(keys[1]).not.toBe(keys[0]); await page.getByRole('button', { name: 'Retry saved sale safely' }).click(); await expect(page.getByText('stock was not debited twice', { exact: false })).toBeVisible(); expect(keys[2]).toBe(keys[1]);
});

test('an expired unused quote clears retry state only after verified idempotent server closure', async ({ page }) => {
  const keys: string[] = []; let closed = false, closeCalls = 0;
  await mock(page, async (route, path, method) => {
    if (path === '/api/orders' && method === 'POST') { keys.push(route.request().headers()['idempotency-key']); await json(route, { order: { ...order(), id: keys.length > 1 ? agentId : orderId, quote_expires_at: keys.length > 1 ? future() : new Date(Date.now() - 60_000).toISOString() } }, 201); return true; }
    if (path === `/api/orders/${orderId}/checkout`) { await json(route, { error: 'order_not_payable' }, 409); return true; }
    if (path === `/api/orders/${agentId}/checkout`) { await json(route, { attemptId: saleId, state: 'pending', redirectUrl: null, simulation: true }); return true; }
    if (path === `/api/orders/${orderId}/expire-unused`) {
      expect(method).toBe('POST'); expect(route.request().postDataJSON()).toEqual({}); closeCalls++;
      if (!closed) { closed = true; await route.abort('failed'); }
      else await json(route, { orderId, state: 'expired_unused', safeToRequote: true, replayed: true });
      return true;
    }
    return false;
  });
  await openCustomer(page); await page.getByRole('button', { name: 'Buy a bundle', exact: true }).click(); await page.getByRole('checkbox', { name: /reviewed the price/ }).check(); await page.getByRole('button', { name: 'Prepare checkout' }).click(); await expect(page.getByText('This order cannot begin payment.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Close an expired unused quote' }).click(); await expect(page.getByText('Quote closure could not be verified.', { exact: false })).toBeVisible(); expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.endsWith(':purchase-details')).length)).toBe(1); await expect(page.getByRole('combobox', { name: 'Purchase site', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close an expired unused quote' }).click(); await expect(page.getByText('verified that no payment attempt exists', { exact: false })).toBeVisible(); expect(closeCalls).toBe(2); expect(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.includes('purchase-details') || key.includes(':checkout:') || key.includes(':order:')))).toEqual([]); await expect(page.getByRole('combobox', { name: 'Purchase site', exact: true })).toBeEnabled();
  await page.getByRole('checkbox', { name: /reviewed the price/ }).check(); await page.getByRole('button', { name: 'Prepare checkout' }).click(); await expect(page.getByText('Simulation checkout prepared.', { exact: false })).toBeVisible(); expect(keys).toHaveLength(2); expect(keys[1]).not.toBe(keys[0]);
});

test('published cash-only bundles open private pairing and require the exact agent cash confirmation', async ({ page }) => {
  let received: unknown;
  await mock(page, async (route, path, method) => {
    if (path === '/api/capabilities') { await json(route, { ...capabilities, demo: false, paymentMode: 'disabled', paymentCheckout: false, deliverySms: false }); return true; }
    if (path === '/api/bundles') { await json(route, { products: [product], candidate: false }); return true; }
    if (path === '/api/staff/session') { await json(route, staff()); return true; }
    if (path === '/api/staff/inventory') { await json(route, { inventory: [{ agentId: staffId, siteId, siteName: site.name, bundleId: 'flex', quantity: 1 }] }); return true; }
    if (path === '/api/staff/sales') { if (method === 'POST') { received = route.request().postDataJSON(); await json(route, { sale: { ...sale(), simulation: false, payment: { method: 'cash', evidence: 'agent_attestation', receivedMinor: 100, currency: 'USD', confirmedAt: new Date().toISOString(), confirmedBy: staffId } }, replayed: false }); } else await json(route, { sales: [], hasMore: false, nextOffset: null }); return true; }
    return false;
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Buy flex from an agent' }).click(); await expect(page.getByRole('heading', { name: 'Receive a private agent receipt' })).toBeVisible(); await expect(page.getByText('FLEX · $1.00', { exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: 'Prepare checkout' })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Create private pairing code' })).toBeEnabled();
  await page.getByRole('button', { name: 'Close customer workspace' }).click(); await page.getByRole('button', { name: 'Staff', exact: true }).click(); await page.getByLabel('Customer pairing code').fill('ABCD234567'); await expect(page.getByRole('button', { name: 'Confirm cash and issue voucher' })).toBeDisabled(); await page.getByRole('checkbox', { name: 'I have received $1.00 in cash from this customer.', exact: true }).check(); await page.getByRole('button', { name: 'Confirm cash and issue voucher' }).click();
  await expect(page.getByText('Cash received: $1.00 · confirmed by agent', { exact: true })).toBeVisible(); expect(received).toEqual({ siteId, bundleId: 'flex', delivery: 'receipt', pairingCode: 'ABCD234567', payment: { method: 'cash', confirmed: true, amountMinor: 100, currency: 'USD' } });
});

test('a legacy committed sale retries its exact saved body without inventing cash evidence', async ({ page }) => {
  const key = '12345678-1234-4123-8123-123456789abc', legacy = { siteId, bundleId: 'flex', delivery: 'receipt', pairingCode: 'ABCD234567' };
  await page.addInitScript(({ staffId, key, legacy }) => sessionStorage.setItem(`pamofi.operation:staff:${staffId}:sale`, JSON.stringify({ key, payload: JSON.stringify(legacy) })), { staffId, key, legacy });
  await mock(page, async (route, path, method) => {
    if (path === '/api/staff/session') { await json(route, staff()); return true; }
    if (path === '/api/staff/inventory') { await json(route, { inventory: [{ agentId: staffId, siteId, siteName: site.name, bundleId: 'flex', quantity: 0 }] }); return true; }
    if (path === '/api/staff/sales') { if (method === 'POST') { expect(route.request().headers()['idempotency-key']).toBe(key); expect(route.request().postDataJSON()).toEqual(legacy); await json(route, { sale: sale(), replayed: true }); } else await json(route, { sales: [], hasMore: false, nextOffset: null }); return true; }
    return false;
  });
  await openStaff(page); await expect(page.getByText('Do not collect cash again.', { exact: false })).toBeVisible(); await page.getByRole('checkbox', { name: /without collecting payment again/ }).check(); await page.getByRole('button', { name: 'Retry saved sale safely' }).click(); await expect(page.getByText('stock was not debited twice', { exact: false })).toBeVisible(); await expect(page.getByText('Cash confirmation was not recorded for this earlier sale.', { exact: true })).toBeVisible();
});
