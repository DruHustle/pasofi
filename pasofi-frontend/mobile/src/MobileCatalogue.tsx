import { useEffect, useState } from 'react';
import type { Product } from './business';
import Icon from './Icon';

// Mirrors the web catalogue (pasofi-frontend/web/src/BundleCatalogue.tsx) so the
// app shows the same filters, sorting and bundle cards. Example mode is the
// unconfigured preview: cards open a short explanation and never start a purchase.
const filters = [
  { id: 'all', label: 'All bundles', short: 'All', matches: (_: Product) => true },
  { id: 'daily', label: 'Daily', short: 'Daily', matches: (b: Product) => b.validity_seconds <= 86400 },
  { id: 'short', label: 'Short stays', short: 'Short', matches: (b: Product) => b.validity_seconds > 86400 && b.validity_seconds <= 3 * 86400 },
  { id: 'weekly', label: 'Weekly', short: 'Weekly', matches: (b: Product) => b.validity_seconds > 3 * 86400 && b.validity_seconds <= 7 * 86400 },
  { id: 'longer', label: 'Longer', short: 'Longer', matches: (b: Product) => b.validity_seconds > 7 * 86400 && b.validity_seconds <= 27 * 86400 },
  { id: 'monthly', label: 'Monthly', short: 'Monthly', matches: (b: Product) => b.validity_seconds > 27 * 86400 },
];
const sorts = [
  { id: 'published', label: 'Default order' }, { id: 'price-asc', label: 'Price: low to high' }, { id: 'price-desc', label: 'Price: high to low' },
  { id: 'data-desc', label: 'Data: most first' }, { id: 'data-asc', label: 'Data: least first' },
  { id: 'validity-desc', label: 'Validity: longest first' }, { id: 'validity-asc', label: 'Validity: shortest first' },
] as const;
type Sort = typeof sorts[number]['id'];

