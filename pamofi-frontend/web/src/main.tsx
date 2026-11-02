import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
const DemoPurchase = lazy(() => import('./DemoPurchase'));
const Recovery = lazy(() => import('./Recovery'));
const StaffWorkspace = lazy(() => import('./StaffWorkspace'));
const CustomerAccess = lazy(() => import('./CustomerAccess'));
const Handoff = lazy(() => import('./Handoff'));
import type { Capabilities, Product } from './business';
import { createRoot } from 'react-dom/client';
import './style.css';
import { api } from './api';
import { onSessionChange } from './session';
type Bundle = { id: string; price_minor: number; currency: string; byte_limit: string; validity_seconds: number };
type Article = { question: string; answer: string };
const validBundle = (value: Bundle) => value && typeof value.id === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(value.id) && Number.isInteger(value.price_minor) && value.price_minor > 0 && typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency) && typeof value.byte_limit === 'string' && /^[1-9][0-9]{0,29}$/.test(value.byte_limit) && Number.isInteger(value.validity_seconds) && value.validity_seconds > 0;
const bundlePrice = (bundle: Bundle) => new Intl.NumberFormat(undefined, { style: 'currency', currency: bundle.currency }).format(bundle.price_minor / 100);
function App() {
  const [bundles, setBundles] = useState<Bundle[] | null>(null);
  const [articles, setArticles] = useState<Article[] | null>(null);
  const [error, setError] = useState(false), [helpError, setHelpError] = useState(false);
  const [catalogueAttempt, setCatalogueAttempt] = useState(0), [helpAttempt, setHelpAttempt] = useState(0);
  const [demoEnabled, setDemoEnabled] = useState(false), [helpQuery, setHelpQuery] = useState('');
  const [notice, setNotice] = useState(''), [offline, setOffline] = useState(!navigator.onLine);
  const opener = useRef<HTMLButtonElement | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [workspace, setWorkspace] = useState<'customer' | 'staff' | 'handoff' | null>(() => location.pathname === '/handoff' ? 'handoff' : null);
  const [checkoutBundle, setCheckoutBundle] = useState<Product | null>(null);
  const recoveryTarget = useRef<'demo' | 'customer'>('demo');
  const [tab, setTab] = useState<'bundles'|'help'>(() => location.hash === '#help' ? 'help' : 'bundles');
  const [purchase, setPurchase] = useState<Bundle | 'access' | 'recovery' | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError(false); setBundles(null); setDemoEnabled(false);
    api<{ products: Bundle[]; candidate: boolean }>('/api/bundles', { signal: controller.signal }).then(data => {
      if (!Array.isArray(data.products) || !data.products.every(validBundle)) throw Error('invalid_catalogue');
      if (!controller.signal.aborted) { setBundles(data.products); setDemoEnabled(data.candidate === true); }
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [catalogueAttempt]);
  useEffect(() => {
    const controller = new AbortController();
    setHelpError(false); setArticles(null);
    api<{ articles: Article[] }>('/api/help', { signal: controller.signal }).then(data => {
      if (!Array.isArray(data.articles) || !data.articles.every(item => typeof item.question === 'string' && typeof item.answer === 'string')) throw Error('invalid_help');
      if (!controller.signal.aborted) setArticles(data.articles);
    }).catch(() => { if (!controller.signal.aborted) setHelpError(true); });
    return () => controller.abort();
  }, [helpAttempt]);
  useEffect(() => { const controller = new AbortController(); api<Capabilities>('/api/capabilities', { signal: controller.signal }).then(value => { if (!controller.signal.aborted && typeof value.demo === 'boolean') setCapabilities(value); }).catch(() => {}); return () => controller.abort(); }, []);
  useEffect(() => onSessionChange(change => { setPurchase(null); setWorkspace(null); setNotice(change === 'signed_out' ? 'Signed out in another tab. Account details have been cleared from this view.' : 'Your account changed in another tab. Reopen your account tools to load the current account.'); }), []);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    addEventListener('online', update); addEventListener('offline', update);
    return () => { removeEventListener('online', update); removeEventListener('offline', update); };
  }, []);
  const openPurchase = (next: Bundle | 'access' | 'recovery', button: HTMLButtonElement) => { opener.current = button; setNotice(''); setWorkspace(null); recoveryTarget.current = 'demo'; setPurchase(next); };
  const openWorkspace = (next: 'customer' | 'staff' | 'handoff', button: HTMLButtonElement, bundle: Product | null = null) => { opener.current = button; setNotice(''); setPurchase(null); setCheckoutBundle(bundle); setWorkspace(next); };
  const customerRecovery = () => { recoveryTarget.current = 'customer'; setWorkspace(null); setPurchase('recovery'); };
  const recovered = () => { if (recoveryTarget.current === 'customer' && capabilities) { setPurchase(null); setWorkspace('customer'); } else setPurchase('access'); };
  const closePurchase = () => { setPurchase(null); setWorkspace(null); requestAnimationFrame(() => opener.current?.focus()); };
  const visibleArticles = articles?.filter(article => helpQuery.trim().toLocaleLowerCase().split(/\s+/).every(word => `${article.question} ${article.answer}`.toLocaleLowerCase().includes(word))) ?? [];
  const scrollToExplore = () => document.getElementById('explore')?.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
  useEffect(() => {
    const sync = () => { if (location.hash === '#help' || location.hash === '#bundles' || location.hash === '') { setTab(location.hash === '#help' ? 'help' : 'bundles'); if (location.hash) requestAnimationFrame(scrollToExplore); } };
    if (location.hash === '#help' || location.hash === '#bundles') requestAnimationFrame(sync);
    addEventListener('popstate', sync);
    return () => removeEventListener('popstate', sync);
  }, []);
  const selectTab = (next: 'bundles'|'help', scroll = false) => { if (location.hash !== `#${next}`) history.pushState(null, '', `#${next}`); setTab(next); if (scroll) scrollToExplore(); };
  const go = (next: 'bundles'|'help') => selectTab(next, true);
  return <><a className="skip-link" href="#explore">Skip to bundles and help</a><header className="header"><a className="brand" href="#top" aria-label="PamoFi home"><span className="brandmark" aria-hidden="true">◒</span><span>PamoFi<small>by Onesa</small></span></a><nav aria-label="Main navigation"><button onClick={() => go('bundles')}>Bundles</button><button onClick={() => go('help')}>Help</button>{demoEnabled && <button onClick={event => openPurchase('access', event.currentTarget)}>My demo access</button>}<button onClick={event => { openPurchase('recovery', event.currentTarget); if (!demoEnabled) recoveryTarget.current = 'customer'; }}>Recover</button><button disabled={!capabilities} onClick={event => openWorkspace('customer', event.currentTarget)}>Customer tools</button><button onClick={event => openWorkspace('staff', event.currentTarget)}>Staff</button><button onClick={event => openWorkspace('handoff', event.currentTarget)}>Accept handoff</button><span className="nav-note">Wi-Fi made simple <span>↗</span></span></nav></header>
  <main id="top">{offline && <div className="connection-notice" role="status">You appear to be offline. Reconnect before checking an order or recovering access.</div>}{notice && <div className="connection-notice" role="status">{notice}</div>}<div className="demo"><span className="demo-dot"/>{capabilities?.demo === false ? <> PAMOFI CUSTOMER SERVICE <span className="demo-sep">/</span> Review current offers and check your confirmed account status</> : <> DEMONSTRATION <span className="demo-sep">/</span> Candidate bundles · purchases and connections are not yet available</>}</div>
  <section className="hero"><div className="hero-copy"><div className="eyebrow"><span className="spark">✳</span> HELLO, YOU’RE IN THE RIGHT PLACE</div><h1>Good connection.<br/><em>More possibility.</em></h1><p>Stay close to what matters with straightforward Wi-Fi bundles, made for the way you connect.</p><div className="hero-actions"><button className="primary" onClick={() => go('bundles')}>Explore bundles <span>↗</span></button><button className="secondary" onClick={() => go('help')}>How it works <span>→</span></button></div><div className="hero-foot"><span className="avatars" aria-hidden="true"><i>✳</i><i>⌁</i><i>✦</i></span><span>Made for your everyday<br/><strong>moments online.</strong></span></div></div><div className="hero-visual" aria-hidden="true">
      <img className="hero-photo" src="/images/pamofi-everyday-connection.webp" alt="" width="900" height="1200" fetchPriority="high"/>
      <div className="hero-photo-shade"/>
      <div className="hero-photo-label"><span className="hero-label-dot"/> THE LITTLE THINGS ADD UP</div>
      <div className="hero-photo-caption"><span>GOOD TO BE CONNECTED</span><strong>More of what<br/><em>matters.</em></strong></div>
      <div className="floating"><span className="float-icon">✳</span><div><strong>Made for your everyday</strong><small>Connection on your terms</small></div><span className="float-arrow">↗</span></div>
    </div></section>
  <section className="features" aria-label="Bundle features">
    <div><span className="feature-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 8.5c4.4-4 11.6-4 16 0M7 12c2.8-2.5 7.2-2.5 10 0M10 15.5c1.2-1 2.8-1 4 0"/><circle cx="12" cy="19" r="1" fill="currentColor" stroke="none"/></svg></span><strong>Simple bundles</strong><p>Pick the data and time that work for you.</p></div>
    <div><span className="feature-icon feature-icon-sand" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></svg></span><strong>On your terms</strong><p>No subscriptions or automatic renewals.</p></div>
    <div><span className="feature-icon feature-icon-sage" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M19 10c0 5-7 10-7 10s-7-5-7-10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/></svg></span><strong>Choose your site</strong><p>Check availability at configured PamoFi locations.</p></div>
  </section>
  {purchase && <Suspense fallback={<p role="status">Loading demo…</p>}>{purchase === 'recovery' ? <Recovery close={closePurchase} recovered={recovered}/> : <DemoPurchase key={purchase === 'access' ? 'access' : purchase.id} bundle={purchase === 'access' ? null : purchase} close={closePurchase} signedOut={() => { closePurchase(); setNotice('Signed out of this device. Use Recover to return to your saved demo account.'); }}/>}</Suspense>}
  {workspace && <Suspense fallback={<p className="empty" role="status">Loading your workspace…</p>}>{workspace === 'staff' ? <StaffWorkspace close={closePurchase} capabilities={capabilities}/> : workspace === 'handoff' ? <Handoff close={closePurchase} recovered={() => { setWorkspace(capabilities ? 'customer' : null); if (!capabilities) setPurchase('access'); }}/> : capabilities && <CustomerAccess close={closePurchase} capabilities={capabilities} selectedBundle={checkoutBundle} recovered={customerRecovery}/>}</Suspense>}
  <section className="explore" id="explore" tabIndex={-1}><div className="section-head"><div><div className="eyebrow"><span className="spark">✳</span> A LITTLE MORE FREEDOM</div><h2>{tab === 'bundles' ? 'Find your fit.' : 'Here to help.'}</h2><p>{tab === 'bundles' ? 'A bundle for the little things and everything in between.' : 'The basics, without the complicated bits.'}</p></div><div className="tabs" aria-label="Explore"><button className={tab === 'bundles' ? 'selected' : ''} aria-pressed={tab === 'bundles'} onClick={() => selectTab('bundles')}>Bundles</button><button className={tab === 'help' ? 'selected' : ''} aria-pressed={tab === 'help'} onClick={() => selectTab('help')}>Help & FAQs</button></div></div>
  {tab === 'bundles' ? <><div className="catalogue-label"><span>{demoEnabled ? 'CANDIDATE BUNDLES' : 'PUBLISHED BUNDLES'}</span><span>USD · DATA + TIME</span></div>{error ? <div className="empty"><p role="status">Bundle information is temporarily unavailable.</p><button className="secondary" onClick={() => setCatalogueAttempt(value => value + 1)}>Retry bundles</button></div> : !bundles ? <div className="empty" role="status">Loading bundle information…</div> : bundles.length === 0 ? <div className="empty" role="status">No bundles are published yet. Check back when PamoFi launches.</div> : <div className="cards">{bundles.map((b, i) => <article className={'card ' + (b.id === 'flex' ? 'featured' : '')} key={b.id}><div className="card-top"><span>{String(i + 1).padStart(2,'0')} / {b.id.toUpperCase()}</span>{b.id === 'flex' && <span className="badge">EVERYDAY PICK</span>}</div><h3>{Number(b.byte_limit) / 1_000_000_000} <small>GB</small></h3><p className="duration">for {b.validity_seconds / 86400} days</p><div className="card-rule"/><div className="card-bottom"><strong>{bundlePrice(b)} <small>{b.currency}</small></strong><button className="arrow" disabled={!demoEnabled && !capabilities?.paymentCheckout && !capabilities?.staffSales} aria-label={demoEnabled ? `Try ${b.id} demo bundle` : capabilities?.staffSales ? `Buy ${b.id} from an agent` : capabilities?.paymentCheckout ? `Review ${b.id} bundle` : `${b.id} purchasing is not available`} onClick={event => demoEnabled ? openPurchase(b, event.currentTarget) : openWorkspace('customer', event.currentTarget, b)}>{demoEnabled ? 'Try demo' : capabilities?.staffSales ? 'Buy from an agent' : capabilities?.paymentCheckout ? 'View bundle' : 'Not available'} <span aria-hidden="true">→</span></button></div></article>)}</div>}<div className="disclosure"><span>✳</span><p><strong>Good to know.</strong> Time starts when you first connect and ends when your time or data runs out. Uploads and downloads both count. One active connection per customer. Purchases must start within 30 days.</p></div></> : <div className="faq"><div className="help-search"><label htmlFor="help-query">Find a quick answer</label><input id="help-query" type="search" maxLength={160} placeholder="Try data, recovery or payments" value={helpQuery} onChange={event => setHelpQuery(event.target.value)}/><p>Search reviewed answers. Never enter a voucher, password or recovery key here.</p></div>{helpError ? <div className="empty"><p role="status">Help is temporarily unavailable.</p><button className="secondary" onClick={() => setHelpAttempt(value => value + 1)}>Retry help</button></div> : articles === null ? <p role="status">Loading help…</p> : articles.length === 0 ? <p role="status">Help articles are not published yet.</p> : visibleArticles.length === 0 ? <p role="status">No reviewed answer matches that search. Try a shorter phrase or clear the search to see all answers.</p> : visibleArticles.map(a => <details key={a.question}><summary>{a.question}<span aria-hidden="true">+</span></summary><p>{a.answer}</p></details>)}</div>}</section>
  <section className="closing"><div><div className="eyebrow">A BETTER WAY TO CONNECT</div><h2>A little connection<br/><em>goes a long way.</em></h2></div><button className="secondary light" onClick={() => go('help')}>Explore help <span>↗</span></button></section></main><footer><a className="brand" href="#top"><span className="brandmark">◒</span><span>PamoFi<small>by Onesa</small></span></a><p>Wi-Fi for your everyday.</p><span>{capabilities?.demo === false ? 'PAMOFI · CUSTOMER ACCESS' : 'DEMO · NOT YET LIVE'}</span></footer></>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
