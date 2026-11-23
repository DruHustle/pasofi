import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../dist/app.js';
import {paymentConfiguration,ecocashCheckoutAvailable} from '../dist/checkout.js';
import {ecocashCheckoutConfiguration,payerNumber} from '../dist/ecocash-checkout.js';
import {EcoCashOnlinePaymentsClient,prepareEcoCashPayment} from '../dist/ecocash.js';

const site=randomUUID();
const keys=JSON.stringify({k1:Buffer.alloc(32,7).toString('base64')});
// Synthetic sandbox values only; no real merchant or customer data.
const sandbox={PAMOFI_PAYMENTS_ENABLED:'true',PAMOFI_ECOCASH_CHECKOUT_ENABLED:'true',ECOCASH_ENVIRONMENT:'sandbox',APP_ENV:'demo',NODE_ENV:'development',
 ECOCASH_API_USERNAME:'synthetic-user',ECOCASH_API_PASSWORD:'synthetic-password',ECOCASH_MERCHANT_CODE:'001535',ECOCASH_MERCHANT_PIN:'0000',
 ECOCASH_MERCHANT_NUMBER:'263788732685',ECOCASH_TERMINAL_ID:'UAT00003',ECOCASH_LOCATION:'Synthetic site',ECOCASH_SUPER_MERCHANT_NAME:'ECOCASH',
 ECOCASH_MERCHANT_NAME:'Pasofi sandbox fixture',ECOCASH_QUALIFIED_SITE_IDS_JSON:JSON.stringify([site]),
 VOUCHER_DELIVERY_ACTIVE_KEY_ID:'k1',VOUCHER_DELIVERY_KEYS_JSON:keys};
const production={...sandbox,ECOCASH_ENVIRONMENT:'production',APP_ENV:'production',NODE_ENV:'production',PAMOFI_PAYMENT_MODE:'production',
 ECOCASH_PRODUCTION_QUALIFIED:'true',ECOCASH_API_BASE_URL:'https://payments.ecocash.invalid/payment/v1/',ECOCASH_MERCHANT_PIN:'4821',
 PAMOFI_CUSTOMER_NETWORK_ENABLED:'true',PAMOFI_RADIUS_QUALIFIED:'true',PAMOFI_ROUTER_CONTROL_QUALIFIED:'true'};
const names=[...new Set([...Object.keys(production),'PAMOFI_PAYMENT_PROVIDER','PAMOFI_PAYMENT_MODE','DATABASE_URL'])];

async function withEnv(values,fn){
 const saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 for(const name of names)delete process.env[name];Object.assign(process.env,values);
 try{return await fn();}finally{for(const [name,value]of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
}

test('ECO-001 EcoCash stays off by default: no capability, no routes and no outbound calls',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('outbound request forbidden');});
 const {PAMOFI_ECOCASH_CHECKOUT_ENABLED:_off,...configuredButOff}=sandbox;
 for(const env of [{},configuredButOff,{...sandbox,PAMOFI_PAYMENTS_ENABLED:'false'}]){
  await withEnv({...env,DATABASE_URL:'postgresql://unused:unused@127.0.0.1:1/never_connect',PAMOFI_COMMERCE_ENABLED:'false',OUTBOX_DISPATCH_ENABLED:'false',INTERNAL_RADIUS_ENABLED:'false'},async()=>{
   assert.deepEqual(paymentConfiguration(true),{enabled:false,mode:'disabled'});
   assert.equal(ecocashCheckoutAvailable(true),false);
   const app=buildApp();try{
    const caps=(await app.inject({url:'/v1/capabilities'})).json();
    assert.equal(caps.ecocashCheckout,false);assert.equal(caps.paymentCheckout,false);assert.equal(caps.paymentMode,'disabled');
    assert.equal((await app.inject({url:`/v1/payments/methods?siteId=${site}&bundleId=flex`})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url:`/v1/orders/${randomUUID()}/checkout`,payload:{siteId:site,methodCode:'ECOCASH',payerMsisdn:'0773047653'}})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url:'/callbacks/ecocash',payload:{responseCode:'00',transactionOperationStatus:'Charged'}})).statusCode,404);
   }finally{await app.close();}
  });
 }
 assert.equal(calls,0);
});

