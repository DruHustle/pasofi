import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { currentSession } from './session';
import { type Capabilities, localDate, messageFor } from './business';
import { type UsageSnapshot, dataAmount } from './LiveUsage';

type NetworkPoint = { nasId: string; siteId: string; siteName: string; name: string; loginUrl: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const formOrigins = (() => {
  try {
    const values: unknown = JSON.parse(import.meta.env.VITE_PAMOFI_ROUTER_FORM_ORIGINS || '["https://hotspot.pasofi.onesa.eu","https://hotspot.pamofi.onesa.eu"]');
    if (!Array.isArray(values) || values.length > 20 || !values.every(value => {
      if (typeof value !== 'string') return false;
      const url = new URL(value);
      return url.protocol === 'https:' && url.origin === value && !url.username && !url.password;
    })) return [] as string[];
    return values as string[];
  } catch { return [] as string[]; }
})();
type Credential = { username: string; password: string; expiresAt: string; loginUrl: string; siteId: string; nasId: string };
export default function NetworkAccess({ customerId, capabilities, usage, fresh, refreshing, refresh }: { customerId: string; capabilities: Capabilities; usage: UsageSnapshot | null; fresh: boolean; refreshing: boolean; refresh: () => Promise<void> }) {
  const [sites, setSites] = useState<NetworkPoint[]>([]), [nasId, setNasId] = useState('');
  const [sitesLoading, setSitesLoading] = useState(true), [sitesError, setSitesError] = useState(false), [sitesAttempt, setSitesAttempt] = useState(0);
  const [credentials, setCredentials] = useState<Credential | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [now, setNow] = useState(Date.now());
  const request = useRef<{ siteId: string; nasId: string; key: string } | null>(null), live = useRef(false), generation = useRef(0);
  const validity = useRef({ customerId, fresh, revision: 0 });
  if (validity.current.customerId !== customerId || (validity.current.fresh && !fresh)) ++validity.current.revision;
  validity.current.customerId = customerId; validity.current.fresh = fresh;
  const session = usage?.customerId === customerId ? usage.session : null;
  const isCurrent = (revision: number) => live.current && generation.current === revision && validity.current.customerId === customerId;
  async function verifyOwner() { if (await currentSession() !== customerId) throw new ApiError(401, 'session_changed'); }
  useEffect(() => {
    live.current = true; ++generation.current;
    setCredentials(null); setShowPassword(false); setBusy(false); setMessage(''); request.current = null; setSites([]); setNasId('');
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => { live.current = false; ++generation.current; clearInterval(timer); };
  }, [customerId, capabilities.networkAccess]);
  useEffect(() => {
    const revision = generation.current, controller = new AbortController();
    const current = () => !controller.signal.aborted && isCurrent(revision);
    setSitesError(false); setSitesLoading(capabilities.networkAccess);
    if (capabilities.networkAccess) {
      api<{ accessPoints: NetworkPoint[] }>('/api/network/sites', { signal: controller.signal }).then(result => {
        // An older site's deduplicated list cannot identify the physical router.
        if (!Array.isArray(result.accessPoints) || new Set(result.accessPoints.map(site => site?.nasId)).size !== result.accessPoints.length || !result.accessPoints.every(site => {
          if (!site || typeof site.nasId !== 'string' || !uuid.test(site.nasId) || typeof site.siteId !== 'string' || !uuid.test(site.siteId) || typeof site.siteName !== 'string' || !site.siteName || typeof site.name !== 'string' || !site.name || typeof site.loginUrl !== 'string') return false;
          const url = new URL(site.loginUrl); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/login';
        })) throw Error('invalid_hotspot_locations');
        if (current()) { setSites(result.accessPoints); setNasId(value => result.accessPoints.some(site => site.nasId === value) ? value : result.accessPoints.length === 1 ? result.accessPoints[0].nasId : ''); }
      }).catch(() => { if (current()) setSitesError(true); }).finally(() => { if (current()) setSitesLoading(false); });
    }
    return () => controller.abort();
  }, [customerId, capabilities.networkAccess, sitesAttempt]);
  useEffect(() => { if (credentials && Date.parse(credentials.expiresAt) <= now) { setCredentials(null); request.current = null; } }, [now, credentials]);
  async function prepare(event: React.FormEvent) {
    event.preventDefault();
    const selected = sites.find(site => site.nasId === nasId);
    if (busy || sitesLoading || sitesError || !selected || !capabilities.networkAccess || !fresh || usage?.hold.active) return;
    const revision = generation.current, verifiedRevision = validity.current.revision;
    setBusy(true); setMessage(''); setCredentials(null); setShowPassword(false);
    try {
      await verifyOwner();
      if (!isCurrent(revision)) return;
      if (!request.current || request.current.siteId !== selected.siteId || request.current.nasId !== selected.nasId) request.current = { siteId: selected.siteId, nasId: selected.nasId, key: crypto.randomUUID() };
      const result = await api<Credential>('/api/network/credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ siteId: selected.siteId, nasId: selected.nasId, requestKey: request.current.key }) });
      if (!isCurrent(revision)) return;
      if (!validity.current.fresh || validity.current.revision !== verifiedRevision) { setMessage('Account status changed while preparing sign-in. Check the connection, then retry the prepared request safely.'); return; }
      const url = new URL(result.loginUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/login' || result.siteId !== selected.siteId || result.nasId !== selected.nasId || result.loginUrl !== selected.loginUrl || typeof result.username !== 'string' || typeof result.password !== 'string' || !Number.isFinite(Date.parse(result.expiresAt))) throw Error('invalid_connection_details');
      if (isCurrent(revision)) { setCredentials(result); setMessage('Your connection is ready to start. Continue below; the hotspot will confirm when you’re online.'); await refresh(); }
    } catch (error) {
      if (isCurrent(revision)) {
        const expired = error instanceof ApiError && error.status === 409 && error.code === 'credential_expired';
        // A lost response must retry the same preparation. Rotate only after
        // the credential authority confirms it is no longer usable.
        if (expired) request.current = null;
        setMessage(expired ? 'Your prepared hotspot sign-in expired. Choose Connect to Wi-Fi again to get fresh details.' : messageFor(error, 'Connection details could not be verified. Check status before retrying.'));
        await refresh();
      }
    }
    finally { if (isCurrent(revision)) setBusy(false); }
  }
  async function disconnect() {
    if (busy || !session || !fresh) return; const revision = generation.current; setBusy(true); setMessage('');
    try {
      await verifyOwner(); if (!isCurrent(revision)) return;
      await api('/api/network/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grantId: session.grantId }) });
      if (isCurrent(revision)) { setCredentials(null); setMessage('Disconnect requested. Wait for confirmed final status before switching to another hotspot.'); await refresh(); }
    } catch (error) { if (isCurrent(revision)) setMessage(messageFor(error)); }
    finally { if (isCurrent(revision)) setBusy(false); }
  }
  const retryPending = !!request.current && !credentials && session?.state === 'pending' && session.siteId === request.current.siteId && session.nasId === request.current.nasId && !session.disconnectRequested;
  const connected = fresh && session?.connected === true && session.state === 'active';
  return <section className="workspace-card"><div className="workspace-section-head"><h3>Hotspot connection</h3><button className="secondary" disabled={busy || refreshing} onClick={refresh}>Check connection</button></div>
    <p className={`connection-state ${connected ? 'connected' : ''}`} role="status">{!fresh ? 'Connection status not verified' : usage?.hold.active ? 'Connection needs review' : !session ? 'No active hotspot session' : session.disconnectRequested ? 'Disconnect awaiting confirmation' : connected ? 'Connected · recent router report' : session.state === 'uncertain' ? 'Checking an interrupted connection' : usage?.connectivity === 'stale' ? 'Router report delayed · connection not verified' : 'Sign-in pending · not confirmed connected'}</p>
    {session && <p>Usage recorded for this connection: {dataAmount(session.chargedBytes)} · This connection is scheduled to end by {localDate(session.deadline)}. Check the balance above for your remaining data.</p>}
    {message && <p className="feedback" role="status">{message}</p>}
    {!capabilities.networkAccess && <p className="notice">New hotspot connections are paused.{session ? " You can still check or disconnect your current session." : " Ask your PasoFi agent when service is available."}</p>}
    {capabilities.networkAccess && !credentials && sitesLoading && <p role="status">Loading hotspot locations…</p>}
    {capabilities.networkAccess && !credentials && sitesError && <div className="notice"><p role="alert">Hotspot locations could not be loaded. Try again to choose where to connect.</p><button className="secondary" disabled={busy || sitesLoading} onClick={() => setSitesAttempt(value => value + 1)}>Retry locations</button></div>}
    {capabilities.networkAccess && !credentials && !sitesLoading && !sitesError && sites.length === 0 && <div className="notice"><p role="status">No hotspot locations are available yet. Ask your PasoFi agent for help or check again.</p><button className="secondary" disabled={busy} onClick={() => setSitesAttempt(value => value + 1)}>Refresh locations</button></div>}
    {capabilities.networkAccess && !credentials && !sitesLoading && !sitesError && sites.length > 0 && <form className="form-grid" onSubmit={prepare}>
      {sites.length === 1 ? <p>Connecting at <strong>{sites[0].siteName} · {sites[0].name}</strong>. No Wi-Fi name to enter.</p> : <label>Choose your PasoFi hotspot<select required value={nasId} onChange={event => { setNasId(event.target.value); setCredentials(null); }} disabled={busy || !!session}><option value="">Select a hotspot</option>{sites.map(site => <option value={site.nasId} key={site.nasId}>{site.siteName} · {site.name}</option>)}</select></label>}
      <button className="primary" disabled={busy || !fresh || !!usage?.hold.active || !nasId || (!!session && !retryPending)}>{busy ? 'Getting your connection ready…' : retryPending ? 'Retry connection' : 'Connect to Wi-Fi'}</button>
    </form>}
    {capabilities.networkAccess && credentials && fresh && <div className="private-value">
      <h4>One more tap and you’re on your way</h4>
      {formOrigins.includes(new URL(credentials.loginUrl).origin) ? <>
        <p>Connect securely to your PasoFi hotspot. Your connection details are filled in for you.</p>
        <form action={credentials.loginUrl} method="post">
          <input type="hidden" name="username" value={credentials.username} />
          <input type="hidden" name="password" value={credentials.password} />
          <button className="primary" type="submit">Connect now →</button>
        </form>
      </> : <p>This location needs a manual sign-in. Open the connection details below to continue.</p>}
      <p>Ready until {localDate(credentials.expiresAt)}.</p>
      <details><summary>Manual connection details</summary>
        <a className="secondary button-link" href={credentials.loginUrl} target="_blank" rel="noopener noreferrer">Open registered hotspot sign-in ↗</a>
        <p>Enter these temporary details only on the registered hotspot page.</p>
        <label>Hotspot username<input readOnly autoComplete="off" value={credentials.username} onFocus={event => event.target.select()} /></label>
        <label>Hotspot password<input readOnly type={showPassword ? 'text' : 'password'} autoComplete="off" value={credentials.password} onFocus={event => event.target.select()} /></label>
        <div className="purchase-actions"><button className="secondary" onClick={() => setShowPassword(value => !value)}>{showPassword ? 'Hide hotspot password' : 'Show hotspot password'}</button><button className="secondary" onClick={async () => { try { await navigator.clipboard.writeText(credentials.password); setMessage('Hotspot password copied. Paste it only into the registered hotspot sign-in page.'); } catch { setShowPassword(true); setMessage('Select the hotspot password and copy it manually.'); } }}>Copy hotspot password</button></div>
      </details>
      <button className="text-button" onClick={() => setCredentials(null)}>Hide connection details</button>
    </div>}
    {session && <button className="secondary" disabled={busy || !fresh || session.disconnectRequested} onClick={disconnect}>{session.disconnectRequested ? 'Waiting for disconnection' : 'Disconnect this hotspot session'}</button>}
  </section>;
}
