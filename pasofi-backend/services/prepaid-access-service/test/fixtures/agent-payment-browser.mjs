// Owned loopback-only provider fixture for full browser acceptance. This file is
// absent from runtime images and does not accept real Stripe credentials.
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import pg from 'pg';
import {buildApp} from '../../dist/app.js';
import {createAgentStripeFixture} from './agent-stripe.mjs';
import {cleanupAgentPaymentEvidence} from './agent-checkouts.mjs';

const site=process.env.PAMOFI_TEST_AGENT_STRIPE_SITE_ID;
const token=process.env.PAMOFI_TEST_AGENT_STRIPE_CONTROL_SECRET;
const port=Number(process.env.PAMOFI_TEST_AGENT_STRIPE_CONTROL_PORT);
const database=new URL(process.env.DATABASE_URL||'');
// The repository's documented disposable Compose/CI initializer uses the
// exact legacy name; separately provisioned local databases use *_test.
const disposableName=/^\/[A-Za-z0-9_-]+_test$/.test(database.pathname)
 ||database.pathname==='/pamofi_prepaid_access';
if(process.env.APP_ENV!=='demo'||process.env.NODE_ENV!=='development'||process.env.PAMOFI_TEST_CONFIRM_ISOLATED!=='1'
 ||process.env.HOST!=='127.0.0.1'||!['postgres:','postgresql:'].includes(database.protocol)
 ||!['127.0.0.1','localhost','[::1]'].includes(database.hostname)||!disposableName
 ||!database.port||!database.username||database.search||database.hash
 ||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(site||'')
 ||!/^[a-f0-9]{64}$/.test(token||'')||!Number.isInteger(port)||port<1024||port>65535
 ||Object.keys(process.env).some(key=>key.startsWith('STRIPE_')))throw Error('Owned isolated synthetic provider environment required');
const fixture=createAgentStripeFixture();
Object.assign(process.env,fixture.environment([site]));
const pool=new pg.Pool({connectionString:database.href,max:1,connectionTimeoutMillis:3000});
await pool.query('INSERT INTO sales_locations(id,name,enabled) VALUES($1,$2,true)',[site,'Browser payment fixture '+site]);
const app=buildApp(fixture.client);
await app.listen({host:'127.0.0.1',port:Number(process.env.PORT)});
let pendingEvent=null;
const control=createServer(async(request,response)=>{
 const supplied=request.headers.authorization??'';
 const expected='Bearer '+token;
 const reply=(status,body)=>{response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(body));};
 if(!['127.0.0.1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress)||supplied.length!==expected.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))return reply(403,{error:'fixture_authority_required'});
 if(request.method!=='POST'||!['/event','/cleanup'].includes(request.url))return reply(404,{error:'not_found'});
 try {
  let text='';for await(const chunk of request){text+=chunk;if(Buffer.byteLength(text)>2048)throw Error('invalid_body');}
  const input=JSON.parse(text);
  if(request.url==='/cleanup'){
   const client=await pool.connect();
   try{
    await client.query('BEGIN');
    const location=await client.query('SELECT name FROM sales_locations WHERE id=$1 FOR UPDATE',[site]);
    if(location.rows[0]?.name!=='Browser payment fixture '+site)throw Error('owned_site_required');
    const agents=(await client.query('SELECT DISTINCT agent_id FROM agent_site_inventory WHERE site_id=$1',[site])).rows.map(row=>row.agent_id);
    const orders=(await client.query('SELECT DISTINCT o.id,o.customer_id FROM purchase_orders o WHERE EXISTS(SELECT 1 FROM provider_payment_attempts a WHERE a.order_id=o.id AND a.site_id=$1) OR EXISTS(SELECT 1 FROM agent_checkouts c WHERE c.order_id=o.id AND c.site_id=$1)',[site])).rows;
    const allocations=(await client.query('SELECT id FROM inventory_allocations WHERE site_id=$1',[site])).rows.map(row=>row.id);
    const checkouts=(await client.query('SELECT id FROM agent_checkouts WHERE site_id=$1',[site])).rows.map(row=>row.id);
    await cleanupAgentPaymentEvidence(client,{agentIds:agents,customerIds:orders.map(row=>row.customer_id),orderIds:orders.map(row=>row.id)});
    await client.query('DELETE FROM event_outbox WHERE aggregate_id=ANY($1::uuid[])',[orders.map(row=>row.id)]);
    await client.query('DELETE FROM commerce_audit WHERE target_id=ANY($1::uuid[])',[[...allocations,...checkouts]]);
    await client.query('DELETE FROM inventory_allocations WHERE site_id=$1',[site]);
    await client.query('DELETE FROM agent_site_inventory WHERE site_id=$1',[site]);
    await client.query('DELETE FROM sales_locations WHERE id=$1',[site]);
    await client.query('COMMIT');
    return reply(200,{removed:true});
   }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  if(!input||typeof input.reference!=='string'||!/^pi_[A-Za-z0-9]+$/.test(input.reference)||!['succeed','cancel','refund','replay'].includes(input.outcome))throw Error('invalid_event');
  const intent=fixture.get(input.reference);
  if(intent.metadata.pasofi_site_id!==site||intent.livemode!==false)throw Error('owned_intent_required');
  if(input.wallet!==undefined&&!['apple_pay','google_pay'].includes(input.wallet))throw Error('invalid_wallet');
  if(input.outcome==='succeed')fixture.succeed(input.reference,{wallet:input.wallet});
  else if(input.outcome==='cancel')fixture.cancel(input.reference);
  else if(input.outcome==='refund')fixture.refund(input.reference);
  const type=input.outcome==='cancel'?'payment_intent.canceled':input.outcome==='refund'?'charge.refunded':'payment_intent.succeeded';
  if(input.outcome==='replay'){
   if(!pendingEvent||pendingEvent.reference!==input.reference)throw Error('owned_event_required');
  }else pendingEvent={reference:input.reference,...fixture.webhook(input.reference,type)};
  const result=await app.inject({method:'POST',url:'/callbacks/stripe',headers:{'content-type':'application/json','stripe-signature':pendingEvent.signature},payload:pendingEvent.raw});
  return reply(result.statusCode,{status:result.statusCode,simulation:true,reference:input.reference});
 }catch{return reply(400,{error:'fixture_event_refused'});}
});
await new Promise((resolve,reject)=>{control.once('error',reject);control.listen(port,'127.0.0.1',resolve);});
let stopping=false;
async function close(){if(stopping)return;stopping=true;await new Promise(resolve=>control.close(resolve));await app.close();await pool.end();}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>void close().catch(()=>{process.exitCode=1;}));
console.log('Isolated synthetic Stripe browser service ready');
