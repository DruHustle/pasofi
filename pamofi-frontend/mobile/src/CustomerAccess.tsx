import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { currentSession, ensureSession, announceSessionChange, clearSessionSecrets } from './session';
import { type Capabilities, type Product, type Site, finishMutation, localDate, messageFor, money, mutationIntent } from './business';
import { RecoverySetup } from './Recovery';
import { CreateHandoff } from './Handoff';
import NetworkAccess from './NetworkAccess';

type Entitlement = { id: string; bundle_id: string; byte_limit: string; consumed_bytes: string; validity_seconds: number; activated_at: string | null; revoked_at: string | null; start_by: string };
type Pairing = { id: string; code: string; expiresAt: string };
type Receipt = { sale: { id: string; siteName: string; bundleId: string; priceMinor: number; currency: string; byteLimit: string; validitySeconds: number; startBy: string; simulation: boolean }; voucher: { id: string; code: string; state: string } };
type Order = { id: string; bundle_id: string; price_minor: number; currency: string; status: string; quote_expires_at: string };
type PaymentMethod = { code: string; name: string; currency: string; minMinor: number; maxMinor: number };
type PaymentStatus = { order: Order; attempts: { id: string; state: string }[]; entitlementId: string | null; simulation: boolean; fulfillmentState: 'unconfirmed' | 'fulfilled' | 'reversed' | 'pending_review'; entitlementRevokedAt: string | null; safeToRequote?: boolean };
type Tab = 'access' | 'voucher' | 'receipt' | 'purchase' | 'recovery';
export default function CustomerAccess({ close, capabilities, selectedBundle = null, initialTab = 'access', recovered }: { close: () => void; capabilities: Capabilities; selectedBundle?: Product | null; initialTab?: Tab; recovered: () => void }) {
  const [tab, setTab] = useState<Tab>(selectedBundle ? 'purchase' : initialTab), [owner, setOwner] = useState<string | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [now, setNow] = useState(Date.now());
  const [access, setAccess] = useState<Entitlement[]>([]), [nextOffset, setNextOffset] = useState<number | null>(null);
  const [voucherCode, setVoucherCode] = useState(''), [pairing, setPairing] = useState<Pairing | null>(null), [pairingState, setPairingState] = useState(''), [receipt, setReceipt] = useState<Receipt | null>(null);
  const [sites, setSites] = useState<Site[]>([]), [products, setProducts] = useState<Product[]>([]), [bundleId, setBundleId] = useState(selectedBundle?.id ?? ''), [siteId, setSiteId] = useState('');
  const [methods, setMethods] = useState<PaymentMethod[]>([]), [methodCode, setMethodCode] = useState(''), [methodsLoading, setMethodsLoading] = useState(false);
  const [order, setOrder] = useState<Order | null>(null), [payment, setPayment] = useState<PaymentStatus | null>(null), [redirectUrl, setRedirectUrl] = useState('');
  const [checkoutPending, setCheckoutPending] = useState(false);
  const restoredMethod = useRef('');
  const [signout, setSignout] = useState(false), [agreed, setAgreed] = useState(false);
  const live = useRef(false), heading = useRef<HTMLHeadingElement>(null), ownerRef = useRef<string | null>(null), polling = useRef(false);
  function remember(id: string) { ownerRef.current = id; if (live.current) setOwner(id); }
  async function identity(create = false) {
    const creating = create && !ownerRef.current;
    try {
      const id = create && !ownerRef.current ? await ensureSession() : await currentSession();
      if (ownerRef.current && ownerRef.current !== id) throw new ApiError(401, 'session_changed');
      remember(id); return id;
    } catch (error) {
      if (error instanceof ApiError && error.status === 401 && live.current) { setOwner(null); setAccess([]); setReceipt(null); setVoucherCode(''); setPairing(null); setOrder(null); setPayment(null); setRedirectUrl(''); }
      if (creating && error instanceof ApiError && error.status === 401) throw new ApiError(400, 'cookie_not_kept');
      throw error;
    }
  }
  async function refreshAccess(more = false) {
    await identity();
    const result = await api<{ entitlements: Entitlement[]; hasMore: boolean; nextOffset: number | null }>(`/api/access${more && nextOffset !== null ? `?offset=${nextOffset}` : ''}`);
    if (live.current) { setAccess(previous => more ? [...new Map([...previous, ...result.entitlements].map(item => [item.id, item])).values()] : result.entitlements); setNextOffset(result.hasMore ? result.nextOffset : null); }
  }
  useEffect(() => {
    live.current = true; heading.current?.focus();
    (async () => {
      try {
        const id = await currentSession(); remember(id);
        try { const saved = sessionStorage.getItem(`pamofi.operation:customer:${id}:purchase-details`); if (saved) { const draft = JSON.parse(JSON.parse(saved).payload) as { bundleId: string; siteId: string; methodCode: string }; restoredMethod.current = draft.methodCode; setBundleId(draft.bundleId); setSiteId(draft.siteId); setMethodCode(draft.methodCode); setCheckoutPending(true); setTab('purchase'); setMessage('Your unfinished checkout details were restored. Safely retry or check its verified status before starting another purchase.'); } } catch { /* Storage is required and checked before a new checkout request. */ }
        await refreshAccess();
      }
      catch (error) { if (!(error instanceof ApiError && error.status === 401) && live.current) setMessage(messageFor(error)); }
      finally { if (live.current) setLoading(false); }
    })();
    Promise.all([api<{ sites: Site[] }>('/api/sites'), api<{ products: Product[] }>('/api/bundles')]).then(([locations, catalogue]) => { if (live.current) { setSites(locations.sites); setSiteId(value => value || locations.sites[0]?.id || ''); setProducts(catalogue.products); setBundleId(value => value || catalogue.products[0]?.id || ''); } }).catch(error => { if (live.current) setMessage(messageFor(error)); });
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => { live.current = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!capabilities.paymentCheckout || !siteId || !bundleId) { setMethods([]); return; }
    const controller = new AbortController(); setMethodsLoading(true); setMethods([]); setMethodCode('');
    api<{ enabled: boolean; methods: PaymentMethod[] }>(`/api/payments/methods?siteId=${encodeURIComponent(siteId)}&bundleId=${encodeURIComponent(bundleId)}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setMethods(result.enabled ? result.methods : []); setMethodCode(result.enabled ? restoredMethod.current || result.methods[0]?.code || '' : ''); } }).catch(error => { if (!controller.signal.aborted) setMessage(messageFor(error)); }).finally(() => { if (!controller.signal.aborted) setMethodsLoading(false); });
    return () => controller.abort();
  }, [siteId, bundleId, capabilities.paymentCheckout]);
  useEffect(() => {
    if (!pairing || pairingState !== 'pending' || Date.parse(pairing.expiresAt) <= now || polling.current || document.hidden) return;
    polling.current = true;
    void (async () => {
      try { await identity(); const result = await api<{ status: string; receipt?: Receipt }>(`/api/receipt-pairings/${pairing.id}`); if (live.current) { setPairingState(result.status); if (result.status === 'ready' || result.status === 'expired') { if (ownerRef.current) finishMutation(`customer:${ownerRef.current}`, 'receipt-pairing'); } if (result.receipt) { setReceipt(result.receipt); setMessage('Your private receipt is ready. Redeem its voucher to queue the bundle; this does not connect you automatically.'); } } }
      catch (error) { if (live.current) setMessage(messageFor(error)); }
      finally { polling.current = false; }
    })();
  }, [now, pairing, pairingState]);
  async function startAccount() { if (busy) return; setBusy(true); setMessage(''); try { await identity(true); await refreshAccess(); } catch (error) { setMessage(messageFor(error)); } finally { if (live.current) setBusy(false); } }
  async function redeem(event?: React.FormEvent, receiptCode?: string) {
    event?.preventDefault(); if (busy || !capabilities.vouchers) return; setBusy(true); setMessage('');
    try {
      await identity(true); const code = (receiptCode ?? voucherCode).replace(/[\s-]/g, '').toUpperCase();
      const result = await api<{ entitlementId: string; replayed: boolean }>('/api/vouchers/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      if (!result.entitlementId) throw Error('invalid_redemption');
      if (live.current) { setVoucherCode(''); setReceipt(null); setMessage(result.replayed ? 'This voucher was already redeemed into your account. Your existing bundle is shown below.' : 'Voucher redeemed. Your bundle is queued; time starts only after a successful hotspot connection.'); setTab('access'); }
      await refreshAccess();
    } catch (error) { if (live.current) setMessage(messageFor(error, 'The voucher response could not be confirmed. Retrying the same voucher is safe and cannot create a second bundle.')); }
    finally { if (live.current) setBusy(false); }
  }
  async function pair() {
    if (busy || !capabilities.receiptPairing) return; setBusy(true); setMessage(''); setReceipt(null);
    try {
      const id = await identity(true); if (pairing && (Date.parse(pairing.expiresAt) <= Date.now() || pairingState !== 'pending')) finishMutation(`customer:${id}`, 'receipt-pairing'); const key = mutationIntent(`customer:${id}`, 'receipt-pairing', {});
      const result = await api<{ pairing: Pairing }>('/api/receipt-pairings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: '{}' });
      if (Date.parse(result.pairing.expiresAt) <= Date.now()) { finishMutation(`customer:${id}`, 'receipt-pairing'); throw Error('pairing_expired'); }
      if (live.current) { setPairing(result.pairing); setPairingState('pending'); }
    } catch (error) { if (live.current) setMessage(messageFor(error, 'The pairing could not be created or has expired. Try again to receive a fresh code.')); }
    finally { if (live.current) setBusy(false); }
  }
  async function checkPayment() {
    if (!order) return; await identity();
    const result = await api<PaymentStatus>(`/api/orders/${order.id}/status`);
    if (live.current) {
      setOrder(result.order); setPayment(result);
      const settled = result.safeToRequote === true || ['fulfilled', 'reversed'].includes(result.fulfillmentState) || (result.fulfillmentState === 'unconfirmed' && result.attempts.length > 0 && result.attempts.every(attempt => ['failed', 'reversed'].includes(attempt.state)));
      if (settled && ownerRef.current) { finishMutation(`customer:${ownerRef.current}`, `order:${result.order.bundle_id}`); finishMutation(`customer:${ownerRef.current}`, `checkout:${result.order.id}`); finishMutation(`customer:${ownerRef.current}`, 'purchase-details'); setCheckoutPending(false); setRedirectUrl(''); }
      if (result.entitlementId || result.fulfillmentState === 'reversed' || result.fulfillmentState === 'pending_review') { setRedirectUrl(''); await refreshAccess(); }
    }
  }
  async function expireUnusedQuote() {
    if (busy || !order) return;
    setBusy(true); setMessage('');
    try {
      const id = await identity();
      const result = await api<{ orderId: string; state: string; safeToRequote: boolean; replayed: boolean }>(`/api/orders/${order.id}/expire-unused`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (result.orderId !== order.id || result.state !== 'expired_unused' || result.safeToRequote !== true) throw Error('unverified_quote_expiry');
      finishMutation(`customer:${id}`, `order:${order.bundle_id}`); finishMutation(`customer:${id}`, `checkout:${order.id}`); finishMutation(`customer:${id}`, 'purchase-details');
      if (live.current) { setCheckoutPending(false); setOrder(null); setPayment(null); setRedirectUrl(''); setAgreed(false); restoredMethod.current = ''; setMessage('The service closed the expired unused quote and verified that no payment attempt exists. Review the current terms before preparing a fresh quote.'); }
    } catch (error) { if (live.current) setMessage(messageFor(error, 'Quote closure could not be verified. The original purchase details are preserved; retry this same closure or check payment status.')); }
    finally { if (live.current) setBusy(false); }
  }
  async function checkout(event: React.FormEvent) {
    event.preventDefault(); if (busy || !capabilities.paymentCheckout || !agreed || !bundleId || !methodCode) return;
    setBusy(true); setMessage(''); setRedirectUrl('');
    try {
      const id = await identity(true), payload = { bundleId, mode: 'checkout' };
      mutationIntent(`customer:${id}`, 'purchase-details', { bundleId, siteId, methodCode }); setCheckoutPending(true); restoredMethod.current = methodCode;
      const key = mutationIntent(`customer:${id}`, `order:${bundleId}`, payload);
      const created = await api<{ order: Order }>('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(payload) });
      if (live.current) setOrder(created.order);
      const checkoutPayload = { siteId, methodCode }, checkoutKey = mutationIntent(`customer:${id}`, `checkout:${created.order.id}`, checkoutPayload);
      const result = await api<{ attemptId: string; state: string; redirectUrl: string | null; simulation: boolean }>(`/api/orders/${created.order.id}/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': checkoutKey }, body: JSON.stringify(checkoutPayload) });
      if (result.redirectUrl) {
        const url = new URL(result.redirectUrl);
        if (url.protocol !== 'https:' || url.username || url.password) throw Error('invalid_checkout_url');
        if (live.current) setRedirectUrl(url.href);
      }
      if (live.current) setMessage(result.simulation ? 'Simulation checkout prepared. No real payment has been taken.' : 'Checkout prepared. Continue on the payment provider page, then check the verified status here.');
    } catch (error) { if (live.current) setMessage(messageFor(error, 'Checkout could not be confirmed. Check the order before starting another payment. Retry uses the same saved request.')); }
    finally { if (live.current) setBusy(false); }
  }
  async function check() { if (busy) return; setBusy(true); setMessage(''); try { await checkPayment(); } catch (error) { if (live.current) setMessage(messageFor(error)); } finally { if (live.current) setBusy(false); } }
  async function mock(outcome: 'success' | 'failed') {
    if (busy || !order || capabilities.paymentMode !== 'mock') return; setBusy(true); setMessage('');
    try { await identity(); await api(`/api/orders/${order.id}/mock-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome }) }); await checkPayment(); }
    catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  async function logout() {
    if (busy) return; setBusy(true);
    try {
      await api('/api/session', { method: 'DELETE' }); clearSessionSecrets();
      try { for (const key of Object.keys(sessionStorage)) if (key.startsWith('pamofi.operation:customer:')) sessionStorage.removeItem(key); } catch { /* The server session was revoked; private view is still cleared. */ }
      announceSessionChange('signed_out'); if (live.current) close();
    } catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  const paymentVerified = payment?.fulfillmentState === 'fulfilled' && !!payment.entitlementId;
  const paymentSettled = !!payment && (payment.safeToRequote === true || ['fulfilled', 'reversed'].includes(payment.fulfillmentState) || (payment.fulfillmentState === 'unconfirmed' && payment.attempts.length > 0 && payment.attempts.every(attempt => ['failed', 'reversed'].includes(attempt.state))));
  const product = products.find(item => item.id === bundleId), method = methods.find(item => item.code === methodCode);
  const methodEligible = !!product && !!method && product.currency === method.currency && product.price_minor >= method.minMinor && product.price_minor <= method.maxMinor;
  function accessState(item: Entitlement) { if (item.revoked_at) return 'Reversed · unavailable'; if (BigInt(item.consumed_bytes) >= BigInt(item.byte_limit)) return 'Data used up'; if (!item.activated_at) return Date.parse(item.start_by) <= now ? 'Start deadline passed' : 'Queued · not connected'; return Date.parse(item.activated_at) + item.validity_seconds * 1000 <= now ? 'Validity ended' : 'Activated · check hotspot connection below'; }
  return <section className="workspace" aria-labelledby="customer-heading" aria-busy={busy}><div className="purchase-head"><div><div className="eyebrow">YOUR PAMOFI</div><h2 id="customer-heading" tabIndex={-1} ref={heading}>Your connection, in one place</h2></div><button className="close-button" onClick={close} aria-label="Close customer workspace">×</button></div>
    {capabilities.demo && <p className="notice">Demonstration environment. These flows do not establish real customer payment, SMS delivery, or internet connectivity.</p>}
    <div className="workspace-tabs" aria-label="Customer sections">{(['access', 'voucher', 'receipt', 'purchase', 'recovery'] as const).map(value => <button key={value} aria-pressed={tab === value} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>{value === 'access' ? 'My bundles' : value === 'voucher' ? 'Use a voucher' : value === 'receipt' ? 'Private receipt' : value === 'purchase' ? 'Buy a bundle' : 'Recovery & devices'}</button>)}</div>
    {loading && <p role="status">Checking your account…</p>}{message && <p className="feedback" role="status">{message}</p>}
    {!loading && !owner && <p className="notice">No account is active in this browser. Buying, redeeming a voucher, or creating a private receipt starts a customer account. <button className="text-button" onClick={recovered}>Recover an existing account</button></p>}
    {tab === 'access' && <><section className="workspace-card"><div className="workspace-section-head"><h3>Your bundles</h3>{owner && <button className="secondary" disabled={busy} onClick={() => { setBusy(true); refreshAccess().catch(error => setMessage(messageFor(error))).finally(() => setBusy(false)); }}>Refresh bundles</button>}</div>{access.length === 0 ? <p>No bundles are shown yet. Redeem a voucher or review the available purchase options.</p> : <ul className="access-list">{access.map(item => <li key={item.id}><strong>{item.bundle_id.toUpperCase()} · {Number(item.byte_limit) / 1e9} GB</strong><span>{accessState(item)}</span><small>{(Number(item.consumed_bytes) / 1e9).toFixed(3)} GB accounted · {item.activated_at ? `Activated ${localDate(item.activated_at)}` : `Start by ${localDate(item.start_by)}`}</small></li>)}</ul>}{nextOffset !== null && <button className="secondary" disabled={busy} onClick={() => { setBusy(true); refreshAccess(true).catch(error => setMessage(messageFor(error))).finally(() => setBusy(false)); }}>Show more bundles</button>}</section>{owner && <NetworkAccess customerId={owner} capabilities={capabilities} />}</>}
    {tab === 'voucher' && <section className="workspace-card"><h3>Use your voucher</h3><p>Enter the code from your agent or private receipt. Uploads and downloads count toward the allowance. Redeeming queues the bundle; it does not start its validity or connect you.</p>{!capabilities.vouchers ? <p className="notice">Voucher redemption is not enabled here yet.</p> : <form className="form-grid" onSubmit={redeem}><label>Voucher code<input required maxLength={40} autoComplete="off" autoCapitalize="characters" spellCheck={false} value={voucherCode} onChange={event => setVoucherCode(event.target.value.toUpperCase())} /></label><button className="primary" disabled={busy}>Redeem voucher</button></form>}</section>}
    {tab === 'receipt' && <section className="workspace-card"><h3>Receive a private agent receipt</h3><p>Create a pairing code on your own device and show it to the agent when paying. Keep this page open. Your receipt and voucher stay attached to this account.</p>{!capabilities.receiptPairing ? <p className="notice">Private receipt pairing is not enabled here yet.</p> : <><button className="primary" disabled={busy || (!!pairing && pairingState === 'pending' && Date.parse(pairing.expiresAt) > now)} onClick={pair}>Create private pairing code</button>{pairing && <div className="pairing-card"><span>SHOW THIS CODE TO YOUR AGENT</span><strong>{pairing.code}</strong><small>{pairingState === 'pending' && Date.parse(pairing.expiresAt) > now ? `Waiting for your receipt · expires ${localDate(pairing.expiresAt)}` : pairingState === 'ready' ? 'Receipt ready' : 'Pairing expired · create a new code'}</small></div>}</>}{receipt && <div className="private-receipt"><h4>{receipt.sale.simulation ? 'Demo receipt' : 'Your receipt'}</h4><p>{receipt.sale.siteName} · {receipt.sale.bundleId.toUpperCase()} · {money(receipt.sale.priceMinor, receipt.sale.currency)}</p><p>{Number(receipt.sale.byteLimit) / 1e9} GB · {receipt.sale.validitySeconds / 86400} days · Start by {localDate(receipt.sale.startBy)}</p><label>Private voucher<input readOnly value={receipt.voucher.code} autoComplete="off" /></label><button className="primary" disabled={busy || !capabilities.vouchers} onClick={() => redeem(undefined, receipt.voucher.code)}>Redeem this receipt's voucher</button><small>Receipt reference: {receipt.sale.id}</small></div>}</section>}
    {tab === 'purchase' && <section className="workspace-card"><h3>{capabilities.paymentMode === 'mock' ? 'Try a provider payment simulation' : 'Buy a bundle'}</h3>{!capabilities.paymentCheckout ? <p className="notice">Online checkout is not enabled here. Use a voucher from an authorized agent when available.</p> : <><form className="form-grid" onSubmit={checkout}><fieldset disabled={busy || !!order || checkoutPending}><label>Purchase site<select required value={siteId} onChange={event => setSiteId(event.target.value)}><option value="">Choose a site</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label><label>Bundle<select required value={bundleId} onChange={event => setBundleId(event.target.value)}><option value="">Choose a bundle</option>{products.map(item => <option key={item.id} value={item.id}>{item.id.toUpperCase()} · {money(item.price_minor, item.currency)}</option>)}</select></label>{product && <div className="summary-tile"><strong>{money(product.price_minor, product.currency)}</strong><span>{Number(product.byte_limit) / 1e9} GB · {product.validity_seconds / 86400} days · One active connection</span></div>}<label>Payment method<select required disabled={methodsLoading} value={methodCode} onChange={event => setMethodCode(event.target.value)}><option value="">{methodsLoading ? 'Checking payment methods…' : 'Choose an enabled method'}</option>{methods.map(item => <option key={item.code} value={item.code}>{item.name}</option>)}</select></label>{method && <small>Provider limits: {money(method.minMinor, method.currency)} to {money(method.maxMinor, method.currency)}.</small>}</fieldset><label className="check-label"><input type="checkbox" required checked={agreed} onChange={event => setAgreed(event.target.checked)} disabled={busy} />I have reviewed the price, allowance, and validity. {capabilities.paymentMode === 'mock' ? 'This is a simulation.' : 'Payment confirmation does not mean I am connected.'}</label><button className="primary" disabled={busy || !methodEligible || !agreed || (!!payment && (payment.fulfillmentState !== 'unconfirmed' || payment.safeToRequote === true))}>{order || checkoutPending ? 'Retry this checkout safely' : 'Prepare checkout'}</button></form>{!methodsLoading && methods.length === 0 && <p>No configured payment method is available for this bundle and site.</p>}{redirectUrl && <a className="primary button-link" href={redirectUrl} target="_blank" rel="noopener noreferrer">Continue to payment provider ↗</a>}{order && <div className="payment-status"><h4>Order {order.id.slice(0, 8)}</h4><p>{money(order.price_minor, order.currency)} · Quote expires {localDate(order.quote_expires_at)}</p><button className="secondary" disabled={busy} onClick={check}>Check verified payment status</button>{capabilities.paymentMode === 'mock' && <div className="purchase-actions"><button className="secondary" disabled={busy} onClick={() => mock('success')}>Simulate successful payment</button><button className="secondary" disabled={busy} onClick={() => mock('failed')}>Simulate failed payment</button></div>}{payment && <p role="status">{payment.safeToRequote === true ? 'Expired unused quote closed. No provider payment was initiated for this order.' : paymentVerified ? `${payment.simulation ? 'Simulated payment' : 'Payment'} verified. Your bundle is queued; internet connection is not yet confirmed.` : payment.fulfillmentState === 'reversed' ? 'Payment reversed. This purchase no longer provides usable access.' : payment.fulfillmentState === 'pending_review' ? 'Payment needs review. Do not pay again while the previous charge and accounted usage are being reconciled.' : `Payment not confirmed. ${payment.attempts.map(attempt => attempt.state.replace(/_/g, ' ')).join(', ') || 'Waiting for a verified provider result.'}`}</p>}{(!payment || payment.fulfillmentState === 'unconfirmed') && payment?.safeToRequote !== true && <div className="quote-expiry"><p>If this quote expired before a payment was attempted, the service can close it safely. This does not cancel, reverse or restart an existing provider payment.</p><button className="secondary" disabled={busy} onClick={expireUnusedQuote}>Close an expired unused quote</button></div>}{paymentSettled && <button className="secondary" disabled={busy} onClick={() => { setOrder(null); setPayment(null); setRedirectUrl(''); setAgreed(false); restoredMethod.current = ''; setMessage('Choose the terms for a new purchase.'); }}>{payment.safeToRequote === true ? 'Review a fresh quote' : 'Review another bundle'}</button>}</div>}</>}</section>}
    {tab === 'recovery' && <>{owner ? <><RecoverySetup /><CreateHandoff customerId={owner} /><section className="workspace-card"><h3>Sign out of this browser</h3>{signout ? <><p>Save your recovery details before you leave. Signing out does not end an active hotspot session; use the connection controls for that.</p><div className="purchase-actions"><button className="secondary" disabled={busy} onClick={logout}>Sign out of customer account</button><button className="secondary" disabled={busy} onClick={() => setSignout(false)}>Keep this session</button></div></> : <button className="secondary" onClick={() => setSignout(true)}>Prepare to sign out</button>}</section></> : <section className="workspace-card"><h3>Save or restore access</h3><p>Use your saved reference and recovery key to restore an existing account. Start a new account only if you do not need to recover one.</p><div className="purchase-actions"><button className="primary" onClick={recovered}>Recover my account</button><button className="secondary" disabled={busy} onClick={startAccount}>Start a new customer account</button></div></section>}</>}
  </section>;
}
