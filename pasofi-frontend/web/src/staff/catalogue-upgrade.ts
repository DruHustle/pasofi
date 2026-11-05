import type { Product, Staff } from '../business';

export type CatalogueProduct = Product & { published: boolean };
export type CatalogueSnapshot = { products: CatalogueProduct[]; currencies: string[]; publicationGuardVersion: 1 | null };
export type CatalogueRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

// A new ID preserves every earlier sale, quote, voucher and allowance snapshot.
export const revisedOffers = [
  { id: 'mini-5gb-v2', name: 'Mini', legacyId: 'mini', legacyBytes: '2000000000', priceMinor: 50, bytes: '5000000000', seconds: 259200 },
  { id: 'flex-10gb-v2', name: 'Flex', legacyId: 'flex', legacyBytes: '5000000000', priceMinor: 100, bytes: '10000000000', seconds: 604800 },
  { id: 'week-30gb-v2', name: 'Week', legacyId: 'week', legacyBytes: '20000000000', priceMinor: 300, bytes: '30000000000', seconds: 604800 },
  { id: 'fortnight-50gb-v2', name: 'Fortnight', legacyId: 'fortnight', legacyBytes: '35000000000', priceMinor: 500, bytes: '50000000000', seconds: 1209600 },
  { id: 'month-100gb-v2', name: 'Month', legacyId: 'month', legacyBytes: '75000000000', priceMinor: 1000, bytes: '100000000000', seconds: 2592000 },
] as const;

type Offer = typeof revisedOffers[number];
export class CatalogueUpgradeError extends Error {
  kind: 'actor_changed' | 'catalogue_invalid' | 'currency_unavailable' | 'version_conflict' | 'unconfirmed' | 'interrupted' | 'backend_upgrade_required';
  constructor(kind: CatalogueUpgradeError['kind'], message: string) { super(message); this.name = 'CatalogueUpgradeError'; this.kind = kind; }
}

function matches(product: CatalogueProduct | undefined, offer: Offer, legacy = false) {
  return !!product && product.price_minor === offer.priceMinor && product.currency === 'USD'
    && product.byte_limit === (legacy ? offer.legacyBytes : offer.bytes) && product.validity_seconds === offer.seconds;
}

export function catalogueUpgradePreview(products: readonly CatalogueProduct[]) {
  const rows = revisedOffers.map(offer => {
    const replacement = products.find(product => product.id === offer.id);
    const legacy = products.find(product => product.id === offer.legacyId);
    return { offer, replacement, legacy, conflict: !!replacement && !matches(replacement, offer),
      legacyMatches: matches(legacy, offer, true), ready: matches(replacement, offer),
      published: matches(replacement, offer) && replacement!.published };
  });
  return { rows, conflicts: rows.filter(row => row.conflict), prepared: rows.filter(row => row.ready).length,
    published: rows.filter(row => row.published).length,
    pendingWithdrawals: rows.filter(row => row.legacyMatches && row.legacy!.published),
    preservedLegacy: rows.filter(row => row.legacy && !row.legacyMatches),
    complete: rows.every(row => row.published && !(row.legacyMatches && row.legacy!.published)) };
}

function parseCatalogue(value: unknown): CatalogueSnapshot {
  const invalid = () => new CatalogueUpgradeError('catalogue_invalid', 'The current catalogue could not be verified. Refresh administration before continuing.');
  if (!value || typeof value !== 'object') throw invalid();
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.products) || (input.currencies !== undefined && (!Array.isArray(input.currencies) || !input.currencies.every(currency => typeof currency === 'string')))) throw invalid();
  const ids = new Set<string>();
  const products = input.products.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw invalid();
    const product = value as Record<string, unknown>;
    if (typeof product.id !== 'string' || ids.has(product.id) || !Number.isSafeInteger(product.price_minor)
      || Number(product.price_minor) < 1 || typeof product.currency !== 'string'
      || typeof product.byte_limit !== 'string' || !/^[0-9]{1,19}$/.test(product.byte_limit) || BigInt(product.byte_limit) < 1n
      || !Number.isSafeInteger(product.validity_seconds) || Number(product.validity_seconds) < 60 || typeof product.published !== 'boolean') throw invalid();
    ids.add(product.id);
    return { id: product.id, price_minor: product.price_minor as number, currency: product.currency,
      byte_limit: BigInt(product.byte_limit).toString(), validity_seconds: product.validity_seconds as number, published: product.published };
  });
  return { products, currencies: (input.currencies ?? ['USD']) as string[], publicationGuardVersion: input.publicationGuardVersion === 1 ? 1 : null };
}

