import { useEffect, useRef, useState } from 'react';
import { Browser } from '@capacitor/browser';
import { startNativeSignIn, type NativeRegistration } from './native-oidc';
import { nativePlatform, deliverAppleCallback } from './native-oidc-ui';
import type { CustomerTab } from './CustomerAccess';
import { api, mobileApiOrigin } from './api';
import { authenticateWithAppleBrowser, openNativeOnesaSignIn } from './native-api';

export default function OnesaSignIn({ enterCode, close, destination, managedReturnReady = true, resumeRegistration=false, usedRegistration }: { destination: CustomerTab; enterCode: () => void; close: () => void; managedReturnReady?: boolean; resumeRegistration?:boolean; usedRegistration:()=>void }) {
  const [available, setAvailable] = useState(false), [loading, setLoading] = useState(true);
  const [native,setNative] = useState<NativeRegistration | null>(null);
  const platform=nativePlatform();
  const direct=Boolean(managedReturnReady && native && platform && native[platform]);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setAvailable(false); setMessage('');
    api<{ origin: string | null; handoff?: boolean; native?: NativeRegistration }>('/api/onesa/availability', { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) {
        setAvailable(value.origin === mobileApiOrigin && value.handoff === true);
        setNative(value.origin === mobileApiOrigin ? value.native ?? null : null);
      }
    }).catch(() => { if (!controller.signal.aborted) setMessage('Onesa sign-in availability could not be checked. Your existing account is unchanged.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [attempt]);
  const resuming=useRef(false);
  useEffect(()=>{
    if(!resumeRegistration || !available || loading || resuming.current)return;
    resuming.current=true;
    usedRegistration();
    void openBrowser();
  },[resumeRegistration,available,loading]);
  async function openBrowser() {
    if (busy || !available || !mobileApiOrigin) return;
    setBusy(true); setMessage('');
    try {
      if (direct && native && platform) {
        const url = await startNativeSignIn(native, platform, destination, sessionStorage);
        if (platform === 'ios') deliverAppleCallback(await authenticateWithAppleBrowser(mobileApiOrigin, url));
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
  return <section className="workspace" aria-labelledby="onesa-app-heading" aria-busy={loading || busy}>
    <div className="purchase-head"><h2 id="onesa-app-heading">Sign in with Onesa</h2><button className="close-button" onClick={close} aria-label="Close Onesa sign-in">×</button></div>
    <p>{direct ? 'Sign in in your system browser. PasoFi will reopen your current screen.' : 'Sign in securely in your browser, then bring that account into this app with a one-time code. Your browser and app keep separate sessions.'}</p>
    {loading ? <p role="status">Checking Onesa sign-in…</p> : !available ? <><p role="status">Onesa sign-in for this app is not available from the configured service yet. Your guest recovery options still work.</p><p><a href="https://pasofi.mobile.onesa.eu/#account" target="_blank" rel="noopener noreferrer">PasoFi account on the web</a></p><button className="secondary" onClick={() => setAttempt(value => value + 1)}>Check sign-in availability</button></> : <>
      {!direct && <ol className="onesa-app-steps"><li>Open PasoFi in your browser and choose <strong>Sign in with Onesa</strong>. Sign in or register through Onesa Identity.</li><li>In <strong>Account</strong>, choose <strong>Create one-time handoff code</strong>. Use only a code from your own account.</li><li>Copy your code and select the browser’s return link to open this app at Accept an account handoff. Enter the code within two minutes. Sign out of any other app account first.</li></ol>}
      <p className="private-value">PasoFi address: <strong>{mobileApiOrigin}</strong></p>
      <p>Guest purchases stay with the guest account. Save its recovery details before switching accounts.</p>
      <div className="purchase-actions"><button className="primary" disabled={busy} onClick={openBrowser}>{busy ? 'Opening browser…' : 'Open Onesa sign-in in browser'}</button>{!direct && <button className="secondary" disabled={busy} onClick={enterCode}>Enter sign-in code</button>}</div>
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
