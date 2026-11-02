import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../dist/app.js';
const url=process.env.PAMOFI_TEST_DATABASE_URL, origin='http://localhost:5173';
test('recovery requires reference and key, restores ownership, and rotates without races',{skip:!url},async()=>{
 process.env.DATABASE_URL=url;process.env.APP_ENV='demo';process.env.NODE_ENV='development';process.env.PUBLIC_ORIGIN=origin;process.env.SESSION_CREATION_SECRET='DEMO_ONLY_insecure_local_session_creation_secret_123456789';
 const app=buildApp(), pool=new pg.Pool({connectionString:url});let customer;
 try{
  const initial=await app.inject({method:'POST',url:'/v1/session',headers:{origin,'idempotency-key':randomBytes(32).toString('base64url')}});assert.equal(initial.statusCode,201);customer=initial.json().customerId;
  const cookie=initial.headers['set-cookie'].split(';')[0];
  const setup=await app.inject({method:'POST',url:'/v1/recovery/setup',headers:{origin,cookie}});assert.equal(setup.statusCode,201);assert.equal(setup.headers['cache-control'],'no-store');
  const {accountReference,recoveryKey}=setup.json();assert.equal(accountReference.length,14);assert.equal(recoveryKey.length,43);
  assert.equal((await app.inject({method:'POST',url:'/v1/recovery/setup',headers:{origin,cookie}})).statusCode,409);
  const status=await app.inject({method:'GET',url:'/v1/recovery/status',headers:{cookie}});assert.deepEqual(status.json(),{configured:true,accountReference,version:1});
  const recover=(reference,key)=>app.inject({method:'POST',url:'/v1/recovery',headers:{origin},payload:{accountReference:reference,recoveryKey:key}});
  assert.equal((await recover(randomBytes(10).toString('base64url'),recoveryKey)).statusCode,401);
  assert.equal((await recover(accountReference,randomBytes(32).toString('base64url'))).statusCode,401);
  const restored=await recover(accountReference,recoveryKey);assert.equal(restored.statusCode,200);assert.equal(restored.json().customerId,customer);assert.match(restored.headers['set-cookie'],/HttpOnly/);
  const rotate=()=>app.inject({method:'POST',url:'/v1/recovery/rotate',headers:{origin,cookie},payload:{expectedVersion:1}});
  const rotations=await Promise.all([rotate(),rotate()]);assert.deepEqual(rotations.map(r=>r.statusCode).sort(),[200,409]);
  const replacement=rotations.find(r=>r.statusCode===200).json();assert.equal(replacement.accountReference,accountReference);
  assert.equal((await recover(accountReference,recoveryKey)).statusCode,401);
  assert.equal((await recover(accountReference,replacement.recoveryKey)).json().customerId,customer);
  const stored=(await pool.query('SELECT encode(key_hash,\'hex\') AS hash FROM customer_recovery WHERE customer_id=$1',[customer])).rows[0].hash;
  assert.notEqual(stored,replacement.recoveryKey);
 }finally{if(customer){await pool.query('DELETE FROM customer_sessions WHERE customer_id=$1',[customer]);await pool.query('DELETE FROM customer_recovery WHERE customer_id=$1',[customer]);await pool.query('DELETE FROM customers WHERE id=$1',[customer]);}await pool.end();await app.close();}
});
