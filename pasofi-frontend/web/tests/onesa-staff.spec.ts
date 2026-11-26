import { test, expect } from '@playwright/test';

test('Onesa callback removes credentials from the URL and returns a verified administrator to staff', async ({ page }) => {
  const state = 's'.repeat(43);
  let body: unknown;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/onesa/complete')) {
      body = route.request().postDataJSON();
      return route.fulfill({ json: { authenticated: true } });
    }
    if (path.endsWith('/staff/session')) {
      return route.fulfill({ json: { staffId: '4916caf4-1026-4f85-a7b3-4d566649246d', displayName: 'Onesa administrator',
        email: 'admin@example.invalid', role: 'admin', status: 'approved', siteIds: [], mfaVerified: true, version: 1 } });
    }
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto('/onesa-callback.html?code=test-code&state=' + state + '&iss=https%3A%2F%2Fportal.example.invalid');
  await expect(page).toHaveURL(/\/admin$/);
  expect(body).toEqual({ code: 'test-code', state, iss: 'https://portal.example.invalid' });
  await expect(page.getByText('Onesa administrator', { exact: true })).toBeVisible();
});

test('a cancelled or malformed callback presents a clean sign-in retry', async ({ page }) => {
  let exchange = false;
  await page.route('**/api/staff/onesa/complete', route => { exchange = true; return route.fulfill({ status: 401 }); });
  await page.goto('/onesa-callback.html?error=access_denied&state=private-state');
  await expect(page).toHaveURL(/\/onesa-callback\.html$/);
  await expect(page.getByRole('heading', { name: 'Staff sign-in needs attention' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to PasoFi Staff' })).toHaveAttribute('href', '/admin');
  expect(exchange).toBe(false);
});

test('an elapsed staff attempt offers a restart instead of reporting an access problem', async ({ page }) => {
  const state = 'x'.repeat(43);
  await page.addInitScript(state => {
    sessionStorage.setItem('pasofi-onesa-flow:' + state, JSON.stringify({staff: true, expires: Date.now() - 1000}));
    sessionStorage.setItem('pasofi-onesa-customer', '1');
  }, state);
  let exchanged = false;
  await page.route('**/api/**', route => {
    exchanged = true;
    return route.fulfill({status: 401, json: {error: 'onesa_sign_in_rejected'}});
  });
  await page.goto('/onesa-callback.html?code=synthetic-code&state=' + state);
  await expect(page.getByRole('heading', {name: 'Staff sign-in expired'})).toBeVisible();
  await expect(page.getByRole('status')).toContainText('within five minutes');
  await expect(page.getByRole('link', {name: 'Return to PasoFi Staff'})).toHaveAttribute('href', '/admin');
  await expect(page).toHaveURL(/\/onesa-callback\.html$/);
  expect(exchanged).toBe(false);
});

test('blocked callback storage presents a readable retry after removing URL credentials', async ({page}) => {
  let exchanged=false;
  await page.addInitScript(() => Object.defineProperty(window,'sessionStorage',{get(){throw new DOMException('Storage unavailable','SecurityError');}}));
  await page.route('**/api/**',route=>{exchanged=true;return route.fulfill({status:503,json:{}});});
  await page.goto('/onesa-callback.html?code=synthetic-code&state=' + 'x'.repeat(43));
  await expect(page).toHaveURL(/\/onesa-callback\.html$/);
  await expect(page.getByRole('status')).toContainText('Allow site storage');
  expect(exchanged).toBe(false);
});
