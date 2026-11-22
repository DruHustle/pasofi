import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import Fastify from 'fastify';
import {jwtVerify} from 'jose';
import {registerCommerce} from '../dist/commerce.js';
import {approvedDeviceCapabilities} from '../dist/approved-devices.js';

const actorId = 'a1111111-1111-4111-8111-111111111111';
const deviceId = 'b2222222-2222-4222-8222-222222222222';
const nasId = 'c3333333-3333-4333-8333-333333333333';
const requestKey = 'd4444444-4444-4444-8444-444444444444';
const origin = 'https://pasofi.example.test';
const secret = 'test_private_network_signing_secret_32bytes';
const add = {macAddress: ' 3c-22-fb-12-34-56 ', label: ' Owner phone ', reason: ' Owner approved portal-free access '};
const device = {id: deviceId, macAddress: '3C:22:FB:12:34:56', label: 'Owner phone', createdBy: actorId, createdAt: '2026-11-22T10:00:00.000Z'};
const listing = {
  devices: [{...device, routers: [{nasId, state: 'applied', observedAt: '2026-11-22T10:00:01.000Z'}]}],
  routers: [{id: nasId, siteName: 'Goromonzi', clientName: 'G0', configured: true, status: 'synced', errorCode: null, attemptedAt: '2026-11-22T10:00:01.000Z', syncedAt: '2026-11-22T10:00:01.000Z', conflicts: 0, pendingRemovals: 0}],
  events: [{id: requestKey, entryId: deviceId, type: 'added', actorId, nasId: null, macAddress: '3C:22:FB:12:34:56', label: 'Owner phone', reason: 'Owner approved portal-free access', createdAt: '2026-11-22T10:00:00.000Z'}],
  maxDevices: 200, writesEnabled: true, registryAvailable: true, syncing: false,
};

async function fixture(fn) {
  const saved = {...process.env}; const events = []; let networkBehavior;
  let staff = {staffId: actorId, role: 'admin', siteIds: [], version: 4, mfaVerified: true};
  let identityStatus = 200;
  const identity = createServer((request, response) => {
    response.writeHead(identityStatus, {'content-type': 'application/json'}); response.end(JSON.stringify(staff));
  });
  const network = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    events.push({url: request.url, method: request.method, headers: request.headers, body: body ? JSON.parse(body) : undefined});
    if (networkBehavior) return networkBehavior(request, response);
    response.writeHead(request.method === 'GET' ? 200 : 201, {'content-type': 'application/json', 'set-cookie': 'leak=blocked'});
    response.end(JSON.stringify(request.method === 'GET' ? listing : request.url.endsWith('/sync') ? {syncing: true} : {device, syncing: false}));
  });
  await Promise.all([new Promise(resolve => identity.listen(0, '127.0.0.1', resolve)), new Promise(resolve => network.listen(0, '127.0.0.1', resolve))]);
  Object.assign(process.env, {
    INTERNAL_IDENTITY_SECRET: 'test_private_identity_signing_secret_32bytes', IDENTITY_URL: `http://127.0.0.1:${identity.address().port}`,
    INTERNAL_NETWORK_SECRET: secret, NETWORK_URL: `http://127.0.0.1:${network.address().port}`,
    PAMOFI_APPROVED_DEVICES_ENABLED: 'true', PAMOFI_APPROVED_DEVICES_WRITE_ENABLED: 'true',
    PAMOFI_COMMERCE_ENABLED: 'false', PAMOFI_CUSTOMER_NETWORK_ENABLED: 'false',
  });
  const app = Fastify({logger: false, bodyLimit: 16384});
  registerCommerce(app, {}, true, async () => null, request => request.headers.origin === origin);
  const call = (path = '', options = {}) => app.inject({
    method: options.method ?? 'GET', url: `/v1/admin/approved-devices${path}`,
    headers: {cookie: '__Host-pamofi_staff_session=private_browser_cookie', origin, 'idempotency-key': requestKey, ...options.headers},
    ...(options.body === undefined ? {} : {payload: options.body}),
  });
  try { await fn({call, events, setStaff: value => {staff = {...staff, ...value};}, setIdentityStatus: value => {identityStatus = value;}, setNetwork: value => {networkBehavior = value;}}); }
  finally {
    await app.close(); identity.closeAllConnections(); network.closeAllConnections();
    await Promise.all([new Promise(resolve => identity.close(resolve)), new Promise(resolve => network.close(resolve))]);
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved);
  }
}

