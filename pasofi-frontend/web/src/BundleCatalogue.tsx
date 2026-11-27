import { useEffect, useState, type ReactNode } from 'react';
import type { Capabilities, Product } from './business';
import Icon from './Icon';

const hotspotBuild = import.meta.env.VITE_PASOFI_HOTSPOT_PORTAL === '1';
const narrowViewport = '(max-width: 599px)';

const filters = [
  { id: 'all', label: 'All bundles', short: 'All', matches: (_: Product) => true },
  { id: 'daily', label: 'Daily', short: 'Daily', matches: (b: Product) => b.validity_seconds <= 86400 },
  { id: 'short', label: 'Short stays', short: 'Short', matches: (b: Product) => b.validity_seconds > 86400 && b.validity_seconds <= 3 * 86400 },
  { id: 'weekly', label: 'Weekly', short: 'Weekly', matches: (b: Product) => b.validity_seconds > 3 * 86400 && b.validity_seconds <= 7 * 86400 },
  { id: 'longer', label: 'Longer', short: 'Longer', matches: (b: Product) => b.validity_seconds > 7 * 86400 && b.validity_seconds <= 27 * 86400 },
  { id: 'monthly', label: 'Monthly', short: 'Monthly', matches: (b: Product) => b.validity_seconds > 27 * 86400 },
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
/** Price split into symbol, whole amount and cents; the text reads exactly like Intl's output. */
function PriceParts({ minor, currency }: { minor: number; currency: string }) {
  const parts = new Intl.NumberFormat('en-US', { style: 'currency', currency }).formatToParts(minor / 100);
  return <strong>{parts.map((part, index) => <span key={index} className={part.type === 'currency' || part.type === 'literal' ? 'pf-price-symbol'
    : part.type === 'decimal' || part.type === 'fraction' ? 'pf-price-cents' : undefined}>{part.value}</span>)}</strong>;
}
/** Price per GB in minor units, or null when the allowance is under 1 MB. */
function perGbMinor(bundle: Product) {
  const megabytes = Number(BigInt(bundle.byte_limit) / 1_000_000n);
  return megabytes > 0 ? bundle.price_minor * 1000 / megabytes : null;
}
function perGbLabel(bundle: Product) {
  const minor = perGbMinor(bundle);
  if (minor === null) return null;
  const format = new Intl.NumberFormat('en-US', { style: 'currency', currency: bundle.currency });
  return minor < 1 ? `under ${format.format(0.01)}/GB` : `${format.format(Math.round(minor) / 100)}/GB`;
}
/** The one bundle with the clearly lowest price per GB in its currency (needs 3+ to compare). */
function bestValueIds(bundles: Product[]) {
  const ids = new Set<string>();
  for (const currency of new Set(bundles.map(bundle => bundle.currency))) {
    const priced = bundles.filter(bundle => bundle.currency === currency).map(bundle => ({ id: bundle.id, value: perGbMinor(bundle) }))
      .filter((item): item is { id: string; value: number } => item.value !== null).sort((left, right) => left.value - right.value);
    if (priced.length >= 3 && priced[0].value < priced[1].value) ids.add(priced[0].id);
  }
  return ids;
}
export default function BundleCatalogue({ bundles, demo, capabilities, checkingAvailability, error, retry, refreshAvailability, choose, redeemVoucher, help, headingLevel = 2, compact = false, accountEntry, seeAll }: {
  bundles: Product[] | null; demo: boolean; capabilities: Capabilities | null; checkingAvailability: boolean; error: boolean;
  retry: () => void; refreshAvailability: () => void; choose: (bundle: Product, button: HTMLButtonElement) => void;
  redeemVoucher: (button: HTMLButtonElement) => void; help: () => void;
  headingLevel?: 1 | 2; compact?: boolean; accountEntry?: ReactNode;
  /** Home preview: a swipeable row without filters; the full list lives on Bundles. */
  seeAll?: (button: HTMLButtonElement) => void;
}) {
  const preview = Boolean(seeAll);
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState<Sort>('published');
  const [narrow, setNarrow] = useState(() => hotspotBuild && window.matchMedia(narrowViewport).matches);
  useEffect(() => {
    if (!hotspotBuild) return;
    const viewport = window.matchMedia(narrowViewport);
    const update = () => setNarrow(viewport.matches);
    update();
    if (!viewport.addEventListener) {
      viewport.addListener(update);
      return () => viewport.removeListener(update);
    }
    viewport.addEventListener('change', update);
    return () => viewport.removeEventListener('change', update);
  }, []);
  const narrowHotspotCatalogue = narrow && headingLevel === 1;
  const available = filters.filter(f => f.id === 'all' || bundles?.some(f.matches));
  // Keep the customer's filter while a refresh is loading; fall back only when
  // the newly published catalogue no longer contains that duration.
  useEffect(() => { if (bundles !== null && !available.some(f => f.id === filter)) setFilter('all'); }, [bundles, filter]);
  const selected = available.find(f => f.id === filter) ?? filters[0];
  const visible = (bundles?.filter(selected.matches) ?? []).sort((left, right) => compareBundles(left, right, sort));
  const multipleCurrencies = new Set(visible.map(bundle => bundle.currency)).size > 1;
  const bestValue = bestValueIds(bundles ?? []);
  // Each published bundle keeps its own colour, whatever the filter or sort.
  const tone = (bundle: Product) => String(Math.max(0, bundles?.indexOf(bundle) ?? 0) % 8);
  const availableToBuy = !checkingAvailability && Boolean(demo || capabilities?.staffSales || capabilities?.paymentCheckout);
  const canRedeemVoucher = !checkingAvailability && capabilities?.vouchers === true;
  const purchaseStatus = checkingAvailability ? 'Checking purchase availability…'
    : capabilities === null ? 'Purchase availability is not confirmed'
    : canRedeemVoucher ? 'New sales are paused' : 'Purchases paused';
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  const controls = <>
    <div className="pf-filter-row" role="group" aria-label="Bundle duration">{available.map(f => <button key={f.id} aria-pressed={filter === f.id} aria-label={f.short === f.label ? undefined : f.label} onClick={() => setFilter(f.id)}>{f.short === f.label ? f.label : <><span className="pf-filter-full">{f.label}</span><span className="pf-filter-short" aria-hidden="true">{f.short}</span></>}</button>)}</div>
    <div className="pf-catalogue-toolbar">
      <div className="pf-catalogue-caption"><span>{demo ? 'Candidate bundles · demo only' : 'Published bundles'}</span>{bundles !== null && !error && <span className="pf-result-count" role="status" aria-atomic="true">Showing {visible.length} of {bundles.length} {bundles.length === 1 ? 'bundle' : 'bundles'}</span>}</div>
      <label className="pf-sort" htmlFor="bundle-sort"><span>Sort bundles</span><select id="bundle-sort" value={sort} disabled={!bundles?.length || error} onChange={event => setSort(event.target.value as Sort)}>{sorts.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
    </div>
  </>;
  return <section className={narrowHotspotCatalogue ? 'pf-catalogue pf-catalogue--hotspot' : preview ? 'pf-catalogue pf-catalogue--preview' : compact ? 'pf-catalogue pf-catalogue--compact' : 'pf-catalogue'} id="explore" aria-labelledby="catalogue-heading" tabIndex={-1}>
    <div className="pf-section-heading"><div><Heading id="catalogue-heading" tabIndex={-1}>Find your fit.</Heading></div>{seeAll
      ? <button className="pf-text-link" onClick={event => seeAll(event.currentTarget)}>See all bundles <Icon name="arrow"/></button>
      : <button className="pf-text-link" onClick={help}>Help & FAQs <Icon name="arrow"/></button>}</div>
    {accountEntry}
    {preview ? null : compact || narrowHotspotCatalogue ? <details className="pf-catalogue-options"><summary>{narrowHotspotCatalogue ? 'Filter & sort' : 'Filter & sort bundles'}</summary>{controls}</details> : controls}
    {sort.startsWith('price-') && multipleCurrencies && <p className="pf-sort-note">Prices are grouped by currency, then sorted within each currency.</p>}
    {!demo && bundles !== null && bundles.length > 0 && !error && !availableToBuy && <div className="pf-purchase-availability">
      <div role="status">
        <strong>{purchaseStatus}</strong>
        {capabilities === null && !checkingAvailability && <p>Check availability before making a payment.</p>}
      </div>
      {canRedeemVoucher && <button className="pf-button pf-button-primary" onClick={event => redeemVoucher(event.currentTarget)}>Redeem voucher</button>}
      <button className="pf-button pf-button-secondary" onClick={refreshAvailability} aria-label="Refresh availability">{canRedeemVoucher ? 'Refresh' : 'Refresh availability'}</button>
    </div>}
    {error ? <div className="pf-empty" role="status"><span className="pf-empty-icon"><Icon name="wifi"/></span><h3>Let’s try that again.</h3><p>Bundle information is temporarily unavailable.</p><button className="pf-button pf-button-secondary" onClick={retry}>Retry bundles</button></div>
      : bundles === null ? <div className="pf-bundle-grid" role="status" aria-label="Loading bundle information"><span className="pf-sr-only">Loading bundle information…</span>{[1, 2, 3].map(i => <div key={i} className="pf-bundle-skeleton" aria-hidden="true"><span/><span/><span/></div>)}</div>
      : bundles.length === 0 ? <div className="pf-empty"><span className="pf-empty-icon"><Icon name="grid"/></span><h3>More connection is on the way.</h3><p role="status">No bundles are published yet. Check back when PasoFi launches.</p><div className="purchase-actions"><button className="pf-button pf-button-secondary" onClick={refreshAvailability}>Refresh availability</button><button className="pf-button pf-button-secondary" onClick={help}>Explore help <Icon name="arrow"/></button></div></div>
      : <div className="pf-bundle-grid" data-purchasable={availableToBuy}>{visible.map(bundle => {
        const data = bundleData(bundle.byte_limit);
        const label = checkingAvailability ? `Checking ${bundle.id} purchase availability` : demo ? `Try ${bundle.id} demo bundle` : capabilities?.staffSales ? `Buy ${bundle.id} from an agent` : capabilities?.paymentCheckout ? `Review ${bundle.id} bundle` : `${bundle.id} purchasing is not available`;
        const nameId = `bundle-name-${bundle.id}`;
        const best = bestValue.has(bundle.id), perGb = perGbLabel(bundle);
        return <article className="pf-bundle-card" key={bundle.id} aria-labelledby={nameId} data-best-value={best || undefined} data-tone={tone(bundle)}>
          <div className="pf-bundle-top"><span className="pf-plan-name" id={nameId}>{bundle.id.replace(/-v[0-9]+$/, '').replaceAll('-', ' ')}</span>{best && <span className="pf-bundle-badge">Best value</span>}<Icon name="wifi"/></div>
          <h3>{data.amount}<span>{data.unit}</span></h3>
          <p className="pf-validity"><Icon name="clock"/>{bundleDuration(bundle.validity_seconds)}</p>
          <div className="pf-bundle-price"><PriceParts minor={bundle.price_minor} currency={bundle.currency}/><span><abbr title={bundle.currency === 'USD' ? 'US dollars' : bundle.currency}>{bundle.currency}</abbr>{perGb && <span className="pf-per-gb"> · {perGb}</span>}</span></div>
          {(!narrowHotspotCatalogue || availableToBuy) && <button className="pf-button pf-button-primary" disabled={!availableToBuy} aria-label={label} onClick={event => choose(bundle, event.currentTarget)}>{checkingAvailability ? 'Checking…' : demo ? 'Try demo' : availableToBuy ? 'Choose' : capabilities === null ? 'Unavailable' : 'Paused'}<Icon name="arrow"/></button>}
        </article>;
      })}</div>}
    {!preview && <div className="pf-bundle-terms"><Icon name="shield"/><p><strong>Simple, upfront terms.</strong> One-off prices. Time starts on your first successful connection. Uploads and downloads count. One active connection per customer. Start within 30 days; your bundle ends when its time or data runs out.</p></div>}
  </section>;
}
