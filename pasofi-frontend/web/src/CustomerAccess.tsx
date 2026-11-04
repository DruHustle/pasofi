import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { currentSession, ensureSession, announceSessionChange, clearSessionSecrets } from './session';
import { type Capabilities, type Product, type Site, type CashEvidence, cashDescription, finishMutation, localDate, messageFor, money, mutationIntent } from './business';
import { RecoverySetup } from './Recovery';
import { CreateHandoff } from './Handoff';
import NetworkAccess from './NetworkAccess';
import LiveUsage, { dataAmount, useLiveUsage, type UsageSnapshot } from './LiveUsage';
import './customer-premium.css';

type Entitlement = { id: string; bundle_id: string; byte_limit: string; consumed_bytes: string; validity_seconds: number; activated_at: string | null; revoked_at: string | null; start_by: string };
type Pairing = { id: string; code: string; expiresAt: string };
type Receipt = { sale: { id: string; siteName: string; bundleId: string; priceMinor: number; currency: string; byteLimit: string; validitySeconds: number; startBy: string; simulation: boolean; payment?: CashEvidence }; voucher: { id: string; code: string; state: string } };
type Order = { id: string; bundle_id: string; price_minor: number; currency: string; status: string; quote_expires_at: string };
type PaymentMethod = { code: string; name: string; currency: string; minMinor: number; maxMinor: number };
type PaymentStatus = { order: Order; attempts: { id: string; state: string }[]; entitlementId: string | null; simulation: boolean; fulfillmentState: 'unconfirmed' | 'fulfilled' | 'reversed' | 'pending_review'; entitlementRevokedAt: string | null; safeToRequote?: boolean };
export type CustomerTab = 'access' | 'wifi' | 'history' | 'voucher' | 'receipt' | 'purchase' | 'recovery';
type CustomerIcon = 'data' | 'voucher' | 'wifi' | 'history' | 'shield' | 'receipt' | 'user' | 'arrow';
function CustomerGlyph({ name }: { name: CustomerIcon }) {
  const paths: Record<CustomerIcon, string> = {
    data: 'M12 3v18M3 12h18',
    voucher: 'M4 5h16v5a2 2 0 0 0 0 4v5H4v-5a2 2 0 0 0 0-4V5Zm8 0v3m0 3v2m0 3v3',
    wifi: 'M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0m-9 4a5 5 0 0 1 6 0m-3 4h.01',
    history: 'M4 10a8 8 0 1 1 1 8M4 4v6h6m2-3v5l3 2',
    shield: 'm12 3 8 3v5c0 5-5 8-8 10-3-2-8-5-8-10V6l8-3Zm-4 9 3 3 5-6',
    receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3Zm3 5h6m-6 4h6',
    user: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
    arrow: 'M5 12h14m-6-6 6 6-6 6',
  };
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
function withUsage(item: Entitlement, snapshot: UsageSnapshot | null): Entitlement {
  const update = snapshot?.entitlementUpdates.find(value => value.id === item.id);
  // Counters and first activation/revocation are monotonic. A slow history read
  // must not roll back a newer usage snapshot (or vice versa).
  return update ? { ...item, ...update, consumed_bytes: BigInt(update.consumed_bytes) > BigInt(item.consumed_bytes) ? update.consumed_bytes : item.consumed_bytes, activated_at: item.activated_at ?? update.activated_at, revoked_at: item.revoked_at ?? update.revoked_at } : item;
}
export default function CustomerAccess({ close, capabilities, selectedBundle = null, requestedBundleId = null, initialTab = 'access', recovered, onNavigate, onBuyData }: { close: () => void; capabilities: Capabilities; selectedBundle?: Product | null; requestedBundleId?: string | null; initialTab?: CustomerTab; recovered: () => void; onNavigate?: (tab: CustomerTab, bundleId?: string) => void; onBuyData?: () => void }) {
  const [tab, setTab] = useState<CustomerTab>(selectedBundle ? capabilities.staffSales && capabilities.receiptPairing ? 'receipt' : 'purchase' : initialTab), [owner, setOwner] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [now, setNow] = useState(Date.now());
  const [access, setAccess] = useState<Entitlement[]>([]), [nextOffset, setNextOffset] = useState<number | null>(null);
  const [voucherCode, setVoucherCode] = useState(''), [pairing, setPairing] = useState<Pairing | null>(null), [pairingState, setPairingState] = useState(''), [receipt, setReceipt] = useState<Receipt | null>(null);
  const [sites, setSites] = useState<Site[]>([]), [products, setProducts] = useState<Product[]>([]), [bundleId, setBundleId] = useState(selectedBundle?.id ?? requestedBundleId ?? ''), [siteId, setSiteId] = useState('');
  const [methods, setMethods] = useState<PaymentMethod[]>([]), [methodCode, setMethodCode] = useState(''), [methodsLoading, setMethodsLoading] = useState(false);
  const [order, setOrder] = useState<Order | null>(null), [payment, setPayment] = useState<PaymentStatus | null>(null), [redirectUrl, setRedirectUrl] = useState('');
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [catalogueLoaded, setCatalogueLoaded] = useState(false), [recoveryReminder, setRecoveryReminder] = useState(false);
  const restoredMethod = useRef(''), savedOrderLookup = useRef(0);
  const [signout, setSignout] = useState(false), [agreed, setAgreed] = useState(false), [leaving, setLeaving] = useState(false);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const live = useRef(false), heading = useRef<HTMLHeadingElement>(null), ownerRef = useRef<string | null>(null), polling = useRef(false), generation = useRef(0), accessList = useRef<HTMLUListElement>(null), lastUsage = useRef<UsageSnapshot | null>(null);
  const previousInitialTab = useRef(initialTab), previousBundle = useRef(selectedBundle?.id ?? requestedBundleId ?? null);
  function selectTab(next: CustomerTab, selection = bundleId) { setTab(next); onNavigate?.(next, selection); }
  function buyData() { if (onBuyData) onBuyData(); else selectTab(capabilities.staffSales && capabilities.receiptPairing ? 'receipt' : 'purchase'); }
  useEffect(() => {
    if (previousInitialTab.current !== initialTab) { previousInitialTab.current = initialTab; setTab(initialTab); heading.current?.focus(); }
  }, [initialTab]);
  useEffect(() => {
    const nextBundleId = selectedBundle?.id ?? requestedBundleId;
    if (!nextBundleId || previousBundle.current === nextBundleId) return;
    previousBundle.current = nextBundleId;
    if (order || checkoutPending) { selectTab('purchase'); setMessage('Your earlier checkout is still saved. Check its verified status before choosing a different bundle.'); return; }
    // Explicit checkout/receipt routes own the screen; a changed ID only updates selection.
    setBundleId(nextBundleId);
  }, [selectedBundle?.id, requestedBundleId]);
  const isCurrent = (revision: number) => live.current && generation.current === revision;
  function invalidateAccount(expectedOwner?: string) {
    if (expectedOwner && ownerRef.current !== expectedOwner) return;
    ++generation.current; ownerRef.current = null; lastUsage.current = null; clearSessionSecrets();
    if (live.current) { setOwner(null); setAccess([]); setNextOffset(null); setReceipt(null); setVoucherCode(''); setPairing(null); setPairingState(''); setOrder(null); setPayment(null); setRedirectUrl(''); setCheckoutPending(false); setRecoveryReminder(false); setAgreed(false); setBusy(false); setLoading(false); setMessage('Your customer session changed or expired. Sign in or recover your account to check its balance again.'); }
  }
  function mergeUsage(snapshot: UsageSnapshot) {
    if (snapshot.customerId !== ownerRef.current || !live.current) return;
    lastUsage.current = snapshot;
    setAccess(previous => previous.map(item => withUsage(item, snapshot)));
  }
  const usage = useLiveUsage(owner, ['access', 'wifi', 'history'].includes(tab) && !leaving, visibleIds.length ? visibleIds : access.slice(0, 100).map(item => item.id), mergeUsage, invalidateAccount);
  function remember(id: string) { ownerRef.current = id; if (live.current) setOwner(id); }
  async function identity(create = false) {
    const revision = generation.current;
    const creating = create && !ownerRef.current;
    try {
      const id = create && !ownerRef.current ? await ensureSession() : await currentSession();
      if (!isCurrent(revision)) throw new ApiError(401, 'session_changed');
      if (ownerRef.current && ownerRef.current !== id) throw new ApiError(401, 'session_changed');
      remember(id); return id;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && isCurrent(revision) && (!creating || ownerRef.current)) invalidateAccount();
      if (creating && error instanceof ApiError && error.status === 401) throw new ApiError(400, 'cookie_not_kept');
      throw error;
    }
  }
  async function refreshAccess(more = false) {
    const revision = generation.current, id = await identity();
    const result = await api<{ customerId: string; entitlements: Entitlement[]; hasMore: boolean; nextOffset: number | null }>(`/api/access${more && nextOffset !== null ? `?offset=${nextOffset}` : ''}`);
    if (isCurrent(revision) && result.customerId !== id) { invalidateAccount(id); throw new ApiError(401, 'session_changed'); }
    if (isCurrent(revision) && ownerRef.current === id) { setAccess(previous => { const rows = more ? [...new Map([...previous, ...result.entitlements].map(item => [item.id, item])).values()] : result.entitlements; return rows.map(item => withUsage(item, lastUsage.current?.customerId === id ? lastUsage.current : null)); }); setNextOffset(result.hasMore ? result.nextOffset : null); }
  }
  useEffect(() => {
    live.current = true; const revision = generation.current; heading.current?.focus();
    (async () => {
      try {
        const id = await currentSession(); if (!isCurrent(revision)) return; remember(id);
        try { const saved = sessionStorage.getItem(`pamofi.operation:customer:${id}:purchase-details`); if (saved) { const draft = JSON.parse(JSON.parse(saved).payload) as { bundleId: string; siteId: string; methodCode: string }; restoredMethod.current = draft.methodCode; setBundleId(draft.bundleId); setSiteId(draft.siteId); setMethodCode(draft.methodCode); setCheckoutPending(true); selectTab('purchase', draft.bundleId); setMessage('Your unfinished checkout details were restored. Safely retry or check its verified status before starting another purchase.'); void restoreSavedOrder(id, revision, draft.bundleId).catch(() => { if (isCurrent(revision)) setMessage('Your checkout is still saved. Its order could not be loaded. Retry the saved-order check before starting another payment.'); }); } } catch { /* Storage is required and checked before a new checkout request. */ }
        await refreshAccess();
      }
      catch (error) { if (!(error instanceof ApiError && error.status === 401) && isCurrent(revision)) setMessage(messageFor(error)); }
      finally { if (isCurrent(revision)) setLoading(false); }
    })();
    Promise.all([api<{ sites: Site[] }>('/api/sites'), api<{ products: Product[] }>('/api/bundles')]).then(([locations, catalogue]) => { if (live.current) { setSites(locations.sites); setSiteId(value => value || locations.sites[0]?.id || ''); setProducts(catalogue.products); setCatalogueLoaded(true); setBundleId(value => value || catalogue.products[0]?.id || ''); } }).catch(error => { if (live.current) setMessage(messageFor(error)); });
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => { live.current = false; ++generation.current; clearInterval(timer); };
  }, []);
  const accessIds = access.map(item => item.id).join(',');
  useEffect(() => {
    if (!['access', 'history'].includes(tab) || !accessList.current || typeof IntersectionObserver === 'undefined') { setVisibleIds([]); return; }
    const visible = new Set<string>();
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) { const id = (entry.target as HTMLElement).dataset.entitlementId!; if (entry.isIntersecting) visible.add(id); else visible.delete(id); }
      setVisibleIds([...visible].slice(0, 100));
    }, { rootMargin: '120px' });
    accessList.current.querySelectorAll('[data-entitlement-id]').forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [accessIds, tab]);
  useEffect(() => {
    if (!capabilities.paymentCheckout || !siteId || !bundleId) { setMethods([]); return; }
    const controller = new AbortController(); setMethodsLoading(true); setMethods([]); setMethodCode('');
    api<{ enabled: boolean; methods: PaymentMethod[] }>(`/api/payments/methods?siteId=${encodeURIComponent(siteId)}&bundleId=${encodeURIComponent(bundleId)}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setMethods(result.enabled ? result.methods : []); setMethodCode(result.enabled ? restoredMethod.current || result.methods[0]?.code || '' : ''); } }).catch(error => { if (!controller.signal.aborted) setMessage(messageFor(error)); }).finally(() => { if (!controller.signal.aborted) setMethodsLoading(false); });
    return () => controller.abort();
  }, [siteId, bundleId, capabilities.paymentCheckout]);
  useEffect(() => {
    if (!pairing || pairingState !== 'pending' || Date.parse(pairing.expiresAt) <= now || polling.current || document.hidden) return;
    polling.current = true; const revision = generation.current;
    void (async () => {
      try { await identity(); const result = await api<{ status: string; receipt?: Receipt }>(`/api/receipt-pairings/${pairing.id}`); if (isCurrent(revision)) { setPairingState(result.status); if (result.status === 'ready' || result.status === 'expired') { if (ownerRef.current) finishMutation(`customer:${ownerRef.current}`, 'receipt-pairing'); } if (result.receipt) { setReceipt(result.receipt); setMessage('Your private receipt is ready. Redeem its voucher to queue the bundle; this does not connect you automatically.'); } } }
      catch (error) { if (isCurrent(revision)) setMessage(messageFor(error)); }
      finally { polling.current = false; }
    })();
  }, [now, pairing, pairingState]);
  async function startAccount() { if (busy) return; const revision = generation.current; setBusy(true); setMessage(''); try { await identity(true); await refreshAccess(); await usage.refresh(); } catch (error) { if (isCurrent(revision)) setMessage(messageFor(error)); } finally { if (isCurrent(revision)) setBusy(false); } }
  async function redeem(event?: React.FormEvent, receiptCode?: string) {
    event?.preventDefault(); if (busy || !capabilities.vouchers) return; const revision = generation.current; setBusy(true); setMessage('');
    try {
      await identity(true); const code = (receiptCode ?? voucherCode).replace(/[\s-]/g, '').toUpperCase();
      const result = await api<{ entitlementId: string; replayed: boolean }>('/api/vouchers/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      if (!result.entitlementId) throw Error('invalid_redemption');
      if (!isCurrent(revision)) return;
      setVoucherCode(''); setReceipt(null); setRecoveryReminder(true); setMessage(result.replayed ? 'This voucher was already redeemed into your account. Your existing bundle is shown below.' : 'Voucher redeemed. Your bundle is queued; time starts only after a successful hotspot connection.'); selectTab('access');
      await refreshAccess(); await usage.refresh();
    } catch (error) { if (isCurrent(revision)) setMessage(messageFor(error, 'The voucher response could not be confirmed. Retrying the same voucher is safe and cannot create a second bundle.')); }
    finally { if (isCurrent(revision)) setBusy(false); }
  }
  async function pair() {
    if (busy || !capabilities.receiptPairing) return; const revision = generation.current; setBusy(true); setMessage(''); setReceipt(null);
    try {
      const id = await identity(true); if (pairing && (Date.parse(pairing.expiresAt) <= Date.now() || pairingState !== 'pending')) finishMutation(`customer:${id}`, 'receipt-pairing'); const key = mutationIntent(`customer:${id}`, 'receipt-pairing', {});
      const result = await api<{ pairing: Pairing }>('/api/receipt-pairings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: '{}' });
      if (Date.parse(result.pairing.expiresAt) <= Date.now()) { finishMutation(`customer:${id}`, 'receipt-pairing'); throw Error('pairing_expired'); }
      if (isCurrent(revision)) { setPairing(result.pairing); setPairingState('pending'); }
    } catch (error) { if (isCurrent(revision)) setMessage(messageFor(error, 'The pairing could not be created or has expired. Try again to receive a fresh code.')); }
    finally { if (isCurrent(revision)) setBusy(false); }
  }
  async function restoreSavedOrder(id: string, revision: number, originalBundle: string) {
    // Read-only lookup. Never create an order or replay a provider payment merely
    // because a page was restored, the catalogue changed, or checkout was paused.
    const lookup = ++savedOrderLookup.current, orderKey = `pamofi.operation:customer:${id}:order:${originalBundle}`, detailsKey = `pamofi.operation:customer:${id}:purchase-details`;
    const raw = sessionStorage.getItem(orderKey), details = sessionStorage.getItem(detailsKey);
    const sameIntent = () => {
      if (!isCurrent(revision) || ownerRef.current !== id || lookup !== savedOrderLookup.current) return false;
      try { return sessionStorage.getItem(orderKey) === raw && sessionStorage.getItem(detailsKey) === details; } catch { return false; }
    };
    try {
      if (!raw || !details) throw Error('saved_order_reference_missing');
      const saved = JSON.parse(raw) as { key: string; payload: string };
      const payload = JSON.parse(saved.payload) as { bundleId: string; mode: string };
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(saved.key) || payload.bundleId !== originalBundle || payload.mode !== 'checkout') throw Error('invalid_saved_order');
      const result = await api<{ customerId: string; lookupKey?: string; orders: (Order & { purchase_mode?: string })[] }>(`/api/orders?requestKey=${encodeURIComponent(saved.key)}`);
      // A slower lookup cannot replace a resolved or newer purchase, or overwrite
      // a more recent recovery result from this same customer session.
      if (!sameIntent()) return;
      // The echo distinguishes exact lookup support from an older backend that
      // ignores the query and returns an unrelated recent-order list.
      if (result.customerId !== id || result.lookupKey !== saved.key || !Array.isArray(result.orders) || result.orders.length !== 1) throw Error('saved_order_not_confirmed');
      const found = result.orders[0];
      if (!/^[0-9a-f-]{36}$/i.test(found.id) || found.bundle_id !== originalBundle || found.purchase_mode !== 'checkout'
        || !Number.isSafeInteger(found.price_minor) || found.price_minor < 1 || !/^[A-Z]{3}$/.test(found.currency) || !Number.isFinite(Date.parse(found.quote_expires_at))) throw Error('invalid_saved_order');
      setOrder(found); setMessage('Your saved order was found. Check its verified payment status before paying again.');
    } catch (error) { if (sameIntent()) throw error; }
  }
  async function restoreOrder() {
    if (busy || !checkoutPending) return;
    const revision = generation.current; setBusy(true); setMessage('');
    try { const id = await identity(); await restoreSavedOrder(id, revision, bundleId); }
    catch (error) { if (isCurrent(revision)) setMessage(messageFor(error, 'The saved order could not be confirmed. Your original purchase details are preserved. Try checking again; do not start another payment.')); }
    finally { if (isCurrent(revision)) setBusy(false); }
  }
  async function checkPayment() {
    if (!order) return; const revision = generation.current; await identity();
    const result = await api<PaymentStatus>(`/api/orders/${order.id}/status`);
    if (isCurrent(revision)) {
      setOrder(result.order); setPayment(result);
      if (result.fulfillmentState === 'fulfilled' && result.entitlementId) setRecoveryReminder(true);
      const settled = result.safeToRequote === true || ['fulfilled', 'reversed'].includes(result.fulfillmentState) || (result.fulfillmentState === 'unconfirmed' && result.attempts.length > 0 && result.attempts.every(attempt => ['failed', 'reversed'].includes(attempt.state)));
      if (settled && ownerRef.current) { finishMutation(`customer:${ownerRef.current}`, `order:${result.order.bundle_id}`); finishMutation(`customer:${ownerRef.current}`, `checkout:${result.order.id}`); finishMutation(`customer:${ownerRef.current}`, 'purchase-details'); setCheckoutPending(false); setRedirectUrl(''); }
      if (result.entitlementId || result.fulfillmentState === 'reversed' || result.fulfillmentState === 'pending_review') { setRedirectUrl(''); await refreshAccess(); await usage.refresh(); }
    }
  }
  async function expireUnusedQuote() {
    if (busy || !order) return;
    const revision = generation.current; setBusy(true); setMessage('');
    try {
      const id = await identity();
      const result = await api<{ orderId: string; state: string; safeToRequote: boolean; replayed: boolean }>(`/api/orders/${order.id}/expire-unused`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (result.orderId !== order.id || result.state !== 'expired_unused' || result.safeToRequote !== true) throw Error('unverified_quote_expiry');
      if (!isCurrent(revision) || ownerRef.current !== id) return;
      finishMutation(`customer:${id}`, `order:${order.bundle_id}`); finishMutation(`customer:${id}`, `checkout:${order.id}`); finishMutation(`customer:${id}`, 'purchase-details');
      if (isCurrent(revision)) { setCheckoutPending(false); setOrder(null); setPayment(null); setRedirectUrl(''); setAgreed(false); restoredMethod.current = ''; setMessage('The service closed the expired unused quote and verified that no payment attempt exists. Review the current terms before preparing a fresh quote.'); }
    } catch (error) { if (isCurrent(revision)) setMessage(messageFor(error, 'Quote closure could not be verified. The original purchase details are preserved; retry this same closure or check payment status.')); }
    finally { if (isCurrent(revision)) setBusy(false); }
  }
  async function checkout(event: React.FormEvent) {
    event.preventDefault(); if (busy || !capabilities.paymentCheckout || !agreed || !bundleId || !methodCode) return;
    const revision = generation.current; setBusy(true); setMessage(''); setRedirectUrl('');
    try {
      const id = await identity(true), payload = { bundleId, mode: 'checkout' };
      mutationIntent(`customer:${id}`, 'purchase-details', { bundleId, siteId, methodCode }); setCheckoutPending(true); restoredMethod.current = methodCode;
      const key = mutationIntent(`customer:${id}`, `order:${bundleId}`, payload);
      const created = await api<{ order: Order }>('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(payload) });
      if (!isCurrent(revision)) return;
      setOrder(created.order);
      const checkoutPayload = { siteId, methodCode }, checkoutKey = mutationIntent(`customer:${id}`, `checkout:${created.order.id}`, checkoutPayload);
      const result = await api<{ attemptId: string; state: string; redirectUrl: string | null; simulation: boolean }>(`/api/orders/${created.order.id}/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': checkoutKey }, body: JSON.stringify(checkoutPayload) });
      if (result.redirectUrl) {
        const url = new URL(result.redirectUrl);
        if (url.protocol !== 'https:' || url.username || url.password) throw Error('invalid_checkout_url');
        if (isCurrent(revision)) setRedirectUrl(url.href);
      }
      if (isCurrent(revision)) setMessage(result.simulation ? 'Simulation checkout prepared. No real payment has been taken.' : 'Checkout prepared. Continue on the payment provider page, then check the verified status here.');
    } catch (error) { if (isCurrent(revision)) setMessage(messageFor(error, 'Checkout could not be confirmed. Check the order before starting another payment. Retry uses the same saved request.')); }
    finally { if (isCurrent(revision)) setBusy(false); }
  }
  async function check() { if (busy) return; const revision = generation.current; setBusy(true); setMessage(''); try { await checkPayment(); } catch (error) { if (isCurrent(revision)) setMessage(messageFor(error)); } finally { if (isCurrent(revision)) setBusy(false); } }
  async function mock(outcome: 'success' | 'failed') {
    if (busy || !order || capabilities.paymentMode !== 'mock') return; const revision = generation.current; setBusy(true); setMessage('');
    try { await identity(); await api(`/api/orders/${order.id}/mock-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome }) }); await checkPayment(); }
    catch (error) { if (isCurrent(revision)) setMessage(messageFor(error)); }
    finally { if (isCurrent(revision)) setBusy(false); }
  }
  async function logout() {
    if (busy) return; const revision = generation.current; setBusy(true); setLeaving(true);
    try {
      await api('/api/session', { method: 'DELETE' }); clearSessionSecrets();
      try { for (const key of Object.keys(sessionStorage)) if (key.startsWith('pamofi.operation:customer:')) sessionStorage.removeItem(key); } catch { /* The server session was revoked; private view is still cleared. */ }
      announceSessionChange('signed_out'); if (isCurrent(revision)) { invalidateAccount(); close(); }
    } catch (error) { if (isCurrent(revision)) setMessage(messageFor(error)); }
    finally { if (isCurrent(revision)) { setBusy(false); setLeaving(false); } }
  }
  async function reloadBundles(more = false) {
    if (busy) return; const revision = generation.current; setBusy(true);
    try { await refreshAccess(more); await usage.refresh(); }
    catch (error) { if (isCurrent(revision)) setMessage(messageFor(error)); }
    finally { if (isCurrent(revision)) setBusy(false); }
  }
  const paymentVerified = payment?.fulfillmentState === 'fulfilled' && !!payment.entitlementId;
  const paymentFailed = payment?.fulfillmentState === 'unconfirmed' && payment.attempts.length > 0 && payment.attempts.every(attempt => ['failed', 'reversed'].includes(attempt.state));
  const paymentLabel = payment?.safeToRequote === true ? 'Quote closed' : paymentVerified ? 'Bundle queued' : payment?.fulfillmentState === 'reversed' ? 'Payment reversed' : payment?.fulfillmentState === 'pending_review' ? 'Review in progress' : paymentFailed ? 'Payment failed' : 'Awaiting confirmation';
  const paymentSettled = !!payment && (payment.safeToRequote === true || ['fulfilled', 'reversed'].includes(payment.fulfillmentState) || (payment.fulfillmentState === 'unconfirmed' && payment.attempts.length > 0 && payment.attempts.every(attempt => ['failed', 'reversed'].includes(attempt.state))));
  const product = products.find(item => item.id === bundleId), method = methods.find(item => item.code === methodCode);
  const methodEligible = !!product && !!method && product.currency === method.currency && product.price_minor >= method.minMinor && product.price_minor <= method.maxMinor;
  function accessState(item: Entitlement) { if (item.revoked_at) return 'Reversed · unavailable'; if (BigInt(item.consumed_bytes) >= BigInt(item.byte_limit)) return 'Data used up'; if (!item.activated_at) return Date.parse(item.start_by) <= now ? 'Start deadline passed' : 'Queued · not connected'; return Date.parse(item.activated_at) + item.validity_seconds * 1000 <= now ? 'Validity ended' : 'Activated · check hotspot connection below'; }
  const titles: Record<CustomerTab, string> = { access: 'Your internet', wifi: 'My WiFi', history: 'Your activity', voucher: 'Redeem a voucher', receipt: 'Buy with an agent', purchase: 'Checkout', recovery: 'Your account' };
  const subtitles: Record<CustomerTab, string> = { access: 'A little data. A lot of possibility.', wifi: 'Your hotspot, your devices, your connection.', history: 'Keep track of your bundles and recent receipts.', voucher: 'A code away from your next connection.', receipt: 'Pay in cash. Get your data privately.', purchase: 'Your bundle. Your preferred way to pay.', recovery: 'Keep your connection close, wherever you go.' };
  const sectionLinks: { tab: CustomerTab; label: string }[] = [
    { tab: 'access', label: 'My bundles' }, { tab: 'wifi', label: 'My WiFi' }, { tab: 'history', label: 'History' },
    { tab: 'voucher', label: 'Use a voucher' }, { tab: 'receipt', label: 'Private receipt' },
    { tab: 'purchase', label: 'Online payment' }, { tab: 'recovery', label: 'Recovery & devices' },
  ];
  const sectionNavigation = <nav className="workspace-tabs customer-section-tabs" aria-label="Customer sections">{sectionLinks.map(link => <button key={link.tab} aria-pressed={tab === link.tab} className={tab === link.tab ? 'selected' : ''} onClick={() => selectTab(link.tab)}>{link.label}</button>)}</nav>;
  const emptyBundleGuidance = capabilities.staffSales || capabilities.paymentCheckout || capabilities.vouchers
    ? 'No bundles are shown yet. Browse bundles to check current availability.'
    : 'No bundles are shown yet. Purchases and voucher redemption are not available yet. Browse bundles to check current availability.';
  const bundleList = (history = false) => <section className="workspace-card customer-bundles-panel">
    <div className="workspace-section-head"><div><div className="eyebrow">{history ? 'YOUR ACCOUNT ACTIVITY' : 'READY FOR YOUR EVERYDAY'}</div><h3>{history ? 'Bundle history' : 'Your bundles'}</h3></div>{owner && <button className="text-button" disabled={busy} onClick={() => reloadBundles()}>Refresh bundles</button>}</div>
    {access.length === 0 ? <div className="customer-empty-state"><span className="customer-empty-icon"><CustomerGlyph name={history ? 'history' : 'voucher'} /></span><h4>{history ? 'Your story starts here.' : 'Your next connection starts here.'}</h4><p>{history ? 'When a bundle is added to this account, its allowance and validity will appear here.' : emptyBundleGuidance}</p>{capabilities.receiptPairing && <button className="primary" onClick={() => selectTab('receipt')}>Receive an agent receipt</button>}</div> : <ul className="access-list customer-bundle-list" ref={accessList}>{access.map(item => <li key={item.id} data-entitlement-id={item.id}>
      <div className="customer-bundle-row"><span className="customer-record-icon"><CustomerGlyph name="wifi" /></span><div><strong>{item.bundle_id.toUpperCase()} · {Number(item.byte_limit) / 1e9} GB</strong><span>{accessState(item)}</span></div></div>
      <small>{(Number(item.consumed_bytes) / 1e9).toFixed(3)} GB accounted · {item.activated_at ? `Activated ${localDate(item.activated_at)}` : `Start by ${localDate(item.start_by)}`}</small>
      {history && <small>Bundle reference: {item.id}</small>}
    </li>)}</ul>}
    {nextOffset !== null && <button className="secondary" disabled={busy} onClick={() => reloadBundles(true)}>Show more bundles</button>}
  </section>;
  const connectionPanel = owner && <NetworkAccess customerId={owner} capabilities={capabilities} usage={usage.snapshot} fresh={usage.fresh} refreshing={usage.refreshing} refresh={usage.refresh} />;
  return <section className="workspace customer-workspace" aria-labelledby="customer-heading" aria-busy={busy} data-screen={tab}>
    <div className="purchase-head customer-page-heading"><div><div className="eyebrow">YOUR PAMOFI</div><h2 id="customer-heading" tabIndex={-1} ref={heading}>{titles[tab]}</h2><p>{subtitles[tab]}</p></div><button className="close-button" onClick={close} aria-label="Close customer workspace">×</button></div>
    {capabilities.demo && <p className="notice customer-demo-notice">Demonstration environment. These flows do not establish real customer payment, SMS delivery, or internet connectivity.</p>}
    {tab !== 'access' && sectionNavigation}
    {loading && <div className="customer-loading" role="status"><span className="customer-loading-dot" />Checking your account…</div>}
    {message && <p className="feedback" role="status">{message}</p>}
    {!loading && !owner && <p className="notice customer-session-notice">No account is active in this browser. Buying, redeeming a voucher, or creating a private receipt starts a customer account. <button className="text-button" onClick={recovered}>Recover an existing account</button></p>}
    {recoveryReminder && owner && tab !== 'recovery' && <aside className="notice customer-recovery-reminder"><strong>Keep access to your bundle.</strong><p>Save your account reference and recovery key before changing devices or clearing this browser.</p><button className="secondary" onClick={() => { setRecoveryReminder(false); selectTab('recovery'); }}>Review recovery & devices</button></aside>}
    {catalogueLoaded && bundleId && !product && (tab === 'receipt' || tab === 'purchase') && <p className="notice" role="status">{checkoutPending || order ? 'This bundle is no longer published. Your saved purchase is preserved; check its verified status before paying again.' : 'The selected bundle is no longer published. Choose an available bundle before continuing.'}</p>}
    {checkoutPending && tab !== 'purchase' && <button className="customer-pending-checkout" onClick={() => selectTab('purchase')}><CustomerGlyph name="receipt" /><span><strong>Your checkout is saved</strong><small>Check its status before starting another payment.</small></span><CustomerGlyph name="arrow" /></button>}

    {tab === 'access' && <>
      {owner ? <LiveUsage usage={usage} onBuyData={buyData} /> : !loading && <section className="customer-welcome-card"><span className="customer-welcome-icon"><CustomerGlyph name="wifi" /></span><div className="eyebrow">A WORLD OF POSSIBILITY</div><h3>Make yourself at home.</h3><p>Choose a bundle or redeem a voucher. Your data balance and connection will appear right here.</p><button className="primary" onClick={buyData}>Explore bundles<CustomerGlyph name="arrow" /></button><small>No registration form to get started.</small></section>}
      <div className="customer-quick-actions" aria-label="Quick actions">
        <button onClick={buyData}><span><CustomerGlyph name="data" /></span>Browse bundles</button>
        <button onClick={() => selectTab('voucher')}><span><CustomerGlyph name="voucher" /></span>Redeem a voucher</button>
        <button onClick={() => selectTab('wifi')} aria-label="Manage my WiFi"><span><CustomerGlyph name="wifi" /></span>My WiFi</button>
        <button onClick={() => selectTab('recovery')} aria-label="Manage recovery and devices"><span><CustomerGlyph name="user" /></span>My account</button>
      </div>
      {sectionNavigation}
      <div className="customer-overview-grid">{bundleList()}{connectionPanel}</div>
      <section className="customer-soft-banner"><span><CustomerGlyph name="shield" /></span><div><h3>Your data, on your terms.</h3><p>Validity begins at your first successful hotspot connection. Your uploads and downloads both count.</p></div></section>
    </>}

    {tab === 'wifi' && <>
      <section className="customer-wifi-intro"><span className="customer-welcome-icon"><CustomerGlyph name="wifi" /></span><div><h3>A connection that moves with you.</h3><p>Use one active hotspot connection at a time. Disconnect and wait for confirmation before switching to another location.</p></div></section>
      {owner ? <div className="customer-detail-grid">{connectionPanel}<section className="workspace-card"><span className="customer-record-icon"><CustomerGlyph name="user" /></span><h3>Use another device</h3><p>Move your account using a one-time handoff. Your existing bundle stays with your account.</p><button className="secondary" onClick={() => selectTab('recovery')}>Recovery & device options</button><p className="customer-muted">Moving your account does not end an existing hotspot session.</p></section></div> : <section className="workspace-card customer-empty-state"><h3>Bring your data with you.</h3><p>Recover your account to check its connection, or choose your first bundle.</p><div className="purchase-actions"><button className="primary" onClick={recovered}>Recover my account</button><button className="secondary" onClick={buyData}>Browse bundles</button></div></section>}
    </>}

    {tab === 'history' && <>
      <div className="customer-history-summary"><span className="customer-record-icon"><CustomerGlyph name="history" /></span><div><h3>Every bundle has a story.</h3><p>View allowance, activation and validity for this account. Receipts and checkout details below are those opened in this browser session.</p></div></div>
      {receipt && <section className="workspace-card customer-history-receipt"><div className="workspace-section-head"><h3>{receipt.sale.simulation ? 'Latest demo receipt' : 'Latest agent receipt'}</h3><span className="customer-status-tag">Voucher issued</span></div><strong>{money(receipt.sale.priceMinor, receipt.sale.currency)}</strong><p>{receipt.sale.bundleId.toUpperCase()} · {receipt.sale.siteName}</p><p>{cashDescription(receipt.sale.payment, receipt.sale.simulation)}</p><button className="secondary" onClick={() => selectTab('receipt')}>View private receipt</button></section>}
      {order && <section className="workspace-card"><div className="workspace-section-head"><h3>Recent checkout</h3><span className="customer-status-tag">{paymentLabel}</span></div><strong>{money(order.price_minor, order.currency)}</strong><p>{order.bundle_id.toUpperCase()} · Order {order.id.slice(0, 8)}</p><button className="secondary" onClick={() => selectTab('purchase')}>View checkout status</button></section>}
      {bundleList(true)}
      {owner && usage.snapshot && <section className="workspace-card customer-history-usage"><div><span className="eyebrow">RECORDED USAGE</span><h3>{dataAmount(usage.snapshot.lifetimeAccountedBytes)}</h3></div><p>Lifetime data recorded for this account.{!usage.fresh && ' This is the last confirmed snapshot.'}</p></section>}
    </>}

    {tab === 'voucher' && <section className="workspace-card customer-voucher-card">
      <div className="customer-voucher-art" aria-hidden="true"><CustomerGlyph name="voucher" /><span>PAMOFI</span><i /><span>YOUR NEXT CONNECTION</span></div>
      <div className="customer-voucher-content"><div className="eyebrow">GOOD THINGS COME IN SMALL CODES</div><h3>Use your voucher</h3><p>Enter the code from your agent or private receipt. Uploads and downloads count toward the allowance. Redeeming queues the bundle; it does not start its validity or connect you.</p>
      {!capabilities.vouchers ? <p className="notice">Voucher redemption is not enabled here yet.</p> : <form className="form-grid" onSubmit={redeem}><label>Voucher code<input className="customer-voucher-input" required maxLength={40} autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="Enter your voucher code" value={voucherCode} onChange={event => setVoucherCode(event.target.value.toUpperCase())} /></label><button className="primary" disabled={busy}>Redeem voucher<CustomerGlyph name="arrow" /></button></form>}
      <div className="customer-private-note"><CustomerGlyph name="shield" /><span>Your voucher is private. Share it only when redeeming.</span></div></div>
    </section>}

    {tab === 'receipt' && <div className="customer-checkout-layout"><section className="workspace-card customer-agent-checkout"><div className="eyebrow">CASH, MADE SIMPLE</div><h3>Receive a private agent receipt</h3><p>Create a pairing code on your own device and show it to the agent. Agree the bundle and pay its exact cash price. The agent confirms receipt of cash before issuing your voucher. Keep this page open; your private receipt appears automatically.</p>
      <ol className="customer-steps"><li><span>1</span><div><strong>Choose your bundle</strong><small>Confirm the price with an authorized agent.</small></div></li><li><span>2</span><div><strong>Pair and pay</strong><small>Show your code, then pay the exact cash amount.</small></div></li><li><span>3</span><div><strong>Redeem and connect</strong><small>Use the voucher delivered privately to this page.</small></div></li></ol>
      {!capabilities.receiptPairing ? <p className="notice">Private receipt pairing is not enabled here yet.</p> : <><button className="primary" disabled={busy || (!!pairing && pairingState === 'pending' && Date.parse(pairing.expiresAt) > now)} onClick={pair}>Create private pairing code<CustomerGlyph name="arrow" /></button>{pairing && <div className="pairing-card"><span>SHOW THIS CODE TO YOUR AGENT</span><strong>{pairing.code}</strong><small>{pairingState === 'pending' && Date.parse(pairing.expiresAt) > now ? `Waiting for your receipt · expires ${localDate(pairing.expiresAt)}` : pairingState === 'ready' ? 'Receipt ready' : 'Pairing expired · create a new code'}</small></div>}</>}
      {receipt && <div className="private-receipt"><div className="customer-receipt-heading"><CustomerGlyph name="receipt" /><h4>{receipt.sale.simulation ? 'Demo receipt' : 'Your receipt'}</h4></div><p>{receipt.sale.siteName} · {receipt.sale.bundleId.toUpperCase()} · {money(receipt.sale.priceMinor, receipt.sale.currency)}</p><p>{Number(receipt.sale.byteLimit) / 1e9} GB · {receipt.sale.validitySeconds / 86400} days · Start by {localDate(receipt.sale.startBy)}</p><p className="cash-evidence">{cashDescription(receipt.sale.payment, receipt.sale.simulation)}</p><label>Private voucher<input readOnly value={receipt.voucher.code} autoComplete="off" /></label><button className="primary" disabled={busy || !capabilities.vouchers} onClick={() => redeem(undefined, receipt.voucher.code)}>Redeem this receipt's voucher</button><small>Receipt reference: {receipt.sale.id}</small></div>}
    </section><aside className="workspace-card customer-order-summary"><span className="customer-record-icon"><CustomerGlyph name="wifi" /></span><div className="eyebrow">YOUR NEXT BUNDLE</div>{product ? <><h3>{product.id.toUpperCase()}</h3><strong className="customer-summary-data">{Number(product.byte_limit) / 1e9}<small>GB</small></strong><p>{product.validity_seconds / 86400} days after connection</p><div className="customer-summary-price"><span>Cash price</span><strong>{money(product.price_minor, product.currency)}</strong></div><small>Ask the agent for this published bundle. Check the issued receipt before redeeming.</small></> : <><h3>A little more online.</h3><p>Choose your bundle with the agent and check its price before you pay.</p>{onBuyData && <button className="secondary" onClick={onBuyData}>Explore bundles</button>}</>}<div className="customer-private-note"><CustomerGlyph name="shield" /><span>Your bundle time starts when you first connect.</span></div></aside></div>}

    {tab === 'purchase' && <section className="workspace-card customer-payment-card">
      {capabilities.staffSales && <div className="cash-path"><span className="customer-record-icon"><CustomerGlyph name="receipt" /></span><h3>Buy from an authorized agent</h3><ol><li>Choose your bundle and confirm its cash price with the agent.</li><li>Show your private pairing code, then pay the agreed cash amount.</li><li>Redeem the voucher in your receipt to add the queued data.</li></ol>{capabilities.receiptPairing && <button className="primary" onClick={() => selectTab('receipt')}>Get a private agent receipt</button>}<p>Time starts after a successful hotspot connection. A cash receipt alone does not connect your device.</p></div>}
      <div className="eyebrow">MORE WAYS TO CONNECT</div><h3>{capabilities.paymentMode === 'mock' ? 'Optional online payment simulation' : 'Online payment options'}</h3>
      {!capabilities.paymentCheckout ? <><p className="notice">Online checkout is not enabled here. Use a voucher from an authorized agent when available.</p><div className="customer-provider-list" aria-label="Payment integrations awaiting activation"><span>EcoCash<small>Pending</small></span><span>InnBucks<small>Pending</small></span><span>Bank & card<small>Pending</small></span></div></> : <>
        <form className="form-grid" onSubmit={checkout}><fieldset disabled={busy || !!order || checkoutPending}><label>Purchase site<select required value={siteId} onChange={event => setSiteId(event.target.value)}><option value="">Choose a site</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label><label>Bundle<select required value={bundleId} onChange={event => { setBundleId(event.target.value); onNavigate?.('purchase', event.target.value); }}><option value="">Choose a bundle</option>{products.map(item => <option key={item.id} value={item.id}>{item.id.toUpperCase()} · {money(item.price_minor, item.currency)}</option>)}</select></label>
          {product && <div className="summary-tile"><strong>{money(product.price_minor, product.currency)}</strong><span>{Number(product.byte_limit) / 1e9} GB · {product.validity_seconds / 86400} days · One active connection</span></div>}
          <label>Payment method<select required disabled={methodsLoading} value={methodCode} onChange={event => setMethodCode(event.target.value)}><option value="">{methodsLoading ? 'Checking payment methods…' : 'Choose an enabled method'}</option>{methods.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>{method && <small>Provider limits: {money(method.minMinor, method.currency)} to {money(method.maxMinor, method.currency)}.</small>}
        </fieldset><label className="check-label"><input type="checkbox" required checked={agreed} onChange={event => setAgreed(event.target.checked)} disabled={busy} />I have reviewed the price, allowance, and validity. {capabilities.paymentMode === 'mock' ? 'This is a simulation.' : 'Payment confirmation does not mean I am connected.'}</label><button className="primary" disabled={busy || !methodEligible || !agreed || (!!payment && (payment.fulfillmentState !== 'unconfirmed' || payment.safeToRequote === true))}>{order || checkoutPending ? 'Retry this checkout safely' : 'Prepare checkout'}</button></form>
        {!methodsLoading && methods.length === 0 && <p>No configured payment method is available for this bundle and site.</p>}
        {redirectUrl && <a className="primary button-link" href={redirectUrl} target="_blank" rel="noopener noreferrer">Continue to payment provider ↗</a>}
      </>}
      {checkoutPending && !order && <div className="notice customer-saved-order"><h4>Check your saved purchase</h4><p>Its status can be checked even if the bundle or payment method is no longer offered. This check does not start a payment.</p><button className="secondary" disabled={busy} onClick={restoreOrder}>Check saved checkout status</button></div>}
        {order && <div className={`payment-status customer-payment-status ${paymentVerified ? 'is-confirmed' : payment?.fulfillmentState === 'reversed' || paymentFailed ? 'is-reversed' : ''}`}><span className="customer-status-tag">{paymentLabel}</span><h4>Order {order.id.slice(0, 8)}</h4><p>{money(order.price_minor, order.currency)} · Quote expires {localDate(order.quote_expires_at)}</p><button className="secondary" disabled={busy} onClick={check}>Check verified payment status</button>
          {capabilities.paymentMode === 'mock' && <div className="purchase-actions"><button className="secondary" disabled={busy} onClick={() => mock('success')}>Simulate successful payment</button><button className="secondary" disabled={busy} onClick={() => mock('failed')}>Simulate failed payment</button></div>}
          {payment && <p role="status">{payment.safeToRequote === true ? 'Expired unused quote closed. No provider payment was initiated for this order.' : paymentVerified ? `${payment.simulation ? 'Simulated payment' : 'Payment'} verified. Your bundle is queued; internet connection is not yet confirmed.` : payment.fulfillmentState === 'reversed' ? 'Payment reversed. This purchase no longer provides usable access.' : payment.fulfillmentState === 'pending_review' ? 'Payment needs review. Do not pay again while the previous charge and accounted usage are being reconciled.' : `Payment not confirmed. ${payment.attempts.map(attempt => attempt.state.replace(/_/g, ' ')).join(', ') || 'Waiting for a verified provider result.'}`}</p>}
          {(!payment || payment.fulfillmentState === 'unconfirmed') && payment?.safeToRequote !== true && <div className="quote-expiry"><p>If this quote expired before a payment was attempted, the service can close it safely. This does not cancel, reverse or restart an existing provider payment.</p><button className="secondary" disabled={busy} onClick={expireUnusedQuote}>Close an expired unused quote</button></div>}
          {paymentSettled && <button className="secondary" disabled={busy} onClick={() => { setOrder(null); setPayment(null); setRedirectUrl(''); setAgreed(false); restoredMethod.current = ''; setMessage('Choose the terms for a new purchase.'); }}>{payment.safeToRequote === true ? 'Review a fresh quote' : 'Review another bundle'}</button>}
        </div>}
    </section>}

    {tab === 'recovery' && <>
      <section className="customer-profile-card"><span className="customer-profile-avatar"><CustomerGlyph name="user" /></span><div><span className="eyebrow">YOUR EVERYDAY CONNECTION</span><h3>{owner ? 'Your PamoFi account' : 'Welcome to PamoFi'}</h3><p>{owner ? 'Your account is available in this browser.' : 'Start with a bundle, or bring back your saved account.'}</p></div><span className="customer-profile-language">English</span></section>
      {owner ? <><div className="customer-account-grid"><RecoverySetup /><CreateHandoff customerId={owner} /></div><section className="workspace-card customer-signout-card"><h3>Sign out of this browser</h3>{signout ? <><p>Save your recovery details before you leave. Signing out does not end an active hotspot session; use the connection controls for that.</p><div className="purchase-actions"><button className="secondary" disabled={busy} onClick={logout}>Sign out of customer account</button><button className="secondary" disabled={busy} onClick={() => setSignout(false)}>Keep this session</button></div></> : <button className="secondary" onClick={() => setSignout(true)}>Prepare to sign out</button>}</section></> : <section className="workspace-card"><h3>Save or restore access</h3><p>Use your saved reference and recovery key to restore an existing account. Start a new account only if you do not need to recover one.</p><div className="purchase-actions"><button className="primary" onClick={recovered}>Recover my account</button><button className="secondary" disabled={busy} onClick={startAccount}>Start a new customer account</button></div></section>}
    </>}
  </section>;
}
