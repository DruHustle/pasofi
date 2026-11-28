import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import { pendingNativeDestination } from './native-oidc';
import { api, mobileApiConfigured, usesNativeCustomerApi } from './api';
import type { Capabilities, Product } from './business';
import MobileCatalogue from './MobileCatalogue';
import Icon, { type IconName } from './Icon';
import type { CustomerTab } from './CustomerAccess';
import RegistrationLink, {AccountClosureLink, watchRegistrationReturn} from './RegistrationLink';
import MobileCustomer from './MobileCustomer';
import { PolicyNotice } from './Policies';
import { policyHelpArticles } from './PolicyHelp';
import { onAccountHandoffReturn } from './native-api';
import '@fontsource-variable/plus-jakarta-sans';
import './mobile.css';
import './mobile-web.css';

type Tab = 'home' | 'bundles' | 'history' | 'account' | 'help';
// Illustrative offers for the unconfigured preview only; configured builds show
// the live published catalogue, exactly like the website.
const examples: Product[] = ([['mini', 50, 2, 3], ['flex', 100, 5, 7], ['week', 300, 20, 7], ['fortnight', 500, 35, 14], ['month', 1000, 75, 30]] as const)
  .map(([id, price, gb, days]) => ({ id, price_minor: price, currency: 'USD', byte_limit: String(gb * 1_000_000_000), validity_seconds: days * 86400 }));
const validBundle = (value: Product) => value && typeof value.id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value.id) && Number.isInteger(value.price_minor) && value.price_minor > 0 && typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency) && typeof value.byte_limit === 'string' && /^[1-9][0-9]{0,29}$/.test(value.byte_limit) && Number.isInteger(value.validity_seconds) && value.validity_seconds > 0;
const questions = [
  ...policyHelpArticles.map(article => ({ q: article.question, a: article.answer })),
  { q: 'Can I buy a bundle in this app?', a: mobileApiConfigured ? 'Yes, when purchases are open. Choose a bundle and My PasoFi shows the ways to pay that the service currently offers.' : 'Not yet. This is an offline preview. Payments and Wi-Fi connections are not available.' },
  { q: 'Does my data include uploads?', a: 'Both uploads and downloads count toward the published allowance, including background updates.' },
  { q: 'How will I use a voucher?', a: 'When the service is available, you can enter your private voucher in your account. Redeeming adds a bundle; a hotspot must confirm your connection before you have internet access.' },
  { q: 'Can I use more than one device?', a: 'The service is designed for one active device per customer. Supported device access depends on the configured service.' },
];
const navigation: { id: Exclude<Tab, 'help'>; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'bundles', label: 'Bundles', icon: 'bundles' },
  { id: 'history', label: 'History', icon: 'history' },
  { id: 'account', label: 'Account', icon: 'account' },
];

// A WebView must always offer a safe way back if a native account component
// throws during render, hydration or a provider/session error. Never fall back
// to an unqualified checkout, demo account, or network grant.
class AccountRenderBoundary extends Component<{ close: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="mobile-customer mobile-account-unavailable" role="status">
      <div className="mobile-account-links">
        <p className="mobile-account-brand"><strong>PasoFi</strong> An Onesa Mobile product</p>
        <button type="button" onClick={this.props.close}>← Back to PasoFi</button>
      </div>
      <div className="mobile-notice">
        <p>Mobile account access is not enabled by this deployment yet. You can still browse bundles and help.</p>
      </div>
    </section>;
  }
}

