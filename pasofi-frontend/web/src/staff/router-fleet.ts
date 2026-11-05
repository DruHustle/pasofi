import { api, ApiError } from '../api';
import { type Staff, messageFor } from '../business';

export type RouterSummary = {
  id: string; siteId: string; siteName: string; clientName: string;
  customerNetworkEnabled: boolean; configured: boolean; writesEnabled: boolean;
};
export type RouterTargetKind = 'identity' | 'interface' | 'wireless' | 'wifi' | 'hotspot-profile';
export type RouterValues = Record<string, string | boolean>;
export type RouterField = { key: string; label: string; type: 'text' | 'boolean'; maxLength?: number; help?: string };
export type RouterTarget = {
  key: string; kind: RouterTargetKind; name?: string; values: RouterValues; revision: string; fields: RouterField[];
};
export type RouterSnapshot = {
  router: RouterSummary; device: { identity: string; model: string; version: string; serial: string };
  targets: RouterTarget[]; observedAt: string;
};
export type RouterChangeStatus = 'prepared' | 'applying' | 'applied' | 'unchanged' | 'diverged' | 'uncertain' | 'expired' | 'failed';
export type RouterChange = {
  id: string; nasId: string; actorId: string; actorVersion: string;
  targetKey: string; targetKind: RouterTargetKind; targetName?: string;
  before: RouterValues; after: RouterValues; beforeRevision: string; afterRevision: string;
  status: RouterChangeStatus; reason: string; createdAt: string; updatedAt: string; expiresAt: string;
  appliedAt: string | null; parentChangeId: string | null; errorCode: string | null; reconcileAfter: string | null;
};
export type RouterPreview = { targetKey: string; expectedRevision: string; values: RouterValues; reason: string };

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const revision = /^[a-f0-9]{64}$/;
const targetKey = /^[a-z][a-z0-9_-]{0,47}$/;
const allowedKeys: Record<RouterTargetKind, Record<string, 'text' | 'boolean'>> = {
  identity: { name: 'text' }, interface: { comment: 'text' },
  wireless: { ssid: 'text', disabled: 'boolean' }, wifi: { 'configuration.ssid': 'text', disabled: 'boolean' },
  'hotspot-profile': { 'rate-limit': 'text', 'idle-timeout': 'text', 'keepalive-timeout': 'text' },
};
const statuses = new Set<RouterChangeStatus>(['prepared', 'applying', 'applied', 'unchanged', 'diverged', 'uncertain', 'expired', 'failed']);
const invalid = () => new ApiError(502, 'invalid_router_response');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 256, allowEmpty = true): string {
  if (typeof value !== 'string' || value.length > limit || (!allowEmpty && !value)) throw invalid();
  return value;
}
function id(value: unknown): string {
  const result = text(value, 36, false); if (!uuid.test(result)) throw invalid(); return result.toLowerCase();
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') throw invalid(); return value; }
function timestamp(value: unknown): string {
  const result = text(value, 64, false); if (!Number.isFinite(Date.parse(result))) throw invalid(); return result;
}
function actorVersion(value: unknown): string {
  const result = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof result !== 'string' || !/^[1-9][0-9]{0,18}$/.test(result)) throw invalid();
  return result;
}
function kind(value: unknown): RouterTargetKind {
  if (typeof value !== 'string' || !Object.hasOwn(allowedKeys, value)) throw invalid();
  return value as RouterTargetKind;
}
function values(value: unknown, targetKind: RouterTargetKind): RouterValues {
  const data = object(value), keys = Object.keys(data);
  if (!keys.length || keys.length > Object.keys(allowedKeys[targetKind]).length) throw invalid();
  const result: RouterValues = {};
  for (const key of keys) {
    if (!Object.hasOwn(allowedKeys[targetKind], key)) throw invalid();
    result[key] = allowedKeys[targetKind][key] === 'boolean' ? boolean(data[key]) : text(data[key], 1024);
  }
  return result;
}
function parseSummary(value: unknown): RouterSummary {
  const item = object(value);
  return { id: id(item.id), siteId: id(item.siteId), siteName: text(item.siteName, 200), clientName: text(item.clientName, 200),
    customerNetworkEnabled: boolean(item.customerNetworkEnabled), configured: boolean(item.configured), writesEnabled: boolean(item.writesEnabled) };
}
function parseTarget(value: unknown): RouterTarget {
  const item = object(value), targetKind = kind(item.kind), current = values(item.values, targetKind);
  if (typeof item.key !== 'string' || !targetKey.test(item.key) || typeof item.revision !== 'string' || !revision.test(item.revision)
    || !Array.isArray(item.fields) || item.fields.length !== Object.keys(current).length) throw invalid();
  const seen = new Set<string>();
  const fields = item.fields.map((value): RouterField => {
    const field = object(value), key = text(field.key, 64, false);
    if (!Object.hasOwn(current, key) || seen.has(key) || field.type !== allowedKeys[targetKind][key]) throw invalid();
    seen.add(key);
    if (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || Number(field.maxLength) < 1 || Number(field.maxLength) > 1024)) throw invalid();
    return { key, label: text(field.label, 100, false), type: field.type as 'text' | 'boolean',
      ...(field.maxLength === undefined ? {} : { maxLength: Number(field.maxLength) }),
      ...(field.help === undefined ? {} : { help: text(field.help, 500) }) };
  });
  return { key: item.key, kind: targetKind, ...(item.name === undefined ? {} : { name: text(item.name, 256) }), values: current, revision: item.revision, fields };
}
export function parseRouterList(value: unknown): RouterSummary[] {
  const data = object(value); if (!Array.isArray(data.routers) || data.routers.length > 1000) throw invalid();
  const routers = data.routers.map(parseSummary);
  if (new Set(routers.map(router => router.id)).size !== routers.length) throw invalid();
  return routers;
}
export function parseRouterSnapshot(value: unknown, routerId: string): RouterSnapshot {
  const data = object(value), router = parseSummary(data.router), device = object(data.device);
  if (router.id !== routerId || !Array.isArray(data.targets) || data.targets.length > 256) throw invalid();
  const targets = data.targets.map(parseTarget);
  if (new Set(targets.map(target => target.key)).size !== targets.length) throw invalid();
  return { router, device: { identity: text(device.identity), model: text(device.model), version: text(device.version), serial: text(device.serial) },
    targets, observedAt: timestamp(data.observedAt) };
}
function parseChange(value: unknown, routerId: string): RouterChange {
  const item = object(value), targetKind = kind(item.targetKind), before = values(item.before, targetKind), after = values(item.after, targetKind);
  if (id(item.nasId) !== routerId || typeof item.targetKey !== 'string' || !targetKey.test(item.targetKey)
    || typeof item.beforeRevision !== 'string' || !revision.test(item.beforeRevision) || typeof item.afterRevision !== 'string' || !revision.test(item.afterRevision)
    || !statuses.has(item.status as RouterChangeStatus)
    || Object.keys(before).length !== Object.keys(after).length || Object.keys(before).some(key => !Object.hasOwn(after, key))) throw invalid();
  return { id: id(item.id), nasId: routerId, actorId: id(item.actorId), actorVersion: actorVersion(item.actorVersion), targetKey: item.targetKey,
    targetKind, ...(item.targetName === undefined || item.targetName === null ? {} : { targetName: text(item.targetName, 256) }), before, after,
    beforeRevision: item.beforeRevision, afterRevision: item.afterRevision, status: item.status as RouterChangeStatus,
    reason: text(item.reason, 500, false), createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt), expiresAt: timestamp(item.expiresAt),
    appliedAt: item.appliedAt === null ? null : timestamp(item.appliedAt), parentChangeId: item.parentChangeId === null ? null : id(item.parentChangeId),
    errorCode: item.errorCode === null ? null : text(item.errorCode, 100), reconcileAfter: item.reconcileAfter === null ? null : timestamp(item.reconcileAfter) };
}
export function parseRouterChange(value: unknown, routerId: string, changeId?: string): RouterChange {
  const change = parseChange(object(value).change, routerId); if (changeId && change.id !== changeId) throw invalid(); return change;
}
export function parseRouterHistory(value: unknown, routerId: string): RouterChange[] {
  const data = object(value); if (!Array.isArray(data.changes) || data.changes.length > 50) throw invalid();
  return data.changes.map(change => parseChange(change, routerId));
}
export const routerPath = (routerId: string) => `/api/admin/routers/${encodeURIComponent(id(routerId))}`;
export const routerChangePath = (routerId: string, changeId: string) => `${routerPath(routerId)}/changes/${encodeURIComponent(id(changeId))}`;

