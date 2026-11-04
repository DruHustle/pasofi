#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

// Orchestration only: every project builds/tests in its own directory and owns
// its migrations. This script does not import service or frontend application code.
const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(backend, '..');
const services = ['identity', 'prepaid-access', 'network', 'notification', 'assistant'];
const variables = {
  identity: 'PAMOFI_TEST_IDENTITY_DATABASE_URL',
  'prepaid-access': 'PAMOFI_TEST_PREPAID_DATABASE_URL',
  network: 'PAMOFI_TEST_NETWORK_DATABASE_URL',
  notification: 'PAMOFI_TEST_NOTIFICATION_DATABASE_URL',
  assistant: 'PAMOFI_TEST_ASSISTANT_DATABASE_URL',
};
const serviceDirectory = name => join(backend, 'services', `${name}-service`);
const frontendDirectory = name => join(repository, 'pasofi-frontend', name);
const args = new Set(process.argv.slice(2));
const known = new Set(['--integration', '--browser', '--install', '--help']);
const integration = args.has('--integration');
const browser = args.has('--browser');
const owned = new Set();
const reservations = new Set();
const stopped = new AbortController();
const counts = [];
let cleanupPromise;
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const say = message => console.log(`[verify] ${message}`);
async function completesWithin(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

function assertActive() { if (stopped.signal.aborted) throw Error('Verification interrupted'); }
function stopChild(child, signal) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    // Only signal process groups created by this invocation, including npm's
    // descendants. Never discover/kill processes by port, name, or pattern.
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    await Promise.all([...reservations].map(item => item.release()));
    const children = [...owned];
    for (const item of children) stopChild(item.child, 'SIGTERM');
    await Promise.all(children.map(async item => {
      const completed = await completesWithin(item.done, 12_000);
      if (!completed) {
        stopChild(item.child, 'SIGKILL');
        await completesWithin(item.done, 2_000);
      }
    }));
  })();
  return cleanupPromise;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stopped.abort();
  void cleanup();
});

function sanitizedEnvironment() {
  const env = { ...process.env };
  // Do not inherit a real service's database, credentials, feature flags, or
  // provider configuration into a test process. npm/browser runtime settings stay.
  for (const key of Object.keys(env)) {
    if (/^(?:DATABASE_URL$|PG[A-Z_]|APP_ENV$|NODE_ENV$|NODE_OPTIONS$|PUBLIC_ORIGIN(?:_ALIASES)?$|HOST$|PORT$|IDENTITY_URL$|NOTIFICATION_URL$|NOTIFICATION_DELIVERY_|PREPAID_URL$|NETWORK_URL$|NETWORK_RECONCILER_|ROUTEROS_|STAFF_|SESSION_CREATION_SECRET$|VOUCHER_|DELIVERY_|VITE_PAMOFI_|OUTBOX_|INTERNAL_|PESEPAY_|ECOCASH_|SENDAI_|RADIUS_|PAMOFI_|PASOFI_)/.test(key)) delete env[key];
  }
  return { ...env, APP_ENV: 'demo', NODE_ENV: 'development', OUTBOX_DISPATCH_ENABLED: 'false' };
}
function databaseConfiguration() {
  if (process.env.PAMOFI_TEST_CONFIRM_ISOLATED !== '1') throw Error('Integration requires PAMOFI_TEST_CONFIRM_ISOLATED=1 and dedicated disposable databases');
  const result = {}, databases = new Set();
  for (const name of services) {
    const variable = variables[name], value = process.env[variable];
    if (!value) throw Error(`Integration requires ${variable}; refusing to skip its tests`);
    let url;
    try { url = new URL(value); } catch { throw Error(`${variable} is not a PostgreSQL URL`); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !url.username || !url.port || !/^\/[A-Za-z0-9_-]+$/.test(url.pathname) || url.search || url.hash) {
      throw Error(`${variable} must name an explicit loopback port and database, without URL parameters or fragments`);
    }
    const identity = `${url.port}:${url.pathname}`;
    if (databases.has(identity)) throw Error('Each service must use a separate disposable database');
    databases.add(identity);
    result[name] = value;
  }
  return result;
}

