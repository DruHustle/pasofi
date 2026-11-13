import { ApiError } from './api';

export type Capabilities = {
  demo: boolean; paymentMode: 'disabled' | 'mock' | 'sandbox' | 'production';
  paymentCheckout: boolean; vouchers: boolean; receiptPairing: boolean;
  invoices?: boolean; invoiceEmail?: boolean; invoiceSms?: boolean;
  staffSales: boolean; inventoryAllocation?: boolean; salesLocationStatus?: boolean; deliverySms: boolean; networkAccess: boolean; mobileCookies: boolean;
  routerFleet?: boolean; routerFleetWrite?: boolean;
};
export type Product = { id: string; price_minor: number; currency: string; byte_limit: string; validity_seconds: number };
export type Site = { id: string; name: string; enabled?: boolean; version?: string };
export type CashEvidence = { method: 'cash' | 'unrecorded'; evidence: 'agent_attestation' | 'unrecorded'; receivedMinor: number | null; currency: string | null; confirmedAt: string | null; confirmedBy: string | null };
export function cashDescription(payment: CashEvidence | undefined, simulation: boolean) {
  return payment?.method === 'cash' && payment.evidence === 'agent_attestation' && payment.receivedMinor !== null && payment.currency
    ? `${simulation ? 'Simulated cash' : 'Cash'} received: ${money(payment.receivedMinor, payment.currency)} · confirmed by agent`
    : 'Cash confirmation was not recorded for this earlier sale.';
}
export type Staff = {
  staffId: string; email: string; displayName: string; status: 'pending' | 'approved' | 'rejected' | 'disabled';
  role: 'admin' | 'agent' | 'support' | null; siteIds: string[]; version: number;
  mfaEnrolled?: boolean; mfaVerified?: boolean; createdAt?: string;
};
export const money = (minor: number, currency = 'USD') => new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
export const localDate = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export function messageFor(error: unknown, fallback = 'This request could not be completed. Please try again.') {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 401) return 'Your session or verification has expired. Sign in again to continue.';
  if (error.status === 403) return 'This action is not available for your account or assigned site. Refresh your account permissions.';
  if (error.status === 429) return 'Too many attempts. Wait a minute before trying again.';
  const messages: Record<string, string> = {
    no_usable_entitlement: 'Your account has no bundle eligible for a new hotspot session. Check the remaining data and validity of your bundles.',
    accounting_review_required: 'Your previous connection needs an accounting review. Contact your PasoFi agent before reconnecting.',
    session_pending_or_active: 'A hotspot session is still open. Check its status before starting another connection.',
    cookie_not_kept: 'This browser did not keep the account cookie. Allow cookies for the configured PasoFi service, then retry. No voucher or payment was submitted.',
    version_conflict: 'This record changed while you were reviewing it. Refresh and review the current details.',
    cash_sale_site_unavailable: 'Sales are paused at this location. Return any cash received for this sale to the customer.',
    site_unavailable: 'New sales are paused or unavailable at this sales location. Paid receipts and existing allowances remain available.',
    staff_changed: 'This staff record changed. Refresh and review the latest details.',
    insufficient_inventory: 'There is not enough stock for this sale. Refresh inventory or ask an administrator to allocate stock.',
    out_of_stock: 'This bundle is out of stock at the selected site.',
    cash_confirmation_required: 'This unused request needs an explicit confirmation that the exact cash amount was received. Review the customer and amount before issuing a new sale.',
    cash_amount_mismatch: 'The cash confirmation does not match this bundle’s published price and currency. Refresh the catalogue and review the correct amount.',
    pairing_expired: 'The customer pairing code has expired. Ask the customer to create a new code.',
    invalid_pairing: 'That pairing code could not be verified. Check the code and selected site.',
    invalid_voucher: 'The voucher could not be verified. Check all characters and try again.',
    voucher_unavailable: 'This voucher is expired, replaced, or unavailable. Ask the selling agent to review the receipt.',
    quote_still_valid: 'The quote is still valid. Review its terms or check payment status; no purchase retry details were discarded.',
    payment_attempt_exists: 'A payment attempt already exists for this order. Check its verified status; the saved purchase is preserved and no new charge was started.',
    order_not_payable: 'This order cannot begin payment. Check its verified status, or ask the service to close an expired unused quote.',
    pairing_unavailable: 'The pairing code is invalid, expired or already used. Ask the customer for a new private pairing code.',
    refund_payout_pending: 'A cash refund is reserved against this shift. Complete its cash return before closing the shift.',
    refund_payout_not_prepared: 'Reserve the approved refund against an open cash shift before returning money.',
    voucher_refunded: 'This sale has been withdrawn for a refund. Check the receipt and refund status with the agent.',
    refund_usage_review_required: 'This bundle has usage or unresolved network activity. Its refund needs an accounting review; no automatic refund was approved.',
    refund_insufficient_cash: 'The open shift has insufficient recorded cash to pay this refund. Check the shift before returning money.',
    refund_already_requested: 'A refund request already exists for this sale. Refresh the refund list to review it.',
    refund_not_approved: 'A supervisor must approve this refund before cash is returned.',
    shift_required: 'Open a cash shift for this location and currency before receiving payment.',
    shift_already_open: 'A shift is already open for this location and currency. Refresh shifts to use it.',
    shift_already_closed: 'This shift is already closed. Refresh its recorded count before taking further action.',
    pairing_terms_mismatch: 'This reference is for a different bundle or location. Look up its details before taking cash.',
    pairing_already_paid: 'The agent already confirmed this sale. Check your private receipt; it cannot be cancelled as an unpaid reference.',
    reference_not_found: 'No cash reference was found at this location. Check the code and selected site.',
    cash_selection_required: 'Choose an available bundle and location before creating your cash reference.',
    pairing_required: 'A private customer pairing code is required for this delivery option.',
    bundle_unavailable: 'This bundle version is unavailable. Refresh the published catalogue before choosing another.',
    invalid_phone: 'Check the customer phone number and use the supported international format.',
    invalid_or_used: 'The voucher is invalid, unavailable or belongs to another account. Check its characters and the original receipt.',
    quote_expired: 'This price quote has expired. Review a new order before paying.',
    idempotency_conflict: 'This retry no longer matches the original request. Restore the original details before retrying.',
    session_already_exists: 'This browser already has a customer account. Sign out of that account before accepting a handoff.',
    invalid_handoff: 'The handoff code has expired, was already used, or could not be verified. Create a new one on the original device.',
  };
  return messages[error.code] ?? (error.status >= 500 ? 'The service is temporarily unavailable. A request may still have completed; check its status before retrying.' : fallback);
}

