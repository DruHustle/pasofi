import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const cwd=fileURLToPath(new URL('.',import.meta.url));

test('the production prepaid entrypoint accepts EcoCash credentials only from secret files', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'pasofi-ecocash-secret-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const dist = join(fixture, 'dist');
  await mkdir(dist);
  const database = join(fixture, 'database');
  const password = join(fixture, 'password');
  const pin = join(fixture, 'pin');
  await Promise.all([
    writeFile(database, 'postgresql://pamofi_prepaid_access_runtime:fixture_only@127.0.0.1:1/pamofi_prepaid_access\n', { mode: 0o400 }),
    writeFile(password, 'fixture-password\n', { mode: 0o400 }),
    writeFile(pin, '0000\n', { mode: 0o400 }),
    writeFile(join(dist, 'server.js'), `
if (process.env.PAMOFI_ECOCASH_CHECKOUT_ENABLED === 'true' &&
    (process.env.ECOCASH_API_PASSWORD !== 'fixture-password' || process.env.ECOCASH_MERCHANT_PIN !== '0000')) {
  throw Error('fixture credentials were not loaded');
}
console.log('fixture service started');
`),
  ]);
  const start = overrides => spawnSync(process.execPath, [join(cwd, 'entrypoint.mjs'), 'serve'], {
    cwd: fixture,
    env: { APP_ENV: 'production', NODE_ENV: 'production', PAMOFI_SERVICE: 'prepaid-access', DATABASE_URL_FILE: database, ...overrides },
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(start({}).status, 0, 'base production remains available with EcoCash off');
  for (const name of ['ECOCASH_API_PASSWORD', 'ECOCASH_MERCHANT_PIN']) {
    const inline = start({ [name]: 'fixture-inline' });
    assert.equal(inline.status, 1, `${name} stays out of the startup environment even while paused`);
    assert.match(inline.stderr, new RegExp(`${name}_FILE`));
    assert.doesNotMatch(inline.stdout + inline.stderr, /fixture-inline|fixture service started/);
  }
  const active = { PAMOFI_ECOCASH_CHECKOUT_ENABLED: 'true' };
  const withoutPin = start({ ...active, ECOCASH_API_PASSWORD_FILE: password });
  assert.equal(withoutPin.status, 1);
  assert.match(withoutPin.stderr, /ECOCASH_MERCHANT_PIN_FILE/);
  assert.doesNotMatch(withoutPin.stdout + withoutPin.stderr, /fixture-password|fixture service started/);
  const mounted = start({ ...active, ECOCASH_API_PASSWORD_FILE: password, ECOCASH_MERCHANT_PIN_FILE: pin });
  assert.equal(mounted.status, 0, mounted.stderr);
  assert.match(mounted.stdout, /fixture service started/);
});

const available=spawnSync('docker',['compose','version','--short'],{encoding:'utf8'}).status===0;
test('EcoCash overlay adds egress only to prepaid, loads secrets from files and keeps checkout switched off',
 {skip:!available&&process.env.CI!=='true'},()=>{
 const env={...process.env,COMPOSE_DISABLE_ENV_FILE:'1',PAMOFI_PUBLIC_HOST:'ecocash-config.example.test',
  PAMOFI_SERVICES_SUBNET:'10.246.0.0/24',PAMOFI_ECOCASH_EGRESS_SUBNET:'10.248.0.0/24',
  PAMOFI_SECRETS_DIR:'/not-mounted/ecocash-config-test',PAMOFI_DATABASE_VOLUME:'ecocash-config-not-created',
  PAMOFI_ROUTER_CONTROL_DIR:'/not-mounted/router-control',PAMOFI_ROUTER_CONTROL_QUALIFIED:'false',
  PAMOFI_COMMERCE_ENABLED:'false',PAMOFI_AGENT_COMMISSION_BPS:'0',VOUCHER_DELIVERY_ACTIVE_KEY_ID:'synthetic',RADIUS_CREDENTIAL_KEY_VERSION:'1',
  ECOCASH_API_BASE_URL:'https://payments.ecocash.invalid/payment/v1/',ECOCASH_API_USERNAME:'synthetic-user',ECOCASH_MERCHANT_CODE:'000000',
  ECOCASH_MERCHANT_NUMBER:'0770000000',ECOCASH_TERMINAL_ID:'SYNTH001',ECOCASH_LOCATION:'Synthetic',ECOCASH_SUPER_MERCHANT_NAME:'Synthetic',ECOCASH_MERCHANT_NAME:'Synthetic'};
 for(const key of ['COMPOSE_FILE','COMPOSE_PROFILES','COMPOSE_PROJECT_NAME','COMPOSE_ENV_FILES','PAMOFI_PAYMENTS_ENABLED','PAMOFI_ECOCASH_CHECKOUT_ENABLED','ECOCASH_PRODUCTION_QUALIFIED','ECOCASH_QUALIFIED_SITE_IDS_JSON'])delete env[key];
 for(const service of ['IDENTITY','PREPAID','NETWORK','NOTIFICATION','ASSISTANT','WEB'])env[`PAMOFI_${service}_IMAGE`]='example.invalid/synthetic:never-pulled';
 const render=overlay=>spawnSync('docker',['compose','-p','ecocash-config-read-only','--profile','*','-f','compose.yaml',...(overlay?['-f','ecocash-payments.compose.yaml']:[]),'config','--format','json'],{cwd,env,encoding:'utf8',timeout:15000});
 const original=render(false),merged=render(true);assert.equal(original.status,0,original.stderr);assert.equal(merged.status,0,merged.stderr);
 const base=JSON.parse(original.stdout),next=JSON.parse(merged.stdout),prepaid=next.services['prepaid-access'];
 assert.equal(base.networks.ecocash_egress,undefined);
 assert.deepEqual(Object.keys(prepaid.networks).sort(),['database','ecocash_egress','services']);
 assert.equal(prepaid.networks.ecocash_egress.gw_priority,1);assert.equal(prepaid.ports?.length??0,0);
 for(const [name,value] of Object.entries({PAMOFI_PAYMENTS_ENABLED:'false',PAMOFI_ECOCASH_CHECKOUT_ENABLED:'false',ECOCASH_PRODUCTION_QUALIFIED:'false',ECOCASH_QUALIFIED_SITE_IDS_JSON:'[]',ECOCASH_ENVIRONMENT:'production'}))
  assert.equal(prepaid.environment[name],value,name);
 assert.equal(prepaid.environment.ECOCASH_API_PASSWORD,undefined,'the API password is never an inline environment value');
 assert.equal(prepaid.environment.ECOCASH_MERCHANT_PIN,undefined,'the merchant PIN is never an inline environment value');
 assert.equal(prepaid.environment.ECOCASH_API_PASSWORD_FILE,'/run/secrets/ecocash_api_password');
 assert.equal(prepaid.environment.ECOCASH_MERCHANT_PIN_FILE,'/run/secrets/ecocash_merchant_pin');
 for(const [name,service] of Object.entries(next.services))if(name!=='prepaid-access')assert.equal(service.networks?.ecocash_egress,undefined,`${name} has no EcoCash egress`);
});
