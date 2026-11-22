import { ApiError } from '../api';
import { messageFor } from '../business';

export type DeviceRouterState = 'applied' | 'conflict' | 'missing' | 'pending' | 'not_configured';
export type RouterSyncStatus = 'synced' | 'attention' | 'unreachable' | 'pending' | 'not_configured';
export type ApprovedDevice = {
  id: string; macAddress: string; label: string; createdBy: string; createdAt: string;
  routers: { nasId: string; state: DeviceRouterState; observedAt: string | null }[];
};
export type AllowlistRouter = {
  id: string; siteName: string | null; clientName: string | null; configured: boolean; status: RouterSyncStatus;
  errorCode: string | null; attemptedAt: string | null; syncedAt: string | null; conflicts: number; pendingRemovals: number;
};
export type AllowlistEvent = {
  id: string; entryId: string; type: 'added' | 'removed' | 'router_binding_added' | 'router_binding_removed';
  actorId: string; nasId: string | null; macAddress: string | null; label: string | null; reason: string | null; createdAt: string;
};
export type Allowlist = {
  devices: ApprovedDevice[]; routers: AllowlistRouter[]; events: AllowlistEvent[];
  maxDevices: number; writesEnabled: boolean; registryAvailable: boolean; syncing: boolean;
};

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const states = new Set<DeviceRouterState>(['applied', 'conflict', 'missing', 'pending', 'not_configured']);
const statuses = new Set<RouterSyncStatus>(['synced', 'attention', 'unreachable', 'pending', 'not_configured']);
const eventTypes = new Set<AllowlistEvent['type']>(['added', 'removed', 'router_binding_added', 'router_binding_removed']);
const invalid = () => new ApiError(502, 'invalid_allowlist_response');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): string { if (typeof value !== 'string' || value.length > limit) throw invalid(); return value; }
function optional(value: unknown, limit: number): string | null { return value === null ? null : text(value, limit); }
function id(value: unknown): string { const result = text(value, 36); if (!uuid.test(result)) throw invalid(); return result.toLowerCase(); }
function optionalId(value: unknown): string | null { return value === null ? null : id(value); }
function time(value: unknown): string { const result = text(value, 64); if (!Number.isFinite(Date.parse(result))) throw invalid(); return result; }
function optionalTime(value: unknown): string | null { return value === null ? null : time(value); }
function count(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(); return value as number; }
function list<T>(value: unknown, max: number, project: (item: Record<string, unknown>) => T): T[] {
  if (!Array.isArray(value) || value.length > max) throw invalid();
  return value.map(item => project(object(item)));
}
function member<T extends string>(value: unknown, allowed: Set<T>): T { if (typeof value !== 'string' || !allowed.has(value as T)) throw invalid(); return value as T; }

export function parseAllowlist(value: unknown): Allowlist {
  const data = object(value);
  if (!Number.isSafeInteger(data.maxDevices) || typeof data.writesEnabled !== 'boolean' || typeof data.registryAvailable !== 'boolean' || typeof data.syncing !== 'boolean') throw invalid();
  return {
    devices: list(data.devices, 500, item => {
      const mac = text(item.macAddress, 17); if (!/^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(mac)) throw invalid();
      return { id: id(item.id), macAddress: mac, label: text(item.label, 400), createdBy: id(item.createdBy), createdAt: time(item.createdAt),
        routers: list(item.routers, 500, router => ({ nasId: id(router.nasId), state: member(router.state, states), observedAt: optionalTime(router.observedAt) })) };
    }),
    routers: list(data.routers, 500, item => ({
      id: id(item.id), siteName: optional(item.siteName, 200), clientName: optional(item.clientName, 200), configured: item.configured === true,
      status: member(item.status, statuses), errorCode: optional(item.errorCode, 64), attemptedAt: optionalTime(item.attemptedAt), syncedAt: optionalTime(item.syncedAt),
      conflicts: count(item.conflicts), pendingRemovals: count(item.pendingRemovals),
    })),
    events: list(data.events, 50, item => ({
      id: id(item.id), entryId: id(item.entryId), type: member(item.type, eventTypes), actorId: id(item.actorId), nasId: optionalId(item.nasId),
      macAddress: optional(item.macAddress, 17), label: optional(item.label, 400), reason: optional(item.reason, 600), createdAt: time(item.createdAt),
    })),
    maxDevices: data.maxDevices as number, writesEnabled: data.writesEnabled, registryAvailable: data.registryAvailable, syncing: data.syncing,
  };
}

