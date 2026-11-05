import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerCustomerNetwork} from '../dist/network-lifecycle.js';

const customerId='11111111-1111-4111-8111-111111111111';
const ownGrant='22222222-2222-4222-8222-222222222222';
const foreignGrant='33333333-3333-4333-8333-333333333333';
const origin='https://pasofi.example.test';

test('pausing new network access preserves authenticated session reads and own-grant termination',async()=>{
  const names=['PAMOFI_CUSTOMER_NETWORK_ENABLED','PAMOFI_RADIUS_QUALIFIED','INTERNAL_RADIUS_ENABLED','INTERNAL_NETWORK_SECRET','NETWORK_URL'];
  const saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  for(const name of names)delete process.env[name];
  process.env.PAMOFI_CUSTOMER_NETWORK_ENABLED='false';
  const statements=[];
  let state='active';
  const pool={async query(sql,params){
    statements.push({sql,params});
    if(sql.startsWith('SELECT id,site_id')){
      assert.deepEqual(params,[customerId]);
      assert.match(sql,/WHERE customer_id=\$1 AND state<>'closed'/);
      return {rowCount:1,rows:[{id:ownGrant,state,connected:state==='active'}]};
    }
    assert.match(sql,/UPDATE access_grants/);
    assert.match(sql,/WHERE id=\$1 AND customer_id=\$2/);
    assert.equal(params[1],customerId);
    if(params[0]!==ownGrant)return {rowCount:0,rows:[]};
    if(state!=='closed')state='uncertain';
    return {rowCount:1,rows:[{state}]};
  }};
  const app=Fastify();
  registerCustomerNetwork(app,pool,false,async request=>request.headers.authorization==='customer-session'?customerId:null,request=>request.headers.origin===origin);
  const send=(method,url,payload,authenticated=true,requestOrigin=origin)=>app.inject({method,url,payload,headers:{...(authenticated?{authorization:'customer-session'}:{}),origin:requestOrigin}});
  try{
    const status=await send('GET','/v1/network/session');
    assert.equal(status.statusCode,200);
    assert.deepEqual(status.json(),{session:{id:ownGrant,state:'active',connected:true}});
    const beforeDenied=statements.length;
    assert.equal((await send('GET','/v1/network/session',undefined,false)).statusCode,401);
    assert.equal((await send('POST','/v1/network/disconnect',{grantId:ownGrant},false)).statusCode,401);
    assert.equal((await send('POST','/v1/network/disconnect',{grantId:ownGrant},true,'https://untrusted.example.test')).statusCode,403);
    assert.equal(statements.length,beforeDenied,'unauthenticated and cross-origin requests must not touch the ledger');
    assert.equal((await send('POST','/v1/network/disconnect',{grantId:foreignGrant})).statusCode,404);
    assert.equal(state,'active','another customer cannot stop this grant');
    const pending=await send('POST','/v1/network/disconnect',{grantId:ownGrant});
    assert.equal(pending.statusCode,202);
    assert.deepEqual(pending.json(),{state:'disconnect_pending'});
    const after=await send('GET','/v1/network/session');
    assert.deepEqual(after.json(),{session:{id:ownGrant,state:'uncertain',connected:false}});
    state='closed';
    const replay=await send('POST','/v1/network/disconnect',{grantId:ownGrant});
    assert.equal(replay.statusCode,200);
    assert.deepEqual(replay.json(),{state:'closed'});
    const beforeIssuance=statements.length;
    const credentials=await send('POST','/v1/network/credentials',{siteId:foreignGrant,requestKey:ownGrant});
    assert.equal(credentials.statusCode,404);
    assert.equal(credentials.json().error,'network_disabled');
    assert.equal((await send('GET','/v1/network/sites')).statusCode,404);
    assert.equal(statements.length,beforeIssuance,'pausing access must still prevent new issuance');
  }finally{
    await app.close();
    for(const [name,value]of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value;}
  }
});

test('existing-session operations report unavailable when the ledger is unavailable',async()=>{
  const app=Fastify();
  registerCustomerNetwork(app,null,false,async()=>customerId,()=>true);
  try{
    for(const response of [await app.inject({method:'GET',url:'/v1/network/session'}),await app.inject({method:'POST',url:'/v1/network/disconnect',payload:{grantId:ownGrant}})]){
      assert.equal(response.statusCode,503);
      assert.deepEqual(response.json(),{error:'network_unavailable'});
    }
  }finally{await app.close();}
});
