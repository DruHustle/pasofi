import { expect, test } from '@playwright/test';

const paused = { demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: false, receiptPairing: false, staffSales: false, deliverySms: false, networkAccess: false, mobileCookies: false };
const bundle = { id: 'flex', price_minor: 100, currency: 'USD', byte_limit: '5000000000', validity_seconds: 86400 };

for (const width of [320, 390, 1280]) test(`customer sign-in opens directly and can be retried at ${width}px`, async ({ page }, info) => {
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
  await page.setViewportSize({ width, height: 900 }); await page.goto('/#account');
  const entry = page.getByRole('button', { name: 'Sign in', exact: true });
  await expect(entry).toHaveCount(1); await expect(entry).toBeInViewport();
  await entry.click();
  await expect(page.getByRole('alert')).toContainText('Sign-in is temporarily unavailable');
  await expect(entry).toBeEnabled();
  expect(starts).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`customer-entry-${width}.png`), fullPage: true });
});

test('one Sign in entry goes straight to the provider and back without Onesa Account', async ({ page }) => {
  let starts = 0;
  let releaseAvailability!: () => void;
  const waiting = new Promise<void>(resolve => {releaseAvailability = resolve;});
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/onesa/start') {
      starts++;
      expect(route.request().postDataJSON()).toEqual({returnTo:'/#account'});
      return route.fulfill({json:{authorizationUrl:'https://auth.example.invalid/authorize'}});
    }
    if (url.pathname === '/api/onesa/availability') await waiting;
    const body = url.pathname === '/api/onesa/availability' ? {origin:url.origin}
      : url.pathname === '/api/capabilities' ? paused : url.pathname === '/api/bundles' ? {products:[],candidate:false}
      : {error:'not_authenticated'};
    return route.fulfill({status:url.pathname === '/api/session' ? 401 : 200,json:body});
  });
  await page.route('https://auth.example.invalid/**', route => route.fulfill({body:'Test sign-in and sign-up page'}));
  await page.goto('/#account');
  await expect(page.getByRole('heading', { name: 'Your account', exact: true })).toBeVisible();
  await expect(page.getByRole('button', {name:'Sign in',exact:true})).toHaveCount(0);
  releaseAvailability();
  const signIn = page.getByRole('button', {name:'Sign in',exact:true});
  await expect(signIn).toBeVisible();
  await expect(page.getByText('New to PasoFi. Sign up.', { exact: true })).toBeVisible();
  await expect(page.locator('a[href*="account.onesa.eu"]')).toHaveCount(0);
  await expect(page.getByRole('link', {name:'Sign up'})).toHaveCount(0);
  await signIn.click();
  await expect(page).toHaveURL('https://auth.example.invalid/authorize');
  expect(starts).toBe(1);
});

test('one Sign in stays the only customer entry even when the service offers direct sign-up', async ({ page }) => {
  const starts: unknown[] = [];
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/onesa/availability') return route.fulfill({ json: { origin: url.origin, signup: true } });
    if (url.pathname === '/api/onesa/start') {
      starts.push(route.request().postDataJSON());
      return route.fulfill({ json: { authorizationUrl: 'https://auth.example.invalid/authorize' } });
    }
    if (url.pathname === '/api/session') return route.fulfill({ status: 401, json: { error: 'not_authenticated' } });
    if (url.pathname === '/api/capabilities') return route.fulfill({ json: paused });
    return route.fulfill({ json: url.pathname === '/api/help' ? { articles: [] } : { products: [], candidate: false } });
  });
  await page.route('https://auth.example.invalid/**', route => route.fulfill({ body: 'Sign in or sign up' }));
  await page.goto('/#account');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign up', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('https://auth.example.invalid/authorize');
  expect(starts).toEqual([{ returnTo: '/#account' }]);
});

test('normal sign-in and keeping guest purchases send distinct requests', async ({ page }) => {
  const starts: unknown[] = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/onesa/start') {
      starts.push(route.request().postDataJSON());
      return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    }
    if (path === '/api/onesa/availability') return route.fulfill({ json: { origin: new URL(route.request().url()).origin } });
    if (path === '/api/session') return route.fulfill({ json: { customerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', guest: true } });
    if (path === '/api/capabilities') return route.fulfill({ json: paused });
    if (path === '/api/help') return route.fulfill({ json: { articles: [] } });
    return route.fulfill({ json: { products: [], candidate: false } });
  });
  await page.goto('/#account');
  const keepPurchases = page.getByRole('button', { name: 'Keep guest purchases', exact: true });
  await expect(keepPurchases).toBeVisible();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Sign-in is temporarily unavailable. Please try again.')).toBeVisible();
  await keepPurchases.click();
  await expect.poll(() => starts).toEqual([{ returnTo: '/#account' }, { returnTo: '/#account', claimGuest: true }]);
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
  await expect(page.getByRole('link', {name:'Request administrator access'})).toHaveAttribute('href','https://account.onesa.eu/access?product=pasofi&role=administrator');
  await page.getByRole('button', { name: label, exact: true }).click();
  await expect.poll(() => starts).toBe(1);
  await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
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
    if (hash.startsWith('#staff')) await expect(scope.getByRole('link',{name:'Request administrator access'})).toHaveAttribute('href','https://account.onesa.eu/access?product=pasofi&role=administrator');
    else await expect(scope.locator('a[href*="account.onesa.eu/register"]')).toHaveCount(0);
    if (hash.startsWith('#staff')) {
      await expect(scope.getByText('Staff sign-in is temporarily unavailable.')).toBeVisible();
      await expect(scope.getByRole('link',{name:'Sign in to Company Portal'})).toHaveCount(0);
    } else {
      await expect(scope.getByRole('button',{name:'Retry sign-in'})).toBeVisible();
      await expect(scope.getByText(/Sign-in unavailable/)).toBeVisible();
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
      await expect(scope.getByText('Staff sign-in is temporarily unavailable.')).toBeVisible();
      await expect(scope.getByRole('link',{name:'Sign in to Company Portal',exact:true})).toHaveCount(0);
    } else {
      await expect(scope.getByRole('button',{name:'Retry sign-in',exact:true})).toBeVisible();
      await expect(scope.getByRole('link',{name:'Sign in to Company Portal',exact:true})).toHaveCount(0);
    }
    if (hash.startsWith('#staff')) await expect(scope.getByRole('link',{name:'Request administrator access',exact:true})).toHaveAttribute('href','https://account.onesa.eu/access?product=pasofi&role=administrator');
    else await expect(scope.locator('a[href*="account.onesa.eu/register"]')).toHaveCount(0);
    await expect(scope.locator('input[type="password"]')).toHaveCount(0);
  }
  expect(writes).toBe(0);
});

test('a customer signing in at the hotspot welcome returns to the welcome screen', async ({ page, baseURL }) => {
  let returnTo: string | undefined;
  let signedIn = false;
  const state = 'c'.repeat(43);
  const authorize = 'https://portal.example.invalid/authorize?state=' + state;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/onesa/start') {
      returnTo = route.request().postDataJSON().returnTo;
      return route.fulfill({ json: { authorizationUrl: authorize } });
    }
    const customerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    if (path === '/api/session' && !signedIn) return route.fulfill({ status: 401, json: { error: 'not_authenticated' } });
    if (path === '/api/onesa/complete') signedIn = true;
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
  await expect(page.getByRole('link', { name: 'Return to PasoFi Staff' })).toHaveAttribute('href', '/admin');
  await expect(page.getByRole('link', { name: 'Check your Onesa access' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/onesa-callback\.html$/);
  expect(endpoint).toBe('/api/staff/onesa/complete');
});
