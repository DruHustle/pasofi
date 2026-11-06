import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {registerCustomerNetwork} from '../dist/network-lifecycle.js';

async function fixture(t,work){
 const env={PAMOFI_CUSTOMER_NETWORK_ENABLED:'true',INTERNAL_RADIUS_ENABLED:'true',INTERNAL_NETWORK_SECRET:'test_network_secret_at_least_32_bytes',NETWORK_URL:'http://network.example.test'};
 const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
 Object.assign(process.env,env);
 const customerId=randomUUID(),siteId=randomUUID(),requestKey=randomUUID(),origin='https://pasofi.example.test';
 const state={hold:false,grant:false,upstreamCalls:0,status:409,body:JSON.stringify({error:'credential_expired'})};
 const pool={query:async sql=>{
  if(sql.includes('FROM network_account_holds'))return {rowCount:state.hold?1:0,rows:[]};
  if(sql.includes('FROM access_grants'))return {rowCount:state.grant?1:0,rows:[]};
  if(sql.includes('FROM purchase_entitlements'))return {rowCount:1,rows:[]};
  throw Error('unexpected query');
 }};
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  state.upstreamCalls++;
  assert.equal(new URL(url).pathname,'/internal/v1/network/credentials');
  assert.deepEqual(JSON.parse(init.body),{customerId,siteId,requestKey});
  return new Response(state.body,{status:state.status,headers:{'content-type':'application/json'}});
 });
 const app=Fastify();
 registerCustomerNetwork(app,pool,true,async request=>request.headers.authorization==='owner'?customerId:null,request=>request.headers.origin===origin);
 const send=(headers={})=>app.inject({method:'POST',url:'/v1/network/credentials',headers:{authorization:'owner',origin,...headers},payload:{siteId,requestKey}});
 try{await work({send,state});}
 finally{
  await app.close();
  for(const[key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }
}

test('an authoritative expired-credential response permits safe customer recovery without bypassing account guards',async t=>fixture(t,async({send,state})=>{
 assert.equal((await send({authorization:'other'})).statusCode,401);
 assert.equal((await send({origin:'https://untrusted.example.test'})).statusCode,403);
 state.hold=true;assert.equal((await send()).json().error,'accounting_review_required');
 state.hold=false;state.grant=true;assert.equal((await send()).json().error,'session_pending_or_active');
 assert.equal(state.upstreamCalls,0);
 state.grant=false;
 const expired=await send();
 assert.equal(expired.statusCode,409);
 assert.deepEqual(expired.json(),{error:'credential_expired'});
 assert.equal(state.upstreamCalls,1);
}));

test('unknown, malformed and non-conflict upstream failures stay ambiguous and do not expose internal errors',async t=>fixture(t,async({send,state})=>{
 for(const [status,body]of [[409,{error:'credential_key_unavailable',detail:'private detail'}],[503,{error:'credential_expired'}],[409,{error:{code:'credential_expired'}}],[409,null],[409,'not json']]){
  state.status=status;state.body=typeof body==='string'?body:JSON.stringify(body);
  const response=await send();
  assert.equal(response.statusCode,503);
  assert.deepEqual(response.json(),{error:'network_unavailable'});
 }
}));
