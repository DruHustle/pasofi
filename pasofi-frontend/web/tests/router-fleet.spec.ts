import { test, expect, type Page, type Route } from '@playwright/test';

const staffId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const siteId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const otherSiteId = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd2';
const routerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const otherRouterId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const unconfiguredId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const changeId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const rollbackId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const revision = 'a'.repeat(64), revised = 'b'.repeat(64);
const date = (seconds = 0) => new Date(Date.now() + seconds * 1000).toISOString();
const staff = { staffId, email: 'admin@staff.invalid', displayName: 'Administrator', status: 'approved', role: 'admin', siteIds: [], version: 1, mfaVerified: true, mfaEnrolled: true };
const capabilities = { demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: false, receiptPairing: false, staffSales: false, deliverySms: false, networkAccess: false, mobileCookies: false, routerFleet: true, routerFleetWrite: true };
const routers = [
  { id: routerId, siteId, siteName: 'Market Square', clientName: 'Market router', customerNetworkEnabled: true, configured: true, writesEnabled: true },
  { id: otherRouterId, siteId: otherSiteId, siteName: 'College Road', clientName: 'College router', customerNetworkEnabled: false, configured: true, writesEnabled: false },
  { id: unconfiguredId, siteId, siteName: 'Market Square', clientName: 'New router', customerNetworkEnabled: false, configured: false, writesEnabled: false },
];
const fields = [{ key: 'name', label: 'Router name', type: 'text', maxLength: 64, help: '1–64 UTF-8 bytes.' }];
function snapshot(id = routerId, name = id === routerId ? 'Pasofi Market' : 'Pasofi College') {
  return { router: routers.find(router => router.id === id)!, device: { identity: name, model: 'hAP ax²', version: '7.20', serial: 'DEVICE-EXAMPLE' },
    targets: [{ key: 'identity', kind: 'identity', values: { name }, revision: name === 'Pasofi Market' ? revision : revised, fields }], observedAt: date() };
}
function change(overrides: Record<string, unknown> = {}) {
  return { id: changeId, nasId: routerId, actorId: staffId, actorVersion: '1', targetKey: 'identity', targetKind: 'identity',
    before: { name: 'Pasofi Market' }, after: { name: 'Pasofi Market East' }, beforeRevision: revision, afterRevision: revised,
    status: 'prepared', reason: 'Make the site name easier to identify.', createdAt: date(), updatedAt: date(), expiresAt: date(600),
    appliedAt: null, parentChangeId: null, errorCode: null, reconcileAfter: null, ...overrides };
}
const json = (route: Route, value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
type Handler = (route: Route, path: string, method: string) => Promise<boolean>;
async function mock(page: Page, handler?: Handler) {
  const state = { session: { ...staff }, caps: { ...capabilities } as Record<string, unknown>, name: 'Pasofi Market', changes: [] as ReturnType<typeof change>[],
    posts: [] as { path: string; body: unknown; key: string | undefined }[] };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (method === 'POST') state.posts.push({ path, body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] });
    if (await handler?.(route, path, method)) return;
    if (path === '/api/capabilities') return json(route, state.caps);
    if (path === '/api/bundles') return json(route, { products: [], candidate: false });
    if (path === '/api/help') return json(route, { articles: [] });
    if (path === '/api/sites' || path === '/api/staff/sites') return json(route, { sites: [{ id: siteId, name: 'Market Square', enabled: false }] });
    if (path === '/api/session') return json(route, { error: 'not_authenticated' }, 401);
    if (path === '/api/staff/session') return json(route, state.session);
    if (path === '/api/staff/users') return json(route, { users: [], nextCursor: null });
    if (path === '/api/admin/bundles') return json(route, { products: [], cashCurrencies: ['USD'] });
    if (path === '/api/staff/inventory') return json(route, { inventory: [] });
    if (path === '/api/admin/routers') return json(route, { routers });
    const match = path.match(/^\/api\/admin\/routers\/([^/]+)(?:\/changes(?:\/([^/]+)(?:\/(apply|reconcile|rollback))?)?)?$/);
    if (match) {
      const id = match[1], recordedId = match[2], action = match[3];
      if (!path.includes('/changes')) return json(route, snapshot(id, id === routerId ? state.name : undefined));
      if (!recordedId) {
        if (method === 'GET') return json(route, { changes: state.changes.filter(item => item.nasId === id) });
        const body = route.request().postDataJSON();
        const prepared = change({ after: body.values, reason: body.reason }); state.changes.unshift(prepared); return json(route, { change: prepared }, 201);
      }
      const item = state.changes.find(item => item.id === recordedId);
      if (!item) return json(route, { error: 'not_found' }, 404);
      if (!action) return json(route, { change: item });
      if (action === 'rollback') {
        const inverse = change({ id: rollbackId, parentChangeId: item.id, before: item.after, after: item.before,
          beforeRevision: revised, afterRevision: revision, reason: route.request().postDataJSON().reason });
        state.changes.unshift(inverse); return json(route, { change: inverse }, 201);
      }
      item.status = 'applied'; item.appliedAt = date() as never; item.updatedAt = date(); state.name = item.after.name;
      return json(route, { change: item });
    }
    return json(route, { error: 'unexpected_request' }, 500);
  });
  return state;
}
async function open(page: Page) {
  await page.goto('/'); await page.getByRole('button', { name: 'Staff', exact: true }).click();
  await page.getByRole('button', { name: 'Routers', exact: true }).click();
}
async function selectMarket(page: Page) {
  await page.getByRole('button', { name: 'Manage Market router at Market Square', exact: true }).click();
  await expect(page.getByLabel('Router name', { exact: false })).toHaveValue('Pasofi Market');
}
async function preview(page: Page) {
  await page.getByLabel('Router name', { exact: false }).fill('Pasofi Market East');
  await page.getByLabel('Change reason', { exact: true }).fill('Make the site name easier to identify.');
  await page.getByRole('button', { name: 'Review change', exact: true }).click();
  await expect(page.getByTestId('router-change-review')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Reviewed change', exact: true })).toBeFocused();
}
async function apply(page: Page) {
  await page.getByRole('checkbox', { name: 'I reviewed these changes for Market router.' }).check();
  await page.getByRole('button', { name: 'Apply reviewed change', exact: true }).click();
}

for (const width of [320, 390, 768, 1280]) test(`router selection and review fit a ${width}px viewport`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 }); await mock(page); await open(page);
  await expect(page.getByRole('button', { name: 'Manage Market router at Market Square' })).toContainText('Not checked');
  await selectMarket(page); await preview(page);
  await expect(page.getByRole('button', { name: 'Apply reviewed change' })).toBeDisabled();
  await expect(page.getByTestId('router-change-review')).toContainText('Pasofi Market East');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`router-review-${width}.png`), fullPage: true });
});

