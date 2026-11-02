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
test('a lost first response retries the same customer session', async ({page}) => {
  let drop=true;
  const customers:string[]=[];
  const keys:string[]=[];
  await page.route('**/api/session',async route=>{
    if(route.request().method()!=='POST'){await route.continue();return;}
    const key=route.request().headers()['idempotency-key'];
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);keys.push(key);
    const response=await route.fetch();
    expect([200,201]).toContain(response.status());
    customers.push((await response.json()).customerId);
    if(drop)await route.abort('failed');else await route.fulfill({response});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Try flex demo bundle'}).click();
  await expect(page.getByRole('alert')).toContainText('could not reach');
  expect(customers.length).toBeGreaterThan(0);
  drop=false;
  await page.getByRole('button',{name:'Close demo purchase'}).click();
  await page.getByRole('button',{name:'Try flex demo bundle'}).click();
  await expect(page.getByRole('button',{name:'Create demo order'})).toBeVisible();
  expect(customers.length).toBeGreaterThan(1);
  expect(new Set(customers).size).toBe(1);
  expect(new Set(keys).size).toBe(1);
  expect(await page.evaluate(()=>sessionStorage.getItem('pamofi.sessionCreationRetry'))).toBeNull();
});
test('a rejected cookie keeps the retry secret until the session is confirmed', async ({page}) => {
  let stripCookie=true;
  const customers:string[]=[],keys:string[]=[];
  await page.route('**/api/session',async route=>{
    if(route.request().method()!=='POST'){
      if(stripCookie)await route.fulfill({status:401,contentType:'application/json',body:'{"error":"not_authenticated"}'});
      else await route.continue();
      return;
    }
    keys.push(route.request().headers()['idempotency-key']);
    const response=await route.fetch();
    expect([200,201]).toContain(response.status());customers.push((await response.json()).customerId);
    const headers=response.headers();
    if(stripCookie)delete headers['set-cookie'];
    await route.fulfill({response,headers});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Try flex demo bundle'}).click();
  await expect(page.getByRole('alert')).toContainText('could not reach');
  expect(await page.evaluate(()=>sessionStorage.getItem('pamofi.sessionCreationRetry'))).not.toBeNull();
  stripCookie=false;
  await page.context().clearCookies();
  await page.getByRole('button',{name:'Close demo purchase'}).click();
  await page.getByRole('button',{name:'Try flex demo bundle'}).click();
  await expect(page.getByRole('button',{name:'Create demo order'})).toBeVisible();
  expect(customers.length).toBeGreaterThan(1);
  expect(new Set(customers).size).toBe(1);expect(new Set(keys).size).toBe(1);
  expect(await page.evaluate(()=>sessionStorage.getItem('pamofi.sessionCreationRetry'))).toBeNull();
});
