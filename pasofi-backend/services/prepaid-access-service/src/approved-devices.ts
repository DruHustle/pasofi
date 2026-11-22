import {SignJWT} from 'jose';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {boundedJson, networkConfiguration} from './router-fleet.js';

type Staff = {staffId: string; role: 'admin'|'agent'|'support'; version: number; mfaVerified: boolean};
type StaffGuard = (request: FastifyRequest, reply: FastifyReply, roles: Staff['role'][]) => Promise<Staff|null>;
type Action = 'list'|'add'|'remove'|'sync';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERROR_CODES = new Set([
  'not_found', 'invalid_request', 'invalid_mac_address', 'broadcast_mac_address', 'multicast_mac_address',
  'invalid_label', 'invalid_reason', 'device_exists', 'allowlist_full', 'device_not_active',
  'idempotency_conflict', 'allowlist_writes_disabled', 'unavailable',
]);
const ROUTER_STATES = new Set(['applied', 'conflict', 'missing', 'pending', 'not_configured']);
const ROUTER_STATUSES = new Set(['synced', 'attention', 'unreachable', 'pending', 'not_configured']);
const EVENT_TYPES = new Set(['added', 'removed', 'router_binding_added', 'router_binding_removed']);

export function approvedDeviceCapabilities(demo: boolean, available = true) {
  const approvedDevices = available && process.env.PAMOFI_APPROVED_DEVICES_ENABLED === 'true' && !!networkConfiguration(demo);
  return {approvedDevices, approvedDevicesWrite: approvedDevices && process.env.PAMOFI_APPROVED_DEVICES_WRITE_ENABLED === 'true'};
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => object(value) && Object.keys(value).every(key => keys.includes(key));
const control = /[\u0000-\u001f\u007f]/;
// Shape checks only. The network service owns MAC normalization (case,
// separators, broadcast/multicast) and returns a specific reviewed error code.
const macShape = (value: unknown): value is string => typeof value === 'string' && value.trim().length >= 12 && value.trim().length <= 17 && /^[0-9A-Fa-f:.-]+$/.test(value.trim());
const labelShape = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && [...value.trim()].length <= 80 && !control.test(value);
const reasonShape = (value: unknown): value is string => typeof value === 'string' && value.trim().length >= 10 && Buffer.byteLength(value) <= 500 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
function requestKey(request: FastifyRequest) {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}
function fail(): never { throw Error('unavailable'); }
function text(value: unknown, max: number, nullable = false): string|null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length > max || control.test(value)) fail();
  return value;
}
function id(value: unknown, nullable = false) { const result = text(value, 36, nullable); if (result !== null && !UUID.test(result)) fail(); return result; }
function count(value: unknown) { if (!Number.isSafeInteger(value) || (value as number) < 0) fail(); return value as number; }
function list<T>(value: unknown, max: number, project: (item: Record<string, unknown>) => T) {
  if (!Array.isArray(value) || value.length > max) fail();
  return value.map(item => { if (!object(item)) fail(); return project(item); });
}
function one(value: unknown, allowed: Set<string>) { if (typeof value !== 'string' || !allowed.has(value)) fail(); return value; }
function device(item: Record<string, unknown>) {
  return {id: id(item.id), macAddress: text(item.macAddress, 17), label: text(item.label, 400), createdBy: id(item.createdBy), createdAt: text(item.createdAt, 64),
    ...(item.removedAt === undefined ? {} : {removedAt: text(item.removedAt, 64)})};
}
// Projection keeps only reviewed fields. RouterOS URLs, usernames, passwords,
// raw router replies and internal details never leave the network service.
function publicData(action: Action, data: Record<string, unknown>) {
  if (typeof data.syncing !== 'boolean') fail();
  if (action === 'sync') return {syncing: data.syncing};
  if (action !== 'list') { if (!object(data.device)) fail(); return {device: device(data.device), syncing: data.syncing}; }
  if (!Number.isSafeInteger(data.maxDevices) || typeof data.writesEnabled !== 'boolean' || typeof data.registryAvailable !== 'boolean') fail();
  return {
    devices: list(data.devices, 500, item => ({...device(item), routers: list(item.routers, 500, router => ({
      nasId: id(router.nasId), state: one(router.state, ROUTER_STATES), observedAt: text(router.observedAt, 64, true)}))})),
    routers: list(data.routers, 500, router => ({id: id(router.id), siteName: text(router.siteName, 200, true), clientName: text(router.clientName, 200, true),
      configured: router.configured === true, status: one(router.status, ROUTER_STATUSES), errorCode: text(router.errorCode, 64, true),
      attemptedAt: text(router.attemptedAt, 64, true), syncedAt: text(router.syncedAt, 64, true), conflicts: count(router.conflicts), pendingRemovals: count(router.pendingRemovals)})),
    events: list(data.events, 50, event => ({id: id(event.id), entryId: id(event.entryId), type: one(event.type, EVENT_TYPES), actorId: id(event.actorId),
      nasId: id(event.nasId, true), macAddress: text(event.macAddress, 17, true), label: text(event.label, 400, true), reason: text(event.reason, 600, true), createdAt: text(event.createdAt, 64)})),
    maxDevices: data.maxDevices, writesEnabled: data.writesEnabled, registryAvailable: data.registryAvailable, syncing: data.syncing,
  };
}