test('one admin session previews, confirms and verifies a revision-bound change without exposing connection secrets', async ({ page }) => {
  const state = await mock(page); await open(page); await selectMarket(page);
  await expect(page.getByText('Customer access paused', { exact: true })).toBeVisible();
  await preview(page);
  expect(state.posts).toHaveLength(1); expect(state.posts[0].body).toEqual({ targetKey: 'identity', expectedRevision: revision, values: { name: 'Pasofi Market East' }, reason: 'Make the site name easier to identify.' });
  expect(state.posts[0].key).toMatch(/^[0-9a-f-]{36}$/);
  const stored = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.includes(':router-')));
  expect(stored.map(([, value]) => value)).toEqual([changeId]);
  await apply(page); await expect(page.getByTestId('router-change-review')).toContainText('Applied and verified');
  expect(state.posts[1]).toEqual({ path: `/api/admin/routers/${routerId}/changes/${changeId}/apply`, body: {}, key: undefined });
  await page.getByRole('button', { name: 'Refresh and edit settings' }).click();
  await expect(page.getByLabel('Router name', { exact: false })).toHaveValue('Pasofi Market East');
  await page.getByLabel('Router site').selectOption(otherSiteId);
  await expect(page.getByRole('button', { name: 'Manage Market router at Market Square' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Manage College router at College Road' }).click();
  await expect(page.getByLabel('Router name', { exact: false })).toHaveValue('Pasofi College');
  await expect(page.getByRole('button', { name: 'Review change', exact: true })).toBeDisabled();
  await expect(page.locator('.router-fleet')).not.toContainText('password');
});

test('old services remain discoverable and read-only qualification is independent of customer access', async ({ page }) => {
  const state = await mock(page); delete state.caps.routerFleet; delete state.caps.routerFleetWrite;
  await open(page); await expect(page.getByText('Router management needs the service update.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Registered routers' })).toHaveCount(0);
  state.caps.routerFleet = true; state.caps.routerFleetWrite = false;
  await page.getByRole('button', { name: 'Refresh routers', exact: true }).click(); await selectMarket(page);
  await expect(page.getByText('Configuration changes are disabled for this router.', { exact: false })).toBeVisible();
  await expect(page.getByLabel('Configuration area')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Review change', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Manage New router at Market Square' }).click();
  await expect(page.getByText('Private management is not configured for this router.', { exact: false })).toBeVisible();
  expect(state.posts).toHaveLength(0);
});

