import { test, expect } from '@playwright/test';
import type { Staff } from '../src/business';
import { catalogueUpgradePreview, upgradeCatalogue, type CatalogueProduct, type CatalogueRequest } from '../src/staff/catalogue-upgrade';

const actor: Staff = { staffId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'admin@staff.invalid', displayName: 'Test administrator', status: 'approved', role: 'admin', siteIds: [], version: 3, mfaEnrolled: true, mfaVerified: true };
// These expected prices, decimal bytes and durations come from the requested offer.
const revised = [
  ['mini-5gb-v2', 50, '5000000000', 259200], ['flex-10gb-v2', 100, '10000000000', 604800],
  ['week-30gb-v2', 300, '30000000000', 604800], ['fortnight-50gb-v2', 500, '50000000000', 1209600],
  ['month-100gb-v2', 1000, '100000000000', 2592000],
] as const;
const legacy = [
  ['mini', 50, '2000000000', 259200], ['flex', 100, '5000000000', 604800],
  ['week', 300, '20000000000', 604800], ['fortnight', 500, '35000000000', 1209600], ['month', 1000, '75000000000', 2592000],
] as const;
const row = ([id, price_minor, byte_limit, validity_seconds]: readonly [string, number, string, number], published = true): CatalogueProduct => ({ id, price_minor, currency: 'USD', byte_limit, validity_seconds, published });
type Call = { path: string; method: string; payload?: Record<string, unknown> };

function server(initial = legacy.map(offer => row(offer))) {
  const products = new Map(initial.map(product => [product.id, structuredClone(product)]));
  const calls: Call[] = [];
  const state = { session: structuredClone(actor), currencies: ['USD'], publicationGuardVersion: 1 as number | undefined,
    beforeWrite: (_call: Call) => {}, afterWrite: (_call: Call) => {}, beforeRead: () => {} };
  const request: CatalogueRequest = async <T>(path: string, init?: RequestInit) => {
    const call: Call = { path, method: init?.method ?? 'GET', ...(init?.body ? { payload: JSON.parse(String(init.body)) } : {}) };
    calls.push(call);
    if (path === '/api/staff/session' && call.method === 'GET') return structuredClone(state.session) as T;
    if (path === '/api/admin/bundles' && call.method === 'GET') {
      state.beforeRead();
      return structuredClone({ products: [...products.values()], currencies: state.currencies, publicationGuardVersion: state.publicationGuardVersion }) as T;
    }
    // A separate, verified session read must immediately precede EVERY mutation.
    expect(calls.at(-2)).toEqual({ path: '/api/staff/session', method: 'GET' });
    expect(state.session).toMatchObject({ staffId: actor.staffId, version: actor.version, role: 'admin', status: 'approved', mfaVerified: true });
    state.beforeWrite(call);
    if (path === '/api/admin/bundles' && call.method === 'POST') {
      const body = call.payload!;
      expect(Object.keys(body).sort()).toEqual(['byteLimit', 'currency', 'id', 'priceMinor', 'published', 'reason', 'validitySeconds']);
      expect(body.reason).toEqual(expect.stringMatching(/pricing revision/i));
      const existing = products.get(String(body.id));
      const created = { id: String(body.id), price_minor: Number(body.priceMinor), currency: String(body.currency), byte_limit: String(body.byteLimit), validity_seconds: Number(body.validitySeconds), published: Boolean(body.published) };
      if (existing) expect({ ...existing, published: false }).toEqual({ ...created, published: false });
      else products.set(created.id, created);
      state.afterWrite(call);
      return structuredClone({ product: products.get(created.id) }) as T;
    }
    if (path.startsWith('/api/admin/bundles/') && call.method === 'PATCH') {
      expect(Object.keys(call.payload!).sort()).toEqual(call.payload!.published ? ['published', 'reason'] : ['published', 'reason', 'requiredPublishedBundleIds']);
      if (call.payload!.published === false) {
        expect(call.payload!.requiredPublishedBundleIds).toEqual(revised.map(offer => offer[0]));
        if ((call.payload!.requiredPublishedBundleIds as string[]).some(id => !products.get(id)?.published)) throw Object.assign(new Error('required_bundles_not_published'), { status: 409, code: 'required_bundles_not_published' });
      }
      const product = products.get(path.slice('/api/admin/bundles/'.length));
      if (!product) throw Object.assign(new Error('not_found'), { status: 404 });
      product.published = call.payload!.published as boolean;
      state.afterWrite(call);
      return structuredClone({ product: { id: product.id, published: product.published } }) as T;
    }
    throw Error(`Unexpected request: ${call.method} ${path}`);
  };
  return { request, state, products, calls, writes: () => calls.filter(call => call.method !== 'GET') };
}
const run = (fixture: ReturnType<typeof server>, signal = new AbortController().signal) => upgradeCatalogue({ request: fixture.request, actor, signal });

