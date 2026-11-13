import { expect, test } from '@playwright/test';

const paused = { demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: false, receiptPairing: false, staffSales: false, deliverySms: false, networkAccess: false, mobileCookies: false };
const bundle = { id: 'flex', price_minor: 100, currency: 'USD', byte_limit: '5000000000', validity_seconds: 86400 };

for (const width of [320, 390, 1280]) test(`Onesa customer entry is discoverable and recovers focus at ${width}px`, async ({ page }, info) => {
  let starts = 0;
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const body = url.pathname === '/api/onesa/availability' ? { origin: url.origin }
      : url.pathname === '/api/capabilities' ? paused
      : url.pathname === '/api/bundles' ? { products: [bundle], candidate: false }
      : url.pathname === '/api/help' ? { articles: [] } : { error: 'unavailable' };
    if (url.pathname === '/api/onesa/start') starts++;
    return route.fulfill({ status: url.pathname === '/api/onesa/start' ? 503 : url.pathname === '/api/session' ? 401 : 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.setViewportSize({ width, height: 900 }); await page.goto('/');
  const entry = page.getByRole('button', { name: 'Sign in with Onesa', exact: true });
  await expect(entry).toHaveCount(1); await expect(entry).toBeInViewport();
  await entry.click();
  await expect(page.getByRole('heading', { name: 'Continue to your Onesa account' })).toBeFocused();
  await expect(page.getByText(/Guest purchases stay with your guest account/)).toBeVisible();
  expect(starts).toBe(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(entry).toBeFocused(); await expect(entry).toHaveAttribute('aria-expanded', 'false');
  await entry.click(); await page.getByRole('button', { name: 'Continue with Onesa', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Onesa sign-in is temporarily unavailable');
  await expect(page.getByRole('button', { name: 'Continue with Onesa', exact: true })).toBeEnabled();
  expect(starts).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`customer-entry-${width}.png`), fullPage: true });
});

test('configured signup starts the PasoFi interaction and retains the requested account screen', async ({ page }) => {
  let starts = 0;
  let releaseAvailability!: () => void;
  const waiting = new Promise<void>(resolve => {releaseAvailability = resolve;});
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/onesa/start') {
      starts++;
      expect(route.request().postDataJSON()).toEqual({returnTo:'/#account'});
      return route.fulfill({json:{authorizationUrl:'https://portal-signup.example.invalid/authorize'}});
    }
    if (url.pathname === '/api/onesa/availability') await waiting;
    const body = url.pathname === '/api/onesa/availability' ? {origin:url.origin}
      : url.pathname === '/api/capabilities' ? paused : url.pathname === '/api/bundles' ? {products:[],candidate:false}
      : {error:'not_authenticated'};
    return route.fulfill({status:url.pathname === '/api/session' ? 401 : 200,json:body});
  });
  await page.route('https://portal-signup.example.invalid/**', route => route.fulfill({body:'Test Company Portal issuer'}));
  await page.goto('/#account');
  await expect(page.getByText('Checking Company Portal sign-in…')).toBeVisible();
  await expect(page.getByRole('link', {name:'Create an Onesa account'})).toHaveCount(0);
  releaseAvailability();
  const signup = page.getByRole('button', {name:'Create an Onesa account',exact:true});
  await signup.click();
  await page.getByRole('button', {name:'Cancel',exact:true}).click();
  await expect(signup).toBeFocused();
  await signup.click();
  await page.getByRole('button', {name:'Continue with Onesa',exact:true}).click();
  await expect(page).toHaveURL('https://portal-signup.example.invalid/authorize');
  expect(starts).toBe(1);
});

