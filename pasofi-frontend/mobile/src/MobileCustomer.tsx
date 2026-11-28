import { useEffect, useRef, useState } from 'react';
import { api, mobileApiOrigin, usesNativeCustomerApi } from './api';
import type { Capabilities } from './business';
import { messageFor } from './business';
import CustomerAccess, { type CustomerTab } from './CustomerAccess';
import Recovery from './Recovery';
import Handoff from './Handoff';
import RegistrationLink from './RegistrationLink';
import OnesaSignIn from './OnesaSignIn';
import { watchNativeReturn } from './native-oidc-ui';
import { onSessionChange } from './session';
import Icon from './Icon';
import './customer.css';

const webShortcuts = {
  voucher: { title: 'Redeem voucher', action: 'Redeem voucher on the web', path: '#voucher' },
  access: { title: 'Check usage', action: 'Check usage on the web', path: '#usage' },
  wifi: { title: 'My WiFi', action: 'Open My WiFi on the web', path: '#wifi' },
};
export type CustomerShortcut = keyof typeof webShortcuts;

export default function MobileCustomer({ close, initialTab = 'access', handoffReturn, registrationTab, usedRegistration, requestedBundleId = null, shortcut, goHome = close, goBundles = close }: { close: () => void; initialTab?: CustomerTab; handoffReturn: number; registrationTab:CustomerTab|null; usedRegistration:()=>void; requestedBundleId?: string | null; shortcut?: CustomerShortcut; goHome?: () => void; goBundles?: () => void }) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null), [message, setMessage] = useState(''), [loading, setLoading] = useState(true);
  const [accountDisabled, setAccountDisabled] = useState(false);
  const [screen, setScreen] = useState<'account' | 'recover' | 'handoff' | 'onesa'>('account'), [attempt, setAttempt] = useState(0);
  const [activeTab, setActiveTab] = useState<CustomerTab>(initialTab);
  const [nativeReturnReady,setNativeReturnReady]=useState(!usesNativeCustomerApi),[nativeReturnFailed,setNativeReturnFailed]=useState(false);
  const live = useRef(false);
  useEffect(()=>{
    let mounted=true;
    const listener=watchNativeReturn(destination=>{
      if(mounted){setActiveTab(destination);setScreen('account');setAttempt(n=>n+1);}
    },()=>{if(mounted)setMessage('Sign-in could not finish. Please try again.');})
      .then(stop=>{if(mounted)setNativeReturnReady(true);return stop;})
      .catch(()=>{if(mounted){setNativeReturnFailed(true);setNativeReturnReady(true);}return ()=>{};});
    return ()=>{mounted=false;void listener.then(stop=>stop()).catch(()=>{});};
  },[]);
  useEffect(()=>{if(registrationTab){setActiveTab(registrationTab);setScreen('onesa');}},[registrationTab]);
  useEffect(() => { if (handoffReturn) setScreen('handoff'); }, [handoffReturn]);
  useEffect(() => {
    const controller = new AbortController();
    live.current = true; setLoading(true); setMessage(''); setCapabilities(null); setAccountDisabled(false);
    if (!mobileApiOrigin) { setLoading(false); setAccountDisabled(true); return () => { live.current = false; }; }
    // A captive network or unreachable gateway must not leave account entry
    // spinning indefinitely. Preserve the offline preview and do not sign in.
    const timeout = setTimeout(() => {
      if (!live.current || controller.signal.aborted) return;
      controller.abort();
      setCapabilities(null);
      setMessage('The configured PasoFi service did not respond in time. You can still browse bundles and help.');
      setLoading(false);
    }, 12000);
    api<Capabilities>('/api/capabilities', { signal: controller.signal }).then(value => {
      if (!live.current || controller.signal.aborted) return;
      if (value.mobileCookies !== true || (usesNativeCustomerApi && value.nativeCustomerApiVersion !== 1)) { setAccountDisabled(true); return; }
      setCapabilities(value);
    }).catch(error => { if (live.current && !controller.signal.aborted) setMessage(messageFor(error, 'The configured PasoFi service could not be reached. You can still browse bundles and help.', { readOnly: true })); }).finally(() => { clearTimeout(timeout); if (live.current && !controller.signal.aborted) setLoading(false); });
    const unsubscribe = onSessionChange(() => { clearTimeout(timeout); controller.abort(); setCapabilities(null); setLoading(true); setMessage('Your account changed. Refreshing the current account…'); setAttempt(value => value + 1); });
    return () => { live.current = false; clearTimeout(timeout); controller.abort(); unsubscribe(); };
  }, [attempt]);
  const webShortcut = shortcut && webShortcuts[shortcut];
  const showShortcutFallback = webShortcut && !loading && !capabilities;
  return <div className="mobile-customer"><div className="mobile-account-links">
    <p className="mobile-account-brand"><strong>PasoFi</strong> An Onesa Mobile product</p>
    <button onClick={close}>← Back to PasoFi</button>
    {!loading && !showShortcutFallback && <RegistrationLink tab={activeTab}/>}
    {!loading && !showShortcutFallback && (!capabilities || !usesNativeCustomerApi) && <a href="https://pasofi.mobile.onesa.eu/#account" target="_blank" rel="noopener noreferrer">Continue to PasoFi account on the web</a>}
    {capabilities && <>
      {usesNativeCustomerApi && screen !== 'onesa' && <button onClick={() => setScreen('onesa')}>Sign in</button>}
      <button onClick={() => { setActiveTab('recovery'); setScreen('account'); }}>My account</button>
      <button onClick={() => setScreen('recover')}>Recover</button>
    </>}
  </div>
    {loading && <p className="mobile-notice" role="status">Checking the configured PasoFi service…</p>}
    {showShortcutFallback ? <section className="workspace" aria-labelledby="mobile-shortcut-heading">
      <h2 id="mobile-shortcut-heading">{webShortcut.title}</h2>
      <p role="status">{accountDisabled ? 'This feature is currently unavailable in the app. You can continue on the PasoFi website.' : message}</p>
      <div className="purchase-actions">
        <a className="primary" href={`https://pasofi.mobile.onesa.eu/${webShortcut.path}`} target="_blank" rel="noopener noreferrer">{webShortcut.action}</a>
        {!accountDisabled && <button className="secondary" onClick={() => setAttempt(value => value + 1)}>Retry service connection</button>}
      </div>
    </section> : accountDisabled ? <div className="mobile-notice"><p role="status">Mobile account access is not enabled in the app. You can continue to your PasoFi account on the web.</p></div>
      : message && <div className="mobile-notice"><div><p role="status">{message}</p><button className="mobile-primary" onClick={() => setAttempt(value => value + 1)}>Retry service connection</button></div></div>}
    {capabilities && (screen === 'onesa' ? nativeReturnReady
      ? <OnesaSignIn resumeRegistration={Boolean(registrationTab)} usedRegistration={usedRegistration} destination={activeTab} close={() => setScreen('account')} managedReturnReady={!nativeReturnFailed} />
      : <p role="status">Preparing the secure sign-in return…</p>
      : screen === 'account' ? <CustomerAccess key={`account-${attempt}`} capabilities={capabilities} initialTab={activeTab} requestedBundleId={requestedBundleId} onNavigate={setActiveTab} onBuyData={goBundles} close={close} recovered={() => setScreen('recover')} /> : screen === 'recover' ? <Recovery close={() => setScreen('account')} recovered={() => setScreen('account')} /> : <Handoff close={() => setScreen('account')} recovered={() => setScreen('account')} />)}
    {capabilities && <nav className="mobile-nav" aria-label="Account navigation">
      {/* Same destinations as the website: Home and Bundles return to the app's screens. */}
      <button onClick={goHome}><span className="mobile-nav-icon"><Icon name="home" /></span>Home</button>
      <button aria-current={screen === 'account' && (activeTab === 'purchase' || activeTab === 'receipt' || activeTab === 'voucher') ? 'page' : undefined} onClick={goBundles}><span className="mobile-nav-icon"><Icon name="bundles" /></span>Bundles</button>
      <button aria-current={screen === 'account' && activeTab === 'history' ? 'page' : undefined} onClick={() => { setScreen('account'); setActiveTab('history'); }}><span className="mobile-nav-icon"><Icon name="history" /></span>History</button>
      <button aria-current={screen !== 'account' || activeTab === 'recovery' || activeTab === 'access' || activeTab === 'wifi' ? 'page' : undefined} onClick={() => { setScreen('account'); setActiveTab('recovery'); }}><span className="mobile-nav-icon"><Icon name="account" /></span>Account</button>
    </nav>}
  </div>;
}