test('ECO-002 every activation requirement is independently required and fails closed',async()=>{
 await withEnv(sandbox,async()=>{
  assert.deepEqual(paymentConfiguration(true),{enabled:true,mode:'sandbox'});
  assert.equal(ecocashCheckoutAvailable(true),true);
  assert.equal(ecocashCheckoutConfiguration(true)?.live,false);
  assert.equal(ecocashCheckoutConfiguration(false),null,'sandbox credentials never configure a non-demo service');
 });
 const sandboxRequired=['ECOCASH_ENVIRONMENT','ECOCASH_API_USERNAME','ECOCASH_API_PASSWORD','ECOCASH_MERCHANT_CODE','ECOCASH_MERCHANT_PIN','ECOCASH_MERCHANT_NUMBER',
  'ECOCASH_TERMINAL_ID','ECOCASH_LOCATION','ECOCASH_SUPER_MERCHANT_NAME','ECOCASH_MERCHANT_NAME','VOUCHER_DELIVERY_ACTIVE_KEY_ID','VOUCHER_DELIVERY_KEYS_JSON'];
 for(const name of sandboxRequired){
  const {[name]:_missing,...env}=sandbox;
  await withEnv(env,async()=>{assert.equal(ecocashCheckoutConfiguration(true),null,name);assert.deepEqual(paymentConfiguration(true),{enabled:false,mode:'disabled'},name);});
 }
 for(const [name,value] of [['ECOCASH_MERCHANT_PIN','1234'],['ECOCASH_API_USERNAME','bad:user'],['ECOCASH_MERCHANT_NUMBER','12345'],['ECOCASH_QUALIFIED_SITE_IDS_JSON','["not-a-uuid"]'],['ECOCASH_QUALIFIED_SITE_IDS_JSON','{'],['ECOCASH_ENVIRONMENT','Sandbox']]){
  await withEnv({...sandbox,[name]:value},async()=>assert.equal(ecocashCheckoutConfiguration(true),null,`${name}=${value}`));
 }
 // An empty site list keeps reconciliation configured but sells nothing.
 await withEnv({...sandbox,ECOCASH_QUALIFIED_SITE_IDS_JSON:'[]'},async()=>{assert.equal(ecocashCheckoutConfiguration(true)?.newCheckout,false);assert.equal(ecocashCheckoutAvailable(true),false);});
 // A provider-selector typo can never be "rescued" into EcoCash or mock.
 for(const provider of ['ecocash','pesepay','','MOCK','stripe ']){
  await withEnv({...sandbox,PAMOFI_PAYMENT_PROVIDER:provider},async()=>{assert.deepEqual(paymentConfiguration(true),{enabled:false,mode:'disabled'},provider);assert.equal(ecocashCheckoutAvailable(true),false);});
 }
 await withEnv(production,async()=>{
  assert.deepEqual(paymentConfiguration(false),{enabled:true,mode:'production'});
  assert.equal(ecocashCheckoutConfiguration(false)?.live,true);
  assert.equal(ecocashCheckoutConfiguration(true),null,'production configuration is refused in demo');
 });
 await withEnv({...production,PAMOFI_PAYMENT_PROVIDER:'mock'},async()=>{
  assert.deepEqual(paymentConfiguration(false),{enabled:false,mode:'disabled'},'the demo-only selector cannot expose live checkout');
  assert.equal(ecocashCheckoutAvailable(false),false);
  assert.equal(ecocashCheckoutConfiguration(false)?.live,true,'existing EcoCash attempts can still be reconciled');
 });
 for(const name of ['ECOCASH_PRODUCTION_QUALIFIED','ECOCASH_API_BASE_URL','PAMOFI_PAYMENT_MODE']){
  const {[name]:_missing,...env}=production;
  await withEnv(env,async()=>assert.equal(ecocashCheckoutConfiguration(false),null,name));
 }
 for(const name of ['PAMOFI_CUSTOMER_NETWORK_ENABLED','PAMOFI_RADIUS_QUALIFIED','PAMOFI_ROUTER_CONTROL_QUALIFIED','PAMOFI_ECOCASH_CHECKOUT_ENABLED']){
  await withEnv({...production,[name]:'false'},async()=>{
   assert.equal(ecocashCheckoutConfiguration(false)?.newCheckout,false,`${name} closes new checkout`);
   assert.deepEqual(paymentConfiguration(false),{enabled:false,mode:'disabled'},name);
  });
 }
 for(const url of ['http://payments.ecocash.invalid/payment/v1/','https://user:pw@payments.ecocash.invalid/v1/','https://payments.ecocash.invalid/v1/?x=1','https://payments.ecocash.invalid/v1','https://developers.ecocash.co.zw/sandbox/payment/v1/','not a url']){
  await withEnv({...production,ECOCASH_API_BASE_URL:url},async()=>assert.equal(ecocashCheckoutConfiguration(false),null,url));
 }
});

