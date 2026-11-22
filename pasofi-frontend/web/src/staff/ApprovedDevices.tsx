import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { type Capabilities, type Staff, finishMutation, localDate, mutationIntent } from '../business';
import {
  type Allowlist, type AllowlistEvent, type AllowlistRouter, type ApprovedDevice,
  deviceMessage, labelValid, normalizeMac, parseAllowlist, reasonValid, routerDetail, routerName, stateLabel, statusLabel,
} from './approved-devices';
import '../approved-devices.css';

const path = '/api/admin/approved-devices';
const jsonHeaders = { 'Content-Type': 'application/json' };
const MAX_POLLS = 20;
// A definite reply settles the saved idempotency key; an unknown outcome keeps
// it so the same request can be repeated safely after checking the list.
const definite = (error: unknown) => error instanceof ApiError && error.status >= 400 && error.status < 500 && error.code !== 'idempotency_conflict';

export default function ApprovedDevices({ staff, capabilities, users = [] }: { staff: Staff; capabilities: Capabilities | null; users?: Staff[] }) {
  const [data, setData] = useState<Allowlist | null>(null), [loading, setLoading] = useState(false), [loadError, setLoadError] = useState('');
  const [label, setLabel] = useState(''), [mac, setMac] = useState(''), [reason, setReason] = useState('');
  const [removing, setRemoving] = useState<ApprovedDevice | null>(null), [removeReason, setRemoveReason] = useState('');
  const [busy, setBusy] = useState<'add' | 'remove' | 'sync' | null>(null), [feedback, setFeedback] = useState(''), [formError, setFormError] = useState('');
  const live = useRef(false), generation = useRef(0), polls = useRef(0), removeHeading = useRef<HTMLHeadingElement>(null);
  const enabled = capabilities?.approvedDevices !== false;
  const canWrite = capabilities?.approvedDevicesWrite !== false && data?.writesEnabled === true;
  const owner = `staff:${staff.staffId}`;
  const names = new Map(users.map(user => [user.staffId.toLowerCase(), user.displayName]));
  const who = (actorId: string) => actorId === staff.staffId.toLowerCase() ? 'You' : names.get(actorId) ?? 'An administrator';
  const routers = new Map((data?.routers ?? []).map(router => [router.id, router]));

  async function load(quiet = false) {
    const request = ++generation.current;
    if (!quiet) { setLoading(true); setLoadError(''); }
    try {
      const result = parseAllowlist(await api<unknown>(path));
      if (!live.current || request !== generation.current) return;
      setData(result); setLoadError('');
      if (!result.syncing) polls.current = 0;
    } catch (error) {
      if (live.current && request === generation.current && !quiet) setLoadError(deviceMessage(error, 'The approved device list could not be loaded.'));
    } finally { if (live.current && request === generation.current && !quiet) setLoading(false); }
  }
  useEffect(() => {
    live.current = true; if (enabled) void load();
    return () => { live.current = false; generation.current++; };
  }, []);
  // Router synchronization continues after a change is saved. Re-read until
  // every router has reported, within a bounded number of checks.
  useEffect(() => {
    if (!data?.syncing || polls.current >= MAX_POLLS) return;
    const timer = setTimeout(() => { polls.current++; void load(true); }, 2500);
    return () => clearTimeout(timer);
  }, [data]);

  async function add(event: React.FormEvent) {
    event.preventDefault(); if (busy || !canWrite) return;
    setFeedback(''); setFormError('');
    const parsed = normalizeMac(mac);
    if ('error' in parsed) { setFormError(deviceMessage(parsed.error)); return; }
    if (!labelValid(label)) { setFormError(deviceMessage('invalid_label')); return; }
    if (!reasonValid(reason)) { setFormError(deviceMessage('invalid_reason')); return; }
    const payload = { macAddress: parsed.mac, label: label.trim(), reason: reason.trim() }, operation = `approved-device-add:${parsed.mac}`;
    setBusy('add');
    try {
      const key = mutationIntent(owner, operation, payload);
      const result = await api<{ device: ApprovedDevice; syncing: boolean }>(path, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': key }, body: JSON.stringify(payload) });
      finishMutation(owner, operation);
      if (!live.current) return;
      setLabel(''); setMac(''); setReason('');
      setFeedback(`${result.device.label} (${result.device.macAddress}) is approved. ${result.syncing ? 'Applying it to the routers…' : 'Router results are shown below.'}`);
      await load(true);
    } catch (error) {
      if (definite(error)) finishMutation(owner, operation);
      if (live.current) setFormError(deviceMessage(error));
    } finally { if (live.current) setBusy(null); }
  }
  function startRemoval(device: ApprovedDevice) {
    setRemoving(device); setRemoveReason(''); setFeedback(''); setFormError('');
    requestAnimationFrame(() => removeHeading.current?.focus());
  }
  async function remove(event: React.FormEvent) {
    event.preventDefault(); if (busy || !removing || !canWrite) return;
    if (!reasonValid(removeReason)) { setFormError(deviceMessage('invalid_reason')); return; }
    const payload = { reason: removeReason.trim() }, operation = `approved-device-remove:${removing.id}`;
    setBusy('remove'); setFormError('');
    try {
      const key = mutationIntent(owner, operation, payload);
      const result = await api<{ device: ApprovedDevice; syncing: boolean }>(`${path}/${removing.id}/remove`, { method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': key }, body: JSON.stringify(payload) });
      finishMutation(owner, operation);
      if (!live.current) return;
      setRemoving(null); setRemoveReason('');
      setFeedback(`${result.device.label} (${result.device.macAddress}) was removed. ${result.syncing ? 'Removing it from the routers…' : 'It will use the captive portal again.'}`);
      await load(true);
    } catch (error) {
      if (definite(error)) finishMutation(owner, operation);
      if (live.current) setFormError(deviceMessage(error));
    } finally { if (live.current) setBusy(null); }
  }
  async function sync() {
    if (busy || !canWrite) return;
    setBusy('sync'); setFeedback(''); setFormError('');
    try {
      const result = await api<{ syncing: boolean }>(`${path}/sync`, { method: 'POST', headers: jsonHeaders, body: '{}' });
      if (!live.current) return;
      polls.current = 0;
      setFeedback(result.syncing ? 'Synchronizing the routers…' : 'Router synchronization finished.');
      await load(true);
    } catch (error) { if (live.current) setFormError(deviceMessage(error)); }
    finally { if (live.current) setBusy(null); }
  }

  function describe(event: AllowlistEvent) {
    const device = `${event.label ?? 'A device'}${event.macAddress ? ` (${event.macAddress})` : ''}`;
    const router = event.nasId ? routers.get(event.nasId) : undefined, where = router ? routerName(router) : 'a router';
    switch (event.type) {
      case 'added': return `${who(event.actorId)} approved ${device}`;
      case 'removed': return `${who(event.actorId)} removed ${device}`;
      case 'router_binding_added': return `Applied ${device} on ${where}`;
      case 'router_binding_removed': return `Removed ${device} from ${where}`;
    }
  }

  if (!enabled) return <section className="workspace-card approved-devices"><h3>Approved devices</h3><p className="notice">Approved devices are not enabled for this service.</p></section>;
  return <section className="approved-devices" aria-labelledby="approved-devices-heading">
    <div className="workspace-section-head">
      <div>
        <h3 id="approved-devices-heading">Approved devices</h3>
        <p>Approved phones and IoT devices get internet at every PasoFi site router without the captive portal. Changes are recorded with your name and reason.</p>
      </div>
      <div className="approved-devices-actions">
        <button className="secondary" disabled={loading || !!busy} onClick={() => void load()}>Refresh list</button>
        {canWrite && <button className="secondary" disabled={loading || !!busy} onClick={() => void sync()}>{busy === 'sync' ? 'Synchronizing…' : 'Sync routers now'}</button>}
      </div>
    </div>
    {loadError && <div className="notice" role="alert"><p>{loadError}</p></div>}
    {feedback && <p className="feedback" role="status">{feedback}</p>}
    {formError && <p className="approved-devices-error" role="alert">{formError}</p>}
    {loading && !data && <p role="status">Loading approved devices…</p>}
    {data && <>
      <div className="approved-devices-routers" aria-label="Router synchronization">
        {!data.registryAvailable && <p className="notice">Router connections are not configured on the server. The list is saved and will be applied once routers are connected.</p>}
        {data.routers.map(router => <RouterCard key={router.id} router={router} />)}
        {data.syncing && <p role="status" className="approved-devices-syncing">Synchronizing routers…</p>}
      </div>
      {canWrite ? <form className="workspace-card form-grid approved-devices-form" onSubmit={add} aria-labelledby="approve-device-heading">
        <h4 id="approve-device-heading">Approve a device</h4>
        <fieldset disabled={!!busy}>
          <label>Device label<input value={label} maxLength={80} onChange={event => setLabel(event.target.value)} autoComplete="off" placeholder="Office printer" /></label>
          <label>MAC address<input value={mac} onChange={event => setMac(event.target.value)} autoComplete="off" spellCheck={false} placeholder="3C:22:FB:12:34:56" inputMode="text" />
            <small>Use the Wi-Fi address shown in the device’s settings for the PasoFi network. Phones may use a private Wi-Fi address per network; approve the one shown for PasoFi.</small></label>
          <label>Reason for approval<textarea value={reason} rows={2} maxLength={500} onChange={event => setReason(event.target.value)} />
            <small>At least 10 characters. Recorded in the audit history.</small></label>
        </fieldset>
        <button className="primary" disabled={!!busy || data.devices.length >= data.maxDevices}>{busy === 'add' ? 'Approving…' : 'Approve device'}</button>
        <small>{data.devices.length} of {data.maxDevices} devices approved.</small>
      </form> : <p className="notice">Changes to approved devices are paused. The list remains visible.</p>}
      {removing && <form className="workspace-card form-grid approved-devices-remove" onSubmit={remove} aria-labelledby="remove-device-heading">
        <h4 id="remove-device-heading" ref={removeHeading} tabIndex={-1}>Remove {removing.label}</h4>
        <p>{removing.macAddress} will use the captive portal again at every site.</p>
        <fieldset disabled={!!busy}>
          <label>Reason for removal<textarea value={removeReason} rows={2} maxLength={500} onChange={event => setRemoveReason(event.target.value)} /></label>
        </fieldset>
        <div className="approved-devices-actions">
          <button className="primary" disabled={!!busy}>{busy === 'remove' ? 'Removing…' : 'Remove device'}</button>
          <button type="button" className="secondary" disabled={!!busy} onClick={() => { setRemoving(null); setFormError(''); }}>Cancel</button>
        </div>
      </form>}
      {data.devices.length === 0 ? <p className="notice">No devices are approved. Every device uses the captive portal.</p> :
        <div className="table-scroll"><table>
          <thead><tr><th>Device</th><th>Routers</th><th>Approved</th>{canWrite && <th><span className="visually-hidden">Actions</span></th>}</tr></thead>
          <tbody>{data.devices.map(device => <tr key={device.id}>
            <td><strong>{device.label}</strong><small><code>{device.macAddress}</code></small></td>
            <td><ul className="approved-devices-states">{device.routers.map(item => {
              const router = routers.get(item.nasId);
              return <li key={item.nasId}><span>{router ? routerName(router) : 'Router'}</span><span className={`approved-state ${item.state}`}>{stateLabel[item.state]}</span></li>;
            })}</ul></td>
            <td>{localDate(device.createdAt)}<small>by {who(device.createdBy)}</small></td>
            {canWrite && <td><button className="secondary" disabled={!!busy} aria-label={`Remove ${device.label}`} onClick={() => startRemoval(device)}>Remove</button></td>}
          </tr>)}</tbody>
        </table></div>}
      <section className="workspace-card" aria-labelledby="approved-history-heading">
        <h4 id="approved-history-heading">Recent changes</h4>
        {data.events.length === 0 ? <p>No changes recorded yet.</p> : <ol className="audit-list">{data.events.map(event => <li key={event.id}>
          <strong>{describe(event)}</strong>
          {event.reason && <p>Reason: {event.reason}</p>}
          <small>{localDate(event.createdAt)}</small>
        </li>)}</ol>}
      </section>
    </>}
  </section>;
}

function RouterCard({ router }: { router: AllowlistRouter }) {
  return <article className={`approved-router ${router.status}`}>
    <div><strong>{routerName(router)}</strong><span className={`approved-state ${router.status}`}>{statusLabel[router.status]}</span></div>
    <p>{routerDetail(router)}</p>
    {router.configured && <small>
      {router.syncedAt ? `Last in sync ${localDate(router.syncedAt)}` : 'Never fully in sync'}
      {router.attemptedAt && router.attemptedAt !== router.syncedAt ? ` · Last attempt ${localDate(router.attemptedAt)}` : ''}
      {router.conflicts ? ` · ${router.conflicts} with existing router rules` : ''}
      {router.pendingRemovals ? ` · ${router.pendingRemovals} removal${router.pendingRemovals === 1 ? '' : 's'} pending` : ''}
    </small>}
  </article>;
}
