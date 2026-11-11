import { test, expect } from '@playwright/test';
import { downloadStatus, publicDownloadUrl } from '../src/downloadLinks';

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

test('direct Android downloads require a versioned file, first-party source and verified digest', () => {
  const digest = 'a'.repeat(64);
  expect(downloadStatus(undefined)).toBe('unavailable');
  expect(downloadStatus('https://play.google.com/store/apps/details')).toBe('play');
  const firstParty = 'https://pasofi.mobile.onesa.eu/downloads/pasofi-1.0.0.apk';
  const release = 'https://github.com/DruHustle/pasofi/releases/download/mobile-v1.0.0/pasofi-1.0.0.apk';
  for (const url of [firstParty, release]) {
    expect(publicDownloadUrl('android', url, digest)).toBe(url);
    expect(downloadStatus(url)).toBe('apk');
    expect(publicDownloadUrl('android', url)).toBeUndefined();
    expect(publicDownloadUrl('android', url, 'unverified')).toBeUndefined();
    expect(publicDownloadUrl('ios', url, digest)).toBeUndefined();
  }
  for (const url of [firstParty.replace('pasofi.mobile.onesa.eu', 'unrelated.example'),
    release.replace('/DruHustle/', '/untrusted/'), release.replace('/pasofi/', '/other-repo/'),
    release.replace('/download/', '/edit/'), firstParty.replace('-1.0.0.apk', '-debug.apk'),
    firstParty + '?redirect=other', firstParty.replace('/downloads/', '/uploads/')]) {
    expect(publicDownloadUrl('android', url, digest)).toBeUndefined();
  }
});

test('direct navigation lands on both platform choices and allows scrolling away', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 756 });
  await page.route('**/api/**', route => route.fulfill({ status: 503, body: '{}' }));
  await page.goto('/#mobile-apps-title');
  const region = page.getByRole('region', { name: 'Mobile apps' });
  await expect(region.getByText('iOS', { exact: true })).toBeInViewport({ ratio: 1 });
  await expect(region.getByText('Android', { exact: true })).toBeInViewport({ ratio: 1 });
  await page.evaluate(() => {
    const delayed = document.createElement('div');
    delayed.id = 'deferred-content-test';
    delayed.style.height = '1400px';
    document.querySelector('main')!.append(delayed);
  });
  await expect(region).toBeInViewport({ ratio: 1 });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await page.evaluate(() => { document.getElementById('deferred-content-test')!.style.height = '1800px'; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
