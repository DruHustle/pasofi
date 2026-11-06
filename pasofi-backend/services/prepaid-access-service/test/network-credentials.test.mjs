import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {registerCustomerNetwork} from '../dist/network-lifecycle.js';

async function fixture(t,work){
 const env={PAMOFI_CUSTOMER_NETWORK_ENABLED:'true',INTERNAL_RADIUS_ENABLED:'true',INTERNAL_NETWORK_SECRET:'test_network_secret_at_least_32_bytes',NETWORK_URL:'http://network.example.test'};
 const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
 Object.assign(process.env,env);
 const customerId=randomUUID(),siteId=randomUUID(),nasId=randomUUID(),requestKey=randomUUID(),entitlementId=randomUUID(),origin='https://pasofi.example.test';
 const pendingGrant={id:randomUUID(),site_id:siteId,nas_id:nasId,request_key:randomUUID(),entitlement_id:entitlementId,state:'pending'};
 const credential={siteId,nasId,loginUrl:'https://selected.example.test/login',username:'synthetic_saved_username',password:'synthetic_saved_password',expiresAt:new Date(Date.now()+120000).toISOString()};
 const state={hold:false,grant:false,eligible:true,entitlement:true,upstreamCalls:0,status:409,body:JSON.stringify({error:'credential_expired'}),nasId:undefined,authCustomerId:customerId,log:[],eligibilityChecks:[],privateCalls:[],onUpstream:null};
 const grant=()=>state.grant===true?{...pendingGrant,state:'active'}:state.grant||null;
 const pool={connect:async()=>{
  state.log.push('connect');
  return {release:()=>state.log.push('release'),query:async(sql,values=[])=>{
   if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)){state.log.push(sql);return {rowCount:0,rows:[]};}
   if(sql.startsWith('SELECT pg_advisory_xact_lock')){assert.deepEqual(values,[customerId]);state.log.push('customer-lock');return {rowCount:1,rows:[{}]};}
   // Match the dedicated eligibility query before its nested hold/grant reads.
   if(sql.startsWith('SELECT 1 FROM purchase_entitlements e')){
    assert.ok(sql.includes('clock_timestamp()'));assert.deepEqual(values.slice(0,3),[entitlementId,customerId,grant()?.id??null]);
    state.log.push('eligibility');state.eligibilityChecks.push(values[3]);
    return {rowCount:state.eligible?1:0,rows:state.eligible?[{}]:[]};
   }
   if(sql==='SELECT 1 FROM network_account_holds WHERE customer_id=$1'){
    assert.deepEqual(values,[customerId]);state.log.push('hold');return {rowCount:state.hold?1:0,rows:state.hold?[{}]:[]};
   }
   if(sql.startsWith('SELECT id,site_id,nas_id,request_key,entitlement_id,state FROM access_grants')){
    assert.ok(sql.endsWith('FOR UPDATE'));assert.deepEqual(values,[customerId]);state.log.push('grant-lock');
    const row=grant();return {rowCount:row?1:0,rows:row?[row]:[]};
   }
   if(sql.startsWith('SELECT id FROM purchase_entitlements')){
    assert.ok(sql.endsWith('FOR SHARE'));
    assert.deepEqual(values,grant()?[grant().entitlement_id,customerId]:[customerId]);
    state.log.push(grant()?'bound-entitlement-lock':'entitlement-lock');
    return {rowCount:state.entitlement?1:0,rows:state.entitlement?[{id:entitlementId}]:[]};
   }
   throw Error('unexpected query');
  }};
 }};
 t.mock.method(globalThis,'fetch',async(url,init)=>{
  state.upstreamCalls++;
  state.log.push('upstream');
  assert.equal(new URL(url).pathname,'/internal/v1/network/credentials');
  const body=JSON.parse(init.body);state.privateCalls.push(body);
  assert.deepEqual(body,{customerId,siteId,...(state.nasId?{nasId:state.nasId}:{}),requestKey,...(grant()?{nasId:grant().nas_id,replayCredentialId:grant().request_key}:{})});
  if(state.onUpstream)await state.onUpstream();
  return new Response(state.body,{status:state.status,headers:{'content-type':'application/json'}});
 });
 const app=Fastify();
 registerCustomerNetwork(app,pool,true,async request=>request.headers.authorization==='owner'?state.authCustomerId:null,request=>request.headers.origin===origin);
 const send=(headers={},selection={})=>app.inject({method:'POST',url:'/v1/network/credentials',headers:{authorization:'owner',origin,...headers},payload:{siteId,requestKey,...selection}});
 const pending=()=>{state.grant={...pendingGrant};state.nasId=nasId;state.status=200;state.body=JSON.stringify(credential);};
 try{await work({send,state,pending,credential,customerId,siteId,nasId,requestKey,pendingGrant});}
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

test('explicit router selection preserves authenticated account, origin, hold and reservation checks',async t=>fixture(t,async({send,state,nasId})=>{
 state.nasId=nasId;
 const selection={nasId};
 assert.equal((await send({authorization:'other'},selection)).statusCode,401);
 assert.equal((await send({origin:'https://untrusted.example.test'},selection)).statusCode,403);
 state.hold=true;assert.equal((await send({},selection)).json().error,'accounting_review_required');
 state.hold=false;state.grant=true;assert.equal((await send({},selection)).json().error,'session_pending_or_active');
 assert.equal(state.upstreamCalls,0);
 state.grant=false;state.status=200;state.body=JSON.stringify({nasId,username:'synthetic_selected_credential'});
 assert.equal((await send({},selection)).statusCode,200);assert.equal(state.upstreamCalls,1);
 assert.deepEqual(state.privateCalls[0].nasId,nasId);
 assert.equal((await send({},{nasId:'not-a-router-uuid'})).statusCode,400);assert.equal(state.upstreamCalls,1);
}));

