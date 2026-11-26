import { useEffect, useRef, useState } from 'react';
import { Browser } from '@capacitor/browser';
import { startNativeSignIn, type NativeRegistration } from './native-oidc';
import { nativePlatform, deliverAppleCallback } from './native-oidc-ui';
import type { CustomerTab } from './CustomerAccess';
import { api, mobileApiOrigin } from './api';
import { authenticateWithAppleBrowser } from './native-api';

export default function OnesaSignIn({ close, destination, managedReturnReady = true, resumeRegistration=false, usedRegistration }: { destination: CustomerTab; close: () => void; managedReturnReady?: boolean; resumeRegistration?:boolean; usedRegistration:()=>void }) {
  const [available, setAvailable] = useState(false), [loading, setLoading] = useState(true);
  const [native,setNative] = useState<NativeRegistration | null>(null);
  const platform=nativePlatform();
  const direct=Boolean(managedReturnReady && native && platform && native[platform]);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setAvailable(false); setMessage('');
    api<{ origin: string | null; handoff?: boolean; native?: NativeRegistration }>('/api/onesa/availability', { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) {
        setAvailable(value.origin === mobileApiOrigin);
        setNative(value.origin === mobileApiOrigin ? value.native ?? null : null);
      }
    }).catch(() => { if (!controller.signal.aborted) setMessage('Sign-in availability could not be checked. Please try again.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  const resuming=useRef(false);
  useEffect(()=>{
    if(!resumeRegistration || !available || !direct || loading || resuming.current)return;
    resuming.current=true;
    usedRegistration();
    void openBrowser(false);
  },[resumeRegistration,available,direct,loading]);
  async function openBrowser(reauthenticate: boolean) {
    if (busy || !available || !mobileApiOrigin || !direct || !native || !platform) return;
    setBusy(true); setMessage('');
    try {
      const url = await startNativeSignIn(native, platform, destination, sessionStorage, {reauthenticate});
      if (platform === 'ios') {
        const result = await authenticateWithAppleBrowser(mobileApiOrigin, url);
        if (result) deliverAppleCallback(result);
        else setMessage('Complete sign-in in your browser to return to this screen.');
      } else {
        await Browser.open({url});
        setMessage('Complete sign-in in your browser to return to this screen.');
      }
    } catch { setMessage('Your browser could not be opened. Retry, or open the PasoFi address shown below in your browser.'); }
    finally { setBusy(false); }
  }
  return <section className="workspace" aria-labelledby="onesa-app-heading" aria-busy={loading || busy}>
    <div className="purchase-head"><h2 id="onesa-app-heading">Sign in</h2><button className="close-button" onClick={close} aria-label="Close sign-in">×</button></div>
    {loading ? <p role="status">Preparing sign-in…</p> : !available || !direct
      ? <><p role="status">Sign in to PasoFi on the web while app sign-in is unavailable.</p>
        <p><a href="https://pasofi.mobile.onesa.eu/#account" target="_blank" rel="noopener noreferrer">Open PasoFi on the web</a></p>
        <button className="secondary" onClick={() => setAttempt(value => value + 1)}>Retry app sign-in</button></>
      : <><p>PasoFi will reopen this screen when you sign in.</p>
        <button className="primary" disabled={busy} onClick={() => openBrowser(true)}>{busy ? 'Opening sign-in…' : 'Sign in'}</button></>}
    {message && <p role="status">{message}</p>}
  </section>;
}