// Mutation retries survive panel closes/reloads. Requests are scoped by the authenticated owner.
export function mutationIntent(owner: string, operation: string, payload: unknown): string {
  const storage = `pamofi.operation:${owner}:${operation}`;
  const fingerprint = JSON.stringify(payload);
  const previous = sessionStorage.getItem(storage);
  if (previous) {
    const saved = JSON.parse(previous) as { key: string; payload: string };
    if (saved.payload !== fingerprint) throw new ApiError(409, 'idempotency_conflict');
    return saved.key;
  }
  const key = crypto.randomUUID();
  sessionStorage.setItem(storage, JSON.stringify({ key, payload: fingerprint }));
  return key;
}
export function finishMutation(owner: string, operation: string) { sessionStorage.removeItem(`pamofi.operation:${owner}:${operation}`); }
export function discardStaffDrafts(preserveStaffId?: string) {
  try { for (const key of Object.keys(sessionStorage)) if (key.startsWith('pamofi.operation:staff:') && (!preserveStaffId || !key.startsWith(`pamofi.operation:staff:${preserveStaffId}:`))) sessionStorage.removeItem(key); } catch { /* Private data remains memory-only if browser storage is disabled. */ }
}

const staffChannel = (() => { try { return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('pamofi.staff-session'); } catch { return null; } })();
export function announceStaffSession(kind: 'signed_in' | 'signed_out', staffId?: string) { staffChannel?.postMessage({ kind, staffId }); }
export function onStaffSessionChange(listener: (kind: 'signed_in' | 'signed_out', staffId?: string) => void) {
  const receive = (event: MessageEvent) => { if (event.data?.kind === 'signed_in' || event.data?.kind === 'signed_out') listener(event.data.kind, typeof event.data.staffId === 'string' ? event.data.staffId : undefined); };
  staffChannel?.addEventListener('message', receive);
  return () => staffChannel?.removeEventListener('message', receive);
}

export function cashListUrl(path: string, active: boolean, before: string | null) {
  const query = new URLSearchParams();
  if (active) query.set('active', 'true');
  if (before) query.set('before', before);
  return query.size ? `${path}?${query}` : path;
}
