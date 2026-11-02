import { useEffect, useState } from 'react';
import type { Capabilities, Product } from './business';
import Icon from './Icon';

const filters = [
  { id: 'all', label: 'All bundles', matches: (_: Product) => true },
  { id: 'daily', label: 'Daily', matches: (b: Product) => b.validity_seconds <= 86400 },
  { id: 'short', label: 'Short stays', matches: (b: Product) => b.validity_seconds > 86400 && b.validity_seconds <= 3 * 86400 },
  { id: 'weekly', label: 'Weekly', matches: (b: Product) => b.validity_seconds > 3 * 86400 && b.validity_seconds <= 7 * 86400 },
  { id: 'longer', label: 'Longer', matches: (b: Product) => b.validity_seconds > 7 * 86400 && b.validity_seconds <= 27 * 86400 },
  { id: 'monthly', label: 'Monthly', matches: (b: Product) => b.validity_seconds > 27 * 86400 },
];
export function bundleData(bytes: string) {
  const amount = BigInt(bytes), unit = amount >= 1_000_000_000n ? 1_000_000_000n : 1_000_000n;
  const decimals = (amount % unit * 100n / unit).toString().padStart(2, '0').replace(/0+$/, '');
  return { amount: `${amount / unit}${decimals ? `.${decimals}` : ''}`, unit: unit === 1_000_000_000n ? 'GB' : 'MB' };
}
export function bundleDuration(seconds: number) {
  const unit = seconds >= 86400 ? 'day' : seconds >= 3600 ? 'hour' : 'minute';
  const amount = seconds / (unit === 'day' ? 86400 : unit === 'hour' ? 3600 : 60);
  return `${Number(amount.toFixed(2))} ${unit}${amount === 1 ? '' : 's'}`;
}
export default function BundleCatalogue({ bundles, demo, capabilities, error, retry, choose, help }: {
  bundles: Product[] | null; demo: boolean; capabilities: Capabilities | null; error: boolean;
  retry: () => void; choose: (bundle: Product, button: HTMLButtonElement) => void; help: () => void;
}) {
  const [filter, setFilter] = useState('all');
  const available = filters.filter(f => f.id === 'all' || bundles?.some(f.matches));
  useEffect(() => { if (!available.some(f => f.id === filter)) setFilter('all'); }, [bundles, filter]);
  const selected = available.find(f => f.id === filter) ?? filters[0];
  const visible = bundles?.filter(selected.matches) ?? [];
  const availableToBuy = demo || capabilities?.staffSales || capabilities?.paymentCheckout;
  return <section className="pf-catalogue" id="explore" aria-labelledby="catalogue-heading" tabIndex={-1}>
    <div className="pf-section-heading"><div><span className="pf-eyebrow">A LITTLE MORE FREEDOM</span><h2 id="catalogue-heading">Find your fit.</h2><p>Pick your data. Make more of your day.</p></div><button className="pf-text-link" onClick={help}>Help & FAQs <Icon name="arrow"/></button></div>
    <div className="pf-filter-row" role="group" aria-label="Bundle duration">{available.map(f => <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}</div>
    <div className="pf-catalogue-caption"><span>{demo ? 'Candidate bundles · demo only' : 'Published bundles'}</span><span>Data + time · Pay once</span></div>
    {error ? <div className="pf-empty" role="status"><span className="pf-empty-icon"><Icon name="wifi"/></span><h3>Let’s try that again.</h3><p>Bundle information is temporarily unavailable.</p><button className="pf-button pf-button-secondary" onClick={retry}>Retry bundles</button></div>
      : bundles === null ? <div className="pf-bundle-grid" role="status" aria-label="Loading bundle information"><span className="pf-sr-only">Loading bundle information…</span>{[1, 2, 3].map(i => <div key={i} className="pf-bundle-skeleton" aria-hidden="true"><span/><span/><span/></div>)}</div>
      : bundles.length === 0 ? <div className="pf-empty"><span className="pf-empty-icon"><Icon name="grid"/></span><h3>More connection is on the way.</h3><p role="status">No bundles are published yet. Check back when PamoFi launches.</p><button className="pf-button pf-button-secondary" onClick={help}>Explore help <Icon name="arrow"/></button></div>
      : <div className="pf-bundle-grid">{visible.map(bundle => {
        const data = bundleData(bundle.byte_limit), featured = bundle.id === 'flex';
        const label = demo ? `Try ${bundle.id} demo bundle` : capabilities?.staffSales ? `Buy ${bundle.id} from an agent` : capabilities?.paymentCheckout ? `Review ${bundle.id} bundle` : `${bundle.id} purchasing is not available`;
        return <article className={`pf-bundle-card ${featured ? 'pf-bundle-featured' : ''}`} key={bundle.id}>
          <div className="pf-bundle-top"><span className="pf-plan-name">{bundle.id.replaceAll('-', ' ')}</span>{featured ? <span className="pf-recommended"><Icon name="bolt"/> Our pick</span> : <Icon name="wifi"/>}</div>
          <h3>{data.amount}<span>{data.unit}</span></h3>
          <p className="pf-validity"><Icon name="clock"/>{bundleDuration(bundle.validity_seconds)}</p>
          <div className="pf-bundle-price"><strong>{new Intl.NumberFormat('en-US', { style: 'currency', currency: bundle.currency }).format(bundle.price_minor / 100)}</strong><span>{bundle.currency} · once-off</span></div>
          <button className={`pf-button ${featured ? 'pf-button-primary' : 'pf-button-secondary'}`} disabled={!availableToBuy} aria-label={label} onClick={event => choose(bundle, event.currentTarget)}>{demo ? 'Try demo' : availableToBuy ? 'Choose bundle' : 'Not available'}<Icon name="arrow"/></button>
        </article>;
      })}</div>}
    <div className="pf-bundle-terms"><Icon name="shield"/><p><strong>Simple, upfront terms.</strong> Time starts on your first successful connection. Uploads and downloads count. One active connection per customer. Start within 30 days; your bundle ends when its time or data runs out.</p></div>
  </section>;
}
