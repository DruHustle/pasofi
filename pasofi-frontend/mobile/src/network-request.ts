// The network authority issues credentials for two minutes. This tab cache
// carries only an idempotency reference; the server still authorizes every replay.
export const networkRequestLifetimeMs = 120_000;
const storageKey = 'pamofi.networkRequest.v1';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type NetworkRequest = { customerId: string; siteId: string; nasId: string; key: string; expiresAt: number };
function valid(value: unknown): value is NetworkRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 5) return false;
  const row = value as Record<string, unknown>, now = Date.now();
  return ['customerId', 'siteId', 'nasId', 'key'].every(key => typeof row[key] === 'string' && uuid.test(row[key] as string))
    && typeof row.expiresAt === 'number' && Number.isSafeInteger(row.expiresAt) && row.expiresAt > now && row.expiresAt <= now + networkRequestLifetimeMs;
}
export function clearNetworkRequest() { try { sessionStorage.removeItem(storageKey); } catch { /* Memory-only retries remain available when tab storage is disabled. */ } }
export function readNetworkRequest(customerId: string): NetworkRequest | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const saved: unknown = raw.length <= 1024 ? JSON.parse(raw) : null;
    if (valid(saved) && saved.customerId === customerId) return saved;
  } catch { /* Malformed or unavailable storage must never authorize a replay. */ }
  clearNetworkRequest();
  return null;
}
export function saveNetworkRequest(request: NetworkRequest) {
  if (!valid(request)) { clearNetworkRequest(); return; }
  // Explicit fields prevent a credential or private replay authority from being
  // included accidentally if a caller later adds fields to its in-memory object.
  const { customerId, siteId, nasId, key, expiresAt } = request;
  try { sessionStorage.setItem(storageKey, JSON.stringify({ customerId, siteId, nasId, key, expiresAt })); } catch { /* Keep the current in-memory request for a safe retry. */ }
}
