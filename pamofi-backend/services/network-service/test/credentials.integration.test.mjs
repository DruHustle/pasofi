import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { issueRadiusCredential } from '../dist/credentials.js';
const url=process.env.PAMOFI_TEST_NETWORK_DATABASE_URL;
test('credential retries return one encrypted, NAS-bound secret without extending expiry',{skip:!url},async()=>{
 const pool=new pg.Pool({connectionString:url,max:10}), customerId=randomUUID(),nasId=randomUUID(),otherNas=randomUUID(),requestKey=randomUUID(),site=randomUUID();
 const key={version:1,key:randomBytes(32)},input={customerId,nasId,requestKey};
 try{
  await pool.query('INSERT INTO radius_nas(id,site_id,client_name,enabled) VALUES($1,$2,$3,true),($4,$2,$5,true)',[nasId,site,`a_${nasId.replaceAll('-','')}`,otherNas,`b_${otherNas.replaceAll('-','')}`]);
  const rows=await Promise.all(Array.from({length:8},()=>issueRadiusCredential(pool,input,key)));
  assert.equal(new Set(rows.map(r=>r.username)).size,1);assert.equal(new Set(rows.map(r=>r.password)).size,1);assert.equal(new Set(rows.map(r=>r.expiresAt.getTime())).size,1);
  assert.match(rows[0].password,/^[A-Za-z0-9_-]{43}$/);
  const saved=await pool.query('SELECT id,secret_hash,encrypted_secret,secret_key_version FROM radius_credentials WHERE customer_id=$1',[customerId]);
  assert.equal(saved.rowCount,1);assert.equal(saved.rows[0].secret_key_version,1);
  assert.deepEqual(saved.rows[0].secret_hash,createHash('sha256').update(rows[0].password).digest());
  assert.equal(saved.rows[0].encrypted_secret.includes(Buffer.from(rows[0].password)),false);
  await assert.rejects(issueRadiusCredential(pool,{...input,nasId:otherNas},key),{code:'idempotency_conflict'});
  await assert.rejects(issueRadiusCredential(pool,input,{version:2,key:key.key}),{code:'credential_key_unavailable'});
  await assert.rejects(issueRadiusCredential(pool,input,{version:1,key:randomBytes(32)}),{code:'credential_unavailable'});
  await pool.query('UPDATE radius_nas SET enabled=false WHERE id=$1',[nasId]);
  await assert.rejects(issueRadiusCredential(pool,input,key),{code:'credential_expired'});
  await assert.rejects(issueRadiusCredential(pool,{...input,requestKey:randomUUID()},key),{code:'nas_unavailable'});
  await pool.query('UPDATE radius_nas SET enabled=true WHERE id=$1',[nasId]);
  await pool.query("UPDATE radius_credentials SET expires_at=now()-interval '1 second' WHERE customer_id=$1",[customerId]);
  await assert.rejects(issueRadiusCredential(pool,input,key),{code:'credential_expired'});
 }finally{await pool.query('DELETE FROM radius_credentials WHERE customer_id=$1',[customerId]);await pool.query('DELETE FROM radius_nas WHERE id=ANY($1::uuid[])',[[nasId,otherNas]]);await pool.end();}
});
