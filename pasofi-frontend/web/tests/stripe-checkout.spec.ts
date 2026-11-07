import {test,expect,type Page} from '@playwright/test';
import {usageSnapshot} from './usage-fixture';

const customerId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',siteId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const orderId='ffffffff-ffff-4fff-8fff-ffffffffffff',attemptId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const secret='pi_SyntheticPayment123_secret_SYNTHETIC';
async function fixture(page:Page){
 let verified=false,owner=customerId;const checkoutKeys:string[]=[];
 const order={id:orderId,bundle_id:'flex',price_minor:500,currency:'USD',status:'awaiting_payment',quote_expires_at:new Date(Date.now()+900000).toISOString(),purchase_mode:'checkout'};
 await page.addInitScript(()=>{
  const runtime=window as any;runtime.stripeConfirmCount=0;runtime.stripeDecline=false;
  runtime.Stripe=()=>({_registerWrapper(){},registerAppInfo(){},elements:()=>({create:(_kind:string,options:Record<string,unknown>)=>{
   runtime.stripeWallets=options.wallets;
   const callbacks:Record<string,()=>void>={};let node:HTMLElement;
   return {on:(name:string,callback:()=>void)=>{callbacks[name]=callback;},mount:(target:HTMLElement)=>{node=document.createElement('div');node.textContent='Synthetic secure card iframe';target.append(node);queueMicrotask(()=>callbacks.ready?.());},destroy:()=>node?.remove()};
  }}),confirmPayment:async()=>{runtime.stripeConfirmCount++;return runtime.stripeDecline?{error:{type:'card_error',message:'Your card was declined.'}}:{paymentIntent:{id:'pi_SyntheticPayment123',status:'succeeded'}};}});
 });
 await page.route('https://js.stripe.com/**',route=>route.fulfill({contentType:'application/javascript',body:''}));
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;
  const json=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(path==='/api/capabilities')return json({demo:true,paymentMode:'sandbox',paymentCheckout:true,vouchers:true,receiptPairing:false,staffSales:false,deliverySms:false,networkAccess:false,mobileCookies:false});
  if(path==='/api/session')return json({customerId:owner});
  if(path==='/api/bundles')return json({products:[{id:'flex',price_minor:500,currency:'USD',byte_limit:'5000000000',validity_seconds:604800}]});
  if(path==='/api/sites')return json({sites:[{id:siteId,name:'Synthetic payment site'}]});
  if(path==='/api/help')return json({articles:[]});
  if(path==='/api/recovery/status')return json({configured:false});
  if(path==='/api/usage')return json(usageSnapshot('0',{allowanceBytes:'0'}));
  if(path==='/api/access')return json({customerId:owner,entitlements:[],hasMore:false,nextOffset:null});
  if(path==='/api/payments/methods')return json({enabled:true,mode:'sandbox',simulation:true,methods:[{code:'STRIPE_CARD',name:'Card or mobile wallet',currency:'USD',minMinor:50,maxMinor:99999999}]});
  if(path==='/api/orders')return json(request.method()==='POST'?{order}:{customerId:owner,lookupKey:url.searchParams.get('requestKey'),orders:[order]});
  if(path===`/api/orders/${orderId}/checkout`){
   checkoutKeys.push(request.headers()['idempotency-key']);expect(request.postDataJSON()).toEqual({siteId,methodCode:'STRIPE_CARD'});
   return json({attemptId,state:'pending',redirectUrl:null,simulation:true,stripe:{provider:'stripe',clientSecret:secret,publishableKey:['pk','test','SYNTHETIC'].join('_'),testMode:true,merchantCountryCode:'GB',merchantDisplayName:'PasoFi',applePayMerchantId:null,googlePay:false}});
  }
  if(path===`/api/orders/${orderId}/status`)return json({order:{...order,status:verified?'payment_confirmed':'awaiting_payment'},attempts:[{id:attemptId,state:verified?'succeeded':'pending'}],entitlementId:verified?'11111111-1111-4111-8111-111111111111':null,entitlementRevokedAt:null,fulfillmentState:verified?'fulfilled':'unconfirmed',simulation:true});
  return json({error:'unexpected_request'},500);
 });
 await page.goto('/#checkout?bundle=flex');
 await page.getByRole('checkbox',{name:/reviewed the price/}).check();await page.getByRole('button',{name:'Prepare checkout'}).click();
 await expect(page.getByRole('form',{name:'Secure card payment'})).toBeVisible();
 return {checkoutKeys,verify:()=>{verified=true;},changeOwner:()=>{owner='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';}};
}

test('Stripe completion cannot grant access until the server verifies the saved order',async({page})=>{
 const f=await fixture(page);
 expect(await page.evaluate(()=>(window as any).stripeWallets)).toEqual({applePay:'never',googlePay:'never',link:'never'});
 await page.getByRole('button',{name:'Pay $5.00',exact:true}).click();
 await expect(page.getByText('Payment not confirmed.',{exact:false})).toBeVisible();
 await expect(page.getByRole('form',{name:'Secure card payment'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Check verified payment status'})).toBeEnabled();
 await expect(page.getByText('Bundle queued',{exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>JSON.stringify(sessionStorage)+JSON.stringify(localStorage))).not.toContain(secret);
 f.verify();await page.getByRole('button',{name:'Check verified payment status'}).click();
 await expect(page.getByText('Simulated payment verified.',{exact:false})).toBeVisible();
 expect(f.checkoutKeys).toHaveLength(1);expect(await page.evaluate(()=>(window as any).stripeConfirmCount)).toBe(1);
});

test('card decline and reload preserve the original checkout key without persisting its client secret',async({page})=>{
 const f=await fixture(page);await page.evaluate(()=>{(window as any).stripeDecline=true;});
 await page.getByRole('button',{name:'Pay $5.00',exact:true}).click();await expect(page.getByText('Your card was declined.',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>JSON.stringify(sessionStorage)+JSON.stringify(localStorage))).not.toContain(secret);
 await page.reload();await page.getByRole('checkbox',{name:/reviewed the price/}).check();await page.getByRole('button',{name:'Retry this checkout safely'}).click();
 await expect(page.getByRole('form',{name:'Secure card payment'})).toBeVisible();expect(f.checkoutKeys).toHaveLength(2);expect(new Set(f.checkoutKeys).size).toBe(1);
});

test('a changed customer session cannot confirm a previously prepared Stripe payment',async({page})=>{
 const f=await fixture(page);f.changeOwner();await page.getByRole('button',{name:'Pay $5.00',exact:true}).click();
 await expect(page.getByRole('form',{name:'Secure card payment'})).toHaveCount(0);
 expect(await page.evaluate(()=>(window as any).stripeConfirmCount)).toBe(0);
});
