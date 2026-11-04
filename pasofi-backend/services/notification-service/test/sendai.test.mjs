import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SendaiAdapter } from '../dist/sendai.js';
const id='0f9c1b3a-6d2e-4a1b-9c3d-7e5f2a8b4c10';
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
test('Sendai submission is not delivery; retrieval preserves ten-thousandths',async()=>{
 const calls=[];
 const fetcher=async(url,options)=>{calls.push({url,method:options.method});return options.method==='POST'?response({id,status:'enqueued',delivered_at:null,charge:'450',charge_currency:'USD'},202):response({data:{id,status:'success',delivered_at:null,charge:'450',charge_currency:'USD'}});};
 const adapter=new SendaiAdapter('test-token',fetcher);
 const sent=await adapter.send({to:'263771000000',from:'Approved',message:'Example'});
 assert.deepEqual(sent,{state:'submitted',providerId:id,providerStatus:'enqueued',deliveredAt:null,cost:{amount:'450',scale:4,currency:'USD'}});
 const queried=await adapter.retrieve(id);assert.equal(queried.state,'submitted');assert.equal(queried.deliveredAt,null);
 assert.deepEqual(calls.map(c=>c.method),['POST','GET']);
});
test('only delivery evidence confirms delivery and ambiguous sends stay unknown',async()=>{
 const adapter=new SendaiAdapter('test-token',async()=>response({data:{id,status:'success',delivered_at:'2026-11-01T10:00:00Z',charge:'1',charge_currency:'USD'}}));
 assert.equal((await adapter.retrieve(id)).state,'delivered');
 const timeout=new SendaiAdapter('test-token',async()=>{throw Error('timeout');});
 assert.equal((await timeout.send({to:'263771000000',from:'Approved',message:'Example'})).state,'unknown');
 const serverError=new SendaiAdapter('test-token',async()=>response({},500));
 assert.equal((await serverError.send({to:'263771000000',from:'Approved',message:'Example'})).state,'unknown');
 const rejected=new SendaiAdapter('test-token',async()=>response({},400));
 assert.equal((await rejected.send({to:'263771000000',from:'Approved',message:'Example'})).state,'failed');
});
test('mismatched provider IDs and malformed prices do not become success',async()=>{
 const badId=new SendaiAdapter('test-token',async()=>response({data:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status:'success',delivered_at:null}}));
 assert.equal((await badId.retrieve(id)).state,'unknown');
 const badCost=new SendaiAdapter('test-token',async()=>response({id,status:'enqueued',delivered_at:null,charge:0.045,charge_currency:'USD'},202));
 assert.equal((await badCost.send({to:'263771000000',from:'Approved',message:'Example'})).state,'unknown');
});

test('ambiguous send metadata retains its provider ID for safe read-only reconciliation', async () => {
 const input={to:'263771000000',from:'Approved',message:'Example'};
 for (const malformed of [
  {status:'unexpected',delivered_at:null},
  {status:'success',delivered_at:'1234'},
  {status:'enqueued',delivered_at:null,charge:0.045,charge_currency:'USD'}
 ]) {
  const adapter=new SendaiAdapter('test-token',async()=>response({id:id.toUpperCase(),...malformed},202));
  assert.deepEqual(await adapter.send(input),{state:'unknown',providerId:id,providerStatus:null,deliveredAt:null,cost:null});
 }
 const malformedId=new SendaiAdapter('test-token',async()=>response({id:'not-a-provider-handle',status:'enqueued',delivered_at:null},202));
 assert.equal((await malformedId.send(input)).providerId,null);
});

test('provider UUID casing is normalized while mismatched retrieval handles stay untrusted', async () => {
 const uppercase=new SendaiAdapter('test-token',async()=>response({data:{id:id.toUpperCase(),status:'success',delivered_at:'2026-11-01T10:00:00Z'}}));
 assert.equal((await uppercase.retrieve(id)).state,'delivered');
 assert.equal((await uppercase.retrieve(id)).providerId,id);
 const mismatch=new SendaiAdapter('test-token',async()=>response({data:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status:'success',delivered_at:'2026-11-01T10:00:00Z'}}));
 const result=await mismatch.retrieve(id);
 assert.equal(result.state,'unknown');
 assert.equal(result.providerId,id);
});
