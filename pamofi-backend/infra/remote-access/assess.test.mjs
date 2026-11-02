import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assess} from './assess.mjs';
import {buildPlan} from './plan.mjs';

const base = {routerArchitecture: 'smips', routerOsVersion: '7.18.2', alwaysOnSiteDevice: false, ipv4: {routerAddress: null, upstreamAddress: null, portForwarding: 'unknown', udpReachability: 'untested'}, ipv6: {routerAddress: null, routerAvailability: 'unknown', clientConnectivity: 'unknown', udpReachability: 'untested'}};
const scenario = changes => ({...base, ...changes, ipv4: {...base.ipv4, ...changes.ipv4}, ipv6: {...base.ipv6, ...changes.ipv6}});

test('private upstream and shared IPv4 observations do not prove CGNAT or require a server', () => {
  for (const routerAddress of [null, '192.168.0.20', '100.64.1.20']) {
    const assessment = assess(scenario({ipv4: {routerAddress}}));
    assert.equal(assessment.status, 'assessment-only');
    assert.equal(assessment.recommendation, 'inspect-direct-paths-first');
    assert.equal(assessment.directIpv4.status, 'needs-inspection');
    assert.match(assessment.directIpv4.reason, /do not .*prove carrier-grade NAT/);
    assert.match(assessment.evidence, /No router, DNS service or network endpoint was contacted/);
    assert.match(assessment.alternatives.backToHome, /SMIPS hAP lite is unsupported/);
  }
});

test('public IPv4 and forwarded upstream IPv4 are candidates until the operator reports an off-LAN test', () => {
  for (const ipv4 of [
    {routerAddress: '8.8.8.8'},
    {routerAddress: '192.168.0.20', upstreamAddress: '8.8.8.8', portForwarding: 'available'},
  ]) {
    const candidate = assess(scenario({ipv4}));
    assert.equal(candidate.recommendation, 'qualify-direct-ipv4');
    assert.equal(candidate.directIpv4.status, 'candidate');
    const reported = assess(scenario({ipv4: {...ipv4, udpReachability: 'reported-working'}}));
    assert.equal(reported.recommendation, 'direct-ipv4-reported-working');
    assert.match(reported.evidence, /Operator-reported/);
  }
  for (const routerAddress of ['127.0.0.1', '224.0.0.1', '203.0.113.1']) {
    assert.equal(assess(scenario({ipv4: {routerAddress, upstreamAddress: '8.8.8.8', portForwarding: 'available'}})).directIpv4.status, 'needs-inspection');
  }
});

test('usable IPv6 remains a serverless candidate when IPv4 inbound is blocked', () => {
  const assessment = assess(scenario({ipv4: {routerAddress: '100.64.1.20', udpReachability: 'blocked'}, ipv6: {routerAddress: '2a01:4f8:abcd::2', routerAvailability: 'present', clientConnectivity: 'available'}}));
  assert.equal(assessment.directIpv4.status, 'blocked');
  assert.equal(assessment.directIpv6.status, 'candidate');
  assert.equal(assessment.recommendation, 'qualify-direct-ipv6');
  assert.match(assessment.managementOnly, /separate backend\/RADIUS\/payment/);
});

test('IPv6 requires the actual remote client path and prefers a reported-working family over an untested one', () => {
  const untestedClient = assess(scenario({ipv6: {routerAddress: '2a01:4f8:abcd::2', routerAvailability: 'present'}}));
  assert.equal(untestedClient.directIpv6.status, 'needs-inspection');
  const noClient = assess(scenario({ipv6: {routerAddress: '2a01:4f8:abcd::2', routerAvailability: 'present', clientConnectivity: 'unavailable'}}));
  assert.equal(noClient.directIpv6.status, 'blocked');
  const reported = assess(scenario({ipv4: {routerAddress: '8.8.8.8'}, ipv6: {routerAddress: '2a01:4f8:abcd::2', routerAvailability: 'present', clientConnectivity: 'available', udpReachability: 'reported-working'}}));
  assert.equal(reported.recommendation, 'direct-ipv6-reported-working');
});

test('fallback selection distinguishes an existing helper and BTH-capable hardware from SMIPS', () => {
  const blocked = {ipv4: {udpReachability: 'blocked'}, ipv6: {routerAvailability: 'unavailable'}};
  assert.equal(assess(scenario(blocked)).recommendation, 'hub-or-other-external-relay-needed-for-current-paths');
  const local = assess(scenario({...blocked, alwaysOnSiteDevice: true}));
  assert.equal(local.recommendation, 'consider-local-tailscale-subnet-router');
  assert.match(local.alternatives.localTailscaleSubnetRouter, /verify a supported OS/);
  assert.equal(assess(scenario({...blocked, routerArchitecture: 'arm', routerOsVersion: '7.12'})).recommendation, 'consider-back-to-home-managed-relay');
  assert.equal(assess(scenario({...blocked, routerArchitecture: 'arm', routerOsVersion: '7.11.2'})).recommendation, 'hub-or-other-external-relay-needed-for-current-paths');
});

test('assessment rejects impossible readiness, unknown/private fields and unsupported firmware', () => {
  const invalid = [
    {...base, privateKey: 'do-not-provide'}, {...base, alwaysOnSiteDevice: 'false'}, {...base, routerOsVersion: '6.49.18'}, {...base, routerOsVersion: '7.18; commands'},
    scenario({ipv4: {routerAddress: '192.168.0.20', udpReachability: 'reported-working'}}),
    scenario({ipv4: {routerAddress: '192.168.0.20', upstreamAddress: '8.8.8.8', portForwarding: 'unavailable', udpReachability: 'reported-working'}}),
    scenario({ipv4: {routerAddress: '999.1.1.1'}}), scenario({ipv4: {password: 'forbidden'}}),
    scenario({ipv6: {routerAvailability: 'present', routerAddress: 'fe80::1'}}),
    scenario({ipv6: {routerAvailability: 'present', routerAddress: '2001:db8::1'}}),
    scenario({ipv6: {routerAddress: '2a01:4f8:abcd::2'}}),
    scenario({ipv6: {udpReachability: 'reported-working'}}),
  ];
  for (const observation of invalid) assert.throws(() => assess(observation));
});

test('bundled observations stay unknown and plan examples cannot be used without replacing placeholders', async () => {
  const observations = JSON.parse(await readFile(new URL('./observations.example.json', import.meta.url), 'utf8'));
  assert.equal(assess(observations).recommendation, 'inspect-direct-paths-first');
  for (const file of ['public-plan.example.json', 'direct-plan.example.json', 'direct-ipv6-plan.example.json']) {
    const p = JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
    assert.throws(() => buildPlan(p), file);
  }
});

test('assessment CLI reads only public observation input and rejects malformed/private inputs without echoing them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pamofi-assess-'));
  try {
    const script = fileURLToPath(new URL('./assess.mjs', import.meta.url)), input = join(root, 'observations.json');
    await writeFile(input, JSON.stringify(base));
    const good = spawnSync(process.execPath, [script, input], {encoding: 'utf8'});
    assert.equal(good.error, undefined);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).status, 'assessment-only');
    for (const source of ['{"privateKey":"TEST-SECRET",}', JSON.stringify({...base, password: 'TEST-SECRET'})]) {
      await writeFile(input, source);
      const bad = spawnSync(process.execPath, [script, input], {encoding: 'utf8'});
      assert.equal(bad.error, undefined);
      assert.notEqual(bad.status, 0);
      assert.doesNotMatch(`${bad.stdout}${bad.stderr}`, /TEST-SECRET/);
    }
  } finally { await rm(root, {recursive: true, force: true}); }
});
