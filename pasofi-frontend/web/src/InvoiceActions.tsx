import { useEffect, useRef, useState } from 'react';
import { api, apiPdf, ApiError } from './api';
import { localDate, messageFor, money } from './business';
import { type Invoice, type InvoiceDelivery, invoiceDeliveryLabel, invoiceFilename, invoiceIdPattern, invoiceStatusText, parseInvoicePage } from './invoice-delivery';
import { cleanupInvoiceExports, exportInvoicePdf, invoiceExportAction } from './invoice-download';
import './invoices.css';

type InvoiceScope = 'customer' | 'staff';
type Verify = () => Promise<unknown>;
const invoiceFailure = (error: unknown) => error instanceof ApiError && [404, 405, 501].includes(error.status)
  ? 'Invoice PDFs are not available here yet.' : messageFor(error, 'The invoice PDF could not be loaded. Please try again.');

export function InvoiceDeliveryFields({ value, onChange, disabled = false, emailEnabled = false, smsEnabled = false }: {
  value: InvoiceDelivery; onChange: (value: InvoiceDelivery) => void; disabled?: boolean; emailEnabled?: boolean; smsEnabled?: boolean;
}) {
  return <div className="invoice-preference">
    <label>Invoice copy<select value={value.channel} disabled={disabled} onChange={event => onChange({ channel: event.target.value as InvoiceDelivery['channel'] })}>
      <option value="download">Download PDF</option>
      <option value="email" disabled={!emailEnabled}>Email PDF{!emailEnabled ? ' · unavailable' : ''}</option>
      <option value="sms" disabled={!smsEnabled}>SMS link{!smsEnabled ? ' · unavailable' : ''}</option>
    </select></label>
    {value.channel !== 'download' && <label>{value.channel === 'email' ? 'Invoice email' : 'Invoice mobile number'}<input
      type={value.channel === 'email' ? 'email' : 'tel'} required maxLength={value.channel === 'email' ? 254 : 24}
      autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={disabled}
      value={value.recipient ?? ''} placeholder={value.channel === 'email' ? 'you@example.com' : '+263…'}
      onChange={event => onChange({ ...value, recipient: event.target.value })}
    /></label>}
    <small>{value.channel === 'download' ? 'The paid PDF will be available with your receipt.' : value.channel === 'email' ? 'Email delivery is requested after payment; the PDF also stays available here.' : 'A private invoice link is requested after payment. The link lasts 7 days.'}</small>
  </div>;
}

