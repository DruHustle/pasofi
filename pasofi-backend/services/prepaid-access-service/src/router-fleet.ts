import {SignJWT} from 'jose';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';

type Staff = {staffId: string; role: 'admin'|'agent'|'support'; version: number; mfaVerified: boolean};
type StaffGuard = (request: FastifyRequest, reply: FastifyReply, roles: Staff['role'][]) => Promise<Staff|null>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS = new Set(['name', 'comment', 'ssid', 'configuration.ssid', 'disabled', 'rate-limit', 'idle-timeout', 'keepalive-timeout']);
const ERROR_CODES = new Set([
  'not_found', 'fleet_disabled', 'writes_disabled', 'router_not_configured', 'router_unavailable',
  'target_unavailable', 'device_mismatch', 'invalid_request', 'invalid_values', 'stale_revision',
  'idempotency_conflict', 'change_expired', 'change_not_prepared', 'change_not_applied',
  'actor_mismatch', 'router_busy', 'reconcile_too_soon', 'configuration_changed', 'no_changes',
  'rollback_not_available', 'unavailable', 'rate_limited', 'fleet_writes_disabled',
  'revision_conflict', 'change_not_ready', 'reconciliation_pending',
]);
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).every(key => keys.includes(key));
}
function configuration(demo: boolean) {
  const secret = process.env.INTERNAL_NETWORK_SECRET, base = process.env.NETWORK_URL;
  if (!secret || Buffer.byteLength(secret) < 32 || (!demo && secret.startsWith('DEMO_ONLY_')) || !base) return null;
  try {
    const url = new URL(base);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
        (!demo && url.protocol !== 'https:') || (demo && !['http:', 'https:'].includes(url.protocol))) return null;
    return {url, secret};
  } catch { return null; }
}
export function routerFleetCapabilities(demo: boolean, available = true) {
  const routerFleet = available && process.env.PAMOFI_ROUTER_FLEET_ENABLED === 'true' && !!configuration(demo);
  return {routerFleet, routerFleetWrite: routerFleet && process.env.PAMOFI_ROUTER_FLEET_WRITE_ENABLED === 'true'};
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw Error('unavailable');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length; if (size > 256 * 1024) throw Error('unavailable'); chunks.push(part.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!object(result)) throw Error('unavailable');
  return result;
}
function reason(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 10 && Buffer.byteLength(value) <= 500 && !/[\u0000-\u001f\u007f]/.test(value);
}
function requestKey(request: FastifyRequest) {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}
function flat(value: unknown, keys: string[]): Record<string, unknown> {
  if (!object(value)) throw Error('unavailable');
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) continue;
    const item = value[key];
    if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) throw Error('unavailable');
    result[key] = item;
  }
  return result;
}
function values(value: unknown) {
  if (!object(value) || !Object.keys(value).length || Object.keys(value).some(key => !KEYS.has(key))) throw Error('unavailable');
  const result: Record<string, string|boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' && typeof item !== 'boolean') throw Error('unavailable');
    result[key] = item;
  }
  return result;
}
function array(value: unknown, max: number, project: (value: unknown) => unknown) {
  if (!Array.isArray(value) || value.length > max) throw Error('unavailable');
  return value.map(project);
}
function router(value: unknown) {
  return flat(value, ['id', 'siteId', 'siteName', 'clientName', 'customerNetworkEnabled', 'configured', 'writesEnabled']);
}
function change(value: unknown) {
  if (!object(value)) throw Error('unavailable');
  return {...flat(value, ['id', 'nasId', 'actorId', 'actorVersion', 'targetKey', 'targetKind', 'targetName', 'beforeRevision', 'afterRevision', 'status', 'reason', 'createdAt', 'updatedAt', 'expiresAt', 'appliedAt', 'reconcileAfter', 'parentChangeId', 'errorCode']), before: values(value.before), after: values(value.after)};
}
function publicData(action: string, data: Record<string, unknown>) {
  if (action === 'list') return {routers: array(data.routers, 500, router)};
  if (action === 'history') return {changes: array(data.changes, 50, change)};
  if (action !== 'detail') return {change: change(data.change)};
  if (typeof data.observedAt !== 'string') throw Error('unavailable');
  return {
    router: router(data.router), device: flat(data.device, ['identity', 'model', 'version', 'serial']), observedAt: data.observedAt,
    targets: array(data.targets, 16, target => {
      if (!object(target)) throw Error('unavailable');
      return {...flat(target, ['key', 'kind', 'name', 'revision']), values: values(target.values),
        fields: array(target.fields, 8, field => flat(field, ['key', 'label', 'type', 'maxLength', 'help']))};
    }),
  };
}