// Browser authentication ends here: only an approved, MFA-verified PasoFi
// administrator reaches network, using a short-lived service token carrying
// the server-derived actor. Cookies and caller-supplied router details stay out.
export function registerApprovedDevices(app: FastifyInstance, demo: boolean, guard: StaffGuard) {
  const register = (method: 'GET'|'POST', suffix: string, action: Action) => {
    app.route<{Params: {id?: string}}>({
      method, url: `/v1/admin/approved-devices${suffix}`,
      config: {rateLimit: {max: method === 'GET' ? 90 : 20, timeWindow: '1 minute'}},
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const capabilities = approvedDeviceCapabilities(demo);
        if (!capabilities.approvedDevices) return reply.code(404).send({error: 'approved_devices_disabled'});
        const staff = await guard(request, reply, ['admin']);
        if (!staff) return;
        if (staff.role !== 'admin' || !staff.mfaVerified || !UUID.test(staff.staffId) || !Number.isSafeInteger(staff.version) || staff.version < 1) return reply.code(403).send({error: 'forbidden'});
        const deviceId = request.params.id;
        if ((deviceId !== undefined && !UUID.test(deviceId)) || !exact(request.query, []) || (method === 'GET' && request.body !== undefined)) return reply.code(400).send({error: 'invalid_request'});
        if (action !== 'list' && !capabilities.approvedDevicesWrite) return reply.code(409).send({error: 'writes_disabled'});
        let body: Record<string, unknown>|undefined;
        const input = request.body, key = requestKey(request);
        if (action === 'add') {
          if (!key || !exact(input, ['macAddress', 'label', 'reason']) || !macShape(input.macAddress) || !labelShape(input.label) || !reasonShape(input.reason)) return reply.code(400).send({error: 'invalid_request'});
          body = {macAddress: input.macAddress.trim(), label: input.label.trim(), reason: input.reason.trim(), requestKey: key};
        } else if (action === 'remove') {
          if (!key || !exact(input, ['reason']) || !reasonShape(input.reason)) return reply.code(400).send({error: 'invalid_request'});
          body = {reason: input.reason.trim(), requestKey: key};
        } else if (action === 'sync') {
          if (input !== undefined && !exact(input, [])) return reply.code(400).send({error: 'invalid_request'});
          body = {};
        }
        const configured = networkConfiguration(demo);
        if (!configured) return reply.code(503).send({error: 'approved_devices_unavailable'});
        const path = action === 'list' ? '/internal/v1/device-allowlist' : action === 'add' ? '/internal/v1/device-allowlist/devices'
          : action === 'sync' ? '/internal/v1/device-allowlist/sync' : `/internal/v1/device-allowlist/devices/${deviceId!.toLowerCase()}/remove`;
        try {
          const token = await new SignJWT({scope: method === 'GET' ? 'device-allowlist:read' : 'device-allowlist:write', actorId: staff.staffId.toLowerCase(), actorVersion: String(staff.version)})
            .setProtectedHeader({alg: 'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('network')
            .setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(configured.secret));
          // Changes are durable in network before any router write. A lost
          // reply is not retried here; the browser repeats its idempotency key.
          const response = await fetch(new URL(path, configured.url), {
            method, headers: {authorization: `Bearer ${token}`, ...(body ? {'content-type': 'application/json'} : {})},
            ...(body ? {body: JSON.stringify(body)} : {}), redirect: 'error', signal: AbortSignal.timeout(8000),
          });
          const data = await boundedJson(response);
          if (!response.ok) {
            if ([400, 403, 404, 409, 503].includes(response.status) && typeof data.error === 'string' && ERROR_CODES.has(data.error)) return reply.code(response.status).send({error: data.error});
            throw Error('unavailable');
          }
          if (![200, 201, 202].includes(response.status)) throw Error('unavailable');
          return reply.code(response.status).send(publicData(action, data));
        } catch { return reply.code(503).send({error: 'approved_devices_unavailable'}); }
      },
    });
  };
  register('GET', '', 'list');
  register('POST', '', 'add');
  register('POST', '/sync', 'sync');
  register('POST', '/:id/remove', 'remove');
}
