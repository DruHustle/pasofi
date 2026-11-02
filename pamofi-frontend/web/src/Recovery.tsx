import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { announceSessionChange, clearSessionSecrets, currentSession } from './session';

type Status = { configured: boolean; accountReference?: string; version?: number };
type Secret = { accountReference: string; recoveryKey: string };
export function RecoverySetup() {
  const [status, setStatus] = useState<Status | null>(null), [secret, setSecret] = useState<Secret | null>(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [replace, setReplace] = useState(false);
  const mounted = useRef(false), owner = useRef<string | null>(null);
  async function loadStatus() {
    const customerId = await currentSession();
    if (owner.current && owner.current !== customerId) throw new ApiError(401, 'session_changed');
    owner.current = customerId;
    const current = await api<Status>('/api/recovery/status');
    if (typeof current.configured !== 'boolean' || (current.configured && (!current.accountReference || !Number.isInteger(current.version)))) throw Error('invalid_recovery_status');
    if (mounted.current) setStatus(current);
    return current;
  }
  useEffect(() => {
    mounted.current = true;
    loadStatus().catch(() => { if (mounted.current) setError('Recovery setup is unavailable. Try loading it again.'); });
    return () => { mounted.current = false; };
  }, []);
  async function reload() {
    setBusy(true); setError('');
    try { await loadStatus(); }
    catch { if (mounted.current) setError('Recovery setup is unavailable. Try loading it again.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function create() {
    if (!status || busy) return;
    setBusy(true); setError(''); setReplace(false);
    // A lost rotation response may already have invalidated the previously displayed key.
    setSecret(null);
    try {
      if (!owner.current || await currentSession() !== owner.current) throw new ApiError(401, 'session_changed');
      const result = status.configured
        ? await api<Secret>('/api/recovery/rotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: status.version }) })
        : await api<Secret>('/api/recovery/setup', { method: 'POST' });
      if (!/^[A-Za-z0-9_-]{14}$/.test(result.accountReference) || !/^[A-Za-z0-9_-]{43}$/.test(result.recoveryKey)) throw Error('invalid_recovery_details');
      if (mounted.current) {
        setSecret(result);
        setStatus({ configured: true, accountReference: result.accountReference, version: (status.version ?? 0) + 1 });
      }
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof ApiError && reason.status === 401) { setStatus(null); setError('Your account changed or expired. Close this view and reopen your current account before changing recovery details.'); return; }
      setError('The new key could not be confirmed. A previous key may no longer work. Load the current status, then create a replacement and save it.');
      setStatus(null);
      try { await loadStatus(); } catch { /* Keep replacement disabled until the current version is known. */ }
    } finally { if (mounted.current) setBusy(false); }
  }
  return <div className="recovery-box" aria-busy={busy}>
    <h3>Keep your access recoverable</h3><p>Save an account reference and recovery key somewhere private. You need both to restore this account in another browser. Never send the key to support or paste it into chat.</p>
    {status?.configured && !secret && <p>Account reference: <strong>{status.accountReference}</strong></p>}
    {secret && <div className="recovery-secret"><p>Save these now. The recovery key will not be shown again.</p><p>Account reference: <strong data-testid="account-reference">{secret.accountReference}</strong></p><p>Recovery key: <strong data-testid="recovery-key">{secret.recoveryKey}</strong></p><button className="secondary" onClick={() => setSecret(null)}>Hide saved key</button></div>}
    {error && <p role="alert">{error}</p>}
    {!status && <button className="secondary" disabled={busy} onClick={reload}>Load recovery status</button>}
    {replace ? <><p>Replacing this key invalidates the previous one immediately. Save the replacement before you leave.</p><div className="purchase-actions"><button className="secondary" disabled={busy} onClick={create}>Create replacement key</button><button className="secondary" disabled={busy} onClick={() => setReplace(false)}>Keep current key</button></div></> : <button className="secondary" disabled={!status || busy} onClick={() => status?.configured ? setReplace(true) : create()}>{busy ? 'Checking recovery…' : status?.configured ? 'Replace recovery key' : 'Create recovery key'}</button>}
  </div>;
}

export default function Recovery({ close, recovered }: { close: () => void; recovered: () => void }) {
  const [accountReference, setReference] = useState(''), [recoveryKey, setKey] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null), mounted = useRef(false);
  useEffect(() => { mounted.current = true; heading.current?.focus(); return () => { mounted.current = false; }; }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    const reference = accountReference.trim(), key = recoveryKey.trim();
    if (!/^[A-Za-z0-9_-]{14}$/.test(reference) || !/^[A-Za-z0-9_-]{43}$/.test(key)) { setError('Enter the complete account reference and recovery key you saved.'); return; }
    setBusy(true); setError('');
    try {
      const result = await api<{ customerId: string }>('/api/recovery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountReference: reference, recoveryKey: key }) });
      let verified: string;
      try { verified = await currentSession(); }
      catch { throw Error('cookie_not_confirmed'); }
      if (verified !== result.customerId) throw Error('cookie_not_confirmed');
      clearSessionSecrets(); announceSessionChange('recovered');
      if (mounted.current) { setKey(''); recovered(); }
    } catch (reason) {
      if (!mounted.current) return;
      if (reason instanceof Error && reason.message === 'cookie_not_confirmed') setError('Your recovery details were verified, but this browser did not keep the recovered session. Allow cookies for PamoFi, then try again.');
      else if (reason instanceof ApiError && reason.status === 429) setError('Too many recovery attempts. Wait a minute before trying again.');
      else if (reason instanceof ApiError && [400, 401].includes(reason.status)) setError('The reference and key could not be verified. Check both and try again.');
      else setError('The recovery service is temporarily unavailable. Your saved details have not been changed. Please try again.');
    } finally { if (mounted.current) setBusy(false); }
  }
  return <section className="purchase" aria-labelledby="recover-heading" aria-busy={busy}>
    <div className="purchase-head"><h2 id="recover-heading" ref={heading} tabIndex={-1}>Recover your account</h2><button className="close-button" onClick={close} aria-label="Close recovery">×</button></div>
    <p>Enter the account reference and recovery key you saved. A phone number or order reference alone cannot recover an account.</p>
    <form onSubmit={submit} className="recovery-form"><label>Account reference<input autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={100} value={accountReference} onChange={event => setReference(event.target.value)} /></label><label>Recovery key<input type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={100} value={recoveryKey} onChange={event => setKey(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}<button className="primary" disabled={busy} type="submit">{busy ? 'Verifying recovery…' : 'Recover access'} <span aria-hidden="true">→</span></button>
    </form>
  </section>;
}
