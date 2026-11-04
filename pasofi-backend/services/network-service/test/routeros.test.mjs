import {test} from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {RouterOS,configuredRouters} from '../dist/routeros.js';

test('RouterOS requires validated HTTPS and independently confirms removal',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pamofi-router-rest-'));let server;
 try {
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  let mode='valid',active=true,deletes=0,requests=0,trickled=false;const username='customer_'+ 'a'.repeat(24);
  server=https.createServer({key:readFileSync(join(dir,'key')),cert:readFileSync(join(dir,'cert'))},(request,response)=>{
   requests++;assert.equal(request.headers.authorization,'Basic '+Buffer.from('operator:test-only-secret').toString('base64'));
   response.setHeader('content-type','application/json');
   if(mode==='redirect'){response.writeHead(302,{location:'https://example.invalid/'});response.end();return;}
   const url=new URL(request.url,'https://router.invalid');
   if(request.method==='DELETE') {deletes++;assert.equal(decodeURIComponent(url.pathname),'/rest/ip/hotspot/active/*A');if(mode==='valid')active=false;response.end();return;}
   assert.equal(url.searchParams.get('user'),username);
   if(mode==='trickle'){
    trickled=true;response.write('[');
    const interval=setInterval(()=>response.write(' '),100),end=setTimeout(()=>response.end(']'),7000);
    response.on('close',()=>{clearInterval(interval);clearTimeout(end);});return;
   }
   response.end(JSON.stringify(active?[{'.id':'*A',user:mode==='foreign'?'another-customer':username}]:[]));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={nasId:'test',url:`https://127.0.0.1:${server.address().port}/rest/`,username:'operator',password:'test-only-secret',caFile:join(dir,'cert')};
  const router=new RouterOS(config);
  assert.equal((await router.disconnect(username)).absent,true);assert.equal(deletes,1);assert.equal(requests,3);
  active=true;mode='retained';assert.equal((await router.disconnect(username)).absent,false);
  mode='foreign';const before=deletes;await assert.rejects(router.disconnect(username),{message:'router_unavailable'});assert.equal(deletes,before);
  mode='redirect';await assert.rejects(router.disconnect(username),{message:'router_unavailable'});
  await assert.rejects(new RouterOS({...config,caFile:undefined}).active(username),{message:'router_unavailable'});
  assert.throws(()=>new RouterOS({...config,url:'http://127.0.0.1/rest/'}),{message:'router_unavailable'});
  assert.throws(()=>new RouterOS({...config,url:'https://user:password@router.example/rest/'}),{message:'router_unavailable'});
  mode='trickle';await assert.rejects(router.active(username),{message:'router_unavailable'});assert.equal(trickled,true);
 } finally {if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
test('router registry normalizes NAS UUIDs and rejects malformed or case-duplicate IDs',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pamofi-router-registry-')),path=join(dir,'routers.json'),saved=process.env.ROUTEROS_ROUTERS_FILE;
 process.env.ROUTEROS_ROUTERS_FILE=path;
 const nasId='ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF',config={nasId,url:'https://router.invalid/rest/',username:'test',password:'test-only-password'};
 try {
  writeFileSync(path,JSON.stringify([config]));assert.ok(configuredRouters().has(nasId.toLowerCase()));
  writeFileSync(path,JSON.stringify([config,{...config,nasId:nasId.toLowerCase()}]));assert.throws(()=>configuredRouters(),{message:'router_unavailable'});
  for(const invalid of ['-'.repeat(36),'1'.repeat(36)]){writeFileSync(path,JSON.stringify([{...config,nasId:invalid}]));assert.throws(()=>configuredRouters(),{message:'router_unavailable'});}
 }finally{if(saved===undefined)delete process.env.ROUTEROS_ROUTERS_FILE;else process.env.ROUTEROS_ROUTERS_FILE=saved;rmSync(dir,{recursive:true,force:true});}
});
