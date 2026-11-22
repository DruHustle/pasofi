import { test, expect, type Page, type Route } from '@playwright/test';

const staffId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherAdmin = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const g0 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', k0 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const printerId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1', phoneId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const date = (seconds = 0) => new Date(Date.now() + seconds * 1000).toISOString();
const admin = { staffId, email: 'admin@staff.invalid', displayName: 'Administrator', status: 'approved', role: 'admin', siteIds: [], version: 1, mfaVerified: true, mfaEnrolled: true };
const capabilities = { demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: false, receiptPairing: false, staffSales: false, deliverySms: false, networkAccess: false, mobileCookies: false, approvedDevices: true, approvedDevicesWrite: true };
const routers = [
  { id: g0, siteName: 'Goromonzi', clientName: 'G0', configured: true, status: 'synced', errorCode: null, attemptedAt: date(-60), syncedAt: date(-60), conflicts: 0, pendingRemovals: 0 },
  { id: k0, siteName: 'Kuwadzana', clientName: 'K0', configured: false, status: 'not_configured', errorCode: null, attemptedAt: null, syncedAt: null, conflicts: 0, pendingRemovals: 0 },
];
type Device = { id: string; macAddress: string; label: string; createdBy: string; createdAt: string; routers: { nasId: string; state: string; observedAt: string | null }[] };
const device = (id: string, macAddress: string, label: string, state = 'applied', createdBy = otherAdmin): Device => ({ id, macAddress, label, createdBy, createdAt: date(-3600),
  routers: [{ nasId: g0, state, observedAt: date(-60) }, { nasId: k0, state: 'not_configured', observedAt: null }] });
const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });

