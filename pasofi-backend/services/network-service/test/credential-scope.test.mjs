import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {SignJWT} from 'jose';
import {registerNetworkInternal} from '../dist/internal.js';
import {registerNetworkInternal as registerOldNetworkInternal} from './fixtures/pre-replay-internal.mjs';

async function fixture(register,work){
 const secret=randomBytes(32).toString('hex');
 const env={APP_ENV:'demo',NODE_ENV:'development',PAMOFI_CUSTOMER_NETWORK_ENABLED:'true',INTERNAL_RADIUS_ENABLED:'true',INTERNAL_NETWORK_SECRET:secret};
 const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
 const state={queries:0,validatedBody:null},app=Fastify();
 // Crossing this trap proves entry into issuance. No credential routine, real
 // database, encryption key or secret delivery is available in this fixture.
 const pool={query:async()=>{state.queries++;throw Error('SQL trap');}};
 app.addHook('preHandler',async request=>{state.validatedBody=request.body;});
 register(app,pool);
 const base={customerId:randomUUID(),siteId:randomUUID(),nasId:randomUUID(),requestKey:randomUUID()},replayCredentialId=randomUUID();
 const send=async(scope,extra={})=>{
  const token=await new SignJWT({scope}).setProtectedHeader({alg:'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('network').setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(secret));
  return app.inject({method:'POST',url:'/internal/v1/network/credentials',headers:{authorization:`Bearer ${token}`},payload:{...base,...extra}});
 };
 try{await work({send,state,replayCredentialId,base});}
 finally{await app.close();for(const[key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}

test('the pre-replay network version denies the new replay scope before issuance despite stripping its body field',async()=>fixture(registerOldNetworkInternal,async({send,state,replayCredentialId,base})=>{
 const rejected=await send('network:credentials:replay',{replayCredentialId});
 assert.equal(rejected.statusCode,403);assert.deepEqual(rejected.json(),{error:'forbidden'});assert.equal(state.queries,0);
 assert.deepEqual(state.validatedBody,{customerId:base.customerId,siteId:base.siteId,requestKey:base.requestKey});
 // Control: the exact old route really strips the replay restriction and
 // enters issuance with the old scope. The dedicated new scope prevents this.
 const unsafeOldScope=await send('network:credentials',{replayCredentialId});
 assert.equal(unsafeOldScope.statusCode,503);assert.equal(state.queries,1);
}));

test('the current network boundary requires an exact match between replay scope and replay-only authority',async()=>fixture(registerNetworkInternal,async({send,state,replayCredentialId})=>{
 for(const[scope,body]of [['network:credentials',{replayCredentialId}],['network:credentials:replay',{}],['network:sites',{replayCredentialId}]]){
  const rejected=await send(scope,body);assert.equal(rejected.statusCode,403);assert.deepEqual(rejected.json(),{error:'forbidden'});
 }
 assert.equal(state.queries,0);
 // Both matched contracts pass authorization; real replay/no-insert behavior
 // is exercised by the two-database pending-grant integration fixture.
 assert.equal((await send('network:credentials')).statusCode,503);assert.equal(state.queries,1);
 assert.equal((await send('network:credentials:replay',{replayCredentialId})).statusCode,503);assert.equal(state.queries,2);
}));
