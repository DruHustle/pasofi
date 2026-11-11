import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InvoiceLink } from './InvoiceActions';
import type { Capabilities, Product } from './business';
import type { CustomerTab } from './CustomerAccess';
import { api } from './api';
import { currentSession, onSessionChange } from './session';
import Icon, { type IconName } from './Icon';
import BundleCatalogue from './BundleCatalogue';
import Home from './Home';
import ScreenBoundary from './ScreenBoundary';
import Policies, { PolicyNotice } from './Policies';
import { withPolicyHelp, type HelpArticle as Article } from './PolicyHelp';
import './style.css';
import './premium.css';
import './home.css';

const DemoPurchase = lazy(() => import('./DemoPurchase'));
const Recovery = lazy(() => import('./Recovery'));
const StaffWorkspace = lazy(() => import('./StaffWorkspace'));
const CustomerAccess = lazy(() => import('./CustomerAccess'));
const Handoff = lazy(() => import('./Handoff'));
type View = 'home' | 'bundles' | 'help' | 'history' | 'account' | 'wifi' | 'voucher' | 'connect' | 'checkout' | 'receipt' | 'staff' | 'handoff' | 'terms' | 'privacy';
const customerViews: Partial<Record<View, CustomerTab>> = { history: 'history', account: 'recovery', wifi: 'wifi', voucher: 'voucher', checkout: 'purchase', receipt: 'receipt' };
const customerView: Record<CustomerTab, View> = { access: 'home', history: 'history', recovery: 'account', wifi: 'wifi', voucher: 'voucher', receipt: 'receipt', purchase: 'checkout' };
function workspaceFor(next: View) { return next === 'staff' || next === 'handoff' ? next : customerViews[next] ? 'customer' : null; }
const views: View[] = ['home', 'bundles', 'help', 'history', 'account', 'wifi', 'voucher', 'connect', 'checkout', 'receipt', 'staff', 'handoff', 'terms', 'privacy'];
const navItems: { view: View; label: string; icon: IconName }[] = [
  { view: 'home', label: 'Home', icon: 'home' }, { view: 'bundles', label: 'Bundles', icon: 'grid' },
  { view: 'history', label: 'History', icon: 'history' }, { view: 'account', label: 'Account', icon: 'user' },
];
function locationView(): View {
  const hash = location.hash.slice(1).split('?')[0];
  if (views.includes(hash as View)) return hash as View;
  return location.pathname === '/connect' ? 'connect' : location.pathname === '/handoff' ? 'handoff' : 'home';
}
function locationBundleId() {
  if (!['checkout', 'receipt'].includes(locationView())) return null;
  const id = new URLSearchParams(location.hash.split('?')[1] ?? '').get('bundle');
  return id && /^[a-z][a-z0-9-]{0,39}$/.test(id) ? id : null;
}
const validBundle = (value: Product) => value && typeof value.id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value.id) && Number.isInteger(value.price_minor) && value.price_minor > 0 && typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency) && typeof value.byte_limit === 'string' && /^[1-9][0-9]{0,29}$/.test(value.byte_limit) && Number.isInteger(value.validity_seconds) && value.validity_seconds > 0;

