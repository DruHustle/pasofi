import { test, expect } from '@playwright/test';

test('Onesa callback removes credentials from the URL and returns a verified administrator to staff', async ({ page }) => {
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
  await page.goto('/onesa-callback.html?code=test-code&state=test-state&iss=https%3A%2F%2Fportal.example.invalid');
  await expect(page).toHaveURL(/\/#staff$/);
  expect(body).toEqual({ code: 'test-code', state: 'test-state', iss: 'https://portal.example.invalid' });
  await expect(page.getByText('Onesa administrator', { exact: true })).toBeVisible();
});

test('a cancelled or malformed callback presents a clean sign-in retry', async ({ page }) => {
  let exchange = false;
  await page.route('**/api/staff/onesa/complete', route => { exchange = true; return route.fulfill({ status: 401 }); });
  await page.goto('/onesa-callback.html?error=access_denied&state=private-state');
  await expect(page).toHaveURL(/\/onesa-callback\.html$/);
  await expect(page.getByRole('status')).toContainText('Sign-in could not be completed');
  await expect(page.getByRole('link', { name: 'Return to PasoFi' })).toHaveAttribute('href', '/');
  expect(exchange).toBe(false);
});


test('blocked callback storage presents a readable retry after removing URL credentials', async ({page}) => {
  let exchanged=false;
  await page.addInitScript(() => Object.defineProperty(window,'sessionStorage',{get(){throw new DOMException('Storage unavailable','SecurityError');}}));
  await page.route('**/api/**',route=>{exchanged=true;return route.fulfill({status:503,json:{}});});
  await page.goto('/onesa-callback.html?code=synthetic-code&state=synthetic-state');
  await expect(page).toHaveURL(/\/onesa-callback\.html$/);
  await expect(page.getByRole('status')).toContainText('Sign-in could not be completed');
  expect(exchanged).toBe(false);
});
