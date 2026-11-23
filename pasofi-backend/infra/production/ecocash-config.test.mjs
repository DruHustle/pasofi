import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const cwd=fileURLToPath(new URL('.',import.meta.url));
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
