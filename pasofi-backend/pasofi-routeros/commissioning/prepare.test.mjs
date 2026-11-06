import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPackage, missingInputs, validatePlan } from './prepare.mjs';
import { validateBaseline } from './baseline.mjs';
import { buildCollector } from './collect.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, 'prepare.mjs');
const digest = value => createHash('sha256').update(value).digest('hex');
const baselineFile = join(here, 'baseline.example.json');
const baselineExample = JSON.parse(await readFile(baselineFile, 'utf8'));
const baseline = () => structuredClone(baselineExample);

// Synthetic unit-test values only. No endpoint is contacted, keys generated or
// fixture output presented as a real router plan or an allocated production ID.
function fixture() {
  return {
    schemaVersion: 1,
    site: { siteId: '6fd8315b-2147-4daa-b7c0-ad717d79f2d2', nasId: '912b2dea-d750-4fd7-b6f4-08d0e70a16af', clientName: 'g1_fixture', displayName: 'Fixture site' },
    customer: { bridge: 'pfi-g1-guest', interfaces: ['pfi-g1-wifi', 'ether4'], network: '10.203.10.0/24', gateway: '10.203.10.1', poolStart: '10.203.10.10', poolEnd: '10.203.10.200', dhcpServer: 'pfi-g1-dhcp', ipv6Policy: 'disabled-on-customer-path' },
    serviceLink: {
      serverEndpoint: 'wg.fixture.example.com', port: 52829,
      serverPublicKey: Buffer.alloc(32, 1).toString('base64'), routerPublicKey: Buffer.alloc(32, 2).toString('base64'),
      serverTunnelIp: '10.203.255.1', routerTunnelIp: '10.203.255.2', serverInterface: 'pfi-g1-fixture',
      routerInterface: 'pasofi-service', routerListenPort: 52829,
      routerNetworks: [...baselineExample.requiredRouterNetworks], serverNetworks: ['172.20.0.0/16'],
    },
    hotspot: {
      name: 'pfi-g1-hotspot', profile: 'pfi-g1-https', origin: 'https://g1.fixture.example.com', appOrigin: 'https://app.fixture.example.com',
      certificateName: 'g1-hotspot-fixture', certificateSha256: digest('synthetic hotspot certificate'), sourceDirectory: 'hotspot', targetDirectory: 'pasofi-g1-welcome',
    },
    routerControl: { url: 'https://10.203.255.2/rest/', username: 'g1-reconciler', certificateName: 'g1-rest-fixture', certificateSha256: digest('synthetic private REST certificate') },
  };
}

test('actual template keeps unknown facts empty and cannot emit a commissioning package', async () => {
  const template = JSON.parse(await readFile(join(here, 'plan.template.json'), 'utf8'));
  const missing = missingInputs(template);
  for (const field of ['site.siteId', 'site.nasId', 'customer.bridge', 'serviceLink.routerPublicKey', 'serviceLink.serverTunnelIp', 'hotspot.certificateSha256', 'routerControl.url']) assert.ok(missing.includes(field));
  assert.equal(template.site.displayName, null);
  assert.equal(template.serviceLink.routerNetworks, null);
  await assert.rejects(buildPackage(baseline(), template), /Required commissioning inputs/);
  const result = spawnSync(process.execPath, [script, baselineFile, join(here, 'plan.template.json'), '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).status, 'needs-input');
  assert.equal(result.stderr, '');
});

test('complete input emits only read-only router scripts and disabled incremental NAS registration', async () => {
  const input = fixture(), files = await buildPackage(baseline(), input), report = JSON.parse(files['review.json']);
  assert.equal(report.status, 'prepared-only');
  assert.equal(report.customerServiceQualified, false);
  assert.equal(report.liveChangesPerformed, false);
  assert.ok(Object.values(report.gates).every(value => value === 'pending-live-evidence'));
  for (const [filename, content] of Object.entries(files)) {
    if (filename !== 'review.json') assert.equal(report.sha256[filename], digest(content));
    if (filename.endsWith('.rsc')) {
      assert.match(content, /serial-number\] != "TESTSERIAL0001"/);
      assert.doesNotMatch(content, /\/(?:[^\n\[\]]*?)[ \t](?:add|set|remove|enable|disable|reset|reboot|fetch|import|export|copy|update)(?:[ \t\r\n\]]|$)/);
      assert.doesNotMatch(content, /private-key|\/radius print|\/ip hotspot user |secret=|lease-script|use-doh-server|\/ip dns print|\/ip dhcp-client print/);
    }
  }
  assert.match(files['check-disabled-staging.rsc'], /radius-interim-update\] != 1m/);
  assert.match(files['check-disabled-staging.rsc'], /Expected separate disabled customer bridge/);
  assert.match(files['check-disabled-staging.rsc'], /RADIUS must remain disabled/);
  assert.match(files['nas-registration.sql.review'], /INSERT INTO radius_nas/);
  assert.match(files['nas-registration.sql.review'], /,false\);/);
  assert.doesNotMatch(files['nas-registration.sql.review'], /\b(?:UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/);
  assert.equal(JSON.parse(files['nas-enrollment.json']).replaceExistingAuthority, false);
  assert.equal(JSON.parse(files['welcome-site.json']).hotspotOrigin, input.hotspot.origin);
  assert.equal(JSON.parse(files['site-link.public.json']).routerInterface, 'pasofi-service');
});

