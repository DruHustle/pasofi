import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { localDate } from './business';

type Allowance = { bundleCount: number; allowanceBytes: string; usedBytes: string; remainingBytes: string };
export type UsageSnapshot = {
  customerId: string; asOf: string; totals: Allowance; active: Allowance; queued: Allowance;
  lifetimeAccountedBytes: string; reservationOutstandingBytes: string; lastAccountingAt: string | null;
  session: null | {
    grantId: string; entitlementId: string; siteId: string; state: 'pending' | 'active' | 'uncertain';
    issuedAt: string; deadline: string; lastAccountingAt: string | null;
    reservedBytes: string; chargedBytes: string; reservationOutstandingBytes: string;
    disconnectRequested: boolean; accountingAnomaly: boolean; accountingStale: boolean; connected: boolean;
  };
  hold: { active: boolean; reason: string | null; since: string | null };
  connectivity: 'none' | 'pending' | 'recent_accounting' | 'stale' | 'uncertain' | 'held';
  accounting: { expectedIntervalSeconds: number; staleAfterSeconds: number; pollAfterSeconds: number };
  entitlementUpdates: { id: string; consumed_bytes: string; activated_at: string | null; revoked_at: string | null; start_by: string; expires_at: string | null }[];
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bytes = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,79})$/.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const optionalDate = (value: unknown) => value === null || date(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function validAllowance(value: unknown): value is Allowance {
  return record(value) && Number.isSafeInteger(value.bundleCount) && Number(value.bundleCount) >= 0 && bytes(value.allowanceBytes) && bytes(value.usedBytes) && bytes(value.remainingBytes)
    && BigInt(value.usedBytes) + BigInt(value.remainingBytes) === BigInt(value.allowanceBytes);
}
function validSnapshot(value: unknown): value is UsageSnapshot {
  if (!record(value) || typeof value.customerId !== 'string' || !uuid.test(value.customerId) || !date(value.asOf)
    || !validAllowance(value.totals) || !validAllowance(value.active) || !validAllowance(value.queued)
    || !bytes(value.lifetimeAccountedBytes) || !bytes(value.reservationOutstandingBytes) || !optionalDate(value.lastAccountingAt)
    || !record(value.hold) || typeof value.hold.active !== 'boolean' || !(value.hold.reason === null || typeof value.hold.reason === 'string') || !optionalDate(value.hold.since)
    || !['none', 'pending', 'recent_accounting', 'stale', 'uncertain', 'held'].includes(String(value.connectivity))
    || !record(value.accounting) || !['expectedIntervalSeconds', 'staleAfterSeconds', 'pollAfterSeconds'].every(key => Number.isSafeInteger(value.accounting && (value.accounting as Record<string, unknown>)[key]) && Number((value.accounting as Record<string, unknown>)[key]) > 0)
    || !Array.isArray(value.entitlementUpdates) || value.entitlementUpdates.length > 101) return false;
  const { totals, active, queued } = value;
  if (totals.bundleCount !== active.bundleCount + queued.bundleCount
    || (['allowanceBytes', 'usedBytes', 'remainingBytes'] as const).some(key => BigInt(totals[key]) !== BigInt(active[key]) + BigInt(queued[key]))) return false;
  if (value.session !== null) {
    const session = value.session;
    if (!record(session) || !['grantId', 'entitlementId', 'siteId'].every(key => typeof session[key] === 'string' && uuid.test(session[key] as string))
      || !['pending', 'active', 'uncertain'].includes(String(session.state)) || !date(session.issuedAt) || !date(session.deadline) || !optionalDate(session.lastAccountingAt)
      || !bytes(session.reservedBytes) || !bytes(session.chargedBytes) || !bytes(session.reservationOutstandingBytes)
      || !['disconnectRequested', 'accountingAnomaly', 'accountingStale', 'connected'].every(key => typeof session[key] === 'boolean')) return false;
  }
  return value.entitlementUpdates.every(item => record(item) && typeof item.id === 'string' && uuid.test(item.id) && bytes(item.consumed_bytes)
    && optionalDate(item.activated_at) && optionalDate(item.revoked_at) && date(item.start_by) && optionalDate(item.expires_at));
}

// Decimal GB, exact integer arithmetic even when an account exceeds Number.MAX_SAFE_INTEGER.
export function dataAmount(value: string) {
  const amount = BigInt(value);
  if (amount > 0n && amount < 1_000_000n) return '<0.001 GB';
  return `${new Intl.NumberFormat().format(amount / 1_000_000_000n)}.${String(amount % 1_000_000_000n / 1_000_000n).padStart(3, '0')} GB`;
}
const elapsedLabel = (seconds: number) => seconds < 5 ? 'just now' : seconds < 60 ? `${Math.floor(seconds)} seconds ago` : seconds < 3600 ? `${Math.floor(seconds / 60)} minutes ago` : `${Math.floor(seconds / 3600)} hours ago`;

export function useLiveUsage(customerId: string | null, active: boolean, entitlementIds: string[], onSnapshot: (snapshot: UsageSnapshot) => void, onSessionInvalid: (customerId: string) => void) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null), [refreshing, setRefreshing] = useState(false), [failed, setFailed] = useState(false);
  const [online, setOnline] = useState(navigator.onLine), [visible, setVisible] = useState(!document.hidden), [clock, setClock] = useState(performance.now());
  const receivedAt = useRef<number | null>(null), generation = useRef(0);
  const latest = useRef({ customerId, active, entitlementIds, onSnapshot, onSessionInvalid }); latest.current = { customerId, active, entitlementIds, onSnapshot, onSessionInvalid };
  const controls = useRef<{ refresh: () => Promise<void>; pause: () => void } | null>(null);
  const refresh = useCallback(() => controls.current?.refresh() ?? Promise.resolve(), []);
  useEffect(() => {
    const owner = customerId, epoch = ++generation.current;
    let requestNumber = 0, controller: AbortController | null = null, inFlight = false, stopped = false, failures = 0, retryAt = 0;
    receivedAt.current = null; setSnapshot(null); setFailed(false); setRefreshing(false);
    const current = () => generation.current === epoch && latest.current.customerId === owner && !stopped;
    const pause = () => { ++requestNumber; controller?.abort(); controller = null; inFlight = false; if (current()) setRefreshing(false); };
    const run = async (force = false) => {
      if (!owner || !current() || (!latest.current.active && !force) || !navigator.onLine || document.hidden) return;
      if (force) { failures = 0; retryAt = 0; }
      else if (performance.now() < retryAt) return;
      if (inFlight && !force) return;
      // A manual or post-mutation refresh supersedes any read that began before the mutation.
      if (inFlight) pause();
      const request = ++requestNumber, abort = new AbortController(); controller = abort; inFlight = true; setRefreshing(true);
      const accepts = () => current() && request === requestNumber && !abort.signal.aborted;
      try {
        const ids = [...new Set(latest.current.entitlementIds)].filter(id => uuid.test(id)).slice(0, 100);
        const result = await api<unknown>(`/api/usage${ids.length ? `?entitlementIds=${encodeURIComponent(ids.join(','))}` : ''}`, { signal: abort.signal });
        if (!accepts()) return;
        if (record(result) && typeof result.customerId === 'string' && result.customerId !== owner) throw new ApiError(401, 'session_changed');
        if (!validSnapshot(result)) throw Error('invalid_usage_snapshot');
        receivedAt.current = performance.now(); failures = 0; retryAt = 0; setClock(receivedAt.current); setSnapshot(result); setFailed(false); latest.current.onSnapshot(result);
      } catch (error) {
        if (!accepts()) return;
        if (error instanceof ApiError && error.status === 401) {
          stopped = true; ++requestNumber; abort.abort(); receivedAt.current = null; setSnapshot(null); setRefreshing(false); latest.current.onSessionInvalid(owner);
        } else {
          ++failures;
          retryAt = performance.now() + Math.max(Math.min(5_000 * 2 ** Math.min(failures - 1, 4), 60_000), error instanceof ApiError ? error.retryAfterMs ?? (error.status === 429 ? 60_000 : 0) : 0);
          setFailed(true); // Keep the last good snapshot, explicitly stale, through malformed or failed reads.
        }
      } finally {
        if (accepts()) { inFlight = false; controller = null; setRefreshing(false); }
      }
    };
    controls.current = { refresh: () => run(true), pause };
    const environmentChanged = () => {
      setOnline(navigator.onLine); setVisible(!document.hidden); setClock(performance.now());
      if (navigator.onLine && !document.hidden && latest.current.active) { if (receivedAt.current !== null) setFailed(true); void run(true); } else pause();
    };
    const focused = () => { if (latest.current.active) { if (receivedAt.current !== null) setFailed(true); void run(true); } };
    window.addEventListener('online', environmentChanged); window.addEventListener('offline', environmentChanged); window.addEventListener('focus', focused); document.addEventListener('visibilitychange', environmentChanged);
    const poll = setInterval(() => { void run(); }, 5_000), ticker = setInterval(() => { if (!document.hidden) setClock(performance.now()); }, 1_000);
    void run();
    return () => {
      ++generation.current; pause(); controls.current = null; clearInterval(poll); clearInterval(ticker);
      window.removeEventListener('online', environmentChanged); window.removeEventListener('offline', environmentChanged); window.removeEventListener('focus', focused); document.removeEventListener('visibilitychange', environmentChanged);
    };
  }, [customerId]);
  const previousActive = useRef(active);
  useEffect(() => {
    if (previousActive.current !== active) { if (active) { if (receivedAt.current !== null) setFailed(true); void refresh(); } else controls.current?.pause(); }
    previousActive.current = active;
  }, [active, refresh]);
  const currentSnapshot = snapshot?.customerId === customerId ? snapshot : null;
  const ageSeconds = receivedAt.current === null ? null : Math.max(0, (clock - receivedAt.current) / 1000);
  const status = !online ? 'offline' : !visible || !active ? 'paused' : failed || (ageSeconds !== null && ageSeconds >= 15) ? 'stale' : currentSnapshot ? 'ready' : 'loading';
  return { snapshot: currentSnapshot, refreshing, refresh, status, fresh: status === 'ready', ageSeconds };
}