function compare(left: Product, right: Product, sort: Sort) {
  if (sort.startsWith('price-')) return left.currency.localeCompare(right.currency) || (sort === 'price-asc' ? left.price_minor - right.price_minor : right.price_minor - left.price_minor);
  if (sort.startsWith('data-')) { const a = BigInt(left.byte_limit), b = BigInt(right.byte_limit), c = a < b ? -1 : a > b ? 1 : 0; return sort === 'data-asc' ? c : -c; }
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
export const bundleName = (bundle: Product) => bundle.id.replace(/-v[0-9]+$/, '').replaceAll('-', ' ');
function PriceParts({ minor, currency }: { minor: number; currency: string }) {
  const parts = new Intl.NumberFormat('en-US', { style: 'currency', currency }).formatToParts(minor / 100);
  return <strong>{parts.map((part, index) => <span key={index} className={part.type === 'currency' || part.type === 'literal' ? 'pf-price-symbol'
    : part.type === 'decimal' || part.type === 'fraction' ? 'pf-price-cents' : undefined}>{part.value}</span>)}</strong>;
}
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
function bestValueIds(bundles: Product[]) {
  const ids = new Set<string>();
  for (const currency of new Set(bundles.map(bundle => bundle.currency))) {
    const priced = bundles.filter(bundle => bundle.currency === currency).map(bundle => ({ id: bundle.id, value: perGbMinor(bundle) }))
      .filter((item): item is { id: string; value: number } => item.value !== null).sort((left, right) => left.value - right.value);
    if (priced.length >= 3 && priced[0].value < priced[1].value) ids.add(priced[0].id);
  }
  return ids;
}

export default function MobileCatalogue({ bundles, example, error, checking, purchasable, retry, choose, help, seeAll, headingLevel = 2 }: {
  bundles: Product[] | null; example: boolean; error: boolean; checking: boolean; purchasable: boolean;
  retry: () => void; choose: (bundle: Product) => void; help: () => void; seeAll?: () => void; headingLevel?: 1 | 2;
}) {
  const preview = Boolean(seeAll);
  const [filter, setFilter] = useState('all'), [sort, setSort] = useState<Sort>('published');
  const available = filters.filter(f => f.id === 'all' || bundles?.some(f.matches));
  useEffect(() => { if (bundles !== null && !available.some(f => f.id === filter)) setFilter('all'); }, [bundles, filter]);
  const selected = available.find(f => f.id === filter) ?? filters[0];
  const visible = (bundles?.filter(selected.matches) ?? []).sort((left, right) => compare(left, right, sort));
  const best = bestValueIds(bundles ?? []);
  const Heading = headingLevel === 1 ? 'h1' : 'h2';
  return <section className={preview ? 'pf-catalogue pf-catalogue--preview' : 'pf-catalogue'} aria-labelledby="catalogue-heading">
    <div className="pf-section-heading"><Heading id="catalogue-heading" tabIndex={-1}>Find your fit.</Heading>{seeAll
      ? <button className="pf-text-link" onClick={seeAll}>See all bundles <Icon name="arrow" /></button>
      : <button className="pf-text-link" onClick={help}>Help & FAQs <Icon name="arrow" /></button>}</div>
    {example && <p className="pf-example-note"><Icon name="info" />Example bundles. Prices and terms are illustrative and may change before launch.</p>}
    {!preview && <>
      <div className="pf-filter-row" role="group" aria-label="Bundle duration">{available.map(f => <button key={f.id} aria-pressed={filter === f.id} aria-label={f.short === f.label ? undefined : f.label} onClick={() => setFilter(f.id)}>{f.short === f.label ? f.label : <><span className="pf-filter-full">{f.label}</span><span className="pf-filter-short" aria-hidden="true">{f.short}</span></>}</button>)}</div>
      <div className="pf-catalogue-toolbar">
        <div className="pf-catalogue-caption"><span>{example ? 'Example bundles' : 'Published bundles'}</span>{bundles !== null && !error && <span role="status" aria-atomic="true">Showing {visible.length} of {bundles.length} {bundles.length === 1 ? 'bundle' : 'bundles'}</span>}</div>
        <label className="pf-sort" htmlFor="bundle-sort"><span>Sort bundles</span><select id="bundle-sort" value={sort} disabled={!bundles?.length || error} onChange={event => setSort(event.target.value as Sort)}>{sorts.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      </div>
    </>}
    {!example && !checking && bundles !== null && bundles.length > 0 && !error && !purchasable && <div className="pf-purchase-availability" role="status"><strong>Purchases paused</strong><span>Check again later or ask a PasoFi agent.</span></div>}
    {error ? <div className="pf-empty" role="status"><h3>Let’s try that again.</h3><p>Bundle information is temporarily unavailable.</p><button className="mobile-secondary" onClick={retry}>Retry bundles</button></div>
      : bundles === null ? <div className="pf-bundle-grid" role="status" aria-label="Loading bundle information">{[1, 2, 3].map(i => <div key={i} className="pf-bundle-skeleton" aria-hidden="true"><span /><span /><span /></div>)}</div>
      : bundles.length === 0 ? <div className="pf-empty"><h3>More connection is on the way.</h3><p role="status">No bundles are published yet.</p><button className="mobile-secondary" onClick={retry}>Refresh availability</button></div>
      : <div className="pf-bundle-grid">{visible.map(bundle => {
        const data = bundleData(bundle.byte_limit), name = bundleName(bundle), perGb = perGbLabel(bundle), nameId = `bundle-name-${bundle.id}`;
        // The preview shows the same Buy button as the website, disabled: it never starts a purchase.
        const label = example ? `Buy ${name} (not available in this preview)`
          : checking ? `Checking ${bundle.id} purchase availability` : purchasable ? `Buy ${bundle.id} bundle` : `${bundle.id} purchasing is not available`;
        return <article className="pf-bundle-card" key={bundle.id} aria-labelledby={nameId} data-best-value={best.has(bundle.id) || undefined}>
          <div className="pf-bundle-top"><span className="pf-plan-name" id={nameId}>{name}</span>{best.has(bundle.id) && <span className="pf-bundle-badge">Best value</span>}</div>
          <h3>{data.amount}<span>{data.unit}</span></h3>
          <p className="pf-validity"><Icon name="clock" />{bundleDuration(bundle.validity_seconds)}</p>
          <div className="pf-bundle-price"><PriceParts minor={bundle.price_minor} currency={bundle.currency} /><span><abbr title={bundle.currency === 'USD' ? 'US dollars' : bundle.currency}>{bundle.currency}</abbr>{perGb && <span className="pf-per-gb"> · {perGb}</span>}</span></div>
          <button className="pf-card-button" aria-label={label} disabled={example || checking || !purchasable} onClick={() => choose(bundle)}>{example ? 'Buy' : checking ? 'Checking…' : purchasable ? 'Buy' : 'Paused'}</button>
        </article>;
      })}</div>}
    {!preview && <div className="pf-bundle-terms"><Icon name="shield" /><p><strong>Simple, upfront terms.</strong> One-off prices. Time starts on your first successful connection. Uploads and downloads count. One active connection per customer.</p></div>}
  </section>;
}
