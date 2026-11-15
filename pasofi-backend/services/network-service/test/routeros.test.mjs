import {test} from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {RouterOS,configuredRouters} from '../dist/routeros.js';

test('RouterOS requires validated HTTPS and independently confirms removal',{timeout:30000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pamofi-router-rest-'));let server;
 try {
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,'key'),'-out',join(dir,'cert'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:router.invalid,IP:127.0.0.1'],{stdio:'ignore'});
  chmodSync(join(dir,'cert'),0o444);
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
  const config={nasId:'test',url:`https://router.invalid:${server.address().port}/rest/`,username:'operator',password:'test-only-secret',caFile:join(dir,'cert')};
  const testResolution={resolveHost:async()=>[{address:'127.0.0.1',family:4}],isPrivateAddress:address=>address==='127.0.0.1'};
  const router=new RouterOS(config,testResolution);
  const publicRouter=new RouterOS(config,{resolveHost:async()=>[{address:'8.8.8.8',family:4}]});
  const requestsBeforePublic=requests;
  await assert.rejects(publicRouter.active(username),{message:'router_unavailable'});
  assert.equal(requests,requestsBeforePublic,'public DNS answers must be rejected before credentials are sent');
  const mixedRouter=new RouterOS(config,{resolveHost:async()=>[{address:'127.0.0.1',family:4},{address:'8.8.8.8',family:4}],isPrivateAddress:address=>address==='127.0.0.1'});
  await assert.rejects(mixedRouter.active(username),{message:'router_unavailable'});
  assert.equal(requests,requestsBeforePublic,'ambiguous DNS answers must be rejected before credentials are sent');
  assert.throws(()=>new RouterOS({...config,url:`https://8.8.8.8:${server.address().port}/rest/`}),{message:'router_unavailable'});
  const caLink=join(dir,'ca-link');symlinkSync(join(dir,'cert'),caLink);
  assert.throws(()=>new RouterOS({...config,caFile:caLink}),{message:'router_unavailable'});
  chmodSync(join(dir,'cert'),0o666);
  assert.throws(()=>new RouterOS(config),{message:'router_unavailable'});
  chmodSync(join(dir,'cert'),0o444);
  const oversizedCA=join(dir,'oversized-ca');writeFileSync(oversizedCA,Buffer.alloc(65537,0x41),{mode:0o444});
  assert.throws(()=>new RouterOS({...config,caFile:oversizedCA}),{message:'router_unavailable'});
  const privateCA=join(dir,'private-ca');writeFileSync(privateCA,'-----BEGIN CERTIFICATE-----\\n-----BEGIN PRIVATE KEY-----',{mode:0o444});
  assert.throws(()=>new RouterOS({...config,caFile:privateCA}),{message:'router_unavailable'});
  assert.equal((await router.disconnect(username)).absent,true);assert.equal(deletes,1);assert.equal(requests,3);
  active=true;mode='retained';assert.equal((await router.disconnect(username)).absent,false);
  mode='foreign';const before=deletes;await assert.rejects(router.disconnect(username),{message:'router_unavailable'});assert.equal(deletes,before);
  mode='redirect';await assert.rejects(router.disconnect(username),{message:'router_unavailable'});
  assert.throws(()=>new RouterOS({...config,caFile:undefined}),{message:'router_unavailable'});
  assert.throws(()=>new RouterOS({...config,url:'http://127.0.0.1/rest/'}),{message:'router_unavailable'});
  assert.throws(()=>new RouterOS({...config,url:'https://user:password@router.example/rest/'}),{message:'router_unavailable'});
  mode='trickle';await assert.rejects(router.active(username),{message:'router_unavailable'});assert.equal(trickled,true);
 } finally {if(server)await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
test('router registry requires an absolute private regular file and validates entries',()=>{
 const dir=mkdtempSync(join(tmpdir(),'pamofi-router-registry-')),path=join(dir,'routers.json'),link=join(dir,'routers-link.json'),caDirectory=join(dir,'ca'),saved=process.env.ROUTEROS_ROUTERS_FILE;
 mkdirSync(caDirectory,{mode:0o755});
 process.env.ROUTEROS_ROUTERS_FILE=path;
 const nasId='ABCDEFAB-CDEF-4ABC-8ABC-ABCDEFABCDEF',caFile=join(caDirectory,nasId.toLowerCase()+'.pem');
 writeFileSync(caFile,'-----BEGIN CERTIFICATE-----\\nZm9v\\n-----END CERTIFICATE-----',{mode:0o444});
 const config={nasId,url:'https://router.invalid/rest/',username:'test',password:'test-only-password',caFile};
 const save=(rows,mode=0o444)=>{try{chmodSync(path,0o600);}catch{}writeFileSync(path,JSON.stringify(rows));chmodSync(path,mode);};
 try {
  save([config]);assert.ok(configuredRouters({caDirectory}).has(nasId.toLowerCase()));
  save([config,{...config,nasId:nasId.toLowerCase()}]);assert.throws(()=>configuredRouters({caDirectory}),{message:'router_unavailable'});
  for(const invalid of ['-'.repeat(36),'1'.repeat(36)]){save([{...config,nasId:invalid}]);assert.throws(()=>configuredRouters({caDirectory}),{message:'router_unavailable'});}
  save([{...config,caFile:join(caDirectory,'other.pem')}]);assert.throws(()=>configuredRouters({caDirectory}),{message:'router_unavailable'});
  save([{...config,caFile:undefined}]);assert.throws(()=>configuredRouters({caDirectory}),{message:'router_unavailable'});
  save([config],0o644);assert.throws(()=>configuredRouters({caDirectory}),{message:'router_unavailable'});
  chmodSync(path,0o600);writeFileSync(path,Buffer.alloc(512*1024+1,0x20));chmodSync(path,0o444);assert.throws(()=>configuredRouters({caDirectory}),{message:'router_unavailable'});
  save([config]);symlinkSync(path,link);process.env.ROUTEROS_ROUTERS_FILE=link;assert.throws(()=>configuredRouters({caDirectory}),{message:'router_unavailable'});
  process.env.ROUTEROS_ROUTERS_FILE='routers.json';assert.throws(()=>configuredRouters({caDirectory}),{message:'router_unavailable'});
 }finally{if(saved===undefined)delete process.env.ROUTEROS_ROUTERS_FILE;else process.env.ROUTEROS_ROUTERS_FILE=saved;rmSync(dir,{recursive:true,force:true});}
});