test('unreachable routers can be retried and a late prior selection cannot replace the chosen router', async ({ page }) => {
  let unavailable = true, delay = false, release: (() => void) | undefined;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await mock(page, async (route, path) => {
    if (path !== `/api/admin/routers/${routerId}`) return false;
    if (unavailable) { await json(route, { error: 'router_unavailable' }, 503); return true; }
    if (delay) { await blocked; await json(route, snapshot()); return true; }
    return false;
  });
  await open(page); await page.getByRole('button', { name: 'Manage Market router at Market Square' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'private connection' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Manage Market router at Market Square' })).toContainText('Unreachable');
  unavailable = false; await page.getByRole('button', { name: 'Refresh router', exact: true }).click();
  await expect(page.getByLabel('Router name', { exact: false })).toHaveValue('Pasofi Market');
  delay = true; await page.getByRole('button', { name: 'Refresh router', exact: true }).click();
  await page.getByRole('button', { name: 'Manage College router at College Road' }).click();
  await expect(page.getByLabel('Router name', { exact: false })).toHaveValue('Pasofi College');
  release!(); await expect(page.getByLabel('Router name', { exact: false })).toHaveValue('Pasofi College');
  await expect(page.locator('.router-detail h4').first()).toHaveText('College router');
});

test('an interrupted preview retries only its original idempotency key and frozen request', async ({ page }) => {
  let attempts = 0;
  const state = await mock(page, async (route, path, method) => {
    if (path === `/api/admin/routers/${routerId}/changes` && method === 'POST' && ++attempts === 1) { await route.abort('failed'); return true; }
    return false;
  });
  await open(page); await selectMarket(page);
  await page.getByLabel('Router name', { exact: false }).fill('Pasofi Market East');
  await page.getByLabel('Change reason', { exact: true }).fill('Make the site name easier to identify.');
  await page.getByRole('button', { name: 'Review change', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry saved preview' })).toBeVisible();
  await expect(page.getByLabel('Router name', { exact: false })).toBeDisabled();
  await page.getByRole('button', { name: 'Retry saved preview' }).click();
  await expect(page.getByTestId('router-change-review')).toContainText('Ready for review');
  expect(state.posts).toHaveLength(2); expect(state.posts[0]).toEqual(state.posts[1]);
});

test('a lost apply response survives refresh and only checks the same recorded outcome', async ({ page }) => {
  let state: Awaited<ReturnType<typeof mock>>;
  let reconcileCount = 0;
  state = await mock(page, async (route, path) => {
    if (path.endsWith('/apply')) {
      Object.assign(state.changes[0], { status: 'uncertain', reconcileAfter: date(90), errorCode: 'router_unavailable' });
      await route.abort('failed'); return true;
    }
    if (path.endsWith('/reconcile')) { reconcileCount++; return false; }
    return false;
  });
  await open(page); await selectMarket(page); await preview(page); await apply(page);
  await expect(page.getByTestId('router-change-review')).toContainText('Outcome uncertain');
  await expect(page.getByRole('button', { name: 'Apply reviewed change' })).toHaveCount(0);
  const recordSummary = page.locator('.router-change-record > summary');
  await recordSummary.focus();
  await page.getByRole('button', { name: 'Check outcome', exact: true }).dispatchEvent('click');
  await expect(page.getByRole('button', { name: 'Check outcome', exact: true })).toBeEnabled();
  await expect(recordSummary).toBeFocused();
  expect(reconcileCount).toBe(0); expect(state.posts.filter(post => post.path.endsWith('/apply'))).toHaveLength(1);
  await open(page); await page.getByRole('button', { name: 'Manage Market router at Market Square' }).click();
  await expect(page.getByTestId('router-change-review')).toContainText('Outcome uncertain');
  const values = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.includes(':router-')).map(([, value]) => value));
  expect(values).toEqual([changeId, changeId]);
  Object.assign(state.changes[0], { reconcileAfter: date(-1) });
  await page.getByRole('button', { name: 'Check outcome', exact: true }).click();
  await page.getByRole('button', { name: 'Check outcome', exact: true }).click();
  await expect(page.getByTestId('router-change-review')).toContainText('Applied and verified');
  expect(reconcileCount).toBe(1); expect(state.posts.filter(post => post.path.endsWith('/apply'))).toHaveLength(1);
  expect(state.posts.find(post => post.path.endsWith('/reconcile'))?.body).toEqual({});
});

test('rollback prepares a new inverse change and still requires explicit review and apply', async ({ page }) => {
  const state = await mock(page); await open(page); await selectMarket(page); await preview(page); await apply(page);
  await page.getByRole('button', { name: 'Prepare rollback' }).click();
  await page.getByLabel('Rollback reason').fill('Restore the original name for the operator.');
  await page.getByRole('button', { name: 'Review rollback', exact: true }).click();
  await expect(page.getByTestId('router-change-review')).toContainText('Review rollback');
  await expect(page.getByRole('button', { name: 'Apply reviewed change' })).toBeDisabled();
  expect(state.posts.filter(post => post.path.endsWith('/apply'))).toHaveLength(1);
  const rollback = state.posts.find(post => post.path.endsWith('/rollback'))!;
  expect(rollback.body).toEqual({ reason: 'Restore the original name for the operator.' });
  expect(rollback.key).not.toBe(state.posts[0].key);
  await apply(page); await expect(page.getByTestId('router-change-review')).toContainText('Applied and verified');
  expect(state.posts.filter(post => post.path.endsWith('/apply')).map(post => post.path)).toEqual([
    `/api/admin/routers/${routerId}/changes/${changeId}/apply`, `/api/admin/routers/${routerId}/changes/${rollbackId}/apply`,
  ]);
});

test('changed staff authorization prevents the reviewed mutation and clears private router data', async ({ page }) => {
  const state = await mock(page); await open(page); await selectMarket(page); await preview(page);
  state.session.version = 2; await apply(page);
  await expect(page.locator('.router-fleet').getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('router-change-review')).toHaveCount(0);
  expect(state.posts.filter(post => post.path.endsWith('/apply'))).toHaveLength(0);
});

test('a stale revision requires a fresh inspection before a new preview', async ({ page }) => {
  let conflict = true;
  await mock(page, async (route, path, method) => {
    if (path === `/api/admin/routers/${routerId}/changes` && method === 'POST' && conflict) {
      conflict = false; await json(route, { error: 'revision_conflict' }, 409); return true;
    }
    return false;
  });
  await open(page); await selectMarket(page);
  await page.getByLabel('Router name', { exact: false }).fill('Pasofi Market East');
  await page.getByLabel('Change reason', { exact: true }).fill('Make the site name easier to identify.');
  await page.getByRole('button', { name: 'Review change', exact: true }).click();
  await expect(page.getByText('The router settings changed after this view was captured.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review change', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh router', exact: true }).click(); await preview(page);
  await expect(page.getByTestId('router-change-review')).toContainText('Ready for review');
});

test('agents and support do not receive a router administration surface', async ({ page }) => {
  const state = await mock(page); state.session.role = 'support';
  await page.goto('/'); await page.getByRole('button', { name: 'Staff', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Administration', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Routers', exact: true })).toHaveCount(0);
  expect(state.posts).toHaveLength(0);
});
