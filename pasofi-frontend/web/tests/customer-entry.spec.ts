import { expect, test } from '@playwright/test';

const paused = { demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: false, receiptPairing: false, staffSales: false, deliverySms: false, networkAccess: false, mobileCookies: false };
const bundle = { id: 'flex', price_minor: 100, currency: 'USD', byte_limit: '5000000000', validity_seconds: 86400 };

for (const width of [320, 390, 1280]) test(`Onesa customer entry starts sign-in in one click and can retry at ${width}px`, async ({ page }, info) => {
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
  const entry = page.getByRole('button', { name: 'Sign in', exact: true });
  await expect(entry).toHaveCount(1); await expect(entry).toBeInViewport();
  await entry.click();
  await expect(page.getByRole('alert')).toContainText('Sign-in is temporarily unavailable');
  await expect(entry).toBeEnabled();
  expect(starts).toBe(1);
  await entry.click();
  await expect.poll(() => starts).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`customer-entry-${width}.png`), fullPage: true });
});

test('central signup stays separate from the PasoFi interaction that returns to the account screen', async ({ page }) => {
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
  await expect(page.getByText('Checking sign-in…')).toBeVisible();
  await expect(page.getByRole('link', {name:'Create account'})).toHaveCount(0);
  releaseAvailability();
  const signup = page.getByRole('link', {name:'Create account',exact:true});
  await expect(signup).toHaveAttribute('href','https://account.onesa.eu/register?audience=user&product=pasofi&platform=web');
  expect(await signup.getAttribute('target')).toBeNull();
  const origin=new URL(page.url()).origin;
  await page.route('https://account.onesa.eu/**', route=>route.fulfill({contentType:'text/html',body:'<a href="'+origin+'/?registration=complete">Back to PasoFi</a>'}));
  await signup.click();
  await page.getByRole('link',{name:'Back to PasoFi'}).click();
  await expect(page).toHaveURL('https://portal-signup.example.invalid/authorize');
  expect(starts).toBe(1);
  await page.goto('/#account');
  const signIn = page.getByRole('button', {name:'Sign in',exact:true});
  await signIn.click();
  await expect(page).toHaveURL('https://portal-signup.example.invalid/authorize');
  expect(starts).toBe(2);
});

test('home sign-in returns to Home and links guest purchases only on request', async ({ page }) => {
  const starts: unknown[] = [];
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/onesa/start') {
      starts.push(route.request().postDataJSON());
      return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    }
    return route.fulfill({ json: url.pathname === '/api/onesa/availability' ? { origin: url.origin }
      : url.pathname === '/api/capabilities' ? paused
      : url.pathname === '/api/bundles' ? { products: [] }
      : url.pathname === '/api/session' ? { guest: true } : { articles: [] } });
  });
  await page.goto('/');
  const keepPurchases = page.getByRole('button', { name: 'Keep guest purchases', exact: true });
  await expect(keepPurchases).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(keepPurchases).toBeEnabled();
  await keepPurchases.click();
  await expect.poll(() => starts).toEqual([{ returnTo: '/#home' }, { returnTo: '/#home', claimGuest: true }]);
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

test('staff sign-in clears an abandoned customer flow and signup has its own administrator entry', async ({ page, baseURL }) => {
  const label = 'Sign in';
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
  await expect(page.getByRole('link', {name:'Request administrator access'})).toHaveAttribute('href','https://account.onesa.eu/register?audience=admin&product=pasofi&platform=web');
  const staffSignIn = page.getByRole('region', { name: 'Staff workspace' }).getByRole('button', { name: label, exact: true });
  await staffSignIn.click();
  await expect.poll(() => starts).toBe(1);
  await expect(staffSignIn).toBeEnabled();
});

test('customer entry and staff access remain fail-closed when Identity is unavailable', async ({ page }) => {
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
    await expect(scope.getByRole('link',{name:hash.startsWith('#staff') ? 'Request administrator access' : 'Create account'})).toHaveAttribute('href','https://account.onesa.eu/register?audience=' + (hash.startsWith('#staff') ? 'admin' : 'user') + '&product=pasofi&platform=web');
    if (hash.startsWith('#staff')) {
      await expect(scope.getByText('Onesa Identity sign-in is not connected to this PasoFi service yet. PasoFi access remains disabled until the connection is configured.')).toBeVisible();
      await expect(scope.getByRole('link',{name:'Sign in to Company Portal'})).toHaveCount(0);
    } else {
      await expect(scope.getByRole('button',{name:'Retry sign-in'})).toBeVisible();
      await expect(scope.getByText(/Sign-in is unavailable/)).toBeVisible();
      await expect(scope.getByRole('link',{name:'Sign in to Company Portal'})).toHaveCount(0);
    }
    await expect(scope.getByRole('button',{name:'Start a new customer account'})).toHaveCount(0);
    await expect(scope.locator('input[type="password"]')).toHaveCount(0);
  }
  expect(credentialWrites).toBe(0);
});