export default function LiveUsage({ usage }: { usage: ReturnType<typeof useLiveUsage> }) {
  const { snapshot, refreshing, refresh, status, ageSeconds } = usage;
  const total = snapshot ? BigInt(snapshot.totals.allowanceBytes) : 0n;
  const percent = snapshot && total > 0n ? Number(BigInt(snapshot.totals.usedBytes) * 1000n / total) / 10 : 0;
  const routerAge = snapshot?.lastAccountingAt ? Math.max(0, (Date.parse(snapshot.asOf) - Date.parse(snapshot.lastAccountingAt)) / 1000 + (ageSeconds ?? 0)) : null;
  const statusText = status === 'offline' ? 'Offline · showing the last confirmed balance' : status === 'paused' ? 'Updates paused while this view is inactive' : status === 'stale' ? 'Update delayed · showing the last confirmed balance' : status === 'ready' ? 'Updates automatically every 5 seconds' : 'Checking your data balance…';
  return <section className="workspace-card live-usage" aria-labelledby="usage-heading" data-testid="live-usage">
    <div className="workspace-section-head"><div><div className="eyebrow">YOUR DATA ALLOWANCE</div><h3 id="usage-heading">Remaining data</h3></div><button className="secondary" disabled={refreshing || status === 'offline'} onClick={refresh} aria-label="Refresh data balance">Refresh balance</button></div>
    <p className={`usage-freshness ${status}`} role="status">{statusText}</p>
    {snapshot ? <>
      <p className="usage-remaining" data-testid="usage-remaining">{dataAmount(snapshot.totals.remainingBytes)}</p>
      <div className="usage-meter-label"><span><strong data-testid="usage-used">{dataAmount(snapshot.totals.usedBytes)}</strong> used</span><span>of {dataAmount(snapshot.totals.allowanceBytes)}</span></div>
      <progress max={100} value={percent} aria-label="Data allowance used" aria-valuetext={`${dataAmount(snapshot.totals.usedBytes)} used of ${dataAmount(snapshot.totals.allowanceBytes)} (${percent}%)`} />
      <dl className="usage-breakdown"><div><dt>Activated bundles remaining</dt><dd data-testid="usage-active">{dataAmount(snapshot.active.remainingBytes)}</dd><small>{snapshot.active.bundleCount} {snapshot.active.bundleCount === 1 ? 'bundle' : 'bundles'} within validity</small></div><div><dt>Queued for your next connection</dt><dd data-testid="usage-queued">{dataAmount(snapshot.queued.remainingBytes)}</dd><small>{snapshot.queued.bundleCount} {snapshot.queued.bundleCount === 1 ? 'bundle' : 'bundles'} · validity has not started</small></div></dl>
      {snapshot.hold.active || snapshot.connectivity === 'uncertain' ? <p className="notice">Your remaining data is shown above. A previous connection needs review before another can start. Ask an agent for help; do not buy another bundle to clear this review.</p> : snapshot.connectivity === 'stale' ? <p className="notice">Router reports are delayed. The balance includes recorded usage; more recent usage may not have arrived yet.</p> : snapshot.connectivity === 'pending' ? <p className="usage-note">Hotspot sign-in is pending. Prepared sign-in details do not confirm a connection.</p> : null}
      <div className="usage-timestamps"><p>Balance checked <span>{ageSeconds === null ? '—' : elapsedLabel(ageSeconds)}</span> · <time dateTime={snapshot.asOf}>{localDate(snapshot.asOf)}</time></p><p>Last router report received: {snapshot.lastAccountingAt ? <><time dateTime={snapshot.lastAccountingAt}>{localDate(snapshot.lastAccountingAt)}</time> <span>({elapsedLabel(routerAge!)})</span></> : 'No report yet'}</p></div>
      <p className="usage-note">Usage reflects verified router reports, normally received about every {snapshot.accounting.expectedIntervalSeconds} seconds. Queued data is included in your total; its validity starts after a successful hotspot connection.</p>
      {BigInt(snapshot.reservationOutstandingBytes) > 0n && <p className="usage-note">Current connection reservation: {dataAmount(snapshot.reservationOutstandingBytes)}. This is shown separately from recorded usage and is not deducted again from the balance above. A reservation may remain under review after its bundle expires or is reversed.</p>}
    </> : <p>{status === 'offline' ? 'Reconnect to check your balance. No previously confirmed balance is available in this view.' : status === 'stale' ? 'Your balance could not be verified. Retry when the service is available.' : 'Your recorded allowance will appear here when the account check completes.'}</p>}
  </section>;
}
