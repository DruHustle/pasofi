import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {jwtVerify,SignJWT} from 'jose';
import pg from 'pg';
import {buildApp} from '../dist/app.js';
const url=process.env.PAMOFI_TEST_DATABASE_URL;
const identitySecret='test_identity_secret_at_least_32_bytes',deliverySecret='test_delivery_secret_at_least_32_bytes';
const origin='http://localhost:5173';
async function setup(){
 const pool=new pg.Pool({connectionString:url,max:10}),site=randomUUID(),otherSite=randomUUID(),customer=randomUUID(),otherCustomer=randomUUID(),admin=randomUUID(),agent=randomUUID(),otherAgent=randomUUID(),support=randomUUID();
 const staff={admin:{staffId:admin,role:'admin',siteIds:[],version:1,mfaVerified:true},agent:{staffId:agent,role:'agent',siteIds:[site],version:1,mfaVerified:true},other:{staffId:otherAgent,role:'agent',siteIds:[site,otherSite],version:1,mfaVerified:true},support:{staffId:support,role:'support',siteIds:[site],version:1,mfaVerified:true}};
 const server=createServer(async(req,res)=>{try{const {payload}=await jwtVerify((req.headers.authorization??'').replace(/^Bearer /,''),new TextEncoder().encode(identitySecret),{issuer:'prepaid-access',subject:'prepaid-access',audience:'identity'});const cookie=req.headers.cookie??'';let result;if(req.url==='/internal/v1/session'&&payload.scope==='identity:resolve'){if(!cookie.includes('customer=')){res.writeHead(401);res.end('{}');return;}result={customerId:cookie.includes('customer=other')?otherCustomer:customer};}else if(req.url==='/internal/v1/staff/session'&&payload.scope==='staff:resolve'){const name=/staff=([^;]+)/.exec(cookie)?.[1];if(name==='pending'){res.writeHead(403);res.end('{}');return;}result=staff[name];if(!result){res.writeHead(401);res.end('{}');return;}}else if(req.url?.startsWith('/internal/v1/staff/users/')&&payload.scope==='staff:read'){const id=req.url.split('/').at(-1),found=Object.values(staff).find(s=>s.staffId===id);if(!found){res.writeHead(404);res.end('{}');return;}result={...found,status:'approved'};}else throw Error();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));}catch{res.writeHead(401);res.end('{}');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const env={DATABASE_URL:url,APP_ENV:'demo',NODE_ENV:'development',IDENTITY_URL:`http://127.0.0.1:${server.address().port}`,INTERNAL_IDENTITY_SECRET:identitySecret,INTERNAL_DELIVERY_SECRET:deliverySecret,PUBLIC_ORIGIN:origin,PAMOFI_COMMERCE_ENABLED:'true',VOUCHER_DELIVERY_ACTIVE_KEY_ID:'v1',VOUCHER_DELIVERY_KEYS_JSON:JSON.stringify({v1:randomBytes(32).toString('base64')}),PAMOFI_AGENT_COMMISSION_BPS:'1000',PAMOFI_PAYMENTS_ENABLED:'true',PAMOFI_PAYMENT_MODE:'mock',PAYMENT_RECONCILIATION_WORKER_ENABLED:'false',PAMOFI_SMS_DELIVERY_ENABLED:'false'};
 const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);const app=buildApp();
 const call=(method,path,body,who='admin',key=randomUUID())=>app.inject({method,url:path,headers:{origin,cookie:who.startsWith('customer')?`customer=${who==='customer2'?'other':'main'}`:`staff=${who}`,'idempotency-key':key},...(body===undefined?{}:{payload:body})});
 async function cleanup(){await app.close();await new Promise(resolve=>server.close(resolve));await pool.query('DELETE FROM commerce_audit WHERE actor_id=ANY($1::uuid[])',[[admin,agent,otherAgent,support]]);await pool.query('DELETE FROM receipt_pairings WHERE customer_id=ANY($1::uuid[])',[[customer,otherCustomer]]);await pool.query('DELETE FROM access_grants WHERE customer_id=ANY($1::uuid[])',[[customer,otherCustomer]]);await pool.query('DELETE FROM payment_reviews WHERE order_id IN (SELECT id FROM purchase_orders WHERE customer_id=ANY($1::uuid[]))',[[customer,otherCustomer]]);await pool.query('DELETE FROM verified_charges WHERE order_id IN (SELECT id FROM purchase_orders WHERE customer_id=ANY($1::uuid[]))',[[customer,otherCustomer]]);await pool.query('DELETE FROM purchase_entitlements WHERE customer_id=ANY($1::uuid[])',[[customer,otherCustomer]]);await pool.query('DELETE FROM provider_payment_attempts WHERE customer_id=ANY($1::uuid[])',[[customer,otherCustomer]]);await pool.query('DELETE FROM purchase_orders WHERE customer_id=ANY($1::uuid[])',[[customer,otherCustomer]]);await pool.query('DELETE FROM event_outbox WHERE aggregate_id IN (SELECT id FROM agent_sales WHERE agent_id=ANY($1::uuid[]))',[[agent,otherAgent]]);await pool.query('DELETE FROM agent_sale_deliveries WHERE sale_id IN (SELECT id FROM agent_sales WHERE agent_id=ANY($1::uuid[]))',[[agent,otherAgent]]);await pool.query('DELETE FROM issued_vouchers WHERE sale_id IN (SELECT id FROM agent_sales WHERE agent_id=ANY($1::uuid[]))',[[agent,otherAgent]]);await pool.query('DELETE FROM agent_sales WHERE agent_id=ANY($1::uuid[])',[[agent,otherAgent]]);await pool.query('DELETE FROM inventory_allocations WHERE actor_id=$1',[admin]);await pool.query('DELETE FROM agent_site_inventory WHERE site_id=ANY($1::uuid[])',[[site,otherSite]]);await pool.query('DELETE FROM sales_locations WHERE id=ANY($1::uuid[])',[[site,otherSite]]);await pool.end();for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
 await call('POST','/v1/admin/sites',{id:site,name:'Test site one'});await call('POST','/v1/admin/sites',{id:otherSite,name:'Test site two'});return {pool,app,call,cleanup,site,otherSite,customer,otherCustomer,admin,agent,otherAgent,support};
}
test('approved roles and site scopes protect inventory, immutable sales and private receipt redemption',{skip:!url},async()=>{
 const f=await setup();try{
  assert.equal((await f.app.inject({url:'/v1/staff/inventory'})).statusCode,401);
  assert.equal((await f.call('GET','/v1/staff/inventory',undefined,'pending')).statusCode,403);
  const allocation={agentId:f.agent,siteId:f.site,bundleId:'mini',quantity:2,reason:'Initial synthetic agent stock'};
  assert.equal((await f.call('POST','/v1/admin/inventory/allocations',allocation,'agent')).statusCode,403);
  assert.equal((await f.call('POST','/v1/admin/inventory/allocations',{...allocation,agentId:f.support})).statusCode,409);
  const allocationKey=randomUUID(),allocations=await Promise.all(Array.from({length:5},()=>f.call('POST','/v1/admin/inventory/allocations',allocation,'admin',allocationKey)));
  assert.ok(allocations.every(r=>[200,201].includes(r.statusCode)));assert.equal(new Set(allocations.map(r=>r.json().allocationId)).size,1);
  assert.equal((await f.call('POST','/v1/admin/inventory/allocations',{...allocation,quantity:3},'admin',allocationKey)).statusCode,409);
  const stock=(await f.call('GET','/v1/staff/inventory',undefined,'agent')).json().inventory;assert.equal(stock[0].quantity,2);
  assert.deepEqual((await f.call('GET','/v1/staff/inventory',undefined,'other')).json().inventory,[]);
  const pairingKey=randomUUID(),paired=(await f.call('POST','/v1/receipt-pairings',{},'customer',pairingKey)).json();
  assert.equal((await f.call('POST','/v1/receipt-pairings',{},'customer',pairingKey)).json().pairing.code,paired.pairing.code);
  assert.equal((await f.call('GET',`/v1/receipt-pairings/${paired.pairing.id}`,undefined,'customer2')).statusCode,404);
  const payload={siteId:f.site,bundleId:'mini',delivery:'receipt',pairingCode:paired.pairing.code};
  assert.equal((await f.call('POST','/v1/staff/sales',{...payload,siteId:f.otherSite},'agent')).statusCode,403);
  assert.equal((await f.call('POST','/v1/staff/sales',payload,'support')).statusCode,403);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/staff/sales',headers:{cookie:'staff=agent',origin:'https://foreign.example','idempotency-key':randomUUID()},payload})).statusCode,403);
  const key=randomUUID(),sales=await Promise.all(Array.from({length:6},()=>f.call('POST','/v1/staff/sales',payload,'agent',key)));
  assert.ok(sales.every(r=>[200,201].includes(r.statusCode)));const sale=sales[0].json().sale;assert.equal(new Set(sales.map(r=>r.json().sale.id)).size,1);
  assert.equal(sale.priceMinor,50);assert.equal(sale.commissionMinor,5);assert.equal(sale.commissionBps,1000);assert.equal(sale.siteName,'Test site one');assert.equal(sale.simulation,true);
  assert.equal((await f.call('GET','/v1/staff/inventory',undefined,'agent')).json().inventory[0].quantity,1);
  assert.equal((await f.call('POST','/v1/staff/sales',payload,'agent')).statusCode,409);
  assert.equal((await f.call('GET',`/v1/staff/sales/${sale.id}/receipt`,undefined,'other')).statusCode,404);
  assert.equal((await f.call('GET',`/v1/staff/sales/${sale.id}/receipt`,undefined,'support')).statusCode,403);
  const privateReceipt=await f.call('GET',`/v1/receipt-pairings/${paired.pairing.id}`,undefined,'customer');assert.equal(privateReceipt.json().status,'ready');assert.equal(privateReceipt.headers['cache-control'],'no-store');const code=privateReceipt.json().receipt.voucher.code;
  assert.ok(!sales[0].body.includes(code));assert.equal((await f.call('GET',`/v1/staff/sales/${sale.id}/receipt`,undefined,'agent')).json().receipt.voucher.code,code);
  assert.equal((await f.call('POST','/v1/vouchers/redeem',{code},'customer2')).statusCode,409);
  const redeemed=await Promise.all(Array.from({length:6},()=>f.call('POST','/v1/vouchers/redeem',{code},'customer')));assert.ok(redeemed.every(r=>r.statusCode===200));assert.equal(new Set(redeemed.map(r=>r.json().entitlementId)).size,1);
  const e=(await f.pool.query('SELECT * FROM purchase_entitlements WHERE customer_id=$1',[f.customer])).rows;assert.equal(e.length,1);assert.equal(e[0].activated_at,null);assert.equal(e[0].byte_limit,'2000000000');
  const saved=(await f.pool.query('SELECT key_id,code_cipher FROM issued_vouchers WHERE sale_id=$1',[sale.id])).rows[0];assert.equal(saved.key_id,'v1');assert.ok(!saved.code_cipher.toString().includes(code.replaceAll('-','')));
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM commerce_audit WHERE actor_id=$1 AND action=\'inventory.allocate\'',[f.admin])).rows[0].n,1);
  const token=await new SignJWT({scope:'delivery:read'}).setProtectedHeader({alg:'HS256'}).setIssuer('notification').setSubject('notification').setAudience('prepaid-access').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(deliverySecret));
  assert.equal((await f.app.inject({url:`/internal/v1/deliveries/${sale.id}`})).statusCode,401);
  assert.equal((await f.app.inject({url:`/internal/v1/deliveries/${sale.id}`,headers:{authorization:`Bearer ${token}`}})).json().channel,'none');
 }finally{await f.cleanup();}
});
test('mock hosted checkout verifies ownership, quote mode and idempotency before issuing one entitlement',{skip:!url},async()=>{
 const f=await setup();try{
  const capabilities=(await f.app.inject({url:'/v1/capabilities'})).json();assert.equal(capabilities.paymentMode,'mock');assert.equal(capabilities.paymentCheckout,true);assert.equal(capabilities.deliverySms,false);
  const methods=(await f.app.inject({url:`/v1/payments/methods?siteId=${f.site}&bundleId=flex`})).json();assert.equal(methods.methods[0].code,'MOCKPAY');
  const order=(await f.call('POST','/v1/orders',{bundleId:'flex',mode:'checkout'},'customer')).json().order;
  assert.equal((await f.call('POST',`/v1/orders/${order.id}/demo-confirm`,undefined,'customer')).statusCode,409);
  assert.equal((await f.call('POST',`/v1/orders/${order.id}/checkout`,{siteId:f.site,methodCode:'MOCKPAY'},'customer2')).statusCode,404);
  assert.equal((await f.call('POST',`/v1/orders/${order.id}/checkout`,{siteId:f.site,methodCode:'UNQUALIFIED'},'customer')).statusCode,409);
  const key=randomUUID(),starts=await Promise.all(Array.from({length:4},()=>f.call('POST',`/v1/orders/${order.id}/checkout`,{siteId:f.site,methodCode:'MOCKPAY'},'customer',key)));
  assert.ok(starts.every(r=>r.statusCode===200));assert.equal(new Set(starts.map(r=>r.json().attemptId)).size,1);assert.equal(starts[0].json().redirectUrl,null);assert.equal(starts[0].json().simulation,true);
  const paid=await Promise.all(Array.from({length:4},()=>f.call('POST',`/v1/orders/${order.id}/mock-payment`,{outcome:'success'},'customer')));assert.ok(paid.every(r=>r.statusCode===200&&r.json().state==='fulfilled'));
  const status=(await f.call('GET',`/v1/orders/${order.id}/status`,undefined,'customer')).json();assert.equal(status.order.status,'payment_confirmed');assert.ok(status.entitlementId);assert.equal(status.attempts.length,1);
  assert.equal((await f.call('GET',`/v1/orders/${order.id}/status`,undefined,'customer2')).statusCode,404);
  assert.equal(status.fulfillmentState,'fulfilled');assert.equal(status.entitlementRevokedAt,null);
  assert.equal((await f.call('POST',`/v1/orders/${order.id}/mock-payment`,{outcome:'reversed'},'customer')).json().state,'reversed');
  const reversed=(await f.call('GET',`/v1/orders/${order.id}/status`,undefined,'customer')).json();assert.equal(reversed.fulfillmentState,'reversed');assert.equal(reversed.entitlementId,null);assert.ok(reversed.entitlementRevokedAt);
  assert.equal((await f.call('POST',`/v1/orders/${order.id}/mock-payment`,{outcome:'success'},'customer')).statusCode,409);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM purchase_entitlements WHERE order_id=$1',[order.id])).rows[0].n,1);
 }finally{await f.cleanup();}
});
test('customer quote recovery requires owned, origin-checked closure before advertising safe requote',{skip:!url},async()=>{
 const f=await setup();try{
  const order=(await f.call('POST','/v1/orders',{bundleId:'flex',mode:'checkout'},'customer')).json().order;
  const path=`/v1/orders/${order.id}/expire-unused`;
  assert.equal((await f.call('POST',path,{},'customer')).json().error,'quote_still_valid');
  await f.pool.query("UPDATE purchase_orders SET quote_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[order.id]);
  assert.equal((await f.call('GET',`/v1/orders/${order.id}/status`,undefined,'customer')).json().safeToRequote,false);
  assert.equal((await f.call('POST',path,{},'customer2')).statusCode,404);
  assert.equal((await f.app.inject({method:'POST',url:path,headers:{origin},payload:{}})).statusCode,401);
  assert.equal((await f.app.inject({method:'POST',url:path,headers:{origin:'https://foreign.example',cookie:'customer=main'},payload:{}})).statusCode,403);
  const closed=await f.call('POST',path,{},'customer');assert.equal(closed.statusCode,200);
  assert.deepEqual(closed.json(),{orderId:order.id,state:'expired_unused',safeToRequote:true,replayed:false});
  assert.equal((await f.call('POST',path,{},'customer')).json().replayed,true);
  const status=(await f.call('GET',`/v1/orders/${order.id}/status`,undefined,'customer')).json();
  assert.equal(status.safeToRequote,true);assert.ok(status.order.expired_unused_at);assert.deepEqual(status.attempts,[]);assert.equal(status.entitlementId,null);
  const checkout=await f.call('POST',`/v1/orders/${order.id}/checkout`,{siteId:f.site,methodCode:'MOCKPAY'},'customer');
  assert.equal(checkout.statusCode,409);assert.equal(checkout.json().error,'order_not_payable');
 }finally{await f.cleanup();}
});
