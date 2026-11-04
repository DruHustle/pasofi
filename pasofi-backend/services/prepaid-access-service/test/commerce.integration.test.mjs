import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {jwtVerify,SignJWT} from 'jose';
import pg from 'pg';
import {buildApp} from '../dist/app.js';
import {sellVoucher} from '../dist/vouchers.js';
import {loadDeliveryKeys} from '../dist/delivery-crypto.js';
const url=process.env.PAMOFI_TEST_DATABASE_URL;
const identitySecret='test_identity_secret_at_least_32_bytes',deliverySecret='test_delivery_secret_at_least_32_bytes';
const origin='http://localhost:5173';
async function setup(options={}){
 const pool=new pg.Pool({connectionString:url,max:10}),site=randomUUID(),otherSite=randomUUID(),customer=randomUUID(),otherCustomer=randomUUID(),admin=randomUUID(),agent=randomUUID(),otherAgent=randomUUID(),support=randomUUID();
 const staff={admin:{staffId:admin,role:'admin',siteIds:[],version:1,mfaVerified:true},agent:{staffId:agent,role:'agent',siteIds:[site],version:1,mfaVerified:true},other:{staffId:otherAgent,role:'agent',siteIds:[site,otherSite],version:1,mfaVerified:true},support:{staffId:support,role:'support',siteIds:[site],version:1,mfaVerified:true}};
 const targetIdentity={response:null,requests:0};
 const server=createServer(async(req,res)=>{try{
  const {payload}=await jwtVerify((req.headers.authorization??'').replace(/^Bearer /,''),new TextEncoder().encode(identitySecret),{issuer:'prepaid-access',subject:'prepaid-access',audience:'identity'}),cookie=req.headers.cookie??'';let result;
  if(req.url==='/internal/v1/session'&&payload.scope==='identity:resolve'){
   if(!cookie.includes('customer=')){res.writeHead(401);res.end('{}');return;}result={customerId:cookie.includes('customer=other')?otherCustomer:customer};
  }else if(req.url==='/internal/v1/staff/session'&&payload.scope==='staff:resolve'){
   const name=/staff=([^;]+)/.exec(cookie)?.[1];if(name==='pending'){res.writeHead(403);res.end('{}');return;}result=staff[name];if(!result){res.writeHead(401);res.end('{}');return;}
  }else if(req.url?.startsWith('/internal/v1/staff/users/')&&payload.scope==='staff:read'){
   ++targetIdentity.requests;if(targetIdentity.response){res.writeHead(targetIdentity.response.status,{'content-type':'application/json'});res.end(JSON.stringify(targetIdentity.response.body));return;}
   const id=req.url.split('/').at(-1),found=Object.values(staff).find(s=>s.staffId===id);if(!found){res.writeHead(404);res.end('{}');return;}result={...found,status:found.status??'approved'};
  }else throw Error();
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
 }catch{res.writeHead(401);res.end('{}');}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const env={DATABASE_URL:url,APP_ENV:'demo',NODE_ENV:'development',IDENTITY_URL:`http://127.0.0.1:${server.address().port}`,INTERNAL_IDENTITY_SECRET:identitySecret,INTERNAL_DELIVERY_SECRET:deliverySecret,PUBLIC_ORIGIN:origin,PAMOFI_COMMERCE_ENABLED:'true',VOUCHER_DELIVERY_ACTIVE_KEY_ID:'v1',VOUCHER_DELIVERY_KEYS_JSON:JSON.stringify({v1:randomBytes(32).toString('base64')}),PAMOFI_AGENT_COMMISSION_BPS:'1000',PAMOFI_PAYMENTS_ENABLED:'true',PAMOFI_PAYMENT_MODE:'mock',PAYMENT_RECONCILIATION_WORKER_ENABLED:'false',PAMOFI_SMS_DELIVERY_ENABLED:'false',...(options.env??{})};
 const saved=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);const app=buildApp();
 const call=(method,path,body,who='admin',key=randomUUID())=>app.inject({method,url:path,headers:{origin,cookie:who.startsWith('customer')?`customer=${who==='customer2'?'other':'main'}`:`staff=${who}`,'idempotency-key':key},...(body===undefined?{}:{payload:body})});
 async function cleanup(){await app.close();await new Promise(resolve=>server.close(resolve));await pool.query('DELETE FROM commerce_audit WHERE actor_id=ANY($1::uuid[])',[[admin,agent,otherAgent,support]]);await pool.query('DELETE FROM receipt_pairings WHERE customer_id=ANY($1::uuid[])',[[customer,otherCustomer]]);await pool.query('DELETE FROM access_grants WHERE customer_id=ANY($1::uuid[])',[[customer,otherCustomer]]);await pool.query('DELETE FROM payment_reviews WHERE order_id IN (SELECT id FROM purchase_orders WHERE customer_id=ANY($1::uuid[]))',[[customer,otherCustomer]]);await pool.query('DELETE FROM verified_charges WHERE order_id IN (SELECT id FROM purchase_orders WHERE customer_id=ANY($1::uuid[]))',[[customer,otherCustomer]]);await pool.query('DELETE FROM purchase_entitlements WHERE customer_id=ANY($1::uuid[])',[[customer,otherCustomer]]);await pool.query('DELETE FROM provider_payment_attempts WHERE customer_id=ANY($1::uuid[])',[[customer,otherCustomer]]);await pool.query('DELETE FROM purchase_orders WHERE customer_id=ANY($1::uuid[])',[[customer,otherCustomer]]);await pool.query('DELETE FROM event_outbox WHERE aggregate_id IN (SELECT id FROM agent_sales WHERE agent_id=ANY($1::uuid[]))',[[agent,otherAgent]]);await pool.query('DELETE FROM agent_sale_deliveries WHERE sale_id IN (SELECT id FROM agent_sales WHERE agent_id=ANY($1::uuid[]))',[[agent,otherAgent]]);await pool.query('DELETE FROM issued_vouchers WHERE sale_id IN (SELECT id FROM agent_sales WHERE agent_id=ANY($1::uuid[]))',[[agent,otherAgent]]);await pool.query('DELETE FROM agent_sales WHERE agent_id=ANY($1::uuid[])',[[agent,otherAgent]]);await pool.query('DELETE FROM inventory_allocations WHERE actor_id=$1',[admin]);await pool.query('DELETE FROM agent_site_inventory WHERE site_id=ANY($1::uuid[])',[[site,otherSite]]);await pool.query('DELETE FROM sales_locations WHERE id=ANY($1::uuid[])',[[site,otherSite]]);await pool.end();for(const [k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
 await call('POST','/v1/admin/sites',{id:site,name:options.siteName??'Test site one'});await call('POST','/v1/admin/sites',{id:otherSite,name:'Test site two'});return {pool,app,call,cleanup,site,otherSite,customer,otherCustomer,admin,agent,otherAgent,support,staff,targetIdentity};
}
test('configured migration origin reaches the authenticated guard and foreign origins remain blocked',{skip:!url},async()=>{
 const f=await setup({env:{PUBLIC_ORIGIN_ALIASES:JSON.stringify(['https://pasofi.onesa.eu'])}});
 try{
  const call=origin=>f.app.inject({method:'POST',url:'/v1/admin/bundles',headers:{origin,cookie:'staff=admin'},payload:{}});
  assert.equal((await call('https://pasofi.onesa.eu')).statusCode,400);
  assert.equal((await call('https://other.onesa.eu')).statusCode,403);
 }finally{await f.cleanup();}
});
test('administrators can prepare sites and catalogue while commerce stays closed',{skip:!url},async()=>{
 const f=await setup({env:{PAMOFI_COMMERCE_ENABLED:'false',PAMOFI_PAYMENTS_ENABLED:'false',VOUCHER_DELIVERY_KEYS_JSON:''}}),bundleId=`setup-${randomUUID().slice(0,8)}`;
 try{
  const capabilities=(await f.app.inject({url:'/v1/capabilities'})).json();
  for(const capability of ['staffSales','vouchers','receiptPairing','paymentCheckout'])assert.equal(capabilities[capability],false);
  assert.equal((await f.call('GET','/v1/staff/sites')).statusCode,200);
  assert.equal((await f.call('GET','/v1/staff/inventory')).statusCode,200);
  assert.equal((await f.call('GET','/v1/admin/bundles')).statusCode,200);
  assert.equal((await f.app.inject({url:'/v1/admin/bundles'})).statusCode,401);
  assert.equal((await f.call('GET','/v1/admin/bundles',undefined,'pending')).statusCode,403);
  assert.equal((await f.call('GET','/v1/admin/bundles',undefined,'agent')).statusCode,403);
  assert.equal((await f.call('GET','/v1/staff/inventory',undefined,'support')).statusCode,403);
  f.staff.admin.mfaVerified=false;
  assert.equal((await f.call('GET','/v1/admin/bundles')).statusCode,503);
  f.staff.admin.mfaVerified=true;
  const draft={id:bundleId,priceMinor:150,currency:'USD',byteLimit:'3000000000',validitySeconds:86400,published:false,reason:'Reviewed draft for isolated setup test'};
  assert.equal((await f.app.inject({method:'POST',url:'/v1/admin/bundles',headers:{origin:'https://foreign.example',cookie:'staff=admin'},payload:draft})).statusCode,403);
  assert.equal((await f.call('POST','/v1/admin/bundles',draft,'agent')).statusCode,403);
  const created=await f.call('POST','/v1/admin/bundles',draft);assert.equal(created.statusCode,201);assert.equal(created.json().product.published,false);
  assert.equal((await f.app.inject({url:'/v1/bundles'})).json().products.some(item=>item.id===bundleId),false);
  assert.equal((await f.call('PATCH',`/v1/admin/bundles/${bundleId}`,{published:true,reason:'Reviewed publication for setup test'})).statusCode,200);
  assert.equal((await f.app.inject({url:'/v1/bundles'})).json().products.some(item=>item.id===bundleId),true);
  assert.equal((await f.call('POST','/v1/admin/inventory/allocations',{agentId:f.agent,siteId:f.site,bundleId,quantity:1,reason:'Stock must remain disabled'})).statusCode,404);
  assert.equal((await f.call('POST','/v1/staff/sales',{},'agent')).statusCode,404);
  assert.equal((await f.call('POST','/v1/receipt-pairings',{},'customer')).statusCode,404);
  assert.equal((await f.call('POST','/v1/vouchers/redeem',{code:'ABCD-EFGH-JKLM-2345'},'customer')).statusCode,404);
  const after=(await f.app.inject({url:'/v1/capabilities'})).json();assert.equal(after.staffSales,false);assert.equal(after.vouchers,false);
 }finally{await f.pool.query('DELETE FROM bundle_versions WHERE id=$1',[bundleId]);await f.cleanup();}
});
test('allocation replay survives target changes and new rejected allocations do not change inventory',{skip:!url},async()=>{
 const f=await setup();try{
  const body={agentId:f.agent,siteId:f.site,bundleId:'mini',quantity:2,reason:'Stock for an isolated replay test'},key=randomUUID();
  const original=await f.call('POST','/v1/admin/inventory/allocations',body,'admin',key);assert.equal(original.statusCode,201);
  f.staff.agent.status='disabled';f.staff.agent.siteIds=[];
  const replay=await f.call('POST','/v1/admin/inventory/allocations',body,'admin',key);
  assert.equal(replay.statusCode,200);assert.equal(replay.json().allocationId,original.json().allocationId);assert.equal(replay.json().replayed,true);
  const newRequest=await f.call('POST','/v1/admin/inventory/allocations',body);
  assert.equal(newRequest.statusCode,409);assert.equal(newRequest.json().error,'allocation_agent_not_eligible');
  const conflict=await f.call('POST','/v1/admin/inventory/allocations',{...body,quantity:3},'admin',key);
  assert.equal(conflict.statusCode,409);assert.equal(conflict.json().error,'idempotency_conflict');
  f.staff.agent.status='approved';f.staff.agent.siteIds=[f.site];
  const unavailable=await f.call('POST','/v1/admin/inventory/allocations',{...body,bundleId:'not-published-for-test'});
  assert.equal(unavailable.statusCode,409);assert.equal(unavailable.json().error,'site_or_bundle_unavailable');
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM inventory_allocations WHERE actor_id=$1',[f.admin])).rows[0].n,1);
  assert.equal((await f.pool.query('SELECT quantity FROM agent_site_inventory WHERE agent_id=$1 AND site_id=$2 AND bundle_id=$3',[f.agent,f.site,'mini'])).rows[0].quantity,2);
 }finally{await f.cleanup();}
});
test('allocation identity outages never claim ineligibility and committed retries bypass target lookups',{skip:!url},async()=>{
 const f=await setup();try{
  const body={agentId:f.agent,siteId:f.site,bundleId:'mini',quantity:2,reason:'Stock for isolated identity fault testing'},committedKey=randomUUID(),pendingKey=randomUUID();
  const committed=await f.call('POST','/v1/admin/inventory/allocations',body,'admin',committedKey);assert.equal(committed.statusCode,201);
  const validTarget={...f.staff.agent,status:'approved'};
  const failures=[
   ...[401,403,503].map(status=>({status,body:{error:'identity_unavailable'}})),
   {status:200,body:{}},
   {status:200,body:{...validTarget,staffId:f.otherAgent}},
   {status:200,body:{...validTarget,siteIds:['invalid-site']}},
   {status:200,body:{...validTarget,status:'unknown'}},
   {status:200,body:{...validTarget,status:['approved']}},
   {status:200,body:{...validTarget,role:['agent']}},
   {status:200,body:{...validTarget,version:null}},
  ];
  for(const failure of failures){
   f.targetIdentity.response=failure;
   const rejected=await f.call('POST','/v1/admin/inventory/allocations',body,'admin',pendingKey);
   assert.equal(rejected.statusCode,503);assert.equal(rejected.json().error,'unavailable');
   const requests=f.targetIdentity.requests,replay=await f.call('POST','/v1/admin/inventory/allocations',body,'admin',committedKey);
   assert.equal(replay.statusCode,200);assert.equal(replay.json().allocationId,committed.json().allocationId);assert.equal(replay.json().replayed,true);assert.equal(f.targetIdentity.requests,requests);
  }
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM inventory_allocations WHERE actor_id=$1',[f.admin])).rows[0].n,1);
  assert.equal((await f.pool.query('SELECT quantity FROM agent_site_inventory WHERE agent_id=$1 AND site_id=$2 AND bundle_id=$3',[f.agent,f.site,'mini'])).rows[0].quantity,2);
  f.targetIdentity.response=null;
  const recovered=await f.call('POST','/v1/admin/inventory/allocations',body,'admin',pendingKey);assert.equal(recovered.statusCode,201);
  assert.equal((await f.call('POST','/v1/admin/inventory/allocations',body,'admin',pendingKey)).json().allocationId,recovered.json().allocationId);
  assert.equal((await f.pool.query('SELECT quantity FROM agent_site_inventory WHERE agent_id=$1 AND site_id=$2 AND bundle_id=$3',[f.agent,f.site,'mini'])).rows[0].quantity,4);
 }finally{await f.cleanup();}
});
test('saved order lookup is exact, owner-scoped and read-only while checkout and its bundle are unavailable',{skip:!url},async()=>{
 const f=await setup({env:{PAMOFI_PAYMENTS_ENABLED:'false',PAMOFI_COMMERCE_ENABLED:'false'}}),bundleId=`lookup-${randomUUID().slice(0,8)}`;
 try{
  const draft={id:bundleId,priceMinor:150,currency:'USD',byteLimit:'3000000000',validitySeconds:86400,published:false,reason:'Unpublished historical quote lookup test'};
  assert.equal((await f.call('POST','/v1/admin/bundles',draft)).statusCode,201);
  const firstKey=randomUUID(),secondKey=randomUUID(),firstId=randomUUID(),secondId=randomUUID(),otherId=randomUUID();
  for(const [id,owner,key]of[[firstId,f.customer,firstKey],[secondId,f.customer,secondKey],[otherId,f.otherCustomer,firstKey]]){
   await f.pool.query("INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at,purchase_mode) SELECT $1,$2,$3,id,price_minor,currency,byte_limit,validity_seconds,'awaiting_payment',now()-interval '1 minute','checkout' FROM bundle_versions WHERE id=$4",[id,owner,key,bundleId]);
  }
  assert.equal((await f.app.inject({url:'/v1/capabilities'})).json().paymentCheckout,false);
  assert.equal((await f.app.inject({url:'/v1/bundles'})).json().products.some(product=>product.id===bundleId),false);
  const owned=await f.call('GET',`/v1/orders?requestKey=${firstKey}`,undefined,'customer');
  assert.equal(owned.statusCode,200);assert.equal(owned.headers['cache-control'],'no-store');
  assert.equal(owned.json().customerId,f.customer);assert.equal(owned.json().lookupKey,firstKey);assert.deepEqual(owned.json().orders.map(order=>order.id),[firstId]);assert.equal(owned.json().orders[0].bundle_id,bundleId);
  const other=await f.call('GET',`/v1/orders?requestKey=${firstKey}`,undefined,'customer2');
  assert.equal(other.json().customerId,f.otherCustomer);assert.equal(other.json().lookupKey,firstKey);assert.deepEqual(other.json().orders.map(order=>order.id),[otherId]);
  const excluded=await f.call('GET',`/v1/orders?requestKey=${secondKey}`,undefined,'customer2');
  assert.deepEqual(excluded.json(),{customerId:f.otherCustomer,lookupKey:secondKey,orders:[]});
  for(const key of[randomUUID(),'a'.repeat(16),'z'.repeat(128)]){
   const missing=await f.call('GET',`/v1/orders?requestKey=${key}`,undefined,'customer');
   assert.equal(missing.statusCode,200);assert.deepEqual(missing.json(),{customerId:f.customer,lookupKey:key,orders:[]});
  }
  assert.equal((await f.app.inject({url:`/v1/orders?requestKey=${firstKey}`})).statusCode,401);
  for(const key of['','short','a'.repeat(15),'a'.repeat(129),'a'.repeat(16)+'!'])assert.equal((await f.call('GET',`/v1/orders?requestKey=${encodeURIComponent(key)}`,undefined,'customer')).statusCode,400);
  assert.equal((await f.call('GET',`/v1/orders?requestKey=${firstKey}&requestKey=${secondKey}`,undefined,'customer')).statusCode,400);
  const legacy=(await f.call('GET','/v1/orders',undefined,'customer')).json();
  assert.equal(legacy.customerId,f.customer);assert.equal(Object.hasOwn(legacy,'lookupKey'),false);assert.deepEqual(legacy.orders.map(order=>order.id).sort(),[firstId,secondId].sort());
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM purchase_orders WHERE customer_id=ANY($1::uuid[])',[[f.customer,f.otherCustomer]])).rows[0].n,3);
  assert.equal((await f.pool.query('SELECT count(*)::int AS n FROM provider_payment_attempts WHERE customer_id=ANY($1::uuid[])',[[f.customer,f.otherCustomer]])).rows[0].n,0);
 }finally{
  await f.pool.query('DELETE FROM purchase_orders WHERE customer_id=ANY($1::uuid[])',[[f.customer,f.otherCustomer]]);
  await f.pool.query('DELETE FROM bundle_versions WHERE id=$1',[bundleId]);await f.cleanup();
 }
});
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
  const payload={siteId:f.site,bundleId:'mini',delivery:'receipt',pairingCode:paired.pairing.code,payment:{method:'cash',confirmed:true,amountMinor:50,currency:'USD'}};
  assert.equal((await f.call('POST','/v1/staff/sales',{...payload,siteId:f.otherSite},'agent')).statusCode,403);
  assert.equal((await f.call('POST','/v1/staff/sales',payload,'support')).statusCode,403);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/staff/sales',headers:{cookie:'staff=agent',origin:'https://foreign.example','idempotency-key':randomUUID()},payload})).statusCode,403);
  const key=randomUUID(),sales=await Promise.all(Array.from({length:6},()=>f.call('POST','/v1/staff/sales',payload,'agent',key)));
  assert.ok(sales.every(r=>[200,201].includes(r.statusCode)));const sale=sales[0].json().sale;assert.equal(new Set(sales.map(r=>r.json().sale.id)).size,1);
  assert.equal(sale.priceMinor,50);assert.equal(sale.commissionMinor,5);assert.equal(sale.commissionBps,1000);assert.equal(sale.siteName,'Test site one');assert.equal(sale.simulation,true);
  assert.deepEqual({...sale.payment,confirmedAt:null},{method:'cash',evidence:'agent_attestation',receivedMinor:50,currency:'USD',confirmedAt:null,confirmedBy:f.agent});assert.ok(sale.payment.confirmedAt);
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
test('cash sales require immutable exact agent attestation while historical committed retries remain recoverable',{skip:!url},async()=>{
 const f=await setup();try{
  await f.call('POST','/v1/admin/inventory/allocations',{agentId:f.agent,siteId:f.site,bundleId:'mini',quantity:2,reason:'Synthetic cash sale stock'});
  const pairing=(await f.call('POST','/v1/receipt-pairings',{},'customer')).json().pairing;
  const base={siteId:f.site,bundleId:'mini',delivery:'receipt',pairingCode:pairing.code};
  const payment={method:'cash',confirmed:true,amountMinor:50,currency:'USD'};
  for(const invalid of [undefined,{...payment,confirmed:false},{...payment,method:'card'},{...payment,amountMinor:49},{...payment,amountMinor:50.5},{...payment,currency:'ZWL'}]){
   const rejected=await f.call('POST','/v1/staff/sales',{...base,...(invalid?{payment:invalid}:{})},'agent');
   assert.equal(rejected.statusCode,409);assert.ok(['cash_confirmation_required','cash_amount_mismatch'].includes(rejected.json().error));
  }
  assert.equal((await f.call('GET','/v1/staff/inventory',undefined,'agent')).json().inventory[0].quantity,2);
  assert.equal((await f.pool.query('SELECT id FROM agent_sales WHERE agent_id=$1',[f.agent])).rowCount,0);
  assert.equal((await f.call('GET',`/v1/receipt-pairings/${pairing.id}`,undefined,'customer')).json().status,'pending');
  const key=randomUUID(),created=await f.call('POST','/v1/staff/sales',{...base,payment},'agent',key);
  assert.equal(created.statusCode,201);const sale=created.json().sale;
  assert.equal(sale.payment.method,'cash');assert.equal(sale.payment.evidence,'agent_attestation');assert.equal(sale.payment.receivedMinor,50);assert.equal(sale.payment.confirmedBy,f.agent);assert.ok(sale.payment.confirmedAt);
  for(const changed of [undefined,{...payment,amountMinor:51},{...payment,currency:'ZWL'},{...payment,confirmed:false}]){
   const conflict=await f.call('POST','/v1/staff/sales',{...base,...(changed?{payment:changed}:{})},'agent',key);
   assert.equal(conflict.statusCode,409);assert.equal(conflict.json().error,'idempotency_conflict');
  }
  const replay=await f.call('POST','/v1/staff/sales',{...base,payment:{currency:'USD',amountMinor:50,confirmed:true,method:'cash'}},'agent',key);
  assert.equal(replay.statusCode,200);assert.equal(replay.json().replayed,true);assert.deepEqual(replay.json().sale.payment,sale.payment);
  assert.equal((await f.call('GET','/v1/staff/inventory',undefined,'agent')).json().inventory[0].quantity,1);
  assert.equal((await f.pool.query('SELECT id FROM event_outbox WHERE aggregate_id=$1',[sale.id])).rowCount,1);
  await assert.rejects(f.pool.query('UPDATE agent_sales SET cash_received_minor=51 WHERE id=$1',[sale.id]),{code:'23514',constraint:'immutable_sale_cash_attestation'});
  const receipt=(await f.call('GET',`/v1/staff/sales/${sale.id}/receipt`,undefined,'agent')).json();assert.deepEqual(receipt.receipt.sale.payment,sale.payment);
  // Seed a legacy committed sale through the retained legacy domain path. Its
  // original hash has no cash field, and its historical tender stays unknown.
  const legacyPair=(await f.call('POST','/v1/receipt-pairings',{},'customer')).json().pairing,legacyKey=randomUUID();
  await f.pool.query("INSERT INTO agent_inventory(agent_id,bundle_id,quantity) VALUES($1,'mini',1)",[f.agent]);
  const legacy=await sellVoucher(f.pool,f.agent,f.site,'mini',legacyKey,loadDeliveryKeys(),{siteName:'Test site one',delivery:'receipt',pairingCode:legacyPair.code});
  const recovered=await f.call('POST','/v1/staff/sales',{...base,pairingCode:legacyPair.code},'agent',legacyKey);
  assert.equal(recovered.statusCode,200);assert.equal(recovered.json().sale.id,legacy.saleId);assert.equal(recovered.json().replayed,true);
  assert.deepEqual(recovered.json().sale.payment,{method:'unrecorded',evidence:'unrecorded',receivedMinor:null,currency:null,confirmedAt:null,confirmedBy:null});
  assert.equal((await f.call('GET','/v1/staff/inventory',undefined,'agent')).json().inventory[0].quantity,1);
 }finally{await f.pool.query('DELETE FROM agent_inventory WHERE agent_id=$1',[f.agent]);await f.cleanup();}
});
test('guarded browser usage fixture accounts the redeemed sale once and cleans only its synthetic grant',{skip:!url},async()=>{
 const f=await setup({siteName:`Browser fixture ${randomUUID()}`});
 const fixturePath=fileURLToPath(new URL('./fixtures/commerce.mjs',import.meta.url));
 const command=(action,agent=f.agent)=>promisify(execFile)(process.execPath,[fixturePath,action,'--site',f.site,'--agent',agent,'--customer',f.customer],{env:{...process.env,PAMOFI_TEST_DATABASE_URL:url,PAMOFI_TEST_CONFIRM_ISOLATED:'1'},timeout:10000});
 try{
  await f.call('POST','/v1/admin/inventory/allocations',{agentId:f.agent,siteId:f.site,bundleId:'mini',quantity:1,reason:'Browser synthetic usage fixture'});
  const pair=(await f.call('POST','/v1/receipt-pairings',{},'customer')).json().pairing;
  const sale=await f.call('POST','/v1/staff/sales',{siteId:f.site,bundleId:'mini',delivery:'receipt',pairingCode:pair.code,payment:{method:'cash',confirmed:true,amountMinor:50,currency:'USD'}},'agent');
  assert.equal(sale.statusCode,201);
  const receipt=(await f.call('GET',`/v1/receipt-pairings/${pair.id}`,undefined,'customer')).json().receipt;
  assert.equal((await f.call('POST','/v1/vouchers/redeem',{code:receipt.voucher.code},'customer')).statusCode,200);
  await assert.rejects(command('account-usage',f.otherAgent));
  const first=JSON.parse((await command('account-usage')).stdout);
  assert.equal(first.accounted,true);assert.equal(first.usedBytes,'3000000');assert.equal(first.remainingBytes,'1997000000');
  assert.equal(JSON.parse((await command('account-usage')).stdout).usedBytes,'3000000');
  const usage=(await f.call('GET','/v1/usage',undefined,'customer')).json();assert.equal(usage.totals.usedBytes,'3000000');assert.equal(usage.session.connected,true);
  assert.equal(JSON.parse((await command('remove')).stdout).removed,true);
  assert.equal((await f.pool.query('SELECT id FROM access_grants WHERE customer_id=$1',[f.customer])).rowCount,0);
 }finally{await f.cleanup();}
});
