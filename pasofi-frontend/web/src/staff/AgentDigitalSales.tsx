import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { api, ApiError } from '../api';
import { type Capabilities, type Product, type Site, type Staff, bundleDuration, finishMutation, localDate, messageFor, money, mutationIntent } from '../business';

type Stock = { siteId: string; bundleId: string; quantity: number };
type Quote = { bundleId: string; siteId: string; siteName: string; priceMinor: number; currency: string; byteLimit: string; validitySeconds: number };
type Checkout = {
  id: string; orderId: string | null; quote: Quote; createdAt: string; expiresAt: string; paidAt: string | null;
  simulation: boolean; stockState: 'none' | 'reserved' | 'consumed' | 'released';
  status: 'unclaimed' | 'awaiting_payment' | 'payment_pending' | 'paid' | 'cancelled' | 'expired' | 'reversed' | 'review';
  commission: { basisPoints: number; amountMinor: number; currency: string; state: 'unearned' | 'earned' | 'reversed' | 'review' };
};
type Handoff = { code: string; url: string };
type LinkResponse = { checkout: Checkout; handoff?: Handoff | null; replayed?: boolean };
type Draft = { siteId: string; bundleId: string };
type DigitalCapabilities = Capabilities & { agentDigitalSales?: boolean; agentCheckoutRecovery?: boolean };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statusLabels: Record<Checkout['status'], string> = {
  unclaimed: 'Waiting for customer', awaiting_payment: 'Customer checkout opened', payment_pending: 'Payment awaiting confirmation',
  paid: 'Payment verified', cancelled: 'Payment cancelled', expired: 'Unused link expired', reversed: 'Payment reversed', review: 'Needs review',
};
const commissionLabels: Record<Checkout['commission']['state'], string> = {
  unearned: 'Awaiting payment', earned: 'Earned', reversed: 'Reversed', review: 'Under review',
};
function checked(value: Checkout): Checkout {
  const q = value?.quote, c = value?.commission;
  if (!value || !uuid.test(value.id) || !q || !uuid.test(q.siteId) || !/^[a-z][a-z0-9-]{0,39}$/.test(q.bundleId)
    || typeof q.siteName !== 'string' || !Number.isSafeInteger(q.priceMinor) || q.priceMinor < 1 || !/^[A-Z]{3}$/.test(q.currency)
    || !/^[1-9][0-9]{0,29}$/.test(q.byteLimit) || !Number.isSafeInteger(q.validitySeconds) || q.validitySeconds < 1
    || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.expiresAt))
    || !Object.prototype.hasOwnProperty.call(statusLabels, value.status) || !['none', 'reserved', 'consumed', 'released'].includes(value.stockState)
    || typeof value.simulation !== 'boolean' || !c || !Object.prototype.hasOwnProperty.call(commissionLabels, c.state)
    || !Number.isSafeInteger(c.amountMinor) || c.amountMinor < 0 || c.amountMinor > q.priceMinor || c.currency !== q.currency) throw Error('invalid_agent_checkout');
  return value;
}
function checkedHandoff(value: Handoff | null | undefined, checkout: Checkout): Handoff | null {
  if (!value || checkout.status !== 'unclaimed' || Date.parse(checkout.expiresAt) <= Date.now()) return null;
  const url = new URL(value.url);
  const knownOrigin = ['https://pasofi.mobile.onesa.eu', 'https://hotspot.pasofi.mobile.onesa.eu'].includes(url.origin);
  const localDemo = checkout.simulation && url.origin === location.origin && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (!/^[A-Za-z0-9_-]{43}$/.test(value.code) || (!knownOrigin && !localDemo) || url.username || url.password || url.pathname !== '/' || url.search
    || url.hash !== '#checkout?agentCheckout=' + checkout.id + '.' + value.code) throw Error('invalid_agent_checkout_link');
  return value;
}