export default function MobileApp() {
  const [tab, setTab] = useState<Tab>('home');
  const [pending] = useState(() => Capacitor.isNativePlatform() ? pendingNativeDestination(sessionStorage) : null);
  const [accountOpen, setAccountOpen] = useState(Boolean(pending)), [accountTab, setAccountTab] = useState<CustomerTab>(pending ?? 'access');
  const [requestedBundle, setRequestedBundle] = useState<string | null>(null);
  const [bundles, setBundles] = useState<Product[] | null>(mobileApiConfigured ? null : examples), [catalogueError, setCatalogueError] = useState(false);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null), [checking, setChecking] = useState(mobileApiConfigured), [catalogueAttempt, setCatalogueAttempt] = useState(0);
  useEffect(() => {
    // Configured builds read the same public catalogue and sales status as the website.
    if (!mobileApiConfigured) return;
    const controller = new AbortController(); setCatalogueError(false); setChecking(true);
    Promise.all([
      api<{ products: Product[] }>('/api/bundles', { signal: controller.signal }).then(data => {
        if (!Array.isArray(data?.products) || !data.products.every(validBundle)) throw Error('invalid_catalogue');
        if (!controller.signal.aborted) setBundles(data.products);
      }).catch(() => { if (!controller.signal.aborted) setCatalogueError(true); }),
      api<Capabilities>('/api/capabilities', { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setCapabilities(value); }).catch(() => { if (!controller.signal.aborted) setCapabilities(null); }),
    ]).finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [catalogueAttempt]);
  // The app can sell only when its account connection is qualified, as My PasoFi checks.
  const accountQualified = !!capabilities && capabilities.mobileCookies === true && (!usesNativeCustomerApi || capabilities.nativeCustomerApiVersion === 1);
  const purchasable = accountQualified && (capabilities!.staffSales && capabilities!.receiptPairing || capabilities!.paymentCheckout);
  const [registrationTab,setRegistrationTab]=useState<CustomerTab|null>(null);
  useEffect(()=>{
    let active=true;
    const watching=watchRegistrationReturn(destination=>{
      if(active){setAccountTab(destination);setRegistrationTab(destination);setHandoffReturn(0);setAccountOpen(true);}
    }).catch(()=>()=>{});
    return ()=>{active=false;void watching.then(stop=>stop());};
  },[]);
  const [handoffReturn, setHandoffReturn] = useState(0);
  useEffect(() => onAccountHandoffReturn(() => {
    // The OS return must open a safe account surface even in an unconfigured
    // build. MobileCustomer enforces the service gate before any handoff.
    setHandoffReturn(previous => previous + 1);
    setAccountOpen(true);
  }), []);
  const [helpQuery, setHelpQuery] = useState('');
  const content = useRef<HTMLElement>(null), previousTab = useRef(tab), previousAccountOpen = useRef(accountOpen);
  useEffect(() => {
    const returnedFromAccount = previousAccountOpen.current && !accountOpen;
    if (returnedFromAccount) window.scrollTo({ top: 0, behavior: 'auto' });
    if (!accountOpen && (returnedFromAccount || previousTab.current !== tab)) content.current?.querySelector('h1')?.focus({ preventScroll: true });
    previousTab.current = tab; previousAccountOpen.current = accountOpen;
  }, [tab, accountOpen]);
  const choose = (next: Tab) => { setTab(next); window.scrollTo({ top: 0, behavior: 'auto' }); };
  const openAccount = (next: CustomerTab = 'access', bundleId: string | null = null) => { setAccountTab(next); setRequestedBundle(bundleId); setAccountOpen(true); window.scrollTo({ top: 0, behavior: 'auto' }); };
  const accountFeature = (next: CustomerTab) => mobileApiConfigured ? openAccount(next) : choose('account');
  // Like the website, History and Account open the live account when one is configured.
  const go = (next: Exclude<Tab, 'help'>) => next === 'history' && mobileApiConfigured ? openAccount('history') : next === 'account' && mobileApiConfigured ? openAccount('recovery') : choose(next);
  const chooseBundle = (bundle: Product) => { if (purchasable) openAccount(capabilities!.staffSales && capabilities!.receiptPairing ? 'receipt' : 'purchase', bundle.id); };
  const leaveAccount = (next: Tab) => { setHandoffReturn(0); setRegistrationTab(null); setRequestedBundle(null); setAccountOpen(false); setTab(next); };
  const shownQuestions = questions.filter(item => helpQuery.trim().toLowerCase().split(/\s+/).every(word => `${item.q} ${item.a}`.toLowerCase().includes(word)));

  if (accountOpen) return <div className="mobile-app mobile-live-shell"><AccountRenderBoundary close={() => leaveAccount(tab)}><MobileCustomer initialTab={accountTab} requestedBundleId={requestedBundle} registrationTab={registrationTab} usedRegistration={()=>setRegistrationTab(null)} handoffReturn={handoffReturn} close={() => leaveAccount(tab)} goHome={() => leaveAccount('home')} goBundles={() => leaveAccount('bundles')} /></AccountRenderBoundary></div>;

  return <div className="mobile-app">
    <a className="mobile-skip" href="#mobile-content">Skip to content</a>
    <header className="mobile-header">
      <button className="mobile-brand" aria-label="PasoFi home" aria-describedby="pasofi-product-family" onClick={() => choose('home')}><span className="mobile-brandmark"><Icon name="wifi" /></span><span>PasoFi<small id="pasofi-product-family">An Onesa Mobile product</small></span></button>
      <div className="mobile-header-actions"><button className="mobile-icon-button" aria-label="Help" aria-current={tab === 'help' ? 'page' : undefined} onClick={() => choose('help')}><Icon name="help" /></button><button className="mobile-avatar-button" aria-label="My PasoFi" onClick={() => mobileApiConfigured ? openAccount() : choose('account')}><Icon name="account" /></button></div>
    </header>
    <main id="mobile-content" className="mobile-content" ref={content}>
      {!mobileApiConfigured && <div className="mobile-notice"><Icon name="info" /><p><strong>Offline preview</strong><span>Explore the app. Purchases and Wi-Fi access are not available yet.</span></p></div>}

      {tab === 'home' && <>
        <section className="mobile-hero" aria-labelledby="home-hero-heading">
          <div className="mobile-hero-copy"><span className="mobile-eyebrow">More connection. More possibilities.</span><h1 id="home-hero-heading" tabIndex={-1}>Your internet.<br />Your everyday.</h1>
            <button className="mobile-hero-button" onClick={() => choose('bundles')}>Browse bundles <Icon name="arrow" /></button></div>
          <div className="mobile-hero-art"><img src="/images/pasofi-community-hero.webp" alt="Three friends sharing a happy moment around a smartphone" width="1536" height="1024" /></div>
        </section>
        <section className="mobile-quick-actions" aria-label="Quick actions">
          <button onClick={() => accountFeature('voucher')}><span><Icon name="voucher" /></span>Redeem voucher</button>
          <button onClick={() => accountFeature('access')}><span><Icon name="history" /></span>Check usage</button>
          <button onClick={() => accountFeature('wifi')}><span><Icon name="wifi" /></span>My WiFi</button>
          <button onClick={() => choose('help')}><span><Icon name="help" /></span>Get help</button>
        </section>
        <MobileCatalogue bundles={bundles} example={!mobileApiConfigured} error={catalogueError} checking={checking} purchasable={purchasable} retry={() => setCatalogueAttempt(value => value + 1)} choose={chooseBundle} help={() => choose('help')} seeAll={() => choose('bundles')} />
        <details className="mobile-guide"><summary><span className="mobile-guide-icon"><Icon name="spark" /></span><span><strong>New to PasoFi?</strong><small>Three steps to your next connection.</small></span><Icon name="chevron" /></summary><ol>
          <li><span>01</span><div><h3>Find your hotspot</h3><p>Ask the local agent which Wi-Fi network to join and check its availability.</p></div></li>
          <li><span>02</span><div><h3>Choose your bundle</h3><p>Compare data, price and validity. Purchase options depend on current service availability.</p></div></li>
          <li><span>03</span><div><h3>Make it your connection</h3><p>Redeem your voucher and open My WiFi for the connection steps. Your account keeps track of usage.</p></div></li>
        </ol></details>
      </>}

      {tab === 'bundles' && <MobileCatalogue headingLevel={1} bundles={bundles} example={!mobileApiConfigured} error={catalogueError} checking={checking} purchasable={purchasable} retry={() => setCatalogueAttempt(value => value + 1)} choose={chooseBundle} help={() => choose('help')} />}

      {tab === 'history' && <section aria-labelledby="mobile-history">
        <div className="mobile-page-heading"><h1 tabIndex={-1} id="mobile-history">Your activity</h1><p>Keep track of your bundles and recent receipts.</p></div>
        <div className="mobile-empty-state"><span className="mobile-empty-icon"><Icon name="history" /></span><h2>Your story starts here.</h2><p>This offline preview has no purchase or usage records. Your confirmed account history will appear when account access is available.</p><button className="mobile-primary" onClick={() => choose('bundles')}>Explore bundles <Icon name="arrow" /></button></div>
      </section>}

      {tab === 'account' && <section aria-labelledby="mobile-account">
        <div className="mobile-page-heading"><h1 tabIndex={-1} id="mobile-account">Your account</h1><p>A simple home for your connection.</p></div>
        <div className="mobile-profile-card"><span className="mobile-profile-avatar"><Icon name="account" /></span><div><h2>Welcome to PasoFi</h2><p>You’re exploring the offline preview.</p></div><span className="mobile-label">Preview</span></div>
        <p className="mobile-account-explainer">Accounts, vouchers and devices become available when the service is ready. No account is created while you explore.</p>
        <p className="mobile-account-explainer"><a href="https://pasofi.mobile.onesa.eu/#account" target="_blank" rel="noopener noreferrer">PasoFi account on the web</a> · <RegistrationLink tab="access"/></p>
        <p className="mobile-account-explainer"><AccountClosureLink /></p>
        <div className="mobile-settings-list">
          <button onClick={() => choose('help')}><span className="mobile-setting-icon"><Icon name="devices" /></span><span><strong>My WiFi & devices</strong><small>Learn how connecting will work</small></span><Icon name="chevron" /></button>
          <div className="mobile-setting-row"><span className="mobile-setting-icon"><Icon name="globe" /></span><span><strong>Language</strong><small>English</small></span><span className="mobile-setting-value">EN</span></div>
          <button onClick={() => choose('help')}><span className="mobile-setting-icon"><Icon name="help" /></span><span><strong>Help & support</strong><small>Clear answers, whenever you need them</small></span><Icon name="chevron" /></button>
        </div>
      </section>}

      {tab === 'help' && <section aria-labelledby="mobile-help">
        <div className="mobile-page-heading"><span className="mobile-eyebrow">A LITTLE GUIDANCE</span><h1 tabIndex={-1} id="mobile-help">Here to help.</h1><p>Quick answers. More time for your day.</p></div>
        <div className="mobile-help-search"><label htmlFor="mobile-help-search">Find a quick answer</label><input id="mobile-help-search" type="search" maxLength={160} placeholder="Search help" value={helpQuery} onChange={event => setHelpQuery(event.target.value)} /><small>Search stays on this device. Never enter a private voucher, password or recovery key.</small></div>
        <div className="mobile-faq">{shownQuestions.length ? shownQuestions.map(item => <details key={item.q}><summary>{item.q}<Icon name="chevron" /></summary><p>{item.a}</p></details>) : <p className="mobile-no-results" role="status">No matching answer. Try a shorter phrase or clear your search.</p>}</div>
      </section>}
      {(tab === 'help' || tab === 'bundles') && <PolicyNotice/>}
    </main>
    <nav className="mobile-nav" aria-label="Main navigation">{navigation.map(item => <button key={item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => go(item.id)}><span className="mobile-nav-icon"><Icon name={item.icon} /></span>{item.label}</button>)}</nav>
  </div>;
}
