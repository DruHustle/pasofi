import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildRouterPlan} from './router-plan.mjs';

test('router RADIUS plan is disabled, source-bound and contains no secret',()=>{
  const secret='a'.repeat(64),secretHash=createHash('sha512').update(secret).digest('hex');
  const plan=buildRouterPlan({site:'site01',serverIp:'10.77.254.1',routerIp:'10.77.254.2',secretHash});
  assert.ok(!plan.includes(secret));
  assert.match(plan,/src-address=10\.77\.254\.2/);
  assert.match(plan,/require-message-auth=yes-for-request-resp/);
  assert.match(plan,/secret=\$radiusSecret disabled=yes/);
  assert.ok(plan.indexOf('RADIUS secret checksum mismatch')<plan.indexOf('/radius add'));
  assert.doesNotMatch(plan,/\/ip hotspot add|disabled=no comment=/);
  assert.match(plan,/wireguard find where name="pamofi-service" and disabled=no/);
  for(const bad of [{site:'../escape'},{serverIp:'8.8.8.8'},{routerIp:'10.77.254.1'},{secretHash:'bad'},
    ...['bridge','ether1','pasofi-service"; /system reboot','pasofi-service\n','',null,23].map(routerInterface=>({routerInterface}))])assert.throws(()=>buildRouterPlan({site:'site01',serverIp:'10.77.254.1',routerIp:'10.77.254.2',secretHash,...bad}));
});

test('the site-two RADIUS client uses the explicitly selected service interface',()=>{
  const plan=buildRouterPlan({site:'site02',serverIp:'10.77.254.5',routerIp:'10.77.254.6',secretHash:'a'.repeat(128),routerInterface:'pasofi-service'});
  assert.match(plan,/wireguard find where name="pasofi-service" and disabled=no/);
  assert.match(plan,/\/ip address find where interface="pasofi-service" and address="10\.77\.254\.6\/32"/);
  assert.match(plan,/pfi-radius-site02\.secret/);
  assert.match(plan,/address=10\.77\.254\.5 src-address=10\.77\.254\.6/);
  assert.ok(plan.indexOf('Multiple service interfaces exist')<plan.indexOf('/radius add'));
  assert.doesNotMatch(plan,/(?:interface|gateway)="pamofi-service"/);
});

test('CLI handles a single newline without exposing or overwriting the secret',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pamofi-router-radius-'));
  try {
    const secret='b'.repeat(64),file=join(dir,'secret'),out=join(dir,'review.rsc');
    await writeFile(file,secret+'\n',{mode:0o600});
    const script=fileURLToPath(new URL('./router-plan.mjs',import.meta.url));
    const args=[script,'site01','10.77.254.1','10.77.254.2',file,out];
    const first=spawnSync(process.execPath,args,{encoding:'utf8'});
    assert.equal(first.status,0,first.stderr);
    assert.ok(!first.stdout.includes(secret));
    const text=await readFile(out,'utf8');
    assert.ok(!text.includes(secret));
    assert.ok(text.includes(createHash('sha512').update(secret).digest('hex')));
    assert.notEqual(spawnSync(process.execPath,args,{encoding:'utf8'}).status,0);
    assert.equal(await readFile(out,'utf8'),text);
    const siteTwoOut=join(dir,'site-two.rsc');
    const siteTwo=spawnSync(process.execPath,[script,'site02','10.77.254.5','10.77.254.6',file,siteTwoOut,'pasofi-service'],{encoding:'utf8'});
    assert.equal(siteTwo.status,0,siteTwo.stderr);
    assert.match(await readFile(siteTwoOut,'utf8'),/wireguard find where name="pasofi-service" and disabled=no/);
    assert.notEqual(spawnSync(process.execPath,[script,'site02','10.77.254.5','10.77.254.6',file,join(dir,'unsafe.rsc'),'bridge'],{encoding:'utf8'}).status,0);
    const nonAscii=Buffer.alloc(64,0x62);nonAscii[0]=0xe2;
    await writeFile(file,nonAscii,{mode:0o600});
    assert.notEqual(spawnSync(process.execPath,[script,'site01','10.77.254.1','10.77.254.2',file,join(dir,'invalid.rsc')],{encoding:'utf8'}).status,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
