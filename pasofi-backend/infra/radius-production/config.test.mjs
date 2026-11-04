import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {X509Certificate} from 'node:crypto';
import {validateRegistry,renderClients,registrationSql,prepare} from './prepare.mjs';
import {loadEnvironment} from './start-authority.mjs';
const fixture=()=>({serverTunnelIp:'10.77.254.1',nases:[{nasId:'f21a346c-f639-4a84-8511-a7d26ef080f7',siteId:'792e6c6d-8b01-41f2-8892-40fd83932d34',clientName:'nas_a',siteName:'Pilot A',routerTunnelIp:'10.77.254.2',loginUrl:'https://login.example.com/login'}]});
test('production RADIUS clients use exact NAS /32 and require authenticated requests',()=>{
  const registry=fixture(),secret='a'.repeat(64),text=renderClients(registry,{nas_a:secret});
  assert.match(text,/ipaddr = 10\.77\.254\.2\/32/);assert.match(text,/shortname = nas_a/);
  assert.match(text,/require_message_authenticator = yes/);assert.match(text,/limit_proxy_state = yes/);
  assert.doesNotMatch(text,/0\.0\.0\.0|127\.0\.0\.1|LAB_ONLY/);
  assert.throws(()=>renderClients(registry,{nas_a:'unsafe" secret'}));
});
test('NAS registrations are explicit, disabled and reject ambiguous identity or injected material',()=>{
  const original=fixture();assert.equal(validateRegistry(original),original);
  for(const change of [{secret:'x'},{serverTunnelIp:'0.0.0.0'},{serverTunnelIp:'127.0.0.1'},{nases:[]},{nases:[original.nases[0],original.nases[0]]}])assert.throws(()=>validateRegistry({...fixture(),...change}));
  for(const update of [{nasId:['f21a346c-f639-4a84-8511-a7d26ef080f7']},{siteId:'NOT-UUID'},{clientName:'a\nsecret = x'},{routerTunnelIp:'10.77.254.1'},{loginUrl:'http://login.pamofi.com/login'},{loginUrl:'https://login.pamofi.com/login?next=evil'},{siteName:'bad\nvalue'}])assert.throws(()=>validateRegistry({...fixture(),nases:[{...fixture().nases[0],...update}]}));
  original.nases[0].siteName="Owner's pilot";const sql=registrationSql(original);assert.match(sql,/Owner''s pilot/);assert.match(sql,/,false\);/);assert.doesNotMatch(sql,/ON CONFLICT|enabled=true/);
});
test('preparation creates private independent secrets and actual mutually trusted TLS material without overwrite',async()=>{
  const parent=await mkdtemp(join(tmpdir(),'pamofi-radius-prepare-'));
  try{
    const directory=join(parent,'protected');await prepare(fixture(),directory);
    assert.equal((await stat(directory)).mode&0o777,0o700);
    for(const file of ['nas-nas_a.secret','radius_ca_key','registry.json','review.json'])assert.equal((await stat(join(directory,file))).mode&0o777,0o600);
    const ca=new X509Certificate(await readFile(join(directory,'radius_ca')));
    const server=new X509Certificate(await readFile(join(directory,'radius_server_cert'))),client=new X509Certificate(await readFile(join(directory,'radius_client_cert')));
    assert.ok(server.verify(ca.publicKey));assert.ok(client.verify(ca.publicKey));assert.equal(server.checkHost('radius-api'),'radius-api');
    assert.equal((await readFile(join(directory,'radius_client_fingerprint'),'utf8')).trim(),client.fingerprint256.replaceAll(':','').toLowerCase());
    assert.equal(JSON.parse(await readFile(join(directory,'review.json'),'utf8')).status,'prepared-only');
    const saved=await readFile(join(directory,'nas-nas_a.secret'),'utf8');assert.match(saved,/^[a-f0-9]{64}\n$/);
    await assert.rejects(prepare(fixture(),directory));assert.equal(await readFile(join(directory,'nas-nas_a.secret'),'utf8'),saved);
  }finally{await rm(parent,{recursive:true,force:true});}
});
test('authority loader requires production qualification, runtime DB role and file-only credentials',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pamofi-radius-loader-'));
  try{
    const values={DATABASE_URL:'postgresql://pamofi_network_runtime:secret@postgres:5432/pamofi_network',INTERNAL_NETWORK_SECRET:'a'.repeat(64),RADIUS_CLIENT_FINGERPRINT:'b'.repeat(64)};
    const env={APP_ENV:'production',NODE_ENV:'production',PAMOFI_RADIUS_QUALIFIED:'true',PREPAID_URL:'https://prepaid.internal',RADIUS_CA_FILE:'ca',RADIUS_SERVER_CERT_FILE:'cert',RADIUS_SERVER_KEY_FILE:'key',NODE_EXTRA_CA_CERTS:'internal-ca'};
    for(const [name,value]of Object.entries(values)){const path=join(dir,name);await writeFile(path,value+'\n');env[`${name}_FILE`]=path;}
    assert.deepEqual(await loadEnvironment(env),values);
    for(const update of [{APP_ENV:'demo'},{PAMOFI_RADIUS_QUALIFIED:'false'},{DATABASE_URL:values.DATABASE_URL},{PREPAID_URL:'http://prepaid:3000'},{RADIUS_CA_FILE:''},{PAMOFI_ROLE_PREFIX:'bad;sql'}])await assert.rejects(loadEnvironment({...env,...update}));
    await writeFile(env.DATABASE_URL_FILE,'postgresql://pamofi_network_migrate:secret@postgres:5432/pamofi_network');await assert.rejects(loadEnvironment(env));
    await writeFile(env.DATABASE_URL_FILE,values.DATABASE_URL);await writeFile(env.RADIUS_CLIENT_FINGERPRINT_FILE,'not-a-fingerprint');await assert.rejects(loadEnvironment(env));
  }finally{await rm(dir,{recursive:true,force:true});}
});
