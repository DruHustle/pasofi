// Agent links authorize only a quoted purchase. They never authenticate a customer.
// Keep the opaque code out of URLs after entry, persistent storage and OIDC returns.
export type AgentCheckoutIntent = { id: string; code: string };
export type AgentCheckoutSource = { id: string; siteId: string; siteName: string };
export type AgentCheckoutQuote = { bundleId: string; siteId: string; siteName: string; priceMinor: number; currency: string; byteLimit: string; validitySeconds: number };
export type AgentCheckoutPreview = { checkout: { id: string; status: 'unclaimed' | 'claimed' | 'expired'; quote: AgentCheckoutQuote; expiresAt: string; simulation: boolean }; available: boolean };
export type AgentCheckoutEntry = { intent: AgentCheckoutIntent; ownerId: string | null; expiresAt: number } | { error: string };
export const agentCheckoutChanged = 'pasofi:agent-checkout-changed';
const storageKey = 'pamofi.agentCheckout';
const lifetime = 15 * 60 * 1000;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const opaque = /^[A-Za-z0-9_-]{43}$/;
let storageFailure: AgentCheckoutEntry | null = null;

export function validAgentCheckout(value: unknown): value is AgentCheckoutIntent {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as AgentCheckoutIntent;
  return typeof candidate.id === 'string' && uuid.test(candidate.id) && typeof candidate.code === 'string' && opaque.test(candidate.code);
}
export function sameAgentCheckout(a: AgentCheckoutIntent | undefined | null, b: AgentCheckoutIntent | undefined | null) {
  return (!a && !b) || (!!a && !!b && a.id === b.id && a.code === b.code);
}
export function parseAgentCheckout(value: string): AgentCheckoutIntent | null {
  const raw = value.trim();
  const match = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(raw);
  if (match) return { id: match[1].toLowerCase(), code: match[2] };
  // A pasted link is never navigated. Only the public PasoFi checkout origin is accepted.
  try {
    const url = new URL(raw);
    if (url.origin !== 'https://pasofi.mobile.onesa.eu' || url.username || url.password || url.pathname !== '/' || url.search) return null;
    return intentFromHash(url.hash);
  } catch { return null; }
}
function intentFromHash(hash: string): AgentCheckoutIntent | null {
  if (!hash.startsWith('#checkout?')) return null;
  const query = new URLSearchParams(hash.slice('#checkout?'.length));
  if ([...query.keys()].length !== 1 || !query.has('agentCheckout')) return null;
  const raw = query.get('agentCheckout')!;
  const match = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/i.exec(raw);
  return match ? { id: match[1].toLowerCase(), code: match[2] } : null;
}
function changed() { window.dispatchEvent(new Event(agentCheckoutChanged)); }
function save(entry: AgentCheckoutEntry): AgentCheckoutEntry {
  try { sessionStorage.setItem(storageKey, JSON.stringify(entry)); storageFailure = null; }
  catch { storageFailure = { error: 'agent_checkout_storage_unavailable' }; }
  changed();
  return storageFailure ?? entry;
}
export function rememberAgentCheckout(intent: AgentCheckoutIntent): AgentCheckoutEntry {
  if (!validAgentCheckout(intent)) return save({ error: 'invalid_agent_checkout' });
  return save({ intent, ownerId: null, expiresAt: Date.now() + lifetime });
}
export function readAgentCheckout(): AgentCheckoutEntry | null {
  if (storageFailure) return storageFailure;
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const entry = JSON.parse(raw) as AgentCheckoutEntry;
    if ('error' in entry) return { error: 'invalid_agent_checkout' };
    if (!validAgentCheckout(entry.intent) || (entry.ownerId !== null && (typeof entry.ownerId !== 'string' || !uuid.test(entry.ownerId))) || !Number.isFinite(entry.expiresAt) || entry.expiresAt > Date.now() + lifetime) return { error: 'invalid_agent_checkout' };
    return entry.expiresAt > Date.now() ? entry : { error: 'agent_checkout_expired' };
  } catch { return { error: 'agent_checkout_storage_unavailable' }; }
}
export function clearAgentCheckout() {
  storageFailure = null;
  try { sessionStorage.removeItem(storageKey); } catch { /* Mutations still fail closed when retry storage is unavailable. */ }
  changed();
}
export function captureAgentCheckoutLocation(): AgentCheckoutEntry | null {
  if (!location.hash.startsWith('#checkout?')) return readAgentCheckout();
  const query = new URLSearchParams(location.hash.slice('#checkout?'.length));
  if (!query.has('agentCheckout')) return readAgentCheckout();
  const intent = intentFromHash(location.hash);
  // Scrub even a malformed private link, before any sign-in or outgoing navigation.
  history.replaceState(history.state, '', `${location.pathname}${location.search}#checkout`);
  return intent ? rememberAgentCheckout(intent) : save({ error: 'invalid_agent_checkout' });
}
export function bindAgentCheckout(intent: AgentCheckoutIntent, customerId: string) {
  const entry = readAgentCheckout();
  if (!uuid.test(customerId) || !entry || 'error' in entry || !sameAgentCheckout(entry.intent, intent) || (entry.ownerId !== null && entry.ownerId !== customerId)) throw Error('agent_checkout_owner_changed');
  const stored = save({ ...entry, ownerId: customerId });
  if ('error' in stored) throw Error(stored.error);
}
export function validAgentQuote(value: unknown): value is AgentCheckoutQuote {
  if (!value || typeof value !== 'object') return false;
  const quote = value as AgentCheckoutQuote;
  return typeof quote.bundleId === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(quote.bundleId)
    && typeof quote.siteId === 'string' && uuid.test(quote.siteId) && typeof quote.siteName === 'string' && quote.siteName.length > 0 && quote.siteName.length <= 200
    && Number.isSafeInteger(quote.priceMinor) && quote.priceMinor > 0 && typeof quote.currency === 'string' && /^[A-Z]{3}$/.test(quote.currency)
    && typeof quote.byteLimit === 'string' && /^[1-9][0-9]{0,29}$/.test(quote.byteLimit) && Number.isSafeInteger(quote.validitySeconds) && quote.validitySeconds > 0;
}
export function validAgentPreview(value: unknown, intent: AgentCheckoutIntent): value is AgentCheckoutPreview {
  if (!value || typeof value !== 'object') return false;
  const preview = value as AgentCheckoutPreview, checkout = preview.checkout;
  return typeof preview.available === 'boolean' && !!checkout && checkout.id === intent.id
    && ['unclaimed', 'claimed', 'expired'].includes(checkout.status) && validAgentQuote(checkout.quote)
    && typeof checkout.expiresAt === 'string' && Number.isFinite(Date.parse(checkout.expiresAt)) && typeof checkout.simulation === 'boolean'
    && (!preview.available || checkout.status === 'unclaimed');
}
export function matchingAgentSource(source: AgentCheckoutSource | null | undefined, intent: AgentCheckoutIntent | undefined, siteId?: string) {
  if (!intent) return source == null;
  return !!source && source.id === intent.id && source.siteId === siteId && typeof source.siteName === 'string' && source.siteName.length > 0 && source.siteName.length <= 200;
}

export function sameAgentSource(actual: AgentCheckoutSource | null | undefined, expected: AgentCheckoutSource | null | undefined) {
  return !expected ? actual == null : !!actual && actual.id === expected.id && actual.siteId === expected.siteId && typeof actual.siteName === 'string' && actual.siteName.length > 0 && actual.siteName.length <= 200;
}
