import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PesepayAdapter, encryptPesepay, decryptPesepay, eligibleMethod } from '../dist/pesepay.js';
const key='0123456789abcdef0123456789abcdef';
const config={environment:'sandbox',integrationKey:'test-integration-key',encryptionKey:key,applicationId:1234,resultUrl:'https://pamofi.example/result',returnUrl:'https://pamofi.example/return',allowedCheckoutOrigins:['https://checkout.pesepay.com']};
const method={active:true,code:'PZW211',currencies:['USD'],minimumAmount:1,maximumAmount:500};
const eligibility={method,merchantEnabledCodes:new Set(['PZW211']),siteQualifiedCodes:new Set(['PZW211'])};
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
const encrypted=data=>response({payload:encryptPesepay(data,key)});
test('provider AES-CBC compatibility vector and callback key check',()=>{
 assert.equal(encryptPesepay({amount:1},key),'FmAbUGQqV6+YfRT6ho5gJw==');
 assert.deepEqual(decryptPesepay('FmAbUGQqV6+YfRT6ho5gJw==',key),{amount:1});
 const adapter=new PesepayAdapter(config,async()=>{throw Error('unused');});
 assert.equal(adapter.callbackAuthorized('test-integration-key'),true);assert.equal(adapter.callbackAuthorized('forged'),false);
 assert.throws(()=>new PesepayAdapter({...config,environment:'typo'}));
});
test('method minimum and merchant/site qualification are enforced',()=>{
 assert.equal(eligibleMethod(method,'USD',50,eligibility.merchantEnabledCodes,eligibility.siteQualifiedCodes),false);
 assert.equal(eligibleMethod(method,'USD',100,eligibility.merchantEnabledCodes,eligibility.siteQualifiedCodes),true);
 assert.equal(eligibleMethod(method,'USD',100,eligibility.merchantEnabledCodes,new Set()),false);
});
test('initiation sends server terms, rejects unqualified methods and treats ambiguity as unknown',async()=>{
 let calls=0;const id=randomUUID();
 const adapter=new PesepayAdapter(config,async(url,init)=>{calls++;assert.match(String(url),/api\.test\.sandbox\.pesepay\.com/);const body=JSON.parse(init.body);const decoded=decryptPesepay(body.payload,key);assert.equal(decoded.amountDetails.amount,1);assert.equal(decoded.merchantReference,id);return encrypted({referenceNumber:'PP-abc123',redirectUrl:'https://checkout.pesepay.com/pay/123',pollUrl:'https://example.invalid'});});
 await assert.rejects(adapter.initiate({orderId:id,amountMinor:50,currency:'USD',methodCode:'PZW211',eligibility}),/method_not_qualified/);
 assert.equal(calls,0);
 assert.deepEqual(await adapter.initiate({orderId:id,amountMinor:100,currency:'USD',methodCode:'PZW211',eligibility}),{state:'initiated',referenceNumber:'PP-abc123',redirectUrl:'https://checkout.pesepay.com/pay/123'});
 const timeout=new PesepayAdapter(config,async()=>{calls++;throw Error('timeout');});
 assert.deepEqual(await timeout.initiate({orderId:id,amountMinor:100,currency:'USD',methodCode:'PZW211',eligibility}),{state:'unknown'});
 const unsafe=new PesepayAdapter(config,async()=>encrypted({referenceNumber:'PP-abc123',redirectUrl:'https://attacker.example/'}));
 assert.deepEqual(await unsafe.initiate({orderId:id,amountMinor:100,currency:'USD',methodCode:'PZW211',eligibility}),{state:'unknown'});
});
test('only a server response matching application, reference, currency and amount proves success',async()=>{
 const terms={referenceNumber:'PP-abc123',amountMinor:100,currency:'USD'};
 const result={referenceNumber:'PP-abc123',applicationId:1234,transactionStatus:'SUCCESS',amountDetails:{amount:1,currencyCode:'USD'}};
 const check=async data=>new PesepayAdapter(config,async()=>encrypted(data)).check(terms);
 assert.equal((await check(result)).state,'verified_success');
 assert.equal((await check({...result,transactionStatus:'PARTIALLY_PAID'})).state,'pending');
 assert.equal((await check({...result,transactionStatus:'REVERSED'})).state,'reversed');
 assert.equal((await check({...result,referenceNumber:'other'})).state,'unknown');
 assert.equal((await check({...result,applicationId:9876})).state,'unknown');
 assert.equal((await check({...result,amountDetails:{amount:1.01,currencyCode:'USD'}})).state,'unknown');
 assert.equal((await check({...result,amountDetails:{amount:1,currencyCode:'ZWG'}})).state,'unknown');
});
