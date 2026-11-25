import { useEffect, useRef, useState } from 'react';
import { currentCustomerScreen, registrationUrl, rememberRegistration, signInAvailable, startProductSignIn } from './registration';
import { hotspotPortal } from './api';

export default function OnesaCustomerSignIn({ prominent = false }: { prominent?: boolean }) {
  const [available, setAvailable] = useState<boolean | null>(null), [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [availabilityAttempt, setAvailabilityAttempt] = useState(0);
  const opener = useRef<HTMLButtonElement>(null), confirmation = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (confirm) confirmation.current?.focus(); }, [confirm]);
  useEffect(() => {
    const controller = new AbortController();
    setAvailable(null);
    signInAvailable(false, controller.signal)
      .then(value => { if (!controller.signal.aborted) setAvailable(value); })
      .catch(() => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, [availabilityAttempt]);
  async function signIn() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await startProductSignIn(false,currentCustomerScreen());
    } catch { setError('Onesa sign-in is temporarily unavailable. Please try again.'); setBusy(false); }
  }
  const signup = <a href={registrationUrl('user')} onClick={()=>rememberRegistration()}>Create an Onesa account</a>;
  function openAccount(trigger: HTMLButtonElement) {
    opener.current = trigger;
    setConfirm(true);
  }
  if (available === null) return <p role="status">Checking Onesa sign-in…</p>;
  if (!available) return <nav className="pf-portal-links pf-onesa-sign-in-unavailable" aria-label="Onesa customer account">
    <span role="status">Onesa Identity unavailable</span>
    <button type="button" disabled={busy} onClick={() => setAvailabilityAttempt(attempt => attempt + 1)}>Retry Onesa sign-in</button>
    {!hotspotPortal && signup}
  </nav>;
  if (hotspotPortal) return <nav className="pf-onesa-sign-in pf-onesa-sign-in-prominent" aria-label="Onesa customer account">
    <button type="button" className="pf-button pf-button-primary" disabled={busy} onClick={signIn}>{busy ? 'Opening Onesa…' : 'Sign in'}</button>
    <a className="pf-button pf-button-secondary" href={registrationUrl('user')} onClick={()=>rememberRegistration()}>Sign up</a>
    <p>Save your recovery details before signing in if you have guest purchases.</p>
    {error && <p role="alert">{error}</p>}
  </nav>;
  return <div className={`pf-onesa-sign-in${prominent ? ' pf-onesa-sign-in-prominent' : ''}`}>
    {prominent && <div className="pf-onesa-sign-in-intro"><strong>Your Onesa account, here in PasoFi</strong><p>Sign in to open your customer account. Browsing bundles needs no account.</p></div>}
    <button className={prominent ? 'pf-button pf-button-secondary' : undefined} disabled={busy} aria-expanded={confirm} onClick={event => openAccount(event.currentTarget)}>Sign in with Onesa</button>
    <a className="text-button" href={registrationUrl('user')} onClick={()=>rememberRegistration()}>Create an Onesa account</a>
    {confirm && <div className="pf-onesa-confirmation" role="region" aria-label="Onesa customer sign-in" aria-busy={busy}>
      <h2 ref={confirmation} tabIndex={-1}>Continue to your Onesa account</h2>
      <p>Open your Onesa account and return to this screen. Guest purchases stay with your guest account; save its recovery details before continuing.</p>
      <div className="purchase-actions"><button className="pf-button pf-button-primary" disabled={busy} onClick={signIn}>{busy ? 'Opening Onesa…' : 'Continue with Onesa'}</button>
      <button className="pf-button pf-button-secondary" disabled={busy} onClick={() => { setConfirm(false); setError(''); opener.current?.focus(); }}>Cancel</button></div>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
