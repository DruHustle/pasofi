import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { localDate, messageFor } from '../business';

type Connection = {
  id: string;
  siteName: string | null;
  startedAt: string;
  lastAccountingAt: string | null;
  chargedBytes: string;
  recent: boolean;
};
type Snapshot = { connections: Connection[]; truncated: boolean };

export default function HotspotConnections() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<Snapshot>('/api/admin/network/connections', { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setSnapshot(value);
    }).catch(failure => {
      if (controller.signal.aborted) return;
      setSnapshot(null);
      setError(failure instanceof ApiError && failure.status === 404
        ? 'Connection monitoring requires the latest PasoFi service.'
        : messageFor(failure, 'Could not verify current hotspot connections.'));
    }).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [attempt]);
  function refresh() {
    setChecking(true); setError(''); setAttempt(value => value + 1);
  }
  return <section className="workspace-card" aria-labelledby="hotspot-connections-heading">
    <div className="workspace-section-head"><div><h3 id="hotspot-connections-heading">Hotspot connections</h3>
      <p>Connections reported by PasoFi hotspot accounting.</p></div>
      <button className="secondary" onClick={refresh} disabled={checking}>Refresh connections</button>
    </div>
    {checking && <p role="status">Checking hotspot connections…</p>}
    {error && <p role="alert" className="notice">{error}</p>}
    {snapshot && (snapshot.connections.length ? <ul className="inventory-list" aria-label="Open hotspot connections">
      {snapshot.connections.map(connection => <li key={connection.id}><div>
        <strong>{connection.siteName ?? 'Unregistered sales location'}</strong>
        <span>{connection.recent ? 'Recent accounting' : 'No recent accounting'}</span>
        <small>Connected {localDate(connection.startedAt)} · Last report {localDate(connection.lastAccountingAt ?? connection.startedAt)}</small>
        <small>{new Intl.NumberFormat().format(BigInt(connection.chargedBytes))} bytes recorded</small>
      </div></li>)}
    </ul> : <p>No open hotspot connections have been reported.</p>)}
    {snapshot?.truncated && <p>Showing the 100 most recently reported connections.</p>}
  </section>;
}
