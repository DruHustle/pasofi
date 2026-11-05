import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { mobileApiConfigured } from './api';
import Icon, { type IconName } from './Icon';
import type { CustomerTab } from './CustomerAccess';
import { PolicyNotice } from './Policies';
import { policyHelpArticles } from './PolicyHelp';
const MobileCustomer = lazy(() => import('./MobileCustomer'));
import './mobile.css';

type Tab = 'home' | 'bundles' | 'history' | 'account' | 'help';
type Category = 'all' | 'daily' | 'short' | 'weekly' | 'longer' | 'monthly';
// Illustrative local values mirror the development seed. They are never live offers.
const examples = [
  { name: 'Mini', data: '2', days: 3, price: '$0.50', description: 'A little connection for your day.' },
  { name: 'Flex', data: '5', days: 7, price: '$1.00', description: 'Room for your everyday moments.' },
  { name: 'Week', data: '20', days: 7, price: '$3.00', description: 'Keep your week moving.' },
  { name: 'Fortnight', data: '35', days: 14, price: '$5.00', description: 'More time for what matters.' },
  { name: 'Month', data: '75', days: 30, price: '$10.00', description: 'Settle into a month of possibilities.' },
];
const categories: { id: Category; label: string; matches: (days: number) => boolean }[] = [
  { id: 'all', label: 'All bundles', matches: () => true },
  { id: 'daily', label: 'Daily', matches: days => days <= 1 },
  { id: 'short', label: 'Short stays', matches: days => days > 1 && days <= 3 },
  { id: 'weekly', label: 'Weekly', matches: days => days > 3 && days <= 7 },
  { id: 'longer', label: 'Longer stays', matches: days => days > 7 && days <= 27 },
  { id: 'monthly', label: 'Monthly', matches: days => days > 27 },
];
const questions = [
  ...policyHelpArticles.map(article => ({ q: article.question, a: article.answer })),
  { q: 'Can I buy a bundle in this app?', a: mobileApiConfigured ? 'This preview has example bundles only. My PasoFi checks which account and purchase features the configured service supports.' : 'Not yet. This is an offline preview. Payments and Wi-Fi connections are not available.' },
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

export default function MobileApp() {
  const [tab, setTab] = useState<Tab>('home');
  const [accountOpen, setAccountOpen] = useState(false), [accountTab, setAccountTab] = useState<CustomerTab>('access');
  const [selected, setSelected] = useState<string | null>(null), [category, setCategory] = useState<Category>('all');
  const [helpQuery, setHelpQuery] = useState('');
  const content = useRef<HTMLElement>(null), previousTab = useRef(tab);
  useEffect(() => { if (previousTab.current !== tab) { content.current?.querySelector('h1')?.focus(); previousTab.current = tab; } }, [tab]);
  const choose = (next: Tab) => { setSelected(null); setTab(next); window.scrollTo({ top: 0, behavior: 'auto' }); };
  const openAccount = (next: CustomerTab = 'access') => { setAccountTab(next); setAccountOpen(true); window.scrollTo({ top: 0, behavior: 'auto' }); };
  const accountFeature = (next: CustomerTab) => mobileApiConfigured ? openAccount(next) : choose('account');
  const shownExamples = examples.filter(bundle => categories.find(item => item.id === category)!.matches(bundle.days));
  const shownQuestions = questions.filter(item => helpQuery.trim().toLowerCase().split(/\s+/).every(word => `${item.q} ${item.a}`.toLowerCase().includes(word)));

  if (accountOpen) return <div className="mobile-app mobile-live-shell"><Suspense fallback={<p className="mobile-notice" role="status">Loading account tools…</p>}><MobileCustomer initialTab={accountTab} close={() => setAccountOpen(false)} /></Suspense></div>;

  return <div className="mobile-app">
    <a className="mobile-skip" href="#mobile-content">Skip to content</a>
    <header className="mobile-header">
      <button className="mobile-brand" aria-label="PasoFi home" onClick={() => choose('home')}><span className="mobile-brandmark"><Icon name="wifi" /></span><span>PasoFi<small>by Onesa</small></span></button>
      <div className="mobile-header-actions">{mobileApiConfigured && <button className="mobile-account-button" onClick={() => openAccount()}>My PasoFi</button>}<button className="mobile-icon-button" aria-label="Help" onClick={() => choose('help')}><Icon name="help" /></button></div>
    </header>
    <main id="mobile-content" className="mobile-content" ref={content}>
      <div className="mobile-notice"><Icon name="info" /><p><strong>Offline preview</strong><span>{mobileApiConfigured ? 'Example bundles only. My PasoFi checks the configured service.' : 'Explore the app. Purchases and Wi-Fi access are not available yet.'}</span></p></div>

      {tab === 'home' && <>
        <div className="mobile-page-heading"><p className="mobile-eyebrow">A LITTLE CONNECTION. MORE POSSIBILITY.</p><h1 tabIndex={-1}>Your internet.<br />Your way.</h1><p>Simple Wi-Fi for the moments that matter.</p></div>
        <section className="mobile-balance" aria-labelledby="preview-balance-title">
          <div className="mobile-balance-top"><span id="preview-balance-title">Your PasoFi balance</span><span className="mobile-status"><span />Preview</span></div>
          <div className="mobile-balance-body"><div><p>Data remaining</p><strong>— <span>GB</span></strong><span className="mobile-balance-caption">Live balance unavailable</span></div><div className="mobile-wifi-orbit" aria-hidden="true"><Icon name="wifi" /></div></div>
          <div className="mobile-balance-meta"><span><Icon name="clock" />Time unavailable</span><span><Icon name="shield" />Connection unverified</span></div>
          <button className="mobile-primary mobile-primary-wide" onClick={() => choose('bundles')}>Explore bundles <Icon name="arrow" /></button>
        </section>
        <section className="mobile-quick-actions" aria-label="Quick actions">
          <button onClick={() => choose('bundles')}><span><Icon name="bundles" /></span>Bundles</button>
          <button onClick={() => accountFeature('voucher')}><span><Icon name="voucher" /></span>Vouchers</button>
          <button onClick={() => accountFeature('wifi')}><span><Icon name="wifi" /></span>My WiFi</button>
          <button onClick={() => choose('help')}><span><Icon name="help" /></span>Support</button>
        </section>
        <section className="mobile-home-offer" aria-labelledby="mobile-explore-title">
          <div className="mobile-section-heading"><h2 id="mobile-explore-title">Find your everyday fit</h2><button className="mobile-text-button" onClick={() => choose('bundles')}>See all <Icon name="arrow" /></button></div>
          <article className="mobile-featured-example"><div><span className="mobile-sample-label"><Icon name="spark" />Example bundle</span><h3>Flex <span>5 GB</span></h3><p>7 days from first connection</p></div><div className="mobile-example-price"><strong>$1.00</strong><span>USD · illustrative</span></div></article>
        </section>
        <section className="mobile-lifestyle"><div className="mobile-hero-art" aria-hidden="true"><img src="/images/pamofi-everyday-connection.webp" alt="" width="900" height="1200" /></div><div><span className="mobile-eyebrow">MADE FOR YOUR EVERYDAY</span><h2>Closer to what matters.</h2><p>A message home. Your next idea. A moment together.</p></div></section>
        <button className="mobile-help-link" onClick={() => choose('help')}><span className="mobile-help-icon"><Icon name="help" /></span><span><strong>A little help goes a long way.</strong><small>Explore quick answers</small></span><Icon name="arrow" /></button>
      </>}

      {tab === 'bundles' && <section aria-labelledby="mobile-bundles">
        <div className="mobile-page-heading"><p className="mobile-eyebrow">A LITTLE MORE FREEDOM</p><h1 tabIndex={-1} id="mobile-bundles">Find your fit.</h1><p>Big moments. Small prices. Explore what’s possible.</p></div>
        <p className="mobile-example-disclosure"><Icon name="info" />Example bundles. Prices and terms are illustrative and may change before launch.</p>
        <div className="mobile-category-tabs" role="group" aria-label="Bundle categories">{categories.filter(item => examples.some(bundle => item.matches(bundle.days))).map(item => <button key={item.id} aria-pressed={category === item.id} onClick={() => { setCategory(item.id); setSelected(null); }}>{item.label}</button>)}</div>
        <div className="mobile-bundles">{shownExamples.map(bundle => <article className={`mobile-card ${bundle.name === 'Flex' ? 'mobile-card-featured' : ''}`} key={bundle.name}>
          <div className="mobile-card-top"><span className="mobile-plan-icon"><Icon name={bundle.days > 7 ? 'globe' : 'wifi'} /></span><div><h2>{bundle.name}</h2><span>Example bundle</span></div>{bundle.name === 'Flex' && <span className="mobile-pick">Everyday pick</span>}</div>
          <div className="mobile-plan-allowance"><strong>{bundle.data}<span>GB</span></strong><span><Icon name="clock" />{bundle.days} days</span></div>
          <p>{bundle.description}</p>
          <div className="mobile-card-bottom"><strong>{bundle.price}<small>USD</small></strong><button aria-label={`${selected === bundle.name ? 'Close' : 'View'} ${bundle.name} example bundle`} aria-expanded={selected === bundle.name} aria-controls={selected === bundle.name ? `bundle-${bundle.name}` : undefined} onClick={() => setSelected(selected === bundle.name ? null : bundle.name)}>{selected === bundle.name ? 'Close details' : 'View details'}<Icon name={selected === bundle.name ? 'chevron' : 'arrow'} /></button></div>
          {selected === bundle.name && <div className="mobile-card-detail" id={`bundle-${bundle.name}`}><p>Example only. Buying and connecting are not available in this preview.</p><p>Planned allowance includes uploads and downloads. Validity begins on the first successful hotspot connection.</p></div>}
        </article>)}</div>
        <div className="mobile-terms-note"><Icon name="shield" /><p><strong>Simple, clear terms.</strong> No subscriptions or automatic renewals are planned. Final prices and availability will be confirmed at launch.</p></div>
      </section>}

      {tab === 'history' && <section aria-labelledby="mobile-history">
        <div className="mobile-page-heading"><p className="mobile-eyebrow">ALL IN ONE PLACE</p><h1 tabIndex={-1} id="mobile-history">Your history.</h1><p>Keep track of your bundles and activity.</p></div>
        <div className="mobile-empty-state"><span className="mobile-empty-icon"><Icon name="history" /></span><h2>Your story starts here.</h2><p>This offline preview has no purchase or usage records. Your confirmed account history will appear when account access is available.</p>{mobileApiConfigured ? <button className="mobile-primary" onClick={() => openAccount('history')}>Open account history <Icon name="arrow" /></button> : <button className="mobile-primary" onClick={() => choose('bundles')}>Explore example bundles <Icon name="arrow" /></button>}</div>
        <div className="mobile-terms-note"><Icon name="lock" /><p>Receipts and usage belong to your account. We’ll only show activity confirmed by the service.</p></div>
      </section>}

      {tab === 'account' && <section aria-labelledby="mobile-account">
        <div className="mobile-page-heading"><p className="mobile-eyebrow">YOUR SPACE</p><h1 tabIndex={-1} id="mobile-account">My PasoFi.</h1><p>A simple home for your connection.</p></div>
        <div className="mobile-profile-card"><span className="mobile-profile-avatar"><Icon name="account" /></span><div><h2>Welcome to PasoFi</h2><p>{mobileApiConfigured ? 'Check your configured account service.' : 'You’re exploring the offline preview.'}</p></div><span className="mobile-label">Preview</span></div>
        {mobileApiConfigured ? <button className="mobile-primary mobile-primary-wide" onClick={() => openAccount()}>Open My PasoFi <Icon name="arrow" /></button> : <p className="mobile-account-explainer">Accounts, vouchers and devices become available when the service is ready. No account is created while you explore.</p>}
        <div className="mobile-settings-list">
          <button onClick={() => mobileApiConfigured ? openAccount('wifi') : choose('help')}><span className="mobile-setting-icon"><Icon name="devices" /></span><span><strong>My WiFi & devices</strong><small>{mobileApiConfigured ? 'Check account availability' : 'Learn how connecting will work'}</small></span><Icon name="chevron" /></button>
          <button onClick={() => mobileApiConfigured ? openAccount('recovery') : choose('help')}><span className="mobile-setting-icon"><Icon name="shield" /></span><span><strong>Account & security</strong><small>{mobileApiConfigured ? 'Recovery and device access' : 'Account access is not available yet'}</small></span><Icon name="chevron" /></button>
          <div className="mobile-setting-row"><span className="mobile-setting-icon"><Icon name="globe" /></span><span><strong>Language</strong><small>English</small></span><span className="mobile-setting-value">EN</span></div>
          <button onClick={() => choose('help')}><span className="mobile-setting-icon"><Icon name="help" /></span><span><strong>Help & support</strong><small>Clear answers, whenever you need them</small></span><Icon name="chevron" /></button>
        </div>
        <p className="mobile-brand-footnote"><Icon name="wifi" />PasoFi by Onesa<span>Wi-Fi for your everyday.</span></p>
      </section>}

      {tab === 'help' && <section aria-labelledby="mobile-help">
        <div className="mobile-page-heading"><p className="mobile-eyebrow">A LITTLE HELP</p><h1 tabIndex={-1} id="mobile-help">Here for you.</h1><p>Clear answers. Less guesswork.</p></div>
        <div className="mobile-support-card"><span><Icon name="help" /></span><div><h2>Let’s make it simple.</h2><p>Explore reviewed answers about bundles, vouchers and getting connected.</p></div></div>
        <div className="mobile-help-search"><label htmlFor="mobile-help-search">Find a quick answer</label><input id="mobile-help-search" type="search" maxLength={160} placeholder="Try data or vouchers" value={helpQuery} onChange={event => setHelpQuery(event.target.value)} /><small>Search stays on this device. Never enter a private voucher, password or recovery key.</small></div>
        <div className="mobile-faq">{shownQuestions.length ? shownQuestions.map(item => <details key={item.q}><summary>{item.q}<Icon name="chevron" /></summary><p>{item.a}</p></details>) : <p className="mobile-no-results" role="status">No matching answer. Try a shorter phrase or clear your search.</p>}</div>
        <div className="mobile-terms-note"><Icon name="info" /><p>This is an offline preview. Available account features depend on the configured service.</p></div>
      </section>}
      <PolicyNotice/>
    </main>
    <nav className="mobile-nav" aria-label="Main navigation">{navigation.map(item => <button key={item.id} aria-current={tab === item.id ? 'page' : undefined} onClick={() => choose(item.id)}><span className="mobile-nav-icon"><Icon name={item.icon} /></span>{item.label}</button>)}</nav>
  </div>;
}
