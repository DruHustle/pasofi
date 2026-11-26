import { useEffect, useRef, useState } from 'react';
import { api, mobileApiOrigin, usesNativeCustomerApi } from './api';
import type { Capabilities } from './business';
import { messageFor } from './business';
import CustomerAccess, { type CustomerTab } from './CustomerAccess';
import Recovery from './Recovery';
import Handoff from './Handoff';
import RegistrationLink from './RegistrationLink';
import OnesaSignIn from './OnesaSignIn';
import { nativePlatform, watchNativeReturn } from './native-oidc-ui';
import { verifiedCallback, type NativeRegistration } from './native-oidc';
import { onSessionChange } from './session';
import Icon from './Icon';
import './customer.css';

export default function MobileCustomer({ close, initialTab = 'access', handoffReturn, registrationTab, usedRegistration }: { close: () => void; initialTab?: CustomerTab; handoffReturn: number; registrationTab:CustomerTab|null; usedRegistration:()=>void }) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null), [message, setMessage] = useState(''), [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<'account' | 'recover' | 'handoff' | 'onesa' | 'signup'>('account'), [attempt, setAttempt] = useState(0);
  const [activeTab, setActiveTab] = useState<CustomerTab>(initialTab);
  const [directSignup, setDirectSignup] = useState(false);
  const [nativeReturnReady,setNativeReturnReady]=useState(!usesNativeCustomerApi),[nativeReturnFailed,setNativeReturnFailed]=useState(false);
  const live = useRef(false);
  useEffect(()=>{
    let mounted=true;
    const listener=watchNativeReturn(destination=>{
      if(mounted){setActiveTab(destination);setScreen('account');setAttempt(n=>n+1);}
    },()=>{if(mounted)setMessage('Sign-in could not finish. Please try again.');})
      .then(stop=>{if(mounted)setNativeReturnReady(true);return stop;})
      .catch(()=>{if(mounted){setNativeReturnFailed(true);setNativeReturnReady(true);setMessage('Secure browser return is unavailable. Use the one-time account handoff instead.');}return ()=>{};});
    return ()=>{mounted=false;void listener.then(stop=>stop()).catch(()=>{});};
  },[]);
  useEffect(()=>{if(registrationTab){setActiveTab(registrationTab);setScreen('onesa');}},[registrationTab]);
  useEffect(() => { if (handoffReturn) setScreen('handoff'); }, [handoffReturn]);
  useEffect(() => {
    const platform = nativePlatform();
    if (!platform || !capabilities || !usesNativeCustomerApi || nativeReturnFailed) {
      setDirectSignup(false);
      return;
    }
    const controller = new AbortController();
    api<{ origin: string | null; handoff?: boolean; native?: NativeRegistration }>('/api/onesa/availability',
      { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setDirectSignup(value.origin === mobileApiOrigin &&
        value.handoff === true && value.native?.signup === true &&
        value.native.verifiedCallback === verifiedCallback && Boolean(value.native[platform]));
    }).catch(() => { if (!controller.signal.aborted) setDirectSignup(false); });
    return () => controller.abort();
  }, [capabilities, nativeReturnFailed]);
  useEffect(() => {
    const controller = new AbortController();
    live.current = true; setLoading(true); setMessage(''); setCapabilities(null);
    if (!mobileApiOrigin) { setLoading(false); setMessage('Mobile account access is not enabled by this deployment yet. A valid HTTPS PasoFi gateway is required. Your offline preview is still available.'); return () => { live.current = false; }; }
    // A captive network or unreachable gateway must not leave account entry
    // spinning indefinitely. Preserve the offline preview and do not sign in.
    const timeout = setTimeout(() => {
      if (!live.current || controller.signal.aborted) return;
      controller.abort();
      setCapabilities(null);
      setMessage('The configured PasoFi service did not respond in time. Your offline preview is still available.');
      setLoading(false);
    }, 12000);
    api<Capabilities>('/api/capabilities', { signal: controller.signal }).then(value => {
      if (!live.current || controller.signal.aborted) return;
      if (value.mobileCookies !== true || (usesNativeCustomerApi && value.nativeCustomerApiVersion !== 1)) { setMessage('Mobile account access is not enabled by this deployment yet. You can continue using the offline preview.'); return; }
      setCapabilities(value);
    }).catch(error => { if (live.current && !controller.signal.aborted) setMessage(messageFor(error, 'The configured PasoFi service could not be reached. Your offline preview is still available.', { readOnly: true })); }).finally(() => { clearTimeout(timeout); if (live.current && !controller.signal.aborted) setLoading(false); });
    const unsubscribe = onSessionChange(() => { clearTimeout(timeout); controller.abort(); setCapabilities(null); setLoading(true); setMessage('Your account changed. Refreshing the current account…'); setAttempt(value => value + 1); });
    return () => { live.current = false; clearTimeout(timeout); controller.abort(); unsubscribe(); };
  }, [attempt]);
  return <div className="mobile-customer"><div className="mobile-account-links">
    <p className="mobile-account-brand"><strong>PasoFi</strong> An Onesa Mobile product</p>
    <button onClick={close}>← Offline preview</button>
    {!loading && <RegistrationLink tab={activeTab} showCustomer={!directSignup}/>}
    {!loading && (!capabilities || !usesNativeCustomerApi) && <a href="https://pasofi.mobile.onesa.eu/#account" target="_blank" rel="noopener noreferrer">Continue to PasoFi account on the web</a>}
    {capabilities && <>
      {usesNativeCustomerApi && <button onClick={() => setScreen('onesa')}>Sign in</button>}
      {directSignup && <button onClick={() => setScreen('signup')}>Create account</button>}
      <button onClick={() => setScreen('account')}>My account</button>
      <button onClick={() => setScreen('recover')}>Recover</button>
      <button onClick={() => setScreen('handoff')}>Accept handoff</button>
    </>}
  </div>
    {loading && <p className="mobile-notice" role="status">Checking the configured PasoFi service…</p>}
    {message && <div className="mobile-notice"><div><p role="status">{message}</p><button className="mobile-primary" onClick={() => setAttempt(value => value + 1)}>Retry service connection</button></div></div>}
    {capabilities && (screen === 'onesa' || screen === 'signup' ? nativeReturnReady
      ? <OnesaSignIn key={screen} createAccount={screen === 'signup'} resumeRegistration={Boolean(registrationTab)} usedRegistration={usedRegistration} destination={activeTab} close={() => setScreen('account')} enterCode={() => setScreen('handoff')} managedReturnReady={!nativeReturnFailed} />
      : <p role="status">Preparing the secure sign-in return…</p>
      : screen === 'account' ? <CustomerAccess key={`account-${attempt}`} capabilities={capabilities} initialTab={activeTab} onNavigate={setActiveTab} close={close} recovered={() => setScreen('recover')} /> : screen === 'recover' ? <Recovery close={() => setScreen('account')} recovered={() => setScreen('account')} /> : <Handoff close={() => setScreen('account')} recovered={() => setScreen('account')} />)}
    {capabilities && <nav className="mobile-nav" aria-label="Account navigation">
      <button aria-current={screen === 'account' && (activeTab === 'access' || activeTab === 'wifi' || activeTab === 'voucher') ? 'page' : undefined} onClick={() => { setScreen('account'); setActiveTab('access'); }}><span className="mobile-nav-icon"><Icon name="home" /></span>Home</button>
      <button aria-current={screen === 'account' && (activeTab === 'purchase' || activeTab === 'receipt') ? 'page' : undefined} onClick={() => { setScreen('account'); setActiveTab('purchase'); }}><span className="mobile-nav-icon"><Icon name="bundles" /></span>Bundles</button>
      <button aria-current={screen === 'account' && activeTab === 'history' ? 'page' : undefined} onClick={() => { setScreen('account'); setActiveTab('history'); }}><span className="mobile-nav-icon"><Icon name="history" /></span>History</button>
      <button aria-current={screen !== 'account' || activeTab === 'recovery' ? 'page' : undefined} onClick={() => { setScreen('account'); setActiveTab('recovery'); }}><span className="mobile-nav-icon"><Icon name="account" /></span>Account</button>
    </nav>}
  </div>;
}