export default function AgentDigitalSales({ staff, capabilities, sites, products, stock, onInventoryChanged }: {
  staff: Staff; capabilities: DigitalCapabilities | null; sites: Site[]; products: Product[]; stock: Stock[]; onInventoryChanged: () => void;
}) {
  const supported = capabilities?.agentCheckoutRecovery === true || capabilities?.agentDigitalSales === true;
  const selling = capabilities?.agentDigitalSales === true;
  const owner = 'staff:' + staff.staffId, boundary = owner + ':' + staff.version;
  const [siteId, setSiteId] = useState(sites[0]?.id ?? ''), [bundleId, setBundleId] = useState(products[0]?.id ?? '');
  const [rows, setRows] = useState<Checkout[]>([]), [nextOffset, setNextOffset] = useState<number | null>(null);
  const [current, setCurrent] = useState<Checkout | null>(null), [handoff, setHandoff] = useState<Handoff | null>(null);
  const [busy, setBusy] = useState(false), [pending, setPending] = useState(false), [message, setMessage] = useState('');
  const mounted = useRef(false), ownerRef = useRef(boundary), selected = useRef<string | null>(null), savedDraft = useRef<Draft | null>(null);
  const historyRevision = useRef(0), requestActive = useRef(false), currentRef = useRef<Checkout | null>(null);
  ownerRef.current = boundary; currentRef.current = current;
  const active = (expected: string) => mounted.current && ownerRef.current === expected;
  const product = products.find(item => item.id === bundleId);
  const available = stock.find(item => item.siteId === siteId && item.bundleId === bundleId)?.quantity ?? 0;
  function clearPrivateView(error: unknown, expected: string) {
    if (!active(expected)) return;
    if (error instanceof ApiError && [401, 403].includes(error.status)) { selected.current = null; setCurrent(null); setHandoff(null); setRows([]); }
  }
  async function verify() {
    const session = await api<Staff>('/api/staff/session');
    if (session.staffId !== staff.staffId || session.version !== staff.version || session.status !== 'approved' || session.role !== 'agent') throw new ApiError(401, 'staff_changed');
  }
  function accept(result: LinkResponse, expected: string) {
    const checkout = checked(result.checkout), link = checkedHandoff(result.handoff, checkout);
    if (!active(expected) || selected.current !== checkout.id) return;
    const previous = currentRef.current;
    setCurrent(checkout); setHandoff(link); currentRef.current = checkout;
    setRows(old => [checkout, ...old.filter(item => item.id !== checkout.id)]);
    if (previous?.id === checkout.id && previous.stockState !== checkout.stockState) onInventoryChanged();
  }
  async function inspect(id: string, quiet = false) {
    if (requestActive.current) return;
    const expected = boundary; requestActive.current = true;
    if (!quiet) { setBusy(true); setMessage(''); }
    try {
      await verify();
      if (!active(expected)) return;
      const result = await api<LinkResponse>('/api/staff/agent-checkouts/' + id);
      if (result.checkout.id !== id) throw Error('invalid_agent_checkout');
      accept(result, expected);
    } catch (error) {
      clearPrivateView(error, expected);
      if (active(expected) && !quiet) setMessage(messageFor(error, 'This payment status could not be checked. Do not collect a second payment.'));
    } finally { requestActive.current = false; if (active(expected) && !quiet) setBusy(false); }
  }
  async function load(offset = 0) {
    const expected = boundary, revision = ++historyRevision.current; setBusy(true); setMessage('');
    try {
      await verify();
      if (!active(expected) || revision !== historyRevision.current) return;
      const result = await api<{ checkouts: Checkout[]; hasMore: boolean; nextOffset: number | null }>('/api/staff/agent-checkouts' + (offset ? '?offset=' + offset : ''));
      const checkouts = result.checkouts.map(checked);
      if (!active(expected) || revision !== historyRevision.current) return;
      setRows(old => offset ? [...new Map([...old, ...checkouts].map(item => [item.id, item])).values()] : checkouts);
      setNextOffset(result.hasMore ? result.nextOffset : null);
      if (!selected.current && checkouts[0]) { selected.current = checkouts[0].id; await inspect(checkouts[0].id, true); }
    } catch (error) { clearPrivateView(error, expected); if (active(expected) && revision === historyRevision.current) setMessage(messageFor(error)); }
    finally { if (active(expected) && revision === historyRevision.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true; selected.current = null; savedDraft.current = null; setCurrent(null); setHandoff(null); setRows([]); setPending(false);
    if (supported) {
      try {
        const raw = sessionStorage.getItem('pamofi.operation:' + owner + ':agent-checkout');
        if (raw) {
          const draft = JSON.parse(JSON.parse(raw).payload) as Draft;
          if (!uuid.test(draft.siteId) || !/^[a-z][a-z0-9-]{0,39}$/.test(draft.bundleId)) throw Error('invalid_saved_link');
          savedDraft.current = draft; setSiteId(draft.siteId); setBundleId(draft.bundleId); setPending(true);
        }
      } catch { setMessage('The saved link request could not be read. Start another link to choose its details again.'); }
      void load();
    }
    return () => { mounted.current = false; ++historyRevision.current; };
  }, [boundary, supported]);
  useEffect(() => {
    if (!current || !['unclaimed', 'awaiting_payment', 'payment_pending'].includes(current.status)) return;
    const id = current.id;
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && !busy && selected.current === id) void inspect(id, true); }, 5000);
    return () => clearInterval(timer);
  }, [current?.id, current?.status, busy, boundary]);
  async function create(event: React.FormEvent) {
    event.preventDefault(); if (busy || (!pending && (!selling || !product || available < 1 || !siteId))) return;
    const expected = boundary; setBusy(true); setMessage('');
    try {
      await verify();
      if (!active(expected)) return;
      const payload = pending && savedDraft.current ? savedDraft.current : { siteId, bundleId };
      const key = mutationIntent(owner, 'agent-checkout', payload); savedDraft.current = payload; setPending(true);
      const result = await api<LinkResponse>('/api/staff/agent-checkouts', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(payload) });
      checked(result.checkout);
      if (result.checkout.quote.siteId !== payload.siteId || result.checkout.quote.bundleId !== payload.bundleId) throw Error('agent_checkout_terms_mismatch');
      const link = checkedHandoff(result.handoff, result.checkout);
      if (result.checkout.status === 'unclaimed' && Date.parse(result.checkout.expiresAt) > Date.now() && !link) throw Error('missing_agent_checkout_link');
      if (!active(expected)) return;
      finishMutation(owner, 'agent-checkout'); savedDraft.current = null; setPending(false); selected.current = result.checkout.id;
      accept(result, expected);
      setMessage(link ? (result.replayed ? 'The original payment link was recovered. No extra sale was created.' : 'Payment link ready. Ask the customer to open it on their own device.') : 'The original sale was recovered. Check its payment status below.');
    } catch (error) { clearPrivateView(error, expected); if (active(expected)) setMessage(messageFor(error, 'The link response could not be confirmed. Retry the saved request to recover the same link.')); }
    finally { if (active(expected)) setBusy(false); }
  }
  function startAnother() {
    if (busy) return;
    // Creating a link neither reserves stock nor starts a payment. An unknown
    // creation can safely be left unshared while the agent prepares a new link.
    finishMutation(owner, 'agent-checkout'); savedDraft.current = null; setPending(false); selected.current = null;
    setCurrent(null); setHandoff(null); setMessage('Choose the next customer’s bundle. Earlier shared links remain valid until their expiry.');
  }
  async function copy() {
    if (!handoff) return;
    const expected = boundary;
    try { await navigator.clipboard.writeText(handoff.url); if (active(expected)) setMessage('Payment link copied. Share it with this customer.'); }
    catch { if (active(expected)) setMessage('Copy is unavailable. Select the payment link to copy it manually.'); }
  }
  if (!supported) return null;
  return <section className="workspace-card agent-digital-sales" aria-labelledby="agent-digital-sales-heading">
    <div className="workspace-section-head"><div><h3 id="agent-digital-sales-heading">Card and wallet sales</h3><p>Create a payment link for the customer’s own device. They can pay by card, Apple Pay or Google Pay when their wallet is available.</p></div><button className="secondary" disabled={busy} onClick={() => void load()}>Refresh card and wallet sales</button></div>
    {!selling && <p className="notice">New card and wallet sales are paused. You can still check existing payments.</p>}
    {message && <p className="feedback" role="status">{message}</p>}
    <div className="workspace-columns"><form className="form-grid" onSubmit={create} aria-label="Create customer payment link">
      <fieldset disabled={busy || pending || !selling}>
        <label>Digital sale site<select required value={siteId} onChange={event => setSiteId(event.target.value)}><option value="">Choose a site</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
        <label>Digital bundle<select required value={bundleId} onChange={event => setBundleId(event.target.value)}><option value="">Choose a bundle</option>{products.map(item => <option key={item.id} value={item.id}>{item.id.toUpperCase()} · {money(item.price_minor, item.currency)}</option>)}</select></label>
        {product && <div className="summary-tile"><small>Customer’s bundle</small><strong>{money(product.price_minor, product.currency)}</strong><span>{Number(product.byte_limit) / 1e9} GB · {bundleDuration(product.validity_seconds)} · {available} available</span></div>}
      </fieldset>
      {pending && <p className="notice">The original link request is saved. Retrying recovers the same link.</p>}
      <button className="primary" disabled={busy || (!pending && (!selling || !product || !siteId || available < 1))}>{pending ? 'Retry saved payment link' : 'Create customer payment link'}</button>
      {(pending || current) && <button type="button" className="secondary" disabled={busy} onClick={startAnother}>Start another payment link</button>}
      <small>Payment is credited after verification. Card and wallet sales do not add cash to your shift.</small>
    </form>
    {current && <div className="summary-tile" aria-label="Selected card or wallet sale">
      <small>{current.quote.siteName} · {current.quote.bundleId.toUpperCase()}</small><strong>{money(current.quote.priceMinor, current.quote.currency)}</strong>
      <span role="status">{statusLabels[current.status]}</span>{current.simulation && <p className="notice">Test payment · no real money is collected.</p>}
      {handoff && <><div className="agent-checkout-qr"><QRCodeSVG value={handoff.url} size={180} title="Customer payment link" /></div><label>Customer payment link<input readOnly value={handoff.url} autoComplete="off" onFocus={event => event.target.select()} /></label><button type="button" className="secondary" onClick={copy}>Copy customer payment link</button><small>Open on the customer’s device · expires {localDate(current.expiresAt)}</small></>}
      {current.stockState === 'reserved' && <p>One bundle is held while this payment is checked. Ask the customer to resume their saved checkout instead of paying again.</p>}
      {current.status === 'paid' && <p>The customer’s bundle and receipt are available in their own account.</p>}
      <span>Commission: {money(current.commission.amountMinor, current.commission.currency)} · {commissionLabels[current.commission.state]}</span>
      <button type="button" className="secondary" disabled={busy} onClick={() => void inspect(current.id)}>Check this payment</button>
    </div>}</div>
    <h4>Recent card and wallet sales</h4>{rows.length === 0 ? <p>No card or wallet sales recorded yet.</p> : <div className="table-scroll"><table><thead><tr><th>Bundle</th><th>Site</th><th>Amount</th><th>Status</th><th>Commission</th><th>Details</th></tr></thead><tbody>{rows.map(item => <tr key={item.id}><td>{item.quote.bundleId.toUpperCase()}<small>{localDate(item.createdAt)}{item.simulation ? ' · Test' : ''}</small></td><td>{item.quote.siteName}</td><td>{money(item.quote.priceMinor, item.quote.currency)}</td><td>{statusLabels[item.status]}</td><td>{money(item.commission.amountMinor, item.commission.currency)}<small>{commissionLabels[item.commission.state]}</small></td><td><button className="secondary" disabled={busy} onClick={() => { selected.current = item.id; setHandoff(null); setCurrent(item); void inspect(item.id); }}>View payment details</button></td></tr>)}</tbody></table></div>}
    {nextOffset !== null && <button className="secondary" disabled={busy} onClick={() => void load(nextOffset)}>Load more card and wallet sales</button>}
  </section>;
}