export async function verifyRouterAdministrator(staff: Staff, signal?: AbortSignal) {
  const current = await api<Staff>('/api/staff/session', { signal });
  if (current.staffId !== staff.staffId || current.version !== staff.version || current.status !== 'approved' || current.role !== 'admin' || current.mfaVerified !== true) {
    throw new ApiError(401, 'staff_changed');
  }
}
export const routerKindLabel: Record<RouterTargetKind, string> = {
  identity: 'Router identity', interface: 'Interface note', wireless: 'Guest Wi-Fi', wifi: 'Guest Wi-Fi', 'hotspot-profile': 'Hotspot profile',
};
export const routerChangeLabel: Record<RouterChangeStatus, string> = {
  prepared: 'Ready for review', applying: 'Applying', applied: 'Applied and verified', unchanged: 'No change observed',
  diverged: 'Needs review', uncertain: 'Outcome uncertain', expired: 'Preview expired', failed: 'Change failed',
};
export const routerChangeSettled = (change: RouterChange) => ['applied', 'unchanged', 'diverged', 'expired', 'failed'].includes(change.status);
export const routerChangePending = (change: RouterChange) => change.status === 'applying' || change.status === 'uncertain';
export const routerValueText = (key: string, value: string | boolean) => key === 'disabled' && typeof value === 'boolean'
  ? value ? 'Disabled' : 'Enabled' : typeof value === 'boolean' ? value ? 'Yes' : 'No' : value || 'Not set';