export function InvoiceDownload({ scope, ownerKey, verify, invoice, saleId, orderId, disabled = false }: {
  scope: InvoiceScope; ownerKey: string; verify: Verify; invoice?: Invoice; saleId?: string; orderId?: string; disabled?: boolean;
}) {
  const [action, setAction] = useState<'pdf' | 'status' | null>(null), [message, setMessage] = useState('');
  const [resolved, setResolved] = useState<Invoice | null>(null);
  const active = useRef<AbortController | null>(null), busy = action !== null;
  const known = invoice ?? resolved, exportAction = invoiceExportAction();
  useEffect(() => {
    setAction(null); setMessage(''); setResolved(null);
    return () => { active.current?.abort(); active.current = null; };
  }, [ownerKey, scope, invoice?.id, saleId, orderId]);
  async function perform(next: 'pdf' | 'status') {
    if (disabled || active.current) return;
    const controller = new AbortController(); active.current = controller;
    const current = () => active.current === controller && !controller.signal.aborted;
    setAction(next); setMessage('');
    try {
      await verify(); if (!current()) return;
      let found = known;
      if (!found) {
        const reference = saleId ?? orderId;
        if (!reference || !invoiceIdPattern.test(reference)) throw new Error('invalid_invoice_reference');
        const filter = saleId ? 'saleId' : 'orderId';
        const page = parseInvoicePage(await api(`/api/${scope}/invoices?${filter}=${encodeURIComponent(reference)}&limit=1`, { signal: controller.signal }));
        found = page.invoices.find(item => item[filter] === reference) ?? null;
      }
      if (!current()) return;
      if (!found) { setMessage('No invoice PDF is available for this purchase yet.'); return; }
      setResolved(found);
      if (next === 'status') {
        const result = await api<{ invoice: { id: string; requestedChannel: InvoiceDelivery['channel']; delivery?: { state?: string; channel?: string | null; deliveredAt?: string } } }>(`/api/${scope}/invoices/${found.id}`, { signal: controller.signal });
        if (result.invoice?.id !== found.id || result.invoice.requestedChannel !== found.requestedChannel) throw new Error('invalid_invoice_response');
        await verify(); if (!current()) return;
        const delivery = result.invoice.delivery, text = invoiceStatusText(found.requestedChannel, delivery);
        const confirmedAt = found.requestedChannel !== 'download' && delivery?.state === 'delivered' && typeof delivery.deliveredAt === 'string' && Number.isFinite(Date.parse(delivery.deliveredAt))
          && (!delivery.channel || delivery.channel === found.requestedChannel) ? delivery.deliveredAt : null;
        setMessage(`${found.simulation ? 'Demo · ' : ''}${text}${confirmedAt ? ` Confirmed at ${localDate(confirmedAt)}.` : ''}`);
        return;
      }
      const blob = await apiPdf(`/api/${scope}/invoices/${found.id}/pdf`, { signal: controller.signal });
      await verify(); if (!current()) return;
      const result = await exportInvoicePdf(blob, invoiceFilename(found.number), controller.signal);
      if (current()) setMessage(result === 'canceled' ? '' : result === 'shared' ? 'PDF opened in your device’s share controls.' : 'PDF download started.');
    } catch (error) { if (current()) setMessage(next === 'status' && !(error instanceof ApiError && [401, 403].includes(error.status)) ? 'Delivery status is unavailable. The PDF is still available.' : invoiceFailure(error)); }
    finally { if (current()) { active.current = null; setAction(null); } }
  }
  return <span className="invoice-action"><button type="button" className="secondary invoice-button" disabled={disabled || busy} onClick={() => perform('pdf')} aria-label={invoice ? `${exportAction} invoice ${invoice.number}` : undefined}>{action === 'pdf' ? 'Loading PDF…' : exportAction === 'Save or share' ? 'Save or share PDF' : invoice ? 'PDF' : 'Invoice PDF'}</button>{(!invoice || invoice.requestedChannel !== 'download') && <button type="button" className="text-button invoice-status-button" disabled={disabled || busy} onClick={() => perform('status')} aria-label={invoice ? `Delivery status for invoice ${invoice.number}` : 'Invoice delivery status'}>{action === 'status' ? 'Checking…' : 'Delivery status'}</button>}{message && <small className="invoice-status" role="status">{message}</small>}</span>;
}

