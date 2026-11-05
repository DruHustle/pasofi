import { test, expect } from '@playwright/test';

test('mobile policies are readable offline and do not create an account', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url()); });
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/');
  await page.context().setOffline(true);
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  const notice = page.locator('.pasofi-policy-notice');
  await notice.locator(':scope > summary').click();
  await expect(notice.getByText('3964 98th Crescent Kuwadzana 5', { exact: true })).toBeVisible();
  await notice.getByText('Read privacy information', { exact: true }).click();
  await notice.getByText('How long information is kept', { exact: true }).click();
  await expect(notice.getByText('Session expiry is not a deletion deadline.', { exact: false })).toBeVisible();
  await notice.getByText('Your requests and complaints', { exact: true }).click();
  await expect(notice.getByRole('link', { name: 'Submit a POTRAZ complaint (opens a new tab)', exact: true })).toHaveAttribute('href', 'https://www.potraz.gov.zw/?page_id=987');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(requests).toEqual([]);
});
