import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import type { Capabilities, Product } from '../src/business';

const plans = [
  { name: 'mini', data: 2, days: 3, cents: 50, price: '$0.50' },
  { name: 'flex', data: 5, days: 7, cents: 100, price: '$1.00' },
  { name: 'week', data: 20, days: 7, cents: 300, price: '$3.00' },
  { name: 'fortnight', data: 35, days: 14, cents: 500, price: '$5.00' },
  { name: 'month', data: 75, days: 30, cents: 1000, price: '$10.00' },
];
const products: Product[] = plans.map(plan => ({
  id: `${plan.name}-v1`,
  byte_limit: String(plan.data * 1_000_000_000),
  validity_seconds: plan.days * 86400,
  price_minor: plan.cents,
  currency: 'USD',
}));

let outputDir: string;
let server: PreviewServer;
let origin: string;
test.beforeAll(async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  outputDir = await mkdtemp(join(tmpdir(), 'pasofi-captive-bundles-'));
  // Build the actual captive assets and use fixture APIs without a router or live services.
  const previousFlag = process.env.VITE_PASOFI_HOTSPOT_PORTAL;
  process.env.VITE_PASOFI_HOTSPOT_PORTAL = '1';
  try {
    await build({ root, build: { outDir: outputDir }, logLevel: 'error' });
  } finally {
    if (previousFlag === undefined) delete process.env.VITE_PASOFI_HOTSPOT_PORTAL;
    else process.env.VITE_PASOFI_HOTSPOT_PORTAL = previousFlag;
  }
  server = await preview({
    root, configFile: false, build: { outDir: outputDir }, logLevel: 'error',
    preview: { host: '127.0.0.1', port: 0 },
  });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw Error('Captive fixture did not bind to loopback');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  await server?.close();
  if (outputDir) await rm(outputDir, { force: true, recursive: true });
});

async function fixture(page: Page) {
  const capabilities: Capabilities = {
    demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: false,
    receiptPairing: false, staffSales: false, deliverySms: false, networkAccess: false, mobileCookies: false,
  };
  const mutations: string[] = [];
  await page.route('**/portal-api/**', route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') {
      mutations.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405, json: { error: 'unexpected_mutation' } });
    }
    if (path === '/portal-api/bundles') return route.fulfill({ json: { products, candidate: false } });
    if (path === '/portal-api/capabilities') return route.fulfill({ json: capabilities });
    if (path === '/portal-api/onesa/availability') return route.fulfill({ json: { origin: 'https://pasofi.example.invalid', hotspotOrigin: origin } });
    if (path === '/portal-api/help') return route.fulfill({ json: { articles: [] } });
    if (path === '/portal-api/sites') return route.fulfill({ json: { sites: [] } });
    if (path === '/portal-api/payments/methods') return route.fulfill({ json: { methods: [] } });
    if (path === '/portal-api/session') return route.fulfill({ status: 401, json: { error: 'not_authenticated' } });
    return route.fulfill({ status: 404, json: { error: 'unexpected_read' } });
  });
  return { capabilities, mutations };
}

test.describe('narrow hotspot catalogue', () => {
  test.use({ isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  for (const { width, cash } of [{ width: 320, cash: false }, { width: 390, cash: true }]) {
    test(`shows all five bundles above the navigation at ${width}×700`, async ({ page }, testInfo) => {
      const { capabilities, mutations } = await fixture(page);
      await page.setViewportSize({ width, height: 700 });
      await page.goto(`${origin}/connect`);
      await page.getByRole('button', { name: 'View bundles', exact: true }).click();
      await expect(page).toHaveURL(/\/#bundles$/);
      await expect(page.getByRole('heading', { name: 'Find your fit.', exact: true })).toBeFocused();

      const catalogue = page.getByRole('region', { name: 'Find your fit.', exact: true });
      const rows = catalogue.getByRole('article');
      const pause = catalogue.getByRole('button', { name: 'Refresh availability' });
      await expect(catalogue.getByText('Purchases paused', { exact: true })).toBeVisible();
      await expect(pause).toHaveCount(1);
      await expect(rows).toHaveCount(5);
      await expect(rows.getByRole('button')).toHaveCount(0);
      for (const plan of plans) {
        const row = rows.filter({ hasText: plan.price });
        await expect(row).toHaveAccessibleName(new RegExp(`^${plan.name}$`, 'i'));
        await expect(row.getByRole('heading')).toHaveText(`${plan.data}GB`);
        await expect(row.getByText(`${plan.days} days`, { exact: true })).toBeVisible();
        await expect(row.getByText('USD', { exact: true })).toBeVisible();
      }

      const expectAllRowsInView = async () => {
        expect(await page.evaluate(() => ({
          scroll: window.scrollY,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
        }))).toEqual({ scroll: 0, overflow: 0 });
        const nav = await page.getByRole('navigation', { name: 'Main navigation' }).boundingBox();
        const bounds = await rows.evaluateAll(items => items.map(item => {
          const box = item.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, overflow: item.scrollWidth - item.clientWidth };
        }));
        expect(bounds).toHaveLength(5);
        for (const row of bounds) {
          expect(row.top).toBeGreaterThanOrEqual(0);
          expect(row.bottom).toBeLessThanOrEqual(nav!.y);
          expect(row.overflow).toBeLessThanOrEqual(0);
        }
      };
      await expectAllRowsInView();
      await page.screenshot({ path: testInfo.outputPath(`captive-bundles-${width}.png`) });

      const options = catalogue.locator('summary');
      const sort = catalogue.getByRole('combobox', { name: 'Sort bundles', exact: true });
      await expect(sort).toBeHidden();
      await options.focus();
      await page.keyboard.press('Enter');
      await expect(sort).toBeVisible();
      await sort.selectOption('price-desc');
      await expect(rows.first()).toHaveAccessibleName(/^month$/i);
      await catalogue.getByRole('button', { name: 'Weekly', exact: true }).click();
      await expect(rows).toHaveCount(2);
      await catalogue.getByRole('button', { name: 'All bundles', exact: true }).click();
      await options.click();

      capabilities.staffSales = cash;
      capabilities.receiptPairing = cash;
      capabilities.paymentCheckout = !cash;
      capabilities.paymentMode = cash ? 'disabled' : 'sandbox';
      await pause.click();
      const action = catalogue.getByRole('button', { name: cash ? 'Buy mini-v1 from an agent' : 'Review mini-v1 bundle' });
      await expect(action).toBeEnabled();
      await expect(rows.getByRole('button')).toHaveCount(5);
      await expectAllRowsInView();
      const target = await action.boundingBox();
      expect(target!.width).toBeGreaterThanOrEqual(44);
      expect(target!.height).toBeGreaterThanOrEqual(44);
      await action.click();
      await expect(page).toHaveURL(cash ? /#receipt\?bundle=mini-v1$/ : /#checkout\?bundle=mini-v1$/);
      expect(mutations).toEqual([]);
    });
  }
});

test('wide hotspot screens retain the full comparison controls and existing availability state', async ({ page }) => {
  const { mutations } = await fixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/connect`);
  const voucher = page.getByRole('region', { name: 'Have a voucher?' });
  await expect(voucher.getByText('Voucher redemption is currently paused.')).toBeVisible();
  await expect(voucher.getByRole('button', { name: 'Redeem voucher' })).toHaveCount(0);
  await page.getByRole('button', { name: 'View bundles', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Find your fit.', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Sort bundles', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'mini-v1 purchasing is not available' })).toBeDisabled();
  expect(mutations).toEqual([]);
});
