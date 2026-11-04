import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const script=fileURLToPath(new URL('./check.sh',import.meta.url));
test('hostname and 30-day expiry checks reject unsafe certificates',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pamofi-cert-check-'));
  try {
    for(const [name,hostname,days,expected] of [['valid','hotspot.pamofi.onesa.eu','60',0],['short','hotspot.pamofi.onesa.eu','1',1],['wrong','other.onesa.eu','60',1]]) {
      const cert=join(dir,`${name}.pem`),key=join(dir,`${name}.key`);
      const gen=spawnSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days',days,'-subj',`/CN=${hostname}`],{encoding:'utf8'});
      assert.equal(gen.status,0,gen.stderr);
      assert.equal(spawnSync('sh',[script,cert]).status,expected,name);
    }
    assert.equal(spawnSync('sh',[script,join(dir,'missing.pem')]).status,1);
  }finally {await rm(dir,{recursive:true,force:true});}
});
