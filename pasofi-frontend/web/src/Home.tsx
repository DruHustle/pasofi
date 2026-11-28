import { lazy, Suspense, useRef, useState, type ReactNode } from 'react';
import type { Capabilities } from './business';
import type { CustomerTab } from './CustomerAccess';
import Icon from './Icon';

type Props = {
  capabilities: Capabilities | null; children: ReactNode;
  browse: (button?: HTMLButtonElement) => void;
  account: (tab: CustomerTab, button: HTMLButtonElement) => void;
  help: (button?: HTMLButtonElement) => void;
};
const HotspotMap = lazy(() => import('./HotspotMap'));

export default function Home({ capabilities, children, browse, account, help }: Props) {
  const [locationsOpen, setLocationsOpen] = useState(false);
  const locationsDialog = useRef<HTMLDialogElement>(null);
  const locationsButton = useRef<HTMLButtonElement>(null);

  function showLocations(button: HTMLButtonElement) {
    locationsButton.current = button;
    locationsDialog.current?.showModal();
    setLocationsOpen(true);
  }

  function closeLocations() {
    setLocationsOpen(false);
    locationsButton.current?.focus({ preventScroll: true });
  }

  return <div className="pasofi-home-content">
    <section className="pasofi-home-hero" aria-labelledby="home-hero-heading">
      <div className="pasofi-home-hero-copy"><span className="pasofi-home-kicker">A LITTLE MORE PASOFI</span><h1 id="home-hero-heading" tabIndex={-1}>Your internet.<br/><em>Your everyday.</em></h1><p>For the catch-ups, bright ideas and everyday moments.</p>
        <button className="pf-button" onClick={event => browse(event.currentTarget)}>Browse bundles <Icon name="arrow"/></button></div>
      <div className="pasofi-home-hero-photo"><img src="/images/pasofi-community-hero.webp" alt="Three friends sharing a happy moment around a smartphone" width={1536} height={1024} fetchPriority="high" decoding="async"/><span className="pasofi-home-photo-note"><Icon name="wifi"/> Your world. A little closer.</span></div>
    </section>
    <section className="pf-quick-actions pasofi-home-actions" aria-label="Quick actions">
      <button disabled={!capabilities} onClick={event => account('voucher', event.currentTarget)}><span><Icon name="ticket"/></span><strong>Redeem voucher</strong></button>
      <button aria-haspopup="dialog" onClick={event => showLocations(event.currentTarget)}><span><Icon name="location"/></span><strong>Hotspot locations</strong></button>
      <button disabled={!capabilities} onClick={event => account('access', event.currentTarget)}><span><Icon name="history"/></span><strong>Check usage</strong></button>
      <button onClick={event => help(event.currentTarget)}><span><Icon name="help"/></span><strong>Get help</strong></button>
    </section>

    {children}

    <details className="pasofi-home-guide"><summary><span className="pasofi-home-section-icon"><Icon name="bolt"/></span><span><strong>New to PasoFi?</strong><small>Three steps to your next connection.</small></span><Icon name="plus"/></summary><ol>
      <li><span>01</span><div><h3>Find your hotspot</h3><p>Ask the local agent which Wi-Fi network to join and check its availability.</p><button className="pf-text-link" aria-haspopup="dialog" onClick={event => showLocations(event.currentTarget)}>Find a location <Icon name="arrow"/></button></div></li>
      <li><span>02</span><div><h3>Choose your bundle</h3><p>Compare data, price and validity. Purchase options depend on current service availability.</p><button className="pf-text-link" onClick={event => browse(event.currentTarget)}>View bundles <Icon name="arrow"/></button></div></li>
      <li><span>03</span><div><h3>Make it your connection</h3><p>{capabilities?.vouchers ? 'Redeem your voucher and open My WiFi for the connection steps. Your account keeps track of usage.' : 'Open My WiFi to check connection options and account usage.'}</p><button className="pf-text-link" disabled={!capabilities} onClick={event => account('wifi', event.currentTarget)}>Open My WiFi <Icon name="arrow"/></button></div></li>
    </ol></details>

    <section className="pasofi-home-story" aria-labelledby="home-study-heading">
      <img src="/images/pasofi-study-together.webp" alt="Two adults working together on a laptop at a shared table" width={1536} height={1024} loading="lazy" decoding="async"/>
      <div>
        <h2 id="home-study-heading">A little data. So many possibilities.</h2>
        <p>Study together, keep work moving, or catch up with someone you love. Choose the bundle that fits your day.</p>
        <button className="pf-text-link" onClick={event => browse(event.currentTarget)}>Compare bundles <Icon name="arrow"/></button>
      </div>
    </section>

    <dialog className="pasofi-map-dialog" ref={locationsDialog} aria-labelledby="pasofi-map-heading" onClose={closeLocations}>
      <header>
        <h2 id="pasofi-map-heading">Hotspot locations</h2>
        <button type="button" aria-label="Close map" onClick={() => locationsDialog.current?.close()}><Icon name="close"/></button>
      </header>
      {locationsOpen && <Suspense fallback={<p className="pasofi-map-status" role="status">Loading map…</p>}><HotspotMap/></Suspense>}
    </dialog>
  </div>;
}