export function InvoiceHistory({ scope, ownerKey, verify }: { scope: InvoiceScope; ownerKey: string; verify: Verify }) {
  const [invoices, setInvoices] = useState<Invoice[]>([]), [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(''), [nextOffset, setNextOffset] = useState<number | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    setInvoices([]); setLoaded(false); setBusy(false); setMessage(''); setNextOffset(null);
    return () => { active.current?.abort(); active.current = null; };
  }, [ownerKey, scope]);
  async function load(more = false) {
    if (active.current || (more && nextOffset === null)) return;
    const controller = new AbortController(); active.current = controller;
    const current = () => active.current === controller && !controller.signal.aborted;
    setBusy(true); setMessage('');
    try {
      await verify(); if (!current()) return;
      const page = parseInvoicePage(await api(`/api/${scope}/invoices?limit=5&offset=${more ? nextOffset : 0}`, { signal: controller.signal }));
      if (more && page.hasMore && page.nextOffset! <= nextOffset!) throw new Error('invalid_invoice_response');
      if (!current()) return;
      setInvoices(previous => more ? [...new Map([...previous, ...page.invoices].map(item => [item.id, item])).values()] : page.invoices);
      setNextOffset(page.hasMore ? page.nextOffset : null); setLoaded(true);
    } catch (error) { if (current()) setMessage(invoiceFailure(error)); }
    finally { if (current()) { active.current = null; setBusy(false); } }
  }
  return <details className="invoice-history" onToggle={event => { if (event.currentTarget.open && !loaded && !active.current) void load(); }}>
    <summary>Paid invoices <span>PDF copies</span></summary>
    <div className="invoice-history-content">
      {message && <p className="invoice-status" role="status">{message}</p>}
      {busy && <p className="invoice-status" role="status">Loading invoices…</p>}
      {loaded && invoices.length === 0 && <p className="invoice-status">No paid invoices are available for this account yet.</p>}
      {invoices.length > 0 && <ul className="invoice-list">{invoices.map(item => <li key={item.id}>
        <div><strong>{item.number} · {money(item.totalMinor, item.currency)}</strong><small>{localDate(item.paidAt)}{item.simulation ? ' · Demo' : ''} · {invoiceDeliveryLabel(item.requestedChannel)}</small></div>
        <InvoiceDownload scope={scope} ownerKey={ownerKey} verify={verify} invoice={item} />
      </li>)}</ul>}
      <div className="invoice-history-actions"><button type="button" className="text-button" disabled={busy} onClick={() => load()}>{loaded ? 'Refresh invoices' : 'Retry invoices'}</button>{nextOffset !== null && <button type="button" className="text-button" disabled={busy} onClick={() => load(true)}>More invoices</button>}</div>
    </div>
  </details>;
}

function invoiceFragment() {
  if (!location.hash.startsWith('#invoice=')) return null;
  const token = location.hash.slice(9);
  return { token: /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null };
}

export function InvoiceLink() {
  const [link, setLink] = useState(invoiceFragment), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    const capture = () => {
      const next = invoiceFragment(); if (!next) return;
      active.current?.abort(); active.current = null; setBusy(false); setMessage(''); setLink(next);
      // The token stays in memory only: no query string, referrer, or browser storage.
      history.replaceState(history.state, '', `${location.pathname}${location.search}`);
    };
    capture(); void cleanupInvoiceExports().catch(() => {});
    addEventListener('hashchange', capture);
    return () => { removeEventListener('hashchange', capture); active.current?.abort(); active.current = null; };
  }, []);
  async function download() {
    if (!link?.token || active.current) return;
    const controller = new AbortController(); active.current = controller;
    const current = () => active.current === controller && !controller.signal.aborted;
    setBusy(true); setMessage('');
    try {
      const blob = await apiPdf('/api/invoice-downloads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: link.token }), signal: controller.signal });
      if (!current()) return;
      const result = await exportInvoicePdf(blob, 'PasoFi-paid-invoice.pdf', controller.signal);
      if (current()) setMessage(result === 'canceled' ? '' : result === 'shared' ? 'PDF opened in your device’s share controls.' : 'PDF download started. Keep your invoice private.');
    } catch (error) {
      if (current()) setMessage(error instanceof ApiError && [400, 404, 410].includes(error.status) ? 'This invoice link has expired or is unavailable. Ask the sender for a new copy.' : invoiceFailure(error));
    } finally { if (current()) { active.current = null; setBusy(false); } }
  }
  if (!link) return null;
  return <section className="invoice-link" aria-label="Private invoice link"><div><strong>Your paid invoice</strong><small>{link.token ? 'Private PDF · no sign-in needed' : 'This invoice link is invalid. Ask the sender for a new copy.'}</small>{message && <small className="invoice-status" role="status">{message}</small>}</div>{link.token && <button type="button" className="secondary invoice-button" disabled={busy} onClick={download}>{busy ? 'Loading PDF…' : `${invoiceExportAction()} PDF`}</button>}<button type="button" className="invoice-dismiss" aria-label="Dismiss invoice link" onClick={() => { active.current?.abort(); active.current = null; setLink(null); }}>×</button></section>;
}
