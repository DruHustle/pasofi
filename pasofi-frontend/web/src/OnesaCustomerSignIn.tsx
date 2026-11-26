import { useEffect, useState } from 'react';
import { currentCustomerScreen, customerSignInAvailability, registrationUrl, rememberRegistration, startProductSignIn } from './registration';
import { hotspotPortal } from './api';
import { inspectBrowserSession, onSessionChange } from './session';

export default function OnesaCustomerSignIn({ prominent = false }: { prominent?: boolean }) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [directSignup, setDirectSignup] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [availabilityAttempt, setAvailabilityAttempt] = useState(0);
  const [account, setAccount] = useState<'guest' | 'member' | null>(null);
  const retryAccount = hotspotPortal && new URLSearchParams(location.search).get('onesa') === 'retry';

  useEffect(() => {
    let active = true;
    void inspectBrowserSession().then(session => {
      if (active) setAccount(session.guest === true ? 'guest' : 'member');
    }).catch(() => {});
    const stopListening = onSessionChange(() => { active = false; setAccount(null); });
    return () => { active = false; stopListening(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setAvailable(null);
    customerSignInAvailability(controller.signal)
      .then(value => { if (!controller.signal.aborted) { setAvailable(value.available); setDirectSignup(value.signup); } })
      .catch(() => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, [availabilityAttempt]);

  async function signIn(claimGuest = false, signup = false) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await startProductSignIn(false, currentCustomerScreen(), retryAccount, claimGuest, signup);
    } catch { setError('Sign-in is temporarily unavailable. Please try again.'); setBusy(false); }
  }

  if (available === null || (account === 'member' && !retryAccount)) return null;
  const signupClass = hotspotPortal ? 'pf-button pf-button-secondary' : 'text-button';
  const signUp = available && directSignup
    ? <button type="button" className={signupClass} disabled={busy} onClick={() => signIn(false, true)}>Sign up</button>
    : <a className={signupClass} href={registrationUrl('user')} onClick={() => rememberRegistration()}>Sign up</a>;
  if (!available) return <nav className="pf-portal-links pf-onesa-sign-in-unavailable" aria-label="Customer sign-in">
    <span role="status">Sign-in unavailable</span>
    <button type="button" onClick={() => setAvailabilityAttempt(attempt => attempt + 1)}>Retry sign-in</button>
    {!hotspotPortal && signUp}
  </nav>;

  return <div className={`pf-onesa-sign-in${prominent || hotspotPortal ? ' pf-onesa-sign-in-prominent' : ''}`} aria-busy={busy}>
    <button type="button" className={prominent || hotspotPortal ? 'pf-button pf-button-primary' : undefined} disabled={busy} onClick={() => signIn()}>
      {busy ? 'Opening sign-in…' : retryAccount ? 'Sign in with a different account' : 'Sign in'}
    </button>
    {signUp}
    {account === 'guest' && <div className="pf-onesa-sign-in-intro">
      <p>Save your recovery details before switching accounts if you have guest purchases.</p>
      <button className="text-button" type="button" disabled={busy} onClick={() => signIn(true)}>Keep guest purchases</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
