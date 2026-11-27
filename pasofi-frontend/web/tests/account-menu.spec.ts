import { expect, test, type Page, type Route } from '@playwright/test';

const caps = { demo: false, paymentMode: 'disabled', paymentCheckout: false, vouchers: true, receiptPairing: false, staffSales: false, deliverySms: false, networkAccess: false, mobileCookies: false };
const customerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function fixture(page: Page, initial: 'signed-out' | 'member' | 'guest') {
  const state = { session: initial, sessionReads: 0, starts: [] as unknown[], deletes: 0, redemptions: [] as string[] };
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), method = route.request().method();
    switch (url.pathname) {
      case '/api/capabilities': return json(route, caps);
      case '/api/bundles': return json(route, { products: [], candidate: false });
      case '/api/help': return json(route, { articles: [] });
      case '/api/sites': return json(route, { sites: [] });
      case '/api/onesa/availability': return json(route, { origin: url.origin });
      case '/api/onesa/start':
        state.starts.push(route.request().postDataJSON());
        return json(route, { authorizationUrl: 'https://auth.example.invalid/authorize?state=' + 'm'.repeat(43) });
      case '/api/session':
        if (method === 'DELETE') { state.deletes++; state.session = 'signed-out'; return route.fulfill({ status: 204 }); }
        state.sessionReads++;
        return state.session === 'signed-out' ? json(route, { error: 'not_authenticated' }, 401) : json(route, { customerId, guest: state.session === 'guest' });
      case '/api/access': return json(route, { customerId, entitlements: [], hasMore: false, nextOffset: null });
      case '/api/usage': return json(route, { error: 'not_authenticated' }, 401);
      case '/api/vouchers/redeem':
        state.redemptions.push(route.request().postDataJSON().code);
        return json(route, { entitlementId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', replayed: false });
      default: return json(route, { error: 'not_authenticated' }, 401);
    }
  });
  await page.route('https://auth.example.invalid/**', route => route.fulfill({ body: 'Sign in or sign up' }));
  return state;
}
const accountButton = (page: Page) => page.getByRole('banner').getByRole('button', { name: 'Your account', exact: true });

for (const width of [320, 390, 1280]) test(`a signed-out visitor opens the account menu and signs in directly at ${width}px`, async ({ page }, info) => {
  const state = await fixture(page, 'signed-out');
  await page.setViewportSize({ width, height: 800 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your internet. Your everyday.', exact: true })).toBeVisible();
  expect(state.sessionReads).toBe(0);

  const button = accountButton(page);
  await expect(button).toHaveAttribute('aria-haspopup', 'menu');
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const menu = page.getByRole('menu', { name: 'Your account' });
  await expect(menu.getByRole('status')).toHaveText('Not signed in');
  await expect(menu.getByRole('menuitem')).toHaveText(['Sign in or sign up', 'Redeem a voucher', 'Check usage', 'Recover a guest account', 'Help']);
  await expect(menu).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  for (const item of await menu.getByRole('menuitem').all()) expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath(`account-menu-signed-out-${width}.png`) });

  await expect(menu.getByRole('menuitem', { name: 'Sign in or sign up' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Redeem a voucher' })).toBeFocused();
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: 'Help' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();

  await button.click();
  await page.mouse.click(5, 790);
  await expect(menu).toHaveCount(0);

  await button.click();
  await menu.getByRole('menuitem', { name: 'Sign in or sign up' }).click();
  await expect(page).toHaveURL(/^https:\/\/auth\.example\.invalid\/authorize/);
  expect(state.starts).toEqual([{ returnTo: '/#home' }]);
});

test('a signed-in customer reaches account tools from the menu and signs out', async ({ page }) => {
  const state = await fixture(page, 'member');
  await page.goto('/#bundles');
  const button = accountButton(page);
  await button.click();
  const menu = page.getByRole('menu', { name: 'Your account' });
  await expect(menu.getByRole('status')).toHaveText('Signed in');
  await expect(button).toHaveAttribute('data-session', 'member');
  await expect(menu.getByRole('menuitem')).toHaveText(['My bundles & usage', 'My WiFi', 'History & receipts', 'Redeem a voucher', 'Account & devices', 'Help', 'Sign out']);

  await menu.getByRole('menuitem', { name: 'History & receipts' }).click();
  await expect(page).toHaveURL(/#history$/);
  await expect(page.getByRole('heading', { name: 'Your activity', exact: true })).toBeVisible();

  await button.click();
  await menu.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/#home$/);
  await expect(page.getByText('You have signed out of PasoFi on this device.')).toBeVisible();
  await expect(menu).toHaveCount(0);
  expect(state.deletes).toBe(1);

  await button.click();
  await expect(menu.getByRole('status')).toHaveText('Not signed in');
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toHaveCount(0);
});

test('a guest keeps purchases when signing in and signs out only after the recovery reminder', async ({ page }) => {
  const state = await fixture(page, 'guest');
  await page.goto('/');
  const button = accountButton(page), menu = page.getByRole('menu', { name: 'Your account' });
  await button.click();
  await expect(menu.getByRole('status')).toHaveText('Guest session');
  await menu.getByRole('menuitem', { name: 'Sign out of guest session…' }).click();
  await expect(page).toHaveURL(/#account$/);
  expect(state.deletes).toBe(0);

  await button.click();
  await menu.getByRole('menuitem', { name: 'Sign in and keep purchases' }).click();
  await expect(page).toHaveURL(/^https:\/\/auth\.example\.invalid\/authorize/);
  expect(state.starts).toEqual([{ returnTo: '/#account', claimGuest: true }]);
});

for (const width of [320, 390, 1280]) test(`a customer with a voucher redeems it from a compact screen at ${width}px`, async ({ page }, info) => {
  const state = await fixture(page, 'signed-out');
  await page.setViewportSize({ width, height: 760 });
  await page.goto('/');
  await accountButton(page).click();
  await page.getByRole('menuitem', { name: 'Redeem a voucher' }).click();
  await expect(page).toHaveURL(/#voucher$/);
  const field = page.getByLabel('Voucher code', { exact: true });
  await expect(field).toBeInViewport();
  const card = page.locator('.customer-voucher-card');
  expect((await card.boundingBox())!.height).toBeLessThan(width < 600 ? 380 : 260);
  expect(await field.evaluate(input => parseFloat(getComputedStyle(input).fontSize))).toBeGreaterThanOrEqual(16);
  await expect(page.locator('.customer-voucher-art')).toHaveCount(0);
  await expect(page.getByText('No account is active in this browser.', { exact: false })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`voucher-${width}.png`) });

  await field.fill('abcd-efgh 2345');
  await expect(field).toHaveValue('ABCD-EFGH 2345');
  // Answer as the guest session the browser would hold, so no session is created here.
  state.session = 'guest';
  await page.getByRole('button', { name: 'Redeem voucher', exact: true }).click();
  await expect(page.getByText('Voucher redeemed. Your bundle is queued;', { exact: false })).toBeVisible();
  expect(state.redemptions).toEqual(['ABCDEFGH2345']);
});
