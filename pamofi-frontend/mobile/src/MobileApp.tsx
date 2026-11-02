import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { mobileApiConfigured } from './api';
const MobileCustomer = lazy(() => import('./MobileCustomer'));
import './mobile.css';

type Tab = 'home' | 'bundles' | 'help';
// Illustrative local values mirror the development seed, not a live offer.
const examples = [
  {name:'Mini', data:'2 GB', time:'3 days', price:'$0.50'},
  {name:'Flex', data:'5 GB', time:'7 days', price:'$1.00'},
  {name:'Week', data:'20 GB', time:'7 days', price:'$3.00'},
  {name:'Fortnight', data:'35 GB', time:'14 days', price:'$5.00'},
  {name:'Month', data:'75 GB', time:'30 days', price:'$10.00'},
];
const questions = [
  {q:'Can I buy a bundle in this app?', a:mobileApiConfigured ? 'This preview has example bundles only. My PamoFi checks which account and purchase features the configured service supports.' : 'Not yet. This is an offline preview. Payments and Wi-Fi connections are not available.'},
  {q:'When does bundle time start?', a:'The planned service starts validity on the first successful connection. Final terms will be confirmed when the service launches.'},
  {q:'Does my data include uploads?', a:'The planned allowance includes both uploads and downloads.'},
  {q:'Can I use more than one device?', a:'The service is designed for one active device per customer. Device switching is still being developed.'},
];
export default function MobileApp() {
  const [tab,setTab]=useState<Tab>('home');
  const [accountOpen, setAccountOpen] = useState(false);
  const [selected,setSelected]=useState<string|null>(null);
  const content = useRef<HTMLElement>(null), previousTab = useRef(tab);
  useEffect(() => { if (previousTab.current !== tab) { content.current?.querySelector('h1')?.focus(); previousTab.current = tab; } }, [tab]);
  const choose=(next:Tab)=>{setSelected(null);setTab(next);window.scrollTo({top:0,behavior:'auto'});};
  if (accountOpen) return <div className="mobile-app"><Suspense fallback={<p className="mobile-notice" role="status">Loading account tools…</p>}><MobileCustomer close={() => setAccountOpen(false)} /></Suspense></div>;
  return <div className="mobile-app">
    <header className="mobile-header"><div className="mobile-brand"><span aria-hidden="true">◒</span><div>PamoFi<small>by Onesa</small></div></div><span className="mobile-label">PREVIEW</span>{mobileApiConfigured && <button className="mobile-account-button" onClick={() => setAccountOpen(true)}>My PamoFi</button>}</header>
    <main id="mobile-content" className="mobile-content" ref={content}>
      <div className="mobile-notice" role="status"><span aria-hidden="true">✳</span><p><strong>Offline preview</strong><br/>{mobileApiConfigured ? 'Example bundles below are offline. Open My PamoFi to check the configured service.' : 'Purchases, accounts and internet access are not available yet.'}</p></div>
      {tab==='home' && <><section className="mobile-hero"><div className="mobile-eyebrow">HELLO, YOU’RE IN THE RIGHT PLACE</div><h1 tabIndex={-1}>Good connection.<br/><em>More possibility.</em></h1><p>Simple Wi-Fi bundles for the moments that matter.</p><button className="mobile-primary" onClick={()=>choose('bundles')}>Explore bundles <span aria-hidden="true">↗</span></button><div className="mobile-hero-art" aria-hidden="true"><img src="/images/pamofi-everyday-connection.webp" alt="" width="900" height="1200"/><small>MORE OF WHAT MATTERS</small></div></section><section className="mobile-intro"><div><span>01</span><strong>Simple bundles</strong><p>Choose the data and time that fit your day.</p></div><div><span>02</span><strong>On your terms</strong><p>No subscriptions or automatic renewals are planned.</p></div></section><button className="mobile-help-link" onClick={()=>choose('help')}>Have a question? <span>Explore help →</span></button></>}
      {tab==='bundles' && <section aria-labelledby="mobile-bundles"><div className="mobile-eyebrow">A LITTLE MORE FREEDOM</div><h1 tabIndex={-1} id="mobile-bundles">Find your fit.</h1><p className="mobile-subtitle">Explore example bundles. Prices and terms are illustrative and may change before launch.</p><div className="mobile-bundles">{examples.map((b,i)=><article className={'mobile-card '+(b.name==='Flex'?'mobile-card-featured':'')} key={b.name}><div className="mobile-card-top"><span>{String(i+1).padStart(2,'0')} / {b.name.toUpperCase()}</span>{b.name==='Flex'&&<span>EVERYDAY PICK</span>}</div><h2>{b.data}</h2><p>for {b.time}</p><div className="mobile-card-bottom"><strong>{b.price} <small>USD</small></strong><button aria-label={`${selected===b.name ? 'Close' : 'View'} ${b.name} example bundle`} aria-expanded={selected===b.name} aria-controls={selected===b.name ? `bundle-${b.name}` : undefined} onClick={()=>setSelected(selected===b.name?null:b.name)}>{selected===b.name ? 'Close' : 'Details'} <span aria-hidden="true">{selected===b.name ? '−' : '→'}</span></button></div>{selected===b.name&&<p className="mobile-card-detail" id={`bundle-${b.name}`}>Example only. Buying and connecting are not available in this preview.</p>}</article>)}</div><p className="mobile-footnote">The planned allowance includes uploads and downloads. Final prices and terms will be confirmed at launch.</p></section>}
      {tab==='help' && <section aria-labelledby="mobile-help"><div className="mobile-eyebrow">HERE FOR YOU</div><h1 tabIndex={-1} id="mobile-help">Here to help.</h1><p className="mobile-subtitle">A few things to know about this preview.</p><div className="mobile-faq">{questions.map(item=><details key={item.q}><summary>{item.q}<span aria-hidden="true">+</span></summary><p>{item.a}</p></details>)}</div><div className="mobile-help-note"><strong>Still in development</strong><p>Available account tools depend on the configured service. This preview never claims a payment or Wi-Fi connection has completed.</p></div></section>}
    </main>
    <nav className="mobile-nav" aria-label="Main navigation"><button aria-current={tab==='home'?'page':undefined} onClick={()=>choose('home')}><span aria-hidden="true">⌂</span>Home</button><button aria-current={tab==='bundles'?'page':undefined} onClick={()=>choose('bundles')}><span aria-hidden="true">▦</span>Bundles</button><button aria-current={tab==='help'?'page':undefined} onClick={()=>choose('help')}><span aria-hidden="true">ⓘ</span>Help</button></nav>
  </div>;
}
