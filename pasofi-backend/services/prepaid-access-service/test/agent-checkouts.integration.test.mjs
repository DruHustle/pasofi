import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {jwtVerify} from 'jose';
import pg from 'pg';
import {buildApp} from '../dist/app.js';
import {StripeAdapter,stripeConfiguration} from '../dist/stripe.js';
import {reconcileProviderPayment} from '../dist/payments.js';
import {processPaymentReconciliation} from '../dist/payment-reconciliation.js';
import {createAgentStripeFixture} from './fixtures/agent-stripe.mjs';
import {cleanupAgentPaymentEvidence} from './fixtures/agent-checkouts.mjs';
import {cleanupInvoiceEvidence} from './fixtures/invoices.mjs';
import {applyRuntimeGrants} from '../../../infra/production/apply-grants.mjs';

const database=process.env.PAMOFI_TEST_DATABASE_URL,origin='http://localhost:5173';
async function fixture({stock=2,runtimeGrants=false}={}){
 const pool=new pg.Pool({connectionString:database,max:10}),site=randomUUID(),otherSite=randomUUID(),agent=randomUUID(),otherAgent=randomUUID(),admin=randomUUID();
 const runtimeRole=runtimeGrants?'agent_checkout_runtime_'+randomUUID().replaceAll('-',''):null;
 let serviceDatabase=database;
 if(runtimeRole){
  const isolated=new URL(database);
  if(process.env.PAMOFI_TEST_CONFIRM_ISOLATED!=='1'||!['127.0.0.1','localhost','[::1]'].includes(isolated.hostname)||process.env.APP_ENV!=='demo'||process.env.NODE_ENV!=='development')throw Error('Runtime grants require an explicitly isolated demo cluster');
  const client=await pool.connect();
  try{
   const owner=(await client.query('SELECT current_user AS name')).rows[0].name;
   await client.query('CREATE ROLE "'+runtimeRole+'" NOLOGIN NOINHERIT');
   await client.query('GRANT USAGE ON SCHEMA public TO "'+runtimeRole+'"');
   await applyRuntimeGrants(client,{service:'prepaid-access',owner,runtime:runtimeRole});
  }finally{client.release();}
  const target=new URL(database);target.searchParams.set('options','-c role='+runtimeRole);serviceDatabase=target.href;
 }
 const paymentPool=runtimeRole?new pg.Pool({connectionString:serviceDatabase,max:10}):pool;
 const customer=randomUUID(),otherCustomer=randomUUID(),bundle='agent-test-'+randomUUID().replaceAll('-','').slice(0,12);
 const secret='SYNTHETIC_IDENTITY_SECRET_AT_LEAST_32_BYTES',stripe=createAgentStripeFixture(),extraApps=[];
 const staff={
  admin:{staffId:admin,role:'admin',status:'approved',siteIds:[],version:1,mfaVerified:true,mfaVerifiedAt:new Date().toISOString()},
  agent:{staffId:agent,role:'agent',status:'approved',siteIds:[site],version:1,mfaVerified:true,mfaVerifiedAt:new Date().toISOString()},
  other:{staffId:otherAgent,role:'agent',status:'approved',siteIds:[otherSite],version:1,mfaVerified:true,mfaVerifiedAt:new Date().toISOString()},
  support:{staffId:randomUUID(),role:'support',status:'approved',siteIds:[site],version:1,mfaVerified:true,mfaVerifiedAt:new Date().toISOString()},
 };
 const identity=createServer(async(req,res)=>{
  try{
   const {payload}=await jwtVerify((req.headers.authorization??'').replace(/^Bearer /,''),new TextEncoder().encode(secret),{issuer:'prepaid-access',subject:'prepaid-access',audience:'identity'});
   const cookie=req.headers.cookie??'';let result;
   if(req.url==='/internal/v1/session'&&payload.scope==='identity:resolve'){
    if(!cookie.startsWith('customer=')){res.writeHead(401);res.end('{}');return;}
    result={customerId:cookie==='customer=other'?otherCustomer:customer};
   }else if(req.url==='/internal/v1/staff/session'&&payload.scope==='staff:resolve'){
    result=staff[cookie.replace('staff=','')];
    if(!result){res.writeHead(401);res.end('{}');return;}
    if(result.status!=='approved'){res.writeHead(403);res.end('{}');return;}
   }else if(req.url?.startsWith('/internal/v1/staff/users/')&&payload.scope==='staff:read'){
    result=Object.values(staff).find(value=>value.staffId===req.url.split('/').at(-1));
    if(!result){res.writeHead(404);res.end('{}');return;}
   }else throw Error('Unexpected identity scope');
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(result));
  }catch{res.writeHead(401);res.end('{}');}
 });
 await new Promise(resolve=>identity.listen(0,'127.0.0.1',resolve));
 const env={DATABASE_URL:serviceDatabase,APP_ENV:'demo',NODE_ENV:'development',PAMOFI_TEST_CONFIRM_ISOLATED:'1',
  IDENTITY_URL:'http://127.0.0.1:'+identity.address().port,INTERNAL_IDENTITY_SECRET:secret,PUBLIC_ORIGIN:origin,
  PUBLIC_ORIGIN_ALIASES:'[]',PAMOFI_COMMERCE_ENABLED:'true',PAMOFI_AGENT_COMMISSION_BPS:'1000',
  VOUCHER_DELIVERY_ACTIVE_KEY_ID:'synthetic',VOUCHER_DELIVERY_KEYS_JSON:JSON.stringify({synthetic:randomBytes(32).toString('base64')}),
  PAMOFI_SMS_DELIVERY_ENABLED:'false',OUTBOX_DISPATCH_ENABLED:'false',PAYMENT_RECONCILIATION_WORKER_ENABLED:'false',
  PAMOFI_ECOCASH_CHECKOUT_ENABLED:'false',...stripe.environment([site,otherSite]),
 };
 const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
 const app=buildApp(stripe.client),adapter=new StripeAdapter(stripeConfiguration(true),stripe.client);
 const headers=(who,key)=>({origin,...(who==='anonymous'?{}:{cookie:who==='customer'||who==='customer2'?'customer='+(who==='customer2'?'other':'main'):'staff='+who}),'idempotency-key':key});
 const call=(method,path,body,who='agent',key=randomUUID(),target=app)=>target.inject({method,url:path,headers:headers(who,key),...(body===undefined?{}:{payload:body})});
 const expectCode=(result,status)=>{assert.equal(result.statusCode,status,result.body);return result.json();};
 expectCode(await call('POST','/v1/admin/sites',{id:site,name:'Synthetic agent payment site'},'admin'),201);
 expectCode(await call('POST','/v1/admin/sites',{id:otherSite,name:'Other synthetic site'},'admin'),201);
 expectCode(await call('POST','/v1/admin/bundles',{id:bundle,priceMinor:100,currency:'USD',byteLimit:'5000000000',validitySeconds:604800,published:true,reason:'Isolated agent checkout acceptance'},'admin'),201);
 if(stock)expectCode(await call('POST','/v1/admin/inventory/allocations',{agentId:agent,siteId:site,bundleId:bundle,quantity:stock,reason:'Isolated stock for digital checkout'},'admin'),201);
 async function offer(key=randomUUID()){return expectCode(await call('POST','/v1/staff/agent-checkouts',{siteId:site,bundleId:bundle},'agent',key),201);}
 const source=offer=>({id:offer.checkout.id,code:offer.handoff.code});
 const orderBody=offer=>({bundleId:bundle,mode:'checkout',agentCheckout:source(offer),invoiceDelivery:{channel:'download'}});
 async function claim(offer,who='customer',key=randomUUID()){return expectCode(await call('POST','/v1/orders',orderBody(offer),who,key),201).order;}
 const start=(order,who='customer',key=randomUUID(),target=app)=>call('POST','/v1/orders/'+order.id+'/checkout',{siteId:site,methodCode:'STRIPE_CARD'},who,key,target);
 const status=async offer=>expectCode(await call('GET','/v1/staff/agent-checkouts/'+offer.checkout.id),200).checkout;
 const quantity=async()=>Number((await pool.query('SELECT quantity FROM agent_site_inventory WHERE agent_id=$1 AND site_id=$2 AND bundle_id=$3',[agent,site,bundle])).rows[0]?.quantity??0);
 const reference=async attempt=>(await pool.query('SELECT provider_reference FROM provider_payment_attempts WHERE id=$1',[attempt])).rows[0].provider_reference;
 const reconcile=async ref=>{const attempt=(await pool.query('SELECT id FROM provider_payment_attempts WHERE provider_reference=$1',[ref])).rows[0];return reconcileProviderPayment(paymentPool,attempt.id,adapter);};
 async function deliver(ref,type){
  const hook=stripe.webhook(ref,type);
  const response=await app.inject({method:'POST',url:'/callbacks/stripe',headers:{'content-type':'application/json','stripe-signature':hook.signature},payload:hook.raw});
  assert.equal(response.statusCode,204,response.body);return hook;
 }
 async function cleanup(){
  await Promise.all(extraApps.map(value=>value.close()));await app.close();await new Promise(resolve=>identity.close(resolve));
  const orders=(await pool.query('SELECT id FROM purchase_orders WHERE customer_id=ANY($1::uuid[])',[[customer,otherCustomer]])).rows.map(row=>row.id);
  await cleanupAgentPaymentEvidence(pool,{agentIds:[agent,otherAgent],customerIds:[customer,otherCustomer],orderIds:orders});
  await cleanupInvoiceEvidence(pool,{agentIds:[agent,otherAgent]});
  await pool.query('DELETE FROM receipt_pairings WHERE customer_id=ANY($1::uuid[])',[[customer,otherCustomer]]);
  const sales=(await pool.query('SELECT id FROM agent_sales WHERE agent_id=ANY($1::uuid[])',[[agent,otherAgent]])).rows.map(row=>row.id);
  await pool.query('DELETE FROM event_outbox WHERE aggregate_id=ANY($1::uuid[])',[sales]);
  await pool.query('DELETE FROM agent_sale_deliveries WHERE sale_id=ANY($1::uuid[])',[sales]);
  await pool.query('DELETE FROM issued_vouchers WHERE sale_id=ANY($1::uuid[])',[sales]);
  await pool.query('DELETE FROM agent_sales WHERE id=ANY($1::uuid[])',[sales]);
  await pool.query('DELETE FROM cash_shifts WHERE agent_id=ANY($1::uuid[])',[[agent,otherAgent]]);
  await pool.query('DELETE FROM inventory_allocations WHERE actor_id=$1',[admin]);
  await pool.query('DELETE FROM agent_site_inventory WHERE site_id=ANY($1::uuid[])',[[site,otherSite]]);
  await pool.query('DELETE FROM commerce_audit WHERE actor_id=ANY($1::uuid[])',[Object.values(staff).map(value=>value.staffId)]);
  await pool.query('DELETE FROM sales_locations WHERE id=ANY($1::uuid[])',[[site,otherSite]]);
  await pool.query('DELETE FROM bundle_versions WHERE id=$1',[bundle]);
  if(runtimeRole){await paymentPool.end();await pool.query('DROP OWNED BY "'+runtimeRole+'"');await pool.query('DROP ROLE "'+runtimeRole+'"');}
  await pool.end();
  for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
 return {pool,paymentPool,app,adapter,call,headers,expectCode,offer,source,orderBody,claim,start,status,quantity,reference,reconcile,deliver,cleanup,stripe,staff,site,otherSite,agent,otherAgent,admin,customer,otherCustomer,bundle,extraApps};
}

