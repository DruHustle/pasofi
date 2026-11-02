import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { currentSession } from './session';
import { type Capabilities, localDate, messageFor } from './business';

type NetworkSite = { id: string; name: string; loginUrl: string };
type NetworkSession = { id: string; siteId: string; state: 'pending' | 'active' | 'uncertain'; connected: boolean; accountedAt: string | null; deadline: string; chargedBytes: string; disconnectRequested: boolean };
const formOrigins = (() => {
  try {
    const values: unknown = JSON.parse(import.meta.env.VITE_PAMOFI_ROUTER_FORM_ORIGINS || '[]');
    if (!Array.isArray(values) || values.length > 20 || !values.every(value => {
      if (typeof value !== 'string') return false;
      const url = new URL(value);
      return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
    })) return [] as string[];
    return values as string[];
  } catch { return [] as string[]; }
})();
type Credential = { username: string; password: string; expiresAt: string; loginUrl: string };
export default function NetworkAccess({ customerId, capabilities }: { customerId: string; capabilities: Capabilities }) {
  const [sites, setSites] = useState<NetworkSite[]>([]), [siteId, setSiteId] = useState('');
  const [session, setSession] = useState<NetworkSession | null>(null), [credentials, setCredentials] = useState<Credential | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [verifiedAt, setVerifiedAt] = useState(0), [now, setNow] = useState(Date.now());
  const request = useRef<{ siteId: string; key: string } | null>(null), live = useRef(false), checking = useRef(false);
  async function verifyOwner() { if (await currentSession() !== customerId) throw new ApiError(401, 'session_changed'); }
  async function refresh() {
    if (!capabilities.networkAccess || checking.current) return;
    checking.current = true;
    try {
      await verifyOwner(); const result = await api<{ session: NetworkSession | null }>('/api/network/session');
      if (live.current) { setSession(result.session); setVerifiedAt(Date.now()); }
    } catch (error) { if (live.current) { setVerifiedAt(0); setCredentials(null); setMessage(messageFor(error, 'Connection status is temporarily unavailable. We cannot confirm whether this device is connected.')); } }
    finally { checking.current = false; }
  }
  useEffect(() => {
    live.current = true;
    if (capabilities.networkAccess) {
      api<{ sites: NetworkSite[] }>('/api/network/sites').then(result => { if (live.current) { setSites(result.sites); setSiteId(result.sites[0]?.id ?? ''); } }).catch(error => { if (live.current) setMessage(messageFor(error)); });
      void refresh();
    }
    const timer = setInterval(() => { setNow(Date.now()); if (!document.hidden) void refresh(); }, 5_000);
    return () => { live.current = false; clearInterval(timer); };
  }, [customerId, capabilities.networkAccess]);
  useEffect(() => { if (credentials && Date.parse(credentials.expiresAt) <= now) { setCredentials(null); request.current = null; } }, [now, credentials]);
  async function prepare(event: React.FormEvent) {
    event.preventDefault(); if (busy || !siteId || !capabilities.networkAccess) return;
    setBusy(true); setMessage(''); setCredentials(null); setShowPassword(false);
    try {
      await verifyOwner();
      if (!request.current || request.current.siteId !== siteId) request.current = { siteId, key: crypto.randomUUID() };
      const result = await api<Credential>('/api/network/credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ siteId, requestKey: request.current.key }) });
      const url = new URL(result.loginUrl), registered = sites.find(site => site.id === siteId);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || !registered || result.loginUrl !== registered.loginUrl || typeof result.username !== 'string' || typeof result.password !== 'string') throw Error('invalid_connection_details');
      if (live.current) { setCredentials(result); setMessage('Short-lived sign-in details are ready. You are not connected until the hotspot confirms successful access.'); }
      await refresh();
    } catch (error) { if (live.current) setMessage(messageFor(error, 'Connection details could not be verified. Check status before retrying.')); }
    finally { if (live.current) setBusy(false); }
  }
  async function disconnect() {
    if (busy || !session) return; setBusy(true); setMessage('');
    try {
      await verifyOwner(); await api('/api/network/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grantId: session.id }) });
      if (live.current) { setCredentials(null); setMessage('Disconnect requested. Wait for confirmed final status before switching to another hotspot.'); }
      await refresh();
    } catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  if (!capabilities.networkAccess) return <section className="workspace-card"><h3>Hotspot connection</h3><p>Hotspot sign-in is not enabled at this deployment yet. A purchased or redeemed bundle alone does not connect your device.</p></section>;
  const fresh = verifiedAt > 0 && now - verifiedAt < 30_000;
  const retryPending = !!request.current && !credentials && session?.state === 'pending' && session.siteId === request.current.siteId && !session.disconnectRequested;
  const connected = fresh && session?.connected === true && session.state === 'active';
  return <section className="workspace-card"><div className="workspace-section-head"><h3>Hotspot connection</h3><button className="secondary" disabled={busy} onClick={refresh}>Check connection</button></div>
    <p className={`connection-state ${connected ? 'connected' : ''}`} role="status">{!fresh ? 'Connection status not verified' : !session ? 'No active hotspot session' : session.disconnectRequested ? 'Disconnect awaiting confirmation' : connected ? 'Connected · confirmed by the hotspot' : session.state === 'uncertain' ? 'Connection needs reconciliation' : 'Sign-in pending · not confirmed connected'}</p>
    {session && <p>Allowance accounted: {(Number(session.chargedBytes) / 1e9).toFixed(3)} GB · Grant deadline {localDate(session.deadline)}.{session.accountedAt ? ` Last hotspot accounting: ${localDate(session.accountedAt)}.` : ''}</p>}
    {message && <p className="feedback" role="status">{message}</p>}
    <form className="form-grid" onSubmit={prepare}><label>Hotspot site<select required value={siteId} onChange={event => { setSiteId(event.target.value); setCredentials(null); }} disabled={busy || !!session}><option value="">Choose a configured hotspot</option>{sites.map(site => <option value={site.id} key={site.id}>{site.name}</option>)}</select></label><button className="primary" disabled={busy || !siteId || (!!session && !retryPending)}>{retryPending ? 'Retry prepared sign-in safely' : 'Prepare hotspot sign-in'}</button></form>
    {credentials && <div className="private-value"><h4>Continue at your hotspot</h4><p>These details expire {localDate(credentials.expiresAt)}. Keep this page open while the hotspot verifies your connection.</p><a className="primary button-link" href={credentials.loginUrl} target="_blank" rel="noopener noreferrer">Open registered hotspot sign-in ↗</a><p>Open the hotspot page and enter these short-lived details. They are not placed in the link.</p><label>Hotspot username<input readOnly autoComplete="off" value={credentials.username} onFocus={event => event.target.select()} /></label><label>Hotspot password<input readOnly type={showPassword ? 'text' : 'password'} autoComplete="off" value={credentials.password} onFocus={event => event.target.select()} /></label><div className="purchase-actions"><button className="secondary" onClick={() => setShowPassword(value => !value)}>{showPassword ? 'Hide hotspot password' : 'Show hotspot password'}</button><button className="secondary" onClick={async () => { try { await navigator.clipboard.writeText(credentials.password); setMessage('Hotspot password copied. Paste it only into the registered hotspot sign-in page.'); } catch { setShowPassword(true); setMessage('Select the hotspot password and copy it manually.'); } }}>Copy hotspot password</button></div>{formOrigins.includes(new URL(credentials.loginUrl).origin) && <form action={credentials.loginUrl} method="post" target="_blank" rel="noopener"><input type="hidden" name="username" value={credentials.username} /><input type="hidden" name="password" value={credentials.password} /><button className="secondary" type="submit">Submit to configured hotspot</button></form>}<button className="text-button" onClick={() => setCredentials(null)}>Hide sign-in details</button></div>}
    {session && <button className="secondary" disabled={busy || session.disconnectRequested} onClick={disconnect}>{session.disconnectRequested ? 'Waiting for disconnection' : 'Disconnect this hotspot session'}</button>}
  </section>;
}
