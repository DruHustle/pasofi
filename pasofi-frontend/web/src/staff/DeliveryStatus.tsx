import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { type Staff, finishMutation, localDate, messageFor, mutationIntent } from '../business';
import type { Sale } from './AgentWorkspace';

type Delivery = { id?: string; state: string; createdAt?: string; lastError?: string; simulation: boolean; attempts: { id: string; state: string; createdAt: string; deliveredAt: string | null; chargeAmount: string | null; chargeScale: number | null; chargeCurrency: string | null }[] };
const labels: Record<string, string> = { queued: 'Waiting for the delivery service', awaiting_delivery_details: 'Preparing the message', ready: 'Ready to submit', submitted: 'Submitted; delivery not yet confirmed', unknown: 'Delivery outcome unknown', delivered: 'Provider reports delivered', failed: 'Delivery failed', canceled: 'Delivery canceled' };
export default function DeliveryStatus({ staff, sale, enabled, close }: { staff: Staff; sale: Sale; enabled: boolean; close: () => void }) {
  const [delivery, setDelivery] = useState<Delivery | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [reason, setReason] = useState(''), [confirmed, setConfirmed] = useState(false), [pending, setPending] = useState(false);
  const live = useRef(false), owner = `staff:${staff.staffId}`, operation = `resend:${sale.id}`;
  async function verify() { const current = await api<Staff>('/api/staff/session'); if (current.staffId !== staff.staffId || current.version !== staff.version || current.status !== 'approved') { setDelivery(null); throw new ApiError(401, 'staff_changed'); } }
  async function load() {
    setBusy(true); setMessage('');
    try { await verify(); const result = await api<Delivery>(`/api/staff/sales/${sale.id}/delivery`); if (live.current) setDelivery(result); }
    catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  useEffect(() => {
    live.current = true; if (sale.delivery !== 'receipt') void load();
    try { const saved = sessionStorage.getItem(`pamofi.operation:${owner}:${operation}`); if (saved) { const payload = JSON.parse(JSON.parse(saved).payload) as { reason: string }; setReason(payload.reason); setPending(true); } } catch { /* A new mutation will refuse unsafe storage before sending. */ }
    return () => { live.current = false; };
  }, [sale.id, staff.staffId, staff.version]);
  const terminal = !!delivery && ['failed', 'delivered', 'canceled'].includes(delivery.state);
  const mayResend = enabled && staff.role !== 'support' && sale.delivery !== 'receipt';
  async function resend(event: React.FormEvent) {
    event.preventDefault(); if (busy || !confirmed || !mayResend || (!terminal && !pending) || reason.trim().length < 10) return;
    setBusy(true); setMessage('');
    try {
      await verify(); const payload = { reason: reason.trim() }, key = mutationIntent(owner, operation, payload); setPending(true);
      await api(`/api/staff/sales/${sale.id}/resend`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(payload) });
      finishMutation(owner, operation);
      if (live.current) { setPending(false); setConfirmed(false); setReason(''); setDelivery(null); setMessage('A resend request is recorded. It may incur another provider charge; delivery has not been confirmed. Refresh the status to follow this attempt.'); }
    } catch (error) { if (live.current) setMessage(messageFor(error, 'The resend could not be confirmed. Retry the saved request to check the same attempt.')); }
    finally { if (live.current) setBusy(false); }
  }
  return <section className="workspace-card" aria-label="Delivery status"><div className="workspace-section-head"><div><h3>Voucher delivery</h3><p>{sale.siteName} · {sale.bundleId.toUpperCase()} · {localDate(sale.soldAt)}</p></div><button className="secondary" onClick={close}>Close delivery status</button></div>
    {message && <p className="feedback" role="status">{message}</p>}
    {sale.delivery === 'receipt' ? <p>This sale uses a private Wi-Fi receipt. No SMS was requested. The customer can open the receipt in their paired account.</p> : <>
      {delivery && <><p className="notice"><strong>{delivery.simulation ? 'Simulated SMS: ' : 'SMS: '}{labels[delivery.state] ?? 'Status requires review'}</strong></p><p>A submitted message or accepted sale does not confirm delivery. An unknown outcome must be reconciled before a resend is allowed.</p>
        {delivery.attempts.length > 0 && <ol className="audit-list">{delivery.attempts.map(attempt => <li key={attempt.id}><strong>{labels[attempt.state] ?? attempt.state.replace(/_/g, ' ')}</strong><small>Submitted {localDate(attempt.createdAt)}{attempt.deliveredAt ? ` · Delivery reported ${localDate(attempt.deliveredAt)}` : ''}</small>{attempt.chargeAmount !== null && attempt.chargeScale !== null && <small>Reported provider charge: {(Number(attempt.chargeAmount) / 10 ** attempt.chargeScale).toFixed(Math.min(attempt.chargeScale, 8))} {attempt.chargeCurrency}</small>}</li>)}</ol>}
      </>}
      <button className="secondary" disabled={busy} onClick={load}>Refresh delivery status</button>
      {mayResend && <form className="form-grid" onSubmit={resend}><h4>Request another SMS</h4><p>Use this only after reviewing the previous outcome and the customer request. Unresolved attempts cannot be resent.</p><label>Resend reason<textarea required minLength={10} maxLength={500} rows={2} disabled={busy || pending} value={reason} onChange={event => setReason(event.target.value)} /></label><label className="check-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} />The customer requested another message and I understand a new provider charge may apply.</label><button className="primary" disabled={busy || !confirmed || reason.trim().length < 10 || (!terminal && !pending)}>{pending ? 'Retry saved resend safely' : 'Request SMS resend'}</button></form>}
      {staff.role === 'support' && <p>Support can review delivery outcomes. An authorized agent or administrator must approve any resend.</p>}
    </>}
  </section>;
}
