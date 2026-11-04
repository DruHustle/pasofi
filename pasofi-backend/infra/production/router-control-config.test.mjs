import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { validateRouterControlRows, inspectRouterControl } from './router-control-config.mjs';

function router() {
  const nasId = randomUUID();
  return { nasId, url: 'https://10.77.254.2/rest/', username: 'pamofi-service', password: 'synthetic-private-router-password', caFile: '/run/pamofi/routeros-ca/' + nasId + '.pem' };
}
test('router-control contract requires scoped HTTPS443, existing credential fields and per-NAS trust files', () => {
  const value = router(); assert.deepEqual(validateRouterControlRows([value]), [value]);
  assert.deepEqual(validateRouterControlRows([{ ...value, url: 'https://router.pamofi.test/rest/' }])[0].nasId, value.nasId);
  for (const patch of [
    { nasId: value.nasId.toUpperCase() }, { nasId: 'not-a-nas' }, { extra: true },
    { url: 'http://10.77.254.2/rest/' }, { url: 'https://10.77.254.2:8443/rest/' },
    { url: 'https://10.77.254.2/rest' }, { url: 'https://user:secret@10.77.254.2/rest/' },
    { url: 'https://10.77.254.2/rest/?redirect=other' }, { url: 'https://127.0.0.1/rest/' },
    { url: 'https://8.8.8.8/rest/' }, { url: 'https://[::1]/rest/' },
    { username: 'user:other' }, { username: '' }, { password: {} }, { password: 'line\nbreak' },
    { caFile: '/etc/ssl/cert.pem' }, { caFile: '/run/pamofi/routeros-ca/../key' },
  ]) assert.throws(() => validateRouterControlRows([{ ...value, ...patch }]));
  for (const rows of [[], {}, [value, value], [null]]) assert.throws(() => validateRouterControlRows(rows));
});
test('offline router-control qualification validates private files and real public trust material without leaking credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pamofi-router-control-')), row = router();
  try {
    const ca = join(directory, 'ca'); await mkdir(ca, { mode: 0o755 });
    const cert = join(ca, row.nasId + '.pem'), key = join(directory, 'test-only-key');
    const created = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=Disposable router trust'], { encoding: 'utf8', timeout: 15000 });
    if (created.error) throw created.error; assert.equal(created.status, 0, created.stderr);
    await chmod(cert, 0o444); await writeFile(join(directory, 'routers.json'), JSON.stringify([row]), { mode: 0o444 });
    const env = { PAMOFI_ROUTER_CONTROL_QUALIFIED: 'false', PAMOFI_ROUTER_CONTROL_DIR: directory };
    const prepared = await inspectRouterControl(env);
    assert.equal(prepared.status, 'prepared-only'); assert.equal(prepared.activationRequested, false); assert.equal(prepared.routerCount, 1);
    assert.equal(JSON.stringify(prepared).includes(row.password), false); assert.equal(JSON.stringify(prepared).includes(row.username), false);
    assert.equal((await inspectRouterControl({ ...env, PAMOFI_ROUTER_CONTROL_QUALIFIED: 'true' })).activationRequested, true);
    for (const flag of [undefined, '', 'yes', 'TRUE']) await assert.rejects(inspectRouterControl({ ...env, PAMOFI_ROUTER_CONTROL_QUALIFIED: flag }));
    await chmod(join(directory, 'routers.json'), 0o600); await assert.rejects(inspectRouterControl(env)); await chmod(join(directory, 'routers.json'), 0o444);
    await chmod(ca, 0o777); await assert.rejects(inspectRouterControl(env)); await chmod(ca, 0o755);
    await writeFile(join(ca, 'private-key'), await readFile(key)); await assert.rejects(inspectRouterControl(env)); await rm(join(ca, 'private-key'));
    const saved = await readFile(cert); await chmod(cert, 0o644); await writeFile(cert, await readFile(key)); await chmod(cert, 0o444);
    await assert.rejects(inspectRouterControl(env));
    await rm(cert); await writeFile(join(directory, 'other.pem'), saved, { mode: 0o444 }); await symlink(join(directory, 'other.pem'), cert);
    await assert.rejects(inspectRouterControl(env));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