test('guards are derived from a validated private baseline without fixed live inventory', async () => {
  const changed = baseline();
  changed.router.serial = 'ANOTHERFIXTURE2';
  changed.router.identity = 'Router.Fixture-2';
  const files = await buildPackage(changed, fixture());
  assert.match(files['check-disabled-staging.rsc'], /serial-number\] != "ANOTHERFIXTURE2"/);
  assert.doesNotMatch(files['check-disabled-staging.rsc'], /TESTSERIAL0001/);
  assert.match(files['collect-readiness.rsc'], /serial-number\] != "ANOTHERFIXTURE2"/);
  for (const change of [
    b => { b.router.serial = 'bad"; /system reboot'; },
    b => { b.router.managementAddress = '192.168.40.0/24'; },
    b => { b.router.wanPort = b.router.recoveryPort; },
    b => { b.requiredRouterNetworks = ['192.168.30.0/24']; },
    b => { b.router.password = 'do-not-output'; },
  ]) {
    const value = baseline(); change(value);
    assert.throws(() => validateBaseline(value));
    assert.throws(() => buildCollector(value));
  }
});

test('rejects protected paths, site reuse and RouterOS input injection', async () => {
  const changes = [
    p => { p.site.siteId = baselineExample.protectedSiteIds[0]; },
    p => { p.site.nasId = '00000000-0000-0000-0000-000000000000'; },
    p => { p.customer.bridge = baselineExample.router.managementBridge; },
    ...[baselineExample.router.wanPort, baselineExample.router.cpeTransitPort, baselineExample.router.recoveryPort, 'pasofi-service'].map(iface => p => { p.customer.interfaces = [iface]; }),
    p => { p.customer.interfaces = ['ether4', 'ether4']; },
    p => { p.customer.bridge = 'guest"; /system reboot'; },
    p => { p.hotspot.certificateName = 'cert\n/system reboot'; },
    p => { p.hotspot.certificateSha256 = 'a'.repeat(64); },
    p => { p.hotspot.targetDirectory = '../escape'; },
    p => { p.hotspot.targetDirectory = 'hotspot/nested'; },
    p => { p.customer.ipv6Policy = 'unrestricted'; },
  ];
  for (const change of changes) {
    const plan = fixture(); change(plan);
    await assert.rejects(buildPackage(baseline(), plan));
  }
});

test('rejects overlapping or invalid customer/service addressing and incomplete route inventories', async () => {
  const changes = [
    p => { p.serviceLink.routerNetworks = ['192.168.30.0/24']; },
    p => { p.serviceLink.serverNetworks = []; },
    p => { p.serviceLink.routerTunnelIp = '192.168.40.22'; },
    p => { p.serviceLink.serverNetworks.push('10.203.0.0/16'); },
    p => { p.customer.network = '192.168.40.0/24'; },
    p => { p.customer.network = '8.8.8.0/24'; },
    p => { p.customer.gateway = '10.203.10.50'; },
    p => { p.customer.poolStart = '10.203.10.201'; },
    p => { p.customer.poolEnd = '10.203.10.255'; },
    p => { p.customer.network = '10.203.255.0/24'; p.customer.gateway = '10.203.255.1'; p.customer.poolStart = '10.203.255.10'; p.customer.poolEnd = '10.203.255.200'; },
  ];
  for (const change of changes) {
    const plan = fixture(); change(plan);
    await assert.rejects(validatePlan(baseline(), plan));
  }
});

