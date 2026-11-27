import { test, expect } from '@playwright/test';

for (const platform of ['small-phone', 'large-phone', 'wide-phone'] as const) {
  test(`${platform} preview mirrors the website, works offline and cannot start a purchase`, async ({ page }, testInfo) => {
    await page.setViewportSize({width: platform === 'small-phone' ? 320 : platform === 'large-phone' ? 390 : 430, height: 780});
    const calls: string[] = [];
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) calls.push(request.url()); });
    await page.goto('/');
    await expect(page.getByText('Offline preview')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your internet. Your everyday.' })).toBeVisible();
    const hero = page.locator('.mobile-hero-art img');
    await expect(hero).toHaveJSProperty('complete', true);
    expect(await hero.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator('.pf-catalogue--preview .pf-bundle-card')).toHaveCount(5);
    await page.context().setOffline(true);
    await page.screenshot({path:testInfo.outputPath(`pamofi-${platform}-home.png`),fullPage:true});

    await page.getByRole('button',{name:'Browse bundles'}).click();
    await expect(page.getByRole('heading',{name:'Find your fit.', level: 1})).toBeVisible();
    await expect(page.getByText('Example bundles. Prices and terms are illustrative', { exact: false })).toBeVisible();
    const cards = page.locator('.pf-bundle-card');
    await expect(cards).toHaveCount(5);
    const filters = page.getByRole('group', { name: 'Bundle duration' });
    expect(await filters.evaluate(row => row.scrollWidth <= row.clientWidth && new Set([...row.children].map(chip => Math.round(chip.getBoundingClientRect().top))).size === 1), 'filters stay on one line').toBe(true);
    // One brand colour across all bundles, as on the website.
    expect(new Set(await cards.evaluateAll(items => items.map(item => getComputedStyle(item).backgroundColor))).size).toBe(1);
    await filters.getByRole('button', { name: 'Weekly', exact: true }).click();
    await expect(cards).toHaveCount(2);
    await expect(page.locator('.pf-plan-name')).toHaveText(['flex', 'week']);
    await filters.getByRole('button', { name: 'Longer', exact: true }).click();
    await expect(page.locator('.pf-plan-name')).toHaveText(['fortnight']);
    await filters.getByRole('button', { name: 'Monthly', exact: true }).click();
    await expect(page.locator('.pf-plan-name')).toHaveText(['month']);
    await expect(filters.getByRole('button', { name: 'Daily', exact: true })).toHaveCount(0);
    await filters.getByRole('button', { name: 'All bundles', exact: true }).click();
    // Same Buy button as the website, but disabled: the preview cannot start a purchase.
    const buy = page.getByRole('button', { name: /^Buy .* \(not available in this preview\)$/ });
    await expect(buy).toHaveCount(5);
    for (const button of await buy.all()) await expect(button).toBeDisabled();
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await expect(page.locator('button:enabled').filter({ hasText: /buy|purchase|pay|recover|choose/i })).toHaveCount(0);
    await page.screenshot({path:testInfo.outputPath(`pamofi-${platform}-bundles.png`),fullPage:true});

    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    await nav.getByRole('button', { name: 'History', exact: true }).click();
    await expect(nav.getByRole('button', { name: 'History', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Your activity' })).toBeFocused();
    await expect(page.getByText('This offline preview has no purchase or usage records.', { exact: false })).toBeVisible();
    await nav.getByRole('button', { name: 'Account', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your account' })).toBeFocused();
    await expect(page.getByRole('link', { name: 'Delete your Onesa account' })).toHaveAttribute('href', 'https://account.onesa.eu/account/closure');
    await expect(page.getByText('No account is created while you explore.', { exact: false })).toBeVisible();
    const navTargets = await page.locator('.mobile-nav button').evaluateAll(buttons => buttons.map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
    expect(navTargets.every(target => target.width >= 44 && target.height >= 44)).toBe(true);
    await page.getByRole('button',{name:'Help',exact:true}).click();
    await page.getByText('Can I buy a bundle in this app?').click();
    await expect(page.getByText('Not yet. This is an offline preview. Payments and Wi-Fi connections are not available.')).toBeVisible();
    await page.getByLabel('Find a quick answer').fill('uploads');
    await expect(page.locator('.mobile-faq details')).toHaveCount(1);
    await page.getByLabel('Find a quick answer').fill('unmatched query');
    await expect(page.getByText('No matching answer.', { exact: false })).toBeVisible();
    await page.getByLabel('Find a quick answer').clear();
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    expect(calls).toEqual([]);
    await page.screenshot({path:testInfo.outputPath(`pamofi-${platform}-preview.png`),fullPage:true});
  });
}
