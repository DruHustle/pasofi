import { useEffect, useRef, useState } from 'react';
import { api, usesNativeCustomerApi } from './api';
import { announceSessionChange, currentSession, clearSessionSecrets } from './session';
import { messageFor } from './business';

export function CreateHandoff({ customerId }: { customerId: string }) {
  const [code, setCode] = useState(''), [expires, setExpires] = useState(0), [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const live = useRef(false);
  useEffect(() => { live.current = true; const timer = setInterval(() => setNow(Date.now()), 1_000); return () => { live.current = false; clearInterval(timer); }; }, []);
  useEffect(() => { if (code && now >= expires) { setCode(''); setMessage('Handoff code expired. Create a new one when the other device is ready.'); } }, [now, expires, code]);
  async function create() {
    if (busy) return; setBusy(true); setCode(''); setMessage('');
    try {
      if (await currentSession() !== customerId) throw Error('session_changed');
      const result = await api<{ handoffCode: string; expiresIn: number }>('/api/handoff', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!/^[A-Za-z0-9_-]{43}$/.test(result.handoffCode)) throw Error('invalid_handoff');
      if (live.current) { setCode(result.handoffCode); setExpires(Date.now() + result.expiresIn * 1_000); }
    } catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  return <section className="workspace-card"><h3>Continue on another device</h3><p>Create a one-time code, open PasoFi in your other browser or app, then choose Accept handoff. The code is not placed in a URL and is valid for up to two minutes. Guest accounts can also use saved recovery details. Onesa accounts use Onesa sign-in for account recovery.</p>{message && <p role="status">{message}</p>}{code && <div className="private-value"><label>One-time handoff code<input readOnly value={code} autoComplete="off" onFocus={event => event.target.select()} /></label><small>Expires in {Math.max(0, Math.ceil((expires - now) / 1000))} seconds. Use only in your own browser or PasoFi app.</small></div>}<button className="secondary" disabled={busy} onClick={create}>{code ? 'Replace handoff code' : 'Create one-time handoff code'}</button></section>;
}

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
  return <section className="workspace" aria-labelledby="handoff-heading"><div className="purchase-head"><h2 id="handoff-heading" tabIndex={-1} ref={heading}>Accept an account handoff</h2><button className="close-button" aria-label="Close handoff" onClick={close}>×</button></div><p>Paste the one-time code from your own signed-in PasoFi device. If this {usesNativeCustomerApi ? 'app' : 'browser'} already has an account, sign out before continuing. A handoff does not transfer an active Wi-Fi connection.</p><form className="form-grid" onSubmit={redeem}><label>One-time handoff code<input required type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={60} value={code} onChange={event => setCode(event.target.value)} /></label><label className="check-label"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />This code comes from my own PasoFi account and I want to use that account in this {usesNativeCustomerApi ? 'app' : 'browser'}.</label>{message && <p role="alert">{message}</p>}<button className="primary" disabled={busy || !confirmed}>Accept account handoff</button></form></section>;
}
