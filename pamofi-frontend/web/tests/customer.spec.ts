import { test, expect } from '@playwright/test';
for (const width of [320, 360, 1280]) {
  test(`mock purchase on ${width}px`, async ({page}) => {
    await page.setViewportSize({width,height:850});
    await page.goto('/');
    await expect(page.locator('.demo').getByText('DEMONSTRATION')).toBeVisible();
    await page.getByRole('button',{name:'Try flex demo bundle'}).click();
    await expect(page.getByRole('heading',{name:'Try a bundle'})).toBeVisible();
    await page.getByRole('button',{name:'Create demo order'}).click();
    await expect(page.getByRole('heading',{name:'Awaiting simulated payment'})).toBeVisible();
    await page.getByRole('button',{name:'Confirm simulation'}).click();
    await expect(page.getByRole('heading',{name:'Simulated payment confirmed'})).toBeVisible();
    await page.getByRole('button',{name:'View demo access'}).click();
    await expect(page.getByText('Queued · not connected')).toBeVisible();
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.screenshot({path:`/private/tmp/pamofi-demo-${width}.png`,fullPage:true});
    await page.reload();
    await page.getByRole('button',{name:'My demo access'}).click();
    await expect(page.getByText('Queued · not connected')).toBeVisible();
  });
}
test('recovery key restores a demo purchase in a separate browser context', async ({browser}) => {
  const first=await browser.newContext(), page=await first.newPage();
  await page.goto('http://localhost:5173/');
  await page.getByRole('button',{name:'Try flex demo bundle'}).click();
  await page.getByRole('button',{name:'Create recovery key'}).click();
  const reference=await page.getByTestId('account-reference').innerText();
  const key=await page.getByTestId('recovery-key').innerText();
  await page.getByRole('button',{name:'Create demo order'}).click();
  await page.getByRole('button',{name:'Confirm simulation'}).click();
  await expect(page.getByRole('heading',{name:'Simulated payment confirmed'})).toBeVisible();
  const second=await browser.newContext(), recovered=await second.newPage();
  await recovered.goto('http://localhost:5173/');
  await recovered.getByRole('button',{name:'Recover',exact:true}).click();
  await recovered.getByLabel('Account reference').fill(reference);
  await recovered.getByLabel('Recovery key').fill(key);
  await recovered.getByRole('button',{name:'Recover access'}).click();
  await expect(recovered.getByText('Queued · not connected')).toBeVisible();
  await first.close();await second.close();
});
