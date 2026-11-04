import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {EcoCashSandboxAdapter,prepareEcoCashPayment} from '../dist/ecocash.js';

const config={environment:'sandbox',username:'synthetic-user',password:'synthetic-password',merchantCode:'001535',merchantPin:'0000',merchantNumber:'263788732685',terminalID:'UAT00003',location:'Synthetic site',superMerchantName:'ECOCASH',merchantName:'PasoFi sandbox fixture'};
const prepared=()=>prepareEcoCashPayment({attemptId:randomUUID(),orderId:randomUUID(),customerMsisdn:'263773047653',amountMinor:125,currency:'USD'});
const success=p=>({clientCorrelator:p.clientCorrelator,referenceCode:p.referenceCode,endUserId:p.endUserId,ecocashReference:'MP260508.1439.T0782584',transactionOperationStatus:'Charged',responseCode:'00'});
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

test('direct EcoCash sandbox preparation uses the official Online Payments request and Basic authentication',async()=>{
 const p=prepared();let posts=0;
 const adapter=new EcoCashSandboxAdapter(config,async(url,request)=>{
  posts++;assert.equal(url,'https://developers.ecocash.co.zw/sandbox/payment/v1/transactions/amount/');assert.equal(request.method,'POST');
  assert.equal(request.headers.authorization,`Basic ${Buffer.from('synthetic-user:synthetic-password').toString('base64')}`);
  assert.equal(request.redirect,'error');assert.ok(request.signal instanceof AbortSignal);
  const body=JSON.parse(request.body);assert.equal(body.clientCorrelator,p.attemptId);assert.equal(body.referenceCode,p.attemptId);assert.equal(body.endUserId,'773047653');assert.equal(body.tranType,'MER');
  assert.deepEqual(body.paymentAmount.charginginformation,{amount:1.25,currency:'USD',description:`PasoFi order ${p.orderId}`});
  assert.equal(body.merchantPin,config.merchantPin);assert.equal(body.merchantNumber,'788732685');assert.equal(body.terminalID,config.terminalID);
  assert.equal(body.notifyUrl,undefined);assert.equal(body.pin,undefined);assert.equal(request.headers['X-Client-Id'],undefined);assert.equal(body.serviceType,undefined);
  return json(success(p));
 });
 assert.equal(Object.isFrozen(p),true);assert.equal(adapter.supportsAutomaticFulfillment,false);
 assert.equal(JSON.stringify(adapter).includes(config.password),false);assert.equal(JSON.stringify(adapter).includes(config.merchantPin),false);
 const result=await adapter.initiate(p);assert.equal(result.state,'lookup_required');assert.equal(result.providerReference,'MP260508.1439.T0782584');assert.equal(posts,1);
});
test('lost EcoCash initiation is recovered only by the original read-only lookup and never credits inferred terms',async()=>{
 const p=prepared();let posts=0,gets=0;
 const adapter=new EcoCashSandboxAdapter(config,async(url,request)=>{
  if(request.method==='POST'){posts++;throw Error('ambiguous transport timeout');}
  gets++;assert.equal(url,`https://developers.ecocash.co.zw/sandbox/payment/v1/773047653/transactions/amount/${p.clientCorrelator}`);
  assert.equal(request.method,'GET');assert.equal(request.body,undefined);assert.equal(request.redirect,'error');
  return json(success(p));
 });
 const unknown=await adapter.initiate(p);assert.deepEqual(unknown,{state:'lookup_required',clientCorrelator:p.clientCorrelator,referenceCode:p.referenceCode});
 const first=await adapter.lookup(p),second=await adapter.lookup(p);
 assert.equal(posts,1);assert.equal(gets,2);assert.deepEqual(second,first);
 assert.equal(first.state,'review_required');assert.equal(first.reason,'settlement_terms_unverified');assert.equal(first.amountMinor,undefined);assert.equal(first.currency,undefined);
});
test('EcoCash lookup rejects mismatched identity, unqualified status and undocumented extra settlement fields',async()=>{
 const p=prepared();
 for(const overrides of [{clientCorrelator:randomUUID()},{referenceCode:randomUUID()},{endUserId:'778000000'},{ecocashReference:''},{responseCode:0},{responseCode:'01'},{transactionOperationStatus:'SUCCESS'},{transactionOperationStatus:'TS'},{transactionOperationStatus:'Refunded'},{transactionOperationStatus:'Reversed'}]){
  const result=await new EcoCashSandboxAdapter(config,async()=>json({...success(p),...overrides})).lookup(p);
  assert.equal(result.state,'unknown',JSON.stringify(overrides));
 }
 const added=await new EcoCashSandboxAdapter(config,async()=>json({...success(p),amount:1.25,currency:'USD',merchantCode:config.merchantCode})).lookup(p);
 assert.equal(added.state,'review_required');
});
test('EcoCash errors, oversized responses and redirects never authorize fulfillment or retry initiation',async()=>{
 const p=prepared();
 for(const status of [400,401,404,422,500,302]){
  const adapter=new EcoCashSandboxAdapter(config,async()=>json({responseCode:'00',transactionOperationStatus:'Charged'},status));
  assert.equal((await adapter.initiate(p)).state,'lookup_required');assert.equal((await adapter.lookup(p)).state,'unknown');
 }
 const oversized=new EcoCashSandboxAdapter(config,async()=>json({...success(p),padding:'x'.repeat(70000)}));
 assert.equal((await oversized.initiate(p)).providerReference,undefined);assert.equal((await oversized.lookup(p)).state,'unknown');
 const malformed=new EcoCashSandboxAdapter(config,async()=>new Response('{invalid-json'));
 assert.equal((await malformed.lookup(p)).state,'unknown');
});
test('EcoCash preparation has no production endpoint or customer-PIN configuration path',async()=>{
 assert.throws(()=>new EcoCashSandboxAdapter({...config,environment:'production'}),/production_contract_unqualified/);
 assert.throws(()=>new EcoCashSandboxAdapter({...config,merchantPin:'1234'}),/invalid_ecocash_sandbox_configuration/);
 assert.throws(()=>new EcoCashSandboxAdapter({...config,username:'bad:user'}),/invalid_ecocash_sandbox_configuration/);
 for(const changed of [{customerMsisdn:'https://foreign.example'},{currency:'ZWG'},{amountMinor:1.5},{amountMinor:0},{attemptId:'not-a-unique-uuid'}]){
  assert.throws(()=>prepareEcoCashPayment({attemptId:randomUUID(),orderId:randomUUID(),customerMsisdn:'0773047653',amountMinor:50,currency:'USD',...changed}));
 }
 const p=prepared();let calls=0;
 const adapter=new EcoCashSandboxAdapter(config,async()=>{calls++;return json(success(p));});
 await assert.rejects(adapter.initiate({...p,clientCorrelator:randomUUID()}),/invalid_prepared/);
 assert.equal(calls,0);
});
