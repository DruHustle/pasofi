import { useEffect, useRef, useState } from 'react';
import { api, mobileApiOrigin, usesNativeCustomerApi } from './api';
import type { Capabilities } from './business';
import { messageFor } from './business';
import CustomerAccess, { type CustomerTab } from './CustomerAccess';
import Recovery from './Recovery';
import Handoff from './Handoff';
import OnesaSignIn from './OnesaSignIn';
import { watchNativeReturn } from './native-oidc-ui';
import { onSessionChange } from './session';
import Icon from './Icon';
import './customer.css';

export default function MobileCustomer({ close, initialTab = 'access' }: { close: () => void; initialTab?: CustomerTab }) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null), [message, setMessage] = useState(''), [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<'account' | 'recover' | 'handoff' | 'onesa'>('account'), [attempt, setAttempt] = useState(0);
  const [activeTab, setActiveTab] = useState<CustomerTab>(initialTab);
  const live = useRef(false);
  useEffect(()=>{
    let mounted=true;
    const listener=watchNativeReturn(destination=>{
      if(mounted){setActiveTab(destination);setScreen('account');setAttempt(n=>n+1);}
    },()=>{if(mounted)setMessage('Onesa sign-in could not finish. Your existing account is available; try sign-in again.');});
    return ()=>{mounted=false;void listener.then(stop=>stop()).catch(()=>{});};
  },[]);
  useEffect(() => {
    const controller = new AbortController();
    live.current = true; setLoading(true); setMessage(''); setCapabilities(null);
    if (!mobileApiOrigin) { setLoading(false); setMessage('A valid HTTPS PasoFi gateway is required. This build is still an offline preview.'); return () => { live.current = false; }; }
    api<Capabilities>('/api/capabilities', { signal: controller.signal }).then(value => {
      if (!live.current || controller.signal.aborted) return;
      if (value.mobileCookies !== true || (usesNativeCustomerApi && value.nativeCustomerApiVersion !== 1)) { setMessage('Mobile account access is not enabled by this deployment yet. You can continue using the offline preview.'); return; }
      setCapabilities(value);
    }).catch(error => { if (live.current && !controller.signal.aborted) setMessage(messageFor(error, 'The configured PasoFi service could not be reached. Your offline preview is still available.')); }).finally(() => { if (live.current && !controller.signal.aborted) setLoading(false); });
    const unsubscribe = onSessionChange(() => { controller.abort(); setCapabilities(null); setMessage('Your account changed. Reconnect to load the current account.'); });
    return () => { live.current = false; controller.abort(); unsubscribe(); };
  }, [attempt]);
  return <div className="mobile-customer"><div className="mobile-account-links">
    <p className="mobile-account-brand"><strong>PasoFi</strong> An Onesa Mobile product</p>
    <button onClick={close}>← Offline preview</button>
    {capabilities && usesNativeCustomerApi ? <button onClick={() => setScreen('onesa')}>Create an Onesa account</button>
      : capabilities ? <a href="https://pasofi.mobile.onesa.eu/#account" target="_blank" rel="noopener noreferrer">Continue with Company Portal on the PasoFi website</a>
      : !loading && <>
        <a href="https://portal.onesa.eu/admin" target="_blank" rel="noopener noreferrer">Sign in to Company Portal</a>
        <a href="https://portal.onesa.eu/admin?entry=register" target="_blank" rel="noopener noreferrer">Create an Onesa account</a>
      </>}
    {capabilities && <>
      {usesNativeCustomerApi && <button onClick={() => setScreen('onesa')}>Sign in with Onesa</button>}
      <button onClick={() => setScreen('account')}>My account</button>
      <button onClick={() => setScreen('recover')}>Recover</button>
      <button onClick={() => setScreen('handoff')}>Accept handoff</button>
    </>}
  </div>
    {loading && <p className="mobile-notice" role="status">Checking the configured PasoFi service…</p>}
    {message && <div className="mobile-notice"><div><p role="status">{message}</p><button className="mobile-primary" onClick={() => setAttempt(value => value + 1)}>Retry service connection</button></div></div>}
    {capabilities && (screen === 'onesa' ? <OnesaSignIn destination={activeTab} close={() => setScreen('account')} enterCode={() => setScreen('handoff')} /> : screen === 'account' ? <CustomerAccess key={`account-${attempt}`} capabilities={capabilities} initialTab={activeTab} onNavigate={setActiveTab} close={close} recovered={() => setScreen('recover')} /> : screen === 'recover' ? <Recovery close={() => setScreen('account')} recovered={() => setScreen('account')} /> : <Handoff close={() => setScreen('account')} recovered={() => setScreen('account')} />)}
    {capabilities && <nav className="mobile-nav" aria-label="Account navigation">
      <button aria-current={screen === 'account' && (activeTab === 'access' || activeTab === 'wifi' || activeTab === 'voucher') ? 'page' : undefined} onClick={() => { setScreen('account'); setActiveTab('access'); }}><span className="mobile-nav-icon"><Icon name="home" /></span>Home</button>
      <button aria-current={screen === 'account' && (activeTab === 'purchase' || activeTab === 'receipt') ? 'page' : undefined} onClick={() => { setScreen('account'); setActiveTab('purchase'); }}><span className="mobile-nav-icon"><Icon name="bundles" /></span>Bundles</button>
      <button aria-current={screen === 'account' && activeTab === 'history' ? 'page' : undefined} onClick={() => { setScreen('account'); setActiveTab('history'); }}><span className="mobile-nav-icon"><Icon name="history" /></span>History</button>
      <button aria-current={screen !== 'account' || activeTab === 'recovery' ? 'page' : undefined} onClick={() => { setScreen('account'); setActiveTab('recovery'); }}><span className="mobile-nav-icon"><Icon name="account" /></span>Account</button>
    </nav>}
  </div>;
}
