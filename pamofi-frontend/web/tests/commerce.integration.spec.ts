import { test, expect, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const identityDirectory = fileURLToPath(new URL('../../../pamofi-backend/services/identity-service/', import.meta.url));
const prepaidDirectory = fileURLToPath(new URL('../../../pamofi-backend/services/prepaid-access-service/', import.meta.url));
async function fixture<T>(kind: 'identity' | 'commerce', args: string[]): Promise<T> {
  const database = kind === 'identity' ? process.env.PAMOFI_TEST_IDENTITY_DATABASE_URL : process.env.PAMOFI_TEST_PREPAID_DATABASE_URL;
  if (process.env.PAMOFI_TEST_CONFIRM_ISOLATED !== '1' || !database || !process.env.STAFF_MFA_ENCRYPTION_KEY) throw Error('Real commerce browser acceptance requires the isolated database and MFA environment supplied by local-tools/verify.mjs --integration --browser.');
  const { stdout } = await execute(process.execPath, [kind === 'identity' ? 'test/fixtures/staff.mjs' : 'test/fixtures/commerce.mjs', ...args], {
    cwd: kind === 'identity' ? identityDirectory : prepaidDirectory,
    env: { ...process.env, APP_ENV: 'demo', NODE_ENV: 'development', PAMOFI_TEST_DATABASE_URL: database }, timeout: 45_000,
  });
  // Fixture credentials stay in test-process memory; never attach stdout or tokens.
  return JSON.parse(stdout.trim()) as T;
}
function authenticator(secret: string, counter: number) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const character of secret) bits += alphabet.indexOf(character).toString(2).padStart(5, '0');
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, index) => parseInt(bits.slice(index * 8, index * 8 + 8), 2)));
  const time = Buffer.alloc(8); time.writeBigUInt64BE(BigInt(counter)); const digest = createHmac('sha1', key).update(time).digest(), offset = digest[19] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
async function passwordLogin(page: Page, email: string, password: string) {
  const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/staff/login' && result.request().method() === 'POST');
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Continue to verification' }).click(); await expect(page.getByLabel('Authenticator code')).toBeVisible(); return (await response).json();
}

