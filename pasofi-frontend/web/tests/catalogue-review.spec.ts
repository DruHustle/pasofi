import { test, expect, type Page } from '@playwright/test';
import type { Product } from '../src/business';

const product = (id: string, price: number, bytes: string, days: number, currency = 'USD'): Product => ({
  id, price_minor: price, byte_limit: bytes, validity_seconds: days * 86400, currency,
});
const catalogue = [
  product('month', 1000, '75000000000', 30),
  product('large-low', 1500, '9007199254740992', 2),
  product('day', 25, '1000000000', 1),
  product('large-high', 2000, '9007199254740993', 14),
  product('week', 100, '5000000000', 7),
];

/** Isolated catalogue responses: no accounts, purchases or live services. */
async function fixture(page: Page, products = catalogue) {
  const state = { products, failed: false, mutations: [] as string[], unexpected: [] as string[] };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() !== 'GET') {
      state.mutations.push(`${request.method()} ${path}`);
      return reply({ error: 'unexpected_mutation' }, 405);
    }
    if (path === '/api/bundles') return state.failed ? reply({ error: 'temporarily_unavailable' }, 503) : reply({ products: state.products, candidate: false });
    if (path === '/api/capabilities') return reply({ demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: true, receiptPairing: true, staffSales: true, deliverySms: false, networkAccess: false, mobileCookies: false });
    if (path === '/api/help') return reply({ articles: [] });
    if (path === '/api/session') return reply({ error: 'not_authenticated' }, 401);
    if (path === '/api/sites') return reply({ sites: [] });
    if (path === '/api/network/sites') return reply({ accessPoints: [] });
    state.unexpected.push(`${request.method()} ${path}`);
    return reply({ error: 'unexpected_request' }, 500);
  });
  return state;
}

const names = (page: Page) => page.locator('.pf-bundle-card .pf-plan-name');
const count = (page: Page) => page.locator('.pf-result-count');
const sort = (page: Page) => page.getByRole('combobox', { name: 'Sort bundles', exact: true });
const filters = (page: Page) => page.getByRole('group', { name: 'Bundle duration' });
const refresh = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Bundles', exact: true }).click();

test('customers can compare exact published prices, byte allowances and validity without a fabricated recommendation', async ({ page }) => {
  const state = await fixture(page); await page.goto('/#bundles');
  await expect(count(page)).toHaveText('Showing 5 of 5 bundles');
  await expect(names(page)).toHaveText(['month', 'large low', 'day', 'large high', 'week']);
  await expect(page.getByText('Our pick', { exact: true })).toHaveCount(0);

  for (const [value, expected] of [
    ['price-asc', ['day', 'week', 'month', 'large low', 'large high']],
    ['price-desc', ['large high', 'large low', 'month', 'week', 'day']],
    ['data-desc', ['large high', 'large low', 'month', 'week', 'day']],
    ['data-asc', ['day', 'week', 'month', 'large low', 'large high']],
    ['validity-asc', ['day', 'large low', 'week', 'large high', 'month']],
    ['validity-desc', ['month', 'large high', 'week', 'large low', 'day']],
    ['published', ['month', 'large low', 'day', 'large high', 'week']],
  ] as const) {
    await sort(page).selectOption(value);
    await expect(names(page)).toHaveText([...expected]);
  }
  // Adjacent amounts above Number.MAX_SAFE_INTEGER must retain their true order.
  await sort(page).selectOption('data-desc');
  await expect(names(page).first()).toHaveText('large high');
  await filters(page).getByRole('button', { name: 'Weekly', exact: true }).click();
  await expect(names(page)).toHaveText(['week']);
  await expect(count(page)).toHaveText('Showing 1 of 5 bundles');
  await expect(page.getByRole('button', { name: 'Buy week from an agent', exact: true })).toBeEnabled();
  await expect(page.locator('.pf-bundle-card .pf-bundle-price strong')).toHaveText('$1.00');
  expect(state.mutations).toEqual([]); expect(state.unexpected).toEqual([]);
});

