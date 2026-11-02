import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { type Staff, finishMutation, localDate, messageFor, mutationIntent } from '../business';

type Review = { id: string; customerId: string; siteId: string; nasId: string; state: string; version: string; uploadHigh: string; downloadHigh: string; chargedBytes: string; reservedBytes: string; absentVerifiedAt: string | null; credentialFencedAt: string | null; reason: string; accountingAnomaly: boolean };
export default function NetworkReviews({ staff }: { staff: Staff }) {
  const [reviews, setReviews] = useState<Review[]>([]), [offset, setOffset] = useState<number | null>(null), [selected, setSelected] = useState<Review | null>(null);
  const [upload, setUpload] = useState(''), [download, setDownload] = useState(''), [reason, setReason] = useState(''), [evidence, setEvidence] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const live = useRef(false);
  async function verify() { const current = await api<Staff>('/api/staff/session'); if (current.staffId !== staff.staffId || current.version !== staff.version || current.role !== 'admin' || current.status !== 'approved') throw new ApiError(401, 'staff_changed'); }
  async function load(more = false) {
    if (busy) return; setBusy(true); setMessage('');
    try { await verify(); const result = await api<{ reviews: Review[]; hasMore: boolean; nextOffset: number | null }>(`/api/admin/network/reviews${more && offset !== null ? `?offset=${offset}` : ''}`); if (live.current) { setReviews(previous => more ? [...new Map([...previous, ...result.reviews].map(item => [item.id, item])).values()] : result.reviews); setOffset(result.hasMore ? result.nextOffset : null); if (selected) setSelected(result.reviews.find(item => item.id === selected.id) ?? null); } }
    catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  useEffect(() => { live.current = true; void load(); return () => { live.current = false; }; }, [staff.staffId, staff.version]);
  function select(review: Review) { setSelected(review); setUpload(''); setDownload(''); setReason(''); setEvidence(''); setConfirmed(false); setMessage(''); }
  async function resolve(event: React.FormEvent) {
    event.preventDefault(); if (busy || !selected || !confirmed) return;
    if (!/^\d+$/.test(upload) || !/^\d+$/.test(download) || BigInt(upload) < BigInt(selected.uploadHigh) || BigInt(download) < BigInt(selected.downloadHigh) || BigInt(upload) + BigInt(download) > BigInt(selected.reservedBytes)) { setMessage('Final cumulative counts must include every observed byte and fit within the existing reservation. Do not estimate missing usage.'); return; }
    const payload = { expectedVersion: selected.version, finalUpload: upload, finalDownload: download, reason: reason.trim(), evidenceReference: evidence.trim() };
    setBusy(true); setMessage('');
    try {
      await verify(); const owner = `staff:${staff.staffId}`, operation = `network-review:${selected.id}`, key = mutationIntent(owner, operation, payload);
      const result = await api<{ state: string; grantId: string; chargedBytes: string; additionalBytes: string; replayed: boolean }>(`/api/admin/network/reviews/${selected.id}/resolve`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(payload) });
      if (result.state !== 'closed' || result.grantId !== selected.id) throw Error('unverified_resolution');
      finishMutation(owner, operation);
      if (live.current) { setReviews(previous => previous.filter(item => item.id !== selected.id)); setSelected(null); setMessage(`Review closed with ${result.chargedBytes} cumulative bytes charged. ${result.replayed ? 'The original resolution was recovered.' : 'Final router evidence and credential fencing were verified by the service.'}`); }
    } catch (error) { if (live.current) setMessage(messageFor(error, 'The review could not be closed. Keep the reservation blocked until fresh router evidence and exact final counters are available.')); }
    finally { if (live.current) setBusy(false); }
  }
  return <section className="workspace-card"><div className="workspace-section-head"><div><h3>Network accounting reviews</h3><p>Uncertain sessions stay blocked until independent router absence, credential fencing, and exact final cumulative counters are verified. This tool cannot write off unknown usage.</p></div><button className="secondary" disabled={busy} onClick={() => load()}>Refresh network reviews</button></div>{message && <p className="feedback" role="status">{message}</p>}{reviews.length === 0 ? <p>No unresolved sessions are shown.</p> : <div className="table-scroll"><table><thead><tr><th>Grant / site</th><th>Observed usage</th><th>Router evidence</th><th>Review</th></tr></thead><tbody>{reviews.map(review => <tr key={review.id}><td>{review.id}<small>Site {review.siteId} · {review.state}</small></td><td>Upload {review.uploadHigh} bytes<small>Download {review.downloadHigh} bytes</small><small>Reservation {review.reservedBytes} bytes</small></td><td>{review.absentVerifiedAt ? `Absent ${localDate(review.absentVerifiedAt)}` : 'Absence not verified'}<small>{review.credentialFencedAt ? 'Credential fenced' : 'Credential fencing missing'}</small></td><td><button className="secondary" disabled={busy} onClick={() => select(review)}>Review final accounting</button></td></tr>)}</tbody></table></div>}{offset !== null && <button className="secondary" disabled={busy} onClick={() => load(true)}>Load more network reviews</button>}
    {selected && <form className="form-grid" onSubmit={resolve}><h4>Resolve grant {selected.id}</h4><p>Reason: {selected.reason}. Record version {selected.version}.</p><fieldset disabled={busy}><label>Verified final upload bytes<input required inputMode="numeric" pattern="[0-9]+" value={upload} onChange={event => setUpload(event.target.value)} /></label><label>Verified final download bytes<input required inputMode="numeric" pattern="[0-9]+" value={download} onChange={event => setDownload(event.target.value)} /></label><label>Evidence reference<input required minLength={10} maxLength={500} value={evidence} onChange={event => setEvidence(event.target.value)} placeholder="Reference to verified router final-accounting evidence" /></label><label>Resolution reason<textarea required minLength={10} maxLength={500} rows={3} value={reason} onChange={event => setReason(event.target.value)} /></label><label className="check-label"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />These are verified final cumulative router counts, not estimates. I have checked the evidence reference.</label></fieldset>{(!selected.absentVerifiedAt || !selected.credentialFencedAt) && <p className="notice">Required router absence or credential fencing is missing. Refresh after the independent network checks complete.</p>}<button className="primary" disabled={busy || !confirmed || !selected.absentVerifiedAt || !selected.credentialFencedAt}>Resolve using verified final counts</button></form>}
  </section>;
}
