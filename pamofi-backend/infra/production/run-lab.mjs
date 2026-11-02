#!/usr/bin/env node
// Disposable Docker qualification of the real production configuration. Only
// generated local credentials/certificates are used; no provider is contacted.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, copyFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url)), backend = resolve(here, '../..'), repository = resolve(backend, '..');
const id = randomBytes(8).toString('hex'), project = `pamofi-production-lab-${id}`, volume = `${project}-database`;
const backupContainer = `${project}-backup-config`;
const serviceNames = ['identity', 'prepaid-access', 'network', 'notification', 'assistant'];
const ownedProcesses = new Set(), images = [];
const dockerEnvironment = { ...process.env, COMPOSE_DISABLE_ENV_FILE: '1' };
for (const name of ['COMPOSE_FILE', 'COMPOSE_PROFILES', 'COMPOSE_PROJECT_NAME', 'COMPOSE_ENV_FILES']) delete dockerEnvironment[name];
let directory, rendered, volumeCreated = false, stopped = false, cleaning = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; for (const process of ownedProcesses) process.kill('SIGTERM'); });
const active = () => { if (stopped && !cleaning) throw Error('Production lab interrupted.'); };
async function run(command, args, { env = process.env, input, timeout = 60000, failureAllowed = false, cwd = here } = {}) {
  active();
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  ownedProcesses.add(child);
  let stdout = '', stderr = '', error;
  child.stdout.on('data', part => { stdout = (stdout + part).slice(-3_000_000); });
  child.stderr.on('data', part => { stderr = (stderr + part).slice(-3_000_000); });
  child.on('error', value => { error = value; });
  child.stdin.on('error', () => {}); child.stdin.end(input);
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  const status = await new Promise(resolve => child.once('close', code => resolve(code)));
  clearTimeout(timer); ownedProcesses.delete(child);
  if (!failureAllowed && (error || status !== 0)) throw Error(`${command} qualification command failed (${error?.code || status}): ${stderr.slice(-1800)} ${stdout.slice(-1000)}`);
  return { status, stdout, stderr };
}
async function docker(args, options) { return run('docker', args, { env: dockerEnvironment, ...options }); }
async function compose(args, options) { return docker(['compose', '-p', project, '-f', rendered, ...args], options); }
function ipRange(cidr) {
  const [ip, rawBits] = cidr.split('/'), bits = Number(rawBits);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip) || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const parts = ip.split('.').map(Number); if (parts.some(value => value > 255)) return null;
  const value = parts.reduce((sum, part) => sum * 256 + part, 0), size = 2 ** (32 - bits), start = Math.floor(value / size) * size;
  return [start, start + size - 1];
}
async function unusedSubnet() {
  const ids = (await docker(['network', 'ls', '-q'])).stdout.trim().split(/\s+/).filter(Boolean);
  const networks = ids.length ? JSON.parse((await docker(['network', 'inspect', ...ids])).stdout) : [];
  const used = networks.flatMap(network => (network.IPAM?.Config || []).map(item => ipRange(item.Subnet || '')).filter(Boolean));
  for (let attempt = 0; attempt < 1000; attempt++) {
    const bytes = randomBytes(2), cidr = `${attempt < 700 ? `10.${128 + bytes[0] % 112}` : `172.${16 + bytes[0] % 16}`}.${bytes[1]}.0/24`, range = ipRange(cidr);
    if (used.every(other => range[1] < other[0] || other[1] < range[0])) return cidr;
  }
  throw Error('No unused private Docker subnet found.');
}
function noUnexpectedPorts(config) {
  for (const [service, value] of Object.entries(config.services)) if (service !== 'gateway') assert.equal(value.ports?.length || 0, 0, `${service} must not publish a host port`);
  assert.equal(config.volumes.database.external, true);
  assert.equal(config.volumes.database.name, volume);
}
async function main() {
  const endpoint = !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST || JSON.parse((await docker(['context', 'inspect'])).stdout)[0]?.Endpoints?.docker?.Host;
  if (typeof endpoint !== 'string' || !endpoint.startsWith('unix://')) throw Error('The disposable production lab requires a local Unix-socket Docker daemon.');
  await docker(['info'], { timeout: 15000 });
  directory = await mkdtemp(join(tmpdir(), `${project}-`));
  const secrets = join(directory, 'secrets');
  try {
    console.log('Production lab: generating private disposable secrets and certificates.');
    await run(process.execPath, [join(here, 'generate-secrets.mjs'), '--directory', secrets, '--new-install-only']);
    await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'ca.key'), '-out', join(directory, 'ca.crt'), '-days', '1', '-subj', '/CN=PamoFi production configuration lab CA']);
    await copyFile(join(directory, 'ca.crt'), join(secrets, 'internal_ca')); await chmod(join(secrets, 'internal_ca'), 0o444);
    for (const [name, names] of [['public', 'DNS:pamofi.test,IP:127.0.0.1'], ['internal', 'DNS:identity.internal,DNS:prepaid.internal,DNS:network.internal,DNS:notification.internal,DNS:assistant.internal']]) {
      await run('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(secrets, `${name}_tls_key`), '-out', join(directory, `${name}.csr`), '-subj', `/CN=${name === 'public' ? 'pamofi.test' : 'identity.internal'}`]);
      const extension = join(directory, `${name}.ext`); await writeFile(extension, `subjectAltName=${names}\nextendedKeyUsage=serverAuth\n`);
      await run('openssl', ['x509', '-req', '-in', join(directory, `${name}.csr`), '-CA', join(directory, 'ca.crt'), '-CAkey', join(directory, 'ca.key'), '-CAcreateserial', '-out', join(secrets, `${name}_tls_cert`), '-days', '1', '-extfile', extension]);
      await chmod(join(secrets, `${name}_tls_key`), 0o444); await chmod(join(secrets, `${name}_tls_cert`), 0o444);
    }
    await writeFile(join(secrets, 'first_staff_password'), `${randomBytes(24).toString('base64url')}\n`, { mode: 0o600 });
    for (const name of ['b2_key_id', 'b2_application_key', 'backup_cipher']) await writeFile(join(secrets, name), `${randomBytes(32).toString('hex')}\n`, { mode: 0o444 });
    const env = { ...dockerEnvironment, PAMOFI_SECRETS_DIR: secrets, PAMOFI_DATABASE_VOLUME: volume, PAMOFI_PUBLIC_HOST: 'pamofi.test', PAMOFI_SERVICES_SUBNET: await unusedSubnet(), PAMOFI_COMMERCE_ENABLED: 'true', PAMOFI_AGENT_COMMISSION_BPS: '500', VOUCHER_DELIVERY_ACTIVE_KEY_ID: 'initial', RADIUS_CREDENTIAL_KEY_VERSION: '1', PAMOFI_BOOTSTRAP_UID: String(process.getuid()), PAMOFI_BOOTSTRAP_GID: String(process.getgid()), STAFF_BOOTSTRAP_EMAIL: 'operator@pamofi.invalid', STAFF_BOOTSTRAP_DISPLAY_NAME: 'Isolated lab operator', STAFF_BOOTSTRAP_REASON: 'Disposable production configuration qualification', STAFF_BOOTSTRAP_CONFIRM: 'first-admin', B2_BUCKET: `${project}-unused`, B2_REGION: 'us-west-004', BACKUP_REPOSITORY_PREFIX: `/${project}` };
    for (const service of serviceNames) {
      const key = service === 'prepaid-access' ? 'PREPAID' : service.toUpperCase(), image = `${project}-${service}:local`;
      env[`PAMOFI_${key}_IMAGE`] = image; images.push(image);
      console.log(`Production lab: building independently verified ${service} output.`);
      await docker(['build', '-q', '-t', image, join(backend, `services/${service}-service`)], { timeout: 300000 });
    }
    env.PAMOFI_WEB_IMAGE = `${project}-web:local`; images.push(env.PAMOFI_WEB_IMAGE);
    await docker(['build', '-q', '-t', env.PAMOFI_WEB_IMAGE, join(repository, 'pamofi-frontend/web')], { timeout: 300000 });
    const backupImage = `${project}-backup:local`; images.push(backupImage);
    await docker(['build', '-q', '-t', backupImage, join(backend, 'infra/backup-production')], { timeout: 300000 });
    const backupArguments = ['run', '--rm', '--name', backupContainer, '--label', `com.pamofi.production-lab=${id}`, '--network', 'none', '--read-only', '--tmpfs', '/run/pgbackrest', '--security-opt', 'no-new-privileges:true'];
    for (const name of ['B2_BUCKET', 'B2_REGION', 'BACKUP_REPOSITORY_PREFIX']) backupArguments.push('--env', `${name}=${env[name]}`);
    for (const [name, file] of [['B2_KEY_ID_FILE', 'b2_key_id'], ['B2_APPLICATION_KEY_FILE', 'b2_application_key'], ['BACKUP_CIPHER_FILE', 'backup_cipher']]) backupArguments.push('--env', `${name}=/run/secrets/${file}`, '--mount', `type=bind,source=${join(secrets, file)},target=/run/secrets/${file},readonly`);
    const backupSmoke = await docker([...backupArguments, backupImage, 'sh', '-eu', '-c', `
test "$(stat -c '%a:%U' "$PGBACKREST_CONFIG")" = '600:postgres'
gosu postgres test -r "$PGBACKREST_CONFIG"
grep -qx 'pg1-path=/var/lib/postgresql/data/pgdata' "$PGBACKREST_CONFIG"
grep -qx 'repo1-cipher-type=aes-256-cbc' "$PGBACKREST_CONFIG"
grep -qx 'repo1-storage-verify-tls=y' "$PGBACKREST_CONFIG"
gosu postgres pgbackrest version
`], { timeout: 30000 });
    assert.match(backupSmoke.stdout, /pgBackRest 2\.57\.0/);
    console.log('Production backup image: private postgres-owned configuration and pinned binary passed with networking disabled.');
    // Compose config excludes inactive profile services unless all profiles are
    // explicitly selected while rendering. The generated services retain their
    // profiles; ordinary up still leaves migration/bootstrap processes stopped.
    const configArgs = ['compose', '-p', project, '--profile', '*', '-f', join(here, 'compose.yaml'), '-f', join(here, 'bootstrap-staff.compose.yaml')];
    const config = JSON.parse((await docker([...configArgs, 'config', '--format', 'json'], { env })).stdout); noUnexpectedPorts(config);
    for (const service of serviceNames) assert.deepEqual(config.services[`${service}-migrate`].profiles, ['migrate']);
    assert.deepEqual(config.services['identity-bootstrap'].profiles, ['bootstrap']);
    const backup = JSON.parse((await docker([...configArgs, '-f', join(backend, 'infra/backup-production/compose.yaml'), 'config', '--format', 'json'], { env })).stdout); noUnexpectedPorts(backup);
    assert.ok(backup.services.postgres.command.some(value => value.includes('archive_mode=on')));
    const backupSecrets = backup.services.postgres.secrets.map(item => item.source);
    for (const name of ['postgres_password', 'identity_migrate_password', 'b2_key_id', 'b2_application_key', 'backup_cipher']) assert.ok(backupSecrets.includes(name));
    // Bind only the lab's public gateway, on Docker-assigned loopback ports.
    // The production template keeps its fixed public80/443 convention.
    config.services.gateway.ports = [{ target: 80, host_ip: '127.0.0.1', protocol: 'tcp' }, { target: 443, host_ip: '127.0.0.1', protocol: 'tcp' }];
    rendered = join(directory, 'compose.json'); await writeFile(rendered, JSON.stringify(config), { mode: 0o600 });
    await docker(['volume', 'create', '--label', `com.pamofi.production-lab=${id}`, volume]); volumeCreated = true;
    console.log('Production lab: initializing independent owner/migration/runtime roles.');
    await compose(['up', '-d', '--wait', '--wait-timeout', '120', 'postgres'], { timeout: 150000 });
    for (const service of serviceNames) await compose(['--profile', 'migrate', 'run', '--rm', `${service}-migrate`], { timeout: 120000 });
    await compose(['--profile', 'bootstrap', 'run', '--rm', 'identity-bootstrap'], { timeout: 30000 });
    const repeated = await compose(['--profile', 'bootstrap', 'run', '--rm', 'identity-bootstrap'], { timeout: 30000, failureAllowed: true }); assert.notEqual(repeated.status, 0);
    await compose(['up', '-d', '--wait', '--wait-timeout', '120'], { timeout: 150000 });
    const containers = (await compose(['ps', '-q'])).stdout.trim().split(/\s+/).filter(Boolean), states = JSON.parse((await docker(['inspect', ...containers])).stdout);
    for (const state of states) {
      const service = state.Config.Labels['com.docker.compose.service'], bindings = state.HostConfig.PortBindings || {};
      if (service === 'gateway') { for (const ports of Object.values(bindings)) for (const port of ports) assert.equal(port.HostIp, '127.0.0.1'); }
      else assert.equal(Object.keys(bindings).length, 0, `${service} exposes a host port`);
    }
    const httpsAddress = (await compose(['port', 'gateway', '443'])).stdout.trim(), httpAddress = (await compose(['port', 'gateway', '80'])).stdout.trim();
    assert.match(httpsAddress, /^127\.0\.0\.1:\d+$/); assert.match(httpAddress, /^127\.0\.0\.1:\d+$/);
    const publicResult = await run(process.execPath, [join(here, 'lab-public.mjs'), httpsAddress.split(':')[1], httpAddress.split(':')[1], secrets], { timeout: 90000 }); console.log(publicResult.stdout.trim());
    const internalScript = await readFile(join(here, 'lab-internal.mjs'), 'utf8');
    for (const service of serviceNames) { const result = await compose(['exec', '-T', service, 'node', '--input-type=module'], { input: internalScript, timeout: 30000 }); console.log(result.stdout.trim()); }
    const diagnostics = await run(process.execPath, [join(backend, 'infra/operations/check.mjs'), '--queues'], { env: { ...dockerEnvironment, PAMOFI_OPERATIONS_COMPOSE_FILE: rendered, PAMOFI_OPERATIONS_PROJECT: project, PAMOFI_MONITOR_ORIGIN: `https://${httpsAddress}`, NODE_EXTRA_CA_CERTS: join(secrets, 'internal_ca') }, timeout: 60000 });
    const report = JSON.parse(diagnostics.stdout); assert.equal(report.ok, true); assert.equal(report.publicHttps, true); assert.deepEqual(report.problems, []);
    console.log('Read-only operator check passed with verified HTTPS and three service runtime aggregate queries.');
    // Prove the declared external volume survives even an explicit down -v.
    await compose(['down', '--volumes', '--remove-orphans'], { timeout: 90000 });
    assert.equal((await docker(['volume', 'inspect', '--format', '{{ index .Labels "com.pamofi.production-lab" }}', volume])).stdout.trim(), id);
    await compose(['up', '-d', '--wait', '--wait-timeout', '90', 'postgres'], { timeout: 120000 });
    const count = await compose(['exec', '-T', 'postgres', 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', '-U', 'pamofi_bootstrap', '-d', 'pamofi_identity', '-c', 'SELECT count(*) FROM staff_bootstrap_guard']); assert.equal(count.stdout.trim(), '1');
    console.log('Production Compose/TLS lab passed: overlays render, real HTTPS/MFA/handoff/private authorization, readable non-root secret mounts, no published internal services, external database survives down -v.');
  } finally {
    cleaning = true;
    if (rendered) await compose(['down', '--volumes', '--remove-orphans'], { timeout: 90000, failureAllowed: true });
    const backupLabel = await docker(['container', 'inspect', '--format', '{{ index .Config.Labels "com.pamofi.production-lab" }}', backupContainer], { failureAllowed: true });
    if (backupLabel.status === 0 && backupLabel.stdout.trim() === id) await docker(['container', 'rm', '-f', backupContainer], { failureAllowed: true });
    if (volumeCreated) {
      const label = await docker(['volume', 'inspect', '--format', '{{ index .Labels "com.pamofi.production-lab" }}', volume], { failureAllowed: true });
      if (label.status === 0 && label.stdout.trim() === id) await docker(['volume', 'rm', volume], { failureAllowed: true });
    }
    for (const image of images) await docker(['image', 'rm', image], { failureAllowed: true });
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Production lab failed.'); process.exitCode = 1; });