test('unverified availability cannot enable a published bundle and an explicit refresh recovers', async ({ page }) => {
  let available = false;
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const body = path === '/api/onesa/availability' ? { origin: null }
      : path === '/api/capabilities' ? { ...paused, staffSales: available }
      : path === '/api/bundles' ? { products: [bundle], candidate: false }
      : path === '/api/help' ? { articles: [] } : { error: 'not_authenticated' };
    return route.fulfill({ status: path === '/api/capabilities' && !available ? 503 : path === '/api/session' ? 401 : 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/#bundles');
  await expect(page.getByText('Purchase availability is not confirmed', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'flex purchasing is not available' })).toBeDisabled();
  available = true;
  await page.getByRole('button', { name: 'Refresh availability', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Buy flex from an agent', exact: true })).toBeEnabled();
  await expect(page.getByText('Purchase availability is not confirmed', { exact: true })).toHaveCount(0);
});

for (const label of ['Sign in with Onesa', 'Create an Onesa account']) test(`staff ${label} clears the purpose of an abandoned customer flow before starting`, async ({ page, baseURL }) => {
  // Preserve production's HTTPS requirement while serving this test's local UI.
  // No request reaches the reserved example hostname.
  await page.route('https://pasofi-entry.example.invalid/**', async route => {
    const target = new URL(route.request().url()), local = new URL(baseURL!);
    target.protocol = local.protocol; target.host = local.host;
    await route.fulfill({ response: await page.request.get(target.href) });
  });
  await page.addInitScript(() => sessionStorage.setItem('pasofi-onesa-customer', '1'));
  let starts = 0;
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/staff/onesa/start') {
      expect(await page.evaluate(() => sessionStorage.getItem('pasofi-onesa-customer'))).toBeNull();
      starts++;
      return route.fulfill({ status: 503, json: { error: 'onesa_unavailable' } });
    }
    const body = url.pathname === '/api/staff/onesa/availability' ? { origin: url.origin }
      : url.pathname === '/api/onesa/availability' ? { origin: null }
      : url.pathname === '/api/capabilities' ? paused
      : url.pathname === '/api/bundles' ? { products: [], candidate: false }
      : url.pathname === '/api/help' ? { articles: [] } : { error: 'not_authenticated' };
    return route.fulfill({ status: url.pathname === '/api/staff/session' ? 401 : 200, json: body });
  });
  await page.goto('https://pasofi-entry.example.invalid/#staff');
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect.poll(() => starts).toBe(1);
  await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
});

test('production account and staff entry use Portal when federation is unavailable', async ({ page }) => {
  let credentialWrites = 0;
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'POST') credentialWrites++;
    return route.fulfill({ status: path.endsWith('/session') ? 401 : 200,
      json: path === '/api/capabilities' ? paused : path.endsWith('/availability') ? { origin: null } : {} });
  });
  for (const hash of ['#account', '#staff?apply=1']) {
    await page.goto('/' + hash);
    const scope = hash.startsWith('#staff') ? page.getByRole('region', { name: 'Staff workspace' }) : page;
    await expect(scope.getByRole('link',{name:'Create an Onesa account'})).toHaveAttribute('href','https://portal.onesa.eu/account/register');
    await expect(scope.getByRole('link',{name:'Sign in to Company Portal'})).toHaveAttribute('href','https://portal.onesa.eu/account');
    await expect(scope.getByRole('button',{name:'Start a new customer account'})).toHaveCount(0);
    await expect(scope.locator('input[type="password"]')).toHaveCount(0);
  }
  expect(credentialWrites).toBe(0);
});

test('a gateway outage still offers Company Portal sign-in and signup on the account and staff screens', async ({page}) => {
  let writes = 0;
  await page.route('**/api/**', route => {
    if (route.request().method() !== 'GET') writes++;
    return route.fulfill({status:503,json:{error:'api_unconfigured'}});
  });
  for (const hash of ['#account','#staff?apply=1']) {
    await page.goto('/'+hash);
    const scope = hash.startsWith('#staff') ? page.getByRole('region',{name:'Staff workspace'}) : page.getByRole('main');
    await expect(scope.getByRole('link',{name:'Sign in to Company Portal',exact:true})).toHaveAttribute('href','https://portal.onesa.eu/account');
    await expect(scope.getByRole('link',{name:'Create an Onesa account',exact:true})).toHaveAttribute('href','https://portal.onesa.eu/account/register');
    await expect(scope.locator('input[type="password"]')).toHaveCount(0);
  }
  expect(writes).toBe(0);
});

test('a customer signing in at the hotspot welcome returns to the welcome screen', async ({ page, baseURL }) => {
  let returnTo: string | undefined;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/onesa/start') {
      returnTo = route.request().postDataJSON().returnTo;
      return route.fulfill({ json: { authorizationUrl: 'https://portal.example.invalid/authorize' } });
    }
    const customerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const body = path === '/api/onesa/complete' ? { authenticated: true, returnTo, customerId }
      : path === '/api/session' ? { customerId }
      : path === '/api/onesa/availability' ? { origin: new URL(route.request().url()).origin }
      : path === '/api/capabilities' ? paused : path === '/api/help' ? { articles: [] } : { products: [] };
    return route.fulfill({ json: body });
  });
  await page.route('https://portal.example.invalid/authorize', route =>
    route.fulfill({ status: 302, headers: { Location: new URL('/onesa-callback.html?code=test&state=test', baseURL).href } }));
  await page.goto('/connect');
  await page.getByRole('button', { name: 'Sign in with Onesa', exact: true }).click();
  await page.getByRole('button', { name: 'Continue with Onesa', exact: true }).click();
  await expect.poll(() => returnTo).toBe('/#connect');
  await expect(page).toHaveURL(/\/#connect$/);
  await expect(page.getByRole('button', { name: 'My WiFi', exact: true })).toBeVisible();
});
