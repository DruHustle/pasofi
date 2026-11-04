/** Pure lifecycle rules. Persistence, trusted accounting evidence and locking are not yet wired. */
export type Entitlement = {
  id: string; purchasedAt: number; startBy: number; validitySeconds: number;
  byteLimit: bigint; consumedBytes: bigint; activatedAt: number | null;
};
export type AccessState = 'queued' | 'active' | 'expired' | 'exhausted' | 'start-by-missed';
function validate(e: Entitlement) {
  if (!e.id || !Number.isSafeInteger(e.purchasedAt) || !Number.isSafeInteger(e.startBy) ||
      !Number.isSafeInteger(e.validitySeconds) || e.validitySeconds <= 0 ||
      e.startBy < e.purchasedAt || !Number.isSafeInteger(e.validitySeconds * 1000) || e.byteLimit <= 0n || e.consumedBytes < 0n ||
      e.consumedBytes > e.byteLimit || (e.activatedAt !== null && (!Number.isSafeInteger(e.activatedAt) || e.activatedAt < e.purchasedAt || e.activatedAt > e.startBy || !Number.isSafeInteger(e.activatedAt + e.validitySeconds * 1000)))) {
    throw new RangeError('invalid entitlement');
  }
}
export function accessState(e: Entitlement, now: number): AccessState {
  validate(e);
  if (!Number.isSafeInteger(now)) throw new RangeError('invalid time');
  if (e.activatedAt === null) return now > e.startBy ? 'start-by-missed' : 'queued';
  if (e.consumedBytes >= e.byteLimit) return 'exhausted';
  if (now >= e.activatedAt + e.validitySeconds * 1000) return 'expired';
  return 'active';
}
/** Caller must authenticate trusted evidence and serialize customer state first.
 * This function must never be called for Access-Accept alone. */
export function activateOnConnection(items: Entitlement[], connectedAt: number, observedAt: number): Entitlement[] {
  if (!Number.isSafeInteger(connectedAt) || !Number.isSafeInteger(observedAt) || connectedAt > observedAt) throw new RangeError('invalid connection evidence');
  for (const item of items) validate(item);
  if (items.some(item => item.activatedAt !== null && item.activatedAt > connectedAt)) throw new RangeError('stale connection evidence');
  if (items.some(item => accessState(item, connectedAt) === 'active')) return items;
  const next = items.filter(item => item.activatedAt === null && item.purchasedAt <= connectedAt && item.startBy >= connectedAt)
    .sort((a,b) => a.purchasedAt - b.purchasedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
  return next ? items.map(item => item === next ? { ...item, activatedAt: connectedAt } : item) : items;
}
