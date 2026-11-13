import { useEffect, useRef, useState } from 'react';
import { api } from './api';

export default function OnesaCustomerSignIn({ prominent = false }: { prominent?: boolean }) {
  const [available, setAvailable] = useState<boolean | null>(null), [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const opener = useRef<HTMLButtonElement>(null), confirmation = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (confirm) confirmation.current?.focus(); }, [confirm]);
  useEffect(() => {
    const controller = new AbortController();
    api<{origin:string|null}>('/api/onesa/availability', {signal:controller.signal})
      .then(value => { if (!controller.signal.aborted) setAvailable(value.origin === location.origin); })
      .catch(() => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, []);
  async function signIn() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await api<{authorizationUrl:string}>('/api/onesa/start', {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({returnTo:'/' + location.hash}),
      });
      const target = new URL(result.authorizationUrl);
      if (target.protocol !== 'https:' || target.username || target.password) throw Error();
      sessionStorage.setItem('pasofi-onesa-customer','1');
      location.assign(target.href);
    } catch { setError('Onesa sign-in is temporarily unavailable. Please try again.'); setBusy(false); }
  }
  const signup = <a href="https://portal.onesa.eu/admin?entry=register">Create an Onesa account</a>;
  function openAccount(trigger: HTMLButtonElement) {
    opener.current = trigger;
    setConfirm(true);
  }
  if (available === null) return <p role="status">Checking Company Portal sign-in…</p>;
  if (!available && prominent) return <nav className="pf-portal-links" aria-label="Company Portal account">
    <span>Company Portal</span>
    <a href="https://portal.onesa.eu/admin" aria-label="Sign in to Company Portal">Sign in</a>
    <a href="https://portal.onesa.eu/admin?entry=register" aria-label="Create an Onesa account">Sign up</a>
  </nav>;
  if (!available) return <div className="pf-onesa-sign-in">
    <a href="https://portal.onesa.eu/admin">Sign in to Company Portal</a>
    {signup}
    <p>PasoFi account access requires a connection to Company Portal.</p>
  </div>;
  return <div className={`pf-onesa-sign-in${prominent ? ' pf-onesa-sign-in-prominent' : ''}`}>
    {prominent && <div className="pf-onesa-sign-in-intro"><strong>Your Onesa account, here in PasoFi</strong><p>Sign in to open your customer account. Browsing bundles needs no account.</p></div>}
    <button className={prominent ? 'pf-button pf-button-secondary' : undefined} disabled={busy} aria-expanded={confirm} onClick={event => openAccount(event.currentTarget)}>Sign in with Onesa</button>
    <button className="text-button" disabled={busy} aria-expanded={confirm} onClick={event => openAccount(event.currentTarget)}>Create an Onesa account</button>
    {confirm && <div className="pf-onesa-confirmation" role="region" aria-label="Onesa customer sign-in" aria-busy={busy}>
      <h2 ref={confirmation} tabIndex={-1}>Continue to your Onesa account</h2>
      <p>Sign in or choose Create account in Company Portal.</p>
      <p>Open your Onesa account and return to this screen. Guest purchases stay with your guest account; save its recovery details before continuing.</p>
      <div className="purchase-actions"><button className="pf-button pf-button-primary" disabled={busy} onClick={signIn}>{busy ? 'Opening Onesa…' : 'Continue with Onesa'}</button>
      <button className="pf-button pf-button-secondary" disabled={busy} onClick={() => { setConfirm(false); setError(''); opener.current?.focus(); }}>Cancel</button></div>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
