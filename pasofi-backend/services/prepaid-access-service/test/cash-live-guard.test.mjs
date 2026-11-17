import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../dist/app.js';
import {approvedCashSiteIds} from '../dist/commerce.js';

// Configuration-only checks: no payments, identity requests, test database,
// RADIUS packets or physical RouterOS commands are performed.
test('production new cash sales fail closed without both physical approval and qualified network configuration',async()=>{
 const vars={
  APP_ENV:'production',NODE_ENV:'production',DATABASE_URL:'',
  PAMOFI_COMMERCE_ENABLED:'true',PAMOFI_AGENT_COMMISSION_BPS:'0',
  VOUCHER_DELIVERY_ACTIVE_KEY_ID:'test',
  VOUCHER_DELIVERY_KEYS_JSON:JSON.stringify({test:Buffer.alloc(32,5).toString('base64')}),
  PAMOFI_SMS_DELIVERY_ENABLED:'false',
  PAMOFI_CASH_CUSTOMER_GO:'false',
  PAMOFI_CASH_APPROVED_SITE_IDS_JSON:'[]',
  PAMOFI_CUSTOMER_NETWORK_ENABLED:'false',
  PAMOFI_RADIUS_QUALIFIED:'false',
  INTERNAL_NETWORK_SECRET:'test_network_secret_longer_than_32_chars',
  NETWORK_URL:'https://network.internal.example'
 };
 const saved=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]]));
 const read=async changes=>{Object.assign(process.env,vars,changes);const app=buildApp();try{return (await app.inject({url:'/v1/capabilities'})).json();}finally{await app.close();}};
 try{
  let c=await read({});assert.equal(c.staffSales,false);assert.equal(c.receiptPairing,false);assert.equal(c.networkAccess,false);
  c=await read({PAMOFI_CASH_CUSTOMER_GO:'true'});assert.equal(c.staffSales,false);
  c=await read({PAMOFI_CUSTOMER_NETWORK_ENABLED:'true',PAMOFI_RADIUS_QUALIFIED:'true'});assert.equal(c.networkAccess,true);assert.equal(c.staffSales,false);
  c=await read({PAMOFI_CASH_CUSTOMER_GO:'true',PAMOFI_CUSTOMER_NETWORK_ENABLED:'true',PAMOFI_RADIUS_QUALIFIED:'true',PAMOFI_CASH_APPROVED_SITE_IDS_JSON:'["11111111-1111-4111-8111-111111111111"]'});assert.equal(c.networkAccess,true);assert.equal(c.staffSales,true);assert.equal(c.receiptPairing,true);
  c=await read({PAMOFI_CASH_CUSTOMER_GO:'true',PAMOFI_CUSTOMER_NETWORK_ENABLED:'true',PAMOFI_RADIUS_QUALIFIED:'true',PAMOFI_CASH_APPROVED_SITE_IDS_JSON:'["11111111-1111-4111-8111-111111111111"]',PAMOFI_COMMERCE_ENABLED:'false'});assert.equal(c.staffSales,false);assert.equal(c.receiptPairing,false);
  c=await read({PAMOFI_CASH_CUSTOMER_GO:'true',PAMOFI_CUSTOMER_NETWORK_ENABLED:'true',PAMOFI_RADIUS_QUALIFIED:'true',PAMOFI_CASH_APPROVED_SITE_IDS_JSON:'["11111111-1111-4111-8111-111111111111"]',NETWORK_URL:'http://insecure.example'});assert.equal(c.staffSales,false);
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('demo cash workflow remains independently testable without false production approval',async()=>{
 const vars={APP_ENV:'demo',NODE_ENV:'development',DATABASE_URL:'',PAMOFI_COMMERCE_ENABLED:'true',
  PAMOFI_AGENT_COMMISSION_BPS:'0',PAMOFI_CASH_CUSTOMER_GO:'false',
  VOUCHER_DELIVERY_ACTIVE_KEY_ID:'test',
  VOUCHER_DELIVERY_KEYS_JSON:JSON.stringify({test:Buffer.alloc(32,7).toString('base64')}),
  PAMOFI_SMS_DELIVERY_ENABLED:'false'};
 const saved=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]]));Object.assign(process.env,vars);
 const app=buildApp();try{const cap=(await app.inject({url:'/v1/capabilities'})).json();assert.equal(cap.demo,true);assert.equal(cap.staffSales,true);assert.equal(cap.receiptPairing,true);}finally{await app.close();for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});

test('cash site acceptance allowlist is exact, canonical, unique and fail closed',()=>{
 const good='11111111-1111-4111-8111-111111111111';
 assert.deepEqual([...approvedCashSiteIds(JSON.stringify([good]))],[good]);
 for(const invalid of [undefined,'', 'null', '[]', '{}','[1]','["*" ]',JSON.stringify([good,good]),JSON.stringify([good.toUpperCase()]),'not json'])assert.equal(approvedCashSiteIds(invalid).size,0);
});
