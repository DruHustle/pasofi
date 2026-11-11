import { test, expect } from '@playwright/test';

for (const entry of ['/']) {
  test(`PasoFi icons load without an account or working API at ${entry}`, async ({ page }) => {
    await page.route('**/api/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' }));
    await page.goto(entry);
    await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute('href', '/favicon.svg');
    await expect(page.locator('link[rel="icon"][sizes="16x16 32x32 48x48"]')).toHaveAttribute('href', '/favicon.ico');
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('sizes', '180x180');
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#001a33');
    await expect(page.getByRole('button', { name: 'PasoFi home' }).getByText('An Onesa Mobile product')).toBeVisible();
    const svg = await page.request.get('/favicon.svg');
    expect(svg.status()).toBe(200); expect(svg.headers()['content-type']).toMatch(/^image\/svg\+xml/);
    expect(await svg.text()).toContain('viewBox="0 0 64 64"');
    const ico = await page.request.get('/favicon.ico');
    expect(ico.status()).toBe(200); expect(ico.headers()['content-type']).toMatch(/^image\/(?:x-icon|vnd\.microsoft\.icon)/);
    const bytes = await ico.body();
    expect([...bytes.subarray(0, 6)]).toEqual([0, 0, 1, 0, 3, 0]);
    for (const [index, size] of [16, 32, 48].entries()) {
      const frame = 6 + index * 16, start = bytes.readUInt32LE(frame + 12);
      expect([bytes[frame], bytes[frame + 1]]).toEqual([size, size]);
      expect([...bytes.subarray(start, start + 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect([bytes.readUInt32BE(start + 16), bytes.readUInt32BE(start + 20)]).toEqual([size, size]);
    }
    const touch = await page.request.get('/apple-touch-icon.png');
    expect(touch.status()).toBe(200); expect(touch.headers()['content-type']).toMatch(/^image\/png/);
    expect(await page.evaluate(async () => {
      const image = new Image(); image.src = '/apple-touch-icon.png'; await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    })).toEqual([180, 180]);
  });
}