test('catalogue refresh preserves sorting and a valid duration, then safely falls back when offers disappear', async ({ page }) => {
  const day = product('day', 25, '1000000000', 1);
  const weekLow = product('week-low', 100, '5000000000', 7);
  const weekHigh = product('week-high', 200, '10000000000', 7);
  const month = product('month', 1000, '75000000000', 30);
  const state = await fixture(page, [weekLow, day, weekHigh]); await page.goto('/#bundles');
  await filters(page).getByRole('button', { name: 'Weekly', exact: true }).click();
  await sort(page).selectOption('price-desc');
  await expect(names(page)).toHaveText(['week high', 'week low']);

  state.products = [day, { ...weekLow, price_minor: 75 }, weekHigh]; await refresh(page);
  await expect(filters(page).getByRole('button', { name: 'Weekly', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(sort(page)).toHaveValue('price-desc');
  await expect(count(page)).toHaveText('Showing 2 of 3 bundles');
  await expect(names(page)).toHaveText(['week high', 'week low']);
  await expect(page.locator('.pf-bundle-card .pf-bundle-price strong')).toHaveText(['$2.00', '$0.75']);

  state.products = [day, month]; await refresh(page);
  await expect(filters(page).getByRole('button', { name: 'All bundles', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(filters(page).getByRole('button', { name: 'Weekly', exact: true })).toHaveCount(0);
  await expect(names(page)).toHaveText(['month', 'day']);
  await expect(count(page)).toHaveText('Showing 2 of 2 bundles');

  state.products = []; await refresh(page);
  await expect(count(page)).toHaveText('Showing 0 of 0 bundles');
  await expect(sort(page)).toBeDisabled();
  await expect(page.getByText('No bundles are published yet. Check back when PasoFi launches.', { exact: true })).toBeVisible();
  await expect(names(page)).toHaveCount(0);

  state.products = [day, month]; await page.getByRole('button', { name: 'Refresh availability', exact: true }).click();
  await expect(sort(page)).toHaveValue('price-desc');
  await expect(names(page)).toHaveText(['month', 'day']);
  expect(state.mutations).toEqual([]); expect(state.unexpected).toEqual([]);
});

test('a catalogue error has a safe retry and does not leave stale results or an enabled sort', async ({ page }) => {
  const state = await fixture(page); await page.goto('/#bundles');
  await sort(page).selectOption('validity-desc');
  state.failed = true; await refresh(page);
  await expect(page.getByRole('button', { name: 'Retry bundles', exact: true })).toBeVisible();
  await expect(names(page)).toHaveCount(0); await expect(count(page)).toHaveCount(0);
  await expect(sort(page)).toBeDisabled();
  state.failed = false; await page.getByRole('button', { name: 'Retry bundles', exact: true }).click();
  await expect(sort(page)).toHaveValue('validity-desc');
  await expect(names(page)).toHaveText(['month', 'large high', 'week', 'large low', 'day']);
  expect(state.mutations).toEqual([]); expect(state.unexpected).toEqual([]);
});

test('price comparison groups currencies instead of treating their face values as equivalent', async ({ page }) => {
  const state = await fixture(page, [
    product('zar-high', 1500, '5000000000', 7, 'ZAR'),
    product('usd-high', 500, '5000000000', 7),
    product('zar-low', 1000, '2000000000', 7, 'ZAR'),
    product('usd-low', 100, '2000000000', 7),
  ]);
  await page.goto('/#bundles'); await sort(page).selectOption('price-asc');
  await expect(names(page)).toHaveText(['usd low', 'usd high', 'zar low', 'zar high']);
  await expect(page.getByText('Prices are grouped by currency, then sorted within each currency.', { exact: true })).toBeVisible();
  state.products = state.products.filter(item => item.currency === 'USD'); await refresh(page);
  await expect(names(page)).toHaveText(['usd low', 'usd high']);
  await expect(page.locator('.pf-sort-note')).toHaveCount(0);
  expect(state.mutations).toEqual([]);
});

for (const width of [320, 390, 1280]) {
  test(`catalogue comparison controls and supporting text remain usable at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await fixture(page, catalogue.filter(item => !item.id.startsWith('large-')));
    await page.setViewportSize({ width, height: 844 }); await page.goto('/#bundles');
    await expect(count(page)).toHaveText('Showing 3 of 3 bundles');
    await sort(page).focus(); await expect(sort(page)).toBeFocused();
    await sort(page).selectOption('price-asc');
    await expect(names(page)).toHaveText(['day', 'week', 'month']);
    for (const control of [sort(page), filters(page).getByRole('button', { name: 'All bundles', exact: true }), page.getByRole('button', { name: 'Buy day from an agent', exact: true })]) {
      const box = await control.boundingBox(); expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    for (const selector of ['.pf-validity', '.pf-bundle-price > span', '.pf-bundle-terms p', '.pf-catalogue-caption']) {
      expect(await page.locator(selector).first().evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
    }
    await page.screenshot({ path: testInfo.outputPath(`catalogue-${width}.png`), fullPage: true });
    if (width !== 320) {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Your internet. Your everyday.', exact: true })).toBeVisible();
      await expect(names(page)).toHaveCount(3);
      await page.screenshot({ path: testInfo.outputPath(`home-${width}.png`), fullPage: true });
    }
    expect(errors).toEqual([]);
  });
}

test('desktop tagline and navigation title meet normal-text contrast on their actual backgrounds', async ({ page }) => {
  await fixture(page); await page.setViewportSize({ width: 1280, height: 900 }); await page.goto('/#bundles');
  for (const selector of ['.pf-header-tagline', '.pf-nav-title']) {
    const ratio = await page.locator(selector).evaluate(element => {
      const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      const luminance = (color: number[]) => color.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
      let parent: Element | null = element, background = 'rgb(255, 255, 255)';
      while (parent) {
        const candidate = getComputedStyle(parent).backgroundColor;
        if (candidate !== 'rgba(0, 0, 0, 0)' && candidate !== 'transparent') { background = candidate; break; }
        parent = parent.parentElement;
      }
      const foreground = luminance(rgb(getComputedStyle(element).color)), surface = luminance(rgb(background));
      return (Math.max(foreground, surface) + 0.05) / (Math.min(foreground, surface) + 0.05);
    });
    expect(ratio, `${selector} normal-text contrast`).toBeGreaterThanOrEqual(4.5);
  }
});

test('home actions and heading retain readable contrast', async ({ page }) => {
  await fixture(page); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your internet. Your everyday.' })).toBeVisible();
  for (const [foreground, background] of [
    ['#home-hero-heading', '.pasofi-home-hero'],
    ['#home-hero-heading em', '.pasofi-home-hero'],
    ...[1, 2, 3, 4].map(n => [`.pf-quick-actions button:nth-child(${n}) strong`, `.pf-quick-actions button:nth-child(${n})`]),
  ]) {
    const colors = await page.evaluate(([fg, bg]) => [getComputedStyle(document.querySelector(fg)!).color, getComputedStyle(document.querySelector(bg)!).backgroundColor], [foreground, background]);
    const lum = (value: string) => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
    const [a, b] = colors.map(lum), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    expect(ratio, `${foreground} against ${background}`).toBeGreaterThanOrEqual(4.5);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('support and published service policies remain reachable directly and from the footer', async ({ page }) => {
  await fixture(page); await page.goto('/#help');
  await expect(page.getByRole('link', { name: '+263 715 092 221' })).toHaveAttribute('href', 'tel:+263715092221');
  await page.getByRole('link', { name: 'Service terms' }).click();
  await expect(page.getByRole('heading', { name: 'Service terms', exact: true })).toBeVisible();
  await expect(page.getByText('Operated by Onesa', { exact: true })).toBeVisible();
  await expect(page.getByText('3964 98th Crescent Kuwadzana 5', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Privacy', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Privacy information' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Privacy information' })).toBeVisible();
});

for (const width of [320, 390, 1280]) {
  test(`all five offers are easy to compare with a compact homepage at ${width}px`, async ({ page }, testInfo) => {
    await fixture(page, [product('mini',50,'5000000000',3), product('flex',100,'10000000000',7), product('week',300,'30000000000',7), product('fortnight',500,'50000000000',14), product('month',1000,'100000000000',30)]);
    await page.setViewportSize({width,height:844}); await page.goto('/');
    await expect(names(page)).toHaveCount(5);
    const cards = page.locator('.pf-bundle-card');
    const first = await cards.first().boundingBox(), last = await cards.last().boundingBox();
    await expect(page.locator('.pasofi-home-hero')).toBeVisible();
    expect(first!.y, 'first offer should follow the compact photo hero in the first viewport').toBeLessThan(800);
    expect(last!.y + last!.height, 'the photo hero and five compact offers should need at most one short scroll').toBeLessThan(width >= 1000 ? 1140 : 1350);
    for (const card of await cards.all()) {
      const box = await card.boundingBox(); expect(box!.height).toBeLessThan(125);
      const button = await card.getByRole('button').boundingBox(); expect(button!.height).toBeGreaterThanOrEqual(44); expect(button!.width).toBeGreaterThanOrEqual(44);
    }
    await expect(cards.last().locator('h3')).toHaveText('100GB');
    await expect(cards.last().locator('.pf-bundle-price strong')).toHaveText('$10.00');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`compact-home-${width}.png`),fullPage:true});
  });
}
