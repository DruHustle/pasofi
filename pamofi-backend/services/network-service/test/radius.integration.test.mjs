import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import pg from 'pg';
import { buildRadiusApp } from '../dist/radius-app.js';
const networkUrl=process.env.PAMOFI_TEST_NETWORK_DATABASE_URL,prepaidDb=process.env.PAMOFI_TEST_DATABASE_URL,prepaidUrl=process.env.PAMOFI_TEST_PREPAID_URL;
const secret='DEMO_ONLY_network_lab_key_0123456789abcdef';
const attr=value=>({value:[value]});
const run=(args)=>execFileSync('openssl',args,{stdio:'ignore'});
function certs(dir){
 const p=name=>join(dir,name);
 run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout',p('ca.key'),'-out',p('ca.crt'),'-days','1','-subj','/CN=PamoFi lab CA']);
 for(const name of ['server','radius','other']) {
  run(['req','-newkey','rsa:2048','-nodes','-keyout',p(`${name}.key`),'-out',p(`${name}.csr`),'-subj',`/CN=${name}`]);
  writeFileSync(p(`${name}.ext`),name==='server'?'subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n':'extendedKeyUsage=clientAuth\n');
  run(['x509','-req','-in',p(`${name}.csr`),'-CA',p('ca.crt'),'-CAkey',p('ca.key'),'-CAcreateserial','-out',p(`${name}.crt`),'-days','1','-extfile',p(`${name}.ext`)]);
 }
 return Object.fromEntries(['ca.crt','server.crt','server.key','radius.crt','radius.key','other.crt','other.key'].map(f=>[f,readFileSync(p(f))]));
}
function post(url,ca,client,body,nas){return new Promise((resolve,reject)=>{
 const req=https.request(url,{method:'POST',ca,cert:client?.cert,key:client?.key,headers:{'content-type':'application/json','x-pamofi-nas':nas}},res=>{let data='';res.setEncoding('utf8');res.on('data',x=>data+=x);res.on('end',()=>resolve({status:res.statusCode,body:data ? JSON.parse(data) : null}));});
 req.on('error',reject);req.end(JSON.stringify(body));
});}
test('mutual TLS and two registered NASes share one authoritative reservation', {skip:!networkUrl||!prepaidDb||!prepaidUrl,timeout:60000}, async()=>{
 const old={...process.env};Object.assign(process.env,{APP_ENV:'demo',NODE_ENV:'development',INTERNAL_RADIUS_ENABLED:'true'});
 const dir=mkdtempSync(join(tmpdir(),'pamofi-radius-test-')),c=certs(dir),network=new pg.Pool({connectionString:networkUrl}),prepaid=new pg.Pool({connectionString:prepaidDb});
 const radius={cert:c['radius.crt'],key:c['radius.key']},other={cert:c['other.crt'],key:c['other.key']};
 const customer=randomUUID(),order=randomUUID(),entitlement=randomUUID(),sites=[randomUUID(),randomUUID()],nases=[randomUUID(),randomUUID()],credentials=[randomUUID(),randomUUID()];
 const users=[randomBytes(24).toString('base64url'),randomBytes(24).toString('base64url')],passwords=[randomBytes(32).toString('base64url'),randomBytes(32).toString('base64url')];
 const app=buildRadiusApp({pool:network,tls:{ca:c['ca.crt'],cert:c['server.crt'],key:c['server.key']},clientFingerprint:new X509Certificate(c['radius.crt']).fingerprint256,prepaidUrl,networkSecret:secret});
 try {
  await prepaid.query(`INSERT INTO purchase_orders(id,customer_id,idempotency_key,bundle_id,price_minor,currency,byte_limit,validity_seconds,status,quote_expires_at) VALUES($1,$2,$3,'flex',100,'USD',5000000000,604800,'payment_confirmed',now()+interval '15 minutes')`,[order,customer,randomUUID()]);
  await prepaid.query(`INSERT INTO purchase_entitlements(id,order_id,customer_id,bundle_id,byte_limit,validity_seconds,start_by) VALUES($1,$2,$3,'flex',5000000000,604800,now()+interval '30 days')`,[entitlement,order,customer]);
  for(let i=0;i<2;i++){
   await network.query('INSERT INTO radius_nas(id,site_id,client_name,enabled) VALUES($1,$2,$3,true)',[nases[i],sites[i],`nas_${i}`]);
   await network.query("INSERT INTO radius_credentials(id,username,secret_hash,customer_id,nas_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '15 minutes')",[credentials[i],users[i],createHash('sha256').update(passwords[i]).digest(),customer,nases[i]]);
  }
  await app.listen({host:'127.0.0.1',port:0});
  const address=app.server.address();assert.equal(typeof address,'object');const base=`https://127.0.0.1:${address.port}`;
  const access=i=>({'User-Name':attr(users[i]),'User-Password':attr(passwords[i]),'Acct-Session-Id':attr(`LAB-${i}`)});
  await assert.rejects(post(`${base}/radius/authorize`,c['ca.crt'],null,access(0),'nas_0'));
  assert.equal((await post(`${base}/radius/authorize`,c['ca.crt'],other,access(0),'nas_0')).status,401);
  assert.equal((await post(`${base}/radius/authorize`,c['ca.crt'],radius,access(0),'unregistered')).status,401);
  assert.equal((await post(`${base}/radius/authorize`,c['ca.crt'],radius,{...access(0),'User-Password':attr('x'.repeat(43))},'nas_0')).status,401);
  const first=await post(`${base}/radius/authorize`,c['ca.crt'],radius,access(0),'nas_0');assert.equal(first.status,200);assert.equal(first.body['reply:Mikrotik-Total-Limit'],705032704);assert.equal(first.body['reply:Mikrotik-Total-Limit-Gigawords'],1);assert.equal(first.body['reply:Mikrotik-Rate-Limit'],'1M/3M');
  const repeat=await post(`${base}/radius/authorize`,c['ca.crt'],radius,access(0),'nas_0');assert.equal(repeat.status,200);assert.deepEqual(repeat.body['reply:Class'],first.body['reply:Class']);assert.ok(repeat.body['reply:Session-Timeout']<=first.body['reply:Session-Timeout']);
  assert.equal((await post(`${base}/radius/authorize`,c['ca.crt'],radius,access(1),'nas_1')).status,401);
  const classAttr=first.body['reply:Class'].value[0],baseEvent={'Class':attr(classAttr),'Acct-Session-Id':attr('LAB-0')};
  const start={...baseEvent,'Class':attr(Buffer.from(classAttr.slice(2),'hex').toString('utf8')),'Acct-Status-Type':attr('Start')};
  assert.equal((await post(`${base}/radius/accounting`,c['ca.crt'],radius,start,'nas_1')).status,401);
  assert.equal((await post(`${base}/radius/accounting`,c['ca.crt'],radius,start,'nas_0')).status,204);
  const interim={...baseEvent,'Acct-Status-Type':attr('Interim-Update'),'Acct-Input-Octets':attr(10),'Acct-Input-Gigawords':attr(0),'Acct-Output-Octets':attr(0),'Acct-Output-Gigawords':attr(1)};
  assert.equal((await post(`${base}/radius/accounting`,c['ca.crt'],radius,interim,'nas_0')).status,204);
  assert.equal((await post(`${base}/radius/accounting`,c['ca.crt'],radius,interim,'nas_0')).status,204);
  assert.equal((await prepaid.query('SELECT consumed_bytes::text FROM purchase_entitlements WHERE id=$1',[entitlement])).rows[0].consumed_bytes,'4294967306');
  const missing={...interim};delete missing['Acct-Output-Gigawords'];assert.equal((await post(`${base}/radius/accounting`,c['ca.crt'],radius,missing,'nas_0')).status,401);
  assert.equal((await post(`${base}/radius/accounting`,c['ca.crt'],radius,{...interim,'Acct-Status-Type':attr('Stop')},'nas_0')).status,204);
  assert.equal((await post(`${base}/radius/authorize`,c['ca.crt'],radius,access(1),'nas_1')).status,401);
 } finally {
  await app.close();await network.query('DELETE FROM radius_credentials WHERE id=ANY($1::uuid[])',[credentials]);await network.query('DELETE FROM radius_nas WHERE id=ANY($1::uuid[])',[nases]);
  await prepaid.query('DELETE FROM access_grants WHERE customer_id=$1',[customer]);await prepaid.query('DELETE FROM purchase_entitlements WHERE id=$1',[entitlement]);await prepaid.query('DELETE FROM purchase_orders WHERE id=$1',[order]);await network.end();await prepaid.end();rmSync(dir,{recursive:true,force:true});
  for(const k of ['APP_ENV','NODE_ENV','INTERNAL_RADIUS_ENABLED']){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}
 }
});
