import {test,expect,type Page} from '@playwright/test';
import {usageSnapshot} from './usage-fixture';

// EcoCash checkout is only offered when the server advertises it. The browser
// collects the customer's own wallet number (never a PIN) and shows an
// "approve on your phone" state; only the server's verified status queues access.
const customerId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',siteId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const orderId='ffffffff-ffff-4fff-8fff-ffffffffffff',attemptId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
async function fixture(page:Page){
 let verified=false;const bodies:unknown[]=[];
 const order={id:orderId,bundle_id:'flex',price_minor:100,currency:'USD',status:'awaiting_payment',quote_expires_at:new Date(Date.now()+900000).toISOString(),purchase_mode:'checkout'};
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname;
  const json=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(path==='/api/capabilities')return json({demo:true,paymentMode:'sandbox',paymentCheckout:true,ecocashCheckout:true,vouchers:true,receiptPairing:false,staffSales:false,deliverySms:false,networkAccess:false,mobileCookies:false});
  if(path==='/api/session')return json({customerId});
  if(path==='/api/bundles')return json({products:[{id:'flex',price_minor:100,currency:'USD',byte_limit:'5000000000',validity_seconds:604800}]});
  if(path==='/api/sites')return json({sites:[{id:siteId,name:'Synthetic EcoCash site'}]});
  if(path==='/api/help')return json({articles:[]});
  if(path==='/api/recovery/status')return json({configured:false});
  if(path==='/api/usage')return json(usageSnapshot('0',{allowanceBytes:'0'}));
  if(path==='/api/access')return json({customerId,entitlements:[],hasMore:false,nextOffset:null});
  if(path==='/api/payments/methods')return json({enabled:true,mode:'sandbox',simulation:true,methods:[{code:'ECOCASH',name:'EcoCash',currency:'USD',minMinor:50,maxMinor:50000}]});
  if(path==='/api/orders')return json(request.method()==='POST'?{order}:{customerId,lookupKey:url.searchParams.get('requestKey'),orders:[order]});
  if(path===`/api/orders/${orderId}/checkout`){bodies.push(request.postDataJSON());return json({attemptId,state:'pending',redirectUrl:null,simulation:true,ecocash:{provider:'ecocash',payerHint:'653',awaitingApproval:true}});}
  if(path===`/api/orders/${orderId}/status`)return json({order:{...order,status:verified?'payment_confirmed':'awaiting_payment'},attempts:[{id:attemptId,provider:'ecocash_test',state:verified?'succeeded':'pending'}],entitlementId:verified?'11111111-1111-4111-8111-111111111111':null,entitlementRevokedAt:null,fulfillmentState:verified?'fulfilled':'unconfirmed',simulation:true});
  return json({error:'unexpected_request'},500);
 });
 await page.goto('/#checkout?bundle=flex');
 await page.getByLabel('Payment method').selectOption('ECOCASH');
 return {bodies,verify:()=>{verified=true;}};
}

test('EcoCash checkout sends the normalized payer number once and waits for server verification',async({page})=>{
 const f=await fixture(page);
 const number=page.getByLabel('EcoCash number');
 await expect(number).toBeVisible();
 await expect(page.getByText('PasoFi never asks for your EcoCash PIN',{exact:false})).toBeVisible();
 await expect(page.getByLabel(/pin/i)).toHaveCount(0);
 await expect(page.getByRole('region',{name:'Two ways to pay with EcoCash'}).getByText('Available: choose EcoCash',{exact:false})).toBeVisible();
 await page.getByRole('checkbox',{name:/reviewed the price/}).check();
 await number.fill('12345');await page.getByRole('button',{name:'Prepare checkout'}).click();
 await expect(page.getByText('Enter the EcoCash number that will approve this payment',{exact:false})).toBeVisible();
 expect(f.bodies).toHaveLength(0);
 await number.fill('077 304 7653');await page.getByRole('button',{name:'Prepare checkout'}).click();
 await expect(page.getByRole('heading',{name:'Approve on your phone'})).toBeVisible();
 await expect(page.getByText('number ending 653',{exact:false})).toBeVisible();
 expect(f.bodies).toEqual([{siteId,methodCode:'ECOCASH',payerMsisdn:'0773047653'}]);
 await expect(page.getByText('Bundle queued',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Check verified payment status'}).click();
 await expect(page.getByRole('heading',{name:'Approve on your phone'})).toBeVisible();
 f.verify();await page.getByRole('button',{name:'Check verified payment status'}).click();
 await expect(page.getByText('Simulated payment verified.',{exact:false})).toBeVisible();
 await expect(page.getByRole('heading',{name:'Approve on your phone'})).toHaveCount(0);
 expect(f.bodies).toHaveLength(1);
});
