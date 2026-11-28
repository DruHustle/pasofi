import {test,expect,type Page} from '@playwright/test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

// Only Stripe's browser/provider transport is synthetic here. Identity, MFA,
// agent/customer APIs, PostgreSQL, signed callbacks, inventory and invoices run
// as real services. This is not physical wallet authorization evidence.
const execute=promisify(execFile);
const identityDirectory=fileURLToPath(new URL('../../../pasofi-backend/services/identity-service/',import.meta.url));
const site=process.env.PAMOFI_TEST_AGENT_STRIPE_SITE_ID!;
const control=process.env.PAMOFI_TEST_AGENT_STRIPE_CONTROL_URL!;
const controlSecret=process.env.PAMOFI_TEST_AGENT_STRIPE_CONTROL_SECRET!;
async function identityFixture<T>(args:string[]):Promise<T>{
 if(process.env.PAMOFI_TEST_CONFIRM_ISOLATED!=='1'||!process.env.PAMOFI_TEST_IDENTITY_DATABASE_URL)throw Error('Use the isolated full browser verification gate');
 const {stdout}=await execute(process.execPath,['test/fixtures/staff.mjs',...args],{cwd:identityDirectory,timeout:45000,
  env:{...process.env,APP_ENV:'demo',NODE_ENV:'development',PAMOFI_TEST_DATABASE_URL:process.env.PAMOFI_TEST_IDENTITY_DATABASE_URL}});
 return JSON.parse(stdout.trim());
}
async function login(page:Page,user:{staffId:string;email:string;password:string},baseURL:string){
 await page.goto(baseURL);await page.getByRole('button',{name:'Staff',exact:true}).click();
 await page.getByLabel('Email',{exact:true}).fill(user.email);await page.getByLabel('Password',{exact:true}).fill(user.password);
 await page.getByRole('button',{name:'Continue to verification'}).click();
 const {code}=await identityFixture<{code:string}>(['code',user.staffId]);
 await page.getByLabel('Authenticator code').fill(code);await page.getByRole('button',{name:'Verify authenticator'}).click();
}
async function provider(path:string,body:unknown){
 const target=new URL(path,control);if(target.hostname!=='127.0.0.1')throw Error('Loopback provider fixture required');
 const result=await fetch(target,{method:'POST',headers:{authorization:'Bearer '+controlSecret,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
 expect([200,202,204]).toContain(result.status);return result;
}
async function syntheticStripe(page:Page){
 await page.addInitScript(()=>{
  const runtime=window as any;runtime.paymentConfirmations=0;
  runtime.Stripe=()=>({_registerWrapper(){},registerAppInfo(){},elements:(input:{clientSecret:string})=>({
   create:(_kind:string,options:unknown)=>{runtime.walletOptions=options;const handlers:Record<string,()=>void>={};let node:HTMLElement;
    return {on:(name:string,callback:()=>void)=>{handlers[name]=callback;},mount:(target:HTMLElement)=>{node=document.createElement('div');node.textContent='Synthetic Stripe transport for service acceptance';target.append(node);queueMicrotask(()=>handlers.ready?.());},destroy:()=>node?.remove()};},
   intent:input.clientSecret.split('_secret_')[0]
  }),confirmPayment:async({elements}:{elements:{intent:string}})=>{runtime.paymentConfirmations++;return {paymentIntent:{id:elements.intent,status:'succeeded'}};}});
 });
 await page.route('https://js.stripe.com/**',route=>route.fulfill({contentType:'application/javascript',body:''}));
}

test('real services settle direct and agent card, Apple Pay and Google Pay transport cases exactly once',async({browser,baseURL},testInfo)=>{
 test.setTimeout(240000);
 if(!site||!control||!controlSecret)throw Error('Run through verify.mjs --integration --browser');
 const admin=await identityFixture<{staffId:string;email:string;password:string}>(['create']);
 const agent=await identityFixture<typeof admin>(['create-agent',site]);
 const adminContext=await browser.newContext(),agentContext=await browser.newContext();
 const adminPage=await adminContext.newPage(),agentPage=await agentContext.newPage();
 const evidence:Record<string,unknown>[]=[];
 try{
  await login(adminPage,admin,baseURL!);await expect(adminPage.getByRole('heading',{name:'Administration',exact:true})).toBeVisible();
  const allocation=await adminPage.request.post(new URL('/api/admin/inventory/allocations',baseURL).href,{headers:{origin:baseURL!,'Idempotency-Key':randomUUID()},data:{agentId:agent.staffId,siteId:site,bundleId:'flex',quantity:3,reason:'Owned isolated digital payment browser fixture'}});
  expect(allocation.status()).toBe(201);
  await login(agentPage,agent,baseURL!);await expect(agentPage.getByRole('heading',{name:'Your sites and sales'})).toBeVisible();
  await expect(agentPage.getByRole('heading',{name:'Card and wallet sales'})).toBeVisible();
  let remaining=3;
  for(const seller of ['customer','agent'])for(const choice of ['card','apple_pay','google_pay']){
   const context=await browser.newContext(),page=await context.newPage();
   try{
    await syntheticStripe(page);
    let checkoutId:string|undefined;
    if(seller==='agent'){
     const another=agentPage.getByRole('button',{name:'Start another payment link'});if(await another.isVisible())await another.click();
     await agentPage.getByLabel('Digital sale site').selectOption(site);await agentPage.getByLabel('Digital bundle').selectOption('flex');
     const created=agentPage.waitForResponse(r=>new URL(r.url()).pathname==='/api/staff/agent-checkouts'&&r.request().method()==='POST');
     await agentPage.getByRole('button',{name:'Create customer payment link',exact:true}).click();
     const response=await created;expect(response.status()).toBe(201);const body=await response.json();checkoutId=body.checkout.id;
     const link=await agentPage.getByLabel('Customer payment link',{exact:true}).inputValue();expect(link).toBe(body.handoff.url);
     // The link survives an agent-page reload without issuing a second sale.
     await agentPage.reload();await expect(agentPage.getByLabel('Customer payment link',{exact:true})).toHaveValue(link);
     await page.goto(link);
     await expect(page.getByRole('combobox',{name:'Bundle',exact:true})).toHaveValue('flex');
     await expect(page.getByRole('combobox',{name:'Bundle',exact:true})).toBeDisabled();
    }else{
     await page.goto(new URL('/#checkout?bundle=flex',baseURL).href);
     await page.getByLabel('Purchase site').selectOption(site);
    }
    await page.getByRole('checkbox',{name:/reviewed the price/}).check();
    const prepared=page.waitForResponse(r=>/^\/api\/orders\/[0-9a-f-]+\/checkout$/.test(new URL(r.url()).pathname)&&r.request().method()==='POST');
    await page.getByRole('button',{name:'Prepare checkout',exact:true}).click();
    const prepareResponse=await prepared;expect([200,201]).toContain(prepareResponse.status());const preparedBody=await prepareResponse.json();
    const orderId=new URL(prepareResponse.url()).pathname.split('/')[3];
    const reference=preparedBody.stripe.clientSecret.split('_secret_')[0];
    await expect(page.getByRole('form',{name:'Secure payment',exact:true})).toBeVisible();
    expect(await page.evaluate(()=>(window as any).walletOptions.wallets)).toEqual({applePay:'auto',googlePay:'auto',link:'never'});
    const before=await (await page.request.get(new URL('/api/access',baseURL).href)).json();expect(before.entitlements).toHaveLength(0);
    await page.getByRole('button',{name:'Pay $1.00',exact:true}).click();
    await expect(page.getByText('Payment not confirmed.',{exact:false})).toBeVisible();
    expect((await (await page.request.get(new URL('/api/access',baseURL).href)).json()).entitlements).toHaveLength(0);
    if(checkoutId){
     const pending=await (await agentPage.request.get(new URL('/api/staff/agent-checkouts/'+checkoutId,baseURL).href)).json();
     expect(pending.checkout.stockState).toBe('reserved');expect(pending.checkout.commission.state).toBe('unearned');
    }
    await provider('/event',{reference,outcome:'succeed',...(choice==='card'?{}:{wallet:choice})});
    await expect.poll(async()=>{const status=await (await page.request.get(new URL('/api/orders/'+orderId+'/status',baseURL).href)).json();return status.fulfillmentState;}).toBe('fulfilled');
    await page.getByRole('button',{name:'Check verified payment status'}).click();
    await expect(page.getByText('Simulated payment verified.',{exact:false})).toBeVisible();
    await provider('/event',{reference,outcome:'replay'});
    const access=await (await page.request.get(new URL('/api/access',baseURL).href)).json();expect(access.entitlements).toHaveLength(1);expect(access.entitlements[0].activated_at).toBeNull();
    const status=await (await page.request.get(new URL('/api/orders/'+orderId+'/status',baseURL).href)).json();expect(status.attempts).toHaveLength(1);
    const invoices=await (await page.request.get(new URL('/api/customer/invoices',baseURL).href)).json();expect(invoices.invoices.filter((item:{orderId:string})=>item.orderId===orderId)).toHaveLength(1);
    const stored=await page.evaluate(()=>JSON.stringify(sessionStorage)+JSON.stringify(localStorage));expect(stored).not.toContain(preparedBody.stripe.clientSecret);
    if(checkoutId){
     remaining--;
     await agentPage.getByRole('button',{name:'Check this payment'}).click();
     await expect(agentPage.getByLabel('Selected card or wallet sale').getByText('Payment verified',{exact:true})).toBeVisible();
     const paid=await (await agentPage.request.get(new URL('/api/staff/agent-checkouts/'+checkoutId,baseURL).href)).json();
     expect(paid.checkout.commission).toMatchObject({state:'earned',basisPoints:1000,amountMinor:10});expect(paid.checkout.stockState).toBe('consumed');
     const inventory=await (await agentPage.request.get(new URL('/api/staff/inventory',baseURL).href)).json();expect(inventory.inventory.find((row:{siteId:string;bundleId:string})=>row.siteId===site&&row.bundleId==='flex').quantity).toBe(remaining);
     const shifts=await (await agentPage.request.get(new URL('/api/staff/cash-shifts',baseURL).href)).json();expect(shifts.shifts).toHaveLength(0);
     if(choice==='google_pay'){
      await provider('/event',{reference,outcome:'refund'});
      await expect.poll(async()=>{const value=await(await agentPage.request.get(new URL('/api/staff/agent-checkouts/'+checkoutId,baseURL).href)).json();return value.checkout.commission.state;}).toBe('reversed');
     }
    }
    evidence.push({seller,transport:choice,provider:'synthetic Stripe SDK',testMode:true,oneOrder:true,oneAttempt:true,oneEntitlement:true,oneInvoice:true,serverVerified:true});
    if(seller==='agent'&&choice==='card'){
     await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
     await page.screenshot({path:testInfo.outputPath('agent-customer-payment-390.png'),fullPage:true});
     await agentPage.setViewportSize({width:1280,height:1000});await agentPage.getByRole('heading',{name:'Card and wallet sales'}).scrollIntoViewIfNeeded();
     await agentPage.locator('.agent-digital-sales').screenshot({path:testInfo.outputPath('agent-sales-1280.png')});
    }
   }finally{await context.close();}
  }
  await testInfo.attach('payment-service-evidence',{body:JSON.stringify(evidence,null,2),contentType:'application/json'});
 }finally{
  await Promise.all([adminContext.close(),agentContext.close()]);
  await provider('/cleanup',{});
  await identityFixture(['remove',agent.staffId]);await identityFixture(['remove',admin.staffId]);
 }
});
