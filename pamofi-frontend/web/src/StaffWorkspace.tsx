import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { type Capabilities, type Staff, discardStaffDrafts, announceStaffSession, onStaffSessionChange, messageFor } from './business';
import AgentWorkspace from './staff/AgentWorkspace';
import AdminWorkspace from './staff/AdminWorkspace';
import SalesHistory from './staff/SalesHistory';

type Step = 'loading' | 'login' | 'register' | 'mfa_setup' | 'mfa_verify' | 'workspace' | 'unavailable';
export default function StaffWorkspace({ close, capabilities }: { close: () => void; capabilities: Capabilities | null }) {
  const [step, setStep] = useState<Step>('loading'), [staff, setStaff] = useState<Staff | null>(null);
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState(''), [secret, setSecret] = useState(''), [expiresAt, setExpiresAt] = useState(0);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [now, setNow] = useState(Date.now());
  const challengeOwner = useRef<string | null>(null), generation = useRef(0);
  const isCurrent = (requestGeneration: number) => live.current && generation.current === requestGeneration;
  const live = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  function accept(value: Staff) {
    if (!value.staffId || !value.mfaVerified || !Array.isArray(value.siteIds)) throw Error('invalid_staff_session');
    setStaff(value); setSecret(''); setCode(''); setPassword(''); setStep('workspace');
  }
  async function load() {
    const requestGeneration = ++generation.current;
    setBusy(true); setMessage('');
    try { const current = await api<Staff>('/api/staff/session'); if (isCurrent(requestGeneration)) accept(current); }
    catch (error) {
      if (!isCurrent(requestGeneration)) return;
      setStaff(null);
      if (error instanceof ApiError && error.status === 401) setStep('login');
      else { setStep('unavailable'); setMessage(messageFor(error)); }
    } finally { if (isCurrent(requestGeneration)) setBusy(false); }
  }
  useEffect(() => {
    live.current = true; heading.current?.focus(); void load();
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    const unsubscribe = onStaffSessionChange((kind, staffId) => { generation.current++; setBusy(false); setExpiresAt(0); setStaff(null); setSecret(''); setCode(''); setPassword(''); challengeOwner.current = null; discardStaffDrafts(kind === 'signed_in' ? staffId : undefined); setStep('login'); setMessage('The staff account changed in another tab. Sign in again or refresh this workspace before continuing.'); });
    return () => { generation.current++; live.current = false; clearInterval(timer); unsubscribe(); };
  }, []);
  useEffect(() => {
    if ((step === 'mfa_setup' || step === 'mfa_verify') && expiresAt && now >= expiresAt) {
      generation.current++; challengeOwner.current = null; setBusy(false); setExpiresAt(0); setSecret(''); setCode(''); setPassword(''); setStep('login'); setMessage('Verification expired. Sign in again for a new challenge.');
    }
  }, [now, expiresAt, step]);
  async function authenticate(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    const requestGeneration = ++generation.current;
    setBusy(true); setMessage('');
    try {
      if (step === 'register') {
        await api('/api/staff/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.trim(), password, displayName: displayName.trim() }) });
        if (isCurrent(requestGeneration)) { setPassword(''); setStep('login'); setMessage('Your application has been received. Sign in and set up an authenticator; an administrator must approve your access.'); }
      } else {
        const next = await api<{ next: 'mfa_setup' | 'mfa_verify'; expiresIn: number; staffId: string }>('/api/staff/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.trim(), password }) });
        if (!['mfa_setup', 'mfa_verify'].includes(next.next) || !Number.isFinite(next.expiresIn) || typeof next.staffId !== 'string') throw Error('invalid_challenge');
        if (isCurrent(requestGeneration)) { challengeOwner.current = next.staffId; setPassword(''); setCode(''); setSecret(''); setExpiresAt(Date.now() + next.expiresIn * 1_000); setStep(next.next); }
      }
    } catch (error) { if (isCurrent(requestGeneration)) setMessage(error instanceof ApiError && error.status === 401 ? 'The sign-in details could not be verified. Check your email and password.' : messageFor(error)); }
    finally { if (isCurrent(requestGeneration)) setBusy(false); }
  }
  async function prepareMfa() {
    if (busy) return; const requestGeneration = ++generation.current; setBusy(true); setMessage('');
    try {
      const result = await api<{ secret: string; expiresIn: number; staffId: string }>('/api/staff/mfa/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (result.staffId !== challengeOwner.current || !/^[A-Z2-7]{16,128}$/.test(result.secret)) throw Error('invalid_mfa_secret');
      if (isCurrent(requestGeneration)) setSecret(result.secret);
    } catch (error) { if (isCurrent(requestGeneration)) setMessage(messageFor(error)); }
    finally { if (isCurrent(requestGeneration)) setBusy(false); }
  }
  async function verifyMfa(event: React.FormEvent) {
    event.preventDefault(); if (busy || !/^\d{6}$/.test(code)) return;
    const requestGeneration = ++generation.current;
    setBusy(true); setMessage(''); let mfaAccepted = false;
    try {
      const result = await api<Staff>(`/api/staff/mfa/${step === 'mfa_setup' ? 'confirm' : 'verify'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
      if (!isCurrent(requestGeneration)) return;
      mfaAccepted = true;
      if (result.staffId !== challengeOwner.current) throw Error('staff_session_mismatch');
      const verified = await api<Staff>('/api/staff/session');
      if (!isCurrent(requestGeneration)) return;
      if (verified.staffId !== result.staffId || verified.version !== result.version || verified.mfaVerified !== true) throw Error('staff_session_mismatch');
      if (isCurrent(requestGeneration)) { discardStaffDrafts(verified.staffId); announceStaffSession('signed_in', verified.staffId); challengeOwner.current = null; accept(verified); }
    } catch (error) { if (isCurrent(requestGeneration)) { setCode(''); if (mfaAccepted || (error instanceof Error && error.message === 'staff_session_mismatch')) { setSecret(''); challengeOwner.current = null; setStep('login'); setMessage('The verified staff session was not kept by this browser or the account changed in another tab. Sign in again; no staff account has been accepted.'); } else setMessage(messageFor(error, 'That code could not be verified. Use the current six-digit code from your authenticator.')); } }
    finally { if (isCurrent(requestGeneration)) setBusy(false); }
  }
  async function logout() {
    if (busy) return; const requestGeneration = ++generation.current; setSecret(''); setCode(''); setBusy(true); setMessage('');
    try {
      await api('/api/staff/session', { method: 'DELETE' });
      if (isCurrent(requestGeneration)) { generation.current++; setBusy(false); setExpiresAt(0); discardStaffDrafts(); announceStaffSession('signed_out'); challengeOwner.current = null; setStaff(null); setSecret(''); setCode(''); setPassword(''); setStep('login'); setMessage('Signed out of the staff workspace.'); }
    } catch (error) { if (isCurrent(requestGeneration)) setMessage(messageFor(error, 'Sign out could not be completed. Please try again.')); }
    finally { if (isCurrent(requestGeneration)) setBusy(false); }
  }
  return <section className="workspace" aria-labelledby="staff-heading" aria-busy={busy}>
    <div className="purchase-head"><div><div className="eyebrow">PAMOFI TEAM</div><h2 id="staff-heading" ref={heading} tabIndex={-1}>Staff workspace</h2></div><button className="close-button" aria-label="Close staff workspace" onClick={close}>×</button></div>
    {capabilities?.demo && <p className="notice">Demo environment. Transactions here are simulations and do not send real payments or connect customers.</p>}
    {message && <p className="feedback" role="status">{message}</p>}
    {step === 'loading' && <p role="status">Checking your staff session…</p>}
    {step === 'unavailable' && <button className="secondary" onClick={load} disabled={busy}>Retry staff connection</button>}
    {(step === 'login' || step === 'register') && <div className="workspace-auth"><div><h3>{step === 'register' ? 'Apply for staff access' : 'Welcome back'}</h3><p>{step === 'register' ? 'Every staff account needs an authenticator and administrator approval before it can sell vouchers or manage a site.' : 'Sign in with your email, password, and authenticator code.'}</p></div><form className="form-grid" onSubmit={authenticate}>
      {step === 'register' && <label>Your name<input required maxLength={80} autoComplete="name" value={displayName} onChange={event => setDisplayName(event.target.value)} /></label>}
      <label>Email<input type="email" required maxLength={254} autoComplete="username" autoCapitalize="none" value={email} onChange={event => setEmail(event.target.value)} /></label>
      <label>Password<input type="password" required minLength={step === 'register' ? 15 : 1} maxLength={128} autoComplete={step === 'register' ? 'new-password' : 'current-password'} value={password} onChange={event => setPassword(event.target.value)} /></label>
      {step === 'register' && <small>Use at least 15 characters. Keep this password separate from customer recovery details.</small>}
      <button className="primary" disabled={busy}>{step === 'register' ? 'Submit staff application' : 'Continue to verification'}</button>
    </form><button className="text-button" disabled={busy} onClick={() => { setPassword(''); setMessage(''); setStep(step === 'register' ? 'login' : 'register'); }}>{step === 'register' ? 'Already applied? Sign in' : 'New team member? Apply for access'}</button></div>}
    {(step === 'mfa_setup' || step === 'mfa_verify') && <div className="workspace-auth"><h3>{step === 'mfa_setup' ? 'Set up your authenticator' : 'Verify it is you'}</h3><p>Challenge expires in {Math.max(0, Math.ceil((expiresAt - now) / 60_000))} minutes.</p>
      {step === 'mfa_setup' && <>{!secret ? <button className="secondary" disabled={busy} onClick={prepareMfa}>Create authenticator setup key</button> : <div className="private-value"><p>Add a time-based PamoFi account in your authenticator using this setup key. Keep it private.</p><code data-testid="mfa-setup-key">{secret}</code></div>}</>}
      <form className="form-grid" onSubmit={verifyMfa}><label>Authenticator code<input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" required value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} /></label><button className="primary" disabled={busy || (step === 'mfa_setup' && !secret)}>Verify authenticator</button></form><button className="text-button" disabled={busy} onClick={logout}>Cancel sign-in</button>
    </div>}
    {step === 'workspace' && staff && <><div className="workspace-account"><div><strong>{staff.displayName}</strong><span>{staff.email}</span></div><span className={`status-pill status-${staff.status}`}>{staff.status} {staff.role ? `· ${staff.role}` : ''}</span><div className="purchase-actions"><button className="secondary" disabled={busy} onClick={load}>Refresh staff access</button><button className="secondary" disabled={busy} onClick={logout}>Sign out of staff</button></div></div>
      {staff.status === 'pending' && <div className="empty"><h3>Waiting for administrator approval</h3><p>Your authenticator is ready. An administrator must review your application and assign a role and sites before you can work with customer sales.</p></div>}
      {(staff.status === 'disabled' || staff.status === 'rejected') && <div className="empty"><h3>Staff access is {staff.status}</h3><p>This account cannot perform staff actions. Contact your PamoFi administrator to resolve access.</p></div>}
      {staff.status === 'approved' && staff.role === 'agent' && <AgentWorkspace staff={staff} capabilities={capabilities} />}
      {staff.status === 'approved' && staff.role === 'admin' && <AdminWorkspace staff={staff} capabilities={capabilities} />}
      {staff.status === 'approved' && staff.role === 'support' && <SalesHistory staff={staff} deliveryEnabled={!!capabilities?.deliverySms} />}
    </>}
  </section>;
}