export function routerFieldError(target: RouterTarget, draft: RouterValues): string | null {
  for (const field of target.fields) {
    const value = draft[field.key];
    if (field.type === 'boolean') { if (typeof value !== 'boolean') return `Check ${field.label.toLowerCase()}.`; }
    else if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return `Check ${field.label.toLowerCase()}.`;
    else if (field.maxLength !== undefined && new TextEncoder().encode(value).length > field.maxLength) return `${field.label} is too long. Use a shorter value.`;
    else if (!['comment', 'rate-limit'].includes(field.key) && !value.trim()) return `Enter ${field.label.toLowerCase()}.`;
  }
  if (target.fields.every(field => draft[field.key] === target.values[field.key])) return 'Change at least one setting before reviewing it.';
  return null;
}
export function routerMessage(error: unknown, fallback?: string): string {
  if (!(error instanceof ApiError)) return fallback ?? 'The router service could not be reached. Check the recorded outcome before trying another change.';
  const messages: Record<string, string> = {
    unavailable: 'Router management is unavailable. Check the service connection and try again.',
    router_fleet_unavailable: 'The router management response was interrupted. Check the saved change outcome before trying another change.',
    fleet_disabled: 'Router management is not enabled. Refresh the router service status.',
    writes_disabled: 'Configuration changes are paused. Inspection and recorded change history remain available.',
    target_unavailable: 'This configuration area is no longer available. Refresh the router to inspect its current settings.',
    configuration_changed: 'The registered management settings changed. Refresh the router before reviewing a new change.',
    router_unavailable: 'The private connection to this router could not be verified. Refresh its status when the connection is restored.',
    router_not_configured: 'Private management is not configured for this router yet.',
    device_mismatch: 'The connected device does not match this router’s registered identity. Ask the operator to review the connection.',
    fleet_writes_disabled: 'Configuration changes are disabled for this router. Inspection and recorded change history remain available.',
    revision_conflict: 'The router settings changed after this view was captured. Refresh the router and review a new change.',
    router_busy: 'Another router change needs to finish or be reconciled first. Check its recorded outcome.',
    idempotency_conflict: 'This request does not match its saved preview. Check change history before preparing another one.',
    change_expired: 'This preview expired. Refresh the router and review a new change.',
    change_not_ready: 'This change cannot be applied in its current state. Check its recorded outcome.',
    actor_mismatch: 'Only the administrator who prepared this change can apply it. Refresh your staff access.',
    invalid_values: 'Check the proposed values and the field guidance before reviewing again.',
    invalid_request: 'Check the proposed values and reason before reviewing again.',
    reconciliation_pending: 'The router operation is still inside its verification window. Refresh its recorded status after the displayed time.',
    invalid_router_response: 'The router response could not be verified. Refresh before making a change.',
    not_found: 'This router or change is no longer available. Refresh the router list.',
  };
  return messages[error.code] ?? messageFor(error, fallback);
}

// Only known change IDs are retained. Configuration values, reasons and router
// credentials never enter browser storage. A pending marker prevents an
// interrupted apply from becoming a fresh write when this view is reopened.
export function routerChangeStorage(staffId: string, routerId: string, pending = false) {
  return `pamofi.operation:staff:${staffId}:router-${routerId}:${pending ? 'pending-change' : 'viewed-change'}`;
}
export function rememberedRouterChange(staffId: string, routerId: string, pending = false): string | null {
  try { const value = sessionStorage.getItem(routerChangeStorage(staffId, routerId, pending)); return value && uuid.test(value) ? value.toLowerCase() : null; }
  catch { return null; }
}
export function rememberRouterChange(staffId: string, routerId: string, changeId: string | null, pending = false) {
  try {
    const key = routerChangeStorage(staffId, routerId, pending);
    if (changeId === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, id(changeId));
  } catch { /* The server’s change history still records an operation if storage is unavailable. */ }
}