function launch(label, command, commandArgs, cwd, env, { foreground = false } = {}) {
  assertActive();
  say(label);
  const child = spawn(command, commandArgs, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const item = { label, child, output: '', error: null, exited: false, result: null, done: null };
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.setEncoding('utf8');
    stream.on('data', value => {
      item.output = (item.output + stripVTControlCharacters(value)).slice(-8_000_000);
      if (foreground) destination.write(value);
    });
  }
  item.done = new Promise(resolveDone => {
    child.once('error', error => { item.error = error; });
    child.once('close', (code, signal) => {
      item.exited = true;
      item.result = { code, signal };
      owned.delete(item);
      resolveDone(item.result);
    });
  });
  owned.add(item);
  return item;
}
async function run(label, command, commandArgs, cwd, env, timeout = 600_000) {
  const item = launch(label, command, commandArgs, cwd, env, { foreground: true });
  let timer;
  const outcome = await Promise.race([
    item.done,
    new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(null), timeout); }),
  ]);
  clearTimeout(timer);
  if (outcome === null) {
    stopChild(item.child, 'SIGTERM');
    throw Error(`${label} exceeded its ${timeout / 1000}s limit`);
  }
  assertActive();
  if (item.error || outcome.code !== 0) throw Error(`${label} failed${item.error ? ` (${item.error.code ?? 'spawn error'})` : ` (exit ${outcome.code ?? outcome.signal})`}`);
  return item.output;
}
async function reservePort() {
  assertActive();
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  let released = false;
  const item = { port: address.port, release: async () => {
    if (released) return;
    released = true;
    reservations.delete(item);
    await new Promise((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
  } };
  reservations.add(item);
  return item;
}
function checkChildren(children) {
  for (const item of children) if (item.exited || item.error) {
    if (item.output) process.stderr.write(item.output.slice(-8000));
    throw Error(`${item.label} exited unexpectedly`);
  }
}
async function ready(item, endpoint, expectedService) {
  const deadline = Date.now() + 30_000;
  // Give a failed bind time to report before accepting an HTTP readiness result.
  await delay(200);
  while (Date.now() < deadline) {
    assertActive(); checkChildren([item]);
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(1500), redirect: 'error' });
      if (response.ok) {
        if (expectedService) {
          const live = await fetch(new URL('/health/live', endpoint), { signal: AbortSignal.timeout(1500), redirect: 'error' });
          if (!live.ok || (await live.json()).service !== expectedService) throw Error('Unexpected service');
        }
        await delay(100);
        checkChildren([item]);
        return;
      }
    } catch { /* Retry a starting process until the bounded readiness deadline. */ }
    await delay(100);
  }
  if (item.output) process.stderr.write(item.output.slice(-8000));
  throw Error(`${item.label} did not become ready within 30s`);
}