test('real MFA approval, agent cash sale, private receipt, queued allowance and automatic accounted usage', async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const admin = await fixture<{ staffId: string; email: string; password: string }>('identity', ['create']);
  const id = randomUUID(), email = `pamofi-browser-${id}@staff.pamofi.test`, password = `Browser fixture password ${randomUUID()}`, siteName = `Browser fixture ${randomUUID()}`;
  const adminContext = await browser.newContext(), agentContext = await browser.newContext(), customerContext = await browser.newContext();
  const adminPage = await adminContext.newPage(), agentPage = await agentContext.newPage(), customerPage = await customerContext.newPage();
  let agentId = '', siteId = '', customerId = '';
  try {
    await adminPage.goto(baseURL!); await adminPage.getByRole('button', { name: 'Staff', exact: true }).click(); await passwordLogin(adminPage, admin.email, admin.password);
    const verification = await fixture<{ code: string }>('identity', ['code', admin.staffId]); await adminPage.getByLabel('Authenticator code').fill(verification.code); await adminPage.getByRole('button', { name: 'Verify authenticator' }).click(); await expect(adminPage.getByRole('heading', { name: 'Administration', exact: true })).toBeVisible();
    await adminPage.getByRole('button', { name: 'Sites', exact: true }).click(); await adminPage.getByLabel('Site name').fill(siteName);
    const creation = adminPage.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/sites' && response.request().method() === 'POST'); await adminPage.getByRole('button', { name: 'Create site', exact: true }).click(); const created = await creation; expect(created.status()).toBe(201); siteId = (await created.json()).site.id;
    await agentPage.goto(baseURL!); await agentPage.getByRole('button', { name: 'Staff', exact: true }).click(); await agentPage.getByRole('button', { name: 'New team member? Apply for access' }).click(); await agentPage.getByLabel('Your name').fill(`Browser agent ${id.slice(0, 8)}`); await agentPage.getByLabel('Email', { exact: true }).fill(email); await agentPage.getByLabel('Password', { exact: true }).fill(password); await agentPage.getByRole('button', { name: 'Submit staff application' }).click(); await expect(agentPage.getByText('Your application has been received.', { exact: false })).toBeVisible();
    agentId = (await passwordLogin(agentPage, email, password)).staffId; await agentPage.getByRole('button', { name: 'Create authenticator setup key' }).click(); const secret = await agentPage.getByTestId('mfa-setup-key').innerText(); const firstCounter = Math.floor(Date.now() / 30_000); await agentPage.getByLabel('Authenticator code').fill(authenticator(secret, firstCounter)); await agentPage.getByRole('button', { name: 'Verify authenticator' }).click(); await expect(agentPage.getByRole('heading', { name: 'Waiting for administrator approval' })).toBeVisible(); agentId = (await (await agentPage.request.get(new URL('/api/staff/session', baseURL).href)).json()).staffId;
    await adminPage.getByRole('button', { name: 'Refresh administration' }).click(); await adminPage.getByRole('button', { name: 'Staff approvals', exact: true }).click();
    // Staff lists are paged; find our unique fixture without assuming it is on page one.
    for (let count = 0; count < 20 && !await adminPage.getByRole('row').filter({ hasText: email }).count(); count++) { const more = adminPage.getByRole('button', { name: 'Load more staff', exact: true }); if (!await more.isVisible()) break; await Promise.all([adminPage.waitForResponse(response => new URL(response.url()).pathname === '/api/staff/users' && new URL(response.url()).searchParams.has('after')), more.click()]); await expect(adminPage.getByRole('button', { name: 'Refresh administration' })).toBeEnabled(); }
    await adminPage.getByRole('row').filter({ hasText: email }).getByRole('button', { name: 'Review access' }).click(); await adminPage.getByRole('checkbox', { name: siteName, exact: true }).check(); await adminPage.getByLabel('Reason', { exact: true }).fill('Approved isolated browser acceptance fixture'); await adminPage.getByRole('button', { name: 'Save staff decision' }).click(); await expect(adminPage.getByText('Staff decision saved.', { exact: false })).toBeVisible();
    await adminPage.getByRole('button', { name: 'Inventory', exact: true }).click(); await adminPage.getByRole('combobox', { name: 'Agent', exact: true }).selectOption(agentId); await adminPage.getByRole('combobox', { name: 'Site', exact: true }).selectOption(siteId); await adminPage.getByRole('combobox', { name: 'Bundle', exact: true }).selectOption('flex'); await adminPage.getByLabel('Quantity').fill('1'); await adminPage.getByLabel('Reason', { exact: true }).fill('One voucher for isolated browser acceptance'); await adminPage.getByRole('button', { name: 'Allocate inventory' }).click(); await expect(adminPage.getByText('Inventory allocation confirmed.', { exact: false })).toBeVisible();
    await agentPage.getByRole('button', { name: 'Refresh staff access' }).click(); await expect(agentPage.getByLabel('Email', { exact: true })).toBeVisible(); await passwordLogin(agentPage, email, password); const nextCounter = Math.max(Math.floor(Date.now() / 30_000), firstCounter + 1); await agentPage.getByLabel('Authenticator code').fill(authenticator(secret, nextCounter)); await agentPage.getByRole('button', { name: 'Verify authenticator' }).click(); await expect(agentPage.getByRole('heading', { name: 'Your sites and sales' })).toBeVisible();
    await customerPage.goto(baseURL!); await customerPage.getByRole('button', { name: 'Customer tools' }).click(); await customerPage.getByRole('button', { name: 'Private receipt', exact: true }).click(); await customerPage.getByRole('button', { name: 'Create private pairing code' }).click(); const pairingCode = await customerPage.locator('.pairing-card strong').innerText(); customerId = (await (await customerPage.request.get(new URL('/api/session', baseURL).href)).json()).customerId;
    await agentPage.getByRole('combobox', { name: 'Sale site', exact: true }).selectOption(siteId); await agentPage.getByRole('combobox', { name: 'Bundle', exact: true }).selectOption('flex'); await agentPage.getByLabel('Customer pairing code').fill(pairingCode); await expect(agentPage.getByRole('button', { name: 'Confirm demo sale' })).toBeDisabled(); await agentPage.getByRole('checkbox', { name: /simulated sale/ }).check(); const saleResponse = agentPage.waitForResponse(response => new URL(response.url()).pathname === '/api/staff/sales' && response.request().method() === 'POST'); await agentPage.getByRole('button', { name: 'Confirm demo sale' }).click(); const confirmedSale = (await (await saleResponse).json()).sale; expect(confirmedSale.payment).toMatchObject({ method: 'cash', evidence: 'agent_attestation', receivedMinor: confirmedSale.priceMinor, currency: confirmedSale.currency, confirmedBy: agentId }); expect(confirmedSale.payment.confirmedAt).toBeTruthy(); await expect(agentPage.getByText('Demo sale confirmed:', { exact: false })).toBeVisible();
    await expect(customerPage.getByLabel('Private voucher')).toBeVisible({ timeout: 15_000 }); await expect(customerPage.getByText('confirmed by agent', { exact: false })).toBeVisible(); const voucher = await customerPage.getByLabel('Private voucher').inputValue(); expect(voucher.length).toBeGreaterThan(12); expect(customerPage.url()).not.toContain(voucher); await customerPage.getByRole('button', { name: "Redeem this receipt's voucher" }).click(); await expect(customerPage.getByText('Queued · not connected', { exact: true })).toBeVisible();
    const inventory = await (await agentPage.request.get(new URL('/api/staff/inventory', baseURL).href)).json(); expect(inventory.inventory.find((entry: { siteId: string; bundleId: string }) => entry.siteId === siteId && entry.bundleId === 'flex').quantity).toBe(0);
    const access = await (await customerPage.request.get(new URL('/api/access', baseURL).href)).json(); expect(access.entitlements).toHaveLength(1); expect(access.entitlements[0].activated_at).toBeNull();
    await expect(customerPage.getByTestId('usage-queued')).toHaveText(`${(Number(access.entitlements[0].byte_limit) / 1e9).toFixed(3)} GB`); await expect(customerPage.getByTestId('usage-used')).toHaveText('0.000 GB');
    // The service-owned isolated fixture uses the real grant/accounting engine; no router or payment provider is contacted.
    const accounted = await fixture<{ accounted: boolean; usedBytes: string; remainingBytes: string }>('commerce', ['account-usage', '--site', siteId, '--agent', agentId, '--customer', customerId]); expect(accounted.accounted).toBe(true); expect(accounted.usedBytes).toBe('3000000');
    // No click or navigation: the visible five-second poll must pick up the committed debit and activation.
    await expect(customerPage.getByTestId('usage-used')).toHaveText('0.003 GB', { timeout: 15_000 }); await expect(customerPage.getByTestId('usage-remaining')).toHaveText(`${(Number(accounted.remainingBytes) / 1e9).toFixed(3)} GB`); await expect(customerPage.getByTestId('usage-queued')).toHaveText('0.000 GB'); await expect(customerPage.locator('[data-entitlement-id]')).toContainText('0.003 GB accounted');
    await customerPage.setViewportSize({ width: 360, height: 1000 }); expect(await customerPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); await customerPage.getByTestId('live-usage').screenshot({ path: testInfo.outputPath('real-customer-usage-360.png') });
  } finally {
    await Promise.all([adminContext.close(), agentContext.close(), customerContext.close()]);
    if (siteId) await fixture('commerce', ['remove', '--site', siteId, '--agent', agentId || id, '--customer', customerId || id]);
    if (agentId) await fixture('identity', ['remove-registered', agentId, email]);
    await fixture('identity', ['remove', admin.staffId]);
  }
});
