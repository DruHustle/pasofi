import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const cwd=fileURLToPath(new URL('.',import.meta.url));
const available=spawnSync('docker',['compose','version','--short'],{encoding:'utf8'}).status===0;
test('actual Compose merge adds explicit provider egress only to prepaid and keeps payment activation closed',
 {skip:!available&&process.env.CI!=='true'},()=>{
 const env={...process.env,COMPOSE_DISABLE_ENV_FILE:'1',PAMOFI_PUBLIC_HOST:'stripe-config.example.test',
  PAMOFI_SERVICES_SUBNET:'10.246.0.0/24',PAMOFI_STRIPE_EGRESS_SUBNET:'10.247.0.0/24',
  PAMOFI_SECRETS_DIR:'/not-mounted/stripe-config-test',PAMOFI_DATABASE_VOLUME:'stripe-config-not-created',
  PAMOFI_COMMERCE_ENABLED:'false',PAMOFI_AGENT_COMMISSION_BPS:'0',VOUCHER_DELIVERY_ACTIVE_KEY_ID:'synthetic',RADIUS_CREDENTIAL_KEY_VERSION:'1',
  STRIPE_ACCOUNT_ID:'acct_SyntheticMerchant123',STRIPE_MERCHANT_COUNTRY:'GB',STRIPE_PUBLISHABLE_KEY:'pk_live_SYNTHETIC',
  STRIPE_QUALIFIED_SITE_IDS_JSON:'["11111111-1111-4111-8111-111111111111"]'};
 for(const key of ['COMPOSE_FILE','COMPOSE_PROFILES','COMPOSE_PROJECT_NAME','COMPOSE_ENV_FILES','PAMOFI_PAYMENTS_ENABLED','STRIPE_PRODUCTION_QUALIFIED'])delete env[key];
 for(const service of ['IDENTITY','PREPAID','NETWORK','NOTIFICATION','ASSISTANT','WEB'])env[`PAMOFI_${service}_IMAGE`]='example.invalid/synthetic:never-pulled';
 const render=(overlay,values=env)=>spawnSync('docker',['compose','-p','stripe-config-read-only','--profile','*','-f','compose.yaml',
  ...(overlay?['-f','stripe-payments.compose.yaml']:[]),'config','--format','json'],{cwd,env:values,encoding:'utf8',timeout:15000});
 const original=render(false),merged=render(true);assert.equal(original.status,0,original.stderr);assert.equal(merged.status,0,merged.stderr);
 const base=JSON.parse(original.stdout),next=JSON.parse(merged.stdout),prepaid=next.services['prepaid-access'];
 assert.equal(base.services['prepaid-access'].environment.PAMOFI_PAYMENTS_ENABLED,'false');
 assert.equal(base.services['prepaid-access'].environment.PAMOFI_PAYMENT_MODE,'disabled');
 assert.equal(base.networks.stripe_egress,undefined);
 assert.deepEqual(Object.keys(prepaid.networks).sort(),['database','services','stripe_egress']);
 assert.equal(prepaid.networks.stripe_egress.gw_priority,1);assert.equal(prepaid.ports?.length??0,0);
 assert.equal(prepaid.environment.PAMOFI_PAYMENTS_ENABLED,'false');assert.equal(prepaid.environment.STRIPE_PRODUCTION_QUALIFIED,'false');
 assert.equal(prepaid.environment.PAMOFI_CUSTOMER_NETWORK_ENABLED,'false');assert.equal(prepaid.environment.PAMOFI_RADIUS_QUALIFIED,'false');
 assert.equal(next.networks.stripe_egress.internal??false,false);assert.equal(next.networks.stripe_egress.driver,'bridge');
 assert.deepEqual(next.networks.stripe_egress.ipam.config,[{subnet:env.PAMOFI_STRIPE_EGRESS_SUBNET}]);
 for(const [name,service]of Object.entries(base.services))if(name!=='prepaid-access')assert.deepEqual(next.services[name],service,`${name} changed`);
 for(const [name,network]of Object.entries(base.networks))assert.deepEqual(next.networks[name],network,`${name} isolation changed`);
 const missing={...env};delete missing.PAMOFI_STRIPE_EGRESS_SUBNET;
 const refused=render(true,missing);assert.notEqual(refused.status,0);assert.match(refused.stderr,/PAMOFI_STRIPE_EGRESS_SUBNET/);
});
