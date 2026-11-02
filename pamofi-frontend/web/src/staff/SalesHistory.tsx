import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { type Staff, cashDescription, localDate, messageFor, money } from '../business';
import type { Sale } from './AgentWorkspace';
import DeliveryStatus from './DeliveryStatus';

export default function SalesHistory({ staff, deliveryEnabled }: { staff: Staff; deliveryEnabled: boolean }) {
  const [sales, setSales] = useState<Sale[]>([]), [nextOffset, setNextOffset] = useState<number | null>(null);
  const [selected, setSelected] = useState<Sale | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [loaded, setLoaded] = useState(false);
  const [receipt, setReceipt] = useState<{ sale: Sale; voucher: { code: string; state: string } } | null>(null);
  const live = useRef(false);
  async function verify() { const current = await api<Staff>('/api/staff/session'); if (current.staffId !== staff.staffId || current.version !== staff.version || current.status !== 'approved') { setSales([]); setSelected(null); setReceipt(null); throw new ApiError(401, 'staff_changed'); } }
  async function load(more = false) {
    setBusy(true); setMessage('');
    try { await verify(); const result = await api<{ sales: Sale[]; hasMore: boolean; nextOffset: number | null }>(`/api/staff/sales${more && nextOffset !== null ? `?offset=${nextOffset}` : ''}`); if (live.current) { setSales(previous => more ? [...new Map([...previous, ...result.sales].map(sale => [sale.id, sale])).values()] : result.sales); setNextOffset(result.hasMore ? result.nextOffset : null); setLoaded(true); } }
    catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  useEffect(() => { live.current = true; void load(); return () => { live.current = false; }; }, [staff.staffId, staff.version]);
  async function reveal(sale: Sale) {
    setBusy(true); setMessage(''); setReceipt(null);
    try { await verify(); const result = await api<{ receipt: { sale: Sale; voucher: { code: string; state: string } } }>(`/api/staff/sales/${sale.id}/receipt`); if (live.current) setReceipt(result.receipt); }
    catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  return <div><section className="workspace-card"><div className="workspace-section-head"><div><h3>Sales and delivery</h3><p>{staff.role === 'admin' ? 'Review sales across authorized sites.' : 'Only sales at your assigned sites are available.'} Recovery keys and private account credentials are never needed for delivery support.</p></div><button className="secondary" disabled={busy} onClick={() => load()}>Refresh sales</button></div>{message && <p className="feedback" role="status">{message}</p>}
    {!loaded && !message && <p role="status">Loading sales…</p>}{loaded && sales.length === 0 && <p>No sales are available for your scope.</p>}
    {sales.length > 0 && <div className="table-scroll"><table><thead><tr><th>Sale</th><th>Site</th><th>Amount</th><th>Delivery</th><th>Review</th></tr></thead><tbody>{sales.map(sale => <tr key={sale.id}><td>{sale.bundleId.toUpperCase()}<small>{localDate(sale.soldAt)}{sale.simulation ? ' · Demo' : ''}</small></td><td>{sale.siteName}</td><td>{money(sale.priceMinor, sale.currency)}<small>{cashDescription(sale.payment, sale.simulation)}</small></td><td>{sale.delivery}</td><td><button className="secondary" disabled={busy} onClick={() => setSelected(sale)}>Delivery status</button>{staff.role === 'admin' && <button className="secondary" disabled={busy} onClick={() => reveal(sale)}>View private receipt</button>}</td></tr>)}</tbody></table></div>}{nextOffset !== null && <button className="secondary" disabled={busy} onClick={() => load(true)}>Load more sales</button>}</section>
    {selected && <DeliveryStatus key={selected.id} staff={staff} sale={selected} enabled={deliveryEnabled} close={() => setSelected(null)} />}
    {receipt && <section className="private-receipt"><div className="workspace-section-head"><h3>Private customer receipt</h3><button className="secondary" onClick={() => setReceipt(null)}>Hide receipt</button></div><p>{receipt.sale.siteName} · {receipt.sale.bundleId.toUpperCase()} · {money(receipt.sale.priceMinor, receipt.sale.currency)}</p><p className="cash-evidence">{cashDescription(receipt.sale.payment, receipt.sale.simulation)}</p><label>Voucher code<input readOnly value={receipt.voucher.code} autoComplete="off" /></label><p>State: {receipt.voucher.state}. Give this only to the customer for this sale.</p></section>}
  </div>;
}
