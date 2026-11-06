export const usageCustomerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const usageEntitlementId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export function usageSnapshot(usedBytes = '0', { customerId = usageCustomerId, allowanceBytes = '5000000000', queuedBytes = '0', entitlementId = usageEntitlementId } = {}) {
  const queued = BigInt(queuedBytes), active = BigInt(allowanceBytes) - queued, used = BigInt(usedBytes);
  const asOf = new Date().toISOString(), startBy = new Date(Date.now() + 86400_000).toISOString();
  const activeCount = active > 0n ? 1 : 0, queuedCount = queued > 0n ? 1 : 0;
  return {
    customerId, asOf,
    totals: { bundleCount: activeCount + queuedCount, allowanceBytes, usedBytes, remainingBytes: String(BigInt(allowanceBytes) - used) },
    active: { bundleCount: activeCount, allowanceBytes: String(active), usedBytes, remainingBytes: String(active - used) },
    queued: { bundleCount: queuedCount, allowanceBytes: queuedBytes, usedBytes: '0', remainingBytes: queuedBytes },
    lifetimeAccountedBytes: usedBytes, reservationOutstandingBytes: '0', lastAccountingAt: used > 0n ? asOf : null,
    session: null as null | { grantId: string; entitlementId: string; siteId: string; nasId?: string | null; state: string; issuedAt: string; deadline: string; lastAccountingAt: string | null; reservedBytes: string; chargedBytes: string; reservationOutstandingBytes: string; disconnectRequested: boolean; accountingAnomaly: boolean; accountingStale: boolean; connected: boolean },
    hold: { active: false, reason: null, since: null }, connectivity: 'none',
    accounting: { expectedIntervalSeconds: 60, staleAfterSeconds: 90, pollAfterSeconds: 5 },
    entitlementUpdates: [{ id: entitlementId, consumed_bytes: usedBytes, activated_at: active > 0n ? asOf : null, revoked_at: null, start_by: startBy, expires_at: active > 0n ? startBy : null }],
  };
}
