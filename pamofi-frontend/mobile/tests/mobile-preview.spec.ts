import { test, expect } from '@playwright/test';

for (const platform of ['small-phone', 'large-phone'] as const) {
  test(`${platform} preview works offline and cannot start a purchase`, async ({ page }, testInfo) => {
    await page.setViewportSize({width: platform === 'small-phone' ? 320 : 390, height: 780});
    const calls: string[] = [];
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) calls.push(request.url()); });
    await page.goto('/');
    await expect(page.getByText('Offline preview')).toBeVisible();
    await expect(page.locator('.mobile-hero-art img')).toHaveJSProperty('complete', true);
    expect(await page.locator('.mobile-hero-art img').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await page.context().setOffline(true);
    await page.screenshot({path:testInfo.outputPath(`pamofi-${platform}-home.png`),fullPage:true});
    await page.getByRole('button',{name:'Explore bundles'}).click();
    await expect(page.getByRole('heading',{name:'Find your fit.'})).toBeVisible();
    await page.getByRole('button',{name:'View Flex example bundle'}).click();
    await expect(page.getByText('Example only. Buying and connecting are not available in this preview.')).toBeVisible();
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.getByRole('button',{name:/buy|purchase|pay|recover/i})).toHaveCount(0);
    await page.getByRole('button',{name:'Help',exact:true}).click();
    await page.getByText('Can I buy a bundle in this app?').click();
    await expect(page.getByText('Not yet. This is an offline preview. Payments and Wi-Fi connections are not available.')).toBeVisible();
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(calls).toEqual([]);
    await page.screenshot({path:testInfo.outputPath(`pamofi-${platform}-preview.png`),fullPage:true});
  });
}