test('a gateway outage keeps customer and staff Identity access fail-closed', async ({page}) => {
  let writes = 0;
  await page.route('**/api/**', route => {
    if (route.request().method() !== 'GET') writes++;
    return route.fulfill({status:503,json:{error:'api_unconfigured'}});
  });
  for (const hash of ['#account','#staff?apply=1']) {
    await page.goto('/'+hash);
    const scope = hash.startsWith('#staff') ? page.getByRole('region',{name:'Staff workspace'}) : page.getByRole('main');
    if (hash.startsWith('#staff')) {
      await expect(scope.getByText('Onesa Identity sign-in is not connected to this PasoFi service yet. PasoFi access remains disabled until the connection is configured.')).toBeVisible();
      await expect(scope.getByRole('link',{name:'Sign in to Company Portal',exact:true})).toHaveCount(0);
    } else {
      await expect(scope.getByRole('button',{name:'Retry sign-in',exact:true})).toBeVisible();
      await expect(scope.getByRole('link',{name:'Sign in to Company Portal',exact:true})).toHaveCount(0);
    }
    await expect(scope.getByRole('link',{name:hash.startsWith('#staff') ? 'Request administrator access' : 'Create account',exact:true})).toHaveAttribute('href','https://account.onesa.eu/register?audience=' + (hash.startsWith('#staff') ? 'admin' : 'user') + '&product=pasofi&platform=web');
    await expect(scope.locator('input[type="password"]')).toHaveCount(0);
  }
  expect(writes).toBe(0);
});

test('a customer signing in at the hotspot welcome returns to the welcome screen', async ({ page, baseURL }) => {
  let returnTo: string | undefined;
  const state = 'c'.repeat(43);
  const authorize = 'https://portal.example.invalid/authorize?state=' + state;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/onesa/start') {
      returnTo = route.request().postDataJSON().returnTo;
      return route.fulfill({ json: { authorizationUrl: authorize } });
    }
    const customerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const body = path === '/api/onesa/complete' ? { authenticated: true, returnTo, customerId }
      : path === '/api/session' ? { customerId }
      : path === '/api/onesa/availability' ? { origin: new URL(route.request().url()).origin }
      : path === '/api/capabilities' ? paused : path === '/api/help' ? { articles: [] } : { products: [] };
    return route.fulfill({ json: body });
  });
  await page.route(authorize, route =>
    route.fulfill({contentType:'text/html',body:'<script>location.replace('+JSON.stringify(new URL('/onesa-callback.html?code=test&state=' + state,baseURL).href)+')</script>'}));
  await page.goto('/connect');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect.poll(() => returnTo).toBe('/#connect');
  await expect(page).toHaveURL(/\/#connect$/);
  await expect(page.getByRole('button', { name: 'My WiFi', exact: true })).toBeVisible();
});

test('a staff callback shows its own recovery page even after a customer sign-in starts', async ({ page }) => {
  const state = 's'.repeat(43);
  await page.addInitScript(state => {
    sessionStorage.setItem('pasofi-onesa-flow:' + state, JSON.stringify({
      staff: true, returnTo: '/#staff', expires: Date.now() + 300000,
    }));
    sessionStorage.setItem('pasofi-onesa-customer', '1');
  }, state);
  let endpoint: string | undefined;
  await page.route('**/api/**', route => {
    endpoint = new URL(route.request().url()).pathname;
    return route.fulfill({ status: 401, json: { error: 'onesa_sign_in_rejected' } });
  });
  await page.goto('/onesa-callback.html?code=fixture&state=' + state);
  await expect(page.getByRole('heading', { name: 'Staff sign-in needs attention' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to PasoFi Staff' })).toHaveAttribute('href', '/#staff');
  await expect(page.getByRole('link', { name: 'Check your Onesa access' })).toBeVisible();
  await expect(page).toHaveURL(/\/onesa-callback\.html$/);
  expect(endpoint).toBe('/api/staff/onesa/complete');
});
