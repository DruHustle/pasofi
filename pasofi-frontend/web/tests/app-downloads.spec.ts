import { test, expect } from '@playwright/test';
import { publicDownloadUrl } from '../src/appDownloads';

test('only public release destinations for the selected platform become download links', () => {
  expect(publicDownloadUrl('ios', undefined)).toBeUndefined();
  expect(publicDownloadUrl('android', '')).toBeUndefined();
  const android = 'https://play.google.com/store/apps/details?id=com.onesa.pasofi';
  const apple = 'https://apps.apple.com/zw/app/example/id123456789';
  const beta = 'https://testflight.apple.com/join/Ab12Cd34';
  expect(publicDownloadUrl('android', android)).toBe(android);
  expect(publicDownloadUrl('ios', apple)).toBe(apple);
  expect(publicDownloadUrl('ios', beta)).toBe(beta);
  for (const url of [apple.replace('apps.apple.com', 'example.com'), 'javascript:alert(1)',
    'https://example.com/app.apk', apple.replace('https:', 'http:'), apple + '?redirect=example.com',
    apple.replace('apps.apple.com', 'name:pass@apps.apple.com'), beta + '/extra']) {
    expect(publicDownloadUrl('ios', url)).toBeUndefined();
  }
  expect(publicDownloadUrl('android', android + '.different')).toBeUndefined();
  expect(publicDownloadUrl('android', beta)).toBeUndefined();
});

test('both platforms are visible without inactive download links on phones', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.route('**/api/**', route => route.fulfill({ status: 503, body: '{}' }));
  await page.goto('/');
  const section = page.getByRole('region', { name: 'Mobile apps' });
  await expect(section.getByText('iOS', { exact: true })).toBeVisible();
  await expect(section.getByText('Android', { exact: true })).toBeVisible();
  await expect(section.getByText('Not yet available')).toHaveCount(2);
  await expect(section.getByRole('link')).toHaveCount(0);
  expect(await section.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