test('payer numbers are normalized to the EcoCash subscriber form and anything else is rejected',()=>{
 for(const value of ['0773047653','263773047653','+263773047653','077 304 7653','077-304-7653','773047653'])assert.equal(payerNumber(value),'773047653',value);
 for(const value of ['','0123456789','+44773047653','07730476531','https://x.example',12345,null,'0'.repeat(20)])assert.throws(()=>payerNumber(value),/invalid_ecocash_number/,String(value));
});

test('settlement lookup reports only provider-supplied terms and never request values',async()=>{
 const config={environment:'sandbox',username:'synthetic-user',password:'synthetic-password',merchantCode:'001535',merchantPin:'0000',merchantNumber:'263788732685',terminalID:'UAT00003',location:'Synthetic site',superMerchantName:'ECOCASH',merchantName:'Pasofi sandbox fixture'};
 const p=prepareEcoCashPayment({attemptId:randomUUID(),orderId:randomUUID(),customerMsisdn:'0773047653',amountMinor:125,currency:'USD'});
 const base={clientCorrelator:p.clientCorrelator,referenceCode:p.referenceCode,endUserId:p.endUserId,ecocashReference:'MP260508.1439.T0782584',transactionOperationStatus:'Charged',responseCode:'00'};
 const reply=body=>new EcoCashOnlinePaymentsClient(config,async()=>new Response(JSON.stringify(body),{status:200})).lookupSettlement(p);
 assert.deepEqual(await reply(base),{state:'charged',providerReference:base.ecocashReference,amountMinor:null,currency:null,merchantCode:null});
 assert.deepEqual(await reply({...base,merchantCode:'001535',paymentAmount:{totalAmountCharged:'1.25',charginginformation:{amount:1.25,currency:'USD'}}}),
  {state:'charged',providerReference:base.ecocashReference,amountMinor:125,currency:'USD',merchantCode:'001535'});
 for(const bad of [{amount:'1.255'},{amount:-1},{amount:'abc'}])assert.equal((await reply({...base,paymentAmount:{charginginformation:{...bad,currency:'USD'}}})).amountMinor,null);
 for(const overrides of [{responseCode:'01'},{transactionOperationStatus:'PENDING SUBSCRIBER VALIDATION'},{clientCorrelator:randomUUID()},{endUserId:'778000000'}])assert.deepEqual(await reply({...base,...overrides}),{state:'unknown'});
 const production=new EcoCashOnlinePaymentsClient({...config,environment:'production',merchantPin:'4821',baseUrl:'https://payments.ecocash.invalid/payment/v1/'},async()=>{throw Error('unreachable');});
 await assert.rejects(production.lookupSettlement(p),/invalid_prepared/,'a sandbox-prepared payment cannot be sent to a production client');
});
