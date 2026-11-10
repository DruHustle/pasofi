import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import Fastify from 'fastify';
import {jwtVerify} from 'jose';
import {registerCommerce} from '../dist/commerce.js';
import {routerFleetCapabilities} from '../dist/router-fleet.js';

const actorId = 'a1111111-1111-4111-8111-111111111111';
const id = 'b2222222-2222-4222-8222-222222222222';
const changeId = 'c3333333-3333-4333-8333-333333333333';
const requestKey = 'd4444444-4444-4444-8444-444444444444';
const origin = 'https://pasofi.example.test';
const secret = 'test_private_network_signing_secret_32bytes';
const preview = {targetKey: 'identity', expectedRevision: 'a'.repeat(64), values: {name: 'Pasofi Central'}, reason: 'Reviewed identity label change'};

async function fixture(fn) {
  const saved = {...process.env}; const events = []; let networkBehavior;
  let staff = {staffId: actorId, role: 'admin', siteIds: [], version: 7, mfaVerified: true};
  let identityStatus = 200;
  const identity = createServer((request, response) => {
    response.writeHead(identityStatus, {'content-type': 'application/json'}); response.end(JSON.stringify(staff));
  });
  const network = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const event = {url: request.url, method: request.method, headers: request.headers, body: body ? JSON.parse(body) : undefined};
    events.push(event);
    if (networkBehavior) return networkBehavior(request, response);
    response.writeHead(200, {'content-type': 'application/json', 'set-cookie': 'leak=blocked'});
    response.end(JSON.stringify(request.url.endsWith('/routers') ? {routers: []} : {change: {id: changeId, status: 'prepared', before: {name: 'Old'}, after: {name: 'New'}}}));
  });
  await Promise.all([new Promise(resolve => identity.listen(0, '127.0.0.1', resolve)), new Promise(resolve => network.listen(0, '127.0.0.1', resolve))]);
  Object.assign(process.env, {
    INTERNAL_IDENTITY_SECRET: 'test_private_identity_signing_secret_32bytes', IDENTITY_URL: `http://127.0.0.1:${identity.address().port}`,
    INTERNAL_NETWORK_SECRET: secret, NETWORK_URL: `http://127.0.0.1:${network.address().port}`,
    PAMOFI_ROUTER_FLEET_ENABLED: 'true', PAMOFI_ROUTER_FLEET_WRITE_ENABLED: 'true',
    PAMOFI_COMMERCE_ENABLED: 'false', PAMOFI_CUSTOMER_NETWORK_ENABLED: 'false',
  });
  const app = Fastify({logger: false, bodyLimit: 16384});
  registerCommerce(app, {}, true, async () => null, request => request.headers.origin === origin);
  const call = (path = '', options = {}) => app.inject({
    method: options.method ?? 'GET', url: `/v1/admin/routers${path}`,
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

test('fleet reuses approved admin/MFA identity and works while customer commerce is paused', async () => {
  await fixture(async ({call, events, setStaff, setIdentityStatus}) => {
    assert.equal((await call()).statusCode, 200);
    for (const role of ['agent', 'support']) { setStaff({role}); assert.equal((await call()).statusCode, 403); }
    setStaff({role: 'admin', mfaVerified: false}); assert.equal((await call()).statusCode, 503);
    setStaff({mfaVerified: true}); setIdentityStatus(401); assert.equal((await call()).statusCode, 401);
    setIdentityStatus(403); assert.equal((await call()).statusCode, 403);
    assert.equal(events.length, 1);
  });
});

test('preview derives signed actor claims and request key without forwarding browser credentials', async () => {
  await fixture(async ({call, events}) => {
    const response = await call(`/${id}/changes`, {method: 'POST', body: preview, headers: {authorization: 'Bearer browser-supplied'}});
    assert.equal(response.statusCode, 200); assert.equal(response.headers['set-cookie'], undefined); assert.equal(response.headers['cache-control'], 'no-store');
    const event = events[0]; assert.equal(event.url, `/internal/v1/router-fleet/routers/${id}/changes`);
    assert.deepEqual(event.body, {...preview, requestKey});
    assert.equal(event.headers.cookie, undefined); assert.equal(event.headers.origin, undefined); assert.equal(event.headers['idempotency-key'], undefined);
    const {payload} = await jwtVerify(event.headers.authorization.slice(7), new TextEncoder().encode(secret), {issuer: 'prepaid-access', subject: 'prepaid-access', audience: 'network', algorithms: ['HS256']});
    assert.equal(payload.actorId, actorId); assert.equal(payload.actorVersion, '7'); assert.equal(payload.scope, 'router-fleet:write'); assert.equal(payload.exp - payload.iat, 15);
    await call();
    const read = await jwtVerify(events[1].headers.authorization.slice(7), new TextEncoder().encode(secret)); assert.equal(read.payload.scope, 'router-fleet:read');
  });
});

test('fleet rejects foreign origins, actor injection, arbitrary resources, malformed IDs and payloads before forwarding', async () => {
  await fixture(async ({call, events}) => {
    assert.equal((await call(`/${id}/changes`, {method: 'POST', body: preview, headers: {origin: 'https://foreign.example.test'}})).statusCode, 403);
    for (const body of [{...preview, actorId}, {...preview, requestKey}, {...preview, url: 'https://private.invalid/rest/'}, {...preview, values: {password: 'secret'}}, {...preview, values: {name: 'x\ncommand'}}, {...preview, reason: 'short'}, {...preview, expectedRevision: 'stale'}]) {
      assert.equal((await call(`/${id}/changes`, {method: 'POST', body})).statusCode, 400);
    }
    assert.equal((await call(`/${id}/changes`, {method: 'POST', body: preview, headers: {'idempotency-key': 'bad'}})).statusCode, 400);
    assert.equal((await call('/not-a-uuid')).statusCode, 400);
    assert.equal((await call('?url=https://private.invalid')).statusCode, 400);
    assert.equal((await call(`/${id}/changes/${changeId}/apply`, {method: 'POST', body: {values: {name: 'injected'}}})).statusCode, 400);
    assert.equal(events.length, 0);
  });
});

test('writes require their own switch while change history and reconciliation stay available', async () => {
  await fixture(async ({call, events}) => {
    process.env.PAMOFI_ROUTER_FLEET_WRITE_ENABLED = 'false';
    assert.deepEqual(routerFleetCapabilities(true), {routerFleet: true, routerFleetWrite: false});
    for (const [path, body] of [[`/${id}/changes`, preview], [`/${id}/changes/${changeId}/apply`, {}], [`/${id}/changes/${changeId}/rollback`, {reason: 'Restore previous router label'}]]) {
      assert.equal((await call(path, {method: 'POST', body})).statusCode, 409);
    }
    assert.equal((await call(`/${id}/changes/${changeId}`)).statusCode, 200);
    assert.equal((await call(`/${id}/changes/${changeId}/reconcile`, {method: 'POST', body: {}})).statusCode, 200);
    assert.equal(events.length, 2);
    process.env.PAMOFI_ROUTER_FLEET_ENABLED = 'false';
    assert.equal((await call()).statusCode, 404); assert.deepEqual(routerFleetCapabilities(true), {routerFleet: false, routerFleetWrite: false});
  });
});

test('upstream failures never disclose service credentials or retry a potentially applied write', async () => {
  await fixture(async ({call, events, setNetwork}) => {
    for (const behavior of [
      (_request, response) => {response.writeHead(302, {location: 'https://elsewhere.invalid'}); response.end();},
      (_request, response) => {response.writeHead(500, {'content-type': 'application/json'}); response.end(JSON.stringify({error: 'password=private'}));},
      (_request, response) => {response.writeHead(200, {'content-type': 'text/html'}); response.end('<html>Router login</html>');},
      (_request, response) => {response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({change: {}, password: 'private'}));},
      (_request, response) => {response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({change: {text: 'x'.repeat(270000)}}));},
    ]) {
      setNetwork(behavior); const before = events.length;
      const result = await call(`/${id}/changes/${changeId}/apply`, {method: 'POST', body: {}});
      assert.equal(result.statusCode, 503); assert.deepEqual(result.json(), {error: 'router_fleet_unavailable'}); assert.equal(events.length, before + 1);
    }
    setNetwork((_request, response) => {response.writeHead(409, {'content-type': 'application/json'}); response.end(JSON.stringify({error: 'reconciliation_pending', debug: 'private'}));});
    assert.deepEqual((await call(`/${id}/changes/${changeId}/reconcile`, {method: 'POST', body: {}})).json(), {error: 'reconciliation_pending'});
    setNetwork((_request, response) => {response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({change: {id: changeId, status: 'applied', before: {name: 'Old'}, after: {name: 'New'}, password: 'private', internal: {url: 'private'}}}));});
    assert.deepEqual((await call(`/${id}/changes/${changeId}`)).json(), {change: {id: changeId, status: 'applied', before: {name: 'Old'}, after: {name: 'New'}}});
    setNetwork((_request, response) => {response.writeHead(200, {'content-type': 'application/json'}); response.end(JSON.stringify({routers: [{id, siteName: 'Kuwadzana', password: 'private', url: 'private', username: 'private'}]}));});
    assert.deepEqual((await call()).json(), {routers: [{id, siteName: 'Kuwadzana'}]});
  });
});

test('production capability requires a valid HTTPS service origin and private signing key', () => {
  const saved = {...process.env};
  try {
    Object.assign(process.env, {PAMOFI_ROUTER_FLEET_ENABLED: 'true', PAMOFI_ROUTER_FLEET_WRITE_ENABLED: 'true', INTERNAL_NETWORK_SECRET: secret});
    for (const value of ['http://network.internal', 'https://user:pass@network.internal', 'https://network.internal/path', 'https://network.internal?command=reboot']) {
      process.env.NETWORK_URL = value; assert.equal(routerFleetCapabilities(false).routerFleet, false);
    }
    process.env.NETWORK_URL = 'https://network.internal'; assert.equal(routerFleetCapabilities(false).routerFleet, true);
    assert.equal(routerFleetCapabilities(false, false).routerFleet, false);
    process.env.INTERNAL_NETWORK_SECRET = 'DEMO_ONLY_' + 'x'.repeat(32); assert.equal(routerFleetCapabilities(false).routerFleet, false);
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
});