test('rejects credentials/unknown fields and noncanonical or wrong-host login/control URLs without echoing values', async () => {
  const credential = 'sensitive-test-value-never-print';
  const changes = [
    p => { p.password = credential; },
    p => { p.serviceLink.privateKey = credential; },
    p => { p.routerControl.password = credential; },
    p => { p.hotspot.origin = 'http://g1.fixture.example.com'; },
    p => { p.hotspot.origin = 'https://g1.fixture.example.com/login'; },
    p => { p.hotspot.origin = p.hotspot.appOrigin; },
    p => { p.routerControl.url = 'https://8.8.8.8/rest/'; },
    p => { p.routerControl.url = 'https://10.203.255.3/rest/'; },
    p => { p.routerControl.url = `https://user:${credential}@10.203.255.2/rest/`; },
    p => { p.routerControl.url = 'https://10.203.255.2/rest/?query=1'; },
  ];
  for (const change of changes) {
    const plan = fixture(); change(plan);
    await assert.rejects(validatePlan(baseline(), plan), error => { assert.ok(!error.message.includes(credential)); return true; });
  }
});

test('CLI writes private files, refuses existing/symlink/repository targets and never overwrites', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pasofi-g1-commissioning-'));
  try {
    const source = join(dir, 'plan.json'), target = join(dir, 'review');
    await writeFile(source, JSON.stringify(fixture()), { mode: 0o600 });
    const run = destination => spawnSync(process.execPath, [script, baselineFile, source, destination], { encoding: 'utf8' });
    const first = run(target);
    assert.equal(first.status, 0, first.stderr);
    assert.equal((await stat(target)).mode & 0o777, 0o700);
    for (const file of await readdir(target)) assert.equal((await stat(join(target, file))).mode & 0o777, 0o600);
    const before = await readFile(join(target, 'review.json'), 'utf8');
    assert.notEqual(run(target).status, 0);
    assert.equal(await readFile(join(target, 'review.json'), 'utf8'), before);
    const alias = join(dir, 'alias'); await symlink(target, alias);
    assert.notEqual(run(alias).status, 0);
    assert.equal(await readFile(join(target, 'review.json'), 'utf8'), before);
    const repository = resolve(here, '../../..'), repoAlias = join(dir, 'repository'); await symlink(repository, repoAlias);
    assert.notEqual(run(join(repoAlias, 'refused-g1-output')).status, 0);
    assert.notEqual(run('relative-output').status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('invalid/missing input never creates a partial bundle or prints input JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pasofi-g1-incomplete-'));
  try {
    const target = join(dir, 'must-not-exist');
    const incomplete = spawnSync(process.execPath, [script, baselineFile, join(here, 'plan.template.json'), target], { encoding: 'utf8' });
    assert.notEqual(incomplete.status, 0);
    await assert.rejects(stat(target), { code: 'ENOENT' });
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{"password":"sensitive-malformed-json",');
    const malformed = spawnSync(process.execPath, [script, baselineFile, bad, '--check'], { encoding: 'utf8' });
    assert.notEqual(malformed.status, 0);
    assert.equal(malformed.stderr.trim(), 'Invalid commissioning JSON');
    assert.equal(malformed.stdout, '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('collector can be prepared before missing service facts, with private no-overwrite output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pasofi-collector-'));
  try {
    const target = join(dir, 'collect.rsc');
    const run = destination => spawnSync(process.execPath, [script, baselineFile, '--collect', destination], { encoding: 'utf8' });
    assert.equal(run(target).status, 0);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    const before = await readFile(target, 'utf8');
    assert.match(before, /serial-number\] != "TESTSERIAL0001"/);
    assert.notEqual(run(target).status, 0);
    assert.equal(await readFile(target, 'utf8'), before);
    assert.notEqual(run(join(dir, 'unsafe.auto.rsc')).status, 0);
    await assert.rejects(stat(join(dir, 'unsafe.auto.rsc')), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