function App() {
  const [view, setView] = useState<View>(locationView);
  const [bundles, setBundles] = useState<Product[] | null>(null), [articles, setArticles] = useState<Article[] | null>(null);
  const [catalogueError, setCatalogueError] = useState(false), [helpError, setHelpError] = useState(false);
  const [catalogueAttempt, setCatalogueAttempt] = useState(0), [helpAttempt, setHelpAttempt] = useState(0), [capabilityAttempt, setCapabilityAttempt] = useState(0);
  const [demoEnabled, setDemoEnabled] = useState(false), [helpQuery, setHelpQuery] = useState('');
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null), [capabilitiesError, setCapabilitiesError] = useState(false);
  const [workspace, setWorkspace] = useState<'customer' | 'staff' | 'handoff' | null>(() => workspaceFor(locationView()));
  const [customerTab, setCustomerTab] = useState<CustomerTab>(() => customerViews[locationView()] ?? 'access');
  const [checkoutBundle, setCheckoutBundle] = useState<Product | null>(null);
  const [requestedBundleId, setRequestedBundleId] = useState<string | null>(locationBundleId);
  const [purchase, setPurchase] = useState<Product | 'access' | 'recovery' | null>(null);
  const [notice, setNotice] = useState(''), [offline, setOffline] = useState(!navigator.onLine);
  const opener = useRef<HTMLButtonElement | null>(null), content = useRef<HTMLElement>(null), interactions = useRef(0);
  const recoveryTarget = useRef<'demo' | 'customer'>('demo'), allowHomeRestore = useRef(true);
  const catalogueGeneration = useRef(0), capabilityGeneration = useRef(0);

  useEffect(() => {
    const revision = ++catalogueGeneration.current, controller = new AbortController();
    const current = () => !controller.signal.aborted && catalogueGeneration.current === revision;
    setCatalogueError(false); setBundles(null); setDemoEnabled(false);
    api<{ products: Product[]; candidate: boolean }>('/api/bundles', { signal: controller.signal }).then(data => {
      if (!Array.isArray(data.products) || !data.products.every(validBundle)) throw Error('invalid_catalogue');
      if (current()) { setBundles(data.products); setDemoEnabled(data.candidate === true); }
    }).catch(() => { if (current()) setCatalogueError(true); });
    return () => controller.abort();
  }, [catalogueAttempt]);
  useEffect(() => {
    const controller = new AbortController(); setHelpError(false); setArticles(null);
    api<{ articles: Article[] }>('/api/help', { signal: controller.signal }).then(data => {
      if (!Array.isArray(data.articles) || !data.articles.every(item => typeof item.question === 'string' && typeof item.answer === 'string')) throw Error('invalid_help');
      if (!controller.signal.aborted) setArticles(data.articles);
    }).catch(() => { if (!controller.signal.aborted) setHelpError(true); });
    return () => controller.abort();
  }, [helpAttempt]);
  useEffect(() => {
    const revision = ++capabilityGeneration.current, controller = new AbortController();
    const current = () => !controller.signal.aborted && capabilityGeneration.current === revision;
    setCapabilitiesError(false); setCapabilities(null);
    api<Capabilities>('/api/capabilities', { signal: controller.signal }).then(value => {
      if (current()) { if (typeof value.demo === 'boolean') setCapabilities(value); else setCapabilitiesError(true); }
    }).catch(() => { if (current()) setCapabilitiesError(true); });
    return () => controller.abort();
  }, [capabilityAttempt]);
  useEffect(() => {
    // A read-only session check restores a returning customer's dashboard. Browsing
    // never creates an account, and a late result cannot override a user action.
    if (!allowHomeRestore.current || capabilities?.demo !== false || view !== 'home' || workspace || purchase) return;
    let active = true; const revision = interactions.current;
    currentSession().then(() => { if (active && interactions.current === revision) { setCustomerTab('access'); setWorkspace('customer'); } }).catch(() => {});
    return () => { active = false; };
  }, [capabilities?.demo, view]);
  useEffect(() => onSessionChange(change => {
    ++interactions.current; allowHomeRestore.current = false; setPurchase(null); setWorkspace(null); setCheckoutBundle(null); setRequestedBundleId(null);
    history.replaceState(null, '', `${location.pathname === '/handoff' || location.pathname === '/connect' ? '/' : location.pathname}#home`); setView('home'); setCustomerTab('access');
    setNotice(change === 'signed_out' ? 'Signed out in another tab. Account details have been cleared from this view.' : 'Your account changed in another tab. Reopen your account tools to load the current account.');
  }), []);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine); addEventListener('online', update); addEventListener('offline', update);
    return () => { removeEventListener('online', update); removeEventListener('offline', update); };
  }, []);
  useEffect(() => {
    const sync = () => {
      ++interactions.current; const next = locationView(); setView(next); setPurchase(null); setCheckoutBundle(null);
      setWorkspace(workspaceFor(next)); setRequestedBundleId(locationBundleId());
      setCustomerTab(customerViews[next] ?? 'access');
    };
    addEventListener('popstate', sync); addEventListener('hashchange', sync);
    return () => { removeEventListener('popstate', sync); removeEventListener('hashchange', sync); };
  }, []);
  function setLocation(next: View, bundleId?: string | null, replace = false) {
    const selected = (next === 'checkout' || next === 'receipt') && bundleId && /^[a-z][a-z0-9-]{0,39}$/.test(bundleId) ? bundleId : null;
    const path = next === 'connect' ? '/connect' : `${location.pathname === '/connect' || location.pathname === '/handoff' ? '/' : location.pathname}#${next}${selected ? `?bundle=${encodeURIComponent(selected)}` : ''}`;
    setRequestedBundleId(selected);
    if (`${location.pathname}${location.hash}` !== path) history[replace ? 'replaceState' : 'pushState'](null, '', path);
    setView(next);
  }
  function focusScreen() {
    requestAnimationFrame(() => { window.scrollTo({ top: 0, behavior: 'auto' }); content.current?.querySelector<HTMLElement>('h1, h2')?.focus({ preventScroll: true }); });
  }
  function refreshCatalogue() {
    // Invalidate before the next effect so a previous response cannot win a refresh.
    ++catalogueGeneration.current; setCatalogueAttempt(value => value + 1);
  }
  function refreshCapabilities() {
    ++capabilityGeneration.current; setCapabilityAttempt(value => value + 1);
  }
  function refreshAvailability() {
    document.getElementById('catalogue-heading')?.focus({ preventScroll: true });
    refreshCatalogue(); refreshCapabilities();
  }
  function navigate(next: View, button?: HTMLButtonElement) {
    allowHomeRestore.current = true; ++interactions.current; if (button) opener.current = button; setPurchase(null); setNotice(''); setCheckoutBundle(null); setLocation(next);
    setCustomerTab(customerViews[next] ?? 'access'); setWorkspace(workspaceFor(next) ?? (next === 'home' && workspace === 'customer' ? 'customer' : null));
    if (next === 'bundles') refreshAvailability();
    focusScreen();
  }
  function openCustomer(tab: CustomerTab = 'access', button?: HTMLButtonElement, bundle: Product | null = null) {
    ++interactions.current; if (button) opener.current = button; setNotice(''); setPurchase(null); setCheckoutBundle(bundle); setCustomerTab(tab); setWorkspace('customer');
    setLocation(customerView[tab], bundle?.id); focusScreen();
  }
  function openUtility(next: 'staff' | 'handoff', button: HTMLButtonElement) {
    ++interactions.current; opener.current = button; setNotice(''); setPurchase(null); setCheckoutBundle(null); setWorkspace(next); setLocation(next); focusScreen();
  }
  function closeWorkspace() {
    ++interactions.current; setPurchase(null); setWorkspace(null); setCheckoutBundle(null);
    if (customerViews[view] || view === 'staff' || view === 'handoff') setLocation('home');
    requestAnimationFrame(() => { if (opener.current?.isConnected) opener.current.focus(); else focusScreen(); });
  }
  function openDemo(next: Product | 'access', button: HTMLButtonElement) {
    ++interactions.current; opener.current = button; setNotice(''); setWorkspace(null); recoveryTarget.current = 'demo'; setPurchase(next); focusScreen();
  }
  function openRecovery(button?: HTMLButtonElement, target: 'demo' | 'customer' = demoEnabled ? 'demo' : 'customer') {
    ++interactions.current; if (button) opener.current = button; recoveryTarget.current = target; setWorkspace(null); setPurchase('recovery'); focusScreen();
  }
  const chooseBundle = (bundle: Product, button: HTMLButtonElement) => demoEnabled ? openDemo(bundle, button) : openCustomer(capabilities?.staffSales && capabilities?.receiptPairing ? 'receipt' : 'purchase', button, bundle);
  const customerNavigate = (tab: CustomerTab, bundleId?: string) => {
    setCustomerTab(tab); if (bundleId !== undefined) setCheckoutBundle(null);
    setLocation(customerView[tab], bundleId ?? checkoutBundle?.id ?? requestedBundleId, customerTab === tab);
  };
  const visibleArticles = withPolicyHelp(articles ?? []).filter(article => helpQuery.trim().toLocaleLowerCase().split(/\s+/).every(word => `${article.question} ${article.answer}`.toLocaleLowerCase().includes(word)));
  const activeNav: View = view === 'wifi' || view === 'voucher' ? 'home' : view === 'receipt' || view === 'checkout' ? 'bundles' : view;
  const showWelcome = !workspace && !purchase && (view === 'home' || view === 'connect');
  const showCatalogue = !workspace && !purchase && (view === 'home' || view === 'bundles' || view === 'connect');
  const serviceLabel = capabilities === null ? capabilitiesError ? 'SERVICE STATUS UNAVAILABLE' : 'CHECKING SERVICE STATUS' : capabilities.demo ? 'DEMONSTRATION' : capabilities.staffSales || capabilities.paymentCheckout || capabilities.networkAccess ? 'PASOFI CUSTOMER SERVICE' : 'SERVICE IN PREPARATION';
  const serviceDetail = capabilities === null ? 'Please check back for current availability' : capabilities.demo ? 'Candidate bundles · purchases and connections are not yet available' : capabilities.staffSales || capabilities.paymentCheckout || capabilities.networkAccess ? 'Your account shows confirmed purchases and connection status' : 'Purchases and connections are not yet available';

  return <div className="pf-app">
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); content.current?.focus(); content.current?.scrollIntoView({ block: 'start', behavior: 'auto' }); }}>Skip to main content</a>
    <header className="pf-header"><a className="pf-brand" href="#home" onClick={event => { event.preventDefault(); navigate('home'); }} aria-label="Pasofi home" aria-describedby="pasofi-product-family"><span className="pf-brand-mark"><Icon name="wifi"/></span><span>Pasofi<small id="pasofi-product-family">An Onesa Mobile product</small></span></a><span className="pf-header-tagline">A little connection. More possibility.</span><div className="pf-header-actions"><button className="pf-icon-button" onClick={() => navigate('help')} aria-label="Help"><Icon name="help"/><span>Help</span></button><button className="pf-avatar-button" disabled={!capabilities} onClick={event => openCustomer('access', event.currentTarget)} aria-label="Customer tools"><Icon name="user"/></button></div></header>
    <nav className="pf-navigation" aria-label="Main navigation"><span className="pf-nav-title">YOUR PASOFI</span>{navItems.map(item => <button key={item.view} aria-current={activeNav === item.view ? 'page' : undefined} onClick={event => navigate(item.view, event.currentTarget)}><span className="pf-nav-icon"><Icon name={item.icon}/></span><span>{item.label}</span>{activeNav === item.view && <span className="pf-nav-dot"/>}</button>)}<div className="pf-nav-note"><Icon name="shield"/><strong>Connection on your terms.</strong><span>No subscriptions.<br/>Just the data you need.</span></div></nav>
    <main id="main-content" className={`pf-main ${view === 'connect' ? 'pf-captive' : view === 'home' ? 'pf-home' : ''}`} ref={content} tabIndex={-1}>
      {offline && <div className="connection-notice" role="status">You appear to be offline. Reconnect before checking an order or recovering access.</div>}
      {notice && <div className="connection-notice" role="status">{notice}</div>}
      <div className="demo pf-service-status" data-status={capabilitiesError ? 'unavailable' : !capabilities ? 'checking' : capabilities.demo ? 'demo' : capabilities.staffSales || capabilities.paymentCheckout || capabilities.networkAccess ? 'available' : 'preparation'}><span className="pf-status-dot"/><span><strong>{serviceLabel}</strong><span className="pf-service-detail">{serviceDetail}</span></span>{capabilitiesError && <button onClick={refreshCapabilities}>Retry service status</button>}</div>
      <ScreenBoundary screen={`${view}:${workspace ?? ''}:${purchase === 'recovery' ? 'recovery' : purchase ? 'purchase' : ''}:${catalogueAttempt}`} onBrowse={() => navigate('bundles')}>
      {showWelcome && view === 'connect' && <>
        <div className="pf-page-intro"><div><span className="pf-eyebrow">WELCOME TO YOUR HOTSPOT</span><h1 tabIndex={-1}>Connect to Pasofi</h1><p>Check bundle prices and voucher availability at this hotspot.</p></div></div>
        {view === 'connect' && <section className="pf-quick-actions" aria-label="Quick actions">{([
          { label: 'View bundles', icon: 'plus' as IconName, action: (b: HTMLButtonElement) => navigate('bundles', b), disabled: false },
          { label: 'Redeem voucher', icon: 'ticket' as IconName, action: (b: HTMLButtonElement) => openCustomer('voucher', b), disabled: !capabilities },
          { label: 'My WiFi', icon: 'wifi' as IconName, action: (b: HTMLButtonElement) => openCustomer('wifi', b), disabled: !capabilities },
          { label: 'Get help', icon: 'help' as IconName, action: (b: HTMLButtonElement) => navigate('help', b), disabled: false },
        ]).map(action => <button key={action.label} disabled={action.disabled} onClick={event => action.action(event.currentTarget)}><span><Icon name={action.icon}/></span><strong>{action.label}</strong></button>)}</section>}
      </>}
      {purchase && <Suspense fallback={<div className="pf-empty" role="status">Loading your account tools…</div>}>{purchase === 'recovery' ? <Recovery close={closeWorkspace} recovered={() => { setPurchase(null); if (recoveryTarget.current === 'customer' && capabilities) openCustomer(); else setPurchase('access'); }}/>: <DemoPurchase key={purchase === 'access' ? 'access' : purchase.id} bundle={purchase === 'access' ? null : purchase} close={closeWorkspace} signedOut={() => { closeWorkspace(); setNotice('Signed out of this device. Use Recover to return to your saved demo account.'); }}/>}</Suspense>}
      {workspace && <Suspense fallback={<div className="pf-workspace-loading" role="status"><span/><span/><span/>Loading your workspace…</div>}>{workspace === 'staff' ? <StaffWorkspace close={closeWorkspace} capabilities={capabilities}/> : workspace === 'handoff' ? <Handoff close={closeWorkspace} recovered={() => { if (capabilities) openCustomer(); else { setWorkspace(null); setPurchase('access'); } }}/> : capabilities ? <CustomerAccess close={closeWorkspace} capabilities={capabilities} selectedBundle={checkoutBundle} requestedBundleId={requestedBundleId} initialTab={customerTab} onNavigate={customerNavigate} onBuyData={() => navigate('bundles')} recovered={() => openRecovery(undefined, 'customer')}/> : <div className="pf-empty" role="status"><h2 tabIndex={-1}>Let’s check your service.</h2><p>{capabilitiesError ? 'Account tools are temporarily unavailable. Please retry the service status.' : 'Checking which account features are available…'}</p>{capabilitiesError && <button className="pf-button pf-button-secondary" onClick={refreshCapabilities}>Retry account connection</button>}</div>}</Suspense>}
      {showCatalogue && (view === 'home' ? <Home capabilities={capabilities} onInteract={() => { allowHomeRestore.current = false; ++interactions.current; }} browse={button => navigate('bundles', button)} account={openCustomer} help={button => navigate('help', button)} recover={openRecovery}><BundleCatalogue compact bundles={bundles} demo={demoEnabled} capabilities={capabilities} error={catalogueError} retry={refreshCatalogue} refreshAvailability={refreshAvailability} choose={chooseBundle} help={() => navigate('help')}/></Home>
        : <BundleCatalogue compact={view !== 'bundles'} headingLevel={view === 'bundles' ? 1 : 2} bundles={bundles} demo={demoEnabled} capabilities={capabilities} error={catalogueError} retry={refreshCatalogue} refreshAvailability={refreshAvailability} choose={chooseBundle} help={() => navigate('help')}/>)}
      {!workspace && !purchase && view === 'help' && <section className="pf-help" aria-labelledby="help-heading"><div className="pf-page-intro"><div><span className="pf-eyebrow">A LITTLE GUIDANCE</span><h1 id="help-heading" tabIndex={-1}>Here to help.</h1><p>Quick answers. More time for your day.</p></div><span className="pf-help-illustration"><Icon name="help"/></span></div><div className="pf-help-layout"><div className="pf-help-main"><label className="pf-search" htmlFor="help-query"><Icon name="search"/><span className="pf-sr-only">Find a quick answer</span><input id="help-query" type="search" maxLength={160} placeholder="Search data, vouchers or recovery" value={helpQuery} onChange={event => setHelpQuery(event.target.value)}/></label><p className="pf-private-note">Search reviewed answers. Never enter a voucher, password or recovery key here.</p><div className="pf-faq">{helpError && <div className="pf-empty"><p role="status">Help is temporarily unavailable.</p><p>Policy answers are available below.</p><button className="pf-button pf-button-secondary" onClick={() => setHelpAttempt(value => value + 1)}>Retry help</button></div>}{!helpError && articles === null && <p role="status">Loading more help…</p>}{visibleArticles.length === 0 ? <p className="pf-empty" role="status">No reviewed answer matches that search. Try a shorter phrase or clear the search to see all answers.</p> : visibleArticles.map(a => <details key={a.question}><summary>{a.question}<Icon name="plus"/></summary><p>{a.answer}</p></details>)}</div></div><aside className="pf-support-card"><span className="pf-empty-icon"><Icon name="shield"/></span><h2>Your account, in your hands.</h2><p>Call customer support on <a href="tel:+263715092221">+263 715 092 221</a>. Keep recovery details and voucher codes private.</p><p>Keep your recovery key somewhere safe. You can use it to restore access on another device.</p><button className="pf-button pf-button-secondary" onClick={event => openRecovery(event.currentTarget)}>Recover my account <Icon name="arrow"/></button><p className="pf-private-note">For a cash-sale query, ask the agent at your Pasofi location to review your receipt.</p><PolicyNotice/></aside></div></section>}
      {!workspace && !purchase && (view === 'terms' || view === 'privacy') && <Policies kind={view}/>}
      {showCatalogue && <section className="pf-help-banner"><span className="pf-empty-icon"><Icon name="help"/></span><div><h2>A little help goes a long way.</h2><p>From your first voucher to your next connection.</p></div><button className="pf-text-link" onClick={() => navigate('help')}>Explore help <Icon name="arrow"/></button></section>}
      </ScreenBoundary>
      <footer className="pf-footer"><div><strong>Pasofi</strong><p>An Onesa Mobile product</p></div><div className="pf-footer-tools"><button onClick={event => openRecovery(event.currentTarget)}>Recover</button><button onClick={event => openUtility('staff', event.currentTarget)}>Staff</button><button onClick={event => openUtility('handoff', event.currentTarget)}>Accept handoff</button>{demoEnabled && <button onClick={event => openDemo('access', event.currentTarget)}>My demo access</button>}<a href="#terms" onClick={event => { event.preventDefault(); navigate('terms'); }}>Service terms</a><a href="#privacy" onClick={event => { event.preventDefault(); navigate('privacy'); }}>Privacy</a><a href="/connect" onClick={event => { event.preventDefault(); navigate('connect'); }}>Hotspot welcome</a></div></footer>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><InvoiceLink/><App/></React.StrictMode>);