test.describe('catalogue controller', () => {
  test('publishes exact revised offers in stages while preserving historical and unrelated terms', async () => {
    const special = row(['school-special', 200, '17000000000', 86400]);
    const historical = row(['month-v0', 800, '60000000000', 2592000], false);
    const fixture = server([...legacy.map(offer => row(offer)), special, historical]);
    const result = await run(fixture);
    const writes = fixture.writes();
    expect(writes).toHaveLength(15);
    expect(writes.slice(0, 5).map(call => call.method)).toEqual(Array(5).fill('POST'));
    expect(writes.slice(0, 5).map(call => call.payload!.published)).toEqual(Array(5).fill(false));
    expect(writes.slice(0, 5).map(call => [call.payload!.id, call.payload!.priceMinor, call.payload!.byteLimit, call.payload!.validitySeconds])).toEqual(revised);
    expect(writes.slice(5, 10).map(call => [call.path.split('/').at(-1), call.payload!.published])).toEqual(revised.map(offer => [offer[0], true]));
    expect(writes.slice(10).map(call => [call.path.split('/').at(-1), call.payload!.published])).toEqual(legacy.map(offer => [offer[0], false]));
    for (const offer of revised) expect(fixture.products.get(offer[0])).toEqual(row(offer));
    for (const offer of legacy) expect(fixture.products.get(offer[0])).toEqual(row(offer, false));
    expect(fixture.products.get(special.id)).toEqual(special);
    expect(fixture.products.get(historical.id)).toEqual(historical);
    expect(catalogueUpgradePreview(result.products).complete).toBe(true);
    await run(fixture);
    expect(fixture.writes()).toHaveLength(15); // A resumed, complete operation makes no writes.
  });

  test('reconciles committed draft, publication and withdrawal whose responses were lost', async () => {
    const fixture = server();
    const losses = new Set(['POST:/api/admin/bundles', 'PATCH:/api/admin/bundles/flex-10gb-v2', 'PATCH:/api/admin/bundles/week']);
    fixture.state.afterWrite = call => { if (losses.delete(`${call.method}:${call.path}`)) throw Error('response lost after commit'); };
    const result = await run(fixture);
    expect(losses.size).toBe(0);
    expect(catalogueUpgradePreview(result.products).complete).toBe(true);
    expect(fixture.writes()).toHaveLength(15);
  });

  test('an interrupted draft phase resumes without recreating saved drafts or retiring live offers', async () => {
    const fixture = server();
    fixture.state.beforeWrite = call => { if (call.method === 'POST' && call.payload!.id === 'week-30gb-v2') throw Error('request never committed'); };
    await expect(run(fixture)).rejects.toThrow('could not be confirmed');
    expect(fixture.writes().every(call => call.method === 'POST')).toBe(true);
    for (const offer of legacy) expect(fixture.products.get(offer[0])!.published).toBe(true);
    expect(fixture.products.get('mini-5gb-v2')!.published).toBe(false);
    fixture.state.beforeWrite = () => {};
    await run(fixture);
    expect(fixture.writes().filter(call => call.method === 'POST' && call.payload!.id === 'mini-5gb-v2')).toHaveLength(1);
    expect(fixture.writes().filter(call => call.method === 'POST' && call.payload!.id === 'flex-10gb-v2')).toHaveLength(1);
    expect(catalogueUpgradePreview([...fixture.products.values()]).complete).toBe(true);
  });

  test('partial publication keeps every older offer until all replacements are confirmed', async () => {
    const fixture = server();
    fixture.state.beforeWrite = call => { if (call.path.endsWith('/fortnight-50gb-v2')) throw Error('publication unavailable'); };
    await expect(run(fixture)).rejects.toThrow('could not be confirmed');
    expect(fixture.writes().some(call => call.method === 'PATCH' && call.payload!.published === false)).toBe(false);
    for (const offer of legacy) expect(fixture.products.get(offer[0])!.published).toBe(true);
    fixture.state.beforeWrite = () => {};
    await run(fixture);
    expect(fixture.writes().filter(call => call.path.endsWith('/mini-5gb-v2'))).toHaveLength(1);
    expect(catalogueUpgradePreview([...fixture.products.values()]).complete).toBe(true);
  });

  test('only exact known legacy terms are withdrawn, and replacement ID conflicts block all writes', async () => {
    const fixture = server();
    fixture.products.get('week')!.byte_limit = '25000000000';
    const preserved = structuredClone(fixture.products.get('week'));
    await run(fixture);
    expect(fixture.products.get('week')).toEqual(preserved);
    expect(fixture.writes().some(call => call.path === '/api/admin/bundles/week')).toBe(false);
    const collision = server([...legacy.map(offer => row(offer)), row(['month-100gb-v2', 900, '100000000000', 2592000], false)]);
    await expect(run(collision)).rejects.toThrow('different terms');
    expect(collision.writes()).toEqual([]);
  });

  for (const change of ['account', 'version', 'verification'] as const) {
    test(`stops before the next write when administrator ${change} changes`, async () => {
      const fixture = server();
      fixture.state.afterWrite = () => {
        if (fixture.writes().length !== 2) return;
        if (change === 'account') fixture.state.session.staffId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        else if (change === 'version') fixture.state.session.version++;
        else fixture.state.session.mfaVerified = false;
      };
      await expect(run(fixture)).rejects.toThrow('account or verification changed');
      expect(fixture.writes()).toHaveLength(2);
      expect(fixture.writes().every(call => call.method === 'POST')).toBe(true);
    });
  }

  test('rechecks all replacement publications before each individual legacy withdrawal', async () => {
    const fixture = server();
    fixture.state.afterWrite = call => { if (call.path === '/api/admin/bundles/mini') fixture.products.get('month-100gb-v2')!.published = false; };
    await expect(run(fixture)).rejects.toThrow('no longer published');
    expect(fixture.writes().filter(call => call.method === 'PATCH' && call.payload!.published === false)).toEqual([
      expect.objectContaining({ path: '/api/admin/bundles/mini' }),
    ]);
    for (const offer of legacy.slice(1)) expect(fixture.products.get(offer[0])!.published).toBe(true);
  });

  test('requires an advertised supported backend before any draft, publication or withdrawal', async () => {
    for (const version of [undefined, 0, 2]) {
      const fixture = server(); fixture.state.publicationGuardVersion = version;
      await expect(run(fixture)).rejects.toThrow('Pricing update requires the service update');
      expect(fixture.writes()).toEqual([]);
    }
  });

  test('a server-side replacement change between the read and withdrawal keeps the legacy offer', async () => {
    const fixture = server();
    fixture.state.beforeWrite = call => { if (call.path === '/api/admin/bundles/mini') fixture.products.get('month-100gb-v2')!.published = false; };
    await expect(run(fixture)).rejects.toThrow('A revised offer changed before withdrawal');
    for (const offer of legacy) expect(fixture.products.get(offer[0])!.published).toBe(true);
    expect(fixture.writes().filter(call => call.method === 'PATCH' && call.payload!.published === false)).toHaveLength(1);
  });

  test('stops on cancellation, invalid catalogue data or an unapproved currency', async () => {
    const cancelled = server(); const controller = new AbortController();
    cancelled.state.afterWrite = () => controller.abort();
    await expect(run(cancelled, controller.signal)).rejects.toThrow('interrupted');
    expect(cancelled.writes()).toHaveLength(1);
    const malformed = server(); malformed.products.get('mini')!.byte_limit = 'unverified';
    await expect(run(malformed)).rejects.toThrow('could not be verified'); expect(malformed.writes()).toEqual([]);
    const currency = server(); currency.state.currencies = ['EUR'];
    await expect(run(currency)).rejects.toThrow('not an approved catalogue currency'); expect(currency.writes()).toEqual([]);
  });
});

