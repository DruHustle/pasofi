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
const sorts = [
  { id: 'published', label: 'Default order' },
  { id: 'price-asc', label: 'Price: low to high' },
  { id: 'price-desc', label: 'Price: high to low' },
  { id: 'data-desc', label: 'Data: most first' },
  { id: 'data-asc', label: 'Data: least first' },
  { id: 'validity-desc', label: 'Validity: longest first' },
  { id: 'validity-asc', label: 'Validity: shortest first' },
] as const;
type Sort = typeof sorts[number]['id'];
function compareBundles(left: Product, right: Product, sort: Sort) {
  if (sort.startsWith('price-')) {
    // A USD price and another currency's face value are not comparable.
    const currency = left.currency.localeCompare(right.currency);
    return currency || (sort === 'price-asc' ? left.price_minor - right.price_minor : right.price_minor - left.price_minor);
  }
  if (sort.startsWith('data-')) {
    const leftBytes = BigInt(left.byte_limit), rightBytes = BigInt(right.byte_limit);
    const comparison = leftBytes < rightBytes ? -1 : leftBytes > rightBytes ? 1 : 0;
    return sort === 'data-asc' ? comparison : -comparison;
  }
  if (sort === 'validity-asc') return left.validity_seconds - right.validity_seconds;
  if (sort === 'validity-desc') return right.validity_seconds - left.validity_seconds;
  return 0;
}
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
export default function BundleCatalogue({ bundles, demo, capabilities, error, retry, refreshAvailability, choose, help, headingLevel = 2, compact = false }: {
  bundles: Product[] | null; demo: boolean; capabilities: Capabilities | null; error: boolean;
  retry: () => void; refreshAvailability: () => void; choose: (bundle: Product, button: HTMLButtonElement) => void; help: () => void;
  headingLevel?: 1 | 2; compact?: boolean;
}) {
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState<Sort>('published');
  const available = filters.filter(f => f.id === 'all' || bundles?.some(f.matches));
  // Keep the customer's filter while a refresh is loading; fall back only when
  // the newly published catalogue no longer contains that duration.
  useEffect(() => { if (bundles !== null && !available.some(f => f.id === filter)) setFilter('all'); }, [bundles, filter]);
  const selected = available.find(f => f.id === filter) ?? filters[0];
  const visible = (bundles?.filter(selected.matches) ?? []).sort((left, right) => compareBundles(left, right, sort));
  const multipleCurrencies = new Set(visible.map(bundle => bundle.currency)).size > 1;
  const availableToBuy = demo || capabilities?.staffSales || capabilities?.paymentCheckout;
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const controls = <>
    <div className="pf-filter-row" role="group" aria-label="Bundle duration">{available.map(f => <button key={f.id} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}</div>
    <div className="pf-catalogue-toolbar">
      <div className="pf-catalogue-caption"><span>{demo ? 'Candidate bundles · demo only' : 'Published bundles'}</span>{bundles !== null && !error && <span className="pf-result-count" role="status" aria-atomic="true">Showing {visible.length} of {bundles.length} {bundles.length === 1 ? 'bundle' : 'bundles'}</span>}</div>
      <label className="pf-sort" htmlFor="bundle-sort"><span>Sort bundles</span><select id="bundle-sort" value={sort} disabled={!bundles?.length || error} onChange={event => setSort(event.target.value as Sort)}>{sorts.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
    </div>
  </>;
  return <section className="pf-catalogue" id="explore" aria-labelledby="catalogue-heading" tabIndex={-1}>
    <div className="pf-section-heading"><div><span className="pf-eyebrow">A LITTLE MORE FREEDOM</span><Heading id="catalogue-heading" tabIndex={-1}>Find your fit.</Heading><p>Pick your data. Make more of your day.</p></div><button className="pf-text-link" onClick={help}>Help & FAQs <Icon name="arrow"/></button></div>
    {compact ? <details className="pf-catalogue-options"><summary>Filter & sort bundles</summary>{controls}</details> : controls}
    {sort.startsWith('price-') && multipleCurrencies && <p className="pf-sort-note">Prices are grouped by currency, then sorted within each currency.</p>}
    {!demo && bundles !== null && bundles.length > 0 && !error && !availableToBuy && <div className="pf-purchase-availability" role="status"><div><strong>{capabilities === null ? 'Purchase availability is not confirmed' : 'Purchases are paused'}</strong><p>{capabilities === null ? 'You can compare these bundles. Check service availability before making a payment.' : 'You can compare published prices. Check again before visiting an agent or making a payment.'}</p></div><button className="pf-button pf-button-secondary" onClick={refreshAvailability}>Refresh availability</button></div>}
    {error ? <div className="pf-empty" role="status"><span className="pf-empty-icon"><Icon name="wifi"/></span><h3>Let’s try that again.</h3><p>Bundle information is temporarily unavailable.</p><button className="pf-button pf-button-secondary" onClick={retry}>Retry bundles</button></div>
      : bundles === null ? <div className="pf-bundle-grid" role="status" aria-label="Loading bundle information"><span className="pf-sr-only">Loading bundle information…</span>{[1, 2, 3].map(i => <div key={i} className="pf-bundle-skeleton" aria-hidden="true"><span/><span/><span/></div>)}</div>
      : bundles.length === 0 ? <div className="pf-empty"><span className="pf-empty-icon"><Icon name="grid"/></span><h3>More connection is on the way.</h3><p role="status">No bundles are published yet. Check back when PasoFi launches.</p><div className="purchase-actions"><button className="pf-button pf-button-secondary" onClick={refreshAvailability}>Refresh availability</button><button className="pf-button pf-button-secondary" onClick={help}>Explore help <Icon name="arrow"/></button></div></div>
      : <div className="pf-bundle-grid">{visible.map(bundle => {
        const data = bundleData(bundle.byte_limit);
        const label = demo ? `Try ${bundle.id} demo bundle` : capabilities?.staffSales ? `Buy ${bundle.id} from an agent` : capabilities?.paymentCheckout ? `Review ${bundle.id} bundle` : `${bundle.id} purchasing is not available`;
        return <article className="pf-bundle-card" key={bundle.id}>
          <div className="pf-bundle-top"><span className="pf-plan-name">{bundle.id.replace(/-v[0-9]+$/, '').replaceAll('-', ' ')}</span><Icon name="wifi"/></div>
          <h3>{data.amount}<span>{data.unit}</span></h3>
          <p className="pf-validity"><Icon name="clock"/>{bundleDuration(bundle.validity_seconds)}</p>
          <div className="pf-bundle-price"><strong>{new Intl.NumberFormat('en-US', { style: 'currency', currency: bundle.currency }).format(bundle.price_minor / 100)}</strong><span>{bundle.currency}</span></div>
          <button className="pf-button pf-button-primary" disabled={!availableToBuy} aria-label={label} onClick={event => choose(bundle, event.currentTarget)}>{demo ? 'Try demo' : availableToBuy ? 'Choose' : capabilities === null ? 'Check status' : 'Paused'}<Icon name="arrow"/></button>
        </article>;
      })}</div>}
    <div className="pf-bundle-terms"><Icon name="shield"/><p><strong>Simple, upfront terms.</strong> One-off prices. Time starts on your first successful connection. Uploads and downloads count. One active connection per customer. Start within 30 days; your bundle ends when its time or data runs out.</p></div>
  </section>;
}
