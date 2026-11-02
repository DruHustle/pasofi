import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { sendOnce, pollAttempt, markStaleSubmissionsUnknown } from '../dist/delivery.js';
import { SendaiAdapter } from '../dist/sendai.js';
const url=process.env.PAMOFI_TEST_DATABASE_URL;
const message={to:'263771000000',from:'Test',message:'Example'};
const sent=id=>({state:'submitted',providerId:id,providerStatus:'enqueued',deliveredAt:null,cost:{amount:'450',scale:4,currency:'USD'}});
async function fixture(pool){const event=randomUUID(),job=randomUUID(),ref=randomUUID();await pool.query("INSERT INTO event_inbox(id,producer,event_type,aggregate_id,aggregate_version,payload_hash) VALUES ($1,'test','test',$2,1,$3)",[event,ref,randomBytes(32)]);await pool.query("INSERT INTO delivery_jobs(id,event_id,delivery_reference,state) VALUES ($1,$2,$3,'ready')",[job,event,ref]);return {event,job};}
async function cleanup(pool,f){await pool.query('DELETE FROM delivery_attempts WHERE job_id=$1',[f.job]);await pool.query('DELETE FROM delivery_jobs WHERE id=$1',[f.job]);await pool.query('DELETE FROM event_inbox WHERE id=$1',[f.event]);}
test('one outbound attempt per job and poll requires delivery evidence',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:6}), f=await fixture(pool), id=randomUUID();let calls=0;
 const adapter={send:async()=>{calls++;await new Promise(r=>setTimeout(r,20));return sent(id);},retrieve:async()=>({...sent(id),state:'delivered',providerStatus:'success',deliveredAt:'2026-11-01T10:00:00Z'})};
 try{
  const results=await Promise.allSettled([sendOnce(pool,f.job,adapter,message),sendOnce(pool,f.job,adapter,message)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls,1);
  const attempt=results.find(r=>r.status==='fulfilled').value;
  assert.equal(attempt.state,'submitted');
  const result=await pollAttempt(pool,attempt.attemptId,adapter);assert.equal(result.state,'delivered');
  const saved=(await pool.query('SELECT state,charge_amount::text,charge_scale,charge_currency,delivered_at FROM delivery_attempts WHERE id=$1',[attempt.attemptId])).rows[0];
  assert.equal(saved.state,'delivered');assert.equal(saved.charge_amount,'450');assert.equal(saved.charge_scale,4);assert.equal(saved.charge_currency,'USD');assert.ok(saved.delivered_at);
 }finally{await cleanup(pool,f);await pool.end();}
});
test('ambiguous send is not automatically repeated',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url}), f=await fixture(pool);let calls=0;
 const adapter={send:async()=>{calls++;throw Error('timeout');},retrieve:async()=>{throw Error('not used');}};
 try{const attempt=await sendOnce(pool,f.job,adapter,message);assert.equal(attempt.state,'unknown');await assert.rejects(sendOnce(pool,f.job,adapter,message),{code:'not_ready'});assert.equal(calls,1);}
 finally{await cleanup(pool,f);await pool.end();}
});
test('late provider response is retained after a stale submission',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:4}), f=await fixture(pool), id=randomUUID();let release,started;
 const gate=new Promise(r=>{release=r;}), ready=new Promise(r=>{started=r;});
 const adapter={send:async()=>{started();await gate;return sent(id);},retrieve:async()=>{throw Error('not used');}};
 try{
  const pending=sendOnce(pool,f.job,adapter,message);await ready;
  await pool.query("UPDATE delivery_attempts SET updated_at=now()-interval '2 minutes' WHERE job_id=$1",[f.job]);
  assert.equal(await markStaleSubmissionsUnknown(pool,60,f.job),1);
  assert.equal((await pool.query('SELECT state FROM delivery_jobs WHERE id=$1',[f.job])).rows[0].state,'unknown');
  release();const result=await pending;assert.equal(result.state,'submitted');
  const row=(await pool.query('SELECT state,provider_id FROM delivery_attempts WHERE id=$1',[result.attemptId])).rows[0];assert.equal(row.state,'submitted');assert.equal(row.provider_id,id);
 }finally{release();await cleanup(pool,f);await pool.end();}
});
test('canceling in-flight delivery keeps cancellation and records the provider response',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:4}), f=await fixture(pool), id=randomUUID();let release,started;
 const gate=new Promise(r=>{release=r;}), ready=new Promise(r=>{started=r;});
 const adapter={send:async()=>{started();await gate;return sent(id);},retrieve:async()=>{throw Error('not used');}};
 try{
  const pending=sendOnce(pool,f.job,adapter,message);await ready;
  await pool.query("UPDATE delivery_jobs SET state='canceled' WHERE id=$1",[f.job]);
  release();const result=await pending;
  assert.equal((await pool.query('SELECT state FROM delivery_jobs WHERE id=$1',[f.job])).rows[0].state,'canceled');
  const attempt=(await pool.query('SELECT state,provider_id FROM delivery_attempts WHERE id=$1',[result.attemptId])).rows[0];assert.equal(attempt.state,'submitted');assert.equal(attempt.provider_id,id);
 }finally{release();await cleanup(pool,f);await pool.end();}
});

test('an ambiguous send with a validated provider ID can be reconciled without sending twice',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url}),f=await fixture(pool),id=randomUUID();let sends=0,polls=0;
 const adapter=new SendaiAdapter('test-token',async(_url,options)=>{
  if(options.method==='POST'){
   sends++;
   return new Response(JSON.stringify({id,status:'enqueued',delivered_at:null,charge:'bad',charge_currency:'USD'}),{status:202});
  }
  polls++;
  if(polls===1)return new Response('{}',{status:503});
  return new Response(JSON.stringify({data:{id,status:'success',delivered_at:'2026-11-01T10:00:00Z',charge:'450',charge_currency:'USD'}}),{status:200});
 });
 try{
  const attempt=await sendOnce(pool,f.job,adapter,message);assert.equal(attempt.state,'unknown');
  const stored=(await pool.query('SELECT state,provider_id FROM delivery_attempts WHERE id=$1',[attempt.attemptId])).rows[0];
  assert.deepEqual(stored,{state:'unknown',provider_id:id});
  await assert.rejects(sendOnce(pool,f.job,adapter,message),{code:'not_ready'});
  assert.equal((await pollAttempt(pool,attempt.attemptId,adapter)).state,'unknown');
  assert.equal((await pool.query('SELECT state FROM delivery_jobs WHERE id=$1',[f.job])).rows[0].state,'unknown');
  assert.equal((await pollAttempt(pool,attempt.attemptId,adapter)).state,'delivered');
  assert.equal((await pool.query('SELECT state FROM delivery_jobs WHERE id=$1',[f.job])).rows[0].state,'delivered');
  assert.equal(sends,1);assert.equal(polls,2);
  await assert.rejects(pollAttempt(pool,attempt.attemptId,adapter),{code:'not_pollable'});
 }finally{await cleanup(pool,f);await pool.end();}
});
