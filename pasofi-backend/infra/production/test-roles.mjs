// Disposable PostgreSQL qualification. Requires psql, built independent services,
// and an explicitly acknowledged loopback test cluster with CREATE ROLE/DATABASE.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID, createHmac } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

const here = fileURLToPath(new URL('.', import.meta.url)), backend = resolve(here, '../..');
const services = [['identity', 'identity'], ['prepaid-access', 'prepaid_access'], ['network', 'network'], ['notification', 'notification'], ['assistant', 'assistant']];
const prefix = `pft_${randomBytes(6).toString('hex')}`, owned = [], psql = process.env.PSQL_BIN || 'psql';
let directory, child, checks = 0, interrupted = false, cleaning = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
});
const active = () => { if (interrupted && !cleaning) throw Error('Role qualification interrupted; cleaning owned resources.'); };
const quote = value => { assert.match(value, /^[a-z][a-z0-9_]+$/); return `"${value}"`; };
function connectionEnvironment(url, database = decodeURIComponent(url.pathname.slice(1)), username = decodeURIComponent(url.username), password = decodeURIComponent(url.password)) {
  const env = { ...process.env, PGHOST: url.hostname.replace(/^\[|\]$/g, ''), PGPORT: url.port, PGUSER: username, PGPASSWORD: password, PGDATABASE: database, PGCONNECT_TIMEOUT: '3' };
  delete env.PGOPTIONS; delete env.PGSERVICE; delete env.PGSERVICEFILE; delete env.PASSFILE; delete env.PGPASSFILE;
  return env;
}
function query(env, sql, denied = false) {
  active();
  const result = spawnSync(psql, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { env, input: sql, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
  if (denied) { assert.notEqual(result.status, 0, 'A forbidden runtime operation unexpectedly succeeded.'); assert.match(result.stderr, /permission denied|must be owner|not permitted/, 'Expected an authorization denial.'); }
  else if (result.status !== 0) throw Error(`Role qualification SQL failed: ${result.error?.code || result.stderr.slice(0, 500)}`);
  checks++;
  return result.stdout.trim();
}
async function file(name, value) { const path = join(directory, name); await writeFile(path, `${value}\n`, { flag: 'wx', mode: 0o600 }); return path; }
async function freePort() {
  const server = createServer(); await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', bytes = []; let buffer = 0, bits = 0;
  for (const letter of secret) { buffer = (buffer << 5) | alphabet.indexOf(letter); bits += 5; if (bits >= 8) { bits -= 8; bytes.push((buffer >> bits) & 255); } }
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hash = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(), offset = hash[19] & 15;
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
async function stopChild() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); resolve(); }, 12000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

async function main() {
  if (process.env.PAMOFI_TEST_CONFIRM_ISOLATED !== '1') throw Error('PAMOFI_TEST_CONFIRM_ISOLATED=1 is mandatory.');
  const admin = new URL(process.env.PAMOFI_TEST_BOOTSTRAP_DATABASE_URL || '');
  if (!['postgres:', 'postgresql:'].includes(admin.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(admin.hostname) || !admin.port || !admin.username || admin.search || admin.hash || admin.pathname !== '/postgres') throw Error('An explicit loopback bootstrap URL for the isolated postgres database is required.');
  const adminEnv = connectionEnvironment(admin);
  directory = await mkdtemp(join(tmpdir(), 'pamofi-role-qualification-'));
  try {
    for (const [service, suffix] of services) {
      active();
      const database = `${prefix}_${suffix}`, owner = `${database}_owner`, migrator = `${database}_migrate`, runtime = `${database}_runtime`;
      const migrationPassword = randomBytes(32).toString('hex'), runtimePassword = randomBytes(32).toString('hex');
      assert.equal(query(adminEnv, `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname='${database}') OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('${owner}','${migrator}','${runtime}'))`), 'f');
      const env = { ...adminEnv, PAMOFI_ROLE_DATABASE: database, PAMOFI_ROLE_OWNER: owner, PAMOFI_ROLE_MIGRATOR: migrator, PAMOFI_ROLE_RUNTIME: runtime, PAMOFI_ROLE_MIGRATION_PASSWORD: migrationPassword, PAMOFI_ROLE_RUNTIME_PASSWORD: runtimePassword };
      // All names were absent and use an unguessable per-run prefix. Record the
      // intended resources before executing the multi-statement init script.
      owned.push({ service, database, owner, migrator, runtime, migrationPassword, runtimePassword });
      const initialized = spawnSync(psql, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--file', join(here, 'roles.sql')], { env, encoding: 'utf8', timeout: 30000 });
      if (initialized.status !== 0) throw Error(`Role initialization failed for ${service}: ${initialized.stderr.slice(0, 500)}`);
      const migrationUrl = new URL(admin); migrationUrl.username = migrator; migrationUrl.password = migrationPassword; migrationUrl.pathname = `/${database}`;
      const runtimeUrl = new URL(admin); runtimeUrl.username = runtime; runtimeUrl.password = runtimePassword; runtimeUrl.pathname = `/${database}`;
      const migrationFile = await file(`${service}-migration`, migrationUrl.toString()), runtimeFile = await file(`${service}-runtime`, runtimeUrl.toString());
      Object.assign(owned.at(-1), { runtimeFile, runtimeUrl });
      const migrationEnv = { ...process.env, APP_ENV: 'production', NODE_ENV: 'production', PAMOFI_SERVICE: service, PAMOFI_ROLE_PREFIX: prefix, MIGRATION_DATABASE_URL_FILE: migrationFile };
      delete migrationEnv.DATABASE_URL; delete migrationEnv.MIGRATION_DATABASE_URL;
      const migrated = spawnSync(process.execPath, [join(here, 'entrypoint.mjs'), 'migrate'], { cwd: join(backend, `services/${service}-service`), env: migrationEnv, encoding: 'utf8', timeout: 60000 });
      if (migrated.status !== 0) throw Error(`Migration/grant qualification failed for ${service}: ${migrated.stdout.slice(-1000)} ${migrated.stderr.slice(-500)}`);
      const runtimeEnv = connectionEnvironment(admin, database, runtime, runtimePassword);
      const migrationLoginEnv = connectionEnvironment(admin, database, migrator, migrationPassword);
      const ownerEnv = { ...migrationLoginEnv, PGOPTIONS: `-c role=${owner}` };
      assert.equal(query(ownerEnv, 'SELECT current_user'), owner);
      assert.equal(query(runtimeEnv, 'SELECT current_user'), runtime);
      assert.ok(Number(query(runtimeEnv, 'SELECT count(*) FROM schema_migrations')) > 0);
      query(migrationLoginEnv, 'CREATE TABLE public.migrator_must_set_role(id integer)', true);
      query(runtimeEnv, `SET ROLE ${quote(owner)}`, true);
      query(runtimeEnv, 'CREATE TABLE public.forbidden_table(id integer)', true);
      query(runtimeEnv, 'CREATE SCHEMA forbidden_schema', true);
      query(runtimeEnv, 'CREATE TEMP TABLE forbidden_temp(id integer)', true);
      query(runtimeEnv, "INSERT INTO schema_migrations(name,checksum) VALUES('fake','fake')", true);
      query(ownerEnv, "CREATE TABLE public.role_probe(id serial PRIMARY KEY, value text NOT NULL); CREATE FUNCTION public.role_probe_function() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'");
      query(runtimeEnv, 'SELECT * FROM public.role_probe', true);
      query(runtimeEnv, 'SELECT public.role_probe_function()', true);
      query(runtimeEnv, "SELECT nextval('public.role_probe_id_seq')", true);
      query(ownerEnv, `GRANT SELECT,INSERT,UPDATE ON public.role_probe TO ${quote(runtime)}; GRANT USAGE,SELECT ON public.role_probe_id_seq TO ${quote(runtime)}`);
      assert.equal(query(runtimeEnv, "INSERT INTO public.role_probe(value) VALUES('owned runtime') RETURNING id"), '1');
      assert.equal(query(runtimeEnv, "UPDATE public.role_probe SET value='updated' WHERE id=1 RETURNING value"), 'updated');
      query(runtimeEnv, 'DELETE FROM public.role_probe', true);
      query(runtimeEnv, 'TRUNCATE public.role_probe', true);
      query(runtimeEnv, 'ALTER TABLE public.role_probe ADD COLUMN forbidden integer', true);
      query(runtimeEnv, 'DROP TABLE public.role_probe', true);
      query(ownerEnv, 'DROP TABLE public.role_probe; DROP FUNCTION public.role_probe_function()');
      if (service === 'identity') {
        query(runtimeEnv, `INSERT INTO staff_bootstrap_guard(singleton,staff_id) VALUES(true,'${randomUUID()}')`, true);
        const auditId = randomUUID();
        query(runtimeEnv, `INSERT INTO staff_audit_events(id,target_staff_id,action,reason,new_version,after_state) VALUES('${auditId}','${randomUUID()}','bootstrap','Synthetic privilege proof',1,'{}')`);
        query(runtimeEnv, `UPDATE staff_audit_events SET reason='Modified audit' WHERE id='${auditId}'`, true);
        query(runtimeEnv, `DELETE FROM staff_audit_events WHERE id='${auditId}'`, true);
      }
      if (service === 'prepaid-access') {
        query(runtimeEnv, "UPDATE cash_refund_events SET payload='{}'", true);
        query(runtimeEnv, 'DELETE FROM cash_refund_events', true);
        query(runtimeEnv, 'DELETE FROM cash_refunds', true);
        query(runtimeEnv, 'DELETE FROM cash_shifts', true);
        query(runtimeEnv, "UPDATE paid_invoices SET number='forbidden'", true);
        query(runtimeEnv, 'DELETE FROM paid_invoices', true);
        query(runtimeEnv, 'DELETE FROM invoice_delivery_intents', true);
        query(runtimeEnv, 'DELETE FROM invoice_deliveries', true);
        assert.match(query(runtimeEnv, "SELECT nextval('paid_invoice_number_seq')"), /^[0-9]+$/);
        query(runtimeEnv, "SELECT setval('paid_invoice_number_seq',1)", true);
      }
      if (service === 'network') {
        const nas = randomUUID(), site = randomUUID();
        query(ownerEnv, `INSERT INTO radius_nas(id,site_id,client_name,site_name,login_url,enabled) VALUES('${nas}','${site}','role_proof','Role proof','https://router.example.test/login',false)`);
        query(runtimeEnv, `INSERT INTO radius_nas(id,site_id,client_name) VALUES('${randomUUID()}','${site}','forbidden_nas')`, true);
        for (const assignment of ["enabled=true", `site_id='${randomUUID()}'`, "client_name='forbidden_name'", "site_name='Forbidden name'", "login_url='https://other.example.test/login'"]) {
          query(runtimeEnv, 'UPDATE radius_nas SET ' + assignment + " WHERE id='" + nas + "'", true);
        }
        query(runtimeEnv, "DELETE FROM radius_nas WHERE id='" + nas + "'", true);
        // Both actual credential paths lock the NAS row. PostgreSQL permits
        // these locks with an UPDATE privilege on only its primary key.
        assert.equal(query(runtimeEnv, "BEGIN; SELECT id FROM radius_nas WHERE id='" + nas + "' FOR SHARE; SELECT id FROM radius_nas WHERE id='" + nas + "' FOR UPDATE; ROLLBACK"), nas + '\n' + nas);
        query(ownerEnv, "UPDATE radius_nas SET enabled=true WHERE id='" + nas + "'");
        const credential = spawnSync(process.execPath, ['--input-type=module'], {
          cwd: join(backend, 'services/network-service'), env: { ...runtimeEnv, DATABASE_URL: runtimeUrl.toString(), PAMOFI_ROLE_PROOF_NAS: nas },
          encoding: 'utf8', timeout: 20000,
          input: `
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { issueRadiusCredential } from './dist/credentials.js';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
try {
  const input = { customerId: randomUUID(), nasId: process.env.PAMOFI_ROLE_PROOF_NAS, requestKey: randomUUID() };
  const key = { version: 1, key: randomBytes(32) };
  const first = await issueRadiusCredential(pool, input, key);
  const retry = await issueRadiusCredential(pool, input, key);
  assert.equal(retry.username, first.username);
  assert.equal(retry.password, first.password);
  console.log('Runtime credential issue and locked retry passed.');
} finally { await pool.end(); }
`,
        });
        if (credential.error || credential.status !== 0) throw Error('Network runtime credential qualification failed: ' + (credential.error?.code || credential.stderr.slice(-600)));
        assert.match(credential.stdout, /Runtime credential issue and locked retry passed/); checks++;
      }
    }
    for (const source of owned) for (const target of owned) if (source !== target) query(connectionEnvironment(admin, target.database, source.runtime, source.runtimePassword), 'SELECT 1', true);
    // Exercise real identity transactions using the production entrypoint and
    // runtime grant set, not just a table-level has_privilege assertion.
    const identity = owned.find(item => item.service === 'identity'), port = await freePort();
    const environment = { ...process.env, APP_ENV: 'production', NODE_ENV: 'production', PAMOFI_SERVICE: 'identity', PAMOFI_ROLE_PREFIX: prefix, DATABASE_URL_FILE: identity.runtimeFile, HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: 'https://role-proof.example.test' };
    delete environment.DATABASE_URL; delete environment.PAMOFI_TRUST_PROXY_CIDRS;
    for (const key of ['INTERNAL_IDENTITY_SECRET', 'SESSION_CREATION_SECRET', 'STAFF_MFA_ENCRYPTION_KEY']) { delete environment[key]; environment[`${key}_FILE`] = await file(key, randomBytes(32).toString('hex')); }
    child = spawn(process.execPath, [join(here, 'entrypoint.mjs'), 'serve'], { cwd: join(backend, 'services/identity-service'), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume(); child.stderr.resume();
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      active();
      if (child.exitCode !== null || child.signalCode !== null) throw Error('Runtime identity exited before readiness.');
      try { if ((await fetch(`${base}/health/ready`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true);
    const request = (path, payload, cookie, extras = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { origin: environment.PUBLIC_ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extras }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
    const retryKey = randomBytes(32).toString('base64url');
    let response = await request('/v1/session', {}, null, { 'idempotency-key': retryKey });
    assert.equal(response.status, 201); const customerId = (await response.json()).customerId;
    response = await request('/v1/session', {}, null, { 'idempotency-key': retryKey });
    assert.equal(response.status, 200); assert.equal((await response.json()).customerId, customerId);
    const email = `${randomUUID()}@runtime.invalid`, password = randomBytes(24).toString('base64url');
    assert.equal((await request('/v1/staff/register', { email, password, displayName: 'Runtime proof' })).status, 202);
    response = await request('/v1/staff/login', { email, password }); assert.equal(response.status, 200);
    const challenge = response.headers.getSetCookie().find(value => value.startsWith('__Host-pamofi_staff_challenge=')).split(';')[0];
    response = await request('/v1/staff/mfa/setup', {}, challenge); assert.equal(response.status, 200); const setup = await response.json();
    response = await request('/v1/staff/mfa/confirm', { code: totp(setup.secret) }, challenge); assert.equal(response.status, 200); assert.equal((await response.json()).status, 'pending');
    checks += 7;
    active();
    console.log(`Production role qualification passed ${checks} checks across five independently migrated databases, including real customer retry and staff MFA transactions.`);
  } finally {
    cleaning = true;
    await stopChild();
    for (const resource of [...owned].reverse()) {
      query(adminEnv, `DROP DATABASE IF EXISTS ${quote(resource.database)} WITH (FORCE)`);
      for (const role of [resource.runtime, resource.migrator, resource.owner]) query(adminEnv, `DROP ROLE IF EXISTS ${quote(role)}`);
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Role qualification failed.'); process.exitCode = 1; });
