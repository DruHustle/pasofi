import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('.', import.meta.url));
const available = spawnSync('docker', ['compose', 'version', '--short']).status === 0;
const env = {
  PATH: process.env.PATH,
  COMPOSE_DISABLE_ENV_FILE: '1',
  PAMOFI_PUBLIC_HOST: 'cash-config.example.test',
  PAMOFI_SERVICES_SUBNET: '10.246.0.0/24',
  PAMOFI_SECRETS_DIR: '/not-mounted/cash-config-test',
  PAMOFI_DATABASE_VOLUME: 'cash-config-not-created',
  PAMOFI_COMMERCE_ENABLED: 'false',
  PAMOFI_AGENT_COMMISSION_BPS: '0',
  VOUCHER_DELIVERY_ACTIVE_KEY_ID: 'synthetic',
  RADIUS_CREDENTIAL_KEY_VERSION: '1',
};
for (const service of ['IDENTITY', 'PREPAID', 'NETWORK', 'NOTIFICATION', 'ASSISTANT', 'WEB']) {
  env[`PAMOFI_${service}_IMAGE`] = 'example.invalid/synthetic:never-pulled';
}

function render(files, values = env) {
  const result = spawnSync('docker', [
    'compose', '-p', 'cash-config-read-only', '--profile', '*',
    ...files.flatMap(file => ['-f', file]), 'config', '--format', 'json',
  ], { cwd, env: values, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

test('production cash requires its own reviewed Compose inputs', { skip: !available && process.env.CI !== 'true' }, () => {
  const approvedSites = '["11111111-1111-4111-8111-111111111111"]';
  const requestedCash = {
    ...env,
    PAMOFI_CASH_CUSTOMER_GO: 'true',
    PAMOFI_CASH_APPROVED_SITE_IDS_JSON: approvedSites,
  };
  const base = render(['compose.yaml'], requestedCash);
  const prepaid = base.services['prepaid-access'].environment;
  assert.equal(prepaid.PAMOFI_CASH_CUSTOMER_GO, 'false');
  assert.equal(prepaid.PAMOFI_CASH_APPROVED_SITE_IDS_JSON, '[]');

  const cashFiles = ['compose.yaml', 'cash-sales.compose.yaml'];
  assert.deepEqual(render(cashFiles), base);
  assert.deepEqual(render(cashFiles, {
    ...requestedCash,
    PAMOFI_CASH_CUSTOMER_GO: '',
    PAMOFI_CASH_APPROVED_SITE_IDS_JSON: '',
  }), base);

  const selected = structuredClone(base);
  Object.assign(selected.services['prepaid-access'].environment, {
    PAMOFI_CASH_CUSTOMER_GO: 'true',
    PAMOFI_CASH_APPROVED_SITE_IDS_JSON: approvedSites,
  });
  assert.deepEqual(render(cashFiles, requestedCash), selected);
});
