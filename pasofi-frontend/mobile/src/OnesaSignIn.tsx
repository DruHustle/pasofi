import { useEffect, useRef, useState } from 'react';
import { Browser } from '@capacitor/browser';
import { startNativeSignIn, type NativeRegistration } from './native-oidc';
import { nativePlatform, deliverAppleCallback } from './native-oidc-ui';
import type { CustomerTab } from './CustomerAccess';
import { api, mobileApiOrigin } from './api';
import { authenticateWithAppleBrowser, openNativeOnesaSignIn } from './native-api';
import RegistrationLink from './RegistrationLink';

export default function OnesaSignIn({ enterCode, close, destination, managedReturnReady = true, resumeRegistration=false, createAccount = false, usedRegistration }: { destination: CustomerTab; enterCode: () => void; close: () => void; managedReturnReady?: boolean; resumeRegistration?:boolean; createAccount?: boolean; usedRegistration:()=>void }) {
  const [available, setAvailable] = useState(false), [loading, setLoading] = useState(true);
  const [native,setNative] = useState<NativeRegistration | null>(null);
  const platform=nativePlatform();
  const direct=Boolean(managedReturnReady && native && platform && native[platform]);
  const directSignup = direct && native?.signup === true;
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setAvailable(false); setMessage('');
    api<{ origin: string | null; handoff?: boolean; native?: NativeRegistration }>('/api/onesa/availability', { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) {
        setAvailable(value.origin === mobileApiOrigin && value.handoff === true);
        setNative(value.origin === mobileApiOrigin ? value.native ?? null : null);
      }
    }).catch(() => { if (!controller.signal.aborted) setMessage('Sign-in is temporarily unavailable.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  const launched=useRef(false);
  useEffect(()=>{
    if (createAccount && !directSignup) return;
    if (!available || loading || launched.current || (!resumeRegistration && !direct)) return;
    launched.current = true;
    if (resumeRegistration) usedRegistration();
    void openBrowser(false);
  }, [resumeRegistration, available, loading, direct, createAccount, directSignup]);
  async function openBrowser(reauthenticate: boolean) {
    if (busy || !available || !mobileApiOrigin) return;
    setBusy(true); setMessage('');
    try {
      if (direct && native && platform) {
        const url = await startNativeSignIn(native, platform, destination, sessionStorage, {reauthenticate, signup: createAccount});
        if (platform === 'ios') {
          const result = await authenticateWithAppleBrowser(mobileApiOrigin, url);
          if (result) deliverAppleCallback(result);
          else setMessage('Complete sign-in in your browser to return to this screen.');
        }
        else {
          await Browser.open({url});
          setMessage('Complete sign-in in your browser to return to this screen.');
        }
        return;
      }
      await openNativeOnesaSignIn(mobileApiOrigin);
      setMessage('Browser opened. After creating your one-time code, use the return link in the browser or choose Enter sign-in code here.');
    } catch { setMessage('Your browser could not be opened. Retry, or open the PasoFi address shown below in your browser.'); }
    finally { setBusy(false); }
  }
  if (createAccount) return <section className="workspace" aria-labelledby="onesa-app-heading" aria-busy={loading || busy}>
    <div className="purchase-head"><h2 id="onesa-app-heading">Create account</h2><button className="close-button" onClick={close} aria-label="Close registration">×</button></div>
    {loading ? <p role="status">Checking registration…</p> : available && directSignup
      ? <button className="primary" disabled={busy} onClick={() => openBrowser(false)}>{busy ? 'Opening browser…' : 'Open registration in browser'}</button>
      : <RegistrationLink tab={destination} showAdmin={false}/>}
    {message && <p role="status">{message}</p>}
  </section>;
  return <section className="workspace" aria-labelledby="onesa-app-heading" aria-busy={loading || busy}>
    <div className="purchase-head"><h2 id="onesa-app-heading">Sign in</h2><button className="close-button" onClick={close} aria-label="Close sign-in">×</button></div>
    <p>{direct ? 'After you sign in, PasoFi returns you to this screen.' : 'Sign in in your browser, then use a one-time code to open your account in the app.'}</p>
    {loading ? <p role="status">Checking sign-in…</p> : !available ? <><p role="status">Sign in on the web or use your recovery details in the app.</p><p><a href="https://pasofi.mobile.onesa.eu/#account" target="_blank" rel="noopener noreferrer">PasoFi account on the web</a></p><button className="secondary" onClick={() => setAttempt(value => value + 1)}>Check sign-in availability</button></> : <>
      {!direct && <ol className="onesa-app-steps"><li>Open PasoFi in your browser and choose <strong>Sign in</strong>.</li><li>In <strong>Account</strong>, choose <strong>Create one-time handoff code</strong>. Use only a code from your own account.</li><li>Copy your code and select the browser’s return link to open this app at Accept an account handoff. Enter the code within two minutes. Sign out of any other app account first.</li></ol>}
      <p className="private-value">PasoFi address: <strong>{mobileApiOrigin}</strong></p>
      <p>Guest purchases stay with the guest account. Save its recovery details before switching accounts.</p>
      <div className="purchase-actions"><button className="primary" disabled={busy} onClick={() => openBrowser(true)}>{busy ? 'Opening browser…' : 'Open sign-in in browser'}</button>{!direct && <button className="secondary" disabled={busy} onClick={enterCode}>Enter sign-in code</button>}</div>
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
