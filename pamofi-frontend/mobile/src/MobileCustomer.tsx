import { useEffect, useRef, useState } from 'react';
import { api, mobileApiOrigin } from './api';
import type { Capabilities } from './business';
import { messageFor } from './business';
import CustomerAccess from './CustomerAccess';
import Recovery from './Recovery';
import Handoff from './Handoff';
import { onSessionChange } from './session';
import './customer.css';

export default function MobileCustomer({ close }: { close: () => void }) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null), [message, setMessage] = useState(''), [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<'account' | 'recover' | 'handoff'>('account'), [attempt, setAttempt] = useState(0);
  const live = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    live.current = true; setLoading(true); setMessage(''); setCapabilities(null);
    if (!mobileApiOrigin) { setLoading(false); setMessage('A valid HTTPS PamoFi gateway is required. This build is still an offline preview.'); return () => { live.current = false; }; }
    api<Capabilities>('/api/capabilities', { signal: controller.signal }).then(value => {
      if (!live.current || controller.signal.aborted) return;
      if (value.mobileCookies !== true) { setMessage('Mobile account access is not enabled by this deployment yet. You can continue using the offline preview.'); return; }
      setCapabilities(value);
    }).catch(error => { if (live.current && !controller.signal.aborted) setMessage(messageFor(error, 'The configured PamoFi service could not be reached. Your offline preview is still available.')); }).finally(() => { if (live.current && !controller.signal.aborted) setLoading(false); });
    const unsubscribe = onSessionChange(() => { controller.abort(); setCapabilities(null); setMessage('Your account changed in another window. Reconnect to load the current account.'); });
    return () => { live.current = false; controller.abort(); unsubscribe(); };
  }, [attempt]);
  return <div className="mobile-customer"><div className="mobile-account-links"><button onClick={close}>← Offline preview</button>{capabilities && <><button onClick={() => setScreen('account')}>My account</button><button onClick={() => setScreen('recover')}>Recover</button><button onClick={() => setScreen('handoff')}>Accept handoff</button></>}</div>
    {loading && <p className="mobile-notice" role="status">Checking the configured PamoFi service…</p>}
    {message && <div className="mobile-notice"><div><p role="status">{message}</p><button className="mobile-primary" onClick={() => setAttempt(value => value + 1)}>Retry service connection</button></div></div>}
    {capabilities && (screen === 'account' ? <CustomerAccess key={`account-${attempt}`} capabilities={capabilities} close={close} recovered={() => setScreen('recover')} /> : screen === 'recover' ? <Recovery close={() => setScreen('account')} recovered={() => setScreen('account')} /> : <Handoff close={() => setScreen('account')} recovered={() => setScreen('account')} />)}
  </div>;
}