test('approved devices require an approved, MFA-verified administrator', async () => {
  await fixture(async ({call, events, setStaff, setIdentityStatus}) => {
    assert.equal((await call()).statusCode, 200);
    for (const role of ['agent', 'support']) {
      setStaff({role}); assert.equal((await call()).statusCode, 403);
      assert.equal((await call('', {method: 'POST', body: add})).statusCode, 403);
    }
    setStaff({role: 'admin', mfaVerified: false}); assert.equal((await call()).statusCode, 503);
    assert.equal((await call('', {method: 'POST', body: add})).statusCode, 503);
    setStaff({mfaVerified: true}); setIdentityStatus(401); assert.equal((await call()).statusCode, 401);
    setIdentityStatus(403); assert.equal((await call(`/${deviceId}/remove`, {method: 'POST', body: {reason: 'Device was handed back'}})).statusCode, 403);
    assert.equal(events.length, 1, 'only the administrator request reaches network');
  });
});

test('changes forward server-derived actor claims and the idempotency key without browser credentials', async () => {
  await fixture(async ({call, events}) => {
    const response = await call('', {method: 'POST', body: add, headers: {authorization: 'Bearer browser-supplied'}});
    assert.equal(response.statusCode, 201); assert.deepEqual(response.json(), {device, syncing: false});
    assert.equal(response.headers['set-cookie'], undefined); assert.equal(response.headers['cache-control'], 'no-store');
    const event = events[0]; assert.equal(event.url, '/internal/v1/device-allowlist/devices');
    assert.deepEqual(event.body, {macAddress: '3c-22-fb-12-34-56', label: 'Owner phone', reason: 'Owner approved portal-free access', requestKey});
    for (const header of ['cookie', 'origin', 'idempotency-key']) assert.equal(event.headers[header], undefined);
    const {payload} = await jwtVerify(event.headers.authorization.slice(7), new TextEncoder().encode(secret), {issuer: 'prepaid-access', subject: 'prepaid-access', audience: 'network', algorithms: ['HS256']});
    assert.equal(payload.actorId, actorId); assert.equal(payload.actorVersion, '4'); assert.equal(payload.scope, 'device-allowlist:write'); assert.equal(payload.exp - payload.iat, 15);
    assert.equal((await call(`/${deviceId.toUpperCase()}/remove`, {method: 'POST', body: {reason: 'Device was handed back'}})).statusCode, 201);
    assert.equal(events[1].url, `/internal/v1/device-allowlist/devices/${deviceId}/remove`); assert.deepEqual(events[1].body, {reason: 'Device was handed back', requestKey});
    assert.equal((await call('/sync', {method: 'POST', body: {}})).statusCode, 201);
    assert.equal(events[2].url, '/internal/v1/device-allowlist/sync'); assert.deepEqual(events[2].body, {});
    assert.deepEqual((await call()).json(), listing);
    const read = await jwtVerify(events[3].headers.authorization.slice(7), new TextEncoder().encode(secret)); assert.equal(read.payload.scope, 'device-allowlist:read');
  });
});

test('foreign origins, injected fields and malformed input are rejected before forwarding', async () => {
  await fixture(async ({call, events}) => {
    assert.equal((await call('', {method: 'POST', body: add, headers: {origin: 'https://foreign.example.test'}})).statusCode, 403);
    for (const body of [
      {...add, actorId}, {...add, requestKey}, {...add, nasId}, {...add, url: 'https://10.77.254.2/rest/'}, {...add, server: 'pfi-guest20'}, {...add, type: 'blocked'},
      {...add, macAddress: '3C:22:FB:12:34:56;/system/reboot'}, {...add, macAddress: '3C:22'}, {...add, macAddress: 42},
      {...add, label: ''}, {...add, label: 'x'.repeat(81)}, {...add, label: 'line\nbreak'}, {...add, reason: 'short'}, {macAddress: add.macAddress, label: add.label},
    ]) assert.equal((await call('', {method: 'POST', body})).statusCode, 400, JSON.stringify(body));
    assert.equal((await call('', {method: 'POST', body: add, headers: {'idempotency-key': 'not-a-uuid'}})).statusCode, 400);
    assert.equal((await call(`/${deviceId}/remove`, {method: 'POST', body: {reason: 'Remove with an injected binding', bindingId: '*1'}})).statusCode, 400);
    assert.equal((await call(`/${deviceId}/remove`, {method: 'POST', body: {reason: 'short'}})).statusCode, 400);
    assert.equal((await call('/not-a-uuid/remove', {method: 'POST', body: {reason: 'Remove a malformed device'}})).statusCode, 400);
    assert.equal((await call('/sync', {method: 'POST', body: {nasId}})).statusCode, 400);
    assert.equal((await call('?nasId=' + nasId)).statusCode, 400);
    assert.equal(events.length, 0);
  });
});

