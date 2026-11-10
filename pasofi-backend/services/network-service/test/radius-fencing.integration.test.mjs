import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,X509Certificate} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import https from 'node:https';
import pg from 'pg';
import {buildRadiusApp} from '../dist/radius-app.js';
import {issueRadiusCredential} from '../dist/credentials.js';

const database=process.env.PAMOFI_TEST_NETWORK_DATABASE_URL;
const attr=value=>({value:[value]});
function certificates(dir){
  const file=name=>join(dir,name),run=args=>execFileSync('openssl',args,{stdio:'ignore'});
  run(['req','-x509','-newkey','rsa:2048','-nodes','-keyout',file('ca.key'),'-out',file('ca.crt'),'-days','1','-subj','/CN=Pasofi fencing test CA']);
  for(const name of ['server','radius']){
    run(['req','-newkey','rsa:2048','-nodes','-keyout',file(`${name}.key`),'-out',file(`${name}.csr`),'-subj',`/CN=${name}`]);
    writeFileSync(file(`${name}.ext`),name==='server'?'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n':'extendedKeyUsage=clientAuth\n');
    run(['x509','-req','-in',file(`${name}.csr`),'-CA',file('ca.crt'),'-CAkey',file('ca.key'),'-CAcreateserial','-out',file(`${name}.crt`),'-days','1','-extfile',file(`${name}.ext`)]);
  }
  return Object.fromEntries(['ca.crt','server.crt','server.key','radius.crt','radius.key'].map(name=>[name,readFileSync(file(name))]));
}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function authorize(endpoint,c,body,clientName){return new Promise((resolve,reject)=>{
  const request=https.request(endpoint,{method:'POST',ca:c['ca.crt'],cert:c['radius.crt'],key:c['radius.key'],headers:{'content-type':'application/json','x-pamofi-nas':clientName}},response=>{let raw='';response.setEncoding('utf8');response.on('data',part=>{raw+=part;});response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(raw)}));});
  request.on('error',reject);request.end(JSON.stringify(body));
});}
test('credential revocation, expiry and NAS disablement during grant lookup prevent Access-Accept',{skip:!database,timeout:30000},async()=>{
  const env={APP_ENV:'demo',NODE_ENV:'development',INTERNAL_RADIUS_ENABLED:'true'},saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
  const dir=mkdtempSync(join(tmpdir(),'pamofi-radius-fencing-')),c=certificates(dir),pool=new pg.Pool({connectionString:database,max:3});
  const customer=randomUUID(),nas=randomUUID(),site=randomUUID(),clientName=`fence_${randomUUID().replaceAll('-','')}`;
  let barrier,server,app;
  try {
    await pool.query('INSERT INTO radius_nas(id,site_id,client_name,enabled) VALUES($1,$2,$3,true)',[nas,site,clientName]);
    server=createServer(async(request,response)=>{
      let raw='';for await(const part of request)raw+=part;
      const body=JSON.parse(raw);assert.equal(body.customerId,customer);assert.equal(body.nasId,nas);assert.equal(body.siteId,site);
      const current=barrier;current.arrived.resolve();await current.release.promise;
      response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({grantId:randomUUID(),generation:randomUUID(),reservedBytes:'5000',deadline:new Date(Date.now()+3600000).toISOString()}));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    app=buildRadiusApp({pool,tls:{ca:c['ca.crt'],cert:c['server.crt'],key:c['server.key']},clientFingerprint:new X509Certificate(c['radius.crt']).fingerprint256,prepaidUrl:`http://127.0.0.1:${server.address().port}`,networkSecret:'test_fencing_key_at_least_32_bytes'});
    const endpoint=(await app.listen({host:'127.0.0.1',port:0}))+'/radius/authorize';
    for(const change of ['unchanged','revoked','expired','disabled_nas']){
      await pool.query('UPDATE radius_nas SET enabled=true WHERE id=$1',[nas]);
      const credential=await issueRadiusCredential(pool,{customerId:customer,nasId:nas,requestKey:randomUUID()},{version:1,key:randomBytes(32)});
      barrier={arrived:deferred(),release:deferred()};
      const pending=authorize(endpoint,c,{'User-Name':attr(credential.username),'User-Password':attr(credential.password),'Acct-Session-Id':attr(`fencing-${change}`)},clientName);
      let timer;try{await Promise.race([barrier.arrived.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('ledger request did not arrive')),3000);})]);}finally{clearTimeout(timer);}
      if(change==='revoked')await pool.query('UPDATE radius_credentials SET revoked_at=now() WHERE username=$1',[credential.username]);
      if(change==='expired')await pool.query("UPDATE radius_credentials SET expires_at=now()-interval '1 second' WHERE username=$1",[credential.username]);
      if(change==='disabled_nas')await pool.query('UPDATE radius_nas SET enabled=false WHERE id=$1',[nas]);
      barrier.release.resolve();const result=await pending;
      assert.equal(result.status,change==='unchanged'?200:401,change);
      if(change!=='unchanged')assert.equal(result.body['reply:Class'],undefined);
    }
  } finally {
    barrier?.release.resolve();if(app)await app.close();if(server)await new Promise(resolve=>server.close(resolve));
    await pool.query('DELETE FROM radius_credentials WHERE customer_id=$1',[customer]);await pool.query('DELETE FROM radius_nas WHERE id=$1',[nas]);await pool.end();rmSync(dir,{recursive:true,force:true});
    for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});
