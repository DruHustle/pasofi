import { test, expect } from '@playwright/test';

test('a forged registration-complete URL cannot begin customer or administrator sign-in', async ({page}) => {
  const starts:string[]=[];
  await page.route(/\/api\/(?:staff\/)?onesa\/start$/, route => {
    starts.push(route.request().url());
    return route.fulfill({status:503,json:{}});
  });
  await page.goto('/?registration=complete');
  await expect(page).toHaveURL(/\/#account$/);
  expect(starts).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem('pasofi.registration'))).toBeNull();
});

test('an expired administrator return falls back to a clean customer account screen', async ({page}) => {
  const starts:string[]=[];
  await page.addInitScript(() => {
    sessionStorage.setItem('pasofi.registration',JSON.stringify({
      path:'/#staff',expires:Date.now()-60_000,
    }));
  });
  await page.route(/\/api\/(?:staff\/)?onesa\/start$/, route => {
    starts.push(route.request().url());
    return route.fulfill({status:503,json:{}});
  });
  await page.goto('/?registration=complete');
  await expect(page).toHaveURL(/\/#account$/);
  expect(starts).toEqual([]);
  expect(await page.evaluate(() => sessionStorage.getItem('pasofi.registration'))).toBeNull();
});

test('a current administrator return uses the approved staff OIDC entry exactly once', async ({page}) => {
  let started=0;
  // Seed the receipt in PasoFi's own origin. An init script would also run
  // on the provider origin and introduce a false storage failure.
  await page.goto('/#account');
  await page.evaluate(() => sessionStorage.setItem('pasofi.registration',JSON.stringify({
    path:'/#staff',expires:Date.now()+60_000,
  })));
  await page.route('**/api/staff/onesa/availability', route =>
    route.fulfill({json:{origin:new URL(route.request().url()).origin}}));
  await page.route('**/api/staff/onesa/start', route => {
    started++;
    expect(route.request().postDataJSON()).toEqual({});
    return route.fulfill({json:{authorizationUrl:'https://auth.onesa.eu/authorize?account=synthetic'}}); 
  });
  await page.route('https://auth.onesa.eu/authorize?account=synthetic', route =>
    route.fulfill({contentType:'text/html',body:'Synthetic authorization endpoint'}));
  await page.goto('/?registration=complete');
  await page.waitForURL('https://auth.onesa.eu/authorize?account=synthetic');
  expect(started).toBe(1);
  // After the provider handoff, verify the original product origin, not the
  // provider's unrelated sessionStorage.
  await page.goto('/#staff');
  expect(await page.evaluate(() => sessionStorage.getItem('pasofi.registration'))).toBeNull();
});