async function mock(page: Page, options: { session?: Record<string, unknown>; caps?: Record<string, unknown>; writesEnabled?: boolean; addError?: [number, string] } = {}) {
  const state = {
    devices: [device(printerId, '02:00:00:00:00:0A', 'Office printer')], syncing: false, syncReads: 0,
    events: [{ id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1', entryId: printerId, type: 'added', actorId: otherAdmin, nasId: null, macAddress: '02:00:00:00:00:0A', label: 'Office printer', reason: 'Printer must reach the cloud print service', createdAt: date(-3600) },
      { id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2', entryId: printerId, type: 'router_binding_added', actorId: otherAdmin, nasId: g0, macAddress: '02:00:00:00:00:0A', label: 'Office printer', reason: null, createdAt: date(-3599) }],
    posts: [] as { path: string; body: unknown; key: string | undefined }[], reads: 0,
  };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (method === 'POST') state.posts.push({ path, body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
    if (path === '/api/capabilities') return json(route, { ...capabilities, ...options.caps });
    if (path === '/api/bundles') return json(route, { products: [], candidate: false });
    if (path === '/api/help') return json(route, { articles: [] });
    if (path === '/api/sites' || path === '/api/staff/sites') return json(route, { sites: [] });
    if (path === '/api/session') return json(route, { error: 'not_authenticated' }, 401);
    if (path === '/api/staff/session') return json(route, options.session ?? admin);
    if (path === '/api/staff/onesa/availability') return json(route, { origin: null });
    if (path === '/api/staff/password-reset/availability') return json(route, { enabled: false });
    if (path === '/api/staff/users') return json(route, { users: [admin, { ...admin, staffId: otherAdmin, displayName: 'Tendai Moyo', email: 'tendai@staff.invalid' }], nextCursor: null });
    if (path === '/api/admin/bundles') return json(route, { products: [], cashCurrencies: ['USD'] });
    if (path === '/api/staff/inventory') return json(route, { inventory: [] });
    if (path === '/api/admin/approved-devices' && method === 'GET') {
      state.reads++;
      if (state.syncing && ++state.syncReads >= 2) { state.syncing = false; for (const item of state.devices) item.routers[0].state = 'applied'; }
      return json(route, { devices: state.devices, routers, events: state.events, maxDevices: 200, writesEnabled: options.writesEnabled ?? true, registryAvailable: true, syncing: state.syncing });
    }
    if (path === '/api/admin/approved-devices' && method === 'POST') {
      if (options.addError) return json(route, { error: options.addError[1] }, options.addError[0]);
      const body = route.request().postDataJSON();
      const added = device(phoneId, body.macAddress, body.label, 'pending', staffId); state.devices.push(added); state.syncing = true; state.syncReads = 0;
      state.events.unshift({ id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3', entryId: phoneId, type: 'added', actorId: staffId, nasId: null, macAddress: body.macAddress, label: body.label, reason: body.reason, createdAt: date() });
      return json(route, { device: added, syncing: true }, 201);
    }
    const removal = path.match(/^\/api\/admin\/approved-devices\/([^/]+)\/remove$/);
    if (removal && method === 'POST') {
      const removed = state.devices.find(item => item.id === removal[1]);
      if (!removed) return json(route, { error: 'not_found' }, 404);
      state.devices = state.devices.filter(item => item.id !== removed.id);
      state.events.unshift({ id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4', entryId: removed.id, type: 'removed', actorId: staffId, nasId: null, macAddress: removed.macAddress, label: removed.label, reason: route.request().postDataJSON().reason, createdAt: date() });
      return json(route, { device: { ...removed, removedAt: date() }, syncing: false });
    }
    if (path === '/api/admin/approved-devices/sync' && method === 'POST') return json(route, { syncing: false });
    return json(route, { error: 'unexpected_request' }, 500);
  });
  return state;
}

test('the /admin page opens the approved device list for an MFA-verified administrator', async ({ page }) => {
  await mock(page);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Approved devices', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approved devices', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const row = page.getByRole('row').filter({ hasText: 'Office printer' });
  await expect(row).toContainText('02:00:00:00:00:0A');
  await expect(row).toContainText('G0 · GoromonziActive');
  await expect(row).toContainText('K0 · KuwadzanaNot connected');
  await expect(row).toContainText('by Tendai Moyo');
  const routerCards = page.getByLabel('Router synchronization');
  await expect(routerCards).toContainText('In sync');
  await expect(routerCards).toContainText('No private management connection is configured for this router');
  await expect(page.getByRole('region', { name: 'Recent changes' })).toContainText('Tendai Moyo approved Office printer (02:00:00:00:00:0A)');
  await expect(page.getByRole('region', { name: 'Recent changes' })).toContainText('Reason: Printer must reach the cloud print service');
  await expect(page.getByRole('region', { name: 'Recent changes' })).toContainText('Applied Office printer (02:00:00:00:00:0A) on G0 · Goromonzi');
  // Closing the workspace leaves /admin for the home view.
  await page.getByRole('button', { name: 'Close staff workspace' }).click();
  await expect(page).toHaveURL(/\/#home$/);
});

test('adding a device validates the MAC locally, normalizes it and follows router synchronization', async ({ page }) => {
  const state = await mock(page);
  await page.goto('/admin');
  const label = page.getByLabel('Device label'), mac = page.getByLabel('MAC address', { exact: false }), reason = page.getByLabel('Reason for approval', { exact: false });
  await label.fill('Owner phone');
  for (const [value, message] of [
    ['FF:FF:FF:FF:FF:FF', 'broadcast address'], ['01:00:5E:00:00:FB', 'multicast address'], ['3C:22:FB:12:34', 'for example 3C:22:FB:12:34:56'],
  ]) {
    await mac.fill(value); await reason.fill('Owner approved portal-free access');
    await page.getByRole('button', { name: 'Approve device' }).click();
    await expect(page.getByRole('alert')).toContainText(message);
  }
  await mac.fill('3c-22-fb-12-34-56'); await reason.fill('short');
  await page.getByRole('button', { name: 'Approve device' }).click();
  await expect(page.getByRole('alert')).toContainText('at least 10 characters');
  expect(state.posts).toHaveLength(0);
  await reason.fill('  Owner approved portal-free access  ');
  await page.getByRole('button', { name: 'Approve device' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Owner phone (3C:22:FB:12:34:56) is approved' })).toBeVisible();
  expect(state.posts).toHaveLength(1);
  expect(state.posts[0].path).toBe('/api/admin/approved-devices');
  expect(state.posts[0].body).toEqual({ macAddress: '3C:22:FB:12:34:56', label: 'Owner phone', reason: 'Owner approved portal-free access' });
  expect(state.posts[0].key).toMatch(uuid);
  const row = page.getByRole('row').filter({ hasText: 'Owner phone' });
  await expect(row).toContainText('by You');
  // The pending router state is re-read until synchronization completes.
  await expect(row).toContainText('G0 · GoromonziActive', { timeout: 10_000 });
  expect(state.reads).toBeGreaterThanOrEqual(3);
  await expect(label).toHaveValue('');
});

test('removing a device requires a reason and records it', async ({ page }) => {
  const state = await mock(page);
  await page.goto('/admin');
  await page.getByRole('button', { name: 'Remove Office printer' }).click();
  await expect(page.getByRole('heading', { name: 'Remove Office printer' })).toBeFocused();
  await page.getByRole('button', { name: 'Remove device' }).click();
  await expect(page.getByRole('alert')).toContainText('at least 10 characters');
  expect(state.posts).toHaveLength(0);
  await page.getByLabel('Reason for removal').fill('Printer was returned to the supplier');
  await page.getByRole('button', { name: 'Remove device' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Office printer (02:00:00:00:00:0A) was removed' })).toBeVisible();
  expect(state.posts[0]).toMatchObject({ path: `/api/admin/approved-devices/${printerId}/remove`, body: { reason: 'Printer was returned to the supplier' } });
  expect(state.posts[0].key).toMatch(uuid);
  await expect(page.getByRole('row').filter({ hasText: 'Office printer' })).toHaveCount(0);
  await expect(page.getByText('No devices are approved. Every device uses the captive portal.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Recent changes' })).toContainText('You removed Office printer (02:00:00:00:00:0A)');
  await page.getByRole('button', { name: 'Sync routers now' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Router synchronization finished.' })).toBeVisible();
  expect(state.posts.at(-1)).toMatchObject({ path: '/api/admin/approved-devices/sync', body: {} });
});

test('service errors are explained without discarding the form', async ({ page }) => {
  await mock(page, { addError: [409, 'device_exists'] });
  await page.goto('/admin');
  await page.getByLabel('Device label').fill('Printer again');
  await page.getByLabel('MAC address', { exact: false }).fill('02:00:00:00:00:0A');
  await page.getByLabel('Reason for approval', { exact: false }).fill('Trying to add the same printer');
  await page.getByRole('button', { name: 'Approve device' }).click();
  await expect(page.getByRole('alert')).toContainText('This MAC address is already approved.');
  await expect(page.getByLabel('Device label')).toHaveValue('Printer again');
});

test('paused writes keep the list visible without change controls', async ({ page }) => {
  const state = await mock(page, { caps: { approvedDevicesWrite: false }, writesEnabled: false });
  await page.goto('/admin');
  await expect(page.getByRole('row').filter({ hasText: 'Office printer' })).toBeVisible();
  await expect(page.getByText('Changes to approved devices are paused. The list remains visible.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve device' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove Office printer' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sync routers now' })).toHaveCount(0);
  expect(state.posts).toHaveLength(0);
});

test('staff without the administrator role never see or request approved devices', async ({ page }) => {
  const state = await mock(page, { session: { ...admin, role: 'agent', siteIds: [] } });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Staff workspace' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approved devices', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Approved devices', exact: true })).toHaveCount(0);
  expect(state.reads).toBe(0);
});

test('the administration tabs also open approved devices from the staff workspace', async ({ page }) => {
  await mock(page);
  await page.goto('/'); await page.getByRole('button', { name: 'Staff', exact: true }).click();
  await page.getByRole('button', { name: 'Approved devices', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Office printer' })).toBeVisible();
});
