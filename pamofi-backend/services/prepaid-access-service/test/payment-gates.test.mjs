import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../dist/app.js';
import {paymentConfiguration} from '../dist/checkout.js';

test('legacy Pesepay and unqualified direct-provider flags cannot enable checkout, callbacks or outbound workers',async t=>{
 const env={DATABASE_URL:'postgresql://unused:unused@127.0.0.1:1/never_connect',PAMOFI_PAYMENTS_ENABLED:'true',PAMOFI_PAYMENT_MODE:'sandbox',PAMOFI_PAYMENT_PROVIDER:'pesepay',APP_ENV:'demo',NODE_ENV:'development',PAMOFI_PESEPAY_SANDBOX_ENABLED:'true',PESEPAY_SANDBOX_QUALIFIED:'true',PESEPAY_PRODUCTION_QUALIFIED:'true',PESEPAY_INTEGRATION_KEY:'synthetic-key',PESEPAY_ENCRYPTION_KEY:'0123456789abcdef0123456789abcdef',PESEPAY_APPLICATION_ID:'1234',PESEPAY_RESULT_URL:'https://pamofi.example/callbacks/pesepay',PESEPAY_RETURN_URL:'https://pamofi.example/return',PESEPAY_CHECKOUT_ORIGINS:'https://checkout.pesepay.com',PESEPAY_METHODS_JSON:'[{"active":true,"code":"PZW211","currencies":["USD"],"minimumAmount":1,"maximumAmount":500}]',PESEPAY_MERCHANT_METHOD_CODES:'PZW211',PESEPAY_SITE_METHOD_CODES_JSON:'{}',ECOCASH_ENABLED:'true',ECOCASH_SANDBOX_QUALIFIED:'true',ECOCASH_PRODUCTION_QUALIFIED:'true',PAMOFI_COMMERCE_ENABLED:'false',OUTBOX_DISPATCH_ENABLED:'false',PAMOFI_SMS_DELIVERY_ENABLED:'false',PAMOFI_CUSTOMER_NETWORK_ENABLED:'false',INTERNAL_RADIUS_ENABLED:'false'};
 const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);let calls=0;
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('outbound request forbidden in gate test');});
 try{
  for(const [mode,provider,demo]of [['sandbox','pesepay',true],['production','pesepay',false],['sandbox','ecocash',true],['ecocash_sandbox','ecocash',true],['production','ecocash',false]]){
   process.env.PAMOFI_PAYMENT_MODE=mode;process.env.PAMOFI_PAYMENT_PROVIDER=provider;process.env.APP_ENV=demo?'demo':'production';process.env.NODE_ENV=demo?'development':'production';
   assert.deepEqual(paymentConfiguration(demo),{enabled:false,mode:'disabled'});
   const app=buildApp();try{
    const caps=(await app.inject({url:'/v1/capabilities'})).json();assert.equal(caps.paymentCheckout,false);assert.equal(caps.paymentMode,'disabled');
    assert.equal((await app.inject({url:'/v1/payments/methods'})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url:`/v1/orders/${randomUUID()}/checkout`,payload:{}})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url:'/callbacks/pesepay',headers:{authorization:'synthetic-key'},payload:{referenceNumber:'PP-old'}})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url:'/callbacks/ecocash',payload:{responseCode:'00',transactionOperationStatus:'Charged'}})).statusCode,404);
   }finally{await app.close();}
  }
  process.env.PAMOFI_PAYMENT_MODE='mock';assert.deepEqual(paymentConfiguration(true),{enabled:true,mode:'mock'});assert.deepEqual(paymentConfiguration(false),{enabled:false,mode:'disabled'});
  assert.equal(calls,0);
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
