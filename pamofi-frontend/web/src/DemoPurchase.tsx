import { useEffect, useRef, useState } from 'react';
import { RecoverySetup } from './Recovery';
import { api, ApiError } from './api';
import { announceSessionChange, clearOrderIntent, clearSessionSecrets, currentSession, ensureSession, orderIntent, saveOrderIntent } from './session';

type Bundle = { id: string; price_minor: number; currency: string; byte_limit: string; validity_seconds: number };
type Order = { id: string; bundle_id: string; price_minor: number; currency: string; status: string; quote_expires_at: string };
type Entitlement = { id: string; bundle_id: string; byte_limit: string; consumed_bytes: string; validity_seconds: number; activated_at: string | null; revoked_at: string | null; start_by: string };
type Phase = 'loading' | 'review' | 'pending' | 'confirmed' | 'access' | 'error';
const date = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const money = (value: number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value / 100);
function orderLabel(order: Order, now: number) {
  if (order.status === 'payment_confirmed') return 'Simulated payment confirmed';
  if (order.status === 'awaiting_payment') return Date.parse(order.quote_expires_at) <= now ? 'Quote expired · not paid' : 'Awaiting simulated payment';
  return 'Status needs review';
}
function accessLabel(entitlement: Entitlement, now: number) {
  if (entitlement.revoked_at) return 'Unavailable after reversal';
  if (BigInt(entitlement.consumed_bytes) >= BigInt(entitlement.byte_limit)) return 'Data used up';
  if (!entitlement.activated_at) return Date.parse(entitlement.start_by) <= now ? 'Start deadline passed' : 'Queued · not connected';
  return Date.parse(entitlement.activated_at) + entitlement.validity_seconds * 1_000 <= now ? 'Validity ended' : 'Activated · connection not verified';
}

