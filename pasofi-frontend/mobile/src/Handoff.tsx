import { useEffect, useRef, useState } from 'react';
import { api, usesNativeCustomerApi } from './api';
import { announceSessionChange, currentSession, clearSessionSecrets } from './session';
import { messageFor } from './business';

export default function Handoff({ close, recovered }: { close: () => void; recovered: () => void }) {
  const [code, setCode] = useState(''), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const live = useRef(false), heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { live.current = true; heading.current?.focus(); return () => { live.current = false; }; }, []);
  async function redeem(event: React.FormEvent) {
    event.preventDefault(); if (busy || !confirmed) return; setBusy(true); setMessage('');
    try {
      const result = await api<{ customerId: string }>('/api/handoff/redeem', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handoffCode: code.trim() }) });
      if (await currentSession() !== result.customerId) throw Error('session_not_kept');
      clearSessionSecrets(); announceSessionChange('recovered');
      if (live.current) { setCode(''); recovered(); }
    } catch (error) { if (live.current) setMessage(error instanceof Error && error.message === 'session_not_kept' ? (usesNativeCustomerApi ? 'The app did not keep the transferred account. Close and reopen PasoFi, then create a fresh handoff code on the original device.' : 'The browser did not keep the transferred session. Allow cookies and create a fresh handoff code on the original device.') : messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  return <section className="workspace" aria-labelledby="handoff-heading"><div className="purchase-head"><h2 id="handoff-heading" tabIndex={-1} ref={heading}>Enter a sign-in code</h2><button className="close-button" aria-label="Close handoff" onClick={close}>×</button></div><p>Paste the one-time code from your own signed-in PasoFi device. If this {usesNativeCustomerApi ? 'app' : 'browser'} already has an account, sign out before continuing. A handoff does not transfer an active Wi-Fi connection.</p><form className="form-grid" onSubmit={redeem}><label>One-time handoff code<input required type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={60} value={code} onChange={event => setCode(event.target.value)} /></label><label className="check-label"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />This code comes from my own PasoFi account and I want to use that account in this {usesNativeCustomerApi ? 'app' : 'browser'}.</label>{message && <p role="alert">{message}</p>}<button className="primary" disabled={busy || !confirmed}>Confirm sign-in</button></form></section>;
}
