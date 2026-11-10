import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import type { Capabilities, Site } from './business';
import type { CustomerTab } from './CustomerAccess';
import Icon from './Icon';

type Props = {
  capabilities: Capabilities | null; children: ReactNode;
  onInteract: () => void;
  browse: (button?: HTMLButtonElement) => void;
  account: (tab: CustomerTab, button: HTMLButtonElement) => void;
  help: (button?: HTMLButtonElement) => void;
  recover: (button: HTMLButtonElement) => void;
};
function readLocations(value: unknown): Site[] {
  if (!value || typeof value !== 'object' || !('sites' in value) || !Array.isArray(value.sites) || value.sites.length > 1000) throw Error('invalid_locations');
  const locations = value.sites.map(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200) throw Error('invalid_locations');
    return { id: item.id, name: item.name };
  });
  if (new Set(locations.map(site => site.id)).size !== locations.length) throw Error('invalid_locations');
  return locations;
}

export default function Home({ capabilities, children, onInteract, browse, account, help, recover }: Props) {
  const [locationsOpen, setLocationsOpen] = useState(false), [locations, setLocations] = useState<Site[] | null>(null);
  const [locationsError, setLocationsError] = useState(false), [locationsAttempt, setLocationsAttempt] = useState(0), [locationQuery, setLocationQuery] = useState('');
  const locationPanel = useRef<HTMLDetailsElement>(null), locationSearch = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!locationsOpen) return;
    const controller = new AbortController(); setLocationsError(false); setLocations(null);
    api<unknown>('/api/sites', { signal: controller.signal }).then(readLocations).then(result => {
      if (!controller.signal.aborted) setLocations(result);
    }).catch(() => { if (!controller.signal.aborted) setLocationsError(true); });
    return () => controller.abort();
  }, [locationsOpen, locationsAttempt]);
  function showLocations() {
    setLocationsOpen(true);
    requestAnimationFrame(() => { locationPanel.current?.scrollIntoView({ behavior: 'auto', block: 'start' }); locationSearch.current?.focus({ preventScroll: true }); });
  }
  const filteredLocations = locations?.filter(site => site.name.toLocaleLowerCase().includes(locationQuery.trim().toLocaleLowerCase())) ?? [];
  return <div className="pasofi-home-content" onPointerDownCapture={onInteract} onKeyDownCapture={onInteract} onClickCapture={onInteract} onInputCapture={onInteract}>
    <section className="pasofi-home-hero" aria-labelledby="home-hero-heading">
      <div className="pasofi-home-hero-copy"><span className="pasofi-home-kicker">A LITTLE MORE PASOFI</span><h1 id="home-hero-heading" tabIndex={-1}>Your internet.<br/><em>Your everyday.</em></h1><p>For the catch-ups, bright ideas and everyday moments.</p>
        <button className="pf-button" onClick={event => browse(event.currentTarget)}>Browse bundles <Icon name="arrow"/></button></div>
      <div className="pasofi-home-hero-photo"><img src="/images/pasofi-community-hero.webp" alt="Three friends sharing a happy moment around a smartphone" width={1536} height={1024} fetchPriority="high" decoding="async"/><span className="pasofi-home-photo-note"><Icon name="wifi"/> Your world. A little closer.</span></div>
    </section>
    <section className="pf-quick-actions pasofi-home-actions" aria-label="Quick actions">
      <button onClick={event => browse(event.currentTarget)}><span><Icon name="plus"/></span><strong>Buy data</strong></button>
      <button onClick={showLocations}><span><Icon name="location"/></span><strong>Hotspot locations</strong></button>
      <button disabled={!capabilities} onClick={event => account('access', event.currentTarget)}><span><Icon name="history"/></span><strong>Check usage</strong></button>
      <button onClick={event => help(event.currentTarget)}><span><Icon name="help"/></span><strong>Get help</strong></button>
    </section>

    {children}

    <div className="pasofi-home-more">
      <section className="pasofi-home-story" aria-labelledby="home-study-heading"><img src="/images/pasofi-study-together.webp" alt="Two adults working together on a laptop at a shared table" width={1536} height={1024} loading="lazy" decoding="async"/>
        <div><span className="pasofi-home-kicker">MAKE ROOM FOR YOUR NEXT IDEA</span><h2 id="home-study-heading">A little data. <br/>So many possibilities.</h2><p>Study together, keep work moving, or catch up with someone you love. Choose the bundle that fits your day.</p><button className="pf-text-link" onClick={event => browse(event.currentTarget)}>Compare bundles <Icon name="arrow"/></button></div>
      </section>
      <section className="pasofi-home-account" aria-labelledby="home-account-heading"><span className="pasofi-home-account-icon"><Icon name="shield"/></span><span className="pasofi-home-kicker">ALREADY WITH PASOFI?</span><h2 id="home-account-heading">Your connection.<br/>In your hands.</h2><p>Use a voucher, check your Wi-Fi or recover your existing account.</p><div>
        <button disabled={!capabilities} onClick={event => account('voucher', event.currentTarget)}><Icon name="ticket"/><span>Redeem voucher</span><Icon name="chevron"/></button>
        <button disabled={!capabilities} onClick={event => account('wifi', event.currentTarget)}><Icon name="wifi"/><span>My WiFi</span><Icon name="chevron"/></button>
        <button onClick={event => recover(event.currentTarget)}><Icon name="user"/><span>Recover my account</span><Icon name="chevron"/></button>
      </div></section>
    </div>

    <details className="pasofi-home-locations" ref={locationPanel} open={locationsOpen} onToggle={event => setLocationsOpen(event.currentTarget.open)}>
      <summary><span className="pasofi-home-section-icon"><Icon name="location"/></span><span><strong>Find a Pasofi location</strong><small>Check listed locations before you visit.</small></span><Icon name="plus"/></summary>
      <div className="pasofi-home-location-content"><p>These are listed sales locations. Confirm the hotspot name and local availability with the agent before travelling.</p>
        <div className="pasofi-home-location-status" role="status">{capabilities?.demo ? 'Demonstration service · these listings do not confirm live coverage.' : capabilities === null ? 'Checking service availability…' : capabilities.networkAccess ? 'Check My WiFi for current connection options.' : 'Customer connections are currently paused.'}{capabilities?.demo !== true && capabilities?.staffSales === false && ' Cash purchases are currently paused.'}</div>
        <div className="pasofi-home-location-tools"><label>Search locations<input ref={locationSearch} type="search" maxLength={160} value={locationQuery} onChange={event => setLocationQuery(event.target.value)} placeholder="Enter a location name"/></label><button className="pf-button pf-button-secondary" disabled={locations === null && !locationsError} onClick={() => setLocationsAttempt(value => value + 1)}>Refresh locations</button></div>
        {locationsError ? <div className="pasofi-home-location-empty" role="status"><p>Locations could not be loaded. Refresh to check again or contact support.</p><button className="pf-text-link" onClick={event => help(event.currentTarget)}>Contact support <Icon name="arrow"/></button></div>
          : locations === null ? <p role="status">Loading current locations…</p>
          : locations.length === 0 ? <p role="status">No locations are listed yet. Please check again when the service is available.</p>
          : <><p className="pasofi-home-location-count" role="status">{filteredLocations.length} of {locations.length} {locations.length === 1 ? 'location' : 'locations'}</p><ul>{filteredLocations.map(site => <li key={site.id}><span><strong>{site.name}</strong><small>Listed sales location</small></span><button className="pf-button pf-button-secondary" disabled={!capabilities} onClick={event => account('wifi', event.currentTarget)} aria-label={`Check Wi-Fi for ${site.name}`}>Check Wi-Fi <Icon name="arrow"/></button></li>)}</ul>{filteredLocations.length === 0 && <p>No listed location matches that search.</p>}</>}
      </div>
    </details>
    <details className="pasofi-home-guide"><summary><span className="pasofi-home-section-icon"><Icon name="bolt"/></span><span><strong>New to Pasofi?</strong><small>Three steps to your next connection.</small></span><Icon name="plus"/></summary><ol>
      <li><span>01</span><div><h3>Find your hotspot</h3><p>Ask the local agent which Wi-Fi network to join and check its availability.</p><button className="pf-text-link" onClick={showLocations}>Find a location <Icon name="arrow"/></button></div></li>
      <li><span>02</span><div><h3>Choose your bundle</h3><p>Compare data, price and validity. Purchase options depend on current service availability.</p><button className="pf-text-link" onClick={event => browse(event.currentTarget)}>View bundles <Icon name="arrow"/></button></div></li>
      <li><span>03</span><div><h3>Make it your connection</h3><p>Redeem your voucher and open My WiFi for the connection steps. Your account keeps track of usage.</p><button className="pf-text-link" disabled={!capabilities} onClick={event => account('wifi', event.currentTarget)}>Open My WiFi <Icon name="arrow"/></button></div></li>
    </ol></details>
  </div>;
}
