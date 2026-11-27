import { useEffect, useState } from 'react';
import { currentCustomerScreen, signInAvailable, startProductSignIn } from './registration';
import { hotspotPortal } from './api';
import { inspectBrowserSession, onSessionChange } from './session';

// One entry for new and returning customers: the provider's page offers both
// "Sign in" and "Sign up" and always returns to the screen that started it.
export default function OnesaCustomerSignIn({ prominent = false, compact = false }: { prominent?: boolean; compact?: boolean }) {
  const [available, setAvailable] = useState<boolean | null>(null);
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
    signInAvailable(false, controller.signal)
      .then(value => { if (!controller.signal.aborted) setAvailable(value); })
      .catch(() => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, [availabilityAttempt]);

  async function signIn(claimGuest = false) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      await startProductSignIn(false, currentCustomerScreen(), retryAccount, claimGuest);
    } catch { setError('Sign-in is temporarily unavailable. Please try again.'); setBusy(false); }
  }

  if (available === null || (account === 'member' && !retryAccount)) return null;
  if (!available) return <div className="pf-onesa-sign-in pf-onesa-sign-in-unavailable" role="group" aria-label="Customer sign-in">
    <span role="status">Sign-in unavailable</span>
    <button type="button" className="text-button" onClick={() => setAvailabilityAttempt(attempt => attempt + 1)}>Retry sign-in</button>
  </div>;

  // A compact entry sits beside another task (such as voucher redemption). A
  // guest there keeps what this browser already holds when signing in.
  if (compact) return <div className="pf-onesa-sign-in pf-onesa-sign-in-compact" aria-busy={busy}>
    <button type="button" className="text-button" disabled={busy} onClick={() => signIn(account === 'guest')}>
      {busy ? 'Opening sign-in…' : account === 'guest' ? 'Sign in and keep purchases' : 'Sign in'}
    </button>
    {error && <p role="alert">{error}</p>}
  </div>;
  const primary = prominent || hotspotPortal;
  return <div className={`pf-onesa-sign-in${primary ? ' pf-onesa-sign-in-prominent' : ''}`} aria-busy={busy}>
    <button type="button" className={primary ? 'pf-button pf-button-primary' : 'text-button'} disabled={busy} onClick={() => signIn()}>
      {busy ? 'Opening sign-in…' : retryAccount ? 'Sign in with a different account' : 'Sign in'}
    </button>
    {primary && <p className="pf-onesa-sign-in-hint">New to PasoFi? Choose <strong>Sign up</strong> on the next screen. You’ll come straight back here.</p>}
    {account === 'guest' && <div className="pf-onesa-sign-in-intro">
      <p>Have guest purchases in this browser? Keep them when you sign in.</p>
      <button className="text-button" type="button" disabled={busy} onClick={() => signIn(true)}>Keep guest purchases</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
