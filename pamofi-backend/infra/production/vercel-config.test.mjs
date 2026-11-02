import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, lstat, symlink, link, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { splitOrigins, protectedDirectory, protectedFile, inspectVercelConfiguration } from './vercel-config.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const origins = { PAMOFI_PUBLIC_HOST: 'api.pamofi.test', PAMOFI_PUBLIC_ORIGIN: 'https://pamofi.test' };
function cli(file, args, env = process.env) {
  const environment = { ...env };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [join(here, file), ...args], { env: environment, encoding: 'utf8', timeout: 10000 });
  if (result.error) throw result.error;
  return result;
}
async function temporary(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'pamofi-vercel-config-'));
  try { return await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('split deployment requires separate canonical HTTPS DNS origins and rejects injected or ambiguous hosts', () => {
  assert.deepEqual(splitOrigins(origins), { host: 'api.pamofi.test', oracleOrigin: 'https://api.pamofi.test', browserOrigin: 'https://pamofi.test' });
  for (const host of [undefined, '', '127.0.0.1', '127.1', '999.999.999.999', 'localhost', 'api.local', 'api.localhost', 'api.x', 'API.pamofi.test', 'api.pamofi.test.', 'api..test', '-api.test', 'api.pamofi.test:443', 'api.test/evil', 'api.test;return 200', 'api.test\n', 'a'.repeat(64) + '.test']) {
    assert.throws(() => splitOrigins({ ...origins, PAMOFI_PUBLIC_HOST: host }));
  }
  for (const origin of [undefined, '', 'http://pamofi.test', 'https://api.pamofi.test', 'https://pamofi.test/', 'https://pamofi.test:443', 'https://pamofi.test:8443', 'https://user:secret@pamofi.test', 'https://pamofi.test?x=1', 'https://pamofi.test#x', 'https://127.0.0.1', 'https://localhost', 'https://PAMOFI.test', 'https://pamofi.local', 'https://pamofi.localhost', 'https://pamofi.x']) {
    assert.throws(() => splitOrigins({ ...origins, PAMOFI_PUBLIC_ORIGIN: origin }));
  }
});

test('Vercel credential generator is additive, private, silent and refuses any overwrite', async () => temporary(async directory => {
  const secrets = join(directory, 'secrets'); await mkdir(secrets, { mode: 0o700 });
  const existing = randomBytes(16).toString('hex'); await writeFile(join(secrets, 'existing_application_secret'), existing, { mode: 0o444 });
  const first = cli('generate-vercel-secret.mjs', ['--directory', secrets, '--add-vercel-proxy']);
  assert.equal(first.status, 0, first.stderr);
  const token = await readFile(join(secrets, 'vercel_proxy_token'), 'utf8');
  assert.match(token, /^[0-9a-f]{64}\n$/);
  assert.equal((await lstat(join(secrets, 'vercel_proxy_token'))).mode & 0o777, 0o400);
  assert.equal((await lstat(secrets)).mode & 0o777, 0o700);
  assert.equal(first.stdout.includes(token.trim()), false); assert.equal(first.stderr.includes(token.trim()), false);
  assert.equal(await readFile(join(secrets, 'existing_application_secret'), 'utf8'), existing);
  const second = cli('generate-vercel-secret.mjs', ['--directory', secrets, '--add-vercel-proxy']);
  assert.notEqual(second.status, 0);
  assert.equal(await readFile(join(secrets, 'vercel_proxy_token'), 'utf8'), token);
  assert.notEqual(cli('generate-vercel-secret.mjs', ['--directory', secrets, '--add-vercel-proxy', 'unexpected']).status, 0);
}));

test('secret preflight rejects public directories, repository storage, symlinks, hard links and writable files', async () => temporary(async directory => {
  const secrets = join(directory, 'secrets'); await mkdir(secrets, { mode: 0o700 });
  const file = join(secrets, 'value'); await writeFile(file, 'value', { mode: 0o444 });
  assert.equal(await protectedDirectory(secrets), secrets);
  await chmod(secrets, 0o755); await assert.rejects(protectedDirectory(secrets)); await chmod(secrets, 0o700);
  const alias = join(directory, 'alias'); await symlink(secrets, alias); await assert.rejects(protectedDirectory(alias));
  await symlink(file, join(secrets, 'linked')); await assert.rejects(protectedFile(secrets, 'linked'));
  await link(file, join(secrets, 'hardlinked')); await assert.rejects(protectedFile(secrets, 'value')); await unlink(join(secrets, 'hardlinked'));
  await chmod(file, 0o666); await assert.rejects(protectedFile(secrets, 'value')); await chmod(file, 0o444);
  assert.equal(await protectedFile(secrets, 'value'), 'value');
  const inside = await mkdtemp(join(resolve(here, '../../..'), 'pamofi-vercel-private-test-'));
  try { await assert.rejects(protectedDirectory(inside)); } finally { await rm(inside, { recursive: true }); }
}));

test('offline preflight checks token, certificate hostname/key and reports prepared-only without revealing secrets', async () => temporary(async directory => {
  const secrets = join(directory, 'secrets'); await mkdir(secrets, { mode: 0o700 });
  const token = randomBytes(32).toString('hex'); await writeFile(join(secrets, 'vercel_proxy_token'), token + '\n', { mode: 0o400 });
  const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(secrets, 'public_tls_key'), '-out', join(secrets, 'public_tls_cert'), '-days', '1', '-subj', '/CN=api.pamofi.test', '-addext', 'subjectAltName=DNS:api.pamofi.test'], { encoding: 'utf8', timeout: 15000 });
  if (certificate.error) throw certificate.error;
  assert.equal(certificate.status, 0, certificate.stderr);
  await chmod(join(secrets, 'public_tls_key'), 0o444); await chmod(join(secrets, 'public_tls_cert'), 0o444);
  const env = { ...process.env, ...origins, PAMOFI_SECRETS_DIR: secrets };
  const report = await inspectVercelConfiguration(env);
  assert.equal(report.status, 'prepared-only'); assert.equal(report.oracleOrigin, 'https://api.pamofi.test');
  assert.equal(JSON.stringify(report).includes(token), false);
  const run = cli('preflight-vercel.mjs', [], env);
  assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).status, 'prepared-only');
  assert.equal(run.stdout.includes(token), false);
  await chmod(join(secrets, 'vercel_proxy_token'), 0o444);
  await assert.rejects(inspectVercelConfiguration(env));
  await chmod(join(secrets, 'vercel_proxy_token'), 0o400);
  await assert.rejects(inspectVercelConfiguration({ ...env, PAMOFI_PUBLIC_HOST: 'wrong.pamofi.test' }));
  for (const bad of [token.toUpperCase(), token + '\n\n', token + '\r\n', '0'.repeat(63), token + ' ']) {
    await chmod(join(secrets, 'vercel_proxy_token'), 0o600);
    await writeFile(join(secrets, 'vercel_proxy_token'), bad);
    await assert.rejects(inspectVercelConfiguration(env));
  }
}));
