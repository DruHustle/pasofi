import { api, ApiError } from './api';

// A retry secret can recreate its session cookie. Never put it in a URL or localStorage.
const storageKey = 'pamofi.sessionCreationRetry';
type Session = { customerId: string };
const customerIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validSession(value: Session): string {
  if (!value || !customerIdPattern.test(value.customerId)) throw Error('invalid_session');
  return value.customerId;
}
function retryKey(): string {
  const existing = sessionStorage.getItem(storageKey);
  if (existing) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(existing)) throw Error('invalid_retry_key');
    return existing;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const value = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // If storage is unavailable, fail before creating an account whose retry credential could be lost.
  sessionStorage.setItem(storageKey, value);
  return value;
}
function clearCreationKey() { try { sessionStorage.removeItem(storageKey); } catch { /* An existing cookie still works without storage. */ } }

export async function currentSession(): Promise<string> { return validSession(await api<Session>('/api/session')); }
let creating: Promise<string> | null = null;
export function ensureSession(): Promise<string> {
  if (creating) return creating;
  creating = (async () => {
    try { const id = await currentSession(); clearCreationKey(); return id; }
    catch (error) { if (!(error instanceof ApiError) || error.status !== 401) throw error; }
    const created = validSession(await api<Session>('/api/session', { method: 'POST', headers: { 'Idempotency-Key': retryKey() } }));
    const confirmed = await currentSession();
    if (confirmed !== created) throw Error('session_changed');
    clearCreationKey();
    return confirmed;
  })().finally(() => { creating = null; });
  return creating;
}

type SessionChange = 'signed_out' | 'recovered';
const channel = (() => { try { return typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('pamofi.session') : null; } catch { return null; } })();
export function clearSessionSecrets() {
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key === storageKey || key.startsWith('pamofi.orderRetry:')) sessionStorage.removeItem(key);
    }
  } catch { /* No stored secrets are available when storage is disabled. */ }
}
export function announceSessionChange(change: SessionChange) { channel?.postMessage(change); }
export function onSessionChange(listener: (change: SessionChange) => void): () => void {
  const receive = (event: MessageEvent) => {
    if (event.data === 'signed_out' || event.data === 'recovered') { clearSessionSecrets(); listener(event.data); }
  };
  channel?.addEventListener('message', receive);
  return () => channel?.removeEventListener('message', receive);
}

type Intent = { key: string; orderId?: string };
const intentStorageKey = (customerId: string, bundleId: string) => `pamofi.orderRetry:${customerId}:${bundleId}`;
export function orderIntent(customerId: string, bundleId: string): Intent | null {
  const saved = sessionStorage.getItem(intentStorageKey(customerId, bundleId));
  if (!saved) return null;
  const value = JSON.parse(saved) as Intent;
  if (!value || !/^[A-Za-z0-9_-]{16,128}$/.test(value.key) || (value.orderId && !customerIdPattern.test(value.orderId))) throw Error('invalid_order_retry');
  return value;
}
export function saveOrderIntent(customerId: string, bundleId: string, intent: Intent) { sessionStorage.setItem(intentStorageKey(customerId, bundleId), JSON.stringify(intent)); }
export function clearOrderIntent(customerId: string, bundleId: string) { sessionStorage.removeItem(intentStorageKey(customerId, bundleId)); }
