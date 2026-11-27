// Exercise the incoming-credit boundary with synthetic data in a disposable local database.
// Read the fixture from stdin to keep voucher, phone and account details off the command line.
import pg from 'pg';
import { ingestEcoCashMerchantCredit } from '../../dist/ecocash-credits.js';
import { loadDeliveryKeys } from '../../dist/delivery-crypto.js';
import { syntheticMerchantEnvelopes } from './ecocash-merchant-envelope.mjs';

async function main() {
  if (process.env.APP_ENV !== 'demo' || process.env.NODE_ENV !== 'development' ||
      process.env.PAMOFI_TEST_CONFIRM_ISOLATED !== '1') {
    throw Error('isolated_demo_required');
  }
  const url = new URL(process.env.PAMOFI_TEST_PREPAID_DATABASE_URL ?? '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.port || !url.username || !/^\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.search || url.hash) {
    throw Error('loopback_test_database_required');
  }
  const keys = loadDeliveryKeys();
  if (!keys) throw Error('demo_delivery_key_required');
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 65_536) throw Error('fixture_too_large');
    chunks.push(chunk);
  }
  const { config, observation } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const pool = new pg.Pool({ connectionString: url.href, max: 1, connectionTimeoutMillis: 3000 });
  try {
    const { sign, verifier } = syntheticMerchantEnvelopes();
    process.env.PAMOFI_ECOCASH_MERCHANT_CREDITS_ENABLED = 'true';
    const { creditId, state, reason } = await ingestEcoCashMerchantCredit(pool, keys, config, sign(observation), verifier);
    console.log(JSON.stringify({ simulation: true, creditId, state, reason }));
  } finally {
    await pool.end();
  }
}
main().catch(() => {
  console.error('EcoCash simulation refused. Check the isolated demo settings and fixture format.');
  process.exitCode = 1;
});