// This facade terminates browser authentication. Only short-lived service claims,
// server-derived actor identity, and an exact reviewed operation reach network.
// Neither the browser cookie nor a caller-supplied RouterOS URL is forwarded.
export function registerRouterFleet(app: FastifyInstance, demo: boolean, guard: StaffGuard) {
  type Params = {id?: string; changeId?: string};
  const register = (method: 'GET'|'POST', suffix: string, action: 'list'|'detail'|'history'|'status'|'preview'|'apply'|'reconcile'|'rollback') => {
    app.route<{Params: Params}>({
      method, url: `/v1/admin/routers${suffix}`,
      config: {rateLimit: {max: method === 'GET' ? 90 : 20, timeWindow: '1 minute'}},
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const capabilities = routerFleetCapabilities(demo);
        if (!capabilities.routerFleet) return reply.code(404).send({error: 'fleet_disabled'});
        const staff = await guard(request, reply, ['admin']);
        if (!staff) return;
        if (staff.role !== 'admin' || !staff.mfaVerified || !UUID.test(staff.staffId) || !Number.isSafeInteger(staff.version) || staff.version < 1) return reply.code(403).send({error: 'forbidden'});
        const {id, changeId} = request.params;
        if ((id !== undefined && !UUID.test(id)) || (changeId !== undefined && !UUID.test(changeId)) ||
            !exact(request.query, []) || (method === 'GET' && request.body !== undefined)) return reply.code(400).send({error: 'invalid_request'});
        // Reconciliation only observes the device. Preserve it when writes are
        // paused so a timed-out change can still be resolved safely.
        if (['preview', 'apply', 'rollback'].includes(action) && !capabilities.routerFleetWrite) return reply.code(409).send({error: 'writes_disabled'});
        let body: Record<string, unknown>|undefined;
        if (action === 'preview') {
          const input = request.body, key = requestKey(request);
          if (!key || !exact(input, ['targetKey', 'expectedRevision', 'values', 'reason']) ||
              typeof input.targetKey !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(input.targetKey) ||
              typeof input.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/.test(input.expectedRevision) || !reason(input.reason) ||
              !object(input.values) || !Object.keys(input.values).length || Object.keys(input.values).length > 8 ||
              Object.entries(input.values).some(([key, value]) => !KEYS.has(key) || (typeof value !== 'boolean' && (typeof value !== 'string' || Buffer.byteLength(value) > 160 || /[\u0000-\u001f\u007f]/.test(value))))) return reply.code(400).send({error: 'invalid_request'});
          body = {...input, reason: input.reason.trim(), requestKey: key};
        } else if (action === 'rollback') {
          const input = request.body, key = requestKey(request);
          if (!key || !exact(input, ['reason']) || !reason(input.reason)) return reply.code(400).send({error: 'invalid_request'});
          body = {reason: input.reason.trim(), requestKey: key};
        } else if (method === 'POST') {
          if (!exact(request.body, [])) return reply.code(400).send({error: 'invalid_request'});
          body = {};
        }
        const configured = configuration(demo);
        if (!configured) return reply.code(503).send({error: 'router_fleet_unavailable'});
        const path = `/internal/v1/router-fleet/routers${id ? `/${id.toLowerCase()}` : ''}${['history','preview','status','apply','reconcile','rollback'].includes(action) ? '/changes' : ''}${changeId ? `/${changeId.toLowerCase()}` : ''}${['apply','reconcile','rollback'].includes(action) ? `/${action}` : ''}`;
        try {
          const token = await new SignJWT({scope: method === 'GET' ? 'router-fleet:read' : 'router-fleet:write', actorId: staff.staffId.toLowerCase(), actorVersion: String(staff.version)})
            .setProtectedHeader({alg: 'HS256'}).setIssuer('prepaid-access').setSubject('prepaid-access').setAudience('network')
            .setIssuedAt().setExpirationTime('15s').sign(new TextEncoder().encode(configured.secret));
          // Applying is durable before the router command. A lost upstream reply
          // is deliberately not retried here; clients read the saved change ID.
          const response = await fetch(new URL(path, configured.url), {
            method, headers: {authorization: `Bearer ${token}`, ...(body ? {'content-type': 'application/json'} : {})},
            ...(body ? {body: JSON.stringify(body)} : {}), redirect: 'error', signal: AbortSignal.timeout(30000),
          });
          const data = await boundedJson(response);
          if (!response.ok) {
            if ([400, 403, 404, 409, 429, 503].includes(response.status) && typeof data.error === 'string' && ERROR_CODES.has(data.error)) return reply.code(response.status).send({error: data.error});
            throw Error('unavailable');
          }
          const keys = action === 'list' ? ['routers'] : action === 'detail' ? ['router', 'device', 'targets', 'observedAt'] : action === 'history' ? ['changes'] : ['change'];
          if (![200, 201, 202].includes(response.status) || !exact(data, keys) || keys.some(key => !Object.hasOwn(data, key))) throw Error('unavailable');
          return reply.code(response.status).send(publicData(action, data));
        } catch { return reply.code(503).send({error: 'router_fleet_unavailable'}); }
      },
    });
  };
  register('GET', '', 'list');
  register('GET', '/:id', 'detail');
  register('GET', '/:id/changes', 'history');
  register('POST', '/:id/changes', 'preview');
  register('GET', '/:id/changes/:changeId', 'status');
  register('POST', '/:id/changes/:changeId/apply', 'apply');
  register('POST', '/:id/changes/:changeId/reconcile', 'reconcile');
  register('POST', '/:id/changes/:changeId/rollback', 'rollback');
}