async function nodeTests(name, env) {
  const cwd = serviceDirectory(name);
  const files = (await readdir(join(cwd, 'test'))).filter(file => file.endsWith('.test.mjs')).sort().map(file => join('test', file));
  if (files.length === 0) throw Error(`${name} has no discovered tests`);
  const output = await run(`${name}: tests`, process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=120000', '--test-reporter=tap', ...files], cwd, env);
  const number = field => {
    const match = output.match(new RegExp(`^# ${field} (\\d+)\\s*$`, 'm'));
    if (!match) throw Error(`${name}: missing ${field} test summary`);
    return Number(match[1]);
  };
  const summary = { project: name, tests: number('tests'), passed: number('pass'), skipped: number('skipped'), todo: number('todo') };
  if (!summary.tests || (integration && (summary.skipped || summary.todo))) throw Error(`${name}: integration cannot pass with skipped, pending, or absent tests`);
  counts.push(summary);
}

async function main() {
  if ([...args].some(arg => !known.has(arg))) throw Error('Unknown option; use --help');
  if (args.has('--help')) {
    console.log('Usage: node pasofi-backend/local-tools/verify.mjs [--install] [--integration [--browser]]\n\nDefault: independent builds and unit tests; database tests are explicitly reported as skipped.\n--integration: requires five loopback PAMOFI_TEST_*_DATABASE_URL values and PAMOFI_TEST_CONFIRM_ISOLATED=1.\n--browser: also starts owned web/mobile Vite servers and requires installed Playwright Chromium (or PAMOFI_CHROME_PATH).\n--install: run npm ci separately for all seven projects. See pasofi-backend/docs/TESTING.md.');
    return;
  }
  if (browser && !integration) throw Error('--browser requires --integration so customer flows use real test services');
  if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node.js 22 or newer is required; CI uses Node 24.22.1');
  const databases = integration ? databaseConfiguration() : null;
  const env = sanitizedEnvironment();
  const projects = [...services.map(name => ({ name, cwd: serviceDirectory(name) })), ...['web', 'mobile'].map(name => ({ name, cwd: frontendDirectory(name) }))];
  say(integration ? 'Full integration mode: every database-backed test is required; no real providers are enabled.' : 'Unit mode: database and browser coverage is excluded. This is not the acceptance gate.');
  for (const project of projects) {
    if (args.has('--install')) await run(`${project.name}: install locked dependencies`, 'npm', ['ci', '--no-audit', '--no-fund'], project.cwd, env);
    else {
      try { await access(join(project.cwd, 'node_modules')); }
      catch { throw Error(`${project.name}: dependencies are missing; rerun with --install`); }
    }
    await run(`${project.name}: build`, 'npm', ['run', 'build'], project.cwd, { ...env, NODE_ENV: 'production' });
    if (databases && services.includes(project.name)) await run(`${project.name}: migrations`, process.execPath, ['migrate.mjs'], project.cwd, { ...env, DATABASE_URL: databases[project.name] });
  }
  if (!integration) {
    for (const name of services) await nodeTests(name, env);
    say(`Unit/build verification passed. ${counts.reduce((sum, item) => sum + item.skipped, 0)} database tests were skipped; integration and browser acceptance remain unverified.`);
    return;
  }

  const ports = {};
  for (const name of [...services, 'web', ...(browser ? ['mobile'] : [])]) ports[name] = await reservePort();
  const address = name => `http://127.0.0.1:${ports[name].port}`;
  const demoEnv = {
    ...env, HOST: '127.0.0.1', PUBLIC_ORIGIN: address('web'),
    INTERNAL_IDENTITY_SECRET: 'DEMO_ONLY_insecure_local_service_secret_123456789',
    SESSION_CREATION_SECRET: 'DEMO_ONLY_insecure_local_session_creation_secret_123456789',
    INTERNAL_EVENTS_SECRET: 'DEMO_ONLY_insecure_local_events_secret_123456789',
    INTERNAL_NETWORK_SECRET: 'DEMO_ONLY_network_lab_key_0123456789abcdef',
    INTERNAL_DELIVERY_SECRET: 'DEMO_ONLY_delivery_worker_secret_0123456789abcdef',
    STAFF_MFA_ENCRYPTION_KEY: '11'.repeat(32),
    PAMOFI_COMMERCE_ENABLED: 'true',
    VOUCHER_DELIVERY_ACTIVE_KEY_ID: 'v1',
    VOUCHER_DELIVERY_KEYS_JSON: JSON.stringify({v1:Buffer.alloc(32,17).toString('base64')}),
    PAMOFI_SMS_DELIVERY_ENABLED: 'true',
    PAMOFI_PAYMENTS_ENABLED: 'true', PAMOFI_PAYMENT_MODE: 'mock',
    DELIVERY_WORKER_ENABLED: 'false', NOTIFICATION_DELIVERY_MODE: 'mock',
    INTERNAL_RADIUS_ENABLED: 'true',
    IDENTITY_URL: address('identity'), NOTIFICATION_URL: address('notification'), PREPAID_URL: address('prepaid-access'), NETWORK_URL: address('network'),
  };
  const servers = [];
  for (const name of services) {
    await ports[name].release();
    servers.push(launch(`${name}: isolated demo server`, process.execPath, ['dist/server.js'], serviceDirectory(name), { ...demoEnv, PAMOFI_PAYMENTS_ENABLED:'false', DATABASE_URL: databases[name], PORT: String(ports[name].port) }));
  }
  await Promise.all(services.map((name, index) => ready(servers[index], `${address(name)}/health/ready`, name === 'prepaid-access' ? 'prepaid-access' : name)));
  for (const name of services) {
    checkChildren(servers);
    const testEnv = {
      ...demoEnv,
      PAMOFI_PAYMENTS_ENABLED:'false',
      DATABASE_URL: databases[name],
      // The network RADIUS suite also checks the prepaid ledger; its credentials
      // suite receives the separate network URL explicitly.
      PAMOFI_TEST_DATABASE_URL: name === 'network' ? databases['prepaid-access'] : databases[name],
      PAMOFI_TEST_NETWORK_DATABASE_URL: databases.network,
      PAMOFI_TEST_NOTIFICATION_DATABASE_URL: databases.notification,
      PAMOFI_TEST_PREPAID_URL: address('prepaid-access'),
      PAMOFI_TEST_NOTIFICATION_URL: address('notification'),
    };
    await nodeTests(name, testEnv);
  }
  if (browser) {
    // Database suites exercise their own workers and disposable queue fixtures.
    // Enable the shared mock checkout worker only after those suites finish.
    const prepaidIndex=services.indexOf('prepaid-access');
    stopChild(servers[prepaidIndex].child,'SIGTERM');
    if(!await completesWithin(servers[prepaidIndex].done,12000))throw Error('Prepaid test server did not stop before browser qualification');
    servers[prepaidIndex]=launch('prepaid-access: browser mock checkout server',process.execPath,['dist/server.js'],serviceDirectory('prepaid-access'),{
      ...demoEnv,DATABASE_URL:databases['prepaid-access'],PORT:String(ports['prepaid-access'].port)
    });
    await ready(servers[prepaidIndex],`${address('prepaid-access')}/health/ready`,'prepaid-access');
    const catalogue = await fetch(`${address('prepaid-access')}/v1/bundles`, { signal: AbortSignal.timeout(3000) });
    const catalogueBody = await catalogue.json();
    if (!catalogue.ok || catalogueBody.candidate !== true || !Array.isArray(catalogueBody.products) || !catalogueBody.products.some(product => product.id === 'flex')) throw Error('Browser tests require the disposable candidate catalogue from infra/postgres/init.sql');
    for (const name of ['web', 'mobile']) {
      const cwd = frontendDirectory(name);
      const uiEnv = { ...demoEnv, PAMOFI_BASE_URL: address(name), PAMOFI_IDENTITY_URL: address('identity'), PAMOFI_PREPAID_URL: address('prepaid-access'), PAMOFI_ASSISTANT_URL: address('assistant') };
      if (process.env.PAMOFI_CHROME_PATH) uiEnv.PAMOFI_CHROME_PATH = process.env.PAMOFI_CHROME_PATH;
      await ports[name].release();
      const vite = launch(`${name}: isolated Vite server`, process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(ports[name].port), '--strictPort'], cwd, uiEnv);
      servers.push(vite);
      await ready(vite, address(name));
      const report = join(cwd, 'test-results', 'verification-summary.json');
      await mkdir(dirname(report), { recursive: true });
      await run(`${name}: browser tests`, process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--reporter=line,json'], cwd, { ...uiEnv,
        PAMOFI_TEST_CONFIRM_ISOLATED:'1', PAMOFI_TEST_IDENTITY_DATABASE_URL:databases.identity, PAMOFI_TEST_PREPAID_DATABASE_URL:databases['prepaid-access'],
        PLAYWRIGHT_JSON_OUTPUT_FILE: report });
      const stats = JSON.parse(await readFile(report, 'utf8')).stats;
      if (!stats || !['expected', 'unexpected', 'skipped', 'flaky'].every(field => Number.isInteger(stats[field])) || stats.expected < 1 || stats.unexpected || stats.skipped || stats.flaky) throw Error(`${name}: browser gate requires passing tests with no skipped, flaky, or unexpected cases`);
      counts.push({ project: `${name} browser`, tests: stats.expected, passed: stats.expected, skipped: 0, todo: 0 });
      checkChildren(servers);
    }
  }
  checkChildren(servers);
  say(`Integration verification passed: ${counts.reduce((sum, item) => sum + item.passed, 0)} tests; zero skipped or pending tests. Browser acceptance ${browser ? 'passed for web and mobile' : 'was not requested'}.`);
}

try { await main(); }
catch (error) { console.error(`[verify] FAILED: ${error.message}`); process.exitCode = 1; }
finally { await cleanup(); }