test('a definite ambiguous-site rejection is preserved without treating other failures as a fresh selection',async t=>fixture(t,async({send,state})=>{
 state.body=JSON.stringify({error:'nas_selection_required',detail:'not returned'});
 const ambiguous=await send();assert.equal(ambiguous.statusCode,409);assert.deepEqual(ambiguous.json(),{error:'nas_selection_required'});
 for(const [status,body]of [[503,{error:'nas_selection_required'}],[409,{error:{code:'nas_selection_required'}}],[409,{error:'nas_unavailable',detail:'not returned'}]]){
  state.status=status;state.body=JSON.stringify(body);
  const result=await send();assert.equal(result.statusCode,503);assert.deepEqual(result.json(),{error:'network_unavailable'});
 }
}));

test('unknown, malformed and non-conflict upstream failures stay ambiguous and do not expose internal errors',async t=>fixture(t,async({send,state})=>{
 for(const [status,body]of [[409,{error:'credential_key_unavailable',detail:'private detail'}],[503,{error:'credential_expired'}],[409,{error:{code:'credential_expired'}}],[409,null],[409,'not json']]){
  state.status=status;state.body=typeof body==='string'?body:JSON.stringify(body);
  const response=await send();
  assert.equal(response.statusCode,503);
  assert.deepEqual(response.json(),{error:'network_unavailable'});
 }
}));

test('pending replay derives private authority from the locked grant and preserves its exact credential context',async t=>fixture(t,async({send,state,pending,credential,customerId,nasId,requestKey,pendingGrant})=>{
 pending();state.authCustomerId=customerId.toUpperCase();
 for(const extra of [{replayCredentialId:randomUUID()},{customerId:randomUUID()}]){
  const rejected=await send({},{nasId,...extra});
  assert.equal(rejected.statusCode,400);assert.deepEqual(rejected.json(),{error:'invalid_request'});
 }
 assert.equal(state.upstreamCalls,0);assert.deepEqual(state.log,[]);
 const response=await send({},{nasId});
 assert.equal(response.statusCode,200);assert.deepEqual(response.json(),credential);
 assert.notEqual(pendingGrant.request_key,requestKey);
 assert.equal(state.privateCalls[0].requestKey,requestKey);
 assert.equal(state.privateCalls[0].replayCredentialId,pendingGrant.request_key);
 assert.deepEqual(state.eligibilityChecks,[null,credential.expiresAt]);
 assert.deepEqual(state.log,['connect','BEGIN','customer-lock','hold','grant-lock','bound-entitlement-lock','eligibility','upstream','eligibility','COMMIT','release']);
 // An older caller can omit nasId only because the locked grant supplies it.
 const legacy=await send();assert.equal(legacy.statusCode,200);assert.deepEqual(legacy.json(),credential);
 assert.equal(state.privateCalls[1].nasId,nasId);assert.equal(state.privateCalls[1].replayCredentialId,pendingGrant.request_key);
}));

test('wrong or unknown pending context and eligibility loss withhold credentials without permitting a new retry key',async t=>fixture(t,async({send,state,pending,credential,nasId,pendingGrant})=>{
 pending();
 for(const selection of [{nasId:randomUUID()},{siteId:randomUUID(),nasId}]){
  const response=await send({},selection);assert.equal(response.statusCode,409);assert.equal(response.json().error,'session_pending_or_active');
 }
 for(const change of [{nas_id:null},{request_key:null},{state:'active'},{state:'uncertain'}]){
  state.grant={...pendingGrant,...change};
  const response=await send({},{nasId});assert.equal(response.statusCode,409);assert.equal(response.json().error,'session_pending_or_active');
 }
 state.grant={...pendingGrant};state.eligible=false;
 assert.equal((await send({},{nasId})).json().error,'session_pending_or_active');
 assert.equal(state.upstreamCalls,0);
 state.eligible=true;state.log.length=0;
 state.onUpstream=()=>{state.eligible=false;};
 const stale=await send({},{nasId});
 assert.equal(stale.statusCode,409);assert.deepEqual(stale.json(),{error:'session_pending_or_active'});
 assert.equal(stale.body.includes(credential.password),false);assert.equal(stale.body.includes(credential.username),false);
 assert.deepEqual(state.log.slice(-4),['upstream','eligibility','ROLLBACK','release']);
 state.onUpstream=null;state.eligible=true;
 for(const changed of [{...credential,nasId:randomUUID()},{...credential,siteId:randomUUID()}]){
  state.body=JSON.stringify(changed);
  const response=await send({},{nasId});assert.equal(response.statusCode,503);assert.deepEqual(response.json(),{error:'network_unavailable'});
 }
 state.status=409;state.body=JSON.stringify({error:'credential_expired'});
 const expired=await send({},{nasId});
 assert.equal(expired.statusCode,409);assert.deepEqual(expired.json(),{error:'session_pending_or_active'});
 state.body=JSON.stringify({error:'credential_not_replayable',detail:'not returned'});
 const unknown=await send({},{nasId});assert.equal(unknown.statusCode,503);assert.deepEqual(unknown.json(),{error:'network_unavailable'});
}));
