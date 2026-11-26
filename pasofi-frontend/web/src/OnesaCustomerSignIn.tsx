import { useEffect, useState } from 'react';
import { accountEntryAvailability, currentCustomerScreen, registrationUrl, rememberRegistration, startProductSignIn } from './registration';
import { api, hotspotPortal } from './api';

export default function OnesaCustomerSignIn({ prominent = false }: { prominent?: boolean }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [directSignup, setDirectSignup] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [availabilityAttempt, setAvailabilityAttempt] = useState(0);
  const [guest, setGuest] = useState(false);
  const retryAccount = hotspotPortal && new URLSearchParams(location.search).get('onesa') === 'retry';
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    api<{guest?: boolean}>('/api/session', {signal:controller.signal})
      .then(value => { if (!controller.signal.aborted) setGuest(value.guest === true); }).catch(()=>{});
    return () => controller.abort();
  }, [available]);
  useEffect(() => {
    const controller = new AbortController();
    setAvailable(null);
    setDirectSignup(false);
    accountEntryAvailability(false, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) {
          setAvailable(value.signIn);
          setDirectSignup(value.signup);
        }
      })
      .catch(() => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, [availabilityAttempt]);
  async function signIn(claimGuest = false, signup = false) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await startProductSignIn(false, currentCustomerScreen(), retryAccount && !signup, claimGuest, signup);
    } catch {
      setError(signup ? 'Registration is temporarily unavailable. Please try again.' : 'Sign-in is temporarily unavailable. Please try again.');
      setBusy(false);
    }
  }
  const signupClass = hotspotPortal ? 'pf-button pf-button-secondary' : 'text-button';
  const signup = directSignup
    ? <button type="button" className={signupClass} disabled={busy} onClick={() => signIn(false, true)}>Create account</button>
    : <a className={signupClass} href={registrationUrl('user')} onClick={()=>rememberRegistration()}>Create account</a>;
  if (available === null) return <p role="status">Checking sign-in…</p>;
  if (!available) return <div className="pf-portal-links pf-onesa-sign-in-unavailable" aria-label="Customer sign-in">
    <span role="status">Sign-in is unavailable</span>
    <button type="button" onClick={() => setAvailabilityAttempt(attempt => attempt + 1)}>Retry sign-in</button>
    {!hotspotPortal && signup}
  </div>;
  return <div className={`pf-onesa-sign-in${prominent || hotspotPortal ? ' pf-onesa-sign-in-prominent' : ''}`}>
    {prominent && !hotspotPortal && <p className="pf-onesa-sign-in-intro">Sign in to see your purchases. You can browse bundles as a guest.</p>}
    <button type="button" className={prominent || hotspotPortal ? 'pf-button pf-button-primary' : undefined} disabled={busy} onClick={() => signIn()}>{busy ? 'Opening sign-in…' : retryAccount ? 'Sign in with a different account' : 'Sign in'}</button>
    {signup}
    {guest && <div className="pf-onesa-guest-purchases">
      <p>Save your recovery details before switching accounts.</p>
      <button type="button" className="text-button" disabled={busy} onClick={() => signIn(true)}>Keep guest purchases</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
