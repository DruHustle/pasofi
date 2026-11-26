import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview, type PreviewServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const captive = 'https://hotspot.pasofi.example.invalid';
const canonical = 'https://pasofi.example.invalid';
const state = 'h'.repeat(43);
const authorize = 'https://auth.onesa.eu/authorize?state=' + state;
const account = 'https://account.onesa.eu/register?audience=user&product=pasofi&platform=web&entry=pasofi-hotspot';
const customerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const capabilities = { demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: true,
  receiptPairing: false, staffSales: false, deliverySms: false, networkAccess: false, mobileCookies: false };
let outDir: string;
let server: PreviewServer;
let fixture: string;

test.beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'pasofi-hotspot-web-'));
  const previous = process.env.VITE_PASOFI_HOTSPOT_PORTAL;
  process.env.VITE_PASOFI_HOTSPOT_PORTAL = '1';
  try { await build({ root, logLevel: 'error', build: { outDir } }); }
  finally {
    if (previous === undefined) delete process.env.VITE_PASOFI_HOTSPOT_PORTAL;
    else process.env.VITE_PASOFI_HOTSPOT_PORTAL = previous;
  }
  server = await preview({ root, configFile: false, logLevel: 'error', build: { outDir },
    preview: { host: '127.0.0.1', port: 0 } });
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw Error('Expected isolated loopback preview');
  fixture = 'http://127.0.0.1:' + address.port;
});

test.afterAll(async () => {
  await server?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

test('dedicated Connect signs in directly and resumes verified signup on the same site', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { get: () => false }));
  let enabled = false;
  let signupEnabled = false;
  let completed = false;
  const returns: string[] = [];
  await page.route(captive + '/**', async route => {
    const url = new URL(route.request().url());
    switch (url.pathname) {
      case '/portal-api/onesa/availability':
        return route.fulfill({ json: { origin: canonical, ...(enabled ? { hotspotOrigin: captive } : {}), signup: signupEnabled } });
      case '/portal-api/onesa/start':
        expect(route.request().method()).toBe('POST');
        const input = route.request().postDataJSON();
        returns.push(input.returnTo);
        return route.fulfill({ json: { authorizationUrl: authorize + (input.signup === true ? '&screen_hint=signup' : '') } });
      case '/portal-api/onesa/complete':
        expect(route.request().postDataJSON()).toEqual({ code: 'isolated-code', state });
        completed = true;
        return route.fulfill({ json: { authenticated: true, customerId, returnTo: returns.at(-1) } });
      case '/portal-api/session':
        return completed ? route.fulfill({ json: { customerId } }) : route.fulfill({ status: 401, json: { error: 'not_authenticated' } });
      case '/portal-api/capabilities': return route.fulfill({ json: capabilities });
      case '/portal-api/bundles': return route.fulfill({ json: { candidate: false, products: [
        { id: 'day', label: 'Day pass', price_minor: 100, currency: 'USD', byte_limit: '1000000000', validity_seconds: 86400 },
      ] } });
      case '/portal-api/help': return route.fulfill({ json: { articles: [] } });
      case '/onesa-callback.html':
        return route.fulfill({ response: await page.request.get(fixture + '/hotspot-onesa-callback.html') });
      default:
        if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/portal-api/'))
          return route.fulfill({ status: 404, json: { error: 'not_found' } });
        return route.fulfill({ response: await page.request.get(fixture + url.pathname) });
    }
  });
  await page.route(url => url.origin === 'https://auth.onesa.eu' && url.pathname === '/authorize', route => route.fulfill({ contentType: 'text/html',
    body: '<a href="' + captive + '/onesa-callback.html?code=isolated-code&amp;state=' + state + '">Continue fixture sign-in</a>' }));
  await page.route(account, route => route.fulfill({ contentType: 'text/html',
    body: '<a href="' + captive + '/?registration=complete">Return after fixture registration</a>' }));

  await page.goto(captive + '/connect');
  await expect(page.getByRole('button', { name: 'Retry sign-in' })).toBeVisible();
  expect(returns).toEqual([]);
  enabled = true;
  await page.getByRole('button', { name: 'Retry sign-in' }).click();
  await expect(page.getByRole('heading', { name: 'Connect to PasoFi' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', account);
  await expect(page.getByRole('button', { name: 'View bundles' })).toBeVisible();
  await expect(page.getByText('You appear to be offline.', { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(authorize);
  expect(returns).toEqual(['/connect']);
  await page.getByRole('link', { name: 'Continue fixture sign-in' }).click();
  await expect(page).toHaveURL(captive + '/connect');
  expect(completed).toBe(true);

  completed = false;
  await page.goto(captive + '/connect#bundles');
  await expect(page.getByRole('heading', { name: 'Find your fit.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByText('You appear to be offline.', { exact: false })).toHaveCount(0);
  await page.getByRole('link', { name: 'Create account' }).click();
  await expect(page).toHaveURL(account);
  await page.getByRole('link', { name: 'Return after fixture registration' }).click();
  await expect(page).toHaveURL(authorize);
  expect(returns).toEqual(['/connect', '/connect#bundles']);
  await page.getByRole('link', { name: 'Continue fixture sign-in' }).click();
  await expect(page).toHaveURL(captive + '/connect#bundles');
  expect(completed).toBe(true);

  signupEnabled = true;
  completed = false;
  await page.goto(captive + '/connect#bundles');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page).toHaveURL(authorize + '&screen_hint=signup');
  await page.getByRole('link', { name: 'Continue fixture sign-in' }).click();
  await expect(page).toHaveURL(captive + '/connect#bundles');
  expect(completed).toBe(true);
  signupEnabled = false;

  completed = false;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(captive + '/connect');
  await page.getByRole('region', { name: 'Have a voucher?' }).getByRole('button', { name: 'Redeem voucher' }).click();
  await expect(page).toHaveURL(captive + '/connect#voucher');
  await expect(page.getByRole('textbox', { name: 'Voucher code' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', account);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(authorize);
  expect(returns).toEqual(['/connect', '/connect#bundles', '/connect#bundles', '/connect#voucher']);
  await page.getByRole('link', { name: 'Continue fixture sign-in' }).click();
  await expect(page).toHaveURL(captive + '/connect#voucher');
  expect(completed).toBe(true);
  await page.getByRole('button', { name: 'Close customer workspace' }).click();
  await expect(page).toHaveURL(captive + '/connect');

  completed = false;
  await page.goto(captive + '/onesa-callback.html?error=access_denied&state=' + state);
  await expect(page.getByRole('heading', { name: 'Check your PasoFi access' })).toBeVisible();
  await expect(page).toHaveURL(captive + '/onesa-callback.html');
  await page.getByRole('link', { name: 'Return to PasoFi Wi-Fi' }).click();
  await expect(page.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', account);
  await page.getByRole('button', { name: 'Sign in with a different account' }).click();
  await expect(page).toHaveURL(authorize + '&prompt=login');
  expect(returns.at(-1)).toBe('/connect');
  await page.getByRole('link', { name: 'Continue fixture sign-in' }).click();
  await expect(page).toHaveURL(captive + '/connect');
  expect(completed).toBe(true);
});
