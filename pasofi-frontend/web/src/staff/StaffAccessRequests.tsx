import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { messageFor } from '../business';

const endpoint = '/api/staff/administration';
type AccessRequest = {
  id: string;
  email: string;
  revision: number;
  kind: 'staff' | 'administrator';
  status: 'pending' | 'active';
};

export default function StaffAccessRequests() {
  const [requests, setRequests] = useState<AccessRequest[] | null>(null);
  const [email, setEmail] = useState('');
  const [invitation, setInvitation] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function load(signal?: AbortSignal) {
    try {
      const result = await api<{ requests: AccessRequest[] }>(endpoint, { signal });
      if (!signal?.aborted) setRequests(result.requests);
    } catch (error) {
      if (!signal?.aborted) setNotice(messageFor(error, 'Access requests could not be loaded.'));
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setNotice(''); setInvitation('');
    try {
      const result = await api<{ invitationUrl: string }>(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'invite', email: email.trim() }),
      });
      setInvitation(result.invitationUrl);
      setEmail('');
    } catch (error) {
      setNotice(error instanceof ApiError && error.code === 'staff_invitation_unavailable'
        ? 'This email already has an account. Ask them to request staff access from PasoFi Staff.'
        : messageFor(error, 'The invitation could not be created.'));
    } finally { setBusy(false); }
  }

  async function review(request: AccessRequest, status: 'active' | 'rejected' | 'revoked') {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      await api(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'review', id: request.id, revision: request.revision, kind: request.kind, status }),
      });
      setNotice(status === 'active' && request.kind === 'staff' ? 'Staff access approved. Once this person signs in, assign their sites below.' : 'Access decision saved.');
      await load();
    } catch (error) { setNotice(messageFor(error, 'The decision could not be saved. Refresh the access requests and try again.')); }
    finally { setBusy(false); }
  }

  async function copyInvitation() {
    try { await navigator.clipboard.writeText(invitation); setNotice('Invitation link copied.'); }
    catch { setNotice('Select and copy the invitation link.'); }
  }

  return <section className="workspace-card" aria-labelledby="staff-access-requests">
    <h3 id="staff-access-requests">Staff invitations and requests</h3>
    <form className="form-grid" onSubmit={invite}>
      <label>Seller email<input type="email" maxLength={254} required value={email} onChange={event => setEmail(event.target.value)} /></label>
      <button className="secondary" disabled={busy}>Create seller invitation</button>
    </form>
    {invitation && <div className="form-grid">
      <label>One-time invitation link<input type="url" readOnly value={invitation} onFocus={event => event.currentTarget.select()} /></label>
      <button className="secondary" onClick={copyInvitation}>Copy invitation link</button>
      <small>Share this link with the intended seller. It expires in 24 hours.</small>
    </div>}
    {notice && <p role="status">{notice}</p>}
    {requests?.length === 0 && <p>No access requests.</p>}
    {requests && requests.length > 0 && <ul className="inventory-list">
      {requests.map(request => <li key={request.id + request.kind}>
        <div><strong>{request.email}</strong><small>{request.kind === 'administrator' ? 'Administrator request' : request.status === 'active' ? 'Staff access approved' : 'Staff request'}</small></div>
        {request.status === 'pending' ? <div className="purchase-actions">
          <button className="secondary" disabled={busy} onClick={() => review(request, 'active')}>Approve {request.kind} access</button>
          <button className="secondary" disabled={busy} onClick={() => review(request, 'rejected')}>Decline</button>
        </div> : <button className="secondary" disabled={busy} onClick={() => review(request, 'revoked')}>Revoke staff access</button>}
      </li>)}
    </ul>}
    <button className="text-button" disabled={busy} onClick={() => void load()}>Refresh access requests</button>
  </section>;
}
