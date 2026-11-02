import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('bootstrap refuses missing environment acknowledgment and insecure password files before connecting or printing credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pamofi-bootstrap-guard-'));
  const file = join(directory, 'password'), secret = 'Never print this synthetic bootstrap password';
  try {
    await writeFile(file, `${secret}\n`, { mode: 0o600 });
    const env = { ...process.env, APP_ENV: 'demo', NODE_ENV: 'development', PUBLIC_ORIGIN: 'http://localhost:5173', DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/test_bootstrap', STAFF_MFA_ENCRYPTION_KEY: 'ab'.repeat(32), STAFF_BOOTSTRAP_CONFIRM: '', STAFF_BOOTSTRAP_ENVIRONMENT: 'demo', STAFF_BOOTSTRAP_DATABASE: 'test_bootstrap', STAFF_BOOTSTRAP_ISOLATED: '1' };
    const args = ['dist/bootstrap-staff.js', '--email', 'first@example.test', '--display-name', 'First operator', '--password-file', file, '--reason', 'Explicit isolated setup'];
    let result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Explicit matching/);
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
    env.STAFF_BOOTSTRAP_CONFIRM = 'first-admin';
    await chmod(file, 0o644);
    result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /password file/);
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
    env.STAFF_BOOTSTRAP_DATABASE = 'different_target';
    result = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /explicitly acknowledged/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
