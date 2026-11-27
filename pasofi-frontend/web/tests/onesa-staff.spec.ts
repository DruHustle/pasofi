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
  await page.addInitScript(state => sessionStorage.setItem('pasofi-onesa-flow:' + state, JSON.stringify({ staff: true, returnTo: '/admin', expires: Date.now() + 900000 })), state);
  await page.goto('/onesa-callback.html?code=test-code&state=' + state + '&iss=https%3A%2F%2Fportal.example.invalid');
  await expect(page).toHaveURL(/\/admin$/);
  expect(body).toEqual({ code: 'test-code', state, iss: 'https://portal.example.invalid' });
  await expect(page.getByText('Onesa administrator', { exact: true })).toBeVisible();
});

test('a cancelled or malformed callback presents a clean sign-in retry', async ({ page }) => {
  let exchange = false;
  await page.route('**/api/**/onesa/complete', route => { exchange = true; return route.fulfill({ status: 401 }); });
  await page.goto('/onesa-callback.html?error=access_denied&state=private-state');
  await expect(page).toHaveURL(/\/onesa-callback\.html$/);
  // Without this tab's record the entry is unknown: never assume a staff sign-in.
  await expect(page.getByRole('heading', { name: 'Sign-in was not completed' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to PasoFi', exact: true })).toHaveAttribute('href', '/');
  await expect(page.getByText('Staff sign-in needs attention')).toHaveCount(0);
  expect(exchange).toBe(false);
});

test('a denied staff sign-in names the reason Onesa gave', async ({ page }) => {
  const state = 'd'.repeat(43);
  await page.addInitScript(state => sessionStorage.setItem('pasofi-onesa-flow:' + state, JSON.stringify({ staff: true, returnTo: '/admin', expires: Date.now() + 900000 })), state);
  await page.goto('/onesa-callback.html?error=access_denied&error_description=Onesa%20could%20not%20verify%20a%20fresh%20second%20factor.&state=' + state);
  await expect(page.getByRole('heading', { name: 'Authenticator step not finished' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to PasoFi Staff' })).toHaveAttribute('href', '/admin');
  await page.goto('/onesa-callback.html?error=access_denied&error_description=Onesa%20access%20is%20unavailable%20for%20this%20application.&state=' + state);
  await expect(page.getByRole('heading', { name: 'Staff sign-in needs attention' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('approved PasoFi staff access');
});

for (const [description, heading] of [
  ['Onesa email verification is required.', 'Verify your email first'],
  ['Onesa access is temporarily unavailable.', 'Sign-in is temporarily unavailable'],
  ['Call +000 to unlock your account', 'Sign-in was not completed'],
]) test(`a denied customer sign-in shows only reviewed wording for "${description}"`, async ({ page }) => {
  const state = 'u'.repeat(43);
  await page.addInitScript(state => sessionStorage.setItem('pasofi-onesa-flow:' + state, JSON.stringify({ staff: false, returnTo: '/#voucher', expires: Date.now() + 300000 })), state);
  await page.goto('/onesa-callback.html?error=access_denied&error_description=' + encodeURIComponent(description) + '&state=' + state);
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to PasoFi', exact: true })).toHaveAttribute('href', '/#voucher');
  await expect(page.getByText('Staff', { exact: false })).toHaveCount(0);
  await expect(page.getByText('+000')).toHaveCount(0);
});

test('a callback without its tab record completes the customer sign-in instead of a staff error', async ({ page }) => {
  const state = 'n'.repeat(43), customerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const calls: string[] = [];
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname; calls.push(path);
    if (path === '/api/onesa/complete') return route.fulfill({ json: { authenticated: true, customerId, returnTo: '/#voucher' } });
    if (path === '/api/session') return route.fulfill({ json: { customerId, guest: false } });
    return route.fulfill({ status: 503, json: {} });
  });
  await page.goto('/onesa-callback.html?code=new-tab-code&state=' + state);
  await expect(page).toHaveURL(/\/#voucher$/);
  expect(calls.slice(0, 2)).toEqual(['/api/onesa/complete', '/api/session']);
});

test('a callback with neither sign-in started in this tab explains how to restart', async ({ page }) => {
  await page.route('**/api/onesa/complete', route => route.fulfill({ status: 401, json: { error: 'onesa_sign_in_rejected' } }));
  await page.route('**/api/staff/onesa/complete', route => route.fulfill({ status: 401, json: { error: 'staff_sign_in_expired' } }));
  await page.goto('/onesa-callback.html?code=lost-code&state=' + 'l'.repeat(43));
  await expect(page.getByRole('heading', { name: 'Sign-in expired' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('same tab');
  await expect(page.getByRole('link', { name: 'Return to PasoFi', exact: true })).toHaveAttribute('href', '/');
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
  await expect(page.getByRole('status')).toContainText('same tab');
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

test('an expired staff transaction explains how to restart sign-in', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('pasofi-onesa-flow:' + 's'.repeat(43), JSON.stringify({ staff: true, returnTo: '/admin', expires: Date.now() + 900000 })));
  await page.route('**/api/staff/onesa/complete', route =>
    route.fulfill({ status: 401, json: { error: 'staff_sign_in_expired' } }));
  await page.goto('/onesa-callback.html?code=synthetic-code&state=' + 's'.repeat(43));
  await expect(page.getByRole('heading', { name: 'Staff sign-in expired' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('same tab');
  await expect(page.getByRole('link', { name: 'Return to PasoFi Staff' })).toHaveAttribute('href', '/admin');
});

for (const [error, heading] of [
  ['staff_assignment_pending', 'Your seller application is waiting for approval'],
  ['staff_binding_review_required', 'Your staff record needs a check'],
]) test(`a ${error} staff result does not loop back into staff sign-in`, async ({ page }) => {
  const state = 'p'.repeat(43);
  await page.addInitScript(state => sessionStorage.setItem('pasofi-onesa-flow:' + state, JSON.stringify({ staff: true, returnTo: '/admin', expires: Date.now() + 900000 })), state);
  await page.route('**/api/staff/onesa/complete', route => route.fulfill({ status: error === 'staff_assignment_pending' ? 403 : 409, json: { error } }));
  await page.goto('/onesa-callback.html?code=pending-code&state=' + state);
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to PasoFi', exact: true })).toHaveAttribute('href', '/');
  await expect(page.getByRole('link', { name: 'Return to PasoFi Staff' })).toHaveCount(0);
});
