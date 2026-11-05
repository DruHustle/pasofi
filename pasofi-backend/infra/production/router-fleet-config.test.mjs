import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, chmod, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {validateRouterFleetRows, inspectRouterFleet} from './router-fleet-config.mjs';

function router() {
  const nasId = randomUUID();
  return {nasId, url: 'https://10.77.254.2/rest/', username: 'pasofi-fleet', password: 'synthetic-device-password', caFile: '/run/pamofi/router-fleet-ca/' + nasId + '.pem', expectedSerial: 'TEST12345', allowWrites: false, targets: [{key: 'identity', kind: 'identity'}, {key: 'guest', kind: 'wifi', name: 'guest-wifi'}]};
}
test('fleet enrollment requires an explicit device identity and a bounded resource allowlist', () => {
  const value = router(); assert.deepEqual(validateRouterFleetRows([value]), [value]);
  for (const patch of [
    {expectedSerial: ''}, {expectedSerial: 'x\n'}, {allowWrites: 'true'}, {allowWrites: undefined}, {extra: true},
    {caFile: '/etc/ssl/cert.pem'}, {url: 'http://10.77.254.2/rest/'}, {url: 'https://8.8.8.8/rest/'}, {url: 'https://router.test:8443/rest/'},
    {password: 'x\t'}, {targets: []}, {targets: Array(17).fill(value.targets[0])},
    {targets: [{key: 'root', kind: 'firewall', name: '*1'}]}, {targets: [{key: 'root', kind: 'identity', name: 'unexpected'}]},
    {targets: [{key: 'radio', kind: 'wifi', name: ''}]}, {targets: [{key: '../escape', kind: 'identity'}]},
    {targets: [value.targets[1], {...value.targets[1], key: 'different'}]}, {targets: [{...value.targets[1], command: '/system/reboot'}]},
  ]) assert.throws(() => validateRouterFleetRows([{...value, ...patch}]));
  for (const value of [null, [], [null], [router(), router(), null]]) assert.throws(() => validateRouterFleetRows(value));
  assert.throws(() => validateRouterFleetRows([value, value]));
  const other = router();
  assert.throws(() => validateRouterFleetRows([value, {...other, url: 'https://another.router.test/rest/'}]));
  assert.throws(() => validateRouterFleetRows([value, {...other, expectedSerial: value.expectedSerial.toLowerCase(), url: 'https://another.router.test/rest/'}]));
  assert.throws(() => validateRouterFleetRows([value, {...other, expectedSerial: 'ANOTHER_SERIAL'}]));
  assert.equal(validateRouterFleetRows([value, {...other, expectedSerial: 'ANOTHER_SERIAL', url: 'https://10.77.254.3/rest/'}]).length, 2);
});

test('fleet preflight validates protected files and explicit independent gates without emitting secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pasofi-router-fleet-')), row = router();
  try {
    const ca = join(directory, 'ca'); await mkdir(ca, {mode: 0o755});
    const cert = join(ca, row.nasId + '.pem'), key = join(directory, 'private-test-key');
    const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=Disposable fleet trust'], {encoding: 'utf8', timeout: 15000});
    if (result.error) throw result.error; assert.equal(result.status, 0, result.stderr);
    await chmod(cert, 0o444); const registry = join(directory, 'routers.json'); await writeFile(registry, JSON.stringify([row]), {mode: 0o444});
    const env = {PAMOFI_ROUTER_FLEET_DIR: directory, PAMOFI_ROUTER_FLEET_ENABLED: 'true', PAMOFI_ROUTER_FLEET_WRITE_ENABLED: 'false'};
    const outcome = await inspectRouterFleet(env); assert.equal(outcome.routerCount, 1); assert.equal(outcome.writableRouterCount, 0); assert.equal(outcome.readsRequested, true); assert.equal(outcome.writesRequested, false);
    for (const secret of [row.password, row.username, row.expectedSerial, row.url]) assert.equal(JSON.stringify(outcome).includes(secret), false);
    for (const patch of [{PAMOFI_ROUTER_FLEET_WRITE_ENABLED: 'yes'}, {PAMOFI_ROUTER_FLEET_ENABLED: undefined}, {PAMOFI_ROUTER_FLEET_ENABLED: 'false', PAMOFI_ROUTER_FLEET_WRITE_ENABLED: 'true'}]) await assert.rejects(inspectRouterFleet({...env, ...patch}));
    await chmod(registry, 0o600); await assert.rejects(inspectRouterFleet(env)); await chmod(registry, 0o444);
    await writeFile(join(ca, 'unexpected'), 'private'); await assert.rejects(inspectRouterFleet(env)); await rm(join(ca, 'unexpected'));
    await rm(cert); await symlink(key, cert); await assert.rejects(inspectRouterFleet(env));
  } finally { await rm(directory, {recursive: true, force: true}); }
});