// Mirrors the network service so mistakes are explained before submitting.
// The service remains authoritative and repeats every check.
export function normalizeMac(value: string): { mac: string } | { error: string } {
  const raw = value.trim(); let hex: string;
  if (/^[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}$/.test(raw)) hex = raw.replace(/[:-]/g, '');
  else if (/^[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}$/.test(raw)) hex = raw.replace(/\./g, '');
  else if (/^[0-9A-Fa-f]{12}$/.test(raw)) hex = raw;
  else return { error: 'invalid_mac_address' };
  hex = hex.toUpperCase();
  if (hex === '000000000000') return { error: 'invalid_mac_address' };
  if (hex === 'FFFFFFFFFFFF') return { error: 'broadcast_mac_address' };
  if (parseInt(hex.slice(0, 2), 16) & 1) return { error: 'multicast_mac_address' };
  return { mac: hex.match(/../g)!.join(':') };
}
export function labelValid(value: string) { const label = value.trim(); return !!label && [...label].length <= 80 && !/[\u0000-\u001f\u007f]/.test(value); }
export function reasonValid(value: string) { return value.trim().length >= 10 && new TextEncoder().encode(value).length <= 500; }

const messages: Record<string, string> = {
  invalid_mac_address: 'Enter the device’s Wi-Fi MAC address, for example 3C:22:FB:12:34:56.',
  broadcast_mac_address: 'FF:FF:FF:FF:FF:FF is the broadcast address. It cannot identify one device.',
  multicast_mac_address: 'This is a multicast address (its first byte is odd), so it cannot identify one device. Check the address in the device’s Wi-Fi details.',
  invalid_label: 'Use a label of 1–80 characters without line breaks.',
  invalid_reason: 'Give a reason of at least 10 characters.',
  invalid_request: 'Check the label, MAC address and reason, then try again.',
  device_exists: 'This MAC address is already approved.',
  allowlist_full: 'The approved list is full. Remove a device before adding another.',
  device_not_active: 'This device was already removed. Refresh the list.',
  not_found: 'This device is no longer on the list. Refresh the list.',
  writes_disabled: 'Changes to approved devices are paused. The list remains visible.',
  allowlist_writes_disabled: 'Changes to approved devices are paused. The list remains visible.',
  approved_devices_disabled: 'Approved devices are not enabled for this service.',
  approved_devices_unavailable: 'Approved devices are temporarily unavailable. A change may still have been saved; refresh before retrying.',
  invalid_allowlist_response: 'The approved device list could not be verified. Refresh to try again.',
};
export function deviceMessage(error: unknown, fallback?: string) {
  if (error instanceof ApiError && error.status !== 401 && error.status !== 429 && messages[error.code]) return messages[error.code];
  if (typeof error === 'string' && messages[error]) return messages[error];
  return messageFor(error, fallback);
}
export function routerName(router: AllowlistRouter) {
  return router.clientName && router.siteName ? `${router.clientName} · ${router.siteName}` : router.siteName ?? router.clientName ?? `Router ${router.id.slice(0, 8)}`;
}
export const stateLabel: Record<DeviceRouterState, string> = {
  applied: 'Active', conflict: 'Existing router rule', missing: 'Not applied', pending: 'Waiting for sync', not_configured: 'Not connected',
};
export const statusLabel: Record<RouterSyncStatus, string> = {
  synced: 'In sync', attention: 'Needs attention', unreachable: 'Unreachable', pending: 'Not synced yet', not_configured: 'Not connected',
};
const routerErrors: Record<string, string> = {
  router_unavailable: 'The router did not answer over its private management connection.',
  verification_unavailable: 'Changes were sent but the router could not be re-checked. Sync again to confirm.',
  write_failed: 'The router did not accept every change.',
  untagged_conflict: 'A device is already covered by a router rule PasoFi does not manage. That rule was left unchanged.',
  not_converged: 'The router did not show the expected result after the changes.',
};
export function routerDetail(router: AllowlistRouter) {
  if (!router.configured) return 'No private management connection is configured for this router, so approved devices are not applied here yet.';
  if (router.status === 'pending') return 'Not synchronized yet.';
  return router.errorCode ? routerErrors[router.errorCode] ?? 'The router needs attention.' : 'Every approved device is applied.';
}
