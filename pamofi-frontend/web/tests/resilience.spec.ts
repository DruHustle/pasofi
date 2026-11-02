import { test, expect, type Page, type Route } from '@playwright/test';

const customerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const orderId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const bundle = { id: 'flex', price_minor: 100, currency: 'USD', byte_limit: '5000000000', validity_seconds: 604800 };
const order = () => ({ id: orderId, bundle_id: 'flex', price_minor: 100, currency: 'USD', status: 'awaiting_payment', quote_expires_at: new Date(Date.now() + 900_000).toISOString() });
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body && typeof body === 'object' && ('entitlements' in body || 'orders' in body) ? { customerId, ...body } : body) });
async function mockApi(page: Page, handle?: (route: Route, path: string) => Promise<boolean>) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (await handle?.(route, path)) return;
    if (path === '/api/bundles') return json(route, { products: [bundle], candidate: true });
    if (path === '/api/help') return json(route, { articles: [{ question: 'What data counts?', answer: 'Uploads and downloads both count.' }, { question: 'How do I recover?', answer: 'Use your saved account reference and recovery key.' }] });
    if (path === '/api/session') return json(route, { customerId });
    if (path === '/api/orders') return json(route, { orders: [] });
    if (path === '/api/access') return json(route, { entitlements: [], hasMore: false, nextOffset: null });
    if (path === '/api/recovery/status') return json(route, { configured: false });
    return json(route, { error: 'unexpected_request' }, 500);
  });
}

test('malformed catalogue recovers with Retry and an unpublished catalogue has an explicit empty state', async ({ page }) => {
  let broken = true, empty = false;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await mockApi(page, async (route, path) => {
    if (path !== '/api/bundles') return false;
    await json(route, broken ? { products: null } : { products: empty ? [] : [bundle], candidate: true }); return true;
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Retry bundles' })).toBeVisible();
  broken = false;
  await page.getByRole('button', { name: 'Retry bundles' }).click();
  await expect(page.getByRole('button', { name: 'Try flex demo bundle' })).toBeEnabled();
  empty = true; await page.reload();
  await expect(page.getByText('No bundles are published yet. Check back when PamoFi launches.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('read-only help searches reviewed answers and never sends the typed question', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/')) requests.push(request.url()); });
  await mockApi(page); await page.goto('/');
  await page.getByRole('button', { name: 'Help & FAQs' }).click();
  await page.getByLabel('Find a quick answer').fill('uploads');
  await expect(page.locator('summary').filter({ hasText: 'What data counts?' })).toBeVisible();
  await expect(page.locator('summary').filter({ hasText: 'How do I recover?' })).toHaveCount(0);
  await page.getByLabel('Find a quick answer').fill('secret-not-to-transmit');
  await expect(page.getByText(/No reviewed answer matches/)).toBeVisible();
  expect(requests.some(url => url.includes('secret-not-to-transmit') || url.includes('uploads'))).toBe(false);
});