for (const backendReady of [true, false]) test(`administrator pricing preview ${backendReady ? 'applies the reviewed update' : 'waits for the backend service update'}`, async ({ page }) => {
  const fixture = server();
  if (!backendReady) fixture.state.publicationGuardVersion = undefined;
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let body: unknown;
    if (path === '/api/staff/session' || path.startsWith('/api/admin/bundles')) body = await fixture.request(path, { method: request.method(), ...(request.postData() ? { body: request.postData()! } : {}) });
    else if (path === '/api/capabilities') body = { demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: false, receiptPairing: false, staffSales: false, inventoryAllocation: true, deliverySms: false, networkAccess: false, mobileCookies: false };
    else if (path === '/api/bundles') body = { products: [...fixture.products.values()].filter(product => product.published), candidate: false };
    else if (path === '/api/help') body = { articles: [] };
    else if (path === '/api/staff/users') body = { users: [actor], nextCursor: null };
    else if (path === '/api/sites' || path === '/api/staff/sites') body = { sites: [] };
    else if (path === '/api/staff/inventory') body = { inventory: [] };
    else return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'not_authenticated' }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Staff', exact: true }).click();
  await page.getByRole('button', { name: 'Bundle catalogue', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Revised pricing · 100 GB for US$10', exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('table', { name: 'Revised bundle pricing' }).getByRole('row')).toHaveCount(6);
  await expect(preview).toContainText('75 → 100 GB');
  await expect(preview).toContainText('2 → 5 GB');
  expect(fixture.writes()).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (!backendReady) {
    await expect(preview.getByText('Pricing update requires the service update.', { exact: true })).toBeVisible();
    await expect(preview.getByRole('button', { name: 'Publish revised bundles', exact: true })).toBeDisabled();
    expect(fixture.writes()).toEqual([]);
    return;
  }
  await preview.getByRole('button', { name: 'Publish revised bundles', exact: true }).click();
  await expect(page.getByText('Revised pricing is published: 5, 10, 30, 50 and 100 GB', { exact: false })).toBeVisible();
  await expect(preview.getByRole('button', { name: 'Revised pricing is published', exact: true })).toBeDisabled();
  expect(fixture.writes()).toHaveLength(15);
  await page.reload();
  await page.getByRole('button', { name: 'Staff', exact: true }).click();
  await page.getByRole('button', { name: 'Bundle catalogue', exact: true }).click();
  await expect(preview.getByRole('button', { name: 'Revised pricing is published', exact: true })).toBeDisabled();
  expect(fixture.writes()).toHaveLength(15);
});
