import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {buildApp} from '../dist/app.js';
const url=process.env.PAMOFI_TEST_DATABASE_URL, origin='http://localhost:5173';
test('lost first responses and concurrent retries recover one opaque session', {skip:!url}, async()=>{
 process.env.DATABASE_URL=url;process.env.APP_ENV='demo';process.env.NODE_ENV='development';process.env.PUBLIC_ORIGIN=origin;
 const originalSecret='DEMO_ONLY_insecure_local_session_creation_secret_123456789';process.env.SESSION_CREATION_SECRET=originalSecret;
 const pool=new pg.Pool({connectionString:url}),app=buildApp(),key=randomBytes(32).toString('base64url');let customer;
 const create=(secret=key)=>app.inject({method:'POST',url:'/v1/session',headers:{origin,'idempotency-key':secret}});
 try{
  assert.equal((await app.inject({method:'POST',url:'/v1/session',headers:{origin}})).statusCode,400);
  assert.equal((await create('invalid')).statusCode,400);
  const responses=await Promise.all(Array.from({length:8},()=>create()));
  assert.equal(responses.filter(r=>r.statusCode===201).length,1);
  assert.equal(responses.filter(r=>r.statusCode===200).length,7);
  const customers=new Set(responses.map(r=>r.json().customerId));assert.equal(customers.size,1);customer=responses[0].json().customerId;
  const cookies=new Set(responses.map(r=>r.headers['set-cookie'].split(';')[0]));assert.equal(cookies.size,1);
  const cookie=[...cookies][0],token=cookie.split('=')[1];
  assert.match(responses[0].headers['set-cookie'],/HttpOnly/);assert.equal(responses[0].headers['cache-control'],'no-store');
  assert.ok(responses.every(r=>!r.body.includes(token)&&!r.body.includes(key)));
  const row=(await pool.query("SELECT encode(c.request_hash,'hex') AS request_hash,encode(c.session_token_hash,'hex') AS session_hash FROM customer_session_creations c JOIN customer_sessions s ON s.token_hash=c.session_token_hash WHERE s.customer_id=$1",[customer])).rows[0];
  assert.notEqual(row.request_hash,key);assert.notEqual(row.session_hash,token);
  // A caller who lost the Set-Cookie response receives the exact same identity and cookie.
  const replay=await create();assert.equal(replay.statusCode,200);assert.equal(replay.json().customerId,customer);assert.equal(replay.headers['set-cookie'].split(';')[0],cookie);
  const restarted=buildApp();
  try{
   const afterRestart=await restarted.inject({method:'POST',url:'/v1/session',headers:{origin,'idempotency-key':key}});
   assert.equal(afterRestart.statusCode,200);assert.equal(afterRestart.json().customerId,customer);assert.equal(afterRestart.headers['set-cookie'].split(';')[0],cookie);
  }finally{await restarted.close();}
  process.env.SESSION_CREATION_SECRET='DEMO_ONLY_another_session_creation_secret_123456789';
  assert.equal((await create()).statusCode,503);process.env.SESSION_CREATION_SECRET=originalSecret;
  await pool.query('UPDATE customer_session_creations SET expires_at=now()-interval \'1 second\' WHERE session_token_hash=(SELECT token_hash FROM customer_sessions WHERE customer_id=$1 LIMIT 1)',[customer]);
  assert.equal((await create()).statusCode,409);
  await pool.query('UPDATE customer_session_creations SET expires_at=now()+interval \'1 hour\' WHERE session_token_hash=(SELECT token_hash FROM customer_sessions WHERE customer_id=$1 LIMIT 1)',[customer]);
  await pool.query('UPDATE customer_sessions SET revoked_at=now() WHERE customer_id=$1',[customer]);
  assert.equal((await create()).statusCode,409);
  assert.equal((await app.inject({method:'GET',url:'/v1/session',headers:{cookie}})).statusCode,401);
 } finally {
  if(customer){await pool.query('DELETE FROM customer_sessions WHERE customer_id=$1',[customer]);await pool.query('DELETE FROM customers WHERE id=$1',[customer]);}
  await pool.end();await app.close();
 }
});
test('demo session secrets cannot be used outside demo', {skip:!url}, async()=>{
 process.env.DATABASE_URL=url;process.env.APP_ENV='production';process.env.NODE_ENV='production';process.env.PUBLIC_ORIGIN='https://example.test';
 process.env.SESSION_CREATION_SECRET='DEMO_ONLY_insecure_local_session_creation_secret_123456789';
 const app=buildApp();
 try{assert.equal((await app.inject({method:'POST',url:'/v1/session',headers:{origin:'https://example.test','idempotency-key':randomBytes(32).toString('base64url')}})).statusCode,503);}
 finally{await app.close();}
});
