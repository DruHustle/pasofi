import CashRefunds from './CashRefunds';
import CashShifts from './CashShifts';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import DeliveryStatus from './DeliveryStatus';
import { InvoiceDeliveryFields, InvoiceDownload } from '../InvoiceActions';
import { type InvoiceDelivery, defaultInvoiceDelivery, invoiceDeliveryError, invoiceDeliveryPayload } from '../invoice-delivery';
import { type Capabilities, type Product, type Site, type Staff, type CashEvidence, cashDescription, finishMutation, localDate, messageFor, money, mutationIntent } from '../business';

type Stock = { agentId: string; siteId: string; siteName: string; bundleId: string; quantity: number };
export type Sale = { id: string; agentId: string; siteId: string; siteName: string; bundleId: string; priceMinor: number; commissionMinor: number; commissionBps: number; currency: string; byteLimit: string; validitySeconds: number; soldAt: string; startBy: string; delivery: string; simulation: boolean; payment?: CashEvidence };
type SalePayload = { siteId: string; bundleId: string; delivery: 'receipt' | 'sms' | 'both'; pairingCode?: string; phone?: string; invoiceDelivery?: InvoiceDelivery; payment?: { method: 'cash'; confirmed: true; amountMinor: number; currency: string } };
type CashReference = { code: string; status: string; expiresAt: string; quote: { bundleId: string; siteId: string; siteName: string; priceMinor: number; currency: string; byteLimit: string; validitySeconds: number } };
type Receipt = { sale: Sale; voucher: { id: string; code: string; state: string } };
const normalizedPairing = (value: string) => value.toUpperCase().replace(/[-\s]/g, '');
const normalizedPhone = (value: string) => value.replace(/[\s()-]/g, '').replace(/^\+/, '').replace(/^0(?=7[0-9]{8}$)/, '263');
function invalidDelivery(payload: SalePayload): string | null {
  if (payload.delivery !== 'sms' && !/^[A-Z2-9]{10}$/.test(normalizedPairing(payload.pairingCode ?? ''))) return 'Enter the complete 10-character pairing code from the customer’s device. Spaces and hyphens are accepted.';
  if (payload.delivery !== 'receipt' && !/^263[0-9]{9}$/.test(normalizedPhone(payload.phone ?? ''))) return 'Enter a valid Zimbabwe number, for example +263 77 123 4567 or 077 123 4567.';
  return null;
}
export default function AgentWorkspace({ staff, capabilities }: { staff: Staff; capabilities: Capabilities | null }) {
  const [sites, setSites] = useState<Site[]>([]), [products, setProducts] = useState<Product[]>([]), [stock, setStock] = useState<Stock[]>([]);
  const [sales, setSales] = useState<Sale[]>([]), [nextOffset, setNextOffset] = useState<number | null>(null);
  const [siteId, setSiteId] = useState(''), [bundleId, setBundleId] = useState('');
  const [delivery, setDelivery] = useState<'receipt' | 'sms' | 'both'>('receipt'), [pairingCode, setPairingCode] = useState(''), [phone, setPhone] = useState('');
  const [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [message, setMessage] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null), [pending, setPending] = useState(false);
  const [cashReference, setCashReference] = useState<CashReference | null>(null);
  const [invoiceDelivery, setInvoiceDelivery] = useState<InvoiceDelivery>(() => defaultInvoiceDelivery(capabilities));
  const [deliverySale, setDeliverySale] = useState<Sale | null>(null);
  const invoiceChoiceExplicit = useRef(false);
  useEffect(() => {
    if (loaded && !busy && !pending && !invoiceChoiceExplicit.current) setInvoiceDelivery(defaultInvoiceDelivery(capabilities));
  }, [loaded, busy, pending, capabilities?.invoices, capabilities?.invoiceEmail, capabilities?.invoiceSms]);
  const live = useRef(false), savedPayload = useRef<SalePayload | null>(null), printCleanup = useRef<(() => void) | null>(null), owner = `staff:${staff.staffId}`;
  async function verify() { try { const current = await api<Staff>('/api/staff/session'); if (current.staffId !== staff.staffId || current.version !== staff.version || current.status !== 'approved' || current.role !== 'agent') throw new ApiError(401, 'staff_changed'); } catch (error) { if (error instanceof ApiError && [401, 403].includes(error.status)) { setLoaded(false); setSales([]); setStock([]); setReceipt(null); setDeliverySale(null); setPairingCode(''); setCashReference(null); setPhone(''); invoiceChoiceExplicit.current = false; setInvoiceDelivery(defaultInvoiceDelivery(capabilities)); } throw error; } }
  async function load() {
    setBusy(true); setMessage('');
    try {
      await verify();
      const [locations, catalogue, inventory, history] = await Promise.all([
        api<{ sites: Site[] }>('/api/staff/sites'), api<{ products: Product[] }>('/api/bundles'),
        api<{ inventory: Stock[] }>('/api/staff/inventory'), api<{ sales: Sale[]; hasMore: boolean; nextOffset: number | null }>('/api/staff/sales'),
      ]);
      if (!live.current) return;
      setSites(locations.sites); setProducts(catalogue.products); setStock(inventory.inventory); setSales(history.sales); setNextOffset(history.hasMore ? history.nextOffset : null); setLoaded(true);
      setSiteId(value => value || locations.sites[0]?.id || ''); setBundleId(value => value || catalogue.products[0]?.id || '');
      const saved = sessionStorage.getItem(`pamofi.operation:${owner}:sale`);
      if (saved) {
        const draft = JSON.parse(JSON.parse(saved).payload) as SalePayload;
        savedPayload.current = draft;
        setSiteId(draft.siteId); setBundleId(draft.bundleId); setDelivery(draft.delivery); setPairingCode(draft.pairingCode ?? ''); setPhone(draft.phone ?? ''); invoiceChoiceExplicit.current = true; setInvoiceDelivery(draft.invoiceDelivery ?? { channel: 'download' }); setPending(true);
        setMessage('A sale request is awaiting confirmation. Its original details have been restored; safely retry that request before starting another sale.');
      }
    } catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  useEffect(() => { live.current = true; invoiceChoiceExplicit.current = false; setInvoiceDelivery(defaultInvoiceDelivery(capabilities)); void load(); return () => { live.current = false; printCleanup.current?.(); }; }, [staff.staffId, staff.version]);
  const product = products.find(item => item.id === bundleId), available = stock.find(item => item.siteId === siteId && item.bundleId === bundleId)?.quantity ?? 0;
  async function lookupReference() {
    if (busy || pending) return;
    const code = normalizedPairing(pairingCode);
    if (!/^[A-Z2-9]{10}$/.test(code) || !siteId) { setMessage('Choose the sale site and enter the complete customer reference.'); return; }
    setBusy(true); setConfirmed(false); setCashReference(null); setMessage('');
    try {
      await verify();
      const result = await api<Omit<CashReference, 'code'>>('/api/staff/cash-references/lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, siteId }) });
      if (!live.current) return;
      if (result.status !== 'pending' || !result.quote || Date.parse(result.expiresAt) <= Date.now()) { setMessage('This reference is no longer awaiting payment. Ask the customer to check its receipt or create a new reference.'); return; }
      setCashReference({ ...result, code }); setBundleId(result.quote.bundleId);
      setMessage('Reference verified. Confirm the displayed bundle and location with the customer before receiving cash.');
    } catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  async function sell(event: React.FormEvent) {
    event.preventDefault(); if (busy || !confirmed || !capabilities?.staffSales || (!pending && !product)) return;
    if (!pending && delivery !== 'sms' && (!cashReference || cashReference.code !== normalizedPairing(pairingCode) || cashReference.quote.siteId !== siteId || cashReference.quote.bundleId !== bundleId || Date.parse(cashReference.expiresAt) <= Date.now())) { setConfirmed(false); setMessage('Look up the current cash reference before receiving payment.'); return; }
    if (!pending && capabilities?.invoices) {
      const error = invoiceDeliveryError(invoiceDelivery);
      if (error) { setMessage(error); setConfirmed(false); return; }
      if ((invoiceDelivery.channel === 'email' && !capabilities.invoiceEmail) || (invoiceDelivery.channel === 'sms' && !capabilities.invoiceSms)) { setMessage('That invoice delivery method is unavailable. Choose Download PDF or another available method.'); setConfirmed(false); return; }
    }
    // A legacy pending body must replay byte-for-byte, without inventing a new cash attestation.
    const payload: SalePayload = pending && savedPayload.current ? savedPayload.current : { siteId, bundleId, delivery, ...(delivery !== 'sms' ? { pairingCode: normalizedPairing(pairingCode) } : {}), ...(delivery !== 'receipt' ? { phone: normalizedPhone(phone) } : {}), ...(capabilities?.invoices ? { invoiceDelivery: invoiceDeliveryPayload(invoiceDelivery) } : {}), payment: { method: 'cash', confirmed: true, amountMinor: product!.price_minor, currency: product!.currency } };
    const invalid = invalidDelivery(payload);
    // Validate new input before saving an immutable retry request. An old saved
    // request is still sent unchanged and needs an authoritative rejection.
    if (!pending && invalid) { setMessage(invalid); setConfirmed(false); return; }
    setBusy(true); setMessage(''); setReceipt(null);
    try {
      await verify();
      const key = mutationIntent(owner, 'sale', payload); savedPayload.current = payload; setPending(true);
      const result = await api<{ sale: Sale; replayed: boolean }>('/api/staff/sales', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(payload) });
      finishMutation(owner, 'sale');
      if (!live.current) return;
      savedPayload.current = null; setPending(false); setConfirmed(false); setPairingCode(''); setCashReference(null); setPhone(''); invoiceChoiceExplicit.current = false; setInvoiceDelivery(defaultInvoiceDelivery(capabilities)); setSales(previous => [result.sale, ...previous.filter(item => item.id !== result.sale.id)]);
      setMessage(`${result.sale.simulation ? 'Demo sale' : 'Sale'} confirmed: ${money(result.sale.priceMinor, result.sale.currency)}. ${result.replayed ? 'The original receipt was recovered; stock was not debited twice.' : 'The voucher is issued. A delivery request does not mean an SMS has arrived.'}`);
      try { const refreshed = await api<{ inventory: Stock[] }>('/api/staff/inventory'); if (live.current) setStock(refreshed.inventory); } catch { if (live.current) setMessage('Sale confirmed. The latest inventory could not be loaded; refresh before starting another sale.'); }
    } catch (error) {
      // Only these domain rejections run after the same-key replay lock and roll back.
      // Gateway/availability errors can race another committed request and stay pending.
      const invalidSavedRequest = error instanceof ApiError && error.status === 400 && error.code === 'invalid_sale' && !!invalid;
      const rolledBack = invalidSavedRequest || (error instanceof ApiError && error.status === 409 && ['cash_sale_site_unavailable', 'out_of_stock', 'bundle_unavailable', 'pairing_unavailable', 'pairing_terms_mismatch', 'shift_required', 'pairing_required', 'invalid_phone', 'cash_confirmation_required', 'cash_amount_mismatch'].includes(error.code));
      if (rolledBack) { finishMutation(owner, 'sale'); savedPayload.current = null; }
      if (live.current) { if (rolledBack) { setPending(false); setConfirmed(false); setCashReference(null); setMessage(`${invalidSavedRequest ? invalid : messageFor(error)} This request did not record a sale or debit inventory. Review the details before trying again.`); } else setMessage(messageFor(error, 'The sale response could not be verified. Retry the saved request to check the same sale; do not collect payment again.')); }
    }
    finally { if (live.current) setBusy(false); }
  }
  async function reveal(sale: Sale) {
    if (busy) return; setBusy(true); setMessage(''); setReceipt(null);
    try { await verify(); const result = await api<{ receipt: Receipt }>(`/api/staff/sales/${sale.id}/receipt`); if (live.current) setReceipt(result.receipt); }
    catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  async function copyVoucher() {
    if (!receipt) return;
    try { await navigator.clipboard.writeText(receipt.voucher.code); setMessage('Voucher copied. Give it only to the customer for this sale.'); }
    catch { setMessage('Copy is unavailable. Select the voucher code to copy it manually.'); }
  }
  function printReceipt() {
    if (!receipt || document.body.classList.contains('printing-agent-receipt')) return;
    const printable = document.createElement('section');
    printable.className = 'agent-print-receipt';
    const lines = [
      'Pasofi private receipt',
      `Sale reference: ${receipt.sale.id}`,
      `${receipt.sale.siteName} · ${localDate(receipt.sale.soldAt)}`,
      `${receipt.sale.bundleId.toUpperCase()} · ${money(receipt.sale.priceMinor, receipt.sale.currency)}`,
      `${Number(receipt.sale.byteLimit) / 1e9} GB · ${receipt.sale.validitySeconds / 86400} days · Start by ${localDate(receipt.sale.startBy)}`,
      cashDescription(receipt.sale.payment, receipt.sale.simulation),
      `Voucher: ${receipt.voucher.code}`,
      `Voucher state: ${receipt.voucher.state}`,
    ];
    for (const line of lines) { const paragraph = document.createElement('p'); paragraph.textContent = line; printable.append(paragraph); }
    document.body.append(printable);
    document.body.classList.add('printing-agent-receipt');
    const cleanup = () => { printable.remove(); document.body.classList.remove('printing-agent-receipt'); window.removeEventListener('afterprint', cleanup); if (printCleanup.current === cleanup) printCleanup.current = null; };
    printCleanup.current = cleanup;
    window.addEventListener('afterprint', cleanup, { once: true });
    try { window.print(); } catch { cleanup(); setMessage('Printing is unavailable. Copy the voucher or use the customer receipt.'); }
  }
  async function more() {
    if (busy || nextOffset === null) return; setBusy(true);
    try {
      await verify(); const result = await api<{ sales: Sale[]; hasMore: boolean; nextOffset: number | null }>(`/api/staff/sales?offset=${nextOffset}`);
      if (live.current) { setSales(previous => [...new Map([...previous, ...result.sales].map(item => [item.id, item])).values()]); setNextOffset(result.hasMore ? result.nextOffset : null); }
    } catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  return <div className="agent-workspace"><div className="workspace-section-head"><div><h3>Your sites and sales</h3><p>Open a cash shift for the sale location and currency before receiving payment. Sell only from assigned inventory; prices and commission come from the confirmed server receipt.</p></div><button className="secondary" disabled={busy} onClick={load}>Refresh inventory and sales</button></div>
    {message && <p className="feedback" role="status">{message}</p>}{!loaded && !message && <p role="status">Loading your assigned sites…</p>}
    {loaded && <div className="workspace-columns"><section className="workspace-card"><h3>{capabilities?.demo ? 'Try a demo sale' : 'Issue a voucher'}</h3>
      {!capabilities?.staffSales && <p className="notice">Voucher sales are not enabled in this environment.</p>}
      <form className="form-grid" onSubmit={sell}><fieldset disabled={busy || !capabilities?.staffSales || pending} onChange={() => { setConfirmed(false); setCashReference(null); }}>
        <label>Sale site<select required value={siteId} onChange={event => setSiteId(event.target.value)}><option value="">Choose a site</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
        <label>Bundle<select required value={bundleId} onChange={event => setBundleId(event.target.value)}><option value="">Choose a bundle</option>{products.map(item => <option key={item.id} value={item.id}>{item.id.toUpperCase()} · {money(item.price_minor, item.currency)} · {Number(item.byte_limit) / 1e9} GB</option>)}</select></label>
        {product && <div className="summary-tile"><small>{pending ? 'Selected bundle terms · original receipt decides the sale amount' : 'Exact cash amount to receive'}</small><strong>{money(product.price_minor, product.currency)}</strong><span>{Number(product.byte_limit) / 1e9} GB · {product.validity_seconds / 86400} days · {available} in stock</span></div>}
        <label>Customer delivery<select value={delivery} onChange={event => setDelivery(event.target.value as typeof delivery)}><option value="receipt">Private receipt · paired customer account</option><option value="sms" disabled={!capabilities?.deliverySms}>SMS voucher · no paired account{!capabilities?.deliverySms ? " · not configured" : ""}</option><option value="both" disabled={!capabilities?.deliverySms}>Paired private receipt and SMS{!capabilities?.deliverySms ? " · not configured" : ""}</option></select></label>
        {delivery !== 'sms' && <label>Customer pairing code<input required autoComplete="off" autoCapitalize="characters" maxLength={32} value={pairingCode} onChange={event => setPairingCode(event.target.value.toUpperCase())} /><small>Ask the customer to create this code on their own device. The voucher will be shown only in that paired account.</small></label>}
        {delivery !== 'sms' && <><button type="button" className="secondary" onClick={lookupReference}>Look up cash reference</button>{cashReference && <p className="notice">Verified: {cashReference.quote.siteName} · {cashReference.quote.bundleId.toUpperCase()} · {money(cashReference.quote.priceMinor, cashReference.quote.currency)} · expires {localDate(cashReference.expiresAt)}</p>}</>}
        {delivery !== 'receipt' && <label>Customer mobile number<input type="tel" required autoComplete="off" placeholder="+263…" maxLength={20} value={phone} onChange={event => setPhone(event.target.value)} /><small>Use the international format. Delivery depends on the configured provider and verified delivery status. {delivery === 'sms' ? 'Anyone holding an unpaired voucher can redeem it; verify the customer number before issuing.' : 'The voucher stays bound to the paired customer account.'}</small></label>}
      </fieldset>{capabilities?.invoices && <InvoiceDeliveryFields value={invoiceDelivery} onChange={value => { invoiceChoiceExplicit.current = true; setInvoiceDelivery(value); setConfirmed(false); }} disabled={busy || !capabilities.staffSales || pending} emailEnabled={capabilities.invoiceEmail} smsEnabled={capabilities.invoiceSms} />}{pending && <p className="notice">This checks the original sale. Do not collect cash again. The recovered receipt will show its recorded amount and confirmation.</p>}<label className="check-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} />{pending ? `I will retry this ${capabilities?.demo ? 'simulated sale' : 'saved sale'} without collecting payment again.` : capabilities?.demo ? `I confirm this simulated sale records ${product ? money(product.price_minor, product.currency) : 'the displayed amount'} in cash. No real money was received.` : `I have received ${product ? money(product.price_minor, product.currency) : 'the displayed amount'} in cash from this customer.`}</label>
        <button className="primary" disabled={busy || !confirmed || !capabilities?.staffSales || (!pending && (!product || available < 1 || (delivery !== 'sms' && !cashReference)))}>{pending ? 'Retry saved sale safely' : capabilities?.demo ? 'Confirm demo sale' : 'Confirm cash and issue voucher'}</button>
      </form>
    </section><section className="workspace-card"><h3>Available inventory</h3>{stock.length === 0 ? <p>No stock is assigned. Ask an administrator to allocate bundles for your site.</p> : <ul className="inventory-list">{stock.map(item => <li key={`${item.siteId}:${item.bundleId}`}><div><strong>{item.siteName}</strong><span>{item.bundleId.toUpperCase()}</span></div><strong>{item.quantity}</strong></li>)}</ul>}</section></div>}
    <CashShifts staff={staff} selling={!!capabilities?.staffSales} />
    <CashRefunds staff={staff} />
    {receipt && <section className="private-receipt"><div className="workspace-section-head"><h3>Private customer receipt</h3><button className="secondary" onClick={() => setReceipt(null)}>Hide receipt</button></div><p>{receipt.sale.siteName} · {localDate(receipt.sale.soldAt)}</p><strong>{receipt.sale.bundleId.toUpperCase()} · {money(receipt.sale.priceMinor, receipt.sale.currency)}</strong><p>{Number(receipt.sale.byteLimit) / 1e9} GB · {receipt.sale.validitySeconds / 86400} days · Start by {localDate(receipt.sale.startBy)}</p><p className="cash-evidence">{cashDescription(receipt.sale.payment, receipt.sale.simulation)}</p><label>Voucher code<input readOnly value={receipt.voucher.code} autoComplete="off" onFocus={event => event.target.select()} /></label><div className="purchase-actions"><button className="secondary" onClick={copyVoucher}>Copy voucher</button><button className="secondary" onClick={printReceipt}>Print receipt</button>{capabilities?.invoices && <InvoiceDownload scope="staff" ownerKey={`${owner}:${staff.version}`} verify={verify} saleId={receipt.sale.id} disabled={busy} />}</div><p>State: {receipt.voucher.state}. Give this only to the customer for this sale.</p><small>Sale reference: {receipt.sale.id}</small></section>}
    <section className="workspace-card"><h3>Recent sales</h3>{sales.length === 0 ? <p>No sales recorded for your account yet.</p> : <div className="table-scroll"><table><thead><tr><th>Sale</th><th>Site</th><th>Amount</th><th>Commission</th><th>Delivery</th><th>Receipt</th></tr></thead><tbody>{sales.map(sale => <tr key={sale.id}><td><strong>{sale.bundleId.toUpperCase()}</strong><small>{localDate(sale.soldAt)}{sale.simulation ? ' · Demo' : ''}</small><small>Sale reference: {sale.id}</small></td><td>{sale.siteName}</td><td>{money(sale.priceMinor, sale.currency)}<small>{cashDescription(sale.payment, sale.simulation)}</small></td><td>{money(sale.commissionMinor, sale.currency)}</td><td>{sale.delivery}<button className="secondary" disabled={busy} onClick={() => setDeliverySale(sale)}>Delivery status</button></td><td><button className="secondary" disabled={busy} onClick={() => reveal(sale)}>View private receipt</button>{capabilities?.invoices && <InvoiceDownload scope="staff" ownerKey={`${owner}:${staff.version}`} verify={verify} saleId={sale.id} disabled={busy} />}</td></tr>)}</tbody></table></div>}{nextOffset !== null && <button className="secondary" disabled={busy} onClick={more}>Load more sales</button>}</section>
    {deliverySale && <DeliveryStatus key={deliverySale.id} staff={staff} sale={deliverySale} enabled={!!capabilities?.deliverySms} close={() => setDeliverySale(null)} />}
  </div>;
}
