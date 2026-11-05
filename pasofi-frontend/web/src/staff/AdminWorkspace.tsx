import CashRefunds from './CashRefunds';
import CashShifts from './CashShifts';
import AgentOnboarding from './AgentOnboarding';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import NetworkReviews from './NetworkReviews';
import SalesHistory from './SalesHistory';
import { type Capabilities, type Product, type Site, type Staff, finishMutation, localDate, messageFor, money, mutationIntent } from '../business';
import { CatalogueUpgradeError, catalogueUpgradePreview, upgradeCatalogue } from './catalogue-upgrade';

type Audit = { id: string; actorStaffId: string | null; targetStaffId: string; action: string; reason: string; createdAt: string; newVersion: number };
type Stock = { agentId: string; siteId: string; siteName: string; bundleId: string; quantity: number };
type SetupSection = 'people' | 'sites' | 'catalogue' | 'inventory';
const sectionNames: Record<SetupSection, string> = { people: 'Staff records', sites: 'Sites', catalogue: 'Bundle catalogue', inventory: 'Inventory' };
export default function AdminWorkspace({ staff, capabilities }: { staff: Staff; capabilities: Capabilities | null }) {
  const [tab, setTab] = useState<'people' | 'inventory' | 'sites' | 'catalogue' | 'sales' | 'cash' | 'network' | 'audit'>('people');
  const [users, setUsers] = useState<Staff[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [sites, setSites] = useState<Site[]>([]), [products, setProducts] = useState<(Product & { published: boolean })[]>([]), [stock, setStock] = useState<Stock[]>([]);
  const [events, setEvents] = useState<Audit[]>([]), [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState(''), [decision, setDecision] = useState<'approved' | 'rejected' | 'disabled' | 'revoke_sessions' | 'recover_mfa'>('approved');
  const [role, setRole] = useState<'agent' | 'support' | 'admin'>('agent'), [assigned, setAssigned] = useState<string[]>([]), [reason, setReason] = useState(''), [adminConfirmed, setAdminConfirmed] = useState(false), [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [agentId, setAgentId] = useState(''), [siteId, setSiteId] = useState(''), [bundleId, setBundleId] = useState(''), [quantity, setQuantity] = useState('1'), [allocationReason, setAllocationReason] = useState('');
  const [newBundleId, setNewBundleId] = useState(''), [newPrice, setNewPrice] = useState(''), [newCurrency, setNewCurrency] = useState('USD'), [cashCurrencies, setCashCurrencies] = useState<string[]>([]), [newData, setNewData] = useState(''), [newDays, setNewDays] = useState(''), [catalogueReason, setCatalogueReason] = useState(''), [publicationReason, setPublicationReason] = useState('');
  const [siteName, setSiteName] = useState(''), [siteRequestId, setSiteRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [loaded, setLoaded] = useState(false), [pendingAllocation, setPendingAllocation] = useState(false);
  const [sectionErrors, setSectionErrors] = useState<Partial<Record<SetupSection, string>>>({});
  const [pricingRunning, setPricingRunning] = useState(false), [pricingProgress, setPricingProgress] = useState('');
  const [publicationGuardVersion, setPublicationGuardVersion] = useState<1 | null>(null);
  const pricingAbort = useRef<AbortController | null>(null);
  const live = useRef(false), owner = `staff:${staff.staffId}`;
  const pricing = catalogueUpgradePreview(products);
  const selected = users.find(user => user.staffId === selectedId), agents = users.filter(user => user.status === 'approved' && user.role === 'agent');
  const canAllocate = capabilities?.inventoryAllocation ?? capabilities?.staffSales ?? false;
  const requiredSections: SetupSection[] = tab === 'inventory' ? ['people', 'sites', 'catalogue', 'inventory'] : tab === 'people' || tab === 'sites' || tab === 'catalogue' ? [tab] : [];
  const unavailableSections = requiredSections.filter(section => sectionErrors[section]);
  async function verify() { try { const current = await api<Staff>('/api/staff/session'); if (current.staffId !== staff.staffId || current.version !== staff.version || current.status !== 'approved' || current.role !== 'admin') throw new ApiError(401, 'staff_changed'); } catch (error) { if (error instanceof ApiError && [401, 403].includes(error.status)) { setLoaded(false); setUsers([]); setStock([]); setEvents([]); setSelectedId(''); } throw error; } }
  async function load() {
    setBusy(true); setMessage('');
    try {
      await verify();
      const [people, locations, catalogue, inventory] = await Promise.allSettled([
        api<{ users: Staff[]; nextCursor: string | null }>('/api/staff/users'), api<{ sites: Site[] }>('/api/staff/sites'),
        api<{ products: (Product & { published: boolean })[]; currencies?: string[]; publicationGuardVersion?: number }>('/api/admin/bundles'), api<{ inventory: Stock[] }>('/api/staff/inventory'),
      ]);
      if (!live.current) return;
      // Setup sections have independent availability. A paused or failed
      // commerce endpoint must not hide staff approvals or successful reads.
      const failures: Partial<Record<SetupSection, string>> = {};
      if (people.status === 'fulfilled') { setUsers(people.value.users); setCursor(people.value.nextCursor); }
      else { setUsers([]); setCursor(null); setSelectedId(''); failures.people = messageFor(people.reason); }
      if (locations.status === 'fulfilled') setSites(locations.value.sites);
      else { setSites([]); failures.sites = messageFor(locations.reason); }
      if (catalogue.status === 'fulfilled') { setProducts(catalogue.value.products); setPublicationGuardVersion(catalogue.value.publicationGuardVersion === 1 ? 1 : null); const currencies = catalogue.value.currencies ?? ['USD']; setCashCurrencies(currencies); setNewCurrency(current => currencies.includes(current) ? current : currencies[0] ?? ''); }
      else { setProducts([]); setPublicationGuardVersion(null); failures.catalogue = messageFor(catalogue.reason); }
      if (inventory.status === 'fulfilled') setStock(inventory.value.inventory);
      else { setStock([]); failures.inventory = messageFor(inventory.reason); }
      setSectionErrors(failures); setLoaded(true);
      const saved = sessionStorage.getItem(`pamofi.operation:${owner}:allocation`);
      if (saved) {
        const draft = JSON.parse(JSON.parse(saved).payload) as { agentId: string; siteId: string; bundleId: string; quantity: number; reason: string };
        setAgentId(draft.agentId); setSiteId(draft.siteId); setBundleId(draft.bundleId); setQuantity(String(draft.quantity)); setAllocationReason(draft.reason); setPendingAllocation(true);
        setMessage('An inventory allocation is awaiting confirmation. Retry the restored request before making a different allocation.');
      }
    } catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  useEffect(() => { live.current = true; setPricingRunning(false); setPricingProgress(''); void load(); return () => { live.current = false; pricingAbort.current?.abort(); pricingAbort.current = null; }; }, [staff.staffId, staff.version]);
  async function moreUsers() {
    if (busy || !cursor) return; setBusy(true);
    try { await verify(); const result = await api<{ users: Staff[]; nextCursor: string | null }>(`/api/staff/users?after=${encodeURIComponent(cursor)}`); if (live.current) { setUsers(previous => [...new Map([...previous, ...result.users].map(user => [user.staffId, user])).values()]); setCursor(result.nextCursor); } }
    catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  function selectUser(user: Staff) { setSelectedId(user.staffId); setDecision(user.status === 'approved' ? 'disabled' : 'approved'); setRole(user.role ?? 'agent'); setAssigned(user.siteIds); setReason(''); setAdminConfirmed(false); setRecoveryConfirmed(false); setMessage(''); }
  async function decide(event: React.FormEvent) {
    event.preventDefault(); if (busy || !selected || selected.staffId === staff.staffId || (decision === 'recover_mfa' && !recoveryConfirmed)) return;
    setBusy(true); setMessage('');
    try {
      await verify();
      const result = await api<Staff>(`/api/staff/users/${selected.staffId}/${decision === 'revoke_sessions' ? 'revoke-sessions' : decision === 'recover_mfa' ? 'recover-mfa' : 'decision'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: selected.version, ...(['approved', 'rejected', 'disabled'].includes(decision) ? { status: decision } : {}), ...(decision === 'approved' ? { role, siteIds: role === 'admin' ? [] : assigned } : {}), reason: reason.trim() }) });
      if (live.current) { setUsers(previous => previous.map(user => user.staffId === result.staffId ? result : user)); setSelectedId(''); setMessage(decision === 'recover_mfa' ? 'Authenticator recovery started. The account must sign in with its password, enroll a new authenticator, and be approved again.' : 'Staff decision saved. The account must sign in again to use its updated permissions.'); }
    } catch (error) { if (live.current) setMessage(messageFor(error, 'This decision could not be saved. Refresh staff records and review the latest version before retrying.')); }
    finally { if (live.current) setBusy(false); }
  }
  async function allocate(event: React.FormEvent) {
    event.preventDefault(); if (busy || !canAllocate) return;
    const payload = { agentId, siteId, bundleId, quantity: Number(quantity), reason: allocationReason.trim() };
    if (!pendingAllocation && (!agentId || !siteId || !bundleId || !Number.isInteger(payload.quantity) || payload.quantity < 1 || payload.quantity > 10000 || payload.reason.length < 10)) { setMessage('Choose an agent, site, and bundle; enter a whole stock quantity and a reason of at least 10 characters.'); return; }
    setBusy(true); setMessage('');
    try {
      await verify(); const key = mutationIntent(owner, 'allocation', payload); setPendingAllocation(true);
      await api('/api/admin/inventory/allocations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(payload) });
      finishMutation(owner, 'allocation');
      if (!live.current) return;
      setPendingAllocation(false); setAllocationReason(''); setQuantity('1'); setMessage('Inventory allocation confirmed. A retry of this request cannot allocate the same stock twice.');
      try { const result = await api<{ inventory: Stock[] }>('/api/staff/inventory'); if (live.current) setStock(result.inventory); }
      catch { if (live.current) setMessage('Inventory allocation confirmed. The latest stock could not be loaded; refresh administration before making another allocation.'); }
    } catch (error) {
      // These responses are issued only after the same-key replay check and a
      // rollback. Older agent_not_eligible, conflicts and unknown outcomes keep
      // their saved key until the original allocation can be reconciled.
      const rejected = error instanceof ApiError && error.status === 409 && ['allocation_agent_not_eligible', 'site_or_bundle_unavailable'].includes(error.code);
      if (rejected) finishMutation(owner, 'allocation');
      if (live.current) {
        if (rejected) { setPendingAllocation(false); setMessage(`${error.code === 'allocation_agent_not_eligible' ? 'The selected agent is no longer approved for this site.' : 'The selected site or bundle is no longer available.'} No stock was allocated by this request. Refresh the options and review the details before trying again.`); }
        else setMessage(messageFor(error, 'The allocation response could not be verified. Retry the saved allocation to check the original request.'));
      }
    }
    finally { if (live.current) setBusy(false); }
  }
  async function createSite(event: React.FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setMessage('');
    try {
      await verify(); await api('/api/admin/sites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: siteRequestId, name: siteName.trim() }) });
      const result = await api<{ sites: Site[] }>('/api/staff/sites');
      if (live.current) { setSites(result.sites); setSiteName(''); setSiteRequestId(crypto.randomUUID()); setMessage('Site created. This does not configure a router or enable hotspot connectivity.'); }
    } catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  async function createBundle(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    if (!/^\d+(?:\.\d{1,2})?$/.test(newPrice) || !/^\d+(?:\.\d{1,9})?$/.test(newData)) { setMessage('Enter a price with up to two decimal places and a positive data allowance in GB.'); return; }
    const [dollars, cents = ''] = newPrice.split('.'), [whole, fraction = ''] = newData.split('.');
    const priceMinor = Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
    const byteLimit = (BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'))).toString();
    const validitySeconds = Number(newDays) * 86400;
    if (!cashCurrencies.includes(newCurrency) || !Number.isSafeInteger(priceMinor) || priceMinor < 1 || BigInt(byteLimit) < 1n || !Number.isSafeInteger(validitySeconds) || validitySeconds < 86400) { setMessage('Price, data allowance, and validity must be positive, valid values.'); return; }
    setBusy(true); setMessage('');
    try {
      await verify(); await api('/api/admin/bundles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: newBundleId.trim(), priceMinor, currency: newCurrency, byteLimit, validitySeconds, published: false, reason: catalogueReason.trim() }) });
      const result = await api<{ products: (Product & { published: boolean })[] }>('/api/admin/bundles');
      if (live.current) { setProducts(result.products); setNewBundleId(''); setNewPrice(''); setNewData(''); setNewDays(''); setCatalogueReason(''); setMessage('A new draft bundle version is saved. Review its terms before publishing. Existing purchases keep their original terms.'); }
    } catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  async function applyRevisedPricing() {
    if (busy || pricingAbort.current || publicationGuardVersion !== 1 || pricing.complete || pricing.conflicts.length || !cashCurrencies.includes('USD')) return;
    const controller = new AbortController(); pricingAbort.current = controller;
    const current = () => live.current && pricingAbort.current === controller && !controller.signal.aborted;
    setBusy(true); setPricingRunning(true); setMessage(''); setPricingProgress('Checking the current catalogue and your administrator session…');
    try {
      const result = await upgradeCatalogue({ request: api, actor: staff, signal: controller.signal,
        onSnapshot: snapshot => { if (current()) { setProducts(snapshot.products); setCashCurrencies(snapshot.currencies); setPublicationGuardVersion(snapshot.publicationGuardVersion); } },
        onProgress: progress => { if (current()) setPricingProgress(progress); },
      });
      if (current()) {
        const kept = catalogueUpgradePreview(result.products).preservedLegacy;
        setMessage(`Revised pricing is published: 5, 10, 30, 50 and 100 GB for US$0.50, US$1, US$3, US$5 and US$10. Matching older offers have been withdrawn. Existing purchases keep their recorded terms.${kept.length ? ` ${kept.map(row => row.offer.name).join(', ')} older offers had different terms and were kept for separate review.` : ''}`);
      }
    } catch (error) {
      if (current()) {
        const explanation = error instanceof CatalogueUpgradeError ? error.message : messageFor(error, 'The latest result could not be verified. Continue the update to check saved steps.');
        setMessage(`Pricing update paused. ${explanation} Confirmed changes remain saved.`);
        if ((error instanceof CatalogueUpgradeError && error.kind === 'actor_changed') || (error instanceof ApiError && [401, 403].includes(error.status))) { setLoaded(false); setProducts([]); setUsers([]); setStock([]); }
      }
    } finally {
      if (current()) { setBusy(false); setPricingRunning(false); setPricingProgress(''); pricingAbort.current = null; }
    }
  }
  async function publish(product: Product & { published: boolean }) {
    if (busy || publicationReason.trim().length < 10) { setMessage('Enter an audit reason of at least 10 characters before changing publication.'); return; }
    setBusy(true); setMessage('');
    try {
      await verify(); await api(`/api/admin/bundles/${encodeURIComponent(product.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ published: !product.published, reason: publicationReason.trim() }) });
      if (live.current) { setProducts(previous => previous.map(item => item.id === product.id ? { ...item, published: !product.published } : item)); setPublicationReason(''); setMessage(`Bundle ${product.id} is now ${product.published ? 'unpublished' : 'published'}. Existing purchase terms are unchanged.`); }
    } catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  async function audit(more = false) {
    if (busy) return; setBusy(true); setMessage('');
    try {
      await verify(); const result = await api<{ events: Audit[]; nextCursor: string | null }>(`/api/staff/audit${more && auditCursor ? `?after=${encodeURIComponent(auditCursor)}` : ''}`);
      if (live.current) { setEvents(previous => more ? [...previous, ...result.events] : result.events); setAuditCursor(result.nextCursor); }
    } catch (error) { if (live.current) setMessage(messageFor(error)); }
    finally { if (live.current) setBusy(false); }
  }
  return <div className="admin-workspace"><div className="workspace-section-head"><div><h3>Administration</h3><p>Approve staff, assign site access, and manage voucher stock with recorded reasons.</p></div><button className="secondary" disabled={busy} onClick={load}>Refresh administration</button></div>
    <div className="workspace-tabs" aria-label="Administration sections">{(['people', 'inventory', 'sites', 'catalogue', 'sales', 'cash', 'network', 'audit'] as const).map(value => <button key={value} disabled={pricingRunning} className={tab === value ? 'selected' : ''} aria-pressed={tab === value} onClick={() => { setTab(value); setMessage(''); if (value === 'audit') void audit(); }}>{value === 'people' ? 'Staff approvals' : value === 'inventory' ? 'Inventory' : value === 'sites' ? 'Sites' : value === 'catalogue' ? 'Bundle catalogue' : value === 'sales' ? 'Sales and delivery' : value === 'cash' ? 'Cash reconciliation' : value === 'network' ? 'Network reviews' : 'Audit history'}</button>)}</div>
    {tab === 'cash' && <><CashShifts staff={staff} selling={!!capabilities?.staffSales} /><CashRefunds staff={staff} /></>}
    {message && <p className="feedback" role="status">{message}</p>}{!loaded && !message && <p role="status">Loading administration…</p>}
    {loaded && unavailableSections.length > 0 && <section className="notice" role="alert"><p>{unavailableSections.map(section => sectionNames[section]).join(', ')} could not be loaded. Other administration sections remain available.</p><button className="secondary" disabled={busy} onClick={load}>Retry unavailable sections</button></section>}
    {loaded && tab === 'people' && !sectionErrors.people && <><AgentOnboarding /><div className="table-scroll"><table><thead><tr><th>Team member</th><th>Access</th><th>Authenticator</th><th>Review</th></tr></thead><tbody>{users.map(user => <tr key={user.staffId}><td><strong>{user.displayName}</strong><small>{user.email}</small></td><td>{user.status} · {user.role ?? 'unassigned'}<small>{user.role === 'admin' ? 'All sites' : `${user.siteIds.length} assigned sites`}</small></td><td>{user.mfaEnrolled ? 'Configured' : 'Setup needed'}</td><td><button className="secondary" disabled={busy || user.staffId === staff.staffId} onClick={() => selectUser(user)}>{user.staffId === staff.staffId ? 'Your account' : 'Review access'}</button></td></tr>)}</tbody></table></div>{cursor && <button className="secondary" disabled={busy} onClick={moreUsers}>Load more staff</button>}
      {selected && <section className="workspace-card"><h3>Review {selected.displayName}</h3><p>{selected.email} · Record version {selected.version}</p><form className="form-grid" onSubmit={decide}><fieldset disabled={busy}><label>Decision<select value={decision} onChange={event => setDecision(event.target.value as typeof decision)}><option value="approved">Approve or update access</option><option value="rejected">Reject application</option><option value="disabled">Disable access</option><option value="revoke_sessions">Revoke existing sessions only</option><option value="recover_mfa">Recover a lost authenticator</option></select></label>
        {decision === 'approved' && <><label>Role<select value={role} onChange={event => { setRole(event.target.value as typeof role); setAdminConfirmed(false); }}><option value="agent">Agent · assigned-site sales</option><option value="support">Support · assigned-site help</option><option value="admin">Administrator · all sites</option></select></label>{role !== 'admin' ? <div className="site-checkboxes"><strong>Assigned sites</strong>{sectionErrors.sites ? <p className="notice">Sites could not be loaded. Refresh administration before approving a site-based role.</p> : sites.length === 0 && <p>Create a site before assigning this role.</p>}{sites.map(site => <label className="check-label" key={site.id}><input type="checkbox" checked={assigned.includes(site.id)} onChange={event => setAssigned(previous => event.target.checked ? [...previous, site.id] : previous.filter(id => id !== site.id))} />{site.name}{site.enabled === false ? ' · sales location paused' : ''}</label>)}</div> : <label className="check-label"><input type="checkbox" required checked={adminConfirmed} onChange={event => setAdminConfirmed(event.target.checked)} />I intend to grant administrator access to all sites and staff controls.</label>}{!selected.mfaEnrolled && <p className="notice">This person must complete authenticator setup before approval.</p>}</>}
        {decision === 'recover_mfa' && <div className="notice"><p>Verify this person’s identity through your approved independent process first. This revokes their sessions and site access. They must sign in with their existing password, enroll a new authenticator, and receive administrator approval again. An administrator cannot recover their own authenticator.</p><label className="check-label"><input type="checkbox" checked={recoveryConfirmed} onChange={event => setRecoveryConfirmed(event.target.checked)} />I verified this person’s identity and intend to revoke access for authenticator recovery.</label></div>}
        <label>Reason<textarea required minLength={5} maxLength={500} rows={3} value={reason} onChange={event => setReason(event.target.value)} /></label></fieldset><button className="primary" disabled={busy || (decision === 'recover_mfa' && (!recoveryConfirmed || !selected.mfaEnrolled || !['pending', 'approved'].includes(selected.status))) || (decision === 'approved' && (!selected.mfaEnrolled || (role !== 'admin' && (assigned.length === 0 || !!sectionErrors.sites)) || (role === 'admin' && !adminConfirmed)))}>Save staff decision</button><button type="button" className="secondary" disabled={busy} onClick={() => setSelectedId('')}>Cancel review</button></form></section>}
    </>}
    {loaded && tab === 'inventory' && unavailableSections.length === 0 && <div className="workspace-columns"><section className="workspace-card"><h3>Allocate bundle stock</h3><p>{capabilities?.demo ? 'Demo inventory is for verification only.' : 'Allocation changes what an agent is authorized to sell. It does not record payment from a customer.'}</p>{!capabilities?.staffSales && <p className="notice">Customer sales are paused. {canAllocate ? 'You can allocate stock to approved agents at active sales locations without collecting cash or issuing vouchers.' : 'Stock allocation is unavailable; sites, staff access and draft bundles can still be prepared.'}</p>}<form className="form-grid" onSubmit={allocate}><fieldset disabled={busy || pendingAllocation || !canAllocate}>
      <label>Agent<select required value={agentId} onChange={event => { setAgentId(event.target.value); setSiteId(''); }}><option value="">Choose an approved agent</option>{agents.map(agent => <option key={agent.staffId} value={agent.staffId}>{agent.displayName} · {agent.email}</option>)}</select></label>
      <label>Site<select required value={siteId} onChange={event => setSiteId(event.target.value)}><option value="">Choose an assigned site</option>{sites.filter(site => site.enabled !== false && users.find(user => user.staffId === agentId)?.siteIds.includes(site.id)).map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
      <label>Bundle<select required value={bundleId} onChange={event => setBundleId(event.target.value)}><option value="">Choose a bundle</option>{products.filter(product => product.published).map(product => <option value={product.id} key={product.id}>{product.id.toUpperCase()} · {money(product.price_minor, product.currency)}</option>)}</select></label>
      <label>Quantity<input type="number" required min={1} max={10000} step={1} value={quantity} onChange={event => setQuantity(event.target.value)} /></label><label>Reason<textarea required minLength={10} maxLength={500} rows={3} value={allocationReason} onChange={event => setAllocationReason(event.target.value)} /></label>
    </fieldset><button className="primary" disabled={busy || !canAllocate || (!pendingAllocation && (!agentId || !siteId || !bundleId))}>{pendingAllocation ? 'Retry saved allocation safely' : 'Allocate inventory'}</button></form>{cursor && <button className="secondary" disabled={busy} onClick={moreUsers}>Load more staff for agent selection</button>}</section><section className="workspace-card"><h3>Inventory by site</h3>{stock.length === 0 ? <p>No stock allocated yet.</p> : <ul className="inventory-list">{stock.map(item => <li key={`${item.agentId}:${item.siteId}:${item.bundleId}`}><div><strong>{item.siteName} · {item.bundleId.toUpperCase()}</strong><span>{users.find(user => user.staffId === item.agentId)?.displayName ?? item.agentId}</span></div><strong>{item.quantity}</strong></li>)}</ul>}</section></div>}
    {loaded && tab === 'sites' && !sectionErrors.sites && <div className="workspace-columns"><section className="workspace-card"><h3>Sites</h3>{sites.length === 0 ? <p>No sites configured.</p> : <ul className="inventory-list">{sites.map(site => <li key={site.id}><div><strong>{site.name}</strong><small>{site.id}</small></div></li>)}</ul>}</section><section className="workspace-card"><h3>Add a site</h3><p>A site record allows staff and inventory assignment. Router configuration and verified network setup are separate.</p><form className="form-grid" onSubmit={createSite}><label>Site name<input required minLength={2} maxLength={100} value={siteName} onChange={event => setSiteName(event.target.value)} /></label><button className="primary" disabled={busy}>Create site</button></form></section></div>}
    {loaded && tab === 'catalogue' && !sectionErrors.catalogue && <><section className="workspace-card" aria-labelledby="revised-pricing-heading"><h3 id="revised-pricing-heading">Revised pricing · 100 GB for US$10</h3><p>Publish these five revised offers, then withdraw the matching older offers. Existing purchases retain their original allowance and validity.</p><div className="table-scroll"><table aria-label="Revised bundle pricing"><thead><tr><th>Bundle</th><th>Price</th><th>Data</th><th>Validity</th><th>Update</th></tr></thead><tbody>{pricing.rows.map(row => <tr key={row.offer.id}><td>{row.offer.name}</td><td>{money(row.offer.priceMinor, 'USD')}</td><td>{row.legacyMatches && row.legacy?.published ? `${Number(row.offer.legacyBytes) / 1e9} → ` : ''}{Number(row.offer.bytes) / 1e9} GB</td><td>{row.offer.seconds / 86400} days</td><td>{row.conflict ? 'Version needs review' : row.published ? 'Published' : row.ready ? 'Draft saved' : 'Ready to add'}</td></tr>)}</tbody></table></div>{pricing.preservedLegacy.length > 0 && <p className="notice">Older offers with different terms will be kept for separate review: {pricing.preservedLegacy.map(row => row.offer.name).join(', ')}.</p>}{pricing.conflicts.length > 0 && <p className="notice" role="alert">A replacement version has different terms. Review {pricing.conflicts.map(row => row.offer.name).join(', ')} in the catalogue before applying this update.</p>}{!cashCurrencies.includes('USD') && <p className="notice">USD must be an approved catalogue currency before this update can run.</p>}{publicationGuardVersion !== 1 && <p className="notice" role="status">Pricing update requires the service update.</p>}<p>{pricing.complete ? 'The revised offers and matching older-offer withdrawals are confirmed.' : `${pricing.prepared} of 5 revised offers saved · ${pricing.published} published · ${pricing.pendingWithdrawals.length} matching older offers to withdraw.`}</p><button className="primary" disabled={busy || publicationGuardVersion !== 1 || pricing.complete || pricing.conflicts.length > 0 || !cashCurrencies.includes('USD')} onClick={applyRevisedPricing}>{pricingRunning ? 'Updating pricing…' : pricing.complete ? 'Revised pricing is published' : pricing.prepared ? 'Continue pricing update' : 'Publish revised bundles'}</button>{pricingProgress && <p role="status">{pricingProgress}</p>}</section><section className="workspace-card"><h3>Bundle versions</h3><p>Currencies are configured by the operator. Purchased terms are immutable; create a new version ID to change price, data, or validity.</p><label className="form-grid">Publication reason<textarea minLength={10} maxLength={500} rows={2} value={publicationReason} onChange={event => setPublicationReason(event.target.value)} placeholder="Why should this offer be published or withdrawn?" aria-describedby="publication-reason-hint" /></label><p id="publication-reason-hint">Enter a reason of at least 10 characters to enable the publication buttons.</p><div className="table-scroll"><table><thead><tr><th>Bundle</th><th>Price</th><th>Data / validity</th><th>Publication</th></tr></thead><tbody>{products.map(product => <tr key={product.id}><td>{product.id}</td><td>{money(product.price_minor, product.currency)}</td><td>{Number(product.byte_limit) / 1e9} GB · {product.validity_seconds / 86400} days</td><td><button className="secondary" disabled={busy || publicationReason.trim().length < 10} onClick={() => publish(product)}>{product.published ? 'Unpublish bundle' : 'Publish reviewed bundle'}</button></td></tr>)}</tbody></table></div></section><section className="workspace-card"><h3>Create a draft bundle version</h3><form className="form-grid" onSubmit={createBundle}><fieldset disabled={busy}><label>Unique version ID<input required pattern="[a-z][a-z0-9-]{0,39}" maxLength={40} value={newBundleId} onChange={event => setNewBundleId(event.target.value.toLowerCase())} placeholder="week-v2" /></label><label>Currency<select required value={newCurrency} onChange={event => setNewCurrency(event.target.value)}><option value="">No configured currency</option>{cashCurrencies.map(currency => <option key={currency} value={currency}>{currency}</option>)}</select></label><label>Price<input required inputMode="decimal" value={newPrice} onChange={event => setNewPrice(event.target.value)} /></label><label>Data allowance in GB<input required inputMode="decimal" value={newData} onChange={event => setNewData(event.target.value)} /></label><label>Validity in days<input required type="number" min={1} step={1} value={newDays} onChange={event => setNewDays(event.target.value)} /></label><label>Reason<textarea required minLength={10} maxLength={500} rows={3} value={catalogueReason} onChange={event => setCatalogueReason(event.target.value)} /></label></fieldset><button className="primary" disabled={busy || !newCurrency}>Save draft bundle</button></form></section></>}
    {tab === 'sales' && <SalesHistory staff={staff} deliveryEnabled={!!capabilities?.deliverySms} users={users} />}
    {tab === 'network' && <NetworkReviews staff={staff} />}
    {tab === 'audit' && <section className="workspace-card"><div className="workspace-section-head"><h3>Staff access decisions</h3><button className="secondary" disabled={busy} onClick={() => audit()}>Refresh audit history</button></div>{events.length === 0 ? <p>No access decisions are shown.</p> : <ol className="audit-list">{events.map(event => <li key={event.id}><strong>{event.action.replace(/_/g, ' ')} · {localDate(event.createdAt)}</strong><p>{event.reason}</p><small>Account: {users.find(user => user.staffId === event.targetStaffId)?.email ?? event.targetStaffId} · Version {event.newVersion}</small></li>)}</ol>}{auditCursor && <button className="secondary" disabled={busy} onClick={() => audit(true)}>Load older audit entries</button>}</section>}
  </div>;
}
