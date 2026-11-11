import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { type Capabilities, type Staff, localDate } from '../business';
import {
  type RouterChange, type RouterPreview, type RouterSnapshot, type RouterSummary, type RouterValues,
  parseRouterChange, parseRouterHistory, parseRouterList, parseRouterSnapshot, rememberRouterChange, rememberedRouterChange,
  routerChangeLabel, routerChangePath, routerChangePending, routerChangeSettled, routerFieldError, routerKindLabel,
  routerMessage, routerPath, routerValueText, verifyRouterAdministrator,
} from './router-fleet';
import '../router-fleet.css';

type Observation = { state: 'reachable' | 'unreachable' | 'review'; at?: string };
type PendingPreview = { routerId: string; key: string; payload: RouterPreview };
type PendingRollback = { routerId: string; changeId: string; key: string; reason: string };
const jsonHeaders = { 'Content-Type': 'application/json' };
const knownRejection = (error: unknown) => error instanceof ApiError && error.status >= 400 && error.status < 500 && error.code !== 'idempotency_conflict';
const at = (value: string | null) => value ? localDate(value) : 'Not recorded';

export default function RouterFleet({ staff, capabilities }: { staff: Staff; capabilities: Capabilities | null }) {
  const [service, setService] = useState({ known: capabilities?.routerFleet !== undefined, available: capabilities?.routerFleet === true, write: capabilities?.routerFleetWrite === true });
  const [routers, setRouters] = useState<RouterSummary[]>([]), [observations, setObservations] = useState<Record<string, Observation>>({});
  const [listLoading, setListLoading] = useState(false), [listError, setListError] = useState(''), [serviceLoading, setServiceLoading] = useState(false);
  const [search, setSearch] = useState(''), [siteFilter, setSiteFilter] = useState(''), [selectedId, setSelectedId] = useState('');
  const [snapshot, setSnapshot] = useState<RouterSnapshot | null>(null), [snapshotLoading, setSnapshotLoading] = useState(false), [snapshotError, setSnapshotError] = useState('');
  const [history, setHistory] = useState<RouterChange[]>([]), [historyError, setHistoryError] = useState(''), [historyLoading, setHistoryLoading] = useState(false);
  const [change, setChange] = useState<RouterChange | null>(null), [pendingChangeId, setPendingChangeId] = useState<string | null>(null);
  const [targetKey, setTargetKey] = useState(''), [draft, setDraft] = useState<RouterValues>({}), [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false), [feedback, setFeedback] = useState(''), [accessError, setAccessError] = useState('');
  const [action, setAction] = useState<'preview' | 'apply' | 'check' | 'rollback' | null>(null);
  const [previewSaved, setPreviewSaved] = useState(false), [rollbackSaved, setRollbackSaved] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false), [rollbackReason, setRollbackReason] = useState(''), [now, setNow] = useState(Date.now());
  const live = useRef(false), listGeneration = useRef(0), selectionGeneration = useRef(0);
  const listAbort = useRef<AbortController | null>(null), selectionAbort = useRef<AbortController | null>(null);
  const previewRequest = useRef<PendingPreview | null>(null), rollbackRequest = useRef<PendingRollback | null>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null), focusedChangeId = useRef<string | null>(null);
  const refreshedChange = useRef('');
  const selected = routers.find(router => router.id === selectedId);
  const target = snapshot?.targets.find(target => target.key === targetKey);
  const busy = action !== null;
  const writable = service.write && !!selected?.configured && !!selected?.writesEnabled && !!snapshot?.router.writesEnabled;
  const expired = !!change && change.status === 'prepared' && now >= Date.parse(change.expiresAt);
  const unresolved = !!pendingChangeId || !!change && routerChangePending(change);
  const ownChange = change?.actorId === staff.staffId && change?.actorVersion === String(staff.version);
  const canApply = !!change && change.status === 'prepared' && ownChange && writable && !expired && !pendingChangeId;
  const visibleRouters = routers.filter(router => (!siteFilter || router.siteId === siteFilter)
    && `${router.clientName} ${router.siteName}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const sites = [...new Map(routers.map(router => [router.siteId, { id: router.siteId, name: router.siteName }])).values()];
  const current = (generation: number) => live.current && selectionGeneration.current === generation;

  function rejectAccess(error: unknown) {
    if (!(error instanceof ApiError) || ![401, 403].includes(error.status) || ['actor_mismatch', 'fleet_writes_disabled'].includes(error.code)) return false;
    listGeneration.current++; selectionGeneration.current++; listAbort.current?.abort(); selectionAbort.current?.abort();
    setRouters([]); setSelectedId(''); setSnapshot(null); setChange(null); setHistory([]); setPendingChangeId(null);
    setListLoading(false); setSnapshotLoading(false); setHistoryLoading(false); setAction(null);
    previewRequest.current = null; rollbackRequest.current = null; setPreviewSaved(false); setRollbackSaved(false);
    setAccessError(routerMessage(error)); return true;
  }
  async function loadFleet() {
    const generation = ++listGeneration.current, controller = new AbortController();
    listAbort.current?.abort(); listAbort.current = controller;
    setListLoading(true); setListError(''); setAccessError('');
    try {
      await verifyRouterAdministrator(staff, controller.signal);
      const result = parseRouterList(await api<unknown>('/api/admin/routers', { signal: controller.signal }));
      if (!live.current || listGeneration.current !== generation) return;
      setRouters(result); setSiteFilter(value => result.some(router => router.siteId === value) ? value : '');
      setSelectedId(value => result.some(router => router.id === value) ? value : result.length === 1 ? result[0].id : '');
    } catch (error) {
      if (!live.current || listGeneration.current !== generation || controller.signal.aborted) return;
      if (!rejectAccess(error)) setListError(routerMessage(error, 'The router list could not be loaded. Retry to check the registered routers.'));
    } finally { if (live.current && listGeneration.current === generation) setListLoading(false); }
  }
  async function refreshService() {
    if (serviceLoading || busy) return; setServiceLoading(true); setListError('');
    try {
      await verifyRouterAdministrator(staff);
      const value = await api<Capabilities>('/api/capabilities');
      if (!live.current) return;
      const next = { known: typeof value.routerFleet === 'boolean', available: value.routerFleet === true, write: value.routerFleetWrite === true };
      setService(next); if (service.available && next.available) void loadFleet();
    } catch (error) { if (live.current && !rejectAccess(error)) setListError(routerMessage(error)); }
    finally { if (live.current) setServiceLoading(false); }
  }
  function acceptChange(next: RouterChange, generation: number) {
    if (!current(generation)) return;
    setChange(next); setConfirmed(false); rememberRouterChange(staff.staffId, next.nasId, next.id);
    setHistory(previous => [next, ...previous.filter(item => item.id !== next.id)]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 50));
    if (routerChangeSettled(next)) {
      if (rememberedRouterChange(staff.staffId, next.nasId, true) === next.id) rememberRouterChange(staff.staffId, next.nasId, null, true);
      setPendingChangeId(previous => previous === next.id ? null : previous);
    }
  }
  async function refreshReadback(routerId: string, generation: number) {
    const signal = selectionAbort.current?.signal;
    const results = await Promise.allSettled([
      api<unknown>(routerPath(routerId), { signal }).then(value => parseRouterSnapshot(value, routerId)),
      api<unknown>(`${routerPath(routerId)}/changes`, { signal }).then(value => parseRouterHistory(value, routerId)),
    ]);
    if (!current(generation) || signal?.aborted) return;
    if (results[0].status === 'fulfilled') {
      const details = results[0].value;
      setSnapshot(details); setSnapshotError('');
      setObservations(previous => ({ ...previous, [routerId]: { state: 'reachable', at: details.observedAt } }));
    } else if (!rejectAccess(results[0].reason)) setSnapshotError(routerMessage(results[0].reason));
    if (!current(generation)) return;
    if (results[1].status === 'fulfilled') { setHistory(results[1].value); setHistoryError(''); }
    else if (!rejectAccess(results[1].reason)) setHistoryError(routerMessage(results[1].reason));
  }
  async function loadSelection(routerId: string) {
    const router = routers.find(value => value.id === routerId); if (!router) return;
    const generation = ++selectionGeneration.current, controller = new AbortController();
    selectionAbort.current?.abort(); selectionAbort.current = controller; refreshedChange.current = '';
    const pending = rememberedRouterChange(staff.staffId, routerId, true);
    const remembered = pending ?? rememberedRouterChange(staff.staffId, routerId);
    setSnapshot(null); setSnapshotError(''); setSnapshotLoading(router.configured); setHistory([]); setHistoryError(''); setHistoryLoading(true);
    setChange(null); setPendingChangeId(pending); setConfirmed(false); setFeedback(''); setReason(''); setAction(null);
    setRollbackOpen(false); setRollbackReason(''); previewRequest.current = null; rollbackRequest.current = null; setPreviewSaved(false); setRollbackSaved(false);
    try {
      await verifyRouterAdministrator(staff, controller.signal);
      const [details, records] = await Promise.allSettled([
        router.configured ? api<unknown>(routerPath(routerId), { signal: controller.signal }).then(value => parseRouterSnapshot(value, routerId)) : Promise.resolve(null),
        api<unknown>(`${routerPath(routerId)}/changes`, { signal: controller.signal }).then(value => parseRouterHistory(value, routerId)),
      ]);
      if (!current(generation) || controller.signal.aborted) return;
      if (details.status === 'fulfilled') {
        setSnapshot(details.value);
        if (details.value) {
          setObservations(previous => ({ ...previous, [routerId]: { state: 'reachable', at: details.value!.observedAt } }));
          setTargetKey(previous => details.value!.targets.some(target => target.key === previous) ? previous : details.value!.targets[0]?.key ?? '');
        }
      } else {
        if (rejectAccess(details.reason)) return;
        setSnapshotError(routerMessage(details.reason));
        if (details.reason instanceof ApiError && ['router_unavailable', 'device_mismatch'].includes(details.reason.code)) {
          setObservations(previous => ({ ...previous, [routerId]: { state: details.reason.code === 'device_mismatch' ? 'review' : 'unreachable' } }));
        }
      }
      setSnapshotLoading(false);
      if (records.status === 'fulfilled') setHistory(records.value);
      else { if (rejectAccess(records.reason)) return; setHistoryError(routerMessage(records.reason)); }
      setHistoryLoading(false);
      if (remembered) {
        const known = records.status === 'fulfilled' ? records.value.find(value => value.id === remembered) : undefined;
        const restored = known ?? parseRouterChange(await api<unknown>(routerChangePath(routerId, remembered), { signal: controller.signal }), routerId, remembered);
        acceptChange(restored, generation);
        if (current(generation) && pending && !routerChangeSettled(restored)) setFeedback('A previous apply is awaiting verification. Check its recorded outcome before starting another change.');
      }
    } catch (error) {
      if (!current(generation) || controller.signal.aborted) return;
      if (!rejectAccess(error)) setFeedback(routerMessage(error, 'The saved change could not be loaded. Refresh its recorded outcome before making another change.'));
    } finally { if (current(generation)) { setSnapshotLoading(false); setHistoryLoading(false); } }
  }

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; listGeneration.current++; selectionGeneration.current++; listAbort.current?.abort(); selectionAbort.current?.abort(); };
  }, []);
  useEffect(() => { setService({ known: capabilities?.routerFleet !== undefined, available: capabilities?.routerFleet === true, write: capabilities?.routerFleetWrite === true }); }, [capabilities?.routerFleet, capabilities?.routerFleetWrite]);
  useEffect(() => {
    if (service.available) void loadFleet();
    else { listGeneration.current++; listAbort.current?.abort(); setRouters([]); setSelectedId(''); setListLoading(false); }
  }, [service.available, staff.staffId, staff.version]);
  useEffect(() => {
    if (selectedId && service.available) void loadSelection(selectedId);
    else { selectionGeneration.current++; selectionAbort.current?.abort(); setSnapshot(null); setChange(null); setHistory([]); setPendingChangeId(null); }
  }, [selectedId, service.available, staff.staffId, staff.version]);
  useEffect(() => { setDraft(target ? { ...target.values } : {}); setConfirmed(false); }, [snapshot, targetKey]);
  useEffect(() => {
    if (change?.id && focusedChangeId.current !== change.id) {
      focusedChangeId.current = change.id; reviewHeading.current?.focus();
    }
  }, [change?.id]);
  useEffect(() => {
    if (!change) return; setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);
  }, [change?.id]);
  useEffect(() => {
    if (!change || (!routerChangePending(change) && pendingChangeId !== change.id)) return;
    const generation = selectionGeneration.current, controller = new AbortController(); let attempts = 0, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = parseRouterChange(await api<unknown>(routerChangePath(change.nasId, change.id), { signal: controller.signal }), change.nasId, change.id);
        if (!current(generation) || controller.signal.aborted) return;
        acceptChange(next, generation);
        if (routerChangeSettled(next)) {
          const key = `${next.id}:${next.updatedAt}`;
          if (refreshedChange.current !== key) { refreshedChange.current = key; void refreshReadback(next.nasId, generation); }
          return;
        }
      } catch (error) {
        if (!current(generation) || controller.signal.aborted) return;
        if (rejectAccess(error)) return;
      }
      if (++attempts < 5 && current(generation) && !controller.signal.aborted) timer = setTimeout(poll, 5000);
    };
    timer = setTimeout(poll, 5000);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [change?.id, change?.status, pendingChangeId]);

  async function prepare(event: React.FormEvent) {
    event.preventDefault(); if (busy || !selected || !target || !writable || unresolved) return;
    let saved = previewRequest.current;
    if (!saved) {
      const invalid = routerFieldError(target, draft);
      if (invalid || reason.trim().length < 10 || reason.trim().length > 500) { setFeedback(invalid ?? 'Enter a reason of 10 to 500 characters.'); return; }
      saved = { routerId: selected.id, key: crypto.randomUUID(), payload: { targetKey: target.key, expectedRevision: target.revision, values: { ...draft }, reason: reason.trim() } };
      previewRequest.current = saved; setPreviewSaved(true);
    }
    const generation = selectionGeneration.current, signal = selectionAbort.current?.signal;
    setAction('preview'); setFeedback('');
    try {
      await verifyRouterAdministrator(staff, signal);
      const next = parseRouterChange(await api<unknown>(`${routerPath(saved.routerId)}/changes`, {
        method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': saved.key }, body: JSON.stringify(saved.payload), signal,
      }), saved.routerId);
      if (!current(generation)) return;
      previewRequest.current = null; setPreviewSaved(false); acceptChange(next, generation);
      setFeedback('Review the recorded before and after values, then confirm this change.');
    } catch (error) {
      if (!current(generation) || signal?.aborted) return;
      if (rejectAccess(error)) return;
      if (knownRejection(error)) { previewRequest.current = null; setPreviewSaved(false); }
      if (error instanceof ApiError && error.code === 'revision_conflict') setSnapshot(null);
      setFeedback(routerMessage(error, 'The preview response was interrupted. Retry the saved preview or check change history; no apply was requested.'));
    } finally { if (current(generation)) setAction(null); }
  }
  async function apply() {
    if (busy || !change || !canApply || !confirmed) return;
    const original = change, generation = selectionGeneration.current, signal = selectionAbort.current?.signal;
    setAction('apply'); setFeedback(''); setConfirmed(false);
    try {
      await verifyRouterAdministrator(staff, signal);
      if (!current(generation) || signal?.aborted) return;
      rememberRouterChange(staff.staffId, original.nasId, original.id, true); setPendingChangeId(original.id);
      const result = await api<unknown>(`${routerChangePath(original.nasId, original.id)}/apply`, { method: 'POST', headers: jsonHeaders, body: '{}', signal });
      const next = parseRouterChange(result, original.nasId, original.id); acceptChange(next, generation);
      if (current(generation) && routerChangeSettled(next)) await refreshReadback(original.nasId, generation);
    } catch (error) {
      if (!current(generation) || signal?.aborted) return;
      if (rejectAccess(error)) return;
      setFeedback(routerMessage(error, 'The apply response was interrupted. Its outcome is not confirmed; check the recorded change before doing anything else.'));
      // This is a read of the same durable change. Never retry the apply POST.
      try {
        const next = parseRouterChange(await api<unknown>(routerChangePath(original.nasId, original.id), { signal }), original.nasId, original.id);
        acceptChange(next, generation);
        if (current(generation) && knownRejection(error) && next.status === 'prepared') {
          rememberRouterChange(staff.staffId, next.nasId, null, true); setPendingChangeId(null);
          if (error instanceof ApiError && ['writes_disabled', 'fleet_writes_disabled'].includes(error.code)) setService(previous => ({ ...previous, write: false }));
        }
        if (current(generation) && routerChangeSettled(next)) await refreshReadback(original.nasId, generation);
      } catch (readError) { if (current(generation) && !signal?.aborted) rejectAccess(readError); }
    } finally { if (current(generation)) setAction(null); }
  }
  async function checkOutcome(value = change) {
    if (busy || !value) return;
    const generation = selectionGeneration.current, signal = selectionAbort.current?.signal;
    setAction('check'); setFeedback('');
    try {
      await verifyRouterAdministrator(staff, signal);
      const reconcile = routerChangePending(value) && value.reconcileAfter !== null && Date.now() >= Date.parse(value.reconcileAfter);
      const path = routerChangePath(value.nasId, value.id);
      const next = parseRouterChange(await api<unknown>(reconcile ? `${path}/reconcile` : path,
        reconcile ? { method: 'POST', headers: jsonHeaders, body: '{}', signal } : { signal }), value.nasId, value.id);
      acceptChange(next, generation);
      if (current(generation) && routerChangeSettled(next)) await refreshReadback(value.nasId, generation);
    } catch (error) { if (current(generation) && !signal?.aborted && !rejectAccess(error)) setFeedback(routerMessage(error)); }
    finally { if (current(generation)) setAction(null); }
  }
  async function openChange(changeId: string) {
    if (busy || !selected) return;
    const generation = selectionGeneration.current, signal = selectionAbort.current?.signal;
    setAction('check'); setFeedback('');
    try {
      await verifyRouterAdministrator(staff, signal);
      const next = parseRouterChange(await api<unknown>(routerChangePath(selected.id, changeId), { signal }), selected.id, changeId);
      acceptChange(next, generation);
      if (current(generation)) { setRollbackOpen(false); setRollbackReason(''); rollbackRequest.current = null; setRollbackSaved(false); previewRequest.current = null; setPreviewSaved(false); }
    } catch (error) { if (current(generation) && !signal?.aborted && !rejectAccess(error)) setFeedback(routerMessage(error)); }
    finally { if (current(generation)) setAction(null); }
  }
  async function prepareRollback(event: React.FormEvent) {
    event.preventDefault(); if (busy || !change || change.status !== 'applied' || !writable || unresolved) return;
    let saved = rollbackRequest.current;
    if (!saved) {
      if (rollbackReason.trim().length < 10 || rollbackReason.trim().length > 500) { setFeedback('Enter a rollback reason of 10 to 500 characters.'); return; }
      saved = { routerId: change.nasId, changeId: change.id, key: crypto.randomUUID(), reason: rollbackReason.trim() };
      rollbackRequest.current = saved; setRollbackSaved(true);
    }
    const generation = selectionGeneration.current, signal = selectionAbort.current?.signal; setAction('rollback'); setFeedback('');
    try {
      await verifyRouterAdministrator(staff, signal);
      const next = parseRouterChange(await api<unknown>(`${routerChangePath(saved.routerId, saved.changeId)}/rollback`, {
        method: 'POST', headers: { ...jsonHeaders, 'Idempotency-Key': saved.key }, body: JSON.stringify({ reason: saved.reason }), signal,
      }), saved.routerId);
      if (!current(generation)) return;
      rollbackRequest.current = null; setRollbackSaved(false); setRollbackOpen(false); setRollbackReason(''); acceptChange(next, generation);
      setFeedback('Rollback preview prepared. Review and apply this inverse change separately.');
    } catch (error) {
      if (!current(generation) || signal?.aborted || rejectAccess(error)) return;
      if (knownRejection(error)) { rollbackRequest.current = null; setRollbackSaved(false); }
      setFeedback(routerMessage(error, 'The rollback preview response was interrupted. Retry the saved preview or check change history; no rollback apply was requested.'));
    } finally { if (current(generation)) setAction(null); }
  }
  function anotherChange() {
    if (busy || !selected || unresolved) return;
    rememberRouterChange(staff.staffId, selected.id, null); void loadSelection(selected.id);
  }
  const reachability = (router: RouterSummary) => !router.configured ? 'Needs setup' : observations[router.id]?.state === 'reachable' ? 'Reachable'
    : observations[router.id]?.state === 'unreachable' ? 'Unreachable' : observations[router.id]?.state === 'review' ? 'Device needs review' : 'Not checked';
  const delta = change ? Object.keys(change.after).filter(key => change.after[key] !== change.before[key]) : [];
  const selectedTarget = change ? snapshot?.targets.find(target => target.key === change.targetKey) : undefined;
  const pendingElsewhere = pendingChangeId !== null && pendingChangeId !== change?.id;

  return <section className="router-fleet" aria-labelledby="router-fleet-heading">
    <div className="router-fleet-heading"><div><h3 id="router-fleet-heading">Routers</h3><p>One staff session for your registered PasoFi routers.</p></div>
      <button className="secondary" disabled={listLoading || serviceLoading || busy} onClick={refreshService}>{serviceLoading || listLoading ? 'Checking…' : 'Refresh routers'}</button></div>
    {accessError ? <p className="notice" role="alert">{accessError} Use Refresh staff access or sign in again.</p> : <>
      {!service.available && <div className="router-service-note" role="status"><strong>{service.known ? 'Router management is not enabled yet.' : 'Router management needs the service update.'}</strong><p>Registered routers appear here after their private management service is configured.</p></div>}
      {listError && <p className="feedback" role="alert">{listError}</p>}
      {service.available && <>
        <div className="router-fleet-toolbar"><label>Find a router<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Router or site" /></label>
          <label>Router site<select value={siteFilter} onChange={event => setSiteFilter(event.target.value)}><option value="">All sites</option>{sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label></div>
        <p className="router-fleet-count" role="status">{listLoading && routers.length === 0 ? 'Loading registered routers…' : `${routers.length} registered · ${routers.filter(router => router.configured).length} configured · ${routers.filter(router => !router.configured).length} need setup`}</p>
        {!listLoading && !listError && routers.length === 0 && <p className="router-service-note">No routers are registered yet. An operator must add each existing router and its private management connection.</p>}
        {routers.length > 0 && <div className="router-fleet-layout"><div className="router-fleet-list"><ul className="router-list" aria-label="Registered routers">
          {visibleRouters.map(router => <li key={router.id}><button type="button" disabled={busy} aria-pressed={selectedId === router.id} className={`router-row${selectedId === router.id ? ' selected' : ''}`}
            onClick={() => setSelectedId(router.id)} aria-label={`Manage ${router.clientName} at ${router.siteName}`}><span className="router-row-main"><strong>{router.clientName}</strong><small>{router.siteName}</small></span>
            <span className={`router-state ${observations[router.id]?.state ?? 'unchecked'}`}>{reachability(router)}</span></button></li>)}
        </ul>{visibleRouters.length === 0 && <p className="router-service-note">No routers match this filter.</p>}</div>
        <div className="router-detail">{!selected ? <p className="router-service-note">Select a router to inspect its status and supported settings.</p> : <>
          <div className="router-detail-heading"><div><h4>{selected.clientName}</h4><p>{selected.siteName}</p></div><button className="secondary" disabled={busy || snapshotLoading || historyLoading} onClick={() => loadSelection(selected.id)}>Refresh router</button></div>
          <div className="router-status-strip"><span className={`router-state ${observations[selected.id]?.state ?? 'unchecked'}`}>{snapshotLoading ? 'Checking router…' : reachability(selected)}</span><span>{capabilities?.networkAccess && selected.customerNetworkEnabled ? 'Customer access permitted' : 'Customer access paused'}</span></div>
          {!selected.configured && <p className="router-service-note">Private management is not configured for this router. An operator must register its connection before it can be inspected.</p>}
          {snapshotError && <p className="feedback" role="alert">{snapshotError}</p>}
          {snapshot && <><dl className="router-device-summary"><div><dt>Model</dt><dd>{snapshot.device.model || 'Not reported'}</dd></div><div><dt>RouterOS</dt><dd>{snapshot.device.version || 'Not reported'}</dd></div><div><dt>Last verified check</dt><dd><time dateTime={snapshot.observedAt}>{localDate(snapshot.observedAt)}</time></dd></div></dl>
            <details className="router-device-more"><summary>Device details</summary><dl><div><dt>Identity</dt><dd>{snapshot.device.identity || 'Not reported'}</dd></div><div><dt>Serial</dt><dd>{snapshot.device.serial || 'Not reported'}</dd></div><div><dt>Router record</dt><dd>{selected.id}</dd></div></dl></details>
            {!writable && <p className="router-service-note">Configuration changes are disabled for this router. Its verified status and recorded history remain available.</p>}</>}
          {feedback && <p className="feedback" role="status">{feedback}</p>}
          {pendingElsewhere && <div className="router-service-note" role="status"><p>A previous apply still needs verification before another change can start.</p><button className="secondary" disabled={busy} onClick={() => openChange(pendingChangeId!)}>Open pending change</button></div>}
          {snapshot && !change && !pendingElsewhere && <form className="router-config-form" onSubmit={prepare}>
            <h4>Configuration</h4>{snapshot.targets.length === 0 ? <p>No supported configuration areas are registered for this router.</p> : <>
              <label>Configuration area<select disabled={busy || previewSaved || unresolved} value={targetKey} onChange={event => { setTargetKey(event.target.value); setReason(''); setFeedback(''); }}>
                {snapshot.targets.map(value => <option key={value.key} value={value.key}>{value.name ? `${routerKindLabel[value.kind]} · ${value.name}` : routerKindLabel[value.kind]}</option>)}</select></label>
              <fieldset disabled={busy || previewSaved || !writable || unresolved}>
                {target && <div className="router-config-fields">{target.fields.map(field => field.type === 'boolean'
                  ? <label className="router-check" key={field.key}><input type="checkbox" checked={draft[field.key] === true} onChange={event => setDraft(previous => ({ ...previous, [field.key]: event.target.checked }))} /><span>{field.label}{field.help && <small>{field.help}</small>}</span></label>
                  : <label key={field.key}>{field.label}<input type="text" required={!['comment', 'rate-limit'].includes(field.key)} maxLength={field.maxLength} value={typeof draft[field.key] === 'string' ? draft[field.key] as string : ''}
                    autoComplete="off" onChange={event => setDraft(previous => ({ ...previous, [field.key]: event.target.value }))} />{field.help && <small>{field.help}</small>}</label>)}</div>}
                <label>Change reason<textarea required minLength={10} maxLength={500} rows={2} value={reason} onChange={event => setReason(event.target.value)} placeholder="Why is this change needed?" /></label>
              </fieldset><button className="primary" disabled={busy || !writable || unresolved || !target}>{action === 'preview' ? 'Preparing preview…' : previewSaved ? 'Retry saved preview' : 'Review change'}</button>
            </>}
          </form>}
          {change && <section className="router-change" aria-labelledby="router-change-heading" data-testid="router-change-review">
            <div className="router-change-heading"><h4 id="router-change-heading" ref={reviewHeading} tabIndex={-1}>{change.parentChangeId ? 'Review rollback' : 'Reviewed change'}</h4><span className={`router-change-state ${change.status}`} role="status">{expired ? 'Preview time elapsed' : routerChangeLabel[change.status]}</span></div>
            <p className="router-change-target">{routerKindLabel[change.targetKind]}{change.targetName ? ` · ${change.targetName}` : ''}</p>
            <dl className="router-diff">{delta.map(key => <div key={key}><dt>{selectedTarget?.fields.find(field => field.key === key)?.label ?? key}</dt><dd><span>Before<strong>{routerValueText(key, change.before[key])}</strong></span><span>After<strong>{routerValueText(key, change.after[key])}</strong></span></dd></div>)}</dl>
            <p className="router-change-reason"><strong>Reason:</strong> {change.reason}</p>
            {change.status === 'prepared' && !expired && <p className="router-change-note">Review expires <time dateTime={change.expiresAt}>{localDate(change.expiresAt)}</time>.</p>}
            {expired && <p className="router-service-note">This preview’s review period has ended. Refresh its recorded status and prepare a new change.</p>}
            {change.status === 'prepared' && !ownChange && <p className="router-service-note">Only the administrator who prepared this change can apply it.</p>}
            {(pendingChangeId === change.id || routerChangePending(change)) && <div className="router-service-note" role="status"><p>The recorded outcome must be verified before another change is applied.</p>
              {change.reconcileAfter && now < Date.parse(change.reconcileAfter) && <p>A fresh router verification is available after <time dateTime={change.reconcileAfter}>{localDate(change.reconcileAfter)}</time>. You can refresh the recorded status meanwhile.</p>}</div>}
            {change.status === 'diverged' && <p className="router-service-note">The router differs from both reviewed versions. Refresh and inspect its current settings before preparing another change.</p>}
            {change.errorCode && <p className="router-change-note">{routerMessage(new ApiError(409, change.errorCode), 'The service could not verify this change. Inspect the router and its recorded history.')}</p>}
            {canApply && <label className="router-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /><span>I reviewed these changes for {selected.clientName}.</span></label>}
            <div className="router-change-actions">
              {canApply && <button className="primary" disabled={busy || !confirmed} onClick={apply}>{action === 'apply' ? 'Applying…' : 'Apply reviewed change'}</button>}
              <button className="secondary" disabled={busy} onClick={() => checkOutcome()}>{action === 'check' ? 'Checking…' : 'Check outcome'}</button>
              {!unresolved && <button className="secondary" disabled={busy} onClick={anotherChange}>{change.status === 'prepared' ? 'Edit settings' : 'Refresh and edit settings'}</button>}
              {change.status === 'applied' && writable && !unresolved && !rollbackOpen && <button className="secondary" disabled={busy} onClick={() => { setRollbackOpen(true); setRollbackReason(''); }}>Prepare rollback</button>}
            </div>
            {rollbackOpen && change.status === 'applied' && <form className="router-rollback-form" onSubmit={prepareRollback}><p>Rollback opens a new inverse change for review and application.</p><label>Rollback reason<textarea required minLength={10} maxLength={500} rows={2} disabled={busy || rollbackSaved || !writable} value={rollbackReason} onChange={event => setRollbackReason(event.target.value)} /></label>
              <div className="router-change-actions"><button className="primary" disabled={busy || !writable || unresolved}>{action === 'rollback' ? 'Preparing…' : rollbackSaved ? 'Retry saved rollback preview' : 'Review rollback'}</button><button type="button" className="secondary" disabled={busy || rollbackSaved} onClick={() => setRollbackOpen(false)}>Cancel</button></div></form>}
            <details className="router-change-record"><summary>Change record</summary><dl><div><dt>Reference</dt><dd>{change.id}</dd></div><div><dt>Prepared</dt><dd>{at(change.createdAt)}</dd></div><div><dt>Last updated</dt><dd>{at(change.updatedAt)}</dd></div><div><dt>Administrator</dt><dd>{change.actorId === staff.staffId ? 'You' : change.actorId}</dd></div>{change.appliedAt && <div><dt>Verified application</dt><dd>{at(change.appliedAt)}</dd></div>}</dl></details>
          </section>}
          <details className="router-history"><summary>Change history {history.length > 0 ? `(${history.length})` : ''}</summary>
            {historyLoading && <p role="status">Loading change history…</p>}{historyError && <p className="feedback" role="alert">{historyError}</p>}
            {!historyLoading && !historyError && history.length === 0 && <p>No recorded changes for this router.</p>}
            <ol>{history.map(item => <li key={item.id}><button disabled={busy} onClick={() => openChange(item.id)} aria-label={`Review change ${item.id}`}>
              <span><strong>{item.targetName || routerKindLabel[item.targetKind]}</strong><small>{localDate(item.createdAt)}</small></span><span>{routerChangeLabel[item.status]}</span></button></li>)}</ol>
            {history.length === 50 && <p className="router-change-note">Showing the 50 most recent changes.</p>}
          </details>
        </>}</div></div>}
      </>}
    </>}
  </section>;
}