async function waitForLock(pool){
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){
  const row=(await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0")).rows[0];
  if(row.n>=2)return;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw Error('The intended stock race did not reach both database locks');
}

test('agent handoff is scoped, idempotent and claims one customer-owned source without exposing account authority',{skip:!database},async()=>{
 const f=await fixture();try{
  const caps=f.expectCode(await f.call('GET','/v1/capabilities',undefined,'anonymous'),200);assert.equal(caps.agentDigitalSales,true);assert.equal(caps.agentCheckoutRecovery,true);
  const key=randomUUID(),offer=await f.offer(key),id=offer.checkout.id;
  assert.match(offer.handoff.code,/^[A-Za-z0-9_-]{43}$/);assert.equal(new URL(offer.handoff.url).hash,'#checkout?agentCheckout='+id+'.'+offer.handoff.code);
  const replay=f.expectCode(await f.call('POST','/v1/staff/agent-checkouts',{siteId:f.site,bundleId:f.bundle},'agent',key),200);
  assert.equal(replay.replayed,true);assert.equal(replay.handoff.url,offer.handoff.url);assert.equal(await f.quantity(),2);
  for(const [who,code]of [['other',403],['support',403],['customer',401]])assert.equal((await f.call('POST','/v1/staff/agent-checkouts',{siteId:f.site,bundleId:f.bundle},who)).statusCode,code);
  assert.equal((await f.call('POST','/v1/staff/agent-checkouts',{siteId:f.site,bundleId:f.bundle,priceMinor:1})).statusCode,400);
  assert.equal((await f.app.inject({method:'POST',url:'/v1/staff/agent-checkouts',headers:{...f.headers('agent',randomUUID()),origin:'https://foreign.example'},payload:{siteId:f.site,bundleId:f.bundle}})).statusCode,403);
  const listed=f.expectCode(await f.call('GET','/v1/staff/agent-checkouts'),200);assert.equal(JSON.stringify(listed).includes(offer.handoff.code),false);
  assert.equal(f.expectCode(await f.call('GET','/v1/staff/agent-checkouts/'+id,undefined,'admin'),200).handoff,null);
  assert.equal((await f.call('GET','/v1/staff/agent-checkouts/'+id,undefined,'other')).statusCode,404);
  const preview=f.expectCode(await f.call('POST','/v1/agent-checkouts/preview',f.source(offer),'anonymous'),200);
  assert.equal(preview.available,true);assert.equal(preview.checkout.status,'unclaimed');assert.equal(preview.checkout.quote.priceMinor,100);
  assert.equal((await f.call('POST','/v1/agent-checkouts/preview',{id,code:'X'.repeat(43)},'anonymous')).statusCode,404);
  const orderKey=randomUUID(),order=await f.claim(offer,'customer',orderKey);
  assert.deepEqual(order.agentCheckout,{id,siteId:f.site,siteName:'Synthetic agent payment site'});
  assert.equal((await f.call('POST','/v1/orders',f.orderBody(offer),'customer2')).json().error,'agent_checkout_claimed');
  assert.equal((await f.call('POST','/v1/orders',{bundleId:f.bundle,mode:'checkout',invoiceDelivery:{channel:'download'}},'customer',orderKey)).json().error,'idempotency_conflict');
  assert.equal((await f.call('GET','/v1/orders/'+order.id+'/status',undefined,'customer2')).statusCode,404);
  const own=f.expectCode(await f.call('GET','/v1/orders?requestKey='+orderKey,undefined,'customer'),200);assert.deepEqual(own.orders[0].agentCheckout,order.agentCheckout);
  const status=f.expectCode(await f.call('GET','/v1/orders/'+order.id+'/status',undefined,'customer'),200);assert.deepEqual(status.order.agentCheckout,order.agentCheckout);
  const claimed=f.expectCode(await f.call('POST','/v1/agent-checkouts/preview',f.source(offer),'anonymous'),200);
  assert.equal(claimed.available,false);assert.equal(claimed.checkout.status,'claimed');assert.equal(JSON.stringify(claimed).includes(order.id),false);assert.equal(JSON.stringify(claimed).includes(f.customer),false);
  assert.equal(f.expectCode(await f.call('GET','/v1/staff/agent-checkouts/'+id),200).handoff,null);
  process.env.PAMOFI_PAYMENTS_ENABLED='false';process.env.PAMOFI_COMMERCE_ENABLED='false';
  const paused=buildApp(f.stripe.client);f.extraApps.push(paused);
  const recovered=f.expectCode(await f.call('POST','/v1/orders',f.orderBody(offer),'customer',orderKey,paused),200);
  assert.equal(recovered.order.id,order.id);assert.deepEqual(recovered.order.agentCheckout,order.agentCheckout);
  assert.equal(f.stripe.intents.size,0);assert.equal(await f.quantity(),2);
 }finally{await f.cleanup();}
});

test('signed Stripe settlement consumes one reservation and one commission without a cash shift, voucher or cash total',{skip:!database},async()=>{
 // The normal integration users own only their service DB and cannot create
 // roles. A separate explicit cluster-owner run qualifies the runtime grants.
 const restricted=process.env.PAMOFI_TEST_AGENT_RUNTIME_GRANTS==='1';
 const f=await fixture({runtimeGrants:restricted});try{
  const offer=await f.offer(),order=await f.claim(offer),key=randomUUID();
  const starts=await Promise.all(Array.from({length:5},()=>f.start(order,'customer',key)));
  for(const response of starts)f.expectCode(response,200);
  const attempt=starts[0].json().attemptId;assert.equal(new Set(starts.map(response=>response.json().attemptId)).size,1);assert.equal(f.stripe.intents.size,1);
  const ref=await f.reference(attempt);
  assert.equal(await f.quantity(),1);assert.equal((await f.status(offer)).stockState,'reserved');assert.equal((await f.status(offer)).commission.state,'unearned');
  assert.equal((await f.start(order,'customer2')).statusCode,404);assert.equal((await f.start(order,'agent')).statusCode,401);
  assert.equal((await f.pool.query('SELECT id FROM purchase_entitlements WHERE order_id=$1',[order.id])).rowCount,0);
  f.stripe.succeed(ref);const hook=await f.deliver(ref);
  for(let i=0;i<3;i++)assert.equal((await f.app.inject({method:'POST',url:'/callbacks/stripe',headers:{'content-type':'application/json','stripe-signature':hook.signature},payload:hook.raw})).statusCode,204);
  assert.equal(await processPaymentReconciliation(f.paymentPool,f.adapter),true);
  const outcomes=await Promise.all(Array.from({length:5},()=>f.reconcile(ref)));assert.ok(outcomes.every(outcome=>outcome.state==='fulfilled'));
  const status=await f.status(offer);assert.equal(status.status,'paid');assert.equal(status.stockState,'consumed');assert.equal(status.commission.amountMinor,10);assert.equal(status.commission.state,'earned');
  assert.equal(await f.quantity(),1);
  for(const table of ['purchase_entitlements','verified_charges','paid_invoices'])assert.equal((await f.pool.query('SELECT id FROM '+table+' WHERE order_id=$1',[order.id])).rowCount,1,table);
  assert.equal((await f.pool.query('SELECT id FROM agent_sales WHERE agent_id=$1',[f.agent])).rowCount,0);
  assert.equal((await f.pool.query('SELECT id FROM cash_shifts WHERE agent_id=$1',[f.agent])).rowCount,0);
  f.expectCode(await f.call('POST','/v1/staff/cash-shifts',{siteId:f.site,currency:'USD',openingMinor:123}),201);
  const shifts=f.expectCode(await f.call('GET','/v1/staff/cash-shifts'),200).shifts;assert.equal(shifts[0].salesMinor,'0');assert.equal(shifts[0].commissionMinor,'0');assert.equal(shifts[0].expectedMinor,'123');
  await assert.rejects(f.pool.query('UPDATE agent_checkouts SET commission_minor=1 WHERE id=$1',[offer.checkout.id]),error=>error.constraint==='immutable_agent_checkout');
  if(restricted){
   await f.paymentPool.query('SELECT id FROM agent_checkouts WHERE id=$1 FOR UPDATE',[offer.checkout.id]);
   for(const column of ['agent_id','price_minor','commission_minor','token_cipher','expires_at'])await assert.rejects(f.paymentPool.query('UPDATE agent_checkouts SET '+column+'='+column+' WHERE id=$1',[offer.checkout.id]),{code:'42501'});
   await assert.rejects(f.paymentPool.query('DELETE FROM agent_checkouts WHERE id=$1',[offer.checkout.id]),{code:'42501'});
  }
  await assert.rejects(f.pool.query("INSERT INTO provider_payment_attempts(id,order_id,customer_id,request_key,site_id,method_code,provider,state) VALUES($1,$2,$3,$4,$5,'STRIPE_CARD','stripe_test','initiating')",[randomUUID(),order.id,f.customer,randomUUID(),f.site]),error=>error.constraint==='agent_checkout_attempt_binding');
 }finally{await f.cleanup();}
});

test('two customer checkouts race for the last shared agent stock unit before either can contact Stripe',{skip:!database,timeout:15000},async()=>{
 const f=await fixture({stock:1}),blocker=await f.pool.connect();let pending=[];
 try{
  const one=await f.offer(),two=await f.offer(),first=await f.claim(one),second=await f.claim(two,'customer2');
  await blocker.query('BEGIN');await blocker.query('SELECT quantity FROM agent_site_inventory WHERE agent_id=$1 AND site_id=$2 AND bundle_id=$3 FOR UPDATE',[f.agent,f.site,f.bundle]);
  pending=[f.start(first),f.start(second,'customer2')];await waitForLock(f.pool);assert.equal(f.stripe.intents.size,0);
  await blocker.query('COMMIT');const results=await Promise.all(pending);
  assert.deepEqual(results.map(result=>result.statusCode).sort(),[200,409]);assert.equal(results.find(result=>result.statusCode===409).json().error,'out_of_stock');
  assert.equal(await f.quantity(),0);assert.equal(f.stripe.intents.size,1);
  assert.equal((await f.pool.query("SELECT id FROM agent_checkouts WHERE agent_id=$1 AND stock_state='reserved'",[f.agent])).rowCount,1);
  assert.equal((await f.pool.query('SELECT id FROM provider_payment_attempts WHERE customer_id=ANY($1::uuid[])',[[f.customer,f.otherCustomer]])).rowCount,1);
 }finally{await blocker.query('ROLLBACK').catch(()=>{});await Promise.allSettled(pending);blocker.release();await f.cleanup();}
});

test('cash and customer digital checkout cannot both sell the last allocated agent unit',{skip:!database,timeout:15000},async()=>{
 const f=await fixture({stock:1}),blocker=await f.pool.connect();let pending=[];
 try{
  const offer=await f.offer(),order=await f.claim(offer);
  f.expectCode(await f.call('POST','/v1/staff/cash-shifts',{siteId:f.site,currency:'USD',openingMinor:0}),201);
  const pairing=f.expectCode(await f.call('POST','/v1/receipt-pairings',{siteId:f.site,bundleId:f.bundle},'customer2'),201).pairing;
  const cash={siteId:f.site,bundleId:f.bundle,pairingCode:pairing.code,delivery:'receipt',payment:{method:'cash',confirmed:true,amountMinor:100,currency:'USD'}};
  await blocker.query('BEGIN');await blocker.query('SELECT quantity FROM agent_site_inventory WHERE agent_id=$1 AND site_id=$2 AND bundle_id=$3 FOR UPDATE',[f.agent,f.site,f.bundle]);
  pending=[f.start(order),f.call('POST','/v1/staff/sales',cash)];await waitForLock(f.pool);await blocker.query('COMMIT');
  const results=await Promise.all(pending);assert.equal(results.filter(result=>result.statusCode<300).length,1);assert.equal(results.filter(result=>result.statusCode===409).length,1);
  assert.equal(await f.quantity(),0);
  const cashSales=(await f.pool.query('SELECT id FROM agent_sales WHERE agent_id=$1',[f.agent])).rowCount;
  const reservations=(await f.pool.query("SELECT id FROM agent_checkouts WHERE agent_id=$1 AND stock_state='reserved'",[f.agent])).rowCount;
  assert.equal(cashSales+reservations,1);assert.equal(f.stripe.intents.size,reservations);
 }finally{await blocker.query('ROLLBACK').catch(()=>{});await Promise.allSettled(pending);blocker.release();await f.cleanup();}
});

test('lost Stripe response and quote expiry retain stock and recover the exact original intent after new sales stop',{skip:!database},async()=>{
 const f=await fixture({stock:1});try{
  const offer=await f.offer(),order=await f.claim(offer),key=randomUUID();
  f.stripe.loseResponse(true);const first=f.expectCode(await f.start(order,'customer',key),200);assert.equal(first.state,'unknown');assert.equal(first.stripe,null);
  const original=[...f.stripe.intents.keys()][0];assert.equal(await f.quantity(),0);
  await f.pool.query("UPDATE purchase_orders SET quote_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[order.id]);
  const before=f.stripe.createCalls.length;const retry=f.expectCode(await f.start(order,'customer',key),200);
  assert.equal(retry.attemptId,first.attemptId);assert.equal(f.stripe.createCalls.length,before);assert.equal((await f.status(offer)).stockState,'reserved');
  f.stripe.loseResponse(false);await f.deliver(original,'payment_intent.created');
  await f.pool.query('UPDATE sales_locations SET enabled=false WHERE id=$1',[f.site]);f.staff.agent.status='disabled';
  process.env.PAMOFI_PAYMENTS_ENABLED='false';const paused=buildApp(f.stripe.client);f.extraApps.push(paused);
  const recovered=f.expectCode(await f.start(order,'customer',key,paused),200);
  assert.equal(recovered.attemptId,first.attemptId);assert.equal(recovered.stripe.clientSecret,f.stripe.get(original).client_secret);assert.equal(f.stripe.createCalls.length,before);
  f.stripe.succeed(original);await f.deliver(original);assert.equal((await f.reconcile(original)).state,'fulfilled');
  const access=f.expectCode(await f.call('GET','/v1/access',undefined,'customer'),200);assert.equal(access.entitlements.length,1);assert.equal(await f.quantity(),0);
 }finally{await f.cleanup();}
});

test('only a verified terminal canceled Stripe intent releases stock once and permanently fences the attributed order',{skip:!database},async()=>{
 const f=await fixture({stock:1});try{
  const offer=await f.offer(),order=await f.claim(offer),key=randomUUID(),started=f.expectCode(await f.start(order,'customer',key),200),ref=await f.reference(started.attemptId);
  assert.equal((await f.reconcile(ref)).state,'pending','a reusable declined/card-selection intent remains pending');assert.equal(await f.quantity(),0);
  assert.equal((await f.call('POST','/v1/orders/'+order.id+'/expire-unused',{},'customer')).statusCode,409);
  f.stripe.cancel(ref);await f.deliver(ref,'payment_intent.canceled');
  const results=await Promise.all(Array.from({length:5},()=>f.reconcile(ref)));assert.ok(results.every(result=>result.state==='failed'));
  assert.equal(await f.quantity(),1);const status=await f.status(offer);assert.equal(status.status,'cancelled');assert.equal(status.stockState,'released');assert.equal(status.commission.state,'unearned');
  const replay=f.expectCode(await f.start(order,'customer',key),200);assert.equal(replay.attemptId,started.attemptId);assert.equal(replay.state,'failed');assert.equal(replay.stripe,null);
  const before=f.stripe.createCalls.length;assert.equal((await f.start(order)).json().error,'agent_checkout_closed');assert.equal(f.stripe.createCalls.length,before);
  await assert.rejects(f.pool.query("INSERT INTO provider_payment_attempts(id,order_id,customer_id,request_key,site_id,method_code,provider,state) VALUES($1,$2,$3,$4,$5,'STRIPE_CARD','stripe_test','initiating')",[randomUUID(),order.id,f.customer,randomUUID(),f.site]),error=>error.constraint==='agent_checkout_attempt_binding');
  await assert.rejects(f.pool.query("UPDATE agent_checkouts SET closed_at=NULL,stock_state='none',reserved_at=NULL,released_at=NULL WHERE id=$1",[offer.checkout.id]),error=>error.constraint==='immutable_agent_checkout');
  assert.equal((await f.pool.query('SELECT id FROM purchase_entitlements WHERE order_id=$1',[order.id])).rowCount,0);
 }finally{await f.cleanup();}
});

test('early dispute, won dispute, partial refund and full reversal retain one attribution and the original stock debit',{skip:!database},async()=>{
 const f=await fixture({stock:1});try{
  const offer=await f.offer(),order=await f.claim(offer),started=f.expectCode(await f.start(order),200),ref=await f.reference(started.attemptId);
  f.stripe.succeed(ref);f.stripe.dispute(ref,'under_review');await f.deliver(ref,'charge.dispute.created');assert.equal((await f.reconcile(ref)).state,'reversed');
  assert.equal((await f.status(offer)).stockState,'reserved');assert.equal((await f.status(offer)).status,'review');assert.equal(await f.quantity(),0);
  assert.equal((await f.pool.query('SELECT id FROM purchase_entitlements WHERE order_id=$1',[order.id])).rowCount,0);
  f.stripe.dispute(ref,'won');await f.deliver(ref,'charge.dispute.closed');assert.equal((await f.reconcile(ref)).state,'fulfilled');
  const paid=await f.status(offer);assert.equal(paid.commission.state,'earned');assert.equal(paid.stockState,'consumed');
  const entitlement=(await f.pool.query('SELECT * FROM purchase_entitlements WHERE order_id=$1',[order.id])).rows[0];
  const invoice=(await f.pool.query('SELECT id,snapshot FROM paid_invoices WHERE order_id=$1',[order.id])).rows[0];
  f.stripe.refund(ref,40);await f.deliver(ref,'charge.refunded');assert.equal((await f.reconcile(ref)).state,'fulfilled');
  assert.equal((await f.status(offer)).commission.state,'review','a trusted partial refund requires commission review, not an invented pro-rata amount');
  f.stripe.refund(ref);await f.deliver(ref,'charge.refunded');assert.equal((await f.reconcile(ref)).state,'reversed');
  const reversed=await f.status(offer);assert.equal(reversed.commission.state,'reversed');assert.equal(reversed.stockState,'consumed');assert.equal(await f.quantity(),0);
  const after=(await f.pool.query('SELECT * FROM purchase_entitlements WHERE order_id=$1',[order.id])).rows[0];assert.equal(after.id,entitlement.id);assert.ok(after.revoked_at);
  assert.deepEqual((await f.pool.query('SELECT id,snapshot FROM paid_invoices WHERE order_id=$1',[order.id])).rows[0],invoice);
  assert.equal((await f.pool.query('SELECT id FROM verified_charges WHERE order_id=$1',[order.id])).rowCount,1);
 }finally{await f.cleanup();}
});

test('attribution cannot be added after payment starts and mismatched provider evidence cannot consume reserved stock',{skip:!database},async()=>{
 const f=await fixture();try{
  const offer=await f.offer(),key=randomUUID();
  const ordinary=f.expectCode(await f.call('POST','/v1/orders',{bundleId:f.bundle,mode:'checkout'},'customer',key),201).order;
  f.expectCode(await f.start(ordinary),200);
  assert.equal((await f.call('POST','/v1/orders',f.orderBody(offer),'customer',key)).json().error,'idempotency_conflict');
  await assert.rejects(f.pool.query('UPDATE agent_checkouts SET order_id=$2,claimed_at=now() WHERE id=$1',[offer.checkout.id,ordinary.id]),error=>error.constraint==='agent_checkout_order_binding');
  await assert.rejects(f.pool.query('INSERT INTO agent_checkouts SELECT (jsonb_populate_record(NULL::agent_checkouts,to_jsonb(a)||$2::jsonb)).* FROM agent_checkouts a WHERE id=$1',[
   offer.checkout.id,JSON.stringify({id:randomUUID(),request_key:randomUUID(),token_hash:'\\x'+randomBytes(32).toString('hex'),order_id:ordinary.id,claimed_at:new Date().toISOString()}),
  ]),error=>error.constraint==='agent_checkout_initial_state');
  const order=await f.claim(offer,'customer2'),started=f.expectCode(await f.start(order,'customer2'),200),ref=await f.reference(started.attemptId);
  f.stripe.succeed(ref);const intent=f.stripe.get(ref),originalSite=intent.metadata.pasofi_site_id;
  intent.metadata.pasofi_site_id=f.otherSite;
  const hook=f.stripe.webhook(ref);assert.equal((await f.app.inject({method:'POST',url:'/callbacks/stripe',headers:{'content-type':'application/json','stripe-signature':hook.signature},payload:hook.raw})).statusCode,503);
  assert.equal((await f.reconcile(ref)).state,'unable_to_verify');assert.equal((await f.status(offer)).stockState,'reserved');assert.equal((await f.status(offer)).commission.state,'unearned');
  assert.equal((await f.pool.query('SELECT id FROM purchase_entitlements WHERE order_id=$1',[order.id])).rowCount,0);
  intent.metadata.pasofi_site_id=originalSite;await f.deliver(ref);assert.equal((await f.reconcile(ref)).state,'fulfilled');
 }finally{await f.cleanup();}
});
