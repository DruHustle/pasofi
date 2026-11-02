import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const renderer=fileURLToPath(new URL('./render-config.sh',import.meta.url));
async function fixture(root){
 const values={b2_key_id:'synthetic_key_id_12345',b2_application_key:'synthetic_application_key_0123456789',backup_cipher:'synthetic_independent_cipher_01234567890123456789'};
 for(const [name,value]of Object.entries(values))await writeFile(join(root,name),value,{mode:0o600});
 return {values,env:{PATH:process.env.PATH,B2_BUCKET:'pamofi-disposable-test',B2_REGION:'us-west-004',BACKUP_REPOSITORY_PREFIX:'/isolated-test',B2_KEY_ID_FILE:join(root,'b2_key_id'),B2_APPLICATION_KEY_FILE:join(root,'b2_application_key'),BACKUP_CIPHER_FILE:join(root,'backup_cipher')}};
}
test('B2 config encrypts and verifies TLS, separates PGDATA, and keeps credentials out of output',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pamofi-backup-config-'));
 try {
  const {values,env}=await fixture(root),target=join(root,'pgbackrest.conf');
  const result=spawnSync('sh',[renderer,target],{env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
  assert.equal((await stat(target)).mode&0o777,0o600);const config=await readFile(target,'utf8');
  for(const value of Object.values(values))assert.ok(config.includes(value),'Expected secret only in private config');
  for(const line of ['repo1-s3-endpoint=s3.us-west-004.backblazeb2.com','repo1-storage-verify-tls=y','repo1-cipher-type=aes-256-cbc','repo1-path=/isolated-test','archive-check=y','archive-copy=y','pg1-path=/var/lib/postgresql/data/pgdata','pg1-user=pamofi_bootstrap'])assert.ok(config.split('\n').includes(line),`Missing required setting ${line}`);
  // Atomic replacement must retain private mode even if an old file was broad.
  const replaced=spawnSync('sh',[renderer,target],{env,encoding:'utf8'});assert.equal(replaced.status,0);assert.equal((await stat(target)).mode&0o777,0o600);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('B2 config rejects injected options, missing files and short secrets without exposing values',async()=>{
 const root=await mkdtemp(join(tmpdir(),'pamofi-backup-reject-'));
 try {
  const {values,env}=await fixture(root);
  const cases=[{B2_BUCKET:'bucket\nrepo1-storage-verify-tls=n'},{B2_REGION:'us-west-004;unsafe'},{BACKUP_REPOSITORY_PREFIX:'/../other-env'},{B2_KEY_ID_FILE:join(root,'missing')}];
  await writeFile(join(root,'bad-secret'),'short');cases.push({BACKUP_CIPHER_FILE:join(root,'bad-secret')});
  await writeFile(join(root,'injected-secret'),values.backup_cipher+'\nrepo1-storage-verify-tls=n');cases.push({BACKUP_CIPHER_FILE:join(root,'injected-secret')});
  for(let index=0;index<cases.length;index++){
   const target=join(root,`rejected-${index}.conf`),result=spawnSync('sh',[renderer,target],{env:{...env,...cases[index]},encoding:'utf8'});assert.notEqual(result.status,0,`Unsafe case ${index} accepted`);
   for(const secret of Object.values(values))assert.ok(!(result.stdout+result.stderr).includes(secret),'Secret leaked to process output');
   await assert.rejects(stat(target),{code:'ENOENT'});
  }
 }finally{await rm(root,{recursive:true,force:true});}
});
