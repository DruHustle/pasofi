import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const suffixes = { identity: 'identity', 'prepaid-access': 'prepaid_access', network: 'network', notification: 'notification', assistant: 'assistant' };
const secrets = ['INTERNAL_IDENTITY_SECRET', 'SESSION_CREATION_SECRET', 'STAFF_MFA_ENCRYPTION_KEY', 'STAFF_RESET_SMTP_PASSWORD', 'INTERNAL_EVENTS_SECRET', 'INTERNAL_NETWORK_SECRET', 'INTERNAL_DELIVERY_SECRET', 'VOUCHER_DELIVERY_KEYS_JSON', 'RADIUS_CREDENTIAL_KEYS', 'SENDAI_API_KEY', 'RESEND_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
async function secretFile(name) {
  const path = process.env[`${name}_FILE`];
  if (!path || process.env[name]) throw Error('Each credential requires only its explicit secret file.');
  const value = (await readFile(path, 'utf8')).replace(/\r?\n$/, '');
  if (!value || value.length > 65536 || value.includes('\0') || /[\r\n]/.test(value)) throw Error('Invalid secret file.');
  return value;
}

async function main() {
  if (process.env.APP_ENV !== 'production' || process.env.NODE_ENV !== 'production') throw Error('Production entrypoint requires explicit production environment.');
  const service = process.env.PAMOFI_SERVICE, suffix = suffixes[service], prefix = process.env.PAMOFI_ROLE_PREFIX || 'pamofi';
  if (!suffix || !/^[a-z][a-z0-9_]{0,24}$/.test(prefix)) throw Error('Explicit valid service and database role prefix required.');
  const action = process.argv[2] || 'serve';
  if (!['serve', 'migrate', 'bootstrap-staff'].includes(action) || (action === 'bootstrap-staff' && service !== 'identity')) throw Error('Invalid service action.');
  const migration = action !== 'serve', owner = `${prefix}_${suffix}_owner`, runtime = `${prefix}_${suffix}_runtime`;
  const url = new URL(await secretFile(migration ? 'MIGRATION_DATABASE_URL' : 'DATABASE_URL'));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.username !== (migration ? `${prefix}_${suffix}_migrate` : runtime) || url.pathname !== `/${prefix}_${suffix}` || url.search || url.hash || !url.password) throw Error('Database secret does not match the required service role and database.');
  process.env.DATABASE_URL = url.toString();
  delete process.env.PGOPTIONS;
  if (migration) process.env.PGOPTIONS = `-c role=${owner} -c search_path=public`;
  for (const name of secrets) if (process.env[`${name}_FILE`]) process.env[name] = await secretFile(name);
  if (!migration) { await import(pathToFileURL(resolve('dist/server.js')).href); return; }
  if (action === 'bootstrap-staff') {
    const { bootstrapMain } = await import(pathToFileURL(resolve('dist/bootstrap-staff.js')).href);
    await bootstrapMain(process.argv.slice(3));
    return;
  }
  await import(pathToFileURL(resolve('migrate.mjs')).href);
  // Use this service's already locked pg dependency; never import another
  // service's code. The migration module has closed its own connection pool.
  const { Pool } = createRequire(resolve('package.json'))('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 });
  pool.on('error', () => console.error('Migration grant connection lost.'));
  try {
    const client = await pool.connect();
    try { const { applyRuntimeGrants } = await import('./apply-grants.mjs'); await applyRuntimeGrants(client, { service, owner, runtime }); }
    finally { client.release(); }
  } finally { await pool.end(); }
  console.log(`Migrations and reviewed runtime grants current for ${service}.`);
}
main().catch(() => { console.error('Production service startup failed; check explicit configuration, secret file access, migrations and runtime grants.'); process.exitCode = 1; });