test('writes have their own switch while the list stays available', async () => {
  await fixture(async ({call, events}) => {
    process.env.PAMOFI_APPROVED_DEVICES_WRITE_ENABLED = 'false';
    assert.deepEqual(approvedDeviceCapabilities(true), {approvedDevices: true, approvedDevicesWrite: false});
    for (const [path, body] of [['', add], [`/${deviceId}/remove`, {reason: 'Device was handed back'}], ['/sync', {}]]) {
      const response = await call(path, {method: 'POST', body}); assert.equal(response.statusCode, 409); assert.equal(response.json().error, 'writes_disabled');
    }
    assert.equal((await call()).statusCode, 200); assert.equal(events.length, 1);
    process.env.PAMOFI_APPROVED_DEVICES_ENABLED = 'false';
    assert.equal((await call()).statusCode, 404); assert.deepEqual(approvedDeviceCapabilities(true), {approvedDevices: false, approvedDevicesWrite: false});
  });
});

test('reviewed network errors pass through and unknown responses never leak details', async () => {
  await fixture(async ({call, setNetwork}) => {
    for (const [status, error] of [[400, 'multicast_mac_address'], [400, 'broadcast_mac_address'], [409, 'device_exists'], [409, 'allowlist_full'], [409, 'idempotency_conflict'], [404, 'not_found']]) {
      setNetwork((_request, response) => {response.writeHead(status, {'content-type': 'application/json'}); response.end(JSON.stringify({error, debug: 'password=private'}));});
      const response = await call('', {method: 'POST', body: add}); assert.equal(response.statusCode, status); assert.deepEqual(response.json(), {error});
    }
    for (const behavior of [
      (_request, response) => {response.writeHead(302, {location: 'https://elsewhere.invalid'}); response.end();},
      (_request, response) => {response.writeHead(500, {'content-type': 'application/json'}); response.end(JSON.stringify({error: 'router password=private'}));},
      (_request, response) => {response.writeHead(400, {'content-type': 'application/json'}); response.end(JSON.stringify({error: 'unreviewed_code'}));},
      (_request, response) => {response.writeHead(200, {'content-type': 'text/html'}); response.end('<html>RouterOS</html>');},
      (_request, response) => {response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({...listing, routers: [{...listing.routers[0], status: 'rebooting'}]}));},
    ]) {
      setNetwork(behavior); const response = await call();
      assert.equal(response.statusCode, 503); assert.deepEqual(response.json(), {error: 'approved_devices_unavailable'});
    }
    setNetwork((_request, response) => {response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({...listing, password: 'private',
      routers: [{...listing.routers[0], url: 'https://10.77.254.2/rest/', username: 'pfi-k1-reconciler', password: 'private'}],
      devices: [{...listing.devices[0], bindingId: '*1', comment: 'raw'}]}));});
    assert.deepEqual((await call()).json(), listing);
  });
});

test('capability requires the explicit switch and a private HTTPS network origin', () => {
  const saved = {...process.env};
  try {
    Object.assign(process.env, {PAMOFI_APPROVED_DEVICES_ENABLED: 'true', PAMOFI_APPROVED_DEVICES_WRITE_ENABLED: 'true', INTERNAL_NETWORK_SECRET: secret});
    for (const value of ['http://network.internal', 'https://user:pass@network.internal', 'https://network.internal/path']) {
      process.env.NETWORK_URL = value; assert.equal(approvedDeviceCapabilities(false).approvedDevices, false);
    }
    process.env.NETWORK_URL = 'https://network.internal'; assert.deepEqual(approvedDeviceCapabilities(false), {approvedDevices: true, approvedDevicesWrite: true});
    assert.equal(approvedDeviceCapabilities(false, false).approvedDevices, false);
    process.env.INTERNAL_NETWORK_SECRET = 'DEMO_ONLY_' + 'x'.repeat(32); assert.equal(approvedDeviceCapabilities(false).approvedDevices, false);
    process.env.INTERNAL_NETWORK_SECRET = secret; process.env.PAMOFI_APPROVED_DEVICES_ENABLED = 'false'; assert.equal(approvedDeviceCapabilities(false).approvedDevicesWrite, false);
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});