export default function DemoPurchase({ bundle, close, signedOut }: { bundle: Bundle | null; close: () => void; signedOut: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const owner = useRef<string | null>(null);
  const mounted = useRef(false);
  const [order, setOrder] = useState<Order | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [access, setAccess] = useState<Entitlement[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [resume, setResume] = useState(false), [reload, setReload] = useState(0);
  const [sessionChanged, setSessionChanged] = useState(false);
  const [now, setNow] = useState(Date.now()), [signoutOpen, setSignoutOpen] = useState(false);
  useEffect(() => { mounted.current = true; heading.current?.focus(); return () => { mounted.current = false; }; }, []);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(timer); }, []);

  function clearCompletedIntent(completed: Order) {
    if (!owner.current || completed.status !== 'payment_confirmed') return;
    try {
      const intent = orderIntent(owner.current, completed.bundle_id);
      if (intent?.orderId === completed.id) clearOrderIntent(owner.current, completed.bundle_id);
    } catch { /* A confirmed server result remains valid if local storage becomes unavailable. */ }
  }
  async function summary() {
    const [history, current] = await Promise.all([api<{ orders: Order[] }>('/api/orders'), api<{ entitlements: Entitlement[]; hasMore?: boolean; nextOffset?: number | null }>('/api/access')]);
    if (!Array.isArray(history.orders) || !Array.isArray(current.entitlements)) throw Error('invalid_summary');
    return { orders: history.orders, entitlements: current.entitlements, nextOffset: current.hasMore && Number.isInteger(current.nextOffset) ? current.nextOffset! : null };
  }
  async function verifyOwner() {
    if (!owner.current || await currentSession() !== owner.current) throw new ApiError(401, 'session_changed');
  }
  function failure(error: unknown, fallback: string) {
    if (error instanceof ApiError && error.status === 401) {
      setOrders([]); setAccess([]); setOrder(null); setPhase('error'); setSessionChanged(true);
      setMessage('Your session has changed or expired. Close this view and use Recover with your saved account details.');
    } else setMessage(fallback);
  }
  useEffect(() => {
    let live = true;
    setPhase('loading'); setMessage(''); setSessionChanged(false);
    (async () => {
      const customerId = bundle ? await ensureSession() : await currentSession();
      const current = await summary();
      if (!live) return;
      owner.current = customerId; setOrders(current.orders); setAccess(current.entitlements); setNextOffset(current.nextOffset);
      const retry = bundle ? orderIntent(customerId, bundle.id) : null;
      const previous = retry?.orderId ? current.orders.find(item => item.id === retry.orderId) : null;
      if (previous) { clearCompletedIntent(previous); setOrder(previous); setPhase(previous.status === 'payment_confirmed' ? 'confirmed' : 'pending'); }
      else { setResume(!!retry); setPhase(bundle ? 'review' : 'access'); }
    })().catch(error => {
      if (live) {
        if (!bundle && error instanceof ApiError && error.status === 401) { setSessionChanged(true); setMessage('There is no active demo session in this browser. Use Recover with your saved account details, or try a bundle to start a new demo account.'); setPhase('error'); return; }
        setMessage(error instanceof ApiError && error.code === 'session_retry_expired'
          ? 'This session retry has expired. Use Recover with your saved account reference and key.'
          : 'We could not reach the demo service. Check your connection and try again.');
        setPhase('error');
      }
    });
    return () => { live = false; };
  }, [bundle, reload]);

  async function createOrder() {
    if (!bundle || busy || !owner.current) return;
    setBusy(true); setMessage('');
    try {
      await verifyOwner();
      const intent = orderIntent(owner.current, bundle.id) ?? { key: crypto.randomUUID() };
      // Persist before POST. Closing, reloading, and a lost response all reuse this request.
      saveOrderIntent(owner.current, bundle.id, intent); setResume(true);
      const response = await api<{ order: Order }>('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': intent.key }, body: JSON.stringify({ bundleId: bundle.id }) });
      if (!response.order?.id || response.order.bundle_id !== bundle.id) throw Error('invalid_order');
      saveOrderIntent(owner.current, bundle.id, { ...intent, orderId: response.order.id });
      clearCompletedIntent(response.order);
      if (mounted.current) { setOrder(response.order); setPhase(response.order.status === 'payment_confirmed' ? 'confirmed' : 'pending'); }
    } catch (error) {
      if (mounted.current) failure(error, 'The order response could not be verified. Use Resume demo order to safely retry the same request, including after a reload.');
    } finally { if (mounted.current) setBusy(false); }
  }
  async function refresh() {
    await verifyOwner();
    const current = await summary();
    if (mounted.current) { setOrders(current.orders); setAccess(current.entitlements); setNextOffset(current.nextOffset); }
    return current.orders;
  }
  async function confirm() {
    if (!order || busy) return;
    setBusy(true); setMessage('');
    try {
      await verifyOwner();
      const result = await api<{ status: string; simulation: boolean }>(`/api/orders/${order.id}/demo-confirm`, { method: 'POST' });
      if (result.status !== 'payment_confirmed' || result.simulation !== true) throw Error('invalid_confirmation');
      clearCompletedIntent({ ...order, status: 'payment_confirmed' });
      if (mounted.current) { setOrder({ ...order, status: 'payment_confirmed' }); setPhase('confirmed'); }
      try { await refresh(); }
      catch (error) { if (mounted.current) failure(error, 'Your simulation is confirmed. The access summary could not be refreshed; use Refresh status before relying on the displayed details.'); }
    } catch (error) {
      if (mounted.current) {
        if (error instanceof ApiError && error.code === 'quote_expired') { setNow(Date.now()); setMessage('This quote has expired. Start a new demo order to get current terms.'); }
        else failure(error, 'Confirmation could not be verified. Use Check order before trying again.');
      }
    } finally { if (mounted.current) setBusy(false); }
  }
  async function check() {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      const list = await refresh();
      if (!mounted.current) return;
      if (order) {
        const updated = list.find(item => item.id === order.id);
        if (updated) { clearCompletedIntent(updated); setOrder(updated); setPhase(updated.status === 'payment_confirmed' ? 'confirmed' : 'pending'); }
        else setMessage('This order is outside the recent history or could not be found. Its status has not been verified.');
      } else setPhase('access');
    } catch (error) { if (mounted.current) failure(error, 'Status is temporarily unavailable. Any details shown are the last known values.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function loadMore() {
    if (busy || nextOffset === null) return;
    setBusy(true); setMessage('');
    try {
      await verifyOwner();
      const current = await api<{ entitlements: Entitlement[]; hasMore: boolean; nextOffset: number | null }>(`/api/access?offset=${nextOffset}`);
      if (!Array.isArray(current.entitlements)) throw Error('invalid_summary');
      if (mounted.current) {
        setAccess(previous => [...new Map([...previous, ...current.entitlements].map(item => [item.id, item])).values()]);
        setNextOffset(current.hasMore && Number.isInteger(current.nextOffset) ? current.nextOffset : null);
      }
    } catch (error) { if (mounted.current) failure(error, 'More bundles could not be loaded. Please try again.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function signOut() {
    if (busy) return;
    setBusy(true); setMessage('');
    try {
      await api<void>('/api/session', { method: 'DELETE' });
      clearSessionSecrets(); announceSessionChange('signed_out'); signedOut();
    } catch { if (mounted.current) setMessage('Sign out could not be completed. Your account details have not been cleared. Please try again.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  const expired = !!order && Date.parse(order.quote_expires_at) <= now;
  return <section className="purchase" aria-labelledby="purchase-heading" aria-busy={busy}>
    <div className="purchase-head"><div><div className="eyebrow">LOCAL DEMONSTRATION</div><h2 id="purchase-heading" ref={heading} tabIndex={-1}>{phase === 'access' || !bundle ? 'Your demo access' : 'Try a bundle'}</h2></div><button className="close-button" onClick={close} aria-label="Close demo purchase">×</button></div>
    <p className="notice">Simulation only. No money is charged, no voucher is issued, and this does not connect you to the internet.</p>
    {phase === 'loading' && <p role="status">Loading your demo session…</p>}
    {phase === 'error' && <><p role="alert">{message}</p>{!sessionChanged && <button className="secondary" onClick={() => setReload(value => value + 1)}>Try again</button>}</>}
    {phase === 'review' && bundle && <>
      <div className="purchase-summary"><div><span>{bundle.id.toUpperCase()}</span><strong>{Number(bundle.byte_limit) / 1e9} GB</strong><small>{bundle.validity_seconds / 86400} days</small></div><strong>{money(bundle.price_minor, bundle.currency)}</strong></div>
      <p>Includes uploads and downloads. One device at a time. Time begins with the first successful connection and ends when time or data runs out. Start within 30 days; quotes expire in 15 minutes.</p>
      <RecoverySetup />
      {orders.some(item => item.status === 'awaiting_payment' && Date.parse(item.quote_expires_at) > now) && <p className="notice">You already have a pending demo order. Check My demo access before creating another one.</p>}
      <button className="primary" disabled={busy} onClick={createOrder}>{resume ? 'Resume demo order' : 'Create demo order'} <span aria-hidden="true">→</span></button>
    </>}
    {phase === 'pending' && order && <>
      <h3>{orderLabel(order, now)}</h3><p>{order.bundle_id.toUpperCase()} · {money(order.price_minor, order.currency)} · Quote expires {date(order.quote_expires_at)} (your local time).</p>
      <p>This simulation does not contact a payment provider.</p><div className="purchase-actions">
        {order.status === 'awaiting_payment' && !expired && <button className="primary" disabled={busy} onClick={confirm}>Confirm simulation <span aria-hidden="true">→</span></button>}
        <button className="secondary" disabled={busy} onClick={check}>Check order</button>
        {expired && bundle && <button className="secondary" disabled={busy} onClick={() => { if (owner.current) clearOrderIntent(owner.current, bundle.id); setOrder(null); setResume(false); setMessage(''); setPhase('review'); }}>Start a new demo order</button>}
      </div>
    </>}
    {phase === 'confirmed' && <><h3>Simulated payment confirmed</h3><p>Your demo bundle is queued. Payment confirmation does not mean you are connected. Real payments and connection are not available yet.</p><button className="secondary" disabled={busy} onClick={() => { setOrder(null); setPhase('access'); }}>View demo access <span aria-hidden="true">→</span></button></>}
    {phase === 'access' && <>
      <h3>Bundles</h3>{access.length === 0 ? <p>No demo bundles yet. Explore the candidate bundles to try a simulation.</p> : <ul className="access-list">{access.map(item => <li key={item.id}><strong>{item.bundle_id.toUpperCase()} · {Number(item.byte_limit) / 1e9} GB</strong><span>{accessLabel(item, now)}</span><small>{item.activated_at ? `Activated ${date(item.activated_at)}` : `Start by ${date(item.start_by)}`} (your local time)</small></li>)}</ul>}
      {nextOffset !== null && <button className="secondary" disabled={busy} onClick={loadMore}>Show more bundles</button>}
      <h3>Recent demo orders</h3><p>Showing up to 100 of your most recent orders.</p>{orders.length === 0 ? <p>No demo orders yet.</p> : <ul className="access-list">{orders.map(item => <li key={item.id}><strong>{item.bundle_id.toUpperCase()} · {money(item.price_minor, item.currency)}</strong><span>{orderLabel(item, now)}</span>{item.status === 'awaiting_payment' && <button className="secondary" disabled={busy} onClick={() => { setOrder(item); setMessage(''); setPhase('pending'); }}>Check this order</button>}</li>)}</ul>}
      <button className="secondary" disabled={busy} onClick={check}>Refresh status</button>
      <RecoverySetup />
      <div className="signout-box">{signoutOpen ? <><p>Save your account reference and recovery key before leaving. You will need both to recover this anonymous demo account. Signing out affects this device; it does not end a hotspot connection.</p><div className="purchase-actions"><button className="secondary" disabled={busy} onClick={signOut}>Sign out of this device</button><button className="secondary" disabled={busy} onClick={() => setSignoutOpen(false)}>Keep me signed in</button></div></> : <button className="secondary" disabled={busy} onClick={() => setSignoutOpen(true)}>Sign out</button>}</div>
    </>}
    {busy && <p role="status">Checking with the demo service…</p>}
    {message && phase !== 'error' && <p role="alert">{message}</p>}
  </section>;
}