test('a lost create-order response keeps the same idempotency key across reload', async ({ page }) => {
  const keys: string[] = [], created = order();
  let drop = true;
  await mockApi(page, async (route, path) => {
    if (path !== '/api/orders') return false;
    if (route.request().method() === 'POST') {
      keys.push(route.request().headers()['idempotency-key']);
      if (drop) { drop = false; await route.abort('failed'); }
      else await json(route, { order: created });
    } else await json(route, { orders: keys.length ? [created] : [] });
    return true;
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try flex demo bundle' }).click();
  await page.getByRole('button', { name: 'Create demo order' }).click();
  await expect(page.getByRole('alert')).toContainText('response could not be verified');
  await page.reload();
  await page.getByRole('button', { name: 'Try flex demo bundle' }).click();
  await page.getByRole('button', { name: 'Resume demo order' }).click();
  await expect(page.getByRole('heading', { name: 'Awaiting simulated payment' })).toBeVisible();
  expect(keys).toHaveLength(2); expect(new Set(keys).size).toBe(1);
});

test('ambiguous recovery rotation hides the invalid old key and reloads the current version', async ({ page }) => {
  const reference = 'R'.repeat(14), first = 'A'.repeat(43), replacement = 'B'.repeat(43);
  let version = 0, rotations = 0;
  const expectedVersions: number[] = [];
  await mockApi(page, async (route, path) => {
    if (path === '/api/recovery/status') { await json(route, version ? { configured: true, accountReference: reference, version } : { configured: false }); return true; }
    if (path === '/api/recovery/setup') { version = 1; await json(route, { accountReference: reference, recoveryKey: first }, 201); return true; }
    if (path === '/api/recovery/rotate') {
      expectedVersions.push(route.request().postDataJSON().expectedVersion); version++; rotations++;
      if (rotations === 1) await route.abort('failed');
      else await json(route, { accountReference: reference, recoveryKey: replacement });
      return true;
    }
    return false;
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Try flex demo bundle' }).click();
  await page.getByRole('button', { name: 'Create recovery key' }).click();
  await expect(page.getByTestId('recovery-key')).toHaveText(first);
  await page.getByRole('button', { name: 'Replace recovery key' }).click();
  await page.getByRole('button', { name: 'Create replacement key' }).click();
  await expect(page.getByRole('alert')).toContainText('previous key may no longer work');
  await expect(page.getByTestId('recovery-key')).toHaveCount(0);
  await page.getByRole('button', { name: 'Replace recovery key' }).click();
  await page.getByRole('button', { name: 'Create replacement key' }).click();
  await expect(page.getByTestId('recovery-key')).toHaveText(replacement);
  expect(expectedVersions).toEqual([1, 2]);
});

test('verified recovery cannot claim success when the recovered cookie is rejected', async ({ page }) => {
  await mockApi(page, async (route, path) => {
    if (path !== '/api/recovery') return false;
    await json(route, { customerId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }); return true;
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Recover', exact: true }).click();
  await page.getByLabel('Account reference').fill('R'.repeat(14));
  await page.getByLabel('Recovery key').fill('K'.repeat(43));
  await page.getByRole('button', { name: 'Recover access' }).click();
  await expect(page.getByRole('alert')).toContainText('did not keep the recovered session');
  await expect(page.getByRole('heading', { name: 'Your demo access' })).toHaveCount(0);
});

test('expired quotes cannot be confirmed and stale sessions do not silently create an empty account', async ({ page }) => {
  let expiredSession = false, createdSessions = 0;
  const expired = { ...order(), quote_expires_at: new Date(Date.now() - 1_000).toISOString() };
  await mockApi(page, async (route, path) => {
    if (path === '/api/session') {
      if (route.request().method() === 'POST') createdSessions++;
      await json(route, expiredSession ? { error: 'not_authenticated' } : { customerId }, expiredSession ? 401 : 200); return true;
    }
    if (path === '/api/orders') { await json(route, { orders: [expired] }); return true; }
    return false;
  });
  await page.goto('/'); await page.getByRole('button', { name: 'My demo access' }).click();
  await expect(page.getByText('Quote expired · not paid')).toBeVisible();
  await page.getByRole('button', { name: 'Check this order' }).click();
  await expect(page.getByRole('button', { name: 'Confirm simulation' })).toHaveCount(0);
  expiredSession = true; await page.getByRole('button', { name: 'Check order' }).click();
  await expect(page.getByRole('alert')).toContainText('session has changed or expired');
  expect(createdSessions).toBe(0);
});

test('access pagination keeps current bundles and loads additional history once', async ({ page }) => {
  const offsets: string[] = [];
  const entitlement = { id: orderId, bundle_id: 'flex', byte_limit: '5000000000', consumed_bytes: '0', validity_seconds: 604800, activated_at: null, revoked_at: null, start_by: new Date(Date.now() + 86400_000).toISOString() };
  await mockApi(page, async (route, path) => {
    if (path !== '/api/access') return false;
    const offset = new URL(route.request().url()).searchParams.get('offset') ?? '0'; offsets.push(offset);
    await json(route, { entitlements: [{ ...entitlement, id: offset === '0' ? orderId : 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', bundle_id: offset === '0' ? 'flex' : 'week' }], hasMore: offset === '0', nextOffset: offset === '0' ? 1 : null }); return true;
  });
  await page.goto('/'); await page.getByRole('button', { name: 'My demo access' }).click();
  await page.getByRole('button', { name: 'Show more bundles' }).click();
  await expect(page.getByText('FLEX · 5 GB', { exact: true })).toBeVisible();
  await expect(page.getByText('WEEK · 5 GB', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show more bundles' })).toHaveCount(0);
  expect(offsets.filter(offset => offset === '1')).toHaveLength(1);
});

test('failed signout preserves the account view; successful signout clears only PamoFi secrets', async ({ page }) => {
  let fail = true;
  await mockApi(page, async (route, path) => {
    if (path !== '/api/session' || route.request().method() !== 'DELETE') return false;
    if (fail) await json(route, { error: 'identity_unavailable' }, 503);
    else await route.fulfill({ status: 204 });
    return true;
  });
  await page.goto('/'); await page.getByRole('button', { name: 'My demo access' }).click();
  await page.evaluate(() => { sessionStorage.setItem('pamofi.orderRetry:test', 'private'); sessionStorage.setItem('unrelated.preference', 'keep'); });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out of this device' }).click();
  await expect(page.getByRole('alert')).toContainText('Sign out could not be completed');
  expect(await page.evaluate(() => sessionStorage.getItem('pamofi.orderRetry:test'))).toBe('private');
  fail = false; await page.getByRole('button', { name: 'Sign out of this device' }).click();
  await expect(page.getByText('Signed out of this device. Use Recover to return to your saved demo account.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your demo access' })).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('pamofi.orderRetry:test'))).toBeNull();
  expect(await page.evaluate(() => sessionStorage.getItem('unrelated.preference'))).toBe('keep');
});

test('a lost confirmation can be checked without trapping future purchases on the old order', async ({ page }) => {
  let current = order();
  await mockApi(page, async (route, path) => {
    if (path === '/api/orders') { await json(route, route.request().method() === 'POST' ? { order: current } : { orders: [current] }); return true; }
    if (path.endsWith('/demo-confirm')) { current = { ...current, status: 'payment_confirmed' }; await route.abort('failed'); return true; }
    return false;
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Try flex demo bundle' }).click();
  await page.getByRole('button', { name: 'Create demo order' }).click();
  await page.getByRole('button', { name: 'Confirm simulation' }).click();
  await expect(page.getByRole('alert')).toContainText('Confirmation could not be verified');
  await page.getByRole('button', { name: 'Check order' }).click();
  await expect(page.getByRole('heading', { name: 'Simulated payment confirmed' })).toBeVisible();
  await page.getByRole('button', { name: 'Close demo purchase' }).click();
  await page.getByRole('button', { name: 'Try flex demo bundle' }).click();
  await expect(page.getByRole('button', { name: 'Create demo order' })).toBeVisible();
});

test('recovery setup refuses to rotate a different account when cross-tab messaging is unavailable', async ({ page }) => {
  let changed = false, mutations = 0;
  await page.addInitScript(() => { Object.defineProperty(window, 'BroadcastChannel', { value: undefined }); });
  await mockApi(page, async (route, path) => {
    if (path === '/api/session') { await json(route, { customerId: changed ? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' : customerId }); return true; }
    if (path === '/api/recovery/status') { await json(route, { configured: true, accountReference: 'R'.repeat(14), version: 1 }); return true; }
    if (path === '/api/recovery/rotate') { mutations++; await json(route, { accountReference: 'R'.repeat(14), recoveryKey: 'K'.repeat(43) }); return true; }
    return false;
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Try flex demo bundle' }).click();
  await page.getByRole('button', { name: 'Replace recovery key' }).click();
  changed = true;
  await page.getByRole('button', { name: 'Create replacement key' }).click();
  await expect(page.getByRole('alert')).toContainText('Your account changed or expired');
  expect(mutations).toBe(0);
});

test('opening access without a session does not silently create a replacement account', async ({ page }) => {
  let creations = 0;
  await mockApi(page, async (route, path) => {
    if (path !== '/api/session') return false;
    if (route.request().method() === 'POST') creations++;
    await json(route, { error: 'not_authenticated' }, 401); return true;
  });
  await page.goto('/'); await page.getByRole('button', { name: 'My demo access' }).click();
  await expect(page.getByRole('alert')).toContainText('There is no active demo session');
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  expect(creations).toBe(0);
});

test('catalogue and session requests work without newer AbortSignal static methods', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(AbortSignal, 'any', { value: undefined, configurable: true });
    Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true });
  });
  await mockApi(page); await page.goto('/');
  await page.getByRole('button', { name: 'Try flex demo bundle' }).click();
  await expect(page.getByRole('button', { name: 'Create demo order' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create recovery key' })).toBeEnabled();
});