/** All effects use existing audited admin routes; no stock or launch gate is changed. */
export async function upgradeCatalogue({ request, actor, signal, onSnapshot, onProgress }: {
  request: CatalogueRequest; actor: Pick<Staff, 'staffId' | 'version'>; signal: AbortSignal;
  onSnapshot?: (snapshot: CatalogueSnapshot) => void; onProgress?: (message: string) => void;
}) {
  // Copy the approved actor at the start; a changed session may not inherit this action.
  const expected = { staffId: actor.staffId, version: actor.version };
  const active = () => { if (signal.aborted) throw new CatalogueUpgradeError('interrupted', 'Pricing update interrupted. Refresh the catalogue to check saved changes.'); };
  const verifyActor = async () => {
    active();
    const current = await request<Staff>('/api/staff/session', { signal });
    active();
    if (current.staffId !== expected.staffId || current.version !== expected.version || current.status !== 'approved'
      || current.role !== 'admin' || current.mfaVerified !== true || current.mfaEnrolled !== true) {
      throw new CatalogueUpgradeError('actor_changed', 'Your administrator account or verification changed. Sign in again and review the catalogue before continuing.');
    }
  };
  const read = async () => {
    active();
    const snapshot = parseCatalogue(await request<unknown>('/api/admin/bundles', { signal }));
    active(); onSnapshot?.(snapshot);
    if (snapshot.publicationGuardVersion !== 1) throw new CatalogueUpgradeError('backend_upgrade_required', 'Pricing update requires the service update. Refresh administration after the service has been updated.');
    if (!snapshot.currencies.includes('USD')) throw new CatalogueUpgradeError('currency_unavailable', 'USD is not an approved catalogue currency. Review the configured currencies before continuing.');
    const conflicts = catalogueUpgradePreview(snapshot.products).conflicts;
    if (conflicts.length) throw new CatalogueUpgradeError('version_conflict', `${conflicts.map(row => row.offer.name).join(', ')} already has a replacement version with different terms. Review those versions before continuing.`);
    return snapshot;
  };
  const change = async (path: string, method: 'POST' | 'PATCH', payload: object, confirmed: (products: CatalogueProduct[]) => boolean) => {
    // This check is deliberately immediately before each separate mutation.
    await verifyActor(); active();
    let failure: unknown;
    try { await request<unknown>(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal }); }
    catch (error) {
      active();
      if (error && typeof error === 'object' && 'status' in error && [401, 403].includes(Number(error.status))) throw error;
      failure = error;
    }
    // Read after success AND ambiguous failure. A lost response must never cause
    // another draft, premature withdrawal or an unverified success message.
    const snapshot = await read();
    if (failure && typeof failure === 'object' && 'code' in failure && failure.code === 'required_bundles_not_published') throw new CatalogueUpgradeError('unconfirmed', 'A revised offer changed before withdrawal. The older offer was kept. Review the catalogue before continuing.');
    if (!confirmed(snapshot.products)) {
      const rateLimited = failure && typeof failure === 'object' && 'status' in failure && failure.status === 429;
      throw new CatalogueUpgradeError('unconfirmed', rateLimited ? 'The service is limiting requests. Wait a minute, then continue to check the saved update.' : 'The last catalogue change could not be confirmed. Continue the update to check saved steps before trying the remaining changes.');
    }
    return snapshot;
  };
  const reason = 'Owner-requested pricing revision: USD 10 buys 100 GB, with proportional allowances and unchanged validity.';
  await verifyActor();
  let snapshot = await read();
  onProgress?.('Preparing the five revised bundles…');
  for (const offer of revisedOffers) {
    snapshot = await read();
    if (snapshot.products.some(product => product.id === offer.id)) continue;
    snapshot = await change('/api/admin/bundles', 'POST', { id: offer.id, priceMinor: offer.priceMinor, currency: 'USD', byteLimit: offer.bytes, validitySeconds: offer.seconds, published: false, reason },
      products => matches(products.find(product => product.id === offer.id), offer));
  }
  onProgress?.('Publishing the five revised bundles…');
  for (const offer of revisedOffers) {
    snapshot = await read();
    if (catalogueUpgradePreview(snapshot.products).prepared !== revisedOffers.length) throw new CatalogueUpgradeError('unconfirmed', 'All five revised bundles must be saved before publication can continue. Refresh the catalogue and continue the update.');
    if (snapshot.products.find(product => product.id === offer.id)!.published) continue;
    snapshot = await change(`/api/admin/bundles/${offer.id}`, 'PATCH', { published: true, reason },
      products => { const product = products.find(product => product.id === offer.id); return matches(product, offer) && product!.published; });
  }
  onProgress?.('Withdrawing the matching older offers…');
  for (const offer of revisedOffers) {
    // Re-read ALL replacement terms and publication states before EACH withdrawal.
    snapshot = await read();
    if (catalogueUpgradePreview(snapshot.products).published !== revisedOffers.length) throw new CatalogueUpgradeError('unconfirmed', 'A revised offer is no longer published. Review the catalogue before withdrawing any more older offers.');
    const legacy = snapshot.products.find(product => product.id === offer.legacyId);
    if (!matches(legacy, offer, true) || !legacy!.published) continue;
    snapshot = await change(`/api/admin/bundles/${offer.legacyId}`, 'PATCH', { published: false, reason, requiredPublishedBundleIds: revisedOffers.map(replacement => replacement.id) },
      products => { const product = products.find(product => product.id === offer.legacyId); return matches(product, offer, true) && !product!.published; });
  }
  await verifyActor();
  snapshot = await read();
  if (!catalogueUpgradePreview(snapshot.products).complete) throw new CatalogueUpgradeError('unconfirmed', 'The catalogue changed during the update. Review the latest offers and continue to check the remaining steps.');
  return snapshot;
}
